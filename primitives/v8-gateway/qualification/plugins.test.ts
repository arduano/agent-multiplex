import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { rpcFixture } from './plugins-fixture.js';
import { alice, until } from './fixture.js';
import { GatewayClient } from '../src/client/coordinator.js';
import { HistoryWorkspace } from '../../v8-history/src/client/workspace.js';
import { createHmacHostProof } from '../src/node/host-proof.js';

test('actual Host tRPC schemas traverse authenticated HTTP; optional input, scope and sanitized errors', async () => {
  const f = await rpcFixture();
  try {
    assert.deepEqual(await f.client.extensions.workspace.inspect.query(), { directory: 'directory', bytes: 42 });
    assert.deepEqual(await f.client.extensions.workspace.inspect.query({ prefix: 'custom-' }), { directory: 'custom-directory', bytes: 42 });
    await assert.rejects(f.client.extensions.workspace.privateFailure.query(), error => !String(error).includes('secret'));
    await assert.rejects(async () => f.coordinator.rpcCall({ ...alice, principal: 'other' }, { ...f.request('extensions.workspace.inspect'), type: 'query' }), /FORBIDDEN/);
    await assert.rejects(async () => f.coordinator.rpcCall(alice, { ...f.request('extensions.workspace.inspect'), expected: { ...f.request('extensions.workspace.inspect').expected, compositionId: 'old' }, type: 'query' }), /FENCED/);
    const invalid = await f.transport.rpcCall({ ...f.request('extensions.workspace.claim.submit', { id: 'bad', input: { label: 42 } }), type: 'mutation' });
    assert.equal(invalid.ok, false); assert.equal(f.stats().effects, 0);
  } finally { await f.close(); }
});

test('lost custom mutation reply reads the one domain original; reconnect never resubmits', async () => {
  let lose = true;
  const f = await rpcFixture({ fetch: async (input, init) => {
    const response = await fetch(input, init), body = JSON.parse(String(init?.body));
    if (lose && body.op === 'rpc.call' && body.request.type === 'mutation') { lose = false; await response.arrayBuffer(); throw Error('lost after admission'); }
    return response;
  } });
  try {
    await assert.rejects(f.client.extensions.workspace.claim.submit.mutate({ id: 'original', input: { label: 'one effect' } }));
    assert.deepEqual(await f.client.extensions.workspace.claim.original.query({ id: 'original' }), { id: 'original', label: 'one effect' });
    assert.equal(f.stats().effects, 1);
    f.transport.disconnect(); f.transport.reconnect();
    assert.equal((await f.client.extensions.workspace.claim.original.query({ id: 'original' }))!.id, 'original');
    assert.equal(f.stats().effects, 1);
  } finally { await f.close(); }
});

test('custom unary observation cancellation retains actual admission and reserved trusted lane', async () => {
  const f = await rpcFixture({ limits: { forward: 1, urgent: 1 } }), gate = f.hold();
  const abort = new AbortController();
  try {
    const pending = f.client.extensions.workspace.claim.submit.mutate({ id: 'held', input: { label: 'one' } }, { signal: abort.signal });
    void pending.catch(() => {}); await until(() => f.stats().effects === 1); abort.abort();
    assert.equal(f.coordinator.observation.active, 1);
    await assert.rejects(f.transport.rpcCall({ ...f.request('extensions.workspace.claim.submit', { id: 'saturated', input: { label: 'two' } }), type: 'mutation' }), /FULL/);
    const urgent = f.transport.rpcCall({ ...f.request('extensions.workspace.claim.submit', { id: 'trusted-urgent-fixture', input: { label: 'urgent' } }), type: 'mutation' });
    await until(() => f.coordinator.observation.urgent === 1); gate.resolve();
    await urgent; await pending.catch(() => {}); await until(() => f.coordinator.observation.active === 0 && f.coordinator.observation.urgent === 0);
    assert.equal(f.stats().effects, 2);
  } finally { gate.resolve(); await f.close(); }
});

test('plugin sources share the retained Gateway recovery owner and mux; epoch fences late data', async () => {
  let channels = 0;
  const f = await rpcFixture({ fetch: async (input, init) => { if (JSON.parse(String(init?.body)).op === 'watch.open') channels++; return fetch(input, init); } });
  const history = new HistoryWorkspace({ connection: alice.connection, principal: alice.principal });
  const owner = new GatewayClient({ transport: f.transport, targets: [], hostTargets: [f.target], history, onFence() {} });
  const a: number[] = [], b: number[] = [], labels: string[] = [], states: string[] = [];
  const source = owner.rpcSource(f.request('extensions.workspace.watch'), value => {
    const typed = value as { revision: number }; if (!Number.isSafeInteger(typed.revision)) throw Error('invalid snapshot'); return typed;
  });
  assert.throws(() => owner.bindHostRoute({ ...f.target, owner: 'different-owner' }), /FENCED/);
  const one = source.subscribe(value => a.push(value.revision), state => states.push(state));
  const two = source.subscribe(value => b.push(value.revision), () => {});
  let alternate: { release(): void } | undefined;
  try {
    await until(() => a.length === 1 && b.length === 1); assert.equal(channels, 1); assert.equal(f.stats().subscriptions, 1);
    // Same raw descriptor, different typed projection: neither consumer may
    // receive another parser's result, including a late retained subscriber.
    alternate = owner.rpcSource(f.request('extensions.workspace.watch'), value => `revision:${(value as { revision: number }).revision}`)
      .subscribe(value => labels.push(value), () => {});
    assert.deepEqual(labels, ['revision:1']);
    one.release(); f.emit(); await until(() => b.at(-1) === 2); assert.deepEqual(a, [1]);
    assert.equal(labels.at(-1), 'revision:2'); assert.equal(f.stats().subscriptions, 1);
    owner.disconnect(); owner.reconnect(); await until(() => b.length === 3);
    assert.equal(f.stats().effects, 0); assert.equal(channels, 2); assert.equal(f.stats().subscriptions, 2);
    owner.bindHostRoute({ ...f.target, routeEpoch: 'next' }); f.emit(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(b.length, 3); assert.equal(states.includes('live'), true);
  } finally { one.release(); two.release(); alternate?.release(); owner.close(); await f.close(); }
});

test('backend proof binds identity, route, composition, procedure, expiry and configured peer boundary', async () => {
  const f = await rpcFixture(); let now = 1000;
  const proof = createHmacHostProof({ issuer: 'gateway', audience: 'host', secret: randomBytes(32), now: () => now });
  try {
    const request = f.request('extensions.workspace.inspect'), token = proof.issue(alice, request, 'query', 20);
    assert.equal(proof.verify(token, request.path, 'query')!.context.route.owner, f.target.owner);
    assert.equal(proof.verify(token, 'extensions.workspace.claim.submit', 'mutation'), null);
    assert.equal(proof.verify(token + 'x', request.path, 'query'), null);
    assert.throws(() => proof.issue({ ...alice, actions: ['read'] }, request, 'mutation'), /FORBIDDEN/);
    now += 20; assert.equal(proof.verify(token, request.path, 'query'), null);
    proof.revoke(); assert.throws(() => proof.issue(alice, request, 'query'), /FORBIDDEN/);
  } finally { await f.close(); }
});
