import { blake3 } from "@noble/hashes/blake3";
import type {
  FileDestination,
  FileManifest,
  FileSource,
  IncomingFileHandler,
} from "@arduano/p2prpc-core/files";
import { readBridgeDelegation } from "../../transport/delegation.js";
import type { AssetOptions, HostAssets } from "../node-contracts.js";
import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJson,
  scopeKey,
  type Json,
  type RunRef,
  type SessionScope,
} from "../../protocol/index.js";
import type { NativeInputPort } from "../../files/node-contracts.js";
import {
  mediaType,
  preview,
  type Preview,
  type FileLease,
  type StoredFile,
} from "../../files/index.js";
import {
  ASSET_CHUNK_BYTES,
  AssetError,
  assetTransferMetadataSchema,
  type AssetTransferMetadata,
  type NativeMediaInput,
  type UploadSpec,
  type UploadStatus,
} from "../contracts.js";
import {
  check,
  equal,
  identifier,
  run as validRun,
  scope as copyScope,
  spec as validSpec,
} from "../validation.js";
type Upload = {
  scope: SessionScope;
  spec: UploadSpec;
  token: string;
  data: Uint8Array;
  received: number;
  expiresAt: number;
  publishing?: Promise<StoredFile>;
  transfer?: { manifest: FileManifest<AssetTransferMetadata>; chunks: Set<number> };
};
type ReadLease = {
  scope: SessionScope;
  lease: FileLease;
  expiresAt: number;
  reads: Set<Promise<unknown>>;
  closing?: Promise<void>;
};
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const key = (scope: SessionScope, id: string) => JSON.stringify([scopeKey(scope), identifier(id)]);
function decode(value: string, max: number): Uint8Array {
  check(
    typeof value === "string" &&
      value.length <= Math.ceil(max / 3) * 4 &&
      value.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(value),
  );
  const bytes = Buffer.from(value, "base64");
  check(bytes.length <= max && bytes.toString("base64") === value);
  return bytes;
}
/** Owns only resource transfers/leases. Durable immutable manifests remain in
 * FileStore; session effects and native lifetimes remain with the lifecycle. */
export class HostAssetOwner implements HostAssets {
  get resourceIdentity(): object {
    return this.options.store.resourceIdentity;
  }
  readonly #uploads = new Map<string, Upload>();
  readonly #leases = new Map<string, ReadLease>();
  readonly #actual = new Set<Promise<unknown>>();
  readonly #inputs = new Set<() => Promise<void>>();
  readonly #media = new Map<
    string,
    {
      fingerprint: string;
      promise: Promise<StoredFile>;
    }
  >();
  readonly #now: () => number;
  readonly #uploadTtl: number;
  readonly #leaseTtl: number;
  readonly #maxUploadBytes: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  #failed = false;
  #disposed = false;
  #openingLeases = 0;
  #inputSlots = 0;
  #readCount = 0;
  #sweeping: Promise<void> | undefined;
  constructor(private readonly options: AssetOptions) {
    this.#now = options.now ?? Date.now;
    this.#uploadTtl = options.uploadTtlMs ?? 600000;
    this.#leaseTtl = options.leaseTtlMs ?? 60000;
    this.#maxUploadBytes = options.maxUploadBytes ?? 64 * 1024 * 1024;
    for (const value of [this.#uploadTtl, this.#leaseTtl, this.#maxUploadBytes])
      check(Number.isSafeInteger(value) && value > 0);
    check(
      this.#uploadTtl <= 3600000 &&
        this.#leaseTtl <= 3600000 &&
        this.#maxUploadBytes <= 128 * 1024 * 1024,
    );
  }
  #check() {
    check(!this.#closed, "CLOSED");
    check(!this.#failed, "BUSY");
  }
  #track<T>(work: Promise<T>): Promise<T> {
    this.#actual.add(work);
    void work.finally(() => this.#actual.delete(work)).catch(() => {});
    return work;
  }
  #time(): number {
    const value = this.#now();
    check(Number.isSafeInteger(value) && value >= 0);
    return value;
  }
  #schedule(): void {
    if (this.#closed || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.collect().catch(() => {
        this.#failed = true;
      });
    }, 30000);
    this.#timer.unref();
  }
  #status(upload: Upload): UploadStatus {
    return upload.publishing
      ? { state: "publishing", id: upload.spec.id }
      : {
          state: "receiving",
          id: upload.spec.id,
          token: upload.token,
          received: upload.received,
          bytes: upload.spec.bytes,
          expiresAt: upload.expiresAt,
        };
  }
  #upload(scope: SessionScope, id: string, token: string): Upload {
    this.#check();
    const upload = this.#uploads.get(key(scope, id));
    check(upload && upload.token === token, "FENCED");
    check(upload.publishing || upload.expiresAt > this.#time(), "EXPIRED");
    return upload;
  }
  #matching(file: StoredFile, spec: UploadSpec): void {
    check(
      file.id === spec.id &&
        file.name === spec.name &&
        file.bytes === spec.bytes &&
        file.sha256 === spec.sha256 &&
        file.mediaType === spec.mediaType &&
        file.retention === spec.retention &&
        file.origin === "upload",
      "CONFLICT",
    );
  }
  begin(scope: SessionScope, input: UploadSpec): UploadStatus {
    this.#check();
    check(!this.options.store.isRetired(scope), "FENCED");
    const file = validSpec(input),
      owner = copyScope(scope);
    const complete = this.options.store.file(owner, file.id);
    if (complete) {
      this.#matching(complete, file);
      return { state: "complete", file: complete };
    }
    const id = key(owner, file.id),
      prior = this.#uploads.get(id);
    if (prior && prior.expiresAt <= this.#time() && !prior.publishing) this.#uploads.delete(id);
    else if (prior) {
      check(equal(prior.spec, file), "CONFLICT");
      return this.#status(prior);
    }
    check(
      this.#uploads.size < 4 &&
        [...this.#uploads.values()].reduce((bytes, upload) => bytes + upload.spec.bytes, 0) +
          file.bytes <=
          this.#maxUploadBytes,
      "CAPACITY",
    );
    const upload: Upload = {
      scope: owner,
      spec: file,
      token: randomUUID(),
      data: new Uint8Array(file.bytes),
      received: 0,
      expiresAt: this.#time() + this.#uploadTtl,
    };
    this.#uploads.set(id, upload);
    this.#schedule();
    return this.#status(upload);
  }
  status(scope: SessionScope, id: string): UploadStatus {
    this.#check();
    const file = this.options.store.file(scope, id);
    if (file) return { state: "complete", file };
    const upload = this.#uploads.get(key(scope, id));
    if (upload && !upload.publishing && upload.expiresAt <= this.#time())
      this.#uploads.delete(key(scope, id));
    return upload && (upload.publishing || upload.expiresAt > this.#time())
      ? this.#status(upload)
      : { state: "unknown", id };
  }
  /** The transfer engine owns chunk validation/retry/resume. This destination
   * owns its bounded business reservation and immutable-store publication. */
  readonly incoming: IncomingFileHandler<AssetTransferMetadata> = (offer) => {
    offer.signal.throwIfAborted();
    this.#check();
    const { viewer, target } = readBridgeDelegation(offer.principal);
    check(viewer.actions.includes("control"), "FENCED");
    const metadata = assetTransferMetadataSchema.parse(offer.manifest.metadata);
    check(metadata, "INVALID");
    check(!target.session || target.session.id === metadata.session, "FENCED");
    const scope: SessionScope = {
      connection: viewer.connection,
      principal: viewer.principal,
      host: target.route.host,
      session: metadata.session,
    };
    const upload = this.#upload(scope, metadata.file.id, metadata.token);
    check(equal(upload.spec, validSpec(metadata.file)), "CONFLICT");
    check(!this.options.store.isRetired(scope), "FENCED");
    // The SDK exposes metadata through an accessor returning immutable views.
    // Materialize that public value at this module boundary before retaining it
    // as our JSON comparison data; the protocol's accessor refusal stays strict.
    const manifest = { ...offer.manifest };
    check(manifest.size === upload.spec.bytes && manifest.name === upload.spec.name, "CONFLICT");
    check(!upload.publishing, "BUSY");
    if (upload.transfer) check(equal(upload.transfer.manifest, manifest), "CONFLICT");
    else upload.transfer = { manifest, chunks: new Set() };
    const state = upload.transfer;
    const current = (candidate: FileManifest<AssetTransferMetadata>, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      check(
        this.#uploads.get(key(scope, upload.spec.id)) === upload && upload.transfer === state,
        "FENCED",
      );
      check(equal({ ...candidate }, manifest), "CONFLICT");
      check(!this.options.store.isRetired(scope), "FENCED");
      check(upload.expiresAt > this.#time(), "EXPIRED");
    };
    const destination: FileDestination<AssetTransferMetadata> = {
      prepare: async (candidate, signal) => {
        current(candidate, signal);
        return new Set(state.chunks);
      },
      writeChunk: async (candidate, index, bytes, signal) => {
        current(candidate, signal);
        check(Number.isSafeInteger(index) && index >= 0 && index < manifest.chunkCount);
        const offset = index * manifest.chunkSize;
        check(bytes.length === Math.min(manifest.chunkSize, manifest.size - offset));
        if (state.chunks.has(index))
          check(
            Buffer.compare(upload.data.subarray(offset, offset + bytes.length), bytes) === 0,
            "CONFLICT",
          );
        else {
          upload.data.set(bytes, offset);
          state.chunks.add(index);
          upload.received += bytes.length;
        }
        upload.expiresAt = this.#time() + this.#uploadTtl;
      },
      finalize: async (candidate, context) => {
        current(candidate, context.signal);
        check(!upload.publishing, "BUSY");
        check(state.chunks.size === manifest.chunkCount && upload.received === manifest.size);
        check(Buffer.from(blake3(upload.data)).toString("hex") === manifest.digest, "CONFLICT");
        check(hash(upload.data) === upload.spec.sha256, "CONFLICT");
        check(
          mediaType(upload.data, upload.spec.mediaType) === upload.spec.mediaType,
          "UNSUPPORTED",
        );
        const request = this.options.store.put(
          scope,
          {
            id: upload.spec.id,
            name: upload.spec.name,
            mediaType: upload.spec.mediaType,
            retention: upload.spec.retention ?? "session",
          },
          upload.data,
          "upload",
          {
            ...(context.signal ? { signal: context.signal } : {}),
            onCommitted: () => context.markCommitted(),
          },
        );
        upload.publishing = this.#track(request);
        try {
          await request;
        } finally {
          this.#uploads.delete(key(scope, upload.spec.id));
          upload.data = new Uint8Array();
          this.#schedule();
        }
      },
      abort: async (_candidate, options) => {
        if (options.discard && !upload.publishing) {
          this.#uploads.delete(key(scope, upload.spec.id));
          upload.data = new Uint8Array();
        }
      },
    };
    return { accept: destination };
  };
  source(scope: SessionScope, file: StoredFile): FileSource<AssetTransferMetadata> {
    this.#check();
    const owner = copyScope(scope);
    check(scopeKey(owner) === scopeKey(file.scope), "FENCED");
    const current = this.options.store.file(owner, file.id);
    check(current && equal(current, file), "FENCED");
    return {
      name: file.name,
      size: file.bytes,
      readChunk: async () => {
        throw new AssetError("BUSY");
      },
      prepare: async (signal) => {
        signal?.throwIfAborted();
        const lease = await this.#acquire(owner, file);
        let closed = false;
        return {
          name: file.name,
          size: file.bytes,
          readChunk: async (index, chunkSize, readSignal) => {
            readSignal?.throwIfAborted();
            check(!closed, "CLOSED");
            check(
              Number.isSafeInteger(index) &&
                index >= 0 &&
                Number.isSafeInteger(chunkSize) &&
                chunkSize > 0 &&
                chunkSize <= 4 * 1024 * 1024,
            );
            const offset = index * chunkSize,
              length = Math.min(chunkSize, file.bytes - offset);
            check(length >= 0);
            const bytes = new Uint8Array(length);
            for (let at = 0; at < length; at += ASSET_CHUNK_BYTES) {
              readSignal?.throwIfAborted();
              bytes.set(
                await this.#read(
                  owner,
                  lease.id,
                  offset + at,
                  Math.min(ASSET_CHUNK_BYTES, length - at),
                ),
                at,
              );
            }
            return bytes;
          },
          close: async () => {
            if (closed) return;
            await this.#releaseLease(owner, lease.id);
            closed = true;
          },
        };
      },
    };
  }
  abort(scope: SessionScope, id: string, token: string): void {
    const upload = this.#uploads.get(key(scope, id));
    if (!upload) return;
    this.#upload(scope, id, token);
    check(!upload.publishing, "BUSY");
    this.#uploads.delete(key(scope, id));
    upload.data = new Uint8Array();
  }
  async #acquire(
    scope: SessionScope,
    file: StoredFile,
  ): Promise<{ id: string; file: StoredFile; expiresAt: number }> {
    this.#check();
    check(this.#leases.size + this.#openingLeases + this.#inputSlots < 32, "CAPACITY");
    const owner = copyScope(scope);
    this.#openingLeases++;
    let lease: FileLease;
    try {
      lease = await this.#track(this.options.store.acquire(owner, file));
    } finally {
      this.#openingLeases--;
    }
    if (this.#closed) {
      await lease.release();
      throw new AssetError("CLOSED");
    }
    const id = randomUUID(),
      expiresAt = this.#time() + this.#leaseTtl;
    this.#leases.set(id, { scope: owner, lease, expiresAt, reads: new Set() });
    this.#schedule();
    return { id, file: lease.file, expiresAt };
  }
  #lease(scope: SessionScope, id: string): ReadLease {
    this.#check();
    const value = this.#leases.get(identifier(id));
    check(value && scopeKey(value.scope) === scopeKey(scope) && !value.closing, "FENCED");
    check(value.expiresAt > this.#time(), "EXPIRED");
    return value;
  }
  async #read(
    scope: SessionScope,
    id: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    const lease = this.#lease(scope, id);
    check(
      Number.isSafeInteger(offset) &&
        offset >= 0 &&
        Number.isSafeInteger(length) &&
        length >= 0 &&
        length <= ASSET_CHUNK_BYTES,
    );
    check(this.#readCount < 16 && lease.reads.size < 4, "CAPACITY");
    this.#readCount++;
    const work = this.#track(lease.lease.read(offset, length));
    lease.reads.add(work);
    try {
      const bytes = await work;
      this.#lease(scope, id);
      lease.expiresAt = this.#time() + this.#leaseTtl;
      return bytes;
    } finally {
      lease.reads.delete(work);
      this.#readCount--;
    }
  }
  #release(id: string, lease: ReadLease): Promise<void> {
    if (lease.closing) return lease.closing;
    lease.closing = this.#track(
      (async () => {
        await Promise.allSettled([...lease.reads]);
        try {
          await lease.lease.release();
          this.#leases.delete(id);
        } catch (error) {
          this.#failed = true;
          throw error;
        }
      })(),
    );
    return lease.closing;
  }
  #releaseLease(scope: SessionScope, id: string): Promise<void> {
    const lease = this.#leases.get(identifier(id));
    if (!lease) return Promise.resolve();
    check(scopeKey(lease.scope) === scopeKey(scope), "FENCED");
    return this.#release(id, lease);
  }
  /** Borrowed occurrence capture and preview share this owner's exact store and leases. */
  capturePreview(
    input: Readonly<{ scope: SessionScope; sourceKey: string; id: string }>,
    assertCurrent: () => void,
  ): Promise<Preview> {
    this.#check();
    input = {
      scope: copyScope(input.scope),
      sourceKey: identifier(input.sourceKey),
      id: identifier(input.id),
    };
    assertCurrent();
    return this.#track(
      (async () => {
        const reference = await this.options.store.reference(input.scope, input.sourceKey);
        this.#check();
        assertCurrent();
        const file =
          this.options.store.file(input.scope, input.id) ??
          (await this.options.store.capture(input.scope, reference, {
            id: input.id,
            retention: "cache",
          }));
        this.#check();
        assertCurrent();
        if (file.mediaType === "application/pdf") return { kind: "pdf", file };
        if (file.mediaType.startsWith("image/") && file.mediaType !== "image/svg+xml")
          return { kind: "image", file };
        if (file.bytes > 1024 * 1024) return { kind: "download", file, reason: "too-large" };
        const lease = await this.#acquire(input.scope, file);
        try {
          assertCurrent();
          const bytes = new Uint8Array(file.bytes);
          for (let offset = 0; offset < bytes.length; offset += ASSET_CHUNK_BYTES) {
            const data = await this.#read(
              input.scope,
              lease.id,
              offset,
              Math.min(ASSET_CHUNK_BYTES, bytes.length - offset),
            );
            assertCurrent();
            bytes.set(data, offset);
          }
          return preview(file, bytes);
        } finally {
          await this.#releaseLease(input.scope, lease.id);
        }
      })(),
    );
  }
  collect(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#sweeping) return this.#sweeping;
    this.#sweeping = this.#track(this.#collect());
    void this.#sweeping
      .finally(() => {
        this.#sweeping = undefined;
      })
      .catch(() => {});
    return this.#sweeping;
  }
  async #collect(): Promise<void> {
    if (this.#closed) return;
    const now = this.#time();
    for (const [id, upload] of this.#uploads)
      if (!upload.publishing && upload.expiresAt <= now) {
        this.#uploads.delete(id);
        upload.data = new Uint8Array();
      }
    await Promise.all(
      [...this.#leases]
        .filter(([, lease]) => lease.expiresAt <= now)
        .map(([id, lease]) => this.#release(id, lease)),
    );
    await this.#track(this.options.store.collect());
    if (this.#uploads.size || this.#leases.size || this.options.store.usage().entries)
      this.#schedule();
  }
  capture(input: NativeMediaInput): Promise<StoredFile> {
    this.#check();
    const run = validRun(input.run);
    check(!this.options.store.isRetired(run.scope), "FENCED");
    this.options.assertCurrent?.(run);
    identifier(input.attachment);
    identifier(input.stream);
    check(
      typeof input.eventId === "string" &&
        input.eventId.length > 0 &&
        input.eventId.length <= 1024 &&
        typeof input.assetId === "string" &&
        input.assetId.length > 0 &&
        input.assetId.length <= 1024,
    );
    const occurrence = {
      run,
      attachment: input.attachment,
      stream: input.stream,
      eventId: input.eventId,
      rowId: input.rowId ?? input.eventId,
      assetId: input.assetId,
    };
    const id = `media-${hash(canonicalJson(occurrence as unknown as Json, 16384).json)}`;
    const fingerprint = hash(
      canonicalJson(
        { name: input.name, mediaType: input.mediaType, source: input.source } as Json,
        48 * 1024 * 1024,
      ).json,
    );
    const pending = this.#media.get(id);
    if (pending) {
      check(pending.fingerprint === fingerprint, "CONFLICT");
      return pending.promise;
    }
    check(this.#media.size < 4, "CAPACITY");
    const promise = this.#track(this.#capture(input, run, id));
    this.#media.set(id, { fingerprint, promise });
    void promise
      .finally(() => {
        this.#media.delete(id);
        this.#schedule();
      })
      .catch(() => {});
    return promise;
  }
  async #capture(input: NativeMediaInput, run: RunRef, id: string): Promise<StoredFile> {
    check(
      input.source && typeof input.source === "object" && !Array.isArray(input.source),
      "UNSUPPORTED",
    );
    const source = input.source as Record<string, Json>;
    const resource =
      source.resource && typeof source.resource === "object" && !Array.isArray(source.resource)
        ? (source.resource as Record<string, Json>)
        : undefined;
    let encoded: unknown = source.data ?? source.blob ?? resource?.blob;
    let type =
      typeof source.mimeType === "string"
        ? source.mimeType
        : typeof resource?.mimeType === "string"
          ? resource.mimeType
          : input.mediaType;
    const rawUrl = source.url ?? source.imageUrl ?? source.image_url;
    const url =
      typeof rawUrl === "string"
        ? rawUrl
        : rawUrl && typeof rawUrl === "object" && !Array.isArray(rawUrl)
          ? (rawUrl as Record<string, Json>).url
          : undefined;
    if (typeof url === "string") {
      const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]*)$/.exec(url);
      check(match, "UNSUPPORTED");
      type = match[1]!;
      encoded = match[2]!;
    }
    if (typeof encoded === "string") {
      const bytes = decode(encoded, 32 * 1024 * 1024);
      const name = input.name.split(/[/\\]/).at(-1) || "Attachment";
      const file = await this.options.store.put(
        run.scope,
        { id, name, mediaType: type, retention: "cache" },
        bytes,
        "capture",
      );
      this.options.assertCurrent?.(run);
      return file;
    }
    check(this.options.trustedSourceKey, "UNSUPPORTED");
    const sourceKey = identifier(await this.options.trustedSourceKey(input));
    this.options.assertCurrent?.(run);
    const reference = await this.options.store.reference(run.scope, sourceKey);
    const file = await this.options.store.capture(run.scope, reference, { id, retention: "cache" });
    this.options.assertCurrent?.(run);
    return file;
  }
  async prepare<T>(
    run: RunRef,
    ids: readonly string[],
    port: NativeInputPort<T>,
  ): Promise<{
    inputs: readonly T[];
    release(): Promise<void>;
  }> {
    this.#check();
    run = validRun(run);
    check(!this.options.store.isRetired(run.scope), "FENCED");
    this.options.assertCurrent?.(run);
    check(ids.length <= 32 && new Set(ids).size === ids.length);
    check(
      this.#inputSlots + this.#leases.size + this.#openingLeases + ids.length <= 32,
      "CAPACITY",
    );
    this.#inputSlots += ids.length;
    const holds: {
      input: T;
      release(): Promise<void>;
    }[] = [];
    try {
      for (const id of ids) {
        const file = this.options.store.file(run.scope, identifier(id));
        check(file, "NOT_FOUND");
        holds.push(await this.#track(this.options.store.prepareInput(run.scope, file, port)));
        this.#check();
        this.options.assertCurrent?.(run);
      }
      let releasing: Promise<void> | undefined;
      const release = () => {
        if (releasing) return releasing;
        releasing = this.#track(
          (async () => {
            const results = await Promise.allSettled(holds.map((held) => held.release()));
            if (results.some((result) => result.status === "rejected"))
              throw new AssetError("BUSY");
            this.#inputs.delete(release);
            this.#inputSlots -= ids.length;
          })(),
        );
        return releasing;
      };
      this.#inputs.add(release);
      return { inputs: holds.map((held) => held.input), release };
    } catch (error) {
      const results = await Promise.allSettled(holds.map((held) => held.release()));
      if (results.some((result) => result.status === "rejected")) {
        this.#failed = true;
        throw new AggregateError(
          [
            error,
            ...results
              .filter((r): r is PromiseRejectedResult => r.status === "rejected")
              .map((r) => r.reason),
          ],
          "Native asset cleanup unproved",
          { cause: error },
        );
      }
      this.#inputSlots -= ids.length;
      throw error;
    }
  }
  async retireSession(scope: SessionScope): Promise<void> {
    this.#check();
    scope = copyScope(scope);
    for (const [id, upload] of this.#uploads)
      if (scopeKey(upload.scope) === scopeKey(scope) && !upload.publishing) {
        this.#uploads.delete(id);
        upload.data = new Uint8Array();
      }
    await this.#track(this.options.store.retireSession(scope));
    await this.collect();
  }
  prepareCodexInputs(input: {
    run: RunRef;
    originalId: string;
    attachments: readonly {
      id: string;
    }[];
  }): Promise<{
    inputs: readonly (
      | {
          type: "localImage";
          path: string;
        }
      | {
          type: "mention";
          name: string;
          path: string;
        }
    )[];
    release(): Promise<void>;
  }> {
    identifier(input.originalId);
    return this.prepare(
      input.run,
      input.attachments.map((file) => file.id),
      {
        accepts: () => true,
        async prepare({ file, path }) {
          return file.mediaType.startsWith("image/") && file.mediaType !== "image/svg+xml"
            ? { type: "localImage" as const, path }
            : { type: "mention" as const, name: file.name, path };
        },
      },
    );
  }
  async prepareCopilotInputs(
    run: RunRef,
    ids: readonly string[],
  ): Promise<{
    attachments: readonly Json[];
    release(): Promise<void>;
  }> {
    const prepared = await this.prepare(run, ids, {
      accepts: () => true,
      async prepare({ file, path }) {
        return { type: "file", path, displayName: file.name };
      },
    });
    return { attachments: prepared.inputs, release: prepared.release };
  }
  readiness() {
    if (this.#disposed) return { ready: true as const };
    let accounted = false;
    try {
      accounted = this.options.store.usage().leases <= this.#leases.size + this.#inputSlots;
    } catch {}
    return accounted &&
      !this.#failed &&
      !this.#actual.size &&
      !this.#inputs.size &&
      !this.#openingLeases &&
      !this.#inputSlots &&
      ![...this.#uploads.values()].some((upload) => upload.transfer)
      ? { ready: true as const }
      : {
          ready: false as const,
          reasons: ["Asset transfer, native input or cleanup remains owned"],
        };
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    check(this.readiness().ready, "BUSY");
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#closing = (async () => {
      for (const upload of this.#uploads.values()) upload.data = new Uint8Array();
      this.#uploads.clear();
      const results = await Promise.allSettled(
        [...this.#leases].map(([id, lease]) => this.#release(id, lease)),
      );
      if (results.some((result) => result.status === "rejected")) {
        this.#failed = true;
        throw new AssetError("BUSY");
      }
      this.options.store.close();
      this.#disposed = true;
    })().catch((error) => {
      this.#failed = true;
      throw error;
    });
    return this.#closing;
  }
}
