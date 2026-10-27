import test from "node:test";
import assert from "node:assert/strict";
import { CAPTURE_GAP_ID, type CodexScope, type Frame } from "../src/contracts/types.js";
import { HistoryHub } from "../src/host/history-owner.js";
import { HistoryClient } from "../src/client/history-client.js";
import { rowMedia, type NativeMediaOccurrence } from "../src/contracts/media.js";

const scope: CodexScope = { kind: "codex", threadId: "root", origin: { connection: "fixture", principal: "alice", host: "host", nativeSession: "root", attachment: "owned-1" } };
function setup(options: ConstructorParameters<typeof HistoryHub>[0] = {}) {
  const hub = new HistoryHub(options); hub.open(scope, { knownStart: true }); return hub;
}
function complete(hub: HistoryHub, id: string, text: string) {
  hub.emit(scope, [{ type: "start", id, kind: "assistant" }, { type: "finish", id, kind: "assistant", lifecycle: "completed", text }]);
}
function deliver(client: HistoryClient, frames: readonly Frame[]) { return frames.map(frame => client.apply(frame)); }

test("scope inventory-only commits share replay/validation and never rewrite rows or an older-page fence", async () => {
  const hub = setup(), client = new HistoryClient(scope), stream = hub.watch(scope), owner = hub.owner(scope);
  client.view('main'); deliver(client, stream.drain()); assert.equal(client.current!.scopeInventory, undefined);
  hub.emit(scope, [{ type: 'edge', edge: { state: 'available', cursor: 'older' } }]); deliver(client, stream.drain());
  const fence = client.view('main').beginOlderRead(), cursor = { generation: owner.snapshot().generation, revision: owner.snapshot().revision };
  const child = { ...scope, threadId: 'child' }, inventory = [{ scope }, { scope: child, native: { nickname: 'Worker', configuredModel: 'configured-not-used' } }];
  owner.setScopeInventory({ nativeGeneration: 1, entries: inventory }); const frames = stream.drain();
  assert.equal(frames.length, 1); assert.equal(frames[0]!.kind, 'commit');
  if (frames[0]!.kind === 'commit') assert.deepEqual(frames[0]!.changes, []);
  deliver(client, frames); assert.deepEqual(client.current!.scopeInventory, { nativeGeneration: 1, entries: inventory });
  const replay = owner.watch(cursor); assert.deepEqual(replay.drain(), frames); await replay.return();
  complete(hub, 'ordinary', 'A text token does not resend the inventory'); const textFrames = stream.drain();
  assert.equal(textFrames.length, 1); assert.equal(textFrames[0]!.kind === 'commit' && textFrames[0]!.scopeInventory, undefined);
  deliver(client, textFrames); assert.deepEqual(client.current!.scopeInventory, { nativeGeneration: 1, entries: inventory });
  assert.equal(client.view('main').applyPage({ scope, generation: fence.generation, rows: [], olderEdge: { state: 'end', evidence: 'nativeBoundary' } }, fence), 'applied');
  const before = owner.snapshot();
  for (const invalid of [[...inventory, { scope: child }], [{ scope: { ...child, origin: { ...child.origin, principal: 'foreign' } } }], [{ scope: child, native: { providerSecret: 'forbidden' } }], Array.from({ length: 33 }, (_, i) => ({ scope: { ...scope, threadId: String(i) } }))]) {
    assert.throws(() => owner.setScopeInventory({ nativeGeneration: 1, entries: invalid } as never)); assert.equal(owner.snapshot(), before); assert.deepEqual(stream.drain(), []);
  }
  owner.setScopeInventory({ nativeGeneration: 1, entries: [] }); deliver(client, stream.drain()); assert.deepEqual(client.current!.scopeInventory, { nativeGeneration: 1, entries: [] });
  await stream.return();
});

test("Host initial snapshot and later absolute commits have a coherent handoff through the real consumer", async () => {
  const hub = setup(), client = new HistoryClient(scope), stream = hub.watch(scope);
  complete(hub, "one", "before first drain");
  assert.deepEqual(deliver(client, stream.drain()), ["applied", "applied"]);
  hub.emit(scope, [{ type: "start", id: "two", kind: "assistant" }, { type: "append", id: "two", kind: "assistant", text: "live" }]);
  const pending = stream.next(); hub.emit(scope, [{ type: "finish", id: "two", kind: "assistant", lifecycle: "completed", text: "live full" }]);
  const queued = await pending; assert.equal(queued.done, false); client.apply(queued.value!);
  deliver(client, stream.drain());
  assert.deepEqual(client.current!.rows.map(row => row.body.kind !== "unavailable" && row.body.text), ["before first drain", "live full"]);
  await stream.return(); assert.equal(hub.owner(scope).subscriberCount, 0);
  complete(hub, "three", "no browser"); assert.equal(hub.snapshot(scope).rows.length, 3);
});

test("exact Host replay is idempotent; ring miss and slow subscriber use retained snapshots without native reads", () => {
  const hub = setup({ maxReplayFrames: 2, maxQueuedFrames: 1 }), client = new HistoryClient(scope), initial = hub.watch(scope);
  deliver(client, initial.drain()); const cursor = { generation: client.current!.generation, revision: client.current!.revision };
  complete(hub, "a", "A"); const replay = hub.watch(scope, cursor); assert.equal(replay.mode, "replay");
  const frames = replay.drain(); assert.deepEqual(deliver(client, frames), ["applied"]); assert.equal(client.apply(frames[0]), "duplicate");
  complete(hub, "b", "B"); complete(hub, "c", "C");
  const missed = hub.watch(scope, cursor); assert.equal(missed.mode, "snapshot"); assert.equal(missed.drain()[0]!.kind, "snapshot");
  assert.ok(initial.overflowResets >= 1); assert.equal(initial.drain()[0]!.kind, "snapshot");
  assert.deepEqual(hub.snapshot(scope).rows.map(row => row.id), ["a", "b", "c"]);
});

test("a rejected native batch changes neither current state nor an already-open stream", () => {
  const hub = setup(), stream = hub.watch(scope); stream.drain(); const before = hub.snapshot(scope);
  assert.throws(() => hub.emit(scope, [{ type: "start", id: "first", kind: "assistant" },
    { type: "finish", id: "second", kind: "assistant", lifecycle: "completed", text: 123 } as never]));
  assert.equal(hub.snapshot(scope), before); assert.deepEqual(stream.drain(), []);
});

test("native empty append publication advances sequence without requiring a visible text change", () => {
  const hub = setup(); hub.emit(scope, [{ type: "start", id: "shell", kind: "tool" }]);
  hub.emit(scope, [{ type: "append", id: "shell", kind: "tool", text: "", sequence: 0 }]);
  hub.emit(scope, [{ type: "append", id: "shell", kind: "tool", text: "x", sequence: 1 }]);
  assert.deepEqual(hub.snapshot(scope).coverage.gaps, []);
  hub.emit(scope, [{ type: "append", id: "shell", kind: "tool", text: "x", sequence: 1 }]);
  const body = hub.snapshot(scope).rows[0]!.body; assert.equal(body.kind !== "unavailable" && body.text, "x");
});

test("known native full empty body supersedes provisional text, while absent/null body preserves it", () => {
  const hub = setup();
  for (const id of ["empty", "null"]) hub.emit(scope, [{ type: "start", id, kind: "tool" }, { type: "append", id, kind: "tool", text: "observed" }]);
  hub.emit(scope, [{ type: "finish", id: "empty", kind: "tool", lifecycle: "completed", text: "" },
    { type: "finish", id: "null", kind: "tool", lifecycle: "completed", text: null }]);
  const [empty, omitted] = hub.snapshot(scope).rows;
  assert.equal(empty!.body.kind, "complete"); assert.equal(empty!.body.text, "");
  assert.equal(omitted!.lifecycle, "completed"); assert.equal(omitted!.body.kind, "partial");
  assert.equal(omitted!.body.text, "observed");
});

test("terminal partial rows leave current residency with their evidence intact; running work remains protected", async () => {
  const hub = setup({ maxRows: 1, maxBodyBytes: 5 }), client = new HistoryClient(scope), stream = hub.watch(scope), view = client.view();
  try {
    deliver(client, stream.drain()); complete(hub, "big", "🙂🙂"); deliver(client, stream.drain());
    const row = hub.snapshot(scope).rows[0]!;
    assert.deepEqual(row.body, { kind: "partial", text: "🙂", missing: ["truncated"] });
    complete(hub, "new", "ok"); deliver(client, stream.drain());
    assert.equal(hub.snapshot(scope).rows[0]!.id, "new");
    assert.deepEqual(view.getSnapshot().rows.find(value => value.id === "big"), row);
    assert.ok(hub.snapshot(scope).coverage.gaps.some(gap => gap.kind === "truncated" && gap.rowId === "big"));
    assert.deepEqual(hub.snapshot(scope).retirements, []);
    hub.emit(scope, [{ type: "start", id: "pending", kind: "tool" }]);
    assert.throws(() => complete(hub, "later", "ok"), /PROTECTED_ROW_CAPACITY/);
    assert.equal(hub.snapshot(scope).rows[0]!.id, "pending");
  } finally { await stream.return(); }
});

test("forgotten prefix or final annotations cannot downgrade proved terminal bodies; actual contradiction remains visible", () => {
  const hub = setup();
  complete(hub, "native-full", "native full body");
  hub.emit(scope, [{ type: "start", id: "captured", kind: "assistant" }, { type: "append", id: "captured", kind: "assistant", text: "captured full body" },
    { type: "finish", id: "captured", kind: "assistant", lifecycle: "completed", text: null, sealCaptured: true }]);
  const before = hub.snapshot(scope).rows;
  assert.deepEqual(before.map(row => row.body.kind === "complete" && row.body.evidence), ["nativeFullBody", "capturedStartThroughEnd"]);
  for (const row of before) for (const kind of ["missingPrefix", "missingFinal"] as const)
    hub.emit(scope, [{ type: "gap", gap: { id: `${kind}:${row.id}`, kind, rowId: row.id } }]);
  assert.deepEqual(hub.snapshot(scope).rows, before); assert.deepEqual(hub.snapshot(scope).coverage.gaps, []);
  hub.emit(scope, [{ type: "gap", gap: { id: "actual-contradiction", kind: "nativeGap", rowId: "native-full" } }]);
  assert.deepEqual(hub.snapshot(scope).rows[0], before[0]);
  assert.ok(hub.snapshot(scope).coverage.gaps.some(gap => gap.id === "actual-contradiction"));
  const completed = hub.snapshot(scope).rows[0]!;
  hub.emit(scope, [{ type: "start", id: "native-full", kind: "assistant", text: "orphan-start", native: { orphan: "must-not-merge" } },
    { type: "append", id: "native-full", kind: "assistant", text: "orphan-delta" },
    { type: "finish", id: "native-full", kind: "assistant", lifecycle: "completed", text: "conflicting final" }]);
  assert.deepEqual(hub.snapshot(scope).rows[0], completed);
  assert.ok(hub.snapshot(scope).coverage.gaps.some(gap => gap.rowId === "native-full" && gap.kind === "nativeGap"));
  const small = setup({ maxRows: 1 }); complete(small, "proved-empty", "");
  small.emit(scope, [{ type: "start", id: "pending", kind: "tool" }]);
  const pending = small.snapshot(scope);
  small.emit(scope, [{ type: "start", id: "proved-empty", kind: "assistant", text: "orphan", native: { orphan: true } },
    { type: "append", id: "proved-empty", kind: "assistant", text: "orphan" },
    { type: "finish", id: "proved-empty", kind: "assistant", lifecycle: "completed", text: "" }]);
  assert.strictEqual(small.snapshot(scope), pending, "known terminal duplicates must not evict or compete with running residency");
});

test("rolling gap annotations preserve positive capture loss and the latest actual read boundary", () => {
  const hub = setup({ maxGaps: 4 });
  hub.emit(scope, [{ type: "gap", gap: { id: CAPTURE_GAP_ID, kind: "nativeGap" } },
    { type: "readBoundary", factId: "latest-boundary", reason: "Native compaction" }]);
  for (let index = 0; index < 20; index++) hub.emit(scope, [{ type: "gap", gap: { id: `older-annotation-${index}`, kind: "unsupported" } }]);
  const snapshot = hub.snapshot(scope);
  assert.equal(snapshot.coverage.gaps.length, 4);
  assert.ok(snapshot.coverage.gaps.some(gap => gap.id === CAPTURE_GAP_ID));
  assert.ok(snapshot.coverage.gaps.some(gap => gap.id === JSON.stringify(["nativeReadBoundary", "latest-boundary"])));
  assert.ok(snapshot.coverage.gaps.some(gap => gap.kind === "truncated"));
  assert.equal(hub.owner(scope).readBoundary, "latest-boundary");
});

test("current-residency eviction preserves actual retained client rows and explicit native retirement removes only proven identities", () => {
  const hub = setup({ maxRows: 1 }), client = new HistoryClient(scope), stream = hub.watch(scope); client.view("main");
  deliver(client, stream.drain()); complete(hub, "a", "A"); deliver(client, stream.drain());
  complete(hub, "b", "B"); deliver(client, stream.drain());
  assert.deepEqual(client.current!.rows.map(row => row.id), ["b"]);
  assert.deepEqual(client.view().getSnapshot().rows.map(row => row.id), ["a", "b"]);
  hub.emit(scope, [{ type: "retire", rowIds: ["a"], evidence: "scripted exact native edit" }]); deliver(client, stream.drain());
  assert.deepEqual(client.view().getSnapshot().rows.map(row => row.id), ["b"]);
});

test("attachment replacement retires old capture; native edit rotates only the affected history generation", async () => {
  const hub = setup(), old = hub.watch(scope); complete(hub, "a", "A"); old.drain();
  const next = { ...scope, origin: { ...scope.origin, attachment: "owned-2" } };
  hub.open(next); assert.equal((await old.next()).done, true);
  assert.throws(() => complete(hub, "late", "old"), /UNKNOWN_OR_RETIRED_SCOPE/);
  const before = hub.snapshot(next).generation; hub.reset(next, "thread/reverted");
  assert.notEqual(hub.snapshot(next).generation, before); assert.deepEqual(hub.snapshot(next).rows, []);
  assert.equal(hub.snapshot(next).coverage.knownStart, false);
});

test("initial replay obeys subscriber bound and semantic tombstones survive it without permitting resurrection", () => {
  const hub = setup({ maxQueuedFrames: 1, maxRetirements: 1 });
  const cursor = { generation: hub.snapshot(scope).generation, revision: 0 };
  complete(hub, "a", "A"); complete(hub, "b", "B"); complete(hub, "c", "C");
  const stream = hub.watch(scope, cursor); assert.equal(stream.mode, "snapshot"); assert.equal(stream.drain().length, 1);
  hub.emit(scope, [{ type: "retire", rowIds: ["a"], evidence: "exact fixture proof" }]);
  assert.deepEqual(hub.snapshot(scope).retirements, [{ kind: "retireRows", rowIds: ["a"], evidence: "exact fixture proof" }]);
  assert.throws(() => complete(hub, "a", "resurrect"), /RETIRED_NATIVE_IDENTITY/);
  assert.throws(() => hub.emit(scope, [{ type: "retire", rowIds: ["b"], evidence: "other proof" }]), /RETIREMENT_CAPACITY/);
  assert.deepEqual(hub.snapshot(scope).rows.map(row => row.id), ["b", "c"]);
});

test("metadata-only native record preserves an unavailable text body without inventing a blank full body", () => {
  const hub=setup();hub.emit(scope,[{type:"start",id:"delegation",kind:"delegation",text:null,native:{childThreadId:"exact-child",model:null}}]);
  assert.deepEqual(hub.snapshot(scope).rows[0]!.body,{kind:"unavailable",reason:"nativeOmitted"});
  hub.emit(scope,[{type:"finish",id:"delegation",kind:"delegation",lifecycle:"completed",text:null}]);
  assert.deepEqual(hub.snapshot(scope).rows[0]!.body,{kind:"unavailable",reason:"nativeOmitted"});
  assert.equal(hub.snapshot(scope).rows[0]!.lifecycle,"completed");assert.deepEqual(hub.snapshot(scope).coverage.gaps,[]);
});

const pendingMedia: NativeMediaOccurrence = { id: "output-image", kind: "image", source: "disk", path: "/scripted/image.png", state: "pending" };
const availableMedia: NativeMediaOccurrence = { ...pendingMedia, state: "available", artifactId: "immutable-image" };

test("file resolution streams metadata without changing body, lifecycle or content version and rejects absent or different native identities", () => {
  const hub = setup(), client = new HistoryClient(scope), stream = hub.watch(scope);
  hub.emit(scope, [{ type: "finish", id: "tool-image", kind: "tool", lifecycle: "completed", text: "tool result", native: { media: [pendingMedia] } }]);
  deliver(client, stream.drain()); const before = hub.snapshot(scope).rows[0]!, revision = hub.snapshot(scope).revision;
  hub.emit(scope, [{ type: "media", id: before.id, media: [availableMedia] }]); deliver(client, stream.drain());
  const after = client.current!.rows[0]!;
  assert.ok(after.version > before.version); assert.equal(after.contentVersion, before.contentVersion);
  assert.deepEqual(after.body, before.body); assert.equal(after.lifecycle, before.lifecycle); assert.deepEqual(after.native.media, [availableMedia]);
  assert.equal(hub.snapshot(scope).revision, revision + 1);
  const stable = hub.snapshot(scope);
  assert.throws(() => hub.emit(scope, [{ type: "media", id: "missing", media: [availableMedia] }]), /MEDIA_ROW_MISSING/);
  assert.throws(() => hub.emit(scope, [{ type: "media", id: before.id, media: [{ ...availableMedia, path: "/different/image.png" }] }]), /MEDIA_IDENTITY_CONFLICT/);
  assert.throws(() => hub.emit(scope, [{ type: "media", id: before.id, media: [{ ...availableMedia, artifactId: "other-artifact" }] }]), /MEDIA_ARTIFACT_CONFLICT/);
  assert.strictEqual(hub.snapshot(scope), stable); assert.deepEqual(hub.snapshot(scope).rows.map(row => row.id), [before.id]);
});

test("media settlement during a held history read permits body healing while stale native and read metadata cannot undo available bytes", () => {
  const hub = setup(), owner = hub.owner(scope);
  hub.emit(scope, [{ type: "append", id: "tool-image", kind: "tool", text: "captured suffix" },
    { type: "finish", id: "tool-image", kind: "tool", lifecycle: "completed", native: { media: [pendingMedia] } }]);
  const fence = owner.beginRead(), before = owner.snapshot().rows[0]!;
  hub.emit(scope, [{ type: "media", id: before.id, media: [availableMedia] }]);
  assert.equal(owner.snapshot().rows[0]!.contentVersion, before.contentVersion);
  const record = { id: before.id, kind: before.kind, lifecycle: "completed" as const,
    body: { kind: "complete" as const, text: "full native body", evidence: "nativeFullBody" as const }, native: { media: [pendingMedia] } };
  const page = owner.mergeRead(fence, [record], { state: "end", evidence: "nativeBoundary" }, [], true)!; owner.endRead(fence);
  assert.equal(page.rows[0]!.body.kind, "complete"); assert.equal(page.rows[0]!.body.text, "full native body");
  assert.deepEqual(rowMedia(page.rows[0]!), [availableMedia]); assert.deepEqual(rowMedia(owner.snapshot().rows[0]!), [availableMedia]);
  hub.emit(scope, [{ type: "finish", id: before.id, kind: "tool", lifecycle: "completed", text: "full native body", native: { media: [pendingMedia] } }]);
  assert.deepEqual(rowMedia(owner.snapshot().rows[0]!), [availableMedia]);
});

test("resolving read-derived media retains read provenance so a later live suffix never appends to an unjoined historical prefix", () => {
  const hub = setup(), owner = hub.owner(scope), fence = owner.beginRead();
  owner.mergeRead(fence, [{ id: "read-tool", kind: "tool", lifecycle: "unknown", body: { kind: "partial", text: "history prefix", missing: ["final"] }, native: { media: [pendingMedia] } }], { state: "end", evidence: "nativeBoundary" }, [], true); owner.endRead(fence);
  hub.emit(scope, [{ type: "media", id: "read-tool", media: [availableMedia] }]);
  hub.emit(scope, [{ type: "append", id: "read-tool", kind: "tool", text: "live suffix" }]);
  const row = owner.snapshot().rows[0]!;
  assert.equal(row.body.kind, "partial"); assert.equal(row.body.text, "live suffix"); assert.deepEqual(rowMedia(row), [availableMedia]);
  assert.ok(owner.snapshot().coverage.gaps.some(gap => gap.rowId === row.id && gap.kind === "nativeGap"));
});
