import test from "node:test";
import assert from "node:assert/strict";
import type { CodexScope, HistoryPage, Row } from "../src/contracts/types.js";
import { ReadCoordinator } from "../src/repair/read-coordinator.js";
import { PersistedSnapshotReader, readActivePage, type NativePage, type PagePort } from "../src/repair/cursors.js";
const scope: CodexScope = { kind: "codex", threadId: "root", origin: { connection: "fixture", principal: "alice", host: "host", nativeSession: "root", attachment: "owned" } };
const request = { scope, reason: "E06", kind: "nativeBody", factId: "missing original prefix" } as const;
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function row(id: string, body = "text"): Row { return { id, kind: "assistant", lifecycle: "completed", body: { kind: "complete", text: body, evidence: "nativeFullBody" }, native: {}, version: 1, contentVersion: 1 }; }
function page(rows: readonly Row[], cursor: string | null = "next"): NativePage {
  const page: HistoryPage = { scope, generation: "host-generation", rows,
    olderEdge: cursor === null ? { state: "end", evidence: "nativeBoundary" } : { state: "available", cursor } };
  return { page, status: "ok", hasMore: cursor !== null, nextCursor: cursor };
}

test("routine reconnect, receipt checks and unknown conditions cannot admit a native body read", () => {
  const coordinator = new ReadCoordinator(); let called = 0;
  for (const reason of ["E03", "E04", "E05", "E10", "E15", "E18", "E19", "E22", "E23", "E24", "E25", "E26", "E99", "toString"]) {
    assert.throws(() => coordinator.request({ ...request, reason: reason as never }, async () => ++called));
  }
  assert.equal(called, 0); assert.equal(coordinator.counters.nativeBodyReads, 0);
});

test("consumer expiry cannot free a hung native read slot or multiply the same original fact", async () => {
  const coordinator = new ReadCoordinator({ maxConcurrent: 1, maxFacts: 4, maxAttemptsPerFact: 2 }), held = deferred<string>();
  const handle = coordinator.request(request, () => held.promise);
  assert.deepEqual(await handle.wait(1), { state: "waitingExpired" }); assert.equal(coordinator.active, 1);
  const again = coordinator.request(request, async () => "wrong replacement"); assert.deepEqual(await again.wait(1), { state: "waitingExpired" });
  assert.throws(() => coordinator.request({ ...request, factId: "other" }, async () => "other"), /READ_BUSY/);
  assert.throws(() => coordinator.renew(request, "explicitUser", async () => "wrong"), /UNDERLYING_READ_STILL_OWNED/);
  assert.equal(coordinator.counters.nativeBodyReads, 1); held.resolve("original late result");
  assert.deepEqual(await handle.wait(20), { state: "value", value: "original late result" }); assert.equal(coordinator.active, 0);
});

test("settled paging receipt release requires its exact owner and never frees active native capacity", async () => {
  const coordinator = new ReadCoordinator({ maxConcurrent: 2, maxFacts: 2, maxAttemptsPerFact: 1 }), held = deferred<number>();
  const pending = coordinator.request(request, () => held.promise), otherRequest = { ...request, factId: "another fact" };
  const other = coordinator.request(otherRequest, async () => 2); await other.wait(1000);
  assert.throws(() => coordinator.releaseSettled(request, pending), /UNDERLYING_READ_STILL_OWNED/);
  assert.throws(() => coordinator.releaseSettled(request, other), /READ_HANDLE_MISMATCH/);
  assert.equal(coordinator.active, 1); assert.equal(coordinator.retainedFacts, 2);
  coordinator.releaseSettled(otherRequest, other); assert.equal(coordinator.retainedFacts, 1);
  held.resolve(1); assert.deepEqual(await pending.wait(1000), { state: "value", value: 1 });
  coordinator.releaseSettled(request, pending); assert.equal(coordinator.active, 0); assert.equal(coordinator.retainedFacts, 0);
  assert.deepEqual(await pending.wait(0), { state: "value", value: 1 });
  const replacement = coordinator.request(request, async () => 3); await replacement.wait(1000);
  assert.throws(() => coordinator.releaseSettled(request, pending), /READ_HANDLE_MISMATCH/);
});

test("exact live healing survives a late failed read and stops renewal; repeated suffix observations do not reset allowance", async () => {
  const coordinator = new ReadCoordinator({ maxConcurrent: 1, maxFacts: 4, maxAttemptsPerFact: 1 }), held = deferred<string>();
  const handle = coordinator.request(request, () => held.promise); coordinator.heal(scope, request.factId); held.reject(new Error("late private diagnostic"));
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(await handle.wait(10), { state: "healed" }); assert.equal(coordinator.active, 0);
  assert.throws(() => coordinator.renew(request, "newNativeBoundary", async () => "unneeded"), /REPAIR_ALLOWANCE_EXHAUSTED/);
  assert.deepEqual(coordinator.request(request, async () => "unneeded").outcome, { state: "healed" });
  assert.equal(coordinator.counters.nativeBodyReads, 1);
});

test("finite explicit renewal and scope retirement retain original owners and never leak old results", async () => {
  const coordinator = new ReadCoordinator({ maxConcurrent: 1, maxFacts: 2, maxAttemptsPerFact: 2 });
  const first = coordinator.request(request, async () => { throw new Error("failure"); }); assert.deepEqual(await first.wait(20), { state: "failed", code: "READ_FAILED" });
  const held = deferred<number>(), second = coordinator.renew(request, "explicitUser", () => held.promise);
  coordinator.retire(scope); assert.deepEqual(second.outcome, { state: "retired" }); assert.equal(coordinator.active, 1);
  held.resolve(12); await new Promise(resolve => setImmediate(resolve)); assert.equal(coordinator.active, 0);
  assert.deepEqual(await second.wait(20), { state: "retired" }); assert.equal(coordinator.counters.nativeBodyReads, 2);
});

test("active oversized pages shrink at the exact input cursor without skipping records; expired cursor is not a replacement window", async () => {
  const calls: { cursor: string | null; count: number }[] = [];
  const port: PagePort = async input => { calls.push(input); return page(input.count === 1 ? [row("a")] : [row("a", "x".repeat(2000)), row("b")]); };
  const result = await readActivePage(port, scope, "input", 4, 1000);
  assert.deepEqual(calls.map(x => [x.cursor, x.count]), [["input", 4], ["input", 2], ["input", 1]]); assert.equal(result.page.rows[0]!.id, "a");
  await assert.rejects(readActivePage(async () => ({ ...page([]), status: "expired" }), scope, "expired", 2, 1000), /CURSOR_EXPIRED/);
  await assert.rejects(readActivePage(async () => page([row("huge", "x".repeat(4000))]), scope, "same", 1, 1000), /PAGE_TOO_LARGE/);
});

test("cold persisted snapshots consume continuations once and retain the first pinned byte/generation boundary", async () => {
  const calls: (string | null)[] = [], boundary = { id: "snapshot", generation: "native-file-generation", byteBoundary: 800 };
  const reader = new PersistedSnapshotReader(async input => {
    calls.push(input.cursor);
    return { ...page([row(input.cursor === null ? "first" : "second")], input.cursor === null ? "one-use" : null), snapshot: boundary };
  }, scope);
  assert.equal((await reader.read()).page.rows[0]!.id, "first"); await assert.rejects(reader.read(), /SNAPSHOT_CURSOR_CONSUMED/);
  assert.equal((await reader.read("one-use")).page.rows[0]!.id, "second"); await assert.rejects(reader.read("one-use"), /SNAPSHOT_ENDED/);
  assert.deepEqual(calls, [null, "one-use"]);
  const changed = new PersistedSnapshotReader(async input => ({ ...page([row("r")]), snapshot: { ...boundary, byteBoundary: input.cursor ? 801 : 800 } }), scope);
  await changed.read(); await assert.rejects(changed.read("next"), /SNAPSHOT_BOUNDARY_CHANGED/);
});

test("failed/expired/oversized cold continuations cannot be replayed or mistaken for complete empty history", async () => {
  let calls = 0; const reader = new PersistedSnapshotReader(async () => { calls++; return { ...page([], null), status: "expired" }; }, scope);
  await assert.rejects(reader.read(), /CURSOR_EXPIRED/); await assert.rejects(reader.read(), /SNAPSHOT_ENDED/); assert.equal(calls, 1);
  const held = deferred<NativePage>(), pending = new PersistedSnapshotReader(() => held.promise, scope);
  const original = pending.read(); await assert.rejects(pending.read(), /SNAPSHOT_READ_PENDING/);
  held.resolve({ ...page([row("x")], null), snapshot: { id: "s", generation: "g", byteBoundary: 4 } }); await original;
});

test("admission scope and numeric bounds cannot move after caller or port mutation; retired scopes reject new facts", async () => {
  const limits = { maxConcurrent: 1, maxFacts: 4, maxAttemptsPerFact: 1 }, coordinator = new ReadCoordinator(limits);
  limits.maxConcurrent = 4;
  const held = deferred<number>(); const handle = coordinator.request(request, () => held.promise);
  assert.throws(() => coordinator.request({ ...request, factId: "parallel" }, async () => 2), /READ_BUSY/);
  coordinator.retire(scope); assert.throws(() => coordinator.request({ ...request, factId: "new-fact" }, async () => 3), /READ_SCOPE_RETIRED/);
  held.resolve(1); assert.deepEqual(await handle.wait(20), { state: "retired" });
  const callerScope = structuredClone(scope), active = deferred<NativePage>();
  const read = readActivePage(async input => {
    assert.throws(() => { (input.scope.origin as { principal: string }).principal = "foreign"; }); return active.promise;
  }, callerScope, null, 1, 3000);
  (callerScope.origin as { principal: string }).principal = "changed-after-admission";
  active.resolve(page([row("safe")])); assert.equal((await read).page.scope.origin.principal, "alice");
  assert.throws(() => new PersistedSnapshotReader(async () => page([]), scope, 0), /PAGE_LIMIT/);
  await assert.rejects(readActivePage(async () => ({ ...page([]), page: { ...page([]).page, olderEdge: { state: "end", evidence: "invented" as never } } }), scope, null, 1, 3000), /EDGE_EVIDENCE/);
});

test("native persisted snapshot identity requires bounded strings, never merely array length", async () => {
  const reader = new PersistedSnapshotReader(async () => ({ ...page([]), snapshot: { id: ["s"] as never, generation: ["g"] as never, byteBoundary: 1 } }), scope);
  await assert.rejects(reader.read(), /SNAPSHOT_IDENTITY/);
});
