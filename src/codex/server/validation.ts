import { canonicalJson, cloneJson, type Json } from "../../protocol/index.js";
export class CodexError extends Error {
  constructor(readonly code: string) {
    super(`Codex ${code}`);
    this.name = "CodexError";
  }
}
export function check(value: unknown, code = "INVALID_NATIVE_DATA"): asserts value {
  if (!value) throw new CodexError(code);
}
export function object(value: unknown): Record<string, unknown> {
  check(!!value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
export function text(value: unknown, maximum = 256): string {
  check(
    typeof value === "string" &&
      !!value.length &&
      value.length <= maximum &&
      !/[\u0000-\u001f\u007f]/.test(value),
  );
  return value;
}
export function body(value: unknown, maximum = 65536): string {
  check(typeof value === "string" && Buffer.byteLength(value) <= maximum, "BODY_BOUND");
  return value;
}
export function json(value: unknown, maximum = 262144): Json {
  canonicalJson(value as Json, maximum);
  return cloneJson(value as Json, maximum);
}
export function equal(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJson(left as Json, 262144).json === canonicalJson(right as Json, 262144).json;
}
