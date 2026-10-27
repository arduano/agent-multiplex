import { defaultLimits } from "../contracts/limits.js";
import { FileError, scopeKey, type FileInputs, type FileMethod, type FileOutputs, type FilePort, type FileScope } from "../contracts/types.js";

async function boundedBody(response: Response, maximum: number, exact = false): Promise<Uint8Array> {
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let total = 0;
  const target = exact ? new Uint8Array(maximum) : undefined;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        total += value.byteLength;
        if (total > maximum) { await reader.cancel(); throw new FileError("INVALID", "File response exceeds its bound"); }
        if (target) target.set(value, total - value.byteLength); else chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  if (target) return target.subarray(0, total);
  const encoded = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { encoded.set(chunk, offset); offset += chunk.byteLength; }
  return encoded;
}
function responseJson(bytes: Uint8Array): { result?: unknown; error?: { code?: string; message?: string } } {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes), (_key, value: unknown) => {
      if (value && typeof value === "object" && Object.keys(value).length === 1 && "__bytes" in value) {
        const bytes = (value as { __bytes: unknown }).__bytes;
        if (!Array.isArray(bytes) || bytes.length > 65536 || bytes.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new FileError("INVALID");
        return new Uint8Array(bytes);
      }
      return value;
    }) as ReturnType<typeof responseJson>;
  } catch { throw new FileError("IO", "Invalid file RPC response"); }
}

/** Host read leases never cross this unstable link. A complete GET has a server-owned lease. */
export function createHttpFilePort(baseUrl: string, fetcher: typeof fetch = fetch): FilePort {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const leases = new Map<string, Readonly<{ scope: FileScope; bytes: Uint8Array }>>(); let acquiring = 0;
  const rpc = async <M extends FileMethod>(method: M, input: FileInputs[M]): Promise<FileOutputs[M]> => {
    const response = await fetcher(new URL("rpc", base), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, input }, (_key, value: unknown) => value instanceof Uint8Array ? { __bytes: Array.from(value) } : value) });
    const result = responseJson(await boundedBody(response, 1024 * 1024));
    if (!response.ok || result.error) throw new FileError((result.error?.code ?? "IO") as ConstructorParameters<typeof FileError>[0], "File request failed");
    return result.result as FileOutputs[M];
  };
  return { async call<M extends FileMethod>(method: M, input: FileInputs[M]): Promise<FileOutputs[M]> {
    input = structuredClone(input);
    if (method === "acquire") {
      if (leases.size + acquiring >= 4) throw new FileError("BUSY", "HTTP file acquisition slots are occupied");
      acquiring++;
      try {
        const value = input as FileInputs["acquire"], status = await rpc("status", value);
        if (status.state !== "committed") throw new FileError(status.state === "expired" || status.state === "aborted" ? "EXPIRED" : "NOT_FOUND");
        const artifact = status.artifact;
        if (artifact.id !== value.id || scopeKey(artifact.owner) !== scopeKey(value.scope) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > defaultLimits.maxFileBytes || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new FileError("FENCED");
        const response = await fetcher(new URL(`files/${encodeURIComponent(value.id)}`, base), { credentials: "same-origin", headers: { "If-Match": `"${artifact.sha256}"` } });
        if (!response.ok) {
          const result = responseJson(await boundedBody(response, 1024 * 1024));
          throw new FileError((result.error?.code ?? "IO") as ConstructorParameters<typeof FileError>[0], "File download failed");
        }
        const bytes = await boundedBody(response, artifact.bytes, true);
        if (bytes.length !== artifact.bytes) throw new FileError("CORRUPT", "File download was incomplete");
        const leaseId = crypto.randomUUID(); leases.set(leaseId, { scope: Object.freeze({ ...value.scope }), bytes });
        return { leaseId, artifact } as FileOutputs[M];
      } finally { acquiring--; }
    }
    if (method === "read") {
      const value = input as FileInputs["read"], lease = leases.get(value.leaseId);
      if (!lease || scopeKey(lease.scope) !== scopeKey(value.scope)) throw new FileError("FENCED");
      if (!Number.isSafeInteger(value.offset) || value.offset < 0 || !Number.isSafeInteger(value.length) || value.length < 0 || value.length > defaultLimits.chunkBytes || value.offset + value.length > lease.bytes.length) throw new FileError("INVALID");
      return lease.bytes.slice(value.offset, value.offset + value.length) as FileOutputs[M];
    }
    if (method === "release") {
      const value = input as FileInputs["release"], lease = leases.get(value.leaseId);
      if (lease && scopeKey(lease.scope) !== scopeKey(value.scope)) throw new FileError("FENCED");
      leases.delete(value.leaseId); return undefined as FileOutputs[M];
    }
    return rpc(method, input);
  } };
}
