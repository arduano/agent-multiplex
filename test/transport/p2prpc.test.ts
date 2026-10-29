import assert from "node:assert/strict";
import test from "node:test";
import { createTRPCClient, experimental_localLink, TRPCClientError } from "@trpc/client";
import { initTRPC, TRPCError } from "@trpc/server";
import type { PeerContext } from "@arduano/p2prpc-core";
import { z } from "zod";
import { HistoryWindow } from "../../src/history/index.js";
import type { HostPeer, HostTarget, Viewer } from "../../src/gateway/contracts.js";
import { p2pHostBinding, p2pHostCallContext } from "../../src/transport/node/p2prpc.js";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
import type { BorrowedP2pPeer } from "../../src/transport/node-contracts.js";

const route = { authority: "root", host: "host", owner: "host-owner", routeEpoch: "epoch" };
const plugin = { id: "scripted", version: 1, recordVersion: 1 };
const manifest = {
  contractId: "scripted",
  contractVersion: 1,
  compositionId: "scripted",
  nativeKind: "scripted",
  harness: plugin,
  lifecycle: plugin,
  extensions: {},
};
const target: HostTarget = {
  route,
  expected: {
    contractId: manifest.contractId,
    contractVersion: 1,
    compositionId: manifest.compositionId,
  },
  session: { id: "session", generation: 1 },
};
const viewer = (principal: string): Viewer => ({
  connection: "shared",
  principal,
  actions: principal === "alice" ? ["read", "control"] : ["read"],
  hosts: ["host"],
});

// This fixture supplies the verified transport seed only. The real official
// localLink and Host router own all procedure input parsing and subscriptions.
function seed(
  identity: Viewer,
  selected: HostTarget,
  path: string,
  type: "query" | "mutation" | "subscription",
  peer = "gateway",
): PeerContext {
  const metadata = p2pHostCallContext(identity, selected).p2prpc as {
    headers: Readonly<Record<string, string>>;
  };
  return {
    p2p: {
      peer: { id: peer },
      auth: { principal: { id: peer } },
      request: {
        id: 1,
        path,
        type,
        headers: metadata.headers,
        signal: new AbortController().signal,
      },
    },
  } as PeerContext;
}

test("direct Host binding preserves delegation, exact target and one effect while typed subscription cancellation leaves the other viewer usable", async () => {
  const t = initTRPC.context<{ viewer: Viewer; target: HostTarget }>().create();
  const history = new HistoryWindow({
    run: {
      scope: { connection: "shared", principal: "alice", host: "host", session: "session" },
      generation: 1,
      nativeSession: "native",
    },
    attachment: "scripted",
    stream: "native",
  });
  let effects = 0,
    peerCloses = 0;
  const inputs: unknown[] = [];
  const procedure = t.procedure.use(({ ctx, type, next }) => {
    if (!ctx.viewer.actions.includes(type === "mutation" ? "control" : "read"))
      throw new TRPCError({ code: "FORBIDDEN" });
    return next();
  });
  const router = t.router({
    native: t.router({
      codex: t.router({
        identity: procedure.query(({ ctx }) => ({
          principal: ctx.viewer.principal,
          generation: ctx.target.session?.generation,
        })),
        send: procedure
          .input(z.object({ id: z.string(), text: z.string() }).strict())
          .mutation(({ input }) => {
            inputs.push(input);
            return { id: input.id, effects: ++effects };
          }),
        history: procedure.subscription(() => history.subscribe()),
      }),
    }),
  });
  const host: HostPeer<typeof router> = {
    route,
    manifest,
    router,
    async context(identity, selected) {
      if (selected.session?.id !== "session" || selected.session.generation !== 1)
        throw new TRPCError({ code: "PRECONDITION_FAILED" });
      return { viewer: identity, target: selected };
    },
  };
  const binding = p2pHostBinding(host, (context, requested) =>
    context.p2p.peer.id === "gateway" && context.p2p.auth.principal.id === "gateway"
      ? viewer(requested.principal)
      : null,
  );
  assert.equal(binding.router, router);
  const contextFor = async (request: PeerContext) => binding.createContext(request);
  const clientFor = (identity: Viewer, path: string, type: "query" | "mutation" | "subscription") =>
    createTRPCClient<typeof router>({
      links: [
        experimental_localLink({
          router: binding.router,
          createContext: async () => binding.createContext(seed(identity, target, path, type)),
        }),
      ],
    });
  const alice = clientFor(viewer("alice"), "native.codex.identity", "query");
  const bob = clientFor(viewer("bob"), "native.codex.identity", "query");
  const physical = {
    rpc: alice,
    async close() {
      peerCloses++;
    },
  };
  const borrowed: BorrowedP2pPeer<typeof router> = physical;
  let first: ReturnType<typeof alice.native.codex.history.subscribe> | undefined;
  let second: ReturnType<typeof alice.native.codex.history.subscribe> | undefined;
  try {
    assert.deepEqual(
      await Promise.all([
        borrowed.rpc.native.codex.identity.query(),
        bob.native.codex.identity.query(),
      ]),
      [
        { principal: "alice", generation: 1 },
        { principal: "bob", generation: 1 },
      ],
    );
    const original = { id: "exact-original", text: "one Send" };
    assert.deepEqual(
      await clientFor(viewer("alice"), "native.codex.send", "mutation").native.codex.send.mutate(
        original,
      ),
      { id: original.id, effects: 1 },
    );
    assert.deepEqual(inputs, [original]);
    await assert.rejects(
      clientFor(viewer("bob"), "native.codex.send", "mutation").native.codex.send.mutate({
        id: "denied",
        text: "no",
      }),
      (error: unknown) => error instanceof TRPCClientError && error.data?.code === "FORBIDDEN",
    );
    for (const selected of [
      { ...target, route: { ...route, routeEpoch: "stale" } },
      { ...target, expected: { ...target.expected, compositionId: "foreign" } },
    ])
      await assert.rejects(
        contextFor(seed(viewer("alice"), selected, "native.codex.send", "mutation")),
        { code: "CONFLICT" },
      );
    await assert.rejects(
      contextFor(
        seed(
          viewer("alice"),
          { ...target, session: { id: "session", generation: 2 } },
          "native.codex.send",
          "mutation",
        ),
      ),
      { code: "PRECONDITION_FAILED" },
    );
    await assert.rejects(
      contextFor(seed(viewer("alice"), target, "native.codex.send", "mutation", "untrusted")),
      { code: "FORBIDDEN" },
    );
    const missing = seed(viewer("alice"), target, "native.codex.send", "mutation");
    await assert.rejects(
      contextFor({
        p2p: { ...missing.p2p, request: { ...missing.p2p.request, headers: {} } },
      }),
      { code: "BAD_REQUEST" },
    );
    assert.equal(effects, 1);
    const readyA = deferred<void>(),
      readyB = deferred<void>(),
      updateB = deferred<void>();
    let dataA = 0,
      dataB = 0;
    first = clientFor(
      viewer("alice"),
      "native.codex.history",
      "subscription",
    ).native.codex.history.subscribe(undefined, {
      onData() {
        dataA++;
        readyA.resolve();
      },
      onError: readyA.reject,
    });
    second = clientFor(
      viewer("bob"),
      "native.codex.history",
      "subscription",
    ).native.codex.history.subscribe(undefined, {
      onData() {
        dataB++;
        if (dataB === 1) readyB.resolve();
        else updateB.resolve();
      },
      onError(error) {
        readyB.reject(error);
        updateB.reject(error);
      },
    });
    await Promise.all([readyA.promise, readyB.promise]);
    assert.equal(history.subscriberCount, 2);
    first.unsubscribe();
    await new Promise(setImmediate);
    assert.equal(history.subscriberCount, 1);
    history.update({ activity: { state: "working", turnId: "turn" } });
    await updateB.promise;
    assert.equal(dataA, 1);
    assert.equal(dataB, 2);
    assert.equal((await bob.native.codex.identity.query()).principal, "bob");
    assert.equal(effects, 1);
    assert.equal(peerCloses, 0);
    function typeChecks() {
      // @ts-expect-error Actual Codex router has no Copilot endpoint.
      void alice.native.copilot.identity.query();
      // @ts-expect-error The real procedure controls the input type.
      void alice.native.codex.send.mutate({ id: 1, text: "invalid" });
      // @ts-expect-error Borrowing RPC grants no physical-close capability.
      void borrowed.close();
    }
    void typeChecks;
  } finally {
    first?.unsubscribe();
    second?.unsubscribe();
    await new Promise(setImmediate);
    assert.equal(history.subscriberCount, 0);
    history.close();
  }
});

test("p2p scope metadata rejects malformed and over-budget requests", () => {
  assert.throws(() =>
    p2pHostCallContext({ connection: "shared", principal: "a".repeat(257) }, target),
  );
  assert.throws(() =>
    p2pHostCallContext(viewer("alice"), {
      ...target,
      expected: { ...target.expected, compositionId: "x".repeat(9000) },
    }),
  );
});

test("verified bridge delegation exposes the stable namespace and rejects malformed or oversized claims", async () => {
  const { readBridgeDelegation } = await import("../../src/transport/node/p2prpc.js");
  const delegated = { viewer: viewer("alice"), target };
  assert.deepEqual(readBridgeDelegation({ claims: delegated }), delegated);
  assert.throws(
    () =>
      readBridgeDelegation({
        claims: { viewer: { ...delegated.viewer, actions: ["admin"] }, target },
      }),
    { code: "FORBIDDEN" },
  );
  assert.throws(
    () => readBridgeDelegation({ claims: { viewer: { ...delegated.viewer, hosts: [] }, target } }),
    { code: "FORBIDDEN" },
  );
  assert.throws(
    () => readBridgeDelegation({ claims: { viewer: delegated.viewer, target, untrusted: true } }),
    { code: "FORBIDDEN" },
  );
  assert.throws(
    () =>
      readBridgeDelegation({
        claims: {
          viewer: delegated.viewer,
          target: { ...target, expected: { ...target.expected, compositionId: "x".repeat(9000) } },
        },
      }),
    { code: "FORBIDDEN" },
  );
});
