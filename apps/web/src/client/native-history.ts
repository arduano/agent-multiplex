import type { Harness, JsonValue, SessionRecord } from "@arduano/agent-multiplex-protocol";

interface SessionBindingIdentityInput {
  readonly sessionId: string;
  readonly bindingRevision: number;
  readonly runtimeEpoch: string | null;
  readonly runtimeNodeId: string;
  readonly harness: Harness;
  readonly adapterScopeId: string;
  readonly vendorSessionId: string;
}

interface NativeHistoryReadinessInput {
  readonly harness: Harness;
  readonly nativeSummary?: JsonValue | undefined;
}

export interface NativeHistorySignal {
  readonly bindingIdentity: string;
  readonly generation: number;
  readonly ready: boolean;
}

export type NativeHistorySignalCause = "lifecycle" | "reconcile";

/**
 * Identifies the native routing binding, not merely the logical session. A
 * logical session can be rebound or restarted while retaining its session ID.
 */
export function sessionBindingIdentity(session: SessionBindingIdentityInput): string {
  return JSON.stringify([
    session.sessionId,
    session.bindingRevision,
    session.runtimeEpoch,
    session.runtimeNodeId,
    session.harness,
    session.adapterScopeId,
    session.vendorSessionId,
  ]);
}

/**
 * Copilot can read an empty session. A newly started Codex thread cannot be
 * read reliably until inventory has observed it or a native lifecycle event
 * proves that its first turn has reached a history boundary.
 */
export function nativeHistoryInitiallyReady(session: NativeHistoryReadinessInput): boolean {
  return session.harness !== "codex" || session.nativeSummary != null;
}

/**
 * Requests a history reconciliation without allowing generic stream recovery
 * signals to bypass the fresh-Codex readiness gate.
 */
export function advanceNativeHistorySignal(
  current: NativeHistorySignal | null,
  bindingIdentity: string,
  initiallyReady: boolean,
  cause: NativeHistorySignalCause,
): NativeHistorySignal | null {
  const sameBinding = current?.bindingIdentity === bindingIdentity;
  const ready = cause === "lifecycle" || initiallyReady || (sameBinding && current.ready);
  if (!ready) return sameBinding ? current : null;
  return {
    bindingIdentity,
    generation: (sameBinding ? current.generation : 0) + 1,
    ready: true,
  };
}

// A runtime renews its retained p2prpc connection on its next operation. The
// default runtime heartbeat is ten seconds, so the retry window must span one
// heartbeat interval even though a usual renewal finishes on the first retry.
const defaultRetryDelaysMs = [250, 750, 1_500, 3_000, 6_000] as const;

const retryableErrorCodes = new Set([
  // Browser-visible tRPC codes.
  "SERVICE_UNAVAILABLE",
  "TIMEOUT",
  "TOO_MANY_REQUESTS",
  // Transport/source codes retained by in-process clients and tests.
  "DISCONNECTED",
  "UNAVAILABLE",
]);

interface RetryNativeHistoryOptions {
  /** Delays after successive failures; their count bounds retries. */
  readonly retryDelaysMs?: readonly number[];
  /** Prevents another request after the component/binding has been retired. */
  readonly active?: () => boolean;
  /** Injectable for deterministic unit tests. */
  readonly wait?: (delayMs: number) => Promise<void>;
}

/**
 * Returns true only for an explicit temporary server or transport result.
 * Unknown failures and permanent tRPC results (including auth failures) stay
 * fail-fast; error-message text is deliberately never used for classification.
 */
export function isRetryableNativeHistoryError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;

  for (let depth = 0; depth < 8 && isObject(current); depth += 1) {
    if (visited.has(current)) return false;
    visited.add(current);

    // TRPCClientError exposes the authoritative remote code in `data.code`.
    // Prefer it to a nested transport cause so, for example, UNAUTHORIZED can
    // never become retryable because one of its implementation causes closed.
    const dataCode = nestedString(current, "data", "code") ??
      nestedString(current, "shape", "data", "code");
    if (dataCode !== undefined) return retryableErrorCodes.has(dataCode);

    const code = safeStringProperty(current, "code");
    if (code !== undefined) return retryableErrorCodes.has(code);

    current = safeProperty(current, "cause");
  }

  return false;
}

/** A bounded, read-only retry window, invoked only after positive readiness. */
export async function retryNativeHistory<T>(
  read: () => Promise<T>,
  options: RetryNativeHistoryOptions = {},
): Promise<T> {
  const retryDelaysMs = options.retryDelaysMs ?? defaultRetryDelaysMs;
  const active = options.active ?? (() => true);
  const wait = options.wait ?? delay;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      if (
        attempt === retryDelaysMs.length ||
        !active() ||
        !isRetryableNativeHistoryError(error)
      ) throw error;
      await wait(retryDelaysMs[attempt]!);
      if (!active()) throw error;
    }
  }

  // The loop always returns or throws. This keeps the invariant explicit if
  // its bounds are edited later.
  throw lastError;
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function safeProperty(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function safeStringProperty(value: object, key: string): string | undefined {
  const property = safeProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

function nestedString(value: object, ...path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = safeProperty(current, key);
  }
  return typeof current === "string" ? current : undefined;
}

// Compile-time assertion that the protocol record remains accepted by the
// deliberately narrower helpers above.
const _sessionCompatibility: (session: SessionRecord) => string = sessionBindingIdentity;
void _sessionCompatibility;
