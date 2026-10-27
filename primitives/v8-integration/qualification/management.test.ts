import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogWorkspace } from "../../v8-catalog/src/client/workspace.js";
import type { CatalogEntry, CatalogPort, CatalogScope } from "../../v8-catalog/src/contracts/types.js";
import { HistoryWorkspace } from "../../v8-history/src/client/workspace.js";
import type { Scope as HistoryScope } from "../../v8-history/src/contracts/types.js";
import { McpOwner, McpReadPool, McpWorkspace, type NativeMcpReadPort } from "../../v8-mcp/src/index.js";
import { queryCatalog, SessionPins } from "../../v8-organization/src/index.js";
import { RuntimeSupervisor, type RuntimeHalt } from "../../v8-runtime/src/index.js";
import { deferred, ScriptedRuntimeOwnership, until } from "../../v8-runtime/qualification/fixture.js";
import { SessionWorkspace } from "../../v8-session/src/client/workspace.js";
import type { RunRef, SessionScope } from "../../v8-session/src/contracts/types.js";
import { SessionHost } from "../../v8-lifecycle-default/src/session/index.js";

for (const kind of ["codex", "copilot"] as const) test(`${kind}: pins and MCP observation retain their owners until exact supervised halt`, { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), `v8-management-${kind}-`));
  const scope: SessionScope = { connection: "management", principal: "owner", host: "host", session: "root" };
  const catalogScope: CatalogScope = { connection: scope.connection, principal: scope.principal, authority: "authority" };
  const ownership = new ScriptedRuntimeOwnership(kind);
  const supervisor = new RuntimeSupervisor({ scope, ownership });
  let host: SessionHost | undefined, catalog: CatalogWorkspace | undefined, sessions: SessionWorkspace | undefined;
  let mcp: McpOwner | undefined, client: McpWorkspace | undefined;
  let unsubscribe = () => {};
  const nativeRead = deferred<unknown>(), stop = deferred<RuntimeHalt>();
  let reads = 0;
  try {
    host = await SessionHost.open({ directory, scope, port: supervisor, observationMs: 5000,
      policy: kind === "codex" ? { kind, provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } } : { kind, provider: "copilot-only", permissions: "manual" } });
    assert.equal((await host.submit({ scope, id: "create", generation: 0, command: { type: "create" } })).state, "acknowledged");
    const initial = await host.snapshot(scope), identity = ownership.attachment!.identity;
    const run: RunRef = identity.run;
    const entry: CatalogEntry = { scope: catalogScope, session: scope.session,
      target: { host: scope.host, owner: "durable-request-owner", kind, placement: "shared" },
      createId: "create", version: 1, revision: 1, metadata: { name: "Owned conversation", cwd: "/fixture" },
      binding: { kind, placement: "shared", nativeSession: run.nativeSession, generation: run.generation } };
    const catalogPort: CatalogPort = {
      async list() { return [entry]; }, async get() { return entry; }, async creation() { return null; }, subscribe() { return () => {}; },
      async create() { throw new Error("Organization has no creation capability"); }, async rename() { throw new Error("Organization has no rename capability"); },
      async setWatched() { throw new Error("Organization has no watch mutation capability"); }, async metadataOriginal() { return null; },
    };
    const history = new HistoryWorkspace({ connection: scope.connection, principal: scope.principal });
    sessions = new SessionWorkspace({ history, port: host });
    catalog = new CatalogWorkspace({ scope: catalogScope, port: catalogPort, sessions });
    await catalog.refresh();
    const origin = { connection: scope.connection, principal: scope.principal, host: scope.host, nativeSession: run.nativeSession, attachment: identity.attachment };
    const historyScope: HistoryScope = kind === "codex" ? { kind, origin, threadId: run.nativeSession } : { kind, origin, agentId: null };
    const retained = await catalog.bindNative(scope.session, historyScope);
    catalog.setDraft(scope.session, "keep this draft through native halt");
    const pins = new SessionPins({ catalog, scope: catalogScope });
    pins.setPinned(scope.session, true);
    const view = sessions.select(scope); view.release();
    assert.equal(retained.history.observationReferences, 1);
    assert.equal(queryCatalog(catalog.catalog(), catalogScope, { pinnedOnly: true }, [scope.session]).rows[0]!.entry.session, scope.session);

    const native: NativeMcpReadPort = kind === "codex"
      ? { kind, async status(input) { assert.equal(input.threadId, run.nativeSession); assert.equal(input.detail, "toolsAndAuthOnly"); reads++; return nativeRead.promise; } }
      : { kind, async configured() { reads++; return nativeRead.promise; } };
    const pool = new McpReadPool({ maxActive: 1 });
    mcp = new McpOwner({ run, epoch: initial.epoch, native, reads: pool });
    client = new McpWorkspace({ connection: scope.connection, principal: scope.principal, port: mcp });
    await client.bind(run, kind);
    assert.equal(reads, 0, "binding reads retained evidence without native discovery");
    const pending = client.refresh(run);
    const fenced = assert.rejects(pending, { code: "FENCED" });
    await until(() => reads === 1);
    client.setConnected(run, false); catalog.setConnected(false);
    assert.equal(pool.active, 1); assert.equal(retained.history.observationReferences, 1);
    ownership.observe({ controller: "lost", transport: "lost", leader: "exited" });
    assert.equal((await host.snapshot(scope)).phase, "running", "controller/leader observation is not whole-tree halt");

    // This composition wiring is the native-run owner's responsibility. A UI
    // detach does not retire MCP; exact Host halt does, while pins stay retained.
    unsubscribe = host.subscribe(scope, snapshot => { if (snapshot.phase === "stopped") mcp!.retire(); });
    ownership.stopGate = stop.promise;
    const stopping = host.submit({ scope, id: "stop", generation: run.generation, command: { type: "stop" } });
    await until(() => ownership.stopCalls === 1);
    assert.equal((await host.snapshot(scope)).phase, "stopping");
    assert.notEqual((await mcp.snapshot(run)).freshness, "retired");
    assert.equal(retained.history.backgroundReferenceHeld, true);
    stop.resolve(ownership.proof());
    assert.equal((await stopping).state, "acknowledged"); await fenced;
    assert.equal((await host.snapshot(scope)).phase, "stopped");
    assert.equal((await mcp.snapshot(run)).freshness, "retired");
    assert.equal(pool.active, 1, "retired native read retains capacity until actual settlement");
    nativeRead.resolve(kind === "codex" ? { data: [], nextCursor: null } : { servers: [] });
    await until(() => pool.active === 0);
    assert.equal((await mcp.snapshot(run)).freshness, "retired", "late discovery cannot heal a halted run");
    assert.equal(retained.history.backgroundReferenceHeld, true);
    assert.equal(retained.history.draft, "keep this draft through native halt");
    assert.equal(ownership.opens.length, 1); assert.equal(ownership.stopCalls, 1); assert.equal(ownership.calls.length, 0);
    assert.equal("continuePendingWork" in ownership.opens[0]!, false); assert.equal(ownership.opens[0]!.policy.provider, "copilot-only");
  } finally {
    nativeRead.resolve(kind === "codex" ? { data: [], nextCursor: null } : { servers: [] });
    if (ownership.attachment) stop.resolve(ownership.proof());
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(unsubscribe), Promise.resolve().then(() => client?.close()),
      Promise.resolve().then(() => mcp?.retire()), Promise.resolve().then(() => catalog?.close()),
      Promise.resolve().then(() => sessions?.close()), Promise.resolve().then(() => host?.terminate()),
    ]);
    await rm(directory, { recursive: true, force: true });
    for (const result of cleanup) if (result.status === "rejected") throw result.reason;
  }
});
