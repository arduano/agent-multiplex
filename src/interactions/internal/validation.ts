import {
  canonicalJson,
  scopeKey,
  type Json,
  type Original,
  type RunRef,
} from "../../protocol/index.js";

export class InteractionError extends Error {
  constructor(readonly code: "INVALID" | "FENCED" | "CONFLICT" | "FULL" | "UNSUPPORTED") {
    super(code);
    this.name = "InteractionError";
  }
}
export function check(value: unknown, code: InteractionError["code"] = "INVALID"): asserts value {
  if (!value) throw new InteractionError(code);
}
export function text(value: unknown, maximum = 16384): asserts value is string {
  check(typeof value === "string" && value.length <= maximum && !value.includes("\0"));
}
export function id(value: unknown): asserts value is string {
  text(value, 256);
  check(value.length > 0 && !/[\x00-\x1f\x7f]/.test(value));
}
export function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  check(Object.keys(value).every((key) => allowed.includes(key)));
}
export function strings(value: unknown, maximum = 32): asserts value is readonly string[] {
  check(Array.isArray(value) && value.length <= maximum);
  value.forEach((item) => text(item, 4096));
  check(new Set(value).size === value.length);
}
export function json(value: unknown, maximum = 65536): string {
  try {
    return canonicalJson(value as Json, maximum).json;
  } catch {
    throw new InteractionError("INVALID");
  }
}
export function frozen<T>(value: T): T {
  const result = JSON.parse(json(value)) as T;
  function freeze(current: unknown): void {
    if (current && typeof current === "object") {
      Object.values(current).forEach(freeze);
      Object.freeze(current);
    }
  }
  freeze(result);
  return result;
}
export function runKey(run: RunRef): string {
  json(run);
  const value = object(run);
  keys(value, ["scope", "generation", "nativeSession"]);
  keys(object(run.scope), ["connection", "principal", "host", "session"]);
  id(run.nativeSession);
  check(Number.isSafeInteger(run.generation) && run.generation > 0);
  return JSON.stringify([scopeKey(run.scope), run.generation, run.nativeSession]);
}
export function binding(
  run: RunRef,
  attachment: string,
  expectedRun: RunRef,
  expectedAttachment: string,
): void {
  id(attachment);
  check(attachment === expectedAttachment && runKey(run) === runKey(expectedRun), "FENCED");
}
export function original(value: Original, run: RunRef): void {
  json(value);
  const v = object(value);
  keys(v, ["scope", "id", "requestHash"]);
  keys(object(value.scope), ["connection", "principal", "host", "session"]);
  id(value.id);
  check(typeof value.requestHash === "string" && /^[a-f0-9]{64}$/.test(value.requestHash));
  check(scopeKey(value.scope) === scopeKey(run.scope), "FENCED");
}
export function originalKey(value: Original): string {
  return JSON.stringify([scopeKey(value.scope), value.id]);
}
export function delivery(value: unknown): asserts value is import("../contracts.js").Delivery {
  const v = object(value);
  if (v.kind === "submitted") keys(v, ["kind"]);
  else {
    keys(v, ["kind", "accepted"]);
    check(v.kind === "confirmed" && typeof v.accepted === "boolean");
  }
}
export function observe<T>(
  work: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T | Readonly<{ state: "waitingExpired" }>> {
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 30000);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Observation cancelled", "AbortError"));
      return;
    }
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      fn();
    };
    const abort = () =>
      finish(() => reject(new DOMException("Observation cancelled", "AbortError")));
    const timer = setTimeout(() => finish(() => resolve({ state: "waitingExpired" })), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    void work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
