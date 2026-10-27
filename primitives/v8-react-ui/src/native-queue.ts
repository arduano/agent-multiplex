import { Button } from './ui/index.js';
import { createElement as h } from 'react';
import { NativeObservation, currentObservation, nativeObservation, type RunNativeAction, type NativeSnapshot } from './native-observation.js';

export function CopilotQueue({ snapshot, disabled, readDisabled, run }: Readonly<{ snapshot: NativeSnapshot<'copilot'>; disabled: boolean; readDisabled: boolean; run: RunNativeAction }>) {
  const actions = snapshot.actions, observation = nativeObservation(snapshot, 'copilot.queue'), value = observation?.value;
  if (!snapshot.session.native?.capabilities.reads?.includes('copilot.queue')) return null;
  const queue = value?.type === 'copilot.queue' ? value : undefined;
  // Native count identifies the prefix already in flight; remaining strings
  // are still waiting. Neither group becomes a client-owned queue.
  const inFlight = queue?.inFlightSteeringCount, steering = queue?.steeringMessages.slice(inFlight ?? 0) ?? [];
  return h('section', { 'aria-label': 'Copilot queue' }, h('h4', null, 'Queue'),
    actions.read ? h(Button, { variant: 'ghost', 'data-action': 'read-queue', disabled: readDisabled, onClick: () => run(() => actions.read!({ type: 'copilot.queue' })) }, 'Refresh queue') : null,
    h(NativeObservation, { item: observation, action: 'native-queue' }),
    queue ? h('div', null, h('p', null, `${queue.items.length} queued messages · ${inFlight === undefined ? 'steering delivery state not reported' : `${inFlight} steering messages in flight · ${steering.length} waiting`}`),
      queue.items.length ? h('ol', { 'aria-label': 'Queued messages' }, ...queue.items.map((item, index) => h('li', { key: `${item.id}/${index}`, 'data-queue-id': item.id }, h('p', null, item.displayText), h('p', null, `${item.kind} · ${item.agentMode}`),
        actions.promoteQueued ? h(Button, { variant: 'ghost', 'data-action': `promote-queue-${index}`, disabled: disabled || !currentObservation(observation), onClick: () => run(() => actions.promoteQueued!(item.id).result) }, 'Run queued message now') : null))) : h('p', null, 'No queued messages'),
      steering.length ? h('ol', { 'aria-label': inFlight === undefined ? 'Observed steering messages' : 'Waiting steering messages' }, ...steering.map((message, index) => h('li', { key: index }, message))) : null) : null);
}
