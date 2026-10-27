import { randomBytes } from 'node:crypto';
import { initTRPC } from '@trpc/server';
import type { HostContext } from '../../v8-plugins/src/contracts.js';
import { activateHost } from '../../v8-plugins/src/host.js';
import type { CreateRequest, HostCreationStatus, HostCreationPort } from '../../v8-catalog/src/contracts/types.js';
import { HistoryHub } from '../../v8-history/src/host/history-owner.js';
import { canonical } from '../../v8-session/src/contracts/validation.js';
import type { NativeRead, RunRef } from '../../v8-session/src/contracts/types.js';
import type { GatewayAction, SessionRoute, FileSurface } from '../src/contracts/types.js';
import { hostRpcExpected, type HostRpcRequest } from '../src/contracts/rpc.js';
import { createHostFacade, hostFacadeAction } from '../src/node/host-facade.js';
import { createHmacHostProof, authenticateHostProof } from '../src/node/host-proof.js';
import { createInProcessHostRpcPort } from '../src/node/in-process-host.js';
import { createRemoteHost } from '../src/node/remote-host.js';
import { pluginDefinition } from './plugins-fixture.js';
import { alice, target, scope, historyScope, FixtureSession, deferred } from './fixture.js';

export async function remoteFixture(options: { actions?: readonly GatewayAction[]; routeActions?: readonly GatewayAction[]; files?: FileSurface } = {}) {
  const { session: _session, ...hostTarget } = target;
  const actions = options.actions ?? ['read', 'control', 'catalogWrite', 'mcpRefresh'];
  const identity = { ...alice, actions: ['read', 'control', 'catalogWrite', 'fileWrite', 'mcpRefresh'] as const };
  const proof = createHmacHostProof({ issuer: 'owned-gateway', audience: 'owned-host', secret: randomBytes(32), actionForProcedure: hostFacadeAction });
  const domain = pluginDefinition(), host = await activateHost(domain.definition, { route: hostTarget, storage: {}, authenticate: authenticateHostProof(proof) });
  const history = new HistoryHub(); history.open(historyScope, { knownStart: true });
  const run = { scope, generation: 1, nativeSession: 'native' }, ids = new Set([target.session]), listeners = new Set<(ids: readonly string[]) => void>();
  const originals = new Map<string, { meaning: string; status: HostCreationStatus }>();
  const stats = { creates: 0, older: 0, recover: 0, refresh: 0, nativeRead: 0, stops: 0 };
  let recovery: ReturnType<typeof deferred<void>> | undefined;
  const creation: HostCreationPort = {
    target: { host: target.host, owner: target.owner, kind: 'codex', placement: 'shared' },
    async create(original) {
      const prior = originals.get(original.id); if (prior) { if (prior.meaning !== canonical(original)) throw Error('meaning changed'); return prior.status; }
      stats.creates++; const status = { state: 'created' as const, binding: { nativeSession: 'native-created', generation: 1, kind: 'codex' as const, placement: 'shared' as const } };
      originals.set(original.id, { meaning: canonical(original), status }); ids.add(original.session); publish(); return status;
    },
    async read(original) { return originals.get(original.id)?.status ?? { state: 'unknown' }; },
    async watch(original, emit) { emit(originals.get(original.id)?.status ?? { state: 'unknown' }); return () => {}; },
  };
  const session = Object.assign(new FixtureSession(), { read: async (value: RunRef, _request: NativeRead) => { stats.nativeRead++; return { run: value, type: 'codex.goal' as const, goal: null }; } });
  const mcp = { run, kind: 'codex' as const, discovery: 'thread-scoped-discovery' as const, epoch: 1, revision: 1, freshness: 'unobserved' as const, coverage: 'unknown' as const, observedAt: null, management: 'session-originals' as const, servers: [] };
  const route: SessionRoute = {
    target, ...(options.routeActions ? { actions: options.routeActions } : {}), ...(options.files ? { files: options.files } : {}), session,
    binding: () => ({ run, history: historyScope }), controlCatalog: async () => ({ available: true, choices: [] }),
    history: {
      scopes: () => [historyScope], watch: (scope, cursor) => history.watch(scope, cursor),
      older: async () => { stats.older++; return { scope: historyScope, generation: 'fixture', rows: [], olderEdge: { state: 'end', evidence: 'provedEmptyCapture' } }; },
      recover: async () => { stats.recover++; await recovery?.promise; return { state: 'value', value: { status: 'ready' } }; },
    },
    authorizeHistory: scope => canonical(scope) === canonical(historyScope),
    interactions: { snapshot: async () => ({ scope, run, epoch: 1, revision: 1, baseline: 'complete', items: [] }), subscribe: (_scope, emit) => { void route.interactions!.snapshot(scope).then(emit); return () => {}; } },
    mcp: {
      snapshot: async () => mcp,
      refresh: async () => { stats.refresh++; return mcp; },
      subscribe: (_run, emit) => { void route.mcp!.snapshot(run).then(emit); return () => {}; },
    },
  };
  const facade = createHostFacade({ target: hostTarget, manifest: host.manifest, actions, creation,
    listSessions: () => [...ids], watchSessions: emit => { listeners.add(emit); emit([...ids]); return () => { listeners.delete(emit); }; },
    session: sessionId => { if (!ids.has(sessionId) || sessionId !== target.session) throw Error('not available fixture session'); return route; },
  });
  const router = initTRPC.context<HostContext>().create().mergeRouters(host.router, facade.router);
  const port = createInProcessHostRpcPort({ router, manifest: host.manifest, context: async (identity, request, type) => host.context({
    proof: { authorization: proof.issue(identity, request, type), path: request.path, type }, expected: request.expected,
    ...(request.session ? { session: request.session } : {}),
  }) });
  const remote = (selected = actions, selectedIdentity = identity) => createRemoteHost({ target: hostTarget, expected: host.manifest, creationTarget: creation.target, identity: selectedIdentity, actions: selected, port });
  function publish() { for (const emit of listeners) emit([...ids]); }
  return { hostTarget, identity, actions, host, proof, port, router, session, history, run, route, stats, facade, creation, remote,
    remove() { ids.delete(target.session); publish(); },
    holdRecovery() { return recovery = deferred<void>(); },
    original(id = 'remote-create'): CreateRequest { return { scope: { connection: target.connection, principal: target.principal, authority: target.authority }, id, session: 'created-logical', target: creation.target, metadata: { name: null, cwd: null } }; },
    request(path: string, input: unknown): HostRpcRequest { return { target: hostTarget, expected: hostRpcExpected(host.manifest), path: `multiplex.${path}`, input }; },
    async close() { recovery?.resolve(); await facade.close(); await host.close(); proof.revoke(); },
  };
}
