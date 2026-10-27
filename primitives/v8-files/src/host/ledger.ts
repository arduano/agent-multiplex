import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { HardenedSqliteDatabase, assertPrivateFilesSync, ensurePrivateDirectorySync } from "../../../../packages/storage-sqlite/src/index.js";
import { fileLimits, type FileLimits } from "../contracts/limits.js";
import { assertId, assertScope, FileError, scopeKey, type ArtifactRef, type FileManifest, type FileScope, type FileUsage, type UploadStatus } from "../contracts/types.js";
import type { FileHostOptions } from "./index.js";

type Entry = {
  scope: string; id: string; manifest: FileManifest; state: "uploading" | "publishing" | "committed" | "aborted" | "expired";
  offset: number; createdAt: number; progressAt: number; capturedAt: number; draftUntil: number; file: string; capture: boolean;
  device: string; inode: string;
};
type Operation = { scope: string; id: string; artifacts: string[]; consumers: string[]; released: boolean[]; settled: boolean };
type Capture = { scope: string; id: string; source: string; path: string; artifact: string; signature?: string };
type Lease = { scope: string; id: string; descriptor: number; dev: number; ino: number; bytes: number; mtimeMs: number; ctimeMs: number };
type Binding = FileHostOptions["bindings"][number];
const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const hash = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const within = (root: string, path: string): boolean => { const rel = relative(root, path); return rel === "" || !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel); };

/** All mutable file state and actual synchronous filesystem jobs live on one worker. */
export class FileLedger {
  readonly #store: HardenedSqliteDatabase;
  readonly #directory: string;
  readonly #staging: string;
  readonly #objects: string;
  readonly #bindings = new Map<string, Binding>();
  readonly #limits: Readonly<FileLimits>;
  readonly #leases = new Map<string, Lease>();
  readonly #sealed = new Set<string>();
  readonly #options: FileHostOptions;
  readonly #pageSize: number;
  #at: number;
  #closed = false;
  #unknownBytes = 0;
  #failedPublish = false;
  #failedThresholdCheckpoint = false;
  constructor(options: FileHostOptions, at: number) {
    this.#options = options;
    this.#at = at;
    this.#limits = fileLimits(options.limits);
    this.#directory = resolve(options.directory);
    this.#noSymlinkAncestors(this.#directory);
    ensurePrivateDirectorySync(this.#directory);
    this.#staging = join(this.#directory, "staging"); this.#objects = join(this.#directory, "objects");
    ensurePrivateDirectorySync(this.#staging); ensurePrivateDirectorySync(this.#objects);
    for (const binding of options.bindings) {
      assertScope(binding.scope);
      const key = scopeKey(binding.scope);
      if (this.#bindings.has(key) || !binding.cwd || !(binding.dialect === "posix" ? posix : win32).isAbsolute(binding.cwd)) throw new FileError("INVALID", "Invalid or duplicate scope binding");
      this.#bindings.set(key, binding);
    }
    this.#store = new HardenedSqliteDatabase({ filename: join(this.#directory, "files.sqlite"), applicationId: 0x56384653, storeName: "V8 files", migrations: [{ version: 1, name: "v8-files-initial", apply(db) {
      db.exec("CREATE TABLE entries(scope TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,metadata_size INTEGER NOT NULL,state TEXT NOT NULL,committed_at INTEGER NOT NULL,draft_until INTEGER NOT NULL,actual_bytes INTEGER NOT NULL,charged_bytes INTEGER NOT NULL,reserved_bytes INTEGER NOT NULL,staging_bytes INTEGER NOT NULL,trash_bytes INTEGER NOT NULL,PRIMARY KEY(scope,id)); CREATE INDEX entries_eligible ON entries(state,committed_at,scope,id); CREATE INDEX entries_session ON entries(scope,state,committed_at,id); CREATE TABLE operations(scope TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,metadata_size INTEGER NOT NULL,PRIMARY KEY(scope,id)); CREATE TABLE captures(scope TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,metadata_size INTEGER NOT NULL,PRIMARY KEY(scope,id));");
    } }] });
    const db = this.#store.database;
    this.#pageSize = Number(db.prepare("PRAGMA page_size").get()!.page_size);
    db.exec(`PRAGMA max_page_count=${Math.max(1, Math.floor(this.#limits.databaseBytes / this.#pageSize))}`);
    db.exec(`PRAGMA journal_size_limit=${this.#limits.walBytes}`);
    // FULL commits flush the WAL before ACK; writing it back to the database is separate.
    db.exec("PRAGMA wal_autocheckpoint=0");
    try {
      this.#reconcile();
      this.#inventoryUnknown();
      this.#checkpoint();
      if (this.#physical().dbBytes > this.#limits.databaseBytes || this.#physical().walBytes > this.#limits.walBytes) throw new FileError("STORAGE_FULL", "Ledger limits are below the initialized database size");
    } catch (error) { this.#store.close(); throw error; }
  }

  call(method: string, input: unknown, at: number): unknown {
    if (this.#closed) throw new FileError("CLOSED");
    this.#at = at;
    if (!input || typeof input !== "object" || !("scope" in input)) throw new FileError("INVALID");
    const value = input as { scope: FileScope } & Record<string, unknown>;
    const scope = value.scope; assertScope(scope);
    const key = scopeKey(scope);
    if (!this.#bindings.has(key)) throw new FileError("FENCED", "Unknown file scope");
    if (this.#sealed.has(key) && !["status", "usage", "release", "$protectedOperations", "$archiveStatus", "$seal"].includes(method)) throw new FileError("FENCED", "Session file admissions are sealed");
    switch (method) {
      case "$archiveStatus": return { activeReads: [...this.#leases.values()].filter(lease => lease.scope === key).length };
      case "$seal": {
        if ([...this.#leases.values()].some(lease => lease.scope === key) || this.#rows<Operation>("operations").some(row => row.scope === key && row.released.some(value => !value))) throw new FileError("BUSY", "Actual file holds remain");
        this.#sealed.add(key); return;
      }
      case "begin": return this.#begin(scope, value.manifest as FileManifest);
      case "$nativeBegin": {
        const manifest = this.#manifest(value.manifest as FileManifest), mapping = this.#occurrence(key, value.occurrence, manifest.id);
        return this.#begin(scope, manifest, false, mapping ? [mapping] : []);
      }
      case "$nativeCapture": return this.#capture(scope, value.sourceKey, value.path, value.occurrence);
      case "status": return this.#status(this.#entry(key, this.#id(value.id)));
      case "write": return this.#write(key, this.#id(value.id), value.offset, value.data);
      case "commit": return this.#commit(scope, this.#id(value.id));
      case "abort": return this.#abort(key, this.#id(value.id));
      case "abandon": return this.#abandon(key, this.#id(value.id));
      case "protect": return this.#protect(key, value.operationId, value.artifactIds, value.consumers);
      case "settle": return this.#settle(key, this.#id(value.operationId));
      case "releaseConsumer": return this.#releaseConsumer(key, this.#id(value.operationId), this.#id(value.consumer));
      case "$protectedOperations": return this.#protectedOperations(key, value.after, value.limit);
      case "$nativePath": {
        const file = value.file as { kind?: unknown; owner?: FileScope; path?: unknown; sourceKey?: unknown };
        if (!file || file.kind !== "disk" || !file.owner || scopeKey(file.owner) !== key || typeof file.path !== "string" || file.path.length > 4096 || !file.path || typeof file.sourceKey !== "string" || !file.sourceKey || file.sourceKey.length > 256 || !Array.isArray(value.roots) || value.roots.length > 16 || !value.roots.length || value.roots.some(root => typeof root !== "string" || !isAbsolute(root))) throw new FileError("FENCED");
        const opened = this.#openSource(this.#bindings.get(key)!, file.path, value.roots as string[]);
        try { return opened.path; } finally { closeSync(opened.fd); }
      }
      case "acquire": return this.#acquire(scope, this.#id(value.id));
      case "read": return this.#read(key, this.#id(value.leaseId), value.offset, value.length);
      case "release": return this.#release(key, this.#id(value.leaseId));
      case "capture": {
        if (value.historyScope !== undefined) throw new FileError("FENCED", "Native path context must be resolved by the Host");
        return this.#capture(scope, value.sourceKey, value.path);
      }
      case "usage": this.#inventoryUnknown(); return this.#usage(key);
      case "collect": return this.#collect(key, this.#number(value.requiredBytes), value.requiredEntries === undefined ? 0 : this.#number(value.requiredEntries));
      case "sweep": return this.#sweep(key);
      default: throw new FileError("INVALID", "Unknown file method");
    }
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const lease of this.#leases.values()) closeSync(lease.descriptor);
    this.#leases.clear(); this.#store.close();
  }
  #id(value: unknown): string { if (typeof value !== "string") throw new FileError("INVALID"); assertId(value); return value; }
  #number(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new FileError("INVALID"); return value as number; }
  #entries(): Entry[] { return this.#rows<Entry>("entries"); }
  #rows<T>(table: string): T[] { return this.#store.database.prepare(`SELECT json FROM ${table}`).all().map(row => JSON.parse(String(row.json)) as T); }
  #entry(scope: string, id: string): Entry | undefined { return this.#get<Entry>("entries", scope, id); }
  #get<T>(table: string, scope: string, id: string): T | undefined { const row = this.#store.database.prepare(`SELECT json FROM ${table} WHERE scope=? AND id=?`).get(scope, id); return row ? JSON.parse(String(row.json)) as T : undefined; }
  #put(table: string, row: { scope: string; id: string }): void {
    if (table === "entries") {
      const entry = row as Entry; let actual = 0;
      for (const path of [this.#stage(entry), this.#object(entry)]) if (existsSync(path)) actual += lstatSync(path).size;
      const staging = entry.state === "uploading" || entry.state === "publishing";
      this.#store.database.prepare("INSERT INTO entries(scope,id,json,metadata_size,state,committed_at,draft_until,actual_bytes,charged_bytes,reserved_bytes,staging_bytes,trash_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET json=excluded.json,metadata_size=excluded.metadata_size,state=excluded.state,committed_at=excluded.committed_at,draft_until=excluded.draft_until,actual_bytes=excluded.actual_bytes,charged_bytes=excluded.charged_bytes,reserved_bytes=excluded.reserved_bytes,staging_bytes=excluded.staging_bytes,trash_bytes=excluded.trash_bytes")
        .run(entry.scope, entry.id, JSON.stringify(entry), this.#metadataCharge(table, row), entry.state, entry.capturedAt, entry.draftUntil, actual, staging ? Math.max(actual, entry.manifest.bytes) : actual, staging ? Math.max(0, entry.manifest.bytes - actual) : 0, staging ? actual : 0, entry.state === "expired" || entry.state === "aborted" ? actual : 0);
    } else this.#store.database.prepare(`INSERT INTO ${table}(scope,id,json,metadata_size) VALUES(?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET json=excluded.json,metadata_size=excluded.metadata_size`).run(row.scope, row.id, JSON.stringify(row), this.#metadataCharge(table, row));
  }
  #transitionPages(): number { return 16 + 8 * Math.ceil(Math.log2(Math.max(2, this.#limits.databaseBytes / this.#pageSize))); }
  #reserveWalSpace(maximumPages: number): void {
    // A WAL has one 32-byte header and a 24-byte header for every database-page frame.
    const reserve = 32 + maximumPages * (this.#pageSize + 24);
    if (reserve > this.#limits.walBytes) throw new FileError("STORAGE_FULL", "WAL transition capacity is full");
    if (this.#physical().walBytes + reserve <= this.#limits.walBytes) return;
    this.#checkpoint(true);
    if (this.#physical().walBytes + reserve > this.#limits.walBytes) throw new FileError("STORAGE_FULL", "WAL transition capacity could not settle");
  }
  #txn(fn: () => void, maximumPages = this.#transitionPages()): void {
    this.#reserveWalSpace(maximumPages);
    this.#store.database.exec("BEGIN IMMEDIATE");
    try { fn(); this.#store.database.exec("COMMIT"); }
    catch (error) { this.#store.database.exec("ROLLBACK"); throw error; }
  }
  #checkpoint(threshold = false): void {
    if (this.#options.qualification?.failCheckpoint) throw new FileError("STORAGE_FULL", "Checkpoint unavailable; new file transitions are refused");
    if (threshold && this.#options.qualification?.failCheckpointOnceAtThreshold && !this.#failedThresholdCheckpoint) {
      this.#failedThresholdCheckpoint = true;
      throw new FileError("STORAGE_FULL", "Checkpoint unavailable; reconcile the original file identity");
    }
    const result = this.#store.checkpoint("TRUNCATE");
    if (result.busy) throw new FileError("STORAGE_FULL", "Ledger checkpoint could not settle");
  }
  #crash(phase: NonNullable<FileHostOptions["qualification"]>["crashAt"]): void { if (this.#options.qualification?.crashAt === phase) process.exit(71); }
  #status(entry: Entry | undefined): UploadStatus {
    if (!entry) return { state: "missing" };
    if (entry.state === "publishing") this.#publish(entry);
    if (entry.state === "committed") return { state: "committed", artifact: this.#artifact(entry) };
    if (entry.state === "expired" || entry.state === "aborted") return { state: entry.state, manifest: entry.manifest };
    return { state: "uploading", manifest: entry.manifest, offset: entry.offset };
  }
  #artifact(entry: Entry): ArtifactRef { return { kind: "artifact", owner: this.#scope(entry), id: entry.id, name: entry.manifest.name, mediaType: entry.manifest.mediaType, bytes: entry.manifest.bytes, sha256: entry.manifest.sha256, capturedAt: entry.capturedAt }; }
  #scope(entry: Entry): FileScope { const [connection, principal, host, session] = JSON.parse(entry.scope) as string[]; return { connection: connection!, principal: principal!, host: host!, session: session! }; }
  #manifest(value: FileManifest): FileManifest {
    if (!value || typeof value !== "object") throw new FileError("INVALID");
    assertId(value.id);
    if (typeof value.name !== "string" || value.name.length > 512 || !value.name || /[\x00-\x1f\x7f]/u.test(value.name) || typeof value.mediaType !== "string" || value.mediaType.length > 256 || /[\x00-\x20\x7f]/u.test(value.mediaType) || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > this.#limits.maxFileBytes) throw new FileError("INVALID", "Invalid bounded file manifest");
    return { id: value.id, name: value.name, mediaType: value.mediaType, bytes: value.bytes, sha256: value.sha256 };
  }
  #begin(scope: FileScope, value: FileManifest, capture = false, mappings: readonly Capture[] = []): UploadStatus {
    const manifest = this.#manifest(value); const key = scopeKey(scope);
    const existing = this.#entry(key, manifest.id);
    if (existing) {
      if (JSON.stringify(existing.manifest) !== JSON.stringify(manifest)) throw new FileError("CONFLICT", "Upload identity already has another manifest");
      if (mappings.length) { this.#admitCombined(key, mappings); this.#txn(() => { for (const mapping of mappings) this.#put("captures", mapping); }); }
      if (existing.state === "committed" && existing.draftUntil > this.#at) {
        existing.draftUntil = this.#at + this.#limits.stagingTtlMs;
        this.#txn(() => this.#put("entries", existing));
      }
      if (existing.state === "uploading") this.#prepareStage(existing);
      return this.#status(existing);
    }
    this.#expireUploads();
    this.#sweep(key, false);
    const uploading = this.#store.database.prepare("SELECT COUNT(*) count,COALESCE(SUM(json_extract(json,'$.manifest.bytes')),0) bytes FROM entries WHERE state IN('uploading','publishing')").get()!;
    if (Number(uploading.count) >= this.#limits.maxUploads || Number(uploading.bytes) + manifest.bytes > this.#limits.stagingBytes) throw new FileError("STORAGE_FULL", "Staging capacity is full");
    const entry: Entry = { scope: key, id: manifest.id, manifest, state: "uploading", offset: 0, createdAt: this.#at, progressAt: this.#at, capturedAt: 0, draftUntil: 0, file: randomUUID(), capture, device: "", inode: "" };
    this.#admit(key, entry, "entries");
    if (mappings.length) this.#admitCombined(key, [entry, ...mappings]);
    const added = 1 + mappings.length;
    this.#collect(key, manifest.bytes, added);
    if (!this.#fits(key, manifest.bytes, added)) throw new FileError("STORAGE_FULL", "Protected file capacity is full");
    this.#txn(() => { this.#put("entries", entry); for (const mapping of mappings) this.#put("captures", mapping); }, this.#transitionPages() * added);
    this.#crash("reserved");
    this.#prepareStage(entry);
    return this.#status(entry);
  }
  #write(scope: string, id: string, offsetInput: unknown, dataInput: unknown): UploadStatus {
    const offset = this.#number(offsetInput);
    if (!(dataInput instanceof Uint8Array) || dataInput.length > this.#limits.chunkBytes) throw new FileError("INVALID", "Invalid bounded chunk");
    const entry = this.#require(scope, id);
    if (entry.state === "publishing") this.#publish(entry);
    if (entry.state === "expired" || entry.state === "aborted") throw new FileError("EXPIRED");
    if (offset > entry.offset || offset + dataInput.length > entry.manifest.bytes || offset < entry.offset && offset + dataInput.length > entry.offset) throw new FileError("CONFLICT", "Upload offset conflicts with acknowledged progress");
    const path = entry.state === "committed" ? this.#object(entry) : this.#stage(entry);
    const fd = this.#openOwned(path, entry.state === "committed" ? constants.O_RDONLY : constants.O_RDWR, entry);
    try {
      if (offset < entry.offset || entry.state === "committed") {
        const old = Buffer.alloc(dataInput.length);
        if (readSync(fd, old, 0, old.length, offset) !== old.length || !old.equals(Buffer.from(dataInput))) throw new FileError("CONFLICT", "Repeated chunk differs from original bytes");
        return this.#status(entry);
      }
      // Refuse a failed checkpoint before issuing this new unacknowledged file write.
      this.#reserveWalSpace(this.#transitionPages());
      let count = 0;
      while (count < dataInput.length) { const wrote = writeSync(fd, dataInput, count, dataInput.length - count, offset + count); if (!wrote) throw new FileError("IO"); count += wrote; }
      fsyncSync(fd); this.#crash("flushed");
      entry.offset += dataInput.length;
      if (dataInput.length) entry.progressAt = this.#at;
      this.#txn(() => this.#put("entries", entry)); this.#crash("acknowledged");
      return this.#status(entry);
    } finally { closeSync(fd); }
  }
  #commit(scope: FileScope, id: string): ArtifactRef {
    const entry = this.#require(scopeKey(scope), id);
    if (entry.state === "committed") return this.#artifact(entry);
    if (entry.state === "publishing") return this.#publish(entry);
    if (entry.state !== "uploading" || entry.offset !== entry.manifest.bytes) throw new FileError(entry.state === "expired" || entry.state === "aborted" ? "EXPIRED" : "CONFLICT", "Upload is not complete");
    this.#verify(this.#stage(entry), entry.manifest, false, entry);
    entry.state = "publishing"; entry.capturedAt = this.#at; entry.draftUntil = entry.capture ? 0 : this.#at + this.#limits.stagingTtlMs;
    this.#txn(() => this.#put("entries", entry)); this.#crash("publishing");
    return this.#publish(entry);
  }
  #publish(entry: Entry): ArtifactRef {
    if (entry.state === "committed") return this.#artifact(entry);
    if (entry.state !== "publishing") throw new FileError("CONFLICT");
    if (existsSync(this.#object(entry))) this.#verify(this.#object(entry), entry.manifest, false, entry);
    else {
      this.#verify(this.#stage(entry), entry.manifest, false, entry);
      if (this.#options.qualification?.failPublishOnce && !this.#failedPublish) { this.#failedPublish = true; throw new FileError("IO", "Publication could not settle; reconcile this original identity"); }
      renameSync(this.#stage(entry), this.#object(entry));
    }
    this.#flushDir(this.#staging); this.#flushDir(this.#objects); this.#crash("renamed");
    entry.state = "committed"; this.#txn(() => this.#put("entries", entry)); this.#crash("published");
    return this.#artifact(entry);
  }
  #require(scope: string, id: string): Entry { const entry = this.#entry(scope, id); if (!entry) throw new FileError("NOT_FOUND"); return entry; }
  #abort(scope: string, id: string): UploadStatus {
    const entry = this.#require(scope, id);
    if (entry.state === "committed") throw new FileError("CONFLICT", "Committed uploads cannot be aborted");
    if (entry.state === "uploading") { entry.state = "aborted"; this.#txn(() => this.#put("entries", entry)); this.#remove(entry); }
    return this.#status(entry);
  }
  #abandon(scope: string, id: string): void { const entry = this.#require(scope, id); if (entry.state !== "committed") throw new FileError("CONFLICT"); entry.draftUntil = 0; this.#txn(() => this.#put("entries", entry)); }
  #protect(scope: string, operationId: unknown, artifactIds: unknown, consumers: unknown): void {
    const id = this.#id(operationId);
    if (!Array.isArray(artifactIds) || !Array.isArray(consumers) || artifactIds.length > 256 || consumers.length > 64) throw new FileError("INVALID");
    const artifacts = [...new Set(artifactIds.map(value => this.#id(value)))].sort(); const native = [...new Set(consumers.map(value => this.#id(value)))].sort();
    const old = this.#get<Operation>("operations", scope, id);
    if (old) { if (JSON.stringify(old.artifacts) !== JSON.stringify(artifacts) || JSON.stringify(old.consumers) !== JSON.stringify(native)) throw new FileError("CONFLICT"); return; }
    const entries = artifacts.map(artifact => this.#require(scope, artifact));
    for (const entry of entries) if (entry.state !== "committed") throw new FileError("EXPIRED", "An input expired before admission");
    // Full fixed-length release state is charged up front; release can only shrink JSON.
    const operation: Operation = { scope, id, artifacts, consumers: native, released: native.map(() => false), settled: false };
    this.#admit(scope, operation, "operations");
    this.#txn(() => { this.#put("operations", operation); for (const entry of entries) { entry.draftUntil = 0; this.#put("entries", entry); } }, this.#transitionPages() * (entries.length + 1));
  }
  #settle(scope: string, id: string): void { const operation = this.#get<Operation>("operations", scope, id); if (!operation) throw new FileError("NOT_FOUND"); operation.settled = true; this.#txn(() => this.#put("operations", operation)); }
  #releaseConsumer(scope: string, id: string, consumer: string): void {
    const operation = this.#get<Operation>("operations", scope, id); if (!operation) throw new FileError("NOT_FOUND");
    if (!operation.consumers.includes(consumer)) throw new FileError("FENCED", "Consumer is not registered for this operation");
    operation.released[operation.consumers.indexOf(consumer)] = true;
    this.#txn(() => this.#put("operations", operation));
  }
  #protectedOperations(scope: string, after: unknown, inputLimit: unknown): unknown {
    const limit = inputLimit === undefined ? this.#limits.cleanupBatch : this.#number(inputLimit);
    if (!limit || limit > this.#limits.cleanupBatch) throw new FileError("INVALID");
    const cursor = after === undefined ? "" : this.#id(after);
    const rows = this.#store.database.prepare("SELECT id,json FROM operations WHERE scope=? AND id>? ORDER BY id LIMIT ?").all(scope, cursor, limit + 1);
    const selected = rows.slice(0, limit).map(row => JSON.parse(String(row.json)) as Operation);
    return { operations: selected.map(row => ({ id: row.id, settled: row.settled, consumers: row.consumers.map((id, index) => ({ id, released: row.released[index] })) })), next: rows.length > limit ? selected.at(-1)!.id : null };
  }
  #acquire(scope: FileScope, id: string): { leaseId: string; artifact: ArtifactRef } {
    if (this.#leases.size >= this.#limits.maxReads) throw new FileError("BUSY", "Read lease capacity is full");
    const entry = this.#require(scopeKey(scope), id); if (entry.state !== "committed") throw new FileError("EXPIRED");
    const fd = this.#verify(this.#object(entry), entry.manifest, true, entry);
    const status = fstatSync(fd); const leaseId = randomUUID();
    this.#leases.set(leaseId, { scope: entry.scope, id, descriptor: fd, dev: status.dev, ino: status.ino, bytes: entry.manifest.bytes, mtimeMs: status.mtimeMs, ctimeMs: status.ctimeMs });
    return { leaseId, artifact: this.#artifact(entry) };
  }
  #read(scope: string, leaseId: string, offsetInput: unknown, lengthInput: unknown): Uint8Array {
    const lease = this.#leases.get(leaseId); if (!lease || lease.scope !== scope) throw new FileError("FENCED");
    const offset = this.#number(offsetInput); const length = this.#number(lengthInput);
    if (length > this.#limits.chunkBytes || offset > lease.bytes || offset + length > lease.bytes) throw new FileError("INVALID");
    const status = fstatSync(lease.descriptor);
    if (!status.isFile() || status.dev !== lease.dev || status.ino !== lease.ino || status.size !== lease.bytes || status.nlink !== 1 || status.mtimeMs !== lease.mtimeMs || status.ctimeMs !== lease.ctimeMs) throw new FileError("CORRUPT");
    const body = Buffer.alloc(length); if (readSync(lease.descriptor, body, 0, length, offset) !== length) throw new FileError("CORRUPT");
    const after = fstatSync(lease.descriptor); if (after.mtimeMs !== lease.mtimeMs || after.ctimeMs !== lease.ctimeMs || after.size !== lease.bytes) throw new FileError("CORRUPT");
    return body;
  }
  #release(scope: string, leaseId: string): void {
    const lease = this.#leases.get(leaseId); if (!lease) return; if (lease.scope !== scope) throw new FileError("FENCED");
    closeSync(lease.descriptor); this.#leases.delete(leaseId);
  }
  #occurrence(scope: string, raw: unknown, artifact: string): Capture | undefined {
    if (!raw || typeof raw !== "object") throw new FileError("INVALID");
    const value = raw as { key: unknown; signature: unknown };
    if (Object.keys(value).some(key => key !== "key" && key !== "signature") || typeof value.key !== "string" || !/^native-occurrence-[a-f0-9]{64}$/.test(value.key) || typeof value.signature !== "string" || !/^[a-f0-9]{64}$/.test(value.signature)) throw new FileError("INVALID");
    const prior = this.#get<Capture>("captures", scope, value.key);
    if (prior) {
      if (prior.signature !== value.signature || prior.artifact !== artifact) throw new FileError("CONFLICT", "Native occurrence identity changed");
      return;
    }
    return { scope, id: value.key, source: value.key, path: "", artifact, signature: value.signature };
  }
  #capture(scope: FileScope, sourceInput: unknown, pathInput: unknown, occurrence?: unknown): ArtifactRef {
    if (typeof sourceInput !== "string" || !sourceInput || sourceInput.length > 1024 || /[\x00-\x1f\x7f]/u.test(sourceInput)) throw new FileError("INVALID");
    const source = sourceInput;
    if (source.startsWith("native-occurrence-")) throw new FileError("FENCED", "Reserved native occurrence namespace");
    if (typeof pathInput !== "string" || pathInput.length > 4096 || !pathInput || pathInput.includes("\0")) throw new FileError("INVALID");
    const key = scopeKey(scope); const existing = this.#get<Capture>("captures", key, source);
    if (existing) {
      if (existing.path !== pathInput) throw new FileError("CONFLICT", "Capture source already names another path");
      if (occurrence !== undefined) {
        const mapping = this.#occurrence(key, occurrence, existing.artifact);
        if (mapping) { this.#admit(key, mapping, "captures"); this.#txn(() => this.#put("captures", mapping)); }
      }
      const entry = this.#require(key, existing.artifact);
      if (entry.state === "committed") return this.#artifact(entry);
      if (entry.state === "publishing") return this.#publish(entry);
      if (entry.state !== "uploading") throw new FileError("EXPIRED", "Historical capture is unavailable");
      const data = this.#readSource(this.#bindings.get(key)!, pathInput);
      if (hash(data) !== entry.manifest.sha256 || data.length !== entry.manifest.bytes) throw new FileError("CORRUPT", "Interrupted capture cannot be completed from changed source bytes");
      for (let offset = entry.offset; offset < data.length; offset += this.#limits.chunkBytes) this.#write(key, entry.id, offset, data.subarray(offset, offset + this.#limits.chunkBytes));
      return this.#commit(scope, entry.id);
    }
    const data = this.#readSource(this.#bindings.get(key)!, pathInput);
    const id = randomUUID(); const capture: Capture = { scope: key, id: source, source, path: pathInput, artifact: id };
    const native = occurrence === undefined ? undefined : this.#occurrence(key, occurrence, id);
    const manifest: FileManifest = { id, name: basename(pathInput), mediaType: "application/octet-stream", bytes: data.length, sha256: hash(data) };
    this.#begin(scope, manifest, true, native ? [capture, native] : [capture]);
    for (let offset = 0; offset < data.length; offset += this.#limits.chunkBytes) this.#write(key, id, offset, data.subarray(offset, offset + this.#limits.chunkBytes));
    return this.#commit(scope, id);
  }
  #collect(scope: string, requiredBytes: number, requiredEntries: number): { expired: string[]; reclaimedBytes: number } {
    if (requiredBytes > this.#limits.hostBytes || requiredBytes > this.#limits.sessionBytes) return { expired: [], reclaimedBytes: 0 };
    // Expiry preserves identity, so it cannot create metadata/entry capacity.
    if (this.#count() + requiredEntries > this.#limits.hostEntries || this.#count(scope) + requiredEntries > this.#limits.sessionEntries) return { expired: [], reclaimedBytes: 0 };
    const expired: string[] = []; let reclaimedBytes = 0;
    const usage = this.#usage(scope); const ownPressure = usage.sessionBytes + requiredBytes > this.#limits.sessionBytes;
    const leases = [...this.#leases.values()].map(lease => ({ scope: lease.scope, id: lease.id }));
    // SQLite uses the state/time index, and only bounded eligible candidates leave the worker ledger.
    const rows = this.#store.database.prepare(`SELECT e.json FROM entries e WHERE e.state='committed' AND e.draft_until<=? ${ownPressure ? "AND e.scope=?" : ""}
      AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.scope=e.scope
        AND (json_extract(o.json,'$.settled')=0 OR EXISTS(SELECT 1 FROM json_each(o.json,'$.released') WHERE value=0))
        AND EXISTS(SELECT 1 FROM json_each(o.json,'$.artifacts') WHERE value=e.id))
      AND NOT EXISTS(SELECT 1 FROM json_each(?) leases WHERE json_extract(leases.value,'$.scope')=e.scope AND json_extract(leases.value,'$.id')=e.id)
      ORDER BY e.committed_at,e.scope,e.id LIMIT ?`).all(this.#at, ...(ownPressure ? [scope] : []), JSON.stringify(leases), this.#limits.cleanupBatch);
    const candidates = rows.map(row => JSON.parse(String(row.json)) as Entry);
    for (const entry of candidates) {
      if (this.#fits(scope, requiredBytes, requiredEntries) || expired.length >= this.#limits.cleanupBatch) break;
      entry.state = "expired"; entry.draftUntil = 0;
      this.#txn(() => this.#put("entries", entry)); expired.push(entry.id); this.#crash("expired");
      reclaimedBytes += this.#remove(entry);
    }
    return { expired, reclaimedBytes };
  }
  /** Staging admission is global, so abandoned uploads must expire across session scopes. */
  #expireUploads(): void {
    const candidates = this.#store.database.prepare("SELECT json FROM entries WHERE state='uploading' AND json_extract(json,'$.progressAt')<=? ORDER BY json_extract(json,'$.progressAt'),scope,id LIMIT ?")
      .all(this.#at - this.#limits.stagingTtlMs, this.#limits.cleanupBatch).map(row => JSON.parse(String(row.json)) as Entry);
    this.#sweepEntries(candidates);
  }
  #sweep(scope: string, uploads = true): { expired: string[]; reclaimedBytes: number } {
    const candidates = this.#store.database.prepare("SELECT json FROM entries WHERE scope=? AND ((? AND state='uploading' AND json_extract(json,'$.progressAt')<=?) OR (state='committed' AND draft_until>0 AND draft_until<=?) OR (state IN('expired','aborted') AND actual_bytes>0)) ORDER BY committed_at,id LIMIT ?")
      .all(scope, uploads ? 1 : 0, this.#at - this.#limits.stagingTtlMs, this.#at, this.#limits.cleanupBatch).map(row => JSON.parse(String(row.json)) as Entry);
    return this.#sweepEntries(candidates);
  }
  #sweepEntries(candidates: readonly Entry[]): { expired: string[]; reclaimedBytes: number } {
    const expired: string[] = []; let reclaimedBytes = 0;
    for (const entry of candidates) {
      if (entry.state === "uploading" && entry.progressAt + this.#limits.stagingTtlMs <= this.#at) {
        entry.state = "expired"; this.#txn(() => this.#put("entries", entry)); expired.push(entry.id); reclaimedBytes += this.#remove(entry);
      } else if (entry.state === "committed" && entry.draftUntil && entry.draftUntil <= this.#at) { entry.draftUntil = 0; this.#txn(() => this.#put("entries", entry)); }
      else if (entry.state === "expired" || entry.state === "aborted") reclaimedBytes += this.#remove(entry);
    }
    return { expired, reclaimedBytes };
  }
  #fits(scope: string, addedBytes: number, addedEntries: number): boolean {
    const usage = this.#usage(scope); const own = this.#count(scope);
    return usage.hostBytes + addedBytes <= this.#limits.hostBytes && usage.sessionBytes + addedBytes <= this.#limits.sessionBytes && usage.entries + addedEntries <= this.#limits.hostEntries && own + addedEntries <= this.#limits.sessionEntries;
  }
  #count(scope?: string): number { return ["entries", "operations", "captures"].reduce((sum, table) => sum + Number(this.#store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}${scope ? " WHERE scope=?" : ""}`).get(...(scope ? [scope] : []))!.count), 0); }
  #admit(scope: string, row: { scope: string; id: string }, table: string): void {
    const size = this.#metadataCharge(table, row); const metadata = this.#metadata();
    const own = metadata.get(scope) ?? 0; const total = [...metadata.values()].reduce((sum, value) => sum + value, 0);
    // Fixed reserved transition capacity prevents ordinary admission exhausting release/expiry writes.
    if (size > 32 * 1024 || own + size + 4096 > this.#limits.sessionMetadataBytes || total + size + 4096 > this.#limits.hostMetadataBytes || this.#count(scope) + 1 > this.#limits.sessionEntries || this.#count() + 1 > this.#limits.hostEntries) throw new FileError("STORAGE_FULL", "Ledger metadata capacity is full");
    this.#reserveWalSpace(this.#transitionPages() + Math.ceil(2 * size / this.#pageSize));
    const physical = this.#physical();
    const logical = Number(this.#store.database.prepare("PRAGMA page_count").get()!.page_count) * this.#pageSize;
    const free = Number(this.#store.database.prepare("PRAGMA freelist_count").get()!.freelist_count) * this.#pageSize;
    const reserve = this.#transitionPages() * this.#pageSize;
    if (logical - free + 2 * size + reserve > this.#limits.databaseBytes || physical.dbBytes > this.#limits.databaseBytes) throw new FileError("STORAGE_FULL", "Ledger physical capacity is full");
    void table;
  }
  #admitCombined(scope: string, rows: readonly { scope: string; id: string }[]): void {
    const size = rows.reduce((sum, row) => sum + this.#metadataCharge("manifest" in row ? "entries" : "captures", row), 0); const metadata = this.#metadata();
    if ((metadata.get(scope) ?? 0) + size + 4096 > this.#limits.sessionMetadataBytes || [...metadata.values()].reduce((sum, value) => sum + value, 0) + size + 4096 > this.#limits.hostMetadataBytes || this.#count(scope) + rows.length > this.#limits.sessionEntries || this.#count() + rows.length > this.#limits.hostEntries) throw new FileError("STORAGE_FULL", "Ledger metadata capacity is full");
    this.#reserveWalSpace(rows.length * this.#transitionPages() + Math.ceil(2 * size / this.#pageSize));
    const logical = Number(this.#store.database.prepare("PRAGMA page_count").get()!.page_count) * this.#pageSize;
    const free = Number(this.#store.database.prepare("PRAGMA freelist_count").get()!.freelist_count) * this.#pageSize;
    const reserve = rows.length * this.#transitionPages() * this.#pageSize;
    if (logical - free + 2 * size + reserve > this.#limits.databaseBytes) throw new FileError("STORAGE_FULL", "Ledger physical capacity is full");
  }
  #metadata(): Map<string, number> {
    const result = new Map<string, number>();
    for (const table of ["entries", "operations", "captures"]) for (const row of this.#store.database.prepare(`SELECT scope,SUM(metadata_size) size FROM ${table} GROUP BY scope`).all()) result.set(String(row.scope), (result.get(String(row.scope)) ?? 0) + Number(row.size));
    return result;
  }
  #metadataCharge(table: string, row: { scope: string; id: string }): number {
    if (table === "entries") {
      const entry = row as Entry;
      return bytesOf({ ...entry, offset: entry.manifest.bytes, createdAt: Number.MAX_SAFE_INTEGER, progressAt: Number.MAX_SAFE_INTEGER, capturedAt: Number.MAX_SAFE_INTEGER, draftUntil: Number.MAX_SAFE_INTEGER, state: "publishing", device: "9".repeat(32), inode: "9".repeat(32) });
    }
    if (table === "operations") { const operation = row as Operation; return bytesOf({ ...operation, settled: false, released: operation.consumers.map(() => false) }); }
    return bytesOf(row);
  }
  #physical(): { dbBytes: number; walBytes: number } { const file = join(this.#directory, "files.sqlite"); return { dbBytes: existsSync(file) ? statSync(file).size : 0, walBytes: existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0 }; }
  #usage(scope: string): FileUsage {
    const row = this.#store.database.prepare("SELECT COALESCE(SUM(charged_bytes),0) host,COALESCE(SUM(CASE WHEN scope=? THEN charged_bytes ELSE 0 END),0) session,COALESCE(SUM(reserved_bytes),0) reserved,COALESCE(SUM(staging_bytes),0) staging,COALESCE(SUM(trash_bytes),0) trash FROM entries").get(scope)!;
    const metadata = this.#metadata();
    return { hostBytes: Number(row.host) + this.#unknownBytes, sessionBytes: Number(row.session), reservedBytes: Number(row.reserved), stagingBytes: Number(row.staging), trashBytes: Number(row.trash), entries: this.#count(), metadataBytes: [...metadata.values()].reduce((sum, value) => sum + value, 0), activeReads: this.#leases.size, activeWrites: 0, ...this.#physical() };
  }
  #inventoryUnknown(): void {
    const known = new Set<string>(); for (const entry of this.#entries()) { known.add(this.#stage(entry)); known.add(this.#object(entry)); }
    let bytes = 0;
    // Explicit inventory/startup only; no directory walk on upload/write/admission or per GC candidate.
    for (const directory of [this.#staging, this.#objects]) for (const name of readdirSync(directory)) { const path = join(directory, name); if (!known.has(path)) bytes += lstatSync(path).size; }
    this.#unknownBytes = bytes;
  }
  #remove(entry: Entry): number {
    let reclaimed = 0;
    if (this.#options.qualification?.failUnlink) return 0;
    for (const path of [this.#stage(entry), this.#object(entry)]) {
      if (!existsSync(path)) continue;
      const status = lstatSync(path);
      if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) continue;
      const identity = lstatSync(path, { bigint: true });
      if (!entry.device || !entry.inode || String(identity.dev) !== entry.device || String(identity.ino) !== entry.inode) continue;
      try { unlinkSync(path); reclaimed += status.size; this.#flushDir(dirname(path)); } catch { /* Failed deletion remains charged for the next bounded sweep. */ }
    }
    this.#txn(() => this.#put("entries", entry));
    return reclaimed;
  }
  #stage(entry: Entry): string { return join(this.#staging, entry.file); }
  #object(entry: Entry): string { return join(this.#objects, entry.file); }
  #prepareStage(entry: Entry): void {
    const path = this.#stage(entry);
    if (existsSync(path)) { const fd = this.#openOwned(path, constants.O_RDWR, entry); closeSync(fd); return; }
    if (entry.offset || entry.device || entry.inode) throw new FileError("CORRUPT", "Acknowledged staging bytes are unavailable");
    this.#reserveWalSpace(this.#transitionPages());
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { fsyncSync(fd); const status = fstatSync(fd, { bigint: true }); entry.device = String(status.dev); entry.inode = String(status.ino); this.#txn(() => this.#put("entries", entry)); }
    finally { closeSync(fd); }
    this.#flushDir(this.#staging);
  }
  #openOwned(path: string, flags: number, entry: Entry): number {
    if (!existsSync(path)) throw new FileError("CORRUPT", "Stored bytes are unavailable");
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new FileError("CORRUPT");
    const fd = openSync(path, flags | (constants.O_NOFOLLOW ?? 0));
    const after = fstatSync(fd);
    const identity = fstatSync(fd, { bigint: true });
    if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino || !entry.device || !entry.inode || String(identity.dev) !== entry.device || String(identity.ino) !== entry.inode) { closeSync(fd); throw new FileError("CORRUPT"); }
    assertPrivateFilesSync([path]); return fd;
  }
  #verify(path: string, manifest: FileManifest, retain: boolean, entry: Entry): number {
    const fd = this.#openOwned(path, constants.O_RDONLY, entry);
    try {
      const before = fstatSync(fd); if (before.size !== manifest.bytes) throw new FileError("CORRUPT", "Stored byte length changed");
      const hasher = createHash("sha256"); const body = Buffer.alloc(Math.min(this.#limits.chunkBytes, Math.max(1, manifest.bytes)));
      for (let offset = 0; offset < manifest.bytes;) { const count = readSync(fd, body, 0, Math.min(body.length, manifest.bytes - offset), offset); if (!count) throw new FileError("CORRUPT"); hasher.update(body.subarray(0, count)); offset += count; }
      const after = fstatSync(fd); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || hasher.digest("hex") !== manifest.sha256) throw new FileError("CORRUPT", "Stored checksum changed");
      if (retain) return fd; closeSync(fd); return -1;
    } catch (error) { closeSync(fd); throw error; }
  }
  #openSource(binding: Binding, input: string, nativeRoots?: readonly string[]): { fd: number; path: string } {
    if (binding.dialect !== (process.platform === "win32" ? "win32" : "posix")) throw new FileError("UNSUPPORTED", "Preview reader requires the Host filesystem dialect");
    if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !(process.platform === "win32" && /^[a-z]:[\\/]/i.test(input)) || input.startsWith("\\\\") || input.startsWith("//")) throw new FileError("FENCED");
    if (process.platform !== "linux") throw new FileError("UNSUPPORTED", "This isolated reader is qualified only for Linux handles");
    const target = resolve(binding.cwd, input);
    const canonical = realpathSync(target);
    const privateRoots = [this.#directory, ...(this.#options.privateRoots ?? [])].map(path => existsSync(path) ? realpathSync(path) : resolve(path));
    const allowed = [binding.cwd, ...(this.#options.allowedRoots ?? [])].map(path => realpathSync(path));
    const visible = nativeRoots?.map(path => realpathSync(path));
    const permitted = (path: string): boolean => !privateRoots.some(root => within(root, path)) && (this.#options.broadPaths === true || allowed.some(root => within(root, path))) && (visible === undefined || visible.some(root => within(root, path)));
    if (!permitted(canonical)) throw new FileError("FENCED", "Preview path is outside its granted roots");
    const namedBefore = lstatSync(target);
    if (!namedBefore.isFile() || namedBefore.isSymbolicLink() || namedBefore.nlink !== 1) throw new FileError("FENCED", "Preview source is not a regular unlinked file");
    const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      const actual = realpathSync(`/proc/self/fd/${fd}`);
      if (!permitted(actual) || canonical !== actual || !before.isFile() || before.nlink !== 1 || before.size > this.#limits.maxFileBytes) throw new FileError("FENCED", "Preview handle is not an eligible regular file");
      return { fd, path: actual };
    } catch (error) { closeSync(fd); throw error; }
  }
  #readSource(binding: Binding, input: string): Uint8Array {
    const opened = this.#openSource(binding, input), fd = opened.fd;
    try {
      const before = fstatSync(fd), target = resolve(binding.cwd, input);
      const data = Buffer.alloc(before.size);
      let offset = 0; while (offset < data.length) { const count = readSync(fd, data, offset, data.length - offset, offset); if (!count) throw new FileError("IO"); offset += count; }
      const extra = Buffer.alloc(1); const after = fstatSync(fd);
      const named = statSync(target);
      if (readSync(fd, extra, 0, 1, data.length) !== 0 || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || named.dev !== after.dev || named.ino !== after.ino || opened.path !== realpathSync(`/proc/self/fd/${fd}`)) throw new FileError("IO", "File changed while its snapshot was read");
      return data;
    } finally { closeSync(fd); }
  }
  #flushDir(directory: string): void { if (process.platform === "win32") return; const fd = openSync(directory, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
  #noSymlinkAncestors(path: string): void { let current = path; for (;;) { if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new FileError("FENCED", "Private storage cannot traverse symlinks"); const parent = dirname(current); if (parent === current) break; current = parent; } }
  #reconcile(): void {
    for (const entry of this.#entries()) {
      if (entry.state === "publishing") {
        this.#publish(entry);
      } else if (entry.state === "uploading") {
        const path = this.#stage(entry);
        if (!existsSync(path)) { if (entry.offset || entry.device || entry.inode) continue; this.#prepareStage(entry); }
        if (!entry.device || !entry.inode) { this.#txn(() => this.#put("entries", entry)); continue; }
        const fd = this.#openOwned(path, constants.O_RDWR, entry);
        try { const size = fstatSync(fd).size; if (size > entry.offset) { ftruncateSync(fd, entry.offset); fsyncSync(fd); } } finally { closeSync(fd); }
      }
      // Reconstruct actual accounting once at restart, including partial unlink/crash windows.
      this.#txn(() => this.#put("entries", entry));
    }
    // Current bindings may omit old scopes. Their data and holds remain owned and protected.
  }
}
