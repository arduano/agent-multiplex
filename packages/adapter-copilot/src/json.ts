import { toJsonValue, type JsonValue } from "@arduano/agent-multiplex-protocol";

/**
 * Copilot SDK values originate on a JSON-RPC connection, but some convenience
 * APIs (notably session metadata) add Dates after decoding. Round-tripping here
 * gives the wire protocol a strict JSON value while retaining every native
 * event field that JSON can represent.
 */
export function copilotJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return null;
  return toJsonValue(JSON.parse(encoded) as unknown);
}
export function jsonRecord(value: JsonValue, description: string): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${description} must be a JSON object`);
  }
  return value;
}

export function requiredString(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
  description: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${description}.${key} must be a non-empty string`);
  }
  return value;
}
