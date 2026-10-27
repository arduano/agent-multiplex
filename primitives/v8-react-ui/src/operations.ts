import { Button } from './ui/index.js';
import { createElement as h } from 'react';
import type { OperationStatus } from '../../v8-workspace/src/contracts.js';
export function isUnresolved(operation: OperationStatus): boolean { return ['sending', 'unobserved', 'admitted', 'dispatched', 'outcomeUnknown'].includes(operation.state); }
export function operationLabel(operation: OperationStatus): string {
  if (operation.outcome?.sendDispatched === false) return 'Message not sent';
  if (operation.state === 'outcomeUnknown' || operation.state === 'unobserved') return 'Receipt not yet observed';
  if (operation.state === 'sending') return 'Sending request';
  if (operation.state === 'admitted' || operation.state === 'dispatched') return 'Request received; awaiting native outcome';
  if (operation.state === 'refused') return 'Request refused';
  const status = operation.outcome?.status;
  if (status === 'applied' || status === 'acknowledged') {
    const result = operation.outcome?.result;
    if (result?.type === operation.type) switch (result.type) {
      case 'copilot.compact': return result.success ? `Context compacted · ${result.messagesRemoved} messages removed · ${result.tokensRemoved} tokens freed` : 'Native agent did not compact context';
      case 'copilot.queue.promote': return result.steered ? 'Native agent moved the queued message to steering' : 'Native agent did not move the queued message; refresh the queue';
      case 'copilot.task.cancel': return result.cancelled ? 'Native agent accepted task cancellation; refresh task status' : 'Native agent did not cancel the task; refresh task status';
      case 'copilot.task.promote': return result.promoted ? 'Native agent moved the task to background; refresh task status' : 'Native agent did not move the task to background; refresh task status';
      case 'codex.goal.clear': return result.cleared ? 'Native agent cleared the goal; a running turn is unchanged' : 'Native agent reported no goal was cleared';
      case 'codex.terminal.terminate': return result.terminated ? 'Native agent reported terminal termination; check agent lifetime separately' : 'Native agent did not terminate the terminal; refresh background terminals';
    }
    if (['copilot.compact', 'copilot.queue.promote', 'copilot.task.cancel', 'copilot.task.promote', 'codex.goal.clear', 'codex.terminal.terminate'].includes(operation.type)) return 'Native action result was not reported; refresh its state before another action';
    if (operation.type === 'codex.compact') return 'Native agent accepted compaction; completion has not been proved';
  }
  return status === 'accepted' ? 'Accepted by the native agent' : status === 'confirmationRequired' ? 'Confirmation required' : status === 'targetUnavailable' ? 'Native target unavailable' : status === 'deferred' ? 'Deferred by the native agent' : status === 'refused' ? 'Request refused' : status === 'acknowledged' || status === undefined ? 'Request acknowledged' : status;
}
function Original({ operation, check }: Readonly<{ operation: OperationStatus; check(id: string): void }>) {
  return h('div', { className: 'mpx-chat__original', 'data-original': operation.id },
    h('span', null, h('strong', null, operation.type === 'send' ? 'Message' : operation.type), ' · ', operationLabel(operation)),
    isUnresolved(operation) ? h(Button, { variant: 'ghost', type: 'button', onClick: () => check(operation.id) }, `Check original ${operation.type}`) : null,
    operation.outcome?.completedSubsteps?.length ? h('details', null, h('summary', null, 'Applied settings'), h('ul', null, ...operation.outcome.completedSubsteps.map(step => h('li', { key: step }, step)))) : null);
}
type Props = Readonly<{ operations: readonly OperationStatus[]; check(id: string): void }>;
function urgentOperations(operations: readonly OperationStatus[]) {
  const urgent = operations.filter(operation => isUnresolved(operation) || operation.state === 'refused' || operation.outcome?.sendDispatched === false || operation.outcome?.status === 'refused');
  const primary = urgent.find(operation => operation.type === 'stop') ?? urgent.at(-1);
  return { urgent, primary };
}
export function OperationNotice({ operations, check }: Props) {
  const { urgent, primary } = urgentOperations(operations);
  return primary ? h('div', { className: 'mpx-chat__operation-notice', role: 'status', 'data-action': 'latest-action' }, h(Original, { operation: primary, check }), urgent.length > 1 ? h('small', null, `${urgent.length} actions need review`) : null) : null;
}
export function OperationHistory({ operations, check }: Props) {
  const { primary } = urgentOperations(operations);
  const others = operations.filter(operation => operation !== primary);
  return others.length ? h('details', { className: 'mpx-chat__activity', 'data-action': 'action-history' }, h('summary', null, `Activity (${others.length})`), h('div', null, ...others.map(operation => h(Original, { key: operation.id, operation, check })))) : null;
}
/** Every original appears once; receipt acceptance never implies agent completion. */
export function OperationStatusList(props: Props) {
  return props.operations.length ? h('div', { className: 'mpx-chat__operations' }, h(OperationNotice, props), h(OperationHistory, props)) : null;
}
