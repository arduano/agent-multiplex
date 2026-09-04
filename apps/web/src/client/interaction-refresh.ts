/**
 * Control events are the fast path; this selected-session poll is the bounded
 * recovery path when an observer attaches too late or misses one event.
 */
export const pendingInteractionRefreshIntervalMs = 5_000;

export function pendingInteractionRefetchInterval(
  sessionId: string | null | undefined,
): number | false {
  return sessionId ? pendingInteractionRefreshIntervalMs : false;
}
