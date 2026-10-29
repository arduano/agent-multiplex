import assert from "node:assert/strict";
import { test } from "node:test";
import { codexItemKey } from "../../src/codex/client/index.js";
import { CodexWorkspace } from "../../src/codex/client/index.js";
import { deferred, fixture, message, run, thread, turn, until } from "./fixture.js";

test("initial-read eligibility respects native creation provenance and overlapping body failures remain visible", async () => {
  const created = fixture(true, "created"),
    createdView = created.workspace.view(run),
    releaseCreated = createdView.commit();
  try {
    await until(() => createdView.getSnapshot().entry.freshness === "current");
    assert.equal(created.reads.length, 0, "a proved fresh-created root has a valid empty baseline");
    assert.equal(createdView.getSnapshot().read.state, "idle");
  } finally {
    releaseCreated();
    await created.close();
  }
  const unknown = fixture(),
    metadata = deferred<unknown>();
  unknown.setRead((method) =>
    method === "thread/read"
      ? metadata.promise
      : { data: [], nextCursor: null, backwardsCursor: null },
  );
  const workspace = new CodexWorkspace({
    client: unknown.client,
    observations: unknown.observations,
    limits: { maxPendingReads: 1 },
  });
  const view = workspace.view(run),
    release = view.commit();
  try {
    await until(() => unknown.reads.length === 1);
    metadata.resolve({ thread: thread() });
    await until(() => view.getSnapshot().read.state === "failed");
    assert.match(String(view.getSnapshot().read.error), /CODEX_READ_CAPACITY/);
    await view.readTurns();
    assert.equal(view.getSnapshot().read.state, "ready");
    assert.equal(unknown.reads.length, 2, "explicit retry runs the previously refused body read");
    assert.equal(unknown.effects, 0);
  } finally {
    metadata.resolve({ thread: thread() });
    release();
    await workspace.close();
    await unknown.close();
  }
});

test("native views share one run capture and initial reads while retaining independent anchors/frontiers across switches", async () => {
  const f = fixture(true),
    first = f.workspace.view(run),
    second = f.workspace.view(run);
  assert.equal(f.opens + f.reads.length, 0);
  let release = first.commit(),
    releaseSecond = second.commit();
  try {
    await until(
      () =>
        first.getSnapshot().pages.length === 2 &&
        second.getSnapshot().pages.length === 2 &&
        f.watchers === 1,
    );
    assert.equal(f.opens, 1);
    assert.equal(f.reads.length, 2);
    assert.equal(first.anchor.getSnapshot().mode, "followingLive");
    const older = await first.readTurns({
      cursor: "older-native-token",
      limit: 100,
      sortDirection: "desc",
      itemsView: "full",
    });
    assert.equal(older.backwardsCursor, "newer-native-token");
    first.anchor.read({ rowId: codexItemKey("root", "turn", "message"), offset: 13 });
    assert.equal(first.getSnapshot().pages.length, 3);
    assert.equal(second.getSnapshot().pages.length, 2);
    assert.equal(second.anchor.getSnapshot().mode, "followingLive");
    first.pin(true);
    release();
    releaseSecond();
    await until(() => f.watchers === 1);
    assert.equal(first.getSnapshot().pages.length, 3);
    release = first.commit();
    releaseSecond = second.commit();
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(f.opens, 1);
    assert.equal(f.reads.length, 3);
    assert.equal(first.anchor.getSnapshot().anchor?.offset, 13);
    const third = f.workspace.view(run),
      releaseThird = third.commit();
    await until(() => third.getSnapshot().pages.length === 2);
    assert.equal(f.reads.length, 3, "a later view reuses current shared baseline bytes");
    releaseThird();
    third.close();
    f.emit({
      method: "item/started",
      params: {
        threadId: "root",
        turnId: "turn",
        startedAtMs: 1,
        item: message("already streamed"),
      },
    });
    await until(() => first.getSnapshot().entry.items.length === 1);
    const observed = f.workspace.view(run),
      releaseObserved = observed.commit();
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(observed.getSnapshot().pages.length, 0);
    assert.equal(
      f.reads.length,
      3,
      "a useful streamed native baseline needs no initial history read",
    );
    releaseObserved();
    observed.close();
    first.pin(false);
  } finally {
    release();
    releaseSecond();
    await f.close();
  }
  assert.equal(f.watchers + f.effects, 0);
});

test("read/live races preserve exact native provenance; final turn item bodies repair without completing tools and reversion fences late pages", async () => {
  const f = fixture(),
    view = f.workspace.view(run),
    release = view.commit(),
    held = deferred<unknown>();
  f.setRead(() => held.promise);
  try {
    await until(() => f.watchers === 1 && view.getSnapshot().entry.freshness === "current");
    const read = view.readTurns({ limit: 100 });
    await until(() => f.reads.length === 1);
    f.emit({
      method: "item/started",
      params: { threadId: "root", turnId: "turn", item: message(""), startedAtMs: 1 },
    });
    f.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "root", turnId: "turn", itemId: "message", delta: "live" },
    });
    f.emit({
      method: "turn/completed",
      params: { threadId: "root", turn: turn([message("live final")]) },
    });
    await until(
      () =>
        view.getSnapshot().entry.items[0]?.item.type === "agentMessage" &&
        view.getSnapshot().entry.items[0]?.revision === 3,
    );
    held.resolve({
      data: [turn([message("stored projection")])],
      nextCursor: "native-token",
      backwardsCursor: null,
    });
    await read;
    const state = view.getSnapshot(),
      live = state.entry.items[0]!;
    assert.equal(live.item.type === "agentMessage" && live.item.text, "live final");
    assert.equal(live.completed, false, "turn completion is not item/completed evidence");
    const stored = state.pages[0]!;
    assert.equal(
      "page" in stored &&
        stored.page.kind === "turns" &&
        stored.page.result.data[0]!.items[0]!.type === "agentMessage" &&
        stored.page.result.data[0]!.items[0]!.text,
      "stored projection",
    );
    const late = deferred<unknown>();
    f.setRead(() => late.promise);
    const pending = view.readTurns({ cursor: "native-token" });
    await until(() => f.reads.length === 2);
    f.emit({ method: "thread/reverted", params: { threadId: "root" } });
    await until(() => "root" in view.getSnapshot().entry.invalidatedThreads);
    late.resolve({
      data: [turn([message("removed turn")])],
      nextCursor: null,
      backwardsCursor: null,
    });
    await pending;
    assert.equal(view.getSnapshot().entry.items.length, 0);
    assert.ok(view.getSnapshot().pages.every((page) => page.state === "stale"));
    f.setRead(() => ({ data: [], nextCursor: null, backwardsCursor: null }));
    await view.readTurns();
    assert.equal(view.getSnapshot().pages.at(-1)!.state, "current");
    f.disconnect();
    await until(() => f.opens === 2 && view.getSnapshot().entry.freshness === "current");
    assert.equal(
      view.getSnapshot().pages.at(-1)!.state,
      "current",
      "repeated capture checkpoints are not new reversions",
    );
    assert.equal(f.effects, 0);
  } finally {
    release();
    await f.close();
  }
});

test("bounded native page cache retains a committed view's anchor and explicitly exposes later eviction", async () => {
  const f = fixture(),
    workspace = new CodexWorkspace({
      client: f.client,
      observations: f.observations,
      loadInitialHistory: false,
      limits: { maxPages: 1 },
    });
  const first = workspace.view(run),
    second = workspace.view(run),
    release = first.commit(),
    releaseSecond = second.commit();
  let held = true;
  try {
    await first.readTurns({ cursor: "first" });
    first.anchor.read({ rowId: codexItemKey("root", "turn", "message"), offset: 8 });
    await assert.rejects(second.readTurns({ cursor: "second" }), /CODEX_PAGE_CAPACITY/);
    assert.equal(first.getSnapshot().pages[0]!.state, "current");
    release();
    held = false;
    await second.readTurns({ cursor: "second" });
    assert.equal(first.getSnapshot().pages[0]!.state, "evicted");
    assert.equal(first.anchor.getSnapshot().anchor?.offset, 8);
    assert.equal(
      f.reads.length,
      3,
      "capacity refusal does not latch a successful or failed native read",
    );
  } finally {
    if (held) release();
    releaseSecond();
    await workspace.close();
    await f.close();
  }
});

test("reconnect retains native pages and view intent, fences attachment deltas, and retries the same failed native read without effect replay", async () => {
  const f = fixture(),
    view = f.workspace.view(run),
    child = f.workspace.view(run, "child"),
    release = view.commit(),
    releaseChild = child.commit();
  try {
    await until(() => f.watchers === 1 && view.getSnapshot().entry.freshness === "current");
    await view.readTurns({ cursor: "older" });
    view.anchor.read({ rowId: "native-anchor", offset: 5 });
    f.emit({
      method: "item/started",
      params: { threadId: "root", turnId: "turn", item: message("before"), startedAtMs: 1 },
    });
    await until(() => view.getSnapshot().entry.items.length === 1);
    f.replaceAttachment();
    f.disconnect();
    await until(
      () => f.opens === 2 && view.getSnapshot().entry.capture?.attachment === "capture-2",
    );
    assert.deepEqual(f.after[1], { attachment: "capture-1", revision: 1 }, JSON.stringify(f.after));
    assert.equal(view.getSnapshot().entry.items[0]!.continuity, "partial");
    f.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "root", turnId: "turn", itemId: "message", delta: "unbased" },
    });
    await until(() => view.getSnapshot().entry.unbased.length === 1);
    const retainedItem = view.getSnapshot().entry.items[0]!.item;
    assert.equal(retainedItem.type === "agentMessage" && retainedItem.text, "before");
    assert.equal(view.getSnapshot().pages.length, 1);
    assert.equal(view.anchor.getSnapshot().anchor?.offset, 5);
    assert.equal(child.anchor.getSnapshot().mode, "followingLive");
    let attempts = 0;
    f.setRead(() => {
      if (++attempts === 1) throw Error("temporary read failure");
      return { data: [], nextCursor: null, backwardsCursor: null };
    });
    await assert.rejects(child.readTurns({ cursor: "same-native-token" }));
    await child.readTurns({ cursor: "same-native-token" });
    assert.equal(attempts, 2);
    assert.equal((f.reads.at(-1)!.params as { threadId: string }).threadId, "child");
    assert.equal(f.effects, 0);
  } finally {
    release();
    releaseChild();
    await f.close();
  }
});
