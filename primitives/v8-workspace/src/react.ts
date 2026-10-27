import { useEffect, useSyncExternalStore } from 'react';
import type { AgentSnapshot, WorkspaceView } from './contracts.js';
/** Prepared view supplied by workspace owner; render and SSR never allocate/bind/observe. */
export function useAgent(view: WorkspaceView): AgentSnapshot {
  const snapshot = useSyncExternalStore(view.subscribe, view.getSnapshot, view.getServerSnapshot);
  useEffect(() => { if (view.getSnapshot().kind === 'disposed') return; const lease = view.observe(); return () => lease.release(); }, [view]);
  return snapshot;
}
