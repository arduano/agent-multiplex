import { Worker } from "node:worker_threads";
import { CatalogError, type CatalogScope } from "../contracts/types.js";
import { copy } from "../contracts/validation.js";
export class CatalogJournal {
  readonly #worker: Worker; readonly #pending = new Map<number, { resolve(value: unknown): void; reject(e: unknown): void }>(); #serial = 0; #closed = false;
  private constructor(worker: Worker) {
    this.#worker = worker; worker.on("message", (r: { id: number; result?: unknown; error?: ConstructorParameters<typeof CatalogError>[0] }) => { const p = this.#pending.get(r.id); if (!p) return; this.#pending.delete(r.id); r.error ? p.reject(new CatalogError(r.error)) : p.resolve(copy(r.result)); });
    const fail = (): void => { this.#closed = true; for (const p of this.#pending.values()) p.reject(new CatalogError("CLOSED")); this.#pending.clear(); }; worker.on("error", fail); worker.on("exit", fail);
  }
  static async open(config: { directory: string; scope: CatalogScope; maxSessions: number; maxOperations: number }): Promise<CatalogJournal> { const j = new CatalogJournal(new Worker(new URL("./worker.js", import.meta.url), { workerData: config })); try { await j.call("open", {}); return j; } catch (e) { await j.terminate(); throw e; } }
  call<T>(method: string, input: unknown): Promise<T> { if (this.#closed) return Promise.reject(new CatalogError("CLOSED")); if (this.#pending.size >= 32) return Promise.reject(new CatalogError("BUSY")); const id = ++this.#serial; return new Promise<T>((resolve, reject) => { this.#pending.set(id, { resolve: value => resolve(value as T), reject }); this.#worker.postMessage({ id, method, input: copy(input) }); }); }
  async close(): Promise<void> { if (!this.#closed) { await this.call("close", {}); await this.terminate(); } }
  async terminate(): Promise<void> { this.#closed = true; for (const p of this.#pending.values()) p.reject(new CatalogError("CLOSED")); this.#pending.clear(); await this.#worker.terminate(); }
}
