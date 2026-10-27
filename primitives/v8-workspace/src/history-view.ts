import { canonical, copy, id } from '../../v8-session/src/contracts/validation.js';
import { SessionError, type SessionScope } from '../../v8-session/src/contracts/types.js';
import type { Scope, ApplyResult } from '../../v8-history/src/contracts/types.js';
import type { HistoryObservation, HistoryRecovery } from '../../v8-history/src/acquisition/types.js';
import type { ViewSnapshot } from '../../v8-history/src/client/history-client.js';
import type { HistoryWorkspace, WorkspaceSession } from '../../v8-history/src/client/workspace.js';
import type { Binding, ObservationState, WorkspacePorts, WorkspaceView } from './contracts.js';
import { deepFreeze } from '../../v8-history/src/contracts/validation.js';

export type ReadonlyHistorySnapshot = Readonly<{ kind: 'ready' | 'stale'; history: ViewSnapshot; observation: ObservationState }> | Readonly<{ kind: 'disposed' }>;
export type ReadonlyHistoryView = Readonly<{
  scope: Scope;
  getSnapshot(): ReadonlyHistorySnapshot; getServerSnapshot(): ReadonlyHistorySnapshot;
  subscribe(listener: () => void): () => void;
  observe(): Readonly<{ release(): void }>;
  viewport: WorkspaceView['viewport'];
  setExpanded(rowId: string, expanded: boolean): void;
  loadOlder(retryToken?: string): Promise<ApplyResult>;
  recoverHistory(observation?: HistoryObservation, retryToken?: string): Promise<HistoryRecovery>;
}>;
type Entry = { parent: string; scope: Scope; session: WorkspaceSession; binding: Binding; valid(): boolean; observation: ObservationState; leases: Set<() => void>; acquiring: boolean; admission: object; stream: Readonly<{ release(): void }> | null; listeners: Set<() => void>; views: Map<string, ReadonlyHistoryView> };
const disposed = Object.freeze({ kind: 'disposed' as const });

/** Read-only facades over the existing retained HistoryWorkspace. This owns
 * visual stream leases and no rows, cache, native control or replay scheduler. */
export class ReadonlyHistories {
  readonly #entries = new Map<string, Entry>(); #closed = false;
  constructor(readonly history: HistoryWorkspace, readonly ports: WorkspacePorts) {}
  #open(): void { if (this.#closed) throw new SessionError('CLOSED'); }
  #releaseStream(entry: Entry): void {
    const stream = entry.stream; if (!stream || entry.acquiring) return;
    entry.acquiring = true;
    try { stream.release(); if (entry.stream === stream) entry.stream = null; } finally { entry.acquiring = false; }
  }
  #notify(entry: Entry): void { for (const notify of [...entry.listeners]) try { notify(); } catch {} }
  observation(parent: string, scope: Scope, state: ObservationState): void { const entry = this.#entries.get(canonical([parent, scope])); if (entry && entry.observation !== state) { entry.observation = state; this.#notify(entry); } }
  reconcile(parent: string): void { for (const entry of this.#entries.values()) if (entry.parent === parent) { if (!entry.valid()) { entry.observation = 'unobserved'; entry.admission = {}; this.#releaseStream(entry); } this.#notify(entry); } }
  invalidate(parent: string): void { for (const entry of this.#entries.values()) if (entry.parent === parent) { entry.observation = 'unobserved'; entry.admission = {}; this.#releaseStream(entry); this.#notify(entry); } }
  view(parent: SessionScope, value: Scope, viewKey: string, binding: Binding, valid: () => boolean): ReadonlyHistoryView {
    this.#open(); id(viewKey); const scope = deepFreeze(copy(value)), key = canonical([parent.session, scope]);
    let entry = this.#entries.get(key);
    if (!entry) {
      if (this.#entries.size >= 32) throw new SessionError('FULL');
      entry = { parent: parent.session, scope, session: this.history.rebind(scope), binding, valid, observation: 'unobserved', leases: new Set(), acquiring: false, admission: {}, stream: null, listeners: new Set(), views: new Map() }; this.#entries.set(key, entry);
    } else { entry.binding = binding; entry.valid = valid; }
    const stored = entry, existing = stored.views.get(viewKey); if (existing) return existing;
    const history = stored.session.client.view(viewKey); let older: Promise<ApplyResult> | undefined, previous: unknown[] | undefined, cached!: ReadonlyHistorySnapshot;
    // Binding identity is the admission token. Reopening the same proved scope
    // creates another validator closure, but does not invalidate admitted work.
    const current = (admission = stored.binding) => { this.#open(); if (stored.binding !== admission || !stored.valid()) throw new SessionError('FENCED', 'Choose a scope from the current proved inventory'); };
    const getSnapshot = (): ReadonlyHistorySnapshot => {
      if (this.#closed) return disposed;
      const snapshot = history.getSnapshot(), valid = stored.valid(), next = [snapshot, valid, stored.observation];
      if (previous?.every((value, index) => value === next[index])) return cached;
      previous = next; cached = Object.freeze({ kind: valid ? 'ready' : 'stale', history: snapshot, observation: stored.observation }); return cached;
    };
    const view: ReadonlyHistoryView = Object.freeze({ scope: Object.freeze(scope), getSnapshot, getServerSnapshot: getSnapshot,
      subscribe: listener => { if (this.#closed) return () => {}; const notify = () => { try { listener(); } catch {} }; stored.listeners.add(notify); const release = history.subscribe(notify); return () => { release(); stored.listeners.delete(notify); }; },
      observe: () => {
        const binding = stored.binding, admission = stored.admission; current(binding); if (stored.acquiring) throw new SessionError('BUSY', 'Child observation acquisition is in progress');
        const lease = stored.session.mount(viewKey);
        const releaseMount = () => { if (!stored.leases.has(releaseMount)) return; lease.release(); stored.leases.delete(releaseMount); };
        stored.leases.add(releaseMount);
        const release = () => {
          const errors: unknown[] = [];
          try { releaseMount(); } catch (error) { errors.push(error); }
          if (!stored.leases.size) try { this.#releaseStream(stored); } catch (error) { errors.push(error); }
          if (errors.length) throw new AggregateError(errors, 'Child history observation failed to retire');
        };
        try { if (!stored.stream) { stored.acquiring = true; try { stored.stream = this.ports.observeHistory(parent, scope); } finally { stored.acquiring = false; } } }
        catch (error) { try { releaseMount(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Child history acquisition failed'); } throw error; }
        if (this.#closed) { this.close(); throw new SessionError('CLOSED'); }
        try { current(binding); if (stored.admission !== admission) throw new SessionError('FENCED'); }
        catch (error) {
          const errors: unknown[] = [error];
          try { releaseMount(); } catch (cleanup) { errors.push(cleanup); }
          try { this.#releaseStream(stored); } catch (cleanup) { errors.push(cleanup); }
          if (errors.length > 1) throw new AggregateError(errors, 'Child history acquisition was invalidated'); throw error;
        }
        return Object.freeze({ release });
      },
      viewport: Object.freeze({ report: anchor => { this.#open(); history.viewport.report(anchor); }, userScroll: (direction, atTail) => { this.#open(); history.viewport.userScroll(direction, atTail); }, followLatest: () => { this.#open(); history.viewport.followLatest(); }, captureFollow: () => { this.#open(); const follow = history.viewport.captureFollow(); return () => { if (!this.#closed) follow(); }; }, tailPosition: (top, maximum, editing) => { this.#open(); return history.viewport.tailPosition(top, maximum, editing); }, beginRestore: () => { this.#open(); return history.viewport.beginRestore(); }, correct: (token, geometry) => { this.#open(); return history.viewport.correct(token, geometry); } } satisfies WorkspaceView['viewport']),
      setExpanded: (row, expanded) => { this.#open(); history.expand(row, expanded); },
      loadOlder: retryToken => {
        const admission = stored.binding; current(admission); if (older) return older; if (!this.ports.older) throw new SessionError('UNSUPPORTED');
        const token = history.beginOlderRead(), work = Promise.resolve().then(() => { current(admission); return this.ports.older!(parent, token.scope, token.cursor, token.generation, retryToken); }).then(page => { current(admission); return history.applyPage(page, token); }).finally(() => history.finishOlderRead(token));
        older = work; void work.finally(() => { if (older === work) older = undefined; }).catch(() => {}); return work;
      },
      recoverHistory: async (observation = {}, retryToken) => { const admission = stored.binding; current(admission); if (!this.ports.recover) return { state: 'value', value: { status: 'unsupported' } }; const result = await this.ports.recover(parent, scope, observation, retryToken); current(admission); return result; },
    });
    stored.views.set(viewKey, view); return view;
  }
  close(): void {
    const first = !this.#closed; this.#closed = true;
    if (first) for (const entry of this.#entries.values()) { this.#notify(entry); entry.listeners.clear(); }
    const errors: unknown[] = [];
    for (const entry of this.#entries.values()) {
      for (const release of [...entry.leases]) try { release(); } catch (error) { errors.push(error); }
      try { this.#releaseStream(entry); } catch (error) { errors.push(error); }
    }
    // Slots stay owned after close: an acquisition may still return its handle,
    // and explicit close may retry only the exact handles that failed release.
    if (errors.length) throw new AggregateError(errors, 'Child history observations failed to retire');
  }
}
