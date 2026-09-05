import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  IMAGE_MAX_BYTES, IMAGE_MAX_CHUNK_BYTES, IMAGE_MAX_COMMAND_IMAGES,
  imageBeginUploadInputSchema, imageDescriptorSchema, imageReadInputSchema,
  imageWriteUploadInputSchema, imageUploadIdInputSchema,
  type ImageBeginUploadInput, type ImageDescriptor, type ImageLimits,
  type ImageReadInput, type ImageReadResult, type ImageTarget,
  type ImageUploadIdInput, type ImageUploadState, type ImageWriteUploadInput,
  type RuntimeNodeSessionRecord, type RuntimeNodeId, type SessionId,
} from "@arduano/agent-multiplex-protocol";

import { RuntimeNodeStore, type RuntimeImageEntry } from "./store.js";
import type { RuntimeAgentBackend } from "./adapter.js";

export class RuntimeImageError extends Error {
  constructor(readonly code: "NOT_FOUND" | "FENCED" | "CONFLICT" | "RESOURCE_EXHAUSTED" | "UNSUPPORTED", message: string) {
    super(message);
    this.name = "RuntimeImageError";
  }
}

export interface RuntimeImageOptions {
  directory?: string;
  outputRoots?: readonly string[];
  maximumSessionBytes?: number;
  maximumRuntimeBytes?: number;
  unfinishedTtlMs?: number;
}

/** Private durable image bytes. Only immutable descriptors cross the control plane. */
export class RuntimeImages {
  readonly #store: RuntimeNodeStore;
  readonly #runtimeNodeId: RuntimeNodeId;
  readonly #options: RuntimeImageOptions;
  readonly #limits: ImageLimits;
  readonly #root: Promise<string>;
  readonly #ephemeral: boolean;
  readonly #expiryTimer: ReturnType<typeof setInterval>;
  #lock: Promise<unknown> = Promise.resolve();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(store: RuntimeNodeStore, runtimeNodeId: RuntimeNodeId, options: RuntimeImageOptions = {}) {
    this.#store = store;
    this.#runtimeNodeId = runtimeNodeId;
    this.#options = options;
    this.#limits = {
      maximumImageBytes: IMAGE_MAX_BYTES,
      maximumChunkBytes: IMAGE_MAX_CHUNK_BYTES,
      maximumImagesPerCommand: IMAGE_MAX_COMMAND_IMAGES,
      maximumSessionBytes: options.maximumSessionBytes ?? 512 * 1_024 * 1_024,
      maximumRuntimeBytes: options.maximumRuntimeBytes ?? 10 * 1_024 * 1_024 * 1_024,
      mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"],
    };
    for (const value of [this.#limits.maximumSessionBytes, this.#limits.maximumRuntimeBytes, options.unfinishedTtlMs ?? 86_400_000]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("image storage limits must be positive safe integers");
    }
    const filename = store.diagnostics().filename;
    this.#ephemeral = options.directory === undefined && filename === ":memory:";
    this.#root = this.#initialize(options.directory ?? (this.#ephemeral ? undefined : `${filename}.images`));
    void this.#root.catch(() => undefined);
    this.#expiryTimer = setInterval(() => {
      void this.#serialize(() => this.#expire()).catch(() => undefined);
    }, Math.min(options.unfinishedTtlMs ?? 86_400_000, 60 * 60_000));
    this.#expiryTimer.unref();
    void this.#serialize(() => this.#expire()).catch(() => undefined);
  }

  limits(): ImageLimits { return { ...this.#limits, mediaTypes: [...this.#limits.mediaTypes] }; }
  async ready(): Promise<void> { await this.#root; }

  begin(input: ImageBeginUploadInput): Promise<ImageUploadState> {
    return this.#serialize(async () => {
      const parsed = imageBeginUploadInputSchema.parse(input);
      await this.#expire();
      const existing = this.#store.getImage(parsed.imageId);
      if (existing) {
        this.#owned(existing, parsed);
        if (existing.sha256 !== parsed.sha256 || existing.byteLength !== parsed.byteLength || existing.mediaType !== parsed.mediaType) {
          throw new RuntimeImageError("CONFLICT", "image ID was already reserved for different bytes");
        }
        if (!existing.committed && existing.receivedBytes === 0) {
          const file = await open(await this.#path(existing.imageId), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
          await file.close();
          await this.#syncDirectory();
        }
        return this.#state(existing);
      }
      await this.#reserve(parsed, null);
      return this.#state(this.#store.getImage(parsed.imageId)!);
    });
  }

  write(input: ImageWriteUploadInput): Promise<ImageUploadState> {
    return this.#serialize(async () => {
      const parsed = imageWriteUploadInputSchema.parse(input);
      const entry = this.#require(parsed);
      const bytes = decodeCanonicalBase64(parsed.dataBase64, IMAGE_MAX_CHUNK_BYTES);
      if (parsed.offset + bytes.length > entry.byteLength) throw new RuntimeImageError("CONFLICT", "image chunk exceeds declared length");
      const path = await this.#path(entry.imageId);
      const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        if (parsed.offset < entry.receivedBytes || entry.committed) {
          if (parsed.offset + bytes.length > entry.receivedBytes) throw new RuntimeImageError("CONFLICT", "image retry overlaps uncommitted bytes");
          const previous = Buffer.alloc(bytes.length);
          const read = await file.read(previous, 0, bytes.length, parsed.offset);
          if (read.bytesRead !== bytes.length || !previous.equals(bytes)) throw new RuntimeImageError("CONFLICT", "image retry differs from uploaded bytes");
          return this.#state(entry);
        }
        if (parsed.offset !== entry.receivedBytes) throw new RuntimeImageError("CONFLICT", "image chunks must append at the acknowledged offset");
        await file.truncate(entry.receivedBytes);
        let written = 0;
        while (written < bytes.length) {
          const result = await file.write(bytes, written, bytes.length - written, parsed.offset + written);
          if (result.bytesWritten === 0) throw new Error("image file write made no progress");
          written += result.bytesWritten;
        }
        await file.sync();
        const updated = { ...entry, receivedBytes: entry.receivedBytes + bytes.length, updatedAt: Date.now() };
        this.#store.putImage(updated);
        return this.#state(updated);
      } finally { await file.close(); }
    });
  }

  commit(input: ImageUploadIdInput): Promise<ImageDescriptor> {
    return this.#serialize(async () => {
      imageUploadIdInputSchema.parse(input);
      const entry = this.#require(input);
      if (entry.committed) return this.#descriptor(entry);
      if (entry.receivedBytes !== entry.byteLength) throw new RuntimeImageError("CONFLICT", "image upload is incomplete");
      const bytes = await this.#bytes(entry);
      if (digest(bytes) !== entry.sha256) throw new RuntimeImageError("CONFLICT", "image SHA-256 checksum does not match");
      if (identifyImage(bytes) !== entry.mediaType) throw new RuntimeImageError("CONFLICT", "image media type does not match its bytes");
      const committed = { ...entry, committed: true, updatedAt: Date.now() };
      this.#store.putImage(committed);
      return this.#descriptor(committed);
    });
  }

  abort(input: ImageUploadIdInput): Promise<{ imageId: string; aborted: boolean }> {
    return this.#serialize(async () => {
      imageUploadIdInputSchema.parse(input);
      const entry = this.#store.getImage(input.imageId);
      if (!entry) return { imageId: input.imageId, aborted: false };
      this.#owned(entry, input);
      if (entry.committed) throw new RuntimeImageError("CONFLICT", "committed images remain until session archive");
      await this.#remove(entry);
      return { imageId: input.imageId, aborted: true };
    });
  }

  read(input: ImageReadInput): Promise<ImageReadResult> {
    return this.#serialize(async () => {
      const parsed = imageReadInputSchema.parse(input);
      const entry = this.#require(parsed);
      if (!entry.committed) throw new RuntimeImageError("CONFLICT", "image is not committed");
      if (parsed.offset > entry.byteLength) throw new RuntimeImageError("CONFLICT", "image read offset exceeds image length");
      const bytes = await this.#bytes(entry);
      const end = Math.min(entry.byteLength, parsed.offset + parsed.length);
      return { image: this.#descriptor(entry), offset: parsed.offset, dataBase64: bytes.subarray(parsed.offset, end).toString("base64"), eof: end === entry.byteLength };
    });
  }

  getBytes(target: ImageTarget, image: ImageDescriptor): Promise<Buffer> {
    return this.#serialize(async () => {
      const entry = this.#require({ ...target, imageId: image.imageId });
      if (!entry.committed || JSON.stringify(this.#descriptor(entry)) !== JSON.stringify(imageDescriptorSchema.parse(image))) {
        throw new RuntimeImageError("FENCED", "command image descriptor differs from runtime-owned image");
      }
      return this.#bytes(entry);
    });
  }

  storeBase64(target: ImageTarget, dataBase64: string, mediaType: string): Promise<ImageDescriptor> {
    return this.#serialize(async () => {
      const bytes = decodeCanonicalBase64(dataBase64, IMAGE_MAX_BYTES);
      if (identifyImage(bytes) !== mediaType) throw new RuntimeImageError("CONFLICT", "native image media type does not match its bytes");
      return this.#storeBytes(target, bytes, null);
    });
  }

  snapshot(target: ImageTarget, sourceKey: string, path: string, session: RuntimeNodeSessionRecord, backend: RuntimeAgentBackend, localFilesystem: boolean): Promise<ImageDescriptor> {
    return this.#serialize(async () => {
      const existing = this.#store.listImages(target.sessionId).find((entry) => entry.sourceKey === sourceKey);
      if (existing?.committed) { this.#owned(existing, target); return this.#descriptor(existing); }
      if (!path || path.startsWith("//") || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
        throw new RuntimeImageError("FENCED", "image path must be a local workspace path");
      }
      if (!isAbsolute(path) && !session.cwd) throw new RuntimeImageError("FENCED", "relative image path requires a session workspace");
      const nativePath = isAbsolute(path) ? path : resolve(session.cwd!, path);
      const bytes = backend.readImageFile
        ? Buffer.from(await backend.readImageFile({ session, path: nativePath, maximumBytes: IMAGE_MAX_BYTES }))
        : localFilesystem
          ? await readConfinedImage(nativePath, [session.cwd, ...(this.#options.outputRoots ?? [])].filter((root): root is string => root !== null), IMAGE_MAX_BYTES, [await this.#root])
          : (() => { throw new RuntimeImageError("UNSUPPORTED", "custom image backend requires its own file reader"); })();
      if (bytes.length > IMAGE_MAX_BYTES) throw new RuntimeImageError("RESOURCE_EXHAUSTED", "image exceeds maximum byte length");
      if (existing) await this.#remove(existing);
      return this.#storeBytes(target, bytes, sourceKey);
    });
  }

  releaseSession(sessionId: SessionId): Promise<void> {
    return this.#serialize(async () => {
      const errors: unknown[] = [];
      for (const entry of this.#store.listImages(sessionId)) {
        try { await this.#remove(entry); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "session image cleanup failed");
    });
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    clearInterval(this.#expiryTimer);
    this.#closePromise = this.#close();
    return this.#closePromise;
  }
  async #close(): Promise<void> {
    await this.#lock.catch(() => undefined);
    const root = await this.#root;
    if (this.#ephemeral) await rm(root, { recursive: true, force: true });
  }

  async #initialize(directory: string | undefined): Promise<string> {
    const root = directory === undefined ? await mkdtemp(join(tmpdir(), "agent-multiplex-images-")) : resolve(directory);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new RuntimeImageError("FENCED", "image storage must be a private regular directory");
    await chmod(root, 0o700);
    const parent = await open(dirname(root), constants.O_RDONLY | constants.O_DIRECTORY);
    try { await parent.sync(); } finally { await parent.close(); }
    return realpath(root);
  }

  async #path(imageId: string): Promise<string> { return join(await this.#root, `${imageId}.blob`); }
  async #syncDirectory(): Promise<void> {
    const directory = await open(await this.#root, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new RuntimeImageError("FENCED", "runtime image store is closing"));
    const next = this.#lock.catch(() => undefined).then(operation);
    this.#lock = next;
    return next;
  }
  #owned(entry: RuntimeImageEntry, target: Pick<ImageTarget, "sessionId" | "bindingRevision">): void {
    if (entry.sessionId !== target.sessionId || entry.bindingRevision !== target.bindingRevision) throw new RuntimeImageError("FENCED", "image belongs to another session binding");
  }
  #require(input: Pick<ImageTarget, "sessionId" | "bindingRevision"> & { imageId: string }): RuntimeImageEntry {
    const entry = this.#store.getImage(input.imageId);
    if (!entry) throw new RuntimeImageError("NOT_FOUND", "image not found");
    this.#owned(entry, input);
    return entry;
  }
  #descriptor(entry: RuntimeImageEntry): ImageDescriptor {
    return imageDescriptorSchema.parse({ ...entry, runtimeNodeId: this.#runtimeNodeId });
  }
  #state(entry: RuntimeImageEntry): ImageUploadState {
    return { imageId: entry.imageId, byteLength: entry.byteLength, receivedBytes: entry.receivedBytes, committed: entry.committed ? this.#descriptor(entry) : null };
  }
  async #bytes(entry: RuntimeImageEntry): Promise<Buffer> {
    const file = await open(await this.#path(entry.imageId), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== entry.byteLength) throw new RuntimeImageError("CONFLICT", "image file length differs from durable record");
      const bytes = await file.readFile();
      if (digest(bytes) !== entry.sha256) throw new RuntimeImageError("CONFLICT", "image file checksum differs from durable record");
      return bytes;
    } finally { await file.close(); }
  }
  async #reserve(input: ImageBeginUploadInput, sourceKey: string | null): Promise<void> {
    const entries = this.#store.listImages();
    const total = entries.reduce((sum, entry) => sum + entry.byteLength, 0);
    const sessionTotal = entries.filter((entry) => entry.sessionId === input.sessionId).reduce((sum, entry) => sum + entry.byteLength, 0);
    if (total + input.byteLength > this.#limits.maximumRuntimeBytes || sessionTotal + input.byteLength > this.#limits.maximumSessionBytes) throw new RuntimeImageError("RESOURCE_EXHAUSTED", "image storage quota exceeded");
    // Journal the reservation before file creation. A crash can leave an empty
    // reservation, never unaccounted durable bytes.
    this.#store.putImage({ ...input, receivedBytes: 0, committed: false, sourceKey, updatedAt: Date.now() });
    const file = await open(await this.#path(input.imageId), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.close();
    await this.#syncDirectory();
  }
  async #storeBytes(target: ImageTarget, bytes: Buffer, sourceKey: string | null): Promise<ImageDescriptor> {
    const mediaType = identifyImage(bytes);
    const sha256 = digest(bytes);
    const existing = this.#store.listImages(target.sessionId).find((entry) => entry.committed && entry.sha256 === sha256 && entry.sourceKey === sourceKey);
    if (existing) return this.#descriptor(existing);
    const input = imageBeginUploadInputSchema.parse({ ...target, imageId: randomUUID(), sha256, byteLength: bytes.length, mediaType });
    await this.#expire();
    await this.#reserve(input, sourceKey);
    const file = await open(await this.#path(input.imageId), constants.O_WRONLY | constants.O_NOFOLLOW);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    const entry = { ...this.#store.getImage(input.imageId)!, receivedBytes: bytes.length, committed: true, updatedAt: Date.now() };
    this.#store.putImage(entry);
    return this.#descriptor(entry);
  }
  async #remove(entry: RuntimeImageEntry): Promise<void> {
    await rm(await this.#path(entry.imageId), { force: true });
    await this.#syncDirectory();
    this.#store.deleteImage(entry.imageId);
  }
  async #expire(): Promise<void> {
    const cutoff = Date.now() - (this.#options.unfinishedTtlMs ?? 86_400_000);
    for (const entry of this.#store.listImages()) if (!entry.committed && entry.updatedAt < cutoff) await this.#remove(entry);
  }
}

export function decodeCanonicalBase64(value: string, maximumBytes: number): Buffer {
  if (value.length > 4 * Math.ceil(maximumBytes / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new RuntimeImageError("CONFLICT", "image must use bounded canonical base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 1 || bytes.length > maximumBytes || bytes.toString("base64") !== value) throw new RuntimeImageError("CONFLICT", "image must use bounded canonical base64");
  return bytes;
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

export function identifyImage(bytes: Buffer): ImageDescriptor["mediaType"] {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (/^(?:\uFEFF)?\s*(?:<\?xml[^>]*\?>\s*)?<svg(?:\s|>)/i.test(bytes.subarray(0, 4096).toString("utf8"))) return "image/svg+xml";
  throw new RuntimeImageError("UNSUPPORTED", "unsupported image file format");
}

/** Check the opened inode, not just a pathname that can change before open. */
export async function readConfinedImage(path: string, roots: readonly string[], maximumBytes = IMAGE_MAX_BYTES, excludedRoots: readonly string[] = []): Promise<Buffer> {
  if (process.platform !== "linux") throw new RuntimeImageError("UNSUPPORTED", "confined image reads require Linux opened-file identity");
  if (!isAbsolute(path) || roots.length === 0) throw new RuntimeImageError("FENCED", "image path must be absolute and inside the session workspace");
  const canonicalRoots = await Promise.all(roots.map(async (root) => realpath(root)));
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const opened = await realpath(`/proc/self/fd/${file.fd}`);
    if (excludedRoots.some((root) => opened === root || opened.startsWith(`${root}${sep}`))) throw new RuntimeImageError("FENCED", "private runtime image storage is not a native output root");
    const inside = canonicalRoots.some((root) => {
      const suffix = relative(root, opened);
      return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
    });
    if (!inside) throw new RuntimeImageError("FENCED", "opened image file is outside configured roots");
    const before = await file.stat();
    if (!before.isFile()) throw new RuntimeImageError("FENCED", "image path must refer to a regular file");
    if (before.size < 1 || before.size > maximumBytes) throw new RuntimeImageError("RESOURCE_EXHAUSTED", "image file exceeds maximum byte length");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw new RuntimeImageError("CONFLICT", "image file changed while reading");
      offset += result.bytesRead;
    }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new RuntimeImageError("CONFLICT", "image file changed while reading");
    return bytes;
  } finally { await file.close(); }
}
