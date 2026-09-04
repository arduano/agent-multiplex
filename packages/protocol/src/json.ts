import { z } from "zod";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const jsonPrimitiveSchema = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
]);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    jsonPrimitiveSchema,
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  jsonValueSchema,
);

/** Deterministic JSON encoding suitable for command payload comparison. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const members = Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
  return `{${members.join(",")}}`;
}

/**
 * Canonicalize a typed protocol record after applying the same object-member
 * semantics as JSON serialization. SuperJSON deliberately preserves own
 * optional properties whose value is `undefined`, while an equivalent record
 * loaded from SQLite does not contain those properties. Protocol record
 * equality must therefore ignore `undefined` object members.
 *
 * This is intentionally narrower than JSON.stringify: top-level `undefined`
 * and `undefined` array elements remain invalid instead of becoming absent or
 * `null`. Non-plain objects are also left for jsonValueSchema to reject.
 */
export function canonicalProtocolRecordJson(value: unknown): string {
  return canonicalJson(jsonValueSchema.parse(omitUndefinedObjectMembers(value)));
}

function omitUndefinedObjectMembers(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((member) => omitUndefinedObjectMembers(member));
  }
  if (value === null || typeof value !== "object") return value;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const result: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (member === undefined) continue;
    result[key] = omitUndefinedObjectMembers(member);
  }
  return result;
}

export function toJsonValue(value: unknown): JsonValue {
  return jsonValueSchema.parse(value);
}
