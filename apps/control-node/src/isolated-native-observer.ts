/** Observer budget for durable native mutations across the authority's IPC hops.
 * The platform is owned by the remote Runtime, not known to this Control. A
 * Windows lifecycle can sequentially start the SDK (180s), detach (60s), attach
 * (120s), apply mode (60s) and hydrate (60s); Recover adds a Stop phase. Ten
 * minutes admits that bounded pipeline without turning a short storage observer
 * deadline into dispatch uncertainty. Expiry retains the original RPC slot and
 * durable operation identity; it never cancels or retries the native mutation.
 * Catalog, health, enrollment, receipt reads and other storage calls retain the
 * ordinary IsolatedRpc budget. Transport/authentication limits are unchanged. */
export const ISOLATED_NATIVE_MUTATION_OBSERVER_MS = 600_000;

const nativeMutations = new Set([
  "createLaunch", "resume", "recover", "stop", "archive", "execute",
  "access.launches.create", "access.sessions.resume", "access.sessions.recover",
  "access.sessions.stop", "access.sessions.archive", "access.sessions.execute",
  "link.launches.create", "link.sessions.resume", "link.sessions.recover",
  "link.sessions.stop", "link.sessions.archive", "link.commands.execute",
]);
const nativeObserver = Object.freeze({ timeoutMs: ISOLATED_NATIVE_MUTATION_OBSERVER_MS });
const ordinaryObserver = Object.freeze({});

export function isolatedNativeObserver(operation: string): { readonly timeoutMs?: number } {
  return nativeMutations.has(operation) ? nativeObserver : ordinaryObserver;
}
