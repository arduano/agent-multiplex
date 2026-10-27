import { HistoryWorkspace, type WorkspaceSession } from "../../../v8-history/src/client/workspace.js";
import type { Scope } from "../../../v8-history/src/contracts/types.js";
import { digest } from "../contracts/content.js";
import { defaultLimits } from "../contracts/limits.js";
import { assertId, assertScope, FileError, scopeKey, type ArtifactRef, type FilePort, type FileScope, type UploadStatus } from "../contracts/types.js";
import { BrowserExclusiveLock, draftKey, LocalExclusiveLock, type DraftPersistence, type DraftRecord, type ExclusiveLock } from "./persistence.js";
import { snapshotScope } from "./snapshot.js";

export type FileWorkspaceSnapshot = Readonly<{ connected: boolean; revision: number; records: readonly DraftRecord[]; activeTransfers: number }>;
export type FileWorkspaceOptions = Readonly<{ history: HistoryWorkspace; persistence: DraftPersistence; port: FilePort; lock?: ExclusiveLock; chunkBytes?: number }>;
/** Retained local intent only. This owner never invokes Send or guesses native consumption. */
export class FileWorkspace {
  readonly #history: HistoryWorkspace; readonly #persistence: DraftPersistence; readonly #port: FilePort; readonly #lock: ExclusiveLock; readonly #chunkBytes: number;
  readonly #sessions = new Map<string, WorkspaceSession>(); readonly #records = new Map<string, DraftRecord>();
  readonly #jobs = new Map<string, Promise<ArtifactRef>>(); readonly #listeners = new Set<() => void>();
  #connected = true; #revision = 0; #closed = false;
  #snapshot: FileWorkspaceSnapshot = Object.freeze({ connected: true, revision: 0, records: Object.freeze([]), activeTransfers: 0 });
  constructor(options: FileWorkspaceOptions) {
    this.#history = options.history; this.#persistence = options.persistence; this.#port = options.port; this.#lock = options.lock ?? (typeof window === "undefined" ? new LocalExclusiveLock() : new BrowserExclusiveLock()); this.#chunkBytes = options.chunkBytes ?? defaultLimits.chunkBytes;
    if (!Number.isSafeInteger(this.#chunkBytes) || this.#chunkBytes < 1 || this.#chunkBytes > defaultLimits.chunkBytes) throw new RangeError("Invalid upload chunk bound");
  }
  getSnapshot = (): FileWorkspaceSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => { if (this.#closed) return () => {}; this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #changed(): void {
    this.#snapshot = Object.freeze({ connected: this.#connected, revision: ++this.#revision, records: Object.freeze(this.#closed ? [] : [...this.#records.values()]), activeTransfers: this.#jobs.size });
    for (const listener of [...this.#listeners]) try { listener(); } catch { /* A renderer cannot reject a durable file write or another observer. */ }
  }
  #check(scope: FileScope): void { assertScope(scope); if (this.#closed) throw new FileError("CLOSED"); if (!this.#sessions.has(scopeKey(scope))) throw new FileError("FENCED", "Bind file scope to its retained history session first"); }
  async bind(scope: FileScope, historyScope: Scope): Promise<void> {
    scope = snapshotScope(scope); historyScope = structuredClone(historyScope);
    if (this.#closed) throw new FileError("CLOSED");
    assertScope(scope);
    if (scope.connection !== historyScope.origin.connection || scope.principal !== historyScope.origin.principal || scope.host !== historyScope.origin.host || scope.session !== historyScope.origin.nativeSession) throw new FileError("FENCED");
    this.#sessions.set(scopeKey(scope), this.#history.session(historyScope));
    await this.reload(scope);
  }
  async reload(scope: FileScope): Promise<void> {
    scope = snapshotScope(scope); this.#check(scope); const records = await this.#persistence.list(scope); this.#check(scope);
    for (const [key, record] of this.#records) if (scopeKey(record.scope) === scopeKey(scope)) this.#records.delete(key);
    for (const record of records) this.#records.set(record.key, record); this.#changed();
  }
  async clear(scope: FileScope, id: string, expectedRevision: number): Promise<void> {
    scope = snapshotScope(scope); this.#check(scope); assertId(id); const key = draftKey(scope, id);
    if (this.#jobs.has(key)) throw new FileError("BUSY", "A transfer still owns this local file");
    if (!this.#persistence.remove) throw new FileError("UNSUPPORTED");
    await this.#lock.run(key, async () => {
      this.#check(scope); if (this.#jobs.has(key)) throw new FileError("BUSY");
      await this.#persistence.remove!(scope, id, expectedRevision); this.#check(scope); this.#records.delete(key); this.#changed();
    });
  }
  setPinned(scope: FileScope, pinned: boolean): void { this.#check(scope); this.#sessions.get(scopeKey(scope))!.setPinned(pinned); this.#changed(); }
  setConnected(connected: boolean): void {
    if (this.#closed) throw new FileError("CLOSED"); this.#connected = connected; this.#history.setConnected(connected); this.#changed();
    if (connected) for (const record of this.#records.values()) if (record.phase === "uploading" || record.phase === "uncertain") void this.upload(record.scope, record.manifest.id).catch(() => {});
  }
  async #save(record: DraftRecord): Promise<DraftRecord> {
    this.#check(record.scope);
    const saved = await this.#persistence.put(record, record.revision);
    this.#check(record.scope);
    this.#records.set(saved.key, saved); this.#changed();
    if (saved.key !== record.key) throw new FileError("CONFLICT", "A concurrent revision was preserved as a conflict copy");
    return saved;
  }
  async saveDraft(scope: FileScope, input: Readonly<{ name: string; mediaType: string; blob: Blob; id?: string }>, expectedRevision = 0): Promise<DraftRecord> {
    scope = snapshotScope(scope); const { name, mediaType, blob } = input;
    this.#check(scope); const id = input.id ?? crypto.randomUUID(); assertId(id);
    if (blob.size > defaultLimits.maxFileBytes || !name || name.length > 1024 || mediaType.length > 256) throw new FileError("INVALID");
    const manifest = Object.freeze({ id, name, mediaType: mediaType || "application/octet-stream", bytes: blob.size, sha256: await digest(new Uint8Array(await blob.arrayBuffer())) });
    this.#check(scope);
    return this.#lock.run(draftKey(scope, id), async () => {
      this.#check(scope); const previous = await this.#persistence.get(scope, id); this.#check(scope);
      if (previous && previous.phase !== "draft") throw new FileError("CONFLICT", "An initiated upload cannot change original meaning");
      const saved = await this.#persistence.put({ key: draftKey(scope, id), scope, manifest, blob, revision: expectedRevision, phase: "draft", operationIds: [] }, expectedRevision);
      this.#check(scope);
      this.#records.set(saved.key, saved); this.#changed(); return saved;
    });
  }
  async recordRequest(scope: FileScope, id: string, operationId: string): Promise<DraftRecord> {
    scope = snapshotScope(scope);
    this.#check(scope); assertId(operationId);
    return this.#lock.run(draftKey(scope, id), async () => {
      this.#check(scope); const record = await this.#persistence.get(scope, id); this.#check(scope); if (!record) throw new FileError("NOT_FOUND");
      if (record.operationIds.includes(operationId)) return record;
      if (record.operationIds.length >= 128) throw new FileError("STORAGE_FULL");
      return this.#save({ ...record, operationIds: [...record.operationIds, operationId] });
    });
  }
  upload(scope: FileScope, id: string): Promise<ArtifactRef> {
    scope = snapshotScope(scope);
    this.#check(scope); assertId(id); const key = draftKey(scope, id), prior = this.#jobs.get(key); if (prior) return prior;
    if (this.#jobs.size >= defaultLimits.maxUploads) return Promise.reject(new FileError("BUSY", "Background upload slots are occupied"));
    const job = this.#lock.run(key, async () => {
      this.#check(scope); let record = await this.#persistence.get(scope, id); this.#check(scope); if (!record) throw new FileError("NOT_FOUND");
      if (record.phase === "expired" || record.phase === "aborted") throw new FileError("EXPIRED");
      if (!this.#connected) throw new FileError("BUSY", "Waiting for connection");
      record = await this.#save({ ...record, phase: "uploading" });
      try {
        let status = await this.#port.call("status", { scope, id });
        this.#check(scope);
        if (status.state === "missing") { status = await this.#port.call("begin", { scope, manifest: record.manifest }); this.#check(scope); }
        const terminal = async (value: UploadStatus): Promise<ArtifactRef | undefined> => {
          if (value.state === "expired" || value.state === "aborted") { record = await this.#save({ ...record!, phase: value.state }); throw new FileError("EXPIRED"); }
          if (value.state === "committed") return value.artifact;
          return undefined;
        };
        let artifact = await terminal(status);
        if (!artifact && status.state === "uploading") {
          const remoteManifest = status.manifest, expectedManifest = record.manifest;
          if ((["id", "name", "mediaType", "bytes", "sha256"] as const).some(key => remoteManifest[key] !== expectedManifest[key])) throw new FileError("CONFLICT");
          let offset = status.offset;
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > record.manifest.bytes) throw new FileError("CONFLICT", "Invalid acknowledged upload offset");
          while (offset < record.manifest.bytes) {
            if (!this.#connected) throw new FileError("BUSY", "Waiting for connection");
            const data = new Uint8Array(await record.blob.slice(offset, offset + this.#chunkBytes).arrayBuffer());
            this.#check(scope);
            status = await this.#port.call("write", { scope, id, offset, data });
            this.#check(scope);
            artifact = await terminal(status); if (artifact) break;
            if (status.state !== "uploading" || status.offset <= offset || status.offset > record.manifest.bytes) throw new FileError("CONFLICT", "Invalid acknowledged upload offset");
            offset = status.offset;
          }
          if (!artifact) { artifact = await this.#port.call("commit", { scope, id }); this.#check(scope); }
        }
        if (!artifact) throw new FileError("CONFLICT");
        if (scopeKey(artifact.owner) !== scopeKey(scope) || artifact.id !== id || artifact.sha256 !== record.manifest.sha256 || artifact.bytes !== record.manifest.bytes || artifact.name !== record.manifest.name || artifact.mediaType !== record.manifest.mediaType) throw new FileError("FENCED");
        await this.#save({ ...record, phase: "committed", artifact }); return artifact;
      } catch (error) {
        if (!this.#closed && record.phase !== "expired" && record.phase !== "aborted") await this.#save({ ...record, phase: "uncertain" });
        throw error;
      }
    });
    this.#jobs.set(key, job); this.#changed();
    void job.finally(() => { this.#jobs.delete(key); this.#changed(); }).catch(() => {}); return job;
  }
  reconcile(scope: FileScope, id: string): Promise<ArtifactRef> { return this.upload(scope, id); }
  async retryExpired(scope: FileScope, id: string): Promise<DraftRecord> {
    scope = snapshotScope(scope);
    this.#check(scope); const previous = await this.#persistence.get(scope, id); this.#check(scope); if (!previous) throw new FileError("NOT_FOUND");
    const status = await this.#port.call("status", { scope, id });
    this.#check(scope);
    if (status.state !== "expired" && status.state !== "aborted") throw new FileError("CONFLICT", "Replacement requires a proven terminal upload");
    return this.saveDraft(scope, { name: previous.manifest.name, mediaType: previous.manifest.mediaType, blob: previous.blob });
  }
  /** Stops initiating new work, while already-issued I/O retains its actual owner. */
  close(): void { this.#closed = true; this.#connected = false; this.#listeners.clear(); this.#records.clear(); this.#sessions.clear(); this.#changed(); }
}
export const openFileWorkspace = (options: FileWorkspaceOptions): FileWorkspace => new FileWorkspace(options);
