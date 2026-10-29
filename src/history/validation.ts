import { scopeKey } from "../protocol/index.js";
import type {
  Activity,
  Gap,
  HistoryRecord,
  HistoryScope,
  OlderEdge,
  Row,
  Snapshot,
} from "./contracts.js";

export class HistoryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HistoryError";
  }
}
export function check(value: unknown, code: string): asserts value {
  if (!value) throw new HistoryError(code);
}
export function text(value: unknown, max = 512): asserts value is string {
  check(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= max &&
      !/[\x00-\x1f\x7f]/.test(value),
    "INVALID_ID",
  );
}
export function integer(value: unknown, minimum = 0): asserts value is number {
  check(Number.isSafeInteger(value) && (value as number) >= minimum, "INVALID_COUNTER");
}
export function canonical(value: unknown): string {
  function visit(input: unknown, depth: number): unknown {
    check(depth <= 32, "JSON_DEPTH");
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") {
      check(Number.isFinite(input), "INVALID_JSON");
      return input;
    }
    check(typeof input === "object" && input !== null, "INVALID_JSON");
    if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1));
    check(
      Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null,
      "INVALID_JSON",
    );
    return Object.fromEntries(
      Object.keys(input)
        .sort()
        .map((key) => [key, visit((input as Record<string, unknown>)[key], depth + 1)]),
    );
  }
  return JSON.stringify(visit(value, 0));
}
export const bytes = (value: unknown): number =>
  new TextEncoder().encode(canonical(value)).byteLength;
export function immutable<T>(value: T): T {
  const result = structuredClone(value);
  function freeze(input: unknown): void {
    if (input && typeof input === "object") {
      for (const child of Object.values(input)) freeze(child);
      Object.freeze(input);
    }
  }
  freeze(result);
  return result;
}
export function historyScopeKey(scope: HistoryScope): string {
  check(scope && scope.run, "INVALID_SCOPE");
  const logical = scopeKey(scope.run.scope);
  integer(scope.run.generation, 1);
  text(scope.run.nativeSession);
  text(scope.attachment);
  text(scope.stream);
  return JSON.stringify([
    logical,
    scope.run.generation,
    scope.run.nativeSession,
    scope.attachment,
    scope.stream,
  ]);
}
export function record(value: HistoryRecord): void {
  check(value && typeof value === "object", "INVALID_ROW");
  text(value.id);
  check(
    ["user", "assistant", "reasoning", "tool", "notice", "delegation"].includes(value.kind),
    "INVALID_ROW",
  );
  check(
    ["running", "completed", "failed", "interrupted", "unknown"].includes(value.lifecycle),
    "INVALID_ROW",
  );
  const body = value.body;
  check(body && typeof body === "object", "INVALID_BODY");
  if (body.kind === "unavailable")
    check(["notCaptured", "nativeOmitted", "unsupported"].includes(body.reason), "INVALID_BODY");
  else {
    check(typeof body.text === "string", "INVALID_BODY");
    if (body.kind === "complete")
      check(["native", "captured"].includes(body.evidence), "INVALID_BODY");
    else
      check(
        body.kind === "partial" &&
          Array.isArray(body.missing) &&
          body.missing.length > 0 &&
          body.missing.every((item) =>
            ["prefix", "interior", "final", "truncated"].includes(item),
          ) &&
          new Set(body.missing).size === body.missing.length,
        "INVALID_BODY",
      );
  }
  check(
    value.native &&
      !Array.isArray(value.native) &&
      typeof value.native === "object" &&
      bytes(value.native) <= 8192,
    "INVALID_NATIVE_METADATA",
  );
  canonical(value);
}
export function row(value: Row): void {
  record(value);
  integer(value.version, 1);
}
export function edge(value: OlderEdge): void {
  check(value && typeof value === "object", "INVALID_EDGE");
  if (value.state === "unknown") text(value.reason, 1024);
  else if (value.state === "available") text(value.cursor, 16384);
  else
    check(
      value.state === "end" && ["provedEmptyCapture", "nativeBoundary"].includes(value.evidence),
      "INVALID_EDGE",
    );
}
export function gap(value: Gap): void {
  text(value.id);
  if (value.rowId !== undefined) text(value.rowId);
  check(
    [
      "captureLost",
      "missingPrefix",
      "missingFinal",
      "identity",
      "unsupported",
      "truncated",
    ].includes(value.kind),
    "INVALID_GAP",
  );
}
export function activity(value: Activity): void {
  check(
    value && ["unknown", "working", "idle", "failed"].includes(value.state),
    "INVALID_ACTIVITY",
  );
  if (value.turnId !== null) text(value.turnId);
}
export function snapshot(value: Snapshot): void {
  historyScopeKey(value.scope);
  integer(value.generation, 1);
  integer(value.revision);
  integer(value.readEpoch);
  check(typeof value.residencyOmitted === "boolean", "INVALID_RESIDENCY");
  check(Array.isArray(value.rows) && value.rows.length <= 4096, "INVALID_ROWS");
  value.rows.forEach(row);
  check(new Set(value.rows.map((item) => item.id)).size === value.rows.length, "DUPLICATE_ROW");
  check(
    value.rows.every((item) => item.version <= value.revision),
    "ROW_VERSION",
  );
  check(Array.isArray(value.gaps) && value.gaps.length <= 4096, "INVALID_GAPS");
  value.gaps.forEach(gap);
  check(new Set(value.gaps.map((item) => item.id)).size === value.gaps.length, "DUPLICATE_GAP");
  edge(value.olderEdge);
  activity(value.activity);
}
export function mergeOrder(
  prior: readonly string[],
  incoming: readonly string[],
  before: boolean,
): string[] {
  check(
    new Set(prior).size === prior.length && new Set(incoming).size === incoming.length,
    "DUPLICATE_ROW",
  );
  const positions = new Map(prior.map((id, index) => [id, index])),
    runs = new Map<string, string[]>();
  let position = -1,
    anchor: string | undefined,
    run: string[] = [];
  for (const id of incoming) {
    const next = positions.get(id);
    if (next === undefined) {
      run.push(id);
      continue;
    }
    check(next > position, "ORDER_CONFLICT");
    runs.set(id, run);
    run = [];
    position = next;
    anchor = id;
  }
  if (anchor === undefined) return before ? [...incoming, ...prior] : [...prior, ...incoming];
  const merged: string[] = [];
  for (const id of prior) {
    merged.push(...(runs.get(id) ?? []), id);
    if (id === anchor) merged.push(...run);
  }
  return merged;
}
