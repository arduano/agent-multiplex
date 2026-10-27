import { Worker } from "node:worker_threads";
import { FileError, type DiskRef, type FileErrorCode, type FileInputs, type FileMethod, type FileOutputs, type FilePort, type FileScope } from "../contracts/types.js";
import { fileLimits, type FileLimits } from "../contracts/limits.js";
import type { NativeOccurrence } from "../native/capture.js";

export interface FileHostOptions {
  directory: string;
  bindings: readonly Readonly<{ scope: FileScope; cwd: string; dialect: "posix" | "win32" }>[];
  allowedRoots?: readonly string[];
  privateRoots?: readonly string[];
  broadPaths?: boolean;
  limits?: Partial<FileLimits>;
  now?: () => number;
  /** Disposable qualification only: kill the owned worker at an exact durable boundary. */
  qualification?: Readonly<{ crashAt?: "reserved" | "flushed" | "acknowledged" | "publishing" | "renamed" | "published" | "expired"; failUnlink?: boolean; failCheckpoint?: boolean; failCheckpointOnceAtThreshold?: boolean; failPublishOnce?: boolean }>;
}
type Reply = { id: number; value?: unknown; error?: { code: FileErrorCode; message: string } };
export type ProtectedOperation = Readonly<{ id: string; settled: boolean; consumers: readonly Readonly<{ id: string; released: boolean }>[] }>;
export type ProtectedOperationsPage = Readonly<{ operations: readonly ProtectedOperation[]; next: string | null }>;

/** Owns one worker, one SQLite writer and only the supplied private directory. */
export class FileHost implements FilePort {
  readonly #worker: Worker;
  readonly #now: () => number;
  readonly #maximum: number;
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  #serial = 0;
  #closed = false;
  #closing = false;
  private constructor(worker: Worker, options: FileHostOptions) {
    this.#worker = worker;
    this.#now = options.now ?? Date.now;
    this.#maximum = fileLimits(options.limits).maxQueued;
    worker.on("message", (reply: Reply) => {
      const pending = this.#pending.get(reply.id);
      if (!pending) return;
      this.#pending.delete(reply.id);
      if (reply.error) pending.reject(new FileError(reply.error.code, reply.error.message));
      else pending.resolve(reply.value);
    });
    const fail = (): void => {
      this.#closed = true;
      for (const pending of this.#pending.values()) pending.reject(new FileError("CLOSED", "File owner stopped; reconcile original identities after reopening"));
      this.#pending.clear();
    };
    worker.on("error", fail);
    worker.on("exit", fail);
  }
  static async open(options: FileHostOptions): Promise<FileHost> {
    const { now: _clock, ...serializable } = options;
    const worker = new Worker(new URL("./worker.js", import.meta.url), { workerData: serializable });
    const owner = new FileHost(worker, options);
    try { await owner.#request("$open", undefined); return owner; }
    catch (error) { await worker.terminate(); throw error; }
  }
  async #request(method: string, input: unknown): Promise<unknown> {
    if (this.#closed || this.#closing && method !== "$close") throw new FileError("CLOSED");
    if (this.#pending.size >= this.#maximum) throw new FileError("BUSY", "File owner request queue is full");
    const id = ++this.#serial;
    const at = this.#now();
    if (!Number.isSafeInteger(at) || at < 0) throw new FileError("INVALID", "Invalid file clock");
    return await new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try { this.#worker.postMessage({ id, method, input, at }); }
      catch (error) { this.#pending.delete(id); reject(error); }
    });
  }
  call<M extends FileMethod>(method: M, input: FileInputs[M]): Promise<FileOutputs[M]> {
    return this.#request(method, input) as Promise<FileOutputs[M]>;
  }
  /** Private native-output identity registration in the same worker/ledger.
   * Ordinary FilePort/HTTP callers cannot claim this namespace. */
  native<M extends "begin" | "capture">(method: M, input: FileInputs[M], occurrence: NativeOccurrence): Promise<FileOutputs[M]> {
    return this.#request(method === "begin" ? "$nativeBegin" : "$nativeCapture", { ...input, occurrence }) as Promise<FileOutputs[M]>;
  }
  /** Private keyset inspection of existing holds; never exposed by FilePort or HTTP. */
  protectedOperations(scope: FileScope, options: Readonly<{ after?: string; limit?: number }> = {}): Promise<ProtectedOperationsPage> {
    return this.#request("$protectedOperations", { scope, ...options }) as Promise<ProtectedOperationsPage>;
  }
  /** Private worker barrier; counts actual descriptors without closing them. */
  archiveStatus(scope: FileScope): Promise<Readonly<{ activeReads: number }>> { return this.#request("$archiveStatus", { scope }) as Promise<Readonly<{ activeReads: number }>>; }
  /** Caller already owns the durable session seal. Preserves bytes/audit rows. */
  async seal(scope: FileScope): Promise<void> { await this.#request("$seal", { scope }); }
  /** Same existing Host path policy plus explicit native-visible roots. This
   * returns a reference, never captures/spools a second file or grants custody. */
  resolveNativePath(scope: FileScope, file: DiskRef, roots: readonly string[]): Promise<string> {
    return this.#request("$nativePath", { scope, file, roots }) as Promise<string>;
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    try { await this.#request("$close", undefined); }
    finally { this.#closed = true; await this.#worker.terminate(); }
  }
  /** Abrupt owned-worker termination; never reports pending work as successful. */
  async terminate(): Promise<void> { this.#closed = true; await this.#worker.terminate(); }
}
