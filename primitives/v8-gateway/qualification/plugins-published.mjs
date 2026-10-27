import assert from 'node:assert/strict';
import { randomBytes, createPrivateKey, sign } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAdvancedP2PNode } from '@arduano/p2prpc-core/advanced';
import { createSharedSecretSecurity, verifyPinnedSignedTicket } from '@arduano/p2prpc-core';
import { createP14EndpointHarness } from './p14-endpoint.mjs';
const here = dirname(fileURLToPath(import.meta.url));
/** Actual published shared Peer, actual Host router and authenticated HTTP mux.
 * Domain effects are scripted. No model/native agent/session is started. */
export async function runPluginPublishedQualification({ buildRoot = resolve(here, '../.build') } = {}) {
  const load = path => import(pathToFileURL(resolve(buildRoot, path)).href);
  const [{ pluginDefinition }, { alice, target, until }, { activateHost }, { createHmacHostProof, authenticateHostProof, createHostPeerContext },
    { createP2pHostRpcPort }, { GatewayCoordinator }, { listenLoopback }, { HttpGatewayTransport }, { createGatewayHostClient }] = await Promise.all([
    load('primitives/v8-gateway/qualification/plugins-fixture.js'), load('primitives/v8-gateway/qualification/fixture.js'), load('primitives/v8-plugins/src/index.js'),
    load('primitives/v8-gateway/src/node/host-proof.js'), load('primitives/v8-gateway/src/node/host-rpc.js'), load('primitives/v8-gateway/src/gateway/coordinator.js'),
    load('primitives/v8-gateway/src/http/server.js'), load('primitives/v8-gateway/src/client/http.js'), load('primitives/v8-gateway/src/client/rpc.js'),
  ]);
  const domain = pluginDefinition(), { session: _session, ...hostTarget } = target, cases = [], nodes = [], transports = [], controls = [];
  const proof = createHmacHostProof({ issuer: 'owned-gateway', audience: 'owned-host', secret: randomBytes(32) });
  const host = await activateHost(domain.definition, { route: hostTarget, storage: {}, authenticate: authenticateHostProof(proof) });
  const coordinator = new GatewayCoordinator(), pins = new Set(), secret = randomBytes(32), protocol = { applicationId: 'v8-plugin-owned-proof', contractVersion: '1' };
  const reservation = createSocket('udp4'); await new Promise((yes, no) => { reservation.once('error', no); reservation.bind(0, '127.0.0.1', yes); });
  const address = `127.0.0.1:${reservation.address().port}`; await new Promise(yes => reservation.close(yes));
  const hostKey = randomBytes(32), hostProbe = createP14EndpointHarness({ maxEvents: 2048, iroh: { bindAddress: address, secretKey: hostKey } });
  const gatewayProbe = createP14EndpointHarness({ maxEvents: 2048 }); let server, barrier, cleanup = false;
  const authChecks = [];
  const context = createHostPeerContext({ host, proof, allowPeer: ctx => pins.has(ctx.p2p.peer.id) && ctx.p2p.auth.principal.subject === ctx.p2p.peer.id });
  const options = probe => ({ router: host.router, protocol, endpointFactory: probe.endpointFactory, createContext: async ctx => {
    if (authChecks.length < 16) authChecks.push({ peerPinned: pins.has(ctx.p2p.peer.id), principalMatches: ctx.p2p.auth.principal.subject === ctx.p2p.peer.id,
      path: ctx.p2p.request.path, type: ctx.p2p.request.type, hasProof: typeof ctx.p2p.request.headers['x-multiplex-host-proof'] === 'string',
      proofValid: !!proof.verify(ctx.p2p.request.headers['x-multiplex-host-proof'], ctx.p2p.request.path, ctx.p2p.request.type) });
    return context(ctx);
  },
    security: createSharedSecretSecurity(secret, { authorize: ctx => pins.has(ctx.remotePeerId) && ctx.principal.id === ctx.remotePeerId }), preAuthorizePeer: peer => pins.has(peer.id) });
  try {
    const endpoint = await createAdvancedP2PNode(options(hostProbe)); nodes.push(endpoint);
    const gateway = await createAdvancedP2PNode(options(gatewayProbe)); nodes.push(gateway); pins.add(endpoint.id); pins.add(gateway.id);
    const originalTicket = await endpoint.createTicket(), originalBody = JSON.parse(Buffer.from(originalTicket.split('.')[1], 'base64url').toString('utf8'));
    const original = verifyPinnedSignedTicket(originalTicket, { expectedPeerId: endpoint.id, expectedProtocol: originalBody.protocol });
    const issuedAt = Date.now(), body = Buffer.from(JSON.stringify({ ...original, directAddresses: [address], issuedAt, expiresAt: issuedAt + 90000 }));
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), hostKey]), format: 'der', type: 'pkcs8' });
    const signature = sign(null, Buffer.concat([Buffer.from('p2prpc-signed-ticket-v3\0'), body]), key), ticket = `p2prpc3.${body.toString('base64url')}.${signature.toString('base64url')}`;
    verifyPinnedSignedTicket(ticket, { expectedPeerId: endpoint.id, expectedProtocol: originalBody.protocol });
    const peer = await gateway.connect({ locator: { kind: 'ticket', ticket }, expectedPeerId: endpoint.id, expectedPrincipal: { subject: endpoint.id, issuer: null, tenantId: null, clientId: null } });
    await assert.rejects(peer.rpc.extensions.workspace.inspect.query());
    const port = createP2pHostRpcPort({ peer, manifest: host.manifest, forwardProof: async (identity, request, type) => proof.issue(identity, request, type) });
    coordinator.registerHostRpc({ target: hostTarget, port });
    server = await listenLoopback(coordinator, async authorization => authorization === 'Bearer owned-viewer' ? alice : null);
    const make = () => { const transport = new HttpGatewayTransport({ url: server.url, authorization: 'Bearer owned-viewer' }); transports.push(transport); return createGatewayHostClient({ transport, target: hostTarget, expected: host.manifest }); };
    const a = make(), b = make();
    let inspected; try { inspected = await a.extensions.workspace.inspect.query(); } catch (cause) { throw Error(`Plugin Host context refused: ${JSON.stringify(authChecks)}`, { cause }); }
    assert.deepEqual(inspected, { directory: 'directory', bytes: 42 });
    cases.push('actual custom Host router crosses authenticated HTTP and pinned published Iroh; direct Peer without Gateway proof is denied');
    const left = [], right = [];
    const one = a.extensions.workspace.watch.subscribe(undefined, { onData: value => left.push(value.revision) });
    const two = b.extensions.workspace.watch.subscribe(undefined, { onData: value => right.push(value.revision) }); controls.push(one, two);
    await until(() => left.length === 1 && right.length === 1);
    barrier = gatewayProbe.armOpenBarrier(); const controller = new AbortController();
    const expected = { contractId: host.manifest.contractId, contractVersion: host.manifest.contractVersion, compositionId: host.manifest.compositionId };
    const iterator = port.watch(alice, { target: hostTarget, expected, path: 'extensions.workspace.watch' }, controller.signal)[Symbol.asyncIterator]();
    const pending = iterator.next(); await barrier.acquired; controller.abort(); assert.equal((await pending).done, true);
    assert.equal(gatewayProbe.events().some(event => event.operation === 'close'), false);
    barrier.release(); await until(() => domain.stats().watchers === 2); await iterator.return?.();
    domain.emit(); await until(() => right.at(-1) === 2 && left.at(-1) === 2);
    one.unsubscribe(); await until(() => domain.stats().watchers === 1); domain.emit(); await until(() => right.at(-1) === 3); assert.deepEqual(left, [1, 2]);
    cases.push('new generic Host stream cancelled during actual raw open waits for onStarted; both healthy viewers survive on the one shared Peer');
    const receipt = await b.extensions.workspace.claim.submit.mutate({ id: 'published-original', input: { label: 'one effect' } });
    assert.deepEqual(await a.extensions.workspace.claim.original.query({ id: 'published-original' }), receipt); assert.equal(domain.stats().effects, 1);
    cases.push('custom mutation and original lookup traverse the actual Host router on shared published transport with one scripted effect');
  } finally {
    barrier?.release(); hostProbe.releaseAll(); gatewayProbe.releaseAll(); for (const control of controls) control.unsubscribe(); for (const transport of transports) transport.close();
    coordinator.close(); await server?.close(); const results = await Promise.allSettled(nodes.map(node => node.close()));
    await host.close(); proof.revoke(); assert.ok(results.every(result => result.status === 'fulfilled')); cleanup = true;
  }
  return { passed: true, cases, cleanup, endpoints: nodes.length, liveNativeOrModelCalls: 0, boundary: 'custom plugin router + actual HTTP + two fresh published Iroh endpoints + real raw-open cancellation barrier' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPluginPublishedQualification({ buildRoot: process.argv[2] }).then(value => process.stdout.write(JSON.stringify(value) + '\n')).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
}
