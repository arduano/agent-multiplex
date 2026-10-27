import assert from "node:assert/strict";
import test from "node:test";
import type { Change, CodexScope, Frame, HistoryPage, Origin, Row, Scope, Snapshot } from "../src/contracts/types.js";
import { AnchorController, CapacityError, HistoryClient, HistoryProtocolError, HistoryWorkspace } from "../src/client/index.js";
import { HistoryHub } from "../src/host/history-owner.js";
import { codexRowId, createCodexCodec } from "../src/native/codex/index.js";

const origin: Origin = { connection: "fixture", principal: "owner", host: "host", nativeSession: "native", attachment: "attachment-1" };
const scope = (threadId = "root", override: Partial<Origin> = {}): CodexScope => ({ kind: "codex", origin: { ...origin, ...override }, threadId });
const row = (id: string, text = id, version = 1): Row => ({ id, kind: "assistant", lifecycle: "completed",
  body: { kind: "complete", text, evidence: "nativeFullBody" }, native: {}, version, contentVersion: version });
const snapshot = (rows: readonly Row[], revision = 1, generation = "g1", target: Scope = scope(), cursor = "current-edge"): Snapshot => ({
  scope: target, generation, revision, rows, retirements: [], read: { state: 'idle' }, olderEdge: { state: "available", cursor }, coverage: { knownStart: true, gaps: [] }, activity: { turnId: null, state: "idle" },
});
const snap = (data: Snapshot): Frame => ({ kind: "snapshot", snapshot: data });
const commit = (changes: readonly Change[], order: readonly string[], revision = 2, target: Scope = scope(), generation = "g1"): Frame => ({
  kind: "commit", scope: target, generation, baseRevision: revision - 1, revision, changes, order,
  olderEdge: { state: "available", cursor: `edge-${revision}` }, coverage: { knownStart: true, gaps: [] }, activity: { turnId: null, state: "idle" },
});
const page = (rows: readonly Row[], cursor = "deeper-edge", target: Scope = scope(), generation = "g1"): HistoryPage => ({ scope: target, generation, rows, olderEdge: { state: "available", cursor } });
const ids = (client: HistoryClient, key = "main") => client.view(key).getSnapshot().rows.map(value => value.id);
const body = (value: Row | undefined) => value?.body.kind === "complete" || value?.body.kind === "partial" ? value.body.text : undefined;

test("retained terminal bodies survive late Codex suffixes after both bounded Host and codec evidence expire", async () => {
  const target = scope("root", { nativeSession: "root" }), hub = new HistoryHub({ maxRows: 1, maxReadRows: 2 });
  const codec = createCodexCodec({ origin: target.origin, rootThreadId: "root", capture: hub, knownStart: true, limits: { maxItems: 2 } });
  const stream = hub.watch(target), client = new HistoryClient(target), view = client.view();
  const deliver = () => { for (const frame of stream.drain()) client.apply(frame); };
  const complete = (id: string, text: string) => codec.observe({ method: "item/completed", params: { threadId: "root", turnId: "one-long-turn", item: { type: "commandExecution", id, status: "completed", aggregatedOutput: text } } });
  try {
    hub.emit(target, [{ type: "edge", edge: { state: "available", cursor: "owned-page" } }]); deliver();
    complete("old-command", "Exact complete command output"); deliver();
    const id = codexRowId("root", "one-long-turn", "old-command"), retained = view.getSnapshot().rows.find(row => row.id === id)!;
    assert.equal(retained.body.kind, "complete");
    // One turn exceeds BOTH bounded owners. Forgetting a completed identity
    // is residency, and cannot disprove full bytes already held by this view.
    for (let index = 0; index < 5; index++) { complete(`later-${index}`, `Later full output ${index}`); deliver(); }
    assert.ok(codec.diagnostics().trackedItems <= 2); assert.ok(!hub.snapshot(target).rows.some(row => row.id === id));
    codec.observe({ method: "item/commandExecution/outputDelta", params: { threadId: "root", turnId: "one-long-turn", itemId: "old-command", delta: "An unproved late suffix" } }); deliver();
    const actual = client.current!.rows.find(row => row.id === id)!;
    assert.equal(actual.lifecycle, "running"); assert.equal(actual.body.kind, "partial"); assert.ok(actual.version > retained.version);
    assert.strictEqual(view.getSnapshot().rows.find(row => row.id === id), retained);
    assert.equal(view.getSnapshot().origins[id]?.source, "retainedCurrent");
    assert.strictEqual(view.getSnapshot().current, client.current);

    const token = view.beginOlderRead();
    assert.equal(view.applyPage({ scope: target, generation: token.generation, ...(token.readContext === undefined ? {} : { readContext: token.readContext }),
      rows: [{ ...actual, version: actual.version + 1, contentVersion: actual.contentVersion + 1 }], olderEdge: { state: "available", cursor: "next-owned-page" } }, token), "applied");
    assert.strictEqual(view.getSnapshot().rows.find(row => row.id === id), retained);
    assert.equal(view.getSnapshot().origins[id]?.source, "retainedCurrent");

    complete("old-command", "A later positive full native body"); deliver();
    const positive = view.getSnapshot().rows.find(row => row.id === id)!;
    assert.equal(body(positive), "A later positive full native body"); assert.equal(positive.body.kind, "complete");
    assert.notStrictEqual(positive, retained); assert.equal(view.getSnapshot().origins[id]?.source, "current");
    const conflicting = view.beginOlderRead();
    try {
      assert.throws(() => view.applyPage({ scope: target, generation: conflicting.generation, ...(conflicting.readContext === undefined ? {} : { readContext: conflicting.readContext }),
        rows: [{ ...positive, lifecycle: "running", body: { kind: "partial", text: "Conflicting equal version", missing: ["final"] } }],
        olderEdge: { state: "end", evidence: "nativeBoundary" } }, conflicting), HistoryProtocolError);
    } finally { view.finishOlderRead(conflicting); }
    hub.emit(target, [{ type: "retire", rowIds: [id], evidence: "exact scripted native retirement" }]); deliver();
    assert.ok(!view.getSnapshot().rows.some(row => row.id === id));
  } finally { await stream.return(); assert.equal(hub.owner(target).subscriberCount, 0); }
});

test("actual reusable consumer publishes absolute multi-row commits atomically and ignores exact duplicates", () => {
  const client = new HistoryClient(scope()), main = client.view(), side = client.view("side");
  const initial = snap(snapshot([row("a", "prefix"), row("b", "tool prefix")]));
  assert.equal(client.apply(initial), "applied");
  const observed: string[][] = [];
  main.subscribe(() => observed.push([...main.getSnapshot().rows.map(value => body(value)!), ...side.getSnapshot().rows.map(value => body(value)!)]));
  const next = commit([{ kind: "replaceRow", row: row("a", "whole", 2) }, { kind: "replaceRow", row: row("b", "tool final", 2) }], ["a", "b"]);
  assert.equal(client.apply(next), "applied");
  assert.deepEqual(observed, [["whole", "tool final", "whole", "tool final"]]);
  assert.equal(client.apply(next), "duplicate");
  assert.equal(observed.length, 1);
  const before = main.getSnapshot();
  assert.throws(() => client.apply(commit([{ kind: "replaceRow", row: row("a", "conflicting equal frame", 2) }], ["a", "b"])), HistoryProtocolError);
  assert.strictEqual(main.getSnapshot(), before);
  assert.equal(client.apply(snap(client.current!)), "duplicate");
  assert.throws(() => client.apply({ kind: "append", text: "must never append in client" }));
  assert.strictEqual(main.getSnapshot(), before);
});

test("wire inputs are detached/frozen and an invalid transaction leaves every view unchanged", () => {
  const client = new HistoryClient(scope()), main = client.view(), side = client.view("side");
  const mutable = JSON.parse(JSON.stringify(snap(snapshot([row("a"), row("b")])))) as { snapshot: { rows: { body: { text: string } }[] } };
  client.apply(mutable); mutable.snapshot.rows[0]!.body.text = "caller mutation";
  assert.equal(body(main.getSnapshot().rows[0]), "a");
  assert.ok(Object.isFrozen(main.getSnapshot().rows[0]?.body));
  const mainBefore = main.getSnapshot(), sideBefore = side.getSnapshot();
  const invalid = commit([{ kind: "replaceRow", row: row("a", "would be half-applied", 2) }, { kind: "replaceRow", row: { ...row("b"), version: -1 } }], ["a", "b"]);
  assert.throws(() => client.apply(invalid));
  assert.strictEqual(main.getSnapshot(), mainBefore); assert.strictEqual(side.getSnapshot(), sideBefore);
});

test("base gaps request Host snapshot without applying a suffix, and foreign scopes cannot cross views", () => {
  const client = new HistoryClient(scope()); client.apply(snap(snapshot([row("a")])));
  const before = client.view().getSnapshot();
  assert.equal(client.apply(commit([{ kind: "replaceRow", row: row("b") }], ["a", "b"], 5)), "needsSnapshot");
  assert.strictEqual(client.view().getSnapshot(), before);
  for (const target of [scope("child"), scope("root", { principal: "other" }), scope("root", { attachment: "old" })]) {
    assert.throws(() => client.apply(snap(snapshot([row("foreign")], 2, "g1", target))), HistoryProtocolError);
  }
  assert.deepEqual(ids(client), ["a"]);
});

test("snapshot omission and residency eviction retain context; explicit semantic retirement removes it", () => {
  const client = new HistoryClient(scope()); client.apply(snap(snapshot([row("a"), row("b")])));
  const view = client.view(); view.expand("a", true);
  client.apply(snap(snapshot([row("b")], 2)));
  assert.deepEqual(ids(client), ["a", "b"]);
  client.apply(commit([{ kind: "evictCurrentRows", rowIds: ["b"] }], [], 3));
  assert.deepEqual(ids(client), ["a", "b"]); assert.deepEqual(client.current?.rows, []);
  client.apply(commit([{ kind: "retireRows", rowIds: ["a"], evidence: "exact scripted native revert" }], [], 4));
  assert.deepEqual(ids(client), ["b"]);
  assert.deepEqual(view.getSnapshot().expansions, []);
  assert.throws(() => client.apply(commit([{ kind: "replaceRow", row: row("a", "late stale row", 2) }], ["a"], 5)), HistoryProtocolError);
  assert.throws(() => client.apply(snap({ ...client.current!, revision: 5, retirements: [] })), HistoryProtocolError);
});

test("real Host overflow and replay-miss snapshots retire previously retained rows with the full proof ledger", async () => {
  const target = scope(), hub = new HistoryHub({ maxRows: 1, maxReplayFrames: 1, maxQueuedFrames: 1 }); hub.open(target, { knownStart: true });
  hub.emit(target, [{ type: "edge", edge: { state: "available", cursor: "old-page" } }]);
  const client = new HistoryClient(target), replayClient = new HistoryClient(target);
  const main = client.view(), replayView = replayClient.view(), stream = hub.watch(target);
  const deliver = (frames: readonly Frame[]) => { for (const frame of frames) { client.apply(frame); replayClient.apply(frame); } };
  const finish = (id: string) => hub.emit(target, [{ type: "start", id, kind: "assistant" }, { type: "finish", id, kind: "assistant", lifecycle: "completed", text: id }]);
  deliver(stream.drain()); finish("a"); deliver(stream.drain()); finish("b"); deliver(stream.drain());
  assert.deepEqual(main.getSnapshot().rows.map(value => value.id), ["a", "b"]);
  const cursor = { generation: replayClient.current!.generation, revision: replayClient.current!.revision };
  const oldPage = main.beginOlderRead();
  hub.emit(target, [{ type: "retire", rowIds: ["a", "b"], evidence: "scripted exact native edit" }]);
  finish("c"); finish("d");
  assert.ok(stream.overflowResets > 0);
  const overflow = stream.drain(); assert.equal(overflow[0]?.kind, "snapshot");
  for (const frame of overflow) client.apply(frame);
  assert.deepEqual(main.getSnapshot().rows.map(value => value.id), ["d"]);
  assert.deepEqual(client.current?.retirements.map(change => change.rowIds), [["a"], ["b"]]);
  const missed = hub.watch(target, cursor); assert.equal(missed.mode, "snapshot");
  for (const frame of missed.drain()) replayClient.apply(frame);
  assert.deepEqual(replayView.getSnapshot().rows.map(value => value.id), ["d"]);
  assert.equal(main.applyPage(page([row("a"), row("b")], "deeper-page", target, client.current!.generation), oldPage), "applied");
  assert.deepEqual(main.getSnapshot().rows.map(value => value.id), ["d"]);
  hub.emit(target, [{ type: "retire", rowIds: ["c", "d"], evidence: "second grouped exact native edit" }]);
  for (const frame of stream.drain()) client.apply(frame);
  assert.deepEqual(client.current?.retirements.map(change => change.rowIds), [["a"], ["b"], ["c"], ["d"]]);
  assert.equal(client.apply({ kind: "snapshot", snapshot: hub.snapshot(target) }), "duplicate");
  await stream.return(); await missed.return();
});

test("generation/attachment changes preserve origin-labelled context and fence retired reads", () => {
  const client = new HistoryClient(scope()); client.apply(snap(snapshot([row("old")])));
  const view = client.view(), pending = view.beginOlderRead();
  client.apply(snap(snapshot([row("new")], 0, "g2")));
  assert.deepEqual(ids(client), ["old", "new"]);
  assert.equal(view.getSnapshot().origins.old?.generation, "g1");
  assert.equal(view.getSnapshot().includesPriorGeneration, true);
  assert.equal(view.getSnapshot().olderEdge.state, "unknown");
  assert.equal(view.applyPage(page([row("too late")]), pending), "stale");
  assert.equal(client.apply(snap(snapshot([row("old")], 2, "g1"))), "stale");
  const replacement = scope("root", { attachment: "attachment-2" });
  client.rebind(replacement); assert.equal(client.current, null); assert.deepEqual(ids(client), ["old", "new"]);
  assert.throws(() => client.apply(snap(snapshot([row("foreign attachment")], 1, "g3"))), HistoryProtocolError);
  assert.equal(client.apply(snap(snapshot([row("latest")], 1, "g3", replacement))), "applied");
  assert.throws(() => client.rebind(scope("another native thread")), HistoryProtocolError);
});

test("frame equivalence history and retired-generation fences have explicit finite capacities", () => {
  const client = new HistoryClient(scope(), { maxSeenFrames: 2, maxRetiredGenerations: 2 });
  client.apply(snap(snapshot([row("a")])));
  for (let revision = 2; revision <= 5; revision += 1) client.apply(commit([], ["a"], revision));
  assert.equal(client.apply(snap(snapshot([row("unseen old frame")]))), "stale");
  assert.equal(client.apply(commit([], ["a"], 5)), "duplicate");
  assert.throws(() => client.apply(commit([{ kind: "replaceRow", row: row("a", "conflict", 2) }], ["a"], 5)), HistoryProtocolError);
  client.apply(snap(snapshot([row("a")], 0, "g2")));
  client.apply(snap(snapshot([row("a")], 0, "g3")));
  const before = client.current;
  assert.throws(() => client.apply(snap(snapshot([row("a")], 0, "g4"))), CapacityError);
  assert.strictEqual(client.current, before);
  assert.equal(client.apply(snap(snapshot([row("a")], 999, "g1"))), "stale");
  assert.throws(() => client.rebind(scope("root", { attachment: "attachment-2" })), CapacityError);
  assert.strictEqual(client.current, before);
  assert.equal(client.scope.origin.attachment, "attachment-1");
});

test("the same generation label on a new exact attachment is fresh evidence with separate fences", () => {
  const client = new HistoryClient(scope()); const view = client.view();
  client.apply(snap(snapshot([row("same-id", "old attachment", 9), row("retained-only")])));
  const replacement = scope("root", { attachment: "attachment-2" }); client.rebind(replacement);
  const first = snap(snapshot([row("same-id", "new attachment", 1)], 1, "g1", replacement));
  assert.equal(client.apply(first), "applied"); assert.equal(client.apply(first), "duplicate");
  assert.equal(body(view.getSnapshot().rows.find(value => value.id === "same-id")), "new attachment");
  assert.equal(view.getSnapshot().includesPriorGeneration, true);
  assert.equal(view.getSnapshot().origins["retained-only"]?.scope.origin.attachment, "attachment-1");
  assert.throws(() => client.apply(snap(snapshot([row("same-id", "late old attachment", 10)], 2))), HistoryProtocolError);
  assert.equal(body(client.current?.rows[0]), "new attachment");
});

test("private page edges survive moving current snapshots and stale pages never overwrite newer current bodies", () => {
  const client = new HistoryClient(scope()); client.apply(snap(snapshot([row("a", "current v2", 2)])));
  const main = client.view(), side = client.view("side"), token = main.beginOlderRead();
  assert.strictEqual(main.beginOlderRead(), token);
  assert.equal(main.applyPage(page([row("older"), row("a", "stale page v1")]), token), "applied");
  assert.deepEqual(ids(client), ["older", "a"]); assert.equal(body(main.getSnapshot().rows[1]), "current v2");
  client.apply(commit([{ kind: "replaceRow", row: row("a", "current v3", 3) }], ["a"]));
  assert.deepEqual(main.getSnapshot().olderEdge, { state: "available", cursor: "deeper-edge" });
  assert.deepEqual(side.getSnapshot().olderEdge, { state: "available", cursor: "edge-2" });
  const old = main.beginOlderRead(); main.resetPaging(); const fresh = main.beginOlderRead();
  main.finishOlderRead(old); assert.equal(main.getSnapshot().viewport.loadingOlder, true);
  assert.equal(main.applyPage(page([row("stale owner")]), old), "stale");
  assert.equal(main.applyPage(page([row("fresh")]), fresh), "applied");
  assert.ok(!ids(client).includes("stale owner"));
});

test("foreign and conflicting child pages commit zero data and preserve the admitted page token", () => {
  const client = new HistoryClient(scope()); client.apply(snap(snapshot([row("a")])));
  const view = client.view(), token = view.beginOlderRead(), before = view.getSnapshot();
  assert.throws(() => view.applyPage(page([row("child secret")], "next", scope("child")), token), HistoryProtocolError);
  assert.strictEqual(view.getSnapshot(), before);
  assert.throws(() => view.applyPage(page([row("a", "changed bytes same version")]), token), HistoryProtocolError);
  assert.strictEqual(view.getSnapshot(), before);
  let accessed = false;
  assert.throws(() => view.applyPage({ ...page([]), get scope() { accessed = true; return scope(); } }, token));
  assert.equal(accessed, false); assert.strictEqual(view.getSnapshot(), before);
  assert.throws(() => view.applyPage({ ...page([]), extra: true }, token), HistoryProtocolError);
  assert.equal(view.applyPage(page([row("older")]), token), "applied");
});

test("page reads coalesce under observer reentrancy and cannot regress deeper captured bodies or loop a cursor", () => {
  const client = new HistoryClient(scope()); client.apply(snap(snapshot([row("a")])));
  const view = client.view(); let observedToken: ReturnType<typeof view.beginOlderRead> | undefined;
  const unsubscribe = view.subscribe(() => {
    if (view.getSnapshot().viewport.loadingOlder) observedToken = view.beginOlderRead();
  });
  const token = view.beginOlderRead(); assert.strictEqual(observedToken, token); unsubscribe();
  const before = view.getSnapshot();
  assert.throws(() => view.applyPage(page([row("would leak")], token.cursor), token), HistoryProtocolError);
  assert.strictEqual(view.getSnapshot(), before);
  assert.equal(view.applyPage(page([row("a", "captured newer page", 3)]), token), "applied");
  client.apply(commit([{ kind: "replaceRow", row: row("a", "older current fact", 2) }], ["a"]));
  assert.equal(body(client.current?.rows[0]), "older current fact");
  assert.equal(body(view.getSnapshot().rows[0]), "captured newer page");
  assert.equal(view.getSnapshot().origins.a?.source, "older");
});

test("workspace A/B/A retains slots, draft, original operation, expansions and independent pin references", () => {
  const workspace = new HistoryWorkspace({ connection: origin.connection, principal: origin.principal });
  const a = workspace.session(scope("a")), b = workspace.session(scope("b"));
  a.client.apply(snap(snapshot([row("a-row")], 1, "a-gen", scope("a"))));
  b.client.apply(snap(snapshot([row("b-row")], 1, "b-gen", scope("b"))));
  const first = workspace.select(scope("a")); a.setDraft({ text: "retain draft" }); a.recordOperation("original", { action: "send", text: "immutable" });
  first.view.expand("a-row", true); first.view.viewport.report({ rowId: "a-row", offsetPx: 31 }); first.view.viewport.userScroll("earlier", false);
  a.setPinned(true); assert.equal(a.observationReferences, 2);
  const second = workspace.select(scope("b")); assert.equal(a.observationReferences, 1);
  first.release(); first.release(); assert.equal(b.mountedReferences, 1);
  workspace.setConnected(false); assert.equal(a.pinned, true); assert.equal(a.backgroundReferenceHeld, true);
  workspace.setConnected(true); const returned = workspace.select(scope("a"));
  assert.strictEqual(returned.view, first.view);
  assert.deepEqual(a.draft, { text: "retain draft" }); assert.equal(a.operations[0]?.id, "original");
  assert.deepEqual(returned.view.getSnapshot().expansions, ["a-row"]);
  assert.deepEqual(returned.view.getSnapshot().viewport.anchor, { rowId: "a-row", offsetPx: 31 });
  assert.equal(returned.view.getSnapshot().viewport.intent, "readingHistory");
  const panel = workspace.select(scope("a"), "right-panel"); assert.notStrictEqual(panel.view, returned.view);
  assert.equal(panel.view.getSnapshot().viewport.anchor, null);
  a.setPinned(false); assert.equal(a.observationReferences, 2);
  returned.release(); panel.release(); second.release(); assert.equal(a.observationReferences, 0);
  assert.throws(() => a.recordOperation("original", { action: "send", text: "replacement" }), HistoryProtocolError);
  assert.throws(() => workspace.session(scope("a", { principal: "another account" })), HistoryProtocolError);
});

test("capacity rejects new work without implicit eviction, unpinning, or loss of pending operations", () => {
  const workspace = new HistoryWorkspace({ connection: origin.connection, principal: origin.principal, maxSessions: 1, maxViewsPerSession: 1 });
  const session = workspace.session(scope()); const lease = workspace.select(scope());
  session.setPinned(true); session.recordOperation("unknown effect", { original: true }); session.setDraft("draft");
  assert.throws(() => workspace.select(scope("other")), CapacityError);
  assert.throws(() => workspace.select(scope(), "second"), CapacityError);
  assert.throws(() => workspace.retire(scope()), CapacityError);
  assert.equal(workspace.size, 1); assert.equal(session.pinned, true); assert.equal(session.mountedReferences, 1); assert.equal(session.draft, "draft");
  lease.release(); session.setPinned(false); session.setDraft("");
  assert.throws(() => workspace.retire(scope()), CapacityError);
  session.observeOperation("unknown effect", { nativeOutcome: "known" }, true); workspace.retire(scope());
  assert.equal(workspace.size, 0);

  const limited = new HistoryClient(scope(), { maxRowsPerView: 1 }); const view = limited.view();
  limited.apply(snap(snapshot([row("old")]))) ; const before = view.getSnapshot();
  assert.throws(() => limited.apply(snap(snapshot([row("new")], 2))), CapacityError);
  assert.strictEqual(view.getSnapshot(), before); assert.equal(limited.current?.revision, 1);
});

test("one broken observer cannot roll back a commit or starve another consumer", () => {
  const errors: unknown[] = []; const client = new HistoryClient(scope(), { onObserverError: value => errors.push(value) });
  const main = client.view(), side = client.view("side"); let received = 0;
  main.subscribe(() => { throw new Error("fixture observer"); }); side.subscribe(() => { received += 1; });
  client.apply(snap(snapshot([row("whole")])));
  assert.equal(received, 1); assert.equal(errors.length, 1); assert.deepEqual(ids(client, "side"), ["whole"]);
});

test("anchor math preserves reading position through prepends/growth and a gesture cancels stale restoration", () => {
  const anchor = new AnchorController({ maxRestorePasses: 2 });
  anchor.report({ rowId: "stable-native-item", offsetPx: 20 }); anchor.userScroll("earlier", false);
  const restore = anchor.beginRestore()!;
  const first = anchor.correct(restore, { rowTop: 380, viewportTop: 100, scrollTop: 500 });
  assert.deepEqual(first, { kind: "adjust", scrollTop: 800 });
  assert.deepEqual(anchor.correct(restore, { rowTop: 80, viewportTop: 100, scrollTop: 800 }), { kind: "settled", scrollTop: 800 });
  assert.equal(anchor.tailPosition(800, 1500), 800);
  const stale = anchor.beginRestore()!; anchor.userScroll("earlier", false);
  assert.equal(anchor.correct(stale, { rowTop: 1000, viewportTop: 0, scrollTop: 800 }).kind, "stale");
  const read = anchor.beginOlderRead(); assert.equal(anchor.state.intent, "readingHistory");
  anchor.retireRead(); const newerRead = anchor.beginOlderRead(); anchor.endOlderRead(read);
  assert.equal(anchor.state.loadingOlder, true); anchor.endOlderRead(newerRead);
  anchor.followLatest(); assert.equal(anchor.tailPosition(800, 1500), 1500); assert.equal(anchor.tailPosition(800, 1500, true), 800);
});

test("anchor restoration has a finite correction allowance and never infers an item from an index", () => {
  const anchor = new AnchorController({ maxRestorePasses: 1 });
  assert.equal(anchor.beginRestore(), null);
  anchor.report({ rowId: "exact-key", segmentId: "body-1", offsetPx: 0 });
  const token = anchor.beginRestore()!;
  assert.equal(anchor.correct(token, { rowTop: 100, viewportTop: 0, scrollTop: 0 }).kind, "adjust");
  assert.equal(anchor.correct(token, { rowTop: 100, viewportTop: 0, scrollTop: 100 }).kind, "limited");
  assert.equal(anchor.state.restoringAnchor, false); assert.equal(anchor.state.anchor?.rowId, "exact-key");
});


test('typed acquisition projection follows retained commits but never crosses a changed reader or invalid retry payload', () => {
  const target = scope(), client = new HistoryClient(target), pending = { state: 'pending', target: { kind: 'initial' } } as const;
  client.apply(snap({ ...snapshot([row('kept')]), readContext: 'reader-one', read: pending }));
  client.apply({ ...commit([], ['kept']), readContext: 'reader-one' }); assert.deepEqual(client.current!.read, pending);
  client.apply({ ...commit([], ['kept'], 3), readContext: 'reader-two' }); assert.deepEqual(client.current!.read, { state: 'idle' });
  assert.deepEqual(ids(client), ['kept']); const before = client.current;
  assert.throws(() => client.apply({ ...commit([], ['kept'], 4), read: { state: 'settled', target: { kind: 'recover' }, outcome: 'ready', retryToken: 'invalid-on-success' } }));
  assert.strictEqual(client.current, before);
});
