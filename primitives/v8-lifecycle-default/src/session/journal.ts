import { Worker } from "node:worker_threads";
import { SessionError, type Receipt, type SessionScope, type SessionSnapshot } from "../../../v8-session/src/contracts/types.js";
import { copy } from "../../../v8-session/src/contracts/validation.js";

export type RecordIdentity = Readonly<{ lifecycle: { id: string; recordVersion: number }; harness: { id: string; recordVersion: number }; workspace: { id: string; recordVersion: number } }>;
export const defaultRecordIdentity = (kind: string): RecordIdentity => ({ lifecycle: { id: "multiplex.default-lifecycle", recordVersion: 1 }, harness: { id: `multiplex.${kind}`, recordVersion: 1 }, workspace: { id: "multiplex.existing-directory", recordVersion: 1 } });
export interface SessionLimits { maxOperations: number; maxMetadataBytes: number; maxJournalBytes: number; maxPending: number; maxListeners: number; maxEvents: number }
export const sessionLimits = (value: Partial<SessionLimits> = {}): SessionLimits => {
  const result = { maxOperations: 128, maxMetadataBytes: 4 * 1024 * 1024, maxJournalBytes: 64 * 1024 * 1024, maxPending: 32, maxListeners: 128, maxEvents: 128, ...value };
  for (const size of Object.values(result)) if (!Number.isSafeInteger(size) || size < 1) throw new SessionError("INVALID");
  if (result.maxOperations > 1024 || result.maxMetadataBytes > 16 * 1024 * 1024 || result.maxJournalBytes < 128 * 1024 || result.maxJournalBytes > 1024 * 1024 * 1024 || result.maxPending > 64 || result.maxListeners > 1024 || result.maxEvents > 512) throw new SessionError("INVALID");
  return result;
};
export class SessionJournal {
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  #capacity: (() => void) | undefined;
  #serial = 0; #closed = false;
  private constructor(worker: Worker) {
    this.#worker = worker;
    worker.on("message", (reply: { id: number; result?: unknown; error?: { code: ConstructorParameters<typeof SessionError>[0] } }) => {
      const pending = this.#pending.get(reply.id); if (!pending) return;
      this.#pending.delete(reply.id); this.#wake(); if (reply.error) pending.reject(new SessionError(reply.error.code)); else pending.resolve(copy(reply.result));
    });
    const fail = () => { this.#closed = true; for (const pending of this.#pending.values()) pending.reject(new SessionError("CLOSED")); this.#pending.clear(); this.#wake(); };
    worker.on("error", fail); worker.on("exit", fail);
  }
  static async open(directory: string, scope: SessionScope, limits: SessionLimits, initial: SessionSnapshot, identity: RecordIdentity = defaultRecordIdentity(initial.kind)): Promise<{ journal: SessionJournal; snapshot: SessionSnapshot }> {
    const journal = new SessionJournal(new Worker(new URL("./journal-worker.js", import.meta.url), { workerData: { directory, scope, limits, identity } }));
    try { const snapshot = await journal.call<SessionSnapshot>("open", { initial }); return { journal, snapshot }; }
    catch (error) { await journal.terminate(); throw error; }
  }
  call<T>(method: string, input: unknown): Promise<T> {
    if (this.#closed) return Promise.reject(new SessionError("CLOSED"));
    if (this.#pending.size >= 64) return Promise.reject(new SessionError("BUSY"));
    const id = ++this.#serial;
    return new Promise<T>((resolve, reject) => { this.#pending.set(id, { resolve: value => resolve(value as T), reject }); this.#worker.postMessage({ id, method, input: copy(input) }); });
  }
  #wake(): void { if (this.#closed || this.#pending.size < 64) { const wake = this.#capacity; this.#capacity = undefined; wake?.(); } }
  /** The one serialized trusted-result writer waits for competing bounded RPCs; it never retries a write. */
  async callWhenAvailable<T>(method: string, input: unknown): Promise<T> {
    const fixed = copy(input);
    while (!this.#closed && this.#pending.size >= 64) {
      if (this.#capacity) throw new SessionError("BUSY");
      await new Promise<void>(resolve => { this.#capacity = resolve; });
    }
    return this.call<T>(method, fixed);
  }
  get pending(): number { return this.#pending.size; }
  async close(): Promise<void> { if (!this.#closed) { await this.call("close", null); await this.terminate(); } }
  async terminate(): Promise<void> { this.#closed = true; this.#wake(); await this.#worker.terminate(); }
}
export type Admission = Readonly<{ fresh: boolean; receipt: Receipt }>;
