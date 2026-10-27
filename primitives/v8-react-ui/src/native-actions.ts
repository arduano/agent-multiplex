import { Button } from './ui/index.js';
import { createElement as h } from 'react';
import type { AgentSnapshot } from '../../v8-workspace/src/contracts.js';
import { McpLogin } from './mcp-login.js';
import { CodexGoals } from './native-goal.js';
import { CopilotQueue } from './native-queue.js';
import { CopilotTasks } from './native-tasks.js';
import { NativeObservation, nativeObservation, type RunNativeAction } from './native-observation.js';
export { CodexGoalSummary } from './native-goal.js';

type Ready = Extract<AgentSnapshot, { kind: 'codex' | 'copilot' }>;
type Props = Readonly<{ snapshot: Ready; text: string; hasFiles: boolean; run: RunNativeAction; showGoal?: boolean; open?: boolean }>;

/** Explicit native actions over retained owners. Rendering performs no native
 * reads, copies no observations into React state and never resends a message. */
export function NativeActions({ snapshot, run, showGoal = true, open = false }: Props) {
  const native = snapshot.session.native;
  if (!native) return null;
  const readDisabled = !snapshot.access.read || !snapshot.session.connected || snapshot.session.stale || snapshot.session.requiresRebind || !!native.issue || native.phase !== 'running';
  const disabled = readDisabled || !snapshot.access.control;
  const compact = snapshot.actions.compact, continueAction = snapshot.actions.continue;
  const retrying = native.attention?.generation === native.generation && native.attention.epoch === native.epoch && native.attention.state === 'retrying';
  const continueButton = continueAction ? h(Button, { variant: 'ghost', 'data-action': 'continue-work', disabled: disabled || native.activity !== 'idle' || !native.interactionsComplete || native.interactions.length > 0 || retrying, onClick: () => run(() => continueAction().result) }, 'Continue without a prompt') : null;
  const common = compact ? h(Button, { variant: 'ghost', 'data-action': 'compact-context', disabled, onClick: () => run(() => compact().result) }, 'Compact context') : null;
  if (snapshot.kind === 'codex') {
    const actions = snapshot.actions;
    const terminalObservation = nativeObservation(snapshot, 'codex.terminals'), terminals = terminalObservation?.value;
    return h('details', { 'data-action': 'native-actions', open }, h('summary', null, 'Native actions'),
      h('div', { className: 'mpx-chat__panel-actions' }, continueButton, common),
      actions.reloadMcp ? h('div', null, h(Button, { variant: 'ghost', 'data-action': 'reload-mcp', disabled, onClick: () => run(() => actions.reloadMcp!().result) }, "Reload this agent's MCP configuration"), h('p', null, 'Reload applies to this native session and its loaded children. Check tool connections afterward.')) : null,
      h(McpLogin, { snapshot, disabled, run }),
      showGoal ? h(CodexGoals, { snapshot, disabled, readDisabled, run }) : null,
      actions.read && native.capabilities.reads?.includes('codex.terminals') ? h(Button, { variant: 'ghost', 'data-action': 'read-terminals', disabled: readDisabled, onClick: () => run(() => actions.read!({ type: 'codex.terminals' })) }, 'Refresh background terminals') : null,
      h(NativeObservation, { item: terminalObservation, action: 'native-terminals' }),
      terminals?.type === 'codex.terminals' ? h('div', null,
        terminals.data.length ? terminals.data.map((terminal, index) => h('div', { key: terminal.processId }, h('pre', null, terminal.command), h('p', null, terminal.cwd),
          actions.terminateTerminal ? h(Button, { variant: 'destructive', 'data-action': `terminate-terminal-${index}`, disabled: disabled || terminalObservation?.stale, onClick: () => run(() => actions.terminateTerminal!(terminal.processId).result) }, 'Terminate terminal') : null)) : h('p', null, 'No background terminals on this page'),
        terminals.nextCursor && actions.read ? h(Button, { variant: 'ghost', 'data-action': 'next-terminals', disabled: readDisabled || terminalObservation?.stale, onClick: () => run(() => actions.read!({ type: 'codex.terminals', cursor: terminals.nextCursor })) }, 'Next terminal page') : null) : null,
      actions.cleanTerminals ? h(Button, { variant: 'ghost', 'data-action': 'clean-terminals', disabled, onClick: () => run(() => actions.cleanTerminals!().result) }, 'Clean background terminals') : null);
  }
  const actions = snapshot.actions;
  return h('details', { 'data-action': 'native-actions', open }, h('summary', null, 'Native actions'),
    h('div', { className: 'mpx-chat__panel-actions' }, continueButton, common),
    h(McpLogin, { snapshot, disabled, run }),
    actions.reconnectMcp && snapshot.mcp?.kind === 'copilot' ? h('div', null, ...snapshot.mcp.servers.map((server, index) => h(Button, { variant: 'ghost',
      key: server.name, 'data-action': `reconnect-mcp-${index}`, disabled: disabled || snapshot.mcpStale || snapshot.mcp!.freshness !== 'current' || !server.enabled || server.transport === 'unknown',
      onClick: () => run(() => actions.reconnectMcp!(server.name).result),
    }, `Reconnect ${server.name}`)), h('p', null, 'Reconnect restarts this native server. Check tool connections afterward.')) : null,
    h(CopilotQueue, { snapshot, disabled, readDisabled, run }),
    h(CopilotTasks, { snapshot, disabled, readDisabled, run }));
}
