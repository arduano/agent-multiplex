import { Worker } from "node:worker_threads";
import type { PluginIdentity } from "../../v8-plugins/src/contracts.js";
import { SessionError, type Receipt, type Selection, type SessionScope } from "../../v8-session/src/contracts/types.js";
import { copy } from "../../v8-session/src/contracts/validation.js";
import type { WorkspaceAllocation } from "./workspace.js";

export interface CreationRecord {
  scope: SessionScope; id: string; input: unknown; selection?: Selection;
  workspace: "unallocated" | "pending" | "unknown" | "available" | "released";
  allocation?: WorkspaceAllocation<unknown>; nativeAttempted: boolean;
  stopped: boolean; retired: boolean; stop?: Receipt;
  workspaceRefused?: true;
  archive?: Receipt;
}
/** Host-level creation reservation and pre-native resource custody. Native
 * command originals stay in each SessionHost's journal; this is not an outbox. */
export class CreationRegistry {
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  #serial = 0; #closed = false;
  private constructor(worker: Worker) {
    this.#worker = worker;
    worker.on("message", (reply: { id: number; result?: unknown; error?: string }) => {
      const entry = this.#pending.get(reply.id); if (!entry) return; this.#pending.delete(reply.id);
      if (reply.error) entry.reject(new SessionError(reply.error as ConstructorParameters<typeof SessionError>[0])); else entry.resolve(reply.result);
    });
    const failed = () => { this.#closed = true; for (const entry of this.#pending.values()) entry.reject(new SessionError("CLOSED")); this.#pending.clear(); };
    worker.on("exit", failed); worker.on("error", failed);
  }
  static async open(directory: string, identity: { lifecycle: PluginIdentity; harness: PluginIdentity; workspace: PluginIdentity }, maxSessions: number, custody: { host: string; owner: string }): Promise<CreationRegistry> {
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 1024) throw new SessionError("INVALID");
    const registry = new CreationRegistry(new Worker(new URL("./registry-worker.js", import.meta.url), { workerData: { directory, identity, maxSessions, custody } }));
    try { await registry.call("open", {}); return registry; } catch (error) { await registry.terminate(); throw error; }
  }
  call<T>(method: string, input: unknown): Promise<T> {
    if (this.#closed) return Promise.reject(new SessionError("CLOSED"));
    if (this.#pending.size >= 32) return Promise.reject(new SessionError("BUSY"));
    const id = ++this.#serial;
    return new Promise<T>((resolve, reject) => { this.#pending.set(id, { resolve: value => resolve(structuredClone(value) as T), reject }); this.#worker.postMessage({ id, method, input: copy(input) }); });
  }
  get pending(): number { return this.#pending.size; }
  async close(): Promise<void> { if (!this.#closed) { await this.call("close", {}); await this.terminate(); } }
  async terminate(): Promise<void> { this.#closed = true; await this.#worker.terminate(); }
}
