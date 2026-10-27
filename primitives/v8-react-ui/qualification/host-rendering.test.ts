import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NativeActions } from '../src/native-actions.js';
import { workspaceFixture } from '../../v8-workspace/qualification/fixture.js';
import { ScriptedHostDriver } from '../../v8-host/qualification/fixture.js';

// Adapter-to-renderer integration belongs here; renderer-only checks do not
// load the Host/native-controller graph. This case is moved, not duplicated.
test('actual Copilot adapter task metadata reaches retained reads and inert native presentation without leaking raw SDK fields', async () => {
  const f = workspaceFixture(), driver = new ScriptedHostDriver('copilot', { cwd: '/scripted', nativeSession: 'native-b' });
  let attachment: Awaited<ReturnType<typeof driver.controller.open>> | undefined;
  try {
    const { b } = await f.open(), native = f.snapshot('b');
    const agent = { id: 'task-agent', type: 'agent', description: 'Detailed child description', displayName: 'Named child', status: 'running', startedAt: '2026-10-25T01:00:00Z', toolCallId: 'spawn', agentType: 'general', model: 'requested-model', resolvedModel: 'resolved-model', executionMode: 'sync', canPromoteToBackground: true, error: 'Native error detail', latestResponse: 'Latest native response', result: 'Final native result', prompt: 'PRIVATE_PROMPT_NOT_FOR_TASK_UI', logPath: '/PRIVATE_LOG_NOT_FOR_TASK_UI', providerConfig: 'PRIVATE_PROVIDER_NOT_FOR_TASK_UI' };
    const shell = { id: 'task-shell', type: 'shell', description: 'Shell task', command: 'echo native', status: 'running', startedAt: '2026-10-25T01:00:01Z', pid: 1234 };
    const client = { id: 'task-client', type: 'client', description: 'Client task', displayName: 'Named client', status: 'orphaned', startedAt: '2026-10-25T01:00:02Z', executionMode: 'background', canCancel: false, result: { privateOwnerValue: 'PRIVATE_CLIENT_RESULT_NOT_FOR_TASK_UI' }, error: 'Client failure' };
    driver.action = async method => method === 'tasks.list' ? { tasks: [agent, shell, client] } : method === 'tasks.getProgress' ? { progress: { type: 'agent', latestIntent: 'Intent survives alongside output', recentActivity: [{ timestamp: '2026-10-25T01:01:00Z', message: 'Tool activity survives alongside intent' }] } } : method === 'queue.pendingItems' ? { items: [], steeringMessages: ['Unclassified steering'] } : {};
    attachment = await driver.controller.open({ scope: native.scope, generation: native.generation, operationId: 'scripted-create', nativeSession: null, placement: 'dedicated', policy: { kind: 'copilot', provider: 'copilot-only', permissions: 'manual' } }, () => {});
    f.native.publish(native.scope, { capabilities: { ...native.capabilities, commands: [...native.capabilities.commands, 'copilot.task.cancel', 'copilot.task.promote'], reads: ['copilot.tasks', 'copilot.task.progress', 'copilot.queue'] } });
    assert.ok(driver.controller.read); f.native.nativeRead = (run, request) => driver.controller.read!(run, request);
    const snapshot = () => { const value = b.getSnapshot(); if (value.kind !== 'copilot') assert.fail('Expected Copilot'); return value; };
    await snapshot().actions.read!({ type: 'copilot.tasks' }); await snapshot().actions.read!({ type: 'copilot.task.progress', id: agent.id }); await snapshot().actions.read!({ type: 'copilot.queue' });
    const before = driver.requests.length, render = () => renderToStaticMarkup(h(NativeActions, { snapshot: snapshot(), text: '', hasFiles: false, run() { assert.fail('Render cannot dispatch or read'); } }));
    const markup = render();
    for (const text of ['Named child', 'Detailed child description', 'Requested model: requested-model', 'Resolved model: resolved-model', 'Native error detail', 'Latest native response', 'Final native result', 'echo native', 'PID: 1234', 'Named client', 'Owner disconnected · outcome unknown', 'Intent survives alongside output', 'Tool activity survives alongside intent']) assert.ok(markup.includes(text), text);
    assert.doesNotMatch(markup, /PRIVATE_|Used model/); assert.doesNotMatch(JSON.stringify(snapshot()), /PRIVATE_/); assert.equal(driver.requests.length, before); assert.equal(f.native.submitted.length, 0);
    assert.match(markup, /steering delivery state not reported/); assert.match(markup, /Observed steering messages/); assert.doesNotMatch(markup, /0 steering messages in flight/); assert.doesNotMatch(markup, /data-action="cancel-task-0" disabled/);
    f.native.publish(native.scope, { phase: 'stopped' }); const stopped = render(); assert.match(stopped, /Agent stopped · last observed running/); assert.match(stopped, /data-action="cancel-task-0" disabled/);
  } finally { f.workspace.close(); await attachment?.stopTree(); driver.controller.dispose(); }
});

