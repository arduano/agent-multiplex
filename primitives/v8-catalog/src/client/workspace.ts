import { SessionWorkspace, type SessionEntry } from "../../../v8-session/src/client/workspace.js";
import type { Scope as HistoryScope } from "../../../v8-history/src/contracts/types.js";
import type { Json, SessionScope } from "../../../v8-session/src/contracts/types.js";
import { CatalogError, catalogKey, logicalKey, sessionScope, type ArchivePublication, type CatalogEntry, type CatalogPort, type CatalogScope, type CreateRequest, type Creation, type RenameRequest, type WatchRequest, type MetadataRequest, type MetadataOriginal } from "../contracts/types.js";
import { archive as validateArchive, canonical, check, copy, create as validateCreate, metadata as validateMetadata, id, scope as validateScope, target as validateTarget, binding as validateBinding, name as validateName } from "../contracts/validation.js";
export type MetadataAction = Readonly<{ request: MetadataRequest; state: "pending" | "unconfirmed" | "committed" | "conflict"; result?: CatalogEntry }>;
export type LogicalView = Readonly<{ entry: CatalogEntry | null; original: CreateRequest | null; creation: Creation | null; metadataAction: MetadataAction | null; connected: boolean; stale: boolean; draft: Json; pinned: boolean; bound: boolean; transmission: "idle" | "pending" | "returned" | "unavailable" }>;
class LogicalSession {
  readonly listeners = new Set<() => void>(); entry: CatalogEntry | null = null; original: CreateRequest | null = null; creation: Creation | null = null; connected = true; stale = true; draft: Json = ""; pinned = false; bound: SessionEntry | null = null; transmission: LogicalView["transmission"] = "idle"; job: Promise<Creation> | null = null; readJob: Promise<Creation | null> | null = null; unsubscribe: () => void = () => {};
  #snapshot: LogicalView;
  metadataAction: MetadataAction | null = null; metadataJob: Promise<CatalogEntry> | null = null; metadataRead: Promise<MetadataOriginal | null> | null = null;
  constructor(readonly session: string) { this.#snapshot = this.#view(); }
  #view(): LogicalView { return Object.freeze({ entry: this.entry, original: this.original, creation: this.creation, metadataAction: this.metadataAction, connected: this.connected, stale: this.stale, draft: this.bound?.history.draft ?? this.draft, pinned: this.bound?.history.pinned ?? this.pinned, bound: this.bound !== null, transmission: this.transmission }); }
  getSnapshot = (): LogicalView => { if (this.bound && (this.#snapshot.draft !== this.bound.history.draft || this.#snapshot.pinned !== this.bound.history.pinned)) this.#snapshot = this.#view(); return this.#snapshot; };
  subscribe = (listener: () => void): (() => void) => { if (!this.listeners.has(listener) && this.listeners.size >= 128) throw new CatalogError("FULL"); this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  changed(): void { this.#snapshot = this.#view(); for (const fn of [...this.listeners]) { try { fn(); } catch { /* renderer isolation */ } } }
}
export type LogicalEntry = Pick<LogicalSession, "getSnapshot" | "subscribe">;
/** Retained provisional identity lives outside React and never creates a fake history origin. */
export class CatalogWorkspace {
  readonly #catalogListeners = new Set<() => void>();
  readonly #scope: CatalogScope; readonly #port: CatalogPort; readonly #sessions: SessionWorkspace; readonly #entries = new Map<string, LogicalSession>(); readonly #catalog = new Map<string, CatalogEntry>(); readonly #unsubscribe: () => void; readonly #maxSessions: number; #closed = false; #connected = true; #refresh: Promise<void> | null = null; #nextRefresh: Promise<void> | null = null;
  constructor(options: Readonly<{ scope: CatalogScope; port: CatalogPort; sessions: SessionWorkspace; maxSessions?: number }>) {
    validateScope(options.scope); this.#scope = copy(options.scope); this.#port = options.port; this.#sessions = options.sessions; this.#maxSessions = options.maxSessions ?? 16; check(Number.isSafeInteger(this.#maxSessions) && this.#maxSessions > 0 && this.#maxSessions <= 512);
    this.#unsubscribe = this.#port.subscribe(this.#scope, entry => { try { this.#applyEntry(entry); } catch { /* reject cross-scope/stale publications */ } });
  }
  #open(): void { if (this.#closed) throw new CatalogError("CLOSED"); }
  #retain(session: string): LogicalSession { this.#open(); id(session); const key = logicalKey(this.#scope, session), prior = this.#entries.get(key); if (prior) return prior; if (this.#entries.size >= this.#maxSessions) throw new CatalogError("FULL"); const entry = new LogicalSession(session); entry.connected = this.#connected; entry.entry = this.#catalog.get(session) ?? null; entry.changed(); this.#entries.set(key, entry); return entry; }
  entry(session: string): LogicalEntry { return this.#retain(session); }
  metadataStatus(session: string): MetadataAction | null { this.#open(); id(session); return this.#entries.get(logicalKey(this.#scope, session))?.metadataAction ?? null; }
  subscribeMetadata(session: string, listener: () => void): () => void { return this.#retain(session).subscribe(listener); }
  /** Exact namespace is knowable even before the first catalog row arrives. */
  getScope(): CatalogScope { this.#open(); return copy(this.#scope); }
  catalog(): readonly CatalogEntry[] { this.#open(); return Object.freeze([...this.#catalog.values()]); }
  /** Observation of the existing committed projection, including pin changes.
   * No list read, native binding or effect is performed by subscribing. */
  subscribeCatalog(listener: () => void): () => void {
    this.#open(); if (this.#catalogListeners.size >= 128 && !this.#catalogListeners.has(listener)) throw new CatalogError("FULL");
    this.#catalogListeners.add(listener); return () => { this.#catalogListeners.delete(listener); };
  }
  #catalogChanged(): void { for (const listener of [...this.#catalogListeners]) try { listener(); } catch { /* Renderer isolation. */ } }
  #applyEntry(raw: CatalogEntry): void {
    canonical(raw); validateScope(raw.scope); if (catalogKey(raw.scope) !== catalogKey(this.#scope)) throw new CatalogError("FENCED");
    id(raw.session); id(raw.createId); validateTarget(raw.target); validateName(raw.metadata.name); check(raw.metadata.cwd === null || typeof raw.metadata.cwd === "string" && raw.metadata.cwd.length <= 4096); check(raw.metadata.watched === undefined || typeof raw.metadata.watched === "boolean"); if (raw.binding) validateBinding(raw.binding, raw.target); const entry = this.#entries.get(logicalKey(this.#scope, raw.session)), next = copy(raw), prior = this.#catalog.get(raw.session);
    check(Number.isSafeInteger(next.version) && next.version > 0 && Number.isSafeInteger(next.revision) && next.revision > 0);
    if (next.archive) { id(next.archive.id); check(Number.isSafeInteger(next.archive.generation) && next.archive.generation >= 0 && Object.keys(next.archive).length === 2); }
    if (prior) {
      if (canonical(prior.target) !== canonical(next.target) || prior.createId !== next.createId) throw new CatalogError("FENCED");
      if (next.version < prior.version) return;
      if (next.version === prior.version && canonical(next) !== canonical(prior)) throw new CatalogError("CONFLICT");
      if (prior.binding && canonical(prior.binding) !== canonical(next.binding)) throw new CatalogError("FENCED");
      if (prior.archive && canonical(prior.archive) !== canonical(next.archive ?? null)) throw new CatalogError("FENCED");
    }
    if (!this.#catalog.has(next.session) && this.#catalog.size >= 512) throw new CatalogError("FULL"); this.#catalog.set(next.session, next); if (entry) { entry.entry = next; entry.stale = !this.#connected; entry.changed(); } this.#catalogChanged();
  }
  #applyCreation(entry: LogicalSession, raw: Creation): Creation {
    const original = validateCreate(raw.original); if (!entry.original || canonical(original) !== canonical(entry.original)) throw new CatalogError("FENCED");
    check(["reserved", "dispatching", "nativeCreated", "refused", "outcomeUnknown"].includes(raw.state) && ["committed", "pending"].includes(raw.publication));
    if (raw.entry.session !== original.session || raw.entry.createId !== original.id || canonical(raw.entry.target) !== canonical(original.target) || raw.entry.metadata.cwd !== original.metadata.cwd) throw new CatalogError("FENCED"); this.#applyEntry(raw.entry);
    if (raw.native) validateBinding(raw.native, original.target); check(raw.state !== "nativeCreated" || raw.native !== null); check(raw.publication !== "committed" || canonical(raw.native) === canonical(raw.entry.binding));
    const prior = entry.creation;
    if (prior?.state === "nativeCreated" && raw.state !== "nativeCreated") return prior;
    if (prior?.state === "refused" && raw.state !== "refused") return prior;
    if (prior?.native && canonical(prior.native) !== canonical(raw.native)) throw new CatalogError("FENCED");
    entry.creation = copy(raw); entry.stale = !this.#connected; entry.changed(); return entry.creation;
  }
  create(request: CreateRequest): Promise<Creation> {
    this.#open(); const original = validateCreate(request); if (catalogKey(original.scope) !== catalogKey(this.#scope)) throw new CatalogError("FENCED"); const entry = this.#retain(original.session);
    if (entry.original) { if (canonical(entry.original) !== canonical(original)) throw new CatalogError("CONFLICT"); return entry.job ?? this.check(original.session).then(value => { if (!value) throw new CatalogError("FENCED"); return value; }); }
    entry.original = original; entry.transmission = "pending"; entry.changed();
    const job = Promise.resolve().then(() => this.#port.create(original)).then(value => { const result = this.#applyCreation(entry, value); entry.transmission = "returned"; entry.changed(); return result; }, error => { entry.transmission = "unavailable"; entry.stale = true; entry.changed(); throw error; });
    entry.job = job; void job.finally(() => { if (entry.job === job) entry.job = null; }).catch(() => {}); return job;
  }
  async check(session: string): Promise<Creation | null> { const entry = this.#retain(session); if (!entry.original) throw new CatalogError("FENCED"); if (entry.readJob) return entry.readJob; const work = this.#port.creation(this.#scope, entry.original.id).then(raw => raw ? this.#applyCreation(entry, raw) : entry.creation); entry.readJob = work; try { return await work; } finally { if (entry.readJob === work) entry.readJob = null; } }
  /** One explicit CAS write through the existing catalog owner. Neither a
   * failed response nor reconnect retries it. Observation remains independent. */
  rename(request: RenameRequest): Promise<CatalogEntry> { return this.#metadata(request); }
  setWatched(request: WatchRequest): Promise<CatalogEntry> { return this.#metadata(request); }
  #acceptMetadata(entry: LogicalSession, request: MetadataRequest, result: CatalogEntry): CatalogEntry {
    this.#open();
    if (result.session !== request.session || result.revision !== request.revision + 1 || ("watched" in request ? result.metadata.watched !== request.watched : result.metadata.name !== request.name)) throw new CatalogError("FENCED");
    this.#applyEntry(result);
    if (entry.metadataAction?.request.id === request.id) { entry.metadataAction = copy({ request, state: "committed", result }); entry.changed(); }
    return copy(result);
  }
  #metadata(value: MetadataRequest): Promise<CatalogEntry> {
    this.#open(); const request = validateMetadata(value);
    if (catalogKey(request.scope) !== catalogKey(this.#scope) || !this.#catalog.has(request.session)) throw new CatalogError("FENCED");
    const entry = this.#retain(request.session), prior = entry.metadataAction;
    if (prior?.request.id === request.id) {
      if (canonical(prior.request) !== canonical(request)) throw new CatalogError("CONFLICT");
      if (entry.metadataJob) return entry.metadataJob;
      if (prior.result) return Promise.resolve(prior.result);
      if (prior.state === "conflict") throw new CatalogError("CONFLICT");
      return this.checkMetadata(request.session).then(original => { if (!original) throw new CatalogError("BUSY"); return original.entry; });
    }
    if (entry.metadataJob || prior?.state === "unconfirmed") throw new CatalogError("BUSY");
    entry.metadataAction = copy({ request, state: "pending" }); entry.changed();
    const work = Promise.resolve().then(() => "watched" in request ? this.#port.setWatched(request) : this.#port.rename(request))
      .then(result => this.#acceptMetadata(entry, request, result)).catch(error => {
        if (!this.#closed && entry.metadataAction?.request.id === request.id) {
          const conflict = error && typeof error === "object" && "code" in error && error.code === "CONFLICT";
          entry.metadataAction = copy({ request, state: conflict ? "conflict" : "unconfirmed" }); entry.changed();
        }
        throw error;
      });
    entry.metadataJob = work; void work.finally(() => { if (entry.metadataJob === work) entry.metadataJob = null; }).catch(() => {}); return work;
  }
  /** Exact committed proof only. Absence/current value cannot retire a lost
   * original; neither checking nor reconnect ever calls a mutation again. */
  async checkMetadata(session: string): Promise<MetadataOriginal | null> {
    const entry = this.#retain(session), action = entry.metadataAction;
    if (!action || entry.metadataJob) return null;
    if (action.result) return copy({ request: action.request, entry: action.result });
    if (action.state !== "unconfirmed") return null;
    if (entry.metadataRead) return entry.metadataRead;
    const work = this.#port.metadataOriginal(this.#scope, action.request.id).then(original => {
      this.#open(); if (!original) return null;
      if (canonical(validateMetadata(original.request)) !== canonical(action.request)) throw new CatalogError("FENCED");
      this.#acceptMetadata(entry, action.request, original.entry); return copy(original);
    });
    entry.metadataRead = work; try { return await work; } finally { if (entry.metadataRead === work) entry.metadataRead = null; }
  }
  async publishArchive(request: ArchivePublication): Promise<CatalogEntry> {
    this.#open(); const fixed = validateArchive(request);
    if (catalogKey(fixed.scope) !== catalogKey(this.#scope) || !this.#catalog.has(fixed.session) || !this.#port.publishArchive) throw new CatalogError("FENCED");
    const result = await this.#port.publishArchive(fixed); this.#open();
    if (result.session !== fixed.session || result.archive?.id !== fixed.id || result.archive.generation !== fixed.generation) throw new CatalogError("FENCED");
    this.#applyEntry(result); return copy(result);
  }
  refresh(): Promise<void> {
    this.#open(); if (this.#refresh) return this.#refresh;
    const work = Promise.resolve().then(async () => { const values = await this.#port.list(this.#scope); this.#open(); check(values.length <= 512); for (const value of values) this.#applyEntry(value); });
    this.#refresh = work; void work.finally(() => { if (this.#refresh === work) this.#refresh = null; }).catch(() => {}); return work;
  }
  /** Catalog watches carry changes, not a full baseline. An older list cannot
   * bridge this admission's gap: queue one fresh read behind actual held I/O. */
  #admittedRefresh(): Promise<void> {
    if (!this.#refresh) return this.refresh();
    if (this.#nextRefresh) return this.#nextRefresh;
    const work = this.#refresh.catch(() => {}).then(() => { this.#nextRefresh = null; return this.refresh(); });
    this.#nextRefresh = work; return work;
  }
  async reobserve(): Promise<void> {
    await this.#admittedRefresh();
    for (const entry of this.#entries.values()) if (entry.original && (!entry.creation || entry.creation.publication !== "committed" || !["nativeCreated", "refused"].includes(entry.creation.state))) await this.check(entry.session);
    for (const entry of this.#entries.values()) if (entry.metadataAction?.state === "unconfirmed") await this.checkMetadata(entry.session);
  }
  markStale(): void { this.#open(); for (const entry of this.#entries.values()) { entry.stale = true; entry.changed(); } }
  setDraft(session: string, draft: Json): void { canonical(draft); const entry = this.#retain(session); entry.draft = copy(draft); entry.bound?.history.setDraft(entry.draft); entry.changed(); }
  setPinned(session: string, pinned: boolean): void { check(typeof pinned === "boolean"); const entry = this.#retain(session); entry.pinned = pinned; entry.bound?.history.setPinned(pinned); entry.changed(); this.#catalogChanged(); }
  async bindNative(session: string, history: HistoryScope): Promise<SessionEntry> {
    const entry = this.#retain(session), binding = entry.creation?.native ?? entry.entry?.binding; if (!binding || !entry.entry) throw new CatalogError("FENCED", "No observed real native binding");
    const scope: SessionScope = sessionScope(entry.original ?? { scope: this.#scope, id: entry.entry.createId, session, target: entry.entry.target, metadata: entry.entry.metadata });
    if (history.kind !== binding.kind || history.origin.connection !== scope.connection || history.origin.principal !== scope.principal || history.origin.host !== scope.host || history.origin.nativeSession !== binding.nativeSession) throw new CatalogError("FENCED");
    if (entry.bound) { if (canonical(entry.bound.historyScope) !== canonical(history)) throw new CatalogError("CONFLICT", "Explicit native attachment change belongs to SessionWorkspace.rebind"); return entry.bound; }
    const bound = await this.#sessions.bind(scope, history); bound.history.setDraft(entry.draft); this.#sessions.setPinned(scope, entry.pinned); entry.bound = bound; entry.unsubscribe = bound.subscribe(() => entry.changed()); entry.changed(); return bound;
  }
  setConnected(connected: boolean): void { this.#open(); this.#connected = connected; for (const entry of this.#entries.values()) { entry.connected = connected; entry.stale = true; entry.changed(); } }
  close(): void { if (this.#closed) return; this.#closed = true; this.#unsubscribe(); for (const entry of this.#entries.values()) { entry.unsubscribe(); entry.connected = false; entry.stale = true; entry.changed(); } this.#catalogChanged(); this.#catalogListeners.clear(); }
}
