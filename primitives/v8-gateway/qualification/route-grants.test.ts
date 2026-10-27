import assert from 'node:assert/strict';
import test from 'node:test';
import type { CatalogPort, CatalogScope, CreateRequest } from '../../v8-catalog/src/contracts/types.js';
import type { FilePort } from '../../v8-files/src/contracts/types.js';
import type { McpPort, McpSnapshot } from '../../v8-mcp/src/contracts.js';
import type { RunRef } from '../../v8-session/src/contracts/types.js';
import type { HostManifest } from '../../v8-plugins/src/contracts.js';
import { hostRpcExpected, type HostRpcCall, type HostRpcPort, type HostRpcTarget } from '../src/contracts/rpc.js';
import type { GatewayAction, GatewayTarget, Identity, SessionRoute } from '../src/contracts/types.js';
import { GatewayCoordinator } from '../src/gateway/coordinator.js';
import { FixtureSession, alice, deferred, historyScope, request, target, until } from './fixture.js';

const allActions: GatewayAction[] = ['read', 'control', 'catalogWrite', 'fileWrite', 'mcpRefresh'];
const manifest: HostManifest = {
  contractId: 'fixture.grants', contractVersion: 1, compositionId: 'public-composition',
  harness: { id: 'fixture.codex', version: 1, recordVersion: 1 },
  lifecycle: { id: 'fixture.lifecycle', version: 1, recordVersion: 1 }, extensions: {},
};
const hostTarget = ({ session: _session, ...value }: GatewayTarget): HostRpcTarget => value;
const rpcRequest = (value: GatewayTarget, type: HostRpcCall['type']): HostRpcCall => ({
  target: hostTarget(value), expected: hostRpcExpected(manifest), path: 'fixture.inspect', type,
});

function fixtureRoute(value: GatewayTarget, actions?: GatewayAction[]) {
  const session = new FixtureSession(), scope = { ...session.state.scope, host: value.host };
  session.state = { ...session.state, scope };
  const run: RunRef = { scope, generation: 1, nativeSession: 'native' };
  const history = { ...historyScope, origin: { ...historyScope.origin, host: value.host } };
  const snapshot: McpSnapshot = { kind: 'codex', run, epoch: 1, revision: 1, freshness: 'current',
    coverage: 'enumerated', observedAt: 1, management: 'unavailable-no-original-command', discovery: 'thread-scoped-discovery', servers: [] };
  const effects = { rpcReads: 0, rpcWrites: 0, mcpRefresh: 0, fileCalls: 0 };
  const files: FilePort = { async call() { effects.fileCalls++; return undefined as never; } };
  const mcp: McpPort = { async snapshot() { return snapshot; }, subscribe() { return () => {}; },
    async refresh() { effects.mcpRefresh++; return snapshot; } };
  const route: SessionRoute = { target: value, session, history: { async *watch() {} }, mcp,
    files: { port: files, scope: () => ({ ...scope, session: run.nativeSession }) },
    binding: () => ({ run, history }), authorizeHistory: () => true, ...(actions ? { actions } : {}) };
  const port: HostRpcPort = { manifest,
    async call(_identity, value) { if (value.type === 'mutation') effects.rpcWrites++; else effects.rpcReads++; return { ok: true }; },
    async *watch() { yield { ok: true }; },
  };
  return { route, port, session, effects, run };
}

test('each route intersects the identity union for session, RPC, file, MCP and catalog admission', async () => {
  const coordinator = new GatewayCoordinator(), caller: Identity = { ...alice, actions: allActions, authorities: ['root', 'writable-catalog'] };
  const readActions: GatewayAction[] = ['read'], read = fixtureRoute({ ...target, host: 'read-only' }, readActions);
  const write = fixtureRoute({ ...target, host: 'control-capable' }, allActions);
  const defaults = fixtureRoute({ ...target, host: 'omitted-default' });
  let catalogReads = 0, catalogWrites = 0;
  const catalog: CatalogPort = {
    async list() { catalogReads++; return []; }, async get() { return null; }, async creation() { return null; },
    async create() { catalogWrites++; return undefined as never; }, async rename() { catalogWrites++; return undefined as never; },
    async setWatched() { catalogWrites++; return undefined as never; }, async metadataOriginal() { return null; },
    subscribe() { return () => {}; },
  };
  const readCatalog: CatalogScope = { connection: caller.connection, principal: caller.principal, authority: 'root' };
  const writeCatalog = { ...readCatalog, authority: 'writable-catalog' };
  const creation = (scope: CatalogScope): CreateRequest => ({ scope, id: 'create', session: 'new-session',
    target: { host: 'control-capable', owner: target.owner, kind: 'codex', placement: 'shared' }, metadata: { name: null, cwd: null } });
  try {
    for (const fixture of [read, write, defaults]) {
      coordinator.register(fixture.route);
      coordinator.registerHostRpc({ target: hostTarget(fixture.route.target), port: fixture.port,
        ...(fixture.route.actions ? { actions: fixture.route.actions } : {}) });
    }
    coordinator.registerCatalog({ scope: readCatalog, owner: target.owner, port: catalog, actions: readActions });
    coordinator.registerCatalog({ scope: writeCatalog, owner: target.owner, port: catalog, actions: allActions });
    // The application's arrays are no longer authoritative after admission.
    readActions.push('control', 'fileWrite', 'mcpRefresh', 'catalogWrite');
    await coordinator.snapshot(caller, read.route.target);
    assert.equal((await coordinator.rpcCall(caller, rpcRequest(read.route.target, 'query'))).ok, true);
    assert.equal((await coordinator.fileSurface(caller, read.route.target)).scope.host, 'read-only');
    assert.equal((await coordinator.mcpSnapshot(caller, read.route.target, read.run)).freshness, 'current');
    assert.deepEqual(await coordinator.catalogList(caller, readCatalog), []);
    const observer = coordinator.watchRpc(caller, rpcRequest(read.route.target, 'query'));
    assert.equal((await observer.next()).value?.ok, true); await observer.return();
    assert.throws(() => coordinator.submit(caller, read.route.target, { ...request(), scope: read.run.scope }), { code: 'FORBIDDEN' });
    assert.throws(() => coordinator.rpcCall(caller, rpcRequest(read.route.target, 'mutation')), { code: 'FORBIDDEN' });
    await assert.rejects(coordinator.fileSurface(caller, read.route.target, true), { code: 'FORBIDDEN' });
    await assert.rejects(coordinator.mcpRefresh(caller, read.route.target, read.run), { code: 'FORBIDDEN' });
    assert.throws(() => coordinator.catalogCreate(caller, creation(readCatalog)), { code: 'FORBIDDEN' });
    assert.throws(() => coordinator.catalogRename(caller, { scope: readCatalog, id: 'rename', session: 'logical', revision: 1, name: 'new' }), { code: 'FORBIDDEN' });
    assert.equal(read.session.submits.length, 0); assert.deepEqual(read.effects, { rpcReads: 1, rpcWrites: 0, mcpRefresh: 0, fileCalls: 0 });
    // A capable route never supplies an action absent from the caller identity.
    assert.throws(() => coordinator.rpcCall({ ...caller, actions: ['read'] }, rpcRequest(write.route.target, 'mutation')), { code: 'FORBIDDEN' });
    await coordinator.submit(caller, write.route.target, { ...request(), scope: write.run.scope });
    assert.equal((await coordinator.rpcCall(caller, rpcRequest(write.route.target, 'mutation'))).ok, true);
    await coordinator.fileSurface(caller, write.route.target, true);
    await coordinator.mcpRefresh(caller, write.route.target, write.run);
    await coordinator.catalogCreate(caller, creation(writeCatalog));
    await coordinator.submit(caller, defaults.route.target, { ...request(), scope: defaults.run.scope });
    assert.equal((await coordinator.rpcCall(caller, rpcRequest(defaults.route.target, 'mutation'))).ok, true);
    assert.equal(write.session.submits.length, 1); assert.equal(write.effects.rpcWrites, 1); assert.equal(write.effects.mcpRefresh, 1);
    assert.equal(catalogReads, 1); assert.equal(catalogWrites, 1);
    coordinator.unavailable(read.route.target); coordinator.unavailableHostRpc(hostTarget(read.route.target));
    assert.equal(read.session.submits.length, 0); assert.equal(read.effects.mcpRefresh, 0);
  } finally { coordinator.close(); }
});

test('invalid grants cannot retire or replace admitted routes; empty grants deny every action', async () => {
  const coordinator = new GatewayCoordinator(), fixture = fixtureRoute(target, ['read']), caller = { ...alice, actions: allActions };
  try {
    coordinator.register(fixture.route); coordinator.registerHostRpc({ target: hostTarget(target), port: fixture.port, actions: ['read'] });
    const scope = { connection: target.connection, principal: target.principal, authority: target.authority };
    for (const actions of [['invalid'], ['read', 'read'], Array(1), 'read', null] as unknown[]) {
      const invalid = actions as GatewayAction[];
      assert.throws(() => coordinator.register({ ...fixture.route, target: { ...target, routeEpoch: 'replacement' }, actions: invalid }), { code: 'INVALID' });
      assert.throws(() => coordinator.registerHostRpc({ target: { ...hostTarget(target), routeEpoch: 'replacement' }, port: fixture.port, actions: invalid }), { code: 'INVALID' });
      assert.throws(() => coordinator.registerCatalog({ scope, owner: target.owner, port: {} as CatalogPort, actions: invalid }), { code: 'INVALID' });
    }
    await coordinator.snapshot(caller, target);
    assert.equal((await coordinator.rpcCall(caller, rpcRequest(target, 'query'))).ok, true);
    coordinator.register({ ...fixture.route, target: { ...target, routeEpoch: 'empty' }, actions: [] });
    coordinator.registerHostRpc({ target: { ...hostTarget(target), routeEpoch: 'empty' }, port: fixture.port, actions: [] });
    assert.throws(() => coordinator.snapshot(caller, { ...target, routeEpoch: 'empty' }), { code: 'FORBIDDEN' });
    assert.throws(() => coordinator.rpcCall(caller, { ...rpcRequest(target, 'query'), target: { ...hostTarget(target), routeEpoch: 'empty' } }), { code: 'FORBIDDEN' });
    assert.equal(fixture.session.submits.length, 0); assert.equal(fixture.effects.rpcWrites, 0);
  } finally { coordinator.close(); }
});

test('remote registration snapshots the grant before asynchronous verification and revocation never sends Stop', async () => {
  const verified = deferred<void>(), revoked = new AbortController(), actions: GatewayAction[] = ['read'];
  const coordinator = new GatewayCoordinator({}, async () => {
    await verified.promise; return { target, expiresAt: Date.now() + 10000, revoked: revoked.signal };
  });
  const fixture = fixtureRoute(target, actions), caller = { ...alice, actions: allActions };
  try {
    const registration = coordinator.registerRemote(fixture.route, 'fixture-proof');
    actions.push('control'); verified.resolve(); await registration;
    await coordinator.snapshot(caller, target);
    assert.throws(() => coordinator.submit(caller, target, request()), { code: 'FORBIDDEN' });
    revoked.abort(); assert.throws(() => coordinator.snapshot(caller, target), { code: 'UNAVAILABLE' });
    assert.equal(fixture.session.submits.length, 0); assert.equal(fixture.effects.mcpRefresh, 0);
  } finally { verified.resolve(); coordinator.close(); }
});

test('exact registration release closes only its observers, permits remount, and stale releases preserve replacements', async () => {
  const coordinator = new GatewayCoordinator({ routes: 2 }), fixture = fixtureRoute(target, ['read']), caller = { ...alice, actions: allActions };
  let rpcClosed = 0;
  const port: HostRpcPort = { ...fixture.port,
    async *watch(_identity, _request, signal) {
      yield { live: true };
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      rpcClosed++;
    },
  };
  try {
    const releaseSession = coordinator.register(fixture.route);
    const releaseRpc = coordinator.registerHostRpc({ target: hostTarget(target), port, actions: ['read'] });
    const sessionWatch = coordinator.watchSession(caller, target), rpcWatch = coordinator.watchRpc(caller, rpcRequest(target, 'query'));
    await sessionWatch.next(); await rpcWatch.next(); assert.equal(coordinator.observation.subscribers, 2);
    releaseSession(); releaseRpc(); releaseSession(); releaseRpc();
    await assert.rejects(sessionWatch.next(), { code: 'UNAVAILABLE' });
    await assert.rejects(rpcWatch.next(), { code: 'UNAVAILABLE' });
    await until(() => rpcClosed === 1); assert.equal(coordinator.observation.subscribers, 0); assert.equal(fixture.session.listeners.size, 0);
    // Same-key remount is safe because the old releases capture object identity.
    const remountedSession = coordinator.register(fixture.route);
    const remountedRpc = coordinator.registerHostRpc({ target: hostTarget(target), port, actions: ['read'] });
    releaseSession(); releaseRpc();
    await coordinator.snapshot(caller, target);
    assert.equal((await coordinator.rpcCall(caller, rpcRequest(target, 'query'))).ok, true);
    // An old epoch's releases cannot remove the current transport observation.
    const next = { ...target, routeEpoch: 'next-route' };
    const nextSession = coordinator.register({ ...fixture.route, target: next });
    const nextRpc = coordinator.registerHostRpc({ target: hostTarget(next), port, actions: ['read'] });
    remountedSession(); remountedRpc();
    await coordinator.snapshot(caller, next);
    assert.equal((await coordinator.rpcCall(caller, rpcRequest(next, 'query'))).ok, true);
    nextSession(); nextRpc();
    assert.equal(fixture.session.state.phase, 'running'); assert.equal(fixture.session.submits.length, 0);
    assert.equal(fixture.effects.mcpRefresh, 0); assert.equal(fixture.effects.rpcWrites, 0);
  } finally { coordinator.close(); }
});
