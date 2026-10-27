import assert from 'node:assert/strict';
import test from 'node:test';
import { authenticatedFileAddress, fileLinkTarget, localFilePath, localFileReference } from '../src/file-reference.js';

test('document links keep native dialect and exact capture identity without granting a browser URL', async () => {
  assert.equal(localFilePath('../images/photo.png#preview', '/work/docs/guide.md'), '/work/docs/../images/photo.png');
  assert.equal(localFilePath('images/photo.png', 'C:\\work\\guide.md'), 'C:\\work\\images\\photo.png');
  assert.equal(localFilePath('src/main.ts:42:3'), 'src/main.ts');
  for (const path of ['//remote/private', '\\\\server\\share', '%2f%2fremote/path', '%00private', 'https://remote/file', 'data:text/html,unsafe']) assert.equal(localFilePath(path), undefined);
  assert.equal(authenticatedFileAddress('https://remote/file', 'https://gateway.invalid/chat'), undefined);
  assert.equal(authenticatedFileAddress('/authenticated/file', 'https://gateway.invalid/chat'), 'https://gateway.invalid/authenticated/file');
  const first = await localFileReference('exact-row', '/work/guide.md');
  assert.deepEqual(await localFileReference('exact-row', '/work/guide.md'), first);
  assert.notEqual((await localFileReference('different-row', '/work/guide.md')).sourceKey, first.sourceKey);
  assert.notEqual((await localFileReference('exact-row', '/work/other.md')).sourceKey, first.sourceKey);
});


test('file links preserve navigation intent while native encoded names are decoded only once', () => {
  assert.deepEqual(fileLinkTarget('file:///work/a%20b.md#heading'), { kind: 'local', path: '/work/a b.md', fragment: '#heading' });
  assert.deepEqual(fileLinkTarget('file:///C:/work/a.md:42:3'), { kind: 'local', path: 'C:/work/a.md', fragment: '#L42' });
  assert.deepEqual(fileLinkTarget('code.ts:12'), { kind: 'local', path: 'code.ts', fragment: '#L12' });
  assert.deepEqual(fileLinkTarget('report%3A12'), { kind: 'local', path: 'report:12' });
  // A one-letter colon prefix is ambiguous with a drive-relative native path.
  assert.equal(fileLinkTarget('a%3A12').kind, 'unsupported');
  assert.deepEqual(fileLinkTarget('../a%2520%23%3F.png', '/work/docs/readme.md'), { kind: 'local', path: '/work/docs/../a%20#?.png' });
  assert.deepEqual(fileLinkTarget('#section'), { kind: 'fragment', href: '#section' });
  assert.deepEqual(fileLinkTarget('https://example.invalid/image.png'), { kind: 'web', href: 'https://example.invalid/image.png' });
  for (const url of ['file://server/private', 'file:///safe?other=1', 'C:relative', 'C:/safe:stream', 'javascript:alert(1)', '/safe#bad fragment']) assert.equal(fileLinkTarget(url).kind, 'unsupported');
});
