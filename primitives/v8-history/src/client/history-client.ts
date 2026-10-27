import { conversationKey, sameConversation, sameScope, scopeKey } from "../contracts/identity.js";
import { mergeHistoryOrder } from "../contracts/order.js";
import type { ApplyResult, Change, OlderEdge, Row, Scope, Snapshot } from "../contracts/types.js";
import { canonical, cloneJson, deepFreeze, object, validateFrame } from "../contracts/validation.js";
import { AnchorController, type ViewportState } from "./anchor.js";

export class CapacityError extends Error { override name = "CapacityError"; }
export class HistoryProtocolError extends Error { override name = "HistoryProtocolError"; }
export type RowOrigin = Readonly<{ scope: Scope; generation: string; source: "current" | "older" | "retainedCurrent" }>;
type StoredRow = Readonly<{ row: Row; scope: Scope; generation: string; source: "current" | "older" }>;
type Retirement = Extract<Change, { kind: "retireRows" }>;
type ViewState = Readonly<{
  stored: ReadonlyMap<string, StoredRow>;
  order: readonly string[];
  edge: OlderEdge;
  privatePages: boolean;
}>;
export type ViewSnapshot = Readonly<{
  current: Snapshot | null;
  rows: readonly Row[];
  origins: Readonly<Record<string, RowOrigin>>;
  includesPriorGeneration: boolean;
  olderEdge: OlderEdge;
  viewport: ViewportState;
  expansions: readonly string[];
}>;
export type PageReadToken = Readonly<{
  scope: Scope; generation: string; readContext?: string; cursor: string; readGeneration: number; nonce: symbol;
}>;
export type ClientLimits = Readonly<{
  maxRowsPerView?: number;
  maxBytesPerView?: number;
  maxViews?: number;
  maxSeenFrames?: number;
  maxRetiredGenerations?: number;
  onObserverError?: (error: unknown) => void;
}>;
function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be positive`);
  return value;
}
function sameRow(a: Row, b: Row): boolean { return canonical(a) === canonical(b); }
function checkRowVersion(prior: Row, next: Row): void {
  if (next.version < prior.version || next.contentVersion < prior.contentVersion) throw new HistoryProtocolError("Row version regressed");
  if (next.version === prior.version && !sameRow(prior, next)) throw new HistoryProtocolError("Conflicting equal row version");
  if (canonical(next.body) !== canonical(prior.body) && next.contentVersion === prior.contentVersion) throw new HistoryProtocolError("Changed body reused its content version");
}
/** Within one acquisition, cache residency cannot weaken retained positive
 * terminal evidence. Keep the original row and provenance, never merge facts. */
function retainsComplete(prior: Row, next: Row): boolean {
  const terminal = (row: Row) => ["completed", "failed", "interrupted"].includes(row.lifecycle);
  return terminal(prior) && prior.body.kind === "complete" && (!terminal(next) || next.body.kind !== "complete");
}
/** Host snapshots normalize grouped native retirements to one immutable proof per identity. */
function retirementLedger(previous: readonly Retirement[], changes: readonly Change[]): readonly Retirement[] {
  const ledger = new Map<string, Retirement>();
  for (const change of [...previous, ...changes]) {
    if (change.kind !== "retireRows") continue;
    for (const id of change.rowIds) {
      const proof: Retirement = { kind: "retireRows", rowIds: [id], evidence: change.evidence,
        ...(change.replacementId === undefined ? {} : { replacementId: change.replacementId }) };
      const prior = ledger.get(id);
      if (prior && canonical(prior) !== canonical(proof)) throw new HistoryProtocolError("Conflicting retirement evidence");
      if (!prior) ledger.set(id, proof);
    }
  }
  return [...ledger.values()];
}
export class HistoryClient {
  #scope: Scope;
  #current: Snapshot | null = null;
  readonly #views = new Map<string, HistoryView>();
  readonly #listeners = new Set<() => void>();
  readonly #seen = new Map<string, string>();
  readonly #retiredGenerations = new Set<string>();
  #retiredRows = new Set<string>();
  readonly limits: Readonly<{ maxRowsPerView: number; maxBytesPerView: number; maxViews: number; maxSeenFrames: number; maxRetiredGenerations: number }>;
  readonly #onObserverError: (error: unknown) => void;

  constructor(scope: Scope, limits: ClientLimits = {}) {
    this.#scope = deepFreeze(structuredClone(scope));
    this.limits = Object.freeze({ maxRowsPerView: positive(limits.maxRowsPerView ?? 10_000, "Row limit"),
      maxBytesPerView: positive(limits.maxBytesPerView ?? 16 * 1_024 * 1_024, "Byte limit"), maxViews: positive(limits.maxViews ?? 8, "View limit"),
      maxSeenFrames: positive(limits.maxSeenFrames ?? 64, "Frame-equivalence limit"), maxRetiredGenerations: positive(limits.maxRetiredGenerations ?? 64, "Retired-generation limit") });
    this.#onObserverError = limits.onObserverError ?? (() => {});
  }
  get scope(): Scope { return this.#scope; }
  get current(): Snapshot | null { return this.#current; }
  get identity(): string { return conversationKey(this.#scope); }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  notify(listeners: Iterable<() => void>): void {
    for (const listener of [...listeners]) try { listener(); } catch (error) { try { this.#onObserverError(error); } catch { /* Observation cannot roll back committed facts. */ } }
  }
  view(key = "main"): HistoryView {
    if (!key || key.length > 256) throw new TypeError("Invalid retained view key");
    let view = this.#views.get(key);
    if (!view) {
      if (this.#views.size >= this.limits.maxViews) throw new CapacityError("Retained view capacity reached; explicit retirement required");
      view = new HistoryView(this, key); this.#views.set(key, view);
    }
    return view;
  }
  /** Explicit attachment fence; native/logical conversation identity cannot change. */
  rebind(scope: Scope): void {
    if (!sameConversation(this.#scope, scope)) throw new HistoryProtocolError("Cannot rebind another conversation or principal");
    if (sameScope(this.#scope, scope)) return;
    if (this.#current) { this.#admitRetirement(this.#current.generation); this.#retiredGenerations.add(this.#generationFence(this.#current.generation)); }
    this.#scope = deepFreeze(structuredClone(scope)); this.#current = null; this.#retiredRows = new Set();
    for (const view of this.#views.values()) view.commit(view.prepare(null, [], true), true);
    this.notify(this.#listeners); for (const view of this.#views.values()) view.publish();
  }
  #generationFence(generation: string): string { return JSON.stringify([scopeKey(this.#scope), generation]); }
  #admitRetirement(generation: string): void {
    if (!this.#retiredGenerations.has(this.#generationFence(generation)) && this.#retiredGenerations.size >= this.limits.maxRetiredGenerations) throw new CapacityError("Retired-generation fence capacity reached; old fences were preserved");
  }
  apply(value: unknown): ApplyResult {
    const frame = validateFrame(value);
    const scope = frame.kind === "snapshot" ? frame.snapshot.scope : frame.scope;
    if (!sameScope(scope, this.#scope)) throw new HistoryProtocolError("Foreign or retired history scope");
    const generation = frame.kind === "snapshot" ? frame.snapshot.generation : frame.generation;
    const revision = frame.kind === "snapshot" ? frame.snapshot.revision : frame.revision;
    if (this.#retiredGenerations.has(this.#generationFence(generation))) return "stale";
    const key = JSON.stringify([scopeKey(scope), generation, revision, frame.kind]), meaning = canonical(frame), seen = this.#seen.get(key);
    if (seen !== undefined) {
      if (seen !== meaning) throw new HistoryProtocolError("Conflicting equal Host frame revision");
      return "duplicate";
    }
    const prior = this.#current;
    if (prior?.generation === generation && revision < prior.revision) return "stale";
    if (prior?.generation === generation && revision === prior.revision) {
      if (frame.kind === "snapshot" && canonical(frame.snapshot) === canonical(prior)) return "duplicate";
      throw new HistoryProtocolError("Unproved equal Host frame revision");
    }
    if (frame.kind === "commit" && (!prior || prior.generation !== generation || frame.baseRevision !== prior.revision || revision !== prior.revision + 1)) return "needsSnapshot";
    const changedGeneration = !!prior && prior.generation !== generation;
    if (changedGeneration && prior) this.#admitRetirement(prior.generation);
    let retired = changedGeneration ? new Set<string>() : new Set(this.#retiredRows);
    let next: Snapshot;
    const changes: readonly Change[] = frame.kind === "commit" ? frame.changes : frame.snapshot.retirements;
    const retirements = retirementLedger(changedGeneration ? [] : prior?.retirements ?? [], changes);
    if (retirements.length > this.limits.maxRowsPerView) throw new CapacityError("Semantic-retirement evidence capacity reached");
    if (frame.kind === "snapshot") {
      if (retirementLedger([], frame.snapshot.retirements).length !== retirements.length) throw new HistoryProtocolError("Snapshot omitted known semantic retirement evidence");
      retired = new Set(retirements.flatMap(change => change.rowIds));
      if (frame.snapshot.rows.some(row => retired.has(row.id))) throw new HistoryProtocolError("Snapshot resurrected a retired native identity");
      if (prior?.generation === generation) {
        const previous = new Map(prior.rows.map(row => [row.id, row]));
        for (const row of frame.snapshot.rows) { const old = previous.get(row.id); if (old) checkRowVersion(old, row); }
      }
      next = deepFreeze({ ...frame.snapshot, retirements });
    } else {
      const rows = new Map(prior!.rows.map(row => [row.id, row]));
      for (const change of changes) {
        if (change.kind === "replaceRow") {
          if (retired.has(change.row.id)) throw new HistoryProtocolError("Retired native identity cannot silently reappear");
          const old = rows.get(change.row.id); if (old) checkRowVersion(old, change.row);
          rows.set(change.row.id, change.row);
        } else {
          for (const id of change.rowIds) { rows.delete(id); if (change.kind === "retireRows") retired.add(id); }
        }
      }
      if (retired.size > this.limits.maxRowsPerView) throw new CapacityError("Semantic-retirement evidence capacity reached");
      if (new Set(frame.order).size !== frame.order.length || frame.order.length !== rows.size || frame.order.some(id => !rows.has(id))) throw new HistoryProtocolError("Absolute current order does not match its rows");
      next = deepFreeze({ scope: frame.scope, generation, revision, rows: frame.order.map(id => rows.get(id)!), retirements, olderEdge: frame.olderEdge, coverage: frame.coverage, activity: frame.activity, read: frame.read ?? (frame.readContext === prior!.readContext ? prior!.read : { state: "idle" }),
        ...((frame.scopeInventory ?? prior?.scopeInventory) === undefined ? {} : { scopeInventory: frame.scopeInventory ?? prior!.scopeInventory! }), ...(frame.readContext === undefined ? {} : { readContext: frame.readContext }) });
    }
    const changedReadContext = prior?.readContext !== next.readContext;
    const prepared = [...this.#views.values()].map(view => [view, view.prepare(next, changes, changedGeneration, changedReadContext)] as const);
    if (changedGeneration && prior) this.#retiredGenerations.add(this.#generationFence(prior.generation));
    this.#current = next; this.#retiredRows = retired;
    // Older fingerprints can be released: the current-generation revision gate
    // still rejects their application, while the latest exact frame remains known.
    this.#seen.set(key, meaning); while (this.#seen.size > this.limits.maxSeenFrames) this.#seen.delete(this.#seen.keys().next().value!);
    for (const [view, state] of prepared) view.commit(state, changedGeneration || changedReadContext);
    this.notify(this.#listeners); for (const [view] of prepared) view.publish();
    return "applied";
  }
  isRetired(id: string): boolean { return this.#retiredRows.has(id); }
}

export class HistoryView {
  readonly client: HistoryClient;
  readonly key: string;
  readonly viewport: AnchorController;
  readonly #listeners = new Set<() => void>();
  readonly #expansions = new Set<string>();
  #state: ViewState = { stored: new Map(), order: [], edge: { state: "unknown", reason: "No current history boundary" }, privatePages: false };
  #snapshot: ViewSnapshot | null = null;
  #pending: PageReadToken | null = null;
  #suppress = false;

  constructor(client: HistoryClient, key: string) {
    this.client = client; this.key = key;
    this.viewport = new AnchorController({ changed: () => { this.#snapshot = null; if (!this.#suppress) this.publish(); } });
    this.#state = this.prepare(client.current, [], false);
  }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  publish(): void { this.client.notify(this.#listeners); }
  getSnapshot = (): ViewSnapshot => {
    if (!this.#snapshot) {
      const current = this.client.current, currentRows = new Map(current?.rows.map(row => [row.id, row]) ?? []);
      const origins = Object.fromEntries(this.#state.order.map(id => {
        const stored = this.#state.stored.get(id)!;
        const source = current?.generation === stored.generation && currentRows.get(id) === stored.row ? "current" : stored.source === "older" ? "older" : "retainedCurrent";
        return [id, { scope: stored.scope, generation: stored.generation, source } satisfies RowOrigin];
      }));
      this.#snapshot = deepFreeze({ current, rows: this.#state.order.map(id => this.#state.stored.get(id)!.row), origins,
        includesPriorGeneration: [...this.#state.stored.values()].some(value => !current || value.generation !== current.generation || !sameScope(value.scope, current.scope)),
        olderEdge: this.#state.edge, viewport: this.viewport.state, expansions: [...this.#expansions] });
    }
    return this.#snapshot;
  };
  #checkCapacity(stored: ReadonlyMap<string, StoredRow>): void {
    if (stored.size > this.client.limits.maxRowsPerView) throw new CapacityError("Retained rows full; state was preserved");
    let bytes = 0;
    for (const value of stored.values()) { bytes += canonical(value).length * 2; if (bytes > this.client.limits.maxBytesPerView) throw new CapacityError("Retained bytes full; state was preserved"); }
  }
  prepare(next: Snapshot | null, changes: readonly Change[], generationChanged: boolean, readContextChanged = false): ViewState {
    const stored = new Map(this.#state.stored); let order = [...this.#state.order];
    for (const change of changes) {
      if (change.kind === "retireRows") for (const id of change.rowIds) { stored.delete(id); order = order.filter(item => item !== id); }
      if (change.kind === "replaceRow" && next) {
        const old = stored.get(change.row.id);
        const sameAcquisition = old && old.generation === next.generation && sameScope(old.scope, next.scope);
        if (!sameAcquisition || old.row.version <= change.row.version) {
          if (sameAcquisition) { checkRowVersion(old.row, change.row); if (retainsComplete(old.row, change.row)) continue; }
          stored.set(change.row.id, { row: change.row, scope: next.scope, generation: next.generation, source: "current" });
        }
      }
    }
    if (next) {
      const incomingIds = new Set(next.rows.map(row => row.id));
      // An actual native generation/attachment change establishes new ordering
      // for reused identities. Unrelated retained rows keep their old provenance;
      // only anchors from this exact acquisition constrain the incoming order.
      order = order.filter(id => {
        if (!incomingIds.has(id)) return true;
        const old = this.#state.stored.get(id);
        return old?.generation === next.generation && sameScope(old.scope, next.scope);
      });
      for (const row of next.rows) {
        const old = stored.get(row.id);
        const sameAcquisition = old && old.generation === next.generation && sameScope(old.scope, next.scope);
        if (sameAcquisition && old.row.version > row.version) continue;
        if (sameAcquisition && old.row.version === row.version && !sameRow(old.row, row)) throw new HistoryProtocolError("Conflicting retained row version");
        if (sameAcquisition && retainsComplete(old.row, row)) continue;
        stored.set(row.id, { row, scope: next.scope, generation: next.generation, source: "current" });
      }
      order = mergeHistoryOrder(order, next.rows.map(row => row.id), false);
    }
    if (order.length !== stored.size || order.some(id => !stored.has(id))) throw new HistoryProtocolError("Retained row lacks an exact ordering boundary");
    this.#checkCapacity(stored);
    const edge = readContextChanged && next ? next.olderEdge : generationChanged ? { state: "unknown", reason: "Acquisition changed; retained pages need an explicit boundary rebase" } as const
      : !this.#state.privatePages && next ? next.olderEdge : this.#state.edge;
    return { stored, order, edge, privatePages: readContextChanged ? false : this.#state.privatePages || generationChanged };
  }
  commit(state: ViewState, retireRead: boolean): void {
    this.#state = state; this.#snapshot = null;
    for (const id of this.#expansions) if (!state.stored.has(id)) this.#expansions.delete(id);
    if (retireRead) { this.#pending = null; this.#suppress = true; try { this.viewport.retireRead(); } finally { this.#suppress = false; } }
  }
  expand(id: string, expanded: boolean): void {
    if (!this.#state.stored.has(id)) throw new HistoryProtocolError("Cannot expand an unknown row");
    if (expanded) this.#expansions.add(id); else this.#expansions.delete(id);
    this.#snapshot = null; this.publish();
  }
  beginOlderRead(): PageReadToken {
    if (this.#pending) return this.#pending;
    const current = this.client.current;
    if (!current || this.#state.edge.state !== "available") throw new HistoryProtocolError("Older edge is not available");
    const readGeneration = this.viewport.state.readGeneration + 1;
    const token = Object.freeze({ scope: current.scope, generation: current.generation, cursor: this.#state.edge.cursor, readGeneration, nonce: Symbol("older-read"), ...(current.readContext === undefined ? {} : { readContext: current.readContext }) });
    this.#pending = token;
    this.viewport.beginOlderRead();
    return token;
  }
  /** Retires only this consumer token; the actual read owner remains the caller/Host's duty. */
  finishOlderRead(token: PageReadToken): void {
    if (token !== this.#pending) return;
    this.#pending = null; this.viewport.endOlderRead(token.readGeneration);
  }
  resetPaging(): void {
    this.#pending = null; this.#suppress = true;
    try { this.viewport.retireRead(); } finally { this.#suppress = false; }
    this.#state = { ...this.#state, edge: this.client.current?.olderEdge ?? { state: "unknown", reason: "No current boundary" }, privatePages: false };
    this.#snapshot = null; this.publish();
  }
  applyPage(value: unknown, token: PageReadToken): ApplyResult {
    const current = this.client.current;
    if (token !== this.#pending || token.readGeneration !== this.viewport.state.readGeneration || !current || current.generation !== token.generation || current.readContext !== token.readContext || !sameScope(current.scope, token.scope)) return "stale";
    const page = object(cloneJson(value));
    if (Object.keys(page).some(key => !["scope", "generation", "readContext", "rows", "olderEdge"].includes(key))) throw new HistoryProtocolError("Unexpected history page field");
    const checked = validateFrame({ kind: "snapshot", snapshot: { scope: page.scope, generation: page.generation, revision: current.revision,
      rows: page.rows, retirements: [], olderEdge: page.olderEdge, coverage: { knownStart: false, gaps: [] }, activity: { turnId: null, state: "unknown" }, ...(page.readContext === undefined ? {} : { readContext: page.readContext }) } });
    if (checked.kind !== "snapshot") throw new HistoryProtocolError("Invalid history page");
    const data = checked.snapshot;
    if (!sameScope(data.scope, token.scope)) throw new HistoryProtocolError("Foreign history page");
    if (data.generation !== token.generation || data.readContext !== token.readContext) return "stale";
    if (data.olderEdge.state === "available" && data.olderEdge.cursor === token.cursor) throw new HistoryProtocolError("Older page cursor did not advance");
    const stored = new Map(this.#state.stored), ids: string[] = [];
    for (const row of data.rows) {
      if (this.client.isRetired(row.id)) continue;
      const old = stored.get(row.id); ids.push(row.id);
      if (old?.generation === data.generation && sameScope(old.scope, data.scope)) {
        if (old.row.version > row.version || old.row.contentVersion > row.contentVersion) continue;
        if (old.row.version === row.version) {
          if (!sameRow(old.row, row)) throw new HistoryProtocolError("Conflicting page row version");
          continue;
        }
        checkRowVersion(old.row, row);
        if (retainsComplete(old.row, row)) continue;
      }
      stored.set(row.id, { row, scope: data.scope, generation: data.generation, source: "older" });
    }
    this.#checkCapacity(stored);
    this.#state = { stored, order: mergeHistoryOrder(this.#state.order, ids, true), edge: data.olderEdge, privatePages: true };
    this.#snapshot = null; this.#pending = null; this.#suppress = true;
    try { this.viewport.endOlderRead(token.readGeneration); } finally { this.#suppress = false; }
    this.publish(); return "applied";
  }
}
