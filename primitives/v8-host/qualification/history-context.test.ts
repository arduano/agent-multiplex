import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHost } from "../../v8-lifecycle-default/src/assembly.js";
import { scriptedHost, deferred, until } from "./fixture.js";
import { HistoryClient } from "../../v8-history/src/client/history-client.js";
import type { AcquisitionBatch } from "../../v8-history/src/acquisition/types.js";
import type { Scope } from "../../v8-history/src/contracts/types.js";
import { CAPTURE_GAP_ID } from "../../v8-history/src/contracts/types.js";
import { PrimitiveError } from "../../v8-history/src/contracts/validation.js";
import type { ManagedPolicy, SessionScope } from "../../v8-session/src/contracts/types.js";
import type { CopilotSessionConfig } from "../../v8-harness-copilot/src/controller.js";

test("production Host preserves the complete 4412-byte native plan instead of truncating at four KiB", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v8-plan-body-")), scope: SessionScope = { connection: "plan-body", principal: "owner", host: "codex", session: "logical" };
  const driver = scriptedHost("codex", { cwd: directory });
  const host = await openHost({ directory, cwd: directory, scope, controller: driver.controller,
    policy: { kind: "codex", provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } } });
  try {
    await host.session.submit({ scope, id: "create", generation: 0, command: { type: "create" } });
    const binding = (await host.binding())!, plan = "é".repeat(16) + "p".repeat(4379) + "\n";
    assert.equal(new TextEncoder().encode(plan).byteLength, 4412); assert.equal(plan.length, 4396);
    driver.notify("turn/started", { threadId: binding.run.nativeSession, turn: { id: "plan-turn", status: "inProgress" } });
    driver.notify("item/completed", { threadId: binding.run.nativeSession, turnId: "plan-turn", item: { type: "plan", id: "native-plan", text: plan } });
    driver.notify("turn/completed", { threadId: binding.run.nativeSession, turn: { id: "plan-turn", status: "completed" } });
    await until(() => host.history.snapshot(binding.history).rows.length > 0);
    const snapshot = host.history.snapshot(binding.history);
    assert.deepEqual(snapshot.rows[0]!.body, { kind: "complete", text: plan, evidence: "nativeFullBody" });
    assert.deepEqual(snapshot.coverage.gaps, []); assert.equal(driver.counts.bodyReads, 0); assert.equal(driver.counts.sends, 0);
  } finally { await host.terminate(); await rm(directory, { recursive: true, force: true }); }
});

test("explicit native reopening establishes one shared hundred-entry initial baseline before any viewer and pages without replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v8-initial-history-")), scope: SessionScope = { connection: "initial-history", principal: "owner", host: "codex", session: "logical" };
  const driver = scriptedHost("codex", { cwd: directory }), gate = deferred<void>();
  const calls: { cursor: string | null; count: number }[] = [];
  const options = { directory, cwd: directory, scope, controller: driver.controller,
    policy: { kind: "codex", provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } },
    history: { port: (run, attached) => ({ scope: attached, mode: "active", context: `bound-${run.generation}`, read: async request => {
      calls.push({ cursor: request.cursor, count: request.count });
      if (request.cursor === null) await gate.promise;
      if (request.cursor === "failure-page") throw new PrimitiveError("CODEX_HISTORY_PAGE_BOUND");
      return { scope: attached, status: "ok", records: Array.from({ length: 100 }, (_, index) => ({ id: `${request.cursor === null ? "latest" : "older"}-${index}`,
        kind: "tool", lifecycle: "completed", body: { kind: "complete", text: `saved tool output ${index}\n${"x".repeat(1000)}`, evidence: "nativeFullBody" },
        native: { threadId: run.nativeSession, turnId: "saved-turn", nativeItemId: `saved-${index}`, channel: "body", type: "commandExecution", command: "scripted harmless command", exitCode: 0 } })),
        gaps: [], hasMore: true, nextCursor: request.cursor === null ? "older-page" : "failure-page" };
    } }) } } satisfies Parameters<typeof openHost>[0];
  let host = await openHost(options);
  const submit = async (type: "create" | "stop" | "resume", id: string) => host.session.submit({ scope, id, generation: (await host.session.snapshot(scope)).generation, command: { type } });
  let left: ReturnType<typeof host.history.watch> | undefined, right: ReturnType<typeof host.history.watch> | undefined, pump: Promise<void> | undefined;
  try {
    await submit("create", "create"); await until(async () => (await host.session.snapshot(scope)).phase === "running");
    assert.equal(calls.length, 0, "proved fresh capture does not fetch native history");
    await submit("stop", "stop-first"); await until(async () => (await host.session.snapshot(scope)).phase === "stopped");
    await until(() => host.updateReadiness().ready); await host.close(); host = await openHost(options);
    assert.equal(calls.length, 0, "a cold stopped Host still does not acquire a reader");
    await submit("resume", "resume");
    await until(() => calls.length === 1); assert.equal(calls[0]!.count, 100);
    const attached = (await host.binding())!.history;
    assert.deepEqual(host.history.snapshot(attached).read, { state: "pending", target: { kind: "initial" } });
    assert.equal(host.history.snapshot(attached).olderEdge.state, "unknown");
    assert.equal(host.updateReadiness().ready, false);
    left = host.history.watch(attached); right = host.history.watch(attached);
    const client = new HistoryClient(attached), view = client.view();
    pump = (async () => { for await (const frame of right!) client.apply(frame); })();
    await left.return(); left = undefined;
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(host.history.recover(attached, { signal: cancelled.signal }), { name: "AbortError" });
    assert.deepEqual(await host.history.recover(attached, { timeoutMs: 0 }), { state: "waitingExpired" });
    assert.equal(calls.length, 1, "cancelled/expired viewers do not replace the admitted baseline");
    gate.resolve(); await until(() => view.getSnapshot().rows.length === 100);
    assert.equal(host.history.snapshot(attached).rows.length, 100); assert.equal(host.history.limits.maxRows, 128);
    await right.return(); await pump;
    right = host.history.watch(attached); pump = (async () => { for await (const frame of right!) client.apply(frame); })();
    await until(() => !!client.current); await host.binding(); assert.equal(calls.length, 1, "reconnect and binding observation do not read");
    assert.deepEqual(await host.history.recover(attached), { state: "value", value: { status: "ready" } }); assert.equal(calls.length, 1);
    const first = view.beginOlderRead(), page = await host.history.older(attached, first.cursor, first.generation);
    assert.equal(page.rows.length, 100); assert.equal(view.applyPage(page, first), "applied");
    assert.ok(Buffer.byteLength(JSON.stringify(page)) > 65_536, "representative100-row tool page must exceed the old byte cap");
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 524_288);
    assert.equal(view.getSnapshot().rows.length, 200); assert.equal(host.history.snapshot(attached).rows.length, 100, "private older pages do not grow current residency");
    const second = view.beginOlderRead();
    await assert.rejects(host.history.older(attached, second.cursor, second.generation), { code: "IO" });
    await assert.rejects(host.history.older(attached, second.cursor, second.generation), { code: "IO" });
    assert.deepEqual(calls.map(call => call.cursor), [null, "older-page", "failure-page"]);
    assert.ok(calls.every(call => call.count === 100)); assert.equal(driver.counts.sends, 0); assert.equal(driver.counts.resumes, 1);
    await assert.rejects(host.history.older(attached, "foreign-context", second.generation), { code: "FENCED" });
    assert.equal(calls.length, 3);
  } finally { gate.resolve(); await left?.return(); await right?.return(); await pump; await host.terminate(); await rm(directory, { recursive: true, force: true }); }
});

test("initial baseline failure stays observed once and Stop fences a later attachment's pending baseline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v8-initial-history-failure-")), scope: SessionScope = { connection: "initial-failure", principal: "owner", host: "codex", session: "logical" };
  const driver = scriptedHost("codex", { cwd: directory }), late = deferred<void>(); let calls = 0;
  const options = { directory, cwd: directory, scope, controller: driver.controller,
    policy: { kind: "codex", provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } },
    history: { port: (run, attached) => ({ scope: attached, mode: "active", context: `initial-${run.generation}`, read: async () => {
      calls++; if (run.generation === 2) throw new PrimitiveError("CODEX_HISTORY_PAGE_BOUND");
      await late.promise;
      return { scope: attached, status: "ok", records: [{ id: "too-late", kind: "assistant", lifecycle: "completed", body: { kind: "complete", text: "late old attachment", evidence: "nativeFullBody" }, native: {} }], gaps: [], hasMore: false, nextCursor: null };
    } }) } } satisfies Parameters<typeof openHost>[0];
  let host = await openHost(options);
  const submit = (type: "create" | "resume" | "stop", id: string) => host.session.snapshot(scope).then(snapshot => host.session.submit({ scope, id, generation: snapshot.generation, command: { type } }));
  try {
    await submit("create", "create"); await submit("stop", "first-stop");
    await until(() => host.updateReadiness().ready); await host.close(); host = await openHost(options);
    await submit("resume", "resume-failing-initial");
    const attached = (await host.binding())!.history;
    await until(() => { const read = host.history.snapshot(attached).read; return read.state === "settled" && read.outcome === "failed"; });
    assert.equal(calls, 1);
    assert.deepEqual(await host.history.recover(attached), { state: "failed", code: "CODEX_HISTORY_PAGE_BOUND" });
    const watch = host.history.watch(attached); await watch.next(); await watch.return(); await host.binding(); assert.equal(calls, 1);
    await submit("stop", "second-stop"); await submit("resume", "resume-pending-initial"); await until(() => calls === 2);
    await submit("stop", "retire-pending-attachment"); await until(async () => (await host.session.snapshot(scope)).phase === "stopped");
    const current = (await host.binding())!.history, before = host.history.snapshot(current);
    assert.equal(host.updateReadiness().ready, false, "Stop does not pretend pending native read I/O has settled");
    late.resolve(); await until(() => host.updateReadiness().ready);
    const { read: _oldRead, revision: _oldRevision, ...prior } = before, { read, revision, ...after } = host.history.snapshot(current);
    assert.deepEqual(after, prior); assert.deepEqual(read, { state: 'idle' }); assert.ok(revision >= before.revision); assert.equal(before.rows.length, 0);
    assert.equal(calls, 2); assert.equal(driver.counts.resumes, 2); assert.equal(driver.counts.sends, 0);
  } finally { late.resolve(); await host.terminate(); await rm(directory, { recursive: true, force: true }); }
});

test("actual capture failure reports unknown transcript progress without rewriting independent native activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v8-capture-failure-")), scope: SessionScope = { connection: "capture-failure", principal: "owner", host: "codex", session: "logical" };
  const driver = scriptedHost("codex", { cwd: directory });
  const host = await openHost({ directory, cwd: directory, scope, policy: { kind: "codex", provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } }, controller: driver.controller });
  try {
    await host.session.submit({ scope, id: "create", generation: 0, command: { type: "create" } });
    await until(async () => (await host.session.snapshot(scope)).phase === "running");
    const attached = (await host.binding())!.history, threadId = attached.origin.nativeSession;
    driver.notify("turn/started", { threadId, turn: { id: "active-turn", status: "inProgress" } });
    assert.deepEqual(host.history.snapshot(attached).activity, { turnId: "active-turn", state: "working" });
    host.history.emit(attached, Array.from({ length: host.history.limits.maxRows }, (_, index) => ({ type: "start" as const, id: `running-${index}`, kind: "tool" as const })));
    driver.notify("item/started", { threadId, turnId: "active-turn", item: { id: "over-capacity", type: "agentMessage", text: "" } });
    const failed = host.history.snapshot(attached);
    assert.ok(failed.coverage.gaps.some(gap => gap.id === CAPTURE_GAP_ID && gap.kind === "nativeGap"));
    assert.deepEqual(failed.activity, { turnId: "active-turn", state: "unknown" });
    assert.equal(failed.rows.length, host.history.limits.maxRows);
    driver.notify("turn/completed", { threadId, turn: { id: "active-turn", status: "completed" } });
    await until(async () => (await host.session.snapshot(scope)).activity === "idle");
    assert.deepEqual(host.history.snapshot(attached).activity, { turnId: "active-turn", state: "unknown" });
    assert.equal(driver.counts.sends, 0); assert.equal(driver.counts.resumes, 0);
  } finally { await host.terminate(); await rm(directory, { recursive: true, force: true }); }
});

for (const kind of ["codex", "copilot"] as const) test(`${kind}: actual Host read leases retire native cursors and delayed pages without dropping private rows or anchors`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "v8-read-context-")), scope: SessionScope = { connection: "fixture", principal: "owner", host: kind, session: "logical" };
  const driver = scriptedHost(kind, { cwd: directory }), heldA = deferred<AcquisitionBatch>(), heldB = deferred<void>();
  let lease = "private-active-attachment", mode: "active" | "persisted" = "active", reads = 0, metadataReads = 0, attached!: Scope;
  const nativeA = `native-a${"x".repeat(8184)}`;
  const batch = (id: string, next = "next-native-cursor"): AcquisitionBatch => ({ scope: attached, status: "ok", records: [{ id, kind: "user", lifecycle: "completed", body: { kind: "complete", text: id, evidence: "nativeFullBody" }, native: {} }], hasMore: true, nextCursor: next, gaps: [] });
  const policy: ManagedPolicy = kind === "codex" ? { kind, provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } } : { kind, provider: "copilot-only", permissions: "manual" };
  const host = await openHost({ directory, cwd: directory, scope, policy, controller: driver.controller, history: { port: (_run, history) => {
    const context = lease, selectedMode = mode;
    return { scope: history, mode: selectedMode, context, read: async request => {
      reads++;
      if (selectedMode === "persisted") { assert.equal(request.cursor, null, "a new persisted lease starts from its own baseline"); assert.equal(request.count, 1); return batch(`baseline-${context}`, `cursor-${context}`); }
      if (request.cursor === null) return batch("baseline", nativeA);
      if (request.cursor === nativeA) return batch("private-older", "native-b");
      if (request.cursor === "native-b") return batch("delayed-before-stop", "native-c");
      assert.equal(request.cursor, "native-c", "a second cursor cannot dispatch through the same pending frontier"); return heldA.promise;
    } };
  }, authorize: async () => { metadataReads++; await heldB.promise; } } });
  const submit = async (type: "create" | "stop", id: string) => host.session.submit({ scope, id, generation: (await host.session.snapshot(scope)).generation, command: { type } });
  let stream: ReturnType<typeof host.history.watch> | undefined, pump: Promise<void> | undefined;
  try {
    await submit("create", "create"); attached = (await host.binding())!.history;
    host.history.emit(attached, [{ type: "gap", gap: { id: "real-capture-gap", kind: "nativeGap" } }]);
    const client = new HistoryClient(attached), view = client.view(), other = client.view("other"); stream = host.history.watch(attached); pump = (async () => { for await (const frame of stream!) client.apply(frame); })();
    await until(() => !!client.current); const generation = client.current!.generation;
    assert.deepEqual(await host.history.recover(attached), { state: "value", value: { status: "ready" } }); await until(() => view.getSnapshot().olderEdge.state === "available");
    const first = view.beginOlderRead(); assert.ok(first.cursor.length > 8192 && first.cursor.length <= 16384);
    const privatePage = await host.history.older(attached, first.cursor, first.generation); assert.equal(view.applyPage(privatePage, first), "applied"); view.finishOlderRead(first);
    view.viewport.userScroll("earlier", false); view.viewport.report({ rowId: "private-older", offsetPx: 19 });
    const delayedToken = view.beginOlderRead(), delayedPage = await host.history.older(attached, delayedToken.cursor, delayedToken.generation);
    const oldContext = client.current!.readContext!, oldCursor = delayedPage.olderEdge.state === "available" ? delayedPage.olderEdge.cursor : "unavailable";
    assert.match(oldContext, /^[a-f0-9]{64}$/); assert.equal(JSON.stringify(client.current).includes(lease), false);
    const pendingA = host.history.older(attached, oldCursor, generation), rejectA = assert.rejects(pendingA, { code: "FENCED" });
    await until(() => reads === 4);
    await assert.rejects(host.history.older(attached, `${oldContext.length}:${oldContext}:native-d`, generation), { code: "READ_BUSY" });
    assert.equal(reads, 4, "the existing single-frontier guard admits no second native body read");
    // Occupy the coordinator's other real slot through its supported metadata
    // path, rather than assuming one acquisition can page two cursors at once.
    const child: Scope = attached.kind === "codex" ? { ...attached, threadId: "held-proof-child" } : { kind: "copilot", origin: attached.origin, agentId: "held-proof-child" };
    const pendingB = host.history.authorize(child); await until(() => metadataReads === 1);
    await submit("stop", "stop"); await until(() => client.current!.readContext !== oldContext);
    const stopped = view.getSnapshot(); assert.equal(stopped.olderEdge.state, "unknown"); assert.equal(stopped.viewport.loadingOlder, false); assert.equal(view.applyPage(delayedPage, delayedToken), "stale");
    assert.equal(client.current!.generation, generation); assert.equal(stopped.viewport.anchor!.rowId, "private-older"); assert.equal(stopped.viewport.anchor!.offsetPx, 19); assert.ok(stopped.rows.some(row => row.id === "private-older")); assert.ok(!other.getSnapshot().rows.some(row => row.id === "private-older"));
    lease = "private-persisted-lease-one"; mode = "persisted";
    await assert.rejects(host.history.recover(attached), /READ_BUSY/); assert.equal(reads, 4, "a new reader cannot release old actual physical reads"); assert.equal(metadataReads, 1);
    await assert.rejects(host.history.older(attached, oldCursor, generation), { code: "FENCED" }); assert.equal(reads, 4);
    heldA.resolve(batch("retired-a")); heldB.resolve(); await rejectA;
    assert.deepEqual(await pendingB, { state: "failed", code: "READ_FAILED" }, "Stop fences the old child authorization before it can publish a scope");
    assert.ok(!client.current!.scopeInventory?.entries.some(entry => entry.scope.kind === "codex" ? entry.scope.threadId === "held-proof-child" : entry.scope.agentId === "held-proof-child"));
    assert.deepEqual(await host.history.recover(attached), { state: "value", value: { status: "ready" } }); await until(() => view.getSnapshot().olderEdge.state === "available"); assert.equal(reads, 5);
    const readerOne = client.current!.readContext!, priorCursor = view.getSnapshot().olderEdge; assert.equal(priorCursor.state, "available");
    lease = "private-persisted-lease-two";
    await assert.rejects(host.history.older(attached, priorCursor.state === "available" ? priorCursor.cursor : "", generation), { code: "FENCED" }); assert.equal(reads, 5);
    assert.deepEqual(await host.history.recover(attached), { state: "value", value: { status: "ready" } }); await until(() => client.current!.readContext !== readerOne); assert.equal(reads, 6);
    assert.equal((await host.session.snapshot(scope)).phase, "stopped"); assert.equal(client.current!.generation, generation); assert.ok(view.getSnapshot().rows.some(row => row.id === "private-older")); assert.equal(view.getSnapshot().viewport.anchor!.rowId, "private-older"); assert.ok(!view.getSnapshot().rows.some(row => row.id === "retired-a" || row.id === "retired-b" || row.id === "delayed-before-stop"));
  } finally { if (attached) heldA.resolve(batch("cleanup-a")); heldB.resolve(); await stream?.return(); await pump; await host.terminate(); await rm(directory, { recursive: true, force: true }); }
});

for (const kind of ["codex", "copilot"] as const) test(`${kind}: successful native compaction fences paging and held reads while preserving retained rows and scroll intent without automatic fetch`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "v8-compaction-boundary-")), scope: SessionScope = { connection: "compaction", principal: "owner", host: kind, session: "logical" };
  const driver = scriptedHost(kind, { cwd: directory }), held = deferred<AcquisitionBatch>();
  let reads = 0, attached!: Scope;
  const batch = (): AcquisitionBatch => ({ scope: attached, status: "ok", records: [{ id: "prior-message", kind: "user", lifecycle: "completed", body: { kind: "complete", text: "retained prior message", evidence: "nativeFullBody" }, native: {} }], hasMore: true, nextCursor: reads > 2 ? "new-native-cursor" : "old-native-cursor", gaps: [] });
  const policy: ManagedPolicy = kind === "codex" ? { kind, provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } } : { kind, provider: "copilot-only", permissions: "manual" };
  const host = await openHost({ directory, cwd: directory, scope, policy, controller: driver.controller, history: { port: (_run, history) => ({ scope: history, mode: "active", context: "same-native-attachment", read: async request => { reads++; return request.cursor === null ? batch() : held.promise; } }) } });
  let stream: ReturnType<typeof host.history.watch> | undefined, pump: Promise<void> | undefined;
  try {
    await host.session.submit({ scope, id: "create", generation: 0, command: { type: "create" } });
    await until(async () => (await host.session.snapshot(scope)).phase === "running"); attached = (await host.binding())!.history;
    host.history.emit(attached, [{ type: "gap", gap: { id: "captured-gap", kind: "nativeGap" } }]);
    const client = new HistoryClient(attached), view = client.view(); stream = host.history.watch(attached); pump = (async () => { for await (const frame of stream!) client.apply(frame); })();
    await until(() => !!client.current); assert.deepEqual(await host.history.recover(attached), { state: "value", value: { status: "ready" } });
    await until(() => view.getSnapshot().olderEdge.state === "available");
    view.viewport.userScroll("earlier", false); view.viewport.report({ rowId: "prior-message", offsetPx: 17 });
    const generation = client.current!.generation, before = client.current!.rows.find(row => row.id === "prior-message")!, context = client.current!.readContext!, token = view.beginOlderRead();
    const pending = host.history.older(attached, token.cursor, token.generation), rejected = assert.rejects(pending, { code: "FENCED" }); await until(() => reads === 2);
    let complete: () => void, duplicate: () => void;
    if (kind === "codex") {
      const params = { threadId: attached.origin.nativeSession, turnId: "native-compact-turn", item: { id: "native-compact-item", type: "contextCompaction" } };
      driver.notify("item/started", params);
      complete = () => driver.notify("item/completed", params);
      duplicate = () => { driver.notify("item/completed", params); driver.notify("thread/compacted", { threadId: attached.origin.nativeSession, turnId: params.turnId }); };
    } else {
      const config = driver.requests.find(request => request.method === "session.create")!.params as CopilotSessionConfig;
      config.onEvent({ id: "compact-start", type: "session.compaction_start", data: {} });
      config.onEvent({ id: "compact-failed", type: "session.compaction_complete", data: { success: false } });
      const event = { id: "compact-success", type: "session.compaction_complete", data: { success: true } };
      complete = () => config.onEvent(event); duplicate = complete;
    }
    assert.equal(host.history.snapshot(attached).readContext, context, "start/failure cannot prove a native page edit");
    complete(); await until(() => client.current!.readContext !== context);
    const changed = host.history.snapshot(attached); assert.equal(changed.generation, generation); assert.equal(changed.olderEdge.state, "unknown");
    assert.deepEqual(changed.rows.find(row => row.id === before.id), before); assert.equal(view.getSnapshot().viewport.anchor!.rowId, before.id); assert.equal(view.getSnapshot().viewport.anchor!.offsetPx, 17); assert.equal(view.getSnapshot().viewport.loadingOlder, false);
    const revision = changed.revision, changedContext = changed.readContext; duplicate();
    assert.equal(host.history.snapshot(attached).readContext, changedContext); assert.equal(host.history.snapshot(attached).revision, revision, "the exact positive fact rotates only once");
    // Settle the already-owned I/O before a new request can replace its reader.
    held.resolve(batch()); await rejected; assert.equal(reads, 2);
    await assert.rejects(host.history.older(attached, token.cursor, token.generation), { code: "FENCED" }); assert.equal(reads, 2, "compaction and a rejected old cursor never fetch history");
    assert.deepEqual(await host.history.recover(attached), { state: "value", value: { status: "ready" } }); await until(() => view.getSnapshot().olderEdge.state === "available");
    assert.equal(reads, 3); const next = view.getSnapshot().olderEdge; assert.ok(next.state === "available" && next.cursor !== token.cursor);
    assert.equal(client.current!.generation, generation); assert.deepEqual(client.current!.rows.find(row => row.id === before.id), before); assert.equal(view.getSnapshot().viewport.anchor!.rowId, before.id);
    if (kind === "codex") {
      const priorContext = client.current!.readContext;
      driver.notify("item/completed", { threadId: attached.origin.nativeSession, turnId: "native-compact-turn", item: { id: "second-compact-item", type: "contextCompaction" } });
      await until(() => client.current!.readContext !== priorContext);
      assert.equal(reads, 3, "another exact compaction item in the same turn is a new edit, without automatic fetching");
      const secondRevision = host.history.snapshot(attached).revision; duplicate();
      assert.equal(host.history.snapshot(attached).revision, secondRevision, "old exact item and the latest deprecated alias cannot rotate again");
    }
    assert.equal(driver.counts.sends, 0); assert.equal(driver.counts.resumes, 0);
  } finally { if (attached) held.resolve(batch()); await stream?.return(); await pump; await host.terminate(); await rm(directory, { recursive: true, force: true }); }
});
