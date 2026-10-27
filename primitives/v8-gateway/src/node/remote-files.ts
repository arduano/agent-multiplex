import { randomUUID } from 'node:crypto';
import type { PeerFiles } from '@arduano/p2prpc-core';
import { FileError, scopeKey, type FileInputs, type FileMethod, type FileOutputs, type FilePort, type FileScope } from '../../../v8-files/src/contracts/types.js';
import { defaultLimits } from '../../../v8-files/src/contracts/limits.js';
import { canonical, copy } from '../../../v8-session/src/contracts/validation.js';
import { sameRun, type RunRef } from '../../../v8-session/src/contracts/types.js';
import type { FileSurface, Identity } from '../contracts/types.js';
import { hostRpcExpected, hostRpcTarget, type HostRpcExpected, type HostRpcPort, type HostRpcTarget } from '../contracts/rpc.js';
import type { FileResult } from './host-files.js';
import { fileMetadata, memoryFileSource, sha256, verifiedMemoryDestination, type PeerFileMetadata } from './peer-files.js';

/** A connection lease, never a durable cache or FileHost. Completed downloads
 * occupy at most four 10MiB byte leases across every session on this edge. */
export function createRemoteFiles(options: Readonly<{
  target: HostRpcTarget; expected: HostRpcExpected; identity: Identity; port: HostRpcPort;
  files: PeerFiles<PeerFileMetadata>;
}>) {
  const target = hostRpcTarget(options.target), expected = hostRpcExpected(options.expected);
  const leases = new Map<string, { scope: FileScope; bytes: Uint8Array }>(), tasks = new Set<Promise<unknown>>();
  const sessions = new Map<string, ReturnType<typeof session>>(); let closed = false, acquiring = 0;
  const active = () => { if (closed) throw new FileError('CLOSED'); };
  const track = <T>(work: () => Promise<T>): Promise<T> => {
    active(); const task = Promise.resolve().then(work); tasks.add(task); void task.finally(() => tasks.delete(task)).catch(() => {}); return task;
  };
  const rpc = async <T>(name: string, value: unknown, type: 'query' | 'mutation' = 'query'): Promise<T> => {
    const response = await options.port.call(options.identity, { target, expected, path: `multiplexFiles.${name}`, type, input: value }) as FileResult<T>;
    if (!response || typeof response !== 'object' || !('ok' in response)) throw new FileError('IO');
    if (!response.ok) throw new FileError(response.code); return response.value;
  };
  function session(id: string) {
    let current: Readonly<{ run: RunRef; scope: FileScope | null }> | undefined;
    const exact = (scope: FileScope) => {
      active(); if (!current?.scope || scopeKey(current.scope) !== scopeKey(scope)) throw new FileError('FENCED'); return { run: current.run, scope: current.scope };
    };
    const port: FilePort = { call<M extends FileMethod>(method: M, input: FileInputs[M]): Promise<FileOutputs[M]> {
      return track(async () => {
        if (method === 'release') { const value = input as FileInputs['release'], lease = leases.get(value.leaseId); if (!lease || scopeKey(lease.scope) !== scopeKey(value.scope)) throw new FileError('FENCED'); leases.delete(value.leaseId); return undefined as FileOutputs[M]; }
        const bound = exact(input.scope), scoped = { session: id, run: bound.run };
        if (method === 'read') {
          const value = input as FileInputs['read'], lease = leases.get(value.leaseId);
          if (!lease || scopeKey(lease.scope) !== scopeKey(value.scope)) throw new FileError('FENCED');
          if (!Number.isSafeInteger(value.offset) || !Number.isSafeInteger(value.length) || value.offset < 0 || value.length < 0 || value.length > defaultLimits.chunkBytes || value.offset + value.length > lease.bytes.length) throw new FileError('INVALID');
          return lease.bytes.slice(value.offset, value.offset + value.length) as FileOutputs[M];
        }
        if (method === 'acquire') {
          if (acquiring + leases.size >= defaultLimits.maxReads) throw new FileError('BUSY'); acquiring++;
          let memory: ReturnType<typeof verifiedMemoryDestination> | undefined;
          try {
            const value = input as FileInputs['acquire'];
            const shared = await rpc<{ artifact: FileOutputs['commit']; metadata: PeerFileMetadata; handle: Readonly<{ token: string; expiresAt?: number }> }>('download', { ...scoped, id: value.id });
            const metadata = fileMetadata(shared.metadata);
            if (metadata.kind !== 'artifact' || metadata.id !== value.id || canonical(metadata.target) !== canonical(target)
              || !sameRun(metadata.run, bound.run) || scopeKey(metadata.scope) !== scopeKey(bound.scope)
              || shared.artifact.id !== metadata.id || shared.artifact.bytes !== metadata.bytes || shared.artifact.sha256 !== metadata.sha256
              || scopeKey(shared.artifact.owner) !== scopeKey(bound.scope)) throw new FileError('FENCED');
            const unchanged = () => { exact(bound.scope); if (!current || !sameRun(current.run, bound.run)) throw new FileError('FENCED'); };
            memory = verifiedMemoryDestination(metadata, unchanged);
            const transfer = await options.files.download(shared.handle, memory.destination, { chunkSize: defaultLimits.chunkBytes, lanes: 1 });
            await transfer.result; unchanged(); const leaseId = randomUUID();
            leases.set(leaseId, { scope: bound.scope, bytes: memory.value() }); return { leaseId, artifact: shared.artifact } as FileOutputs[M];
          } finally { acquiring--; memory?.close(); }
        }
        if (method === 'write') {
          const value = input as FileInputs['write'], bytes = Uint8Array.from(value.data);
          if (bytes.length > defaultLimits.chunkBytes) throw new FileError('INVALID');
          const metadata = fileMetadata({ version: 1, kind: 'chunk', target, run: bound.run, scope: bound.scope, id: value.id, offset: value.offset, bytes: bytes.length, sha256: sha256(bytes) });
          const handle = options.files.share(memoryFileSource(metadata, bytes), { expiresAt: Date.now() + 30000, maxDownloads: 1 });
          try { return await rpc('write', { ...scoped, scope: bound.scope, metadata, handle }, 'mutation'); }
          finally { options.files.revoke(handle); }
        }
        if (method === 'status' || method === 'usage') return rpc('read', { ...scoped, method, input });
        if (method === 'begin' || method === 'commit' || method === 'abort' || method === 'abandon' || method === 'capture') return rpc('mutate', { ...scoped, method, input }, 'mutation');
        throw new FileError('UNSUPPORTED');
      });
    } };
    return Object.freeze({ surface: { port, scope: () => current?.scope ? copy(current.scope) : null } satisfies FileSurface,
      async bind(run: RunRef) {
        active(); if (run.scope.session !== id) throw new FileError('FENCED');
        if (current && sameRun(current.run, run)) return;
        const value = await rpc<{ run: RunRef; scope: FileScope | null }>('scope', { session: id, run }); active();
        if (!sameRun(value.run, run) || value.scope && (value.scope.connection !== target.connection || value.scope.principal !== target.principal || value.scope.host !== target.host || value.scope.session !== run.nativeSession)) throw new FileError('FENCED');
        current = copy(value);
      },
    });
  }
  return Object.freeze({
    session(id: string) { active(); let value = sessions.get(id); if (!value) { value = session(id); sessions.set(id, value); } return value; },
    async close() { closed = true; await Promise.allSettled([...tasks]); leases.clear(); sessions.clear(); },
    get leaseCount() { return leases.size + acquiring; },
  });
}
export type RemoteFiles = ReturnType<typeof createRemoteFiles>;
