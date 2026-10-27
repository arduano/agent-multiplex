import assert from 'node:assert/strict';
import test from 'node:test';
import { CatalogError, type CatalogEntry } from '../../v8-catalog/src/contracts/types.js';
import { workspaceFixture } from './fixture.js';

test('rename uses the exact catalog CAS original and publishes into the same prepared view without native effects', async () => {
  let entry!: CatalogEntry;
  const f = workspaceFixture({ rename: async request => {
    assert.equal(request.id, 'rename-original'); assert.equal(request.revision, entry.revision);
    return { ...entry, revision: entry.revision + 1, version: entry.version + 1, metadata: { ...entry.metadata, name: request.name } };
  } });
  try {
    const { a } = await f.open(); a.setDraft('retained message'); entry = f.workspace.list().rows[0]!.entry;
    const before = f.counts(), rows = a.getSnapshot(); let publications = 0;
    const release = f.workspace.subscribeCatalog(() => { publications++; });
    await f.workspace.renameSession(entry.session, { id: 'rename-original', revision: entry.revision, name: 'Renamed' });
    release(); const after = a.getSnapshot();
    assert.notEqual(after.kind, 'disposed'); if (after.kind === 'disposed' || rows.kind === 'disposed') assert.fail('Disposed');
    assert.equal(after.logical.entry!.metadata.name, 'Renamed'); assert.equal(after.composer.value.text, 'retained message');
    assert.equal(after.history, rows.history); assert(publications > 0);
    assert.deepEqual(f.counts(), { ...before, catalogEffects: before.catalogEffects + 1 });
  } finally { f.workspace.close(); }
});

test('conflicting, lost and foreign rename results preserve the observed catalog and never replay on refresh', async () => {
  for (const outcome of ['conflict', 'lost', 'foreign'] as const) {
    let entry!: CatalogEntry, calls = 0;
    const f = workspaceFixture({ rename: async request => {
      calls++;
      if (outcome === 'conflict') throw new CatalogError('CONFLICT');
      if (outcome === 'lost') throw new CatalogError('IO');
      return { ...entry, session: 'b', version: 2, revision: 2, metadata: { ...entry.metadata, name: request.name } };
    } });
    try {
      await f.open(); entry = f.workspace.list().rows[0]!.entry;
      await assert.rejects(f.workspace.renameSession(entry.session, { id: 'one-save', revision: entry.revision, name: 'New' }));
      await f.workspace.refreshCatalog();
      assert.equal(calls, 1); assert.equal(f.workspace.list().rows[0]!.entry.metadata.name, entry.metadata.name); assert.equal(f.counts().submitted, 0);
    } finally { f.workspace.close(); }
  }
});
