import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileHost } from '../../v8-files/src/host/index.js';
// The focused TypeScript graph must emit the actual worker entry as well.
import type {} from '../../v8-files/src/host/worker.js';
import type { FilePort } from '../../v8-files/src/contracts/types.js';
import { workspaceFixture } from './fixture.js';

test('local-link capture uses the prepared native file scope and keeps the first snapshot after disk changes', async () => {
  let owner!: FileHost, foreign = false;
  const port: FilePort = { async call(method, input) {
    const result = await owner.call(method, input);
    return foreign && method === 'capture' ? { ...(result as object), owner: { ...input.scope, principal: 'another-account' } } as typeof result : result;
  } };
  const f = workspaceFixture({ files: port }), directory = await mkdtemp(join(tmpdir(), 'v8-workspace-capture-'));
  try {
    const { a } = await f.open(); const scope = f.workspace.fileScope('a');
    owner = await FileHost.open({ directory: join(directory, 'cache'), bindings: [{ scope, cwd: directory, dialect: 'posix' }] });
    await writeFile(join(directory, 'note.md'), '# Original verified document');
    const first = await a.captureFile({ sourceKey: 'exact-streamed-reference', path: 'note.md' });
    assert.deepEqual(first.owner, scope); assert.equal(first.owner.session, 'native-a');
    await writeFile(join(directory, 'note.md'), '# Changed after first display');
    const retained = await a.captureFile({ sourceKey: 'exact-streamed-reference', path: 'note.md' });
    assert.deepEqual(retained, first);
    const preview = await a.previewFile(retained);
    assert.deepEqual(preview.preview, { kind: 'text', text: '# Original verified document' }); preview.release();
    await assert.rejects(a.captureFile({ sourceKey: 'outside-root', path: '../outside.txt' }));
    foreign = true;
    await assert.rejects(a.captureFile({ sourceKey: 'other-reference', path: 'note.md' }), { code: 'FENCED' });
    assert.equal(f.counts().submitted, 0);
  } finally { f.workspace.close(); await owner?.close(); }
});
