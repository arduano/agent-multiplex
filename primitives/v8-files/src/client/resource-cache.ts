import { digest, imageType, textContent } from "../contracts/content.js";
import { defaultLimits, MiB } from "../contracts/limits.js";
import { FileError, scopeKey, type ArtifactRef, type FilePort } from "../contracts/types.js";

class Slots {
  active = 0; readonly #waiting: (() => void)[] = [];
  constructor(readonly maximum: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) await new Promise<void>(resolve => this.#waiting.push(resolve)); else this.active++;
    try { return await work(); } finally { const next = this.#waiting.shift(); if (next) next(); else this.active--; }
  }
}
export type Preview = Readonly<{ kind: "image"; url: string; width: number; height: number }> | Readonly<{ kind: "text"; text: string }> | Readonly<{ kind: "download" }>;
export type ResourceLease = Readonly<{ artifact: ArtifactRef; blob: Blob; preview: Preview; release: () => void }>;
type Resource = Readonly<{ blob: Blob; preview: Preview; decoded: number }>;
type Entry = { key: string; artifact: ArtifactRef; references: number; generation: number; expired: boolean; pending: boolean; decoded: number; promise: Promise<Resource>; resource?: Resource; used: number };
export type ResourceCacheOptions = Readonly<{ maxEncodedBytes?: number; maxDecodedBytes?: number; maxEntries?: number; maxReads?: number; maxDecodes?: number; textBytes?: number; decodeImage?: (url: string) => Promise<Readonly<{ width: number; height: number }>> }>;

/** Shared immutable browser resources; eviction and expiry cannot retire actual running I/O. */
export class ResourceCache {
  readonly #entries = new Map<string, Entry>(); readonly #expired = new Set<string>(); readonly #reads: Slots; readonly #decodes: Slots;
  readonly #port: FilePort; readonly #options: Required<Omit<ResourceCacheOptions, "decodeImage">> & Pick<ResourceCacheOptions, "decodeImage">;
  #clock = 0; #generation = 0; #closed = false;
  constructor(port: FilePort, options: ResourceCacheOptions = {}) {
    this.#port = port;
    this.#options = { maxEncodedBytes: 32 * MiB, maxDecodedBytes: 64 * MiB, maxEntries: 128, maxReads: 4, maxDecodes: 2, textBytes: 2 * MiB, ...options };
    for (const [key, value] of Object.entries(this.#options)) if (key !== "decodeImage" && (!Number.isSafeInteger(value) || (value as number) <= 0)) throw new RangeError("Invalid resource bound");
    this.#reads = new Slots(this.#options.maxReads); this.#decodes = new Slots(this.#options.maxDecodes);
  }
  #key(ref: ArtifactRef): string { return `${scopeKey(ref.owner)}:${ref.id}`; }
  get usage(): Readonly<{ entries: number; encodedBytes: number; decodedBytes: number; activeReads: number; activeDecodes: number }> {
    return Object.freeze({ entries: this.#entries.size, encodedBytes: [...this.#entries.values()].reduce((n, e) => n + e.artifact.bytes, 0), decodedBytes: [...this.#entries.values()].reduce((n, e) => n + e.decoded, 0), activeReads: this.#reads.active, activeDecodes: this.#decodes.active });
  }
  #drop(entry: Entry): void {
    if (entry.pending || entry.references) return;
    if (entry.resource?.preview.kind === "image") URL.revokeObjectURL(entry.resource.preview.url);
    if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
  }
  #room(encoded: number, decoded: number, entries: number): void {
    const fits = () => { const u = this.usage; return u.encodedBytes + encoded <= this.#options.maxEncodedBytes && u.decodedBytes + decoded <= this.#options.maxDecodedBytes && u.entries + entries <= this.#options.maxEntries; };
    if (fits()) return;
    for (const entry of [...this.#entries.values()].sort((a, b) => a.used - b.used)) { if (!entry.references && !entry.pending) this.#drop(entry); if (fits()) return; }
    throw new FileError("STORAGE_FULL", "All browser resource capacity is leased or working");
  }
  async acquire(artifact: ArtifactRef): Promise<ResourceLease> {
    const key = this.#key(artifact);
    if (this.#closed) throw new FileError("CLOSED"); if (this.#expired.has(key)) throw new FileError("EXPIRED");
    let entry = this.#entries.get(key);
    if (entry && (entry.artifact.sha256 !== artifact.sha256 || entry.artifact.bytes !== artifact.bytes)) throw new FileError("CONFLICT");
    if (!entry) {
      if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > defaultLimits.maxFileBytes) throw new FileError("INVALID");
      this.#room(artifact.bytes, 0, 1);
      const current: Entry = { key, artifact: Object.freeze({ ...artifact, owner: Object.freeze({ ...artifact.owner }) }), references: 0, pending: true, expired: false, decoded: 0, generation: ++this.#generation, used: ++this.#clock, promise: undefined as unknown as Promise<Resource> };
      entry = current; this.#entries.set(key, current);
      current.promise = this.#reads.run(() => this.#load(current)).then(resource => { current.resource = resource; return resource; }).finally(() => { current.pending = false; if ((current.expired || this.#closed) && !current.references) this.#drop(current); });
    }
    const retained = entry; retained.references++; retained.used = ++this.#clock;
    try {
      const resource = await retained.promise; let released = false;
      return Object.freeze({ artifact: retained.artifact, blob: resource.blob, preview: resource.preview, release: () => { if (released) return; released = true; retained.references--; retained.used = ++this.#clock; if (retained.expired || this.#closed) this.#drop(retained); } });
    } catch (error) { retained.references--; this.#drop(retained); throw error; }
  }
  async #load(entry: Entry): Promise<Resource> {
    const ref = entry.artifact, acquired = await this.#port.call("acquire", { scope: ref.owner, id: ref.id });
    let url: string | undefined;
    try {
      if (acquired.artifact.sha256 !== ref.sha256 || acquired.artifact.bytes !== ref.bytes || acquired.artifact.id !== ref.id || scopeKey(acquired.artifact.owner) !== scopeKey(ref.owner)) throw new FileError("FENCED");
      const bytes = new Uint8Array(ref.bytes); let offset = 0;
      while (offset < bytes.length) {
        const chunk = await this.#port.call("read", { scope: ref.owner, leaseId: acquired.leaseId, offset, length: Math.min(defaultLimits.chunkBytes, bytes.length - offset) });
        if (!chunk.length || chunk.length > Math.min(defaultLimits.chunkBytes, bytes.length - offset)) throw new FileError("CORRUPT");
        bytes.set(chunk, offset); offset += chunk.length;
      }
      if (await digest(bytes) !== ref.sha256) throw new FileError("CORRUPT");
      const mime = imageType(bytes), blob = new Blob([bytes], { type: mime ?? "application/octet-stream" });
      if (mime) {
        url = URL.createObjectURL(blob);
        const dimensions = await this.#decodes.run(() => this.#options.decodeImage ? this.#options.decodeImage(url!) : decodeImage(url!));
        if (![dimensions.width, dimensions.height].every(v => Number.isSafeInteger(v) && v > 0)) throw new FileError("UNSUPPORTED");
        const decoded = dimensions.width * dimensions.height * 4;
        if (!Number.isSafeInteger(decoded)) throw new FileError("UNSUPPORTED");
        this.#room(0, decoded, 0);
        entry.decoded = decoded;
        return { blob, preview: Object.freeze({ kind: "image", url, ...dimensions }), decoded };
      }
      try { return { blob, preview: Object.freeze({ kind: "text", text: textContent(bytes, this.#options.textBytes) }), decoded: 0 }; }
      catch (error) { if (!(error instanceof FileError) || error.code !== "UNSUPPORTED") throw error; return { blob, preview: Object.freeze({ kind: "download" }), decoded: 0 }; }
    } catch (error) { if (url) { URL.revokeObjectURL(url); url = undefined; } throw error; }
    finally {
      try { await this.#port.call("release", { scope: ref.owner, leaseId: acquired.leaseId }); }
      catch (error) { if (url) URL.revokeObjectURL(url); throw error; }
    }
  }
  markExpired(artifact: ArtifactRef): void {
    const key = this.#key(artifact);
    // Refuse a new cache epoch instead of forgetting terminal identities at capacity.
    if (!this.#expired.has(key) && this.#expired.size >= this.#options.maxEntries) { this.close(); return; }
    this.#expired.add(key); const entry = this.#entries.get(key); if (entry) { entry.expired = true; this.#drop(entry); }
  }
  close(): void { this.#closed = true; for (const entry of this.#entries.values()) this.#drop(entry); }
}
export async function decodeImage(url: string): Promise<Readonly<{ width: number; height: number }>> {
  const image = new Image(); image.src = url;
  try { await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight }; }
  finally { image.removeAttribute("src"); }
}
