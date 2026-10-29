import assert from "node:assert/strict";
import { test } from "node:test";
import { RetainedWorkspace } from "../../src/client/index.js";
import { command, deferred, fixture, receipt, row, runFor, scope, until } from "./fixture.js";

test("prepared views are inert; two committed viewers share feeds, switches retain drafts/history and pins retain only background observations", async () => {
  const f = fixture(),
    workspace = new RetainedWorkspace(f),
    a = workspace.view(scope),
    second = workspace.view(scope);
  assert.equal(f.observations.opened, 0);
  const releaseA = a.commit(),
    releaseSecond = second.commit();
  await until(() => a.entry.getSnapshot().historyFreshness === "current");
  assert.equal(f.observations.opened, 3);
  await a.entry.setDraft("keep draft");
  f.feed.window().update({ rows: [row("retained")] });
  await until(() => a.entry.getSnapshot().history.rows.length === 1);
  await a.entry.pin(true);
  releaseA();
  releaseSecond();
  await workspace.settled();
  assert.equal(f.observations.connections.size, 3);
  const other = workspace.view({ ...scope, session: "other" }),
    releaseOther = other.commit();
  await until(() => other.entry.getSnapshot().freshness === "current");
  releaseOther();
  await workspace.settled();
  const back = workspace.view(scope),
    releaseBack = back.commit();
  assert.equal(back.entry, a.entry);
  assert.equal(back.entry.getSnapshot().draft, "keep draft");
  assert.equal(back.entry.getSnapshot().history.rows[0]!.id, "retained");
  assert.equal(f.feed.baselineReads + f.feed.olderReads + f.feed.dispatches.length, 0);
  releaseBack();
  await a.entry.pin(false);
  await workspace.settled();
  assert.equal(f.observations.connections.size, 0);
  await workspace.close();
});

test("durable local admission follows only the initiating view, before native ACK; later gestures and unmount fence delayed presentation", async () => {
  const f = fixture(),
    workspace = new RetainedWorkspace(f),
    view = workspace.view(scope),
    other = workspace.view(scope);
  const release = view.commit(),
    releaseOther = other.commit();
  await until(() => view.entry.getSnapshot().freshness === "current");
  view.anchor.read({ rowId: "old", offset: 4 });
  other.anchor.read({ rowId: "other", offset: 8 });
  const durable = deferred<void>(),
    native = deferred<ReturnType<typeof receipt>>();
  f.persistence.barrier = durable.promise;
  f.feed.dispatchResult = async () => native.promise;
  const pending = view.submit(command("one"));
  await Promise.resolve();
  assert.equal(f.feed.dispatches.length, 0);
  assert.equal(view.anchor.getSnapshot().mode, "readingHistory");
  durable.resolve();
  const handle = await pending;
  await until(() => f.feed.dispatches.length === 1);
  assert.equal(view.anchor.getSnapshot().mode, "followingLive");
  assert.equal(other.anchor.getSnapshot().mode, "readingHistory");
  view.anchor.read({ rowId: "new-choice", offset: 0 });
  native.resolve(receipt("one"));
  await handle.settled;
  assert.equal(view.anchor.getSnapshot().anchor!.rowId, "new-choice");
  f.feed.dispatchResult = undefined;
  const another = deferred<void>();
  f.persistence.barrier = another.promise;
  view.anchor.read({ rowId: "same-position", offset: 0 });
  const later = view.submit(command("two"));
  view.anchor.gesture();
  another.resolve();
  await (
    await later
  ).settled;
  assert.equal(view.anchor.getSnapshot().mode, "readingHistory");
  const closing = deferred<void>();
  f.persistence.barrier = closing.promise;
  const unmounted = view.submit(command("three"));
  release();
  closing.resolve();
  await (
    await unmounted
  ).settled;
  assert.equal(view.anchor.getSnapshot().mode, "readingHistory");
  assert.equal(f.feed.dispatches.length, 3);
  releaseOther();
  await workspace.settled();
  await workspace.close();
});

test("lost replies reconcile exact originals only; reconnect preserves captured payload/run and native confirmation remains separate", async () => {
  const f = fixture(),
    workspace = new RetainedWorkspace(f),
    view = workspace.view(scope),
    release = view.commit();
  await until(() => view.entry.getSnapshot().historyFreshness === "current");
  f.feed.dispatchResult = async () => {
    throw Error("Lost reply");
  };
  const input = command("original"),
    handle = await view.submit(input);
  await handle.settled;
  assert.equal(handle.getSnapshot().state, "unknown");
  await f.observations.offline();
  assert.equal(view.entry.getSnapshot().freshness, "unavailable");
  f.observations.online();
  await until(() => view.entry.getSnapshot().freshness === "current");
  f.feed.originalResult = receipt("original");
  await view.entry.checkOriginal("original");
  assert.equal(handle.getSnapshot().state, "succeeded");
  assert.equal(handle.getSnapshot().nativeConfirmed, false);
  assert.deepEqual(f.feed.dispatches[0]!.command, input);
  assert.equal(f.feed.dispatches.length, 1);
  assert.deepEqual(f.feed.originalReads, ["original"]);
  f.feed
    .window()
    .update({ rows: [{ ...row("user"), kind: "user", native: { originalId: "original" } }] });
  await until(() => handle.getSnapshot().nativeConfirmed);
  view.anchor.read({ rowId: "user", offset: 0 });
  f.feed.window().update({ rows: [row("assistant")] });
  await until(() => view.entry.getSnapshot().history.rows.length === 2);
  assert.equal(view.anchor.getSnapshot().mode, "readingHistory");
  release();
  await workspace.settled();
  await workspace.close();
  const restored = new RetainedWorkspace(f);
  await restored.restore();
  assert.equal(restored.entry(scope).getSnapshot().originals[0]!.state, "succeeded");
  assert.equal(f.feed.dispatches.length, 1);
  await restored.close();
});

test("local validation/persistence failures retain draft and cannot dispatch, follow or erase an unknown original", async () => {
  const f = fixture(),
    workspace = new RetainedWorkspace(f),
    view = workspace.view(scope),
    release = view.commit();
  await until(() => view.entry.getSnapshot().freshness === "current");
  await view.entry.setDraft("keep this");
  view.anchor.read({ rowId: "older", offset: 0 });
  assert.throws(() => view.submit({ ...command("wrong-run"), run: runFor(scope, 2) }), /FENCED/);
  assert.equal(f.feed.dispatches.length, 0);
  f.persistence.fail = true;
  await assert.rejects(view.submit(command("storage")), /PERSISTENCE/);
  assert.equal(f.feed.dispatches.length, 0);
  assert.equal(view.entry.getSnapshot().draft, "keep this");
  assert.equal(view.anchor.getSnapshot().mode, "readingHistory");
  f.persistence.fail = false;
  release();
  await workspace.settled();
  await workspace.close();
});

test("a new native generation during local persistence cannot rewrite the saved original or follow its replacement view", async () => {
  const f = fixture(),
    workspace = new RetainedWorkspace(f),
    view = workspace.view(scope),
    release = view.commit();
  await until(() => view.entry.getSnapshot().freshness === "current");
  view.anchor.read({ rowId: "old", offset: 3 });
  const durable = deferred<void>();
  f.persistence.barrier = durable.promise;
  f.feed.dispatchResult = async (s, input) => receipt(input.id, "refused", s);
  const input = command("old-binding"),
    pending = view.submit(input);
  f.feed
    .stateTopic()
    .publish({ scope, run: runFor(scope, 2), phase: "running", activity: "idle", selection: {} });
  await until(() => view.entry.getSnapshot().state?.run?.generation === 2);
  durable.resolve();
  await (
    await pending
  ).settled;
  assert.deepEqual(f.feed.dispatches[0]!.command, input);
  assert.equal(view.anchor.getSnapshot().mode, "readingHistory");
  release();
  await workspace.settled();
  await workspace.close();
});

test("restored uncertain originals remain observation-only until an exact Host receipt is read", async () => {
  const f = fixture(),
    workspace = new RetainedWorkspace(f),
    view = workspace.view(scope),
    release = view.commit();
  await until(() => view.entry.getSnapshot().freshness === "current");
  f.feed.dispatchResult = async () => {
    throw Error("Lost response");
  };
  await (
    await view.submit(command("restored"))
  ).settled;
  release();
  await workspace.settled();
  await workspace.close();
  const restored = new RetainedWorkspace(f);
  await restored.restore();
  const entry = restored.entry(scope);
  assert.equal(entry.getSnapshot().originals[0]!.state, "unknown");
  assert.equal(f.feed.dispatches.length, 1);
  f.feed.originalResult = receipt("restored");
  await entry.checkOriginal("restored");
  assert.equal(entry.getSnapshot().originals[0]!.state, "succeeded");
  assert.equal(f.feed.dispatches.length, 1);
  assert.deepEqual(f.feed.originalReads, ["restored"]);
  await restored.close();
});

test("unresolved originals reserve Stop while terminal activity rolls; idle eviction waits actual cleanup and protects drafts", async () => {
  const f = fixture(),
    workspace = new RetainedWorkspace({
      ...f,
      limits: { maxEntries: 1, maxOriginals: 1, reservedStops: 1, recentOriginals: 2 },
    });
  const view = workspace.view(scope),
    release = view.commit();
  await until(() => view.entry.getSnapshot().freshness === "current");
  f.feed.dispatchResult = async (s, input) => receipt(input.id, "unknown", s);
  const first = await view.submit(command("unknown"));
  await first.settled;
  assert.throws(() => view.submit(command("ordinary")), /FULL/);
  const stop = await view.entry.submit({
    id: "stop",
    run: runFor(),
    payload: { generation: 1 },
    kind: "stop",
  });
  await stop.settled;
  assert.equal(f.feed.dispatches.length, 2);
  f.feed.originalResult = receipt("unknown");
  await view.entry.checkOriginal("unknown");
  f.feed.originalResult = receipt("stop");
  await view.entry.checkOriginal("stop");
  f.feed.dispatchResult = undefined;
  for (let index = 0; index < 40; index++)
    await (
      await view.submit(command(`recent-${index}`))
    ).settled;
  assert.equal(view.entry.getSnapshot().originals.length, 2);
  assert.equal(first.getSnapshot().state, "succeeded");
  assert.equal(f.feed.dispatches.length, 42);
  const cleanup = deferred<void>();
  f.observations.cleanupBarrier = cleanup.promise;
  release();
  assert.throws(() => workspace.entry({ ...scope, session: "blocked" }), /FULL/);
  cleanup.resolve();
  await workspace.settled();
  await view.entry.setDraft("protected draft");
  assert.throws(() => workspace.entry({ ...scope, session: "blocked" }), /FULL/);
  await view.entry.setDraft("");
  workspace.entry({ ...scope, session: "replacement" });
  assert.equal(workspace.entryCount, 1);
  await workspace.close();
});

test("logical Stop remains admissible before native binding; stopped history cannot authorize ordinary Send", async () => {
  const f = fixture(),
    workspace = new RetainedWorkspace(f),
    view = workspace.view(scope),
    release = view.commit();
  f.feed
    .stateTopic()
    .publish({ scope, run: null, phase: "starting", activity: "unknown", selection: {} });
  await until(() => view.entry.getSnapshot().freshness === "current");
  const stop = {
    id: "stop-preparing",
    kind: "stop",
    run: null,
    payload: { generation: 0 },
  } as const;
  await (
    await view.submit(stop)
  ).settled;
  assert.deepEqual(f.feed.dispatches[0]!.command, stop);
  f.feed
    .stateTopic()
    .publish({ scope, run: runFor(), phase: "stopped", activity: "idle", selection: {} });
  await until(() => view.entry.getSnapshot().state?.phase === "stopped");
  assert.throws(() => view.submit(command("stopped-send")), /FENCED/);
  assert.equal(f.feed.dispatches.length, 1);
  release();
  await workspace.settled();
  await workspace.close();
});

test("submitDraft clears exactly the admitted draft, preserving edits made while durable admission is pending", async () => {
  const f = fixture(),
    workspace = new RetainedWorkspace(f),
    view = workspace.view(scope),
    release = view.commit();
  await until(() => view.entry.getSnapshot().freshness === "current");
  await view.entry.setDraft("first");
  const first = await view.submitDraft({ ...command("draft-one"), optimisticText: "first" });
  assert.equal(view.entry.getSnapshot().draft, "");
  await first.settled;
  await view.entry.setDraft("second");
  const durable = deferred<void>();
  f.persistence.barrier = durable.promise;
  const next = view.submitDraft({ ...command("draft-two"), optimisticText: "second" });
  const edit = view.entry.setDraft("new third draft");
  durable.resolve();
  await (
    await next
  ).settled;
  await edit;
  assert.equal(view.entry.getSnapshot().draft, "new third draft");
  assert.equal(f.feed.dispatches.length, 2);
  release();
  await workspace.settled();
  await workspace.close();
});
