import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initTRPC } from '@trpc/server';
import { createP2PNode, createSharedSecretSecurity, verifyPinnedSignedTicket, type P2PNode, type PeerContext } from '@arduano/p2prpc-core';
import { createHostPeerContext } from '../src/node/host-proof.js';
import { createP2pHostRpcPort } from '../src/node/host-rpc.js';
import { createRemoteHost, mountRemoteHost, readRemoteHostDescriptor } from '../src/node/remote-host.js';
import { GatewayCoordinator } from '../src/gateway/coordinator.js';
import { GatewayClient } from '../src/client/coordinator.js';
import { HttpGatewayTransport } from '../src/client/http.js';
import { listenLoopback } from '../src/http/server.js';
import { HistoryWorkspace } from '../../v8-history/src/client/workspace.js';
import type { Scope } from '../../v8-history/src/contracts/types.js';
import { canonical } from '../../v8-session/src/contracts/validation.js';
import type { HostRpcPort } from '../src/contracts/rpc.js';
import { FileHost } from '../../v8-files/src/host/index.js';
import { FileError, type FilePort, type FileScope } from '../../v8-files/src/contracts/types.js';
import { createRemoteFiles } from '../src/node/remote-files.js';
import { peerFileMetadataSchema, sha256, withHostFileContext, type PeerFileMetadata } from '../src/node/peer-files.js';
import { remoteFixture } from './remote-host-fixture.js';
import { ownedPeerFixture } from './owned-peer-fixture.js';
import { deferred, historyScope, request, scope, target, until } from './fixture.js';

test('direct Host facade and bounded verified files use actual pinned Peer auth/proofs without another owner', { timeout: 25000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v8-peer-files-')), cwd = join(directory, 'workspace'); await mkdir(cwd);
  const fileScope: FileScope = { connection: target.connection, principal: target.principal, host: target.host, session: 'native' };
  const fileHost = await FileHost.open({ directory: join(directory, 'files'), bindings: [{ scope: fileScope, cwd, dialect: 'posix' }] });
  let hostWrites = 0, holdRead: { entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | undefined;
  let holdAcquire: typeof holdRead;
  const filePort: FilePort = { async call(method, input) {
    if (method === 'write') hostWrites++;
    if (method === 'acquire' && holdAcquire) { holdAcquire.entered.resolve(); await holdAcquire.release.promise; }
    if (method === 'read' && holdRead) { holdRead.entered.resolve(); await holdRead.release.promise; }
    return fileHost.call(method, input);
  } };
  const f = await remoteFixture({ actions: ['read', 'control', 'catalogWrite', 'mcpRefresh', 'fileWrite'], files: { port: filePort, scope: () => fileScope } }), nodes: P2PNode<any>[] = [], peers = new Set<string>(), secret = randomBytes(32), hostKey = randomBytes(32);
  const clientRouter = initTRPC.context<PeerContext>().create().router({}), protocol = { applicationId: 'multiplex-v8-direct-host-qualification', contractVersion: '1' };
  const iroh = { bindAddress: '127.0.0.1:0', relay: { mode: 'disabled' as const }, discovery: { dns: false, mdns: false },
    allowAdvertisedAddress: (address: string) => address.startsWith('127.0.0.1:'), allowDirectAddress: (address: string) => address.startsWith('127.0.0.1:'), allowRelayUrl: () => false };
  const gateway = new GatewayCoordinator(); let remote: ReturnType<typeof createRemoteHost> | undefined, mount: ReturnType<typeof mountRemoteHost> | undefined;
  let stream: ReturnType<GatewayCoordinator['watchHistory']> | undefined;
  let files: ReturnType<typeof createRemoteFiles> | undefined;
  try {
    // The pinned ticket publisher omits loopback. Bootstrap only this fixture's
    // freshly reserved exact UDP port with its own valid endpoint signature.
    const reservation = createSocket('udp4');
    await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.bind(0, '127.0.0.1', resolve); });
    const address = `127.0.0.1:${reservation.address().port}`;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const verifiedContext = createHostPeerContext({ host: f.host, proof: f.proof,
        allowPeer: ctx => peers.has(ctx.p2p.peer.id) && ctx.p2p.auth.principal.subject === ctx.p2p.peer.id,
        descriptor: { target: f.hostTarget, manifest: f.host.manifest } });
    const host: P2PNode<typeof f.router, PeerFileMetadata> = await createP2PNode({ router: f.router, protocol, security: createSharedSecretSecurity(secret, { authorize: () => true }), fileMetadataSchema: peerFileMetadataSchema,
      iroh: { ...iroh, secretKey: hostKey, bindAddress: address }, createContext: async ctx => withHostFileContext(await verifiedContext(ctx), ctx, () => host.getPeer(ctx.p2p.peer.id)) });
    nodes.push(host);
    const client = await createP2PNode<typeof clientRouter, PeerFileMetadata>({ router: clientRouter, protocol, security: createSharedSecretSecurity(secret, { authorize: () => true }), fileMetadataSchema: peerFileMetadataSchema, iroh, createContext: ctx => ctx });
    nodes.push(client); peers.add(client.id);
    const original = await host.createTicket(), payload = JSON.parse(Buffer.from(original.split('.')[1]!, 'base64url').toString('utf8')) as { protocol: string };
    const verified = verifyPinnedSignedTicket(original, { expectedPeerId: host.id, expectedProtocol: payload.protocol });
    assert.equal(verified.relayUrl, null);
    const issuedAt = Date.now(), body = Buffer.from(JSON.stringify({ ...verified, directAddresses: [address], issuedAt, expiresAt: issuedAt + 60000 }));
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), hostKey]), type: 'pkcs8', format: 'der' });
    const ticket = `p2prpc3.${body.toString('base64url')}.${sign(null, Buffer.concat([Buffer.from('p2prpc-signed-ticket-v3\0'), body]), key).toString('base64url')}`;
    const peer = await client.connect<typeof f.router>({ locator: { kind: 'ticket', ticket }, expectedPeerId: host.id,
      expectedPrincipal: { subject: host.id, issuer: null, clientId: null, tenantId: null } });
    const port = createP2pHostRpcPort({ peer, manifest: f.host.manifest, forwardProof: async (identity, input, type) => f.proof.issue(identity, input, type) });
    const staleTarget = { ...f.hostTarget, routeEpoch: 'earlier-route' };
    assert.equal((await readRemoteHostDescriptor({ port, identity: f.identity, target: staleTarget, expected: f.host.manifest })).target.routeEpoch, f.hostTarget.routeEpoch);
    await assert.rejects(port.call(f.identity, { ...f.request('snapshot', { session: target.session }), target: staleTarget, type: 'query' }));
    files = createRemoteFiles({ target: f.hostTarget, expected: f.host.manifest, identity: f.identity, port, files: peer.files });
    remote = createRemoteHost({ target: f.hostTarget, expected: f.host.manifest, creationTarget: f.original().target, identity: f.identity, actions: f.actions, port, files });
    mount = mountRemoteHost(gateway, remote); await mount.ready;
    assert.deepEqual(await gateway.binding(f.identity, target), { run: f.run, history: historyScope });
    const surface = await gateway.fileSurface(f.identity, target, true), bytes = Uint8Array.from({ length: 70000 }, (_, index) => index % 251);
    await surface.port.call('begin', { scope: surface.scope, manifest: { id: 'peer-binary', name: 'image.png', mediaType: 'image/png', bytes: bytes.length, sha256: sha256(bytes) } });
    // The reply is lost only after the actual Host write; recovery reads the
    // same upload/offset and does not dispatch a replacement write.
    let loseReply = true;
    const lossy = createRemoteFiles({ target: f.hostTarget, expected: f.host.manifest, identity: f.identity, files: peer.files,
      port: { ...port, async call(identity, request) { const response = await port.call(identity, request); if (request.path === 'multiplexFiles.write' && loseReply) { loseReply = false; throw Error('scripted lost write reply'); } return response; } } });
    try {
      const writer = lossy.session(target.session); await writer.bind(f.run);
      await assert.rejects(writer.surface.port.call('write', { scope: surface.scope, id: 'peer-binary', offset: 0, data: bytes.subarray(0, 65536) }));
      assert.equal((await surface.port.call('status', { scope: surface.scope, id: 'peer-binary' })).state, 'uploading');
      const status = await surface.port.call('status', { scope: surface.scope, id: 'peer-binary' }); assert.equal(status.state === 'uploading' && status.offset, 65536); assert.equal(hostWrites, 1);
    } finally { await lossy.close(); }
    await surface.port.call('write', { scope: surface.scope, id: 'peer-binary', offset: 65536, data: bytes.subarray(65536) });
    await surface.port.call('commit', { scope: surface.scope, id: 'peer-binary' });
    const leases = await Promise.all(Array.from({ length: 4 }, () => surface.port.call('acquire', { scope: surface.scope, id: 'peer-binary' })));
    assert.equal(files.leaseCount, 4); await assert.rejects(surface.port.call('acquire', { scope: surface.scope, id: 'peer-binary' }), (error: unknown) => error instanceof FileError && error.code === 'BUSY');
    assert.deepEqual(await surface.port.call('read', { scope: surface.scope, leaseId: leases[0]!.leaseId, offset: 0, length: 65536 }), bytes.subarray(0, 65536));
    for (const lease of leases) await surface.port.call('release', { scope: surface.scope, leaseId: lease.leaseId });
    assert.equal(files.leaseCount, 0);
    const staleFile = await port.call(f.identity, { target: f.hostTarget, expected: { contractId: f.host.manifest.contractId, contractVersion: f.host.manifest.contractVersion, compositionId: f.host.manifest.compositionId },
      type: 'query', path: 'multiplexFiles.scope', input: { session: target.session, run: { ...f.run, generation: 2 } } });
    assert.deepEqual(staleFile, { ok: false, code: 'FENCED' });
    const deniedFiles = createRemoteFiles({ target: f.hostTarget, expected: f.host.manifest, identity: { ...f.identity, actions: ['read'] }, port, files: peer.files });
    try { const denied = deniedFiles.session(target.session); await denied.bind(f.run); await assert.rejects(denied.surface.port.call('abort', { scope: surface.scope, id: 'peer-binary' })); }
    finally { await deniedFiles.close(); }
    const corrupt = createRemoteFiles({ target: f.hostTarget, expected: f.host.manifest, identity: f.identity, port,
      files: { ...peer.files, share(source, policy) { return peer.files.share({ ...source, async readChunk(index, size, signal) { const bytes = Uint8Array.from(await source.readChunk(index, size, signal)); if (bytes.length) bytes[0] = bytes[0]! ^ 1; return bytes; } }, policy); } } });
    try {
      const writer = corrupt.session(target.session); await writer.bind(f.run);
      await writer.surface.port.call('begin', { scope: surface.scope, manifest: { id: 'corrupt-handoff', name: 'data.bin', mediaType: 'application/octet-stream', bytes: 3, sha256: sha256(Uint8Array.of(1, 2, 3)) } });
      await assert.rejects(writer.surface.port.call('write', { scope: surface.scope, id: 'corrupt-handoff', offset: 0, data: Uint8Array.of(1, 2, 3) }));
      const untouched = await writer.surface.port.call('status', { scope: surface.scope, id: 'corrupt-handoff' }); assert.equal(untouched.state === 'uploading' && untouched.offset, 0);
    } finally { await corrupt.close(); }
    assert.equal(hostWrites, 2);
    assert.equal((await fileHost.call('usage', { scope: fileScope })).activeReads, 0);
    assert.equal((await gateway.interactionSnapshot(f.identity, target)).items.length, 0);
    assert.equal((await gateway.mcpSnapshot(f.identity, target, f.run)).freshness, 'unobserved');
    assert.equal((await gateway.nativeRead(f.identity, target, f.run, { type: 'codex.goal' })).type, 'codex.goal');
    stream = gateway.watchHistory(f.identity, { target, scope: historyScope }); await stream.next();
    f.history.emit(historyScope, [{ type: 'start', id: 'published-stream', kind: 'assistant', text: 'native capture fixture' }]);
    const frame = (await stream.next()).value; assert.equal(frame?.kind, 'commit');
    await gateway.submit(f.identity, target, request('one-published-original'));
    assert.equal((await gateway.receipt(f.identity, target, 'one-published-original'))!.id, 'one-published-original');
    await gateway.older(f.identity, target, historyScope, 'explicit-exception');
    assert.equal(f.stats.older, 1); assert.equal(f.stats.recover + f.stats.refresh, 0); assert.equal(f.session.submits.length, 1);
    await gateway.mcpRefresh(f.identity, target, f.run); assert.equal(f.stats.refresh, 1);
    await stream.return(); stream = undefined;
    // Per-request proof failure must not retire or widen the authenticated Peer.
    await assert.rejects(port.call({ ...f.identity, principal: 'foreign' }, { ...f.request('list', {}), type: 'query' }));
    peers.delete(client.id);
    await assert.rejects(port.call(f.identity, { ...f.request('list', {}), type: 'query' }));
    peers.add(client.id);
    assert.equal((await gateway.receipt(f.identity, target, 'one-published-original'))!.state, 'acknowledged');
    const heldFiles = createRemoteFiles({ target: f.hostTarget, expected: f.host.manifest, identity: f.identity, port, files: peer.files });
    const held = heldFiles.session(target.session); await held.bind(f.run);
    holdRead = { entered: deferred<void>(), release: deferred<void>() };
    const acquiring = held.surface.port.call('acquire', { scope: fileScope, id: 'peer-binary' }); void acquiring.catch(() => {});
    await holdRead.entered.promise; let drained = false;
    const draining = heldFiles.close().then(() => { drained = true; }); await Promise.resolve(); assert.equal(drained, false);
    assert.equal((await gateway.receipt(f.identity, target, 'one-published-original'))!.state, 'acknowledged');
    holdRead.release.resolve(); holdRead = undefined; await assert.rejects(acquiring); await draining;
    const deadline = Date.now() + 3000;
    while ((await fileHost.call('usage', { scope: fileScope })).activeReads) { if (Date.now() >= deadline) throw Error('Exact source lease did not release'); await new Promise(resolve => setTimeout(resolve, 5)); }
    mount.close(); await mount.settled;
    const creation = f.original('one-published-create');
    assert.equal((await remote.creation.create(creation)).state, 'created');
    assert.equal((await remote.creation.read(creation)).state, 'created'); assert.equal(f.stats.creates, 1);
    const preparingFiles = createRemoteFiles({ target: f.hostTarget, expected: f.host.manifest, identity: f.identity, port, files: peer.files });
    const preparing = preparingFiles.session(target.session); await preparing.bind(f.run);
    holdAcquire = { entered: deferred<void>(), release: deferred<void>() };
    const acquisition = preparing.surface.port.call('acquire', { scope: fileScope, id: 'peer-binary' }); void acquisition.catch(() => {});
    try {
      await holdAcquire.entered.promise; let facadeDrained = false;
      const closing = f.facade.close().then(() => { facadeDrained = true; }); await Promise.resolve(); assert.equal(facadeDrained, false);
      holdAcquire.release.resolve(); holdAcquire = undefined; await assert.rejects(acquisition); await closing;
      assert.equal((await fileHost.call('usage', { scope: fileScope })).activeReads, 0);
    } finally { holdAcquire?.release.resolve(); holdAcquire = undefined; await preparingFiles.close(); }
    remote.close();
    assert.equal(f.session.state.phase, 'running'); assert.equal(f.session.submits.length, 1);
    await until(() => f.session.listeners.size === 0);
  } finally {
    holdRead?.release.resolve();
    holdAcquire?.release.resolve();
    await stream?.return(); mount?.close(); remote?.close(); gateway.close(); await files?.close();
    const cleanup = await Promise.allSettled(nodes.map(node => node.close()));
    await f.close(); await fileHost.close(); await rm(directory, { recursive: true, force: true }); assert.ok(cleanup.every(value => value.status === 'fulfilled'), 'Owned endpoint cleanup failed');
  }
  assert.equal(nodes.length, 2);
});

test('default published Peer supports two retained five-scope viewers, four held reads and urgent originals without retiring the surviving viewer', { timeout: 60000 }, async t => {
  const f = await remoteFixture(), gateway = new GatewayCoordinator(), releaseReads = deferred<void>();
  const histories: Scope[] = [historyScope, ...Array.from({ length: 4 }, (_, index): Scope => ({ kind: 'codex', origin: historyScope.origin, threadId: `proved-child-${index}` }))];
  const proved = new Set(histories.map(value => canonical(value)));
  for (const value of histories) {
    f.history.open(value, { knownStart: true });
    f.history.emit(value, [{ type: 'start', id: 'retained', kind: 'assistant', text: 'retained captured history' }]);
  }
  let heldReads = 0, interactionUpstreams = 0, mcpUpstreams = 0, watchActive = 0, maxWatchActive = 0, callsActive = 0, maxCallsActive = 0;
  const watchOpens = new Map<string, number>();
  const interactions = f.route.interactions!, mcp = f.route.mcp!;
  // These five exact scopes are trusted scripted Host facts, not browser grants.
  Object.assign(f.route, {
    history: { ...f.route.history, scopes: () => histories },
    authorizeHistory: (value: Scope) => proved.has(canonical(value)),
    controlCatalog: async () => { heldReads++; await releaseReads.promise; return { available: true, choices: [] }; },
    interactions: { ...interactions, subscribe(...args: Parameters<typeof interactions.subscribe>) {
      interactionUpstreams++; const off = interactions.subscribe(...args);
      return () => { interactionUpstreams--; off(); };
    } },
    mcp: { ...mcp, subscribe(...args: Parameters<typeof mcp.subscribe>) {
      mcpUpstreams++; const off = mcp.subscribe(...args);
      return () => { mcpUpstreams--; off(); };
    } },
  });
  let network: Awaited<ReturnType<typeof ownedPeerFixture<typeof f.router>>> | undefined;
  let server: Awaited<ReturnType<typeof listenLoopback>> | undefined, remote: ReturnType<typeof createRemoteHost> | undefined, mount: ReturnType<typeof mountRemoteHost> | undefined;
  const viewers: { history: HistoryWorkspace; client: GatewayClient; transport: HttpGatewayTransport; close(): void }[] = [];
  const pendingReads: Promise<unknown>[] = [];
  let stage = 'endpoint acquisition', samePeer = false, endpointsClosed = false, serverClosed = false, ownersClosed = false;
  let failureCode: string | null = null, pressure: Readonly<{ queued: number; streams: number; bufferedBytes: number; closed: boolean }> | undefined;
  let diagnostics: (() => Promise<NonNullable<typeof pressure>>) | undefined;
  try {
    const verified = createHostPeerContext({ host: f.host, proof: f.proof, descriptor: { target: f.hostTarget, manifest: f.host.manifest },
      allowPeer: ctx => network!.allowed.has(ctx.p2p.peer.id) && ctx.p2p.auth.principal.subject === ctx.p2p.peer.id });
    network = await ownedPeerFixture({ router: f.router, context: async ctx => verified(ctx) });
    const peer = await network.client.connect<typeof f.router>(network.connection), sessionId = peer.session.id;
    diagnostics = async () => { const resources = (await peer.diagnostics()).resources; return { queued: resources.queued, streams: resources.active.streams, bufferedBytes: resources.active.bufferedBytes, closed: resources.closed }; };
    const actual = createP2pHostRpcPort({ peer, manifest: f.host.manifest, forwardProof: async (identity, input, type) => f.proof.issue(identity, input, type) });
    const port: HostRpcPort = { manifest: actual.manifest,
      async call(...args) { callsActive++; maxCallsActive = Math.max(maxCallsActive, callsActive); try { return await actual.call(...args); } finally { callsActive--; } },
      async *watch(identity, input, signal) {
        watchOpens.set(input.path, (watchOpens.get(input.path) ?? 0) + 1); watchActive++; maxWatchActive = Math.max(maxWatchActive, watchActive);
        try { yield* actual.watch(identity, input, signal); } finally { watchActive--; }
      },
    };
    remote = createRemoteHost({ target: f.hostTarget, expected: f.host.manifest, creationTarget: f.original().target, identity: f.identity, actions: f.actions, port });
    mount = mountRemoteHost(gateway, remote); await mount.ready;
    server = await listenLoopback(gateway, async authorization => authorization === 'Bearer owned-viewer' ? f.identity : null);
    for (let index = 0; index < 2; index++) {
      const history = new HistoryWorkspace({ connection: scope.connection, principal: scope.principal });
      const transport = new HttpGatewayTransport({ url: server.url, authorization: 'Bearer owned-viewer' });
      const client = new GatewayClient({ transport, history, targets: [target], onFence() {} });
      const releases = [client.subscribe(scope, () => {}), client.interactionPort(scope).subscribe(scope, () => {}), client.mcpPort(scope).subscribe(f.run, () => {})];
      const leases = histories.map((value, ordinal) => {
        history.session(value).setPinned(true);
        const view = history.select(value, `retained-${ordinal}`), observed = client.observeHistory(scope, value);
        return () => { view.release(); observed.release(); };
      });
      let closed = false;
      viewers.push({ history, client, transport, close() { if (closed) return; closed = true; releases.forEach(release => release()); leases.forEach(release => release()); client.close(); } });
    }
    stage = 'two viewers and shared upstreams';
    await until(() => histories.every(value => f.history.owner(value).subscriberCount === 2)
      && viewers.every(viewer => histories.every(value => viewer.history.session(value).client.current?.rows.length === 1))
      && f.session.listeners.size === 1 && interactionUpstreams === 1 && mcpUpstreams === 1 && watchActive === 14, 10000);
    assert.equal(watchOpens.get('multiplex.historyWatch'), 10);
    for (const name of ['sessions', 'sessionWatch', 'interactionsWatch', 'mcpWatch']) assert.equal(watchOpens.get(`multiplex.${name}`), 1);
    assert.equal(gateway.observation.subscribers, 16, 'two consumers each retain five histories and three domain feeds');
    assert.equal(f.stats.older + f.stats.recover + f.stats.refresh + f.stats.nativeRead, 0);

    stage = 'four held reads and urgent forwarding';
    for (let index = 0; index < 4; index++) { const pending = viewers[index % 2]!.transport.controlCatalog(target); void pending.catch(() => {}); pendingReads.push(pending); }
    await until(() => heldReads === 4 && gateway.observation.optionalReads === 4);
    const urgent = [
      { scope, id: 'capacity-stop', generation: 1, command: { type: 'stop' as const } },
      { scope, id: 'capacity-answer', generation: 1, command: { type: 'answer' as const, interactionId: 'scripted-pending', choice: 'decision:1', value: { type: 'codex.command' as const, decisionId: 'decision:1' } } },
    ];
    const replies = await Promise.all(urgent.map((original, index) => viewers[index]!.transport.submit(target, original)));
    assert.ok(replies.every(value => value.state === 'acknowledged'));
    assert.deepEqual([...f.session.submits].sort((a, b) => a.id.localeCompare(b.id)), [...urgent].sort((a, b) => a.id.localeCompare(b.id)), 'only these two exact scripted originals reach the Host; concurrent delivery has no ordering contract');
    assert.equal(heldReads, 4); assert.equal(gateway.observation.optionalReads, 4, 'urgent originals do not release or replay held reads');
    releaseReads.resolve(); await Promise.all(pendingReads); await until(() => gateway.observation.optionalReads === 0 && callsActive === 0);

    stage = 'one viewer releases, surviving pins remain live';
    viewers[0]!.close();
    await until(() => histories.every(value => f.history.owner(value).subscriberCount === 1) && gateway.observation.subscribers === 8 && watchActive === 9);
    assert.equal(f.session.listeners.size, 1); assert.equal(interactionUpstreams, 1); assert.equal(mcpUpstreams, 1);
    for (const value of histories) f.history.emit(value, [{ type: 'append', id: 'retained', kind: 'assistant', text: ' + surviving viewer' }]);
    await until(() => histories.every(value => {
      const body = viewers[1]!.history.session(value).client.current?.rows[0]?.body;
      return body && body.kind !== 'unavailable' && body.text.endsWith('surviving viewer');
    }));
    assert.equal((await viewers[1]!.transport.snapshot(target)).phase, 'running'); samePeer = peer.session.id === sessionId; assert.equal(samePeer, true);
    assert.ok(histories.every(value => viewers[0]!.history.session(value).pinned && viewers[0]!.history.session(value).client.current?.rows.length === 1));
    assert.equal(watchOpens.get('multiplex.historyWatch'), 10, 'viewer release never restarts any upstream');
    stage = 'exact observer drain';
    viewers[1]!.close(); await until(() => histories.every(value => f.history.owner(value).subscriberCount === 0)
      && f.session.listeners.size === 0 && interactionUpstreams === 0 && mcpUpstreams === 0 && gateway.observation.subscribers === 0 && watchActive === 1);
    mount.close(); await mount.settled; remote.close();
    await until(() => watchActive === 0 && callsActive === 0);
    const drainDeadline = Date.now() + 5000;
    for (;;) {
      const resources = (await peer.diagnostics()).resources;
      if (resources.queued === 0 && resources.active.streams === 0 && resources.active.bufferedBytes === 0) { pressure = await diagnostics(); break; }
      assert.ok(Date.now() < drainDeadline, 'Published stream and byte leases did not drain');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.deepEqual([...f.session.submits].sort((a, b) => a.id.localeCompare(b.id)), [...urgent].sort((a, b) => a.id.localeCompare(b.id)), 'closing viewers must not add or change either exact original');
    assert.equal(f.stats.older + f.stats.recover + f.stats.refresh + f.stats.nativeRead, 0);
    stage = 'passed';
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    failureCode = typeof code === 'string' && ['FULL', 'UNAVAILABLE', 'TIMEOUT', 'FENCED', 'CLOSED', 'OVERFLOW', 'ERR_ASSERTION'].includes(code) ? code : 'other';
    try { pressure = await diagnostics?.(); } catch { /* A failed Peer may no longer expose resource diagnostics. */ }
    throw error;
  } finally {
    releaseReads.resolve(); await Promise.allSettled(pendingReads);
    for (const viewer of viewers) { viewer.close(); for (const value of histories) viewer.history.session(value).setPinned(false); }
    mount?.close(); if (mount) await mount.settled.catch(() => {}); remote?.close(); gateway.close();
    const cleanup = await Promise.allSettled([
      server?.close().then(() => { serverClosed = true; }),
      network?.close().then(() => { endpointsClosed = true; }),
      f.close().then(() => { ownersClosed = true; }),
    ]);
    t.diagnostic(JSON.stringify({ stage, failureCode, pressure, configured: { endpoints: 2, viewers: 2, historyScopesPerViewer: 5, heldReads: 4, defaultPeerLimits: true },
      watchOpens: Object.fromEntries(watchOpens), maxWatchActive, maxCallsActive, samePeer, heldReads,
      effects: { scriptedOriginals: f.session.submits.map(value => value.command.type), sends: f.session.submits.filter(value => value.command.type === 'send').length,
        resumes: f.session.submits.filter(value => value.command.type === 'resume').length, nativeReads: f.stats.nativeRead, historyReads: f.stats.older + f.stats.recover, discoveries: f.stats.refresh },
      cleanup: { endpointsClosed, serverClosed, ownersClosed, watchActive, callsActive, historySubscribers: histories.map(value => f.history.owner(value).subscriberCount) } }));
    assert.ok(cleanup.every(value => value.status === 'fulfilled'), 'Owned published-capacity resources did not close');
  }
});
