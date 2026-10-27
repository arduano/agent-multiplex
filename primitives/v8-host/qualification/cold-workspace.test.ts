import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHost } from '../../v8-lifecycle-default/src/assembly.js';
import { MultiplexWorkspace } from '../../v8-workspace/src/workspace.js';
import { MemoryDraftPersistence } from '../../v8-files/src/client/persistence.js';
import type { OpeningCapsule } from '../../v8-session/src/contracts/types.js';
import { retireReader } from '../src/native/reader.js';
import type { CatalogPort, CatalogEntry } from '../../v8-catalog/src/contracts/types.js';
import type { HostHistory } from '../src/contracts.js';
import { scriptedHost, until } from './fixture.js';

test('a fresh stopped controller opens the retained workspace without native domains, then explicit Recover alone prepares history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v8-cold-workspace-'));
  const scope = { connection: 'cold-workspace', principal: 'owner', host: 'copilot', session: 'logical' };
  const policy = { kind: 'copilot' as const, provider: 'copilot-only' as const, permissions: 'manual' as const };
  const initial = scriptedHost('copilot', { cwd: directory });
  let host = await openHost({ directory, cwd: directory, scope, policy, controller: initial.controller });
  let workspace: MultiplexWorkspace | undefined, prepared = false, preparations = 0, reads = 0, streams = 0;
  const domains: string[] = [];
  const readerStates: string[] = []; let reader: OpeningCapsule | undefined;
  try {
    await assert.rejects(host.interactions.snapshot(scope), { code: 'FENCED' }, 'No positive native identity is not an empty stopped owner');
    await host.session.submit({ scope, id: 'create', generation: 0, command: { type: 'create' } });
    await until(async () => (await host.session.snapshot(scope)).phase === 'running');
    await host.session.submit({ scope, id: 'stop', generation: 1, command: { type: 'stop' } });
    await until(() => host.updateReadiness().ready);
    const oldBinding = (await host.binding())!;
    await host.close();

    // A new process has a new native controller: reusing the first controller
    // accidentally retains interaction/MCP owners and masks this boundary.
    const cold = scriptedHost('copilot', { cwd: directory, nativeSession: oldBinding.run.nativeSession });
    cold.containment.inspectResult = initial.containment.proof();
    const history: HostHistory = {
      async prepare(run, _attached, custody) {
        assert.ok(custody); assert.deepEqual(await custody.read(), { state: 'none' }); preparations++;
        const opening = { scope: run.scope, generation: run.generation, operationId: 'exact-scripted-reader' };
        await custody.begin(run, opening); readerStates.push((await custody.read()).state);
        reader = { opening, identity: { attachment: 'scripted-reader-attachment', process: 'scripted-reader-process', containment: 'scripted-reader-container', placement: 'dedicated' } };
        await custody.owned(run, reader); readerStates.push((await custody.read()).state); prepared = true;
      },
      async release(custody) {
        if (!prepared) return;
        if (custody) {
          await retireReader(custody, async capsule => { assert.deepEqual(capsule, reader); return { ...capsule, state: 'stopped', scope: 'nativeTree', noAutomaticContinuation: true, acquisitionSealed: true }; });
          readerStates.push((await custody.read()).state);
        }
        prepared = false;
      },
      port: (_run, attached) => ({ scope: attached, mode: prepared ? 'persisted' : 'active', context: prepared ? 'owned-cold-reader' : 'inactive', async read() {
        assert.equal(prepared, true); assert.deepEqual((await host.session.readers.read()).state, 'owned'); reads++;
        return { scope: attached, status: 'ok', records: [{ id: 'saved-tool', kind: 'tool', lifecycle: 'completed', body: { kind: 'complete', text: 'SAVED_COLD_TOOL', evidence: 'nativeFullBody' }, native: {} }], hasMore: false, nextCursor: null, gaps: [] };
      } }),
    };
    host = await openHost({ directory, cwd: directory, scope, policy, controller: cold.controller, history });
    assert.equal((await host.session.snapshot(scope)).phase, 'stopped');
    const binding = (await host.binding())!; assert.ok(binding); assert.equal(host.history.snapshot(binding.history).rows.length, 0);
    assert.equal(cold.controller.current(), null);
    assert.deepEqual(await host.session.readers.read(), { state: 'none' });
    const catalogScope = { connection: scope.connection, principal: scope.principal, authority: 'saved-catalog' };
    const entry: CatalogEntry = { scope: catalogScope, session: scope.session, createId: 'create', target: { host: scope.host, owner: 'durable-host', kind: 'copilot', placement: 'dedicated' }, metadata: { name: 'Saved stopped conversation', cwd: directory }, revision: 1, version: 2, binding: { kind: 'copilot', placement: 'dedicated', generation: binding.run.generation, nativeSession: binding.run.nativeSession } };
    const catalog: CatalogPort = { list: async () => [entry], get: async () => entry, subscribe: () => () => {}, creation: async () => null, create: async () => { throw Error('No Create during bootstrap'); }, rename: async () => { throw Error('No metadata mutation during bootstrap'); }, setWatched: async () => { throw Error('No metadata mutation during bootstrap'); }, metadataOriginal: async () => null };
    workspace = new MultiplexWorkspace({ scope: catalogScope, persistence: new MemoryDraftPersistence(), connect(context) {
      return { session: host.session, catalog, access: () => ({ read: true, control: true, fileWrite: true, mcpRefresh: true, catalogWrite: true }), binding: async () => host.binding(), filePort: () => host.files,
        interactionPort: () => ({ snapshot: async value => { domains.push('interaction.snapshot'); return host.interactions.snapshot(value); }, subscribe: host.interactions.subscribe }),
        mcpPort: () => ({ snapshot: async run => { domains.push('mcp.snapshot'); return host.mcp.snapshot(run); }, subscribe: host.mcp.subscribe, refresh: host.mcp.refresh }),
        observeHistory: (_scope, attached) => {
          streams++; const frames = host.history.watch(attached); let released = false;
          void (async () => { for await (const frame of frames) { if (released) return; context.history.session(attached).client.apply(frame); } })().catch(() => {});
          return { release() { if (released) return; released = true; streams--; void frames.return(); } };
        }, recover: (_scope, attached, observation) => host.history.recover(attached, observation), close() {},
      };
    } });
    const view = await workspace.open(scope.session); // Desired product behavior; fails before correction.
    const lease = view.observe();
    await until(() => { const value = view.getSnapshot(); return value.kind === 'copilot' && value.history.current !== null; });
    const before = view.getSnapshot(); if (before.kind !== 'copilot') assert.fail('Expected stopped Copilot view');
    assert.equal(before.session.native?.phase, 'stopped'); assert.equal(before.history.rows.length, 0); assert.equal(before.history.olderEdge.state, 'unknown');
    assert.equal(preparations, 0); assert.equal(reads, 0);
    if (before.confirmations) { assert.equal(before.confirmations.items.length, 0); assert.equal(before.confirmations.issue, 'ownershipRetired'); }
    if (before.mcp) { assert.equal(before.mcp.freshness, 'retired'); assert.equal(before.mcp.coverage, 'unknown'); }
    await assert.rejects(async () => host.mcp.refresh(binding.run), { code: 'FENCED' });
    assert.throws(() => host.mcp.subscribe({ ...binding.run, generation: binding.run.generation + 1 }, () => {}), { code: 'FENCED' });
    await assert.rejects(host.interactions.snapshot({ ...scope, session: 'foreign' }), { code: 'FENCED' });
    assert.deepEqual(await view.recoverHistory(), { state: 'value', value: { status: 'ready' } });
    await until(() => { const value = view.getSnapshot(); return value.kind === 'copilot' && value.history.rows.some(row => row.id === 'saved-tool'); });
    assert.equal(preparations, 1); assert.equal(reads, 1); assert.equal((await host.session.snapshot(scope)).phase, 'stopped');
    assert.equal((await host.session.readers.read()).state, 'owned');
    assert.deepEqual(cold.counts, { opens: 0, resumes: 0, sends: 0, stops: 0, discovery: 0, bodyReads: 0, replies: 0 });
    lease.release(); assert.equal(streams, 0); assert.ok(domains.length <= 2);
    workspace.close(); await host.close(); assert.deepEqual(readerStates, ['allocating', 'owned', 'none']);
  } finally { workspace?.close(); await host.terminate(); await rm(directory, { recursive: true, force: true }); }
});
