import type { Json } from "./index.js";

/** Stable data encoding, without invoking getters, toJSON or user behavior. */
export function canonicalJson(value: Json, maxBytes: number): { json: string; bytes: number } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RangeError("Invalid JSON byte limit");
  const encoder = new TextEncoder();
  const active = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  function token(text: string): string {
    bytes += encoder.encode(text).byteLength;
    if (bytes > maxBytes) throw new RangeError("JSON exceeds byte limit");
    return text;
  }
  function visit(input: unknown, depth: number): string {
    if (++nodes > 100_000 || depth > 32) throw new RangeError("JSON exceeds structural limit");
    if (input === null || typeof input === "boolean" || typeof input === "string")
      return token(JSON.stringify(input));
    if (typeof input === "number" && Number.isFinite(input)) return token(JSON.stringify(input));
    if (typeof input !== "object" || input === null || active.has(input))
      throw new TypeError("Invalid JSON data");
    if (Object.getOwnPropertySymbols(input).length) throw new TypeError("Invalid JSON properties");
    active.add(input);
    let parts: string[];
    let text: string;
    if (Array.isArray(input)) {
      if (
        Object.keys(input).length !== input.length ||
        Object.getOwnPropertyNames(input).length !== input.length + 1
      )
        throw new TypeError("Invalid JSON array");
      parts = Array.from({ length: input.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, index);
        if (!descriptor || !("value" in descriptor)) throw new TypeError("Invalid JSON array");
        return visit(descriptor.value, depth + 1);
      });
      text =
        token("[") +
        parts.map((part, index) => (index ? token(",") : "") + part).join("") +
        token("]");
    } else {
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError("Invalid JSON object");
      if (Object.getOwnPropertyNames(input).length !== Object.keys(input).length)
        throw new TypeError("Invalid JSON properties");
      parts = Object.keys(input)
        .sort()
        .map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
          if (!("value" in descriptor)) throw new TypeError("Invalid JSON property");
          return token(JSON.stringify(key)) + token(":") + visit(descriptor.value, depth + 1);
        });
      text =
        token("{") +
        parts.map((part, index) => (index ? token(",") : "") + part).join("") +
        token("}");
    }
    active.delete(input);
    return text;
  }
  return { json: visit(value, 0), bytes };
}

export function cloneJson(value: Json, maxBytes: number): Json {
  return JSON.parse(canonicalJson(value, maxBytes).json) as Json;
}
