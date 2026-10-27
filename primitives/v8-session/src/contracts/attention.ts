import type { AttentionSignal, Harness, SessionAttention, SessionSnapshot } from "./types.js";
import { canonical, check, copy, id } from "./validation.js";

/** Closed, content-free native projection. Error messages, text and tool args
 * belong to native history, never to saved attention or a browser seen key. */
export function attentionSignal(value: unknown, kind: Harness): AttentionSignal {
  canonical(value, 2048);
  check(value && typeof value === "object" && !Array.isArray(value));
  const signal = value as AttentionSignal;
  check(Object.keys(signal).length === 2 && Object.keys(signal).every(key => ["state", "cause"].includes(key)));
  check(["working", "retrying", "background", "finished", "error", "interrupted", "unknown"].includes(signal.state));
  check(signal.cause && typeof signal.cause === "object" && !Array.isArray(signal.cause) && Object.keys(signal.cause).length === 2 && Object.keys(signal.cause).every(key => ["source", "id"].includes(key)));
  check(signal.cause.source === (kind === "codex" ? "codex.turn" : "copilot.event")); id(signal.cause.id);
  // Pinned Copilot's retryAttempt is evidence of a failed call, not a promise
  // of another attempt. That adapter currently has no positive retry signal.
  check(kind !== "copilot" || signal.state !== "retrying");
  return copy(signal);
}

/** A cold saved fact has provenance but no current native observation. */
export function savedAttention(value: unknown, kind: Harness): SessionAttention {
  canonical(value, 4096);
  check(value && typeof value === "object" && !Array.isArray(value));
  const attention = value as SessionAttention;
  check(Object.keys(attention).length === 6 && Object.keys(attention).every(key => ["state", "cause", "nativeSession", "generation", "epoch", "revision"].includes(key)));
  attentionSignal({ state: attention.state, cause: attention.cause }, kind);
  id(attention.nativeSession);
  check(Number.isSafeInteger(attention.generation) && attention.generation > 0);
  check(Number.isSafeInteger(attention.epoch) && attention.epoch > 0);
  check(Number.isSafeInteger(attention.revision) && attention.revision > 0);
  return copy(attention);
}

export function observedAttention(value: unknown, snapshot: Pick<SessionSnapshot, "kind" | "nativeSession" | "generation" | "epoch" | "revision">): SessionAttention {
  const attention = savedAttention(value, snapshot.kind);
  check(attention.nativeSession === snapshot.nativeSession && attention.generation <= snapshot.generation && attention.epoch <= snapshot.epoch);
  check(attention.epoch < snapshot.epoch || attention.revision <= snapshot.revision);
  return attention;
}

export function sameAttention(a: AttentionSignal, b: AttentionSignal): boolean {
  return a.state === b.state && a.cause.source === b.cause.source && a.cause.id === b.cause.id;
}
