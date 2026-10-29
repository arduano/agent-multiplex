import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { initTRPC } from "@trpc/server";
import type { PeerContext } from "@arduano/p2prpc-core";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
import { HistoryWindow } from "../../src/history/index.js";
import {
  createMultiplexNode,
  createSharedSecretSecurity,
  pinnedTarget,
  p2pHostBinding,
  p2pHostCallContext,
} from "../../src/transport/node/p2prpc.js";
import { type HostPeer, type HostTarget, type Viewer } from "../../src/gateway/index.js";

test(
  "published native Iroh: two viewers, quiet first-close, subsequent calls and exact physical-owner cleanup",
  { skip: process.env.MULTIPLEX_NETWORK_QUALIFICATION !== "1", timeout: 60000 },
  async () => {
    const route = { authority: "root", host: "host", owner: "host-owner", routeEpoch: "epoch" };
    const plugin = { id: "fixture", version: 1, recordVersion: 1 };
    const manifest = {
      contractId: "fixture",
      contractVersion: 1,
      compositionId: "fixture",
      nativeKind: "scripted",
      harness: plugin,
      lifecycle: plugin,
      extensions: {},
    };
    const viewer: Viewer = {
      connection: "fixture",
      principal: "viewer",
      actions: ["read", "control"],
      hosts: ["host"],
    };
    const scope = { connection: "fixture", principal: "viewer", host: "host", session: "session" };
    const history = new HistoryWindow({
      run: { scope, generation: 1, nativeSession: "native" },
      attachment: "attachment",
      stream: "native",
    });
    let effects = 0,
      allowControl = true;
    const firstRetired = deferred<void>();
    let retired = 0;
    const native = initTRPC.context<{ viewer: Viewer }>().create();
    const router = native.router({
      state: native.procedure.query(() => ({ effects })),
      send: native.procedure.mutation(() => ({ effects: ++effects })),
      history: native.procedure.subscription(() => {
        const held = history.subscribe();
        const source: ReturnType<typeof history.subscribe> = {
          [Symbol.asyncIterator]() {
            return source;
          },
          next: () => held.next(),
          async return() {
            const result = await held.return();
            if (++retired === 1) firstRetired.resolve();
            return result;
          },
        };
        return source;
      }),
    });
    const local: HostPeer<typeof router> = {
      route,
      manifest,
      router,
      async context(identity) {
        return { viewer: identity };
      },
    };
    let gatewayId = "";
    const binding = p2pHostBinding(local, (context, requested) =>
      context.p2p.peer.id === gatewayId &&
      context.p2p.auth.principal.id === gatewayId &&
      requested.connection === viewer.connection &&
      requested.principal === viewer.principal
        ? { ...viewer, actions: allowControl ? ["read", "control"] : ["read"] }
        : null,
    );
    const secret = randomBytes(32);
    const pins = new Set<string>();
    const security = () =>
      createSharedSecretSecurity(secret, {
        authorize: (context) =>
          pins.has(context.remotePeerId) && context.principal.id === context.remotePeerId,
      });
    const iroh = {
      bindAddress: "127.0.0.1:0",
      relay: { mode: "disabled" as const },
      discovery: { dns: false, mdns: false },
      allowAdvertisedAddress: (address: string) => address.startsWith("127.0.0.1:"),
      allowDirectAddress: (address: string) => address.startsWith("127.0.0.1:"),
    };
    const hostKey = randomBytes(32);
    const host = await createMultiplexNode({
      ...binding,
      security: security(),
      iroh: { ...iroh, secretKey: hostKey },
      limits: { shutdownTimeoutMs: 5000, connectTimeoutMs: 5000, handshakeTimeoutMs: 5000 },
    });
    let gateway: Awaited<ReturnType<typeof createMultiplexNode>> | undefined;
    try {
      const t = initTRPC.context<PeerContext>().create();
      gateway = await createMultiplexNode({
        router: t.router({}),
        createContext: (context) => context,
        security: security(),
        iroh,
        limits: { shutdownTimeoutMs: 5000, connectTimeoutMs: 5000, handshakeTimeoutMs: 5000 },
      });
      gatewayId = gateway.id;
      pins.add(host.id);
      pins.add(gateway.id);
      const ticket = await host.createTicket();
      const peer = await gateway.connect<typeof router>(
        pinnedTarget(host.id, { kind: "ticket", ticket }),
      );
      const target: HostTarget = {
        route,
        expected: {
          contractId: manifest.contractId,
          contractVersion: manifest.contractVersion,
          compositionId: manifest.compositionId,
        },
      };
      const context = p2pHostCallContext(viewer, target);
      const readyA = deferred<void>(),
        readyB = deferred<void>(),
        updateB = deferred<void>();
      let dataA = 0,
        dataB = 0;
      const a = peer.rpc.history.subscribe(undefined, {
        context,
        onData() {
          dataA++;
          readyA.resolve();
        },
        onError: readyA.reject,
      });
      const b = peer.rpc.history.subscribe(undefined, {
        context,
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
      try {
        await Promise.all([readyA.promise, readyB.promise]);
        assert.equal(history.subscriberCount, 2);
        a.unsubscribe();
        await firstRetired.promise;
        assert.equal(history.subscriberCount, 1);
        history.update({ activity: { state: "working", turnId: "turn" } });
        await updateB.promise;
        assert.equal(dataA, 1);
        assert.equal(dataB, 2);
        assert.deepEqual(await peer.rpc.send.mutate(undefined, { context }), { effects: 1 });
        assert.equal(effects, 1);
        assert.deepEqual(await peer.rpc.state.query(undefined, { context }), { effects: 1 });
        assert.equal(gateway.peersSnapshot().length, 1);
        allowControl = false;
        await assert.rejects(
          peer.rpc.send.mutate(undefined, { context }),
          (error: unknown) =>
            error instanceof Error &&
            (error as { data?: { code?: string } }).data?.code === "FORBIDDEN",
        );
        assert.equal(effects, 1);
      } finally {
        a.unsubscribe();
        b.unsubscribe();
      }
    } finally {
      history.close();
      const cleanup = await Promise.allSettled([gateway?.close(), host.close()]);
      for (const result of cleanup) assert.equal(result.status, "fulfilled");
    }
  },
);
