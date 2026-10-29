import {
  canonicalJson,
  cloneJson,
  scopeKey,
  type Json,
  type SessionScope,
} from "../protocol/index.js";

export class RuntimeError extends Error {
  constructor(
    readonly code: "FENCED" | "BUSY" | "UNSUPPORTED",
    message = "Native ownership is not established",
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}
export function requireThat(
  value: unknown,
  message = "Invalid runtime ownership evidence",
): asserts value {
  if (!value) throw new RuntimeError("FENCED", message);
}
export function canonical(value: unknown, maxBytes = 1_048_576): string {
  return canonicalJson(value as Json, maxBytes).json;
}
export function copy<T>(value: T): T {
  return cloneJson(value as Json, 1_048_576) as T;
}
export function id(value: unknown): asserts value is string {
  requireThat(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 256 &&
      !/[\x00-\x1f\x7f]/.test(value),
  );
}
export function scope(value: SessionScope): void {
  scopeKey(value);
}
