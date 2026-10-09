import { Worker } from "node:worker_threads";
import { jsonWireByteUpperBound } from "@arduano/agent-multiplex-protocol";
import { V7Error } from "./errors.js";
import { canonicalJson, requestHash } from "./store-payload.js";
import type { JsonValue, RequestReceipt, RequestState, SessionBinding, SessionMetadata, UpdateMetadataInput } from "./protocol.js";
export { canonicalJson, requestHash };
export const V7_STORE_MAX_PENDING_CALLS = 128;
export const V7_STORE_MAX_PENDING_BYTES = 8 * 1024 * 1024;

export interface V7StoreOptions { filename: string; role: "host" | "root"; instanceId: string; workerUrl?: URL }
export type MetadataPatch = Pick<UpdateMetadataInput, "title" | "pinned" | "metadata" | "remove" | "expectedMetadataRevision"> & { archived?: boolean };
interface WriterReply { id?: number; result?: unknown; error?: { code: string; message: string };
  ready?: boolean; bindings?: SessionBinding[]; registry?: SessionMetadata[] }

/** One writer thread owns SQLite. Lists/catalogs read the committed memory view.
 * No fsync, ACL operation or database lookup runs on the transport event loop. */
export class V7Store {
  public readonly role: "host" | "root";
  public readonly instanceId: string;
  readonly #worker: Worker;
  readonly #ready: Promise<void>;
  readonly #bindings = new Map<string, SessionBinding>();
  readonly #registry = new Map<string, SessionMetadata>();
  readonly #pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: unknown) => void }>();
  #serial = 0; #closed = false; #failure: V7Error | undefined; #closing: Promise<void> | undefined;
  #queuedCalls = 0; #queuedBytes = 0;
  public constructor(options: V7StoreOptions) {
    this.role = options.role; this.instanceId = options.instanceId;
    this.#worker = new Worker(options.workerUrl ?? new URL("./store-worker.js", import.meta.url), {
      workerData: { filename: options.filename, role: options.role, instanceId: options.instanceId },
      // --input-type applies to eval/stdin entrypoints, never a file worker.
      // Preserve production loaders/preloads and other inherited Node flags.
      execArgv: process.execArgv.filter((argument, index, arguments_) => !argument.startsWith("--input-type") && arguments_[index - 1] !== "--input-type"),
    });
    let readyResolve!: () => void, readyReject!: (error: unknown) => void;
    this.#ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    void this.#ready.catch(() => {});
    this.#worker.on("message", (reply: WriterReply) => {
      if (reply.ready) {
        if (reply.error) { this.#failure = new V7Error(reply.error.code, reply.error.message); readyReject(this.#failure); return; }
        for (const binding of reply.bindings ?? []) this.#bindings.set(binding.sessionId, binding);
        for (const metadata of reply.registry ?? []) this.#registry.set(metadata.sessionId, metadata);
        readyResolve(); return;
      }
      const pending = reply.id === undefined ? undefined : this.#pending.get(reply.id); if (!pending) return;
      this.#pending.delete(reply.id!);
      if (reply.error) pending.reject(new V7Error(reply.error.code, reply.error.message)); else pending.resolve(reply.result);
    });
    const failed = (error: unknown) => {
      this.#failure = new V7Error("WRITER_UNAVAILABLE", "V7 durable writer is unavailable", { cause: error });
      readyReject(this.#failure);
      for (const pending of this.#pending.values()) pending.reject(this.#failure); this.#pending.clear();
    };
    this.#worker.on("error", failed);
    this.#worker.on("exit", code => {
      if (!this.#closed) failed(new Error(`Writer exited (${code})`));
      else { for (const pending of this.#pending.values()) pending.reject(new V7Error("CLOSED", "V7 store is closed")); this.#pending.clear(); }
    });
  }
  public static async open(options: V7StoreOptions): Promise<V7Store> {
    const store = new V7Store(options);
    try { await store.ready(); return store; } catch (error) { await store.#worker.terminate(); throw error; }
  }
  public ready(): Promise<void> { return this.#ready; }
  public now(): string { return new Date().toISOString(); }
  private async call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.#closed || (this.#closing && method !== "close") || this.#failure) throw this.#failure ?? new V7Error("CLOSED", "V7 store is closed");
    // Reserve before cloning or awaiting initialization. A hung writer must not
    // turn transport requests into an unbounded memory queue. Close has its own
    // one control slot so a saturated writer can still be released.
    const bounded = method !== "close", bytes = bounded ? jsonWireByteUpperBound({ method, args }) : 0;
    if (bounded && (this.#queuedCalls >= V7_STORE_MAX_PENDING_CALLS || this.#queuedBytes + bytes > V7_STORE_MAX_PENDING_BYTES)) {
      throw new V7Error("STORE_BUSY", "Durable writer capacity is occupied; this request was not submitted");
    }
    if (bounded) { this.#queuedCalls += 1; this.#queuedBytes += bytes; }
    try {
      const ownedArgs = structuredClone(args);
      await this.#ready;
      if (this.#closed || (this.#closing && method !== "close") || this.#failure) throw this.#failure ?? new V7Error("CLOSED", "V7 store is closed");
      return await new Promise<T>((resolve, reject) => {
        const id = ++this.#serial;
        this.#pending.set(id, { resolve: value => resolve(value as T), reject });
        try { this.#worker.postMessage({ id, method, args: ownedArgs }); }
        catch (error) { this.#pending.delete(id); reject(error); }
      });
    } finally { if (bounded) { this.#queuedCalls -= 1; this.#queuedBytes -= bytes; } }
  }
  public admit(requestId: string, sessionId: string, operation: string, payload: unknown) {
    return this.call<{ receipt: RequestReceipt; fresh: boolean }>("admit", requestId, sessionId, operation, payload);
  }
  public transition(requestId: string, state: RequestState, outcome: { result?: JsonValue; error?: { code: string; message: string } } = {}) {
    return this.call<RequestReceipt>("transition", requestId, state, outcome);
  }
  public receipt(requestId: string) { return this.call<RequestReceipt | null>("receipt", requestId); }
  public receipts(sessionId?: string, operation?: string) { return this.call<RequestReceipt[]>("receipts", sessionId, operation); }
  public receiptEvents(requestId: string) { return this.call<Array<{ state: RequestState; at: string }>>("receiptEvents", requestId); }
  public requestPayload(requestId: string) { return this.call<JsonValue | null>("requestPayload", requestId); }
  public binding(sessionId: string): SessionBinding | null { return structuredClone(this.#bindings.get(sessionId) ?? null); }
  public bindings(): SessionBinding[] { return [...this.#bindings.values()].map(v => structuredClone(v)).sort((a, b) => a.sessionId.localeCompare(b.sessionId)); }
  public async putBinding(binding: SessionBinding): Promise<void> {
    const committed = structuredClone(binding);
    await this.call("putBinding", committed); this.#bindings.set(committed.sessionId, committed);
  }
  public metadata(sessionId: string): SessionMetadata | null { return structuredClone(this.#registry.get(sessionId) ?? null); }
  public registry(): SessionMetadata[] { return [...this.#registry.values()].map(v => structuredClone(v)).sort((a, b) => a.sessionId.localeCompare(b.sessionId)); }
  public async putMetadata(metadata: SessionMetadata): Promise<void> {
    const committed = structuredClone(metadata);
    await this.call("putMetadata", committed); this.#registry.set(committed.sessionId, committed);
  }
  public async reserveMetadata(metadata: SessionMetadata): Promise<SessionMetadata> {
    const result = await this.call<SessionMetadata>("reserveMetadata", metadata); this.#registry.set(result.sessionId, structuredClone(result)); return result;
  }
  public async patchMetadata(sessionId: string, patch: MetadataPatch): Promise<SessionMetadata> {
    const result = await this.call<SessionMetadata>("patchMetadata", sessionId, patch); this.#registry.set(result.sessionId, structuredClone(result)); return result;
  }
  /** Disposable qualification only; never selected by a normal service. */
  public delayWriterForTest(ms: number): Promise<void> { return this.call("delay", ms); }
  public close(): Promise<void> {
    if (this.#closing) return this.#closing;
    if (this.#closed) return Promise.resolve();
    this.#closing = (async () => {
      try { await this.call("close"); } finally { this.#closed = true; await this.#worker.terminate(); }
    })();
    return this.#closing;
  }
}
