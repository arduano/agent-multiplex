import assert from 'node:assert/strict';
import test from 'node:test';
import type { HistoryPage, Scope } from '../../v8-history/src/contracts/types.js';
import { ReadonlyHistories, type ReadonlyHistoryView } from '../src/history-view.js';
import { HistoryWorkspace } from '../../v8-history/src/client/workspace.js';
import type { WorkspacePorts } from '../src/contracts.js';
import { workspaceFixture, deferred } from './fixture.js';

function noControl(view: ReadonlyHistoryView) {
  // @ts-expect-error Child history does not expose native actions.
  view.actions;
  // @ts-expect-error Child history does not expose a composer or Send.
  view.sendDraft;
  // @ts-expect-error Child history does not grant parent callback authority.
  view.respond;
}
void noControl;

test('streamed child inventory admits exact scopes without metadata reads and retains stale display without stale authority', async () => {
  let reads = 0; const f = workspaceFixture({ historyScopes: async () => { reads++; throw Error('Unavailable exception'); } });
  try {
    const { a } = await f.open(), lease = a.observe(), root = f.bindings.get('a')!.history;
    const child: Scope = { ...root, kind: 'codex', threadId: 'streamed-child' }, client = f.history.session(root).client, before = client.current!;
    client.apply({ kind: 'snapshot', snapshot: { ...before, revision: before.revision + 1, scopeInventory: { nativeGeneration: 1, entries: [{ scope: root }, { scope: child, native: { nickname: 'Native worker', configuredModel: 'native-configured' } }] } } });
    const state = a.getSnapshot(); if (state.kind === 'disposed') assert.fail('Disposed');
    assert.equal(state.historyScopes.state, 'observed'); assert.deepEqual(state.historyScopes.scopes, [root, child]); assert.equal(reads, 0);
    assert.equal(state.agents[0]!.name, 'Native worker'); assert.deepEqual(state.agents[0]!.models, [{ source: 'configured', model: 'native-configured' }]);
    const view = f.workspace.historyView('a', child); assert.equal(view.getSnapshot().kind, 'ready');
    await assert.rejects(f.workspace.refreshHistoryScopes('a')); const unavailable = a.getSnapshot(); if (unavailable.kind === 'disposed') assert.fail('Disposed');
    assert.deepEqual(unavailable.historyScopes.scopes[1], child); assert.equal(unavailable.agents[0]!.name, 'Native worker'); assert.throws(() => view.observe(), { code: 'FENCED' });
    const current = client.current!; client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1 } });
    f.advance(); const stale = a.getSnapshot(); if (stale.kind === 'disposed') assert.fail('Disposed');
    assert.equal(stale.agents[0]!.lastObserved, true); assert.equal(stale.historyScopes.scopes.length, 2); assert.throws(() => f.workspace.historyView('a', child), { code: 'FENCED' });
    await f.workspace.rebind('a'); const rebound = a.getSnapshot(); if (rebound.kind === 'disposed') assert.fail('Disposed');
    assert.equal(rebound.historyScopes.state, 'unobserved'); assert.deepEqual(rebound.historyScopes.scopes, [root, child]);
    assert.throws(() => f.workspace.historyView('a', child), { code: 'FENCED' }); assert.equal(f.counts().submitted, 0); lease.release();
  } finally { f.workspace.close(); }
});

test('same-scope native generation rebind keeps old inventory fenced until a current stream proof and explicit child reopen', async () => {
  const held = deferred<HistoryPage>(), requested = deferred<void>();
  const f = workspaceFixture({ older: () => { requested.resolve(); return held.promise; } }); let finish = () => {};
  try {
    const { a } = await f.open(), rootLease = a.observe(), root = f.bindings.get('a')!.history;
    const child: Scope = { ...root, kind: 'codex', threadId: 'retained-child' }, client = f.history.session(root).client;
    const publish = (generation: number) => { const current = client.current!; client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1,
      scopeInventory: { nativeGeneration: generation, entries: [{ scope: root }, { scope: child, native: { nickname: 'Retained identity' } }] } } }); };
    publish(1); const view = f.workspace.historyView('a', child), childLease = view.observe();
    const loaded = view.getSnapshot(); if (loaded.kind === 'disposed') assert.fail('Disposed'); const rows = loaded.history.rows;
    const oldPage: HistoryPage = { scope: child, generation: loaded.history.current!.generation, rows: [{ ...rows[0]!, id: 'old-native-generation-body' }], olderEdge: { state: 'end', evidence: 'nativeBoundary' } };
    finish = () => held.resolve(oldPage);
    const oldRead = assert.rejects(view.loadOlder(), { code: 'FENCED' }); await requested.promise;
    f.advance('a', true); await f.workspace.rebind('a');
    const waiting = a.getSnapshot(); if (waiting.kind === 'disposed') assert.fail('Disposed');
    assert.equal(waiting.historyScopes.state, 'unobserved'); assert.equal(waiting.agents[0]!.lastObserved, true);
    assert.equal(view.getSnapshot().kind, 'stale'); assert.throws(() => f.workspace.historyView('a', child), { code: 'FENCED' });
    publish(1); assert.throws(() => f.workspace.historyView('a', child), { code: 'FENCED' });
    publish(2); assert.equal(view.getSnapshot().kind, 'stale', 'Fresh inventory does not autonomously revive the old observation lease');
    assert.equal(f.workspace.historyView('a', child), view, 'Explicit new proof reuses retained facade/rows');
    const admitted = view.getSnapshot(); if (admitted.kind === 'disposed') assert.fail('Disposed');
    assert.equal(admitted.kind, 'ready'); assert.deepEqual(admitted.history.rows, rows);
    finish(); await oldRead; const settled = view.getSnapshot(); if (settled.kind === 'disposed') assert.fail('Disposed'); assert.deepEqual(settled.history.rows, rows);
    const newLease = view.observe(); childLease.release(); assert.equal(f.counts().streams, 2); newLease.release(); rootLease.release();
    assert.equal(f.counts().submitted, 0);
  } finally { f.workspace.close(); finish(); }
});

test('same-binding child reopen shares a held older read without invalidating its admission', async () => {
  const held = deferred<HistoryPage>(), requested = deferred<void>();
  const f = workspaceFixture({ older: () => { requested.resolve(); return held.promise; } });
  try {
    const { a } = await f.open(), rootLease = a.observe(), root = f.bindings.get('a')!.history;
    const child: Scope = { ...root, kind: 'codex', threadId: 'reopened-child' }, client = f.history.session(root).client, current = client.current!;
    client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1,
      scopeInventory: { nativeGeneration: 1, entries: [{ scope: root }, { scope: child }] } } });
    const view = f.workspace.historyView('a', child), lease = view.observe();
    const loaded = view.getSnapshot(); if (loaded.kind === 'disposed') assert.fail('Disposed');
    view.viewport.userScroll('earlier', false);
    view.viewport.report({ rowId: loaded.history.rows[0]!.id, offsetPx: 17 });
    const pending = view.loadOlder(); await requested.promise;
    assert.equal(f.workspace.historyView('a', child), view);
    assert.equal(view.loadOlder(), pending, 'Reopening the same admitted binding coalesces the actual work');
    held.resolve({ scope: child, generation: loaded.history.current!.generation,
      rows: [{ ...loaded.history.rows[0]!, id: 'proved-older-row' }], olderEdge: { state: 'end', evidence: 'nativeBoundary' } });
    await pending;
    const settled = view.getSnapshot(); if (settled.kind === 'disposed') assert.fail('Disposed');
    assert.equal(settled.kind, 'ready'); assert.ok(settled.history.rows.some(row => row.id === 'proved-older-row'));
    assert.equal(settled.history.viewport.anchor!.offsetPx, 17); assert.equal(f.counts().older, 1); assert.equal(f.counts().submitted, 0);
    lease.release(); rootLease.release();
  } finally { f.workspace.close(); }
});

test('proved child facades reuse retained history with independent health and no native control capability', async () => {
  let reads = 0, root!: Scope, child!: Scope;
  const f = workspaceFixture({ historyScopes: async () => { reads++; return [root, child]; } });
  try {
    const { a } = await f.open(); root = f.bindings.get('a')!.history; assert.equal(root.kind, 'codex');
    child = { ...root, kind: 'codex', threadId: 'proved-child' };
    const rootLease = a.observe(); a.setDraft('Retained parent intent');
    assert.equal(reads, 0); assert.throws(() => f.workspace.historyView('a', child), { code: 'FENCED' });
    await f.workspace.refreshHistoryScopes('a'); assert.equal(reads, 1);
    const before = f.counts(), view = f.workspace.historyView('a', child); assert.deepEqual(f.counts(), before);
    assert.equal('actions' in view || 'setDraft' in view || 'sendDraft' in view || 'respond' in view, false);
    const lease = view.observe(), client = f.history.session(child).client;
    const current = client.current!;
    client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1, rows: [{ ...current.rows[0]!, body: { kind: 'complete', text: 'Child-only captured history', evidence: 'nativeFullBody' }, version: 2, contentVersion: 2 }] } });
    f.observation({ scope: f.bindings.get('a')!.run.scope, kind: 'history', history: root, state: 'unavailable' });
    f.observation({ scope: f.bindings.get('a')!.run.scope, kind: 'history', history: child, state: 'live' });
    const parent = a.getSnapshot(), selected = view.getSnapshot();
    assert.notEqual(parent.kind, 'disposed'); if (parent.kind === 'disposed' || selected.kind === 'disposed') assert.fail('Disposed');
    assert.equal(parent.observation.history, 'unavailable'); assert.equal(selected.observation, 'live');
    assert.equal(selected.history.rows[0]!.body.kind === 'complete' && selected.history.rows[0]!.body.text, 'Child-only captured history');
    assert.equal(parent.history.rows[0]!.body.kind === 'complete' && parent.history.rows[0]!.body.text, 'retained history');
    lease.release(); assert.equal(f.counts().streams, 1); assert.equal(f.workspace.historyView('a', child), view);
    f.advance(); assert.equal(view.getSnapshot().kind, 'stale'); assert.throws(() => view.observe(), { code: 'FENCED' });
    await assert.rejects(async () => view.loadOlder(), { code: 'FENCED' }); assert.equal(f.counts().submitted, 0);
    const retained = a.getSnapshot(); if (retained.kind === 'disposed') assert.fail('Disposed'); assert.equal(retained.composer.value.text, 'Retained parent intent');
    rootLease.release();
  } finally { f.workspace.close(); }
});

test('foreign, duplicate, missing-root and late inventories never authorize a child', async () => {
  for (const outcome of ['foreign', 'duplicate', 'missing', 'late'] as const) {
    let values: readonly Scope[] = []; const gate = deferred<void>();
    const f = workspaceFixture({ historyScopes: async () => { if (outcome === 'late') await gate.promise; return values; } });
    try {
      await f.open(); const root = f.bindings.get('a')!.history; assert.equal(root.kind, 'codex'); const child: Scope = { ...root, kind: 'codex', threadId: 'candidate' };
      values = outcome === 'foreign' ? [root, { ...child, origin: { ...child.origin, principal: 'foreign' } }] : outcome === 'duplicate' ? [root, child, child] : outcome === 'missing' ? [child] : [root, child];
      const pending = f.workspace.refreshHistoryScopes('a'); if (outcome === 'late') { await Promise.resolve(); f.advance(); gate.resolve(); }
      await assert.rejects(pending, { code: 'FENCED' }); assert.throws(() => f.workspace.historyView('a', child), { code: 'FENCED' }); assert.equal(f.counts().submitted, 0); assert.equal(f.counts().streams, 0);
    } finally { gate.resolve(); f.workspace.close(); }
  }
});


test('readonly acquisition releases a handle returned after reentrant close and rolls back its actual mount', async () => {
  const f = workspaceFixture(); try {
    await f.open(); const binding = f.bindings.get('a')!, history = new HistoryWorkspace({ connection: binding.run.scope.connection, principal: binding.run.scope.principal });
    let retired = 0, closed!: ReadonlyHistories;
    closed = new ReadonlyHistories(history, { observeHistory() { assert.throws(() => view.observe(), { code: 'BUSY' }); closed.close(); return { release() { retired++; } }; } } as unknown as WorkspacePorts);
    const view = closed.view(binding.run.scope, binding.history, 'late', binding, () => true);
    assert.throws(() => view.observe(), { code: 'CLOSED' }); assert.equal(retired, 1);
    assert.equal(history.session(binding.history).mountedReferences, 0); assert.deepEqual(view.getSnapshot(), { kind: 'disposed' });
    closed.close(); assert.equal(retired, 1);
  } finally { f.workspace.close(); }
});

test('readonly close drains all child leases despite one failed release and retries only its exact failed handle', async () => {
  const f = workspaceFixture(); try {
    await f.open(); const binding = f.bindings.get('a')!, history = new HistoryWorkspace({ connection: binding.run.scope.connection, principal: binding.run.scope.principal });
    const attempts = [0, 0]; let index = 0, fail = true;
    const closed = new ReadonlyHistories(history, { observeHistory() { const id = index++; return { release() { attempts[id] = attempts[id]! + 1; if (id === 0 && fail) throw Error('Held release'); } }; } } as unknown as WorkspacePorts);
    const first = closed.view(binding.run.scope, binding.history, 'first', binding, () => true);
    const other = { ...binding.history, kind: 'codex' as const, threadId: 'second' }, second = closed.view(binding.run.scope, other, 'second', binding, () => true);
    const a = first.observe(), b = second.observe(); assert.throws(() => closed.close(), AggregateError);
    assert.deepEqual(attempts, [1, 1]); assert.equal(history.session(binding.history).mountedReferences, 0); assert.equal(history.session(other).mountedReferences, 0);
    assert.equal(first.getSnapshot().kind, 'disposed'); assert.equal(second.getSnapshot().kind, 'disposed');
    fail = false; closed.close(); assert.deepEqual(attempts, [2, 1]); a.release(); b.release(); closed.close(); assert.deepEqual(attempts, [2, 1]);
  } finally { f.workspace.close(); }
});


test('synchronous child invalidation, lost proof or binding replacement retires the returned stream before observe succeeds', async () => {
  const f = workspaceFixture(); try {
    await f.open(); const binding = f.bindings.get('a')!;
    for (const change of ['invalidate', 'proof', 'binding'] as const) {
      const history = new HistoryWorkspace({ connection: binding.run.scope.connection, principal: binding.run.scope.principal }); let retired = 0, valid = true;
      const owner = new ReadonlyHistories(history, { observeHistory() {
        if (change === 'invalidate') owner.invalidate(binding.run.scope.session);
        else if (change === 'proof') { valid = false; owner.reconcile(binding.run.scope.session); }
        else owner.view(binding.run.scope, binding.history, 'same', { ...binding }, () => true);
        return { release() { retired++; } };
      } } as unknown as WorkspacePorts);
      const view = owner.view(binding.run.scope, binding.history, 'same', binding, () => valid);
      assert.throws(() => view.observe(), { code: 'FENCED' }); assert.equal(retired, 1); assert.equal(history.session(binding.history).mountedReferences, 0);
      owner.close(); assert.equal(retired, 1);
    }
  } finally { f.workspace.close(); }
});
