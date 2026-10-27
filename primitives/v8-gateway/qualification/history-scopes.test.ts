import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayCoordinator } from '../src/gateway/coordinator.js';
import { listenLoopback } from '../src/http/server.js';
import { HttpGatewayTransport } from '../src/client/http.js';
import { HistoryHub } from '../../v8-history/src/host/history-owner.js';
import type { Scope } from '../../v8-history/src/contracts/types.js';
import { FixtureSession, alice, bob, target, scope, historyScope, deferred, until } from './fixture.js';

test('actual authenticated HTTP exposes only bounded Host-proved scopes to read identities and revocation fences late inventory', async () => {
  const gateway = new GatewayCoordinator(), session = new FixtureSession(), hub = new HistoryHub();
  const child: Scope = { ...historyScope, kind: 'codex', threadId: 'proved-child' }, run = { scope, generation: 1, nativeSession: 'native' };
  hub.open(historyScope); hub.open(child); let values: readonly Scope[] = [historyScope, child], gate: Promise<void> | undefined, reads = 0;
  gateway.register({ target, session, binding: () => ({ run, history: historyScope }), authorizeHistory: value => { try { hub.snapshot(value); return true; } catch { return false; } }, history: { scopes: async () => { reads++; await gate; return values; }, watch: (scope, cursor) => hub.watch(scope, cursor) } });
  const server = await listenLoopback(gateway, async credential => credential === 'Bearer reader' ? { ...alice, actions: ['read'] } : credential === 'Bearer foreign' ? bob : null);
  const reader = new HttpGatewayTransport({ url: server.url, authorization: 'Bearer reader' }), foreign = new HttpGatewayTransport({ url: server.url, authorization: 'Bearer foreign' });
  try {
    assert.deepEqual(await reader.historyScopes(target), [historyScope, child]); assert.equal(session.submits.length, 0);
    await assert.rejects(foreign.historyScopes(target), { code: 'FORBIDDEN' }); assert.equal(reads, 1);
    values = [historyScope, { ...child, origin: { ...child.origin, attachment: 'unproved' } }]; await assert.rejects(reader.historyScopes(target), { code: 'FENCED' });
    values = [historyScope, child]; const held = deferred<void>(); gate = held.promise;
    const pending = gateway.historyScopes(alice, target); await until(() => reads === 3); gateway.unavailable(target); held.resolve(); await assert.rejects(pending, { code: 'UNAVAILABLE' });
    assert.equal(session.submits.length, 0);
  } finally { reader.close(); foreign.close(); gateway.close(); await server.close(); }
});
