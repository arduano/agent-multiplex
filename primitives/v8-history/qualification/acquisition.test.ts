import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { CodexScope, CopilotScope, Row, Scope } from "../src/contracts/types.js";
import type { AcquisitionBatch, AcquisitionPort, HistoryRecord } from "../src/acquisition/types.js";
import { HistoryAcquisition, type AcquisitionResult } from "../src/acquisition/owner.js";
import type { ReadHandle } from "../src/repair/read-coordinator.js";
import { ReadCoordinator } from "../src/repair/read-coordinator.js";
import { HistoryHub } from "../src/host/history-owner.js";
import { HistoryWorkspace } from "../src/client/workspace.js";
import { ScriptedLink } from "../src/scripted/link.js";
import { createCodexCodec, codexRowId } from "../src/native/codex/index.js";
import { createCodexHistoryPort, type CodexItemsPage, type CodexItemsRequest } from "../src/native/codex/history.js";
import { createCopilotCodec } from "../src/native/copilot/index.js";
import { createCopilotHistoryPort } from "../src/native/copilot/history.js";

const scope: CodexScope = { kind: "codex", threadId: "root", origin: {
  connection: "fixture", principal: "owner", host: "host", nativeSession: "root", attachment: "owned" } };
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function record(id: string, text = id): HistoryRecord { return { id, kind: "assistant", lifecycle: "completed",
  body: { kind: "complete", text, evidence: "nativeFullBody" }, native: {} }; }
function batch(records: readonly HistoryRecord[], selectedScope: Scope = scope, nextCursor: string | null = null): AcquisitionBatch {
  return { scope: selectedScope, status: "ok", records, hasMore: nextCursor !== null, nextCursor, gaps: [] };
}
function makePort(read: AcquisitionPort<CodexScope>["read"], selectedScope = scope, mode: AcquisitionPort<CodexScope>["mode"] = "active"): AcquisitionPort<CodexScope> {
  return { scope: selectedScope, mode, read };
}
function rig(selectedScope: CodexScope = scope) { const hub = new HistoryHub(); hub.open(selectedScope); return { hub, owner: hub.owner(selectedScope) }; }
async function value(handle: ReadHandle<AcquisitionResult>): Promise<AcquisitionResult> {
  const observed = await handle.wait(1000); assert.equal(observed.state, "value");
  if (observed.state !== "value") throw new Error("Expected acquisition result"); return observed.value;
}
function text(row: Row): string | null { return row.body.kind === "unavailable" ? null : row.body.text; }
const entry = (item: unknown, turnId = "turn") => ({ turnId, item, startedAtMs: null, completedAtMs: null });
const codexPage = (data: CodexItemsPage["data"], nextCursor: string | null = null): CodexItemsPage => ({ data, nextCursor, backwardsCursor: data.length ? "reverse" : null });
const event = (id: string, type: string, data: Record<string, unknown>) => ({ id, type, data, parentId: null, timestamp: "2026-10-23T00:00:00Z" });

test("cold Codex page racing real captured completion preserves exact live bytes/versions while observers coalesce without viewers", async () => {
  const fixture = JSON.parse(await readFile(new URL("../../qualification/fixtures/codex-live-20261023.json", import.meta.url), "utf8")) as {
    cases: { rootThreadId: string; events: { method: string; params: Record<string, unknown> }[] }[];
  };
  const captured = fixture.cases[0]!, nativeScope: CodexScope = { ...scope, threadId: captured.rootThreadId,
    origin: { ...scope.origin, nativeSession: captured.rootThreadId } };
  const hub = new HistoryHub(), codec = createCodexCodec({ origin: nativeScope.origin, rootThreadId: nativeScope.threadId, capture: hub });
  const owner = hub.owner(nativeScope), held = deferred<CodexItemsPage>(); let calls = 0;
  const port = createCodexHistoryPort({ scope: nativeScope, authorize: async () => {}, list: async () => { calls++; return held.promise; } });
  const acquisition = new HistoryAcquisition(owner, port), first = acquisition.baseline("E01", "cold attachment"), second = acquisition.baseline("E01", "cold attachment");
  assert.strictEqual(first, second); await tick(); assert.equal(calls, 1); assert.equal(owner.subscriberCount, 0);
  for (const native of captured.events) codec.observe(native);
  const before = owner.snapshot(), answer = before.rows.find(row => row.native.type === "agentMessage")!;
  assert.ok(answer); assert.equal(acquisition.reads.active, 1);
  // Synthetic read shape uses exact real native identity, deliberately stale body.
  held.resolve(codexPage([entry({ type: "agentMessage", id: answer.native.nativeItemId, text: "stale read must lose" }, answer.native.turnId as string),
    entry({ type: "userMessage", id: "old-history", clientId: "old-original", content: [{ type: "text", text: "older native history" }] }, "prior-turn")]));
  const result = await value(first); assert.equal(result.status, "ready");
  const after = owner.snapshot().rows.find(row => row.id === answer.id)!;
  assert.deepEqual(after, answer); assert.equal(after.version, answer.version); assert.equal(after.contentVersion, answer.contentVersion);
  assert.equal(owner.snapshot().rows.filter(row => row.id === answer.id).length, 1);
  assert.ok(owner.snapshot().rows.some(row => row.native.nativeItemId === "old-history"));
  assert.equal(calls, 1); assert.equal(acquisition.counters.portCalls, 1); assert.equal(acquisition.reads.active, 0);
  assert.deepEqual(owner.snapshot().activity, before.activity);
});

test("pinned A-B-A selection retains state and an expired consumer cannot finish or overwrite its successor token", async () => {
  const { hub, owner } = rig(), other: CodexScope = { ...scope, threadId: "other", origin: { ...scope.origin, nativeSession: "other" } };
  hub.open(other);
  for (const selected of [scope, other]) hub.emit(selected, [
    { type: "finish", id: "current", kind: "assistant", lifecycle: "completed", text: selected.threadId },
    { type: "edge", edge: { state: "available", cursor: "older-input" } },
  ]);
  const workspace = new HistoryWorkspace({ connection: "fixture", principal: "owner" }), a = workspace.session(scope), b = workspace.session(other);
  a.setPinned(true); a.setDraft("retained draft");
  const linkA = new ScriptedLink(hub, workspace, scope), linkB = new ScriptedLink(hub, workspace, other); linkA.connect(); linkB.connect();
  const selectedA = workspace.select(scope), view = selectedA.view, oldToken = view.beginOlderRead(), held = deferred<AcquisitionBatch>();
  const acquisition = new HistoryAcquisition(owner, makePort(async () => held.promise)), read = acquisition.older(oldToken);
  await tick(); workspace.select(other); const bBefore = b.client.view().getSnapshot();
  assert.equal(a.mountedReferences, 0); assert.equal(a.observationReferences, 1);
  const back = workspace.select(scope); assert.strictEqual(back.view, view);
  assert.equal((await read.wait(0)).state, "waitingExpired"); assert.equal(acquisition.reads.active, 1);
  view.finishOlderRead(oldToken); const newToken = view.beginOlderRead(); assert.notStrictEqual(newToken, oldToken);
  assert.strictEqual(acquisition.older(newToken), read);
  view.finishOlderRead(oldToken); assert.equal(view.getSnapshot().viewport.loadingOlder, true);
  held.resolve(batch([record("older")], scope, null)); const result = await value(read); assert.equal(result.status, "ready");
  if (result.status !== "ready") throw new Error("Expected page");
  assert.equal(view.applyPage(result.page, oldToken), "stale"); assert.equal(view.getSnapshot().viewport.loadingOlder, true);
  assert.equal(view.applyPage(result.page, newToken), "applied");
  assert.deepEqual(view.getSnapshot().rows.map(row => row.id), ["older", "current"]);
  assert.strictEqual(b.client.view().getSnapshot(), bBefore); assert.equal(a.draft, "retained draft"); assert.equal(a.pinned, true);
  assert.equal(acquisition.counters.portCalls, 1); assert.equal(acquisition.reads.active, 0);
  back.release(); await linkA.disconnect(); await linkB.disconnect();
});

test("native edit/reset and attachment replacement fence delayed pages while their actual read slot remains occupied", async () => {
  for (const change of ["nativeEdit", "replacement"] as const) {
    const { hub, owner } = rig(), reads = new ReadCoordinator({ maxConcurrent: 1, maxFacts: 8, maxAttemptsPerFact: 1 }), held = deferred<AcquisitionBatch>();
    const acquisition = new HistoryAcquisition(owner, makePort(async () => held.promise), reads), read = acquisition.baseline("E01", change);
    await tick(); assert.equal(reads.active, 1);
    let current = owner;
    if (change === "nativeEdit") owner.reset("qualified native history replacement");
    else { const replacement = { ...scope, origin: { ...scope.origin, attachment: "replacement" } }; hub.open(replacement); current = hub.owner(replacement); }
    assert.equal((await read.wait(0)).state, "waitingExpired"); assert.equal(reads.active, 1);
    assert.throws(() => reads.request({ scope, factId: "cannot overlap", reason: "E06", kind: "nativeBody" }, async () => 1), /READ_BUSY/);
    held.resolve(batch([record("must not return")])); assert.deepEqual(await value(read), { status: "stale" });
    assert.equal(current.snapshot().rows.length, 0); assert.equal(reads.active, 0);
    assert.equal(acquisition.counters.portCalls, 1);
  }
});

test("semantic retirement during an older read preserves tombstones and removes the retired identity from its returned page", async () => {
  const { hub, owner } = rig(); hub.emit(scope, [
    { type: "finish", id: "retired", kind: "assistant", lifecycle: "completed", text: "old" },
    { type: "edge", edge: { state: "available", cursor: "older" } },
  ]);
  const held = deferred<AcquisitionBatch>(), acquisition = new HistoryAcquisition(owner, makePort(async () => held.promise));
  const read = acquisition.older({ scope, generation: owner.snapshot().generation, cursor: "older" }); await tick();
  hub.emit(scope, [{ type: "retire", rowIds: ["retired"], evidence: "exact native identity replacement" }]);
  assert.equal(acquisition.reads.active, 1);
  held.resolve(batch([record("retired"), record("survives")])); const result = await value(read); assert.equal(result.status, "ready");
  if (result.status !== "ready") throw new Error("Expected page");
  assert.deepEqual(result.page.rows.map(row => row.id), ["survives"]);
  assert.equal(owner.snapshot().rows.some(row => row.id === "retired"), false);
  assert.deepEqual(owner.snapshot().retirements.map(item => item.rowIds), [["retired"]]);
});

test("active Codex oversized acquisition shrinks at one input cursor without multiplying exception episodes", async () => {
  const { owner } = rig(), calls: CodexItemsRequest[] = [];
  const port = createCodexHistoryPort({ scope, authorize: async () => {}, list: async request => {
    calls.push(request); return codexPage([entry({ type: "commandExecution", id: "one", status: "completed", aggregatedOutput: request.limit === 1 ? "fits" : "x".repeat(4000) })], "next-native");
  } });
  const acquisition = new HistoryAcquisition(owner, port, undefined, { count: 4, maxBytes: 1000 });
  const result = await value(acquisition.baseline("E01", "bounded baseline")); assert.equal(result.status, "ready");
  assert.deepEqual(calls.map(call => [call.cursor, call.limit]), [[null, 4], [null, 2], [null, 1]]);
  assert.equal(acquisition.counters.portCalls, 3); assert.equal(acquisition.counters.oversized, 2);
  assert.equal(acquisition.reads.counters.nativeBodyReads, 1); assert.equal(text(owner.snapshot().rows[0]!), "fits");
  assert.deepEqual(owner.snapshot().olderEdge, { state: "available", cursor: "next-native" });
});

test("persisted failure consumes its native cursor once and a new fact cannot replay the failed transfer", async () => {
  const { owner } = rig(); let calls = 0;
  const acquisition = new HistoryAcquisition(owner, makePort(async () => { calls++; throw new Error("native failure"); }, scope, "persisted"));
  const first = acquisition.baseline("E28", "stopped inspection"); assert.deepEqual(await first.wait(1000), { state: "failed", code: "READ_FAILED" });
  assert.strictEqual(acquisition.baseline("E28", "stopped inspection"), first);
  assert.throws(() => acquisition.baseline("E28", "distinct observer fact"), /PERSISTED_CURSOR_CONSUMED/);
  assert.equal(calls, 1); assert.equal(acquisition.counters.portCalls, 1);
  assert.equal(owner.snapshot().olderEdge.state, "unknown"); assert.equal(owner.snapshot().rows.length, 0);
});

test("persisted meaningful pages skip the captured native metadata sequence without changing tool-body decoding", async () => {
  const selected: CopilotScope = { kind: "copilot", origin: scope.origin, agentId: null }, hub = new HistoryHub(); hub.open(selected);
  // Exact event-type order from the closed .19/.95 passive SDK reader. Bodies
  // are synthetic marker bytes; no vendor file, provider or session is read.
  const native = [event("end-new", "assistant.turn_end", {}), event("answer", "assistant.message", { messageId: "answer", content: "finished" }),
    event("usage", "session.usage_record", {}), event("start", "assistant.turn_start", {}), event("end-old", "assistant.turn_end", {}),
    event("tool", "tool.execution_complete", { toolCallId: "exact-tool", success: true, result: { content: "OWNED_COMPLETE_TOOL" } })];
  const inputs: (string | undefined)[] = [];
  const port = createCopilotHistoryPort({ scope: selected, mode: "persisted", read: async request => {
    assert("sessionId" in request); assert.equal(request.max, 1); assert.equal(request.cursor, inputs.length ? String(inputs.length) : undefined);
    inputs.push(request.cursor); const index = inputs.length - 1;
    return { events: [native[index]!], cursor: index === native.length - 1 ? "" : String(index + 1), hasMore: index < native.length - 1, cursorStatus: "ok" };
  } });
  const acquisition = new HistoryAcquisition(hub.owner(selected), port), first = await value(acquisition.baseline("E01", "cold six-event baseline"));
  assert.equal(first.status, "ready"); if (first.status !== "ready") throw Error("Expected baseline");
  assert.deepEqual(first.page.rows.map(row => row.kind), ["assistant"]); assert.equal(inputs.length, 2);
  let page = first.page;
  // usage_record is not declared by SDK .19. Until its observed metadata-only
  // classification is qualified, preserve its honest unsupported-gap page.
  const gap = await value(acquisition.older({ scope: selected, generation: page.generation, cursor: page.olderEdge.state === "available" ? page.olderEdge.cursor : "missing" }));
  assert.equal(gap.status, "ready"); if (gap.status !== "ready") throw Error("Expected gap page"); page = gap.page;
  assert.equal(page.rows.length, 0); assert(hub.snapshot(selected).coverage.gaps.some(item => item.kind === "unsupported"));
  const last = await value(acquisition.older({ scope: selected, generation: page.generation, cursor: page.olderEdge.state === "available" ? page.olderEdge.cursor : "missing" }));
  assert.equal(last.status, "ready"); if (last.status !== "ready") throw Error("Expected tool page");
  assert.deepEqual(last.page.rows.map(row => [row.kind, row.lifecycle, row.body.kind, text(row)]), [["tool", "completed", "complete", "OWNED_COMPLETE_TOOL"]]);
  assert.deepEqual(last.page.olderEdge, { state: "end", evidence: "nativeBoundary" }); assert.equal(inputs.length, 6);
});

test("persisted scans and sequential UI pages have per-action bounds rather than lifetime32/64 read quotas", async () => {
  const { owner } = rig(), reads = new ReadCoordinator({ maxConcurrent: 1, maxFacts: 3, maxAttemptsPerFact: 1 }); let calls = 0;
  const acquisition = new HistoryAcquisition(owner, makePort(async request => {
    assert.equal(request.cursor, calls ? `cursor-${calls}` : null); calls++;
    return batch(calls <= 40 ? [] : [record(`row-${calls}`)], scope, `cursor-${calls}`);
  }, scope, "persisted"), reads);
  const initial = await value(acquisition.baseline("E01", "forty ignored native records"));
  assert.equal(initial.status, "ready"); if (initial.status !== "ready") throw Error("Expected baseline");
  assert.equal(calls, 41); assert.equal(initial.page.rows.length, 1);
  let page = initial.page;
  for (let index = 0; index < 70; index++) {
    assert.equal(page.olderEdge.state, "available"); if (page.olderEdge.state !== "available") throw Error("Expected continuation");
    const result = await value(acquisition.older({ scope, generation: page.generation, cursor: page.olderEdge.cursor }));
    assert.equal(result.status, "ready"); if (result.status !== "ready") throw Error("Expected page"); page = result.page;
    assert(reads.retainedFacts <= 3); assert(acquisition.retention.episodes <= 3);
  }
  assert.equal(calls, 111); assert.equal(acquisition.counters.portCalls, 111);
  assert.throws(() => acquisition.older({ scope, generation: page.generation, cursor: "cursor-41" }), /PERSISTED_CURSOR_CONSUMED/);
  assert.equal(calls, 111); assert.equal(reads.active, 0);
});

test("a finite empty scan preserves its exact continuation and previous-page coalescing while a successor is pending", async () => {
  const { owner } = rig(), held = deferred<AcquisitionBatch>(); let calls = 0;
  const acquisition = new HistoryAcquisition(owner, makePort(async request => {
    calls++; assert.equal(request.cursor, calls === 1 ? null : `c${calls - 1}`);
    if (calls === 7) return held.promise;
    return batch(calls <= 3 ? [] : [record(`r${calls}`)], scope, `c${calls}`);
  }, scope, "persisted"), undefined, { maxCallsPerPage: 3 });
  const first = await value(acquisition.baseline("E01", "bounded empty scan"));
  assert.equal(first.status, "ready"); if (first.status !== "ready") throw Error("Expected bounded page");
  assert.equal(calls, 3); assert.deepEqual(first.page.olderEdge, { state: "available", cursor: "c3" });
  assert.equal(first.page.rows.length, 0); assert.equal(acquisition.counters.limited, 1);
  const target = (cursor: string) => ({ scope, generation: owner.snapshot().generation, cursor });
  const previous = acquisition.older(target("c3")); await value(previous);
  await value(acquisition.older(target("c4"))); await value(acquisition.older(target("c5")));
  const pending = acquisition.older(target("c6")); await tick();
  assert.strictEqual(acquisition.older(target("c6")), pending);
  assert.deepEqual((await acquisition.older(target("c5")).wait(0)).state, "value");
  assert.equal((await pending.wait(0)).state, "waitingExpired"); assert.equal(acquisition.reads.active, 1);
  assert.throws(() => acquisition.older(target("c7")), /READ_BUSY/); assert.equal(calls, 7);
  held.resolve(batch([record("r7")], scope, "c7")); await value(pending); assert.equal(acquisition.reads.active, 0);
});

test("active baselines follow new real facts and generations while superseded facts cannot manufacture reads", async () => {
  const { owner } = rig(); let calls = 0;
  const acquisition = new HistoryAcquisition(owner, makePort(async () => batch([record(`baseline-${++calls}`)])));
  const first = acquisition.baseline("E01", "initial"); await value(first);
  assert.strictEqual(acquisition.baseline("E01", "initial"), first);
  const gap = acquisition.baseline("E06", "actual native gap"); await value(gap);
  assert.equal(calls, 2); assert.strictEqual(acquisition.baseline("E06", "actual native gap"), gap);
  assert.throws(() => acquisition.baseline("E01", "initial"), /ACQUISITION_FACT_RETIRED/); assert.equal(calls, 2);
  owner.reset("new native history generation"); await value(acquisition.baseline("E01", "initial")); assert.equal(calls, 3);
  assert.throws(() => acquisition.baseline("E06", "initial"), /FACT_MEANING_CHANGED/);
});

test("persisted byte failures and bounded cursor tombstones never dispatch a consumed or unretained continuation", async () => {
  for (const bound of ["count", "bytes", "page"] as const) {
    const { owner } = rig(); let calls = 0;
    const acquisition = new HistoryAcquisition(owner, makePort(async () => {
      calls++; return batch([record(`r${calls}`, bound === "page" ? "x".repeat(2000) : "small")], scope, `cursor-${calls}-${"x".repeat(80)}`);
    }, scope, "persisted"), undefined, bound === "count" ? { maxTombstones: 1 } : bound === "bytes" ? { maxTombstoneBytes: 100 } : { maxBytes: 1000 });
    const first = acquisition.baseline("E28", "stopped bounded read");
    if (bound === "page") {
      assert.deepEqual(await first.wait(1000), { state: "failed", code: "PAGE_TOO_LARGE" });
      assert.strictEqual(acquisition.baseline("E28", "stopped bounded read"), first);
      assert.throws(() => acquisition.baseline("E28", "different fact"), /PERSISTED_CURSOR_CONSUMED/);
    } else {
      const result = await value(first); assert.equal(result.status, "ready"); if (result.status !== "ready" || result.page.olderEdge.state !== "available") throw Error("Expected retained continuation");
      const failed = acquisition.older({ scope, generation: result.page.generation, cursor: result.page.olderEdge.cursor });
      assert.deepEqual(await failed.wait(1000), { state: "failed", code: "ACQUISITION_IDENTITY_CAPACITY" });
    }
    assert.equal(calls, 1); assert(acquisition.retention.tombstones <= acquisition.limits.maxTombstones);
    assert(acquisition.retention.tombstoneBytes <= acquisition.limits.maxTombstoneBytes);
  }
});

test("expired and unsupported acquisition results preserve prior history instead of publishing empty/end evidence", async () => {
  for (const status of ["expired", "unsupported"] as const) {
    const { hub, owner } = rig(); hub.emit(scope, [{ type: "finish", id: "kept", kind: "assistant", lifecycle: "completed", text: "kept" }]);
    const before = owner.snapshot(), acquisition = new HistoryAcquisition(owner,
      makePort(async () => ({ ...batch([]), status })));
    assert.deepEqual(await value(acquisition.baseline("E01", status)), { status });
    const { read: _beforeRead, revision: _beforeRevision, ...prior } = before, { read, revision, ...after } = owner.snapshot();
    assert.deepEqual(after, prior); assert.ok(revision > before.revision); assert.deepEqual(read, { state: 'settled', target: { kind: 'recover' }, outcome: status });
    assert.equal(owner.snapshot().olderEdge.state, "unknown");
  }
});

test("historical child activity and old terminal metadata cannot change current Host activity or grant a live child", async () => {
  const { hub, owner } = rig(); hub.emit(scope, [{ type: "activity", activity: { turnId: "current-turn", state: "working" } }]);
  const before = owner.snapshot().activity;
  const port = createCodexHistoryPort({ scope, authorize: async () => {}, list: async () => codexPage([
    entry({ type: "subAgentActivity", id: "old-start", kind: "started", agentThreadId: "cold-child", agentPath: "0/1" }, "old-turn"),
  ]) });
  const acquisition = new HistoryAcquisition(owner, port); assert.equal((await value(acquisition.baseline("E01", "old child activity"))).status, "ready");
  assert.deepEqual(owner.snapshot().activity, before);
  assert.throws(() => hub.owner({ ...scope, threadId: "cold-child" }), /UNKNOWN_OR_RETIRED_SCOPE/);
  assert.equal(owner.snapshot().rows[0]!.lifecycle, "unknown");
});

test("Copilot live completion wins an earlier history read without replaying old idle or creating duplicate logical messages", async () => {
  const nativeScope: CopilotScope = { kind: "copilot", origin: scope.origin, agentId: null };
  const hub = new HistoryHub(), codec = createCopilotCodec({ origin: nativeScope.origin, capture: hub }), held = deferred<unknown>();
  const owner = hub.owner(nativeScope), port = createCopilotHistoryPort({ scope: nativeScope, mode: "active", read: async () => held.promise });
  const acquisition = new HistoryAcquisition(owner, port), read = acquisition.baseline("E01", "Copilot cold view"); await tick();
  codec.observe(event("live-final", "assistant.message", { messageId: "logical-message", content: "real live full body" }));
  const before = owner.snapshot().rows[0]!;
  held.resolve({ events: [event("stored-final", "assistant.message", { messageId: "logical-message", content: "older stored body" }),
    event("old-idle", "session.idle", {})], cursor: "done", cursorStatus: "ok", hasMore: false });
  assert.equal((await value(read)).status, "ready");
  assert.equal(owner.snapshot().rows.length, 1); assert.deepEqual(owner.snapshot().rows[0], before);
  assert.equal(text(owner.snapshot().rows[0]!), "real live full body");
});

test("an unknown historical prefix never becomes an atomic live delta join and a later exact full completion heals it", async () => {
  const { hub, owner } = rig(), id = codexRowId("root", "turn", "message");
  const port = createCodexHistoryPort({ scope, authorize: async () => {}, list: async () => codexPage([
    entry({ type: "agentMessage", id: "message", text: "unfenced historical prefix" }),
  ]) });
  const acquisition = new HistoryAcquisition(owner, port); await value(acquisition.baseline("E01", "unfenced prefix"));
  hub.emit(scope, [{ type: "append", id, kind: "assistant", text: "raw suffix" }]);
  const partial = owner.snapshot().rows[0]!; assert.equal(text(partial), "raw suffix");
  assert.ok(partial.body.kind === "partial" && partial.body.missing.includes("prefix"));
  assert.ok(owner.snapshot().coverage.gaps.some(gap => gap.rowId === id));
  hub.emit(scope, [{ type: "finish", id, kind: "assistant", lifecycle: "completed", text: "exact full native body" }]);
  assert.deepEqual(owner.snapshot().rows[0]!.body, { kind: "complete", text: "exact full native body", evidence: "nativeFullBody" });
  assert.equal(owner.snapshot().coverage.gaps.some(gap => gap.rowId === id), false); assert.equal(acquisition.counters.portCalls, 1);
});


test("retained initial read state survives observer expiry and replay; only explicit eligible retry renews the exact failed active episode", async () => {
  const { hub, owner } = rig(), first = deferred<AcquisitionBatch>(), retry = deferred<AcquisitionBatch>(); let calls = 0;
  const acquisition = new HistoryAcquisition(owner, makePort(async () => { calls++; return calls === 1 ? first.promise : retry.promise; }));
  const client = new HistoryWorkspace({ connection: scope.origin.connection, principal: scope.origin.principal }).session(scope).client;
  const stream = owner.watch(); client.apply((await stream.next()).value);
  const read = acquisition.baseline('E01', 'one initial attachment', 'initial');
  client.apply((await stream.next()).value); assert.deepEqual(client.current!.read, { state: 'pending', target: { kind: 'initial' } });
  assert.equal((await read.wait(0)).state, 'waitingExpired'); assert.equal(acquisition.reads.active, 1);
  assert.strictEqual(acquisition.baseline('E01', 'one initial attachment'), read); assert.equal(calls, 1);
  const remount = owner.watch(); const baseline = (await remount.next()).value; assert.equal(baseline.kind, 'snapshot'); if (baseline.kind === 'snapshot') assert.equal(baseline.snapshot.read.state, 'pending');
  first.reject(new Error('private native failure')); await read.settled; await tick();
  const failed = owner.snapshot().read; assert.equal(failed.state, 'settled'); if (failed.state !== 'settled') assert.fail('Expected settled failure');
  assert.equal(failed.outcome, 'failed'); assert.ok(failed.retryToken); const token = failed.retryToken;
  assert.strictEqual(acquisition.baseline('E01', 'one initial attachment'), read); assert.equal(calls, 1);
  const renewed = acquisition.baseline('E01', 'one initial attachment', 'recover', token);
  assert.strictEqual(acquisition.baseline('E01', 'one initial attachment', 'recover', token), renewed); assert.equal((await renewed.wait(0)).state, 'waitingExpired'); assert.equal(calls, 2);
  retry.resolve(batch([record('recovered-final')])); assert.equal((await value(renewed)).status, 'ready'); await tick();
  assert.equal(owner.snapshot().rows[0]!.id, 'recovered-final'); assert.deepEqual(owner.snapshot().read, { state: 'settled', target: { kind: 'initial' }, outcome: 'ready' });
  assert.strictEqual(acquisition.baseline('E01', 'one initial attachment', 'recover', token), renewed); assert.equal(calls, 2);
  await stream.return(); await remount.return(); assert.equal(owner.subscriberCount, 0);
});

test("explicit retry is bounded, never replays persisted cursors, and late read state cannot enter a replacement context", async () => {
  for (const mode of ['active', 'persisted'] as const) {
    const { owner } = rig(); let calls = 0;
    const acquisition = new HistoryAcquisition(owner, makePort(async () => { calls++; throw new Error('Native read unavailable'); }, scope, mode));
    const failed = acquisition.baseline('E01', 'same fact'); await failed.settled; await tick();
    const state = owner.snapshot().read; assert.equal(state.state, 'settled'); if (state.state !== 'settled') assert.fail('Expected settled');
    assert.equal(state.outcome, 'failed');
    if (mode === 'persisted') { assert.equal(state.retryToken, undefined); assert.throws(() => acquisition.baseline('E01', 'same fact', 'recover', 'invented'), /STALE_READ_RETRY/); assert.equal(calls, 1); }
    else {
      assert.ok(state.retryToken); const again = acquisition.baseline('E01', 'same fact', 'recover', state.retryToken); await again.settled; await tick();
      const exhausted = owner.snapshot().read; assert.equal(exhausted.state, 'settled'); if (exhausted.state === 'settled') assert.equal(exhausted.retryToken, undefined);
      assert.strictEqual(acquisition.baseline('E01', 'same fact', 'recover', state.retryToken), again); assert.equal(calls, 2);
    }
  }
  const { owner } = rig(), held = deferred<AcquisitionBatch>(); owner.setReadContext('old-reader');
  const acquisition = new HistoryAcquisition(owner, makePort(() => held.promise)); const read = acquisition.baseline('E01', 'old lifetime');
  await tick(); owner.setReadContext('new-reader'); assert.deepEqual(owner.snapshot().read, { state: 'idle' });
  held.resolve(batch([record('late-old-body')])); assert.equal((await value(read)).status, 'stale'); await tick();
  assert.deepEqual(owner.snapshot().read, { state: 'idle' }); assert.equal(owner.snapshot().rows.length, 0);
});


test('an explicit older-page retry preserves its exact cursor and rejects a token from another page before dispatch', async () => {
  const { hub, owner } = rig(); hub.emit(scope, [{ type: 'edge', edge: { state: 'available', cursor: 'first-page' } }]);
  const cursors: (string | null)[] = [];
  const acquisition = new HistoryAcquisition(owner, makePort(async request => { cursors.push(request.cursor); if (cursors.length === 1) throw Error('Read unavailable'); return batch([record('older-result')], scope, 'next-page'); }));
  const target = { scope, generation: owner.snapshot().generation, cursor: 'first-page' };
  const first = acquisition.older(target); await first.settled; await tick();
  const failed = owner.snapshot().read; assert.equal(failed.state, 'settled'); if (failed.state !== 'settled') assert.fail('Expected failed older page');
  assert.deepEqual(failed.target, { kind: 'older', cursor: 'first-page' }); assert.ok(failed.retryToken);
  assert.throws(() => acquisition.older({ ...target, cursor: 'another-page' }, failed.retryToken), /STALE_READ_RETRY/); assert.deepEqual(cursors, ['first-page']);
  const retry = acquisition.older(target, failed.retryToken); assert.strictEqual(acquisition.older(target, failed.retryToken), retry);
  const result = await value(retry); assert.equal(result.status, 'ready'); if (result.status === 'ready') assert.equal(result.page.rows[0]!.id, 'older-result');
  assert.deepEqual(cursors, ['first-page', 'first-page']); assert.equal(acquisition.reads.active, 0);
});
