import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreationRegistry, type CreationRecord } from '../src/registry.js';

const identity = {
  lifecycle: { id: 'capacity.lifecycle', version: 1, recordVersion: 1 },
  harness: { id: 'capacity.harness', version: 1, recordVersion: 1 },
  workspace: { id: 'capacity.workspace', version: 1, recordVersion: 1 },
};
const custody = { host: 'host', owner: 'owner' };
const record = (session: string): CreationRecord => ({
  scope: { connection: 'connection', principal: 'principal', host: 'host', session }, id: `create-${session}`, input: { cwd: '/workspace' },
  workspace: 'unallocated', nativeAttempted: false, stopped: false, retired: false,
});
type Admission = { fresh: boolean; record: CreationRecord };

test('capacity releases only a completed Archive and retains exact originals across reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v8-registry-capacity-'));
  const registries = new Set<CreationRegistry>();
  const open = async (name: string) => { const registry = await CreationRegistry.open(join(directory, name), identity, 1, custody); registries.add(registry); return registry; };
  const close = async (registry: CreationRegistry) => { await registry.close(); registries.delete(registry); };
  try {
    const first = record('first'), next = record('next');
    // Failed release remains uncertain, including after its writer reopens.
    let failed = await open('failed');
    await failed.call<Admission>('admit', { record: first });
    await assert.rejects(failed.call('admit', { record: next }), { code: 'FULL' });
    const pending: CreationRecord = { ...first, stopped: true, retired: true,
      archive: { scope: first.scope, id: 'archive-first', generation: 0, type: 'archive', state: 'dispatched' } };
    await failed.call('put', { record: pending });
    await assert.rejects(failed.call('admit', { record: next }), { code: 'FULL' });
    const unknown: CreationRecord = { ...pending, archive: { ...pending.archive!, state: 'outcomeUnknown', reason: 'archiveUnconfirmed' } };
    await failed.call('put', { record: unknown });
    await close(failed); failed = await open('failed');
    await assert.rejects(failed.call('admit', { record: next }), { code: 'FULL' });
    assert.deepEqual(await failed.call<Admission>('admit', { record: first }), { fresh: false, record: unknown });
    await close(failed);

    // A separate positively completed Archive frees capacity without deleting
    // either its original or the new occupied record.
    let completed = await open('completed');
    await completed.call('admit', { record: first });
    await completed.call('put', { record: pending });
    const archived: CreationRecord = { ...pending, workspace: 'released',
      archive: { ...pending.archive!, state: 'acknowledged', outcome: { status: 'acknowledged' } } };
    await completed.call('put', { record: archived });
    assert.deepEqual(await completed.call<Admission>('admit', { record: next }), { fresh: true, record: next });
    assert.deepEqual(await completed.call<Admission>('admit', { record: first }), { fresh: false, record: archived });
    await close(completed); completed = await open('completed');
    assert.deepEqual(await completed.call<CreationRecord[]>('list', {}), [archived, next]);
    assert.deepEqual(await completed.call<Admission>('admit', { record: first }), { fresh: false, record: archived });
    await assert.rejects(completed.call('admit', { record: { ...first, input: { cwd: '/changed' } } }), { code: 'CONFLICT' });
    await assert.rejects(completed.call('admit', { record: record('third') }), { code: 'FULL' });
    await close(completed);
  } finally {
    try { await Promise.all([...registries].map(registry => registry.close())); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
});
