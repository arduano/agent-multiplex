import { initTRPC, TRPCError, type AnyRouter } from '@trpc/server';
import type { HostContext, HostManifest } from '../../../v8-plugins/src/contracts.js';
import type { CreateRequest, HostCreationPort, HostCreationStatus } from '../../../v8-catalog/src/contracts/types.js';
import { canonical, copy, id } from '../../../v8-session/src/contracts/validation.js';
import { scopeKey, type NativeRead, type Receipt, type RunRef, type SessionSnapshot, type Submit } from '../../../v8-session/src/contracts/types.js';
import type { InteractionSnapshot } from '../../../v8-interactions/src/contracts.js';
import type { McpSnapshot } from '../../../v8-mcp/src/contracts.js';
import { validateScope } from '../../../v8-history/src/contracts/validation.js';
import type { Cursor, Scope } from '../../../v8-history/src/contracts/types.js';
import type { HostRpcTarget } from '../contracts/rpc.js';
import { hostRpcKey, hostRpcTarget, rpcFault } from '../contracts/rpc.js';
import { GatewayError, targetScope, type GatewayAction, type SessionRoute } from '../contracts/types.js';
import { ViewerQueue } from '../contracts/queue.js';
import { historyRetryToken } from '../contracts/validation.js';
import { createHostFileFacade, hostFileAction } from './host-files.js';

type ProcedureType = 'query' | 'mutation' | 'subscription';
const procedures: Readonly<Record<string, readonly [ProcedureType, GatewayAction]>> = Object.freeze({
  describe: ['query', 'read'], list: ['query', 'read'], sessions: ['subscription', 'read'],
  create: ['mutation', 'catalogWrite'], createAdmitted: ['mutation', 'catalogWrite'], creation: ['query', 'read'], creationWatch: ['subscription', 'read'], archiveProof: ['query', 'read'],
  snapshot: ['query', 'read'], binding: ['query', 'read'], controlCatalog: ['query', 'read'],
  submit: ['mutation', 'control'], receipt: ['query', 'read'], sessionWatch: ['subscription', 'read'], receiptWatch: ['subscription', 'read'],
  nativeRead: ['query', 'read'], mcpLoginLink: ['query', 'control'], historyScopes: ['query', 'read'], historyAuthorize: ['mutation', 'read'],
  historyWatch: ['subscription', 'read'], older: ['mutation', 'read'], recover: ['mutation', 'read'],
  interactions: ['query', 'read'], interactionsWatch: ['subscription', 'read'],
  mcp: ['query', 'read'], mcpWatch: ['subscription', 'read'], mcpRefresh: ['mutation', 'mcpRefresh'],
});

/** Use the same trusted policy when issuing and verifying Host proofs. A
 * read-exception mutation is still read; Create never borrows control access. */
export function hostFacadeAction(path: string, type: ProcedureType): GatewayAction {
  const files = hostFileAction(path, type); if (files) return files;
  if (!path.startsWith('multiplex.')) return type === 'mutation' ? 'control' : 'read';
  const rule = procedures[path.slice('multiplex.'.length)];
  if (!rule || rule[0] !== type) throw new GatewayError('FORBIDDEN');
  return rule[1];
}

/** This port references the actual Host's existing owners. It contains no
 * catalog, session state, native acquisition, receipt journal or retry policy.
 * watchSessions publishes complete committed IDs, including an initial value.
 * session() returns an observation route whose lifetime is owned by the Host. */
export type HostFacadeSource = Readonly<{
  target: HostRpcTarget;
  manifest: HostManifest;
  actions: readonly GatewayAction[];
  listSessions(): readonly string[] | Promise<readonly string[]>;
  watchSessions(listener: (ids: readonly string[]) => void): (() => void) | Promise<() => void>;
  session(id: string): SessionRoute;
  creation: HostCreationPort;
}>;

type SessionInput = Readonly<{ session: string }>;
type HistoryInput = SessionInput & Readonly<{ scope: Scope }>;
type RunInput = SessionInput & Readonly<{ run: RunRef }>;
function input<T>(value: unknown): T {
  try { canonical(value, 65536); } catch { throw new GatewayError('INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GatewayError('INVALID');
  return copy(value) as T;
}
function wireValue(value: unknown): unknown {
  // The published codec forbids shared object references. Owner DTOs may
  // legitimately reuse scope/run objects; JSON detaches those aliases here.
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).byteLength > 1048576) throw new GatewayError('FULL');
  return JSON.parse(encoded);
}
async function* wireStream(source: AsyncIterable<unknown>) {
  try { for await (const value of source) yield wireValue(value); } catch (error) { throw facadeFault(error); }
}
function facadeFault(error: unknown): TRPCError {
  const cause = error instanceof TRPCError ? error.cause ?? error : error;
  const code = (cause as { code?: string } | null)?.code;
  const codes: Readonly<Record<string, TRPCError['code']>> = {
    INVALID: 'BAD_REQUEST', FENCED: 'PRECONDITION_FAILED', FORBIDDEN: 'FORBIDDEN', UNAUTHENTICATED: 'UNAUTHORIZED',
    UNAVAILABLE: 'NOT_FOUND', CLOSED: 'NOT_FOUND', FULL: 'TOO_MANY_REQUESTS', OVERFLOW: 'TOO_MANY_REQUESTS',
    CONFLICT: 'CONFLICT', BUSY: 'TOO_MANY_REQUESTS', IO: 'NOT_FOUND', TIMEOUT: 'TIMEOUT', CANCELLED: 'CLIENT_CLOSED_REQUEST',
  };
  const safe = code && codes[code] || (error instanceof TRPCError ? error.code : 'INTERNAL_SERVER_ERROR');
  return new TRPCError({ code: safe, message: safe });
}

/** A direct Host endpoint, beside the existing plugin router. The caller merges
 * this reserved `multiplex` namespace into that router and uses
 * createHostPeerContext for BOTH real Peer authentication and active Host
 * composition verification. It must never expose a browser/asserted context. */
export function createHostFacade(source: HostFacadeSource) {
  const target = hostRpcTarget(source.target), actions = Object.freeze([...source.actions]);
  if (source.creation.target.host !== target.host || source.creation.target.owner !== target.owner) throw new GatewayError('FENCED');
  const streams = new Set<ViewerQueue<unknown>>(), lifetime = new AbortController();
  let closed = false;
  const active = () => { if (closed) throw new GatewayError('CLOSED'); };
  const t = initTRPC.context<HostContext>().create({ errorFormatter({ shape, error }) {
    const fault = rpcFault(error.cause ?? error);
    const { stack: _stack, ...data } = shape.data;
    return { ...shape, message: fault.code, data };
  } });
  const authorize = (ctx: HostContext, action: GatewayAction) => {
    active(); const actual = { ...ctx.route, connection: ctx.identity.connection, principal: ctx.identity.principal };
    if (hostRpcKey(hostRpcTarget(actual)) !== hostRpcKey(target) || !ctx.identity.actions.includes(action) || !actions.includes(action)) throw new GatewayError('FORBIDDEN');
  };
  const p = t.procedure.use(async ({ ctx, path, type, next }) => {
    try {
      active(); const action = hostFacadeAction(path, type);
      authorize(ctx, action);
      const release = ctx.admit?.({ path, type });
      try {
        const result = await next(); if (!result.ok) return { ...result, error: facadeFault(result.error) };
        const data: unknown = result.data;
        return { ...result, data: data && typeof data === 'object' && Symbol.asyncIterator in data
          ? wireStream(data as AsyncIterable<unknown>) : wireValue(data) };
      } finally { release?.(); }
    } catch (error) { throw facadeFault(error); }
  });
  const hostScope = (context: HostContext) => { active(); if (context.session) throw new GatewayError('FENCED'); };
  const ids = (values: readonly string[]) => {
    if (!Array.isArray(values) || values.length > 4096) throw new GatewayError('FULL');
    for (const value of values) id(value);
    if (new Set(values).size !== values.length) throw new GatewayError('FENCED');
    return [...values];
  };
  const route = async (context: HostContext, session: string, action: GatewayAction = 'read') => {
    active(); id(session);
    if (context.session && context.session.id !== session) throw new GatewayError('FENCED');
    const value = source.session(session), { session: _session, ...host } = value.target;
    if (value.target.session !== session || hostRpcKey(hostRpcTarget(host)) !== hostRpcKey(target)
      || value.actions && !value.actions.includes(action)) throw new GatewayError('FENCED');
    if (context.session) {
      const snapshot = await value.session.snapshot(targetScope(value.target)); active();
      if (snapshot.generation !== context.session.generation) throw new GatewayError('FENCED');
    }
    return value;
  };
  const history = (value: SessionRoute, scope: Scope) => {
    const result = validateScope(scope), origin = result.origin;
    if (origin.connection !== target.connection || origin.principal !== target.principal || origin.host !== target.host
      || !value.authorizeHistory(result)) throw new GatewayError('FENCED');
    return result;
  };
  const run = (value: SessionRoute, requested: RunRef) => {
    if (scopeKey(requested.scope) !== scopeKey(targetScope(value.target))) throw new GatewayError('FENCED');
    return requested;
  };
  const original = (context: HostContext, request: CreateRequest) => {
    hostScope(context);
    if (request.scope.connection !== target.connection || request.scope.principal !== target.principal || request.scope.authority !== target.authority
      || canonical(request.target) !== canonical(source.creation.target)) throw new GatewayError('FENCED');
    return request;
  };
  async function* observe<T>(start: (emit: (value: T) => void) => (() => void) | Promise<() => void>, signal?: AbortSignal) {
    active(); const queue = new ViewerQueue<T>(16, 1048576); streams.add(queue as ViewerQueue<unknown>);
    let release: (() => void) | undefined, ended = false;
    queue.setCleanup(() => { ended = true; streams.delete(queue as ViewerQueue<unknown>); release?.(); });
    const abort = () => { void queue.return(); }; signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) return;
      release = await start(value => { if (!ended) queue.push(copy(value)); });
      if (ended) release();
      yield* queue;
    } finally { signal?.removeEventListener('abort', abort); await queue.return(); }
  }
  const router = t.router({ multiplex: t.router({
    describe: p.input(input<Record<string, never>>).query(({ ctx }) => { hostScope(ctx); return { target, manifest: source.manifest }; }),
    list: p.input(input<Record<string, never>>).query(({ ctx }) => { hostScope(ctx); return Promise.resolve(source.listSessions()).then(ids); }),
    sessions: p.input(input<Record<string, never>>).subscription(async function* ({ ctx, signal }) {
      hostScope(ctx); yield* observe<readonly string[]>(emit => source.watchSessions(value => emit(ids(value))), signal);
    }),
    create: p.input(input<{ original: CreateRequest }>).mutation(({ ctx, input }) => source.creation.create(original(ctx, input.original))),
    createAdmitted: p.input(input<{ original: CreateRequest }>).mutation(({ ctx, input }) => {
      const request = original(ctx, input.original); if (!source.creation.createAdmitted) throw new GatewayError('UNAVAILABLE');
      return source.creation.createAdmitted(request);
    }),
    creation: p.input(input<{ original: CreateRequest }>).query(({ ctx, input }) => source.creation.read(original(ctx, input.original))),
    archiveProof: p.input(input<{ original: CreateRequest; id: string; generation: number }>).query(({ ctx, input }) => {
      const request = original(ctx, input.original); if (!source.creation.readArchive) throw new GatewayError('UNAVAILABLE');
      return source.creation.readArchive(request, input.id, input.generation);
    }),
    creationWatch: p.input(input<{ original: CreateRequest }>).subscription(async function* ({ ctx, input, signal }) {
      const request = original(ctx, input.original); if (!source.creation.watch) throw new GatewayError('UNAVAILABLE');
      yield* observe<HostCreationStatus>(emit => source.creation.watch!(request, emit), signal);
    }),
    snapshot: p.input(input<SessionInput>).query(async ({ ctx, input }) => { const value = await route(ctx, input.session); return value.session.snapshot(targetScope(value.target)); }),
    binding: p.input(input<SessionInput>).query(async ({ ctx, input }) => { const value = await route(ctx, input.session); const binding = await value.binding?.() ?? null; if (binding) history(value, binding.history); return binding; }),
    controlCatalog: p.input(input<SessionInput>).query(async ({ ctx, input }) => { const value = await route(ctx, input.session); if (!value.controlCatalog) throw new GatewayError('UNAVAILABLE'); return value.controlCatalog(); }),
    submit: p.input(input<SessionInput & { request: Submit }>).mutation(async ({ ctx, input }) => {
      const value = await route(ctx, input.session, 'control');
      if (scopeKey(input.request.scope) !== scopeKey(targetScope(value.target)) || ctx.session && input.request.generation !== ctx.session.generation) throw new GatewayError('FENCED');
      return value.session.submit(input.request);
    }),
    receipt: p.input(input<SessionInput & { id: string }>).query(async ({ ctx, input }) => { const value = await route(ctx, input.session); id(input.id); return value.session.receipt(targetScope(value.target), input.id); }),
    sessionWatch: p.input(input<SessionInput>).subscription(async function* ({ ctx, input, signal }) { const value = await route(ctx, input.session); yield* observe<SessionSnapshot>(emit => value.session.subscribe(targetScope(value.target), emit), signal); }),
    receiptWatch: p.input(input<SessionInput & { id: string }>).subscription(async function* ({ ctx, input, signal }) {
      const value = await route(ctx, input.session); id(input.id); if (!value.session.subscribeReceipt) throw new GatewayError('UNAVAILABLE');
      yield* observe<Receipt>(emit => value.session.subscribeReceipt!(targetScope(value.target), input.id, emit), signal);
    }),
    nativeRead: p.input(input<RunInput & { request: NativeRead }>).query(async ({ ctx, input }) => { const value = await route(ctx, input.session); if (!value.session.read) throw new GatewayError('UNAVAILABLE'); return value.session.read(run(value, input.run), input.request); }),
    mcpLoginLink: p.input(input<RunInput & { originalId: string }>).query(async ({ ctx, input }) => {
      if (!ctx.identity.actions.includes('read') || !ctx.identity.actions.includes('control')) throw new GatewayError('FORBIDDEN');
      const value = await route(ctx, input.session, 'control'); await route(ctx, input.session, 'read'); id(input.originalId);
      if (!value.session.mcpLoginLink) throw new GatewayError('UNAVAILABLE');
      return value.session.mcpLoginLink(run(value, input.run), input.originalId);
    }),
    historyScopes: p.input(input<SessionInput>).query(async ({ ctx, input }) => { const value = await route(ctx, input.session); if (!value.history.scopes) throw new GatewayError('UNAVAILABLE'); return (await value.history.scopes()).map(scope => history(value, scope)); }),
    historyAuthorize: p.input(input<HistoryInput & { timeoutMs?: number }>).mutation(async ({ ctx, input }) => {
      const value = await route(ctx, input.session), scope = validateScope(input.scope), origin = scope.origin;
      if (origin.connection !== target.connection || origin.principal !== target.principal || origin.host !== target.host) throw new GatewayError('FENCED');
      if (value.authorizeHistory(scope)) return { state: 'value' as const, value: true as const };
      if (!value.history.authorize) throw new GatewayError('FENCED');
      const result = await value.history.authorize(scope, input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs });
      if (result.state === 'value') history(value, scope); return result;
    }),
    historyWatch: p.input(input<HistoryInput & { cursor?: Cursor }>).subscription(async function* ({ ctx, input, signal }) {
      const value = await route(ctx, input.session), scope = history(value, input.scope), source = value.history.watch(scope, input.cursor);
      const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      const abort = () => { void source.return?.(); }; combined.addEventListener('abort', abort, { once: true });
      try { if (!combined.aborted) yield* source; } finally { combined.removeEventListener('abort', abort); await source.return?.(); }
    }),
    older: p.input(input<HistoryInput & { cursor: string; generation?: string; retryToken?: string }>).mutation(async ({ ctx, input }) => { const value = await route(ctx, input.session); const retry = historyRetryToken(input.retryToken); if (!value.history.older) throw new GatewayError('UNAVAILABLE'); return value.history.older(history(value, input.scope), input.cursor, input.generation, retry); }),
    recover: p.input(input<HistoryInput & { timeoutMs?: number; retryToken?: string }>).mutation(async ({ ctx, input }) => { const value = await route(ctx, input.session); const retry = historyRetryToken(input.retryToken); if (!value.history.recover) return { state: 'value' as const, value: { status: 'unsupported' as const } }; return value.history.recover(history(value, input.scope), input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }, retry); }),
    interactions: p.input(input<SessionInput>).query(async ({ ctx, input }) => { const value = await route(ctx, input.session); if (!value.interactions) throw new GatewayError('UNAVAILABLE'); return value.interactions.snapshot(targetScope(value.target)); }),
    interactionsWatch: p.input(input<SessionInput>).subscription(async function* ({ ctx, input, signal }) { const value = await route(ctx, input.session); if (!value.interactions) throw new GatewayError('UNAVAILABLE'); yield* observe<InteractionSnapshot>(emit => value.interactions!.subscribe(targetScope(value.target), emit), signal); }),
    mcp: p.input(input<RunInput>).query(async ({ ctx, input }) => { const value = await route(ctx, input.session); if (!value.mcp) throw new GatewayError('UNAVAILABLE'); return value.mcp.snapshot(run(value, input.run)); }),
    mcpRefresh: p.input(input<RunInput & { timeoutMs?: number }>).mutation(async ({ ctx, input }) => { const value = await route(ctx, input.session, 'mcpRefresh'); if (!value.mcp) throw new GatewayError('UNAVAILABLE'); return value.mcp.refresh(run(value, input.run), input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }); }),
    mcpWatch: p.input(input<RunInput>).subscription(async function* ({ ctx, input, signal }) { const value = await route(ctx, input.session); if (!value.mcp) throw new GatewayError('UNAVAILABLE'); yield* observe<McpSnapshot>(emit => value.mcp!.subscribe(run(value, input.run), emit), signal); }),
  }) });
  const files = createHostFileFacade({ source, authorize, route });
  return Object.freeze({ router: t.mergeRouters(router, files.router), async close() {
    closed = true; lifetime.abort(); for (const queue of [...streams]) queue.finish();
    await files.close();
  } });
}

export type HostFacadeRouter = ReturnType<typeof createHostFacade>['router'];
export type HostPluginRouter = AnyRouter;
/** Keep the version-coupled router operation with the generic dependency. */
export function mergeHostFacade<Router extends AnyRouter>(router: Router, facade: HostFacadeRouter) {
  return initTRPC.context<HostContext>().create().mergeRouters(router, facade);
}
