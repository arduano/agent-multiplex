import type { AcquisitionBatch, AcquisitionPort, AcquisitionRequest, HistoryRecord } from "../../acquisition/types.js";
import type { Body, CopilotScope, Gap, Json, RowKind } from "../../contracts/types.js";
import { sameScope } from "../../contracts/identity.js";
import { canonical, cloneJson, deepFreeze, invariant, object, text, validateScope } from "../../contracts/validation.js";
import type { NativeMediaHandler } from "../../contracts/media.js";
import { copilotMediaData } from "./media.js";
import { delegationFacts } from "./delegation.js";

/** SDK .19 read contracts only. This module never imports an SDK or activates a session. */
export type CopilotActiveHistoryRequest = Readonly<{
  cursor?: string; max: number; direction: "backward"; includeEphemeral: false;
}> & (Readonly<{ agentScope: "primary"; agentIds?: never }> | Readonly<{ agentIds: readonly [string]; agentScope?: never }>);
export type CopilotPersistedHistoryRequest = Readonly<{ sessionId: string; cursor?: string; max: 1; direction: "backward" }>;
export type CopilotNativeHistoryRequest = CopilotActiveHistoryRequest | CopilotPersistedHistoryRequest;
export interface CopilotHistoryOptions {
  scope: CopilotScope;
  mode: "active" | "persisted";
  context?: string;
  read: (request: CopilotNativeHistoryRequest) => Promise<unknown>;
  limits?: Partial<Readonly<{ maxEvents: number; maxEventChars: number; maxBodyChars: number; maxPageBytes: number; maxRetainedEvents: number; maxRetainedBytes: number }>>;
  media?: NativeMediaHandler;
}
const defaults = { maxEvents: 128, maxEventChars: 65_536, maxBodyChars: 65_536, maxPageBytes: 262_144, maxRetainedEvents: 4096, maxRetainedBytes: 1_048_576 };
const own = (value: object, key: string): boolean => Object.hasOwn(value, key);
function field(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  invariant(!descriptor || "value" in descriptor, "COPILOT_HISTORY_ACCESSOR");
  return descriptor?.value;
}
function identifier(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 1024; }
const rowId = (kind: RowKind, value: string): string => JSON.stringify(["copilot", kind, value]);
const ignored = new Set([
  "system.message", "session.start", "session.resume", "session.title_changed", "session.managed_settings_resolved",
  "session.skills_loaded", "session.mcp_servers_loaded", "session.tools_updated", "session.background_tasks_changed",
  "hook.start", "hook.end", "pending_messages.modified", "assistant.turn_start", "assistant.turn_end", "assistant.idle",
  "session.idle", "assistant.usage", "session.usage_info", "tool.execution_progress", "permission.requested", "permission.completed", "session.binary_asset",
]);
const selected = new Set(["assistant.message", "assistant.reasoning", "user.message", "tool.execution_start", "tool.execution_complete", "tool.execution_partial_result", "session.error", "session.binary_asset"]);
const delegationTypes = new Set(["subagent.started", "subagent.configured", "subagent.completed", "subagent.failed"]);
type Envelope = { id: string; type: string; data: Record<string, unknown>; owner: string | null; legacyTool: string | null; parentId?: string | null; timestamp?: string };
function envelope(raw: unknown): Envelope {
  const value = object(raw), data = object(field(value, "data"));
  const id = field(value, "id"), type = field(value, "type");
  text(id, "COPILOT_HISTORY_EVENT_ID", 1024); text(type, "COPILOT_HISTORY_EVENT_TYPE", 1024);
  const agent = field(value, "agentId"), legacyAgent = field(data, "agentId"), legacyTool = field(data, "parentToolCallId");
  if (own(value, "agentId")) invariant(identifier(agent), "COPILOT_HISTORY_OWNER");
  if (own(data, "agentId")) invariant(identifier(legacyAgent), "COPILOT_HISTORY_OWNER");
  if (own(data, "parentToolCallId")) invariant(identifier(legacyTool), "COPILOT_HISTORY_OWNER");
  invariant(agent === undefined || legacyAgent === undefined || agent === legacyAgent, "COPILOT_HISTORY_OWNER");
  const ephemeral = field(value, "ephemeral");
  invariant(ephemeral === undefined || ephemeral === false, "COPILOT_HISTORY_EPHEMERAL");
  const parentId = field(value, "parentId"), timestamp = field(value, "timestamp");
  if (own(value, "parentId")) invariant(parentId === null || identifier(parentId), "COPILOT_HISTORY_ENVELOPE");
  if (own(value, "timestamp")) invariant(identifier(timestamp), "COPILOT_HISTORY_ENVELOPE");
  return { id, type, data, owner: (agent ?? legacyAgent ?? null) as string | null, legacyTool: (legacyTool ?? null) as string | null,
    ...(parentId === undefined ? {} : { parentId: parentId as string | null }), ...(timestamp === undefined ? {} : { timestamp: timestamp as string }) };
}
function belongs(event: Envelope, scope: CopilotScope): boolean {
  // A legacy tool ID never becomes an agent ID merely because their strings coincide.
  if (scope.legacyParentToolCallId !== undefined) return event.owner === null && event.legacyTool === scope.legacyParentToolCallId;
  if (scope.agentId !== null) return event.owner === scope.agentId;
  return event.owner === null && event.legacyTool === null;
}
type MutableRecord = { id: string; kind: RowKind; lifecycle: HistoryRecord["lifecycle"]; body: Body; native: Record<string, Json> };
function meaning(event: Envelope, header: Record<string, Json>, includeData: boolean): string {
  if (!includeData) return canonical(header);
  const data: Record<string, Json> = {};
  for (const name of ["messageId", "reasoningId", "toolCallId", "toolName", "originatingMessageId", "turnId", "phase", "apiCallId", "parentId", "arguments", "toolRequests", "attachments", "media"]) {
    if (own(event.data, name)) data[name] = cloneJson(field(event.data, name)) as Json;
  }
  if (delegationTypes.has(event.type)) {
    for (const name of ["agentName", "agentDisplayName", "agentDescription", "model", "explicitModelOverride", "configuredModelPreference", "firstDispatchedModel", "cancelled"]) {
      if (own(event.data, name)) data[name] = cloneJson(field(event.data, name)) as Json;
    }
  }
  if (["assistant.message", "assistant.reasoning", "user.message"].includes(event.type)) data.content = cloneJson(field(event.data, "content")) as Json;
  if (event.type === "tool.execution_partial_result") data.partialOutput = cloneJson(field(event.data, "partialOutput")) as Json;
  if (event.type === "tool.execution_complete") {
    data.success = cloneJson(field(event.data, "success")) as Json;
    const result = field(event.data, "result"), error = field(event.data, "error");
    for (const [name, raw] of [["result", result], ["error", error]] as const) {
      if (raw === undefined || raw === null) continue;
      const source = object(raw), admitted: Record<string, Json> = {};
      for (const key of name === "result" ? ["content", "detailedContent", "contents", "binaryResultsForLlm"] : ["message"]) {
        const value = field(source, key); if (typeof value === "string" || Array.isArray(value)) admitted[key] = cloneJson(value) as Json;
      }
      if (Object.keys(admitted).length) data[name] = admitted;
    }
  }
  if (event.type === "session.error" && typeof field(event.data, "message") === "string") data.message = field(event.data, "message") as string;
  return canonical({ ...header, data });
}

export function createCopilotHistoryPort(options: CopilotHistoryOptions): AcquisitionPort<CopilotScope> {
  const scope = deepFreeze(cloneJson(options.scope)); validateScope(scope);
  invariant(scope.kind === "copilot" && ["active", "persisted"].includes(options.mode), "COPILOT_HISTORY_BINDING");
  const limits = Object.freeze({ ...defaults, ...options.limits });
  for (const value of Object.values(limits)) invariant(Number.isSafeInteger(value) && value > 0, "COPILOT_HISTORY_LIMIT");
  invariant(limits.maxEvents <= 128 && limits.maxBodyChars <= 65_536 && limits.maxEventChars <= 1_048_576 && limits.maxPageBytes <= 1_048_576 && limits.maxRetainedEvents <= 4096 && limits.maxRetainedBytes <= 1_048_576, "COPILOT_HISTORY_LIMIT");
  const mode = options.mode;
  // This ledger covers history-read observations only. It never compares a live
  // payload against a persisted enrichment, and it never evicts identity fences.
  const retained = new Map<string, string>(); let retainedBytes = 0;
  if (options.context !== undefined) text(options.context, "READ_CONTEXT", 256);
  return Object.freeze({ scope, mode, ...(options.context === undefined ? {} : { context: options.context }), async read(request: AcquisitionRequest<CopilotScope>, assertCurrent?: () => void): Promise<AcquisitionBatch> {
    validateScope(request.scope); invariant(sameScope(scope, request.scope), "FOREIGN_PAGE_SCOPE");
    invariant(Number.isSafeInteger(request.count) && request.count > 0 && request.count <= limits.maxEvents, "COPILOT_HISTORY_COUNT");
    if (request.cursor !== null) text(request.cursor, "COPILOT_HISTORY_CURSOR", 8192);
    const cursor = request.cursor === null ? {} : { cursor: request.cursor };
    const nativeRequest: CopilotNativeHistoryRequest = mode === "persisted"
      ? { sessionId: scope.origin.nativeSession, ...cursor, max: 1, direction: "backward" }
      : { ...cursor, max: request.count, direction: "backward", includeEphemeral: false,
          ...(scope.legacyParentToolCallId !== undefined ? { agentIds: [scope.legacyParentToolCallId] as const }
            : scope.agentId !== null ? { agentIds: [scope.agentId] as const } : { agentScope: "primary" as const }) };
    assertCurrent?.();
    const result = object(await options.read(deepFreeze(nativeRequest)));
    assertCurrent?.();
    const events = field(result, "events"), nextCursor = field(result, "cursor"), hasMore = field(result, "hasMore"), status = field(result, "cursorStatus");
    invariant(Array.isArray(events) && events.length <= (mode === "persisted" ? 1 : request.count), "COPILOT_HISTORY_PAGE");
    invariant(typeof nextCursor === "string" && nextCursor.length <= 8192, "COPILOT_HISTORY_CURSOR");
    invariant(typeof hasMore === "boolean" && (status === "ok" || status === "expired"), "COPILOT_HISTORY_PAGE");
    invariant(!hasMore || nextCursor.length > 0 && nextCursor !== request.cursor, "NONADVANCING_CURSOR");
    if (status === "expired") {
      // Active replacement windows are intentionally not presented as the requested continuation.
      invariant(mode !== "persisted" || events.length === 0 && !hasMore, "COPILOT_PERSISTED_EXPIRED_PAGE");
      return deepFreeze({ scope, status, records: [], hasMore: false, nextCursor: null,
        gaps: [{ id: "copilot:history:cursor-expired", kind: "nativeGap" }] });
    }
    const records = new Map<string, MutableRecord>(), seen = new Map<string, string>(), gaps = new Map<string, Gap>(), rootDelegations = new Set<string>(), messageKinds = new Map<string, RowKind>(), discovered = new Map<string, { scope: CopilotScope }>();
    const gap = (type: string, kind: Gap["kind"] = "unsupported", target?: string): void => {
      const id = JSON.stringify(["copilot", "history", type, target ?? null]);
      gaps.set(id, { id, kind, ...(target ? { rowId: target } : {}) });
    };
    let inputBytes = 0;
    function body(value: unknown): string {
      invariant(typeof value === "string", "COPILOT_HISTORY_BODY");
      invariant(value.length <= limits.maxBodyChars, "PAGE_TOO_LARGE"); return value;
    }
    function terminal(value: MutableRecord, lifecycle: "completed" | "failed"): void {
      invariant(value.lifecycle === "unknown" || value.lifecycle === lifecycle, "COPILOT_HISTORY_TERMINAL_CONFLICT");
      value.lifecycle = lifecycle;
    }
    function fullBody(value: MutableRecord, content: unknown): void {
      const text = body(content);
      invariant(value.body.kind !== "complete" || value.body.text === text, "COPILOT_HISTORY_BODY_CONFLICT");
      value.body = { kind: "complete", text, evidence: "nativeFullBody" };
    }
    function record(event: Envelope, kind: RowKind, logical: unknown): MutableRecord {
      invariant(identifier(logical), "COPILOT_HISTORY_LOGICAL_ID"); const key = rowId(kind, logical);
      // User/assistant IDs share the native message domain. Reasoning/tool/task IDs
      // remain separate domains even when their opaque strings happen to match.
      if ((kind === "user" || kind === "assistant") && identifier(event.data.messageId)) {
        const previous = messageKinds.get(logical);
        invariant(previous === undefined || previous === kind, "COPILOT_HISTORY_KIND_CONFLICT"); messageKinds.set(logical, kind);
      }
      let value = records.get(key);
      if (!value) { value = { id: key, kind, lifecycle: "unknown", body: { kind: "unavailable", reason: "notCaptured" }, native: {} }; records.set(key, value); }
      const original = event.data.originatingMessageId;
      if (own(event.data, "originatingMessageId")) {
        invariant(identifier(original), "COPILOT_HISTORY_ORIGINAL_ID");
        invariant(value.native.originatingMessageId === undefined || value.native.originatingMessageId === original, "COPILOT_HISTORY_ORIGINAL_CONFLICT");
      }
      value.native.eventId = event.id; value.native.type = event.type;
      const ids = value.native.eventIds as string[] | undefined; value.native.eventIds = [...(ids ?? []), event.id];
      for (const name of ["messageId", "reasoningId", "toolCallId", "toolName", "originatingMessageId", "turnId", "phase", "apiCallId", "parentId"]) {
        if (identifier(event.data[name])) value.native[name] = event.data[name];
      }
      if (event.owner !== null) value.native.agentId = event.owner;
      if (event.legacyTool !== null) value.native.parentToolCallId = event.legacyTool;
      if (delegationTypes.has(event.type)) {
        for (const name of ["agentName", "agentDisplayName", "agentDescription"]) if (identifier(event.data[name])) value.native[name] = event.data[name];
        Object.assign(value.native, delegationFacts(event.type, event.data));
      }
      for (const name of ["arguments", "toolRequests"]) if (own(event.data, name)) {
        const encoded = canonical(event.data[name]); invariant(encoded.length <= 8192, "PAGE_TOO_LARGE");
        value.native[name] = JSON.parse(encoded) as Json;
      }
      return value;
    }
    for (const raw of events) {
      let event = envelope(raw);
      const isOwned = belongs(event, scope);
      const lifecycle = event.type.startsWith("subagent.");
      if (!isOwned) {
        invariant(mode === "persisted" || lifecycle && scope.agentId === null && scope.legacyParentToolCallId === undefined, "COPILOT_HISTORY_FOREIGN_OWNER");
      }
      const media = isOwned ? copilotMediaData(event.type, event.data, event.id, scope, options.media)
        : { data: event.data, media: [], unsupported: false };
      event = { ...event, data: media.data };
      const safeHeader: Record<string, Json> = { id: event.id, type: event.type, owner: event.owner, legacyTool: event.legacyTool,
        ...(event.parentId === undefined ? {} : { parentId: event.parentId }), ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }) };
      if (isOwned && event.type === "system.message") { const role = field(event.data, "role"); invariant(role === "system" || role === "developer", "COPILOT_HISTORY_SYSTEM_ROLE"); }
      // Private system/developer instructions and control payloads are never materialized or retained.
      const includeData = isOwned && (selected.has(event.type) || delegationTypes.has(event.type));
      const serialized = includeData ? canonical({ ...safeHeader, data: event.data }) : canonical(safeHeader);
      invariant(serialized.length <= limits.maxEventChars, "PAGE_TOO_LARGE");
      inputBytes += new TextEncoder().encode(serialized).byteLength;
      invariant(inputBytes <= limits.maxPageBytes, "PAGE_TOO_LARGE");
      const fingerprint = meaning(event, safeHeader, includeData);
      const known = retained.get(event.id); invariant(known === undefined || known === fingerprint, "COPILOT_HISTORY_EVENT_CONFLICT");
      const prior = seen.get(event.id); if (prior !== undefined) { invariant(prior === fingerprint, "COPILOT_HISTORY_EVENT_CONFLICT"); continue; }
      seen.set(event.id, fingerprint);
      // An exact-session persisted page (or primary active lifecycle envelope)
      // proves native agent membership, even when its body belongs to a child.
      // Legacy parent tool IDs are a different identity domain.
      if (scope.agentId === null && scope.legacyParentToolCallId === undefined && event.owner !== null && !discovered.has(event.owner)) {
        if (discovered.size < 31) discovered.set(event.owner, { scope: { kind: "copilot", origin: scope.origin, agentId: event.owner } });
        else gap("child-discovery-capacity", "truncated");
      }
      if (!isOwned) continue;
      if (ignored.has(event.type)) continue;
      if (event.type === "assistant.message" || event.type === "assistant.reasoning" || event.type === "user.message") {
        const kind = event.type === "assistant.message" ? "assistant" : event.type === "assistant.reasoning" ? "reasoning" : "user";
        const logical = kind === "reasoning" ? event.data.reasoningId : event.data.messageId;
        const value = record(event, kind, kind === "user" && !identifier(logical) ? event.id : logical);
        fullBody(value, event.data.content); terminal(value, "completed");
        if (media.media.length) value.native.media = media.media as unknown as Json;
        if (media.unsupported) {
          if (kind === "user") {
            // Keep exact media coverage without contradicting explicit full text.
            gap(`unsupported-media:${value.id}`, "unsupported");
          } else {
            if (value.body.kind !== "unavailable") value.body = { kind: "partial", text: value.body.text, missing: ["interior"] };
            gap("unsupported-media", "unsupported", value.id);
          }
        }
        if (kind === "user" && !identifier(logical)) gap("missing-logical-message-id", "identity", value.id);
      } else if (event.type === "tool.execution_start" || event.type === "tool.execution_complete" || event.type === "tool.execution_partial_result") {
        const value = record(event, "tool", event.data.toolCallId);
        if (media.media.length) value.native.media = media.media as unknown as Json;
        if (event.type === "tool.execution_start") {
          // A historical start proves input metadata, never an empty output or current work.
        } else if (event.type === "tool.execution_partial_result") {
          if (value.body.kind !== "complete") value.body = { kind: "partial", text: body(event.data.partialOutput), missing: ["final"] };
        } else {
          invariant(typeof event.data.success === "boolean", "COPILOT_HISTORY_TOOL_SUCCESS");
          terminal(value, event.data.success ? "completed" : "failed");
          let full: unknown;
          if (event.data.result !== undefined && event.data.result !== null) {
            const result = object(event.data.result); full = typeof result.detailedContent === "string" ? result.detailedContent : result.content;
          }
          if (typeof full !== "string" && event.data.error !== undefined && event.data.error !== null) full = object(event.data.error).message;
          if (typeof full === "string") fullBody(value, full);
          else if (value.body.kind !== "complete") {
            if (value.body.kind === "unavailable") value.body = { kind: "unavailable", reason: "nativeOmitted" };
            gap("missing-tool-final-body", "missingFinal", value.id);
          }
          if (media.unsupported) {
            if (value.body.kind !== "unavailable") value.body = { kind: "partial", text: value.body.text, missing: ["interior"] };
            gap("unsupported-media", "unsupported", value.id);
          }
        }
      } else if (event.type === "session.compaction_complete") {
        invariant(typeof event.data.success === "boolean", "COPILOT_COMPACTION_OUTCOME");
        if (event.data.success) gap("historical-transform", "nativeGap");
      } else if (event.type === "session.snapshot_rewind" || event.type === "session.context_cleared" || event.type === "session.truncation") {
        gap("historical-transform", "nativeGap");
      } else if (lifecycle) {
        // Historical delegation rows never establish a live invocation.
        if (!delegationTypes.has(event.type)) { gap(event.type); continue; }
        const tool = event.data.toolCallId, isRoot = scope.agentId === null && scope.legacyParentToolCallId === undefined;
        if (isRoot && own(event.data, "parentId")) {
          invariant(identifier(event.data.parentId), "COPILOT_HISTORY_OWNER"); continue; // An explicitly nested task belongs to another parent.
        }
        if (!identifier(tool)) { gap("unproved-subagent-metadata", "identity"); continue; }
        if (isRoot) {
          if (event.type === "subagent.started") rootDelegations.add(tool);
          else if (!rootDelegations.has(tool)) { gap("unproved-subagent-parent", "identity"); continue; }
        }
        record(event, "delegation", tool);
      } else if (event.type === "session.error") {
        const value = record(event, "notice", event.id); value.lifecycle = "failed";
        value.body = typeof event.data.message === "string" ? { kind: "complete", text: body(event.data.message), evidence: "nativeFullBody" } : { kind: "unavailable", reason: "nativeOmitted" };
      } else gap(event.type);
    }
    const batch: AcquisitionBatch = { scope, status: "ok", records: [...records.values()], hasMore, nextCursor: hasMore ? nextCursor : null, gaps: [...gaps.values()],
      ...(discovered.size ? { discoveredScopes: [...discovered.values()] } : {}) };
    invariant(new TextEncoder().encode(canonical(batch)).byteLength <= limits.maxPageBytes, "PAGE_TOO_LARGE");
    let addedEvents = 0, addedBytes = 0;
    for (const [id, fingerprint] of seen) if (!retained.has(id)) {
      addedEvents++; addedBytes += new TextEncoder().encode(id).byteLength + new TextEncoder().encode(fingerprint).byteLength;
    }
    invariant(retained.size + addedEvents <= limits.maxRetainedEvents && retainedBytes + addedBytes <= limits.maxRetainedBytes, "COPILOT_HISTORY_IDENTITY_CAPACITY");
    const frozen = deepFreeze(batch); assertCurrent?.();
    // All reads/decoding/capacity checks complete before any identity is retained.
    for (const [id, fingerprint] of seen) retained.set(id, fingerprint);
    retainedBytes += addedBytes;
    return frozen;
  } });
}
