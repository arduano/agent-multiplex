import { HistoryWorkspace, type ViewLease, type WorkspaceSession } from "../../../v8-history/src/client/workspace.js";
import type { Scope } from "../../../v8-history/src/contracts/types.js";
import type { FileWorkspace } from "../../../v8-files/src/client/workspace.js";
import { SessionError, scopeKey, sameRun, isMessageCommand, type RunRef, type NativeRead, type GoalStatus, type NativeReadFor, type NativeReadResult, type McpLoginLink, type CodexSelection, type CopilotSelection, type Json, type Receipt, type Selection, type SendInputsFor, type SendCommandFor, type SessionCommand, type SessionPort, type SessionScope, type SessionSnapshot, type Submit } from "../contracts/types.js";
import { canonical, check, copy, id as checkId, scope as checkScope } from "../contracts/validation.js";
import { validateNativeRead, validateNativeReadResult } from "../../../v8-harness-defaults/src/state.js";
import { originalCommandType as checkOriginalType, observedSnapshot, selection as checkSelection } from "./validation.js";

export type OriginalIdentity = Readonly<Pick<Receipt, "scope" | "id" | "type" | "generation">>;
/** Inert receipt identity. Owner is the durable request domain, excluding route freshness. */
export type OriginalReceiptReference = OriginalIdentity & Readonly<{ owner: string }>;
export type ClientOperation = Readonly<{ original: OriginalIdentity; request: Submit | null; receipt: Receipt | null; transmission: "pending" | "returned" | "unavailable" }>;
export type NativeReadObservation = Readonly<{ run: RunRef; request: NativeRead; state: "loading" | "available" | "unavailable"; stale: boolean; value: NativeReadResult | null }>;
export type SessionView = Readonly<{
  native: SessionSnapshot | null; connected: boolean; stale: boolean; requiresRebind: boolean;
  nativeReads: readonly NativeReadObservation[];
  active: boolean; draft: Selection | null; operations: readonly ClientOperation[]; activeJobs: number;
  issue: SessionSnapshot["issue"] | "observationUnavailable" | null;
}>;
export type OperationHandle = Readonly<{ id: string; request: Submit; result: Promise<Receipt> }>;
export type CommonActions<K extends "codex" | "copilot"> = Readonly<{
  /** Editable next intent only; no native request. */
  setSelectionDraft(selection: Extract<Selection, { kind: K }> | null): void;
  create(selection?: Extract<Selection, { kind: K }>): OperationHandle; resume(): OperationHandle; stop(): OperationHandle; archive(): OperationHandle;
  continue?: () => OperationHandle;
  send?: (text: string, selection?: Extract<Selection, { kind: K }>, inputs?: SendInputsFor<K>) => OperationHandle;
  answer?: (interactionId: string, choice: string, value?: Json) => OperationHandle;
  /** Direct private response only; no nativeReads, snapshot or persisted URL. */
  mcpLoginLink?: (originalId: string) => Promise<McpLoginLink>;
}>;
export type CodexAgent = Readonly<{ kind: "codex"; state: SessionView; actions: CommonActions<"codex"> & Readonly<{
  setDefaults?: (selection: CodexSelection) => OperationHandle;
  updateTurn?: (turnId: string, selection: CodexSelection) => OperationHandle;
  interrupt?: (turnId: string) => OperationHandle;
  enqueue?: (text: string, inputs?: SendInputsFor<"codex">) => OperationHandle;
  steer?: (expectedTurnId: string, text: string, inputs?: SendInputsFor<"codex">) => OperationHandle;
  compact?: () => OperationHandle;
  setGoal?: (patch: Readonly<{ objective?: string; status?: GoalStatus; tokenBudget?: number | null }>) => OperationHandle;
  clearGoal?: () => OperationHandle;
  terminateTerminal?: (processId: string) => OperationHandle;
  cleanTerminals?: () => OperationHandle;
  reloadMcp?: () => OperationHandle;
  loginMcp?: (serverName: string) => OperationHandle;
  read?: (request: NativeReadFor<"codex">) => Promise<NativeReadResult>;
}> }>;
export type CopilotAgent = Readonly<{ kind: "copilot"; state: SessionView; actions: CommonActions<"copilot"> & Readonly<{
  setModel?: (model: string, options?: Readonly<{ providerId?: string; effort?: string | null }>) => OperationHandle;
  setMode?: (mode: "interactive" | "plan" | "autopilot") => OperationHandle;
  setPermissions?: (mode: "manual" | "allow-all") => OperationHandle;
  abort?: () => OperationHandle;
  steer?: (text: string, inputs?: SendInputsFor<"copilot">) => OperationHandle;
  promoteQueued?: (id: string) => OperationHandle;
  compact?: () => OperationHandle;
  cancelTask?: (id: string) => OperationHandle;
  promoteTask?: (id: string) => OperationHandle;
  reconnectMcp?: (serverName: string) => OperationHandle;
  loginMcp?: (serverName: string, forceReauth?: boolean) => OperationHandle;
  read?: (request: NativeReadFor<"copilot">) => Promise<NativeReadResult>;
}> }>;
export type SessionAgent = CodexAgent | CopilotAgent | Readonly<{ kind: "unsupported"; state: SessionView }>;
type Stored = { value: ClientOperation; handle: OperationHandle | null; history: WorkspaceSession | undefined; owner: string | undefined };
const positive = (value: number): number => { check(Number.isSafeInteger(value) && value > 0); return value; };
const finalReceipt = (value: Receipt | null): boolean => value?.state === "acknowledged" || value?.state === "refused";

/** One retained entry, never owned by a mounted hook. No browser persistence is introduced. */
class RetainedSession {
  readonly #listeners = new Set<() => void>();
  readonly nativeReads = new Map<NativeRead["type"], NativeReadObservation>();
  readonly operations = new Map<string, Stored>(); readonly jobs = new Set<Promise<unknown>>();
  history: WorkspaceSession | undefined; historyScope: Scope | undefined; boundGeneration: number | null = null;
  native: SessionSnapshot | null = null; connected = true; stale = true; requiresRebind = false;
  reobservation: Promise<void> | null = null;
  draft: Selection | null = null; unavailable = false; unsubscribe: (() => void) | null = null;
  #snapshot: SessionView;
  constructor(readonly scope: SessionScope, readonly kind: "codex" | "copilot") { this.#snapshot = this.#view(); }
  #view(): SessionView {
    return Object.freeze({ native: this.native, connected: this.connected, stale: this.stale, requiresRebind: this.requiresRebind,
      nativeReads: Object.freeze([...this.nativeReads.values()]),
      active: this.native === null || this.native.phase !== "stopped", draft: this.draft,
      operations: Object.freeze([...this.operations.values()].map(value => value.value)), activeJobs: this.jobs.size,
      issue: this.native?.issue ?? (this.unavailable ? "observationUnavailable" : null) });
  }
  getSnapshot = (): SessionView => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    if (!this.#listeners.has(listener) && this.#listeners.size >= 128) throw new SessionError("FULL", "Retained observation listeners are full");
    this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
  };
  changed(): void {
    this.#snapshot = this.#view();
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch { /* A renderer cannot reject accepted native state or another subscriber. */ }
    }
  }
  retireObservation(): void {
    this.nativeReads.clear(); this.connected = false; this.stale = true;
    this.#snapshot = this.#view();
  }
}

export type SessionEntry = Pick<RetainedSession, "getSnapshot" | "subscribe"> & Readonly<{ history: WorkspaceSession; historyScope: Scope }>;
/** Logical control observation can exist before a native transcript identity. */
export type ControlEntry = Pick<RetainedSession, "getSnapshot" | "subscribe">;

export class SessionWorkspace {
  readonly #history: HistoryWorkspace; readonly #port: SessionPort; readonly #files: FileWorkspace | undefined;
  readonly #maxSessions: number; readonly #maxOperations: number;
  readonly #receiptOwner: ((scope: SessionScope) => string) | undefined;
  readonly #protectOriginal: ((reference: OriginalReceiptReference) => boolean) | undefined;
  readonly #admit: ((scope: SessionScope, action: 'read' | 'control') => void) | undefined;
  readonly #entries = new Map<string, RetainedSession>(); readonly #reads = new Map<string, Promise<unknown>>();
  #connected = true; #closed = false;
  constructor(options: Readonly<{ history: HistoryWorkspace; port: SessionPort; files?: FileWorkspace; maxSessions?: number; maxOperations?: number; receiptOwner?: (scope: SessionScope) => string; protectOriginal?: (reference: OriginalReceiptReference) => boolean; admit?: (scope: SessionScope, action: 'read' | 'control') => void }>) {
    this.#history = options.history; this.#port = options.port; this.#files = options.files;
    this.#receiptOwner = options.receiptOwner; this.#protectOriginal = options.protectOriginal; this.#admit = options.admit;
    this.#maxSessions = positive(options.maxSessions ?? 16); this.#maxOperations = positive(options.maxOperations ?? 128);
  }
  #open(): void { if (this.#closed) throw new SessionError("CLOSED"); }
  #entry(scope: SessionScope): RetainedSession { this.#open(); checkScope(scope); const entry = this.#entries.get(scopeKey(scope)); if (!entry) throw new SessionError("FENCED", "Session is not bound"); return entry; }
  #bound(entry: RetainedSession): RetainedSession & { history: WorkspaceSession; historyScope: Scope } {
    if (!entry.history || !entry.historyScope) throw new SessionError("FENCED", "Native history is not bound");
    return entry as RetainedSession & { history: WorkspaceSession; historyScope: Scope };
  }
  entry(scope: SessionScope): SessionEntry { return this.#bound(this.#entry(scope)); }
  control(scope: SessionScope): ControlEntry { return this.#entry(scope); }
  async prepare(scope: SessionScope, kind: "codex" | "copilot"): Promise<ControlEntry> {
    this.#open(); scope = copy(scope); checkScope(scope); check(kind === "codex" || kind === "copilot");
    const key = scopeKey(scope), prior = this.#entries.get(key);
    if (prior) { if (prior.kind !== kind) throw new SessionError("FENCED"); await this.refresh(scope); this.#open(); if (this.#entries.get(key) !== prior) throw new SessionError("FENCED"); return prior; }
    if (this.#entries.size >= this.#maxSessions) throw new SessionError("FULL", "Retained sessions are full; nothing was evicted");
    const entry = new RetainedSession(scope, kind); entry.connected = this.#connected; this.#entries.set(key, entry);
    try {
      entry.unsubscribe = this.#port.subscribe(scope, value => { try { this.#apply(entry, value); } catch { entry.unavailable = true; entry.stale = true; entry.changed(); } });
    } catch (error) {
      // A failed acquisition cannot become a reusable snapshot-only entry.
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
      throw error;
    }
    // The port can synchronously retire this workspace before returning its
    // release handle. Transfer that exact handle into the existing close path.
    if (this.#closed) { this.close(); throw new SessionError("CLOSED"); }
    // A later snapshot failure leaves the acquired observation owned here.
    await this.refresh(scope); this.#open(); return entry;
  }
  #scopeMatch(scope: SessionScope, historyScope: Scope): void {
    checkScope(scope);
    if (scope.connection !== historyScope.origin.connection || scope.principal !== historyScope.origin.principal || scope.host !== historyScope.origin.host) throw new SessionError("FENCED");
  }
  async bind(scope: SessionScope, historyScope: Scope): Promise<SessionEntry> {
    this.#open(); scope = copy(scope); historyScope = copy(historyScope); this.#scopeMatch(scope, historyScope);
    const key = scopeKey(scope), prior = this.#entries.get(key);
    if (prior?.historyScope) {
      if (canonical(prior.historyScope) !== canonical(historyScope)) throw new SessionError("CONFLICT", "Attachment change requires explicit rebind");
      return this.#bound(prior);
    }
    await this.prepare(scope, historyScope.kind); const entry = this.#entry(scope);
    if (entry.historyScope) {
      if (canonical(entry.historyScope) !== canonical(historyScope)) throw new SessionError("CONFLICT", "Attachment change requires explicit rebind");
      return this.#bound(entry);
    }
    if (!entry.native?.nativeSession || entry.native.nativeSession !== historyScope.origin.nativeSession) {
      entry.changed(); throw new SessionError("FENCED", "Native history needs a matching observed session ID");
    }
    // Preserve logical controls/originals; only the positive native binding
    // allocates a history owner. No provisional transcript or invented ID.
    const history = this.#history.session(historyScope);
    history.recordOperations([...entry.operations.values()].filter(item => !item.history).map(({ value: { original, receipt } }) => ({ id: original.id, intent: { kind: "session-operation", type: original.type, generation: original.generation }, reserve: original.type === "stop", settled: finalReceipt(receipt) })));
    entry.history = history; entry.historyScope = historyScope;
    entry.boundGeneration = entry.native?.generation ?? null; entry.requiresRebind = false;
    for (const item of entry.operations.values()) if (!item.history) {
      item.history = entry.history; const original = item.value.original;
      if (item.value.receipt && !finalReceipt(item.value.receipt)) item.history.observeOperation(original.id, { state: item.value.receipt.state, type: item.value.receipt.type });
    }
    if (this.#files) await this.#files.bind({ ...scope, session: historyScope.origin.nativeSession }, historyScope);
    entry.changed(); return this.#bound(entry);
  }
  async rebind(scope: SessionScope, historyScope: Scope): Promise<SessionEntry> {
    this.#open(); scope = copy(scope); historyScope = copy(historyScope); this.#scopeMatch(scope, historyScope);
    const entry = this.#bound(this.#entry(scope)); await this.refresh(scope);
    if (!entry.native || entry.native.kind !== historyScope.kind || entry.native.nativeSession !== null && entry.native.nativeSession !== historyScope.origin.nativeSession) throw new SessionError("FENCED");
    entry.history = this.#history.rebind(historyScope); entry.historyScope = historyScope; entry.boundGeneration = entry.native.generation; entry.requiresRebind = false;
    if (this.#files) await this.#files.bind({ ...scope, session: historyScope.origin.nativeSession }, historyScope);
    entry.changed(); return this.#bound(entry);
  }
  #apply(entry: RetainedSession, raw: SessionSnapshot): void {
    if (this.#closed || this.#entries.get(scopeKey(entry.scope)) !== entry) return;
    const snapshot = observedSnapshot(raw);
    if (scopeKey(snapshot.scope) !== scopeKey(entry.scope) || snapshot.kind !== entry.kind) throw new SessionError("FENCED");
    if (entry.native) {
      if (snapshot.epoch < entry.native.epoch) return;
      if (snapshot.generation < entry.native.generation) {
        if (snapshot.epoch > entry.native.epoch) throw new SessionError("FENCED", "New observation incarnation regressed the native generation");
        return;
      }
      if (snapshot.epoch === entry.native.epoch && snapshot.revision < entry.native.revision) return;
      const archive = entry.native.archive;
      if (archive && (snapshot.generation !== entry.native.generation || !snapshot.archive || snapshot.archive.id !== archive.id || archive.state === "complete" && snapshot.archive.state !== "complete")) throw new SessionError("FENCED", "Completed archive evidence cannot regress or change identity");
      if (snapshot.epoch === entry.native.epoch && snapshot.revision === entry.native.revision) {
        if (canonical(snapshot, 256 * 1024) !== canonical(entry.native, 256 * 1024)) throw new SessionError("CONFLICT", "Same revision changed meaning");
        entry.unavailable = false; entry.stale = !this.#connected; entry.changed(); return;
      }
    }
    for (const [type, observation] of entry.nativeReads) entry.nativeReads.set(type, Object.freeze({ ...observation, stale: true }));
    entry.native = snapshot; entry.unavailable = false; entry.stale = !this.#connected;
    if (entry.historyScope) entry.boundGeneration ??= snapshot.generation;
    entry.requiresRebind = !!entry.historyScope && (snapshot.generation !== entry.boundGeneration || snapshot.nativeSession !== null && snapshot.nativeSession !== entry.historyScope.origin.nativeSession);
    entry.changed();
    this.#reconcileReceipts(entry);
  }
  /** A lost/nonfinal reply and a newer native snapshot are observation pulses,
   * not permission to replay. One existing bounded read job checks retained
   * originals sequentially. A newer authoritative pulse during held IO keeps
   * this same job alive; unchanged facts never cause another sweep. Its local
   * watermark survives until the read slot is released, including a new inert
   * original arriving as the preceding sweep finishes. */
  #reconcileReceipts(entry: RetainedSession): void {
    const current = () => !this.#closed && this.#connected && entry.connected && !entry.stale;
    const pending = (item: Stored) => item.value.transmission !== 'pending' && !finalReceipt(item.value.receipt);
    if (!current() || ![...entry.operations.values()].some(pending)) return;
    let observed: SessionSnapshot | null | undefined;
    const attempted = new Set<Stored>();
    void this.#read(entry, `receipts:${scopeKey(entry.scope)}`, async () => {
      while (current() && [...entry.operations.values()].some(pending)) {
        observed = entry.native;
        for (const item of entry.operations.values()) {
          if (!current()) return;
          if (pending(item)) {
            attempted.add(item);
            try { await this.checkReceipt(entry.scope, item.value.original.id); } catch { /* Preserve genuine unknown/denied outcomes. */ }
          }
        }
        if (entry.native === observed) return;
      }
    }).finally(() => {
      // #read has released its slot now. Coalesced callers never ran this
      // action, so only the job owner can carry a new pulse over the handoff.
      if (observed !== undefined && current() && (entry.native !== observed || [...entry.operations.values()].some(item => pending(item) && !attempted.has(item)))) this.#reconcileReceipts(entry);
    }).catch(() => {});
  }
  async #read<T>(entry: RetainedSession, key: string, action: () => Promise<T>): Promise<T> {
    const prior = this.#reads.get(key); if (prior) return prior as Promise<T>;
    if (this.#reads.size >= this.#maxSessions + this.#maxOperations) throw new SessionError("BUSY", "Actual observation jobs occupy read capacity");
    const pending = Promise.resolve().then(action); this.#reads.set(key, pending); entry.jobs.add(pending); entry.changed();
    try { return await pending; } finally { this.#reads.delete(key); entry.jobs.delete(pending); entry.changed(); }
  }
  async refresh(scope: SessionScope): Promise<void> {
    scope = copy(scope); const entry = this.#entry(scope);
    try { const snapshot = await this.#read(entry, `snapshot:${scopeKey(scope)}`, () => this.#port.snapshot(scope)); this.#apply(entry, snapshot); }
    catch (error) { entry.unavailable = true; entry.stale = true; entry.changed(); throw error; }
  }
  setDraft(scope: SessionScope, value: Selection | null): void {
    const entry = this.#entry(scope); const saved = value === null ? null : copy(value);
    if (saved) { checkSelection(saved); if (saved.kind !== entry.kind) throw new SessionError("FENCED"); }
    entry.draft = saved; entry.changed();
  }
  select(scope: SessionScope, viewKey = "main"): ViewLease { const entry = this.#bound(this.#entry(scope)); return this.#history.select(entry.historyScope, viewKey); }
  setPinned(scope: SessionScope, pinned: boolean): void { const entry = this.#bound(this.#entry(scope)); entry.history.setPinned(pinned); entry.changed(); }
  setConnected(connected: boolean): void {
    this.#open(); this.#connected = connected; this.#history.setConnected(connected); this.#files?.setConnected(connected);
    for (const entry of this.#entries.values()) {
      entry.connected = connected; entry.stale = true; for (const [type, observation] of entry.nativeReads) entry.nativeReads.set(type, Object.freeze({ ...observation, stale: true })); entry.changed();

    }
  }
  /** Observation freshness belongs to this feed, not another domain's link. */
  markStale(scope: SessionScope): void { const entry = this.#entry(scope); entry.stale = true; entry.unavailable = true; for (const [type, observation] of entry.nativeReads) entry.nativeReads.set(type, Object.freeze({ ...observation, stale: true })); entry.changed(); }
  /** Read retained facts after admitted subscription; never resend an original. */
  reobserve(scope: SessionScope): Promise<void> {
    scope = copy(scope); const entry = this.#entry(scope); if (entry.reobservation) return entry.reobservation;
    const work = Promise.resolve().then(async () => {
      await this.refresh(scope);
      for (const item of entry.operations.values()) if (!finalReceipt(item.value.receipt)) await this.checkReceipt(scope, item.value.original.id);
    });
    entry.reobservation = work; void work.finally(() => { if (entry.reobservation === work) entry.reobservation = null; }).catch(() => {}); return work;
  }
  #protected(item: Stored): boolean {
    if (!item.owner || !this.#protectOriginal) return false;
    try { return this.#protectOriginal(copy({ ...item.value.original, owner: item.owner })); }
    catch { return true; } // A failed local protection read cannot release an original.
  }
  #occupied(entry: RetainedSession): number {
    return [...entry.operations.values()].filter(item => !finalReceipt(item.value.receipt) || item.value.transmission === 'pending' || this.#protected(item)).length;
  }
  /** Activity is recent display data. Unresolved or composer-protected originals
   * remain owned; evicting a settled row never replays its inert handle. */
  #prune(entry: RetainedSession): void {
    const recent: Stored[] = [];
    for (const item of entry.operations.values()) {
      if (!finalReceipt(item.value.receipt) || item.value.transmission === 'pending') continue;
      if (this.#protected(item)) continue;
      recent.push(item);
    }
    for (const item of recent.slice(0, Math.max(0, recent.length - 32))) entry.operations.delete(item.value.original.id);
  }
  #observeReceipt(entry: RetainedSession, stored: Stored, raw: Receipt): Receipt {
    if (stored.owner !== undefined && this.#owner(entry.scope) !== stored.owner) throw new SessionError("FENCED", "Original receipt owner changed");
    const receipt = copy(raw); canonical(receipt); checkScope(receipt.scope); checkId(receipt.id);
    const original = stored.value.original;
    if (scopeKey(receipt.scope) !== scopeKey(entry.scope) || receipt.id !== original.id || receipt.type !== original.type || receipt.generation !== original.generation) throw new SessionError("FENCED");
    check(["admitted", "dispatched", "acknowledged", "refused", "outcomeUnknown"].includes(receipt.state));
    if (receipt.outcome) check(["accepted", "applied", "deferred", "refused", "targetUnavailable", "confirmationRequired", "acknowledged"].includes(receipt.outcome.status));
    const previous = stored.value.receipt;
    if (previous && finalReceipt(previous)) { if (canonical(previous) !== canonical(receipt)) return previous; return previous; }
    const rank = { admitted: 0, dispatched: 1, outcomeUnknown: 2, acknowledged: 3, refused: 3 };
    if (previous && rank[receipt.state] < rank[previous.state]) return previous;
    stored.value = Object.freeze({ ...stored.value, receipt });
    // A newly settled old original is recent Activity, including settlement by
    // an exact receipt read after a lost reply.
    if (finalReceipt(receipt) && entry.operations.get(receipt.id) === stored) { entry.operations.delete(receipt.id); entry.operations.set(receipt.id, stored); }
    stored.history?.observeOperation(receipt.id, { state: receipt.state, type: receipt.type }, finalReceipt(receipt)); this.#prune(entry); entry.changed(); return receipt;
  }
  async checkReceipt(scope: SessionScope, id: string): Promise<Receipt | null> {
    scope = copy(scope); checkId(id); const entry = this.#entry(scope), stored = entry.operations.get(id); if (!stored) throw new SessionError("FENCED", "Original operation is not retained");
    this.#admit?.(scope, 'read');
    if (stored.owner !== undefined && this.#owner(entry.scope) !== stored.owner) throw new SessionError("FENCED", "Original receipt owner changed");
    const receipt = await this.#read(entry, `receipt:${scopeKey(scope)}:${id}`, () => this.#port.receipt(scope, id));
    this.#open(); this.#admit?.(scope, 'read');
    return receipt ? this.#observeReceipt(entry, stored, receipt) : stored.value.receipt;
  }
  /** Exact read-only lookup also works after Activity eviction. The reference
   * grants no Submit handle, and cannot move to another durable receipt owner. */
  async checkOriginal(reference: OriginalReceiptReference): Promise<Receipt | null> {
    const fixed = copy(reference); checkScope(fixed.scope); checkId(fixed.id); checkOriginalType(fixed.type);
    check(Object.keys(fixed).sort().join(',') === 'generation,id,owner,scope,type');
    check(Number.isSafeInteger(fixed.generation) && fixed.generation >= 0);
    const entry = this.#entry(fixed.scope);
    this.#admit?.(entry.scope, 'read');
    if (fixed.owner !== this.#owner(entry.scope)) throw new SessionError('FENCED');
    const receipt = await this.#read(entry, `receipt:${scopeKey(entry.scope)}:${fixed.id}`, () => this.#port.receipt(entry.scope, fixed.id));
    this.#open(); this.#admit?.(entry.scope, 'read');
    if (fixed.owner !== this.#owner(entry.scope)) throw new SessionError('FENCED');
    if (!receipt) return null;
    const observed = copy(receipt); canonical(observed);
    if (scopeKey(observed.scope) !== scopeKey(fixed.scope) || observed.id !== fixed.id || observed.type !== fixed.type || observed.generation !== fixed.generation) throw new SessionError('FENCED');
    const stored = entry.operations.get(fixed.id);
    if (stored) return this.#observeReceipt(entry, stored, observed);
    return observed;
  }
  #owner(scope: SessionScope): string {
    if (!this.#receiptOwner) throw new SessionError("UNSUPPORTED", "Durable receipt ownership is not configured");
    const owner = this.#receiptOwner(scope);
    check(typeof owner === "string" && owner.length > 0 && owner.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(owner)); return owner;
  }
  /** Mint before local durable protection. This does not admit or submit an effect. */
  receiptReference<T extends SessionCommand["type"]>(scope: SessionScope, id: string, type: T): OriginalReceiptReference & Readonly<{ type: T }> {
    const entry = this.#entry(scope); checkId(id); checkOriginalType(type);
    this.#admit?.(entry.scope, 'control');
    if (!entry.native) throw new SessionError("FENCED");
    return copy({ scope: entry.scope, owner: this.#owner(entry.scope), id, type, generation: entry.native.generation });
  }
  originalReferences(scope: SessionScope): readonly OriginalReceiptReference[] {
    const entry = this.#entry(scope), owner = this.#owner(entry.scope);
    return Object.freeze([...entry.operations.values()].map(item => {
      if (item.owner !== owner) throw new SessionError("FENCED", "Original receipt owner changed");
      return copy({ ...item.value.original, owner });
    }));
  }
  /** Batch validation is atomic; restored originals have no request or Submit handle. */
  restoreOriginals(scope: SessionScope, references: readonly OriginalReceiptReference[]): void {
    const entry = this.#entry(scope), owner = this.#owner(entry.scope);
    check(Array.isArray(references) && references.length <= this.#maxOperations + 1); canonical(references, (this.#maxOperations + 1) * 8192);
    const fixed = copy(references), seen = new Set<string>();
    for (const reference of fixed) {
      check(reference !== null && typeof reference === "object");
      check(Object.keys(reference).sort().join(",") === "generation,id,owner,scope,type");
      checkScope(reference.scope); checkId(reference.id); checkOriginalType(reference.type);
      check(Object.keys(reference.scope).sort().join(",") === "connection,host,principal,session");
      check(Number.isSafeInteger(reference.generation) && reference.generation >= 0);
      if (scopeKey(reference.scope) !== scopeKey(entry.scope) || reference.owner !== owner) throw new SessionError("FENCED");
      if (seen.has(reference.id)) throw new SessionError("CONFLICT"); seen.add(reference.id);
      const stored = entry.operations.get(reference.id), previous = stored?.value.original;
      if (stored && stored.owner !== owner) throw new SessionError("FENCED");
      if (previous && canonical(previous) !== canonical({ scope: reference.scope, id: reference.id, type: reference.type, generation: reference.generation })) throw new SessionError("CONFLICT");
    }
    const incoming = fixed.filter(reference => !entry.operations.has(reference.id));
    this.#prune(entry);
    if (this.#occupied(entry) + incoming.length > this.#maxOperations + Number(incoming.some(item => item.type === "stop"))) throw new SessionError("FULL", "Retained originals are full; nothing was evicted");
    entry.history?.recordOperations(incoming.map(reference => ({ id: reference.id, intent: { kind: "session-operation", type: reference.type, generation: reference.generation }, reserve: reference.type === "stop" })));
    for (const reference of incoming) {
      const original: OriginalIdentity = copy({ scope: reference.scope, id: reference.id, type: reference.type, generation: reference.generation });
      entry.operations.set(reference.id, { value: Object.freeze({ original, request: null, receipt: null, transmission: "unavailable" }), handle: null, history: entry.history, owner });
    }
    if (incoming.length) { entry.changed(); this.#reconcileReceipts(entry); }
  }
  request(scope: SessionScope, command: SessionCommand, id: string = crypto.randomUUID(), expectedGeneration?: number): OperationHandle {
    scope = copy(scope); command = copy(command); checkId(id); canonical(command); const entry = this.#entry(scope), snapshot = entry.native;
    this.#admit?.(entry.scope, 'control');
    if (!snapshot) throw new SessionError("FENCED", "No observed native target");
    if (expectedGeneration !== undefined && snapshot.generation !== expectedGeneration) throw new SessionError("FENCED", "Prepared original belongs to a retired run");
    if (!entry.history && command.type !== "stop" && command.type !== "archive") throw new SessionError("FENCED", "Only retirement is available before native history binding");
    if ("selection" in command && command.selection) { checkSelection(command.selection); if (command.selection.kind !== snapshot.kind) throw new SessionError("FENCED"); }
    if (isMessageCommand(command) && command.inputs && command.inputs.kind !== snapshot.kind) throw new SessionError("FENCED");
    if (command.type.startsWith("codex.") && snapshot.kind !== "codex" || command.type.startsWith("copilot.") && snapshot.kind !== "copilot") throw new SessionError("FENCED");
    if (entry.requiresRebind && command.type !== "stop" && command.type !== "archive") throw new SessionError("FENCED", "Explicit history rebind is required");
    if (!["create", "resume", "stop", "archive"].includes(command.type) && !snapshot.capabilities.commands.includes(command.type as typeof snapshot.capabilities.commands[number])) throw new SessionError("UNSUPPORTED");
    const request = copy({ scope, id, generation: snapshot.generation, command });
    const existing = entry.operations.get(id), owner = this.#receiptOwner ? this.#owner(scope) : undefined;
    if (existing && existing.owner !== owner) throw new SessionError("FENCED", "Original receipt owner changed");
    if (existing) { if (!existing.handle || !existing.value.request || canonical(existing.value.request) !== canonical(request)) throw new SessionError("CONFLICT", "A restored receipt reference cannot submit a command"); return existing.handle; }
    if (snapshot.archive) throw new SessionError("FENCED", "Session archive admissions are sealed");
    this.#prune(entry);
    if (this.#occupied(entry) >= this.#maxOperations + Number(command.type === "stop")) throw new SessionError("FULL", "Unresolved operations occupy admission capacity");
    for (const [type, observation] of entry.nativeReads) entry.nativeReads.set(type, Object.freeze({ ...observation, stale: true }));
    // Only a safe identity marker enters the shared history owner; answers remain local memory.
    entry.history?.recordOperation(id, { kind: "session-operation", type: command.type, generation: request.generation }, command.type === "stop");
    const result = Promise.resolve().then(() => this.#port.submit(request)).then(receipt => {
      const stored = entry.operations.get(id)!; const observed = this.#observeReceipt(entry, stored, receipt);
      stored.value = Object.freeze({ ...stored.value, transmission: "returned" }); this.#prune(entry); entry.changed(); this.#reconcileReceipts(entry); return observed;
    }, error => {
      const stored = entry.operations.get(id)!; stored.value = Object.freeze({ ...stored.value, transmission: "unavailable" }); entry.changed(); this.#reconcileReceipts(entry); throw error;
    });
    const handle = Object.freeze({ id, request, result });
    const original: OriginalIdentity = copy({ scope, id, type: command.type, generation: request.generation });
    entry.operations.set(id, { value: Object.freeze({ original, request, receipt: null, transmission: "pending" }), handle, history: entry.history, owner }); entry.jobs.add(result); entry.changed();
    void result.finally(() => { entry.jobs.delete(result); entry.changed(); }).catch(() => {}); return handle;
  }
  agent(scope: SessionScope): SessionAgent {
    scope = copy(scope); const entry = this.#bound(this.#entry(scope)), state = entry.getSnapshot(), snapshot = entry.native;
    if (!snapshot) return Object.freeze({ kind: "unsupported", state });
    const generation = snapshot.generation;
    const act = (command: SessionCommand): OperationHandle => { if (entry.native?.generation !== generation) throw new SessionError("FENCED", "Action belongs to a retired run"); return this.request(scope, command); };
    const has = (type: typeof snapshot.capabilities.commands[number]): boolean => snapshot.capabilities.commands.includes(type);
    const common = {
      setSelectionDraft: (selection: Selection | null) => this.setDraft(scope, selection),
      create: (selection?: Selection) => act({ type: "create", ...(selection ? { selection } : {}) }), resume: () => act({ type: "resume" }), stop: () => act({ type: "stop" }), archive: () => act({ type: "archive" }),
      ...(has("send") ? { send: (text: string, selection?: Selection, inputs?: SendInputsFor<"codex" | "copilot">) => {
        if (selection && selection.kind !== snapshot.kind || inputs && inputs.kind !== snapshot.kind) throw new SessionError("FENCED");
        return act({ type: "send", text, ...(selection ? { selection } : {}), ...(inputs ? { inputs } : {}) } as SendCommandFor<"codex" | "copilot">);
      } } : {}),
      ...(has("answer") ? { answer: (interactionId: string, choice: string, value?: Json) => act({ type: "answer", interactionId, choice, ...(value === undefined ? {} : { value }) }) } : {}),
      ...(this.#port.mcpLoginLink ? { mcpLoginLink: async (originalId: string): Promise<McpLoginLink> => {
        checkId(originalId);
        const current = (): RunRef => {
          this.#open(); this.#admit?.(scope, 'read'); this.#admit?.(scope, 'control');
          const value = entry.native;
          if (!value?.nativeSession || value.epoch !== snapshot.epoch || value.generation !== generation || value.nativeSession !== snapshot.nativeSession || value.phase !== 'running' || value.stopRequested || value.issue || !entry.connected || entry.stale || entry.requiresRebind) throw new SessionError('FENCED');
          return { scope, nativeSession: value.nativeSession, generation };
        };
        const run = current(), result = await this.#port.mcpLoginLink!(run, originalId); current(); return copy(result);
      } } : {}),
    };
    const read = (input: NativeReadFor<"codex" | "copilot">): Promise<NativeReadResult> => {
      this.#admit?.(scope, 'read');
      const request = validateNativeRead(snapshot.kind, input);
      if (entry.native?.generation !== generation || !snapshot.nativeSession || !this.#port.read || !entry.connected || entry.stale || entry.requiresRebind || entry.native.phase !== "running") return Promise.reject(new SessionError("FENCED"));
      const run = { scope, generation, nativeSession: snapshot.nativeSession }, key = `native:${scopeKey(scope)}:${request.type}`, previous = entry.nativeReads.get(request.type);
      if (previous?.state === "loading") {
        if (canonical(previous.request) !== canonical(request) || !sameRun(previous.run, run)) return Promise.reject(new SessionError("BUSY"));
        return this.#reads.get(key) as Promise<NativeReadResult>;
      }
      const revision = entry.native.revision, epoch = entry.native.epoch, observation: NativeReadObservation = Object.freeze({ run, request, state: "loading", stale: true, value: previous && sameRun(previous.run, run) ? previous.value : null });
      entry.nativeReads.set(request.type, observation); entry.changed();
      const work = this.#read(entry, key, async () => {
        const result = validateNativeReadResult(run, request, await this.#port.read!(run, request));
        if (this.#closed || entry.native?.generation !== generation || entry.native.nativeSession !== run.nativeSession || entry.native.phase !== "running") throw new SessionError("FENCED");
        entry.nativeReads.set(request.type, Object.freeze({ run, request, state: "available", stale: !entry.connected || entry.stale || entry.native.epoch !== epoch || entry.native.revision !== revision, value: result })); entry.changed(); return result;
      });
      void work.catch(() => {
        if (!this.#closed && entry.nativeReads.get(request.type)?.run.generation === generation) { entry.nativeReads.set(request.type, Object.freeze({ ...observation, state: "unavailable", stale: true })); entry.changed(); }
      });
      return work;
    };
    if (snapshot.kind === "codex") return Object.freeze({ kind: "codex", state, actions: Object.freeze({ ...common,
      ...(has("codex.continue") ? { continue: () => act({ type: "codex.continue" }) } : {}),
      ...(has("codex.defaults") ? { setDefaults: (selection: CodexSelection) => act({ type: "codex.defaults", selection }) } : {}),
      ...(has("codex.turn") ? { updateTurn: (turnId: string, selection: CodexSelection) => act({ type: "codex.turn", turnId, selection }) } : {}),
      ...(has("codex.queue.add") ? { enqueue: (text: string, inputs?: SendInputsFor<"codex">) => act({ type: "codex.queue.add", text, ...(inputs ? { inputs } : {}) }) } : {}),
      ...(has("codex.steer") ? { steer: (expectedTurnId: string, text: string, inputs?: SendInputsFor<"codex">) => act({ type: "codex.steer", expectedTurnId, text, ...(inputs ? { inputs } : {}) }) } : {}),
      ...(has("codex.compact") ? { compact: () => act({ type: "codex.compact" }) } : {}),
      ...(has("codex.goal.set") ? { setGoal: (patch: Readonly<{ objective?: string; status?: GoalStatus; tokenBudget?: number | null }>) => act({ type: "codex.goal.set", ...patch }) } : {}),
      ...(has("codex.goal.clear") ? { clearGoal: () => act({ type: "codex.goal.clear" }) } : {}),
      ...(has("codex.terminal.terminate") ? { terminateTerminal: (processId: string) => act({ type: "codex.terminal.terminate", processId }) } : {}),
      ...(has("codex.terminals.clean") ? { cleanTerminals: () => act({ type: "codex.terminals.clean" }) } : {}),
      ...(has("codex.mcp.reload") ? { reloadMcp: () => act({ type: "codex.mcp.reload" }) } : {}),
      ...(has("codex.mcp.login") ? { loginMcp: (serverName: string) => act({ type: "codex.mcp.login", serverName }) } : {}),
      ...(snapshot.capabilities.reads?.length && this.#port.read ? { read } : {}),
      ...(has("codex.interrupt") ? { interrupt: (turnId: string) => act({ type: "codex.interrupt", turnId }) } : {}),
    }) });
    return Object.freeze({ kind: "copilot", state, actions: Object.freeze({ ...common,
      ...(has("copilot.continue") ? { continue: () => act({ type: "copilot.continue" }) } : {}),
      ...(has("copilot.model") ? { setModel: (model: string, options?: Readonly<{ providerId?: string; effort?: string | null }>) => act({ type: "copilot.model", model, ...options }) } : {}),
      ...(has("copilot.mode") ? { setMode: (mode: "interactive" | "plan" | "autopilot") => act({ type: "copilot.mode", mode }) } : {}),
      ...(has("copilot.permissions") ? { setPermissions: (mode: "manual" | "allow-all") => act({ type: "copilot.permissions", mode }) } : {}),
      ...(has("copilot.steer") ? { steer: (text: string, inputs?: SendInputsFor<"copilot">) => act({ type: "copilot.steer", text, ...(inputs ? { inputs } : {}) }) } : {}),
      ...(has("copilot.queue.promote") ? { promoteQueued: (id: string) => act({ type: "copilot.queue.promote", id }) } : {}),
      ...(has("copilot.compact") ? { compact: () => act({ type: "copilot.compact" }) } : {}),
      ...(has("copilot.task.cancel") ? { cancelTask: (id: string) => act({ type: "copilot.task.cancel", id }) } : {}),
      ...(has("copilot.task.promote") ? { promoteTask: (id: string) => act({ type: "copilot.task.promote", id }) } : {}),
      ...(has("copilot.mcp.reconnect") ? { reconnectMcp: (serverName: string) => act({ type: "copilot.mcp.reconnect", serverName }) } : {}),
      ...(has("copilot.mcp.login") ? { loginMcp: (serverName: string, forceReauth?: boolean) => act({ type: "copilot.mcp.login", serverName, ...(forceReauth === undefined ? {} : { forceReauth }) }) } : {}),
      ...(snapshot.capabilities.reads?.length && this.#port.read ? { read } : {}),
      ...(has("copilot.abort") ? { abort: () => act({ type: "copilot.abort" }) } : {}),
    }) });
  }
  /** Retire browser observations only; no native stop, file disposal or operation replay. */
  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      // Invalidate every consumer before any renderer or external release runs.
      for (const entry of this.#entries.values()) entry.retireObservation();
      for (const entry of this.#entries.values()) entry.changed();
    }
    const errors: unknown[] = [];
    for (const entry of this.#entries.values()) {
      const release = entry.unsubscribe; if (!release) continue;
      entry.unsubscribe = null;
      try { release(); }
      catch (error) { entry.unsubscribe = release; errors.push(error); }
    }
    // Explicit close may retry only exact handles whose cleanup failed.
    if (errors.length) throw new AggregateError(errors, "Session observations failed to retire");
  }
}
