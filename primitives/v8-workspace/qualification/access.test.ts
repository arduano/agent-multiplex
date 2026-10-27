import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayCoordinator } from '../../v8-gateway/src/gateway/coordinator.js';
import { HistoryHub } from '../../v8-history/src/host/history-owner.js';
import { FileHost } from '../../v8-files/src/host/index.js';
import type {} from '../../v8-files/src/host/worker.js';
import type { FilePort } from '../../v8-files/src/contracts/types.js';
import type { WorkspaceAccess } from '../src/contracts.js';
import { workspaceFixture } from './fixture.js';

const readOnly: WorkspaceAccess = { read: true, control: false, fileWrite: false, mcpRefresh: false, catalogWrite: false };

test('read-only Gateway observations preserve native capabilities but deny originals and answers before any local retention', async () => {
  const f = workspaceFixture({ access: () => readOnly }), gateway = new GatewayCoordinator();
  const port = { snapshot: f.native.snapshot.bind(f.native), submit: f.native.submit.bind(f.native), receipt: f.native.receipt.bind(f.native), subscribe: f.native.subscribe.bind(f.native) };
  const identity = { connection: 'fixture', principal: 'owner', authorities: ['authority'], actions: ['read'] as const };
  const target = (session: string) => ({ ...f.bindings.get(session)!.run.scope, authority: 'authority', owner: 'durable-owner', routeEpoch: 'owned-read-only-route' });
  for (const session of ['a', 'b']) {
    const history = new HistoryHub(); history.open(f.bindings.get(session)!.history, { knownStart: true });
    gateway.register({ target: target(session), actions: ['read'], session: port, history, authorizeHistory: () => true });
  }
  f.native.snapshot = scope => gateway.snapshot(identity, target(scope.session));
  f.native.submit = request => Promise.resolve().then(() => gateway.submit(identity, target(request.scope.session), request));
  f.native.receipt = (scope, id) => gateway.receipt(identity, target(scope.session), id);
  try {
    const { a, b } = await f.open(), codex = a.getSnapshot(), copilot = b.getSnapshot();
    if (codex.kind !== 'codex' || copilot.kind !== 'copilot') assert.fail('Expected native views');
    a.setDraft('Read-only retained draft'); await f.workspace.composer('a').flush();
    codex.actions.setSelectionDraft({ kind: 'codex', model: 'local-intent' }); f.workspace.setPinned('a', true);
    const retained = a.getSnapshot(); if (retained.kind !== 'codex') assert.fail('Expected Codex'); assert.equal(retained.sendReady, false);
    assert.deepEqual(codex.session.native!.capabilities, f.snapshot('a').capabilities);
    for (const write of [() => a.sendDraft(), () => codex.actions.send!('denied'), () => codex.actions.stop(), () => codex.actions.resume(), () => codex.actions.archive(), () => codex.actions.setDefaults!({ kind: 'codex' }), () => copilot.actions.setModel!('denied'), () => f.workspace.receiptReference('a', 'denied-reference'), () => f.workspace.create(f.createRequest()), () => f.workspace.renameSession('a', { id: 'rename', revision: 1, name: 'denied' })]) assert.throws(write, { code: 'FENCED' });
    await assert.rejects(f.workspace.refreshMcp('a'), { code: 'FENCED' });
    await assert.rejects(f.workspace.uploadFile('a', 'unadmitted'), { code: 'FENCED' });
    await assert.rejects(f.workspace.captureFile('a', { sourceKey: 'unadmitted', path: 'note.md' }), { code: 'FENCED' });
    let answered = 0;
    const owner = f.owners.get('b')!, run = f.bindings.get('b')!.run;
    owner.registerCopilot({ token: {}, requestId: null, owner: { nativeAgent: run.nativeSession, relation: 'root' }, method: 'userInput', payload: { question: 'Read-only native request', allowFreeform: true }, respond: async () => { answered++; return { kind: 'ack', success: true }; } });
    const prompt = (await owner.snapshot(run.scope)).items[0]!.prompt;
    if (prompt.type !== 'copilot.question') assert.fail('Expected actual native question');
    const form = b.form(prompt); form.update({ answer: 'private local answer' });
    assert.throws(() => b.respond(prompt, { type: 'copilot.question', answer: 'private local answer', wasFreeform: true }), { code: 'FENCED' });
    assert.deepEqual(form.getSnapshot(), { answer: 'private local answer' });
    for (const view of [a, b]) { const state = view.getSnapshot(); if (state.kind === 'disposed') assert.fail('Disposed'); assert.deepEqual(state.operations, []); }
    assert.equal(f.workspace.composer('a').getSnapshot().value.text, 'Read-only retained draft');
    assert.deepEqual(f.workspace.composer('a').getSnapshot().originals, []); assert.deepEqual(f.workspace.originalReferences('a'), []);
    assert.equal(f.native.submitted.length, 0); assert.equal(answered, 0); assert.equal(f.counts().catalogEffects, 0);
  } finally { f.workspace.close(); gateway.close(); }
});

test('per-route file writes and native controls remain independent while immutable previews and local intent survive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v8-access-files-'));
  let files!: FileHost; const methods: string[] = [];
  const port: FilePort = { call: (method, input) => { methods.push(method); return files.call(method, input); } };
  const f = workspaceFixture({ hostForKind: { codex: 'file-host', copilot: 'control-host' }, files: port,
    access: scope => ({ ...readOnly, fileWrite: scope.host === 'file-host', control: scope.host === 'control-host' }) });
  let held: Awaited<ReturnType<typeof f.workspace.previewFile>> | undefined;
  try {
    const { a, b } = await f.open(), fileScope = f.workspace.fileScope('a');
    files = await FileHost.open({ directory: join(directory, 'cache'), bindings: [{ scope: fileScope, cwd: directory, dialect: 'posix' }] });
    const record = await f.workspace.saveFile('a', { name: 'local.txt', mediaType: 'text/plain', blob: new Blob(['verified bytes']) });
    const artifact = await f.workspace.uploadFile('a', record.manifest.id), preview = await f.workspace.previewFile('a', artifact);
    assert.deepEqual(preview.preview, { kind: 'text', text: 'verified bytes' }); preview.release();
    await writeFile(join(directory, 'note.md'), '# Allowed immutable capture');
    const captured = await f.workspace.captureFile('a', { sourceKey: 'file-write-reference', path: 'note.md' });
    held = await f.workspace.previewFile('a', captured);
    const fileView = a.getSnapshot(), controlView = b.getSnapshot();
    if (fileView.kind !== 'codex' || controlView.kind !== 'copilot') assert.fail('Expected native views');
    assert.equal(fileView.access.fileWrite, true); assert.equal(fileView.sendReady, false);
    assert.equal(controlView.access.fileWrite, false); assert.equal(controlView.sendReady, true);
    assert.throws(() => fileView.actions.stop(), { code: 'FENCED' });
    await assert.rejects(f.workspace.uploadFile('b', 'denied'), { code: 'FENCED' });
    await assert.rejects(f.workspace.captureFile('b', { sourceKey: 'denied', path: 'note.md' }), { code: 'FENCED' });
    await assert.rejects(f.workspace.refreshMcp('a'), { code: 'FENCED' }); assert.equal(f.counts().discovery, 0);
    await controlView.actions.stop().result; assert.equal(f.native.submitted.length, 1); assert.equal(f.native.submitted[0]!.scope.host, 'control-host');
    assert.ok(methods.includes('capture') && methods.includes('commit'));
    f.workspace.close(); held.release(); held = undefined; // Exact byte cleanup remains available after account disposal.
    assert.equal((await files.call('usage', { scope: fileScope })).activeReads, 0);
    assert.throws(() => controlView.actions.stop(), { code: 'CLOSED' });
  } finally { held?.release(); f.workspace.close(); await files?.close(); await rm(directory, { recursive: true, force: true }); }
});
