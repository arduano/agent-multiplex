import assert from 'node:assert/strict';
import test from 'node:test';
import { TRPCError } from '@trpc/server';
import { hostProcedure, hostRouter } from '../../v8-plugins/src/router.js';
import type { HostManifest } from '../../v8-plugins/src/contracts.js';
import { GatewayCoordinator } from '../src/gateway/coordinator.js';
import { createInProcessHostRpcPort } from '../src/node/in-process-host.js';

test('actual query/subscription Host context receives only this registration grants, never the account union', async () => {
  const target = { connection: 'fixture', principal: 'owner', authority: 'catalog', host: 'host', owner: 'durable-owner', routeEpoch: 'route-1' };
  const manifest: HostManifest = { contractId: 'fixture.private-query', contractVersion: 1, compositionId: 'fixture', harness: { id: 'fixture.harness', version: 1, recordVersion: 1 }, lifecycle: { id: 'fixture.lifecycle', version: 1, recordVersion: 1 }, extensions: {} };
  const seen: readonly string[][] = [], received = seen as string[][];
  const router = hostRouter({
    privateQuery: hostProcedure.query(({ ctx }) => { if (!ctx.identity.actions.includes('control')) throw new TRPCError({ code: 'FORBIDDEN' }); return 'private transient response'; }),
    privateWatch: hostProcedure.subscription(async function* ({ ctx }) { if (!ctx.identity.actions.includes('control')) throw new TRPCError({ code: 'FORBIDDEN' }); yield 'private transient response'; }),
  });
  const port = createInProcessHostRpcPort({ router, manifest, context: async identity => {
    received.push([...identity.actions]);
    return { identity: { connection: identity.connection, principal: identity.principal, actions: identity.actions }, route: target };
  } });
  const caller = Object.freeze({ connection: target.connection, principal: target.principal, authorities: Object.freeze(['catalog']), actions: Object.freeze(['read', 'control'] as const) });
  const request = { target, expected: { contractId: manifest.contractId, contractVersion: manifest.contractVersion, compositionId: manifest.compositionId }, path: 'privateQuery' };
  const readOnly = new GatewayCoordinator(), full = new GatewayCoordinator();
  readOnly.registerHostRpc({ target, actions: ['read'], port }); full.registerHostRpc({ target, actions: ['read', 'control'], port });
  try {
    assert.deepEqual(await readOnly.rpcCall(caller, { ...request, type: 'query' }), { ok: false, error: { code: 'FORBIDDEN', message: 'FORBIDDEN' } });
    const denied = readOnly.watchRpc(caller, { ...request, path: 'privateWatch' });
    try { assert.deepEqual((await denied.next()).value, { ok: false, error: { code: 'FORBIDDEN', message: 'FORBIDDEN' } }); } finally { await denied.return(); }
    assert.deepEqual(seen, [['read'], ['read']]);
    assert.deepEqual(await full.rpcCall(caller, { ...request, type: 'query' }), { ok: true, value: 'private transient response' });
    const allowed = full.watchRpc(caller, { ...request, path: 'privateWatch' });
    try { assert.deepEqual((await allowed.next()).value, { ok: true, value: 'private transient response' }); } finally { await allowed.return(); }
    assert.deepEqual(caller.actions, ['read', 'control']); assert.deepEqual(caller.authorities, ['catalog']);
  } finally { readOnly.close(); full.close(); }
});
