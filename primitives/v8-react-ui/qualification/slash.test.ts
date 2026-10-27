import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentSnapshot } from '../../v8-workspace/src/contracts.js';
import { workspaceFixture } from '../../v8-workspace/qualification/fixture.js';
import { resolveChatShortcut, shortcutSuggestions } from '../src/slash.js';

type Ready = Extract<AgentSnapshot, { kind: 'codex' | 'copilot' }>;
function ready(value: AgentSnapshot): Ready { if (value.kind !== 'codex' && value.kind !== 'copilot') assert.fail('Expected ready snapshot'); return value; }
test('local, unknown and escaped slash input cannot accidentally become a native Send', async () => {
  const f = workspaceFixture();
  try {
    const { a, b } = await f.open(), codex = ready(a.getSnapshot()), copilot = ready(b.getSnapshot()), before = f.counts();
    for (const command of ['/new', '/status', '/mcp', '/help', '/model', '/effort', '/mode', '/goal']) assert.equal(resolveChatShortcut(command, codex).kind, 'local');
    assert.equal(resolveChatShortcut('/terminal', codex).kind, 'error', 'Native TUI is retired; its command cannot become a Send');
    assert.deepEqual(shortcutSuggestions('/ter', 'codex'), []);
    assert.equal(resolveChatShortcut('/unknown keep my text', codex).kind, 'error');
    assert.equal(resolveChatShortcut('/yolo on', codex).kind, 'error'); assert.equal(resolveChatShortcut('/goal', copilot).kind, 'error');
    assert.deepEqual(resolveChatShortcut('//model literal', codex), { kind: 'message', text: '/model literal' });
    assert.deepEqual(resolveChatShortcut('/home/user/source.ts\nexplain this', codex), { kind: 'message', text: '/home/user/source.ts\nexplain this' });
    assert.deepEqual(shortcutSuggestions('/go', 'copilot'), []);
    assert.deepEqual(f.counts(), before);
  } finally { f.workspace.close(); }
});

test('settings shortcuts retain typed next-Send intent while native commands use the existing exact original owner', async () => {
  const f = workspaceFixture({ controlCatalog: async () => ({ available: true, choices: [{ model: 'model-a', efforts: ['low', 'high'] }] }) });
  try {
    const { a, b } = await f.open(); await a.refreshControls();
    const native = f.snapshot('a'); f.native.publish(native.scope, { capabilities: { ...native.capabilities, commands: [...native.capabilities.commands, 'codex.goal.set'] } });
    const codex = ready(a.getSnapshot()), copilot = ready(b.getSnapshot());
    const model = resolveChatShortcut('/model model-a', codex); assert.equal(model.kind, 'selection');
    if (model.kind !== 'selection') assert.fail('Expected selection'); assert.equal(model.selection.kind, 'codex'); assert.equal(model.selection.model, 'model-a');
    const plan = resolveChatShortcut('/plan inspect the workspace', codex); assert.equal(plan.kind, 'send');
    if (plan.kind !== 'send' || plan.selection.kind !== 'codex') assert.fail('Expected Codex plan Send');
    assert.equal(plan.text, 'inspect the workspace'); assert.equal(plan.selection.collaboration!.mode, 'plan');
    assert.equal(resolveChatShortcut('/yolo on', copilot).kind, 'selection');
    assert.equal(f.counts().submitted, 0);
    const goal = resolveChatShortcut('/goal keep the owner simple', codex); assert.equal(goal.kind, 'native');
    if (goal.kind !== 'native') assert.fail('Expected native command'); await goal.run();
    assert.equal(f.native.submitted.length, 1); assert.equal(f.native.submitted[0]!.command.type, 'codex.goal.set');
    const offline = { ...codex, session: { ...codex.session, connected: false } };
    assert.equal(resolveChatShortcut('/goal do not dispatch', offline).kind, 'error'); assert.equal(f.native.submitted.length, 1);
  } finally { f.workspace.close(); }
});
