import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHost, type AgentHost, type HostOptions } from "../../v8-lifecycle-default/src/assembly.js";
import type { HostHistory } from "../src/contracts.js";
import { scriptedHost, deferred, until } from "./fixture.js";
import { createCodexHistoryPort } from "../../v8-history/src/native/codex/history.js";
import { codexRowId } from "../../v8-history/src/native/codex/index.js";
import { createCopilotHistoryPort } from "../../v8-history/src/native/copilot/history.js";
import type { AcquisitionBatch } from "../../v8-history/src/acquisition/types.js";
import type { Scope, Row } from "../../v8-history/src/contracts/types.js";
import { scopeKey as historyKey } from "../../v8-history/src/contracts/identity.js";
import { GatewayCoordinator } from "../../v8-gateway/src/gateway/coordinator.js";
import { GatewayClient } from "../../v8-gateway/src/client/coordinator.js";
import { HttpGatewayTransport } from "../../v8-gateway/src/client/http.js";
import { listenLoopback } from "../../v8-gateway/src/http/server.js";
import type { GatewayTarget, Identity } from "../../v8-gateway/src/contracts/types.js";
import { MultiplexWorkspace } from "../../v8-workspace/src/workspace.js";
import type { WorkspaceView } from "../../v8-workspace/src/contracts.js";
import { MemoryDraftPersistence } from "../../v8-files/src/client/persistence.js";
import type { CatalogEntry, CatalogPort } from "../../v8-catalog/src/contracts/types.js";
import type { Harness, ManagedPolicy, SessionScope } from "../../v8-session/src/contracts/types.js";

const scope: SessionScope = { connection: "cold-fixture", principal: "owner", host: "host", session: "logical" };
const catalogScope = { connection: scope.connection, principal: scope.principal, authority: "authority" };
// Context wrapping must survive the wire even at the Codex raw-cursor cap.
const olderCursor = "x".repeat(4096);
const policy = (kind: Harness): ManagedPolicy => kind === "codex" ? { kind, provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } } : { kind, provider: "copilot-only", permissions: "manual" };
const content = (row: Row) => row.body.kind === "unavailable" ? "" : row.body.text;
const rows = (view: WorkspaceView) => { const state = view.getSnapshot(); assert.notEqual(state.kind, "disposed"); if (state.kind === "disposed") throw Error("Disposed"); return state.history.rows; };

for (const kind of ["codex", "copilot"] as const) test(`${kind}: Host-owned cold acquisition is shared across authenticated HTTP and keeps older pages/anchors view-private`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "v8-host-history-")), driver = scriptedHost(kind, { cwd: directory });
  const gate = deferred<void>(); let reads = 0;
  const native: HostHistory = { port: (_run, attached) => attached.kind === "codex" ? createCodexHistoryPort({ scope: attached, authorize: async () => {}, list: async input => {
    reads++; driver.counts.bodyReads++; if (input.cursor === null) await gate.promise;
    const older = input.cursor !== null;
    return { data: [{ turnId: "saved-turn", item: { id: older ? "older" : "cold", type: "userMessage", content: [{ type: "text", text: older ? "older private" : "cold baseline" }] }, startedAtMs: null, completedAtMs: null }], nextCursor: older ? null : olderCursor, backwardsCursor: "saved-boundary" };
  } }) : createCopilotHistoryPort({ scope: attached, mode: "active", read: async input => {
    reads++; driver.counts.bodyReads++; const older = input.cursor !== undefined; if (!older) await gate.promise;
    return { events: [{ id: older ? "older-event" : "cold-event", type: "user.message", data: { messageId: older ? "older" : "cold", content: older ? "older private" : "cold baseline" } }], hasMore: !older, cursor: older ? "" : olderCursor, cursorStatus: "ok" };
  } }) };
  const options: HostOptions = { directory, cwd: directory, scope, policy: policy(kind), controller: driver.controller, history: native };
  let host = await openHost(options); const clients: MultiplexWorkspace[] = [], transports: HttpGatewayTransport[] = []; let server: Awaited<ReturnType<typeof listenLoopback>> | undefined;
  const coordinator = new GatewayCoordinator();
  const submit = async (type: "create" | "stop", id: string) => host.session.submit({ scope, id, generation: (await host.session.snapshot(scope)).generation, command: { type } });
  try {
    await submit("create", "create"); const fresh = (await host.binding())!;
    assert.deepEqual(await host.history.recover(fresh.history), { state: "healed" }); assert.equal(reads, 0);
    await host.terminate(); host = await openHost(options); const binding = (await host.binding())!;
    assert.notEqual(binding.history.origin.attachment, fresh.history.origin.attachment);
    await until(() => reads === 1);
    assert.deepEqual(host.history.snapshot(binding.history).read, { state: "pending", target: { kind: "initial" } });
    const target: GatewayTarget = { ...scope, authority: catalogScope.authority, owner: "durable-fixture", routeEpoch: "route-1" };
    coordinator.register({ target, session: host.session, history: host.history, interactions: host.interactions, mcp: host.mcp, binding: () => host.binding(), authorizeHistory: attached => historyKey(attached) === historyKey(binding.history) });
    const identity: Identity = { ...catalogScope, authorities: [catalogScope.authority], actions: ["read", "control"] };
    server = await listenLoopback(coordinator, async authorization => authorization === "Bearer disposable-fixture" ? identity : null);
    const entry: CatalogEntry = { scope: catalogScope, session: scope.session, target: { host: scope.host, owner: target.owner, kind, placement: "dedicated" }, createId: "create", version: 1, revision: 1, metadata: { name: "Fixture", cwd: directory }, binding: { kind, placement: "dedicated", generation: binding.run.generation, nativeSession: binding.run.nativeSession } };
    const catalog: CatalogPort = { list: async () => [entry], get: async () => entry, creation: async () => null, subscribe: () => () => {}, create: async () => { throw Error("No fixture creation"); }, rename: async () => { throw Error("No fixture rename"); }, setWatched: async () => { throw Error("No fixture watch"); }, metadataOriginal: async () => null };
    const connect = () => {
      const transport = new HttpGatewayTransport({ url: server!.url, authorization: "Bearer disposable-fixture" }); transports.push(transport);
      const workspace = new MultiplexWorkspace({ scope: catalogScope, persistence: new MemoryDraftPersistence(), connect: context => {
        const gateway = new GatewayClient({ ...context, transport, history: context.history, targets: [target] });
        return { session: gateway, catalog, access: () => ({ read: true, control: true, fileWrite: true, mcpRefresh: true, catalogWrite: true }), binding: () => transport.binding(target), filePort: () => transport.filePort(target), interactionPort: () => gateway.interactionPort(scope), mcpPort: () => gateway.mcpPort(scope),
          observeHistory: (current, attached) => gateway.observeHistory(current, attached), older: (current, attached, cursor, generation) => gateway.older(current, attached, cursor, generation), recover: (current, attached, observation) => gateway.recover(current, attached, observation),
          close: () => gateway.close(), disconnect: () => gateway.disconnect(), reconnect: () => gateway.reconnect() };
      } }); clients.push(workspace); return workspace;
    };
    const a = connect(), b = connect(), av = await a.open(scope.session), bv = await b.open(scope.session), side = a.view(scope.session, "side");
    const leaseA = av.observe(), leaseB = bv.observe(); a.setPinned(scope.session, true);
    await until(() => av.getSnapshot().kind !== "disposed" && coordinator.observation.subscribers >= 6);
    a.disconnect(); a.reconnect(); av.getSnapshot(); av.getServerSnapshot(); assert.equal(reads, 1, "viewers and reconnect do not add a native baseline");
    await assert.rejects(transports[0]!.recover(target, { ...binding.history, origin: { ...binding.history.origin, principal: "foreign" } }), { code: "FENCED" }); assert.equal(reads, 1);
    const coldId = kind === "codex" ? codexRowId(binding.run.nativeSession, "saved-turn", "cold") : JSON.stringify(["copilot", "user", "cold"]);
    host.history.emit(binding.history, [{ type: "gap", gap: { id: "cold-body-gap", kind: "missingFinal", rowId: coldId } }]);
    const first = av.recoverHistory(), second = bv.recoverHistory(); await until(() => reads === 1);
    // Continuous capture remains active while the actual native page is held.
    driver.onSend = (_text, native) => native.complete("live while reading");
    await transports[0]!.submit(target, { scope, id: "during-read", generation: binding.run.generation, command: { type: "send", text: "owned stream" } });
    await until(() => rows(av).some(row => content(row) === "live while reading")); gate.resolve();
    assert.deepEqual(await first, { state: "value", value: { status: "ready" } }); assert.deepEqual(await second, { state: "value", value: { status: "ready" } });
    await until(() => [av, bv].every(view => rows(view).some(row => content(row) === "cold baseline")));
    await av.recoverHistory(); assert.equal(reads, 1, "same stable cold fact never replenishes after merge");
    const anchor = rows(av).find(row => content(row) === "cold baseline")!; av.viewport.userScroll("earlier", false); av.viewport.report({ rowId: anchor.id, offsetPx: 17 });
    const one = av.loadOlder(), two = av.loadOlder(); assert.equal(one, two); assert.equal(await one, "applied"); assert.equal(reads, 2);
    assert.ok(rows(av).some(row => content(row) === "older private")); assert.ok(!rows(side).some(row => content(row) === "older private")); assert.ok(!rows(bv).some(row => content(row) === "older private"));
    const current = av.getSnapshot(); if (current.kind === "disposed") throw Error("Disposed"); assert.equal(current.history.viewport.anchor!.rowId, anchor.id); assert.equal(current.history.viewport.anchor!.offsetPx, 17);
    const before = reads; a.disconnect(); a.reconnect(); leaseA.release(); leaseB.release(); a.setPinned(scope.session, false); assert.equal(reads, before); assert.equal(driver.counts.opens, 1); assert.equal(driver.counts.resumes, 0);
    await submit("stop", "stop");
  } finally { gate.resolve(); for (const client of clients) client.close(); for (const transport of transports) transport.close(); coordinator.close(); await server?.close(); await host.terminate(); await rm(directory, { recursive: true, force: true }); }
});

test("a known-start recovery does not replenish its episode when its own merge clears only a subset of gaps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v8-host-gap-budget-")), driver = scriptedHost("codex", { cwd: directory }); let reads = 0;
  const host = await openHost({ directory, cwd: directory, scope, policy: policy("codex"), controller: driver.controller, history: { port: (_run, attached) => ({ scope: attached, mode: "active", read: async () => {
    reads++; return { scope: attached, status: "ok", records: [{ id: "healed", kind: "user", lifecycle: "completed", body: { kind: "complete", text: "owned full body", evidence: "nativeFullBody" }, native: {} }], hasMore: false, nextCursor: null, gaps: [] };
  } }) } });
  try {
    await host.session.submit({ scope, id: "create", generation: 0, command: { type: "create" } }); const attached = (await host.binding())!.history;
    host.history.emit(attached, [{ type: "gap", gap: { id: "gap-a", kind: "missingFinal", rowId: "healed" } }, { type: "gap", gap: { id: "gap-b", kind: "missingFinal", rowId: "still-missing" } }]);
    assert.deepEqual(await host.history.recover(attached), { state: "value", value: { status: "ready" } }); assert.equal(host.history.snapshot(attached).coverage.knownStart, true);
    assert.deepEqual(host.history.snapshot(attached).coverage.gaps.map(gap => gap.id), ["gap-b"]);
    await host.history.recover(attached); assert.equal(reads, 1);
    await host.session.submit({ scope, id: "stop", generation: 1, command: { type: "stop" } });
  } finally { await host.terminate(); await rm(directory, { recursive: true, force: true }); }
});

test("Host native-generation namespaces fence old pages, cancelled observers retain physical slots, and stale capture cursors cause zero native work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v8-host-history-fence-")), driver = scriptedHost("codex", { cwd: directory });
  const first = deferred<AcquisitionBatch>(), next = deferred<AcquisitionBatch>(), third = deferred<AcquisitionBatch>(); let reads = 0;
  const options: HostOptions = { directory, cwd: directory, scope, policy: policy("codex"), controller: driver.controller, history: { port: (_run, attached) => ({ scope: attached, mode: "active", read: async () => {
    reads++;
    if (reads === 1) return { scope: attached, status: "ok", records: [{ id: "child-baseline", kind: "user", lifecycle: "completed", body: { kind: "complete", text: "proved child prefix", evidence: "nativeFullBody" }, native: {} }], gaps: [], hasMore: true, nextCursor: "child-older" };
    return reads === 2 ? first.promise : reads === 3 ? next.promise : third.promise;
  } }) } };
  const host = await openHost(options);
  const submit = async (type: "create" | "stop" | "resume", id: string) => host.session.submit({ scope, id, generation: (await host.session.snapshot(scope)).generation, command: { type } });
  let attached!: Scope;
  const batch = (text: string): AcquisitionBatch => ({ scope: attached, status: "ok", records: [{ id: text, kind: "user", lifecycle: "completed", body: { kind: "complete", text, evidence: "nativeFullBody" }, native: {} }], hasMore: false, nextCursor: null, gaps: [] });
  try {
    await submit("create", "create"); attached = (await host.binding())!.history;
    const generation = host.history.snapshot(attached).generation;
    host.history.reset(attached, "explicit native edit");
    await assert.rejects(host.history.older(attached, "old-cursor", generation), { code: "FENCED" }); assert.equal(reads, 0);
    const currentGeneration = host.history.snapshot(attached).generation, abort = new AbortController();
    assert.equal(attached.kind, "codex");
    driver.notify("item/completed", { threadId: attached.origin.nativeSession, turnId: "activity-turn", item: { id: "old-child-activity", type: "subAgentActivity", kind: "started", agentThreadId: "old-child", agentPath: "old-child" } });
    const child: Scope = { kind: "codex", origin: attached.origin, threadId: "old-child" }; assert.equal(host.history.snapshot(child).scope.kind, "codex");
    assert.equal((await host.history.recover(child)).state, "value");
    const childEdge = host.history.snapshot(child).olderEdge; assert.equal(childEdge.state, "available");
    if (childEdge.state !== "available") throw Error("EXPECTED_CHILD_PAGE_CURSOR");
    const childGeneration = host.history.snapshot(child).generation;
    const observer = host.history.recover(attached, { signal: abort.signal }); await until(() => reads === 2); abort.abort(); await assert.rejects(observer, { name: "AbortError" });
    const repeated = await host.history.recover(attached, { timeoutMs: 0 }); assert.equal(repeated.state, "waitingExpired"); assert.equal(reads, 2);
    const rootSettlement = host.history.recover(attached);
    const oldContext = host.history.snapshot(attached).readContext!, oldCursor = `${oldContext.length}:${oldContext}:same-cursor`;
    // One acquisition frontier cannot admit an older page while its baseline
    // is pending. The proved child's page occupies the second physical slot.
    await assert.rejects(host.history.older(attached, oldCursor, currentGeneration), /READ_BUSY/); assert.equal(reads, 2);
    const oldPage = host.history.older(child, childEdge.cursor, childGeneration), oldRejected = assert.rejects(oldPage, { code: "FENCED" }); await until(() => reads === 3);
    await submit("stop", "stop"); await submit("resume", "resume");
    assert.equal((await host.binding())!.run.generation, 2); assert.equal(host.history.snapshot(attached).generation, currentGeneration);
    await assert.rejects(host.history.recover(child), { code: "FENCED" }); assert.equal(reads, 3, "old child context does not confer current-run native-read authority");
    await assert.rejects(host.history.older(attached, oldCursor, currentGeneration), { code: "FENCED" }); assert.equal(reads, 3, "old native context cannot authorize a new-run cursor read");
    const context = host.history.snapshot(attached).readContext!, freshCursor = `${context.length}:${context}:same-cursor`;
    await assert.rejects(host.history.older(attached, freshCursor, currentGeneration), /READ_BUSY/); assert.equal(reads, 3, "new native binding cannot free an old physical slot");
    first.resolve(batch("stale-old-run")); assert.deepEqual(await rootSettlement, { state: "retired" });
    const freshRead = host.history.older(attached, freshCursor, currentGeneration); await until(() => reads === 4);
    next.resolve({ ...batch("old-older-page"), scope: child }); await oldRejected; third.resolve(batch("new-run-page")); assert.equal((await freshRead).rows[0]!.id, "new-run-page");
    assert.ok(!host.history.snapshot(attached).rows.some(row => row.id === "stale-old-run"));
    await submit("stop", "final-stop");
  } finally { if (attached) { first.resolve(batch("cleanup-old")); next.resolve(batch("cleanup-next")); third.resolve(batch("cleanup-third")); } await host.terminate(); await rm(directory, { recursive: true, force: true }); }
});
