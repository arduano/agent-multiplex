import { createHmac, timingSafeEqual } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import type { PeerContext } from '@arduano/p2prpc-core';
import type { HostCall, HostContext } from '../../../v8-plugins/src/contracts.js';
import { canonical, copy } from '../../../v8-session/src/contracts/validation.js';
import { hostRpcExpected, hostRpcRequest, hostRpcTarget, type HostRpcExpected, type HostRpcRequest, type HostRpcTarget } from '../contracts/rpc.js';
import { GatewayError, type GatewayAction, type Identity } from '../contracts/types.js';
/** Published p2prpc reserves HTTP Authorization; use application metadata. */
export const HOST_PROOF_HEADER = 'x-multiplex-host-proof';

/** Configured backend peer authentication. No browser credential, private
 * configuration or native secret is a public Host descriptor. A short lived
 * proof is bound to the actual procedure and verified transport peer.
 */
export function createHmacHostProof(options: Readonly<{
  issuer: string; audience: string; secret: Uint8Array; now?: () => number;
  /** Trusted Host procedure policy, shared by issuer and verifier. Custom
   * routers retain the default read/control policy unless explicitly selected. */
  actionForProcedure?: (path: string, type: 'query' | 'mutation' | 'subscription') => GatewayAction;
}>) {
  if (!options.issuer || !options.audience || options.secret.byteLength !== 32) throw new TypeError('Invalid peer proof configuration');
  const secret = Buffer.from(options.secret), now = options.now ?? Date.now;
  let revoked = false;
  const sign = (value: string) => createHmac('sha256', secret).update(value).digest();
  const token = (context: HostContext, expected: HostRpcExpected, path: string, type: string, expiresAt: number) => {
    const payload = Buffer.from(canonical({ version: 1, issuer: options.issuer, audience: options.audience, expiresAt, context, expected, path, type })).toString('base64url');
    const value = `Bearer v8host.${payload}.${sign(payload).toString('base64url')}`;
    if (value.length > 8192) throw new GatewayError('INVALID'); return value;
  };
  const issue = (identity: Identity, input: HostRpcRequest, type: 'query' | 'mutation' | 'subscription', ttlMs = 30000): string => {
    const request = hostRpcRequest(input), target = request.target;
    if (revoked || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60000) throw new GatewayError('FORBIDDEN');
    if (identity.connection !== target.connection || identity.principal !== target.principal || !identity.authorities.includes(target.authority)
      || !identity.actions.includes(options.actionForProcedure?.(request.path, type) ?? (type === 'mutation' ? 'control' : 'read'))) throw new GatewayError('FORBIDDEN');
    const context: HostContext = { identity: { connection: identity.connection, principal: identity.principal, actions: [...identity.actions] },
      route: { authority: target.authority, host: target.host, owner: target.owner, routeEpoch: target.routeEpoch },
      ...(request.session ? { session: request.session } : {}) };
    return token(context, request.expected, request.path, type, now() + ttlMs);
  };
  const verify = (authorization: unknown, path: string, type: string): { context: HostContext; expected: HostCall['expected']; expiresAt: number } | null => {
    if (revoked || typeof authorization !== 'string' || authorization.length > 8192) return null;
    const parts = /^Bearer v8host\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization); if (!parts) return null;
    const signature = Buffer.from(parts[2]!, 'base64url'), expected = sign(parts[1]!);
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
    try {
      const claim = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
      if (Object.keys(claim).sort().join(',') !== 'audience,context,expected,expiresAt,issuer,path,type,version'
        || claim.version !== 1 || claim.issuer !== options.issuer || claim.audience !== options.audience || claim.path !== path || claim.type !== type
        || !Number.isSafeInteger(claim.expiresAt) || claim.expiresAt <= now() || claim.expiresAt > now() + 60000) return null;
      // Reuse the exact wire scope validator rather than accepting arbitrary
      // signed object shapes as authenticated session identities.
      const ctx = claim.context as HostContext;
      hostRpcRequest({ target: { ...ctx.route, connection: ctx.identity.connection, principal: ctx.identity.principal },
        expected: claim.expected, path, ...(ctx.session ? { session: ctx.session } : {}) });
      if (!Array.isArray(ctx.identity.actions) || ctx.identity.actions.some(action => typeof action !== 'string')) return null;
      if (type !== 'query' && type !== 'mutation' && type !== 'subscription') return null;
      if (!ctx.identity.actions.includes(options.actionForProcedure?.(path, type) ?? (type === 'mutation' ? 'control' : 'read'))) return null;
      return copy({ context: ctx, expected: claim.expected, expiresAt: claim.expiresAt });
    } catch { return null; }
  };
  /** The sole stale-epoch exception observes the same durable Host's current
   * descriptor. It cannot renew an expired proof, change account/owner/manifest,
   * grant control or authorize any other procedure. */
  const descriptorRead = (authorization: unknown, descriptor: Readonly<{ target: HostRpcTarget; manifest: HostRpcExpected }>): HostCall | null => {
    const verified = verify(authorization, 'multiplex.describe', 'query'); if (!verified) return null;
    try {
      const target = hostRpcTarget(descriptor.target), ctx = verified.context;
      const { routeEpoch: _current, ...current } = target;
      const { routeEpoch: _claimed, ...claimed } = hostRpcTarget({ ...ctx.route, connection: ctx.identity.connection, principal: ctx.identity.principal });
      if (ctx.session || canonical(claimed) !== canonical(current) || canonical(verified.expected) !== canonical(hostRpcExpected(descriptor.manifest))
        || !ctx.identity.actions.includes('read')) return null;
      const remaining = verified.expiresAt - now(); if (remaining < 1) return null;
      const expected = hostRpcExpected(descriptor.manifest), path = 'multiplex.describe';
      const authorization = token({ route: { authority: target.authority, host: target.host, owner: target.owner, routeEpoch: target.routeEpoch },
        identity: { connection: target.connection, principal: target.principal, actions: ['read'] } }, expected, path, 'query', verified.expiresAt);
      return { proof: { authorization, path, type: 'query' }, expected };
    } catch { return null; }
  };
  return Object.freeze({ issue, verify, descriptorRead, revoke: () => { revoked = true; } });
}

/** Runs only at the actual Host endpoint. Both authenticated Peer identity and
 * the per-request Gateway proof are required; asserted browser metadata fails.
 */
export function createHostPeerContext(options: Readonly<{
  host: { context(call: HostCall): Promise<HostContext> };
  proof: ReturnType<typeof createHmacHostProof>;
  allowPeer(context: PeerContext): boolean;
  descriptor?: Readonly<{ target: HostRpcTarget; manifest: HostRpcExpected }>;
}>) {
  return async (peer: PeerContext): Promise<HostContext> => {
    if (!options.allowPeer(peer)) throw new TRPCError({ code: 'UNAUTHORIZED' });
    const request = peer.p2p.request;
    const verified = options.proof.verify(request.headers[HOST_PROOF_HEADER], request.path, request.type);
    if (!verified) throw new TRPCError({ code: 'UNAUTHORIZED' });
    if (options.descriptor && request.path === 'multiplex.describe' && request.type === 'query') {
      const call = options.proof.descriptorRead(request.headers[HOST_PROOF_HEADER], options.descriptor);
      if (!call) throw new TRPCError({ code: 'UNAUTHORIZED' });
      return options.host.context(call);
    }
    // The activation's authenticate callback verifies this opaque proof itself.
    return options.host.context({ proof: { authorization: request.headers[HOST_PROOF_HEADER], path: request.path, type: request.type },
      expected: verified.expected, ...(verified.context.session ? { session: verified.context.session } : {}) });
  };
}

export function authenticateHostProof(proof: ReturnType<typeof createHmacHostProof>) {
  return (call: HostCall): HostContext | null => {
    const value = call.proof as { authorization?: unknown; path?: unknown; type?: unknown } | null;
    if (typeof value?.path !== 'string' || typeof value?.type !== 'string') return null;
    const verified = proof.verify(value.authorization, value.path, value.type);
    if (!verified || verified.expected.contractId !== call.expected.contractId || verified.expected.contractVersion !== call.expected.contractVersion
      || verified.expected.compositionId !== call.expected.compositionId) return null;
    return verified.context;
  };
}
