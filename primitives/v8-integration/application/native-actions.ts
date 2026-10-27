import { createElement as h } from 'react';
import type { AgentSnapshot } from '../../v8-workspace/src/contracts.js';

type Ready = Extract<AgentSnapshot, { kind: 'codex' | 'copilot' }>;
type Props = Readonly<{ snapshot: Ready; text: string; hasFiles: boolean; run(work: () => Promise<unknown>): void }>;

/** Explicit native actions over the retained Session owner. Rendering never
 * reads a host, copies its observations into React state, or resends a message. */
export function NativeActions({ snapshot, text, hasFiles, run }: Props) {
  const native = snapshot.session.native;
  if (!native) return null;
  const disabled = !snapshot.session.connected || snapshot.session.stale || !!native.issue || native.phase !== 'running';
  const textDisabled = disabled || hasFiles || !text.trim();
  const observation = (type: string) => snapshot.session.nativeReads.find(item => item.request.type === type);
  const fact = (type: string, id: string) => {
    const item = observation(type);
    const state = !item ? 'Not checked' : item.state === 'loading' ? 'Checking…' : item.state === 'unavailable' ? 'Could not refresh' : 'Checked';
    return h('p', { id, role: 'status' }, `${state}${item?.stale ? ' · last observation may be out of date' : ''}`);
  };
  const compact = snapshot.actions.compact;
  const common = compact ? h('button', { id: 'compact-context', disabled, onClick: () => run(() => compact().result) }, 'Compact context') : null;
  if (snapshot.kind === 'codex') {
    const actions = snapshot.actions, turnId = snapshot.history.current?.activity.turnId;
    const goal = observation('codex.goal')?.value;
    return h('details', { id: 'native-actions' }, h('summary', null, 'Native actions'),
      h('p', null, 'Text actions use the message draft below. Attachments are sent with Send.'),
      actions.steer ? h('button', { id: 'steer-input', disabled: textDisabled || !turnId, onClick: () => run(() => actions.steer!(turnId!, text).result) }, 'Steer current turn') : null,
      actions.enqueue ? h('button', { id: 'enqueue-input', disabled: textDisabled, onClick: () => run(() => actions.enqueue!(text).result) }, 'Queue message') : null,
      common,
      actions.read ? h('button', { id: 'read-goal', disabled, onClick: () => run(() => actions.read!({ type: 'codex.goal' })) }, 'Refresh goal') : null,
      fact('codex.goal', 'native-goal'),
      goal?.type === 'codex.goal' ? goal.goal ? h('div', null, h('p', null, goal.goal.objective), h('p', null, `${goal.goal.status} · ${goal.goal.tokensUsed} tokens used${goal.goal.tokenBudget === null ? '' : ` of ${goal.goal.tokenBudget}`}`)) : h('p', null, 'No goal') : null,
      actions.setGoal ? h('button', { id: 'set-goal', disabled: textDisabled, onClick: () => run(() => actions.setGoal!({ objective: text }).result) }, 'Set goal from draft') : null,
      actions.setGoal && goal?.type === 'codex.goal' && goal.goal ? h('div', null,
        ...(['active', 'paused', 'complete'] as const).map(status => h('button', { key: status, id: `goal-${status}`, disabled, onClick: () => run(() => actions.setGoal!({ status }).result) }, `Set goal ${status}`))) : null,
      actions.clearGoal ? h('button', { id: 'clear-goal', disabled, onClick: () => run(() => actions.clearGoal!().result) }, 'Clear goal') : null);
  }
  const actions = snapshot.actions, queue = observation('copilot.queue')?.value, tasks = observation('copilot.tasks')?.value;
  const promotable = observation('copilot.task.promotable')?.value, progress = observation('copilot.task.progress')?.value;
  return h('details', { id: 'native-actions' }, h('summary', null, 'Native actions'),
    h('p', null, 'Steer uses the message draft below. Send during work uses the native queue.'),
    actions.steer ? h('button', { id: 'steer-input', disabled: textDisabled, onClick: () => run(() => actions.steer!(text).result) }, 'Steer current work') : null,
    common,
    actions.read ? h('div', null,
      h('button', { id: 'read-queue', disabled, onClick: () => run(() => actions.read!({ type: 'copilot.queue' })) }, 'Refresh queue'),
      h('button', { id: 'read-tasks', disabled, onClick: () => run(() => actions.read!({ type: 'copilot.tasks' })) }, 'Refresh tasks'),
      h('button', { id: 'read-promotable', disabled, onClick: () => run(() => actions.read!({ type: 'copilot.task.promotable' })) }, 'Find promotable task')) : null,
    fact('copilot.queue', 'native-queue'),
    queue?.type === 'copilot.queue' ? h('div', null, h('p', null, `${queue.items.length} queued messages · ${queue.inFlightSteeringCount ?? queue.steeringMessages.length} steering messages`), ...queue.items.map((item, index) => h('div', { key: `${item.id}/${index}` }, item.displayText,
      actions.promoteQueued ? h('button', { id: `promote-queue-${index}`, disabled, onClick: () => run(() => actions.promoteQueued!(item.id).result) }, 'Run queued message now') : null))) : null,
    fact('copilot.tasks', 'native-tasks'),
    tasks?.type === 'copilot.tasks' ? h('div', null, ...tasks.tasks.map((task, index) => h('div', { key: task.id }, `${task.description} · ${task.status}`,
      actions.promoteTask && task.canPromoteToBackground ? h('button', { id: `promote-task-${index}`, disabled, onClick: () => run(() => actions.promoteTask!(task.id).result) }, 'Run task in background') : null,
      actions.cancelTask && task.canCancel ? h('button', { id: `cancel-task-${index}`, disabled, onClick: () => run(() => actions.cancelTask!(task.id).result) }, 'Cancel task') : null,
      actions.read ? h('button', { id: `read-progress-${index}`, disabled, onClick: () => run(() => actions.read!({ type: 'copilot.task.progress', id: task.id })) }, 'Refresh task progress') : null))) : null,
    fact('copilot.task.progress', 'native-progress'), fact('copilot.task.promotable', 'native-promotable'),
    progress?.type === 'copilot.task.progress' ? progress.progress ? h('pre', null, progress.progress.latestIntent ?? progress.progress.recentOutput ?? progress.progress.lastMessage ?? progress.progress.recentActivity?.map(item => item.message).join('\n') ?? 'No progress detail') : h('p', null, 'No progress reported') : null,
    promotable?.type === 'copilot.task.promotable' ? h('p', null, promotable.task?.description ?? 'No promotable task') : null,
    promotable?.type === 'copilot.task.promotable' && promotable.task && actions.promoteTask ? h('button', { id: 'promote-current-task', disabled, onClick: () => run(() => actions.promoteTask!(promotable.task!.id).result) }, 'Run observed task in background') : null);
}
