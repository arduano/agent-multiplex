import { createElement as h } from 'react';
import type { AgentSnapshot } from '../../v8-workspace/src/contracts.js';

type Ready = Extract<AgentSnapshot, { kind: 'codex' | 'copilot' }>;
/** Native lifetime, work and observation are separate facts, presented once. */
export function sessionStatus(snapshot: Ready): string {
  const native = snapshot.session.native;
  const stale = !snapshot.session.connected || snapshot.session.stale;
  if (!native) return 'Agent state not observed';
  const suffix = stale ? ' · last observed' : '';
  if (native.phase === 'stopped') return `Agent stopped${suffix}`;
  if (native.phase === 'stopping' || native.stopRequested) return `Stopping agent · not yet proved stopped${suffix}`;
  if (native.phase === 'starting') return `Starting agent${suffix}`;
  const attention = native.attention;
  const state = attention?.generation === native.generation && attention.nativeSession === native.nativeSession && attention.epoch === native.epoch ? attention.state : undefined;
  const work = native.activity === 'working' ? 'Working' : native.activity === 'waiting' ? 'Waiting for input' : state === 'finished' ? 'Turn finished' : state === 'error' ? 'Turn failed' : state === 'interrupted' ? 'Turn interrupted' : state === 'retrying' ? 'Retrying' : state === 'background' ? 'Background work observed' : native.activity === 'idle' ? 'Ready' : 'Activity not reported';
  return `${work} · agent running${suffix}`;
}
export function SessionStatus({ snapshot }: Readonly<{ snapshot: Ready }>) {
  const connection = !snapshot.session.connected ? 'Disconnected' : snapshot.observation.session === 'live' ? 'Connected' : snapshot.observation.session === 'unavailable' ? 'Connection interrupted' : 'Connecting';
  return h('div', { className: 'mpx-chat__status', role: 'status', 'data-action': 'session-status' }, h('span', null, sessionStatus(snapshot)), h('span', { className: 'mpx-chat__connection' }, connection));
}
