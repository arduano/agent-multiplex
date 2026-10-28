import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { workspaceFixture, deferred } from './fixture.js';
import { PlanActions } from '../src/plan-action.js';
import { installPlan } from './goal-plan-fixture.js';
import { MemoryDraftPersistence } from '../../v8-files/src/client/persistence.js';
import { scopeKey, type Receipt } from '../../v8-session/src/contracts/types.js';

test('goal editor retains separate A/B/A intent, defaults blank budget, and never overwrites native facts or a newer edit', async () => {
  const f = workspaceFixture(), gate = deferred<Receipt>();
  try {
    const { a, b } = await f.open(), native = f.snapshot('a');
    f.native.publish(native.scope, { capabilities: { ...native.capabilities, commands: [...native.capabilities.commands, 'codex.goal.set'], reads: ['codex.goal'] } });
    f.native.nativeRead = async run => ({ run, type: 'codex.goal', goal: { threadId: run.nativeSession, objective: 'Native goal', status: 'active', tokenBudget: 500, tokensUsed: 2, timeUsedSeconds: 3, createdAt: 1, updatedAt: 2 } });
    const current = () => { const state = a.getSnapshot(); if (state.kind !== 'codex') assert.fail('Wrong family'); return state; };
    await current().actions.read!({ type: 'codex.goal' });
    a.setDraft({ text: 'Ordinary draft', fileIds: ['unsent-file'] }); await f.workspace.composer('a').flush();
    current().actions.goalEditor!.open(); current().actions.goalEditor!.edit({ objective: 'Edited objective', budget: '' });
    const lease = b.observe(); lease.release(); await f.workspace.open('a');
    assert.equal(current().goalForm.objective, 'Edited objective');
    f.native.invoke = () => gate.promise;
    const first = current().actions.goalEditor!.save(), second = current().actions.goalEditor!.save(); assert.equal(first, second);
    await tick(); assert.deepEqual(f.native.submitted[0]!.command, { type: 'codex.goal.set', objective: 'Edited objective', tokenBudget: null });
    current().actions.goalEditor!.edit({ objective: 'Newer editor intent' });
    const request = f.native.submitted[0]!; gate.resolve({ scope: request.scope, id: request.id, type: request.command.type, generation: request.generation, state: 'acknowledged', outcome: { status: 'applied' } }); await first.result; await tick();
    assert.equal(current().goalForm.objective, 'Newer editor intent'); assert.equal(current().goalForm.editing, true);
    assert.deepEqual(current().composer.value, { text: 'Ordinary draft', fileIds: ['unsent-file'] });
    const observed = current().session.nativeReads[0]!.value;
    assert.equal(observed?.type === 'codex.goal' && observed.goal?.objective, 'Native goal');
    assert.equal(f.native.submitted.length, 1);
    const retiredEditor = current().actions.goalEditor!;
    f.advance('a'); await a.rebind();
    assert.throws(() => retiredEditor.save(), { code: 'FENCED' });
    assert.equal(f.native.submitted.length, 1, 'A prior-run editor cannot submit into the replacement binding');
  } finally { f.workspace.close(); }
});

test('completed retained root plan uses one Send across views and reload; lost reply only restores receipt lookup', async () => {
  const persistence = new MemoryDraftPersistence(), f = workspaceFixture({ persistence });
  const plans = ['é'.repeat(16) + 'x'.repeat(4380), 'Latest plan: a different design'];
  let fresh: ReturnType<typeof workspaceFixture> | undefined;
  try {
    const { a } = await f.open(), capture = installPlan(f, a, 'a', plans), second = f.workspace.view('a', 'second');
    assert.equal(capture.snapshot.rows.filter(row => row.native.type === 'plan').length, 2);
    assert.equal(new TextEncoder().encode(plans[0]).byteLength, 4412, 'Reported-size completed native plans fit the ordinary exact-body Send');
    const later = capture.rollWindow();
    assert.equal(later.rows.some(row => row.id === capture.row.id), false, 'The actual Host window has rolled beyond the completed plan');
    f.history.session(capture.root).client.apply({ kind: 'snapshot', snapshot: later });
    const retained = a.getSnapshot(); if (retained.kind !== 'codex') assert.fail('Wrong family');
    assert.equal(retained.history.origins[capture.row.id]!.source, 'retainedCurrent');
    assert.equal(retained.history.origins[capture.row.id]!.generation, retained.history.current!.generation);
    const file = await a.saveFile({ name: 'keep.txt', mediaType: 'text/plain', blob: new Blob(['keep attachment']) });
    a.setDraft({ text: 'Keep my composer', fileIds: [file.manifest.id] }); await f.workspace.composer('a').flush();
    f.native.invoke = async request => {
      const receipt: Receipt = { scope: request.scope, id: request.id, type: 'send', generation: request.generation, state: 'acknowledged', outcome: { status: 'accepted' } };
      f.native.receipts.set(`${scopeKey(request.scope)}:${request.id}`, receipt); throw Error('Lost response');
    };
    const first = a.implementPlan(capture.row.id), joined = second.implementPlan(capture.row.id); assert.equal(first, joined);
    const original = await first; await assert.rejects(original.result);
    assert.equal(f.native.submitted.length, 1);
    assert.deepEqual(f.native.submitted[0]!.command, { type: 'send', text: 'Implement this plan:\n\n' + plans[0], selection: { kind: 'codex', collaboration: { mode: 'default', model: 'original', effort: 'low' } } });
    const before = a.getSnapshot(); if (before.kind !== 'codex') assert.fail('Wrong family');
    assert.deepEqual(before.composer.value, { text: 'Keep my composer', fileIds: [file.manifest.id] });
    capture.release(); f.workspace.close();
    fresh = workspaceFixture({ persistence }); for (const [key, receipt] of f.native.receipts) fresh.native.receipts.set(key, receipt);
    const reopened = await fresh.workspace.open('a'), current = installPlan(fresh, reopened, 'a', plans);
    const checked = await reopened.implementPlan(current.row.id); assert.equal(checked.id, original.id); assert.equal((await checked.result)?.state, 'acknowledged');
    assert.equal(fresh.native.submitted.length, 0, 'No restored/missing client handle can submit the old Send');
    const state = reopened.getSnapshot(); if (state.kind !== 'codex') assert.fail('Wrong family'); assert.equal(state.composer.value.text, 'Keep my composer');
    current.release();
  } finally { f.workspace.close(); fresh?.workspace.close(); }
});

test('plan admission rejects child/incomplete/prior-run facts and fences delayed preparation after native generation changes', async () => {
  const persistence = new MemoryDraftPersistence(), gate = deferred<void>(), entered = deferred<void>();
  const original = persistence.original.bind(persistence);
  persistence.original = async (...args) => { if (args[3] === 'protect') { entered.resolve(); await gate.promise; } return original(...args); };
  const f = workspaceFixture({ persistence });
  try {
    const { a } = await f.open(), capture = installPlan(f, a), client = f.history.session(capture.root).client;
    const apply = (row: typeof capture.row) => client.apply({ kind: 'snapshot', snapshot: { ...capture.snapshot, revision: client.current!.revision + 1, rows: [row] } });
    apply({ ...capture.row, version: capture.row.version + 1, lifecycle: 'running' });
    assert.throws(() => a.implementPlan(capture.row.id), { code: 'FENCED' });
    apply({ ...capture.row, version: capture.row.version + 2, native: { ...capture.row.native, threadId: 'foreign-child' } });
    assert.throws(() => a.implementPlan(capture.row.id), { code: 'FENCED' });
    apply({ ...capture.row, version: capture.row.version + 3, native: { ...capture.row.native, type: 'agentMessage' } });
    assert.throws(() => a.implementPlan(capture.row.id), { code: 'FENCED' }, 'Plan-like assistant prose is not a native plan item');
    if (capture.row.body.kind !== 'complete') assert.fail('Completed plan body required');
    apply({ ...capture.row, version: capture.row.version + 4, contentVersion: capture.row.contentVersion + 1, body: { ...capture.row.body, text: 'x'.repeat(8192) } });
    assert.throws(() => a.implementPlan(capture.row.id), { code: 'INVALID' });
    assert.equal(f.workspace.originalReferences('a').length, 0, 'An oversized selected plan creates no protected original');
    apply({ ...capture.row, version: capture.row.version + 5, contentVersion: capture.row.contentVersion + 2 });
    const work = a.implementPlan(capture.row.id); await entered.promise;
    f.advance('a'); gate.resolve(); await assert.rejects(work, { code: 'FENCED' });
    assert.equal(f.native.submitted.length, 0); assert.throws(() => a.implementPlan(capture.row.id), { code: 'FENCED' });
    capture.release();
  } finally { gate.resolve(); f.workspace.close(); }
});


test('plan associations keep only recent metadata and one preparation without owning uncertain effects', async () => {
  const actions = new PlanActions(() => {}), held = deferred<{ id: string; result: Promise<Receipt | null> }>();
  const unknown = (id: string): Receipt => ({ scope: { connection: 'c', principal: 'p', host: 'h', session: 's' }, id, generation: 1, type: 'send', state: 'outcomeUnknown' });
  try {
    for (let i = 0; i < 160; i++) {
      const key = `unknown-${i}`, original = await actions.start(key, 'run', key, async job => { actions.identify(job, key); return { id: key, result: Promise.resolve(unknown(key)) }; });
      await original.result; await tick();
    }
    assert.equal(actions.getSnapshot().length, 32); assert.equal(actions.existing('unknown-0'), undefined);
    const current = actions.start('preparing', 'run', 'current', async job => { actions.identify(job, 'current-original'); return held.promise; });
    await tick(); assert.equal(actions.getSnapshot().length, 33);
    assert.equal(actions.start('preparing', 'run', 'current', async () => { throw Error('must join'); }), current);
    assert.throws(() => actions.start('other', 'run', 'other', async () => held.promise), { code: 'BUSY' });
    held.resolve({ id: 'current-original', result: Promise.resolve(unknown('current-original')) }); await current; await tick();
    assert.equal(actions.getSnapshot().length, 32);
  } finally { held.resolve({ id: 'current-original', result: Promise.resolve(null) }); await actions.close(); }
});

test('a retained completed plan older than 32 associations reads its exact original instead of sending again', async () => {
  const f = workspaceFixture(); let capture: ReturnType<typeof installPlan> | undefined;
  try {
    const { a } = await f.open(); capture = installPlan(f, a, 'a', Array.from({ length: 35 }, (_, i) => `Exact plan ${i}`));
    const rows = capture.snapshot.rows.filter(row => row.native.type === 'plan'); assert.equal(rows.length, 35);
    const originals: string[] = [];
    for (const row of rows) { const original = await a.implementPlan(row.id); originals.push(original.id); assert.equal((await original.result)?.state, 'acknowledged'); await tick(); }
    const state = a.getSnapshot(); if (state.kind !== 'codex') assert.fail('Codex fixture required');
    assert.equal(state.planActions.length, 32); assert.equal(state.planActions.some(action => action.rowId === rows[0]!.id), false);
    assert.equal(state.history.rows.some(row => row.id === rows[0]!.id), true, 'the original completed plan remains actually visible');
    const submitted = f.native.submitted.length, repeated = await a.implementPlan(rows[0]!.id);
    assert.equal(repeated.id, originals[0]); assert.equal((await repeated.result)?.state, 'acknowledged');
    assert.equal(f.native.submitted.length, submitted); assert.equal(submitted, 35);
  } finally { capture?.release(); f.workspace.close(); }
});


test('unknown-first plan associations retire while the actual Session and composer retain every original', async () => {
  const f = workspaceFixture(); let capture: ReturnType<typeof installPlan> | undefined;
  try {
    const { a } = await f.open(); capture = installPlan(f, a, 'a', Array.from({ length: 40 }, (_, i) => `Unknown plan ${i}`));
    f.native.invoke = async request => ({ scope: request.scope, id: request.id, generation: request.generation, type: request.command.type, state: 'outcomeUnknown' });
    const rows = capture.snapshot.rows.filter(row => row.native.type === 'plan'), originals: string[] = [];
    for (const row of rows) { const original = await a.implementPlan(row.id); originals.push(original.id); assert.equal((await original.result)?.state, 'outcomeUnknown'); await tick(); }
    const state = a.getSnapshot(); if (state.kind !== 'codex') assert.fail('Codex fixture required');
    assert.equal(state.planActions.length, 32); assert.equal(state.planActions.some(action => action.rowId === rows[0]!.id), false);
    assert.equal(f.workspace.originalReferences('a').length, 40); assert.equal(state.composer.originals.length, 40);
    assert.equal(state.operations.filter(operation => operation.state === 'outcomeUnknown').length, 40);
    // Losing association metadata and even an absent receipt never permits a
    // second Submit: the existing protected original permits observation only.
    const scope = f.snapshot('a').scope; f.native.receipts.delete(`${scopeKey(scope)}:${originals[0]}`);
    const checked = await a.implementPlan(rows[0]!.id); assert.equal(checked.id, originals[0]); assert.equal(await checked.result, null);
    assert.equal(f.native.submitted.length, 40); assert.equal(f.workspace.originalReferences('a').length, 40);
  } finally { capture?.release(); f.workspace.close(); }
});
