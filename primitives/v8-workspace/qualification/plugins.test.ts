import assert from "node:assert/strict";
import test from "node:test";
import { createTRPCClient, type TRPCClient } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import type { AnyRouter } from "@trpc/server";
import { PluginWorkspace, type HostProjection, type PluginHostKey, type PluginHostSet, type PluginObservation, type PluginSource, type SessionProjection } from "../src/plugin-client.js";
import type { HostManifest } from "../../v8-plugins/src/contracts.js";
import { workspaceFixture, catalogScope } from "./fixture.js";
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { defineHost, activateHost, hostRouter, hostProcedure, type PublicHostContract } from '../../v8-plugins/src/index.js';
import { createGatewayHostClient } from '../../v8-gateway/src/client/rpc.js';
import { HttpGatewayTransport } from '../../v8-gateway/src/client/http.js';
import { createHmacHostProof, authenticateHostProof } from '../../v8-gateway/src/node/host-proof.js';
import { createInProcessHostRpcPort } from '../../v8-gateway/src/node/in-process-host.js';
import { GatewayCoordinator } from '../../v8-gateway/src/gateway/coordinator.js';
import { listenLoopback } from '../../v8-gateway/src/http/server.js';

type Contracts = {
  local: { router: AnyRouter; harness: "codex"; createInput: unknown; hostData: { capacity: number }; sessionData: { directory: string }; extensions: { workspace: { hostData: { root: string }; sessionData: { branch: string } } } };
  work: { router: AnyRouter; harness: "copilot"; createInput: unknown; hostData: { organization: string }; sessionData: { mode: string }; extensions: {} };
};
const manifest: HostManifest = { contractId: "fixture.local", contractVersion: 1, compositionId: "public-local-v1", harness: { id: "codex", version: 1, recordVersion: 1 }, lifecycle: { id: "default", version: 1, recordVersion: 1 }, extensions: { workspace: { id: "workspace", version: 1, recordVersion: 1 } } };
const workManifest: HostManifest = { ...manifest, contractId: "fixture.work", compositionId: "public-work-v1", harness: { id: "copilot", version: 1, recordVersion: 1 }, extensions: {} };
const key: PluginHostKey = { ...catalogScope, host: "host", owner: "durable-owner", routeEpoch: "route-1" };
class Source<T> implements PluginSource<T> {
  starts = 0; releases = 0;
  failRelease = false;
  value: ((value: T) => void) | undefined;
  observation: ((value: Exclude<PluginObservation, "unsupported" | "disposed">) => void) | undefined;
  subscribe(value: (value: T) => void, observation: (value: Exclude<PluginObservation, "unsupported" | "disposed">) => void) {
    this.starts++; this.value = value; this.observation = observation; let released = false;
    return { release: () => { if (!released) { released = true; this.releases++; if (this.failRelease) throw new Error("Injected cleanup failure"); } } };
  }
}
function client<R extends AnyRouter>(): TRPCClient<R> { return createTRPCClient<R>({ links: [() => () => observable(() => () => {})] }); }
function fixture(maxEntries = 64) {
  const workspace = new PluginWorkspace<Contracts>({ local: { ...manifest, nativeKind: "codex" }, work: { ...workManifest, nativeKind: "copilot" } }, { maxEntries });
  const source = new Source<HostProjection<Contracts["local"]>>();
  const local = workspace.prepareHost({ hostKind: "local", key, manifest, client: client(), sessionClient: () => client(), source });
  return { workspace, source, local };
}

test("preparation, server snapshots and repeated reads acquire no observers or native work", async () => {
  const f = fixture(), native = workspaceFixture();
  try {
    const { a } = await native.open(), source = new Source<SessionProjection<Contracts["local"]>>();
    const view = f.workspace.prepareAgent(f.local, { session: { id: "a", generation: 1 }, base: a, source });
    const before = native.counts();
    for (let i = 0; i < 10; i++) { assert.equal(view.getSnapshot(), view.getServerSnapshot()); f.local.getServerSnapshot(); }
    assert.equal(f.source.starts, 0); assert.equal(source.starts, 0);
    assert.deepEqual(native.counts(), before);
    assert.equal(native.history.session(native.bindings.get("a")!.history).mountedReferences, 0);
    assert.equal(view.getSnapshot().plugin.observation, "unobserved");
  } finally { f.workspace.close(); native.workspace.close(); }
});

test("A/B/A and pin retain public data with the existing base draft and history owner", async () => {
  const f = fixture(), native = workspaceFixture();
  try {
    const { a } = await native.open(), source = new Source<SessionProjection<Contracts["local"]>>();
    const view = f.workspace.prepareAgent(f.local, { session: { id: "a", generation: 1 }, base: a, source });
    const mounted = view.observe();
    source.value!({ lifecycle: { directory: "/owned" }, extensions: { workspace: { branch: "main" } } });
    a.setDraft("retained draft");
    view.setPinned(true); mounted.release();
    assert.equal(source.starts, 1); assert.equal(source.releases, 0);
    assert.equal(native.counts().streams, 1);
    const other = new Source<HostProjection<Contracts["work"]>>();
    const work = f.workspace.prepareHost({ hostKind: "work", key: { ...key, host: "work-host" }, manifest: workManifest, client: client(), sessionClient: () => client(), source: other });
    const switched = work.projection.observe(); switched.release();
    const returned = view.observe();
    assert.equal(source.starts, 1);
    const snapshot = view.getSnapshot();
    assert.equal(snapshot.plugin.value!.extensions.workspace.branch, "main");
    assert(snapshot.agent.kind !== "disposed");
    assert.equal(snapshot.agent.composer.value.text, "retained draft");
    returned.release(); view.setPinned(false);
    assert.equal(source.releases, 1); assert.equal(f.source.releases, 1); assert.equal(native.counts().streams, 0);
    assert.equal(native.counts().submitted, 0); assert.equal(native.counts().older, 0);
  } finally { f.workspace.close(); native.workspace.close(); }
});

test("source lease epoch rejects late data and disconnect preserves the last authoritative snapshot", () => {
  const f = fixture();
  try {
    const one = f.local.projection.observe(), stale = f.source.value!;
    const initial = { lifecycle: { capacity: 1 }, extensions: { workspace: { root: "/root" } } };
    f.source.value!(initial); f.source.observation!("disconnected");
    assert.equal(f.local.getSnapshot().plugin.value, initial);
    one.release(); stale({ ...initial, lifecycle: { capacity: 99 } });
    assert.equal(f.local.getSnapshot().plugin.value!.lifecycle.capacity, 1);
    const two = f.local.projection.observe();
    assert.equal(f.source.starts, 2);
    stale({ ...initial, lifecycle: { capacity: 98 } });
    assert.equal(f.local.getSnapshot().plugin.value!.lifecycle.capacity, 1);
    f.source.value!({ ...initial, lifecycle: { capacity: 2 } });
    assert.equal(f.local.getSnapshot().plugin.value!.lifecycle.capacity, 2);
    two.release();
  } finally { f.workspace.close(); }
});

test("auth disposal revokes pins, hides base data, isolates listeners and leaves another namespace alive", async () => {
  const f = fixture(), native = workspaceFixture();
  try {
    const { a } = await native.open(), source = new Source<SessionProjection<Contracts["local"]>>();
    const view = f.workspace.prepareAgent(f.local, { session: { id: "a", generation: 1 }, base: a, source });
    view.projection.subscribe(() => { throw new Error("one renderer failed"); });
    view.setPinned(true); source.value!({ lifecycle: { directory: "/private" }, extensions: { workspace: { branch: "private" } } });
    const otherSource = new Source<HostProjection<Contracts["local"]>>();
    const other = f.workspace.prepareHost({ hostKind: "local", key: { ...key, principal: "other" }, manifest, client: client(), sessionClient: () => client(), source: otherSource });
    const otherLease = other.projection.observe();
    source.failRelease = true;
    assert.throws(() => f.workspace.disposeNamespace(key), /cleanup failed after redaction/);
    assert.equal(view.getSnapshot().plugin.observation, "disposed"); assert.equal(view.getSnapshot().plugin.value, null);
    assert.deepEqual(view.getSnapshot().agent, { kind: "disposed" });
    assert.equal(source.releases, 1); assert.equal(native.counts().streams, 0); assert.equal(otherSource.releases, 0);
    view.observe().release(); assert.equal(source.starts, 1);
    assert.throws(() => f.workspace.prepareAgent(f.local, { session: { id: "a", generation: 1 }, base: a, source }), /another workspace|disposed/);
    otherLease.release();
  } finally { f.workspace.close(); native.workspace.close(); }
});

test("known manifest and full authenticated base scope reject unsafe type binding; capacity never evicts", async () => {
  const f = fixture(2), native = workspaceFixture();
  try {
    const { a } = await native.open();
    assert.throws(() => f.workspace.prepareHost({ hostKind: "work", key, manifest: workManifest, client: client(), sessionClient: () => client(), source: new Source() }), /conflicts/);
    assert.throws(() => f.workspace.prepareAgent(f.local, { session: { id: "a", generation: 2 }, base: a, source: new Source() }), /generation mismatch/);
    const unsupported = f.workspace.prepareHost({ hostKind: "local", key: { ...key, host: "wrong-contract" }, manifest: { ...manifest, compositionId: "other" }, client: client(), sessionClient: () => client(), source: new Source<HostProjection<Contracts["local"]>>() });
    unsupported.projection.observe().release(); assert.equal(unsupported.getSnapshot().plugin.observation, "unsupported");
    assert.throws(() => f.workspace.prepareHost({ hostKind: "local", key: { ...key, host: "full" }, manifest, client: client(), sessionClient: () => client(), source: new Source<HostProjection<Contracts["local"]>>() }), /capacity full/);
    assert.equal(f.workspace.prepareHost({ hostKind: "local", key, manifest, client: f.local.client, sessionClient: f.local.sessionClient, source: f.source }), f.local);
  } finally { f.workspace.close(); native.workspace.close(); }
});

test("synchronous source disposal releases the just-acquired observer exactly once", () => {
  let starts = 0, releases = 0;
  const workspace = new PluginWorkspace<Contracts>({ local: { ...manifest, nativeKind: "codex" }, work: { ...workManifest, nativeKind: "copilot" } });
  const view = workspace.prepareHost({ hostKind: "local", key, manifest, client: client(), sessionClient: () => client(), source: { subscribe(value) { starts++; value({ lifecycle: { capacity: 1 }, extensions: { workspace: { root: "/root" } } }); return { release() { releases++; } }; } } });
  const unlisten = view.projection.subscribe(() => { if (view.getSnapshot().plugin.observation === "live") workspace.disposeNamespace(key); });
  const lease = view.projection.observe();
  assert.equal(starts, 1); assert.equal(releases, 1); assert.equal(view.getSnapshot().plugin.observation, "disposed");
  lease.release(); unlisten(); workspace.close(); assert.equal(releases, 1);
});

test("one session shares plugin projection while two actual viewers retain independent history and pin one session", async () => {
  const f = fixture(), native = workspaceFixture();
  try {
    const { a } = await native.open(), side = native.workspace.view("a", "side"), source = new Source<SessionProjection<Contracts["local"]>>();
    const main = f.workspace.prepareAgent(f.local, { session: { id: "a", generation: 1 }, base: a, source });
    const other = f.workspace.prepareAgent(f.local, { session: { id: "a", generation: 1 }, base: side, source });
    assert.notEqual(main, other); assert.equal(main.base, a); assert.equal(other.base, side); assert.equal(main.projection, other.projection);
    const one = main.observe(), two = other.observe();
    source.value!({ lifecycle: { directory: "/owned" }, extensions: { workspace: { branch: "shared" } } });
    assert.equal(source.starts, 1); assert.equal(main.getSnapshot().plugin, other.getSnapshot().plugin);
    await main.base.loadOlder();
    const mainState = main.getSnapshot().agent, otherState = other.getSnapshot().agent;
    assert(mainState.kind !== "disposed" && otherState.kind !== "disposed");
    assert.deepEqual(mainState.history.rows.map(row => row.id), ["older", "row"]);
    assert.deepEqual(otherState.history.rows.map(row => row.id), ["row"]);
    other.setPinned(true); one.release(); two.release(); assert.equal(source.releases, 0);
    main.setPinned(false); assert.equal(source.releases, 1);
  } finally { f.workspace.close(); native.workspace.close(); }
});

test('agent client supplies its exact session context through actual Gateway/Host RPC; host client stays unscoped', { timeout: 10000 }, async () => {
  const definition = defineHost({ contract: { id: 'session-context', version: 1 },
    harness: { kind: 'harness', nativeKind: 'codex', identity: { id: 'scripted.codex', version: 1, recordVersion: 1 }, capabilities: [] } as const,
    lifecycle: () => ({ kind: 'lifecycle' as const, identity: { id: 'scripted.lifecycle', version: 1, recordVersion: 1 }, capabilities: [],
      createInput: z.object({}), public: { host: z.object({}), session: z.object({}) },
      open: () => ({ sessions: {}, router: hostRouter({}), readiness: () => ({ ready: true as const }), close() {} }) }),
    harnessRouter: () => hostRouter({ session: hostProcedure.query(({ ctx }) => {
      if (!ctx.session) throw Error('Exact session route required');
      return { id: ctx.session.id, generation: ctx.session.generation };
    }) }),
  });
  type Actual = { codex: PublicHostContract<typeof definition> };
  const native = workspaceFixture(), proof = createHmacHostProof({ issuer: 'session-client', audience: 'session-host', secret: randomBytes(32) });
  const identity = { ...catalogScope, authorities: [catalogScope.authority], actions: ['read', 'control'] as const };
  const host = await activateHost(definition, { route: key, storage: {}, authenticate: authenticateHostProof(proof) });
  const coordinator = new GatewayCoordinator();
  coordinator.registerHostRpc({ target: key, port: createInProcessHostRpcPort({ router: host.router, manifest: host.manifest,
    context: (caller, request, type) => host.context({ proof: { authorization: proof.issue(caller, request, type), path: request.path, type }, expected: request.expected, ...(request.session ? { session: request.session } : {}) }),
  }) });
  const server = await listenLoopback(coordinator, async bearer => bearer === 'Bearer scripted' ? identity : null);
  const transport = new HttpGatewayTransport({ url: server.url, authorization: 'Bearer scripted' });
  const plugins = new PluginWorkspace<Actual>({ codex: { ...host.manifest, nativeKind: 'codex' } });
  try {
    const options = { transport, target: key, expected: host.manifest };
    const parent = plugins.prepareHost({ hostKind: 'codex', key, manifest: host.manifest,
      client: createGatewayHostClient<Actual['codex']['router']>(options),
      sessionClient: session => createGatewayHostClient<Actual['codex']['router']>({ ...options, session }),
      source: new Source<HostProjection<Actual['codex']>>() });
    await assert.rejects(parent.client.harness.session.query());
    const { a } = await native.open();
    const view = plugins.prepareAgent(parent, { base: a, session: { id: 'a', generation: 1 }, source: new Source<SessionProjection<Actual['codex']>>() });
    assert.notEqual(view.getSnapshot().client, parent.client);
    assert.deepEqual(await view.getSnapshot().client.harness.session.query(), { id: 'a', generation: 1 });
    assert.equal(native.counts().submitted, 0);
    plugins.disposeNamespace(key);
    assert.throws(() => parent.sessionClient({ id: 'a', generation: 1 }), /disposed/);
  } finally { plugins.close(); native.workspace.close(); transport.close(); coordinator.close(); await server.close(); await host.close(); proof.revoke(); }
});
