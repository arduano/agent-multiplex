import assert from 'node:assert/strict';
import test from 'node:test';
import { RetainedComposer } from '../../v8-workspace/src/composer.js';
import { MemoryDraftPersistence, draftKey, type ComposerRecord } from '../src/client/persistence.js';
import { FileWorkspace } from '../src/client/workspace.js';
import { HistoryWorkspace } from '../../v8-history/src/client/workspace.js';
import { ClientFixturePort } from './client-fixture.js';
import type { CodexScope } from '../../v8-history/src/contracts/types.js';

const scope = { connection: 'composer-test', principal: 'owner', authority: 'catalog', host: 'host', session: 'logical' };
const fileScope = { ...scope, session: 'native' };
const attached: CodexScope = { kind: 'codex', threadId: 'native', origin: { ...fileScope, nativeSession: 'native', attachment: 'capture' } };
const reference = { scope: { connection: scope.connection, principal: scope.principal, host: scope.host, session: scope.session }, owner: 'exact-owner', id: 'original-send', type: 'send' as const, generation: 1 };
function gate() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }

test('composer coalesces held autosave, preserves edits away and back, and publishes no late private state after close', async () => {
  const held = gate(); let writes = 0, active = 0, maximum = 0;
  class Persistence extends MemoryDraftPersistence {
    override async putComposer(value: ComposerRecord, revision: number): Promise<ComposerRecord> {
      writes++; maximum = Math.max(maximum, ++active); try { if (writes === 1) await held.promise; return await super.putComposer(value, revision); } finally { active--; }
    }
  }
  const persistence = new Persistence(), composer = new RetainedComposer({ scope, persistence }); await composer.load();
  composer.subscribe(() => { throw Error('renderer'); });
  composer.edit({ text: 'first', fileIds: [] }); const captured = composer.capture();
  composer.edit({ text: 'different', fileIds: [] }); composer.edit({ text: 'first', fileIds: [] });
  held.release(); await composer.flush(); assert.equal(maximum, 1); assert.equal(writes, 2);
  assert.equal(composer.consume(captured), false); assert.equal(composer.getSnapshot().value.text, 'first');
  const another = new RetainedComposer({ scope, persistence }); await another.load(); assert.equal(another.getSnapshot().value.text, 'first');
  composer.close(); assert.equal(composer.getSnapshot().state, 'disposed'); assert.equal(composer.getSnapshot().value.text, ''); assert.deepEqual(composer.getSnapshot().originals, []);
  another.close();
});

test('one browser-store transaction protects an exact original and files; reload is inert and local clear requires exact terminal settlement', async () => {
  const persistence = new MemoryDraftPersistence(), history = new HistoryWorkspace({ connection: scope.connection, principal: scope.principal });
  const files = new FileWorkspace({ history, persistence, port: new ClientFixturePort() }); await files.bind(fileScope, attached);
  const draft = await files.saveDraft(fileScope, { id: 'selected-file', name: 'note.txt', mediaType: 'text/plain', blob: new Blob(['private draft bytes']) }); await files.upload(fileScope, draft.manifest.id);
  const composer = new RetainedComposer({ scope, persistence }); await composer.load(); composer.edit({ text: 'private message', fileIds: [draft.manifest.id] }); await composer.flush();
  await assert.rejects(composer.protect(reference, fileScope, ['missing-file']), { code: 'NOT_FOUND' });
  assert.equal((await persistence.getComposer(scope))!.originals.length, 0); assert.deepEqual((await persistence.get(fileScope, draft.manifest.id))!.operationIds, []);
  await composer.protect(reference, fileScope, [draft.manifest.id]); await files.reload(fileScope);
  const protectedFile = (await persistence.get(fileScope, draft.manifest.id))!; assert.deepEqual(protectedFile.operationIds, [reference.id]);
  await assert.rejects(files.clear(fileScope, draft.manifest.id, protectedFile.revision), { code: 'BUSY' });
  let restored: unknown; const reload = new RetainedComposer({ scope, persistence, restoreOriginals: refs => { restored = refs; } }); await reload.load();
  assert.deepEqual(restored, [reference]); assert.equal(JSON.stringify(restored).includes('private message'), false); assert.equal(JSON.stringify(restored).includes('bytes'), false);
  const peer = new RetainedComposer({ scope: { ...scope, authority: 'other-authority' }, persistence }); await peer.load(); await peer.flush();
  const peerReference = { ...reference, owner: 'different-durable-owner' }; await peer.protect(peerReference, fileScope, [draft.manifest.id]);
  await reload.settle(reference); await files.reload(fileScope); const terminal = (await persistence.get(fileScope, draft.manifest.id))!;
  assert.deepEqual(terminal.operationIds, [reference.id], 'Settling one exact domain cannot clear a different original sharing its local ID');
  await assert.rejects(files.clear(fileScope, draft.manifest.id, terminal.revision), { code: 'BUSY' });
  await peer.settle(peerReference); await files.reload(fileScope); const eligible = (await persistence.get(fileScope, draft.manifest.id))!;
  await assert.rejects(files.clear(fileScope, draft.manifest.id, eligible.revision - 1), { code: 'CONFLICT' });
  await files.clear(fileScope, draft.manifest.id, eligible.revision); assert.equal(await persistence.get(fileScope, draft.manifest.id), undefined);
  assert.equal(files.getSnapshot().records.some(value => value.key === draftKey(fileScope, draft.manifest.id)), false);
  composer.close(); reload.close(); peer.close(); files.close();
});

test('failed original-domain restoration remains unavailable and cannot become a Submit-capable draft', async () => {
  const persistence = new MemoryDraftPersistence(), composer = new RetainedComposer({ scope, persistence }); await composer.load(); await composer.flush(); await composer.protect(reference, fileScope, []);
  const reload = new RetainedComposer({ scope, persistence, restoreOriginals: () => { throw Error('different authenticated owner'); } });
  await assert.rejects(reload.load()); assert.equal(reload.getSnapshot().state, 'unavailable'); await assert.rejects(reload.flush()); assert.throws(() => reload.edit({ text: 'new', fileIds: [] }), { code: 'BUSY' });
  composer.close(); reload.close();
});

test('held file persistence cannot publish after auth disposal and renderer failure cannot reject a durable file write', async () => {
  const held = gate(); let entered!: () => void; const ready = new Promise<void>(done => { entered = done; });
  class Persistence extends MemoryDraftPersistence {
    hold = false;
    override async put(...args: Parameters<MemoryDraftPersistence['put']>) { if (this.hold) { entered(); await held.promise; } return super.put(...args); }
  }
  const persistence = new Persistence(), history = new HistoryWorkspace({ connection: scope.connection, principal: scope.principal });
  const files = new FileWorkspace({ history, persistence, port: new ClientFixturePort() }); await files.bind(fileScope, attached);
  files.subscribe(() => { throw Error('renderer'); }); const first = await files.saveDraft(fileScope, { name: 'first.txt', mediaType: 'text/plain', blob: new Blob(['first']) });
  assert.equal(files.getSnapshot().records[0]!.manifest.id, first.manifest.id);
  persistence.hold = true; const late = files.saveDraft(fileScope, { name: 'late-private.txt', mediaType: 'text/plain', blob: new Blob(['private']) }); const rejected = assert.rejects(late, { code: 'CLOSED' });
  await ready; files.close(); assert.deepEqual(files.getSnapshot().records, []); held.release(); await rejected; assert.deepEqual(files.getSnapshot().records, []);
});

test('captured-edit protection survives the handoff/consume crash window and terminal settlement clears only that exact edit', async () => {
  const persistence = new MemoryDraftPersistence(), first = new RetainedComposer({ scope, persistence }); await first.load(); first.edit({ text: 'handed off before crash', fileIds: [] }); await first.flush();
  const referenceForEdit = { ...reference, type: 'copilot.steer' as const, edit: first.capture().edit };
  await first.protect(referenceForEdit, fileScope, []); first.close();
  const reload = new RetainedComposer({ scope, persistence }); await reload.load(); assert.equal(reload.getSnapshot().originals[0]!.edit, reload.capture().edit);
  await reload.settle(referenceForEdit); assert.deepEqual(reload.getSnapshot().value, { text: '', fileIds: [] }); assert.deepEqual((await persistence.getComposer(scope))!.value, { text: '', fileIds: [] });
  reload.edit({ text: 'not handed off', fileIds: [] }); await reload.flush(); const unsent = { ...referenceForEdit, id: 'unhanded', edit: reload.capture().edit }; await reload.protect(unsent, fileScope, []); await reload.forgetUnsent(unsent); assert.equal(reload.getSnapshot().value.text, 'not handed off');
  const older = { ...referenceForEdit, id: 'older-original', edit: reload.capture().edit }; await reload.protect(older, fileScope, []); reload.edit({ text: 'newer draft', fileIds: [] }); await reload.settle(older); assert.equal(reload.getSnapshot().value.text, 'newer draft');
  reload.close();
});
