import { SessionError, type McpLoginLink } from './types.js';

export const loginLimits = Object.freeze({ servers: 16, urlBytes: 8192, displayMs: 120_000 });
export function validateLoginLink(input: unknown): McpLoginLink {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SessionError('INVALID');
  const value = input as Record<string, unknown>;
  if (value.state === 'available') {
    if (Object.keys(value).sort().join(',') !== 'authorizationUrl,expiresInMs,state,status' || value.status !== 'initiated' || !Number.isSafeInteger(value.expiresInMs) || Number(value.expiresInMs) < 1 || Number(value.expiresInMs) > loginLimits.displayMs || typeof value.authorizationUrl !== 'string' || new TextEncoder().encode(value.authorizationUrl).length > loginLimits.urlBytes || /[\u0000-\u001f\u007f]/.test(value.authorizationUrl)) throw new SessionError('INVALID');
    let url: URL; try { url = new URL(value.authorizationUrl); } catch { throw new SessionError('INVALID'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new SessionError('INVALID');
    return { state: 'available', status: 'initiated', authorizationUrl: value.authorizationUrl, expiresInMs: Number(value.expiresInMs) };
  }
  if (value.state !== 'unavailable' || Object.keys(value).some(key => !['state', 'reason', 'status'].includes(key)) || !['notRetained', 'displayExpired', 'nativeRetired'].includes(String(value.reason)) || value.status !== undefined && !['starting', 'initiated', 'reused', 'succeeded', 'failed', 'outcomeUnknown'].includes(String(value.status))) throw new SessionError('INVALID');
  return { state: 'unavailable', reason: value.reason as Extract<McpLoginLink, { state: 'unavailable' }>['reason'], ...(value.status === undefined ? {} : { status: value.status as NonNullable<Extract<McpLoginLink, { state: 'unavailable' }>['status']> }) };
}
