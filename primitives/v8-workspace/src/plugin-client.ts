import type { TRPCClient } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import type { HostManifest, HostRoute } from "../../v8-plugins/src/contracts.js";
import type { AgentSnapshot, WorkspaceView } from "./contracts.js";
import { copy } from '../../v8-session/src/contracts/validation.js';

export type PluginHostContract = {
  router: AnyRouter;
  harness: string;
  createInput: unknown;
  hostData: unknown;
  sessionData: unknown;
  extensions: Record<string, { hostData: unknown; sessionData: unknown }>;
};
export type PluginHostSet = Record<string, PluginHostContract>;
export type HostProjection<C extends PluginHostContract> = Readonly<{
  lifecycle: C["hostData"];
  extensions: { [K in keyof C["extensions"]]: C["extensions"][K]["hostData"] };
}>;
export type SessionProjection<C extends PluginHostContract> = Readonly<{
  lifecycle: C["sessionData"];
  extensions: { [K in keyof C["extensions"]]: C["extensions"][K]["sessionData"] };
}>;
export type PluginNamespace = Readonly<{ connection: string; principal: string }>;
export type PluginHostKey = PluginNamespace & HostRoute;
export type PluginSessionKey = Readonly<{ id: string; generation: number }>;
export type PluginObservation = "unobserved" | "connecting" | "live" | "disconnected" | "unsupported" | "disposed";
export type PluginProjection<T> = Readonly<{ observation: PluginObservation; value: T | null }>;
export type PluginLease = Readonly<{ release(): void }>;
function releaseLeases(...leases: readonly PluginLease[]): void {
  const failures: unknown[] = [];
  for (const lease of leases) { try { lease.release(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, "Plugin observation cleanup failed");
}
/** Supplied by the existing Gateway descriptor owner. Values are complete,
 * monotonically ordered snapshots for this exact scope. Its reconnect owner
 * fences stale callbacks and never submits a mutation or fetches history.
 */
export interface PluginSource<T> {
  subscribe(onValue: (value: T) => void, onObservation: (value: Exclude<PluginObservation, "unsupported" | "disposed">) => void): PluginLease;
}
type ExpectedManifest = Pick<HostManifest, "contractId" | "contractVersion" | "compositionId">;
type Registrations<H extends PluginHostSet> = { readonly [K in keyof H]: ExpectedManifest & { nativeKind: H[K]["harness"] } };
type HostState<H extends PluginHostSet, K extends keyof H> = {
  readonly hostKind: K;
  readonly client: TRPCClient<H[K]["router"]>;
  readonly manifest: HostManifest;
  readonly plugin: PluginProjection<HostProjection<H[K]>>;
};
export type PluginHostSnapshot<H extends PluginHostSet, K extends keyof H = keyof H> = { [P in K]: HostState<H, P> }[K];
type AgentFor<C extends PluginHostContract> = Extract<AgentSnapshot, { kind: C["harness"] | "unavailable" | "disposed" }>;
export type PluginAgentSnapshot<H extends PluginHostSet, K extends keyof H = keyof H> = {
  [P in K]: Readonly<{ hostKind: P; client: TRPCClient<H[P]["router"]>; manifest: HostManifest; plugin: PluginProjection<SessionProjection<H[P]>>; agent: AgentFor<H[P]> }>
}[K];
type ProjectionView<T> = Readonly<{
  subscribe(listener: () => void): () => void;
  getSnapshot(): PluginProjection<T>;
  getServerSnapshot(): PluginProjection<T>;
  observe(): PluginLease;
  setPinned(value: boolean): void;
}>;
export type PluginHostView<H extends PluginHostSet, K extends keyof H = keyof H> = {
  [P in K]: Readonly<{
    hostKind: P;
    key: PluginHostKey;
    manifest: HostManifest;
    client: TRPCClient<H[P]["router"]>;
    /** Inert client construction with an exact authenticated session route. */
    sessionClient(session: PluginSessionKey): TRPCClient<H[P]["router"]>;
    projection: ProjectionView<HostProjection<H[P]>>;
    getSnapshot(): PluginHostSnapshot<H, P>;
    getServerSnapshot(): PluginHostSnapshot<H, P>;
  }>
}[K];
export type PluginAgentView<H extends PluginHostSet, K extends keyof H = keyof H> = {
  [P in K]: Readonly<{
    host: PluginHostView<H, P>;
    session: PluginSessionKey;
    base: WorkspaceView;
    projection: ProjectionView<SessionProjection<H[P]>>;
    observe(): PluginLease;
    setPinned(value: boolean): void;
    getSnapshot(): PluginAgentSnapshot<H, P>;
    getServerSnapshot(): PluginAgentSnapshot<H, P>;
  }>
}[K];

class Projection<T> {
  readonly #listeners = new Set<() => void>();
  readonly #source: PluginSource<T>;
  #snapshot: PluginProjection<T>;
  #lease: PluginLease | undefined;
  #refs = 0;
  #pinned = false;
  #epoch = 0;
  #starting = false;
  constructor(source: PluginSource<T>, supported: boolean) {
    this.#source = source;
    this.#snapshot = Object.freeze({ observation: supported ? "unobserved" : "unsupported", value: null });
  }
  #notify(): void { for (const listener of [...this.#listeners]) { try { listener(); } catch { /* One renderer cannot block others or auth disposal. */ } } }
  #update(observation: PluginObservation, value = this.#snapshot.value): void { this.#snapshot = Object.freeze({ observation, value }); this.#notify(); }
  #reconcile(): void {
    if (this.#snapshot.observation === "unsupported" || this.#snapshot.observation === "disposed") return;
    if (!this.#refs && !this.#pinned) {
      this.#epoch++;
      const lease = this.#lease; this.#lease = undefined;
      lease?.release();
      return;
    }
    if (this.#lease || this.#starting) return;
    const epoch = ++this.#epoch;
    this.#starting = true;
    this.#update("connecting");
    try {
      const lease = this.#source.subscribe(value => { if (epoch === this.#epoch) this.#update("live", value); }, observation => { if (epoch === this.#epoch) this.#update(observation); });
      // A synchronous callback may dispose/unpin before subscribe returns.
      if (epoch !== this.#epoch || (!this.#refs && !this.#pinned)) lease.release();
      else this.#lease = lease;
    } catch { if (epoch === this.#epoch) this.#update("disconnected"); }
    finally {
      this.#starting = false;
      if (epoch !== this.#epoch && (this.#refs || this.#pinned)) this.#reconcile();
    }
  }
  readonly view: ProjectionView<T> = Object.freeze({
    subscribe: (listener: () => void) => {
      if (this.#snapshot.observation === "disposed") return () => {};
      this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
    },
    getSnapshot: () => this.#snapshot,
    getServerSnapshot: () => this.#snapshot,
    observe: () => {
      this.#refs++; this.#reconcile(); let released = false;
      return { release: () => { if (released) return; released = true; this.#refs--; this.#reconcile(); } };
    },
    setPinned: (value: boolean) => { this.#pinned = value; this.#reconcile(); },
  });
  dispose(): void {
    this.#epoch++; this.#pinned = false;
    const lease = this.#lease; this.#lease = undefined;
    this.#update("disposed", null);
    try { lease?.release(); } finally { this.#listeners.clear(); }
  }
}

function namespaceKey(key: PluginNamespace): string { return JSON.stringify([key.connection, key.principal]); }
function hostKey(key: PluginHostKey): string { return JSON.stringify([key.connection, key.principal, key.authority, key.host, key.owner, key.routeEpoch]); }
function equalManifest(expected: ExpectedManifest, manifest: HostManifest): boolean { return expected.contractId === manifest.contractId && expected.contractVersion === manifest.contractVersion && expected.compositionId === manifest.compositionId; }
function validateKey(key: PluginHostKey): void { for (const value of [key.connection, key.principal, key.authority, key.host, key.owner, key.routeEpoch]) if (typeof value !== "string" || !value.length || value.length > 256) throw new Error("Invalid authenticated plugin scope"); }

/** Retains only public plugin projections. Native state, history, originals,
 * drafts and session pins remain in the existing MultiplexWorkspace owners.
 */
export class PluginWorkspace<H extends PluginHostSet> {
  readonly #registrations: Registrations<H>;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, { namespace: string; projection: Projection<unknown>; view: unknown; agent?: { facades: WeakMap<WorkspaceView, unknown>; setPinned(value: boolean): void }; dispose?: () => void }>();
  readonly #views = new WeakSet<object>();
  readonly #disposedNamespaces = new Set<string>();
  #closed = false;
  constructor(registrations: Registrations<H>, options: { maxEntries?: number } = {}) {
    this.#registrations = copy(registrations);
    this.#maxEntries = options.maxEntries ?? 64;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1) throw new Error("Invalid plugin projection capacity");
  }
  #admit(key: PluginHostKey): void {
    validateKey(key);
    if (this.#closed || this.#disposedNamespaces.has(namespaceKey(key))) throw new Error("Plugin authentication namespace disposed");
    if (this.#entries.size >= this.#maxEntries) throw new Error("Plugin projection capacity full");
  }
  /** Terminal views remain renderable after auth disposal, with redacted data. */
  assertView(view: unknown): void { if (typeof view !== "object" || view === null || !this.#views.has(view)) throw new Error("Plugin view belongs to another workspace"); }
  prepareHost<K extends keyof H>(options: { hostKind: K; key: PluginHostKey; manifest: HostManifest; client: TRPCClient<H[K]["router"]>; sessionClient(session: PluginSessionKey): TRPCClient<H[K]["router"]>; source: PluginSource<HostProjection<H[K]>> }): PluginHostView<H, K> {
    options = { ...options, key: copy(options.key), manifest: copy(options.manifest) };
    const key = `host:${hostKey(options.key)}`;
    const existing = this.#entries.get(key);
    if (existing) {
      const view = existing.view as PluginHostView<H, K>;
      if (view.hostKind !== options.hostKind || !equalManifest(view.manifest, options.manifest)) throw new Error("Existing Host binding conflicts with selected contract");
      return view;
    }
    this.#admit(options.key);
    const expected = this.#registrations[options.hostKind];
    if (!expected) throw new Error("Unknown application Host kind");
    if (typeof options.sessionClient !== 'function') throw new Error('Exact session client factory required');
    const projection = new Projection(options.source, equalManifest(expected, options.manifest));
    let prior: PluginProjection<HostProjection<H[K]>> | undefined, snapshot: PluginHostSnapshot<H, K>;
    const getSnapshot = (): PluginHostSnapshot<H, K> => {
      const current = projection.view.getSnapshot();
      if (current !== prior) { prior = current; snapshot = Object.freeze({ hostKind: options.hostKind, client: options.client, manifest: options.manifest, plugin: current }) as PluginHostSnapshot<H, K>; }
      return snapshot;
    };
    const sessionClient = (session: PluginSessionKey): TRPCClient<H[K]['router']> => {
      if (projection.view.getSnapshot().observation === 'disposed') throw new Error('Plugin authentication namespace disposed');
      if (!session.id || !Number.isSafeInteger(session.generation) || session.generation < 1) throw new Error('Invalid plugin session scope');
      return options.sessionClient(copy(session));
    };
    const view = Object.freeze({ hostKind: options.hostKind, key: options.key, manifest: options.manifest, client: options.client, sessionClient, projection: projection.view, getSnapshot, getServerSnapshot: getSnapshot }) as PluginHostView<H, K>;
    this.#entries.set(key, { namespace: namespaceKey(options.key), projection: projection as Projection<unknown>, view });
    this.#views.add(view);
    return view;
  }
  prepareAgent<K extends keyof H>(host: PluginHostView<H, K>, options: { session: PluginSessionKey; base: WorkspaceView; source: PluginSource<SessionProjection<H[K]>> }): PluginAgentView<H, K> {
    options = { ...options, session: copy(options.session) };
    this.assertView(host);
    if (![...this.#entries.values()].some(entry => entry.view === host)) throw new Error("Plugin Host namespace disposed");
    if (!options.session.id || !Number.isSafeInteger(options.session.generation) || options.session.generation < 1) throw new Error("Invalid plugin session scope");
    const base = options.base.getSnapshot();
    if (base.kind === "disposed" || base.sessionId !== options.session.id) throw new Error("Plugin base session scope mismatch");
    const entry = base.logical.entry;
    if (!entry || entry.scope.connection !== host.key.connection || entry.scope.principal !== host.key.principal || entry.scope.authority !== host.key.authority || entry.target.host !== host.key.host || entry.target.owner !== host.key.owner) throw new Error("Plugin base Host scope mismatch");
    const native = base.session.native;
    if (native && (native.generation !== options.session.generation || native.scope.connection !== host.key.connection || native.scope.principal !== host.key.principal || native.scope.host !== host.key.host || native.scope.session !== options.session.id)) throw new Error("Plugin base generation mismatch");
    if (base.kind !== "unavailable" && base.kind !== this.#registrations[host.hostKind].nativeKind) throw new Error("Plugin base harness mismatch");
    const origin = base.history.current?.scope.origin;
    if (origin && (origin.connection !== host.key.connection || origin.principal !== host.key.principal || origin.host !== host.key.host)) throw new Error("Plugin base history origin mismatch");
    const key = `agent:${hostKey(host.key)}:${JSON.stringify([options.session.id, options.session.generation])}`;
    const existing = this.#entries.get(key);
    const priorFacade = existing?.agent?.facades.get(options.base);
    if (priorFacade) return priorFacade as PluginAgentView<H, K>;
    if (!existing) this.#admit(host.key);
    // Public plugin data belongs to the session. Loaded pages/anchors belong
    // to each actual WorkspaceView and must never be replaced by its sibling.
    const projection = existing ? existing.projection as Projection<SessionProjection<H[K]>> : new Projection(options.source, host.projection.getSnapshot().observation !== "unsupported");
    const client = host.sessionClient(options.session);
    let prior: readonly unknown[] | undefined, snapshot: PluginAgentSnapshot<H, K>, pinned: PluginLease | undefined;
    const observe = (): PluginLease => {
      if (projection.view.getSnapshot().observation === "disposed") return { release() {} };
      const base = options.base.observe(), custom = projection.view.observe(), parent = host.projection.observe(); let released = false;
      return { release: () => { if (released) return; released = true; releaseLeases(base, custom, parent); } };
    };
    const setPinned = existing?.agent?.setPinned ?? ((value: boolean): void => { if (value && !pinned) pinned = observe(); if (!value && pinned) { pinned.release(); pinned = undefined; } });
    const getSnapshot = (): PluginAgentSnapshot<H, K> => {
      const plugin = projection.view.getSnapshot(), agent = plugin.observation === "disposed" ? disposedAgent : options.base.getSnapshot();
      const next = [agent, plugin];
      if (!prior || prior.some((value, index) => value !== next[index])) { prior = next; snapshot = Object.freeze({ hostKind: host.hostKind, client, manifest: host.manifest, plugin, agent }) as PluginAgentSnapshot<H, K>; }
      return snapshot;
    };
    const view = Object.freeze({ host, session: options.session, base: options.base, projection: projection.view, observe, setPinned, getSnapshot, getServerSnapshot: getSnapshot }) as PluginAgentView<H, K>;
    const facades = existing?.agent?.facades ?? new WeakMap<WorkspaceView, unknown>();
    facades.set(options.base, view);
    if (!existing) this.#entries.set(key, { namespace: namespaceKey(host.key), projection: projection as Projection<unknown>, view, agent: { facades, setPinned }, dispose: () => { setPinned(false); } });
    this.#views.add(view);
    return view;
  }
  disposeNamespace(namespace: PluginNamespace): void {
    const key = namespaceKey(namespace);
    this.#disposedNamespaces.add(key);
    const failures: unknown[] = [];
    for (const [id, entry] of this.#entries) if (entry.namespace === key) {
      this.#entries.delete(id);
      try { entry.projection.dispose(); } catch (error) { failures.push(error); }
      try { entry.dispose?.(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Plugin namespace cleanup failed after redaction");
  }
  close(): void {
    if (this.#closed) return; this.#closed = true;
    const failures: unknown[] = [];
    for (const entry of this.#entries.values()) {
      try { entry.projection.dispose(); } catch (error) { failures.push(error); }
      try { entry.dispose?.(); } catch (error) { failures.push(error); }
    }
    this.#entries.clear();
    if (failures.length) throw new AggregateError(failures, "Plugin workspace cleanup failed after redaction");
  }
}
const disposedAgent = Object.freeze({ kind: "disposed" as const });
