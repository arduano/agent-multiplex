import type { IncomingMessage, ServerResponse } from "node:http";
import { FileError, assertId, assertScope, scopeKey, type FileInputs, type FileMethod, type FilePort, type FileScope } from "../contracts/types.js";

export interface FileHttpOptions {
  authenticate(request: IncomingMessage): FileScope | Promise<FileScope>;
  /** File-navigation cookies alone must not authorize uploads. */
  canUpload?: (request: IncomingMessage) => boolean;
  maxBodyBytes?: number;
  responseBudgetMs?: number;
  maxRequests?: number;
  allowedOrigins?: readonly string[];
}
// Detached Host leases never cross an unreliable browser RPC connection.
// HTTP owns every actual read lease; browser ports keep only local byte leases.
const publicMethods = new Set<FileMethod>(["begin", "status", "write", "commit", "abort", "abandon", "capture", "usage"]);
const uploads = new Set<FileMethod>(["begin", "write", "commit", "abort", "abandon"]);
export function wireReplacer(_key: string, value: unknown): unknown {
  return value instanceof Uint8Array ? { __bytes: Array.from(value) } : value;
}
export function wireReviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && "__bytes" in value) {
    const raw = value as { __bytes: unknown };
    if (Object.keys(raw).length !== 1 || !Array.isArray(raw.__bytes) || raw.__bytes.length > 65536 || raw.__bytes.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new FileError("INVALID");
    return new Uint8Array(raw.__bytes as number[]);
  }
  return value;
}
async function body(request: IncomingMessage, maximum: number): Promise<unknown> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    if (total > maximum) throw new FileError("INVALID", "Request is too large");
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8"), wireReviver) as unknown; }
  catch { throw new FileError("INVALID"); }
}
function range(value: string | undefined, bytes: number): { start: number; end: number; partial: boolean } {
  if (!value) return { start: 0, end: bytes - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || bytes === 0) throw new FileError("INVALID", "RANGE");
  const start = match[1] ? Number(match[1]) : Math.max(0, bytes - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(bytes - 1, Number(match[2])) : bytes - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= bytes || (!match[1] && Number(match[2]) === 0)) throw new FileError("INVALID", "RANGE");
  return { start, end, partial: true };
}
function codeStatus(error: FileError): number {
  return error.code === "FENCED" ? 403 : error.code === "NOT_FOUND" ? 404 : error.code === "EXPIRED" ? 410
    : error.code === "BUSY" ? 503 : error.code === "STORAGE_FULL" ? 507 : error.code === "CONFLICT" || error.code === "CORRUPT" ? 409 : error.code === "INVALID" ? 400 : 502;
}
function waitForResponse(response: ServerResponse, event: "drain" | "finish"): Promise<void> {
  return new Promise(resolve => {
    const done = () => { response.off(event, done); response.off("close", done); response.off("error", done); resolve(); };
    response.once(event, done); response.once("close", done); response.once("error", done);
    if (response.destroyed || (event === "finish" && response.writableFinished)) done();
  });
}

/** Authenticated routing and finite buffering only; this adapter owns no durable bytes. */
export function createFileHttpHandler(port: FilePort, options: FileHttpOptions) {
  const maximum = options.maxRequests ?? 8, maximumBody = options.maxBodyBytes ?? 512 * 1024, responseBudget = options.responseBudgetMs ?? 30_000;
  if (![maximum, maximumBody, responseBudget].every(v => Number.isSafeInteger(v) && v > 0) || maximum > 64 || maximumBody > 1024 * 1024) throw new RangeError("HTTP limits must be finite and bounded");
  const authenticate = options.authenticate, canUpload = options.canUpload;
  const allowedOrigins = options.allowedOrigins ? [...options.allowedOrigins] : undefined;
  let active = 0;
  type PendingRelease = { scope: FileScope; leaseId: string; work?: Promise<boolean> };
  const releases = new Map<string, PendingRelease>();
  const attemptRelease = (lease: PendingRelease): Promise<boolean> => {
    if (lease.work) return lease.work;
    const work = Promise.resolve().then(async () => {
      try {
        await port.call("release", { scope: lease.scope, leaseId: lease.leaseId });
        if (releases.delete(lease.leaseId)) active--;
        return true;
      } catch { return false; }
      finally { delete lease.work; }
    });
    lease.work = work; return work;
  };
  // A finite retry episode keeps exact cleanup identity; failed work remains owned.
  const retryReleases = async (): Promise<void> => { await Promise.all([...releases.values()].map(attemptRelease)); };
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    void retryReleases();
    if (active >= maximum) { response.writeHead(503, { "retry-after": "1" }).end(); return; }
    active++;
    let lease: { scope: FileScope; leaseId: string } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      response.setHeader("cache-control", "private, no-store");
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("content-security-policy", "sandbox; default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      const url = new URL(request.url ?? "/", "http://fixture.invalid");
      if (url.search || (url.pathname !== "/rpc" && !url.pathname.startsWith("/files/"))) { response.writeHead(404).end(); return; }
      const scope = Object.freeze({ ...await authenticate(request) }); assertScope(scope);
      const origin = request.headers.origin;
      if (origin && !(allowedOrigins ?? [`http://${request.headers.host}`]).includes(origin)) throw new FileError("FENCED");
      if (url.pathname === "/rpc") {
        if (request.method !== "POST") { response.writeHead(405, { allow: "POST" }).end(); return; }
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) { response.writeHead(415).end(); return; }
        const value = await body(request, maximumBody);
        if (!value || typeof value !== "object") throw new FileError("INVALID");
        const command = value as { method: FileMethod; input: FileInputs[FileMethod] };
        if (!publicMethods.has(command.method) || !command.input || scopeKey(command.input.scope) !== scopeKey(scope)) throw new FileError("FENCED");
        if (uploads.has(command.method) && !canUpload?.(request)) throw new FileError("FENCED");
        const result = await port.call(command.method, command.input);
        if (!response.destroyed) response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result }, wireReplacer));
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, { allow: "GET, HEAD" }).end(); return; }
      const id = decodeURIComponent(url.pathname.slice("/files/".length)); assertId(id);
      const acquired = await port.call("acquire", { scope, id }); lease = { scope, leaseId: acquired.leaseId };
      const artifact = acquired.artifact, etag = `"${artifact.sha256}"`;
      response.setHeader("etag", etag);
      response.setHeader("accept-ranges", "bytes");
      response.setHeader("content-type", "application/octet-stream");
      const filename = artifact.name.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 255) || "file.bin";
      response.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16)}`)}`);
      if (request.headers["if-match"] && request.headers["if-match"] !== etag) { response.writeHead(412).end(); return; }
      if (request.headers["if-none-match"] === etag) { response.writeHead(304).end(); return; }
      let selected;
      try { selected = range(!request.headers["if-range"] || request.headers["if-range"] === etag ? request.headers.range : undefined, artifact.bytes); }
      catch { response.writeHead(416, { "content-range": `bytes */${artifact.bytes}` }).end(); return; }
      const { start, end, partial } = selected;
      response.setHeader("content-length", Math.max(0, end - start + 1));
      if (partial) response.setHeader("content-range", `bytes ${start}-${end}/${artifact.bytes}`);
      response.writeHead(partial ? 206 : 200);
      if (request.method === "HEAD") { response.end(); return; }
      timer = setTimeout(() => response.destroy(), responseBudget);
      for (let offset = start; offset <= end;) {
        if (response.destroyed) break;
        // Consumer disappearance never races the underlying read out of its actual slot.
        const bytes = await port.call("read", { ...lease, offset, length: Math.min(65536, end - offset + 1) });
        if (bytes.length !== Math.min(65536, end - offset + 1)) throw new FileError("CORRUPT");
        if (response.destroyed) break;
        offset += bytes.length;
        if (!response.write(bytes)) {
          await waitForResponse(response, "drain");
          if (response.destroyed) break;
        }
      }
      if (!response.destroyed) {
        const finish = waitForResponse(response, "finish");
        response.end(); await finish;
      }
    } catch (error) {
      if (!response.destroyed) {
        if (response.headersSent) response.destroy();
        else {
          const value = error instanceof FileError ? error : new FileError("FENCED");
          response.writeHead(codeStatus(value), { "content-type": "application/json" });
          response.end(request.method === "HEAD" ? undefined : JSON.stringify({ error: { code: value.code, message: value.code } }));
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (lease) {
        const retained: PendingRelease = lease; releases.set(lease.leaseId, retained);
        for (let attempt = 0; attempt < 3 && releases.has(lease.leaseId); attempt++) await attemptRelease(retained);
      } else active--;
    }
  };
  return Object.assign(handler, { retryReleases, pendingReleases: () => releases.size });
}
