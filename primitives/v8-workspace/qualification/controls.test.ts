import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceFixture, deferred } from './fixture.js';
import type { Catalog } from '../../v8-session/src/contracts/types.js';

test('explicit configured-choice reads coalesce, retain selection intent, and discard a late old-run value without native effects', async () => {
  const gate = deferred<Catalog>(), f = workspaceFixture({ controlCatalog: () => gate.promise });
  try {
    const { a, b } = await f.open(); for (let i = 0; i < 10; i++) a.getSnapshot();
    assert.equal(f.counts().controlReads, 0);
    const state = a.getSnapshot(); if (state.kind !== 'codex') throw Error('Wrong host');
    state.actions.setSelectionDraft({ kind: 'codex', model: 'next-model', effort: 'low' });
    const first = a.refreshControls(), joined = a.refreshControls(); assert.equal(first, joined);
    await Promise.resolve(); assert.equal(f.counts().controlReads, 1);
    f.advance('a'); gate.resolve({ available: true, choices: [{ model: 'next-model', efforts: ['low'] }] });
    await assert.rejects(first, { code: 'FENCED' });
    let current = a.getSnapshot(); if (current.kind !== 'codex') throw Error('Wrong host');
    assert.equal(current.modelCatalog.state, 'unavailable'); assert.equal(current.modelCatalog.value, null);
    assert.equal(current.session.draft!.model, 'next-model'); assert.equal(current.session.native!.selection.model, 'original');
    assert.equal(f.counts().submitted, 0); assert.equal(f.counts().discovery, 0);
    await a.refreshControls(); current = a.getSnapshot(); if (current.kind !== 'codex') throw Error('Wrong host');
    assert.equal(current.modelCatalog.state, 'available');
    const lease = b.observe(); lease.release(); assert.equal(a.getSnapshot(), current);
    assert.equal(f.counts().controlReads, 2); assert.equal(current.session.native!.selection.model, 'original');
  } finally { f.workspace.close(); }
});

test('safe outcomes preserve applied substeps and unsent confirmation while excluding native details and keeping observed selection independent', async () => {
  const f = workspaceFixture();
  try {
    const { b } = await f.open();
    f.native.invoke = async request => ({ scope: request.scope, id: request.id, type: request.command.type, generation: request.generation, state: 'acknowledged', outcome: {
      status: 'confirmationRequired', detail: { sendDispatched: false, completedSubsteps: ['copilot.mode'], native: { secret: 'PRIVATE_NATIVE_DETAIL_243', model: 'unobserved-new-model' } },
    } });
    const state = b.getSnapshot(); if (state.kind !== 'copilot' || !state.actions.send) throw Error('Wrong host');
    const send = state.actions.send('private prompt', { kind: 'copilot', mode: 'plan', model: 'next-model' }); await send.result;
    const current = b.getSnapshot(); if (current.kind !== 'copilot') throw Error('Wrong host');
    assert.deepEqual(current.operations[0]!.outcome, { status: 'confirmationRequired', sendDispatched: false, completedSubsteps: ['copilot.mode'] });
    assert.equal(current.operations[0]!.state, 'acknowledged'); assert.equal(current.session.native!.selection.model, 'original');
    assert.equal(JSON.stringify(current).includes('PRIVATE_NATIVE_DETAIL_243'), false); assert.equal(JSON.stringify(current).includes('private prompt'), false);
    assert.equal(f.native.submitted.length, 1);
  } finally { f.workspace.close(); }
});

test('retained action outcomes preserve native false results and closed compaction counts without private detail', async () => {
  const f = workspaceFixture();
  try {
    const { a, b } = await f.open(), codex = f.snapshot('a'), copilot = f.snapshot('b');
    f.native.publish(codex.scope, { capabilities: { ...codex.capabilities, commands: [...codex.capabilities.commands, 'codex.goal.clear', 'codex.terminal.terminate'] } });
    f.native.publish(copilot.scope, { capabilities: { ...copilot.capabilities, commands: [...copilot.capabilities.commands, 'copilot.compact', 'copilot.queue.promote', 'copilot.task.cancel', 'copilot.task.promote'] } });
    const results = {
      'codex.goal.clear': { cleared: false }, 'codex.terminal.terminate': { terminated: false },
      'copilot.compact': { success: false, tokensRemoved: 0, messagesRemoved: 0 },
      'copilot.queue.promote': { steered: false }, 'copilot.task.cancel': { cancelled: false }, 'copilot.task.promote': { promoted: false },
    };
    f.native.invoke = async request => ({ scope: request.scope, id: request.id, type: request.command.type, generation: request.generation, state: 'acknowledged',
      outcome: { status: 'applied', detail: { ...results[request.command.type as keyof typeof results], privateSummary: 'PRIVATE_ACTION_BODY_472', nativeId: 'PRIVATE_NATIVE_ID_472' } } });
    const c = a.getSnapshot(), p = b.getSnapshot(); if (c.kind !== 'codex' || p.kind !== 'copilot') assert.fail('Wrong harness');
    const handles = [c.actions.clearGoal!(), c.actions.terminateTerminal!('exact-terminal'), p.actions.compact!(), p.actions.promoteQueued!('exact-queue'), p.actions.cancelTask!('exact-task'), p.actions.promoteTask!('exact-task')];
    await Promise.all(handles.map(handle => handle.result));
    for (const view of [a, b]) {
      const snapshot = view.getSnapshot(); if (snapshot.kind !== 'codex' && snapshot.kind !== 'copilot') assert.fail('Wrong harness');
      for (const original of snapshot.operations) {
        assert.equal(original.state, 'acknowledged'); assert.equal(original.outcome?.status, 'applied', 'The native result does not rewrite its acknowledged original');
        assert.deepEqual(original.outcome.result, { type: original.type, ...results[original.type as keyof typeof results] });
        assert.ok(Object.isFrozen(original.outcome.result));
      }
      assert.doesNotMatch(JSON.stringify(snapshot.operations), /PRIVATE_ACTION_BODY_472|PRIVATE_NATIVE_ID_472/);
    }
    assert.equal(f.native.submitted.length, handles.length);
  } finally { f.workspace.close(); }
});
