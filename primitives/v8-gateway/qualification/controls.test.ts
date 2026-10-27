import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Catalog, ManagedPolicy } from "../../v8-session/src/contracts/types.js";
import { openHost } from "../../v8-lifecycle-default/src/node.js";
import { scriptedHost } from "../../v8-host/qualification/fixture.js";
import { HistoryHub } from "../../v8-history/src/host/history-owner.js";
import { HistoryWorkspace } from "../../v8-history/src/client/workspace.js";
import { GatewayCoordinator } from "../src/gateway/coordinator.js";
import { GatewayClient } from "../src/client/coordinator.js";
import { HttpGatewayTransport } from "../src/client/http.js";
import { listenLoopback } from "../src/http/server.js";
import { alice, target, scope, historyScope, FixtureSession, deferred, until, request } from "./fixture.js";

const configured: Catalog = { available: true, choices: [{ model: "configured-model", efforts: ["low", "high"] }] };
async function fixture(catalog?: () => Promise<Catalog>) {
  const session = new FixtureSession(), history = new HistoryHub(); history.open(historyScope, { knownStart: true });
  const coordinator = new GatewayCoordinator({ reads: 1, readQueue: 1 });
  const route = { target, session, history, authorizeHistory: () => true, ...(catalog ? { controlCatalog: catalog } : {}) };
  coordinator.register(route);
  const server = await listenLoopback(coordinator, async credential => credential === "Bearer full" ? alice : credential === "Bearer read" ? { ...alice, actions: ["read"] } : null);
  const transport = new HttpGatewayTransport({ url: server.url, authorization: "Bearer full" });
  return { session, coordinator, server, route, transport, async close() { transport.close(); coordinator.close(); await server.close(); } };
}

for (const kind of ["codex", "copilot"] as const) test(`${kind} actual Host configured controls are explicit authenticated reads before Create; mounts/reconnect do not discover`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "v8-controls-")), driver = scriptedHost(kind, { cwd: directory });
  const original = driver.controller.catalog.bind(driver.controller); let reads = 0;
  driver.controller.catalog = async () => { reads++; return original(); };
  const policy: ManagedPolicy = kind === "codex" ? { kind, provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } } : { kind, provider: "copilot-only", permissions: "manual" };
  const host = await openHost({ directory, cwd: directory, scope, controller: driver.controller, policy });
  const coordinator = new GatewayCoordinator(); coordinator.register({ target, session: host.session, history: host.history, controlCatalog: () => host.controlCatalog(), authorizeHistory: () => false });
  const server = await listenLoopback(coordinator, async credential => credential === "Bearer read" ? { ...alice, actions: ["read"] } : null);
  const transport = new HttpGatewayTransport({ url: server.url, authorization: "Bearer read" }), history = new HistoryWorkspace({ connection: scope.connection, principal: scope.principal });
  const client = new GatewayClient({ transport, history, targets: [target], onFence() {} }); let off = () => {};
  try {
    off = client.subscribe(scope, () => {}); await until(() => coordinator.observation.subscribers === 1);
    client.disconnect(); client.reconnect(); await until(() => coordinator.observation.subscribers === 1); assert.equal(reads, 0);
    const choices = await client.controlCatalog(scope); assert.equal(choices.available, true); assert.deepEqual(choices.choices[0]!.efforts, ["low"]); assert.equal(reads, 1);
    await assert.rejects(client.submit({ ...request("forbidden-create"), generation: 0, command: { type: "create" } }), { code: "FORBIDDEN" });
    assert.equal(driver.counts.opens, 0); assert.equal(driver.counts.resumes, 0); assert.equal(driver.counts.discovery, 0); assert.equal(driver.counts.bodyReads, 0);
  } finally { off(); client.close(); coordinator.close(); await server.close(); await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test("held configured-choice HTTP reads admit one bounded waiter without blocking independent Stop", async () => {
  const gate = deferred<Catalog>(); let calls = 0;
  const f = await fixture(() => { calls++; return gate.promise; });
  try {
    const held = f.transport.controlCatalog(target); await until(() => calls === 1);
    const queued = f.coordinator.controlCatalog(alice, target);
    await assert.rejects(f.coordinator.controlCatalog(alice, target), { code: "FULL" }); assert.equal(calls, 1);
    assert.equal((await f.transport.submit(target, { ...request("urgent-stop"), command: { type: "stop" } })).state, "acknowledged");
    assert.equal(f.session.submits.length, 1); assert.equal(f.coordinator.observation.optionalReads, 1);
    gate.resolve(configured); assert.deepEqual(await held, configured); assert.deepEqual(await queued, configured);
    assert.equal(calls, 2); assert.equal(f.coordinator.observation.optionalReads, 0);
  } finally { gate.resolve(configured); await f.close(); }
});

test("late configured-choice results are fenced by route, durable owner, Host epoch, client epoch and authentication retirement", async () => {
  for (const change of ["route", "owner", "hostEpoch", "clientEpoch", "auth"] as const) {
    const gate = deferred<Catalog>(); let calls = 0;
    const f = await fixture(() => { calls++; return gate.promise; }), history = new HistoryWorkspace({ connection: scope.connection, principal: scope.principal });
    const client = new GatewayClient({ transport: f.transport, history, targets: [target], onFence() {} });
    try {
      const pending = client.controlCatalog(scope), rejected = assert.rejects(pending); await until(() => calls === 1);
      if (change === "route") f.coordinator.register({ ...f.route, target: { ...target, routeEpoch: "next-route" } });
      if (change === "owner") { f.coordinator.unavailable(target); f.coordinator.register({ ...f.route, target: { ...target, owner: "replacement-owner", routeEpoch: "replacement-route" } }); }
      if (change === "hostEpoch") f.session.state = { ...f.session.state, epoch: 2 };
      if (change === "clientEpoch") client.bindRoute({ ...target, routeEpoch: "next-client-route" });
      if (change === "auth") f.server.revoke(alice);
      gate.resolve(configured); await rejected; await until(() => f.coordinator.observation.optionalReads === 0);
      assert.equal(calls, 1); assert.equal(f.session.submits.length, 0);
    } finally { gate.resolve(configured); client.close(); await f.close(); }
  }
});

test("absent or malformed configured catalogs are explicit unavailable/invalid, never a guessed model list", async () => {
  const absent = await fixture();
  try { await assert.rejects(absent.transport.controlCatalog(target), { code: "UNAVAILABLE" }); } finally { await absent.close(); }
  const malformed = await fixture(async () => ({ ...configured, choices: [...configured.choices, ...configured.choices] }));
  try { await assert.rejects(malformed.transport.controlCatalog(target), { code: "INVALID" }); assert.equal(malformed.session.submits.length, 0); } finally { await malformed.close(); }
});
