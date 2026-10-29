import { cloneJson, canonicalJson, type Json } from "../../protocol/index.js";
export class CopilotError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CopilotError";
  }
}
export function check(value: unknown, code = "NATIVE_SHAPE"): asserts value {
  if (!value) throw new CopilotError(code);
}
export function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 256): string {
  check(typeof value === "string" && value.length > 0 && value.length <= max);
  return value;
}
export function json(value: unknown, max = 65536): Json {
  return cloneJson(value as Json, max);
}
export function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left as Json, 16384).json === canonicalJson(right as Json, 16384).json;
}
