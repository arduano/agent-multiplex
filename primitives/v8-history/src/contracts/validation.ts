import type { Action, Activity, Body, CapturedScope, Coverage, Frame, HistoryReadState, Json, OlderEdge, Row, Scope, ScopeFacts, ScopeInventory, NativeMediaOccurrence } from "./types.js";

export const MAX_NATIVE_MEDIA_BYTES = 10 * 1024 * 1024;
export const MAX_NATIVE_MEDIA_OCCURRENCES = 10;

/** Bounded typed accessor; ordinary unknown native JSON is never treated as media. */
export function rowMedia(row: Pick<Row, "native">): readonly NativeMediaOccurrence[] {
  const value = row.native.media;
  if (value === undefined) return Object.freeze([]);
  invariant(Array.isArray(value) && value.length <= MAX_NATIVE_MEDIA_OCCURRENCES, "MEDIA_REFERENCE_BOUND");
  for (const entry of value) {
    invariant(entry !== null && typeof entry === "object" && !Array.isArray(entry), "MEDIA_REFERENCE");
    const item = entry as Record<string, Json>;
    invariant(typeof item.id === "string" && item.id.length <= 4096 &&
      ["image", "unsupported"].includes(String(item.kind)) &&
      ["inline", "disk", "native", "unsupported"].includes(String(item.source)) &&
      ["available", "pending", "unavailable", "unsupported"].includes(String(item.state)), "MEDIA_REFERENCE");
    invariant(!("data" in item) && !("url" in item), "MEDIA_INLINE_FORBIDDEN");
    invariant(Object.keys(item).every(key => ["id", "kind", "source", "state", "artifactId", "mediaType", "sha256", "bytes", "path", "assetId", "omittedReason", "absent", "nativeType", "displayName", "taggedFilesEntry", "declaredBytes"].includes(key)), "MEDIA_REFERENCE");
    for (const key of ["artifactId", "mediaType", "sha256", "path", "assetId", "omittedReason", "nativeType", "displayName", "taggedFilesEntry"]) {
      invariant(item[key] === undefined || typeof item[key] === "string" && ((item[key] as string).length > 0 || ["displayName", "taggedFilesEntry"].includes(key)) && (item[key] as string).length <= (["path", "taggedFilesEntry"].includes(key) ? 4096 : ["assetId", "displayName"].includes(key) ? 1024 : 256), "MEDIA_REFERENCE");
    }
    invariant(item.absent === undefined || item.absent === true, "MEDIA_REFERENCE");
    invariant(item.bytes === undefined || typeof item.bytes === "number" && Number.isSafeInteger(item.bytes) && item.bytes >= 0 && item.bytes <= MAX_NATIVE_MEDIA_BYTES, "MEDIA_REFERENCE");
    invariant(item.declaredBytes === undefined || typeof item.declaredBytes === "number" && Number.isSafeInteger(item.declaredBytes) && item.declaredBytes >= 0, "MEDIA_REFERENCE");
    invariant(item.sha256 === undefined || /^[a-f0-9]{64}$/.test(item.sha256 as string), "MEDIA_REFERENCE");
    invariant(item.source !== "inline" || typeof item.sha256 === "string" && typeof item.bytes === "number" && typeof item.mediaType === "string", "MEDIA_REFERENCE");
    invariant(item.state !== "available" || typeof item.artifactId === "string", "MEDIA_REFERENCE");
  }
  return deepFreeze(JSON.parse(canonical(value))) as readonly NativeMediaOccurrence[];
}


export class PrimitiveError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = "PrimitiveError"; }
}
export function invariant(condition: unknown, code: string): asserts condition {
  if (!condition) throw new PrimitiveError(code);
}
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Deterministic JSON, with finite admission before retaining an untrusted value. */
export function canonical(value: unknown): string {
  const active = new Set<object>(); let nodes = 0, units = 0;
  const visit = (input: unknown, depth: number): Json => {
    invariant(++nodes <= 20_000 && depth <= 24, "JSON_LIMIT");
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") { invariant(Number.isFinite(input), "JSON_NUMBER"); return input; }
    if (typeof input === "string") { units += input.length; invariant(input.length <= 262_144 && units <= 1_048_576, "JSON_LIMIT"); return input; }
    invariant(input !== null && typeof input === "object", "JSON_VALUE");
    invariant(!active.has(input), "JSON_CYCLE"); active.add(input);
    let result: Json;
    if (Array.isArray(input)) {
      invariant(input.length <= 4096, "JSON_LIMIT"); result = Array.from({ length: input.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        invariant(descriptor && "value" in descriptor, "JSON_ARRAY_ELEMENT"); return visit(descriptor.value, depth + 1);
      });
    } else {
      const prototype = Object.getPrototypeOf(input);
      invariant(prototype === Object.prototype || prototype === null, "JSON_OBJECT");
      const keys = Object.keys(input).sort(); invariant(keys.length <= 1024, "JSON_LIMIT");
      const record: Record<string, Json> = Object.create(null) as Record<string, Json>;
      for (const key of keys) {
        invariant(key.length <= 1024 && !["__proto__", "prototype", "constructor"].includes(key), "JSON_KEY");
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        invariant("value" in descriptor, "JSON_ACCESSOR");
        units += key.length; invariant(units <= 1_048_576, "JSON_LIMIT");
        record[key] = visit(descriptor.value, depth + 1);
      }
      result = record;
    }
    active.delete(input); return result;
  };
  const text = JSON.stringify(visit(value, 0));
  invariant(new TextEncoder().encode(text).byteLength <= 1_048_576, "JSON_WIRE_LIMIT");
  return text;
}
export function cloneJson<T>(value: T): T { return JSON.parse(canonical(value)) as T; }
export function object(value: unknown): Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), "EXPECTED_OBJECT");
  return value as Record<string, unknown>;
}
export function text(value: unknown, code = "EXPECTED_STRING", max = 4096): asserts value is string {
  invariant(typeof value === "string" && value.length > 0 && value.length <= max, code);
}
function integer(value: unknown): asserts value is number { invariant(Number.isSafeInteger(value) && (value as number) >= 0, "EXPECTED_REVISION"); }
function strings(value: unknown): asserts value is readonly string[] {
  invariant(Array.isArray(value) && value.length <= 1024, "EXPECTED_IDS");
  for (const id of value) text(id);
  invariant(new Set(value).size === value.length, "DUPLICATE_IDS");
}
function keys(record: Record<string, unknown>, allowed: readonly string[]) {
  invariant(Object.keys(record).every(key => allowed.includes(key)), "UNEXPECTED_FIELD");
}
export function validateScope(input: unknown): Scope {
  const value = object(input); keys(value, ["kind", "origin", "threadId", "agentId", "legacyParentToolCallId"]);
  const origin = object(value.origin); keys(origin, ["connection", "principal", "host", "nativeSession", "attachment"]);
  for (const field of ["connection", "principal", "host", "nativeSession", "attachment"]) text(origin[field], "SCOPE_ID", 1024);
  if (value.kind === "codex") { text(value.threadId, "THREAD_ID", 1024); invariant(!("agentId" in value) && !("legacyParentToolCallId" in value), "WRONG_NATIVE_SCOPE"); }
  else {
    invariant(value.kind === "copilot" && !("threadId" in value), "WRONG_NATIVE_SCOPE");
    if (value.agentId !== null) { text(value.agentId, "AGENT_ID", 1024); invariant(!("legacyParentToolCallId" in value), "WRONG_NATIVE_SCOPE"); }
    if ("legacyParentToolCallId" in value) { invariant(value.agentId === null, "WRONG_NATIVE_SCOPE"); text(value.legacyParentToolCallId, "LEGACY_TOOL_ID", 1024); }
  }
  return input as Scope;
}
/** Display/admission projection from the same Host scope authority. A caller
 * must retain these exact descriptors, rather than invent child context. */
export function validateScopeFacts(input: unknown): ScopeFacts {
  const value = object(input);
  keys(value, ["name", "nickname", "role", "path", "configuredModel", "reasoningEffort", "status", "invocation", "lifecycle", "startedModel", "requestedModel", "firstDispatchedModel", "reportedUsedModel"]);
  for (const field of ["name", "nickname", "role", "path", "configuredModel", "reasoningEffort", "invocation", "startedModel", "requestedModel", "firstDispatchedModel", "reportedUsedModel"]) if (value[field] !== undefined) text(value[field], "SCOPE_FACT", 1024);
  if (value.lifecycle !== undefined) invariant(["running", "completed", "failed", "interrupted"].includes(String(value.lifecycle)), "SCOPE_FACT");
  if (value.status !== undefined) invariant(["idle", "active", "notLoaded", "systemError"].includes(String(value.status)), "SCOPE_FACT");
  return input as ScopeFacts;
}
export function validateScopeInventory(input: unknown, root: Scope): ScopeInventory {
  const inventory = object(input); keys(inventory, ["nativeGeneration", "entries"]);
  invariant(Number.isSafeInteger(inventory.nativeGeneration) && (inventory.nativeGeneration as number) > 0, "SCOPE_INVENTORY_GENERATION");
  validateCapturedScopes(inventory.entries, root);
  return input as ScopeInventory;
}
export function validateCapturedScopes(input: unknown, root: Scope): readonly CapturedScope[] {
  const entries = input;
  invariant(Array.isArray(entries) && entries.length <= 32, "SCOPE_INVENTORY_LIMIT");
  invariant(new TextEncoder().encode(canonical(input)).byteLength <= 1_048_576, "SCOPE_INVENTORY_BYTES");
  const seen = new Set<string>(), origin = canonical(root.origin);
  for (const value of entries) {
    const entry = object(value); keys(entry, ["scope", "native"]);
    const scope = validateScope(entry.scope), key = canonical(scope);
    if (entry.native !== undefined) validateScopeFacts(entry.native);
    invariant(scope.kind === root.kind && canonical(scope.origin) === origin && !seen.has(key), "SCOPE_INVENTORY_IDENTITY");
    seen.add(key);
  }
  return input as readonly CapturedScope[];
}
function validateBody(input: unknown): asserts input is Body {
  const value = object(input);
  if (value.kind === "complete") {
    keys(value, ["kind", "text", "evidence"]);
    invariant(typeof value.text === "string" && value.text.length <= 65_536, "BODY_LIMIT");
    invariant(["nativeFullBody", "capturedStartThroughEnd"].includes(String(value.evidence)), "BODY_EVIDENCE");
  } else if (value.kind === "partial") {
    keys(value, ["kind", "text", "missing"]);
    invariant(typeof value.text === "string" && value.text.length <= 65_536, "BODY_LIMIT");
    invariant(Array.isArray(value.missing) && value.missing.length > 0 && value.missing.length <= 4, "BODY_EVIDENCE");
    invariant(value.missing.every(x => ["prefix", "interior", "final", "truncated"].includes(x)) && new Set(value.missing).size === value.missing.length, "BODY_EVIDENCE");
  } else {
    keys(value, ["kind", "reason"]);
    invariant(value.kind === "unavailable" && ["notCaptured", "unsupported", "nativeOmitted"].includes(String(value.reason)), "BODY_EVIDENCE");
  }
}
export function validateRow(input: unknown): Row {
  const value = object(input); keys(value, ["id", "kind", "lifecycle", "body", "native", "version", "contentVersion"]);
  text(value.id); invariant(["user", "assistant", "reasoning", "tool", "delegation", "notice"].includes(String(value.kind)), "ROW_KIND");
  invariant(["unknown", "running", "completed", "failed", "interrupted"].includes(String(value.lifecycle)), "ROW_LIFECYCLE");
  validateBody(value.body); object(value.native); integer(value.version); integer(value.contentVersion);
  invariant(canonical(value.native).length <= 16_384, "NATIVE_METADATA_LIMIT");
  return input as Row;
}
function edge(input: unknown): asserts input is OlderEdge {
  const value = object(input);
  if (value.state === "available") { keys(value, ["state", "cursor"]); text(value.cursor, "EXPECTED_STRING", 16384); }
  else if (value.state === "end") { keys(value, ["state", "evidence"]); invariant(["provedEmptyCapture", "nativeBoundary"].includes(String(value.evidence)), "EDGE_EVIDENCE"); }
  else { keys(value, ["state", "reason"]); invariant(value.state === "unknown", "EDGE_STATE"); text(value.reason); }
}
function retirement(input: unknown): void {
  const change = object(input); keys(change, ["kind", "rowIds", "evidence", "replacementId"]);
  invariant(change.kind === "retireRows", "RETIREMENT_KIND"); strings(change.rowIds); text(change.evidence);
  if (change.replacementId !== undefined) text(change.replacementId);
}
function coverage(input: unknown): asserts input is Coverage {
  const value = object(input); keys(value, ["knownStart", "gaps"]); invariant(typeof value.knownStart === "boolean" && Array.isArray(value.gaps) && value.gaps.length <= 256, "COVERAGE");
  const ids = new Set<string>();
  for (const raw of value.gaps) {
    const gap = object(raw); keys(gap, ["id", "kind", "rowId"]); text(gap.id); invariant(!ids.has(gap.id), "DUPLICATE_GAP"); ids.add(gap.id);
    invariant(["missingPrefix", "missingFinal", "nativeGap", "identity", "unsupported", "truncated"].includes(String(gap.kind)), "GAP_KIND");
    if (gap.rowId !== undefined) text(gap.rowId);
  }
}
function activity(input: unknown): asserts input is Activity {
  const value = object(input); keys(value, ["turnId", "state"]);
  if (value.turnId !== null) text(value.turnId);
  invariant(["unknown", "working", "idle", "failed"].includes(String(value.state)), "ACTIVITY");
}
export function validateHistoryRead(input: unknown): HistoryReadState {
  const value = object(cloneJson(input));
  if (value.state === 'idle') keys(value, ['state']);
  else {
    invariant(value.state === 'pending' || value.state === 'settled', 'HISTORY_READ_STATE');
    keys(value, value.state === 'pending' ? ['state', 'target'] : ['state', 'target', 'outcome', 'retryToken']);
    const target = object(value.target);
    if (target.kind === 'older') { keys(target, ['kind', 'cursor']); text(target.cursor, 'HISTORY_READ_CURSOR', 16384); }
    else { keys(target, ['kind']); invariant(target.kind === 'initial' || target.kind === 'recover', 'HISTORY_READ_TARGET'); }
    if (value.state === 'settled') {
      invariant(['ready', 'healed', 'failed', 'expired', 'unsupported'].includes(String(value.outcome)), 'HISTORY_READ_OUTCOME');
      if (value.retryToken !== undefined) { invariant(value.outcome === 'failed', 'HISTORY_READ_RETRY'); text(value.retryToken, 'HISTORY_READ_RETRY', 128); }
    }
  }
  return deepFreeze(value as unknown as HistoryReadState);
}
/** All validation completes on a detached JSON copy before a consumer can publish state. */
export function validateFrame(input: unknown): Frame {
  const frame = object(cloneJson(input));
  if (frame.kind === "snapshot") {
    keys(frame, ["kind", "snapshot"]); const snapshot = object(frame.snapshot);
    keys(snapshot, ["scope", "generation", "revision", "rows", "retirements", "olderEdge", "coverage", "activity", "readContext", "scopeInventory", "read"]);
    if (snapshot.readContext !== undefined) text(snapshot.readContext, "READ_CONTEXT", 256);
    validateScope(snapshot.scope); text(snapshot.generation); integer(snapshot.revision);
    if (snapshot.scopeInventory !== undefined) validateScopeInventory(snapshot.scopeInventory, snapshot.scope as Scope);
    invariant(Array.isArray(snapshot.rows) && snapshot.rows.length <= 1024, "ROW_LIMIT");
    const ids = new Set<string>(); for (const row of snapshot.rows) { const checked = validateRow(row); invariant(!ids.has(checked.id), "DUPLICATE_ROW"); ids.add(checked.id); }
    invariant(Array.isArray(snapshot.retirements) && snapshot.retirements.length <= 1024, "RETIREMENT_LIMIT");
    const retired = new Set<string>();
    for (const entry of snapshot.retirements) { retirement(entry); for (const id of entry.rowIds as string[]) { invariant(!retired.has(id) && !ids.has(id), "RETIREMENT_CONFLICT"); retired.add(id); } }
    invariant(retired.size <= 1024, "RETIREMENT_LIMIT");
    edge(snapshot.olderEdge); coverage(snapshot.coverage); activity(snapshot.activity);
    snapshot.read = validateHistoryRead(snapshot.read ?? { state: 'idle' });
  } else {
    invariant(frame.kind === "commit", "FRAME_KIND");
    keys(frame, ["kind", "scope", "generation", "baseRevision", "revision", "changes", "order", "olderEdge", "coverage", "activity", "readContext", "scopeInventory", "read"]);
    if (frame.readContext !== undefined) text(frame.readContext, "READ_CONTEXT", 256);
    validateScope(frame.scope); text(frame.generation); integer(frame.baseRevision); integer(frame.revision);
    if (frame.scopeInventory !== undefined) validateScopeInventory(frame.scopeInventory, frame.scope as Scope);
    invariant(frame.revision === frame.baseRevision + 1, "REVISION_STEP");
    invariant(Array.isArray(frame.changes) && frame.changes.length <= 1024, "CHANGE_LIMIT");
    for (const raw of frame.changes) {
      const change = object(raw);
      if (change.kind === "replaceRow") { keys(change, ["kind", "row"]); validateRow(change.row); }
      else if (change.kind === "evictCurrentRows") { keys(change, ["kind", "rowIds"]); strings(change.rowIds); }
      else {
        retirement(change);
      }
    }
    strings(frame.order); edge(frame.olderEdge); coverage(frame.coverage); activity(frame.activity);
    if (frame.read !== undefined) frame.read = validateHistoryRead(frame.read);
  }
  return deepFreeze(frame as unknown as Frame);
}
export function validateActions(input: readonly Action[]): readonly Action[] {
  const copy = cloneJson(input); invariant(Array.isArray(copy) && copy.length <= 128, "ACTION_LIMIT");
  for (const raw of copy) {
    const a = object(raw); text(a.type);
    invariant(["start", "append", "replace", "finish", "activity", "gap", "clearGap", "edge", "retire", "media", "readBoundary"].includes(a.type), "ACTION_KIND");
    if (["start", "append", "replace", "finish"].includes(a.type)) {
      text(a.id); invariant(["user", "assistant", "reasoning", "tool", "delegation", "notice"].includes(String(a.kind)), "ROW_KIND");
      if (a.text !== undefined && a.text !== null) invariant(typeof a.text === "string" && a.text.length <= 65_536, "BODY_LIMIT");
      if (a.native !== undefined) { object(a.native); invariant(canonical(a.native).length <= 16_384, "NATIVE_METADATA_LIMIT"); }
      if (a.type === "start" && a.text !== undefined) invariant(a.text === null || typeof a.text === "string", "START_TEXT");
      if (a.type === "append") { invariant(typeof a.text === "string", "APPEND_TEXT"); if (a.sequence !== undefined) integer(a.sequence); if (a.channel !== undefined) text(a.channel); }
      if (a.type === "replace") invariant(typeof a.text === "string", "REPLACE_TEXT");
      if (a.type === "finish") { invariant(["completed", "failed", "interrupted"].includes(String(a.lifecycle)), "ROW_LIFECYCLE"); if (a.sealCaptured !== undefined) invariant(typeof a.sealCaptured === "boolean", "BODY_EVIDENCE"); }
    } else if (a.type === "media") { keys(a, ["type", "id", "media"]); text(a.id); invariant(Array.isArray(a.media), "MEDIA_REFERENCE"); rowMedia({ native: { media: a.media as Json } }); }
    else if (a.type === "readBoundary") { keys(a, ["type", "factId", "reason"]); text(a.factId, "READ_BOUNDARY_FACT", 4096); text(a.reason, "READ_BOUNDARY_REASON", 1024); }
    else if (a.type === "activity") activity(a.activity);
    else if (a.type === "edge") edge(a.edge);
    else if (a.type === "clearGap") text(a.id);
    else if (a.type === "retire") { strings(a.rowIds); text(a.evidence); if (a.replacementId !== undefined) text(a.replacementId); }
    else coverage({ knownStart: false, gaps: [a.gap] });
  }
  return deepFreeze(copy);
}
