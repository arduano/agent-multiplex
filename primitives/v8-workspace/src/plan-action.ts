import { SessionError, type RunRef, type Receipt } from '../../v8-session/src/contracts/types.js';
import type { ViewSnapshot } from '../../v8-history/src/client/history-client.js';
import type { Row, Scope } from '../../v8-history/src/contracts/types.js';
import { sameScope } from '../../v8-history/src/contracts/identity.js';

export type PlanOriginal = Readonly<{ id: string; result: Promise<Receipt | null> }>;
export type PlanAction = Readonly<{ rowId: string; originalId: string | null }>;
export type PlanPreparation = { key: string; runKey: string; rowId: string; originalId: string | null; result: Promise<PlanOriginal> };

/** A native plan occurrence must belong to this current root capture. Retained
 * old-generation, child, incomplete and plain assistant text grant no action. */
export function rootPlan(history: ViewSnapshot, root: Scope, run: RunRef, rowId: string): Row | null {
  const current = history.current, origin = history.origins[rowId], row = history.rows.find(value => value.id === rowId);
  return root.kind === 'codex' && root.threadId === run.nativeSession && current && sameScope(current.scope, root) && current.scopeInventory?.nativeGeneration === run.generation &&
    origin && sameScope(origin.scope, root) && origin.generation === current.generation && origin.source !== 'retainedCurrent' && row?.kind === 'assistant' && row.lifecycle === 'completed' && row.body.kind === 'complete' && !!row.body.text.trim() &&
    row.native.type === 'plan' && row.native.threadId === run.nativeSession && typeof row.native.turnId === 'string' && !!row.native.turnId && typeof row.native.nativeItemId === 'string' && !!row.native.nativeItemId ? row : null;
}

/** Associations only: effect identity and status belong to the existing Send
 * original. One shared preparation slot joins two views of the same plan. */
export class PlanActions {
  readonly #entries = new Map<string, PlanPreparation>();
  #pending: PlanPreparation | undefined; #closed = false;
  #snapshot: readonly (PlanAction & Readonly<{ runKey: string }>)[] = Object.freeze([]);
  constructor(readonly changed: () => void) {}
  get pending(): PlanPreparation | undefined { return this.#pending; }
  existing(key: string): Promise<PlanOriginal> | undefined { return this.#entries.get(key)?.result; }
  getSnapshot() { return this.#snapshot; }
  #publish(): void {
    // These are display associations, not an original/receipt owner. The
    // Session/composer owners retain uncertain originals independently.
    const recent = [...this.#entries.values()].filter(job => job !== this.#pending);
    for (const job of recent.slice(0, Math.max(0, recent.length - 32))) this.#entries.delete(job.key);
    this.#snapshot = Object.freeze([...this.#entries.values()].map(value => Object.freeze({ rowId: value.rowId, originalId: value.originalId, runKey: value.runKey })));
    if (!this.#closed) this.changed();
  }
  start(key: string, runKey: string, rowId: string, work: (job: PlanPreparation) => Promise<PlanOriginal>): Promise<PlanOriginal> {
    if (this.#closed) throw new SessionError('CLOSED');
    const previous = this.#entries.get(key); if (previous) return previous.result;
    if (this.#pending) throw new SessionError('BUSY');
    const job: PlanPreparation = { key, runKey, rowId, originalId: null, result: Promise.resolve().then(() => work(job)) };
    this.#entries.set(key, job); this.#pending = job; this.#publish();
    void job.result.catch(() => { if (job.originalId === null) this.#entries.delete(key); }).finally(() => { if (this.#pending === job) this.#pending = undefined; this.#publish(); });
    return job.result;
  }
  identify(job: PlanPreparation, originalId: string): void { job.originalId = originalId; this.#publish(); }
  close(): Promise<void> | undefined { this.#closed = true; this.#entries.clear(); this.#snapshot = Object.freeze([]); return this.#pending?.result.then(() => {}, () => {}); }
}
