import { createHash } from "node:crypto";
import { canonicalProtocolRecordJson } from "@arduano/agent-multiplex-protocol";
import type { JsonValue } from "./protocol.js";

export function canonicalJson(input: unknown): string {
  const value = JSON.parse(canonicalProtocolRecordJson(input)) as JsonValue;
  const normalize = (v: JsonValue): JsonValue => Array.isArray(v) ? v.map(normalize)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize(v[k]!)])) : v;
  return JSON.stringify(normalize(value));
}
export function requestHash(input: unknown): string { return createHash("sha256").update(canonicalJson(input)).digest("hex"); }
