import test from "node:test";
import assert from "node:assert/strict";
import type { HistoryRecord } from "../src/acquisition/types.js";
import type { CodexScope, Row } from "../src/contracts/types.js";
import { HistoryHub } from "../src/host/history-owner.js";
import { HistoryClient } from "../src/client/history-client.js";
import { HistoryAcquisition } from "../src/acquisition/owner.js";
import { createCodexHistoryPort } from "../src/native/codex/history.js";

const scope: CodexScope = { kind: "codex", threadId: "thread", origin: { connection: "c", principal: "p", host: "h", nativeSession: "s", attachment: "a" } };
const end = { state: "end", evidence: "nativeBoundary" } as const;
const rec = (id: string, text: string, lifecycle: HistoryRecord["lifecycle"] = "completed"): HistoryRecord => ({ id, kind: "assistant", lifecycle,
  body: lifecycle === "unknown" ? { kind: "partial", text, missing: ["final"] } : { kind: "complete", text, evidence: "nativeFullBody" }, native: { messageId: id } });
const contents = (row: Row): string | null => row.body.kind === "unavailable" ? null : row.body.text;
function rig(maxBodyBytes = 4096, maxRows = 64) { const hub = new HistoryHub({ maxBodyBytes, maxRows }); hub.open(scope); return { hub, owner: hub.owner(scope) }; }

test("explicit recovery rebases a full current window without retiring retained history or blocking older pages", async () => {
  const { hub, owner } = rig(), client = new HistoryClient(scope), stream = hub.watch(scope), view = client.view();
  const deliver = () => { const frames = stream.drain(); for (const frame of frames) assert.equal(client.apply(frame), "applied"); return frames; };
  try {
    deliver();
    for (let index = 0; index < 64; index++) {
      hub.emit(scope, [{ type: "finish", id: `captured-${index}`, kind: "assistant", lifecycle: "completed", text: `body-${index}` }]);
      deliver();
    }
    const retained = view.getSnapshot().rows[0]!;
    view.viewport.report({ rowId: retained.id, offsetPx: 17 });
    hub.emit(scope, [{ type: "readBoundary", factId: "compacted-item", reason: "Native compaction changed the history read boundary" }]);
    owner.setReadContext("compacted-reader"); deliver();
    let calls = 0;
    const acquisition = new HistoryAcquisition(owner, { scope, mode: "active", context: "compacted-reader", read: async request => {
      calls++;
      if (request.cursor === null) return { scope, status: "ok", records: [rec("captured-63", "body-63"), rec("unseen-latest", "latest")], hasMore: true, nextCursor: "prior-page", gaps: [] };
      assert.equal(request.cursor, "prior-page");
      return { scope, status: "ok", records: [rec("earlier", "earlier"), rec(retained.id, "body-0")], hasMore: false, nextCursor: null, gaps: [] };
    } });
    const baseline = acquisition.baseline("E06", "actual-compaction");
    const recovered = await baseline.wait(1000);
    assert.equal(recovered.state, "value", JSON.stringify(recovered));
    if (recovered.state !== "value") return;
    assert.equal(recovered.value.status, "ready");
    const frames = deliver();
    assert.equal(owner.snapshot().rows.length, 64);
    assert.equal(owner.snapshot().rows.at(-1)!.id, "unseen-latest");
    assert.deepEqual(owner.snapshot().retirements, []);
    assert.ok(frames.some(frame => frame.kind === "commit" && frame.changes.some(change => change.kind === "evictCurrentRows" && change.rowIds.includes(retained.id))));
    assert.ok(frames.every(frame => frame.kind !== "commit" || frame.changes.every(change => change.kind !== "retireRows")));
    assert.equal(view.getSnapshot().rows.length, 65);
    assert.deepEqual(view.getSnapshot().rows.find(row => row.id === retained.id), retained);
    assert.deepEqual(view.viewport.state.anchor, { rowId: retained.id, offsetPx: 17 });
    assert.strictEqual(acquisition.baseline("E06", "actual-compaction"), baseline); assert.equal(calls, 1);
    const token = view.beginOlderRead(), older = await acquisition.older(token).wait(1000);
    assert.equal(older.state, "value");
    if (older.state !== "value" || older.value.status !== "ready") return;
    assert.equal(view.applyPage(older.value.page, token), "applied");
    assert.equal(calls, 2); assert.equal(view.getSnapshot().rows.length, 66);
    assert.deepEqual(view.getSnapshot().olderEdge, end);
    assert.deepEqual(view.viewport.state.anchor, { rowId: retained.id, offsetPx: 17 });
    assert.equal(owner.snapshot().rows.length, 64);
  } finally { await stream.return(); assert.equal(owner.subscriberCount, 0); }
});

test("long partial capture rolls bounded residency and annotations while retaining running rows, client evidence and activity", async () => {
  const { hub, owner } = rig(8), client = new HistoryClient(scope), stream = hub.watch(scope), view = client.view();
  const deliver = () => { for (const frame of stream.drain()) assert.equal(client.apply(frame), "applied"); };
  try {
    deliver();
    hub.emit(scope, [{ type: "start", id: "still-running", kind: "tool" },
      { type: "activity", activity: { turnId: "long-turn", state: "working" } }]); deliver();
    for (let index = 0; index < 1030; index++) {
      hub.emit(scope, [{ type: "finish", id: `tool-${index}`, kind: "tool", lifecycle: "completed", text: `long-output-${index}` }]);
      deliver();
      assert.ok(owner.snapshot().rows.length <= 64); assert.ok(owner.snapshot().coverage.gaps.length <= 128);
      if (index === 0) view.viewport.report({ rowId: "tool-0", offsetPx: 19 });
    }
    assert.equal(owner.snapshot().rows.length, 64);
    assert.equal(owner.snapshot().rows.at(-1)!.id, "tool-1029");
    assert.equal(owner.snapshot().rows.find(row => row.id === "still-running")!.lifecycle, "running");
    assert.equal(owner.snapshot().coverage.knownStart, false);
    assert.ok(owner.snapshot().coverage.gaps.some(gap => gap.id === "history:earlier-gap-annotations-omitted" && gap.kind === "truncated"));
    assert.deepEqual(owner.snapshot().retirements, []);
    assert.equal(view.getSnapshot().rows.length, 1031);
    assert.deepEqual(view.getSnapshot().rows.find(row => row.id === "tool-0")!.body, { kind: "partial", text: "long-out", missing: ["truncated"] });
    assert.deepEqual(view.viewport.state.anchor, { rowId: "tool-0", offsetPx: 19 });
    hub.emit(scope, [{ type: "append", id: "still-running", kind: "tool", text: "done", sequence: 0 },
      { type: "finish", id: "still-running", kind: "tool", lifecycle: "completed", text: "done" },
      { type: "activity", activity: { turnId: "long-turn", state: "idle" } }]); deliver();
    assert.deepEqual(owner.snapshot().activity, { turnId: "long-turn", state: "idle" });
    assert.equal(view.getSnapshot().rows.find(row => row.id === "still-running")!.body.kind, "complete");
    // Once its bounded Host evidence has left memory, an explicit native read
    // may rediscover the same identity with a newer Host version, never a new row.
    const oldVersion = view.getSnapshot().rows.find(row => row.id === "tool-0")!.version;
    const acquisition = new HistoryAcquisition(owner, { scope, mode: "active", read: async () => ({ scope, status: "ok",
      records: [rec("tool-0", "long-output-0")].map(record => ({ ...record, kind: "tool" as const })), hasMore: false, nextCursor: null, gaps: [] }) });
    const read = await acquisition.baseline("E06", "explicit-earlier-native-boundary").wait(1000);
    assert.equal(read.state, "value", JSON.stringify(read)); deliver();
    const rediscovered = view.getSnapshot().rows.filter(row => row.id === "tool-0");
    assert.equal(rediscovered.length, 1); assert.ok(rediscovered[0]!.version > oldVersion);
    assert.equal(view.getSnapshot().rows.length, 1031);
    assert.deepEqual(owner.snapshot().olderEdge, end);
    assert.deepEqual(owner.snapshot().activity, { turnId: "long-turn", state: "idle" });
  } finally { await stream.return(); assert.equal(owner.subscriberCount, 0); }
});

test("rolling evidence retires an outstanding read fence before forgotten newer capture can be overwritten", async () => {
  const hub = new HistoryHub({ maxRows: 1, maxReadRows: 2 }); hub.open(scope);
  const owner = hub.owner(scope); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  hub.emit(scope, [{ type: "start", id: "first", kind: "assistant" }]);
  const acquisition = new HistoryAcquisition(owner, { scope, mode: "active", read: async () => {
    await held; return { scope, status: "ok", records: [rec("first", "old")], hasMore: false, nextCursor: null, gaps: [] };
  } });
  const read = acquisition.baseline("E06", "held-old-page");
  await new Promise<void>(resolve => setImmediate(resolve));
  hub.emit(scope, [{ type: "finish", id: "first", kind: "assistant", lifecycle: "completed", text: "new" }]);
  for (const id of ["second", "third"]) hub.emit(scope, [{ type: "finish", id, kind: "assistant", lifecycle: "completed", text: id }]);
  assert.equal(acquisition.reads.active, 1);
  const before = owner.snapshot(); release();
  assert.deepEqual(await read.wait(1000), { state: "value", value: { status: "stale" } });
  const { read: priorRead, revision: priorRevision, ...priorHistory } = before;
  const { read: settledRead, revision: settledRevision, ...settledHistory } = owner.snapshot();
  assert.deepEqual(priorRead, { state: "pending", target: { kind: "recover" } });
  assert.deepEqual(settledRead, { state: "idle" }); assert.equal(settledRevision, priorRevision + 1);
  assert.deepEqual(settledHistory, priorHistory, "settling a stale read cannot rewrite any captured history fact");
  assert.equal(acquisition.reads.active, 0);
});

test("default hundred-entry target retains a bounded512KiB page and shrinks the same native cursor when larger", async () => {
  const { owner } = rig(); const requests: { cursor: string | null; count: number }[] = [];
  const acquisition = new HistoryAcquisition(owner, { scope, mode: "active", read: async request => {
    requests.push({ cursor: request.cursor, count: request.count });
    return { scope, status: "ok", records: Array.from({ length: request.count }, (_, index) => rec(`large-${index}`, "x".repeat(6000))), gaps: [], hasMore: true, nextCursor: "older-native-page" };
  } });
  const observed = await acquisition.baseline("E01", "large-initial-page").wait(1000);
  assert.equal(observed.state, "value", JSON.stringify(observed));
  if (observed.state !== "value" || observed.value.status !== "ready") return;
  assert.equal(acquisition.limits.count, 100); assert.equal(acquisition.limits.maxBytes, 524_288);
  assert.deepEqual(requests, [{ cursor: null, count: 100 }, { cursor: null, count: 50 }]);
  assert.equal(observed.value.page.rows.length, 50); assert.equal(acquisition.counters.oversized, 1);
  assert.deepEqual(observed.value.page.olderEdge, { state: "available", cursor: "older-native-page" });
});

test("read-only baseline never establishes activity or a callback prefix; exact native final heals the unjoined suffix", () => {
  const { hub, owner } = rig();
  const f = owner.beginRead(); owner.mergeRead(f, [rec("m", "snapshot-prefix", "unknown")], end, [], true); owner.endRead(f);
  assert.equal(owner.snapshot().activity.state, "unknown"); assert.equal(owner.snapshot().coverage.knownStart, false);
  assert.equal(owner.snapshot().rows[0]!.lifecycle, "unknown");
  hub.emit(scope, [{ type: "append", id: "m", kind: "assistant", text: "live-suffix" }]);
  const partial = owner.snapshot().rows[0]!;
  assert.equal(contents(partial), "live-suffix"); assert.equal(partial.body.kind, "partial");
  assert.ok(owner.snapshot().coverage.gaps.some(g => g.rowId === "m"));
  hub.emit(scope, [{ type: "finish", id: "m", kind: "assistant", lifecycle: "completed", text: "snapshot-prefix+live-suffix" }]);
  assert.equal(owner.snapshot().rows[0]!.body.kind, "complete"); assert.equal(owner.snapshot().coverage.gaps.length, 0);
});

test("older reads cannot downgrade a newer full body via truncation or stale missing-final annotations", () => {
  const { hub, owner } = rig(8);
  hub.emit(scope, [{ type: "start", id: "m", kind: "assistant" }]);
  const f = owner.beginRead();
  hub.emit(scope, [{ type: "finish", id: "m", kind: "assistant", lifecycle: "completed", text: "new" }]);
  const before = owner.snapshot().rows[0]!;
  const page = owner.mergeRead(f, [rec("m", "old-body-too-large")], end, [{ id: "read-missing", kind: "missingFinal", rowId: "m" }], false)!;
  owner.endRead(f);
  assert.deepEqual(owner.snapshot().rows[0], before); assert.deepEqual(page.rows[0], before);
  assert.equal(owner.snapshot().coverage.gaps.length, 0);
});

test("accepted native terminal evidence stays bounded and wrong-kind or changed-original evidence commits nothing", () => {
  const { hub, owner } = rig(8);
  hub.emit(scope, [{ type: "append", id: "m", kind: "assistant", text: "tail" }]);
  let f = owner.beginRead();
  owner.mergeRead(f, [rec("m", "native-whole-result-too-large")], end, [], true); owner.endRead(f);
  assert.equal(owner.snapshot().rows[0]!.body.kind, "partial"); assert.ok((contents(owner.snapshot().rows[0]!) ?? "").length <= 8);
  const before = owner.snapshot(); f = owner.beginRead();
  assert.throws(() => owner.mergeRead(f, [{ ...rec("m", "short"), kind: "tool" }], end, [], true), /HISTORY_KIND_CONFLICT/);
  assert.strictEqual(owner.snapshot(), before); owner.endRead(f);
  f = owner.beginRead(); owner.mergeRead(f, [{ ...rec("origin", "one"), native: { originatingMessageId: "request-a" } }], end, [], true); owner.endRead(f);
  const original = owner.snapshot(); f = owner.beginRead();
  assert.throws(() => owner.mergeRead(f, [{ ...rec("origin", "one"), native: { originatingMessageId: "request-b" } }], end, [], true), /HISTORY_IDENTITY_CONFLICT/);
  assert.strictEqual(owner.snapshot(), original); owner.endRead(f);
});

test("read enrichment updates resident rows and page projections with one coherent Host version", () => {
  const { owner } = rig();
  let f = owner.beginRead(); owner.mergeRead(f, [rec("m", "open", "unknown")], end, [], true); owner.endRead(f);
  const prior = owner.snapshot().rows[0]!;
  f = owner.beginRead(); const page = owner.mergeRead(f, [rec("m", "closed")], end, [], true)!; owner.endRead(f);
  assert.deepEqual(page.rows, owner.snapshot().rows); assert.equal(contents(page.rows[0]!), "closed");
  assert.ok(page.rows[0]!.version > prior.version); assert.ok(page.rows[0]!.contentVersion > prior.contentVersion);
  const client = new HistoryClient(scope); client.apply(owner.snapshotFrame());
  assert.deepEqual(client.view().getSnapshot().rows, page.rows);
});

test("read gap annotations cannot leave cached, current and page bodies at different versions", () => {
  const { owner } = rig(); let f = owner.beginRead();
  const page = owner.mergeRead(f, [rec("m", "body")], end, [{ id: "native-truncated", kind: "truncated", rowId: "m" }], true)!;
  owner.endRead(f); assert.equal(page.rows[0]!.body.kind, "partial"); assert.deepEqual(page.rows, owner.snapshot().rows);
  f = owner.beginRead(); const repeated = owner.mergeRead(f, [rec("m", "body")], end, [], false)!; owner.endRead(f);
  assert.equal(contents(repeated.rows[0]!), "body"); assert.equal(repeated.rows[0]!.body.kind, "complete");
  // A separate explicit native full read may heal prior truncated read evidence.
  assert.ok(repeated.rows[0]!.version >= page.rows[0]!.version);
});

test("native versions remain newer than old-page versions after current eviction, and native counters are rejected", () => {
  const { hub, owner } = rig(4096, 1);
  let f = owner.beginRead(); const page = owner.mergeRead(f, [rec("old", "old snapshot")], end, [], false)!; owner.endRead(f);
  const oldVersion = page.rows[0]!.version;
  hub.emit(scope, [{ type: "finish", id: "old", kind: "assistant", lifecycle: "completed", text: "new live" }]);
  hub.emit(scope, [{ type: "finish", id: "next", kind: "assistant", lifecycle: "completed", text: "next" }]);
  f = owner.beginRead(); const recovered = owner.mergeRead(f, [rec("old", "new live")], end, [], false)!; owner.endRead(f);
  assert.equal(contents(recovered.rows[0]!), "new live"); assert.ok(recovered.rows[0]!.version > oldVersion);
  const before = owner.snapshot(); f = owner.beginRead();
  assert.throws(() => owner.mergeRead(f, [{ ...rec("bad", "bad"), version: 999999 } as HistoryRecord], end, [], false), /NATIVE_RECORD_VERSION/);
  assert.strictEqual(owner.snapshot(), before); owner.endRead(f);
});

test("late native updates reuse known history placement, and concurrent baselines cannot regress the shared older edge", () => {
  const { hub, owner } = rig(8, 2);
  for (const id of ["a", "b", "c"]) hub.emit(scope, [{ type: "finish", id, kind: "assistant", lifecycle: "completed", text: id === "a" ? "truncated earlier body" : id }]);
  assert.deepEqual(owner.snapshot().rows.map(row => row.id), ["b", "c"]);
  hub.emit(scope, [{ type: "finish", id: "a", kind: "assistant", lifecycle: "completed", text: "late a" }]);
  assert.deepEqual(owner.snapshot().rows.map(row => row.id), ["a", "c"]);
  const first = owner.beginRead(), second = owner.beginRead();
  owner.mergeRead(second, [], { state: "available", cursor: "new-boundary" }, [], true);
  owner.mergeRead(first, [], { state: "available", cursor: "older-stale-boundary" }, [], true);
  owner.endRead(first); owner.endRead(second);
  assert.deepEqual(owner.snapshot().olderEdge, { state: "available", cursor: "new-boundary" });
});

test("a native edit during asynchronous authorization prevents the later Codex items RPC", async () => {
  const { hub, owner } = rig(); let release!: () => void, lists = 0;
  const authorization = new Promise<void>(resolve => { release = resolve; });
  const port = createCodexHistoryPort({ scope, authorize: () => authorization,
    list: async () => { lists++; return { data: [], nextCursor: null, backwardsCursor: null }; } });
  const acquisition = new HistoryAcquisition(owner, port), read = acquisition.baseline("E01", "cold");
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(acquisition.reads.active, 1);
  hub.reset(scope, "native edit"); release();
  assert.deepEqual(await read.wait(1000), { state: "value", value: { status: "stale" } });
  assert.equal(lists, 0); assert.equal(acquisition.reads.active, 0); assert.deepEqual(owner.snapshot().rows, []);
});
