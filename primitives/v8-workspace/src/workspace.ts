import { CatalogWorkspace, type LogicalEntry, type MetadataAction } from '../../v8-catalog/src/client/workspace.js';
import { sessionScope } from '../../v8-catalog/src/contracts/types.js';
import { scope as validateCatalogScope } from '../../v8-catalog/src/contracts/validation.js';
import { FileWorkspace } from '../../v8-files/src/client/workspace.js';
import type { ComposerValue } from '../../v8-files/src/client/persistence.js';
import { ResourceCache, type ResourceLease } from '../../v8-files/src/client/resource-cache.js';
import { scopeKey as fileKey, type FileScope, type FilePort, type FileInputs, type FileOutputs, type FileMethod, type ArtifactRef, FileError } from '../../v8-files/src/contracts/types.js';
import type { CreateRequest, CatalogEntry, RenameRequest, WatchRequest } from '../../v8-catalog/src/contracts/types.js';
import { HistoryWorkspace } from '../../v8-history/src/client/workspace.js';
import { InteractionWorkspace } from '../../v8-interactions/src/client.js';
import { McpWorkspace } from '../../v8-mcp/src/client.js';
import { SessionPins, type PinRestore, type PinWrite } from '../../v8-organization/src/pins.js';
import { queryCatalog, type CatalogQuery, type CatalogListing } from '../../v8-organization/src/query.js';
import { SessionWorkspace, type SessionEntry, type SessionView, type OperationHandle, type OriginalReceiptReference } from '../../v8-session/src/client/workspace.js';
import { SessionError, scopeKey, sameRun, type RunRef, type NativeRead, type SessionScope, type SessionPort, type SessionCommand, type SendCommandFor, type MessageCommandFor, type Harness, type Receipt, type Catalog } from '../../v8-session/src/contracts/types.js';
import { validateCatalog } from '../../v8-session/src/native/validation.js';
import { canonical, copy, id } from '../../v8-session/src/contracts/validation.js';
import { RetainedComposer } from './composer.js';
import { GoalForm } from './goal-form.js';
import { PlanActions, rootPlan, planImplementationText, type PlanPreparation, type PlanOriginal } from './plan-action.js';
import { SendPreparation, type SendContext, type DraftAction } from './send.js';
import { ReadonlyHistories, type ReadonlyHistoryView } from './history-view.js';
import { validateScope as validateHistoryScope } from '../../v8-history/src/contracts/validation.js';
import type { CapturedScope, Scope as HistoryScope } from '../../v8-history/src/contracts/types.js';
import { agentSummaries } from './agent-summary.js';
import type { AgentSnapshot, Binding, CreationControl, CreationStatus, ObservationState, OperationStatus, WorkspaceAccess, WorkspaceObservation, WorkspaceOptions, WorkspacePorts, WorkspaceView } from './contracts.js';

type PendingBinding = Readonly<{ binding: Binding; state: 'preparing' | 'unavailable' }>;
type ScopeInventory = Readonly<{ supported: boolean; state: 'unobserved' | 'observed' | 'unavailable'; entries: readonly CapturedScope[] }>;
type Prepared = { goalForm: GoalForm; plans: PlanActions; scope: SessionScope; binding: Binding; pendingBinding: PendingBinding | null; logical: LogicalEntry; entry: SessionEntry | null; composer: RetainedComposer | null; send: SendPreparation | null; modelCatalog: SharedCatalog; catalogRead: Promise<Catalog> | null; historyScopes: ScopeInventory; scopeRead: Promise<readonly HistoryScope[]> | null; retainedReleases: (() => void)[]; settlement: Promise<void> | null; ready: boolean; views: Map<string, WorkspaceView>; stream: { release(): void } | null; rebound: Set<() => void>; observers: Set<() => void> };
type SharedCatalog = Readonly<{ state: 'unobserved' | 'loading' | 'available' | 'unavailable'; value: Catalog | null }>;
const unobserved = Object.freeze({ session: 'unobserved' as ObservationState, history: 'unobserved' as ObservationState });
const disposed: AgentSnapshot = Object.freeze({ kind: 'disposed' });
const bounded = (value: number, maximum: number): number => { if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new SessionError('INVALID'); return value; };
function operationStatus(original: Readonly<{ id: string; type: string; generation: number }>, receipt: Receipt | null, pending: boolean): OperationStatus {
  const outcome = receipt?.outcome, detail = outcome?.detail;
  const record = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail as Readonly<Record<string, unknown>> : null;
  const substeps = record?.completedSubsteps;
  const completedSubsteps = Array.isArray(substeps) && substeps.length <= 3 && substeps.every(step => ['copilot.model', 'copilot.mode', 'copilot.permissions'].includes(step)) ? Object.freeze([...substeps]) as readonly string[] : undefined;
  const result = actionResult(original.type, record);
  return Object.freeze({ id: original.id, type: original.type, generation: original.generation, state: receipt?.state ?? (pending ? 'sending' : 'unobserved'),
    ...(outcome ? { outcome: Object.freeze({ status: outcome.status, ...(typeof record?.sendDispatched === 'boolean' ? { sendDispatched: record.sendDispatched } : {}), ...(completedSubsteps ? { completedSubsteps } : {}), ...(result ? { result } : {}) }) } : {}) });
}
function actionResult(type: string, detail: Readonly<Record<string, unknown>> | null): NonNullable<OperationStatus['outcome']>['result'] {
  if (!detail) return undefined;
  if (type === 'copilot.compact' && typeof detail.success === 'boolean' && Number.isSafeInteger(detail.tokensRemoved) && Number(detail.tokensRemoved) >= 0 && Number.isSafeInteger(detail.messagesRemoved) && Number(detail.messagesRemoved) >= 0)
    return Object.freeze({ type, success: detail.success, tokensRemoved: Number(detail.tokensRemoved), messagesRemoved: Number(detail.messagesRemoved) });
  if (type === 'copilot.queue.promote' && typeof detail.steered === 'boolean') return Object.freeze({ type, steered: detail.steered });
  if (type === 'copilot.task.cancel' && typeof detail.cancelled === 'boolean') return Object.freeze({ type, cancelled: detail.cancelled });
  if (type === 'copilot.task.promote' && typeof detail.promoted === 'boolean') return Object.freeze({ type, promoted: detail.promoted });
  if (type === 'codex.goal.clear' && typeof detail.cleared === 'boolean') return Object.freeze({ type, cleared: detail.cleared });
  if (type === 'codex.terminal.terminate' && typeof detail.terminated === 'boolean') return Object.freeze({ type, terminated: detail.terminated });
  return undefined;
}

/** Composition only. Domain state/receipts remain in the existing retained clients. */
export class MultiplexWorkspace {
  readonly #scope; readonly #ports: WorkspacePorts; readonly #history: HistoryWorkspace;
  readonly #historyViews: ReadonlyHistories;
  readonly #sessions: SessionWorkspace; readonly #catalog: CatalogWorkspace; readonly #files: FileWorkspace;
  readonly #interactions: InteractionWorkspace; readonly #mcp: McpWorkspace; readonly #pins: SessionPins; readonly #persistence;
  readonly #resources: ResourceCache; readonly #previews = new Set<ResourceLease>(); readonly #fileLeases = new Map<string, FilePort>();
  readonly #prepared = new Map<string, Prepared>(); readonly #opening = new Map<string, Promise<WorkspaceView>>();
  readonly #disposals = new Set<() => void>(); readonly #maximum: number; readonly #views: number; readonly #maxOperations: number;
  readonly #catalogListeners = new Set<() => void>(); readonly #releaseCatalog: () => void;
  readonly #observations = new Map<string, Readonly<{ session: ObservationState; history: ObservationState }>>();
  readonly #cleanup = new Set<() => void>(); readonly #preparationDrains: Promise<void>[] = [];
  #closed = false; #connected = true; #persistenceClosing = false; #draining = false;
  constructor(options: WorkspaceOptions) {
    validateCatalogScope(options.scope); this.#scope = copy(options.scope); this.#persistence = options.persistence;
    this.#maximum = bounded(options.maxSessions ?? 16, 128); this.#views = bounded(options.maxViewsPerSession ?? 8, 32);
    const maxOperations = this.#maxOperations = bounded(options.maxOperations ?? 128, 512);
    this.#history = new HistoryWorkspace({ connection: this.#scope.connection, principal: this.#scope.principal, maxSessions: this.#maximum, maxViewsPerSession: this.#views, maxOperationsPerSession: maxOperations });
    this.#ports = options.connect({ history: this.#history, onFence: () => this.close(), onConnection: connected => this.#connection(connected), onObservation: observation => this.#observation(observation), onReady: observation => this.#restoreObservation(observation) });
    this.#historyViews = new ReadonlyHistories(this.#history, this.#ports);
    // FileScope.session is a native ID: route only by the exact authenticated binding tuple.
    const files: FilePort = { call: (method, input) => this.#fileCall(method, input) };
    this.#files = new FileWorkspace({ history: this.#history, persistence: options.persistence, port: files }); this.#resources = new ResourceCache(files);
    const sessionPort: SessionPort = {
      snapshot: async scope => { this.#scopeMatch(scope); const value = await this.#ports.session.snapshot(scope); this.#open(); return value; },
      ...(this.#ports.session.read ? { read: (run: RunRef, request: NativeRead) => { this.#scopeMatch(run.scope); return this.#observeResult(() => this.#ports.session.read!(run, request)); } } : {}),
      ...(this.#ports.session.mcpLoginLink ? { mcpLoginLink: (run: RunRef, originalId: string) => {
        this.#requireAccess(run.scope, 'read'); this.#requireAccess(run.scope, 'control');
        return this.#observeResult(() => this.#ports.session.mcpLoginLink!(run, originalId));
      } } : {}),
      submit: async request => { this.#scopeMatch(request.scope); const value = await this.#ports.session.submit(request); this.#open(); return value; },
      receipt: async (scope, operationId) => { this.#scopeMatch(scope); const value = await this.#ports.session.receipt(scope, operationId); this.#open(); return value; },
      subscribe: (scope, listener) => { this.#scopeMatch(scope); return this.#ports.session.subscribe(scope, value => { if (!this.#closed) listener(value); }); },
    };
    this.#sessions = new SessionWorkspace({ history: this.#history, port: sessionPort, files: this.#files, maxSessions: this.#maximum, maxOperations, admit: (scope, action) => this.#requireAccess(scope, action),
      protectOriginal: reference => this.#prepared.get(reference.scope.session)?.composer?.getSnapshot().originals.some(value => value.owner === reference.owner && scopeKey(value.scope) === scopeKey(reference.scope) && value.id === reference.id && value.type === reference.type && value.generation === reference.generation) ?? false,
      ...(this.#ports.receiptOwner ? { receiptOwner: scope => this.#ports.receiptOwner!(scope) } : {}) });
    this.#catalog = new CatalogWorkspace({ scope: this.#scope, sessions: this.#sessions, maxSessions: this.#maximum, port: {
      list: scope => this.#observeResult(() => this.#ports.catalog.list(scope)), get: (scope, session) => this.#observeResult(() => this.#ports.catalog.get(scope, session)),
      create: request => this.#observeResult(() => this.#ports.catalog.create(request)), creation: (scope, operationId) => this.#observeResult(() => this.#ports.catalog.creation(scope, operationId)), rename: request => this.#observeResult(() => this.#ports.catalog.rename(request)),
      setWatched: request => this.#observeResult(() => this.#ports.catalog.setWatched(request)), metadataOriginal: (scope, id) => this.#observeResult(() => this.#ports.catalog.metadataOriginal(scope, id)),
      ...(this.#ports.catalog.publishArchive ? { publishArchive: request => this.#observeResult(() => this.#ports.catalog.publishArchive!(request)) } : {}),
      subscribe: (scope, listener) => this.#ports.catalog.subscribe(scope, value => { if (!this.#closed) listener(value); }),
    } });
    this.#interactions = new InteractionWorkspace({ session: sessionPort, maxSessions: this.#maximum, maxOperations, admit: scope => this.#requireAccess(scope, 'control'), port: {
      snapshot: scope => { this.#scopeMatch(scope); return this.#ports.interactionPort(scope).snapshot(scope); },
      subscribe: (scope, listener) => { this.#scopeMatch(scope); return this.#ports.interactionPort(scope).subscribe(scope, listener); },
    } });
    this.#mcp = new McpWorkspace({ connection: this.#scope.connection, principal: this.#scope.principal, maxRuns: 2 * this.#maximum, port: {
      snapshot: run => this.#mcpPort(run).snapshot(run), subscribe: (run, listener) => this.#mcpPort(run).subscribe(run, listener),
      refresh: (run, observation) => this.#mcpPort(run).refresh(run, observation),
    } });
    this.#pins = new SessionPins({ catalog: this.#catalog, scope: this.#scope, ...(options.pinStorage ? { storage: options.pinStorage } : {}), ...(options.maxPins ? { maxPins: options.maxPins } : {}) });
    this.#releaseCatalog = this.#catalog.subscribeCatalog(() => this.#catalogChanged());
  }
  #catalogChanged(): void { for (const prepared of this.#prepared.values()) if (prepared.entry) this.#reconcile(prepared); for (const listener of [...this.#catalogListeners]) try { listener(); } catch { /* Renderer isolation. */ } }
  #open(): void { if (this.#closed) throw new SessionError('CLOSED'); }
  #observation(value: WorkspaceObservation): void {
    if (this.#closed) return;
    if (value.kind === 'catalog') {
      if (value.scope.connection !== this.#scope.connection || value.scope.principal !== this.#scope.principal || value.scope.authority !== this.#scope.authority) return;
      if (value.state !== 'live') this.#catalog.markStale();
      return;
    }
    if (value.scope.connection !== this.#scope.connection || value.scope.principal !== this.#scope.principal) return;
    if (value.kind === 'session' && value.state !== 'live') this.#sessions.markStale(value.scope);
    const prepared = this.#prepared.get(value.scope.session);
    if (value.kind === 'history' && value.history && prepared && canonical(value.history) !== canonical(prepared.binding.history)) {
      this.#historyViews.observation(value.scope.session, value.history, value.state); return;
    }
    if (value.kind === 'session' || value.kind === 'history') {
      // A logical control feed can be admitted before transcript bootstrap.
      // Retain its display facts through that handover instead of dropping ACKs.
      const key = scopeKey(value.scope), prior = this.#observations.get(key) ?? unobserved;
      if (prior[value.kind] === value.state) return;
      if (!this.#observations.has(key) && this.#observations.size >= this.#maximum) throw new SessionError('FULL');
      this.#observations.set(key, Object.freeze({ ...prior, [value.kind]: value.state }));
      if (prepared && scopeKey(value.scope) === scopeKey(prepared.scope)) for (const notify of [...prepared.observers]) notify();
      return;
    }
    if (!prepared?.entry || scopeKey(value.scope) !== scopeKey(prepared.scope)) return;
    if (value.kind === 'interactions') { if (value.state !== 'live') this.#interactions.setConnected(prepared.scope, value.state === 'connecting'); return; }
    if (value.kind === 'mcp' && (sameRun(value.run, prepared.binding.run) || prepared.pendingBinding?.state === 'preparing' && sameRun(value.run, prepared.pendingBinding.binding.run)) && value.state !== 'live') this.#mcp.setConnected(value.run, value.state === 'connecting');
  }

  async #restoreObservation(value: WorkspaceObservation): Promise<void> {
    // Admission may be reported by a synchronous scripted transport during
    // construction. Domain owners must exist before their snapshot reads run.
    await Promise.resolve(); this.#open();
    if (value.kind === 'catalog') { await this.#catalog.reobserve(); return; }
    this.#scopeMatch(value.scope);
    if (value.kind === 'session') { await this.#sessions.reobserve(value.scope); return; }
    const prepared = this.#prepared.get(value.scope.session);
    if (!prepared?.entry) return;
    if (value.kind === 'interactions') await this.#interactions.refresh(value.scope);
    else if (value.kind === 'mcp' && (sameRun(value.run, prepared.binding.run) || prepared.pendingBinding?.state === 'preparing' && sameRun(value.run, prepared.pendingBinding.binding.run))) await this.#mcp.reobserve(value.run);
    // History uses the Host cursor/replay stream. Reconnecting never reads
    // native transcript bodies or invokes explicit recovery/discovery.
  }
  async #observeResult<T>(work: () => Promise<T>): Promise<T> { this.#open(); const value = await work(); this.#open(); return value; }
  #scopeMatch(scope: SessionScope): void { this.#open(); if (scope.connection !== this.#scope.connection || scope.principal !== this.#scope.principal) throw new SessionError('FENCED'); }
  #access(scope: SessionScope): WorkspaceAccess {
    this.#scopeMatch(scope); const value = this.#ports.access(scope);
    return Object.freeze({ read: value.read === true, control: value.control === true, fileWrite: value.fileWrite === true, mcpRefresh: value.mcpRefresh === true, catalogWrite: value.catalogWrite === true });
  }
  #requireAccess(scope: SessionScope, action: keyof WorkspaceAccess): void { if (!this.#access(scope)[action]) throw new SessionError('FENCED', 'This action is not available through the configured Gateway route'); }
  #logicalScope(session: string): SessionScope {
    this.#open(); const logical = this.#catalog.entry(session).getSnapshot(), target = logical.entry?.target ?? logical.original?.target;
    if (!target) throw new SessionError('FENCED');
    return { connection: this.#scope.connection, principal: this.#scope.principal, host: target.host, session };
  }
  #preparedEntry(session: string): Prepared { this.#open(); id(session); const value = this.#prepared.get(session); if (!value?.entry || !value.ready) throw new SessionError('FENCED', 'Open the proved binding explicitly before preparing a view'); return value; }
  #fileOwner(scope: FileScope): Prepared {
    const matches = [...this.#prepared.values()].filter(value => fileKey({ connection: value.scope.connection, principal: value.scope.principal, host: value.scope.host, session: value.binding.history.origin.nativeSession }) === fileKey(scope));
    if (matches.length !== 1) throw new FileError('FENCED'); return matches[0]!;
  }
  async #fileCall<M extends FileMethod>(method: M, input: FileInputs[M]): Promise<FileOutputs[M]> {
    if (method === 'release') {
      const release = input as FileInputs['release'], key = JSON.stringify([fileKey(release.scope), release.leaseId]), port = this.#fileLeases.get(key);
      if (!port) throw new FileError('FENCED');
      try { return await port.call(method, input); } finally { this.#fileLeases.delete(key); }
    }
    this.#open(); const prepared = this.#fileOwner(input.scope);
    // Same classification as the authenticated Gateway file surface. Capture
    // creates an immutable Host artifact and currently requires fileWrite.
    this.#requireAccess(prepared.scope, ['status', 'usage', 'acquire', 'read'].includes(method) ? 'read' : 'fileWrite');
    const port = this.#ports.filePort(prepared.scope), value = await port.call(method, input);
    if (method === 'acquire') {
      const acquired = value as FileOutputs['acquire'];
      if (this.#closed) { await port.call('release', { scope: input.scope, leaseId: acquired.leaseId }); throw new SessionError('CLOSED'); }
      this.#fileLeases.set(JSON.stringify([fileKey(input.scope), acquired.leaseId]), port);
    }
    this.#open(); return value;
  }
  #mcpPort(run: RunRef) { this.#scopeMatch(run.scope); const entry = this.#prepared.get(run.scope.session); if (!entry || !sameRun(entry.binding.run, run) && !(entry.pendingBinding?.state === 'preparing' && sameRun(entry.pendingBinding.binding.run, run))) throw new SessionError('FENCED'); return this.#ports.mcpPort(run.scope); }
  async refreshCatalog(): Promise<CatalogListing> { this.#open(); await this.#catalog.refresh(); this.#open(); return this.list(); }
  create(request: CreateRequest) {
    // Local admission is synchronous: a returned Promise proves that this
    // owner retained the original, even if its eventual transport result fails.
    this.#requireAccess(sessionScope(request), 'catalogWrite'); const pending = this.#catalog.create(request);
    // Catalog records the original synchronously. Logical control observation
    // can begin while native Create is still pending; it owns no history.
    try { this.prepareCreation(request.session); } catch { /* Preserve the original Create validation/result. */ }
    return pending.then(result => { this.#open(); return result; }).finally(() => {
      if (!this.#closed) {
        const original = this.#catalog.entry(request.session).getSnapshot().original;
        if (original) void this.#sessions.prepare(sessionScope(original), original.target.kind).catch(() => {});
      }
    });
  }
  /** Prepare outside React render. The existing session owner retains controls
   * before a native history binding exists; this performs observation only. */
  prepareCreation(session: string): CreationControl {
    this.#open(); const original = this.#catalog.entry(session).getSnapshot().original;
    if (!original) throw new SessionError('FENCED', 'No retained original Create');
    const scope = sessionScope(original); void this.#sessions.prepare(scope, original.target.kind).catch(() => {});
    const entry = this.#sessions.control(scope); let previous: SessionView | undefined, cached: ReturnType<CreationControl['getSnapshot']> = null;
    return Object.freeze({ subscribe: listener => this.#closed ? () => {} : entry.subscribe(listener), getSnapshot: () => {
      if (this.#closed) return null;
      const state = entry.getSnapshot(); if (previous === state) return cached; previous = state;
      const { draft: _, operations, ...safe } = state;
      cached = Object.freeze({ ...safe, operations: Object.freeze(operations.map(value => operationStatus(value.original, value.receipt, value.transmission === 'pending'))) });
      return cached;
    } });
  }
  stopCreation(session: string) {
    this.#open(); const original = this.#catalog.entry(session).getSnapshot().original;
    if (!original) throw new SessionError('FENCED', 'No retained original Create');
    return this.#sessions.request(sessionScope(original), { type: 'stop' });
  }
  async checkCreation(session: string): Promise<CreationStatus | null> {
    this.#open(); await this.#catalog.check(session); this.#open(); return this.creationStatus(session);
  }
  /** Retained receipt and independently streamed binding facts; no network/read/effect. */
  creationStatus(session: string): CreationStatus | null {
    this.#open(); const logical = this.#catalog.entry(session).getSnapshot();
    if (!logical.original || !logical.creation) return null;
    const { original, creation, entry } = logical;
    if (entry && (entry.createId !== original.id || entry.session !== original.session || canonical(entry.target) !== canonical(original.target))) throw new SessionError('FENCED');
    return Object.freeze({ id: original.id, session: original.session, state: creation.state, publication: creation.publication, binding: entry?.binding ?? null });
  }
  /** Existing catalog-entry publication only. Subscribe, then read creationStatus to cover initial state. */
  subscribeCreation(session: string, listener: (status: CreationStatus | null) => void): () => void {
    this.#open(); const logical = this.#catalog.entry(session); let released = false;
    const notify = () => { if (released || this.#closed) return; try { listener(this.creationStatus(session)); } catch { /* Consumer isolation. */ } };
    const unsubscribe = logical.subscribe(notify);
    const release = () => { if (released) return; released = true; unsubscribe(); this.#disposals.delete(notifyClosed); };
    const notifyClosed = () => { release(); try { listener(null); } catch { /* Auth disposal reaches every consumer. */ } };
    this.#disposals.add(notifyClosed); return release;
  }
  list(query: CatalogQuery = {}): CatalogListing { this.#open(); return queryCatalog(this.#catalog.catalog(), this.#scope, query, this.#pins.snapshot().map(pin => pin.session)); }
  /** Metadata belongs to the catalog's CAS owner, independently of native
   * lifetime. The caller captures one original ID and its observed revision. */
  renameSession(session: string, original: Pick<RenameRequest, 'id' | 'revision' | 'name'>): Promise<CatalogEntry> {
    this.#open(); id(session);
    this.#requireAccess(this.#logicalScope(session), 'catalogWrite');
    if (!this.#connected) throw new SessionError('IO', 'Catalog connection is unavailable');
    return this.#catalog.rename({ ...original, scope: this.#scope, session });
  }
  setWatched(session: string, original: Pick<WatchRequest, 'id' | 'revision' | 'watched'>): Promise<CatalogEntry> {
    this.#open(); id(session); if (!this.#connected) throw new SessionError('IO', 'Catalog connection is unavailable');
    this.#requireAccess(this.#logicalScope(session), 'catalogWrite');
    return this.#catalog.setWatched({ ...original, scope: this.#scope, session });
  }
  metadataStatus(session: string): MetadataAction | null { this.#open(); return this.#catalog.metadataStatus(session); }
  subscribeMetadata(session: string, listener: () => void): () => void { this.#open(); return this.#catalog.subscribeMetadata(session, listener); }
  async checkMetadata(session: string): Promise<MetadataAction | null> { this.#open(); await this.#catalog.checkMetadata(session); this.#open(); return this.metadataStatus(session); }
  /** Publish one exact completed Host archive proof through the catalog owner.
   * Retrying this metadata write never submits or repeats native retirement. */
  publishArchive(session: string, originalId: string, generation: number): Promise<CatalogEntry> {
    this.#open(); id(session);
    this.#requireAccess(this.#logicalScope(session), 'catalogWrite');
    if (!this.#connected) throw new SessionError('IO', 'Catalog connection is unavailable');
    return this.#catalog.publishArchive({ scope: this.#scope, session, id: originalId, generation });
  }
  /** Existing catalog/pin projection notifications; no polling or new store. */
  subscribeCatalog(listener: () => void): () => void { this.#open(); if (this.#catalogListeners.size >= 128 && !this.#catalogListeners.has(listener)) throw new SessionError('FULL'); this.#catalogListeners.add(listener); return () => { this.#catalogListeners.delete(listener); }; }
  /** Explicit read-only bootstrap. No native creation, resume, history body reads or MCP discovery. */
  open(session: string): Promise<WorkspaceView> {
    this.#open(); id(session); const pending = this.#opening.get(session); if (pending) return pending;
    if (this.#prepared.get(session)?.views.has('main')) return Promise.resolve(this.view(session));
    if (!this.#prepared.has(session) && this.#prepared.size >= this.#maximum) return Promise.reject(new SessionError('FULL'));
    const work = this.#bind(session); this.#opening.set(session, work);
    void work.finally(() => { if (this.#opening.get(session) === work) this.#opening.delete(session); }).catch(() => {}); return work;
  }
  async #binding(scope: SessionScope): Promise<Binding> {
    this.#scopeMatch(scope); const binding = await this.#ports.binding(scope); this.#open();
    if (!binding || scopeKey(binding.run.scope) !== scopeKey(scope) || binding.history.origin.connection !== scope.connection || binding.history.origin.principal !== scope.principal || binding.history.origin.host !== scope.host || binding.history.origin.nativeSession !== binding.run.nativeSession) throw new SessionError('FENCED', 'No exact authenticated history binding');
    return copy(binding);
  }
  async #bind(session: string): Promise<WorkspaceView> {
    await this.#catalog.refresh(); this.#open();
    const logical = this.#catalog.entry(session), metadata = logical.getSnapshot().entry;
    if (!metadata?.binding) throw new SessionError('FENCED', 'Catalog native binding is not observed');
    const scope = sessionScope({ scope: this.#scope, session, id: metadata.createId, target: metadata.target, metadata: metadata.metadata });
    const binding = await this.#binding(scope);
    if (binding.run.nativeSession !== metadata.binding.nativeSession || binding.history.kind !== metadata.target.kind) throw new SessionError('FENCED');
    if ([...this.#prepared.values()].some(value => value.scope.session !== session && value.scope.host === scope.host && value.binding.run.nativeSession === binding.run.nativeSession)) throw new SessionError('FENCED', 'Native conversation is already bound to a different logical session');
    const prepared: Prepared = this.#prepared.get(session) ?? { goalForm: new GoalForm(() => this.#notifyPrepared(prepared)), plans: new PlanActions(() => this.#notifyPrepared(prepared)), scope, binding, pendingBinding: null, logical, entry: null, composer: null, send: null, modelCatalog: Object.freeze({ state: 'unobserved', value: null }), catalogRead: null, historyScopes: Object.freeze({ supported: !!this.#ports.historyScopes, state: 'unobserved', entries: Object.freeze([]) }), scopeRead: null, retainedReleases: [], settlement: null, ready: false, views: new Map(), stream: null, rebound: new Set(), observers: new Set() };
    if (this.#prepared.has(session) && canonical(prepared.binding) !== canonical(binding)) throw new SessionError('FENCED', 'Explicit rebind required');
    this.#prepared.set(session, prepared);
    prepared.entry = await this.#catalog.bindNative(session, binding.history); this.#open();
    const observed = prepared.entry.getSnapshot().native;
    if (!observed || !sameRun({ scope, generation: observed.generation, nativeSession: observed.nativeSession! }, binding.run)) throw new SessionError('FENCED', 'Run changed during read-only bootstrap');
    prepared.composer ??= new RetainedComposer({ scope: { ...this.#scope, host: scope.host, session }, persistence: this.#persistence,
      restoreOriginals: references => { this.#open(); this.#sessions.restoreOriginals(scope, references); } });
    // Storage failure is visible in the composer. Native Stop, callback answers
    // and read-only conversation observation retain their existing path.
    try { await prepared.composer.load(); } catch { /* Composer exposes unavailable. */ } this.#open();
    prepared.send ??= new SendPreparation({ composer: prepared.composer, context: action => this.#sendContext(prepared, action),
      files: () => this.#files.getSnapshot().records.filter(record => fileKey(record.scope) === fileKey(this.#fileScope(prepared))),
      upload: id => this.uploadFile(session, id), reference: (id, type) => this.receiptReference(session, id, type),
      submit: (reference, command) => this.#submitMessage(session, reference, command), changed: () => this.#notifyPrepared(prepared) });
    if (!prepared.retainedReleases.length) prepared.retainedReleases.push(prepared.entry.subscribe(() => {
      const native = prepared.entry!.getSnapshot().native;
      if (native?.archive) this.#reconcile(prepared);
      if (!native || native.stopRequested || native.phase === 'stopping' || native.phase === 'stopped' || native.generation !== prepared.binding.run.generation) prepared.send!.invalidate();
      if (!native || native.nativeSession !== prepared.binding.run.nativeSession || native.generation !== prepared.binding.run.generation) {
        prepared.historyScopes = Object.freeze({ supported: prepared.historyScopes.supported, state: 'unobserved', entries: prepared.historyScopes.entries }); this.#historyViews.reconcile(session);
      }
      this.#settleOriginals(prepared);
    }), prepared.composer.subscribe(() => this.#settleOriginals(prepared)), prepared.entry.history.client.subscribe(() => this.#streamedHistoryScopes(prepared)));
    this.#streamedHistoryScopes(prepared);
    this.#settleOriginals(prepared);
    await this.#interactions.bind(scope); this.#open();
    try { await this.#mcp.bind(binding.run, binding.history.kind); }
    catch (error) {
      this.#open();
      const code = (error as { code?: unknown })?.code;
      if (code !== 'FULL' && code !== 'UNAVAILABLE' && code !== 'TIMEOUT') throw error;
      // An admitted MCP observer owns its later baseline. Missing optional
      // evidence stays stale/null; it cannot make proved chat/history fatal.
      // A failed subscription has no retained entry; bootstrap still rejects.
      try { this.#mcp.entry(binding.run); } catch { throw error; }
    }
    this.#open();
    const current = prepared.entry.getSnapshot().native;
    if (!current?.nativeSession || !sameRun({ scope, generation: current.generation, nativeSession: current.nativeSession }, binding.run)) throw new SessionError('FENCED', 'Run changed during read-only bootstrap');
    prepared.ready = true; this.#reconcile(prepared); return this.view(session);
  }
  /** Explicit existing-client history transition, never an implicit effect on render/reconnect. */
  async rebind(session: string): Promise<WorkspaceView> {
    const pending = this.#opening.get(session); if (pending) return pending;
    const work = this.#rebind(session); this.#opening.set(session, work);
    void work.finally(() => { if (this.#opening.get(session) === work) this.#opening.delete(session); }).catch(() => {}); return work;
  }
  async #rebind(session: string): Promise<WorkspaceView> {
    const prepared = this.#preparedEntry(session), binding = await this.#binding(prepared.scope); this.#open();
    if (binding.run.nativeSession !== prepared.binding.run.nativeSession || binding.history.kind !== prepared.binding.history.kind) throw new SessionError('FENCED', 'Different native conversation needs separate identity');
    const previousRun = prepared.binding.run, replacement = !sameRun(previousRun, binding.run);
    const pending: PendingBinding = Object.freeze({ binding, state: 'preparing' }); prepared.pendingBinding = pending;
    this.#releaseHistory(prepared); this.#notifyPrepared(prepared);
    const current = () => {
      this.#open(); if (!this.#connected) throw new SessionError('IO', 'Connection lost during read-only binding preparation');
      const native = prepared.entry!.getSnapshot().native;
      if (prepared.pendingBinding !== pending || !native || native.nativeSession === null || !sameRun({ scope: prepared.scope, generation: native.generation, nativeSession: native.nativeSession }, binding.run) || canonical(prepared.entry!.historyScope) !== canonical(binding.history)) throw new SessionError('FENCED', 'Binding changed during domain preparation');
    };
    try {
      const entry = await this.#sessions.rebind(prepared.scope, binding.history); current();
      await this.#interactions.refresh(prepared.scope); current();
      const interactions = this.#interactions.entry(prepared.scope).getSnapshot();
      if (!interactions.snapshot || !sameRun(interactions.snapshot.run, binding.run)) throw new SessionError('FENCED', 'Interactions did not observe the proved run');
      await this.#mcp.bind(binding.run, binding.history.kind); current();
      // A prior failed bind can retain an empty existing entry; retry its observation, never discovery.
      if (!this.#mcp.entry(binding.run).getSnapshot().snapshot) { await this.#mcp.reobserve(binding.run); current(); }
      const mcp = this.#mcp.entry(binding.run).getSnapshot().snapshot, confirmed = this.#interactions.entry(prepared.scope).getSnapshot().snapshot;
      if (!mcp || !sameRun(mcp.run, binding.run) || !confirmed || !sameRun(confirmed.run, binding.run)) throw new SessionError('FENCED');
      this.#reconcile(prepared, binding); current();
      // No await between publishing the descriptor and switching its domain subscriptions.
      prepared.entry = entry; prepared.binding = binding; prepared.pendingBinding = null;
      prepared.historyScopes = Object.freeze({ supported: prepared.historyScopes.supported, state: 'unobserved', entries: prepared.historyScopes.entries });
      this.#streamedHistoryScopes(prepared);
      for (const refresh of [...prepared.rebound]) try { refresh(); } catch { /* Consumer isolation. */ }
      if (replacement) this.#mcp.retire(previousRun);
      this.#notifyPrepared(prepared); return this.view(session);
    } catch (error) {
      if (replacement && !this.#closed) this.#mcp.retire(binding.run);
      if (!this.#closed && prepared.pendingBinding === pending) {
        this.#releaseHistory(prepared); prepared.pendingBinding = Object.freeze({ binding, state: 'unavailable' }); this.#notifyPrepared(prepared);
      }
      throw error;
    }
  }
  #releaseHistory(prepared: Prepared): void { prepared.stream?.release(); prepared.stream = null; this.#historyViews.invalidate(prepared.scope.session); const key = scopeKey(prepared.scope); this.#observations.set(key, Object.freeze({ ...(this.#observations.get(key) ?? unobserved), history: 'unobserved' })); }
  #notifyPrepared(prepared: Prepared): void { for (const notify of [...prepared.observers]) try { notify(); } catch { /* Consumer isolation. */ } }
  #reconcile(prepared: Prepared, candidate?: Binding): void {
    if (this.#closed) return;
    if (prepared.entry!.getSnapshot().native?.archive || prepared.logical.getSnapshot().entry?.archive) { prepared.stream?.release(); prepared.stream = null; return; }
    if (prepared.entry!.history.observationReferences > 0 && !prepared.stream && (candidate || !prepared.pendingBinding)) prepared.stream = this.#ports.observeHistory(prepared.scope, (candidate ?? prepared.binding).history);
    else if (!prepared.entry!.history.observationReferences && prepared.stream) { prepared.stream.release(); prepared.stream = null; }
  }
  setPinned(session: string, value: boolean): PinWrite { this.#open(); const result = this.#pins.setPinned(session, value), prepared = this.#prepared.get(session); if (prepared?.entry) this.#reconcile(prepared); this.#catalogChanged(); return result; }
  restorePins(): PinRestore { this.#open(); const result = this.#pins.restore(); for (const prepared of this.#prepared.values()) if (prepared.entry) this.#reconcile(prepared); this.#catalogChanged(); return result; }
  pins() { this.#open(); return this.#pins.snapshot(); }
  setDraft(session: string, value: string | ComposerValue): void {
    const composer = this.composer(session); composer.edit(typeof value === 'string' ? { ...composer.getSnapshot().value, text: value } : value);
  }
  /** Local protection retires only against validated exact terminal receipts.
   * One job per retained entry, independent of mounted React observers. */
  #settledOriginal(prepared: Prepared) {
    const operations = prepared.entry!.getSnapshot().operations;
    return prepared.composer!.getSnapshot().originals.find(reference => reference.owner === this.#ports.receiptOwner?.(prepared.scope) && scopeKey(reference.scope) === scopeKey(prepared.scope) && operations.some(value => value.original.id === reference.id && value.original.type === reference.type && value.original.generation === reference.generation && (value.receipt?.state === 'acknowledged' || value.receipt?.state === 'refused')));
  }
  #settleOriginals(prepared: Prepared): void {
    if (this.#closed || prepared.settlement || !prepared.entry || prepared.composer?.getSnapshot().state !== 'saved' || !this.#settledOriginal(prepared)) return;
    const composer = prepared.composer;
    const work = Promise.resolve().then(async () => {
      while (!this.#closed && composer.getSnapshot().state === 'saved') {
        const reference = this.#settledOriginal(prepared);
        if (!reference) return;
        await composer.settle(reference); if (this.#closed) return;
        await this.#files.reload(this.#fileScope(prepared));
      }
    });
    prepared.settlement = work;
    void work.catch(() => { /* Composer retains its explicit storage failure. */ }).finally(() => {
      if (prepared.settlement === work) prepared.settlement = null;
      if (!this.#closed && composer.getSnapshot().state === 'saved') this.#settleOriginals(prepared);
    });
  }
  async refreshMcp(session: string): Promise<void> { const prepared = this.#preparedEntry(session); this.#requireAccess(prepared.scope, 'mcpRefresh'); await this.#mcp.refresh(prepared.binding.run); this.#open(); }
  async checkReceipt(session: string, operationId: string) {
    this.#open(); const prepared = this.#prepared.get(session);
    if (!prepared?.entry) {
      const original = this.#catalog.entry(session).getSnapshot().original;
      if (!original) throw new SessionError('FENCED');
      const receipt = await this.#sessions.checkReceipt(sessionScope(original), operationId); this.#open(); return receipt;
    }
    const interaction = this.#interactions.entry(prepared.scope).getSnapshot().operations.some(value => value.id === operationId);
    const reference = prepared.composer?.getSnapshot().originals.find(value => value.id === operationId);
    const receipt = await (interaction ? this.#interactions.checkReceipt(prepared.scope, operationId) : reference ? this.#sessions.checkOriginal({ scope: reference.scope, owner: reference.owner, id: reference.id, type: reference.type, generation: reference.generation }) : this.#sessions.checkReceipt(prepared.scope, operationId)); this.#open(); return receipt;
  }
  receiptReference(session: string, operationId: string): OriginalReceiptReference & Readonly<{ type: 'send' }>;
  receiptReference<T extends SessionCommand['type']>(session: string, operationId: string, type: T): OriginalReceiptReference & Readonly<{ type: T }>;
  receiptReference(session: string, operationId: string, type: SessionCommand['type'] = 'send'): OriginalReceiptReference {
    const prepared = this.#preparedEntry(session); return this.#sessions.receiptReference(prepared.scope, operationId, type);
  }
  originalReferences(session: string): readonly OriginalReceiptReference[] {
    const prepared = this.#preparedEntry(session); return this.#sessions.originalReferences(prepared.scope);
  }
  restoreOriginals(session: string, references: readonly OriginalReceiptReference[]): void {
    const prepared = this.#preparedEntry(session); this.#sessions.restoreOriginals(prepared.scope, references);
  }
  composer(session: string): RetainedComposer { return this.#preparedEntry(session).composer!; }
  /** One derived admission predicate for both presentation and preparation.
   * Transport admission cannot establish native readiness or a current bind. */
  #sendRun(prepared: Prepared, state: SessionView, access = this.#access(prepared.scope), plan?: PlanPreparation, command: MessageCommandFor<Harness>["type"] = 'send'): RunRef | null {
    const native = state.native;
    if (prepared.plans.pending && prepared.plans.pending !== plan || !access.read || !access.control || !prepared.ready || !native || !native.nativeSession || !state.connected || state.stale || state.requiresRebind || state.issue || native.phase !== 'running' || native.stopRequested || !native.interactionsComplete || !native.capabilities.commands.includes(command)) return null;
    const run = { scope: prepared.scope, nativeSession: native.nativeSession, generation: native.generation };
    return sameRun(run, prepared.binding.run) && this.#ports.receiptOwner ? run : null;
  }
  #sendContext(prepared: Prepared, action: DraftAction): SendContext {
    this.#open();
    const state = prepared.entry!.getSnapshot(), native = state.native;
    if (!native) throw new FileError('FENCED');
    const type = action === 'steer' ? native.kind === 'codex' ? 'codex.steer' : 'copilot.steer' : action === 'queue' && native.kind === 'codex' ? 'codex.queue.add' : 'send';
    const run = this.#sendRun(prepared, state, this.#access(prepared.scope), undefined, type);
    if (!run || native.activity === 'unknown' || native.activity === 'waiting' || native.interactions.some(value => value.blocking)) throw new FileError('FENCED');
    if (action === 'send' && native.activity !== 'idle') throw new FileError('FENCED');
    let expectedTurnId: string | undefined;
    if (action === 'steer') {
      if (native.activity !== 'working') throw new FileError('FENCED');
      if (native.kind === 'codex') {
        const history = prepared.entry!.history.client.current;
        if (!history || canonical(history.scope) !== canonical(prepared.binding.history) || history.scopeInventory?.nativeGeneration !== run.generation || history.activity.state !== 'working' || !history.activity.turnId) throw new FileError('FENCED');
        expectedTurnId = history.activity.turnId;
      }
    }
    return copy({ run, epoch: native.epoch, owner: this.#ports.receiptOwner!(prepared.scope), kind: native.kind, selection: state.draft, ...(expectedTurnId ? { expectedTurnId } : {}) });
  }
  #draftActions(prepared: Prepared): Readonly<Record<DraftAction, boolean>> {
    const composer = prepared.composer!.getSnapshot(), held = composer.originals.some(value => value.edit === composer.edit);
    const allowed = (action: DraftAction) => { try { this.#sendContext(prepared, action); return !held; } catch { return false; } };
    return Object.freeze({ send: allowed('send'), steer: allowed('steer'), queue: allowed('queue') });
  }
  submitDraft(session: string, action: DraftAction) { return this.#preparedEntry(session).send!.start(action); }
  sendDraft(session: string) { return this.submitDraft(session, 'send'); }
  #goalEditor(prepared: Prepared) {
    const binding = prepared.binding, epoch = prepared.entry!.getSnapshot().native?.epoch;
    const current = () => !this.#closed && prepared.binding === binding && !prepared.pendingBinding && prepared.entry!.getSnapshot().native?.epoch === epoch && prepared.entry!.getSnapshot().native?.generation === binding.run.generation;
    const active = () => { this.#open(); if (!current()) throw new SessionError('FENCED'); };
    return Object.freeze({
      open: () => {
        active(); const state = prepared.entry!.getSnapshot();
        const value = state.nativeReads.find(item => item.request.type === 'codex.goal')?.value;
        if (state.native?.kind !== 'codex' || value?.type !== 'codex.goal') throw new SessionError('FENCED', 'Check the native goal before editing');
        prepared.goalForm.open(value.goal);
      },
      edit: (value: Parameters<GoalForm['edit']>[0]) => { active(); prepared.goalForm.edit(value); },
      cancel: () => { active(); prepared.goalForm.cancel(); },
      save: () => {
        active(); const state = prepared.entry!.getSnapshot(), native = state.native;
        this.#requireAccess(prepared.scope, 'control');
        if (!current() || !native || native.kind !== 'codex' || !state.connected || state.stale || state.requiresRebind || state.issue || native.phase !== 'running' || native.stopRequested) throw new SessionError('FENCED');
        return prepared.goalForm.save(patch => {
          const agent = this.#sessions.agent(prepared.scope);
          if (agent.kind !== 'codex' || !agent.actions.setGoal) throw new SessionError('UNSUPPORTED');
          return agent.actions.setGoal(patch);
        }, current);
      },
    });
  }
  #planContext(prepared: Prepared, rowId: string, viewKey: string, job?: PlanPreparation) {
    this.#open(); const state = prepared.entry!.getSnapshot(), native = state.native, run = this.#sendRun(prepared, state, this.#access(prepared.scope), job);
    const history = prepared.entry!.history.client.view(viewKey).getSnapshot();
    if (!run || !native || native.kind !== 'codex' || native.selection.kind !== 'codex' || native.activity !== 'idle' || native.interactions.length || native.selection.collaboration?.mode !== 'plan' || prepared.pendingBinding || prepared.send!.getSnapshot().state === 'preparing' || state.activeJobs) throw new SessionError('FENCED');
    const row = rootPlan(history, prepared.binding.history, run, rowId);
    if (!row) throw new SessionError('FENCED', 'Choose a completed plan from the current root conversation');
    // The clicked occurrence supplies the Send meaning; a newer plan cannot
    // silently replace it. Validate the existing Send limit before any original.
    const text = planImplementationText(row);
    const model = native.selection.collaboration.model, effort = native.selection.collaboration.effort;
    return { run, epoch: native.epoch, row, text, owner: this.#ports.receiptOwner!(prepared.scope), selection: { kind: 'codex' as const, collaboration: { mode: 'default' as const, model, effort } } };
  }
  implementPlan(session: string, rowId: string, viewKey = 'main'): Promise<PlanOriginal> {
    const prepared = this.#preparedEntry(session); id(rowId);
    this.#requireAccess(prepared.scope, 'read'); this.#requireAccess(prepared.scope, 'control');
    const observed = prepared.entry!.getSnapshot().native, owner = this.#ports.receiptOwner?.(prepared.scope);
    if (!observed?.nativeSession || !sameRun({ scope: prepared.scope, nativeSession: observed.nativeSession, generation: observed.generation }, prepared.binding.run)) throw new SessionError('FENCED');
    const existing = observed && owner && prepared.plans.existing(canonical([canonical([prepared.binding.run, observed.epoch, owner]), rowId]));
    if (existing) return existing;
    const context = this.#planContext(prepared, rowId, viewKey), binding = prepared.binding, runKey = canonical([context.run, context.epoch, context.owner]);
    return prepared.plans.start(canonical([runKey, rowId]), runKey, rowId, async job => {
      const current = () => { const value = this.#planContext(prepared, rowId, viewKey, job); if (binding !== prepared.binding || value.epoch !== context.epoch || value.owner !== context.owner || value.row.contentVersion !== context.row.contentVersion || canonical(value.row.body) !== canonical(context.row.body)) throw new SessionError('FENCED'); };
      current();
      const occurrence = canonical(['codex-implement-plan', context.owner, context.run, context.epoch, context.row.native.threadId!, context.row.native.turnId!, context.row.native.nativeItemId!]);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(occurrence)); current();
      const originalId = 'plan-' + Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
      const reference = this.receiptReference(session, originalId), restored = this.originalReferences(session).some(value => value.id === originalId);
      await prepared.composer!.protect(reference, this.#fileScope(prepared), []);
      prepared.plans.identify(job, originalId);
      try {
        current();
        // An exact prior reference or Host receipt permits observation only.
        // A failed lookup never falls through to another Send.
        const existing = restored || await this.#ports.session.receipt(prepared.scope, originalId) !== null;
        current();
        if (existing) { this.restoreOriginals(session, [reference]); return { id: originalId, result: this.checkReceipt(session, originalId) }; }
        const operation = this.submitSend(session, reference, { type: 'send', text: context.text, selection: context.selection });
        void operation.result.catch(() => {}); return operation;
      } catch (error) {
        // No Submit occurred here. Retain the exact protected identity for
        // receipt lookup; neither failed observation nor navigation replays it.
        if (!this.#closed) this.restoreOriginals(session, [reference]);
        throw error;
      }
    });
  }
  fileScope(session: string): FileScope { return copy(this.#fileScope(this.#preparedEntry(session))); }
  /** Explicit pure Host inventory read; row text and caller-supplied IDs never
   * authorize a child. No transcript body or native discovery is requested. */
  refreshHistoryScopes(session: string): Promise<readonly HistoryScope[]> {
    const prepared = this.#preparedEntry(session); if (prepared.scopeRead) return prepared.scopeRead;
    if (!this.#ports.historyScopes) throw new SessionError('UNSUPPORTED');
    const binding = prepared.binding;
    const current = () => { this.#open(); const native = prepared.entry!.getSnapshot().native; if (prepared.binding !== binding || prepared.pendingBinding || native?.nativeSession !== binding.run.nativeSession || native.generation !== binding.run.generation) throw new SessionError('FENCED'); };
    const work = Promise.resolve().then(() => { current(); return this.#ports.historyScopes!(prepared.scope); }).then(input => {
      current(); if (!Array.isArray(input) || input.length > 32) throw new SessionError('FENCED');
      const seen = new Set<string>(), origin = canonical(binding.history.origin), root = canonical(binding.history);
      const scopes = input.map(value => {
        const scope = copy(validateHistoryScope(value)), key = canonical(scope);
        if (scope.kind !== binding.history.kind || canonical(scope.origin) !== origin || seen.has(key)) throw new SessionError('FENCED');
        seen.add(key); return Object.freeze({ ...scope, origin: Object.freeze(scope.origin) });
      });
      if (!seen.has(root)) throw new SessionError('FENCED');
      prepared.historyScopes = Object.freeze({ supported: true, state: 'observed', entries: Object.freeze(scopes.map(scope => { const native = prepared.historyScopes.entries.find(value => canonical(value.scope) === canonical(scope))?.native; return Object.freeze({ scope, ...(native ? { native } : {}) }); })) }); this.#historyViews.reconcile(session); this.#notifyPrepared(prepared); return scopes;
    }).catch(error => { if (!this.#closed && prepared.binding === binding) { prepared.historyScopes = Object.freeze({ supported: true, state: 'unavailable', entries: prepared.historyScopes.entries }); this.#historyViews.reconcile(session); this.#notifyPrepared(prepared); } throw error; });
    prepared.scopeRead = work; void work.finally(() => { if (prepared.scopeRead === work) prepared.scopeRead = null; }).catch(() => {}); return work;
  }
  /** The existing root stream carries the Host's exact inventory. No query,
   * discovery or child body read is caused by React or a delegation row. */
  #streamedHistoryScopes(prepared: Prepared): void {
    if (this.#closed || prepared.pendingBinding) return;
    const native = prepared.entry?.getSnapshot().native, binding = prepared.binding;
    if (!native || native.nativeSession !== binding.run.nativeSession || native.generation !== binding.run.generation) return;
    const snapshot = prepared.entry!.history.client.current;
    if (!snapshot || canonical(snapshot.scope) !== canonical(binding.history) || snapshot.scopeInventory === undefined || snapshot.scopeInventory.nativeGeneration !== binding.run.generation) return;
    if (prepared.historyScopes.state === 'observed' && canonical(prepared.historyScopes.entries) === canonical(snapshot.scopeInventory.entries)) return;
    prepared.historyScopes = Object.freeze({ supported: true, state: 'observed', entries: snapshot.scopeInventory.entries });
    this.#historyViews.reconcile(prepared.scope.session); this.#notifyPrepared(prepared);
  }
  /** Prepare a read-only facade from a current Host-proved inventory. Native
   * control, composer, callbacks, file writes and session actions are absent. */
  historyView(session: string, input: HistoryScope, viewKey = 'child'): ReadonlyHistoryView {
    const prepared = this.#preparedEntry(session), scope = copy(validateHistoryScope(input)), key = canonical(scope), binding = prepared.binding;
    const valid = () => { const native = prepared.entry!.getSnapshot().native; return !this.#closed && prepared.binding === binding && !prepared.pendingBinding && native?.nativeSession === binding.run.nativeSession && native.generation === binding.run.generation && prepared.historyScopes.state === 'observed' && prepared.historyScopes.entries.some(value => canonical(value.scope) === key); };
    if (!valid() || key === canonical(binding.history)) throw new SessionError('FENCED');
    return this.#historyViews.view(prepared.scope, scope, viewKey, binding, valid);
  }
  async reloadFiles(session: string): Promise<void> { const prepared = this.#preparedEntry(session); await this.#files.reload(this.#fileScope(prepared)); this.#open(); }
  async clearFile(session: string, fileId: string, expectedRevision: number): Promise<void> {
    const prepared = this.#preparedEntry(session);
    if (prepared.composer!.getSnapshot().value.fileIds.includes(fileId)) throw new FileError('BUSY', 'Detach this file from the retained composer before clearing its local bytes');
    await this.#files.clear(this.#fileScope(prepared), fileId, expectedRevision); this.#open();
  }
  /** Called synchronously only after local original protection committed. */
  submitSend(session: string, reference: OriginalReceiptReference, command: SendCommandFor<Harness>) {
    const prepared = this.#preparedEntry(session);
    if (reference.type !== 'send' || scopeKey(reference.scope) !== scopeKey(prepared.scope) || !this.#ports.receiptOwner || reference.owner !== this.#ports.receiptOwner(prepared.scope)) throw new SessionError('FENCED');
    return this.#submitMessage(session, reference, command);
  }
  #submitMessage(session: string, reference: OriginalReceiptReference, command: MessageCommandFor<Harness>) {
    const prepared = this.#preparedEntry(session);
    if (reference.type !== command.type || scopeKey(reference.scope) !== scopeKey(prepared.scope) || !this.#ports.receiptOwner || reference.owner !== this.#ports.receiptOwner(prepared.scope)) throw new SessionError('FENCED');
    return this.#sessions.request(prepared.scope, command, reference.id, reference.generation);
  }
  async saveFile(session: string, input: Parameters<FileWorkspace['saveDraft']>[1]) { const prepared = this.#preparedEntry(session), record = await this.#files.saveDraft(this.#fileScope(prepared), input); this.#open(); return record; }
  async uploadFile(session: string, fileId: string) { const prepared = this.#preparedEntry(session); this.#requireAccess(prepared.scope, 'fileWrite'); const artifact = await this.#files.upload(this.#fileScope(prepared), fileId); this.#open(); return artifact; }
  /** Explicit first-display capture. The file owner retains this exact source
   * identity and rechecks native path policy; presentation cannot grant roots. */
  async captureFile(session: string, input: Omit<FileInputs['capture'], 'scope' | 'historyScope'>, historyScope?: HistoryScope): Promise<ArtifactRef> {
    const prepared = this.#preparedEntry(session), scope = this.#fileScope(prepared);
    const artifact = await this.#fileCall('capture', { ...structuredClone(input), scope, ...(historyScope ? { historyScope: structuredClone(historyScope) } : {}) });
    if (fileKey(artifact.owner) !== fileKey(scope)) throw new FileError('FENCED');
    return artifact;
  }
  /** Resolve a streamed native attachment through the existing immutable file owner. */
  async previewCapturedFile(session: string, artifactId: string): Promise<ResourceLease> {
    const prepared = this.#preparedEntry(session);
    const status = await this.#fileCall('status', { scope: this.#fileScope(prepared), id: artifactId }); this.#open();
    if (status.state !== 'committed') throw new FileError('NOT_FOUND');
    return this.previewFile(session, status.artifact);
  }
  async previewFile(session: string, artifact: ArtifactRef): Promise<ResourceLease> {
    const prepared = this.#preparedEntry(session); if (fileKey(artifact.owner) !== fileKey(this.#fileScope(prepared))) throw new FileError('FENCED');
    const resource = await this.#resources.acquire(artifact); if (this.#closed) { resource.release(); throw new SessionError('CLOSED'); }
    let released = false; const lease: ResourceLease = Object.freeze({ ...resource, release: () => { if (released) return; released = true; this.#previews.delete(lease); resource.release(); } }); this.#previews.add(lease); return lease;
  }
  #fileScope(prepared: Prepared): FileScope { return { ...prepared.scope, session: prepared.binding.history.origin.nativeSession }; }
  /** Prepare outside render. No mounted/transport reference is acquired here. */
  view(session: string, viewKey = 'main'): WorkspaceView {
    const prepared = this.#preparedEntry(session); id(viewKey); const old = prepared.views.get(viewKey); if (old) return old;
    if (prepared.views.size >= this.#views) throw new SessionError('FULL');
    const history = prepared.entry!.history.client.view(viewKey); let previous: readonly unknown[] | undefined, cached: AgentSnapshot, older: ReturnType<WorkspaceView['loadOlder']> | undefined;
    const submitDraft: WorkspaceView['submitDraft'] = (action, isCurrent) => {
      this.#open(); const binding = prepared.binding, follow = history.viewport.captureFollow();
      return prepared.send!.start(action, () => { if (!this.#closed && prepared.binding === binding && (!isCurrent || isCurrent())) follow(); });
    };
    const getSnapshot = (): AgentSnapshot => {
      if (this.#closed) return disposed;
      const sessionState = prepared.entry!.getSnapshot(), logical = prepared.logical.getSnapshot(), historyState = history.getSnapshot(), interactions = this.#interactions.entry(prepared.scope).getSnapshot(), mcp = this.#mcp.entry(prepared.binding.run).getSnapshot(), files = this.#files.getSnapshot(), composer = prepared.composer!.getSnapshot();
      const sendPreparation = prepared.send!.getSnapshot(), observation = this.#observations.get(scopeKey(prepared.scope)) ?? unobserved, access = this.#access(prepared.scope);
      const next = [sessionState, logical, historyState, interactions, mcp, files, composer, sendPreparation, prepared.modelCatalog, prepared.historyScopes, prepared.goalForm.getSnapshot(), prepared.plans.getSnapshot(), observation, prepared.pendingBinding, prepared.binding, prepared.ready, access.read, access.control, access.fileWrite, access.mcpRefresh, access.catalogWrite]; if (previous?.every((value, index) => value === next[index])) return cached; previous = next;
      const operations = new Map<string, OperationStatus>();
      for (const operation of sessionState.operations) operations.set(operation.original.id, operationStatus(operation.original, operation.receipt, operation.transmission === 'pending'));
      for (const operation of interactions.operations) operations.set(operation.id, operationStatus({ id: operation.id, type: 'answer', generation: operation.generation }, operation.receipt, operation.state === 'sending'));
      const { operations: _, ...safeSession } = sessionState, agent = this.#sessions.agent(prepared.scope);
      const { draft: omittedLogicalDraft, ...safeLogical } = logical;
      const common = { sessionId: session, viewKey, logical: Object.freeze(safeLogical), session: Object.freeze(safeSession), access, history: historyState, historyScopes: Object.freeze({ supported: prepared.historyScopes.supported, state: prepared.historyScopes.state, scopes: Object.freeze(prepared.historyScopes.entries.map(value => value.scope)) }), agents: agentSummaries(prepared.historyScopes.entries, historyState, { current: prepared.historyScopes.state === 'observed' && !prepared.pendingBinding, stopped: sessionState.native?.phase === 'stopped', live: observation.history === 'live' }), composer, sendReady: this.#sendRun(prepared, sessionState, access) !== null, sendPreparation, draftActions: this.#draftActions(prepared), modelCatalog: prepared.modelCatalog, files: Object.freeze(files.records.filter(value => fileKey(value.scope) === fileKey(this.#fileScope(prepared)))), confirmations: interactions.snapshot, confirmationsStale: interactions.stale, confirmationResponses: interactions.operations, mcp: mcp.snapshot, mcpStale: mcp.stale, operations: Object.freeze([...operations.values()]), observation, bindingTransition: prepared.pendingBinding ? Object.freeze({ state: prepared.pendingBinding.state, run: prepared.pendingBinding.binding.run }) : null };
      const stop = (action: () => OperationHandle) => () => {
        // An old action closure may refuse its native generation. It must not
        // cancel a newer generation's local preparation before that refusal.
        if (prepared.entry!.getSnapshot().native?.generation === sessionState.native?.generation) prepared.send!.invalidate();
        return action();
      };
      if (agent.kind === 'unsupported') cached = Object.freeze({ ...common, kind: 'unavailable' });
      else if (agent.kind === 'codex') { const { answer: _, ...actions } = agent.actions; cached = Object.freeze({ ...common, kind: 'codex', goalForm: prepared.goalForm.getSnapshot(), planActions: Object.freeze(prepared.plans.getSnapshot().filter(value => value.runKey === canonical([prepared.binding.run, sessionState.native?.epoch, this.#ports.receiptOwner?.(prepared.scope)])).map(({ rowId, originalId }) => Object.freeze({ rowId, originalId }))), actions: Object.freeze({ ...actions, stop: stop(actions.stop), ...(actions.setGoal ? { goalEditor: this.#goalEditor(prepared) } : {}) }) }); }
      else { const { answer: _, ...actions } = agent.actions; cached = Object.freeze({ ...common, kind: 'copilot', actions: Object.freeze({ ...actions, stop: stop(actions.stop) }) }); }
      return cached;
    };
    const facade: WorkspaceView = Object.freeze({ getSnapshot, getServerSnapshot: getSnapshot,
      subscribe: listener => {
        if (this.#closed) return () => {};
        const notify = () => { try { listener(); } catch { /* One consumer cannot block state or auth disposal. */ } };
        let releases: (() => void)[] = [], released = false;
        const connect = () => { releases.forEach(release => release()); releases = [prepared.logical.subscribe(notify), prepared.entry!.subscribe(notify), history.subscribe(notify), prepared.composer!.subscribe(notify), this.#interactions.entry(prepared.scope).subscribe(notify), this.#mcp.entry(prepared.binding.run).subscribe(notify), this.#files.subscribe(notify)]; };
        const refresh = () => { if (released || this.#closed) return; connect(); notify(); };
        const release = () => { if (released) return; released = true; releases.forEach(release => release()); prepared.rebound.delete(refresh); prepared.observers.delete(notify); this.#disposals.delete(notifyClosed); };
        const notifyClosed = () => { release(); notify(); }; connect(); prepared.rebound.add(refresh); prepared.observers.add(notify); this.#disposals.add(notifyClosed);
        return release;
      },
      observe: () => { this.#open(); const lease = prepared.entry!.history.mount(viewKey); try { this.#reconcile(prepared); } catch (error) { lease.release(); throw error; } let released = false; return Object.freeze({ release: () => { if (released) return; released = true; lease.release(); this.#reconcile(prepared); } }); },
      setPinned: pinned => this.setPinned(session, pinned),
      rebind: () => this.rebind(session),
      checkReceipt: originalId => this.checkReceipt(session, originalId),
      publishArchive: (originalId, generation) => this.publishArchive(session, originalId, generation),
      refreshMcp: () => this.refreshMcp(session),
      refreshHistoryScopes: () => this.refreshHistoryScopes(session),
      historyView: (scope, key) => this.historyView(session, scope, key),
      saveFile: input => this.saveFile(session, input),
      uploadFile: fileId => this.uploadFile(session, fileId),
      clearFile: (fileId, revision) => this.clearFile(session, fileId, revision),
      captureFile: (input, historyScope) => this.captureFile(session, input, historyScope),
      previewFile: artifact => this.previewFile(session, artifact),
      previewCapturedFile: artifactId => this.previewCapturedFile(session, artifactId),
      viewport: Object.freeze<WorkspaceView['viewport']>({
        report: anchor => { this.#open(); history.viewport.report(anchor); },
        userScroll: (direction, atTail) => { this.#open(); history.viewport.userScroll(direction, atTail); },
        followLatest: () => { this.#open(); history.viewport.followLatest(); },
        captureFollow: () => { this.#open(); const binding = prepared.binding, follow = history.viewport.captureFollow(); return () => { if (!this.#closed && prepared.binding === binding) follow(); }; },
        tailPosition: (scrollTop, maximum, editingPrompt) => { this.#open(); return history.viewport.tailPosition(scrollTop, maximum, editingPrompt); },
        beginRestore: () => { this.#open(); return history.viewport.beginRestore(); },
        correct: (token, geometry) => { this.#open(); return history.viewport.correct(token, geometry); },
      }),
      setExpanded: (rowId, expanded) => { this.#open(); history.expand(rowId, expanded); },
      loadOlder: retryToken => {
        this.#open(); if (older) return older; if (!this.#ports.older) throw new SessionError('UNSUPPORTED');
        const token = history.beginOlderRead(), work = Promise.resolve().then(() => { this.#open(); return this.#ports.older!(prepared.scope, token.scope, token.cursor, token.generation, retryToken); }).then(page => { this.#open(); return history.applyPage(page, token); }).finally(() => history.finishOlderRead(token));
        older = work; void work.finally(() => { if (older === work) older = undefined; }).catch(() => {}); return work;
      },
      recoverHistory: async (observation = {}, retryToken) => {
        this.#open(); const binding = prepared.binding;
        if (!this.#ports.recover) return { state: 'value', value: { status: 'unsupported' } };
        const result = await this.#ports.recover(prepared.scope, binding.history, observation, retryToken); this.#open();
        return binding !== prepared.binding ? { state: 'retired' } : result;
      },
      refreshControls: () => {
        this.#open(); if (prepared.catalogRead) return prepared.catalogRead;
        prepared.modelCatalog = Object.freeze({ state: 'loading', value: prepared.modelCatalog.value }); this.#notifyPrepared(prepared);
        const binding = prepared.binding, generation = prepared.entry!.getSnapshot().native?.generation, work = Promise.resolve().then(async () => {
          this.#open();
          if (!this.#ports.controlCatalog) throw new SessionError('UNSUPPORTED');
          const value = validateCatalog(await this.#ports.controlCatalog(prepared.scope)); this.#open();
          if (binding !== prepared.binding || generation !== prepared.entry!.getSnapshot().native?.generation) throw new SessionError('FENCED');
          prepared.modelCatalog = Object.freeze({ state: value.available ? 'available' : 'unavailable', value }); this.#notifyPrepared(prepared); return value;
        }).catch(error => { if (!this.#closed) { prepared.modelCatalog = Object.freeze({ state: 'unavailable', value: prepared.modelCatalog.value }); this.#notifyPrepared(prepared); } throw error; });
        prepared.catalogRead = work; void work.finally(() => { if (prepared.catalogRead === work) prepared.catalogRead = null; }).catch(() => {}); return work;
      },
      form: prompt => { this.#open(); return this.#interactions.form(prepared.scope, prompt); },
      setDraft: value => this.setDraft(session, value),
      submitDraft,
      sendDraft: () => submitDraft('send'),
      implementPlan: rowId => this.implementPlan(session, rowId, viewKey),
      respond: (prompt, answer, operationId) => {
        this.#open(); const native = prepared.entry!.getSnapshot().native;
        if (!native || native.nativeSession === null || native.nativeSession !== prepared.binding.run.nativeSession || !sameRun(prompt.run, { scope: prepared.scope, generation: native.generation, nativeSession: native.nativeSession })) throw new SessionError('FENCED');
        return this.#interactions.answer(prepared.scope, prompt, answer, operationId);
      },
    });
    prepared.views.set(viewKey, facade); return facade;
  }
  disconnect(): void { this.#open(); this.#ports.disconnect?.(); this.#connection(false); }
  reconnect(): void { this.#open(); this.#ports.reconnect?.(); this.#connection(true); }
  #connection(connected: boolean): void {
    if (this.#closed || connected === this.#connected) return; this.#connected = connected; this.#catalog.setConnected(connected); this.#sessions.setConnected(connected);
    for (const prepared of this.#prepared.values()) if (prepared.entry) {
      this.#interactions.setConnected(prepared.scope, connected); this.#mcp.setConnected(prepared.binding.run, connected);
      const candidate = prepared.pendingBinding;
      if (candidate?.state === 'preparing' && !sameRun(candidate.binding.run, prepared.binding.run)) this.#mcp.setConnected(candidate.binding.run, connected);
    }
  }
  /** Auth namespace disposal only. Never Stop/archive/delete or clear persisted user file intent. */
  close(): void {
    if (this.#draining) return; this.#draining = true;
    try {
      if (!this.#closed) {
        this.#closed = true;
        // Fence every public view before renderer callbacks or external cleanup.
        for (const notify of [...this.#disposals]) try { notify(); } catch {} this.#disposals.clear();
        this.#cleanup.add(this.#releaseCatalog); this.#catalogListeners.clear();
        for (const prepared of this.#prepared.values()) {
          for (const owner of [prepared.send, prepared.plans]) if (owner) this.#cleanup.add(() => { const drain = owner.close(); if (drain) this.#preparationDrains.push(drain); });
          this.#cleanup.add(() => prepared.goalForm.close());
          if (prepared.stream) { const stream = prepared.stream; this.#cleanup.add(() => stream.release()); }
          for (const release of prepared.retainedReleases) this.#cleanup.add(release);
          if (prepared.composer) { const composer = prepared.composer; this.#cleanup.add(() => composer.close()); }
        }
        for (const resource of this.#previews) this.#cleanup.add(() => resource.release());
        for (const close of [() => this.#resources.close(), () => this.#ports.close(), () => this.#interactions.close(), () => this.#mcp.close(), () => this.#catalog.close(), () => this.#files.close()]) this.#cleanup.add(close);
        this.#prepared.clear(); this.#observations.clear();
      }
      const errors: unknown[] = [];
      // These owners also accept handles returned after a reentrant close.
      for (const close of [() => this.#historyViews.close(), () => this.#sessions.close()]) try { close(); } catch (error) { errors.push(error); }
      for (const close of [...this.#cleanup]) try { close(); this.#cleanup.delete(close); } catch (error) { errors.push(error); }
      if (!errors.length && !this.#persistenceClosing) {
        this.#persistenceClosing = true;
        const closePersistence = () => { try { this.#persistence.close(); } catch {} };
        if (this.#preparationDrains.length) void Promise.allSettled(this.#preparationDrains).then(closePersistence); else closePersistence();
      }
      if (errors.length) throw new AggregateError(errors, 'Workspace observations failed to retire');
    } finally { this.#draining = false; }
  }
}
