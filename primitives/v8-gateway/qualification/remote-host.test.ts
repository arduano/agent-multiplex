import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { Peer, PeerContext } from '@arduano/p2prpc-core';
import type { RunRef } from '../../v8-session/src/contracts/types.js';
import { createHmacHostProof } from '../src/node/host-proof.js';
import { hostFacadeAction } from '../src/node/host-facade.js';
import { createRemoteHost, mountRemoteHost } from '../src/node/remote-host.js';
import { GatewayCoordinator } from '../src/gateway/coordinator.js';
import { createP2pGatewayRouter, P2pGatewayTransport, type GatewayP2pRouter } from '../src/node/p2prpc.js';
import { remoteFixture } from './remote-host-fixture.js';
import { target, scope, historyScope, request, until, deferred } from './fixture.js';
import { GatewayError } from '../src/contracts/types.js';
import { ScriptedPort, fixture as sessionFixture } from '../../v8-session/qualification/host-fixture.js';
import { listenLoopback } from '../src/http/server.js';
import { HttpGatewayTransport } from '../src/client/http.js';
import { GatewayClient } from '../src/client/coordinator.js';
import { HistoryWorkspace } from '../../v8-history/src/client/workspace.js';

test('explicit history retry tokens cross HTTP and remote Host forwarding without becoming observer policy', async () => {
  const f = await remoteFixture(), received: unknown[] = [];
  Object.assign(f.route.history, {
    older: async (selected: unknown, cursor: string, generation?: string, retryToken?: string) => {
      received.push({ selected, cursor, generation, retryToken });
      return { scope: historyScope, generation: 'fixture', rows: [], olderEdge: { state: 'end', evidence: 'nativeBoundary' } };
    },
    recover: async (selected: unknown, observation: { timeoutMs?: number }, retryToken?: string) => {
      received.push({ selected, timeoutMs: observation.timeoutMs, retryToken });
      return { state: 'value', value: { status: 'ready' } };
    },
  });
  const remote = f.remote(), gateway = new GatewayCoordinator(), mount = mountRemoteHost(gateway, remote);
  const server = await listenLoopback(gateway, async () => f.identity), transport = new HttpGatewayTransport({ url: server.url, authorization: 'fixture' });
  const client = new GatewayClient({ transport, history: new HistoryWorkspace({ connection: scope.connection, principal: scope.principal }), targets: [target], onFence() {} });
  try {
    await mount.ready;
    await client.older(scope, historyScope, 'earlier-cursor', 'fixture', 'retry-older');
    await client.recover(scope, historyScope, { timeoutMs: 25 }, 'retry-recover');
    assert.deepEqual(received, [
      { selected: historyScope, cursor: 'earlier-cursor', generation: 'fixture', retryToken: 'retry-older' },
      { selected: historyScope, timeoutMs: 25, retryToken: 'retry-recover' },
    ]);
    await assert.rejects(transport.recover(target, historyScope, {}, 'x'.repeat(129)), { code: 'INVALID' });
    assert.equal(received.length, 2); assert.equal(f.session.submits.length, 0);
  } finally { client.close(); mount.close(); await mount.settled; remote.close(); gateway.close(); await server.close(); await f.close(); }
});

test('actual Host read pressure crosses the facade as temporary FULL, while changed native ownership remains FENCED', async () => {
  const f = await remoteFixture(), gates = Array.from({ length: 4 }, () => deferred<void>());
  let dispatched = 0;
  const native = Object.assign(new ScriptedPort(), {
    capabilities: { ...new ScriptedPort().capabilities, reads: ['codex.terminals'] as const },
    async read(run: RunRef) { const slot = dispatched++; if (slot < gates.length) await gates[slot]!.promise; return { run, type: 'codex.terminals' as const, data: [], nextCursor: null }; },
  });
  const owned = await sessionFixture(native, { scope }), remote = f.remote();
  Object.assign(f.route, { session: owned.host });
  const route = remote.sessionRoute(target.session);
  let pending: Promise<unknown>[] = [];
  try {
    assert.equal((await owned.host.submit({ scope, id: 'owned-create', generation: 0, command: { type: 'create' } })).state, 'acknowledged');
    const run = native.run!;
    pending = gates.map((_, i) => route.session.read!(run, { type: 'codex.terminals', cursor: `page-${i}` }));
    await until(() => dispatched === 4);
    await assert.rejects(route.session.read!(run, { type: 'codex.terminals', cursor: 'fifth' }), { code: 'FULL' });
    gates[0]!.resolve(); await pending[0];
    assert.equal((await route.session.read!(run, { type: 'codex.terminals', cursor: 'fifth' })).type, 'codex.terminals');
    await assert.rejects(route.session.read!({ ...run, generation: run.generation + 1 }, { type: 'codex.terminals' }), { code: 'FENCED' });
    assert.equal(dispatched, 5); assert.equal(native.calls.length, 0);
  } finally {
    gates.forEach(gate => gate.resolve()); await Promise.allSettled(pending);
    remote.close(); await owned.dispose(); await f.close();
  }
});

test('remote cold child recovery retains canonical Host proof before reading its history body', async () => {
  const f = await remoteFixture(), remote = f.remote(), gateway = new GatewayCoordinator(), mount = mountRemoteHost(gateway, remote);
  const child = { ...historyScope, threadId: 'not-yet-captured-child' };
  let proofs = 0;
  Object.assign(f.route, { authorizeHistory(value: typeof historyScope) { try { f.history.snapshot(value); return true; } catch { return false; } } });
  Object.assign(f.route.history, { authorize: async (value: typeof historyScope) => {
    assert.deepEqual(value.origin, historyScope.origin); proofs++;
    f.history.open(value, { knownStart: false }); return { state: 'value', value: true };
  } });
  try {
    await mount.ready;
    const denied = gateway.watchHistory(f.identity, { target, scope: child });
    await assert.rejects(denied.next(), { code: 'FENCED' }); await denied.return();
    assert.equal(proofs, 0); assert.equal(f.stats.recover, 0);
    assert.deepEqual(await gateway.recover(f.identity, target, child), { state: 'value', value: { status: 'ready' } });
    assert.equal(proofs, 1); assert.equal(f.stats.recover, 1);
    const stream = gateway.watchHistory(f.identity, { target, scope: child });
    try { assert.equal((await stream.next()).value?.kind, 'snapshot'); } finally { await stream.return(); }
    assert.equal(f.session.submits.length, 0);
  } finally { mount.close(); await mount.settled; remote.close(); gateway.close(); await f.close(); }
});

test('retained history cursor survives a Gateway remount of the same Host run; the Host still rejects foreign native scopes', async () => {
  const f = await remoteFixture(), remote = f.remote(), gateway = new GatewayCoordinator();
  let mount = mountRemoteHost(gateway, remote), stream: ReturnType<typeof gateway.watchHistory> | undefined;
  let losses = 0; const off = remote.onUnavailable(() => losses++);
  try {
    await mount.ready;
    const binding = await gateway.binding(f.identity, target); assert(binding);
    stream = gateway.watchHistory(f.identity, { target, scope: binding.history });
    const initial = (await stream.next()).value; assert(initial?.kind === 'snapshot');
    const cursor = { generation: initial.snapshot.generation, revision: initial.snapshot.revision };
    await stream.return(); stream = undefined;
    mount.close(); await mount.settled;
    mount = mountRemoteHost(gateway, remote); await mount.ready;
    // Same owner/route/run: there is deliberately no new binding read to seed
    // an ephemeral Gateway cache. The Host owns the history authorization.
    stream = gateway.watchHistory(f.identity, { target, scope: binding.history, cursor });
    const pending = stream.next();
    await until(() => f.history.owner(historyScope).subscriberCount === 1);
    f.history.emit(historyScope, [{ type: 'start', id: 'after-remount', kind: 'assistant', text: 'same live conversation' }]);
    const resumed = (await pending).value; assert(resumed?.kind === 'commit');
    assert.equal(resumed.generation, cursor.generation); assert.equal(resumed.baseRevision, cursor.revision);
    await stream.return(); stream = undefined;
    for (const foreign of [
      { ...historyScope, origin: { ...historyScope.origin, attachment: 'retired-attachment' } },
      { ...historyScope, origin: { ...historyScope.origin, nativeSession: 'foreign-native' }, threadId: 'foreign-native' },
    ]) {
      const denied = gateway.watchHistory(f.identity, { target, scope: foreign });
      await assert.rejects(denied.next(), { code: 'FENCED' }); await denied.return();
    }
    assert.equal(losses, 0, 'A scoped refusal does not revoke the reachable Host');
    assert.equal((await gateway.snapshot(f.identity, target)).phase, 'running');
    assert.equal(f.stats.nativeRead + f.stats.older + f.stats.recover, 0);
    assert.equal(f.session.submits.length, 0, 'Reconnect never starts, resumes or resends a native operation');
  } finally { off(); await stream?.return(); mount.close(); await mount.settled; remote.close(); gateway.close(); await f.close(); }
});

test('one failed history observer cannot retire a healthy session observer or Host inventory', async () => {
  const f = await remoteFixture(); let losses = 0;
  const remote = createRemoteHost({ target: f.hostTarget, expected: f.host.manifest, creationTarget: f.creation.target,
    identity: f.identity, actions: f.actions, port: { ...f.port,
      async *watch(identity, operation, signal) {
        if (operation.path === 'multiplex.historyWatch') throw new GatewayError('FENCED');
        yield* f.port.watch(identity, operation, signal);
      },
    } });
  const route = remote.sessionRoute(target.session), off = remote.onUnavailable(() => losses++);
  let snapshots = 0; const release = route.session.subscribe(scope, () => snapshots++);
  try {
    await until(() => snapshots === 1);
    const failed = route.history.watch(historyScope);
    await assert.rejects(failed.next(), { code: 'FENCED' }); await failed.return?.();
    assert.equal(losses, 0, 'Only the complete inventory stream owns Host reachability');
    f.session.emit(); await until(() => snapshots === 2);
    assert.equal((await route.session.snapshot(scope)).phase, 'running');
    assert.equal(f.session.submits.length, 0);
  } finally { release(); off(); remote.close(); await f.close(); }
});

test('remote snapshot consumers share one Host observer, retain its immutable baseline and release only the last lease', async () => {
  const f = await remoteFixture(), remote = f.remote(), route = remote.sessionRoute(target.session);
  const releases: (() => void)[] = [], first: number[] = [], second: number[] = [], late: number[] = [];
  try {
    releases.push(route.session.subscribe(scope, value => first.push(value.revision)));
    releases.push(route.session.subscribe(scope, value => second.push(value.revision)));
    await until(() => first.length === 1 && second.length === 1);
    assert.equal(f.session.listeners.size, 1, 'Two Gateway viewers must not open two raw Host subscriptions');
    f.session.emit(); await until(() => first.length === 2 && second.length === 2);
    releases.push(route.session.subscribe(scope, value => { assert(Object.isFrozen(value)); late.push(value.revision); }));
    assert.deepEqual(late, [second.at(-1)], 'A late viewer receives the current baseline without another read');
    releases.push(route.session.subscribe(scope, () => { throw Error('Consumer callback'); }));
    assert.equal(f.session.listeners.size, 1);
    releases[0]!(); f.session.emit(); await until(() => second.length === 3 && late.length === 2);
    assert.equal(first.length, 2); assert.equal(f.session.listeners.size, 1);
    for (const release of releases.splice(0)) release();
    await until(() => f.session.listeners.size === 0);
    for (let i = 0; i < 128; i++) releases.push(route.session.subscribe(scope, () => {}));
    assert.throws(() => route.session.subscribe(scope, () => {}), { code: 'FULL' });
    await until(() => f.session.listeners.size === 1);
    for (const release of releases.splice(0)) release();
    await until(() => f.session.listeners.size === 0);
    let observed = 0;
    releases.push(route.session.subscribe(scope, () => observed++)); await until(() => observed === 1);
    releases.push(route.session.subscribe(scope, () => route.close()));
    await until(() => f.session.listeners.size === 0);
    assert.throws(() => route.session.subscribe(scope, () => {}), { code: 'CLOSED' });
    assert.equal(f.stats.nativeRead + f.stats.older + f.stats.recover + f.stats.refresh + f.session.submits.length, 0);
  } finally { for (const release of releases) release(); remote.close(); await until(() => f.session.listeners.size === 0); await f.close(); }
});

test('a shared remote snapshot failure reaches each Gateway viewer and a new observer reacquires without retiring the Host', async () => {
  const f = await remoteFixture(), failure = deferred<void>(); let opens = 0, losses = 0;
  const remote = createRemoteHost({ target: f.hostTarget, expected: f.host.manifest, creationTarget: f.creation.target,
    identity: f.identity, actions: f.actions, port: { ...f.port, async *watch(identity, operation, signal) {
      if (operation.path !== 'multiplex.sessionWatch' || ++opens !== 1) { yield* f.port.watch(identity, operation, signal); return; }
      const source = f.port.watch(identity, operation, signal)[Symbol.asyncIterator]();
      try { const initial = await source.next(); assert(!initial.done); yield initial.value; await failure.promise; throw new GatewayError('UNAVAILABLE'); }
      finally { await source.return?.(); }
    } } });
  const gateway = new GatewayCoordinator(), route = remote.sessionRoute(target.session), release = gateway.register(route), off = remote.onUnavailable(() => losses++);
  const first = gateway.watchSession(f.identity, target), second = gateway.watchSession(f.identity, target), healthy = gateway.watchInteractions(f.identity, target);
  let recovered: typeof first | undefined;
  try {
    await first.next(); await second.next(); await healthy.next(); assert.equal(opens, 1);
    failure.resolve(); await assert.rejects(first.next(), { code: 'UNAVAILABLE' }); await assert.rejects(second.next(), { code: 'UNAVAILABLE' });
    await until(() => f.session.listeners.size === 0);
    recovered = gateway.watchSession(f.identity, target); assert.equal((await recovered.next()).value?.scope.session, target.session); assert.equal(opens, 2);
    f.session.state = { ...f.session.state, scope: { ...scope, session: 'foreign' } }; f.session.emit();
    await assert.rejects(recovered.next(), { code: 'FENCED' });
    assert.equal(losses, 0); assert.equal(gateway.observation.subscribers, 1, 'Only the healthy interaction observer remains admitted');
    assert.equal((await route.interactions!.snapshot(scope)).items.length, 0);
    assert.equal(f.stats.nativeRead + f.stats.older + f.stats.recover + f.stats.refresh + f.session.submits.length, 0);
  } finally { failure.resolve(); await first.return(); await second.return(); await healthy.return(); await recovered?.return(); off(); release(); remote.close(); gateway.close(); await f.close(); }
});

test('remote snapshot keys include the exact run and late retired feed completion cannot replace its successor', async () => {
  const f = await remoteFixture(), late = deferred<void>(); let opens = 0, mcpOpens = 0;
  const remote = createRemoteHost({ target: f.hostTarget, expected: f.host.manifest, creationTarget: f.creation.target,
    identity: f.identity, actions: f.actions, port: { ...f.port, async *watch(identity, operation, signal) {
      if (operation.path === 'multiplex.mcpWatch') mcpOpens++;
      if (operation.path !== 'multiplex.sessionWatch' || ++opens !== 1) { yield* f.port.watch(identity, operation, signal); return; }
      const source = f.port.watch(identity, operation, signal)[Symbol.asyncIterator]();
      try { const initial = await source.next(); assert(!initial.done); yield initial.value; await late.promise; yield { ...f.session.state, revision: 999 }; }
      finally { await source.return?.(); }
    } } });
  const route = remote.sessionRoute(target.session), releases: (() => void)[] = [], old: number[] = [], current: number[] = [];
  try {
    const first = route.session.subscribe(scope, value => old.push(value.revision)); releases.push(first); await until(() => old.length === 1);
    first(); releases.push(route.session.subscribe(scope, value => current.push(value.revision))); await until(() => current.length === 1);
    late.resolve(); await setImmediate(); f.session.emit(); await until(() => current.length === 2);
    assert.equal(old.length, 1); assert(!current.includes(999)); assert.equal(f.session.listeners.size, 1);
    let baseline = 0; releases.push(route.session.subscribe(scope, value => { baseline = value.revision; })); assert.equal(baseline, current.at(-1)); assert.equal(opens, 2);
    let mcpValues = 0;
    releases.push(route.mcp!.subscribe(f.run, () => mcpValues++)); releases.push(route.mcp!.subscribe({ ...f.run }, () => mcpValues++));
    await until(() => mcpValues === 2); assert.equal(mcpOpens, 1);
    releases.push(route.mcp!.subscribe({ ...f.run, generation: f.run.generation + 1 }, () => mcpValues++));
    await until(() => mcpOpens === 2); assert.equal(f.session.submits.length, 0);
  } finally { late.resolve(); for (const release of releases) release(); remote.close(); await until(() => f.session.listeners.size === 0); await f.close(); }
});

test('private login link crosses the authenticated Host facade and Peer Gateway query only with read plus control', async () => {
  const f = await remoteFixture(), read = f.remote(['read']), control = f.remote(['read', 'control']), gateway = new GatewayCoordinator();
  const calls: { run: RunRef; originalId: string }[] = [];
  const link = { state: 'available' as const, status: 'initiated' as const, authorizationUrl: 'https://fixture.invalid/authorize?code=private-display', expiresInMs: 1000 };
  Object.assign(f.session, { async mcpLoginLink(run: RunRef, originalId: string) { calls.push({ run, originalId }); return link; } });
  gateway.register(control.sessionRoute(target.session));
  const router = createP2pGatewayRouter(gateway, () => f.identity);
  const caller = router.createCaller({ p2p: { peer: {}, auth: {} } } as PeerContext);
  // The actual router and authenticated facade run in-process; this fixture
  // supplies only the published Peer's typed unary-query seam, no endpoint.
  const peer = { rpc: { mcpLoginLink: { query: caller.mcpLoginLink } } } as unknown as Peer<GatewayP2pRouter>;
  const transport = new P2pGatewayTransport(peer);
  try {
    assert.equal(hostFacadeAction('multiplex.mcpLoginLink', 'query'), 'control');
    assert.throws(() => hostFacadeAction('multiplex.mcpLoginLink', 'mutation'), /FORBIDDEN/);
    await assert.rejects(read.sessionRoute(target.session).session.mcpLoginLink!(f.run, 'login-original'));
    assert.equal(calls.length, 0, 'Read-only access never reaches the private link owner');
    assert.deepEqual(await transport.mcpLoginLink(target, f.run, 'login-original'), link);
    assert.deepEqual(await transport.mcpLoginLink(target, f.run, 'login-original'), link);
    assert.deepEqual(calls, [{ run: f.run, originalId: 'login-original' }, { run: f.run, originalId: 'login-original' }], 'Each explicit lookup reaches the exact current owner without a cached URL');
    assert.equal(f.session.submits.length, 0, 'Private display reads do not create or replay a login original');
    assert.equal(JSON.stringify(await gateway.snapshot(f.identity, target)).includes(link.authorizationUrl), false);
  } finally { transport.close(); read.close(); control.close(); gateway.close(); await f.close(); }
});

test('returning quiet remote history aborts its exact upstream before queued generator completion', async () => {
  const f = await remoteFixture(), remote = f.remote(), route = remote.sessionRoute(target.session);
  let stream: ReturnType<typeof route.history.watch> | undefined, pending: Promise<unknown> | undefined, returning: Promise<unknown> | undefined;
  try {
    stream = route.history.watch(historyScope);
    assert.equal((await stream.next()).done, false);
    assert.equal(f.history.owner(historyScope).subscriberCount, 1);
    pending = stream.next();
    await setImmediate(); // The actual Host now waits for another capture frame.
    returning = stream.return!();
    await setImmediate(); // Drain the existing abort/return callbacks, not a deadline.
    assert.equal(f.history.owner(historyScope).subscriberCount, 0, 'Viewer return must release a quiet Host subscription without another native event');
    assert.deepEqual(await pending, { done: true, value: undefined });
    assert.deepEqual(await returning, { done: true, value: undefined });
    assert.equal(f.stats.nativeRead + f.stats.older + f.stats.recover, 0);
    assert.equal(f.session.submits.length, 0);
  } finally {
    // Independent route lifetime aborts the old source even in the red case.
    remote.close(); await stream?.return?.(); await pending; await returning; await f.close();
  }
});

test('direct Host proofs preserve distinct Create, control, read-exception and MCP ceilings', async () => {
  const f = await remoteFixture();
  const read = f.remote(['read']), catalog = f.remote(['read', 'catalogWrite']), control = f.remote(['read', 'control']);
  try {
    const original = f.original();
    await assert.rejects(read.creation.create(original)); assert.equal(f.stats.creates, 0);
    assert.equal((await catalog.creation.create(original)).state, 'created');
    assert.equal((await read.creation.read(original)).state, 'created'); assert.equal(f.stats.creates, 1);
    await assert.rejects(catalog.sessionRoute(target.session).session.submit(request())); assert.equal(f.session.submits.length, 0);
    const route = read.sessionRoute(target.session);
    await route.history.older!(historyScope, 'explicit'); assert.equal(f.stats.older, 1);
    await assert.rejects(route.mcp!.refresh(f.run)); assert.equal(f.stats.refresh, 0);
    await control.sessionRoute(target.session).session.submit(request()); assert.equal(f.session.submits.length, 1);
    // A proof from an incorrectly configured issuer cannot widen the receiver's
    // independently configured procedure policy.
    const secret = randomBytes(32), broad = createHmacHostProof({ issuer: 'i', audience: 'a', secret });
    const strict = createHmacHostProof({ issuer: 'i', audience: 'a', secret, actionForProcedure: hostFacadeAction });
    const operation = f.request('create', { original });
    const token = broad.issue({ ...f.identity, actions: ['control'] }, operation, 'mutation');
    assert.equal(strict.verify(token, operation.path, 'mutation'), null);
    // Scope and manifest are proved independently of reachability.
    await assert.rejects(f.port.call(f.identity, { ...f.request('snapshot', { session: target.session }), target: { ...f.hostTarget, owner: 'foreign' }, type: 'query' }));
    await assert.rejects(f.port.call(f.identity, { ...f.request('snapshot', { session: target.session }), expected: { ...f.host.manifest, compositionId: 'stale' }, type: 'query' }));
    await assert.rejects(f.port.call(f.identity, { ...f.request('snapshot', { session: target.session }), session: { id: 'foreign', generation: 1 }, type: 'query' }));
    await assert.rejects(f.port.call(f.identity, { ...f.request('snapshot', { session: target.session }), session: { id: target.session, generation: 2 }, type: 'query' }));
    await assert.rejects(f.port.call({ ...f.identity, principal: 'foreign' }, { ...f.request('list', {}), type: 'query' }));
  } finally { read.close(); catalog.close(); control.close(); await f.close(); }
});

test('one Gateway mounts direct Host owners; capture/reconnect/unmount neither read native history nor replay originals', async () => {
  const f = await remoteFixture(), remote = f.remote(), gateway = new GatewayCoordinator(), mount = mountRemoteHost(gateway, remote);
  let frames: AsyncIterableIterator<unknown> | undefined;
  try {
    await mount.ready;
    assert.deepEqual(await gateway.binding(f.identity, target), { run: f.run, history: historyScope });
    assert.deepEqual(await gateway.historyScopes(f.identity, target), [historyScope]);
    frames = gateway.watchHistory(f.identity, { target, scope: historyScope });
    assert.equal((await frames.next()).done, false);
    f.history.emit(historyScope, [{ type: 'start', id: 'streamed', kind: 'assistant', text: 'retained capture' }]);
    assert.equal((await frames.next()).done, false);
    assert.equal(f.stats.older + f.stats.recover + f.stats.nativeRead + f.stats.refresh, 0);
    await gateway.submit(f.identity, target, request('one-original'));
    assert.equal((await gateway.receipt(f.identity, target, 'one-original'))!.id, 'one-original');
    await frames.return?.(); frames = undefined;
    const before = f.session.submits.length;
    mount.close(); await mount.settled;
    assert.equal(f.session.submits.length, before); assert.equal(f.session.state.phase, 'running');
    const remount = mountRemoteHost(gateway, remote);
    try {
      await remount.ready;
      assert.equal((await gateway.receipt(f.identity, target, 'one-original'))!.id, 'one-original');
      assert.equal(f.session.submits.length, 1);
      const view = gateway.watchSession(f.identity, target); await view.next();
      f.remove(); await until(() => gateway.observation.subscribers === 0);
      await assert.rejects(view.next());
      await assert.rejects(async () => gateway.snapshot(f.identity, target));
    } finally { remount.close(); await remount.settled; }
    assert.equal(f.stats.older + f.stats.recover + f.stats.nativeRead + f.stats.refresh, 0);
    // Files are deliberately unavailable, rather than borrowing control or
    // fabricating a local file store for a remote native session.
    assert.equal(remote.sessionRoute(target.session).files, undefined);
  } finally { await frames?.return?.(); mount.close(); remote.close(); gateway.close(); await f.close(); }
});

test('lost remote Create reply reads the exact Host original; canceled recovery leaves admitted work with its owner', async () => {
  const f = await remoteFixture(); let lose = true;
  const remote = createRemoteHost({ target: f.hostTarget, expected: f.host.manifest, creationTarget: f.original().target,
    identity: f.identity, actions: f.actions, port: { ...f.port, async call(identity, operation) {
      const value = await f.port.call(identity, operation);
      if (lose && operation.path === 'multiplex.create') { lose = false; throw Error('lost after one actual owner effect'); }
      return value;
    } } });
  const route = remote.sessionRoute(target.session), gate = f.holdRecovery(), cancellation = new AbortController();
  try {
    const original = f.original(); await assert.rejects(remote.creation.create(original));
    assert.equal((await remote.creation.read(original)).state, 'created'); assert.equal(f.stats.creates, 1);
    const pending = route.history.recover!(historyScope, { signal: cancellation.signal });
    void pending.catch(() => {}); await until(() => f.stats.recover === 1); cancellation.abort();
    await assert.rejects(pending, /CANCELLED/); assert.equal(f.stats.recover, 1);
    assert.equal((await f.host.readiness()).ready, false);
    assert.equal((await route.session.snapshot(scope)).phase, 'running');
    remote.close(); gate.resolve(); await setImmediate();
    assert.equal((await f.host.readiness()).ready, true); assert.equal(f.session.submits.length, 0);
  } finally { gate.resolve(); remote.close(); await f.close(); }
});

test('Host route ceiling is enforced independently; facade close releases its observers without native Stop', async () => {
  const f = await remoteFixture({ routeActions: ['read'] }), remote = f.remote(), route = remote.sessionRoute(target.session);
  try {
    await assert.rejects(route.session.submit(request())); assert.equal(f.session.submits.length, 0);
    let snapshots = 0; const release = route.session.subscribe(scope, () => snapshots++);
    await until(() => snapshots === 1); assert.equal(f.session.listeners.size, 1);
    f.facade.close(); await until(() => f.session.listeners.size === 0); release();
    assert.equal(f.session.state.phase, 'running'); assert.equal(f.session.submits.length, 0);
  } finally { remote.close(); await f.close(); }
});

test('positive remote Create admission is explicit and never falls back to legacy completion', async () => {
  const f = await remoteFixture(), legacy = f.remote(); let admissions = 0;
  const remote = createRemoteHost({ target: f.hostTarget, expected: f.host.manifest, creationTarget: f.creation.target,
    identity: f.identity, actions: f.actions, port: f.port, positiveCreationAdmission: true });
  try {
    assert.equal(legacy.creation.createAdmitted, undefined);
    await assert.rejects(remote.creation.createAdmitted!(f.original())); assert.equal(f.stats.creates, 0);
    f.creation.createAdmitted = async () => { admissions++; return { state: 'pending' }; };
    assert.deepEqual(await remote.creation.createAdmitted!(f.original()), { state: 'pending' });
    assert.equal(admissions, 1); assert.equal(f.stats.creates, 0);
  } finally { remote.close(); legacy.close(); await f.close(); }
});

test('generic control RPC cannot tunnel through the reserved facade to bypass catalogWrite ceilings', async () => {
  const f = await remoteFixture(), gateway = new GatewayCoordinator();
  gateway.registerHostRpc({ target: f.hostTarget, port: f.port, actions: ['read', 'control'] });
  try {
    await assert.rejects(async () => gateway.rpcCall(f.identity, { ...f.request('create', { original: f.original() }), type: 'mutation' }), /FORBIDDEN/);
    assert.throws(() => gateway.watchRpc(f.identity, f.request('creationWatch', { original: f.original() })), /FORBIDDEN/);
    await assert.rejects(async () => gateway.rpcCall(f.identity, { ...f.request('list', {}), path: 'multiplexFiles.mutate', input: { method: 'begin' }, type: 'mutation' }), /FORBIDDEN/);
    assert.throws(() => gateway.watchRpc(f.identity, { ...f.request('list', {}), path: 'multiplexFiles.download' }), /FORBIDDEN/);
    assert.equal(f.stats.creates, 0);
    const normal = await gateway.rpcCall(f.identity, { ...f.request('list', { prefix: '' }), path: 'extensions.workspace.inspect', type: 'query' });
    assert.equal(normal.ok, true);
  } finally { gateway.close(); await f.close(); }
});

test('only exact read-only descriptor can refresh a stale epoch; every durable fence and expiry remains mandatory', async () => {
  const f = await remoteFixture();
  try {
    const stale = { ...f.request('describe', {}), target: { ...f.hostTarget, routeEpoch: 'earlier-route' } };
    const token = f.proof.issue(f.identity, stale, 'query');
    const call = f.proof.descriptorRead(token, { target: f.hostTarget, manifest: f.host.manifest }); assert(call);
    const context = await f.host.context(call); assert.equal(context.route.routeEpoch, f.hostTarget.routeEpoch); assert.deepEqual(context.identity.actions, ['read']);
    await assert.rejects(f.host.context({ proof: { authorization: token, path: stale.path, type: 'query' }, expected: stale.expected }));
    const wrongOwner = f.proof.issue(f.identity, { ...stale, target: { ...stale.target, owner: 'other-owner' } }, 'query');
    assert.equal(f.proof.descriptorRead(wrongOwner, { target: f.hostTarget, manifest: f.host.manifest }), null);
    const wrongManifest = f.proof.issue(f.identity, { ...stale, expected: { ...stale.expected, compositionId: 'different' } }, 'query');
    assert.equal(f.proof.descriptorRead(wrongManifest, { target: f.hostTarget, manifest: f.host.manifest }), null);
    assert.throws(() => f.proof.issue({ ...f.identity, actions: ['control'] }, stale, 'query'), /FORBIDDEN/);
    const otherPath = f.proof.issue(f.identity, { ...stale, path: 'multiplex.snapshot', input: { session: target.session } }, 'query');
    assert.equal(f.proof.descriptorRead(otherPath, { target: f.hostTarget, manifest: f.host.manifest }), null);
    let now = 1000;
    const clock = createHmacHostProof({ issuer: 'i', audience: 'a', secret: randomBytes(32), now: () => now, actionForProcedure: hostFacadeAction });
    const short = clock.issue(f.identity, stale, 'query', 10); now = 1010;
    assert.equal(clock.descriptorRead(short, { target: f.hostTarget, manifest: f.host.manifest }), null);
    const advancing = createHmacHostProof({ issuer: 'i', audience: 'a', secret: randomBytes(32), now: () => ++now, actionForProcedure: hostFacadeAction });
    const original = advancing.issue(f.identity, stale, 'query', 100), before = advancing.verify(original, stale.path, 'query')!;
    const descriptor = advancing.descriptorRead(original, { target: f.hostTarget, manifest: f.host.manifest })!;
    const after = advancing.verify((descriptor.proof as { authorization: string }).authorization, stale.path, 'query')!;
    assert.equal(after.expiresAt, before.expiresAt);
    assert.equal(f.stats.creates + f.stats.older + f.stats.recover + f.stats.nativeRead + f.stats.refresh + f.session.submits.length, 0);
  } finally { await f.close(); }
});
