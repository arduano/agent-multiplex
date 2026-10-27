import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { workspaceFixture } from '../../v8-workspace/qualification/fixture.js';
import { nativeReadResult } from '../../v8-harness-defaults/src/state.js';
import { NativeActions } from '../src/native-actions.js';
import { CodexGoalControl } from '../src/native-goal.js';
import { operationLabel } from '../src/operations.js';
import type { Snapshot } from '../../v8-history/src/contracts/types.js';
declare const CAPTURED_PLAN: Snapshot;
import { Transcript } from '../src/transcript.js';

const f = workspaceFixture(), views = await f.open(); let reads = 0;
const planLease = views.a.observe();
f.history.session(f.bindings.get('a')!.history).client.apply({ kind: 'snapshot', snapshot: CAPTURED_PLAN });
f.native.publish(f.snapshot('a').scope, { selection: { kind: 'codex', model: 'original', effort: 'low', collaboration: { mode: 'plan', model: 'original', effort: 'low' } } });
const agent = { id: 'agent-task', type: 'agent', description: 'Child task description', displayName: 'Friendly child', status: 'running', startedAt: '2026-10-25T01:00:00Z', toolCallId: 'spawn', agentType: 'general', model: 'requested-child', resolvedModel: 'resolved-child', executionMode: 'sync', canPromoteToBackground: true, latestResponse: 'Latest response text', result: 'Final result text', error: 'Native task error', prompt: 'PRIVATE_PROMPT', providerConfig: 'PRIVATE_PROVIDER' };
const shell = { id: 'shell-task', type: 'shell', description: 'Command task', status: 'running', startedAt: '2026-10-25T01:00:01Z', command: 'echo task', pid: 4321 };
const client = { id: 'client-task', type: 'client', description: 'Client task', status: 'orphaned', startedAt: '2026-10-25T01:00:02Z', executionMode: 'background', canCancel: false };
for (const [name, commands, reads] of [
  ['a', ['codex.goal.set', 'codex.goal.clear'], ['codex.goal']],
  ['b', ['copilot.queue.promote', 'copilot.task.cancel', 'copilot.task.promote'], ['copilot.queue', 'copilot.tasks', 'copilot.task.progress', 'copilot.task.promotable']],
] as const) {
  const native = f.snapshot(name); f.native.publish(native.scope, { capabilities: { ...native.capabilities, commands: [...native.capabilities.commands, ...commands], reads } });
}
f.native.nativeRead = async (run, request) => {
  reads++;
  const raw = request.type === 'codex.goal' ? { goal: { threadId: run.nativeSession, objective: 'Full native goal', status: 'budgetLimited', tokenBudget: 2000, tokensUsed: 1800, timeUsedSeconds: 125, createdAt: 1, updatedAt: 2 } }
    : request.type === 'copilot.queue' ? { items: [{ id: 'queue-batch', kind: 'message', agentMode: 'plan', displayText: 'Waiting queued message' }], steeringMessages: ['Already delivered steering', 'Still waiting steering'], inFlightSteeringCount: 1 }
    : request.type === 'copilot.tasks' ? { tasks: [agent, shell, client] }
    : request.type === 'copilot.task.promotable' ? { task: agent }
    : request.type === 'copilot.task.progress' ? { progress: request.id === agent.id ? { type: 'agent', latestIntent: 'Current native intent', recentActivity: [{ timestamp: '2026-10-25T01:01:00Z', message: 'Native tool activity' }] } : request.id === shell.id ? { type: 'shell', recentOutput: 'Shell stdout and stderr' } : { type: 'client', status: 'orphaned', sequence: 4, updatedAt: '2026-10-25T01:02:00Z', percentage: 0, phase: 'uploading', lastMessage: 'Client progress detail', recentActivity: [{ timestamp: '2026-10-25T01:01:59Z', message: 'Client progress activity' }] } }
    : {};
  return nativeReadResult(run, request, raw);
};
f.native.invoke = async request => ({ scope: request.scope, id: request.id, type: request.command.type, generation: request.generation, state: 'acknowledged', outcome: { status: 'applied', detail: request.command.type === 'copilot.queue.promote' ? { steered: false } : request.command.type === 'copilot.task.cancel' ? { cancelled: false } : request.command.type === 'copilot.task.promote' ? { promoted: false } : {} } });
function App() {
  const [selected, select] = useState<'a' | 'b'>('a'), [error, setError] = useState(''), [goalOpen, setGoalOpen] = useState(false), view = views[selected];
  const snapshot = useSyncExternalStore(view.subscribe, view.getSnapshot, view.getServerSnapshot);
  useEffect(() => { const lease = view.observe(); return () => lease.release(); }, [view]);
  if (snapshot.kind !== 'codex' && snapshot.kind !== 'copilot') return h('p', null, 'Closed');
  return h('main', null, h('nav', null, h('button', { onClick: () => select('a') }, 'Codex'), h('button', { onClick: () => select('b') }, 'Copilot')),
    h('label', null, 'Message draft', h('textarea', { 'aria-label': 'Message draft', value: snapshot.composer.value.text, onChange: (event: { currentTarget: { value: string } }) => view.setDraft(event.currentTarget.value) })),
    snapshot.kind === 'codex' ? h(CodexGoalControl, { snapshot, open: goalOpen, onOpenChange: setGoalOpen, run: work => { void work().catch(() => setError('ACTION_FAILED')); } }) : null,
    h(NativeActions, { snapshot, text: snapshot.composer.value.text, hasFiles: false, showGoal: false, run: work => { void work().catch(() => setError('ACTION_FAILED')); } }),
    h(Transcript, { view, history: snapshot.history, previewOptions: { sessionId: selected }, preview: async () => { throw Error('No fixture preview'); }, previewLocal: async () => { throw Error('No fixture preview'); }, run: work => { void work().catch(() => setError('ACTION_FAILED')); } }),
    ...snapshot.operations.map(operation => h('p', { key: operation.id, 'data-original': operation.id }, operationLabel(operation))), error ? h('p', { role: 'alert' }, error) : null);
}
const root = createRoot(document.getElementById('root')!); root.render(h(App));
Object.assign(window, { actionFixture: { counts: () => ({ reads, submissions: f.native.submitted.length }), commands: () => f.native.submitted.map(request => request.command),
  disconnect() { f.observation({ scope: f.snapshot('b').scope, kind: 'session', state: 'connecting' }); f.observation({ scope: f.snapshot('b').scope, kind: 'session', state: 'live' }); },
  stopped() { f.native.publish(f.snapshot('b').scope, { phase: 'stopped' }); },
  close() { root.unmount(); planLease.release(); f.workspace.close(); return f.counts(); } } });
