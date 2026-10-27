import { createElement as h, useEffect, useRef, useState } from 'react';
import type { WorkspaceView } from '../../v8-workspace/src/contracts.js';
import type { ViewSnapshot } from '../../v8-history/src/client/history-client.js';
import type { HistoryRecovery } from '../../v8-history/src/acquisition/types.js';
import { scopeKey } from '../../v8-history/src/contracts/identity.js';
import { Button } from './ui/index.js';

type HistoryView = Pick<WorkspaceView, 'loadOlder' | 'recoverHistory'>;
type Action = 'older' | 'recover';
type Wait = { view: HistoryView; context: string; pending: boolean };
type Observation = Readonly<{ wait: Wait; action: Action; pending: boolean; message: string; failed: boolean }>;

export const historyBoundaryKey = (history: ViewSnapshot): string => JSON.stringify([
  history.current ? scopeKey(history.current.scope) : null, history.current?.generation, history.current?.readContext, history.olderEdge,
]);

export function historyRecoveryMessage(result: HistoryRecovery): string {
  if (result.state === 'value') {
    switch (result.value.status) {
      case 'ready': return 'The Host published the available earlier-history boundary.';
      case 'unsupported': return 'This Host cannot read missing history here. Captured messages are retained.';
      case 'expired': return 'This native history reference expired. Captured messages are retained.';
      case 'stale': return 'The history binding changed during this read. Captured messages are retained.';
    }
  }
  switch (result.state) {
    case 'waitingExpired': return 'The wait ended while the Host still owns the history read. Captured messages are retained.';
    case 'healed': return 'The history gap healed on the retained stream.';
    case 'retired': return 'This history check belongs to a retired binding. Captured messages are retained.';
    case 'failed': return 'Earlier history could not be loaded. Loaded messages are retained.';
  }
}

/** Only the explicit wait belongs to this component. Dismissal, scope changes
 * and unmount never cancel or repeat a Host-owned history acquisition. */
export function HistoryBoundary({ view, history, archived = false, beforeRead }: Readonly<{ view: HistoryView; history: ViewSnapshot; archived?: boolean; beforeRead?(): void }>) {
  const context = historyBoundaryKey(history), owner = useRef<Wait | null>(null);
  const [observation, setObservation] = useState<Observation | null>(null);
  useEffect(() => {
    const wait = { view, context, pending: false }; owner.current = wait;
    return () => { if (owner.current === wait) owner.current = null; };
  }, [view, context]);
  const current = observation?.wait.view === view && observation.wait.context === context ? observation : null;
  const retained = history.current?.read;
  const matching = retained?.state === 'settled' && (retained.target.kind !== 'older' || history.olderEdge.state === 'available' && retained.target.cursor === history.olderEdge.cursor) ? retained : null;
  const actualPending = retained?.state === 'pending';
  const pending = actualPending || !!current?.pending || history.viewport.loadingOlder;
  const retryToken = matching?.retryToken;
  const action: Action = retryToken ? matching!.target.kind === 'older' ? 'older' : 'recover'
    : history.viewport.loadingOlder || retained?.state === 'pending' && retained.target.kind === 'older' ? 'older'
    : current?.pending ? current.action : history.olderEdge.state === 'available' ? 'older' : 'recover';
  const terminal = !!matching && ['failed', 'expired', 'unsupported'].includes(matching.outcome);
  const message = matching?.outcome === 'failed' ? 'Earlier history could not be loaded. Loaded messages are retained.'
    : matching?.outcome === 'expired' ? 'This native history reference expired. Captured messages are retained.'
    : matching?.outcome === 'unsupported' ? 'This Host cannot read missing history here. Captured messages are retained.' : current?.message;
  const read = () => {
    const wait = owner.current;
    if (archived || !wait || wait.view !== view || wait.context !== context || pending || terminal && !retryToken) return;
    beforeRead?.();
    wait.pending = true; setObservation({ wait, action, pending: true, message: '', failed: false });
    const settle = (message: string, failed = false) => { if (owner.current === wait) setObservation({ wait, action, pending: false, message, failed }); };
    void Promise.resolve().then(async () => {
      if (action === 'recover') { const result = await view.recoverHistory({}, retryToken); return { message: historyRecoveryMessage(result), failed: result.state === 'failed' }; }
      const result = await view.loadOlder(retryToken);
      return { failed: false, message: result === 'stale' ? 'This earlier-history read no longer matches the view. Captured messages are retained.'
        : result === 'needsSnapshot' ? 'This earlier page could not be merged. Captured messages are retained.' : '' };
    }).then(result => settle(result.message, result.failed), () => settle('Earlier history could not be loaded. Loaded messages are retained.')).finally(() => { wait.pending = false; });
  };
  if (archived) return null;
  return h('div', { className: 'mpx-chat__history-boundary-content', 'data-read-state': retained?.state ?? 'idle' },
    !pending && history.olderEdge.state === 'end' ? h('p', { className: 'mpx-chat__muted' }, 'Start of available history')
      : terminal && !retryToken || current?.failed && (!retained || retained.state === 'idle') ? null : h(Button, { type: 'button', variant: 'ghost', className: 'mpx-chat__older', disabled: pending, onClick: read },
        pending ? actualPending && retained.target.kind === 'initial' ? 'Loading history…' : action === 'older' ? 'Loading earlier history…' : 'Checking earlier history…'
          : retryToken ? 'Retry loading history' : action === 'older' ? 'Load earlier history' : 'Check earlier history'),
    message ? h('p', { role: 'status' }, message) : null);
}
