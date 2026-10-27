import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogAuthority } from "../../v8-catalog/src/authority/index.js";
import { sessionCreationHost } from "../../v8-lifecycle-default/src/catalog.js";
import { CatalogWorkspace } from "../../v8-catalog/src/client/workspace.js";
import { sessionScope, type CreateRequest } from "../../v8-catalog/src/contracts/types.js";
import { GatewayCoordinator } from "../../v8-gateway/src/gateway/coordinator.js";
import { GatewayClient } from "../../v8-gateway/src/client/coordinator.js";
import { HttpGatewayTransport } from "../../v8-gateway/src/client/http.js";
import { listenLoopback } from "../../v8-gateway/src/http/server.js";
import type { GatewayTarget, Identity } from "../../v8-gateway/src/contracts/types.js";
import { InteractionWorkspace } from "../../v8-interactions/src/client.js";
import type { NativeAnswer, Prompt } from "../../v8-interactions/src/contracts.js";
import { HistoryWorkspace } from "../../v8-history/src/client/workspace.js";
import { openHost, type AgentHost } from "../../v8-lifecycle-default/src/node.js";
import { scriptedHost, deferred } from "../../v8-host/qualification/fixture.js";
import { SessionWorkspace } from "../../v8-session/src/client/workspace.js";
import type { Submit } from "../../v8-session/src/contracts/types.js";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Composed observation did not settle within its bound");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** Real controller ingress under actual AgentHost custody. These are scripted
 * native shapes, not live native ancestry or containment qualification. */
async function childPrompt(host: AgentHost, driver: ReturnType<typeof scriptedHost>, serial: number): Promise<Prompt> {
  const binding = (await host.binding())!, root = binding.run.nativeSession, child = `scripted-child-${serial}`;
  if (driver.kind === "codex") {
    driver.notify("item/started", { threadId: root, turnId: "child-turn", item: { type: "subAgentActivity", id: `spawn-${serial}`, kind: "started", agentThreadId: child, agentPath: child } });
    const settled = deferred<void>();
    driver.reverse({ token: {}, id: `vendor-${serial}`, method: "item/commandExecution/requestApproval", params: { threadId: child, turnId: "child-turn", itemId: `approval-${serial}`, command: "fixture", cwd: "/fixture", availableDecisions: ["accept", "decline"] }, settled: settled.promise,
      respond: async () => { driver.counts.replies++; settled.resolve(); return { kind: "ack", success: true }; } });
  } else {
    driver.event("subagent.started", { toolCallId: `spawn-${serial}`, agentName: "fixture", agentDescription: "finite scripted child" }, child);
    driver.event("permission.requested", { requestId: `vendor-${serial}`, permissionRequest: { kind: "mcp", serverName: "fixture", toolName: "explicit-confirm", managedApprovalRequired: true } }, child);
  }
  const prompt = (await host.interactions.snapshot(binding.run.scope)).items.find(item => item.prompt.owner.nativeAgent === child)?.prompt;
  assert.ok(prompt, "Only proved concrete controller ancestry may expose the child capability"); return prompt;
}

for (const kind of ["codex", "copilot"] as const) test(`${kind}: actual catalog, SQLite Host, authenticated gateway, retained clients and native child callback compose without replay`, { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), `v8-composed-${kind}-`));
  const scope = { connection: "fixture", principal: "alice", authority: "control" };
  // Each disposable controller owns dedicated containment. The old hand-made
  // "shared" label had no shared process/peer proof; real shared-boundary tests
  // remain with RuntimeSupervisor. Distinct host scopes also keep this fixture's
  // fixed native IDs from pretending to be one cross-session native identity.
  const target = (session: string) => ({ host: `host-${session}`, owner: `durable-${session}-owner`, kind, placement: "dedicated" as const });
  const original = (session: string): CreateRequest => ({ scope, id: `create-${session}`, session, target: target(session), metadata: { name: session, cwd: "/fixture" }, selection: { kind } });
  const gatewayTarget = (session: string, routeEpoch = "route-1"): GatewayTarget => ({ ...scope, host: target(session).host, owner: target(session).owner, session, routeEpoch });
  const identity: Identity = { connection: scope.connection, principal: scope.principal, authorities: [scope.authority], actions: ["read", "control", "catalogWrite"] };
  const coordinator = new GatewayCoordinator();
  const hosts = new Map<string, { host: AgentHost; driver: ReturnType<typeof scriptedHost> }>();
  const clients: { history: HistoryWorkspace; transport: HttpGatewayTransport; gateway: GatewayClient; sessions: SessionWorkspace; catalog: CatalogWorkspace }[] = [];
  const interactionClients: InteractionWorkspace[] = [];
  let authority: CatalogAuthority | undefined;
  let server: Awaited<ReturnType<typeof listenLoopback>> | undefined;
  try {
  authority = await CatalogAuthority.open({ directory: join(directory, "catalog"), scope, observationMs: 30000 });
  coordinator.registerCatalog({ scope, owner: "control-owner", port: authority });
  const register = (session: string, routeEpoch = "route-1") => {
    const { host } = hosts.get(session)!;
    coordinator.register({ target: gatewayTarget(session, routeEpoch), session: host.session, history: host.history, binding: () => host.binding(), interactions: host.interactions,
      authorizeHistory: s => { try { host.history.snapshot(s); return true; } catch { return false; } } });
  };
  for (const session of ["main", "peer"]) authority.register(sessionCreationHost({ target: target(session), resolve: async (request, mode) => {
    if (hosts.has(request.session)) return hosts.get(request.session)!.host.session;
    if (mode === "read") return null;
    const driver = scriptedHost(kind, { cwd: directory });
    const host = await openHost({ directory: join(directory, request.session), cwd: directory, scope: sessionScope(request), controller: driver.controller, observationMs: 30000,
      policy: kind === "codex" ? { kind, provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } } : { kind, provider: "copilot-only", permissions: "manual" } });
    hosts.set(request.session, { host, driver }); register(request.session); return host.session;
  } }));
  server = await listenLoopback(coordinator, async authorization => authorization === "Bearer fixture-alice" ? identity : authorization === "Bearer fixture-bob" ? { ...identity, principal: "bob" } : null);
  const drop = new Set(["catalog.create", "submit"]);
  const lossyFetch: typeof fetch = async (input, init) => {
    const op = JSON.parse(String(init?.body)).op as string;
    const response = await fetch(input, init);
    if (drop.delete(op)) { await response.arrayBuffer(); throw new Error("Scripted UI response loss after backend outcome"); }
    return response;
  };
  const make = (lossy = false) => {
    const history = new HistoryWorkspace({ connection: scope.connection, principal: scope.principal });
    const transport = new HttpGatewayTransport({ url: server!.url, authorization: "Bearer fixture-alice", ...(lossy ? { fetch: lossyFetch } : {}) });
    let sessions: SessionWorkspace | undefined, catalog: CatalogWorkspace | undefined;
    const gateway = new GatewayClient({ transport, history, targets: [gatewayTarget("main"), gatewayTarget("peer")], onFence: () => { catalog?.close(); sessions?.close(); }, onConnection: connected => { catalog?.setConnected(connected); sessions?.setConnected(connected); }, onReady: async value => { if (value.kind === "catalog") await catalog?.reobserve(); else if (value.kind === "session") await sessions?.reobserve(value.scope); } });
    sessions = new SessionWorkspace({ history, port: gateway }); catalog = new CatalogWorkspace({ scope, port: gateway.catalogPort(), sessions });
    const client = { history, transport, gateway, sessions, catalog }; clients.push(client); return client;
  };
    const a = make(true), b = make();
    a.catalog.setDraft("main", "draft survives native allocation"); a.catalog.setPinned("main", true);
    assert.equal(a.history.size, 0); assert.equal(a.catalog.entry("main").getSnapshot().bound, false);
    await assert.rejects(a.catalog.create(original("main")));
    const created = await a.catalog.check("main"); assert.equal(created!.state, "nativeCreated");
    const main = hosts.get("main")!, session = sessionScope(original("main")), mainHistory = (await main.host.binding())!.history;
    assert.equal(main.driver.counts.opens, 1); assert.equal(main.driver.containment.inputs[0]!.nativeSession, null);
    assert.equal("continuePendingWork" in main.driver.containment.inputs[0]!, false); assert.equal(main.driver.containment.inputs[0]!.policy.provider, "copilot-only");
    const managed = main.driver.containment.inputs[0]!.policy; if (managed.kind === "codex") assert.deepEqual(managed.access, { approval: "on-request", sandbox: "danger-full-access" });
    assert.equal(created!.native!.nativeSession, mainHistory.origin.nativeSession);
    await b.catalog.refresh();
    await a.catalog.bindNative("main", mainHistory); await b.catalog.bindNative("main", mainHistory);
    const retained = a.sessions.entry(session).history;
    assert.equal(retained.draft, "draft survives native allocation"); assert.equal(retained.pinned, true);
    const observeA = a.gateway.observeHistory(session, mainHistory), observeB = b.gateway.observeHistory(session, mainHistory);
    const lease = a.sessions.select(session); lease.release();
    assert.equal(a.sessions.entry(session).history, retained); assert.equal(retained.pinned, true);
    await until(() => a.history.session(mainHistory).client.current !== null && b.history.session(mainHistory).client.current !== null);
    const send: Submit = { scope: session, id: "original-send", generation: 1, command: { type: "send", text: "scripted request" } };
    await assert.rejects(a.gateway.submit(send)); assert.equal(main.driver.counts.sends, 1);
    await until(() => [a, b].every(client => client.history.session(mainHistory).client.current!.rows.some(row => row.kind === "tool")));
    a.gateway.disconnect();
    if (kind === "codex") main.driver.notify("item/completed", { threadId: mainHistory.origin.nativeSession, turnId: "background-turn", item: { id: "background", type: "agentMessage", text: "captured while UI disconnected" } });
    else main.driver.event("assistant.message", { messageId: "background", content: "captured while UI disconnected" });
    await until(() => b.history.session(mainHistory).client.current!.rows.some(row => row.body.kind !== "unavailable" && row.body.text === "captured while UI disconnected"));
    a.gateway.reconnect();
    await until(() => a.history.session(mainHistory).client.current!.rows.some(row => row.body.kind !== "unavailable" && row.body.text === "captured while UI disconnected"));
    assert.equal((await a.gateway.receipt(session, send.id))!.state, "acknowledged");
    assert.throws(() => a.gateway.submit(send)); assert.equal(main.driver.counts.sends, 1);
    assert.equal(retained.draft, "draft survives native allocation");
    for (const client of [a, b]) {
      const rows = client.history.session(mainHistory).client.current!.rows;
      assert.deepEqual(rows.find(row => row.kind === "assistant" && row.body.kind !== "unavailable" && row.body.text === "Scripted response: scripted request")!.body, { kind: "complete", text: "Scripted response: scripted request", evidence: "nativeFullBody" });
      assert.deepEqual(rows.find(row => row.kind === "tool")!.body, { kind: "complete", text: "scripted terminal output\n", evidence: "nativeFullBody" });
    }
    for (const client of [a, b]) {
      const interactions = new InteractionWorkspace({ port: client.gateway.interactionPort(session), session: client.gateway });
      interactionClients.push(interactions); await interactions.bind(session);
    }
    const prompt = await childPrompt(main.host, main.driver, 1);
    await Promise.all(interactionClients.map(client => client.refresh(session)));
    assert.equal(prompt.owner.relation, "child");
    const answer: NativeAnswer = prompt.type === "codex.command" ? { type: "codex.command", decisionId: "decision:0" } : { type: "copilot.permission", kind: "approve-once" };
    const responses = interactionClients.map((client, i) => client.answer(session, prompt, answer, `answer-viewer-${i}`).result);
    await Promise.all(responses); assert.equal(main.driver.counts.replies, 1);
    assert.equal((await main.host.interactions.snapshot(session)).items.length, 0);
    register("main", "route-2"); a.gateway.bindRoute(gatewayTarget("main", "route-2")); b.gateway.bindRoute(gatewayTarget("main", "route-2"));
    assert.equal((await a.gateway.receipt(session, send.id))!.state, "acknowledged"); assert.equal(main.driver.counts.sends, 1);
    const bob = new HttpGatewayTransport({ url: server.url, authorization: "Bearer fixture-bob" });
    await assert.rejects(bob.receipt(gatewayTarget("main", "route-2"), send.id), { code: "FORBIDDEN" }); bob.close();
    await a.catalog.create(original("peer")); const peer = hosts.get("peer")!, peerHistory = (await peer.host.binding())!.history;
    await a.catalog.bindNative("peer", peerHistory);
    const peerLease = a.sessions.select(sessionScope(original("peer"))); peerLease.release();
    const returnedLease = a.sessions.select(session); returnedLease.release();
    assert.equal(a.sessions.entry(session).history, retained);
    assert.equal(a.history.session(mainHistory).client.current!.rows.some(row => row.kind === "assistant" && row.body.kind !== "unavailable" && row.body.text === "Scripted response: scripted request"), true);
    await childPrompt(main.host, main.driver, 2);
    assert.equal((await a.gateway.submit({ scope: session, id: "stop", generation: 1, command: { type: "stop" } })).state, "acknowledged");
    assert.equal((await main.host.session.snapshot(session)).phase, "stopped"); assert.equal((await main.host.interactions.snapshot(session)).issue, "ownershipRetired");
    assert.equal((await peer.host.session.snapshot(sessionScope(original("peer")))).phase, "running"); assert.equal(peer.driver.counts.stops, 0);
    observeA.release(); observeB.release();
    const savedNative = mainHistory.origin.nativeSession;
    assert.equal((await a.gateway.submit({ scope: session, id: "resume", generation: 1, command: { type: "resume" } })).state, "acknowledged");
    assert.equal(main.driver.containment.inputs[1]!.nativeSession, savedNative); assert.equal("continuePendingWork" in main.driver.containment.inputs[1]!, false); assert.equal(main.driver.counts.resumes, 1);
    assert.equal((await main.host.session.snapshot(session)).generation, 2);
    await a.sessions.rebind(session, mainHistory);
    assert.equal(a.sessions.entry(session).history, retained); assert.equal(retained.pinned, true); assert.equal(retained.draft, "draft survives native allocation");
    assert.equal((await authority.get(scope, "main"))!.binding!.nativeSession, savedNative);
    assert.equal((await a.gateway.receipt(session, send.id))!.generation, 1);
    assert.equal(main.driver.counts.sends, 1); assert.equal(main.driver.counts.replies, 1);
  } finally {
    // Every owned cleanup runs, including setup and another cleanup's failure.
    const detached = await Promise.allSettled([
      ...interactionClients.map(client => Promise.resolve().then(() => client.close())),
      ...clients.map(client => Promise.resolve().then(() => client.gateway.close())),
    ]);
    const released = await Promise.allSettled([
      Promise.resolve().then(() => coordinator.close()),
      Promise.resolve().then(() => server?.close()),
      ...[...hosts.values()].map(({ host, driver }) => Promise.resolve().then(async () => { if (driver.controller.current()) driver.containment.halt(); await host.terminate(); driver.controller.dispose(); })),
      Promise.resolve().then(() => authority?.terminate()),
    ]);
    await rm(directory, { recursive: true, force: true });
    for (const result of [...detached, ...released]) if (result.status === "rejected") throw result.reason;
  }
});
