import type { CreateRequest, HostCreationPort, HostCreationStatus, HostTarget } from '../../../v8-catalog/src/contracts/types.js';
import type { Scope } from '../../../v8-history/src/contracts/types.js';
import { validateScope } from '../../../v8-history/src/contracts/validation.js';
import { canonical, copy, id } from '../../../v8-session/src/contracts/validation.js';
import { scopeKey, type SessionSnapshot } from '../../../v8-session/src/contracts/types.js';
import { hostRpcExpected, hostRpcTarget, type HostRpcExpected, type HostRpcPort, type HostRpcRequest, type HostRpcTarget } from '../contracts/rpc.js';
import { GatewayError, targetScope, type GatewayAction, type GatewayErrorCode, type Identity, type SessionRoute, type GatewayBinding } from '../contracts/types.js';
import type { GatewayCoordinator } from '../gateway/coordinator.js';
import type { HostFacadeRouter } from './host-facade.js';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { HostManifest } from '../../../v8-plugins/src/contracts.js';
import type { RemoteFiles } from './remote-files.js';

type Results = inferRouterOutputs<HostFacadeRouter>['multiplex'];
type Inputs = inferRouterInputs<HostFacadeRouter>['multiplex'];
type Result<Name extends keyof Results> = Results[Name] extends AsyncIterable<infer Value> ? Value : Results[Name];
function remoteFault(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  const codes: Readonly<Record<string, GatewayErrorCode>> = { BAD_REQUEST: 'INVALID', UNAUTHORIZED: 'UNAUTHENTICATED', FORBIDDEN: 'FORBIDDEN',
    PRECONDITION_FAILED: 'FENCED', NOT_FOUND: 'UNAVAILABLE', TOO_MANY_REQUESTS: 'FULL', CONFLICT: 'CONFLICT', TIMEOUT: 'TIMEOUT', CLIENT_CLOSED_REQUEST: 'CANCELLED' };
  const value = error as { code?: string; data?: { code?: string } } | null;
  const code = value?.data?.code ?? value?.code;
  return new GatewayError(code && codes[code] || 'UNAVAILABLE');
}

/** Reachability can change without granting a different account, Host owner or
 * composition. Only the authenticated server-owned routeEpoch may refresh. */
export async function readRemoteHostDescriptor(options: Readonly<{
  port: HostRpcPort; identity: Identity; target: HostRpcTarget; expected: HostRpcExpected;
}>): Promise<Readonly<{ target: HostRpcTarget; manifest: HostManifest }>> {
  const target = hostRpcTarget(options.target), expected = hostRpcExpected(options.expected);
  try {
    const result = await options.port.call(options.identity, { target, expected, path: 'multiplex.describe', input: {}, type: 'query' }) as { target: unknown; manifest: HostManifest };
    const current = hostRpcTarget(result.target), { routeEpoch: _old, ...oldOwner } = target, { routeEpoch: _new, ...newOwner } = current;
    if (canonical(oldOwner) !== canonical(newOwner) || canonical(expected) !== canonical(hostRpcExpected(result.manifest))) throw new GatewayError('FENCED');
    return copy({ target: current, manifest: result.manifest });
  } catch (error) { throw remoteFault(error); }
}

/** Configured, owner-only remote edge. `port` must already pin the actual Peer
 * identity/protocol; `expected` is independently configured, never learned from
 * an untrusted ticket. The original caller account and exact edge ceiling are
 * forwarded, rather than a shared service identity. No command is retried. */
export function createRemoteHost(options: Readonly<{
  target: HostRpcTarget; expected: HostRpcExpected; creationTarget: HostTarget;
  identity: Identity; actions: readonly GatewayAction[]; port: HostRpcPort;
  /** Trusted static Host capability. Never infer positive admission from the
   * legacy create reply, transport ACK or a timeout. Unsupported Hosts fail. */
  positiveCreationAdmission?: true;
  files?: Pick<RemoteFiles, 'session'>;
}>) {
  const target = hostRpcTarget(options.target), expected = hostRpcExpected(options.expected), identity = copy(options.identity);
  const actions = Object.freeze([...options.actions]), creationTarget = copy(options.creationTarget);
  if (canonical(hostRpcExpected(options.port.manifest)) !== canonical(expected)
    || creationTarget.host !== target.host || creationTarget.owner !== target.owner) throw new GatewayError('FENCED');
  if (identity.connection !== target.connection || identity.principal !== target.principal || !identity.authorities.includes(target.authority)
    || actions.some(action => !identity.actions.includes(action))) throw new GatewayError('FORBIDDEN');
  const caller = { ...identity, actions }, lifetime = new AbortController(), routes = new Set<{ close(): void }>();
  const failures = new Set<() => void>(); let closed = false;
  const active = () => { if (closed) throw new GatewayError('CLOSED'); };
  const request = (name: string, input: unknown): HostRpcRequest => ({ target, expected, path: `multiplex.${name}`, input: JSON.parse(canonical(input, 65536)) });
  const call = async <Name extends keyof Results>(name: Name, input: Inputs[Name], type: 'query' | 'mutation' = 'query'): Promise<Result<Name>> => {
    active();
    try { const value = await options.port.call(caller, { ...request(name, input), type }); active(); return value as Result<Name>; }
    catch (error) { throw remoteFault(error); }
  };
  // A read observer can leave while its actual Peer/Host work remains owned.
  // Never pass viewer cancellation to raw published stream admission.
  const observed = <T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    active(); if (signal?.aborted) return Promise.reject(new GatewayError('CANCELLED'));
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (settle: () => void) => { if (done) return; done = true; signal?.removeEventListener('abort', abort); lifetime.signal.removeEventListener('abort', close); settle(); };
      const abort = () => finish(() => reject(new GatewayError('CANCELLED'))), close = () => finish(() => reject(new GatewayError('CLOSED')));
      signal?.addEventListener('abort', abort, { once: true }); lifetime.signal.addEventListener('abort', close, { once: true });
      try { void work().then(value => finish(() => resolve(value)), error => finish(() => reject(error))); } catch (error) { finish(() => reject(error)); }
    });
  };
  const failed = () => { for (const listener of [...failures]) listener(); };
  async function* watch<Name extends keyof Results>(name: Name, input: Inputs[Name], signal: AbortSignal): AsyncIterable<Result<Name>> {
    active();
    try {
      yield* options.port.watch(caller, request(name, input), AbortSignal.any([signal, lifetime.signal])) as AsyncIterable<Result<Name>>;
      if (!signal.aborted && !lifetime.signal.aborted) throw new GatewayError('UNAVAILABLE');
    }
    catch (error) {
      // The inventory subscription owns Host reachability. A refused/stale
      // history or optional MCP subscription belongs to that observer; it
      // cannot retire every other session on an otherwise reachable Host.
      if (name === 'sessions' && !signal.aborted && !lifetime.signal.aborted) failed();
      throw remoteFault(error);
    }
  }
  const observe = <Name extends keyof Results>(name: Name, input: Inputs[Name], emit: (value: Result<Name>) => void) => {
    active(); const controller = new AbortController();
    void (async () => { try { for await (const value of watch(name, input, controller.signal)) emit(value); } catch { /* Reachability was retired by watch; native work is untouched. */ } })();
    return () => controller.abort();
  };
  const sessionRoute = (session: string): SessionRoute & { close(): void } => {
    active(); id(session); const routeTarget = Object.freeze({ ...target, session }), scope = targetScope(routeTarget);
    const releases = new Set<() => void>(), files = options.files?.session(session); let retired = false;
    type SnapshotFeed = {
      controller: AbortController;
      listeners: Map<() => void, { emit(value: unknown): void; failed?: (error: unknown) => void }>;
      latest: Readonly<{ value: unknown }> | undefined;
    };
    const feeds = new Map<string, SnapshotFeed>();
    const open = () => { active(); if (retired) throw new GatewayError('CLOSED'); };
    const exact = (value: typeof scope) => { open(); if (scopeKey(value) !== scopeKey(scope)) throw new GatewayError('FENCED'); };
    const boundScope = (value: Scope) => {
      const checked = validateScope(value), origin = checked.origin;
      if (origin.connection !== target.connection || origin.principal !== target.principal || origin.host !== target.host) throw new GatewayError('FENCED');
      return checked;
    };
    const snapshot = (value: SessionSnapshot) => {
      exact(value.scope); return value;
    };
    const retireFeed = (key: string, feed: SnapshotFeed, failure?: Readonly<{ error: unknown }>) => {
      const current = feeds.get(key) === feed;
      if (current) feeds.delete(key);
      feed.latest = undefined;
      feed.controller.abort();
      for (const [release, listener] of [...feed.listeners]) {
        if (!feed.listeners.has(release)) continue;
        release();
        if (failure && current && !retired) try { listener.failed?.(failure.error); } catch { /* Consumer isolation. */ }
      }
    };
    const subscribe = <Name extends 'sessionWatch' | 'receiptWatch' | 'interactionsWatch' | 'mcpWatch'>(name: Name, input: Inputs[Name], emit: (value: Result<Name>) => void, onError?: (error: unknown) => void) => {
      open();
      if ([...feeds.values()].reduce((count, feed) => count + feed.listeners.size, 0) >= 128) throw new GatewayError('FULL');
      const captured = copy(input), key = canonical({ name, input: captured }, 65536), prior = feeds.get(key);
      const feed: SnapshotFeed = prior ?? { controller: new AbortController(), listeners: new Map(), latest: undefined };
      if (!prior) feeds.set(key, feed);
      const stop = () => {
        if (!feed.listeners.delete(stop)) return;
        releases.delete(stop);
        if (!feed.listeners.size && feeds.get(key) === feed) retireFeed(key, feed);
      };
      const deliver = (value: unknown) => { try { emit(value as Result<Name>); } catch { /* Consumer isolation. */ } };
      feed.listeners.set(stop, { emit: deliver, ...(onError ? { failed: onError } : {}) }); releases.add(stop);
      if (feed.latest) deliver(feed.latest.value);
      if (!prior) void (async () => {
        try {
          for await (const value of watch(name, captured, feed.controller.signal)) {
            if (retired || feeds.get(key) !== feed) return;
            if (name === 'sessionWatch') snapshot(value as SessionSnapshot);
            const encoded = JSON.stringify(value);
            if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).byteLength > 1048576) throw new GatewayError('FULL');
            // These procedures publish complete snapshots, never history
            // deltas. One immutable baseline can serve every local lease.
            feed.latest = copy({ value });
            for (const [release, listener] of [...feed.listeners]) {
              if (retired || feeds.get(key) !== feed) break;
              if (feed.listeners.has(release)) listener.emit(feed.latest.value);
            }
          }
        } catch (error) { retireFeed(key, feed, { error }); }
        finally { retireFeed(key, feed); }
      })();
      return stop;
    };
    const route: SessionRoute & { close(): void } = {
      target: routeTarget, actions,
      ...(files ? { files: files.surface } : {}),
      session: {
        snapshot: async value => { exact(value); return snapshot(await call('snapshot', { session })); },
        submit: value => { exact(value.scope); return call('submit', { session, request: value }, 'mutation'); },
        receipt: (value, operation) => { exact(value); return call('receipt', { session, id: operation }); },
        read: (run, request) => { exact(run.scope); return call('nativeRead', { session, run, request }); },
        mcpLoginLink: (run, originalId) => { exact(run.scope); return call('mcpLoginLink', { session, run, originalId }); },
        subscribe: (value, emit, onError) => { exact(value); return subscribe('sessionWatch', { session }, emit, onError); },
        subscribeReceipt: (value, operation, emit) => { exact(value); return subscribe('receiptWatch', { session, id: operation }, emit); },
      },
      binding: async () => {
        open(); const value = await call('binding', { session });
        if (value) { boundScope(value.history); await files?.bind(value.run); }
        return value as GatewayBinding | null;
      },
      controlCatalog: () => { open(); return call('controlCatalog', { session }); },
      history: {
        scopes: async () => { open(); return (await call('historyScopes', { session })).map(boundScope); },
        watch(scope, cursor) {
          open(); const controller = new AbortController(), stop = () => { releases.delete(stop); controller.abort(); }; releases.add(stop);
          const source = (async function* () {
            try { yield* watch('historyWatch', { session, scope, ...(cursor ? { cursor } : {}) }, controller.signal); }
            finally { stop(); }
          })();
          // Async-generator return queues behind an outstanding next(). Abort
          // this exact observer first so a quiet upstream can finish that next.
          // observePeer retains any actual raw open until its own onStarted.
          return { [Symbol.asyncIterator]() { return this; }, next: () => source.next(),
            return: value => { stop(); return source.return(value); },
            throw: error => { stop(); return source.throw(error); } };
        },
        authorize: async (scope, observation) => {
          open(); const result = await observed(() => call('historyAuthorize', { session, scope, ...(observation?.timeoutMs !== undefined ? { timeoutMs: observation.timeoutMs } : {}) }, 'mutation'), observation?.signal);
          return result;
        },
        older: (scope, cursor, generation, retryToken) => { open(); return call('older', { session, scope, cursor, ...(generation !== undefined ? { generation } : {}), ...(retryToken !== undefined ? { retryToken } : {}) }, 'mutation'); },
        recover: (scope, observation, retryToken) => {
          open(); boundScope(scope);
          return observed(async () => {
            // Cold child recovery is an explicit exception path. Its canonical
            // Host must prove membership before reading a previously unseen
            // child's body; the Gateway retains no duplicate proof cache.
            const input = { session, scope, ...(observation?.timeoutMs !== undefined ? { timeoutMs: observation.timeoutMs } : {}), ...(retryToken !== undefined ? { retryToken } : {}) };
            const authorized = await call('historyAuthorize', input, 'mutation');
            if (authorized.state !== 'value') return authorized;
            return call('recover', input, 'mutation');
          }, observation?.signal);
        },
      },
      // This authenticated edge checks its account/Host envelope. The actual
      // Host facade proves native root/child membership and attachment on EACH
      // history request. A second Gateway proof cache would disappear on
      // remount and incorrectly fence retained clients with unchanged runs.
      authorizeHistory: scope => { open(); boundScope(scope); return true; },
      interactions: {
        snapshot: value => { exact(value); return call('interactions', { session }); },
        subscribe: (value, emit, onError) => { exact(value); return subscribe('interactionsWatch', { session }, emit, onError); },
      },
      mcp: {
        snapshot: run => { exact(run.scope); return call('mcp', { session, run }); },
        refresh: (run, observation) => { exact(run.scope); return observed(() => call('mcpRefresh', { session, run, ...(observation?.timeoutMs !== undefined ? { timeoutMs: observation.timeoutMs } : {}) }, 'mutation'), observation?.signal); },
        subscribe: (run, emit, onError) => { exact(run.scope); return subscribe('mcpWatch', { session, run }, emit, onError); },
      },
      close() { if (retired) return; retired = true; for (const release of [...releases]) release(); routes.delete(route); },
    };
    routes.add(route); return route;
  };
  const creation: HostCreationPort = Object.freeze({
    target: creationTarget,
    ...(options.positiveCreationAdmission ? { createAdmitted: (original: CreateRequest) => call('createAdmitted', { original }, 'mutation') } : {}),
    create: (original: CreateRequest) => call('create', { original }, 'mutation'),
    read: (original: CreateRequest) => call('creation', { original }),
    readArchive: (original: CreateRequest, id: string, generation: number) => call('archiveProof', { original, id, generation }),
    watch: async (original: CreateRequest, listener: (status: HostCreationStatus) => void) => observe('creationWatch', { original }, listener),
  });
  return Object.freeze({ target, actions, manifest: copy(options.port.manifest), creation, sessionRoute,
    listSessions: () => call('list', {}),
    watchSessions: (signal: AbortSignal) => watch('sessions', {}, signal),
    onUnavailable(listener: () => void) { active(); failures.add(listener); return () => { failures.delete(listener); }; },
    close() { if (closed) return; closed = true; lifetime.abort(); for (const route of [...routes]) route.close(); failures.clear(); },
  });
}

export type RemoteHost = ReturnType<typeof createRemoteHost>;

/** Mounts authenticated remote ports into the ONE existing Gateway. This owns
 * observation routes only. Disconnect/unmount never Stop, Resume or retry. */
export function mountRemoteHost(gateway: GatewayCoordinator, host: RemoteHost) {
  const controller = new AbortController(), routes = new Map<string, { route: ReturnType<RemoteHost['sessionRoute']>; release(): void }>();
  let closed = false, resolveReady!: () => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  const retire = () => { for (const { route } of routes.values()) gateway.unavailable(route.target); };
  const unsubscribe = host.onUnavailable(retire);
  const settled = (async () => {
    try {
      for await (const ids of host.watchSessions(controller.signal)) {
        if (closed) return;
        if (!Array.isArray(ids) || ids.length > 4096 || new Set(ids).size !== ids.length) throw new GatewayError('FENCED');
        for (const value of ids) id(value);
        for (const [session, entry] of routes) if (!ids.includes(session)) { entry.release(); entry.route.close(); routes.delete(session); }
        for (const session of ids) if (!routes.has(session)) {
          const route = host.sessionRoute(session);
          try { routes.set(session, { route, release: gateway.register(route) }); } catch (error) { route.close(); throw error; }
        }
        resolveReady();
      }
      if (!closed) throw new GatewayError('UNAVAILABLE');
    } catch (error) { if (!closed) { retire(); rejectReady(error); throw error; } }
  })();
  void settled.catch(() => {});
  return Object.freeze({ ready, settled,
    close() {
      if (closed) return; closed = true; controller.abort(); unsubscribe();
      rejectReady(new GatewayError('CLOSED'));
      for (const { route, release } of routes.values()) { release(); route.close(); } routes.clear();
    },
  });
}
