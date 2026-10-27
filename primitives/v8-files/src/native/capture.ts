import { mediaDigest, mediaMeaning, type MediaResolution, type NativeMediaHandler } from "../../../v8-history/src/contracts/media.js";
import { conversationKey, scopeKey as historyScopeKey } from "../../../v8-history/src/contracts/identity.js";
import { canonical, validateScope } from "../../../v8-history/src/contracts/validation.js";
import type { Scope } from "../../../v8-history/src/contracts/types.js";
import { assertScope, FileError, scopeKey, type ArtifactRef, type FileInputs, type FileManifest, type FileOutputs, type FilePort, type FileScope, type UploadStatus } from "../contracts/types.js";

export type NativeOccurrence = Readonly<{ key: string; signature: string }>;
/** Trusted Host-only registration. Neither FilePort nor HTTP exposes this seam. */
export interface NativeCapturePort extends FilePort {
  native<M extends "begin" | "capture">(method: M, input: FileInputs[M], occurrence: NativeOccurrence): Promise<FileOutputs[M]>;
}

type Entry = { signature: string; resolution: MediaResolution; artifact?: ArtifactRef };
const unavailable: MediaResolution = Object.freeze({ state: "unavailable" });
const terminalErrors = new Set(["INVALID", "CONFLICT", "FENCED", "NOT_FOUND", "EXPIRED", "CORRUPT", "STORAGE_FULL", "BUSY", "UNSUPPORTED"]);
/** Finite optional native-media acquisition; no effect/native-lifetime or history ownership. */
export class NativeFileCapture {
  readonly #port: NativeCapturePort;
  readonly #mapScope: (scope: Scope) => FileScope;
  readonly #maxPending: number;
  readonly #maxPendingBytes: number;
  readonly #maxOccurrences: number;
  readonly #entries = new Map<string, Entry>();
  readonly #jobs = new Set<Promise<void>>();
  readonly #listeners = new Set<() => void>();
  #pendingBytes = 0;
  #closed = false;

  constructor(options: Readonly<{ port: NativeCapturePort; mapScope: (scope: Scope) => FileScope; maxPending?: number; maxPendingBytes?: number; maxOccurrences?: number }>) {
    this.#port = options.port; this.#mapScope = options.mapScope;
    this.#maxPending = options.maxPending ?? 10; this.#maxPendingBytes = options.maxPendingBytes ?? 50 * 1024 * 1024;
    this.#maxOccurrences = options.maxOccurrences ?? 128;
    for (const [value, maximum] of [[this.#maxPending, 10], [this.#maxPendingBytes, 50 * 1024 * 1024], [this.#maxOccurrences, 4096]]) {
      if (!Number.isSafeInteger(value) || value! < 1 || value! > maximum!) throw new RangeError("Native capture limit");
    }
  }
  readonly handler: NativeMediaHandler = input => {
    const scope = JSON.parse(canonical(input.scope)) as Scope; validateScope(scope);
    if (typeof input.occurrence.id !== "string" || !input.occurrence.id || input.occurrence.id.length > 4096) return unavailable;
    const key = this.#key(scope, input.occurrence.id), signature = canonical(mediaMeaning([input.occurrence]));
    const prior = this.#entries.get(key);
    if (prior) return prior.signature === signature ? prior.resolution : unavailable;
    if (this.#closed) return unavailable;
    // Only active work pins this memo. Immutable identity/conflict/expiry lives
    // in the existing FileHost ledger, so completed history is not a quota.
    if (this.#entries.size >= this.#maxOccurrences) for (const [oldKey, entry] of this.#entries) {
      if (entry.resolution.state !== "pending") { this.#entries.delete(oldKey); break; }
    }
    if (this.#entries.size >= this.#maxOccurrences) return unavailable;
    const entry: Entry = { signature, resolution: unavailable }; this.#entries.set(key, entry);
    const occurrence: NativeOccurrence = { key: `native-occurrence-${mediaDigest(new TextEncoder().encode(canonical([conversationKey(scope), input.occurrence.id])))}`, signature: mediaDigest(new TextEncoder().encode(signature)) };
    // Only native output-path leaves select the existing confined immutable
    // preview owner. User localImage references and opaque assets stay inert.
    if (input.occurrence.kind === "image" && input.occurrence.source === "disk" &&
        ["imageView", "imageGeneration", "image_generation_call"].includes(input.occurrence.nativeType ?? "")) {
      const reservation = 10 * 1024 * 1024;
      if (typeof input.occurrence.path !== "string" || !input.occurrence.path || input.occurrence.path.length > 4096 ||
          this.#jobs.size >= this.#maxPending || reservation > this.#maxPendingBytes - this.#pendingBytes) return unavailable;
      const owner = Object.freeze({ ...this.#mapScope(scope) }); assertScope(owner);
      const path = input.occurrence.path;
      const sourceKey = `native-${mediaDigest(new TextEncoder().encode(canonical([conversationKey(scope), input.occurrence.id, path])))}`;
      entry.resolution = Object.freeze({ state: "pending" });
      this.#schedule(entry, reservation, async () => {
        const artifact = await this.#port.native("capture", { scope: owner, sourceKey, path, historyScope: scope }, occurrence);
        if (artifact.kind !== "artifact" || scopeKey(artifact.owner) !== scopeKey(owner) ||
            !Number.isSafeInteger(artifact.bytes) || artifact.bytes > reservation || artifact.bytes < 0 ||
            !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new FileError("CORRUPT");
        return artifact;
      });
      return entry.resolution;
    }

    if (input.occurrence.kind !== "image" || input.occurrence.source !== "inline" || !input.bytes) {
      entry.resolution = input.occurrence.state === "unsupported" ? Object.freeze({ state: "unsupported" }) : unavailable;
      return entry.resolution;
    }
    if (this.#jobs.size >= this.#maxPending || input.bytes.length > 10 * 1024 * 1024 || input.bytes.length > this.#maxPendingBytes - this.#pendingBytes) return unavailable;
    const owner = Object.freeze({ ...this.#mapScope(scope) }); assertScope(owner);
    const media = Object.freeze({ ...input.occurrence }), bytes = new Uint8Array(input.bytes);
    if (bytes.length > 10 * 1024 * 1024 || media.bytes !== bytes.length || !/^[a-f0-9]{64}$/.test(media.sha256 ?? "") || !/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(media.mediaType ?? "")) return unavailable;
    // Authenticated attachment epochs fence observations, not historical byte
    // identities. Reattachment must retain the Host's expired-ID tombstone.
    const id = `native-${mediaDigest(new TextEncoder().encode(canonical([conversationKey(scope), media.id, media.sha256])))}`;
    const extension = media.mediaType === "image/jpeg" ? "jpg" : media.mediaType!.split("/")[1]!.replace("+xml", "");
    const manifest: FileManifest = Object.freeze({ id, name: `native-${scope.kind}-${id.slice(7, 19)}.${extension}`, mediaType: media.mediaType!, bytes: bytes.length, sha256: media.sha256! });
    entry.resolution = Object.freeze({ state: "pending", artifactId: id });
    this.#schedule(entry, bytes.length, () => this.#capture(owner, manifest, bytes, occurrence));
    return entry.resolution;
  };
  #schedule(entry: Entry, reservation: number, acquire: () => Promise<ArtifactRef>): void {
    this.#pendingBytes += reservation;
    // Admit synchronously; actual I/O starts after the native callback returns.
    const job = Promise.resolve().then(async () => {
      try {
        const artifact = await acquire();
        entry.artifact = artifact; entry.resolution = Object.freeze({ state: "available", artifactId: artifact.id });
      } catch { entry.resolution = unavailable; }
    }).finally(() => {
      this.#jobs.delete(job); this.#pendingBytes -= reservation;
      for (const listener of this.#listeners) { try { listener(); } catch { /* Renderer isolation. */ } }
    });
    this.#jobs.add(job);
  }

  lookup(scope: Scope, occurrenceId: string): MediaResolution { return this.#entries.get(this.#key(scope, occurrenceId))?.resolution ?? unavailable; }
  artifact(scope: Scope, occurrenceId: string): ArtifactRef | undefined { return this.#entries.get(this.#key(scope, occurrenceId))?.artifact; }
  subscribe(listener: () => void): () => void {
    if (this.#closed) throw new FileError("CLOSED");
    if (this.#listeners.size >= 128 && !this.#listeners.has(listener)) throw new FileError("BUSY");
    this.#listeners.add(listener); return () => this.#listeners.delete(listener);
  }
  /** Wait only the jobs admitted when called. Later work belongs to a later episode. */
  async drain(): Promise<void> { await Promise.all([...this.#jobs]); }
  async settle(): Promise<void> { await this.drain(); }
  close(): void { this.#closed = true; }
  diagnostics(): Readonly<{ occurrences: number; pending: number; pendingBytes: number; closed: boolean }> {
    return Object.freeze({ occurrences: this.#entries.size, pending: this.#jobs.size, pendingBytes: this.#pendingBytes, closed: this.#closed });
  }
  #key(scope: Scope, id: string): string { return JSON.stringify([historyScopeKey(scope), id]); }
  #manifest(status: UploadStatus, manifest: FileManifest): void {
    if (status.state === "missing" || status.state === "committed") return;
    if (canonical(status.manifest) !== canonical(manifest)) throw new FileError("CONFLICT");
    if (status.state !== "uploading" || !Number.isSafeInteger(status.offset) || status.offset < 0 || status.offset > manifest.bytes) throw new FileError("EXPIRED");
  }
  #artifact(value: ArtifactRef, owner: FileScope, manifest: FileManifest): ArtifactRef {
    if (value.kind !== "artifact" || scopeKey(value.owner) !== scopeKey(owner) ||
      ["id", "name", "mediaType", "bytes", "sha256"].some(key => value[key as keyof ArtifactRef] !== manifest[key as keyof FileManifest])) throw new FileError("CONFLICT");
    return Object.freeze({ ...value, owner: Object.freeze({ ...value.owner }) });
  }
  async #reconcile(scope: FileScope, manifest: FileManifest, action: () => Promise<UploadStatus>): Promise<UploadStatus> {
    try { const result = await action(); this.#manifest(result, manifest); return result; }
    catch (error) {
      if (error instanceof FileError && terminalErrors.has(error.code)) throw error;
      const result = await this.#port.call("status", { scope, id: manifest.id }); this.#manifest(result, manifest); return result;
    }
  }
  async #capture(scope: FileScope, manifest: FileManifest, bytes: Uint8Array, occurrence: NativeOccurrence): Promise<ArtifactRef> {
    const id = manifest.id;
    let status = await this.#reconcile(scope, manifest, () => this.#port.native("begin", { scope, manifest }, occurrence));
    if (status.state === "missing") status = await this.#reconcile(scope, manifest, () => this.#port.native("begin", { scope, manifest }, occurrence));
    this.#manifest(status, manifest);
    while (status.state === "uploading" && status.offset < bytes.length) {
      const offset = status.offset, data = bytes.slice(offset, offset + 64 * 1024);
      status = await this.#reconcile(scope, manifest, () => this.#port.call("write", { scope, id, offset, data }));
      if (status.state === "uploading" && status.offset === offset) status = await this.#reconcile(scope, manifest, () => this.#port.call("write", { scope, id, offset, data }));
      if (status.state === "uploading" && status.offset <= offset) throw new FileError("IO", "Native capture made no durable progress");
      if (status.state === "uploading" && status.offset < offset + data.length) throw new FileError("CONFLICT", "Native chunk was not acknowledged atomically");
    }
    let artifact: ArtifactRef;
    if (status.state === "committed") artifact = this.#artifact(status.artifact, scope, manifest);
    else {
      if (status.state !== "uploading" || status.offset !== bytes.length) throw new FileError("EXPIRED");
      const commit = async (): Promise<UploadStatus> => ({ state: "committed", artifact: await this.#port.call("commit", { scope, id }) });
      status = await this.#reconcile(scope, manifest, commit);
      if (status.state === "uploading" && status.offset === bytes.length) status = await this.#reconcile(scope, manifest, commit);
      if (status.state !== "committed") throw new FileError("IO");
      artifact = this.#artifact(status.artifact, scope, manifest);
    }
    // Only this private native-output namespace is released. Existing user
    // input references are never passed through this uploader or abandoned.
    try { await this.#port.call("abandon", { scope, id }); }
    catch (error) {
      if (error instanceof FileError && terminalErrors.has(error.code)) throw error;
      const current = await this.#port.call("status", { scope, id });
      if (current.state !== "committed") throw new FileError("EXPIRED");
      this.#artifact(current.artifact, scope, manifest);
      await this.#port.call("abandon", { scope, id });
    }
    return artifact;
  }
}
