import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileHost } from '../src/host/index.js';
import { FileError, type FilePort, type FileScope } from '../src/contracts/types.js';
import { fileNavigationQuery, parseFileNavigation } from '../src/contracts/navigation.js';
import { createFileNavigationHandler, htmlPreviewPolicy } from '../src/transport/navigation-http.js';
const scope: FileScope = { connection: 'navigation', principal: 'owner', host: 'host', session: 'native' };
async function fixture(run: (value: { host: FileHost; cwd: string; url: string; handler: ReturnType<typeof createFileNavigationHandler>; get(query: URLSearchParams, init?: RequestInit): Promise<Response> }) => Promise<void>, wrap?: (host: FileHost) => FilePort, options?: Parameters<typeof createFileNavigationHandler>[1], beforeHandle?: (response: ServerResponse) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'v8-navigation-')), cwd = join(directory, 'workspace'); await mkdir(cwd);
  const host = await FileHost.open({ directory: join(directory, 'private'), bindings: [{ scope, cwd, dialect: 'posix' }] });
  const handler = createFileNavigationHandler(async (request, target) => {
    if (request.headers['x-owner'] !== 'yes' || target.host !== 'host' || target.session !== 'logical') throw new FileError('FENCED');
    return { port: wrap?.(host) ?? host, scope };
  }, options);
  const server = createServer((request, response) => { beforeHandle?.(response); void handler(request, response); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object'); const url = `http://127.0.0.1:${address.port}/files`;
  try { await run({ host, cwd, url, handler, get: (query, init) => fetch(`${url}?${query}`, { ...init, headers: { 'x-owner': 'yes', ...Object.fromEntries(new Headers(init?.headers)) } }) }); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await handler.retryReleases(); assert.equal(handler.pendingReleases(), 0); await host.close(); await rm(directory, { recursive: true, force: true }); }
}
const target = { host: 'host', session: 'logical' };
test('authenticated navigation preserves the first snapshot and exact ranges, HEAD and explicit sandboxed HTML', async () => {
  await fixture(async ({ cwd, host, get, url }) => {
    const body = '<!doctype html><style>body{color:red}</style><button id="counter">0</button><script>counter.onclick=()=>counter.textContent=Number(counter.textContent)+1</script>';
    await writeFile(join(cwd, 'page.html'), body);
    const source = { path: 'page.html', sourceKey: 'exact-reference' }, query = fileNavigationQuery({ ...target, source, representation: 'html' });
    assert.deepEqual(parseFileNavigation(`${url}?${query}`), { ...target, source, representation: 'html' });
    assert.equal((await fetch(`${url}?${query}`)).status, 403);
    const first = await get(query); assert.equal(first.status, 200); assert.equal(first.headers.get('content-security-policy'), htmlPreviewPolicy); assert.equal(first.headers.get('content-type'), 'text/html; charset=utf-8'); assert.equal(await first.text(), body);
    const etag = first.headers.get('etag')!;
    await writeFile(join(cwd, 'page.html'), '<script>throw new Error("changed")</script>');
    assert.equal(await (await get(query)).text(), body);
    const head = await get(query, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal(head.headers.get('etag'), etag);
    const ranged = await get(query, { headers: { range: 'bytes=0-14', 'if-range': etag } }); assert.equal(ranged.status, 206); assert.equal(await ranged.text(), body.slice(0, 15));
    assert.equal((await get(query, { headers: { range: 'bytes=999999-' } })).status, 416);
    assert.equal((await get(query, { headers: { 'if-none-match': etag } })).status, 304);
    const captured = await host.call('capture', { scope, ...source });
    const download = await get(fileNavigationQuery({ ...target, id: captured.id })); assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition')!, /^attachment/); assert.equal(await download.text(), body);
    assert.equal((await get(new URLSearchParams([...query, ['id', captured.id]]))).status, 400);
    assert.equal((await get(fileNavigationQuery({ ...target, source: { path: 'page.html', sourceKey: 'x'.repeat(1025) } }))).status, 400);
    // Captured disk metadata is deliberately octet-stream. Both methods must
    // describe the same image representation, without a second MIME cache.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3gAAAABJRU5ErkJggg==', 'base64');
    await writeFile(join(cwd, 'pixel.png'), png);
    const imageQuery = fileNavigationQuery({ ...target, source: { path: 'pixel.png', sourceKey: 'pixel-reference' } });
    const image = await get(imageQuery), imageHead = await get(imageQuery, { method: 'HEAD' });
    assert.equal(image.status, 200); assert.equal(imageHead.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
    for (const name of ['content-type', 'content-disposition', 'content-length', 'etag']) assert.equal(imageHead.headers.get(name), image.headers.get(name));
    assert.equal(await imageHead.text(), ''); assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    await writeFile(join(cwd, 'report.pdf'), '%PDF-1.4\n%%EOF');
    const pdf = await get(fileNavigationQuery({ ...target, source: { path: 'report.pdf', sourceKey: 'pdf-reference' } }));
    assert.equal(pdf.headers.get('content-type'), 'application/pdf'); assert.match(pdf.headers.get('content-disposition')!, /^inline/);
    assert.equal(await pdf.text(), '%PDF-1.4\n%%EOF'); // Framing only; the PDF viewer validates the document.
    assert.equal((await host.call('usage', { scope })).activeReads, 0);
  });
});
test('navigation verifies full bytes before exposing even a range of executable HTML', async () => {
  await fixture(async ({ cwd, get, host }) => {
    await writeFile(join(cwd, 'page.html'), '<!doctype html><p>verified only</p>');
    const result = await get(fileNavigationQuery({ ...target, source: { path: 'page.html', sourceKey: 'corrupt-original' }, representation: 'html' }), { headers: { range: 'bytes=0-5' } });
    assert.equal(result.status, 409); assert.equal(result.headers.get('content-type'), 'application/json'); assert.equal((await result.json()).error, 'CORRUPT');
    assert.equal((await host.call('usage', { scope })).activeReads, 0);
  }, host => ({ call: async (method, input) => { const value = await host.call(method, input); if (method === 'read') { const bytes = value as Uint8Array; bytes[bytes.length - 1]! ^= 1; } return value; } }));
});
test('a pending response retains its slot and lease until its actual finish', { timeout: 15000 }, async () => {
  let blocked = false, flush: (() => void) | undefined, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  await fixture(async ({ cwd, get, handler, host }) => {
    await writeFile(join(cwd, 'slow.txt'), 'buffered response');
    const query = fileNavigationQuery({ ...target, source: { path: 'slow.txt', sourceKey: 'slow-original' } });
    const first = get(query);
    try {
      await Promise.race([waiting, first.then(() => { throw Error('Expected held response'); })]);
      assert.equal(handler.activeRequests(), 1);
      assert.equal((await host.call('usage', { scope })).activeReads, 1);
      assert.equal((await get(query)).status, 503);
    } finally { flush?.(); }
    assert.equal(await (await first).text(), 'buffered response');
    for (let i = 0; i < 100 && handler.activeRequests(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(handler.activeRequests(), 0); assert.equal((await host.call('usage', { scope })).activeReads, 0);
  }, undefined, { maxRequests: 1, responseBudgetMs: 10000 }, response => {
    if (blocked) return;
    blocked = true;
    const end = response.end.bind(response);
    response.end = ((...args: Parameters<ServerResponse['end']>) => {
      flush = () => { end(...args); }; entered(); return response;
    }) as ServerResponse['end'];
  });
});
test('navigation timeout keeps its real I/O slot and exact release until the Host read settles', { timeout: 15000 }, async () => {
  let unblock!: () => void, entered!: () => void, readCount = 0, releaseCount = 0;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { unblock = resolve; });
  await fixture(async ({ cwd, get, handler, host }) => {
    await writeFile(join(cwd, 'page.html'), '<p>held bytes</p>');
    const query = fileNavigationQuery({ ...target, source: { path: 'page.html', sourceKey: 'held' } });
    const first = get(query).then(() => assert.fail('A timed-out response cannot succeed'), () => {});
    try {
      await Promise.race([waiting, first.then(() => { throw Error('Response expired before the held read was admitted'); })]); await first;
      assert.equal(handler.activeRequests(), 1); assert.equal(readCount, 1);
      assert.equal((await get(query)).status, 503); assert.equal(readCount, 1);
    } finally { unblock(); }
    for (let i = 0; i < 100 && handler.activeRequests(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(handler.activeRequests(), 0); assert.equal(releaseCount, 1); assert.equal((await host.call('usage', { scope })).activeReads, 0);
  }, host => ({ call: async (method, input) => { if (method === 'read') { readCount++; entered(); await gate; } if (method === 'release') releaseCount++; return host.call(method, input); } }), { maxRequests: 1, responseBudgetMs: 2500 });
});
