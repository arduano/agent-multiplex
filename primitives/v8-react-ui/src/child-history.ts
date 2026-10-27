import { Button } from './ui/index.js';
import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { AgentSnapshot, WorkspaceView } from '../../v8-workspace/src/contracts.js';
import type { ReadonlyHistoryView } from '../../v8-workspace/src/history-view.js';
import type { Scope } from '../../v8-history/src/contracts/types.js';
import type { ResourceLease } from '../../v8-files/src/client/resource-cache.js';
import type { LocalFileReference } from './file-reference.js';
import type { PreviewOptions } from './files.js';
import { Transcript } from './transcript.js';
import type { AgentSummary } from '../../v8-workspace/src/agent-summary.js';

const scopeLabel = (scope: Scope) => scope.kind === 'codex' ? scope.threadId : scope.agentId ?? scope.legacyParentToolCallId ?? 'Main agent';
type Ready = Extract<AgentSnapshot, { kind: 'codex' | 'copilot' }>;
type Media = Readonly<{ preview(id: string): Promise<ResourceLease>; previewLocal(reference: LocalFileReference): Promise<ResourceLease>; previewOptions: PreviewOptions }>;
/** Explicit Host-proved inventory only. A child history has no composer,
 * actions, callback form, control projection or mutation capability. */
export function ChildHistories({ view, snapshot, open = false, ...media }: Readonly<{ view: WorkspaceView; snapshot: Ready; open?: boolean }> & Media) {
  const [selected, setSelected] = useState<Readonly<{ view: ReadonlyHistoryView; trigger: HTMLButtonElement }> | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mounted = useRef(false); useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const inventory = snapshot.historyScopes;
  if (!inventory.supported) return null;
  const children = snapshot.agents;
  return h('div', { className: 'mpx-chat__child-histories' }, h('details', { open }, h('summary', null, 'Agent histories'),
    h('p', { className: 'mpx-chat__muted' }, 'Agents appear on the retained stream. Opening reads captured history; it does not start, resume or control an agent.'),
    h(Button, { variant: 'ghost', type: 'button', disabled: busy || !snapshot.session.connected || !!snapshot.bindingTransition, onClick: () => {
      setBusy(true); setError(''); void view.refreshHistoryScopes().catch(() => { if (mounted.current) setError('Observed agents could not be refreshed. Existing history is retained.'); }).finally(() => { if (mounted.current) setBusy(false); });
    } }, busy ? 'Reading observed agents…' : 'Refresh observed agents'),
    error ? h('p', { role: 'status' }, error) : null,
    inventory.state === 'observed' && !children.length ? h('p', null, 'No child histories are proved in this captured window.') : null,
    children.length ? h('ul', { 'aria-label': 'Observed child histories' }, ...children.map(agent => h('li', { key: JSON.stringify(agent.scope), 'data-native-agent': agent.id }, h(Button, { variant: 'ghost', type: 'button', disabled: inventory.state !== 'observed' || !!snapshot.bindingTransition, onClick: (event: { currentTarget: HTMLButtonElement }) => {
      try { setSelected({ view: view.historyView(agent.scope), trigger: event.currentTarget }); setError(''); } catch { setError('This child is no longer in the current proved inventory. Refresh observed agents.'); }
    } }, `View agent ${agent.id}`), h(AgentDetails, { agent })))) : null),
    h(Dialog.Root, { open: selected !== null, onOpenChange: next => { if (!next) setSelected(null); } }, selected ? h(Dialog.Portal, { container: selected.trigger.closest<HTMLElement>('.multiplex-chat') }, h(Dialog.Overlay, { className: 'mpx-chat__overlay' }), h(ChildHistoryDialog, { ...media, view: selected.view, trigger: selected.trigger, nativeRunning: snapshot.session.connected && !snapshot.session.stale && !snapshot.session.requiresRebind && !snapshot.session.issue && snapshot.session.native?.phase === 'running' && !snapshot.session.native.stopRequested, agent: children.find(value => JSON.stringify(value.scope) === JSON.stringify(selected.view.scope)) })) : null));
}
function AgentDetails({ agent }: Readonly<{ agent: AgentSummary }>) {
  const labels = { requested: 'Requested', configured: 'Configured', resolvedAtStart: 'Resolved at start', firstDispatched: 'First dispatched', reportedUsed: 'Completion reported' };
  return h('div', { className: 'mpx-chat__muted' },
    h('span', null, [agent.name, agent.role, agent.path].filter(Boolean).join(' · ') || 'Name unavailable'),
    h('span', null, ` · ${agent.lastObserved ? 'Last observed: ' : ''}${agent.status}`),
    agent.models.length ? h('ul', { 'aria-label': 'Agent model facts' }, ...agent.models.map((fact, index) => h('li', { key: index }, `${labels[fact.source]}: ${fact.model}`))) : h('p', null, 'Model unavailable'));
}
function ChildHistoryDialog({ view, trigger, agent, nativeRunning, ...media }: Readonly<{ view: ReadonlyHistoryView; trigger: HTMLButtonElement; agent: AgentSummary | undefined; nativeRunning: boolean }> & Media) {
  const snapshot = useSyncExternalStore(view.subscribe, view.getSnapshot, view.getServerSnapshot), [error, setError] = useState(''), mounted = useRef(false);
  useEffect(() => { mounted.current = true; try { const lease = view.observe(); return () => { mounted.current = false; lease.release(); }; } catch { setError('This captured scope is no longer current. Close and refresh observed agents.'); return () => { mounted.current = false; }; } }, [view]);
  const run = (work: () => Promise<unknown>) => { setError(''); void Promise.resolve().then(work).catch(() => { if (mounted.current) setError('This history read is unavailable. Loaded child rows are retained.'); }); };
  return h(Dialog.Content, { className: 'mpx-chat__dialog mpx-chat__child-dialog', 'aria-describedby': undefined, onCloseAutoFocus: event => { if (trigger.isConnected) { event.preventDefault(); trigger.focus(); } } },
    h(Dialog.Title, { asChild: true }, h('h3', null, `Agent history · ${scopeLabel(view.scope)}`)), h('p', { className: 'mpx-chat__muted' }, 'Read-only child history. This view has no native controls.'),
    agent ? h(AgentDetails, { agent }) : null,
    snapshot.kind === 'disposed' ? h('p', { role: 'status' }, 'Workspace closed') : h('div', { className: 'mpx-chat__child-body' },
      snapshot.kind === 'stale' ? h('p', { role: 'status' }, 'The native binding changed. Loaded history is retained; close and refresh observed agents.') : null,
      snapshot.observation === 'unavailable' || snapshot.observation === 'disconnected' ? h('p', { role: 'status' }, 'Child history connection interrupted. Loaded rows are retained.') : null,
      h(Transcript, { ...media, view, history: snapshot.history, run, nativeWorking: nativeRunning && agent?.status === 'running' && !agent.lastObserved, emptyLabel: 'No child transcript captured yet' })),
    error ? h('p', { role: 'status' }, error) : null, h('footer', { className: 'mpx-chat__panel-actions mpx-chat__dialog-actions' }, h(Dialog.Close, { asChild: true }, h(Button, { variant: 'outline', type: 'button' }, 'Close agent history'))));
}
