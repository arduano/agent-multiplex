import type { Action, Activity, CapturePort, CopilotScope, Json, Lifecycle, Missing, NativeCodec, Origin, RowKind, ScopeFacts } from "../../contracts/types.js";
import { canonical, invariant, object, PrimitiveError, validateScope } from "../../contracts/validation.js";
import type { NativeMediaHandler, NativeMediaOccurrence } from "../../contracts/media.js";
import { copilotMediaData } from "./media.js";
import { delegationFacts } from "./delegation.js";

/** SDK 1.0.19-shaped callbacks only. This module never imports or calls a native SDK. */
export interface CopilotLimits {
  maxEvents: number;
  maxEventChars: number;
  maxRows: number;
  maxBodyChars: number;
  maxScopes: number;
  maxUnknown: number;
}
const defaults: CopilotLimits = { maxEvents: 4096, maxEventChars: 65_536, maxRows: 256, maxBodyChars: 32_768, maxScopes: 32, maxUnknown: 32 };
type Event = { id: string; type: string; data: Record<string, unknown>; agentId?: unknown; media?: readonly NativeMediaOccurrence[]; mediaUnsupported?: boolean };
type LedgerRow = {
  id: string; kind: RowKind; text: string; hasBody: boolean; started: boolean;
  full: boolean; lifecycle: Lifecycle; missing: Set<Missing>; native: Record<string, Json>;
  sequences: Map<number, string>; nextSequence: number;
};
type Owned = { key: string; scope: CopilotScope; rows: Map<string, LedgerRow>; activity: Activity };
export interface CopilotCodec extends NativeCodec {
  /** Bounded classification diagnostics, never an invented native scope or transcript. */
  diagnostics(): Readonly<{ seenEvents: number; rows: number; failed: boolean; quarantined: readonly Readonly<{ eventId: string; reason: string }>[] }>;
}
export interface CopilotCodecOptions {
  origin: Origin;
  capture: CapturePort;
  limits?: Partial<CopilotLimits>;
  /** A caller may assert this only after installing observation before fresh-session work. */
  knownStart?: boolean;
  media?: NativeMediaHandler;
}
const own = (record: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024;
const rowId = (kind: RowKind, value: string): string => JSON.stringify(["copilot", kind, value]);
// SDK .19 instruction/configuration and hook receipts are not human conversation bodies.
const sidebands = new Set(["system.message", "session.managed_settings_resolved", "session.skills_loaded",
  "session.mcp_servers_loaded", "session.tools_updated", "hook.start", "hook.end", "pending_messages.modified",
  "session.start", "session.title_changed", "session.background_tasks_changed", "assistant.streaming_delta",
  "model.call_finished", "model.call_failure", "permission.requested", "permission.completed"]);
const diagnosticKinds = new Map([
  ["model.turn_started", "turn_started"], ["model.log", "log"], ["model.model_call_started", "model_call_started"],
  ["model.model_call_success", "model_call_success"], ["model.message", "message"],
  ["model.tool_execution", "tool_execution"], ["model.turn_ended", "turn_ended"],
]);
function field(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  invariant(!descriptor || "value" in descriptor, "COPILOT_EVENT_ACCESSOR");
  return descriptor?.value;
}
/** Exact observed .95 ephemeral diagnostics only; no model.* wildcard or transcript-body inspection. */
function runtimeDiagnostic(input: Record<string, unknown>, type: string): boolean {
  if (!diagnosticKinds.has(type) && type !== "model.call_start" && type !== "model.call_final_result") return false;
  if (field(input, "ephemeral") !== true) return false;
  const data = object(field(input, "data"));
  if (type === "model.call_start") return id(field(data, "turnId")) && id(field(data, "model"));
  if (type === "model.call_final_result") return id(field(data, "model")) && typeof field(data, "isByok") === "boolean";
  if (field(data, "kind") !== diagnosticKinds.get(type)) return false;
  if (type === "model.log") return id(field(data, "level"));
  const turn = field(data, "turn");
  return Number.isSafeInteger(turn) && (turn as number) >= 0 && (type !== "model.tool_execution" || id(field(data, "toolCallId")));
}

export function createCopilotCodec(options: CopilotCodecOptions): CopilotCodec {
  const limits = { ...defaults, ...options.limits };
  for (const value of Object.values(limits)) invariant(Number.isSafeInteger(value) && value > 0, "COPILOT_LIMIT");
  invariant(limits.maxBodyChars <= 65_536 && limits.maxEventChars <= 1_048_576, "COPILOT_LIMIT");
  const origin = JSON.parse(canonical(options.origin)) as Origin;
  const root: CopilotScope = { kind: "copilot", origin, agentId: null };
  validateScope(root);
  const seen = new Map<string, string>();
  const owners = new Map<string, Owned>();
  const aliases = new Map<string, string>(); // Exact spawning tool ID -> actual agent ID, never opaque-ID equality.
  const parents = new Map<string, string>(); // Exact child spawning tool ID -> positive parent scope key.
  const unknown = new Map<string, { eventId: string; reason: string }>();
  let rowCount = 0;
  let captureFailed = false;
  function captureCall(call: () => void): void {
    invariant(!captureFailed, "COPILOT_CAPTURE_FAILED");
    try { call(); } catch (error) { captureFailed = true; throw error; }
  }

  function owned(key: string): Owned {
    const existing = owners.get(key); if (existing) return existing;
    invariant(owners.size < limits.maxScopes, "COPILOT_SCOPE_LIMIT");
    // Namespace legacy tool ownership so equal tool/agent strings do not establish aliases.
    const parsed = JSON.parse(key) as [string, string?];
    const scope: CopilotScope = parsed[0] === "tool"
      ? { kind: "copilot", origin, agentId: null, legacyParentToolCallId: parsed[1]! }
      : { kind: "copilot", origin, agentId: parsed[0] === "root" ? null : parsed[1]! };
    for (const other of owners.values()) invariant(canonical(other.scope) !== canonical(scope), "COPILOT_SCOPE_COLLISION");
    validateScope(scope);
    const value: Owned = { key, scope, rows: new Map(), activity: { turnId: null, state: "unknown" } }; owners.set(key, value);
    captureCall(() => options.capture.open(scope, { knownStart: options.knownStart === true }));
    return value;
  }
  const rootKey = JSON.stringify(["root"]);
  const agentKey = (value: string): string => JSON.stringify(["agent", value]);
  const toolKey = (value: string): string => aliases.has(value) ? agentKey(aliases.get(value)!) : JSON.stringify(["tool", value]);
  owned(rootKey);

  function quarantine(event: Pick<Event, "id">, reason: string): void {
    invariant(unknown.size < limits.maxUnknown || unknown.has(event.id), "COPILOT_UNKNOWN_LIMIT");
    unknown.set(event.id, { eventId: event.id, reason });
  }
  function marker(event: Event): { agent?: string; parentTool?: string; invalid: boolean } {
    const envelope = own(event as unknown as Record<string, unknown>, "agentId");
    const legacy = own(event.data, "agentId");
    const parent = own(event.data, "parentToolCallId");
    if ((envelope && !id(event.agentId)) || (legacy && !id(event.data.agentId)) || (parent && !id(event.data.parentToolCallId))) return { invalid: true };
    if (envelope && legacy && event.agentId !== event.data.agentId) return { invalid: true };
    return {
      ...(envelope || legacy ? { agent: (envelope ? event.agentId : event.data.agentId) as string } : {}),
      ...(parent ? { parentTool: event.data.parentToolCallId as string } : {}), invalid: false,
    };
  }
  function emit(owner: Owned, actions: readonly Action[]): void { if (actions.length) captureCall(() => options.capture.emit(owner.scope, actions)); }
  function activity(owner: Owned, value: Activity): void { owner.activity = value; emit(owner, [{ type: "activity", activity: value }]); }
  function gap(owner: Owned, identity: string, kind: "identity" | "nativeGap" | "unsupported" | "truncated", target?: string): void {
    emit(owner, [{ type: "gap", gap: { id: identity, kind, ...(target ? { rowId: target } : {}) } }]);
  }
  function unsupported(owner: Owned, type: string): void {
    // Gap maps belong to exact owner scopes. One absent feature fact per type, never per delivery.
    gap(owner, JSON.stringify(["copilot", "unsupported", type]), "unsupported");
  }
  function ledger(owner: Owned, key: string, kind: RowKind): LedgerRow {
    const previous = owner.rows.get(key);
    if (previous) { invariant(previous.kind === kind, "COPILOT_ROW_KIND_CONFLICT"); return previous; }
    invariant(rowCount < limits.maxRows, "COPILOT_ROW_LIMIT"); rowCount++;
    const value: LedgerRow = { id: key, kind, text: "", hasBody: false, started: false, full: false, lifecycle: "running", missing: new Set(["prefix", "final"]), native: {}, sequences: new Map(), nextSequence: 0 };
    owner.rows.set(key, value); return value;
  }
  function metadata(event: Event, fields: readonly string[] = [], jsonFields: readonly string[] = []): Record<string, Json> {
    const native: Record<string, Json> = { eventId: event.id };
    for (const field of fields) {
      const value = event.data[field];
      if (typeof value === "string" && value.length <= 2048 || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) native[field] = value as Json;
    }
    for (const field of jsonFields) if (own(event.data, field)) {
      const encoded = canonical(event.data[field]); invariant(encoded.length <= 8192, "COPILOT_NATIVE_METADATA_LIMIT");
      native[field] = JSON.parse(encoded) as Json;
    }
    return native;
  }
  function start(owner: Owned, row: LedgerRow, native: Record<string, Json>): void {
    if (row.started) return;
    row.started = true; if (!row.hasBody) row.missing.delete("prefix"); Object.assign(row.native, native);
    emit(owner, [{ type: "start", id: row.id, kind: row.kind, native: row.native }]);
  }
  function append(owner: Owned, row: LedgerRow, value: unknown, sequence?: number): void {
    invariant(typeof value === "string", "COPILOT_BODY");
    // A late callback cannot mutate a body already sealed by a native full final.
    if (row.lifecycle !== "running") return;
    if (sequence !== undefined) {
      const previous = row.sequences.get(sequence);
      if (previous !== undefined) {
        if (previous !== value) { row.missing.add("interior"); gap(owner, `copilot:sequence-conflict:${row.id}:${sequence}`, "nativeGap", row.id); }
        return;
      }
      invariant(row.sequences.size < limits.maxEvents, "COPILOT_SEQUENCE_LIMIT");
      if (sequence < row.nextSequence) {
        row.sequences.set(sequence, value);
        row.missing.add("interior"); gap(owner, `copilot:sequence-late:${row.id}:${sequence}`, "nativeGap", row.id); return;
      }
      invariant(row.text.length + value.length <= limits.maxBodyChars, "COPILOT_BODY_LIMIT");
      row.sequences.set(sequence, value);
      if (sequence !== row.nextSequence) row.missing.add("interior");
      row.nextSequence = Math.max(row.nextSequence, sequence + 1);
    } else invariant(row.text.length + value.length <= limits.maxBodyChars, "COPILOT_BODY_LIMIT");
    row.text += value; row.hasBody = true;
    emit(owner, [{ type: "append", id: row.id, kind: row.kind, text: value, ...(sequence !== undefined ? { sequence, channel: "shell" } : {}) }]);
  }
  function replacePartial(owner: Owned, row: LedgerRow, value: unknown): void {
    invariant(typeof value === "string" && value.length <= limits.maxBodyChars, "COPILOT_BODY_LIMIT");
    if (row.lifecycle !== "running") return;
    row.text = value; row.hasBody = true; row.full = false;
    // This deprecated native event replaces the prefix, but supplies no completion proof.
    row.missing.delete("prefix"); row.missing.delete("interior"); row.missing.add("final");
    emit(owner, [{ type: "replace", id: row.id, kind: row.kind, text: value }]);
  }
  function finish(owner: Owned, row: LedgerRow, body: string | null, lifecycle: Exclude<Lifecycle, "running">, native: Record<string, Json>): void {
    if (body !== null) invariant(body.length <= limits.maxBodyChars, "COPILOT_BODY_LIMIT");
    if (row.lifecycle !== "running") {
      if (row.lifecycle !== lifecycle || row.full && body !== null && row.text !== body) {
        // Distinct delivery IDs do not authorize changing a sealed logical item.
        // Keep this scope-level gap independent of row-body healing.
        quarantine({ id: native.eventId as string }, "conflicting logical final");
        gap(owner, `copilot:final-conflict:${row.id}`, "nativeGap");
        return;
      }
      // A repeated terminal fact is inert. A missing final body may still be
      // enriched by a full body with the same terminal lifecycle.
      if (row.full || body === null) return;
    }
    if (body !== null) {
      row.text = body; row.hasBody = true; row.full = true; row.missing.clear();
    }
    row.lifecycle = lifecycle; Object.assign(row.native, native);
    emit(owner, [{ type: "finish", id: row.id, kind: row.kind, lifecycle, text: body, native: row.native }]);
  }
  function migrate(tool: string, agent: string): void {
    const previous = aliases.get(tool); invariant(previous === undefined || previous === agent, "COPILOT_ALIAS_CONFLICT");
    if (previous === agent) return;
    invariant(aliases.size < limits.maxScopes, "COPILOT_ALIAS_LIMIT");
    const oldKey = JSON.stringify(["tool", tool]); const old = owners.get(oldKey);
    const destination = owned(agentKey(agent));
    if (old) {
      // Check the entire finite migration before publishing any row; collisions are not text merges.
      for (const key of old.rows.keys()) invariant(!destination.rows.has(key), "COPILOT_ALIAS_ROW_CONFLICT");
      for (const row of old.rows.values()) {
        const actions: Action[] = [];
        if (row.started) actions.push({ type: "start", id: row.id, kind: row.kind, native: row.native });
        if (row.hasBody) actions.push({ type: "replace", id: row.id, kind: row.kind, text: row.text, native: row.native });
        if (row.missing.has("prefix")) actions.push({ type: "gap", gap: { id: `copilot:alias-prefix:${row.id}`, kind: "missingPrefix", rowId: row.id } });
        if (row.missing.has("interior")) actions.push({ type: "gap", gap: { id: `copilot:alias-interior:${row.id}`, kind: "nativeGap", rowId: row.id } });
        if (row.lifecycle !== "running") actions.push({ type: "finish", id: row.id, kind: row.kind, lifecycle: row.lifecycle, text: row.full ? row.text : null, native: row.native });
        emit(destination, actions); destination.rows.set(row.id, row);
      }
      if (old.rows.size) emit(old, [{ type: "retire", rowIds: [...old.rows.keys()], evidence: "exact subagent spawning-tool to agent relation" }]);
      old.rows.clear();
      if (old.activity.state !== "unknown") {
        if (destination.activity.state === "unknown") activity(destination, old.activity);
        else if (canonical(destination.activity) !== canonical(old.activity)) {
          activity(destination, { turnId: null, state: "unknown" }); gap(destination, `copilot:alias-activity:${tool}`, "identity");
        }
        activity(old, { turnId: null, state: "unknown" });
      }
    }
    aliases.set(tool, agent);
    for (const [child, parent] of parents) if (parent === oldKey) parents.set(child, agentKey(agent));
  }
  function ownerFor(event: Event): Owned | undefined {
    const value = marker(event);
    if (value.invalid) { quarantine(event, "invalid or conflicting owner marker"); return undefined; }
    if (value.agent && value.parentTool) migrate(value.parentTool, value.agent);
    return owned(value.agent ? agentKey(value.agent) : value.parentTool ? toolKey(value.parentTool) : rootKey);
  }
  /** Project the latest exact task from the existing alias/parent/row ledgers.
   * A late older completion cannot replace a newer reused-agent invocation.
   * This also carries nested metadata without reading the parent's body. */
  function publishAgent(agent: string): void {
    const child = owned(agentKey(agent));
    const tool = [...aliases].filter(([, value]) => value === agent).at(-1)?.[0];
    const parent = tool === undefined ? undefined : parents.get(tool);
    const row = tool === undefined || parent === undefined ? undefined : owners.get(parent)?.rows.get(rowId("delegation", tool));
    const configured = [...child.rows.values()].filter(value => value.kind === "notice" && value.native.configuredModel !== undefined).at(-1)?.native.configuredModel;
    const native: Record<string, string> = {};
    if (id(configured)) native.configuredModel = configured;
    if (row) {
      native.invocation = tool!; native.lifecycle = row.lifecycle;
      for (const name of ["configuredModel", "startedModel", "requestedModel", "firstDispatchedModel", "reportedUsedModel"]) {
        if (id(row.native[name])) native[name] = row.native[name];
      }
      const name = row.native.agentDisplayName ?? row.native.agentName; if (id(name)) native.name = name;
    }
    captureCall(() => options.capture.open(child.scope, { native: native as ScopeFacts }));
  }
  function delegation(event: Event): void {
    const marks = marker(event);
    if (marks.invalid) { quarantine(event, "invalid subagent owner marker"); return; }
    if (event.type === "subagent.configured") {
      if (!marks.agent) { quarantine(event, "configured subagent has no actual instance marker"); return; }
      const owner = owned(agentKey(marks.agent));
      const row = ledger(owner, rowId("notice", event.id), "notice");
      finish(owner, row, "Subagent configured", "completed", { ...metadata(event, ["model", "multiTurn", "reasoningEffort", "contextTier"]), ...delegationFacts(event.type, event.data) }); publishAgent(marks.agent); return;
    }
    if (!id(event.data.toolCallId)) { quarantine(event, "subagent lifecycle has no spawning tool ID"); return; }
    const tool = event.data.toolCallId;
    if (marks.agent) migrate(tool, marks.agent);
    if (own(event.data, "parentId") && !id(event.data.parentId)) { quarantine(event, "invalid subagent task parent"); return; }
    const knownParent = id(event.data.parentId) ? toolKey(event.data.parentId) : parents.get(tool);
    // Only started declares that absent task parent means a root-spawned child.
    // Completion events omit this field even for nested runs; a missed start is not root proof.
    if (knownParent === undefined && event.type !== "subagent.started") { quarantine(event, "subagent lifecycle parent was not captured"); return; }
    const parent = knownParent ?? rootKey;
    const previous = parents.get(tool); invariant(previous === undefined || previous === parent, "COPILOT_PARENT_CONFLICT");
    invariant(parents.has(tool) || parents.size < limits.maxScopes, "COPILOT_PARENT_LIMIT"); parents.set(tool, parent);
    const owner = owned(parent); const row = ledger(owner, rowId("delegation", tool), "delegation");
    const native = metadata(event, ["toolCallId", "agentName", "agentDisplayName", "agentDescription", "model", "executionMode", "resumable", "parentId"]);
    Object.assign(native, delegationFacts(event.type, event.data));
    if (marks.agent) native.agentId = marks.agent;
    if (event.type === "subagent.started") start(owner, row, native);
    else if (event.type === "subagent.completed" || event.type === "subagent.failed") {
      const lifecycle = event.type === "subagent.failed" ? "failed" : event.data.cancelled === true ? "interrupted" : "completed";
      finish(owner, row, typeof event.data.error === "string" ? event.data.error : null, lifecycle, native);
    } else unsupported(owner, event.type);
    if (marks.agent) publishAgent(marks.agent);
  }
  function observe(value: unknown): void {
    invariant(!captureFailed, "COPILOT_CAPTURE_FAILED");
    const input = object(value), type = field(input, "type");
    if (typeof type === "string" && (sidebands.has(type) || runtimeDiagnostic(input, type))) { observeSideband(input, type); return; }
    const eventId = field(input, "id"); invariant(id(eventId) && id(type), "COPILOT_EVENT_ID");
    const data = object(field(input, "data"));
    invariant(Object.values(Object.getOwnPropertyDescriptors(input)).every(value => "value" in value) &&
      Object.values(Object.getOwnPropertyDescriptors(data)).every(value => "value" in value), "COPILOT_EVENT_ACCESSOR");
    const provisional: Event = { ...input, id: eventId, type, data };
    const marks = marker(provisional);
    let mediaScope: CopilotScope | undefined;
    if (!marks.invalid) {
      if (marks.agent && marks.parentTool) {
        const known = aliases.get(marks.parentTool);
        invariant(known === undefined || known === marks.agent, "COPILOT_ALIAS_CONFLICT");
        invariant(known !== undefined || aliases.size < limits.maxScopes, "COPILOT_ALIAS_LIMIT");
      }
      const key = marks.agent ? agentKey(marks.agent) : marks.parentTool ? toolKey(marks.parentTool) : rootKey;
      invariant(owners.has(key) || owners.size < limits.maxScopes, "COPILOT_SCOPE_LIMIT");
      const parsed = JSON.parse(key) as [string, string?];
      mediaScope = parsed[0] === "tool" ? { kind: "copilot", origin, agentId: null, legacyParentToolCallId: parsed[1]! }
        : { kind: "copilot", origin, agentId: parsed[0] === "root" ? null : parsed[1]! };
      validateScope(mediaScope);
    }
    const media = copilotMediaData(type, data, eventId, mediaScope, options.media);
    const serialized = canonical({ ...input, data: media.data }); invariant(serialized.length <= limits.maxEventChars, "COPILOT_EVENT_LIMIT");
    const raw = object(JSON.parse(serialized));
    invariant(id(raw.id) && id(raw.type), "COPILOT_EVENT_ID");
    const event = { ...raw, data: object(raw.data), media: media.media, mediaUnsupported: media.unsupported } as Event;
    const prior = seen.get(event.id);
    if (prior !== undefined) { invariant(prior === serialized, "COPILOT_EVENT_CONFLICT"); return; }
    invariant(seen.size < limits.maxEvents, "COPILOT_EVENT_COUNT_LIMIT");
    applyEvent(event); seen.set(event.id, serialized);
  }
  function observeSideband(input: Record<string, unknown>, type: string): void {
    // Validate only the envelope and source markers. Never inspect, copy, hash, size or
    // log content/contentBlocks, hook input/output or private instruction-template metadata.
    const eventId = field(input, "id"); invariant(id(eventId), "COPILOT_EVENT_ID");
    const data = object(field(input, "data")), source: Record<string, Json> = {};
    const header: Record<string, Json> = { id: eventId, type, data: source };
    for (const key of ["agentId", "parentId", "timestamp", "ephemeral"]) if (own(input, key)) {
      const value = field(input, key);
      invariant(key === "ephemeral" ? typeof value === "boolean" : key === "parentId" && value === null || id(value), "COPILOT_SIDEBAND_ENVELOPE");
      header[key] = value as Json;
    }
    for (const key of ["agentId", "parentToolCallId"]) if (own(data, key)) {
      const value = field(data, key); invariant(id(value), "COPILOT_SIDEBAND_OWNER"); source[key] = value;
    }
    invariant(!(typeof header.agentId === "string" && typeof source.agentId === "string") || header.agentId === source.agentId, "COPILOT_SIDEBAND_OWNER");
    if (type === "system.message") {
      const role = field(data, "role"); invariant(role === "system" || role === "developer", "COPILOT_SYSTEM_ROLE"); source.role = role;
    }
    if (type === "assistant.streaming_delta") {
      const bytes = field(data, "totalResponseSizeBytes"); invariant(Number.isSafeInteger(bytes) && (bytes as number) >= 0, "COPILOT_STREAM_PROGRESS");
      source.totalResponseSizeBytes = bytes as number;
    }
    for (const key of ["name", "interactionId", "source", "hookInvocationId", "hookType", "modelId", "kind", "turnId", "toolCallId"]) if (own(data, key)) {
      const value = field(data, key); invariant(typeof value === "string" && value.length <= 1024, "COPILOT_SIDEBAND_SOURCE"); source[key] = value;
    }
    if (own(data, "turn")) {
      const turn = field(data, "turn"); invariant(Number.isSafeInteger(turn) && (turn as number) >= 0, "COPILOT_SIDEBAND_SOURCE"); source.turn = turn as number;
    }
    // For ignored sidebands exact identity comparison covers only these admitted header/source
    // fields; body equality is deliberately neither read nor claimed. Transcript IDs still
    // compare their complete bounded payload and cannot collide with this separate domain.
    const fingerprint = `sideband:${canonical(header)}`;
    invariant(fingerprint.length <= limits.maxEventChars, "COPILOT_EVENT_LIMIT");
    const prior = seen.get(eventId);
    if (prior !== undefined) { invariant(prior === fingerprint, "COPILOT_EVENT_CONFLICT"); return; }
    invariant(seen.size < limits.maxEvents, "COPILOT_EVENT_COUNT_LIMIT"); seen.set(eventId, fingerprint);
  }
  function applyEvent(event: Event): void {
    if (event.type.startsWith("subagent.")) { delegation(event); return; }
    const owner = ownerFor(event); if (!owner) return;
    const data = event.data;
    if (event.type === "assistant.message_start" || event.type === "assistant.message_delta" || event.type === "assistant.message") {
      invariant(id(data.messageId), "COPILOT_MESSAGE_ID"); const row = ledger(owner, rowId("assistant", data.messageId), "assistant");
      if (event.type === "assistant.message_start") start(owner, row, metadata(event, ["messageId", "phase"]));
      else if (event.type === "assistant.message_delta") append(owner, row, data.deltaContent);
      else { invariant(typeof data.content === "string", "COPILOT_BODY"); finish(owner, row, data.content, "completed", metadata(event, ["messageId", "phase", "originatingMessageId", "apiCallId", "chunkIndex", "chunkCount"], ["toolRequests"])); }
    } else if (event.type === "assistant.reasoning_delta" || event.type === "assistant.reasoning") {
      invariant(id(data.reasoningId), "COPILOT_REASONING_ID"); const row = ledger(owner, rowId("reasoning", data.reasoningId), "reasoning");
      if (event.type.endsWith("_delta")) append(owner, row, data.deltaContent);
      else { invariant(typeof data.content === "string", "COPILOT_BODY"); finish(owner, row, data.content, "completed", metadata(event, ["reasoningId"])); }
    } else if (event.type === "user.message") {
      invariant(typeof data.content === "string", "COPILOT_BODY");
      const logical = id(data.messageId) ? data.messageId : event.id;
      const row = ledger(owner, rowId("user", logical), "user");
      const native = metadata(event, ["messageId", "turnId", "source", "delivery"]);
      if (event.media?.length) native.media = event.media as unknown as Json;
      finish(owner, row, data.content, "completed", native);
      // Explicit content proves text independently of unsupported attachments.
      // Row-scoped gaps describe missing body bytes to the capture owner.
      if (event.mediaUnsupported) gap(owner, `copilot:unsupported-media:${event.id}`, "unsupported");
      if (!id(data.messageId)) gap(owner, `copilot:no-message-id:${event.id}`, "identity", row.id);
    } else if (["tool.execution_start", "tool.execution_complete", "tool.execution_partial_result", "tool.shell_output"].includes(event.type)) {
      invariant(id(data.toolCallId), "COPILOT_TOOL_ID"); const row = ledger(owner, rowId("tool", data.toolCallId), "tool");
      if (event.type === "tool.execution_start") start(owner, row, metadata(event, ["toolCallId", "toolName"], ["arguments"]));
      else if (event.type === "tool.execution_partial_result") replacePartial(owner, row, data.partialOutput);
      else if (event.type === "tool.shell_output") {
        invariant(Number.isSafeInteger(data.sequence) && (data.sequence as number) >= 0, "COPILOT_SHELL_SEQUENCE");
        append(owner, row, data.text, data.sequence as number);
      } else {
        let body: string | null = null;
        if (data.result !== undefined) { const result = object(data.result); if (typeof result.detailedContent === "string") body = result.detailedContent; else if (typeof result.content === "string") body = result.content; }
        if (body === null && data.error !== undefined) { const error = object(data.error); if (typeof error.message === "string") body = error.message; }
        invariant(typeof data.success === "boolean", "COPILOT_TOOL_SUCCESS");
        const native = metadata(event, ["toolCallId", "toolName"]);
        if (event.media?.length) native.media = event.media as unknown as Json;
        finish(owner, row, body, data.success ? "completed" : "failed", native);
        if (event.mediaUnsupported) gap(owner, `copilot:unsupported-media:${event.id}`, "unsupported", row.id);
      }
    } else if (event.type === "assistant.turn_start" || event.type === "assistant.turn_end") {
      invariant(id(data.turnId), "COPILOT_TURN_ID");
      if (event.type === "assistant.turn_start") activity(owner, { turnId: data.turnId, state: "working" });
      else if (owner.activity.turnId === data.turnId) activity(owner, { turnId: data.turnId, state: "unknown" });
    } else if (event.type === "session.idle") {
      activity(owner, { turnId: null, state: "idle" });
    } else if (event.type === "session.error") {
      const row = ledger(owner, rowId("notice", event.id), "notice");
      finish(owner, row, typeof data.message === "string" ? data.message : null, "failed", metadata(event, ["willRetry"]));
    } else if (event.type === "session.compaction_complete") {
      invariant(typeof data.success === "boolean", "COPILOT_COMPACTION_OUTCOME");
      if (data.success) emit(owner, [{ type: "readBoundary", factId: JSON.stringify(["copilot", event.id]), reason: "Native compaction changed the history read boundary" }]);
    } else if (event.type === "session.compaction_start") {
      // Starting or failing compaction cannot establish a changed native page boundary.
    } else if (event.type === "session.snapshot_rewind" || event.type === "session.context_cleared") {
      // A native semantic edit fences the retained image. It is not an attachment/reconnect event.
      captureCall(() => options.capture.reset(owner.scope, event.type)); rowCount -= owner.rows.size; owner.rows.clear(); owner.activity = { turnId: null, state: "unknown" };
    } else if (event.type === "assistant.idle" || event.type === "tool.execution_progress" || event.type === "assistant.usage" || event.type === "session.usage_info" || event.type === "session.binary_asset") {
      // Main-loop pause is not session idle; usage/progress does not certify any body bytes.
    } else {
      unsupported(owner, event.type);
    }
  }
  return { observe, diagnostics: () => ({ seenEvents: seen.size, rows: rowCount, failed: captureFailed, quarantined: [...unknown.values()] }) };
}

export { PrimitiveError };
