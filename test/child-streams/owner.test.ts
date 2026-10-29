import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReadonlyTranscript } from "../../src/chat/index.js";
import { test } from "node:test";
import { CodexHistory } from "../../src/codex/node.js";
import {
  HistoryWindow,
  type HistoryReadPort,
  type NativePage,
  type HistoryScope,
} from "../../src/history/index.js";
import type { ObservationConnector } from "../../src/client/index.js";
import { RetainedChildStreams } from "../../src/child-streams/index.js";
import { ChildStreamOwner, childStreamRouter } from "../../src/child-streams/node.js";
import type { HostContext } from "../../src/host/index.js";
import type { RunRef } from "../../src/protocol/index.js";

const run: RunRef = {
  scope: { connection: "c", principal: "owner", host: "host", session: "parent" },
  generation: 1,
  nativeSession: "root",
};
const ctx: HostContext = {
  identity: { connection: "c", principal: "owner", actions: ["read"] },
  route: { authority: "root", host: "host", owner: "host-owner", routeEpoch: "epoch" },
  admit: () => () => {},
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function history(selected = run) {
  const value = new CodexHistory(selected, `attachment-${selected.generation}`);
  value.ingest({
    method: "thread/started",
    params: { thread: { id: "root", sessionId: "root", parentThreadId: null } },
  });
  for (const id of ["child-a", "child-b"])
    value.ingest({
      method: "thread/started",
      params: { thread: { id, sessionId: "root", parentThreadId: "root" } },
    });
  return value;
}
function connector(): ObservationConnector {
  return {
    connect<T>(input: {
      key: string;
      open(signal: AbortSignal): AsyncIterable<T>;
      receive(value: T): void;
      unavailable(): void;
    }) {
      const abort = new AbortController(),
        iterator = input.open(abort.signal)[Symbol.asyncIterator]();
      let active = true;
      const actual = (async () => {
        try {
          while (active) {
            const value = await iterator.next();
            if (value.done) {
              if (active) input.unavailable();
              break;
            }
            if (active) input.receive(value.value);
          }
        } catch {
          if (active) input.unavailable();
        }
      })();
      return async () => {
        active = false;
        abort.abort();
        await iterator.return?.();
        await actual;
      };
    },
  };
}

test("proved native children stream through the typed read-only router and retained views preserve pin/scroll across switches", async () => {
  let current = history(),
    generation = 1,
    reads = 0,
    released = 0;
  const changes = new Set<() => void>();
  const owner = new ChildStreamOwner(
    {
      assertRun(selected) {
        assert.equal(selected.generation, generation, "ROOT_FENCED");
        assert.deepEqual(selected.scope, run.scope);
      },
      inventory() {
        return current
          .scopes()
          .filter((scope) => current.owner(scope.stream)?.relation === "child");
      },
      bind(scope) {
        const release = current.protect(scope.stream),
          window = current.window(scope.stream);
        const port: HistoryReadPort = {
          scope,
          mode: "repeatable",
          async read(input, current) {
            reads++;
            assert.equal(input.count, 100);
            current();
            return {
              status: "page",
              scope,
              rows: [
                {
                  id: `${scope.stream}:older`,
                  kind: "assistant",
                  lifecycle: "completed",
                  body: { kind: "complete", text: "older native message", evidence: "native" },
                  native: {},
                },
              ],
              placement: "before",
              nextCursor: null,
            };
          },
        };
        return {
          window,
          port,
          release() {
            released++;
            release();
          },
        };
      },
      subscribe(listener) {
        changes.add(listener);
        return () => {
          changes.delete(listener);
        };
      },
    },
    2,
    1000,
  );
  const caller = childStreamRouter(owner).createCaller(ctx);
  const workspace = new RetainedChildStreams(
    {
      inventory: (selected) => caller.inventory({ run: selected }),
      watch: (scope) => owner.watch(scope),
      baseline: (scope) => caller.baseline({ scope }),
      older: (scope, cursor) => caller.older({ scope, cursor }),
    },
    connector(),
    2,
  );
  try {
    const scopes = await caller.inventory({ run });
    assert.equal(scopes.length, 2);
    assert(scopes.every((scope) => scope.run.scope.session === "parent"));
    const routed = (await caller.watch({ scope: scopes[0]! }))[Symbol.asyncIterator]();
    assert.equal((await routed.next()).done, false);
    await routed.return?.();
    const denied = childStreamRouter(owner).createCaller({
      ...ctx,
      identity: { ...ctx.identity, principal: "other" },
    });
    await assert.rejects(denied.inventory({ run }), /CHILD_ACTOR_FENCED/);
    workspace.selectRoot(run);
    const a = workspace.view(scopes[0]!),
      unmount = a.commit();
    await tick();
    assert.equal(a.getSnapshot().freshness, "current");
    assert.equal(reads, 0, "A streamed snapshot never fetches history");
    a.anchor.read({ rowId: "anchor", offset: 17 });
    a.pin(true);
    unmount();
    await tick();
    const b = workspace.view(scopes[1]!),
      releaseB = b.commit();
    await tick();
    current.window("child-a").update({
      rows: [
        {
          id: "live",
          kind: "assistant",
          lifecycle: "running",
          body: { kind: "partial", text: "streaming child", missing: ["final"] },
          native: {},
        },
      ],
    });
    await tick();
    assert.equal(a.getSnapshot().history?.rows[0]?.id, "live");
    const transcript = a.transcript.getSnapshot();
    assert.equal(a.transcript.getSnapshot(), transcript);
    assert(!("state" in transcript), "Child rendering does not fabricate parent session state");
    const markup = renderToStaticMarkup(
      createElement(ReadonlyTranscript, { view: a.transcript, title: "Child history" }),
    );
    assert.match(markup, /streaming child/);
    assert(
      !markup.includes("<textarea") && !markup.includes(">Send<") && !markup.includes(">Stop<"),
    );
    assert.equal(reads, 0, "Read-only child rendering does not fetch history");
    assert.equal(a.anchor.getSnapshot().mode, "readingHistory");
    assert.deepEqual(workspace.view(scopes[0]!).anchor.getSnapshot().anchor, {
      rowId: "anchor",
      offset: 17,
    });
    assert.equal((await a.baseline()).state, "ready");
    assert.equal(reads, 1);
    await tick();
    assert.equal(a.getSnapshot().history?.rows[0]?.id, "child-a:older");
    const old = current;
    generation = 2;
    current = history({ ...run, generation });
    for (const changed of changes) changed();
    workspace.selectRoot({ ...run, generation });
    assert.equal(a.getSnapshot().retired, true);
    assert.throws(() => a.baseline(), /ROOT_FENCED/);
    assert.equal(old.window("child-a").subscriberCount, 0);
    releaseB();
    await workspace.close();
    await owner.close();
    old.close();
    assert.equal(released, 2);
    async function typeChecks() {
      // @ts-expect-error Child views cannot send or own lifecycle controls.
      a.send({ text: "forbidden" });
      // @ts-expect-error The typed child router has no native Stop route.
      await caller.stop({ run });
    }
    void typeChecks;
  } finally {
    await workspace.close();
    await owner.close();
    current.close();
  }
});

test("retiring a child observer keeps pending read custody until actual settlement and releases its native hold once", async () => {
  const scope: HistoryScope = { run, attachment: "a", stream: "child" },
    window = new HistoryWindow(scope),
    gate = deferred<NativePage>();
  let reads = 0,
    releases = 0;
  const owner = new ChildStreamOwner(
    {
      assertRun() {},
      inventory: () => [scope],
      bind: () => ({
        window,
        port: {
          scope,
          mode: "repeatable",
          async read() {
            reads++;
            return gate.promise;
          },
        },
        release() {
          releases++;
        },
      }),
      subscribe: () => () => {},
    },
    1,
    0,
  );
  try {
    const first = owner.baseline(scope),
      duplicate = owner.baseline(scope);
    assert.equal((await first).state, "waitingExpired");
    assert.equal((await duplicate).state, "waitingExpired");
    assert.equal(reads, 1);
    const closing = owner.close();
    assert.equal(owner.readiness().ready, false);
    assert.equal(releases, 0);
    gate.resolve({ status: "page", scope, rows: [], placement: "before", nextCursor: null });
    await closing;
    assert.equal(owner.readiness().ready, true);
    assert.equal(releases, 1);
    assert.equal(window.getSnapshot().revision, 0);
    assert.throws(() => owner.inventory(run), /CLOSED/);
  } finally {
    gate.resolve({ status: "unsupported" });
    await owner.close();
    window.close();
  }
});

test("resident capacity cannot resurrect evicted browser views and failed Host hold release remains unready", async () => {
  const source = history(),
    scopes = source.scopes().filter((scope) => scope.stream !== "root");
  const owner = new ChildStreamOwner(
    {
      assertRun() {},
      inventory: () => scopes,
      bind: (scope) => ({
        window: source.window(scope.stream),
        port: {
          scope,
          mode: "repeatable",
          async read() {
            return { status: "unsupported" };
          },
        },
        release() {
          throw Error("release unproved");
        },
      }),
      subscribe: () => () => {},
    },
    1,
  );
  const workspace = new RetainedChildStreams(
    {
      inventory: async () => scopes,
      watch: (scope) => owner.watch(scope),
      baseline: async () => ({ state: "unsupported" }),
      older: async () => ({ state: "unsupported" }),
    },
    connector(),
    1,
  );
  workspace.selectRoot(run);
  const old = workspace.view(scopes[0]!);
  workspace.view(scopes[1]!);
  assert.throws(() => old.commit(), /ROOT_FENCED/);
  await workspace.close();
  const observer = owner.watch(scopes[0]!);
  await observer.next();
  await observer.return?.();
  await assert.rejects(owner.close(), /release unproved/);
  assert.equal(owner.readiness().ready, false);
  source.close();
});
