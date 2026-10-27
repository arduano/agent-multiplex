import { SessionError, type Json, type SessionScope } from "./types.js";
export function check(value: unknown, message = "Invalid session input"): asserts value { if (!value) throw new SessionError("INVALID", message); }
export function id(value: unknown): asserts value is string { check(typeof value === "string" && value.length > 0 && value.length <= 256); }
export function scope(value: SessionScope): void { check(value && typeof value === "object"); for (const field of [value.connection, value.principal, value.host, value.session]) id(field); }
export function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
export function copy<T>(value: T): T { return frozen(structuredClone(value)); }
export function canonical(value: unknown, maxBytes = 16384): string {
  let visited = 0;
  function visit(v: unknown, depth: number): Json {
    check(++visited < 8192 && depth < 24);
    if (v === null || typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "number") { check(Number.isFinite(v)); return v; }
    if (Array.isArray(v)) return v.map(child => visit(child, depth + 1));
    check(v && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null));
    return Object.fromEntries(Object.keys(v).sort().map(key => [key, visit((v as Record<string, unknown>)[key], depth + 1)]));
  }
  const result = JSON.stringify(visit(value, 0)); check(new TextEncoder().encode(result).length <= maxBytes); return result;
}
