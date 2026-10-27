import { Button, Input, Textarea } from './ui/index.js';
import { createElement as h, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { GoalStatus } from '../../v8-session/src/contracts/types.js';
import { goalBudget } from '../../v8-workspace/src/goal-form.js';
import { NativeObservation, nativeObservation, type RunNativeAction, type NativeSnapshot } from './native-observation.js';

const labels: Record<GoalStatus, string> = { active: 'Active', paused: 'Paused', blocked: 'Blocked', usageLimited: 'Usage limit', budgetLimited: 'Budget reached', complete: 'Complete' };

export function CodexGoalControl({ snapshot, run, open, onOpenChange }: Readonly<{ snapshot: NativeSnapshot<'codex'>; run: RunNativeAction; open: boolean; onOpenChange(open: boolean): void }>) {
  const trigger = useRef<HTMLButtonElement | null>(null), native = snapshot.session.native;
  const observation = nativeObservation(snapshot, 'codex.goal'), value = observation?.value;
  if (!snapshot.actions.setGoal && !native?.capabilities.reads?.includes('codex.goal')) return null;
  const goal = value?.type === 'codex.goal' ? value.goal : undefined;
  const readDisabled = !snapshot.access.read || !snapshot.session.connected || snapshot.session.stale || snapshot.session.requiresRebind || !!native?.issue || native?.phase !== 'running';
  return h(Dialog.Root, { open, onOpenChange },
    h(Dialog.Trigger, { asChild: true }, h(Button, { variant: 'ghost', ref: trigger, type: 'button', className: 'mpx-chat__goal-trigger', 'data-action': 'goal-control', title: goal?.objective }, goal ? `Goal · ${observation?.stale ? 'Last observed: ' : ''}${labels[goal.status]}` : 'Goal', goal ? h('span', null, goal.objective) : null)),
    h(Dialog.Portal, { container: trigger.current?.closest<HTMLElement>('.multiplex-chat') }, h(Dialog.Overlay, { className: 'mpx-chat__overlay' }), h(Dialog.Content, { className: 'mpx-chat__dialog', 'aria-describedby': undefined }, h(Dialog.Title, { asChild: true }, h('h3', null, 'Agent goal')),
      h(CodexGoals, { snapshot, readDisabled, disabled: readDisabled || !snapshot.access.control, run }),
      h('footer', { className: 'mpx-chat__panel-actions mpx-chat__dialog-actions' }, h(Dialog.Close, { asChild: true }, h(Button, { variant: 'outline', type: 'button' }, 'Close goal'))))));
}

/** Summary derives only from retained native reads. It never opens an editor,
 * fetches a goal, or treats an acknowledged edit as observed native state. */
export function CodexGoalSummary({ snapshot }: Readonly<{ snapshot: NativeSnapshot<'codex'> }>) {
  const observation = nativeObservation(snapshot, 'codex.goal'), value = observation?.value;
  if (value?.type !== 'codex.goal' || !value.goal) return null;
  const goal = value.goal;
  return h('section', { 'aria-label': 'Observed goal', 'data-action': 'goal-summary' },
    h('strong', null, `Goal · ${observation?.stale ? 'Last observed: ' : ''}${labels[goal.status]}`), h('p', null, goal.objective),
    h('small', null, `${goal.tokensUsed} tokens used${goal.tokenBudget === null ? '' : ` of ${goal.tokenBudget}`} · ${goal.timeUsedSeconds} seconds elapsed`));
}

export function CodexGoals({ snapshot, disabled, readDisabled, run }: Readonly<{
  snapshot: NativeSnapshot<'codex'>; disabled: boolean; readDisabled: boolean; run: RunNativeAction;
}>) {
  const actions = snapshot.actions, observation = nativeObservation(snapshot, 'codex.goal'), value = observation?.value;
  const goal = value?.type === 'codex.goal' ? value.goal : undefined, form = snapshot.goalForm, editor = actions.goalEditor;
  let validBudget = true; try { goalBudget(form.budget); } catch { validBudget = false; }
  if (!actions.setGoal && !actions.clearGoal && !snapshot.session.native?.capabilities.reads?.includes('codex.goal')) return null;
  return h('section', { 'aria-label': 'Codex goal' }, h('h4', null, 'Goal'),
    actions.read && snapshot.session.native?.capabilities.reads?.includes('codex.goal') ? h(Button, { variant: 'ghost', 'data-action': 'read-goal', disabled: readDisabled, onClick: () => run(() => actions.read!({ type: 'codex.goal' })) }, 'Refresh goal') : null,
    h(NativeObservation, { item: observation, action: 'native-goal' }),
    h(CodexGoalSummary, { snapshot }),
    goal === null ? h('p', null, 'No goal') : null,
    editor && !form.editing ? h(Button, { variant: 'ghost', 'data-action': 'edit-goal', disabled: disabled || goal === undefined, onClick: () => editor.open() }, goal ? 'Edit goal' : 'Set goal') : null,
    editor && form.editing ? h('div', { className: 'mpx-chat__goal-editor', 'data-action': 'goal-editor' },
      h('label', null, 'Goal objective', h(Textarea, { 'aria-label': 'Goal objective', maxLength: 4000, value: form.objective, disabled: form.saving, onChange: (event: { currentTarget: HTMLTextAreaElement }) => editor.edit({ objective: event.currentTarget.value }) })),
      h('label', null, 'Token budget', h(Input, { 'aria-label': 'Token budget', type: 'text', inputMode: 'numeric', maxLength: 32, value: form.budget, disabled: form.saving, placeholder: 'Native default', onChange: (event: { currentTarget: HTMLInputElement }) => editor.edit({ budget: event.currentTarget.value }) })),
      !validBudget ? h('p', { 'data-action': 'goal-budget-invalid', role: 'status' }, 'Enter a positive whole token budget, or leave it empty for the native default. Zero is not supported.') : null,
      h('div', { className: 'mpx-chat__panel-actions' },
        h(Button, { variant: 'ghost', 'data-action': 'cancel-goal-edit', disabled: form.saving, onClick: () => editor.cancel() }, 'Cancel goal edit'),
        h(Button, { 'data-action': 'save-goal', disabled: disabled || form.saving || !form.objective.trim() || !validBudget, onClick: () => { if (!disabled && !form.saving && form.objective.trim() && validBudget) run(() => editor.save().result); } }, form.saving ? 'Saving goal…' : 'Save goal'))) : null,
    actions.setGoal && goal ? h('div', { className: 'mpx-chat__panel-actions' }, ...(['active', 'paused', 'complete'] as const).map(status => h(Button, { variant: 'outline', key: status, 'data-action': `goal-${status}`, disabled: disabled || !!observation?.stale || form.saving, onClick: () => run(() => actions.setGoal!({ status }).result) }, `Set goal ${status}`))) : null,
    actions.clearGoal ? h('div', { className: 'mpx-chat__panel-actions' }, h(Button, { variant: 'destructive', 'data-action': 'clear-goal', disabled: disabled || form.saving, onClick: () => run(() => actions.clearGoal!().result) }, 'Clear goal')) : null);
}
