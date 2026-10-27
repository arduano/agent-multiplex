import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FileError, scopeKey, type ArtifactRef, type FilePort, type FileScope } from '../contracts/types.js';
import { defaultLimits } from '../contracts/limits.js';
import { imageType, textContent } from '../contracts/content.js';
import { parseFileNavigation, type FileNavigation } from '../contracts/navigation.js';

export const htmlPreviewPolicy = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const inertPolicy = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
type Binding = Readonly<{ port: FilePort; scope: FileScope }>;
type Held = Binding & Readonly<{ leaseId: string }>;
function range(value: string | undefined, bytes: number) {
  if (!value) return { start: 0, end: bytes - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !bytes || !match[1] && !match[2]) throw new FileError('INVALID');
  const start = match[1] ? Number(match[1]) : Math.max(0, bytes - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(bytes - 1, Number(match[2])) : bytes - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= bytes || !match[1] && Number(match[2]) === 0) throw new FileError('INVALID');
  return { start, end, partial: true };
}
function status(error: FileError) {
  return error.code === 'FENCED' ? 403 : error.code === 'NOT_FOUND' ? 404 : error.code === 'EXPIRED' ? 410 : error.code === 'UNSUPPORTED' ? 415 : error.code === 'INVALID' ? 400 : error.code === 'BUSY' ? 503 : error.code === 'CONFLICT' || error.code === 'CORRUPT' ? 409 : 502;
}
/** Transient authenticated response adapter. Immutable capture, authorization
 * and retirement remain in FilePort. A timed-out observer never frees an
 * outstanding Host operation or loses the exact lease needing cleanup. */
export function createFileNavigationHandler(resolve: (request: IncomingMessage, target: FileNavigation) => Promise<Binding>, options: Readonly<{ maxRequests?: number; responseBudgetMs?: number }> = {}) {
  const maximum = options.maxRequests ?? 8, budget = options.responseBudgetMs ?? 30_000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64 || !Number.isSafeInteger(budget) || budget < 1) throw new RangeError('File navigation bounds');
  let active = 0;
  const pending = new Map<Held, Promise<boolean> | undefined>();
  const release = (held: Held): Promise<boolean> => {
    const work = pending.get(held); if (work) return work;
    const next = Promise.resolve().then(async () => {
      try { await held.port.call('release', { scope: held.scope, leaseId: held.leaseId }); if (pending.delete(held)) active--; return true; }
      catch { pending.set(held, undefined); return false; }
    }); pending.set(held, next); return next;
  };
  const retryReleases = async () => { await Promise.all([...pending.keys()].map(release)); };
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    void retryReleases();
    if (active >= maximum) { response.writeHead(503, { 'retry-after': '1', 'cache-control': 'no-store' }).end(); return; }
    active++;
    let held: Held | undefined;
    const timer = setTimeout(() => { if (!response.writableEnded) response.destroy(); }, budget);
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { allow: 'GET, HEAD' }).end(); return; }
      const target = parseFileNavigation(request.url ?? ''), { port, scope } = await resolve(request, target);
      if (response.destroyed) return;
      const captured = target.source ? await port.call('capture', { scope, ...target.source }) : undefined;
      if (captured && scopeKey(captured.owner) !== scopeKey(scope)) throw new FileError('FENCED');
      if (response.destroyed) return;
      const id = target.id ?? captured!.id, acquired = await port.call('acquire', { scope, id });
      held = { port, scope, leaseId: acquired.leaseId };
      const artifact: ArtifactRef = acquired.artifact;
      if (artifact.id !== id || scopeKey(artifact.owner) !== scopeKey(scope) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > defaultLimits.maxFileBytes || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new FileError('CORRUPT');
      if (response.destroyed) return;
      const html = target.representation === 'html';
      if (html && !/\.html?$/i.test(artifact.name) && !['text/html', 'application/xhtml+xml'].includes(artifact.mediaType.split(';', 1)[0]!)) throw new FileError('UNSUPPORTED');
      if (html && artifact.bytes > defaultLimits.textBytes) throw new FileError('UNSUPPORTED');
      const etag = `"${artifact.sha256}"`;
      response.setHeader('cache-control', 'private, no-store'); response.setHeader('x-content-type-options', 'nosniff'); response.setHeader('referrer-policy', 'no-referrer');
      response.setHeader('content-security-policy', html ? htmlPreviewPolicy : inertPolicy);
      response.setHeader('etag', etag); response.setHeader('accept-ranges', 'bytes');
      if (request.headers['if-match'] && request.headers['if-match'] !== etag) { response.writeHead(412).end(); return; }
      if (request.headers['if-none-match'] === etag) { response.writeHead(304).end(); return; }
      let selected;
      try { selected = range(!request.headers['if-range'] || request.headers['if-range'] === etag ? request.headers.range : undefined, artifact.bytes); }
      catch { response.writeHead(416, { 'content-range': `bytes */${artifact.bytes}` }).end(); return; }
      // Authenticate and verify the whole bounded immutable object before exposing
      // executable HTML or even a byte range. HEAD verifies the same representation
      // and sends its exact headers without a response body.
      const bytes = Buffer.alloc(artifact.bytes);
      let media = artifact.mediaType;
      for (let offset = 0; offset < bytes.length;) {
        if (response.destroyed) return;
        const length = Math.min(defaultLimits.chunkBytes, bytes.length - offset), chunk = await port.call('read', { scope, leaseId: held.leaseId, offset, length });
        if (chunk.length !== length) throw new FileError('CORRUPT');
        bytes.set(chunk, offset); offset += length;
      }
      if (response.destroyed) return;
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new FileError('CORRUPT');
      if (html) textContent(bytes, defaultLimits.textBytes);
      else {
        const image = imageType(bytes);
        if (image) media = image;
        else if (bytes.subarray(0, 8).toString().startsWith('%PDF-')) media = 'application/pdf';
        else if (media === 'application/pdf') throw new FileError('CORRUPT');
        else if (media.startsWith('image/')) throw new FileError('UNSUPPORTED');
      }
      const inline = html || /^(?:image\/(?:png|jpeg|gif|webp|svg\+xml)|application\/pdf)$/.test(media);
      const filename = artifact.name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 255) || 'file.bin';
      response.setHeader('content-type', html ? 'text/html; charset=utf-8' : inline ? media : 'application/octet-stream');
      response.setHeader('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16)}`)}`);
      response.setHeader('content-length', Math.max(0, selected.end - selected.start + 1));
      if (selected.partial) response.setHeader('content-range', `bytes ${selected.start}-${selected.end}/${artifact.bytes}`);
      response.writeHead(selected.partial ? 206 : 200);
      // The bounded response buffer still belongs to this admission while a
      // slow browser is draining it. Host read completion alone cannot free it.
      await new Promise<void>(done => {
        const finished = () => { response.off('finish', finished); response.off('close', finished); done(); };
        response.once('finish', finished); response.once('close', finished);
        response.end(request.method === 'HEAD' ? undefined : bytes.subarray(selected.start, selected.end + 1));
        if (response.writableFinished || response.destroyed) finished();
      });
    } catch (error) {
      if (!response.destroyed) {
        if (response.headersSent) response.destroy();
        else { const code = (error as { code?: string } | null)?.code; const failure = error instanceof FileError ? error : new FileError(code === 'FORBIDDEN' || code === 'FENCED' ? 'FENCED' : code === 'NOT_FOUND' ? 'NOT_FOUND' : code === 'EXPIRED' ? 'EXPIRED' : 'IO'); response.writeHead(status(failure), { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ error: failure.code })); }
      }
    } finally {
      clearTimeout(timer);
      if (held) { pending.set(held, undefined); for (let attempt = 0; attempt < 3 && pending.has(held); attempt++) await release(held); }
      else active--;
    }
  };
  return Object.assign(handle, { retryReleases, pendingReleases: () => pending.size, activeRequests: () => active });
}
