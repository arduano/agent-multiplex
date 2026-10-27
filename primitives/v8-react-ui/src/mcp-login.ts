import { Button } from './ui/index.js';
import { createElement as h, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { AgentSnapshot } from '../../v8-workspace/src/contracts.js';
import type { McpLoginLink } from '../../v8-session/src/contracts/types.js';

type Ready = Extract<AgentSnapshot, { kind: 'codex' | 'copilot' }>;
type Flow = Readonly<{ key: string; originalId: string; trigger: HTMLElement; state: 'checking' | 'failed' | 'refused' | 'observed'; link?: McpLoginLink }>;

/** Only this mounted dialog retains the secret response. Originals stay with
 * SessionWorkspace. Closing/expiry never cancels or repeats native login. */
export function McpLogin({ snapshot, disabled, run }: Readonly<{ snapshot: Ready; disabled: boolean; run(work: () => Promise<unknown>): void }>) {
  const native = snapshot.session.native, key = JSON.stringify([native?.scope.connection, native?.scope.principal, native?.scope.host, snapshot.sessionId, snapshot.logical.entry?.scope.authority, snapshot.logical.entry?.target.owner, native?.epoch, native?.generation, native?.nativeSession]);
  const allowed = snapshot.access.read && snapshot.access.control && !!snapshot.actions.mcpLoginLink && !disabled;
  const [flow, setFlow] = useState<Flow | null>(null), sequence = useRef(0);
  const current = useRef({ key, allowed }); current.current = { key, allowed };
  const close = () => { sequence.current++; setFlow(null); };
  useEffect(() => { sequence.current++; setFlow(null); return () => { sequence.current++; }; }, [key, allowed]);
  const visible = allowed && flow?.key === key ? flow : null;
  useEffect(() => {
    const link = visible?.link; if (link?.state !== 'available') return;
    const timer = setTimeout(() => setFlow(value => value && value === visible ? { ...value, link: { state: 'unavailable', reason: 'displayExpired', status: 'initiated' } } : value), link.expiresInMs);
    return () => clearTimeout(timer);
  }, [visible]);
  const check = async (originalId: string, trigger: HTMLElement, token: number) => {
    try {
      const link = await snapshot.actions.mcpLoginLink!(originalId);
      if (sequence.current === token && current.current.key === key && current.current.allowed) setFlow({ key, originalId, trigger, state: 'observed', link });
    } catch {
      if (sequence.current === token && current.current.key === key && current.current.allowed) setFlow({ key, originalId, trigger, state: 'failed' });
    }
  };
  const inspect = (originalId: string, trigger: HTMLElement) => {
    if (!allowed || !snapshot.actions.mcpLoginLink) return;
    const token = ++sequence.current; setFlow({ key, originalId, trigger, state: 'checking' }); run(() => check(originalId, trigger, token));
  };
  const start = (serverName: string, trigger: HTMLElement, forceReauth = false) => {
    if (!allowed || !snapshot.actions.loginMcp || !snapshot.actions.mcpLoginLink) return;
    const operation = snapshot.kind === 'copilot' ? snapshot.actions.loginMcp(serverName, forceReauth) : snapshot.actions.loginMcp(serverName);
    const token = ++sequence.current; setFlow({ key, originalId: operation.id, trigger, state: 'checking' });
    run(async () => {
      try {
        const receipt = await operation.result;
        if (receipt.state === 'refused') { if (sequence.current === token && current.current.key === key) setFlow({ key, originalId: operation.id, trigger, state: 'refused' }); return; }
        await check(operation.id, trigger, token);
      } catch { if (sequence.current === token && current.current.key === key) setFlow({ key, originalId: operation.id, trigger, state: 'failed' }); }
    });
  };
  const originals = snapshot.operations.filter(operation => operation.generation === native?.generation && (operation.type === 'codex.mcp.login' || operation.type === 'copilot.mcp.login'));
  const servers = snapshot.mcp?.servers.filter(server => server.transport === 'http' || server.transport === 'sse') ?? [];
  const message = !visible || visible.state === 'checking' ? 'Checking this original sign-in action…' : visible.state === 'refused' ? 'Sign-in was not started. Another flow may still be owned, or this credential scope may be unsupported.' : visible.state === 'failed' ? 'This sign-in action could not be observed. Check the original action; no login was repeated.' : visible.link?.state === 'available' ? 'Sign-in was initiated. Complete it in your browser. Its callback runs on the agent Host, which your browser must be able to reach.' : visible.link?.status === 'succeeded' ? 'The native Host confirmed this exact sign-in completed.' : visible.link?.status === 'reused' ? 'The native Host reused valid credentials and reconnected the server.' : visible.link?.status === 'failed' ? 'The native Host reported that this exact sign-in failed.' : visible.link?.reason === 'displayExpired' ? 'This temporary link is no longer displayed. Expiry does not cancel native sign-in or repeat the request.' : 'No temporary link is retained for this original. A server connection alone does not prove this sign-in completed.';
  if (!snapshot.actions.loginMcp && !originals.length) return null;
  return h('div', { 'data-action': 'mcp-login-controls' },
    snapshot.actions.loginMcp ? servers.map((server, index) => h('div', { key: server.name },
      h(Button, { variant: 'ghost', 'data-action': `login-mcp-${index}`, disabled: !allowed || snapshot.mcpStale || server.canAuthenticate !== true, onClick: event => start(server.name, event.currentTarget) }, `Sign in to ${server.name}`),
      snapshot.kind === 'copilot' ? h(Button, { variant: 'ghost', 'data-action': `reauth-mcp-${index}`, disabled: !allowed || snapshot.mcpStale || server.canAuthenticate !== true, onClick: event => start(server.name, event.currentTarget, true) }, `Sign in again to ${server.name}`) : null)) : null,
    ...originals.map((operation, index) => h(Button, { variant: 'ghost', key: operation.id, disabled: !allowed, onClick: event => inspect(operation.id, event.currentTarget) }, `Check sign-in action ${index + 1}`)),
    h(Dialog.Root, { open: !!visible, onOpenChange: next => { if (!next) close(); } }, visible ? h(Dialog.Portal, { container: visible.trigger.closest<HTMLElement>('.multiplex-chat') }, h(Dialog.Overlay, { className: 'mpx-chat__overlay' }),
      h(Dialog.Content, { className: 'mpx-chat__dialog', onCloseAutoFocus: event => { if (visible.trigger.isConnected) { event.preventDefault(); visible.trigger.focus(); } } },
        h(Dialog.Title, null, 'MCP sign-in'), h(Dialog.Description, null, message),
        visible.link?.state === 'available' ? h('a', { href: visible.link.authorizationUrl, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, 'Open sign-in page') : null,
        h('footer', { className: 'mpx-chat__panel-actions mpx-chat__dialog-actions' },
          h(Button, { variant: 'outline', disabled: visible.state === 'checking', onClick: () => inspect(visible.originalId, visible.trigger) }, 'Check this sign-in action'),
          h(Dialog.Close, { asChild: true }, h(Button, { variant: 'ghost', type: 'button' }, 'Close sign-in'))))) : null));
}
