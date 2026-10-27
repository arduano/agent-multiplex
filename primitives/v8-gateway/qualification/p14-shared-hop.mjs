import assert from 'node:assert/strict';
import { randomBytes, createPrivateKey, sign, createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAdvancedP2PNode } from '@arduano/p2prpc-core/advanced';
import { createSharedSecretSecurity, verifyPinnedSignedTicket } from '@arduano/p2prpc-core';
import { createP14EndpointHarness } from './p14-endpoint.mjs';

const lane = fileURLToPath(new URL('..', import.meta.url)), framework = resolve(lane, '../..');
const protocol = { applicationId: 'multiplex-v8-p14-shared-hop', contractVersion: '1' };
const caps = Object.freeze({ endpoints: 8, scenarios: 4, eventsPerEndpoint: 8192, deadlineMs: 90000, pagesPerViewer: 8, rowsPerPage: 8 });
const limits = Object.freeze({ shutdownTimeoutMs: 3000, connectTimeoutMs: 8000, handshakeTimeoutMs: 8000, streamHeaderTimeoutMs: 8000 });
const pause = () => new Promise(resolvePause => setTimeout(resolvePause, 5));
const safeCode = cause => ['CANCELLED', 'CLOSED', 'DISCONNECTED', 'OUTCOME_UNKNOWN', 'RESOURCE_LIMIT', 'TIMEOUT', 'UNAUTHORIZED'].includes(cause?.code) ? cause.code : 'operation failed';

/** Real pinned Iroh Root→Host hop, shared by two retained consumers; scripted domains only.
 * The negative control injects one scheduling window, not a historical-cause claim.
 */
export async function runP14SharedHopQualification({ buildRoot = resolve(lane, '.build') } = {}) {
  const deadline = Date.now() + 80000, started = Date.now(), cases = [], events = [], scenarios = [];
  let endpointCount = 0, diagnosticControl = null, failure = null, cleanup = true, activeScenario = 'setup', activeStep = 'module loading';
  const bounded = async (promise, label, maximum = 8000) => {
    activeStep = label;
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`P14 bounded ${label}`)), Math.max(1, Math.min(maximum, deadline - Date.now()))); })]); }
    finally { clearTimeout(timer); }
  };
  const until = async (test, label) => {
    activeStep = label;
    const end = Math.min(Date.now() + 8000, deadline);
    while (!await test()) { if (Date.now() >= end) throw Error(`P14 bounded ${label}`); await pause(); }
  };
  const load = path => import(pathToFileURL(resolve(buildRoot, path)).href);
  const [{ createP2pGatewayRouter, P2pGatewayTransport }, { GatewayCoordinator }, { HistoryHub }, { HistoryWorkspace }, { GatewayClient }, fixture] = await Promise.all([
    load('primitives/v8-gateway/src/node/p2prpc.js'), load('primitives/v8-gateway/src/gateway/coordinator.js'),
    load('primitives/v8-history/src/host/history-owner.js'), load('primitives/v8-history/src/client/workspace.js'),
    load('primitives/v8-gateway/src/client/coordinator.js'), load('primitives/v8-gateway/qualification/fixture.js'),
  ]);
  const { FixtureSession, target, scope, historyScope, alice, request } = fixture;
  const historicalFixturePath = resolve(lane, 'qualification/fixtures/historical-unsafe-subscription.mjs');
  const historicalFixtureSha256 = createHash('sha256').update(await readFile(historicalFixturePath)).digest('hex');
  const { subscriptionIterable } = await import(pathToFileURL(historicalFixturePath).href);
  const version = async name => {
    let path = dirname(fileURLToPath(import.meta.resolve(name)));
    for (let n = 0; n < 6; n++, path = dirname(path)) {
      try { const value = JSON.parse(await readFile(resolve(path, 'package.json'), 'utf8')); if (value.name === name) return value.version; } catch {}
    }
    throw Error('Pinned dependency metadata unavailable');
  };
  const p2prpc = await version('@arduano/p2prpc-core'), iroh = await version('@momics/iroh-http-node');
  assert.equal(p2prpc, '0.3.0-renewal.2'); assert.equal(iroh, '0.6.2');

  const scenario = async (name, run) => {
    activeScenario = name;
    const nodes = [], viewers = [], probes = [], state = { name, passed: false, cleanup: false, injectedScheduling: name === 'negative-control' || name === 'cancellation' };
    const gateway = new GatewayCoordinator(), session = new FixtureSession(), history = new HistoryHub();
    const rootScope = historyScope, helperScope = { ...historyScope, threadId: 'scripted-helper' };
    const workerScopes = ['scripted-worker-0', 'scripted-worker-1'].map(threadId => ({ ...historyScope, threadId }));
    const allowed = [rootScope, helperScope, ...workerScopes], same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const reads = { older: 0, recover: 0, watch: 0 };
    const records = (thread, start, count) => Array.from({ length: count }, (_, index) => ({
      id: `${thread}:row:${start + index}`, kind: 'assistant', lifecycle: 'completed',
      body: { kind: 'complete', text: `Scripted ${thread} history ${start + index}`, evidence: 'nativeFullBody' }, native: {},
    }));
    for (const selected of allowed) {
      history.open(selected);
      const owner = history.owner(selected), fence = owner.beginRead();
      owner.mergeRead(fence, records(selected.threadId, selected === rootScope ? 64 : 0, 8), selected === rootScope ? { state: 'available', cursor: 'page:0' } : { state: 'end', evidence: 'nativeBoundary' }, [], true);
      owner.endRead(fence);
    }
    const older = async (selected, cursor) => {
      reads.older++; assert.ok(allowed.some(value => same(value, selected)));
      const index = Number(/^page:(\d)$/.exec(cursor)?.[1]); assert.ok(Number.isInteger(index) && index >= 0 && index < 8);
      const owner = history.owner(selected), fence = owner.beginRead();
      try { return owner.mergeRead(fence, records(selected.threadId, 56 - index * 8, 8), index === 7 ? { state: 'end', evidence: 'nativeBoundary' } : { state: 'available', cursor: `page:${index + 1}` }, [], false); }
      finally { owner.endRead(fence); }
    };
    gateway.register({ target, session, history: {
      watch: (...args) => { reads.watch++; return history.watch(...args); }, older,
      recover: async () => { reads.recover++; return { state: 'value', value: { status: 'unsupported' } }; },
    }, authorizeHistory: selected => allowed.some(value => same(value, selected)) });
    const pins = new Set(), router = createP2pGatewayRouter(gateway, verified => pins.has(verified.peer.id) && verified.auth.principal.subject === verified.peer.id ? alice : null);
    const secret = randomBytes(32), errors = [];
    const options = (probe, role) => ({ router, protocol, endpointFactory: probe.endpointFactory, createContext: context => context,
      security: createSharedSecretSecurity(secret, { authorize: context => pins.has(context.remotePeerId) && context.principal.id === context.remotePeerId }),
      preAuthorizePeer: peer => pins.has(peer.id), limits,
      onError: error => { if (errors.length < 64) errors.push({ role, code: safeCode(error) }); },
    });
    try {
      const reservation = createSocket('udp4');
      await bounded(new Promise((resolvePort, reject) => { reservation.once('error', reject); reservation.bind(0, '127.0.0.1', resolvePort); }), 'port reservation');
      const hostAddress = `127.0.0.1:${reservation.address().port}`;
      await new Promise(resolvePort => reservation.close(resolvePort));
      const hostKey = randomBytes(32), hostProbe = createP14EndpointHarness({ maxEvents: caps.eventsPerEndpoint, iroh: { secretKey: hostKey, bindAddress: hostAddress } }), rootProbe = createP14EndpointHarness({ maxEvents: caps.eventsPerEndpoint });
      probes.push({ role: 'host', probe: hostProbe }, { role: 'root', probe: rootProbe });
      assert.ok(endpointCount + 2 <= caps.endpoints);
      const startNode = async (probe, role) => {
        let abandoned = false;
        const opening = createAdvancedP2PNode(options(probe, role));
        // A timed-out diagnostic cannot lose a later native endpoint or claim
        // successful cleanup before that endpoint's owner has been observed.
        void opening.then(node => abandoned ? node.close() : undefined, () => {}).catch(() => {});
        try { const node = await bounded(opening, `${role} endpoint`); nodes.push(node); endpointCount++; return node; }
        catch (cause) { abandoned = true; state.unprovedEndpointAdmission = true; throw cause; }
      };
      const host = await startNode(hostProbe, 'host'), root = await startNode(rootProbe, 'root');
      pins.add(root.id); pins.add(host.id);
      const originalTicket = await bounded(host.createTicket(), 'ticket creation');
      const originalBody = JSON.parse(Buffer.from(originalTicket.split('.')[1], 'base64url').toString('utf8'));
      const original = verifyPinnedSignedTicket(originalTicket, { expectedPeerId: host.id, expectedProtocol: originalBody.protocol });
      assert.equal(original.relayUrl, null);
      const issuedAt = Date.now(), body = Buffer.from(JSON.stringify({ ...original, directAddresses: [hostAddress], issuedAt, expiresAt: issuedAt + caps.deadlineMs }));
      const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), hostKey]), format: 'der', type: 'pkcs8' });
      const signature = sign(null, Buffer.concat([Buffer.from('p2prpc-signed-ticket-v3\0'), body]), key), ticket = `p2prpc3.${body.toString('base64url')}.${signature.toString('base64url')}`;
      assert.deepEqual(verifyPinnedSignedTicket(ticket, { expectedPeerId: host.id, expectedProtocol: original.protocol }).directAddresses, [hostAddress]);
      const peer = await bounded(root.connect({ locator: { kind: 'ticket', ticket }, expectedPeerId: host.id, expectedPrincipal: { subject: host.id, issuer: null, clientId: null, tenantId: null } }), 'shared Root Host connection');
      const sessionId = peer.session.id;
      for (let index = 0; index < 2; index++) {
        const transport = new P2pGatewayTransport(peer), workspace = new HistoryWorkspace({ connection: scope.connection, principal: scope.principal });
        const client = new GatewayClient({ transport, history: workspace, targets: [target], onFence() {} });
        const view = workspace.select(rootScope, 'conversation');
        viewers.push({ transport, workspace, client, view, lease: client.observeHistory(scope, rootScope) });
      }
      assert.equal(viewers[0].transport.peer, viewers[1].transport.peer);
      await until(() => viewers.every(viewer => viewer.workspace.session(rootScope).client.current?.rows.length === 8), 'two shared-hop snapshots');
      const assertHealthy = () => {
        // getPeer() may return another public facade over the same connection.
        // Both consumers retain the exact original Peer object above.
        assert.equal(root.getPeer(host.id)?.session.id, sessionId); assert.equal(peer.session.id, sessionId);
        assert.equal(rootProbe.events().filter(event => event.operation === 'connection' && event.phase === 'admitted').length, 1);
        for (const { probe } of probes) {
          assert.equal(probe.events().filter(event => event.operation === 'close').length, 0);
          assert.equal(probe.events().filter(event => event.operation === 'closed' && event.phase !== 'start').length, 0);
        }
      };
      const assertSettled = async expected => {
        let counts;
        await until(async () => {
          assertHealthy();
          const hostPeer = host.getPeer(root.id); assert.ok(hostPeer);
          const [local, remote] = await bounded(Promise.all([peer.diagnostics(), hostPeer.diagnostics()]), 'shared-hop resource diagnostics');
          counts = { rootStreams: local.resources.active.streams, hostStreams: remote.resources.active.streams, rootQueued: local.resources.queued, hostQueued: remote.resources.queued };
          return counts.rootStreams === expected && counts.hostStreams === expected && counts.rootQueued === 0 && counts.hostQueued === 0;
        }, 'cancelled streams release actual transport capacity');
        assertHealthy(); state.preTeardown = { ...counts, physicalCloseRequests: 0, physicalClosures: 0 };
      };
      await run({ gateway, session, history, rootScope, helperScope, workerScopes, peer, root, host, rootProbe, viewers, reads, assertHealthy });
      if (name !== 'negative-control') await assertSettled(name === 'cancellation' ? 1 : 2);
      state.passed = true; state.reads = { ...reads }; state.submits = session.submits.length; state.errors = errors;
    } finally {
      for (const { probe } of probes) probe.releaseAll();
      for (const viewer of viewers) { viewer.lease.release(); viewer.view.release(); viewer.client.fence(); }
      gateway.close();
      let timer;
      const settled = await Promise.race([
        Promise.allSettled(nodes.map(node => node.close())),
        new Promise(resolveCleanup => { timer = setTimeout(() => resolveCleanup(null), 9000); }),
      ]);
      clearTimeout(timer);
      state.cleanup = !state.unprovedEndpointAdmission && !!settled && settled.every(value => value.status === 'fulfilled'); cleanup &&= state.cleanup;
      for (const { role, probe } of probes) {
        const all = probe.events();
        state[`${role}Events`] = all.length; state[`${role}DroppedEvents`] = probe.droppedEvents;
        events.push(...all.filter(event => ['connection', 'close', 'closed', 'openBi.barrier', 'endpoint.close'].includes(event.operation) || event.phase === 'error').map(event => ({ scenario: name, role, ...event })));
        assert.equal(probe.droppedEvents, 0, 'Transport evidence must remain complete');
      }
      scenarios.push(state);
    }
  };

  try {
    await scenario('negative-control', async context => {
      const { peer, rootProbe, helperScope, viewers, reads } = context, barrier = rootProbe.armOpenBarrier(), controller = new AbortController();
      const original = subscriptionIterable(observer => peer.rpc.historyWatch.subscribe({ target, scope: helperScope }, { onData: observer.next, onError: observer.error, onComplete: observer.complete }), controller.signal);
      const iterator = original[Symbol.asyncIterator](), pending = iterator.next();
      void pending.catch(() => {});
      await bounded(barrier.acquired, 'negative native stream acquisition');
      controller.abort(); assert.equal((await bounded(pending, 'original helper cancellation')).done, true);
      await until(() => rootProbe.events().some(event => event.operation === 'close'), 'first physical close');
      const firstPhysicalClose = rootProbe.events().find(event => event.operation === 'close');
      assert.match(firstPhysicalClose.reason, /stream opening was cancelled/);
      assert.ok(firstPhysicalClose.stack.length > 0); barrier.release();
      const before = reads.older;
      await assert.rejects(bounded(viewers[1].transport.older(target, context.rootScope, 'page:0'), 'negative second viewer read'));
      assert.equal(reads.older, before);
      diagnosticControl = { reproduced: true, injectedScheduling: true, retrospectiveCauseProved: false, historicalFixtureSha256, firstPhysicalClose, secondOlderFailed: true };
    });

    for (const order of [[0, 1], [1, 0]]) await scenario(`normal-order-${order.join('-')}`, async context => {
      const { viewers, rootScope, helperScope, workerScopes, reads, assertHealthy } = context;
      for (const index of order) {
        const viewer = viewers[index];
        for (let page = 0; page < 8; page++) {
          const token = viewer.view.view.beginOlderRead();
          const value = await bounded(viewer.client.older(scope, rootScope, token.cursor, token.generation), 'normal older history');
          assert.equal(viewer.view.view.applyPage(value, token), 'applied'); assertHealthy();
        }
        assert.equal(viewer.view.view.getSnapshot().rows.length, 72);
        assert.equal(new Set(viewer.view.view.getSnapshot().rows.map(row => row.id)).size, 72);
        for (const selected of [helperScope, ...workerScopes, rootScope]) {
          viewer.lease.release(); viewer.view.release();
          viewer.view = viewer.workspace.select(selected, 'conversation'); viewer.lease = viewer.client.observeHistory(scope, selected);
          await until(() => viewer.workspace.session(selected).client.current?.rows.length === 8, 'normal child navigation');
          assertHealthy();
        }
        assert.equal(viewer.view.view.getSnapshot().rows.length, 72, 'Retained parent pages survive navigation');
      }
      assert.equal(reads.older, 16); assert.equal(context.session.submits.length, 0); assertHealthy();
      cases.push(`Uninjected viewer order ${order.join(' then ')} loads eight older pages each, navigates the helper and both workers, and retains all 72 parent rows on one unchanged shared hop`);
    });

    await scenario('cancellation', async context => {
      const { rootProbe, viewers, rootScope, helperScope, gateway, reads, history, session, assertHealthy } = context;
      const [a, b] = viewers;
      await bounded(a.client.submit(request('p14-original')), 'one original Send'); assert.equal(session.submits.length, 1);
      let barrier = rootProbe.armOpenBarrier(), controller = new AbortController();
      const watch = a.transport.watchHistory({ target, scope: helperScope }, controller.signal)[Symbol.asyncIterator](), pending = watch.next();
      void pending.catch(() => {});
      await bounded(barrier.acquired, 'safe stream acquisition'); controller.abort();
      assert.equal((await bounded(pending, 'safe stream cancellation')).done, true); assertHealthy(); barrier.release();
      barrier = rootProbe.armOpenBarrier(); controller = new AbortController();
      const recovered = a.transport.recover(target, rootScope, { signal: controller.signal, timeoutMs: 1000 });
      void recovered.catch(() => {});
      await bounded(barrier.acquired, 'recover native stream acquisition');
      const cancelled = assert.rejects(recovered, { code: 'CANCELLED' }); controller.abort(); await bounded(cancelled, 'recover observation cancellation');
      assertHealthy(); barrier.release(); await until(() => reads.recover === 1 && gateway.observation.optionalReads === 0, 'admitted recovery settlement');
      barrier = rootProbe.armOpenBarrier();
      const closing = a.transport.recover(target, rootScope, { timeoutMs: 1000 });
      void closing.catch(() => {});
      await bounded(barrier.acquired, 'closing adapter native stream acquisition');
      const closed = assert.rejects(closing, { code: 'CLOSED' }); a.client.fence(); await bounded(closed, 'adapter close observation');
      assertHealthy(); barrier.release();
      await until(() => reads.recover === 2 && gateway.observation.optionalReads === 0 && gateway.observation.subscribers === 1, 'closed adapter actual read settlement');
      const token = b.view.view.beginOlderRead(), page = await bounded(b.client.older(scope, rootScope, token.cursor, token.generation), 'healthy second viewer older read');
      assert.equal(b.view.view.applyPage(page, token), 'applied');
      history.emit(rootScope, [{ type: 'start', id: 'after-cancellation', kind: 'assistant', text: 'Capture survives viewer cancellation' }, { type: 'finish', id: 'after-cancellation', kind: 'assistant', lifecycle: 'completed', sealCaptured: true }]);
      await until(() => b.workspace.session(rootScope).client.current?.rows.some(row => row.id === 'after-cancellation' && row.lifecycle === 'completed'), 'healthy captured frame');
      assert.equal((await bounded(b.transport.receipt(target, 'p14-original'), 'exact original receipt')).state, 'acknowledged');
      assert.equal(session.reads, 1); assert.equal(session.submits.length, 1); assert.equal(reads.older, 1); assertHealthy();
      cases.push('Acquired-open stream cancellation, recovery abort and adapter close preserve the independent viewer, older read, captured frame and one exact original receipt without another Send');
    });
  } catch (cause) { failure = { code: safeCode(cause), assertion: cause?.code === 'ERR_ASSERTION', scenario: activeScenario, step: activeStep }; }
  const passed = !failure && cleanup && diagnosticControl?.reproduced === true && cases.length === 3;
  return { passed, cases, diagnosticControl, cleanup, scenarios, events, caps, limits,
    endpoints: endpointCount, p2prpc, iroh, elapsedMs: Date.now() - started, failure, historicalFixtureSha256,
    p14: passed ? 'v8-shared-hop-qualified' : 'unqualified', historicalInitialCloseCaller: 'unproved', historicalCombinedAcceptance: 'failed-deferred',
    publishedAdmission: { perPeerStreams: 32, globalStreams: 256, perPrincipalStreams: 64, perPeerQueued: 16, globalQueued: 128, perPrincipalQueued: 32, totalResponseDeadline: false },
    scope: 'Fresh exact-pinned real Iroh shared Root Host physical hop with two retained V8 consumers and scripted domain sources; forced scheduling control does not retrospectively identify the old trace',
    nativeAgentCalls: 0, modelCalls: 0, providerCalls: 0 };
}
