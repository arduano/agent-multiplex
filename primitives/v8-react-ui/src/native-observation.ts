import { createElement as h } from 'react';
import type { AgentSnapshot } from '../../v8-workspace/src/contracts.js';
import type { NativeRead } from '../../v8-session/src/contracts/types.js';
import type { NativeReadObservation } from '../../v8-session/src/client/workspace.js';

export type NativeSnapshot<K extends 'codex' | 'copilot'> = Extract<AgentSnapshot, { kind: K }>;
export type RunNativeAction = (work: () => Promise<unknown>) => void;
export const nativeObservation = (snapshot: NativeSnapshot<'codex' | 'copilot'>, type: NativeRead['type']) => snapshot.session.nativeReads.find(item => item.request.type === type);
export const currentObservation = (item: NativeReadObservation | undefined): boolean => item?.state === 'available' && !item.stale;

/** Retained facts remain visible through refresh/disconnection. Presentation
 * does not turn them into current native state or run another query. */
export function NativeObservation({ item, action }: Readonly<{ item: NativeReadObservation | undefined; action: string }>) {
  const state = !item ? 'Not checked' : item.state === 'loading' ? 'Checking…' : item.state === 'unavailable' ? 'Could not refresh' : 'Checked';
  return h('p', { 'data-action': action, role: 'status' }, `${state}${item?.stale ? ' · last observation may be out of date' : ''}`);
}
