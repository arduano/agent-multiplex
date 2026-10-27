import { scopeKey } from '../../v8-session/src/contracts/types.js';
import { McpError, type McpPort, type McpSnapshot, type Observation, type RunRef } from './contracts.js';
import { MAX_SNAPSHOT_BYTES, assertRun, canonical, check, copy, id, validateRun, validateSnapshot } from './validation.js';

export type McpView = Readonly<{ snapshot: McpSnapshot | null; connected: boolean; stale: boolean }>;
export type McpEntry = Readonly<{ getSnapshot(): McpView; subscribe(listener: () => void): () => void }>;
type Entry = {
  run: RunRef;
  kind: 'codex' | 'copilot';
  value: McpSnapshot | null;
  connected: boolean;
  stale: boolean;
  retired: boolean;
  initial: boolean;
  read: Promise<void> | null;
  token: number;
  listeners: Set<() => void>;
  unsubscribe: (() => void) | null;
  facade?: McpEntry;
};
const key = (run: RunRef) => JSON.stringify([scopeKey(run.scope), run.generation, run.nativeSession]);

/** Retained exact-run observation. Mount/bind/reconnect never requests native discovery. */
export class McpWorkspace {
  readonly #connection: string;
  readonly #principal: string;
  readonly #port: McpPort;
  readonly #entries = new Map<string, Entry>();
  readonly #maximum: number;
  #closed = false;

  constructor(options: Readonly<{ connection: string; principal: string; port: McpPort; maxRuns?: number }>) {
    id(options.connection); id(options.principal);
    this.#connection = options.connection; this.#principal = options.principal; this.#port = options.port;
    this.#maximum = options.maxRuns ?? 16;
    check(Number.isSafeInteger(this.#maximum) && this.#maximum > 0 && this.#maximum <= 256);
  }

  async bind(run: RunRef, kind: 'codex' | 'copilot'): Promise<void> {
    this.#scope(run); check(kind === 'codex' || kind === 'copilot');
    let entry = this.#entries.get(key(run));
    if (entry) {
      if (entry.kind !== kind) throw new McpError('CONFLICT');
    } else {
      if (this.#entries.size >= this.#maximum) throw new McpError('FULL');
      entry = { run: copy(run), kind, value: null, connected: true, stale: true, retired: false, initial: false, read: null, token: 0, listeners: new Set(), unsubscribe: null };
      this.#entries.set(key(run), entry);
      const admitted = entry;
      try {
        const unsubscribe = this.#port.subscribe(admitted.run, snapshot => {
          if (!this.#current(admitted) || admitted.retired) return;
          try { this.#observe(admitted, snapshot); }
          catch (error) { admitted.stale = true; this.#notify(admitted); throw error; }
        });
        // subscribe may synchronously publish retirement or trigger disposal.
        if (!this.#current(admitted) || admitted.retired) {
          try { unsubscribe(); } catch { /* Observation cleanup cannot restore a retired run. */ }
        } else admitted.unsubscribe = unsubscribe;
      } catch (error) {
        if (this.#current(admitted)) this.#remove(admitted);
        throw error;
      }
    }
    if (entry.retired || entry.initial) return;
    await this.reobserve(entry.run);
  }

  entry(run: RunRef): McpEntry {
    const entry = this.#entry(run);
    if (entry.facade) return entry.facade;
    let seen = -1, cached: McpView;
    entry.facade = Object.freeze({
      getSnapshot: () => {
        if (seen !== entry.token) {
          cached = copy({ snapshot: entry.value, connected: entry.connected, stale: entry.stale }); seen = entry.token;
        }
        return cached;
      },
      subscribe: (listener: () => void) => {
        if (!this.#current(entry)) throw new McpError('CLOSED');
        if (entry.listeners.size >= 64) throw new McpError('FULL');
        entry.listeners.add(listener); return () => entry.listeners.delete(listener);
      },
    });
    return entry.facade;
  }

  setConnected(run: RunRef, connected: boolean): void {
    this.#scope(run); const entry = this.#entries.get(key(run)); if (!entry) return;
    entry.connected = connected; entry.stale = true; this.#notify(entry);
  }

  /** Resynchronize retained Host observation only, suitable after a read-only reconnect. */
  async reobserve(run: RunRef): Promise<void> {
    const entry = this.#entry(run);
    if (entry.retired) throw new McpError('FENCED');
    if (!entry.connected) throw new McpError('UNAVAILABLE');
    if (entry.read) return entry.read;
    const pending = Promise.resolve().then(async () => {
      try {
        this.#assertCurrent(entry);
        const value = await this.#port.snapshot(entry.run);
        this.#assertCurrent(entry);
        this.#observe(entry, value); entry.initial = true;
      } catch (error) {
        if (this.#current(entry)) { entry.stale = true; this.#notify(entry); }
        throw error;
      } finally {
        if (entry.read === pending) entry.read = null;
      }
    });
    entry.read = pending;
    return pending;
  }

  async refresh(run: RunRef, observation: Observation = {}): Promise<McpSnapshot> {
    const entry = this.#entry(run);
    if (entry.retired) throw new McpError('FENCED');
    if (!entry.connected) throw new McpError('UNAVAILABLE');
    const value = await this.#port.refresh(entry.run, observation);
    this.#assertCurrent(entry);
    if (entry.retired) throw new McpError('FENCED');
    this.#observe(entry, value); return value;
  }

  /** Exact published/candidate run retirement; never called by ordinary selection/unmount. */
  retire(run: RunRef): void {
    if (this.#closed) return;
    this.#scope(run);
    const entry = this.#entries.get(key(run));
    if (entry) this.#remove(entry);
  }

  /** Only workspace namespace disposal, never ordinary selection/unmount. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#entries.values()) this.#remove(entry);
  }

  #scope(run: RunRef): void {
    if (this.#closed) throw new McpError('CLOSED');
    validateRun(run);
    if (run.scope.connection !== this.#connection || run.scope.principal !== this.#principal) throw new McpError('FENCED');
  }
  #entry(run: RunRef): Entry {
    this.#scope(run);
    const entry = this.#entries.get(key(run));
    if (!entry) throw new McpError('FENCED');
    assertRun(entry.run, run); return entry;
  }
  #current(entry: Entry): boolean { return !this.#closed && this.#entries.get(key(entry.run)) === entry; }
  #assertCurrent(entry: Entry): void {
    if (this.#closed) throw new McpError('CLOSED');
    if (!this.#current(entry)) throw new McpError('FENCED');
  }
  #detach(entry: Entry): void {
    const unsubscribe = entry.unsubscribe; entry.unsubscribe = null;
    try { unsubscribe?.(); } catch { /* Continue disposing every retained owner. */ }
  }
  #remove(entry: Entry): void {
    // Fence callbacks before invoking external cleanup or notifying cached facades.
    entry.retired = true;
    if (this.#entries.get(key(entry.run)) === entry) this.#entries.delete(key(entry.run));
    entry.value = null; entry.connected = false; entry.stale = true;
    this.#notify(entry); entry.listeners.clear(); this.#detach(entry);
  }
  #observe(entry: Entry, value: McpSnapshot): void {
    if (!this.#current(entry) || entry.retired) return;
    const incoming = validateSnapshot(value, entry.run, entry.kind);
    if (entry.value && (incoming.epoch < entry.value.epoch || incoming.epoch === entry.value.epoch && incoming.revision < entry.value.revision)) return;
    if (entry.value && incoming.epoch === entry.value.epoch && incoming.revision === entry.value.revision && canonical(incoming, MAX_SNAPSHOT_BYTES) !== canonical(entry.value, MAX_SNAPSHOT_BYTES)) throw new McpError('CONFLICT');
    entry.value = incoming; entry.stale = !entry.connected || incoming.freshness !== 'current';
    if (incoming.freshness === 'retired') { entry.retired = true; this.#detach(entry); }
    this.#notify(entry);
  }
  #notify(entry: Entry): void {
    entry.token++;
    for (const listener of [...entry.listeners]) try { listener(); } catch { /* One renderer does not own another observation. */ }
  }
}
