import { sameRun, type Catalog, type Interaction, type NativeOutcome, type RunRef, type StopProof } from "../contracts/types.js";
import { canonical, check, frozen, id } from "../contracts/validation.js";
type Obj = Record<string, unknown>;
export function safe(value: unknown, active = new Set<object>(), depth = 0, budget = { nodes: 0, units: 0 }): void {
  check(depth < 24 && ++budget.nodes <= 8192);
  if (typeof value === "string") { budget.units += value.length; check(budget.units <= 65536); return; }
  if (value === null || ["boolean", "number"].includes(typeof value)) { if (typeof value === "number") check(Number.isFinite(value)); return; }
  check(value && typeof value === "object" && !active.has(value));
  check(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const keys = Object.keys(value); check(keys.length <= 512); active.add(value);
  if (Array.isArray(value)) check(keys.length === value.length && keys.every((key, index) => key === String(index)));
  for (const key of keys) { budget.units += key.length; check(budget.units <= 65536 && !["__proto__", "constructor", "prototype"].includes(key)); const d = Object.getOwnPropertyDescriptor(value, key)!; check("value" in d); safe(d.value, active, depth + 1, budget); }
  active.delete(value);
}
export function materialize(value: unknown): unknown { safe(value); return JSON.parse(canonical(value)); }
export function nativeStateData(value: unknown): unknown { safe(value); return JSON.parse(canonical(value, 65536)); }
export function object(value: unknown, allowed: readonly string[]): Obj {
  check(value && typeof value === "object" && !Array.isArray(value));
  const result = value as Obj; check(Object.keys(result).every(key => allowed.includes(key))); return result;
}
export function text(value: unknown, maximum = 256, empty = false): asserts value is string {
  check(typeof value === "string" && value.length <= maximum && (empty || value.trim().length > 0) && !/[\u0000\u000b\u000c\u007f]/.test(value));
}
export function identity(value: unknown): asserts value is string { id(value); check(!/[\u0000-\u001f\u007f]/.test(value)); }
export function validateOutcome(value: unknown): NativeOutcome {
  const v = object(materialize(value), ["status", "detail"]);
  check(["accepted", "applied", "deferred", "refused", "targetUnavailable", "confirmationRequired", "acknowledged"].includes(String(v.status)));
  return frozen(v) as NativeOutcome;
}
export function run(value: unknown): RunRef {
  const v = object(value, ["scope", "generation", "nativeSession"]), s = object(v.scope, ["connection", "principal", "host", "session"]);
  for (const key of ["connection", "principal", "host", "session"]) identity(s[key]); identity(v.nativeSession);
  check(Number.isSafeInteger(v.generation) && (v.generation as number) >= 1); return frozen(v) as RunRef;
}
export function validateRun(value: unknown): RunRef { return run(materialize(value)); }
export function validateStopProof(expectedRun: RunRef, value: unknown): StopProof {
  const expected = validateRun(expectedRun), v = object(materialize(value), ["run", "state", "scope", "noAutomaticContinuation"]);
  const actual = run(v.run); check(sameRun(expected, actual), "Foreign native stop proof");
  check(v.state === "stopped" && v.scope === "nativeTree" && v.noAutomaticContinuation === true, "Incomplete native stop proof");
  return frozen(v) as StopProof;
}
export function validateInteractions(value: unknown): readonly Interaction[] {
  const values = materialize(value); check(Array.isArray(values) && values.length <= 64); const ids = new Set<string>();
  for (const raw of values) {
    const v = object(raw, ["id", "owner", "kind", "choices", "blocking"]); identity(v.id); identity(v.owner); check(v.blocking === undefined || typeof v.blocking === "boolean");
    check(!ids.has(v.id)); ids.add(v.id);
    check(["approval", "permission", "userInput", "elicitation", "exitPlan"].includes(String(v.kind)));
    check(Array.isArray(v.choices) && v.choices.length > 0 && v.choices.length <= 32);
    for (const choice of v.choices) identity(choice); check(new Set(v.choices).size === v.choices.length);
  }
  return frozen(values) as readonly Interaction[];
}
export function validateCatalog(value: unknown): Catalog {
  const v = object(materialize(value), ["available", "choices"]); check(typeof v.available === "boolean"); check(Array.isArray(v.choices) && v.choices.length <= 128);
  const known = new Set<string>();
  for (const raw of v.choices) {
    const c = object(raw, ["model", "providerId", "efforts", "displayName", "description", "defaultEffort", "inputModalities"]); identity(c.model); if (c.providerId !== undefined) identity(c.providerId);
    check(Array.isArray(c.efforts) && c.efforts.length <= 32); for (const effort of c.efforts) identity(effort); check(new Set(c.efforts).size === c.efforts.length);
    if (c.displayName !== undefined) text(c.displayName);
    if (c.description !== undefined) text(c.description, 4096, true);
    if (c.defaultEffort !== undefined) identity(c.defaultEffort);
    if (c.inputModalities !== undefined) { check(Array.isArray(c.inputModalities) && c.inputModalities.length <= 3); for (const modality of c.inputModalities) check(["text", "image", "audio"].includes(String(modality))); check(new Set(c.inputModalities).size === c.inputModalities.length); }
    const key = JSON.stringify([c.model, c.providerId ?? null]); check(!known.has(key)); known.add(key);
  }
  return frozen(v) as Catalog;
}
