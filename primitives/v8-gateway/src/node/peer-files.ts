import { createHash } from 'node:crypto';
import { blake3 } from '@napi-rs/blake-hash';
import type { AnyRouter } from '@trpc/server';
import type { FileDestination, FileManifest as PeerManifest, FileMetadataSchema, FileSource, Peer, PeerContext, PeerFiles, P2PRequestFiles } from '@arduano/p2prpc-core';
import type { HostContext } from '../../../v8-plugins/src/contracts.js';
import { FileError, assertId, assertScope, scopeKey, type FileScope } from '../../../v8-files/src/contracts/types.js';
import { defaultLimits } from '../../../v8-files/src/contracts/limits.js';
import { canonical, copy, scope as assertSessionScope } from '../../../v8-session/src/contracts/validation.js';
import type { RunRef } from '../../../v8-session/src/contracts/types.js';
import { hostRpcTarget, type HostRpcTarget } from '../contracts/rpc.js';
export type { ConnectOptions, P2PNode, Peer } from '@arduano/p2prpc-core';

export type PeerFileMetadata = Readonly<{
  version: 1; kind: 'artifact' | 'chunk'; target: HostRpcTarget; run: RunRef; scope: FileScope;
  id: string; offset: number; bytes: number; sha256: string;
}>;
export function fileMetadata(value: unknown): PeerFileMetadata {
  try {
    const data = JSON.parse(canonical(value, 16384)) as PeerFileMetadata;
    if (Object.keys(data).sort().join(',') !== 'bytes,id,kind,offset,run,scope,sha256,target,version'
      || data.version !== 1 || !['artifact', 'chunk'].includes(data.kind)) throw Error();
    hostRpcTarget(data.target); assertScope(data.scope); assertSessionScope(data.run.scope); assertId(data.id);
    if (Object.keys(data.scope).sort().join(',') !== 'connection,host,principal,session'
      || Object.keys(data.run).sort().join(',') !== 'generation,nativeSession,scope'
      || Object.keys(data.run.scope).sort().join(',') !== 'connection,host,principal,session'
      || !Number.isSafeInteger(data.run.generation) || data.run.generation < 1 || data.run.nativeSession !== data.scope.session
      || data.scope.connection !== data.target.connection || data.scope.principal !== data.target.principal || data.scope.host !== data.target.host
      || data.run.scope.connection !== data.target.connection || data.run.scope.principal !== data.target.principal || data.run.scope.host !== data.target.host
      || !Number.isSafeInteger(data.bytes) || data.bytes < 0 || data.bytes > (data.kind === 'chunk' ? defaultLimits.chunkBytes : defaultLimits.maxFileBytes)
      || !Number.isSafeInteger(data.offset) || data.offset < 0 || data.kind === 'artifact' && data.offset !== 0
      || !/^[a-f0-9]{64}$/.test(data.sha256)) throw Error();
    return copy(data);
  } catch { throw new FileError('FENCED'); }
}
export const peerFileMetadataSchema: FileMetadataSchema<PeerFileMetadata> = Object.freeze({ '~standard': Object.freeze({
  version: 1 as const, vendor: 'multiplex-file-v1', validate(value: unknown) {
    try { return { value: fileMetadata(value) }; } catch { return { issues: [{ message: 'Invalid file scope' }] }; }
  },
}) });
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** No disk/cache or second publication owner. The SDK gets exact whole-content
 * BLAKE3 verification, while the application also checks its immutable SHA256. */
export function verifiedMemoryDestination(expected: PeerFileMetadata, assertCurrent: () => void = () => {}) {
  expected = fileMetadata(expected);
  let bytes: Uint8Array | undefined, meaning: string | undefined, committed = false;
  const received = new Set<number>();
  const exact = (manifest: PeerManifest<PeerFileMetadata>) => {
    if (manifest.name !== expected.id || manifest.size !== expected.bytes || manifest.chunkSize !== defaultLimits.chunkBytes
      || manifest.chunkCount !== Math.ceil(expected.bytes / defaultLimits.chunkBytes)
      || canonical(fileMetadata(manifest.metadata)) !== canonical(expected) || !/^[a-f0-9]{64}$/.test(manifest.digest)) throw new FileError('FENCED');
    const key = canonical(manifest, 32768); if (meaning !== undefined && meaning !== key) throw new FileError('CONFLICT'); return key;
  };
  const destination: FileDestination<PeerFileMetadata> = {
    async prepare(manifest, signal) { signal?.throwIfAborted(); assertCurrent(); meaning = exact(manifest); bytes ??= new Uint8Array(expected.bytes); return new Set(received); },
    async writeChunk(manifest, index, data, signal) {
      signal?.throwIfAborted(); exact(manifest); if (!bytes || committed || !Number.isSafeInteger(index) || index < 0 || index >= manifest.chunkCount) throw new FileError('FENCED');
      const offset = index * manifest.chunkSize, size = Math.min(manifest.chunkSize, expected.bytes - offset);
      if (data.length !== size) throw new FileError('CORRUPT');
      if (received.has(index)) { if (!Buffer.from(bytes.subarray(offset, offset + size)).equals(Buffer.from(data))) throw new FileError('CONFLICT'); }
      else { bytes.set(data, offset); received.add(index); }
    },
    async finalize(manifest, context) {
      context.signal?.throwIfAborted(); exact(manifest); assertCurrent();
      if (!bytes || received.size !== manifest.chunkCount || sha256(bytes) !== expected.sha256 || blake3(bytes).toString('hex') !== manifest.digest) throw new FileError('CORRUPT');
      // This commits the verified temporary byte handoff only. Host file writes
      // happen separately, once, through the existing FileHost upload owner.
      committed = true; context.markCommitted();
    },
    async abort(_manifest, options) { if (options.discard && !committed) { bytes = undefined; received.clear(); } },
  };
  return Object.freeze({ destination,
    value() { if (!committed || !bytes) throw new FileError('CORRUPT'); return bytes; },
    close() { bytes = undefined; received.clear(); },
  });
}

export function memoryFileSource(metadata: PeerFileMetadata, input: Uint8Array): FileSource<PeerFileMetadata> {
  const data = Uint8Array.from(input), checked = fileMetadata(metadata);
  if (data.length !== checked.bytes || sha256(data) !== checked.sha256) throw new FileError('CORRUPT');
  return Object.freeze({ name: checked.id, size: data.length, metadata: checked,
    async readChunk(index: number, chunkSize: number, signal?: AbortSignal) {
      signal?.throwIfAborted(); if (chunkSize !== defaultLimits.chunkBytes) throw new FileError('INVALID');
      return data.slice(index * chunkSize, Math.min(data.length, (index + 1) * chunkSize));
    },
  });
}

export const HOST_FILE_CONTEXT = Symbol('verified Host Peer file operations');
export type HostFileContext = HostContext & Readonly<{ [HOST_FILE_CONTEXT]?: Readonly<{
  share: P2PRequestFiles<PeerFileMetadata>['share'];
  download: PeerFiles<PeerFileMetadata>['download'];
  signal: AbortSignal;
}> }>;
/** Backend-only enrichment. Headers/JSON cannot mint this symbol or a Peer. */
export function withHostFileContext(context: HostContext, actual: PeerContext<PeerFileMetadata>, currentPeer: () => Peer<AnyRouter, PeerFileMetadata> | undefined): HostFileContext {
  return { ...context, [HOST_FILE_CONTEXT]: {
    share: (source, policy) => actual.p2p.files.share(source, policy), signal: actual.p2p.request.signal,
    download: (handle, destination, options) => {
      const peer = currentPeer();
      if (!peer || peer.identity.id !== actual.p2p.peer.id || peer.session.id !== actual.p2p.auth.id || peer.session.generation !== actual.p2p.auth.generation) throw new FileError('FENCED');
      return peer.files.download(handle, destination, options);
    },
  } };
}
