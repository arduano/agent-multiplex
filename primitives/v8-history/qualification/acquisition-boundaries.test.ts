import assert from "node:assert/strict";
import test from "node:test";
import type { CodexScope, Frame, HistoryPage, Row, Snapshot } from "../src/contracts/types.js";
import { mergeHistoryOrder } from "../src/contracts/order.js";
import { HistoryClient } from "../src/client/history-client.js";
import { PersistedSnapshotReader, readActivePage, type NativePage } from "../src/repair/cursors.js";

const scope: CodexScope = { kind: "codex", threadId: "root", origin: {
  connection: "fixture", principal: "owner", host: "host", nativeSession: "root", attachment: "capture",
} };
const row = (id: string, text = id, version = 1): Row => ({ id, kind: "assistant", lifecycle: "completed",
  body: { kind: "complete", text, evidence: "nativeFullBody" }, native: {}, version, contentVersion: version });
const initial = (): Snapshot => ({ scope, generation: "capture:1", revision: 1, rows: [row("a"), row("b")], retirements: [], read: { state: 'idle' },
  olderEdge: { state: "available", cursor: "older" }, coverage: { knownStart: false, gaps: [] }, activity: { state: "idle", turnId: null } });
const page = (rows: readonly Row[], cursor = "deeper"): HistoryPage => ({ scope, generation: "capture:1", rows, olderEdge: { state: "available", cursor } });

test("exact anchor merge preserves both orders and places new runs adjacent to shared boundaries", () => {
  assert.deepEqual(mergeHistoryOrder(["a", "b", "c", "d"], ["x", "b", "y", "d", "z"], true), ["a", "x", "b", "c", "y", "d", "z"]);
  assert.deepEqual(mergeHistoryOrder(["a", "b", "c"], ["x", "b"], false), ["a", "x", "b", "c"]);
  assert.deepEqual(mergeHistoryOrder(["a", "b", "c"], ["b", "x"], true), ["a", "b", "x", "c"]);
  assert.deepEqual(mergeHistoryOrder(["a"], ["opaque-z", "opaque-a"], true), ["opaque-z", "opaque-a", "a"]);
  assert.deepEqual(mergeHistoryOrder(["a"], ["opaque-z", "opaque-a"], false), ["a", "opaque-z", "opaque-a"]);
  assert.throws(() => mergeHistoryOrder(["a", "b"], ["b", "a"], true), /HISTORY_ORDER_CONFLICT/);
});

test("a reversed older page commits no body, cursor or viewport mutation and retains its acceptance token", () => {
  const client = new HistoryClient(scope), view = client.view(), other = client.view("other");
  client.apply({ kind: "snapshot", snapshot: initial() });
  view.viewport.userScroll("earlier", false); view.viewport.report({ rowId: "b", offsetPx: 8 });
  const token = view.beginOlderRead(), before = view.getSnapshot(), otherBefore = other.getSnapshot();
  let published = 0; view.subscribe(() => published++);
  assert.throws(() => view.applyPage(page([row("b", "must not leak", 2), row("a")]), token), /HISTORY_ORDER_CONFLICT/);
  assert.strictEqual(view.getSnapshot(), before); assert.strictEqual(other.getSnapshot(), otherBefore);
  assert.equal(published, 0); assert.strictEqual(view.beginOlderRead(), token);
  assert.equal(view.applyPage(page([row("old"), row("a")]), token), "applied");
  assert.deepEqual(view.getSnapshot().rows.map(value => value.id), ["old", "a", "b"]);
  assert.deepEqual(view.getSnapshot().viewport.anchor, { rowId: "b", offsetPx: 8 });
  assert.equal(view.getSnapshot().viewport.intent, "readingHistory");
});

test("contradictory live order rejects the entire Host transaction before either retained view changes", () => {
  const client = new HistoryClient(scope), left = client.view("left"), right = client.view("right");
  client.apply({ kind: "snapshot", snapshot: initial() });
  const before = client.current, leftBefore = left.getSnapshot(), rightBefore = right.getSnapshot();
  const frame: Extract<Frame, { kind: "commit" }> = { kind: "commit", scope, generation: "capture:1", baseRevision: 1, revision: 2,
    changes: [{ kind: "replaceRow", row: row("b", "must not leak", 2) }], order: ["b", "a"],
    olderEdge: { state: "available", cursor: "later-edge" }, coverage: { knownStart: false, gaps: [] }, activity: { state: "idle", turnId: null } };
  assert.throws(() => client.apply(frame), /HISTORY_ORDER_CONFLICT/);
  assert.strictEqual(client.current, before); assert.strictEqual(left.getSnapshot(), leftBefore); assert.strictEqual(right.getSnapshot(), rightBefore);
  assert.equal(client.apply({ ...frame, order: ["a", "b"] }), "applied");
  assert.deepEqual(left.getSnapshot().rows[1]!.body, { kind: "complete", text: "must not leak", evidence: "nativeFullBody" });
});

test("a new native generation can reorder reused IDs while retaining old provenance and fencing the old page", () => {
  const client = new HistoryClient(scope), view = client.view();
  client.apply({ kind: "snapshot", snapshot: { ...initial(), rows: [row("a"), row("b"), row("retained-context")] } });
  const oldRead = view.beginOlderRead();
  assert.equal(client.apply({ kind: "snapshot", snapshot: { ...initial(), generation: "capture:2", revision: 0,
    rows: [row("b", "new b"), row("a", "new a")] } }), "applied");
  assert.deepEqual(view.getSnapshot().rows.map(value => value.id), ["retained-context", "b", "a"]);
  assert.equal(view.getSnapshot().origins["retained-context"]!.generation, "capture:1");
  assert.equal(view.getSnapshot().origins.b!.generation, "capture:2");
  assert.equal(view.getSnapshot().includesPriorGeneration, true);
  const before = view.getSnapshot();
  assert.equal(view.applyPage(page([row("old page must not appear")]), oldRead), "stale");
  assert.strictEqual(view.getSnapshot(), before);
  assert.equal(view.getSnapshot().viewport.loadingOlder, false);
});

test("active and persisted readers reject contradictory continuation evidence instead of certifying false empty history", async () => {
  const terminal: NativePage = { page: { ...page([]), olderEdge: { state: "end", evidence: "nativeBoundary" } }, status: "ok", hasMore: false, nextCursor: null };
  const contradictions: NativePage[] = [
    { ...terminal, page: page([]) },
    { ...terminal, hasMore: true, nextCursor: "next" },
    { ...terminal, hasMore: true, nextCursor: "different", page: page([], "next") },
    { ...terminal, nextCursor: "unused-but-contradictory" },
  ];
  for (const contradiction of contradictions) {
    await assert.rejects(readActivePage(async () => contradiction, scope, "input", 1, 4096), /PAGE_BOUNDARY_CONFLICT/);
    let calls = 0;
    const persisted = new PersistedSnapshotReader(async () => {
      calls++; return { ...contradiction, snapshot: { id: "pinned", generation: "journal", byteBoundary: 8 } };
    }, scope);
    await assert.rejects(persisted.read(), /PAGE_BOUNDARY_CONFLICT/);
    await assert.rejects(persisted.read(), /SNAPSHOT_ENDED/); assert.equal(calls, 1);
  }
  const accepted = await readActivePage(async () => terminal, scope, "input", 1, 4096);
  assert.deepEqual(accepted.page.olderEdge, { state: "end", evidence: "nativeBoundary" });
});
