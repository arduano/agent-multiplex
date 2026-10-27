import { Button } from './ui/index.js';
import { createElement as h } from 'react';
import type { Task, TaskProgress } from '../../v8-session/src/contracts/types.js';
import { NativeObservation, currentObservation, nativeObservation, type RunNativeAction, type NativeSnapshot } from './native-observation.js';

function taskStatus(task: Task, stopped: boolean, stale: boolean): string {
  const active = task.status === 'running' || task.status === 'idle';
  const label = task.status === 'orphaned' ? 'Owner disconnected · outcome unknown' : task.status === 'idle' ? task.type === 'client' ? 'Owner connected · waiting' : 'Awaiting input' : task.status.charAt(0).toUpperCase() + task.status.slice(1);
  return stopped && active ? `Agent stopped · last observed ${label.toLowerCase()}` : stale ? `Last observed: ${label}` : label;
}
function TaskDetails({ task, stopped, stale }: Readonly<{ task: Task; stopped: boolean; stale: boolean }>) {
  return h('div', null,
    h('p', null, task.displayName ?? task.description), h('p', { 'data-task-status': task.status }, taskStatus(task, stopped, stale)),
    task.displayName && task.displayName !== task.description ? h('p', null, task.description) : null,
    h('p', null, `${task.type === 'shell' ? 'Command' : task.type === 'agent' ? 'Agent' : 'Client'}${task.executionMode ? task.executionMode === 'background' ? ' · Background' : ' · Foreground' : ''}${task.agentType ? ` · ${task.agentType}` : ''}`),
    task.type === 'agent' ? h('p', null, `Requested model: ${task.model ?? 'Not reported'}`) : null,
    task.type === 'agent' ? h('p', null, `Resolved model: ${task.resolvedModel ?? 'Not reported'}`) : null,
    task.command ? h('pre', { tabIndex: 0, 'aria-label': 'Task command' }, task.command) : null,
    task.pid === undefined ? null : h('p', null, `PID: ${task.pid}`),
    task.error ? h('p', { 'aria-label': 'Task error' }, task.error) : null,
    task.latestResponse ? h('pre', { tabIndex: 0, 'aria-label': 'Latest task response' }, task.latestResponse) : null,
    task.result ? h('pre', { tabIndex: 0, 'aria-label': 'Task result' }, task.result) : null,
    h('p', null, 'Started: ', h('time', { dateTime: task.startedAt }, task.startedAt), task.completedAt ? h('span', null, ' · Completed: ', h('time', { dateTime: task.completedAt }, task.completedAt)) : null));
}
function TaskProgressDetails({ value }: Readonly<{ value: TaskProgress }>) {
  return h('div', null,
    value.status ? h('p', null, `Last reported status: ${value.status}`) : null,
    value.latestIntent ? h('p', null, value.latestIntent) : null,
    value.phase !== undefined || value.percentage !== undefined ? h('p', null, [value.phase, value.percentage === undefined ? null : `${value.percentage}%`].filter(Boolean).join(' · ')) : null,
    value.lastMessage ? h('p', null, value.lastMessage) : null,
    value.recentOutput ? h('pre', { tabIndex: 0, 'aria-label': 'Recent task output' }, value.recentOutput) : null,
    value.recentActivity?.length ? h('ol', { 'aria-label': 'Recent task activity' }, ...value.recentActivity.map((item, index) => h('li', { key: index }, h('time', { dateTime: item.timestamp }, item.timestamp), ' · ', item.message))) : null,
    value.updatedAt ? h('p', null, 'Updated: ', h('time', { dateTime: value.updatedAt }, value.updatedAt)) : null);
}
export function CopilotTasks({ snapshot, disabled, readDisabled, run }: Readonly<{ snapshot: NativeSnapshot<'copilot'>; disabled: boolean; readDisabled: boolean; run: RunNativeAction }>) {
  const actions = snapshot.actions, native = snapshot.session.native, reads = native?.capabilities.reads ?? [];
  const observation = nativeObservation(snapshot, 'copilot.tasks'), value = observation?.value, tasks = value?.type === 'copilot.tasks' ? value.tasks : undefined;
  const progressObservation = nativeObservation(snapshot, 'copilot.task.progress'), progress = progressObservation?.value;
  const promotableObservation = nativeObservation(snapshot, 'copilot.task.promotable'), promotable = promotableObservation?.value;
  const stale = readDisabled || !currentObservation(observation), stopped = native?.phase === 'stopped';
  if (!reads.some(type => type.startsWith('copilot.task'))) return null;
  return h('section', { 'aria-label': 'Copilot tasks' }, h('h4', null, 'Tasks'),
    actions.read && reads.includes('copilot.tasks') ? h(Button, { variant: 'ghost', 'data-action': 'read-tasks', disabled: readDisabled, onClick: () => run(() => actions.read!({ type: 'copilot.tasks' })) }, 'Refresh tasks') : null,
    h(NativeObservation, { item: observation, action: 'native-tasks' }),
    tasks ? tasks.length ? h('ul', { 'aria-label': 'Native Copilot tasks' }, ...tasks.map((task, index) => h('li', { key: task.id, 'data-task-id': task.id },
      h(TaskDetails, { task, stopped, stale }),
      actions.promoteTask && (task.status === 'running' || task.status === 'idle') && task.canPromoteToBackground ? h(Button, { variant: 'ghost', 'data-action': `promote-task-${index}`, disabled: disabled || stale, onClick: () => run(() => actions.promoteTask!(task.id).result) }, 'Run task in background') : null,
      actions.cancelTask && (task.status === 'running' || task.status === 'idle') && (task.type !== 'client' || task.canCancel === true) ? h(Button, { variant: 'ghost', 'data-action': `cancel-task-${index}`, disabled: disabled || stale, onClick: () => run(() => actions.cancelTask!(task.id).result) }, task.type === 'shell' ? 'Stop command' : 'Cancel task') : null,
      actions.read && reads.includes('copilot.task.progress') ? h(Button, { variant: 'ghost', 'data-action': `read-progress-${index}`, disabled: readDisabled || stale, onClick: () => run(() => actions.read!({ type: 'copilot.task.progress', id: task.id })) }, 'Refresh task progress') : null))) : h('p', null, 'No tracked tasks') : null,
    reads.includes('copilot.task.progress') ? h('section', { 'aria-label': 'Copilot task progress' }, h('h5', null, 'Task progress'), h(NativeObservation, { item: progressObservation, action: 'native-progress' }),
      progress?.type === 'copilot.task.progress' ? h('div', { 'data-progress-task-id': progress.id }, h('p', null, `Task: ${progress.id}`), progress.progress ? h(TaskProgressDetails, { value: progress.progress }) : h('p', null, 'No progress reported')) : null) : null,
    reads.includes('copilot.task.promotable') ? h('section', { 'aria-label': 'Promotable task' }, h('h5', null, 'Promotable task'),
      actions.read ? h(Button, { variant: 'ghost', 'data-action': 'read-promotable', disabled: readDisabled, onClick: () => run(() => actions.read!({ type: 'copilot.task.promotable' })) }, 'Find promotable task') : null,
      h(NativeObservation, { item: promotableObservation, action: 'native-promotable' }),
      promotable?.type === 'copilot.task.promotable' ? promotable.task ? h('div', null, h(TaskDetails, { task: promotable.task, stopped, stale: readDisabled || !currentObservation(promotableObservation) }),
        actions.promoteTask && promotable.task.canPromoteToBackground !== false ? h(Button, { variant: 'ghost', 'data-action': 'promote-current-task', disabled: disabled || !currentObservation(promotableObservation), onClick: () => run(() => actions.promoteTask!(promotable.task!.id).result) }, 'Run observed task in background') : null) : h('p', null, 'No promotable task') : null) : null);
}
