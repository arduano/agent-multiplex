import type { HostManifest } from '../../../v8-plugins/src/contracts.js';
import { canonical, copy, id } from '../../../v8-session/src/contracts/validation.js';
import { GatewayError, type GatewayAction, type Identity } from './types.js';

/** A real Host route. Session routes are an optional narrower call scope. */
export type HostRpcTarget = Readonly<{
  connection: string; principal: string; authority: string; host: string;
  owner: string; routeEpoch: string;
}>;
export type HostRpcExpected = Pick<HostManifest, 'contractId' | 'contractVersion' | 'compositionId'>;
export const hostRpcExpected = (value: HostRpcExpected): HostRpcExpected => ({
  contractId: value.contractId, contractVersion: value.contractVersion, compositionId: value.compositionId,
});
export type HostRpcRequest = Readonly<{
  target: HostRpcTarget; expected: HostRpcExpected; path: string;
  input?: unknown; session?: Readonly<{ id: string; generation: number }>;
}>;
export type HostRpcCall = HostRpcRequest & Readonly<{ type: 'query' | 'mutation' }>;
export type RpcFault = Readonly<{ code: string; message: string }>;
export type RpcResult = Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; error: RpcFault }>;
/** Trusted backend port; callers cannot supply their own authentication context. */
export type HostRpcPort = Readonly<{
  manifest: HostManifest;
  /** Trusted procedure policy, never a caller-selected forwarding lane. */
  urgent?(request: HostRpcCall): boolean;
  call(identity: Identity, request: HostRpcCall): Promise<unknown>;
  watch(identity: Identity, request: HostRpcRequest, signal: AbortSignal): AsyncIterable<unknown>;
}>;
export type HostRpcRegistration = Readonly<{ target: HostRpcTarget; actions?: readonly GatewayAction[]; port: HostRpcPort }>;

export function hostRpcTarget(value: unknown): HostRpcTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GatewayError('INVALID');
  const fields = ['connection', 'principal', 'authority', 'host', 'owner', 'routeEpoch'];
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length) throw new GatewayError('INVALID');
  try { for (const field of fields) id(record[field]); }
  catch { throw new GatewayError('INVALID'); }
  return copy(record as HostRpcTarget);
}
export const hostRpcOwnerKey = (target: HostRpcTarget): string =>
  JSON.stringify([target.connection, target.principal, target.authority, target.host, target.owner]);
export const hostRpcKey = (target: HostRpcTarget): string => JSON.stringify([hostRpcOwnerKey(target), target.routeEpoch]);

export function hostRpcRequest(value: unknown): HostRpcRequest {
  try { canonical(value, 65536); } catch { throw new GatewayError('INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GatewayError('INVALID');
  const record = value as Record<string, unknown>;
  const allowed = new Set(['target', 'expected', 'path', 'input', 'session', 'type']);
  if (Object.keys(record).some(key => !allowed.has(key))) throw new GatewayError('INVALID');
  const target = hostRpcTarget(record.target);
  if (typeof record.path !== 'string' || record.path.length > 1024 || !/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/.test(record.path)
    || record.path.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new GatewayError('INVALID');
  const expected = record.expected as Record<string, unknown> | undefined;
  if (!expected || Object.keys(expected).sort().join(',') !== 'compositionId,contractId,contractVersion'
    || typeof expected.contractId !== 'string' || typeof expected.compositionId !== 'string'
    || expected.contractId.length > 256 || expected.compositionId.length > 32768
    || !Number.isSafeInteger(expected.contractVersion) || Number(expected.contractVersion) < 1) throw new GatewayError('INVALID');
  const session = record.session as Record<string, unknown> | undefined;
  if (session !== undefined) {
    if (!session || typeof session !== 'object' || Array.isArray(session)
      || Object.keys(session).some(key => key !== 'id' && key !== 'generation')) throw new GatewayError('INVALID');
    try { id(session.id); } catch { throw new GatewayError('INVALID'); }
    if (!Number.isSafeInteger(session.generation) || Number(session.generation) < 1) throw new GatewayError('INVALID');
  }
  return copy({ target, expected: expected as HostRpcExpected, path: record.path, ...(Object.hasOwn(record, 'input') ? { input: record.input } : {}),
    ...(session ? { session: session as { id: string; generation: number } } : {}) });
}

/** Errors cross the wire as codes only, never native text, inputs or stacks. */
export function rpcFault(error: unknown): RpcFault {
  const candidate = error as { code?: unknown; data?: { code?: unknown }; shape?: { data?: { code?: unknown } } } | null;
  const code = candidate?.data?.code ?? candidate?.shape?.data?.code ?? candidate?.code;
  const allowed = new Set(['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'PRECONDITION_FAILED',
    'TIMEOUT', 'TOO_MANY_REQUESTS', 'METHOD_NOT_SUPPORTED', 'INTERNAL_SERVER_ERROR', 'UNAVAILABLE', 'FENCED', 'FULL', 'CLOSED']);
  const safe = typeof code === 'string' && allowed.has(code) ? code : 'INTERNAL_SERVER_ERROR';
  return Object.freeze({ code: safe, message: safe });
}
