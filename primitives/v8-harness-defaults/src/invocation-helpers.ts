import type { Json } from "../../v8-session/src/contracts/types.js";
import { check } from "../../v8-session/src/contracts/validation.js";
import { validateOutcome } from "../../v8-session/src/native/validation.js";
export function json(value: unknown): Json {
  // Reuse the strict validated-detail path, including accessor/size checks.
  return validateOutcome({ status: "acknowledged", detail: value }).detail!;
}
export function obj(value: unknown): Record<string, Json> {
  const v = json(value); check(v && typeof v === "object" && !Array.isArray(v)); return v as Record<string, Json>;
}
export function optionalString(value: Record<string, Json>, key: string): void { if (value[key] !== undefined) check(typeof value[key] === "string" && (value[key] as string).length <= 4096); }
export function optionalBoolean(value: Record<string, Json>, key: string): void { if (value[key] !== undefined) check(typeof value[key] === "boolean"); }
