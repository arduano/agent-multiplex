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

const wireTextEncoder = new TextEncoder();

/**
 * Conservative byte bound for both JSON and plain MessagePack, including the
 * transport's preflight estimate. Numbers reserve at least float64's nine
 * bytes, strings/containers reserve five-byte headers, and JSON punctuation
 * and escaping are also counted. Taking the larger bound at every value keeps
 * mixed numeric/text payloads safe without depending on a transport encoder.
 * Every value/map key reserves at least 16 bytes as well: two 960 KiB
 * envelopes then contain at most 122,880 values, leaving room below the
 * transport's 131,072-value limit for their enclosing record/event/RPC.
 *
 * Call on validated plain protocol data. Own undefined object properties have
 * the same omission semantics as canonicalProtocolRecordJson; undefined array
 * entries and other non-JSON values remain invalid.
 */
export function jsonWireByteUpperBound(value: unknown): number {
  if (value === null || typeof value === "boolean") return 16;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(16, JSON.stringify(value).length);
  }
  if (typeof value === "string") {
    return Math.max(
      16,
      wireTextEncoder.encode(value).byteLength + 6,
      wireTextEncoder.encode(JSON.stringify(value)).byteLength,
    );
  }
  if (Array.isArray(value)) {
    // One byte per member covers JSON commas (including a spare final comma).
    return 16 + value.reduce((bytes, member) => bytes + 1 + jsonWireByteUpperBound(member), 0);
  }
  if (typeof value === "object" && value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    let bytes = 16;
    for (const [key, member] of Object.entries(value)) {
      if (member !== undefined) bytes += jsonWireByteUpperBound(key) + 2 + jsonWireByteUpperBound(member);
    }
    return bytes;
  }
  throw new TypeError("Wire byte bounds require plain JSON protocol data");
}

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
