import test from 'node:test';
import assert from 'node:assert/strict';
import type { Peer, PeerContext } from '@arduano/p2prpc-core';
import type { ArchivePublication, CatalogEntry, CatalogPort, CatalogScope, CreateRequest, Creation } from '../../v8-catalog/src/contracts/types.js';
import { createGatewayCatalogPort } from '../src/client/catalog-port.js';
import { GatewayCoordinator } from '../src/gateway/coordinator.js';
import { createP2pGatewayRouter, P2pGatewayTransport, type GatewayP2pRouter } from '../src/node/p2prpc.js';
import type { PeerObserver } from '../src/node/peer-observer.js';
import { alice, target, until } from './fixture.js';

test('exact-scope catalog bridge forwards the P2P catalog vocabulary once and owns only cancellable observation leases', { timeout: 10000 }, async () => {
  const scope: CatalogScope = { connection: alice.connection, principal: alice.principal, authority: 'root' };
  const foreign = { ...scope, authority: 'different-root' };
  const original: CreateRequest = { scope, id: 'create-original', session: 'logical',
    target: { host: target.host, owner: target.owner, kind: 'codex', placement: 'dedicated' }, metadata: { name: null, cwd: null } };
  let row: CatalogEntry | null = null, created: Creation | null = null, creates = 0, archives = 0, reads = 0, setups = 0, returns = 0, peerCloses = 0;
  let corruptReply = false;
  const listeners = new Set<(entry: CatalogEntry) => void>(), tasks = new Set<Promise<void>>(), losses: unknown[] = [];
  const publish = () => { for (const listener of listeners) listener(row!); };
  const owner: CatalogPort = {
    async list() { reads++; return row ? [corruptReply ? { ...row, scope: foreign } : row] : []; },
    async get() { return row; },
    async create(request) { creates++; row = { scope: request.scope, session: request.session, target: request.target, createId: request.id, version: 1, revision: 1, metadata: request.metadata, binding: null };
      created = { original: request, entry: row, state: 'reserved', native: null, publication: 'committed' }; publish(); return created; },
    async creation() { return created; },
    async rename(request) { row = { ...row!, revision: row!.revision + 1, metadata: { ...row!.metadata, name: request.name } }; publish(); return row; },
    async setWatched(request) { row = { ...row!, revision: row!.revision + 1, metadata: { ...row!.metadata, watched: request.watched } }; publish(); return row; },
    async metadataOriginal() { return null; },
    async publishArchive(request) { archives++; row = { ...row!, archive: { id: request.id, generation: request.generation } }; publish(); return row; },
    subscribe(_scope, listener) { listeners.add(listener); return () => { listeners.delete(listener); returns++; }; },
  };
  const root = new GatewayCoordinator(); root.registerCatalog({ scope, owner: 'only-root-catalog', port: owner, actions: ['read', 'catalogWrite'] });
  const router = createP2pGatewayRouter(root, () => alice), caller = router.createCaller({ p2p: { peer: {}, auth: {} } } as PeerContext);
  // Actual router/coordinator and transport run in-process. Only the published
  // Peer call/subscription seam is supplied; no endpoint or native process runs.
  const peer = { close() { peerCloses++; }, rpc: {
    catalogList: { query: caller.catalogList }, catalogGet: { query: caller.catalogGet },
    catalogCreate: { mutate: caller.catalogCreate }, catalogCreation: { query: caller.catalogCreation },
    catalogRename: { mutate: caller.catalogRename }, catalogSetWatched: { mutate: caller.catalogSetWatched },
    catalogMetadataOriginal: { query: caller.catalogMetadataOriginal }, catalogPublishArchive: { mutate: caller.catalogPublishArchive },
    catalogWatch: { subscribe(input: { scope: CatalogScope }, callbacks: PeerObserver<CatalogEntry>) {
      setups++; const controller = new AbortController();
      const task = (async () => {
        try {
          const source = await router.createCaller({ p2p: { peer: {}, auth: {} } } as PeerContext, { signal: controller.signal }).catalogWatch(input); callbacks.onStarted();
          for await (const value of source) callbacks.onData(value);
          callbacks.onComplete();
        } catch (error) { callbacks.onError(error); }
      })();
      tasks.add(task); void task.finally(() => tasks.delete(task));
      return { unsubscribe: () => controller.abort() };
    } },
  } } as unknown as Peer<GatewayP2pRouter>;
  const transport = new P2pGatewayTransport(peer), configuredScope = { ...scope };
  const bridge = createGatewayCatalogPort({ scope: configuredScope, transport, onUnavailable: error => losses.push(error) });
  const a: CatalogEntry[] = [], b: CatalogEntry[] = [];
  try {
    configuredScope.authority = 'caller-mutated';
    await bridge.ready; assert.equal(listeners.size, 1); assert.equal(setups, 1);
    assert.deepEqual(await bridge.port.list(scope), [], 'A fresh root is honestly empty');
    await assert.rejects(bridge.port.list(foreign), { code: 'FENCED' }); assert.equal(reads, 1, 'Wrong scope never reaches the remote owner');
    assert.throws(() => bridge.port.subscribe(foreign, () => {}), { code: 'FENCED' });
    const stopA = bridge.port.subscribe(scope, value => a.push(value)); bridge.port.subscribe(scope, value => b.push(value));
    await bridge.port.create(original); await until(() => a.length === 1 && b.length === 1);
    assert.deepEqual((await bridge.port.creation(scope, original.id))?.original, original); assert.equal(creates, 1);
    stopA(); stopA(); assert.equal(listeners.size, 1); assert.equal(returns, 0);
    const renamed = await bridge.port.rename({ scope, session: original.session, id: 'rename', revision: 1, name: 'Renamed' });
    await bridge.port.setWatched({ scope, session: original.session, id: 'watched', revision: renamed.revision, watched: true });
    const archive: ArchivePublication = { scope, session: original.session, id: 'archive-original', generation: 1 };
    assert.deepEqual((await bridge.port.publishArchive!(archive)).archive, { id: archive.id, generation: archive.generation });
    await until(() => b.length === 4); assert.equal(a.length, 1); assert.equal(archives, 1); assert.equal(setups, 1);
    assert.equal(await bridge.port.metadataOriginal(scope, 'missing-original'), null);
    corruptReply = true; await assert.rejects(bridge.port.list(scope), { code: 'FENCED' }); corruptReply = false;
    const quiet = createGatewayCatalogPort({ scope, transport, onUnavailable: error => losses.push(error) });
    await quiet.ready; assert.equal(listeners.size, 2); await quiet.close();
    assert.equal(listeners.size, 1); assert.equal(returns, 1, 'Quiet close aborts pending next and drains its exact upstream');
    assert.deepEqual((await transport.get(scope, original.session))?.archive, { id: archive.id, generation: archive.generation });
    root.close(); await until(() => losses.length === 1); assert.equal(setups, 2, 'Observation loss never retries or replays a mutation');
    await bridge.close(); await bridge.close(); await Promise.all([...tasks]);
    assert.equal(listeners.size, 0); assert.equal(returns, 2); assert.equal(peerCloses, 0); assert.equal(creates, 1); assert.equal(archives, 1);
    await assert.rejects(bridge.port.get(scope, original.session), { code: 'CLOSED' });
    assert.throws(() => bridge.port.subscribe(scope, () => {}), { code: 'CLOSED' });
  } finally { root.close(); await bridge.close(); transport.close(); await Promise.all([...tasks]); }
});
