import { ReadonlyHistories } from '../src/history-view.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceFixture, deferred } from './fixture.js';
import { scopeKey } from '../../v8-session/src/contracts/types.js';
import { digest } from '../../v8-files/src/contracts/content.js';
import type { FilePort, ArtifactRef } from '../../v8-files/src/contracts/types.js';
import { GatewayCoordinator } from '../../v8-gateway/src/gateway/coordinator.js';
import { GatewayError } from '../../v8-gateway/src/contracts/types.js';

test('a fifth read waits for actual Gateway capacity and completes the same workspace open without another readiness event', async () => {
  const gate = deferred<void>(), entered = deferred<void>();
  let gateway!: GatewayCoordinator, identity!: Parameters<GatewayCoordinator['snapshot']>[0], target!: Parameters<GatewayCoordinator['snapshot']>[1];
  const f = workspaceFixture({ domainRead: async domain => { if (domain === 'interactions') { entered.resolve(); await gateway.snapshot(identity, target); } } });
  const binding = f.bindings.get('a')!, native = f.native;
  identity = { connection: binding.run.scope.connection, principal: binding.run.scope.principal, authorities: ['authority'], actions: ['read'] };
  target = { ...binding.run.scope, authority: 'authority', owner: 'durable-owner', routeEpoch: 'read-capacity' };
  gateway = new GatewayCoordinator();
  gateway.register({ target, session: {
    snapshot: async () => { await gate.promise; return f.snapshot('a'); },
    submit: value => native.submit(value), receipt: (scope, id) => native.receipt(scope, id), subscribe: (scope, emit) => native.subscribe(scope, emit),
  }, history: { watch() { throw new Error('No history body read'); } }, authorizeHistory: () => false });
  const active = Array.from({ length: 4 }, () => gateway.snapshot(identity, target));
  let state = 'opening';
  const opening = f.workspace.open('a'); void opening.then(() => { state = 'opened'; }, error => { state = error.code; });
  try {
    assert.equal(f.workspace.open('a'), opening, 'Concurrent views retain the same acquisition');
    await entered.promise; await new Promise(resolve => setImmediate(resolve));
    assert.equal(state, 'opening'); assert.equal(gateway.observation.optionalReads, 4);
    gate.resolve(); await Promise.all(active);
    const view = await opening, snapshot = view.getSnapshot(); assert.equal(snapshot.kind, 'codex');
    const lease = view.observe(); lease.release();
    assert.equal(f.counts().submitted, 0); assert.equal(f.counts().discovery, 0); assert.equal(f.counts().older, 0);
    assert.equal(gateway.observation.optionalReads, 0);
  } finally { gate.resolve(); await Promise.allSettled(active); f.workspace.close(); gateway.close(); await opening.catch(() => {}); }
});

test('transient initial MCP snapshot failure retains its real observation without making session history fatal', async () => {
  const f = workspaceFixture({ domainRead: async domain => { if (domain === 'mcp') throw new GatewayError('UNAVAILABLE'); } });
  try {
    const view = await f.workspace.open('a'), initial = view.getSnapshot();
    if (initial.kind === 'disposed') throw new Error('Disposed');
    assert.equal(initial.mcp, null); assert.equal(initial.mcpStale, true); assert.equal(f.counts().mcpSubscriptions, 1);
    const lease = view.observe(); const observed = view.getSnapshot(); if (observed.kind === 'disposed') throw new Error('Disposed');
    assert.deepEqual(observed.history.rows.map(row => row.id), ['row']);
    const run = f.bindings.get('a')!.run; f.mcps.get('a')!.invalidate(run);
    const changed = view.getSnapshot(); if (changed.kind === 'disposed') throw new Error('Disposed');
    assert.equal(changed.mcp?.freshness, 'stale'); assert.equal(changed.mcpStale, true);
    assert.equal(f.counts().submitted, 0); assert.equal(f.counts().discovery, 0); assert.equal(f.counts().older, 0); lease.release();
  } finally { f.workspace.close(); assert.equal(f.counts().mcpSubscriptions, 0); }
});

test('optional MCP bootstrap never hides terminal faults, namespace close or a native run replaced during its read', async () => {
  for (const code of ['FENCED', 'FORBIDDEN', 'INVALID'] as const) {
    const f = workspaceFixture({ domainRead: async domain => { if (domain === 'mcp') throw new GatewayError(code); } });
    try { await assert.rejects(f.workspace.open('a'), { code }); assert.equal(f.counts().submitted, 0); }
    finally { f.workspace.close(); }
  }
  for (const change of ['close', 'run'] as const) {
    const gate = deferred<void>(), entered = deferred<void>();
    const f = workspaceFixture({ domainRead: async domain => { if (domain === 'mcp') { entered.resolve(); await gate.promise; throw new GatewayError('UNAVAILABLE'); } } });
    const opening = f.workspace.open('a'), rejected = assert.rejects(opening, { code: change === 'close' ? 'CLOSED' : 'FENCED' });
    try { await entered.promise; if (change === 'close') f.workspace.close(); else f.advance('a'); gate.resolve(); await rejected; assert.equal(f.counts().submitted, 0); }
    finally { gate.resolve(); f.workspace.close(); }
  }
});

test('explicit authenticated bootstrap composes actual clients; stable view reads acquire no references or discovery', async () => {
  const f = workspaceFixture(); f.observation({ scope: f.bindings.get('a')!.run.scope, kind: 'session', state: 'live' });
  try { const { a, b } = await f.open(); assert.equal(a.getSnapshot().kind, 'codex'); assert.equal(b.getSnapshot().kind, 'copilot'); const initial = a.getSnapshot(); if (initial.kind === 'disposed') throw new Error('Disposed'); assert.equal(initial.observation.session, 'live', 'Pre-bootstrap admission is retained'); assert.equal(a.getSnapshot(), a.getSnapshot());
    const before = f.counts(); for (let i = 0; i < 10; i++) a.getServerSnapshot(); assert.deepEqual(f.counts(), before); assert.equal(before.streams, 0); assert.equal(before.discovery, 0); assert.equal(before.submitted, 0);
    assert.equal(f.history.session(f.bindings.get('a')!.history).mountedReferences, 0); await f.workspace.refreshMcp('a'); assert.equal(f.counts().discovery, 1);
    const lease = a.observe(); a.setDraft('keep during history interruption'); f.workspace.setPinned('a', true); lease.release();
    const scope = f.bindings.get('a')!.run.scope; f.observation({ scope, kind: 'session', state: 'live' });
    const held = f.holdHistoryFeed('a'); let state = a.getSnapshot(); if (state.kind === 'disposed') throw new Error('Disposed'); assert.deepEqual(state.observation, { session: 'live', history: 'connecting' });
    f.observation({ scope: { ...scope, principal: 'foreign' }, kind: 'history', state: 'unavailable' }); assert.equal(a.getSnapshot(), state);
    f.closeHistoryFeed('a'); await held; state = a.getSnapshot(); if (state.kind === 'disposed') throw new Error('Disposed');
    assert.deepEqual(state.observation, { session: 'live', history: 'unavailable' }); assert.equal(state.session.native!.phase, 'running'); assert.equal(state.history.rows.length, 1); assert.equal(state.composer.value.text, 'keep during history interruption'); assert.equal(state.logical.pinned, true); assert.equal(f.counts().submitted, 0); assert.equal(f.counts().older, 0);
  } finally { f.workspace.close(); }
});
test('A/B/A and stale lease cleanup preserve actual draft/context; pin alone retains the real shared stream', async () => {
  const f = workspaceFixture(); try { const { a, b } = await f.open(); const old = a.observe(); a.setDraft({ text: 'keep', fileIds: ['intent'] });
    const history = f.history.session(f.bindings.get('a')!.history); a.setExpanded('row', true); a.viewport.report({ rowId: 'row', offsetPx: 42 }); f.workspace.setPinned('a', true);
    const current = a.observe(), other = b.observe(); old.release(); old.release(); assert.equal(history.mountedReferences, 1); current.release(); other.release();
    assert.equal(history.backgroundReferenceHeld, true); assert.equal(f.counts().streams, 1); const state = a.getSnapshot(); assert.notEqual(state.kind, 'disposed'); if (state.kind === 'disposed') return;
    assert.deepEqual(state.composer.value, { text: 'keep', fileIds: ['intent'] }); assert.deepEqual(state.history.expansions, ['row']); assert.equal(state.history.viewport.anchor!.offsetPx, 42);
    f.workspace.setPinned('a', false); assert.equal(f.counts().streams, 0); assert.equal(f.counts().submitted, 0); assert.equal(f.history.size, 2);
  } finally { f.workspace.close(); }
});
test('genuine callback surface yields one original status without private answers in any composite snapshot', async () => {
  const f = workspaceFixture(); try { const { b } = await f.open(); const binding = f.bindings.get('b')!; let answered = '';
    const prompt = f.owners.get('b')!.registerCopilot({ token: {}, requestId: null, owner: { nativeAgent: binding.run.nativeSession, relation: 'root' }, method: 'userInput', payload: { question: 'Secret?', allowFreeform: true }, respond: async answer => { answered = String((answer as { answer: string }).answer); return { kind: 'ack', success: true }; } });
    if (prompt.type !== 'copilot.question') throw new Error('Wrong scripted prompt');
    const handle = b.respond(prompt, { type: 'copilot.question', answer: 'PRIVATE_ANSWER_629', wasFreeform: true }, 'original-answer');
    const sending = b.getSnapshot(); if (sending.kind === 'disposed') assert.fail('Disposed');
    assert.equal(sending.confirmationResponses.length, 1); assert.equal(sending.confirmationResponses[0]!.interactionId, prompt.id); assert.equal(sending.confirmationResponses[0]!.id, handle.id); assert.equal(sending.confirmationResponses[0]!.state, 'sending');
    assert.equal(JSON.stringify(sending.confirmationResponses).includes('PRIVATE_ANSWER_629'), false);
    await handle.result;
    assert.equal(answered, 'PRIVATE_ANSWER_629'); const state = b.getSnapshot(); assert.notEqual(state.kind, 'disposed'); if (state.kind === 'disposed') return;
    assert.deepEqual(state.operations, [{ id: 'original-answer', type: 'answer', generation: 1, state: 'acknowledged', outcome: { status: 'acknowledged' } }]); assert.equal(state.confirmationResponses[0]!.interactionId, prompt.id); assert.equal(state.confirmationResponses[0]!.receipt!.id, 'original-answer'); assert.equal(state.confirmationResponses[0]!.state, 'observed'); assert.equal(JSON.stringify(state).includes('PRIVATE_ANSWER_629'), false); assert.equal(f.native.submitted.length, 1);
  } finally { f.workspace.close(); }
});
test('lost Send reply retains one original and explicit receipt observation converges without replay', async () => {
  const f = workspaceFixture(); try { const { a } = await f.open(); f.native.invoke = async request => { f.native.receipts.set(`${scopeKey(request.scope)}:${request.id}`, { scope: request.scope, id: request.id, type: request.command.type, generation: request.generation, state: 'acknowledged' }); throw new Error('lost reply'); };
    const agent = a.getSnapshot(); if (agent.kind !== 'codex' || !agent.actions.send) throw new Error('Missing native action'); const send = agent.actions.send('original Send'); await assert.rejects(send.result);
    await f.workspace.open('b'); await f.workspace.checkReceipt('a', send.id); const state = a.getSnapshot(); if (state.kind === 'disposed') throw new Error('Disposed');
    assert.equal(state.operations.length, 1); assert.equal(state.operations[0]!.state, 'acknowledged'); assert.equal(f.native.submitted.length, 1); assert.equal(f.history.session(f.bindings.get('a')!.history).operations.length, 1);
  } finally { f.workspace.close(); }
});
test('lost archive reply retains one original across selection; metadata publication retries cannot repeat retirement or drop loaded history', async () => {
  let f!: ReturnType<typeof workspaceFixture>, publications = 0;
  f = workspaceFixture({ publishArchive: async request => {
    publications++;
    const receipt = f.native.receipts.get(`${scopeKey(f.bindings.get('a')!.run.scope)}:${request.id}`);
    assert.equal(receipt?.type, 'archive'); assert.equal(receipt?.state, 'acknowledged'); assert.equal(receipt.generation, request.generation);
    if (publications === 1) throw Error('Publication unavailable');
    const entry = f.workspace.list().rows.find(row => row.entry.session === request.session)!.entry;
    return entry.archive ? entry : { ...entry, version: entry.version + 1, archive: { id: request.id, generation: request.generation } };
  } });
  try {
    const { a } = await f.open(), lease = a.observe(), native = f.snapshot('a');
    a.setDraft('Retained archived draft'); a.viewport.report({ rowId: 'row', offsetPx: 19 }); f.workspace.setPinned('a', true);
    f.native.publish(native.scope, { phase: 'stopped' });
    f.native.invoke = async request => {
      assert.equal(request.command.type, 'archive');
      f.native.publish(request.scope, { archive: { id: request.id, state: 'complete' } });
      f.native.receipts.set(`${scopeKey(request.scope)}:${request.id}`, { scope: request.scope, id: request.id, type: 'archive', generation: request.generation, state: 'acknowledged' });
      throw Error('Archive reply lost');
    };
    const state = a.getSnapshot(); if (state.kind !== 'codex') assert.fail('Expected Codex');
    const original = state.actions.archive(); await assert.rejects(original.result);
    lease.release(); await f.workspace.open('b'); assert.equal(f.workspace.view('a'), a);
    const receipt = await f.workspace.checkReceipt('a', original.id); assert.equal(receipt?.state, 'acknowledged');
    await assert.rejects(f.workspace.publishArchive('a', original.id, native.generation));
    assert.equal(f.workspace.list().rows.find(row => row.entry.session === 'a')!.entry.archive, undefined);
    const published = await f.workspace.publishArchive('a', original.id, native.generation);
    assert.deepEqual(await f.workspace.publishArchive('a', original.id, native.generation), published);
    const retained = a.getSnapshot(); if (retained.kind !== 'codex') assert.fail('Expected Codex');
    assert.equal(retained.logical.entry?.archive?.id, original.id); assert.equal(retained.logical.pinned, true);
    assert.equal(retained.operations.length, 1); assert.equal(retained.operations[0]!.state, 'acknowledged');
    assert.equal(retained.composer.value.text, 'Retained archived draft'); assert.equal(retained.history.rows[0]?.body.kind, 'complete');
    assert.equal(retained.history.viewport.anchor?.offsetPx, 19); assert.equal(f.native.submitted.length, 1);
    assert.equal(f.counts().streams, 0, 'Pins retain local pages without reacquiring an archived Host stream');
    assert.equal(f.counts().older, 0); assert.equal(f.counts().discovery, 0);
  } finally { f.workspace.close(); }
});
test('auth disposal overrides retained snapshots and stale actions even when a consumer throws; late binding cannot publish', async () => {
  const f = workspaceFixture(); const { a } = await f.open(); const state = a.getSnapshot(); const release = a.subscribe(() => { throw new Error('consumer'); }); const lease = a.observe(); a.setDraft('private draft'); const queued = state.kind === 'codex' ? state.actions.send?.('queued-before-disposal') : undefined; f.workspace.close();
  if (queued) await assert.rejects(queued.result, { code: 'CLOSED' }); assert.equal(f.counts().submitted, 0);
  assert.deepEqual(a.getSnapshot(), { kind: 'disposed' }); assert.equal(f.counts().streams, 0); assert.equal(f.counts().closed, 1); if (state.kind === 'codex') assert.throws(() => state.actions.send?.('late'), { code: 'CLOSED' }); lease.release(); release();
  const gate = deferred<void>(), late = workspaceFixture({ bindingGate: gate.promise }); const work = late.workspace.open('a'); await new Promise(done => setTimeout(done, 0)); late.workspace.close(); gate.resolve(); await assert.rejects(work, { code: 'CLOSED' }); assert.equal(late.counts().submitted, 0);
});
test('late private preview is rejected after auth fence and its exact acquired capability still releases', async () => {
  const gate = deferred<void>(), bytes = new TextEncoder().encode('private file'); let reads = 0, releases = 0; let artifact!: ArtifactRef;
  const port: FilePort = { call: (async (method: string) => { if (method === 'acquire') return { leaseId: 'owned-lease', artifact }; if (method === 'read') { reads++; await gate.promise; return bytes; } if (method === 'release') { releases++; return; } throw new Error('Unexpected file call'); }) as FilePort['call'] };
  const f = workspaceFixture({ files: port }); const { a } = await f.open(); artifact = { kind: 'artifact', owner: { ...f.bindings.get('a')!.run.scope, session: 'native-a' }, id: 'file', name: 'file.txt', mediaType: 'text/plain', bytes: bytes.length, sha256: await digest(bytes), capturedAt: 1 };
  const preview = f.workspace.previewFile('a', artifact); while (!reads) await new Promise(done => setTimeout(done, 0)); f.workspace.close(); gate.resolve(); await assert.rejects(preview, { code: 'CLOSED' }); assert.equal(releases, 1); assert.deepEqual(a.getSnapshot(), { kind: 'disposed' });
});
test('viewport work is inert and explicit older paging coalesces into the chosen retained slot only', async () => {
  const f = workspaceFixture(); try { const { a } = await f.open(), lease = a.observe(), side = f.workspace.view('a', 'side');
    a.viewport.userScroll('earlier', false); a.viewport.report({ rowId: 'row', offsetPx: 12 }); const restore = a.viewport.beginRestore()!; a.viewport.correct(restore, { rowTop: 12, viewportTop: 0, scrollTop: 0 }); assert.equal(f.counts().older, 0);
    const first = a.loadOlder(), second = a.loadOlder(); assert.equal(first, second); assert.equal(await first, 'applied'); assert.equal(f.counts().older, 1);
    const main = a.getSnapshot(), other = side.getSnapshot(); if (main.kind === 'disposed' || other.kind === 'disposed') throw new Error('Disposed');
    assert.deepEqual(main.history.rows.map(row => row.id), ['older', 'row']); assert.deepEqual(other.history.rows.map(row => row.id), ['row']);
    assert.equal(f.workspace.view('a'), a); lease.release();
  } finally { f.workspace.close(); }
});
test('Create local admission throws before a Promise; an admitted transport failure retains the one original', async () => {
  const f = workspaceFixture({ maxSessions: 1 });
  try {
    const original = f.createRequest();
    assert.throws(() => f.workspace.create({ ...original, metadata: { ...original.metadata, cwd: 'x'.repeat(4097) } }), { code: 'INVALID' });
    assert.equal(f.counts().catalogEffects, 0);
    const pending = f.workspace.create(original);
    assert.ok(pending instanceof Promise);
    assert.doesNotThrow(() => f.workspace.prepareCreation(original.session));
    await assert.rejects(pending, /No create in fixture/);
    assert.equal(f.counts().catalogEffects, 1);
    assert.doesNotThrow(() => f.workspace.prepareCreation(original.session));
    assert.equal(await f.workspace.checkCreation(original.session), null);
    assert.deepEqual(f.creationReads, [original.id]);
    assert.equal(f.counts().catalogEffects, 1, 'Checking the admitted original cannot call Create again');
    assert.throws(() => f.workspace.create({ ...original, id: 'create-b', session: 'b' }), { code: 'FULL' });
    assert.equal(f.counts().catalogEffects, 1, 'Capacity failure cannot reach the Create port');
  } finally { f.workspace.close(); }
});
test('pending Create checks only its immutable original; streamed binding opens without polling and closed checks are fenced', async () => {
  const gate = deferred<void>(), f = workspaceFixture({ createGate: gate.promise });
  try {
    const original = f.createRequest(), pending = await f.workspace.create(original); assert.equal(pending.state, 'dispatching');
    await assert.rejects(f.workspace.open('a'), { code: 'FENCED' });
    assert.deepEqual(await f.workspace.checkCreation('a'), { id: original.id, session: 'a', state: 'dispatching', publication: 'pending', binding: null });
    gate.resolve(); await Promise.resolve(); const settled = await f.workspace.checkCreation('a'); assert.equal(settled!.state, 'nativeCreated'); assert.ok(settled!.binding);
    const view = await f.workspace.open('a'); assert.equal(view.getSnapshot().kind, 'codex'); assert.equal(f.counts().catalogEffects, 1); assert.deepEqual(f.creationReads, [original.id, original.id]); assert.equal(f.counts().submitted, 0);
  } finally { f.workspace.close(); }
  const streamGate = deferred<void>(), streamed = workspaceFixture({ createGate: streamGate.promise });
  try {
    await streamed.workspace.create(streamed.createRequest()); const initial = streamed.workspace.creationStatus('a'); assert.equal(initial!.binding, null);
    const observed = deferred<NonNullable<ReturnType<typeof streamed.workspace.creationStatus>>>(); let notifications = 0;
    const unsubscribe = streamed.workspace.subscribeCreation('a', status => { notifications++; if (status?.binding) observed.resolve(status); });
    streamGate.resolve(); const status = await observed.promise; assert.equal(status.state, 'dispatching'); assert.ok(status.binding); assert.equal(streamed.workspace.creationStatus('a')!.binding, status.binding);
    assert.equal((await streamed.workspace.open('a')).getSnapshot().kind, 'codex'); assert.equal(streamed.counts().catalogEffects, 1); assert.deepEqual(streamed.creationReads, []);
    streamed.workspace.close(); assert.ok(notifications > 1); assert.throws(() => streamed.workspace.creationStatus('a'), { code: 'CLOSED' }); unsubscribe();
  } finally { streamed.workspace.close(); }
  const create = deferred<void>(), read = deferred<void>(), late = workspaceFixture({ createGate: create.promise, creationReadGate: read.promise });
  await late.workspace.create(late.createRequest()); const check = late.workspace.checkCreation('a'); await Promise.resolve(); late.workspace.close(); create.resolve(); read.resolve(); await assert.rejects(check, { code: 'CLOSED' }); assert.equal(late.counts().catalogEffects, 1);
});
test('rebind publishes prepared domains atomically; held/failed reads remain renderable and attachment changes retain actual view slots', async () => {
  const interactionEntered = deferred<void>(), interactionGate = deferred<void>(), mcpEntered = deferred<void>(), mcpGate = deferred<void>();
  let failMcp = false;
  const f = workspaceFixture({ domainRead: async (domain, run) => {
    if (run.generation === 2 && domain === 'interactions') { interactionEntered.resolve(); await interactionGate.promise; }
    if (run.generation === 2 && domain === 'mcp') { mcpEntered.resolve(); await mcpGate.promise; }
    if (run.generation === 3 && domain === 'mcp' && failMcp) throw new Error('held domain unavailable');
  } });
  const errors: unknown[] = [];
  try {
    const { a } = await f.open(), lease = a.observe(); a.setDraft('retained across native attachment'); f.workspace.setPinned('a', true); await a.loadOlder(); a.setExpanded('row', true); a.viewport.report({ rowId: 'row', offsetPx: 19 });
    const retained = f.history.session(f.bindings.get('a')!.history).client.view();
    const unsubscribe = a.subscribe(() => { try { a.getSnapshot(); } catch (error) { errors.push(error); } });
    let responses = 0;
    const question = () => f.owners.get('a')!.registerCodex({ token: {}, requestId: 'native-question', owner: { nativeAgent: 'native-a', relation: 'root' }, method: 'item/tool/requestUserInput', params: { threadId: 'native-a', turnId: 'turn', itemId: 'question', isBlocking: true, questions: [{ id: 'q', header: 'Continue', question: 'Continue?', isOther: false, isSecret: false, options: [{ label: 'Continue', description: 'Proceed' }] }] }, respond: async () => { responses++; return { kind: 'ack', success: true }; } });
    const oldPrompt = question(); if (oldPrompt.type !== 'codex.question') throw new Error('Wrong scripted prompt');
    const next = f.advance(), prompt = question(); if (prompt.type !== 'codex.question') throw new Error('Wrong scripted prompt'); const pending = f.workspace.rebind('a'); await interactionEntered.promise;
    let state = a.getSnapshot(); if (state.kind === 'disposed') throw new Error('Disposed'); assert.equal(state.session.native!.generation, 2); assert.equal(state.session.native!.phase, 'running'); assert.equal(state.bindingTransition!.state, 'preparing'); assert.equal(state.mcp!.run.generation, 1); assert.equal(state.composer.value.text, 'retained across native attachment'); assert.equal(state.logical.pinned, true);
    assert.throws(() => a.respond(oldPrompt, { type: 'codex.question', answers: { q: ['Continue'] } }), { code: 'FENCED' });
    interactionGate.resolve(); await mcpEntered.promise; state = a.getSnapshot(); if (state.kind === 'disposed') throw new Error('Disposed'); assert.equal(state.confirmations!.run.generation, 2); assert.equal(state.mcp!.run.generation, 1); assert.equal(state.bindingTransition!.state, 'preparing');
    const answer = a.respond(prompt, { type: 'codex.question', answers: { q: ['Continue'] } }, 'answer-during-mcp-preparation'); await answer.result; assert.equal(responses, 1); assert.equal(f.native.submitted.length, 1); assert.equal(f.native.submitted[0]!.generation, 2); assert.equal(f.native.submitted[0]!.command.type, 'answer'); assert.equal(f.counts().discovery, 0);
    mcpGate.resolve(); assert.equal(await pending, a); state = a.getSnapshot(); if (state.kind === 'disposed') throw new Error('Disposed'); assert.equal(state.bindingTransition, null); assert.equal(state.mcp!.run.generation, 2); assert.equal(state.confirmations!.run.generation, 2); assert.equal(f.history.session(next.history).client.view(), retained); assert.deepEqual(state.history.rows.map(row => row.id), ['older', 'row']); assert.equal(state.history.current!.scope.origin.attachment, next.history.origin.attachment); assert.equal(state.history.includesPriorGeneration, true); assert.equal(state.history.viewport.anchor!.offsetPx, 19); assert.deepEqual(state.history.expansions, ['row']);
    failMcp = true; f.advance(); await assert.rejects(f.workspace.rebind('a'), /held domain unavailable/); state = a.getSnapshot(); if (state.kind === 'disposed') throw new Error('Disposed'); assert.equal(state.session.native!.generation, 3); assert.equal(state.bindingTransition!.state, 'unavailable'); assert.equal(state.mcp!.run.generation, 2); assert.deepEqual(state.history.rows.map(row => row.id), ['older', 'row']); assert.equal(state.logical.pinned, true);
    failMcp = false; assert.equal(await f.workspace.rebind('a'), a); state = a.getSnapshot(); if (state.kind === 'disposed') throw new Error('Disposed'); assert.equal(state.mcp!.run.generation, 3); assert.equal(state.bindingTransition, null); assert.equal(f.counts().submitted, 1); assert.equal(f.counts().discovery, 0); assert.equal(f.counts().older, 1); assert.deepEqual(errors, []); unsubscribe(); lease.release();
  } finally { f.workspace.close(); }
  const entered = deferred<void>(), held = deferred<void>(), late = workspaceFixture({ domainRead: async (_, run) => { if (run.generation === 2) { entered.resolve(); await held.promise; } } });
  const { a } = await late.open(); late.advance(); const pending = late.workspace.rebind('a'); await entered.promise; late.workspace.close(); held.resolve(); await assert.rejects(pending, { code: 'CLOSED' }); assert.deepEqual(a.getSnapshot(), { kind: 'disposed' });
  const staleEntered = deferred<void>(), staleGate = deferred<void>(), stale = workspaceFixture({ domainRead: async (_, run) => { if (run.generation === 2) { staleEntered.resolve(); await staleGate.promise; } } });
  try {
    const { a: view } = await stale.open(); stale.advance(); const work = stale.workspace.rebind('a'); await staleEntered.promise; stale.native.publish(stale.bindings.get('a')!.run.scope, { generation: 3 }); staleGate.resolve(); await assert.rejects(work, { code: 'FENCED' });
    const state = view.getSnapshot(); if (state.kind === 'disposed') throw new Error('Disposed'); assert.equal(state.session.native!.generation, 3); assert.equal(state.bindingTransition!.state, 'unavailable'); assert.equal(state.mcp!.run.generation, 1); assert.equal(stale.counts().submitted, 0);
  } finally { stale.workspace.close(); }
});

test('successful repeated native rebind retires exact old MCP subscriptions without exhausting retained capacity', async () => {
  const f = workspaceFixture({ maxSessions: 2 });
  try {
    const { a } = await f.open(); assert.equal(f.counts().mcpSubscriptions, 2);
    for (let generation = 2; generation <= 8; generation++) {
      f.advance(); await f.workspace.rebind('a');
      const state = a.getSnapshot(); if (state.kind === 'disposed') throw new Error('Disposed');
      assert.equal(state.mcp!.run.generation, generation); assert.equal(f.counts().mcpSubscriptions, 2);
      assert.equal(f.counts().mcpReleases, generation - 1);
    }
    assert.equal(f.counts().discovery, 0); assert.equal(f.counts().submitted, 0);
  } finally { f.workspace.close(); }
  assert.equal(f.counts().mcpSubscriptions, 0);
});

test('link loss during held candidate MCP read cannot publish a fresh replacement or lose retained facts', async () => {
  const entered = deferred<void>(), held = deferred<void>();
  const f = workspaceFixture({ domainRead: async (domain, run) => { if (domain === 'mcp' && run.generation === 2) { entered.resolve(); await held.promise; } } });
  try {
    const { a } = await f.open(); f.advance(); const binding = f.workspace.rebind('a'); await entered.promise;
    f.workspace.disconnect(); held.resolve(); await assert.rejects(binding, { code: 'IO' });
    const offline = a.getSnapshot(); if (offline.kind === 'disposed') throw new Error('Disposed');
    assert.equal(offline.session.connected, false); assert.equal(offline.mcp!.run.generation, 1); assert.equal(offline.mcpStale, true);
    assert.equal(offline.bindingTransition!.state, 'unavailable'); assert.equal(f.counts().mcpSubscriptions, 2);
    f.workspace.reconnect(); await f.workspace.rebind('a'); const recovered = a.getSnapshot();
    if (recovered.kind === 'disposed') throw new Error('Disposed');
    assert.equal(recovered.mcp!.run.generation, 2); assert.equal(recovered.bindingTransition, null);
    assert.equal(f.counts().mcpSubscriptions, 2); assert.equal(f.counts().submitted, 0);
  } finally { held.resolve(); f.workspace.close(); }
});


test('auth disposal drains remaining owners after child cleanup failure and reconciles only failed cleanup on repeated close', async () => {
  const f = workspaceFixture(), actual = ReadonlyHistories.prototype.close; let fail = true;
  try {
    const { a } = await f.open(), lease = a.observe();
    ReadonlyHistories.prototype.close = function () { f.workspace.close(); actual.call(this); if (fail) { fail = false; throw Error('Exact child release failed'); } };
    assert.throws(() => f.workspace.close(), AggregateError); assert.equal(a.getSnapshot().kind, 'disposed');
    assert.equal(f.counts().closed, 1); assert.equal(f.counts().streams, 0); assert.equal(f.counts().mcpSubscriptions, 0);
    f.workspace.close(); lease.release(); assert.equal(f.counts().closed, 1);
  } finally { ReadonlyHistories.prototype.close = actual; f.workspace.close(); }
});
