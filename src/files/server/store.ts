import type {
  FileLimits,
  FileStoreOptions,
  FileUsage,
  HostPathAuthority,
  NativeInputPort,
  OwnedFileStore,
} from "../node-contracts.js";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { basename, isAbsolute, join, normalize } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, scopeKey, type Json, type SessionScope } from "../../protocol/index.js";
import {
  FileError,
  mediaType,
  type FileLease,
  type HostFile,
  type Retention,
  type StoredFile,
} from "../index.js";
const defaults: FileLimits = {
  maxFileBytes: 32 * 1024 * 1024,
  maxBytes: 512 * 1024 * 1024,
  maxSessionBytes: 128 * 1024 * 1024,
  maxEntries: 4096,
  maxScopes: 4096,
  maxStagingBytes: 64 * 1024 * 1024,
  maxStaging: 4,
  maxLeases: 32,
  maxReferences: 1024,
  maxReadBytes: 1024 * 1024,
  cacheTtlMs: 10 * 60 * 1000,
};
type Entry = {
  file: StoredFile;
  createdAt: number;
  path: string;
  holds: number;
  deleting: boolean;
};
type Reservation = {
  scope: string;
  bytes: number;
};
const hash = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const key = (scope: SessionScope, id: string): string => hash(scopeKey(scope) + "\n" + id);
function copyScope(scope: SessionScope): SessionScope {
  const [connection, principal, host, session] = JSON.parse(scopeKey(scope)) as [
    string,
    string,
    string,
    string,
  ];
  return Object.freeze({ connection, principal, host, session });
}
const number = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new FileError("INVALID", "Invalid byte range");
};
function name(value: string): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 256 ||
    /[\x00-\x1f\x7f/\\]/.test(value)
  )
    throw new FileError("INVALID", "Invalid file name");
  return value;
}
function id(value: string): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 256 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new FileError("INVALID", "Invalid file identity");
  return value;
}
function privateDirectory(path: string, create = false): void {
  if (process.platform === "win32" || !process.getuid)
    throw new FileError("UNSUPPORTED", "Private file storage requires qualified POSIX ownership");
  if (!isAbsolute(path) || normalize(path) !== path)
    throw new FileError("INVALID", "Expected canonical absolute directory");
  if (create)
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== path ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new FileError("FENCED", "File directory is not private");
}
function privateHandle(fd: number, mode: number): void {
  const stat = fstatSync(fd);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid!() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== mode
  )
    throw new FileError("FENCED", "File is not privately owned");
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function list(path: string, maximum: number): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of await opendir(path)) {
    if (names.length >= maximum)
      throw new FileError("CORRUPT", "Directory entry count exceeds its bound");
    names.push(entry.name);
  }
  return names;
}
async function writePrivate(path: string, bytes: Uint8Array, mode = 0o600): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function readPrivate(path: string, max: number, mode = 0o600): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    privateHandle(handle.fd, mode);
    const before = await handle.stat();
    if (before.size > max) throw new FileError("CAPACITY", "Stored file exceeds its bound");
    const bytes = await readBounded(handle, before.size);
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new FileError("CORRUPT", "File changed while reading");
    return bytes;
  } finally {
    await handle.close();
  }
}
async function readBounded(handle: FileHandle, bytes: number): Promise<Uint8Array> {
  const result = new Uint8Array(bytes);
  let offset = 0;
  while (offset < bytes) {
    const read = await handle.read(result, offset, bytes - offset, offset);
    if (!read.bytesRead) throw new FileError("CORRUPT", "File was truncated");
    offset += read.bytesRead;
  }
  return result;
}
/** Immutable scoped bytes, with one OS-released owner and no operation journal. */
export class FileStore implements OwnedFileStore {
  readonly resourceIdentity = Object.freeze({});
  private readonly entries = new Map<string, Entry>();
  private readonly retired = new Map<string, SessionScope>();
  private readonly uploads = new Map<string, Reservation>();
  private readonly references = new Map<
    string,
    {
      scope: string;
      sourceKey: string;
      file: HostFile;
      expiresAt: number;
    }
  >();
  private readonly leases = new Set<FileLease>();
  private captures = 0;
  private resolving = 0;
  private maintenance = 0;
  private closed = false;
  private poisoned = false;
  private constructor(
    private readonly directory: string,
    private readonly lock: DatabaseSync,
    private readonly limits: FileLimits,
    private readonly authority: HostPathAuthority | undefined,
    private readonly now: () => number,
  ) {}
  static async open(options: FileStoreOptions): Promise<FileStore> {
    privateDirectory(options.directory);
    const limits = { ...defaults, ...options.limits };
    for (const value of Object.values(limits))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new FileError("INVALID", "Invalid file limit");
    if (limits.maxStagingBytes < limits.maxFileBytes)
      throw new FileError("INVALID", "Staging must fit one maximum file");
    for (const sub of ["objects", "staging", "retired"])
      privateDirectory(join(options.directory, sub), true);
    for (const item of await list(options.directory, 5))
      if (!["objects", "staging", "retired", "owner.sqlite", "owner.sqlite-journal"].includes(item))
        throw new FileError("CORRUPT", "Unrecognized private-store entry");
    const lockname = join(options.directory, "owner.sqlite");
    let fd: number;
    try {
      fd = openSync(
        lockname,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      fd = openSync(lockname, constants.O_RDWR | constants.O_NOFOLLOW);
    }
    try {
      privateHandle(fd, 0o600);
    } finally {
      closeSync(fd);
    }
    try {
      const sidecar = openSync(lockname + "-journal", constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        privateHandle(sidecar, 0o600);
      } finally {
        closeSync(sidecar);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const lock = new DatabaseSync(lockname, { timeout: 0 });
    try {
      if (
        (
          lock.prepare("SELECT COUNT(*) AS count FROM sqlite_schema").get() as {
            count: number;
          }
        ).count
      )
        throw new FileError("FENCED", "Owner lock contains foreign database state");
      lock.exec("PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;");
      const store = new FileStore(
        options.directory,
        lock,
        limits,
        options.paths,
        options.now ?? Date.now,
      );
      await store.load();
      await syncDirectory(options.directory);
      return store;
    } catch (error) {
      lock.close();
      throw error;
    }
  }
  private check(): void {
    if (this.closed) throw new FileError("CLOSED");
    if (this.poisoned)
      throw new FileError("CORRUPT", "File accounting requires reopening and exact reconciliation");
  }
  private time(): number {
    const value = this.now();
    number(value);
    return value;
  }
  private async load(): Promise<void> {
    for (const item of await list(this.directory, 5))
      if (!["objects", "staging", "retired", "owner.sqlite", "owner.sqlite-journal"].includes(item))
        throw new FileError("CORRUPT", "Unrecognized private-store entry");
    for (const item of await list(join(this.directory, "retired"), this.limits.maxScopes)) {
      if (!/^[a-f0-9]{64}$/.test(item))
        throw new FileError("CORRUPT", "Unrecognized retirement marker");
      const scope = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readPrivate(join(this.directory, "retired", item), 8192),
        ),
      ) as SessionScope;
      const scopeId = scopeKey(scope);
      if (
        hash(scopeId) !== item ||
        this.retired.size >= this.limits.maxScopes ||
        canonicalJson(scope as unknown as Json, 8192).json !==
          canonicalJson(copyScope(scope) as unknown as Json, 8192).json
      )
        throw new FileError("CORRUPT", "Retirement accounting is invalid");
      this.retired.set(scopeId, copyScope(scope));
    }
    for (const object of await list(join(this.directory, "objects"), this.limits.maxEntries)) {
      if (!/^[a-f0-9]{64}$/.test(object) || this.entries.size >= this.limits.maxEntries)
        throw new FileError("CORRUPT", "Object accounting is invalid");
      const path = join(this.directory, "objects", object);
      privateDirectory(path);
      if ((await list(path, 2)).sort().join(",") !== "data,manifest.json")
        throw new FileError("CORRUPT", "Unrecognized object content");
      const manifest = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readPrivate(join(path, "manifest.json"), 16 * 1024),
        ),
      ) as {
        file: StoredFile;
        createdAt: number;
      };
      const file = manifest.file;
      scopeKey(file.scope);
      id(file.id);
      name(file.name);
      number(file.bytes);
      number(manifest.createdAt);
      if (
        file.kind !== "stored" ||
        !["upload", "capture"].includes(file.origin) ||
        !["session", "cache"].includes(file.retention) ||
        !/^([a-f0-9]{64})$/.test(file.sha256) ||
        key(file.scope, file.id) !== object ||
        file.bytes > this.limits.maxFileBytes
      )
        throw new FileError("CORRUPT", "Invalid immutable manifest");
      const normalized = {
        file: {
          kind: "stored",
          scope: copyScope(file.scope),
          id: file.id,
          name: file.name,
          bytes: file.bytes,
          sha256: file.sha256,
          mediaType: file.mediaType,
          origin: file.origin,
          retention: file.retention,
        },
        createdAt: manifest.createdAt,
      };
      if (
        canonicalJson(manifest as unknown as Json, 16 * 1024).json !==
        canonicalJson(normalized as unknown as Json, 16 * 1024).json
      )
        throw new FileError("CORRUPT", "Unrecognized manifest metadata");
      const bytes = await readPrivate(join(path, "data"), this.limits.maxFileBytes);
      if (
        bytes.byteLength !== file.bytes ||
        hash(bytes) !== file.sha256 ||
        mediaType(bytes, file.mediaType) !== file.mediaType
      )
        throw new FileError("CORRUPT", "Immutable bytes do not match manifest");
      this.entries.set(object, {
        file: Object.freeze({ ...file, scope: copyScope(file.scope) }),
        createdAt: manifest.createdAt,
        path,
        holds: 0,
        deleting: false,
      });
    }
    this.assertCapacity();
    // Only the acquired owner may reclaim incomplete unpublished staging.
    const stages = await list(join(this.directory, "staging"), this.limits.maxStaging * 2 + 2);
    if (stages.length > this.limits.maxStaging * 2 + 2)
      throw new FileError("CORRUPT", "Staging accounting exceeds its bound");
    for (const item of stages) {
      if (!/^[a-f0-9-]{36}$/.test(item))
        throw new FileError("CORRUPT", "Unrecognized staging entry");
      const path = join(this.directory, "staging", item);
      privateDirectory(path);
      for (const child of await list(path, 2)) {
        if (!["data", "manifest.json"].includes(child))
          throw new FileError("CORRUPT", "Unrecognized staging content");
        const bytes = await readPrivate(
          join(path, child),
          child === "data" ? this.limits.maxFileBytes : 16 * 1024,
        );
        void bytes;
      }
      await rm(path, { recursive: true });
    }
    await syncDirectory(join(this.directory, "staging"));
    await this.collect();
  }
  private assertCapacity(extra?: { scope: string; bytes: number; count: number }): void {
    const scopes = new Set(this.retired.keys());
    const sessions = new Map<string, number>();
    let bytes = 0;
    for (const entry of this.entries.values()) {
      const scope = scopeKey(entry.file.scope);
      scopes.add(scope);
      bytes += entry.file.bytes;
      sessions.set(scope, (sessions.get(scope) ?? 0) + entry.file.bytes);
    }
    for (const value of this.uploads.values()) {
      scopes.add(value.scope);
      bytes += value.bytes;
      sessions.set(value.scope, (sessions.get(value.scope) ?? 0) + value.bytes);
    }
    if (extra) scopes.add(extra.scope);
    if (extra) sessions.set(extra.scope, (sessions.get(extra.scope) ?? 0) + extra.bytes);
    if (
      bytes + (extra?.bytes ?? 0) > this.limits.maxBytes ||
      [...sessions.values()].some((value) => value > this.limits.maxSessionBytes) ||
      this.entries.size + this.uploads.size + (extra?.count ?? 0) > this.limits.maxEntries ||
      scopes.size > this.limits.maxScopes
    )
      throw new FileError("CAPACITY", "File-store capacity exhausted");
  }
  usage(): FileUsage {
    this.check();
    return {
      bytes: [...this.entries.values()].reduce((n, e) => n + e.file.bytes, 0),
      entries: this.entries.size,
      reservedBytes: [...this.uploads.values()].reduce((n, e) => n + e.bytes, 0),
      trashBytes: [...this.entries.values()]
        .filter((e) => e.deleting)
        .reduce((n, e) => n + e.file.bytes, 0),
      staging: this.uploads.size + [...this.entries.values()].filter((e) => e.deleting).length,
      leases: this.leases.size,
      references: this.references.size,
    };
  }
  file(scope: SessionScope, fileId: string): StoredFile | null {
    this.check();
    return this.entries.get(key(scope, id(fileId)))?.file ?? null;
  }
  async put(
    scope: SessionScope,
    input: {
      id: string;
      name: string;
      mediaType?: string;
      retention?: Retention;
    },
    data: Uint8Array,
    origin: "upload" | "capture" = "upload",
    publication?: Readonly<{ signal?: AbortSignal; onCommitted(file: StoredFile): void }>,
  ): Promise<StoredFile> {
    this.check();
    await this.collect();
    this.check();
    publication?.signal?.throwIfAborted();
    const scopeId = scopeKey(scope);
    id(input.id);
    name(input.name);
    if (this.retired.has(scopeId))
      throw new FileError("FENCED", "Session file lifetime is retired");
    if (!(data instanceof Uint8Array) || data.byteLength > this.limits.maxFileBytes)
      throw new FileError("CAPACITY", "File exceeds its bound");
    const retention = input.retention ?? "session";
    if (!["session", "cache"].includes(retention) || !["upload", "capture"].includes(origin))
      throw new FileError("INVALID");
    const bytes = new Uint8Array(data);
    const file: StoredFile = Object.freeze({
      kind: "stored",
      scope: copyScope(scope),
      id: input.id,
      name: input.name,
      bytes: bytes.byteLength,
      sha256: hash(bytes),
      mediaType: mediaType(bytes, input.mediaType),
      origin,
      retention,
    });
    const object = key(scope, input.id);
    const existing = this.entries.get(object);
    if (existing) {
      if (
        canonicalJson(existing.file as unknown as Json, 16 * 1024).json !==
        canonicalJson(file as unknown as Json, 16 * 1024).json
      )
        throw new FileError(
          "CONFLICT",
          "File identity already has other immutable bytes or metadata",
        );
      publication?.signal?.throwIfAborted();
      publication?.onCommitted(existing.file);
      return existing.file;
    }
    if (this.uploads.has(object))
      throw new FileError("BUSY", "Original file publication is pending");
    const trash = [...this.entries.values()].filter((entry) => entry.deleting);
    const reserved =
      [...this.uploads.values()].reduce((n, r) => n + r.bytes, 0) +
      trash.reduce((n, entry) => n + entry.file.bytes, 0);
    if (
      this.uploads.size + trash.length >= this.limits.maxStaging ||
      reserved + bytes.byteLength > this.limits.maxStagingBytes
    )
      throw new FileError("CAPACITY", "Staging capacity exhausted");
    this.assertCapacity({ scope: scopeId, bytes: bytes.byteLength, count: 1 });
    this.uploads.set(object, { scope: scopeId, bytes: bytes.byteLength });
    const stage = join(this.directory, "staging", randomUUID());
    let published = false;
    try {
      await mkdir(stage, { mode: 0o700 });
      await writePrivate(join(stage, "data"), bytes);
      const createdAt = this.time();
      await writePrivate(
        join(stage, "manifest.json"),
        new TextEncoder().encode(
          canonicalJson({ file, createdAt } as unknown as Json, 16 * 1024).json,
        ),
      );
      await syncDirectory(stage);
      const path = join(this.directory, "objects", object);
      publication?.signal?.throwIfAborted();
      if (this.retired.has(scopeId)) throw new FileError("FENCED");
      await rename(stage, path);
      published = true;
      this.entries.set(object, { file, createdAt, path, holds: 0, deleting: false });
      try {
        publication?.onCommitted(file);
      } finally {
        await syncDirectory(join(this.directory, "objects"));
      }
      return file;
    } catch (error) {
      if (published) this.poisoned = true;
      throw error;
    } finally {
      if (!published)
        try {
          await rm(stage, { recursive: true, force: true });
        } catch {
          this.poisoned = true;
        }
      this.uploads.delete(object);
    }
  }
  async acquire(scope: SessionScope, file: StoredFile): Promise<FileLease> {
    this.check();
    if (scopeKey(scope) !== scopeKey(file.scope)) throw new FileError("FENCED");
    const entry = this.entries.get(key(scope, id(file.id)));
    if (!entry) throw new FileError("NOT_FOUND");
    if (entry.deleting) throw new FileError("BUSY");
    if (
      canonicalJson(file as unknown as Json, 16 * 1024).json !==
      canonicalJson(entry.file as unknown as Json, 16 * 1024).json
    )
      throw new FileError("FENCED", "File descriptor does not match immutable identity");
    if ([...this.entries.values()].reduce((n, e) => n + e.holds, 0) >= this.limits.maxLeases)
      throw new FileError("CAPACITY", "Read lease capacity exhausted");
    entry.holds++;
    let handle: FileHandle | undefined;
    try {
      handle = await open(join(entry.path, "data"), constants.O_RDONLY | constants.O_NOFOLLOW);
      privateHandle(handle.fd, 0o600);
      const initial = await handle.stat();
      if (
        initial.size !== entry.file.bytes ||
        hash(await readBounded(handle, entry.file.bytes)) !== entry.file.sha256
      )
        throw new FileError("CORRUPT", "Immutable file changed");
      const verified = await handle.stat();
      if (
        initial.mtimeMs !== verified.mtimeMs ||
        initial.ctimeMs !== verified.ctimeMs ||
        initial.size !== verified.size
      )
        throw new FileError("CORRUPT", "File changed while acquiring lease");
      let released = false;
      const owned = handle;
      let releasing: Promise<void> | undefined;
      const lease: FileLease = {
        file: entry.file,
        read: async (offset, length) => {
          this.check();
          if (released || releasing) throw new FileError("CLOSED", "Read lease released");
          number(offset);
          number(length);
          if (
            length > this.limits.maxReadBytes ||
            !Number.isSafeInteger(offset + length) ||
            offset + length > entry.file.bytes
          )
            throw new FileError("INVALID", "Read exceeds leased range");
          const before = await owned.stat();
          const data = new Uint8Array(length);
          let total = 0;
          while (total < length) {
            const result = await owned.read(data, total, length - total, offset + total);
            if (!result.bytesRead) throw new FileError("CORRUPT", "Leased file truncated");
            total += result.bytesRead;
          }
          const after = await owned.stat();
          if (
            after.size !== initial.size ||
            before.ctimeMs !== initial.ctimeMs ||
            after.ctimeMs !== initial.ctimeMs
          )
            throw new FileError("CORRUPT", "Leased file changed");
          return data;
        },
        release: () => {
          if (!releasing)
            releasing = (async () => {
              await owned.close();
              released = true;
              entry.holds--;
              this.leases.delete(lease);
            })();
          return releasing;
        },
      };
      this.leases.add(lease);
      return lease;
    } catch (error) {
      entry.holds--;
      await handle?.close();
      throw error;
    }
  }
  async reference(scope: SessionScope, sourceKey: string): Promise<HostFile> {
    this.check();
    const scopeId = scopeKey(scope);
    id(sourceKey);
    if (!this.authority) throw new FileError("UNSUPPORTED", "No Host path authority");
    this.expireReferences();
    if (this.references.size + this.resolving >= this.limits.maxReferences)
      throw new FileError("CAPACITY", "Host reference capacity exhausted");
    this.resolving++;
    try {
      const source = await this.authority.resolve(scope, sourceKey);
      this.check();
      const file: HostFile = Object.freeze({
        kind: "host",
        scope: copyScope(scope),
        id: randomUUID(),
        name: name(source.name ?? basename(source.path)),
      });
      this.references.set(file.id, {
        scope: scopeId,
        sourceKey,
        file,
        expiresAt: this.time() + this.limits.cacheTtlMs,
      });
      return file;
    } finally {
      this.resolving--;
    }
  }
  private expireReferences(): void {
    const now = this.time();
    for (const [id, reference] of this.references)
      if (reference.expiresAt <= now) this.references.delete(id);
  }
  async capture(
    scope: SessionScope,
    reference: HostFile,
    input: {
      id: string;
      retention?: Retention;
    },
  ): Promise<StoredFile> {
    this.check();
    this.expireReferences();
    const known = this.references.get(reference.id);
    if (
      reference.kind !== "host" ||
      !known ||
      known.scope !== scopeKey(scope) ||
      scopeKey(reference.scope) !== known.scope ||
      reference.name !== known.file.name
    )
      throw new FileError("FENCED", "Unknown Host-owned reference");
    if (this.captures >= this.limits.maxStaging)
      throw new FileError("CAPACITY", "Host capture capacity exhausted");
    this.captures++;
    let handle: FileHandle | undefined;
    try {
      const source = await this.authority!.resolve(scope, known.sourceKey);
      if (
        !isAbsolute(source.path) ||
        normalize(source.path) !== source.path ||
        (await realpath(source.path)) !== source.path
      )
        throw new FileError("FENCED", "Host did not authorize a canonical path");
      const expected = await lstat(source.path);
      if (!expected.isFile() || expected.isSymbolicLink())
        throw new FileError("FENCED", "Host source is not a regular file");
      handle = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat();
      if (
        before.dev !== expected.dev ||
        before.ino !== expected.ino ||
        before.size > this.limits.maxFileBytes
      )
        throw new FileError("FENCED", "Host source identity changed or exceeds bound");
      const bytes = await readBounded(handle, before.size);
      const after = await handle.stat();
      if (
        before.size !== after.size ||
        before.ctimeMs !== after.ctimeMs ||
        before.mtimeMs !== after.mtimeMs
      )
        throw new FileError("CORRUPT", "Host source changed during capture");
      return await this.put(
        scope,
        {
          id: input.id,
          name: known.file.name,
          ...(source.mediaType === undefined ? {} : { mediaType: source.mediaType }),
          retention: input.retention ?? "cache",
        },
        bytes,
        "capture",
      );
    } finally {
      await handle?.close();
      this.captures--;
    }
  }
  async prepareInput<T>(
    scope: SessionScope,
    file: StoredFile,
    port: NativeInputPort<T>,
  ): Promise<
    Readonly<{
      input: T;
      release(): Promise<void>;
    }>
  > {
    if (!port.accepts(file))
      throw new FileError("UNSUPPORTED", "Native input port does not accept this file");
    const lease = await this.acquire(scope, file);
    try {
      const input = await port.prepare({
        file: lease.file,
        path: join(this.entries.get(key(scope, file.id))!.path, "data"),
        read: (offset, length) => lease.read(offset, length),
      });
      return { input, release: () => lease.release() };
    } catch (error) {
      await lease.release();
      throw error;
    }
  }
  isRetired(scope: SessionScope): boolean {
    this.check();
    return this.retired.has(scopeKey(scope));
  }
  async retireSession(scope: SessionScope): Promise<void> {
    this.check();
    const scopeId = scopeKey(scope);
    if (this.retired.has(scopeId)) return;
    if (this.maintenance >= this.limits.maxStaging) throw new FileError("BUSY");
    this.assertCapacity({ scope: scopeId, bytes: 0, count: 0 });
    this.retired.set(scopeId, copyScope(scope));
    this.maintenance++;
    const directory = join(this.directory, "retired");
    const stage = join(this.directory, "staging", randomUUID());
    try {
      await mkdir(stage, { mode: 0o700 });
      const temporary = join(stage, "manifest.json");
      await writePrivate(
        temporary,
        new TextEncoder().encode(canonicalJson(copyScope(scope) as unknown as Json, 8192).json),
      );
      await rename(temporary, join(directory, hash(scopeId)));
      await syncDirectory(directory);
      await rm(stage, { recursive: true });
    } catch (error) {
      this.poisoned = true;
      throw error;
    } finally {
      this.maintenance--;
    }
  }
  async collect(): Promise<
    Readonly<{
      files: number;
      bytes: number;
    }>
  > {
    this.check();
    this.expireReferences();
    if (this.maintenance || this.uploads.size || this.captures) return { files: 0, bytes: 0 };
    this.maintenance++;
    const now = this.time();
    let files = 0;
    let bytes = 0;
    try {
      for (const [object, entry] of this.entries) {
        if (
          entry.holds ||
          entry.deleting ||
          !(
            this.retired.has(scopeKey(entry.file.scope)) ||
            (entry.file.retention === "cache" && entry.createdAt + this.limits.cacheTtlMs <= now)
          )
        )
          continue;
        entry.deleting = true;
        try {
          const trash = join(this.directory, "staging", randomUUID());
          await rename(entry.path, trash);
          await syncDirectory(join(this.directory, "objects"));
          await rm(trash, { recursive: true });
          await syncDirectory(join(this.directory, "staging"));
          this.entries.delete(object);
          files++;
          bytes += entry.file.bytes;
        } catch (error) {
          this.poisoned = true;
          throw error;
        }
      }
      return { files, bytes };
    } finally {
      this.maintenance--;
    }
  }
  close(): void {
    if (this.closed) return;
    if (
      this.uploads.size ||
      [...this.entries.values()].some((entry) => entry.holds) ||
      this.captures ||
      this.resolving ||
      this.maintenance
    )
      throw new FileError("BUSY", "Owned file work or leases remain");
    this.closed = true;
    this.lock.close();
  }
}
