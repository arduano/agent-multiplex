import { initTRPC, TRPCError } from '@trpc/server';
import type { FileSource, PreparedFileSource } from '@arduano/p2prpc-core';
import { FileError, assertId, scopeKey, type ArtifactRef, type FileErrorCode, type FileInputs, type FileScope } from '../../../v8-files/src/contracts/types.js';
import { defaultLimits } from '../../../v8-files/src/contracts/limits.js';
import { canonical, copy } from '../../../v8-session/src/contracts/validation.js';
import { sameRun, type RunRef } from '../../../v8-session/src/contracts/types.js';
import type { HostContext } from '../../../v8-plugins/src/contracts.js';
import type { HostFacadeSource } from './host-facade.js';
import type { GatewayAction, SessionRoute } from '../contracts/types.js';
import { GatewayError } from '../contracts/types.js';
import { HOST_FILE_CONTEXT, fileMetadata, verifiedMemoryDestination, type HostFileContext, type PeerFileMetadata } from './peer-files.js';

type ReadMethod = 'status' | 'usage';
type WriteMethod = 'begin' | 'commit' | 'abort' | 'abandon' | 'capture';
type ScopedRun = Readonly<{ session: string; run: RunRef }>;
type MethodInput<M extends ReadMethod | WriteMethod> = ScopedRun & Readonly<{ method: M; input: FileInputs[M] }>;
export type FileResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; code: FileErrorCode }>;
const readMethods = new Set<string>(['status', 'usage']), writeMethods = new Set<string>(['begin', 'commit', 'abort', 'abandon', 'capture']);
const fileCodes = new Set<string>(['INVALID', 'CONFLICT', 'FENCED', 'NOT_FOUND', 'EXPIRED', 'CORRUPT', 'STORAGE_FULL', 'BUSY', 'CLOSED', 'UNSUPPORTED', 'IO']);
export function hostFileAction(path: string, type: 'query' | 'mutation' | 'subscription'): GatewayAction | undefined {
  if (!path.startsWith('multiplexFiles.')) return undefined;
  const name = path.slice('multiplexFiles.'.length), reads = ['scope', 'read', 'download'];
  if (reads.includes(name) && type === 'query') return 'read';
  if (['mutate', 'write'].includes(name) && type === 'mutation') return 'fileWrite';
  throw new GatewayError('FORBIDDEN');
}
const input = <T>(value: unknown): T => { try { return JSON.parse(canonical(value, 65536)) as T; } catch { throw new FileError('INVALID'); } };
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value === undefined ? null : value)) as T;
async function result<T>(work: () => Promise<T>): Promise<FileResult<T>> {
  try { return { ok: true, value: wire(await work()) }; }
  catch (error) { const code = (error as { code?: unknown } | null)?.code; return { ok: false, code: typeof code === 'string' && fileCodes.has(code) ? code as FileErrorCode : 'IO' }; }
}

/** Existing FileHost is the sole durable byte/upload/retention owner. This
 * router owns bounded transfer tasks and exact read-lease cleanup only. */
export function createHostFileFacade(options: Readonly<{
  source: HostFacadeSource;
  authorize(context: HostContext, action: GatewayAction): void;
  route(context: HostContext, session: string, action: GatewayAction): Promise<SessionRoute>;
}>) {
  const t = initTRPC.context<HostFileContext>().create(), tasks = new Set<Promise<unknown>>(), reads = new Set<() => Promise<void>>();
  let closing = false, writes = 0;
  const active = () => { if (closing) throw new FileError('CLOSED'); };
  const track = <T>(work: () => Promise<T>): Promise<T> => {
    active(); const task = Promise.resolve().then(work); tasks.add(task); void task.finally(() => tasks.delete(task)).catch(() => {}); return task;
  };
  const p = t.procedure.use(async ({ ctx, path, type, next }) => {
    active(); const action = hostFileAction(path, type); if (!action) throw new TRPCError({ code: 'FORBIDDEN' });
    options.authorize(ctx, action); const release = ctx.admit?.({ path, type });
    try { return await next(); } finally { release?.(); }
  });
  const bound = async (ctx: HostContext, value: ScopedRun, action: GatewayAction) => {
    active(); const route = await options.route(ctx, value.session, action), binding = await route.binding?.();
    if (!binding || !sameRun(binding.run, value.run)) throw new FileError('FENCED'); return { route, run: binding.run };
  };
  const surface = async (ctx: HostContext, value: ScopedRun, action: GatewayAction) => {
    const { route, run } = await bound(ctx, value, action), scope = route.files?.scope();
    if (!scope || !route.files
      || scope.connection !== options.source.target.connection || scope.principal !== options.source.target.principal
      || scope.host !== options.source.target.host || scope.session !== value.run.nativeSession) throw new FileError('FENCED');
    return { port: route.files.port, scope: copy(scope), run };
  };
  const exactScope = (given: FileScope, actual: FileScope) => { if (scopeKey(given) !== scopeKey(actual)) throw new FileError('FENCED'); };
  const metadata = (value: ScopedRun, scope: FileScope, id: string, bytes: number, sha256: string, kind: PeerFileMetadata['kind'], offset = 0) => fileMetadata({
    version: 1, kind, target: options.source.target, run: value.run, scope, id, bytes, sha256, offset,
  });
  const artifact = (value: ArtifactRef, expected: ArtifactRef) => { if (canonical(value) !== canonical(expected)) throw new FileError('FENCED'); };
  const downloadSource = (ctx: HostContext, value: ScopedRun, info: ArtifactRef, meta: PeerFileMetadata): FileSource<PeerFileMetadata> => ({
    name: info.id, size: info.bytes, metadata: meta,
    async readChunk() { throw new FileError('UNSUPPORTED'); },
    prepare(signal) { return track(async () => {
      signal?.throwIfAborted(); const current = await surface(ctx, value, 'read'), acquired = await current.port.call('acquire', { scope: current.scope, id: info.id });
      const pending = new Set<Promise<Uint8Array>>(); let sealed = false, releasing: Promise<void> | undefined, released = false;
      const close = async () => {
        sealed = true; await Promise.allSettled([...pending]);
        if (released) return;
        if (!releasing) releasing = current.port.call('release', { scope: current.scope, leaseId: acquired.leaseId });
        try { await releasing; released = true; reads.delete(close); } finally { releasing = undefined; }
      };
      // Keep exact release custody before any post-acquisition check can fail.
      reads.add(close);
      const prepared: PreparedFileSource<PeerFileMetadata> = {
        name: info.id, size: info.bytes, metadata: meta, close,
        readChunk(index, chunkSize, readSignal) {
          if (sealed) return Promise.reject(new FileError('CLOSED'));
          const work = Promise.resolve().then(async () => {
            readSignal?.throwIfAborted(); if (chunkSize !== defaultLimits.chunkBytes || !Number.isSafeInteger(index) || index < 0) throw new FileError('INVALID');
            await surface(ctx, value, 'read');
            const offset = index * chunkSize, length = Math.min(chunkSize, info.bytes - offset);
            if (length <= 0) throw new FileError('INVALID');
            const bytes = await current.port.call('read', { scope: current.scope, leaseId: acquired.leaseId, offset, length });
            await surface(ctx, value, 'read'); readSignal?.throwIfAborted(); return bytes;
          });
          pending.add(work); void work.finally(() => pending.delete(work)).catch(() => {}); return work;
        },
      };
      try { artifact(acquired.artifact, info); signal?.throwIfAborted(); await surface(ctx, value, 'read'); return prepared; }
      catch (error) { await close(); throw error; }
    }); },
  });
  const router = t.router({ multiplexFiles: t.router({
    scope: p.input(input<ScopedRun>).query(({ ctx, input }) => result(async () => {
      const value = await bound(ctx, input, 'read'); if (!value.route.files?.scope()) return { scope: null, run: value.run };
      const actual = await surface(ctx, input, 'read'); return { scope: actual.scope, run: actual.run };
    })),
    read: p.input(input<MethodInput<ReadMethod>>).query(({ ctx, input }) => result(async () => {
      if (!readMethods.has(input.method)) throw new FileError('UNSUPPORTED'); const value = await surface(ctx, input, 'read'); exactScope(input.input.scope, value.scope);
      return value.port.call(input.method, input.input);
    })),
    mutate: p.input(input<MethodInput<WriteMethod>>).mutation(({ ctx, input }) => result(() => track(async () => {
      if (!writeMethods.has(input.method)) throw new FileError('UNSUPPORTED'); const value = await surface(ctx, input, 'fileWrite'); exactScope(input.input.scope, value.scope);
      return value.port.call(input.method, input.input);
    }))),
    download: p.input(input<ScopedRun & { id: string }>).query(({ ctx, input }) => result(async () => {
      const files = ctx[HOST_FILE_CONTEXT]; if (!files) throw new FileError('UNSUPPORTED'); assertId(input.id);
      const value = await surface(ctx, input, 'read'), status = await value.port.call('status', { scope: value.scope, id: input.id });
      if (status.state !== 'committed') throw new FileError(status.state === 'expired' || status.state === 'aborted' ? 'EXPIRED' : 'NOT_FOUND');
      if (status.artifact.id !== input.id || scopeKey(status.artifact.owner) !== scopeKey(value.scope)) throw new FileError('FENCED');
      const meta = metadata(input, value.scope, input.id, status.artifact.bytes, status.artifact.sha256, 'artifact');
      return { artifact: status.artifact, metadata: meta,
        handle: files.share(downloadSource(ctx, input, status.artifact, meta), { expiresAt: Date.now() + 30000, maxDownloads: 1 }) };
    })),
    write: p.input(input<ScopedRun & { scope: FileScope; metadata: PeerFileMetadata; handle: Readonly<{ token: string; expiresAt?: number }> }>).mutation(({ ctx, input }) => result(() => track(async () => {
      const files = ctx[HOST_FILE_CONTEXT]; if (!files) throw new FileError('UNSUPPORTED');
      const bytes = verifiedMemoryDestination(fileMetadata(input.metadata));
      if (writes >= defaultLimits.maxWrites) throw new FileError('BUSY'); writes++;
      try {
        const value = await surface(ctx, input, 'fileWrite'); exactScope(input.scope, value.scope);
        const expected = metadata(input, value.scope, input.metadata.id, input.metadata.bytes, input.metadata.sha256, 'chunk', input.metadata.offset);
        if (canonical(expected) !== canonical(input.metadata)) throw new FileError('FENCED');
        const transfer = await files.download(input.handle, bytes.destination, { chunkSize: defaultLimits.chunkBytes, lanes: 1, signal: files.signal });
        await transfer.result; files.signal.throwIfAborted();
        const current = await surface(ctx, input, 'fileWrite'); exactScope(value.scope, current.scope); files.signal.throwIfAborted();
        // One actual FileHost effect after verified transfer. A lost RPC reply
        // reconciles its existing upload ID/offset; it never replays a Send.
        return await current.port.call('write', { scope: current.scope, id: expected.id, offset: expected.offset, data: bytes.value() });
      } finally { writes--; bytes.close(); }
    }))),
  }) });
  return Object.freeze({ router,
    async close() {
      closing = true; await Promise.allSettled([...tasks]);
      const failures = (await Promise.allSettled([...reads].map(close => close()))).filter(value => value.status === 'rejected');
      if (failures.length) throw new AggregateError(failures, 'Host file read release remains unsettled');
    },
  });
}
export type HostFileRouter = ReturnType<typeof createHostFileFacade>['router'];
