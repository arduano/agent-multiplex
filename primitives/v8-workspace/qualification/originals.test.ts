import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryDraftPersistence, draftKey, type ComposerOriginal } from '../../v8-files/src/client/persistence.js';
import { FileError, type ArtifactRef, type FilePort } from '../../v8-files/src/contracts/types.js';
import { digest } from '../../v8-files/src/contracts/content.js';
import { scopeKey, type Receipt } from '../../v8-session/src/contracts/types.js';
import { workspaceFixture, deferred } from './fixture.js';

test('unmounted retained originals serialize exact terminal local settlement; lost replies and held writes cannot release selected files', async () => {
  const persistence = new MemoryDraftPersistence(), gate = deferred<void>();
  const original = persistence.original.bind(persistence); let settlements = 0;
  persistence.original = async (...args: Parameters<MemoryDraftPersistence['original']>) => {
    if (args[3] === 'settle' && ++settlements === 1) await gate.promise;
    return original(...args);
  };
  const f = workspaceFixture({ persistence });
  const readReceipt = f.native.receipt.bind(f.native);
  let receiptsAvailable = false;
  f.native.receipt = (scope, id) => receiptsAvailable ? readReceipt(scope, id) : Promise.resolve(null);
  try {
    await f.open(); const fileScope = f.workspace.fileScope('a'), scope = f.bindings.get('a')!.run.scope;
    const blob = new Blob(['private-local-file']), manifest = { id: 'selected', name: 'selected.txt', mediaType: 'text/plain', bytes: blob.size, sha256: await digest(new Uint8Array(await blob.arrayBuffer())) };
    await persistence.put({ key: draftKey(fileScope, manifest.id), scope: fileScope, manifest, blob, revision: 0, phase: 'committed', operationIds: [], artifact: { ...manifest, kind: 'artifact', owner: fileScope, capturedAt: 1 } }, 0);
    await f.workspace.reloadFiles('a');
    f.native.invoke = async request => {
      const receipt: Receipt = { scope, id: request.id, type: 'send', generation: request.generation, state: 'acknowledged', outcome: { status: 'accepted' } };
      f.native.receipts.set(`${scopeKey(scope)}:${request.id}`, receipt); throw Error('reply lost');
    };
    const composer = f.workspace.composer('a'); composer.edit({ text: 'draft stays', fileIds: ['selected'] }); await composer.flush();
    await assert.rejects(f.workspace.clearFile('a', 'selected', (await persistence.get(fileScope, 'selected'))!.revision), { code: 'BUSY' });
    for (const id of ['first', 'second']) {
      const reference = f.workspace.receiptReference('a', id);
      await composer.protect(reference, fileScope, ['selected']);
      const send = f.workspace.submitSend('a', reference, { type: 'send', text: id }); await assert.rejects(send.result);
    }
    assert.equal(composer.getSnapshot().originals.length, 2); assert.equal(settlements, 0);
    composer.edit({ text: 'draft stays', fileIds: [] }); await composer.flush();
    let retained = (await persistence.get(fileScope, 'selected'))!;
    await assert.rejects(f.workspace.clearFile('a', 'selected', retained.revision), { code: 'BUSY' });
    // Automatic reconciliation may read early. The original premise is that
    // neither final receipt is observable before both file holds are durable.
    receiptsAvailable = true;
    await Promise.all([f.workspace.checkReceipt('a', 'first'), f.workspace.checkReceipt('a', 'second')]);
    for (let i = 0; i < 100 && settlements === 0; i++) await new Promise(done => setTimeout(done, 1));
    assert.equal(settlements, 1, 'one held write owns the settlement slot');
    assert.deepEqual((await persistence.get(fileScope, 'selected'))!.operationIds, ['first', 'second']);
    gate.resolve();
    for (let i = 0; i < 100 && composer.getSnapshot().originals.length; i++) await new Promise(done => setTimeout(done, 1));
    assert.equal(settlements, 2); assert.deepEqual(composer.getSnapshot().originals, []);
    assert.equal(composer.getSnapshot().value.text, 'draft stays');
    retained = (await persistence.get(fileScope, 'selected'))!; assert.deepEqual(retained.operationIds, []);
    await f.workspace.clearFile('a', 'selected', retained.revision); assert.equal(await persistence.get(fileScope, 'selected'), undefined);
    assert.equal(f.native.submitted.length, 2); assert.equal(f.counts().streams, 0, 'settlement does not require a mounted UI listener');
  } finally { gate.resolve(); f.workspace.close(); }
});

test('retained Send preparation coalesces one edit across views, freezes selection and preserves newer intent', async () => {
  const persistence = new MemoryDraftPersistence(), entered = deferred<void>(), gate = deferred<void>(), receiptGate = deferred<void>();
  const write = persistence.putComposer.bind(persistence);
  let hold = true;
  persistence.putComposer = async (...args) => { if (hold) { entered.resolve(); await gate.promise; } return write(...args); };
  const f = workspaceFixture({ persistence });
  try {
    const { a } = await f.open();
    const secondView = f.workspace.view('a', 'other-panel'), invoke = f.native.invoke;
    assert.ok(invoke);
    f.native.invoke = async request => { await receiptGate.promise; return invoke(request); };
    a.viewport.userScroll('earlier', false); a.viewport.report({ rowId: 'row', offsetPx: 12 });
    secondView.viewport.userScroll('earlier', false); secondView.viewport.report({ rowId: 'row', offsetPx: 24 });
    const state = a.getSnapshot(); if (state.kind !== 'codex') throw Error('Expected Codex');
    assert.equal(state.sendReady, true, 'native readiness is independent of an empty draft');
    state.actions.setSelectionDraft({ kind: 'codex', model: 'captured-model' });
    a.setDraft('captured message'); await entered.promise;
    const first = a.sendDraft(), second = secondView.sendDraft();
    assert.equal(first, second);
    const preparing = a.getSnapshot(); if (preparing.kind === 'disposed') throw Error('Disposed');
    assert.equal(preparing.sendPreparation.state, 'preparing');
    assert.equal(preparing.sendReady, true, 'the retained preparation owns its separate local readiness');
    a.setDraft('newer draft');
    state.actions.setSelectionDraft({ kind: 'codex', model: 'later-model' });
    assert.throws(() => a.sendDraft(), { code: 'BUSY' });
    hold = false; gate.resolve();
    const operation = await first;
    const admitted = a.getSnapshot(), other = secondView.getSnapshot(); if (admitted.kind === 'disposed' || other.kind === 'disposed') throw Error('Disposed');
    assert.equal(admitted.history.viewport.intent, 'followingLive', 'The initiating view follows on local original admission, before the held receipt');
    assert.equal(other.history.viewport.intent, 'readingHistory', 'A coalesced second view does not steal or duplicate the follow callback');
    a.viewport.userScroll('earlier', false); a.viewport.report({ rowId: 'row', offsetPx: 12 });
    receiptGate.resolve(); await operation.result;
    const settled = a.getSnapshot(); if (settled.kind === 'disposed') throw Error('Disposed'); assert.equal(settled.history.viewport.intent, 'readingHistory', 'Late native receipts cannot override a newer reading gesture');
    const request = f.native.submitted.find(value => value.command.type === 'send')!;
    assert.equal(request.command.type, 'send');
    if (request.command.type !== 'send') throw Error('Expected Send');
    assert.equal(request.command.text, 'captured message');
    assert.equal(request.command.selection!.model, 'captured-model');
    assert.equal(f.native.submitted.filter(value => value.command.type === 'send').length, 1);
    assert.equal(f.workspace.composer('a').getSnapshot().value.text, 'newer draft');
  } finally { gate.resolve(); receiptGate.resolve(); f.workspace.close(); }
});

test('a same-position reading gesture during verified attachment preparation fences only the deferred follow', async () => {
  const { ClientFixturePort } = await import('../../v8-files/qualification/client-fixture.js');
  const port = new ClientFixturePort(), entered = deferred<void>(), gate = deferred<void>(), call = port.call.bind(port);
  port.call = async (method, input) => { if (method === 'commit') { entered.resolve(); await gate.promise; } return call(method, input); };
  const f = workspaceFixture({ files: port }); let release: (() => void) | undefined;
  try {
    const { b } = await f.open(), native = f.snapshot('b'); release = b.observe().release;
    f.native.publish(native.scope, { activity: 'working', capabilities: { ...native.capabilities, commands: [...native.capabilities.commands, 'copilot.steer'] } });
    b.viewport.userScroll('earlier', false); b.viewport.report({ rowId: 'row', offsetPx: 0 });
    const file = await b.saveFile({ name: 'document.txt', mediaType: 'text/plain', blob: new Blob(['verified attachment']) });
    b.setDraft({ text: 'steer with attachment', fileIds: [file.manifest.id] }); const preparation = b.submitDraft('steer'); await entered.promise;
    // No geometry or anchor changed: the viewport owner's gesture identity must
    // still distinguish this newer instruction to keep reading.
    b.viewport.userScroll('earlier', false); gate.resolve();
    const operation = await preparation; await operation.result;
    const state = b.getSnapshot(); if (state.kind !== 'copilot') throw Error('Copilot required');
    assert.equal(state.history.viewport.intent, 'readingHistory'); assert.equal(state.history.viewport.anchor?.rowId, 'row');
    assert.equal(operation.request.command.type, 'copilot.steer'); assert.equal(f.native.submitted.length, 1);
  } finally { gate.resolve(); release?.(); f.workspace.close(); }
});

test('local Stop fences a held preparation immediately; quiet new generation needs a new Send intent', async () => {
  const persistence = new MemoryDraftPersistence(), entered = deferred<void>(), gate = deferred<void>();
  const write = persistence.putComposer.bind(persistence);
  let hold = true;
  persistence.putComposer = async (...args) => { if (hold) { entered.resolve(); await gate.promise; } return write(...args); };
  const f = workspaceFixture({ persistence });
  try {
    const { a } = await f.open(); a.setDraft('retained stopped intent'); await entered.promise;
    const pending = a.sendDraft();
    const stopped = a.getSnapshot(); if (stopped.kind !== 'codex') throw Error('Expected Codex');
    await stopped.actions.stop().result;
    assert.equal(f.native.submitted.filter(value => value.command.type === 'send').length, 0);
    f.advance(); await f.workspace.rebind('a');
    hold = false; gate.resolve(); await assert.rejects(pending, { code: 'FENCED' });
    assert.equal(f.native.submitted.filter(value => value.command.type === 'send').length, 0);
    assert.equal(f.workspace.composer('a').getSnapshot().value.text, 'retained stopped intent');
    const next = a.sendDraft();
    assert.throws(() => stopped.actions.stop(), { code: 'FENCED' });
    const fresh = await next; await fresh.result;
    assert.equal(fresh.request.generation, 2);
    assert.equal(f.native.submitted.filter(value => value.command.type === 'send').length, 1);
  } finally { gate.resolve(); f.workspace.close(); }
});


test('auth close drains provably unhanded protection after commit without retaining private views or clearing other originals', async () => {
  const persistence = new MemoryDraftPersistence(), entered = deferred<void>(), gate = deferred<void>(), persistenceClosed = deferred<void>();
  const write = persistence.original.bind(persistence), read = persistence.getComposer.bind(persistence);
  let closed = false, closes = 0, hold = false, protectedReference: ComposerOriginal | undefined, artifact!: ArtifactRef;
  persistence.original = async (...args: Parameters<MemoryDraftPersistence['original']>) => {
    if (closed) throw new FileError('CLOSED');
    const saved = await write(...args);
    if (hold && args[3] === 'protect') { protectedReference = args[2]; entered.resolve(); await gate.promise; }
    return saved;
  };
  persistence.getComposer = async scope => { if (closed) throw new FileError('CLOSED'); return read(scope); };
  persistence.close = () => { closed = true; closes++; persistenceClosed.resolve(); };
  const files: FilePort = { call: (async (method: string) => {
    if (method === 'status') return { state: 'committed', artifact };
    throw Error('Unexpected file operation');
  }) as FilePort['call'] };
  const f = workspaceFixture({ persistence, files });
  try {
    const { b } = await f.open(), composer = f.workspace.composer('b'), fileScope = f.workspace.fileScope('b');
    const blob = new Blob(['retained private bytes']), manifest = { id: 'selected', name: 'selected.txt', mediaType: 'text/plain', bytes: blob.size, sha256: await digest(new Uint8Array(await blob.arrayBuffer())) };
    artifact = { ...manifest, kind: 'artifact', owner: fileScope, capturedAt: 1 };
    await persistence.put({ key: draftKey(fileScope, manifest.id), scope: fileScope, manifest, blob, revision: 0, phase: 'committed', operationIds: [], artifact }, 0);
    await f.workspace.reloadFiles('b'); composer.edit({ text: 'retained intent', fileIds: ['selected'] }); await composer.flush();
    const other = f.workspace.receiptReference('b', 'earlier-unknown');
    await composer.protect(other, fileScope, ['selected']);
    hold = true;
    const pending = b.sendDraft(), refused = assert.rejects(pending, { code: 'CLOSED' });
    await entered.promise;
    assert.ok(protectedReference);
    assert.deepEqual((await persistence.get(fileScope, 'selected'))!.operationIds, [other.id, protectedReference.id]);
    f.workspace.close();
    assert.deepEqual(b.getSnapshot(), { kind: 'disposed' });
    assert.equal(composer.getSnapshot().state, 'disposed'); assert.deepEqual(composer.getSnapshot().originals, []);
    assert.equal(closes, 0, 'only persistence lifetime survives the current preparation');
    assert.equal(f.counts().closed, 1, 'routes close immediately');
    assert.equal(f.native.submitted.length, 0);
    gate.resolve(); await refused; await persistenceClosed.promise;
    assert.equal(closes, 1); assert.equal(f.native.submitted.length, 0);
    assert.deepEqual((await persistence.get(fileScope, 'selected'))!.operationIds, [other.id]);
    closed = false; hold = false;
    const reopened = workspaceFixture({ persistence, files });
    try {
      await reopened.open();
      const restored = reopened.workspace.composer('b').getSnapshot();
      assert.deepEqual(restored.value, { text: 'retained intent', fileIds: ['selected'] });
      assert.deepEqual(restored.originals, [other]); assert.equal(reopened.native.submitted.length, 0);
    } finally { reopened.workspace.close(); }
    assert.equal(closes, 2, 'idle namespace closes persistence synchronously');
  } finally { gate.resolve(); f.workspace.close(); }
});

test('one authoring slot freezes a Codex steering turn across held upload and rejects a competing Queue without consuming newer intent', async () => {
  const { ClientFixturePort } = await import('../../v8-files/qualification/client-fixture.js');
  const { HistoryHub } = await import('../../v8-history/src/host/history-owner.js');
  const { createCodexCodec } = await import('../../v8-history/src/native/codex/index.js');
  const port = new ClientFixturePort(), entered = deferred<void>(), gate = deferred<void>(), call = port.call.bind(port);
  port.call = async (method, input) => { if (method === 'commit') { entered.resolve(); await gate.promise; } return call(method, input); };
  const f = workspaceFixture({ files: port });
  let release: (() => void) | undefined;
  try {
    const { a } = await f.open(), binding = f.bindings.get('a')!, root = binding.history;
    if (root.kind !== 'codex') throw Error('Codex required');
    release = a.observe().release;
    const hub = new HistoryHub(), codec = createCodexCodec({ origin: root.origin, rootThreadId: root.threadId, capture: hub, knownStart: true });
    hub.owner(root).setScopeInventory({ nativeGeneration: binding.run.generation, entries: [{ scope: root }] });
    const turn = (id: string) => { codec.observe({ method: 'turn/started', params: { threadId: root.threadId, turn: { id, status: 'inProgress', items: [], itemsView: 'notLoaded' } } }); f.history.session(root).client.apply({ kind: 'snapshot', snapshot: hub.snapshot(root) }); };
    turn('captured-turn'); const native = f.snapshot('a');
    f.native.publish(native.scope, { activity: 'working', capabilities: { ...native.capabilities, commands: [...native.capabilities.commands, 'codex.steer', 'codex.queue.add'] } });
    const state = a.getSnapshot(); if (state.kind !== 'codex') throw Error('Codex required'); state.actions.setSelectionDraft({ kind: 'codex', model: 'next-turn-only' });
    const bytes = Uint8Array.from([137,80,78,71,13,10,26,10,...new Array<number>(16).fill(0)]);
    const file = await a.saveFile({ name: 'image.png', mediaType: 'image/png', blob: new Blob([bytes]) }); a.setDraft({ text: 'steer with image', fileIds: [file.manifest.id] });
    const available = a.getSnapshot(); if (available.kind !== 'codex') throw Error('Codex required');
    assert.deepEqual(available.draftActions, { send: false, steer: true, queue: true });
    assert.throws(() => a.submitDraft('send'), { code: 'FENCED' }, 'Actual admission matches the working primary action projection');
    const work = a.submitDraft('steer'); assert.equal(f.workspace.view('a', 'second').submitDraft('steer'), work);
    assert.throws(() => f.workspace.view('a', 'second').submitDraft('queue'), { code: 'BUSY' });
    await entered.promise; turn('replacement-turn'); a.setDraft({ text: 'newer unsent draft', fileIds: [file.manifest.id] }); gate.resolve();
    await assert.rejects(work, { code: 'FENCED' }); assert.equal(f.native.submitted.length, 0); assert.equal(f.workspace.composer('a').getSnapshot().originals.length, 0);
    const next = await a.submitDraft('steer'); await next.result;
    const command = next.request.command; assert.equal(command.type, 'codex.steer'); if (command.type !== 'codex.steer') throw Error('Wrong action');
    assert.equal(command.expectedTurnId, 'replacement-turn'); assert.equal(command.inputs?.kind, 'codex'); assert.equal(command.inputs?.items.length, 1); assert.equal('selection' in command, false);
    const latest = a.getSnapshot(); if (latest.kind !== 'codex') throw Error('Codex required'); assert.equal(latest.session.draft?.model, 'next-turn-only'); assert.deepEqual(latest.composer.value, { text: '', fileIds: [] });
  } finally { gate.resolve(); release?.(); f.workspace.close(); }
});

test('Copilot steer and explicit Queue share draft protection and attachments; reload cannot resubmit a protected captured edit', async () => {
  const { ClientFixturePort } = await import('../../v8-files/qualification/client-fixture.js');
  const persistence = new MemoryDraftPersistence(), saved = persistence.putComposer.bind(persistence), port = new ClientFixturePort();
  let failConsume = true;
  persistence.putComposer = async (record, revision) => { if (failConsume && record.value.text === '' && record.originals.some(value => value.reference.edit !== undefined)) throw new FileError('IO', 'scripted consume write loss'); return saved(record, revision); };
  const f = workspaceFixture({ persistence, files: port }); let fresh: ReturnType<typeof workspaceFixture> | undefined;
  try {
    const { b } = await f.open(), native = f.snapshot('b');
    f.native.publish(native.scope, { activity: 'working', capabilities: { ...native.capabilities, commands: [...native.capabilities.commands, 'copilot.steer'] } });
    f.native.invoke = async () => { throw Error('lost steering response'); };
    const file = await b.saveFile({ name: 'document.txt', mediaType: 'text/plain', blob: new Blob(['verified attachment']) }); b.setDraft({ text: 'immediate draft', fileIds: [file.manifest.id] });
    const operation = await b.submitDraft('steer'); await assert.rejects(operation.result);
    assert.equal(operation.request.command.type, 'copilot.steer'); assert.equal('inputs' in operation.request.command && operation.request.command.inputs?.kind, 'copilot');
    const retained = f.workspace.composer('b').getSnapshot().originals[0]!; assert.equal(retained.type, 'copilot.steer'); assert.equal(typeof retained.edit, 'number');
    f.workspace.close(); failConsume = false;
    fresh = workspaceFixture({ persistence, files: port }); const view = await fresh.workspace.open('b'), current = fresh.snapshot('b');
    fresh.native.publish(current.scope, { activity: 'working', capabilities: { ...current.capabilities, commands: [...current.capabilities.commands, 'copilot.steer'] } });
    const observed = view.getSnapshot(); if (observed.kind !== 'copilot') throw Error('Copilot required'); assert.equal(observed.composer.value.text, 'immediate draft'); assert.equal(observed.draftActions.steer, false);
    assert.throws(() => view.submitDraft('steer'), { code: 'BUSY' }); assert.equal(fresh.native.submitted.length, 0);
    view.setDraft('new explicit intent');
    const receipt: Receipt = { scope: current.scope, id: operation.id, type: 'copilot.steer', generation: current.generation, state: 'acknowledged', outcome: { status: 'accepted' } };
    fresh.native.receipts.set(`${scopeKey(current.scope)}:${operation.id}`, receipt); await view.checkReceipt(operation.id);
    const queued = await view.submitDraft('queue'); await queued.result; assert.equal(queued.request.command.type, 'send'); assert.equal('selection' in queued.request.command, false); assert.equal(fresh.native.submitted.length, 1);
  } finally { f.workspace.close(); fresh?.workspace.close(); }
});
