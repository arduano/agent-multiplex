import { conversationKey, sameScope } from "../contracts/identity.js";
import type { Json, Scope } from "../contracts/types.js";
import { canonical, deepFreeze } from "../contracts/validation.js";
import { CapacityError, HistoryClient, HistoryProtocolError, type ClientLimits, type HistoryView } from "./history-client.js";

export type StoredOperation = Readonly<{ id: string; intent: Json; observation: Json; settled: boolean }>;
export type ViewLease = Readonly<{ view: HistoryView; release: () => void }>;
export type WorkspaceOptions = Readonly<{
  connection: string;
  principal: string;
  maxSessions?: number;
  maxViewsPerSession?: number;
  maxOperationsPerSession?: number;
  client?: ClientLimits;
}>;
function bound(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be positive`);
  return value;
}

/** Retained session data outlives selection and subscriber leases, never native ownership. */
export class WorkspaceSession {
  readonly client: HistoryClient;
  readonly #operations = new Map<string, StoredOperation>();
  readonly #leases = new Set<symbol>();
  readonly #operationLimit: number;
  #draft: Json = "";
  #pinned = false;

  constructor(client: HistoryClient, operationLimit: number) { this.client = client; this.#operationLimit = operationLimit; }
  get draft(): Json { return this.#draft; }
  get pinned(): boolean { return this.#pinned; }
  get backgroundReferenceHeld(): boolean { return this.#pinned; }
  get observationReferences(): number { return this.#leases.size + Number(this.#pinned); }
  get mountedReferences(): number { return this.#leases.size; }
  get operations(): readonly StoredOperation[] { return Object.freeze([...this.#operations.values()]); }
  setDraft(value: Json): void { canonical(value); this.#draft = deepFreeze(structuredClone(value)); }
  /** Browser-local preference only. No native Stop and no catalog/peer-pin mutation. */
  setPinned(value: boolean): void { this.#pinned = value; }
  recordOperation(id: string, intent: Json, reserve = false): StoredOperation {
    return this.recordOperations([{ id, intent, reserve }])[0]!;
  }
  /** Import original markers atomically. Only positively settled originals may
   * bypass the unresolved budget; their recent display retention stays bounded. */
  recordOperations(values: readonly Readonly<{ id: string; intent: Json; reserve?: boolean; settled?: boolean }>[]): readonly StoredOperation[] {
    this.#prune();
    const pending = [...this.#operations.values()].filter(value => !value.settled).length;
    let admitted = 0;
    const added = new Map<string, StoredOperation>(), result: StoredOperation[] = [];
    for (const { id, intent, settled = false } of values) {
      if (!id || id.length > 256) throw new TypeError("Invalid original operation ID");
      const prior = added.get(id) ?? this.#operations.get(id);
      if (prior) {
        if (canonical(prior.intent) !== canonical(intent)) throw new HistoryProtocolError("Original operation meaning changed");
        result.push(prior); continue;
      }
      if (!settled && pending + admitted >= this.#operationLimit + Number(values.some(value => value.reserve === true))) throw new CapacityError("Retained operation capacity reached");
      canonical(intent);
      const operation = deepFreeze({ id, intent: structuredClone(intent), observation: null, settled });
      added.set(id, operation); if (!settled) admitted++; result.push(operation);
    }
    for (const [id, operation] of added) this.#operations.set(id, operation);
    this.#prune();
    return Object.freeze(result);
  }
  observeOperation(id: string, observation: Json, settled = false): StoredOperation {
    const prior = this.#operations.get(id);
    if (!prior) throw new HistoryProtocolError("Original operation is not retained");
    canonical(observation);
    const operation = deepFreeze({ ...prior, observation: structuredClone(observation), settled: prior.settled || settled });
    this.#operations.set(id, operation); this.#prune(); return operation;
  }
  #prune(): void {
    const settled = [...this.#operations.values()].filter(value => value.settled);
    for (const value of settled.slice(0, Math.max(0, settled.length - 32))) this.#operations.delete(value.id);
  }
  mount(viewKey = "main"): ViewLease {
    const view = this.client.view(viewKey), id = Symbol("viewer-lease"); this.#leases.add(id);
    return Object.freeze({ view, release: () => { this.#leases.delete(id); } });
  }
  assertRetirable(): void {
    if (this.#pinned || this.#leases.size || [...this.#operations.values()].some(value => !value.settled)) throw new CapacityError("Protected session cannot be retired");
    if (this.#draft !== "" && this.#draft !== null) throw new CapacityError("Clear the retained draft explicitly before retirement");
  }
}

/** One embedding workspace with an exact authenticated connection/principal scope. */
export class HistoryWorkspace {
  readonly #connection: string;
  readonly #principal: string;
  readonly #maxSessions: number;
  readonly #maxViews: number;
  readonly #maxOperations: number;
  readonly #clientOptions: ClientLimits;
  readonly #sessions = new Map<string, WorkspaceSession>();
  readonly #selection = new Map<string, ViewLease>();
  #connected = true;

  constructor(options: WorkspaceOptions) {
    if (!options.connection || !options.principal) throw new TypeError("Workspace requires an authenticated scope");
    this.#connection = options.connection; this.#principal = options.principal;
    this.#maxSessions = bound(options.maxSessions ?? 16, "Session limit");
    this.#maxViews = bound(options.maxViewsPerSession ?? 8, "View limit");
    this.#maxOperations = bound(options.maxOperationsPerSession ?? 128, "Operation limit");
    this.#clientOptions = options.client ?? {};
  }
  get size(): number { return this.#sessions.size; }
  get connected(): boolean { return this.#connected; }
  /** Connectivity is observation only; it does not unpin, clear state or stop native capture. */
  setConnected(value: boolean): void { this.#connected = value; }
  #checkScope(scope: Scope): void {
    if (scope.origin.connection !== this.#connection || scope.origin.principal !== this.#principal) throw new HistoryProtocolError("Foreign workspace principal or connection");
  }
  session(scope: Scope): WorkspaceSession {
    this.#checkScope(scope);
    const key = conversationKey(scope); let session = this.#sessions.get(key);
    if (session) {
      if (!sameScope(session.client.scope, scope)) throw new HistoryProtocolError("Attachment change requires explicit rebind");
      return session;
    }
    if (this.#sessions.size >= this.#maxSessions) throw new CapacityError("Workspace capacity reached; no session was evicted");
    session = new WorkspaceSession(new HistoryClient(scope, { ...this.#clientOptions, maxViews: this.#maxViews }), this.#maxOperations);
    this.#sessions.set(key, session); return session;
  }
  rebind(scope: Scope): WorkspaceSession {
    this.#checkScope(scope);
    const session = this.#sessions.get(conversationKey(scope));
    if (!session) return this.session(scope);
    session.client.rebind(scope); return session;
  }
  /** Independent panels name slots; stale/idempotent cleanup cannot release a newer lease. */
  select(scope: Scope, viewKey = "main"): ViewLease {
    const session = this.session(scope), mounted = session.mount(viewKey), previous = this.#selection.get(viewKey);
    const next: ViewLease = Object.freeze({ view: mounted.view, release: () => {
      mounted.release();
      if (this.#selection.get(viewKey) === next) this.#selection.delete(viewKey);
    } });
    this.#selection.set(viewKey, next); previous?.release(); return next;
  }
  retire(scope: Scope): void {
    this.#checkScope(scope); const key = conversationKey(scope), session = this.#sessions.get(key);
    if (!session) return;
    session.assertRetirable(); this.#sessions.delete(key);
  }
}
