import type { Action, CapturePort, CodexScope, Json, Lifecycle, NativeCodec, Origin, RowKind } from "../../contracts/types.js";
import { canonical } from "../../contracts/validation.js";
import { mediaMeaning, type NativeMediaHandler, type NativeMediaOccurrence } from "../../contracts/media.js";
import { codexMediaItem } from "./media.js";
import { codexOptionalQuestionMetadata } from "./questions.js";
import { codexErrorRecord } from "./errors.js";
import type { HistoryRecord } from "../../acquisition/types.js";
import { CodexLineageError, codexThreadMetadata, identity, proveCodexLineage, record, type CodexThreadMetadata } from "./lineage.js";

export { CodexLineageError, proveCodexLineage, type CodexLineageProof } from "./lineage.js";
export { codexOptionalQuestions, type CodexOptionalQuestion, type CodexOptionalQuestions } from "./questions.js";
export { codexErrorRow, type CodexErrorRow } from "./errors.js";

export interface CodexCodecLimits {
  readonly maxThreads: number;
  readonly maxItems: number;
  readonly maxBufferedEvents: number;
  readonly maxBufferedBytes: number;
  readonly maxTextBytes: number;
  readonly maxSegments: number;
  readonly maxTurns: number;
}
const defaults: CodexCodecLimits = {
  maxThreads: 32, maxItems: 512, maxBufferedEvents: 64, maxBufferedBytes: 65_536,
  maxTextBytes: 65_536, maxSegments: 32, maxTurns: 256,
};
const utf8 = new TextEncoder();
// These native service/account notifications have no transcript payload and
// may have a null or absent threadId. Their own domain owners still consume
// them; history must classify them before requiring a transcript scope.
const serviceNotifications = new Set([
  "account/updated", "account/rateLimits/updated", "account/login/completed", "account/gatewayOAuth/changed",
  "skills/changed", "app/list/updated", "mcpServer/startupStatus/updated", "mcpServer/oauthLogin/completed",
]);
type Segment = { readonly channel: string; readonly index?: number; readonly text?: string | null };
type Item = {
  readonly id: string; readonly type: string; readonly kind: RowKind;
  readonly segments: readonly Segment[]; readonly native: Readonly<Record<string, Json>>;
  readonly lifecycle: Exclude<Lifecycle, "running">;
  readonly childStart?: string;
};
type Event =
  | { readonly type: "thread"; readonly threadId: string; readonly metadata: CodexThreadMetadata }
  | { readonly type: "turn"; readonly threadId: string; readonly turnId: string; readonly status: string; readonly error?: HistoryRecord }
  | { readonly type: "error"; readonly threadId: string; readonly error: HistoryRecord }
  | { readonly type: "item"; readonly threadId: string; readonly turnId: string; readonly completed: boolean; readonly item: Item }
  | { readonly type: "delta"; readonly threadId: string; readonly turnId: string; readonly itemId: string;
      readonly nativeType: string; readonly kind: RowKind; readonly channel: string; readonly index?: number; readonly text: string }
  | { readonly type: "part"; readonly threadId: string; readonly turnId: string; readonly itemId: string; readonly index: number }
  | { readonly type: "status"; readonly threadId: string; readonly status: string }
  | { readonly type: "closed"; readonly threadId: string }
  | { readonly type: "readBoundary"; readonly threadId: string; readonly turnId: string }
  | { readonly type: "revert"; readonly threadId: string };
type SegmentState = { readonly id: string; readonly channel: string; readonly index?: number; hasText: boolean };
type Tracked = {
  readonly key: string; readonly turnId: string; readonly nativeItemId: string; readonly nativeType: string; readonly kind: RowKind;
  readonly segments: Map<string, SegmentState>; anchored: boolean; completed: boolean; finalSignature?: string;
};
type LiveOwnership = { readonly kind: "root" }
  | { readonly kind: "threadStarted"; readonly parentThreadId: string }
  | { readonly kind: "parentActivity"; readonly parentThreadId: string; readonly activityItemId: string };
type Thread = {
  readonly scope: CodexScope; readonly items: Map<string, Tracked>; readonly completedTurns: Set<string>;
  readonly ownership: LiveOwnership; metadata?: CodexThreadMetadata; activeTurn: string | null; closed: boolean;
};

/** Segment identity deliberately preserves reasoning channel/index, not a flattened string. */
export function codexRowId(threadId: string, turnId: string, itemId: string, channel = "body", index?: number): string {
  const id = `codex:${JSON.stringify([threadId, turnId, itemId, channel, index ?? null])}`;
  if (id.length > 3_800) throw new TypeError("CODEX_ROW_ID_BOUND_EXCEEDED");
  return id;
}

/**
 * Scripted native-notification codec. No native SDK/process/file/endpoint reads.
 * `knownStart` is the caller's proved-empty-capture assertion, never inferred
 * from first mount. Cold lineage proofs do not grant this codec live ownership.
 * Live children require a validated thread/started chain or an owned parent's
 * explicit live subAgentActivity(started) reference. The latter proves routing
 * ownership only: it supplies no native session/context or cold-history proof.
 */
export class CodexCodec implements NativeCodec {
  readonly #capture: CapturePort;
  readonly #origin: Origin;
  readonly #root: Thread;
  readonly #limits: CodexCodecLimits;
  readonly #media: NativeMediaHandler | undefined;
  readonly #threads = new Map<string, Thread>();
  readonly #blocked = new Set<string>();
  readonly #buffer: Array<{ event: Event; bytes: number }> = [];
  #bufferedBytes = 0;
  #rejected = 0;
  #captureFailure: unknown;

  constructor(options: Readonly<{
    origin: Origin; rootThreadId: string; capture: CapturePort;
    limits?: Partial<CodexCodecLimits>; knownStart?: boolean;
    media?: NativeMediaHandler;
  }>) {
    if (!identity(options.rootThreadId) || options.origin.nativeSession !== options.rootThreadId ||
        Object.values(options.origin).some(value => !identity(value))) throw new TypeError("CODEX_SCOPE_INVALID");
    this.#limits = { ...defaults, ...options.limits };
    this.#media = options.media;
    for (const value of Object.values(this.#limits)) if (!Number.isSafeInteger(value) || value < 1 || value > 1_048_576)
      throw new RangeError("CODEX_LIMIT_INVALID");
    if (this.#limits.maxSegments > 32 || this.#limits.maxTextBytes > 65_536) throw new RangeError("CODEX_LIMIT_INVALID");
    // Port rejection is a visible capture failure, not malformed native input.
    // Stop this reducer until its owner explicitly re-establishes capture;
    // never continue from codec state whose transaction the Host rejected.
    const call = (run: () => void): void => { try { run(); } catch (error) { this.#captureFailure = error; throw error; } };
    this.#capture = {
      open: (scope, input) => call(() => options.capture.open(scope, input)),
      emit: (scope, actions) => call(() => options.capture.emit(scope, actions)),
      reset: (scope, reason) => call(() => options.capture.reset(scope, reason)),
    };
    this.#origin = Object.freeze({ ...options.origin });
    this.#root = this.#makeThread(options.rootThreadId, { kind: "root" });
    this.#threads.set(options.rootThreadId, this.#root);
    this.#capture.open(this.#root.scope, { knownStart: options.knownStart === true });
  }

  observe(value: unknown): void {
    if (this.#captureFailure !== undefined) throw this.#captureFailure;
    const message = record(value);
    // RPC responses and reverse requests are owned elsewhere, never history.
    if (!message || Object.hasOwn(message, "id")) return;
    const params = record(message.params), method = identity(message.method);
    if (!method || !params) { this.#reject(this.#root, "envelope"); return; }
    if (serviceNotifications.has(method)) return;
    const rawThread = method === "thread/started" ? record(params.thread)?.id : params.threadId;
    const threadId = identity(rawThread);
    if (!threadId) { this.#reject(this.#root, "scope"); return; }
    const owner = this.#threads.get(threadId);
    if (owner?.closed) return;
    if (this.#blocked.has(threadId)) { this.#reject(this.#root, "retiredLiveAncestry", "nativeGap"); return; }
    let event: Event | undefined;
    try { event = this.#decode(method, params, threadId); }
    catch {
      const turnId = identity(params.turnId), itemId = identity(params.itemId) ?? identity(record(params.item)?.id);
      const item = owner && turnId && itemId ? owner.items.get(JSON.stringify([turnId, itemId])) : undefined;
      // A rejected chunk breaks that accumulator's chain. A later nullable
      // completion cannot promote the bytes we happened to retain to complete.
      if (owner && item && !item.completed) {
        item.anchored = false;
        this.#rejected++;
        this.#capture.emit(owner.scope, [...item.segments.values()].map(segment => ({ type: "gap",
          gap: { id: `nativeGap:${segment.id}`, kind: "nativeGap", rowId: segment.id } })));
      } else this.#reject(owner ?? this.#root, "invalidNativeEvent");
      return;
    }
    if (!event) return;
    if (event.type === "thread") {
      let authorized: boolean;
      try { authorized = this.#authorize(event); }
      catch (error) {
        if (!(error instanceof CodexLineageError)) throw error;
        this.#reject(this.#root, "unverifiedLiveAncestry", "nativeGap"); return;
      }
      if (authorized) this.#drain(); else this.#enqueue(event);
    } else if (owner) { this.#apply(owner, event); if (this.#buffer.length) this.#drain(); }
    else this.#enqueue(event);
  }

  diagnostics(): Readonly<{ bufferedEvents: number; bufferedBytes: number; authorizedThreads: number; trackedItems: number; rejected: number }> {
    return { bufferedEvents: this.#buffer.length, bufferedBytes: this.#bufferedBytes,
      authorizedThreads: this.#threads.size, trackedItems: [...this.#threads.values()].reduce((sum, thread) => sum + thread.items.size, 0), rejected: this.#rejected };
  }

  /** Live routing evidence is deliberately separate from native context metadata. */
  threadOwnership(threadId: string): Readonly<{ ownership: LiveOwnership; nativeContext?: string }> | undefined {
    const thread = this.#threads.get(threadId);
    return thread && Object.freeze({ ownership: thread.ownership, ...(thread.metadata ? { nativeContext: thread.metadata.context } : {}) });
  }

  #makeThread(id: string, ownership: LiveOwnership, metadata?: CodexThreadMetadata): Thread {
    return { ownership: Object.freeze(ownership), ...(metadata ? { metadata } : {}), scope: Object.freeze({ kind: "codex", origin: this.#origin, threadId: id }),
      items: new Map(), completedTurns: new Set(), activeTurn: null, closed: false };
  }
  #reject(thread: Thread, key: string, kind: "unsupported" | "nativeGap" | "truncated" = "unsupported"): void {
    this.#rejected++;
    this.#capture.emit(thread.scope, [{ type: "gap", gap: { id: `codex:${key}`, kind } }]);
  }
  #gap(thread: Thread, kind: "missingPrefix" | "missingFinal" | "identity", rowId: string): Action {
    return { type: "gap", gap: { id: `${kind}:${rowId}`, kind, rowId } };
  }
  #clear(rowId: string): Action[] {
    return ["missingPrefix", "missingFinal", "nativeGap"].map(kind => ({ type: "clearGap", id: `${kind}:${rowId}` }));
  }
  #text(value: unknown): string {
    if (typeof value !== "string" || value.length > this.#limits.maxTextBytes || utf8.encode(value).byteLength > this.#limits.maxTextBytes)
      throw new TypeError("CODEX_TEXT_BOUND_EXCEEDED");
    return value;
  }
  #index(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= this.#limits.maxSegments)
      throw new TypeError("CODEX_INDEX_INVALID");
    return value as number;
  }
  #decode(method: string, params: Record<string, unknown>, threadId: string): Event | undefined {
    if (method === "thread/started") return { type: "thread", threadId, metadata: codexThreadMetadata(params.thread) };
    if (method === "thread/reverted") return { type: "revert", threadId };
    if (method === "thread/closed") return { type: "closed", threadId };
    if (method === "thread/compacted") {
      const turnId = identity(params.turnId); if (!turnId) throw new TypeError("CODEX_COMPACTION_ID");
      return { type: "readBoundary", threadId, turnId };
    }
    if (method === "thread/status/changed") {
      const status = record(params.status)?.type;
      if (!["idle", "active", "notLoaded", "systemError"].includes(String(status))) throw new TypeError("CODEX_STATUS_INVALID");
      return { type: "status", threadId, status: status as string };
    }
    if (method === "turn/started" || method === "turn/completed") {
      const turn = record(params.turn), turnId = identity(turn?.id), status = turn?.status;
      if (!turnId || (method === "turn/started" ? status !== "inProgress" : !["completed", "failed", "interrupted"].includes(String(status))))
        throw new TypeError("CODEX_TURN_INVALID");
      return { type: "turn", threadId, turnId, status: status as string,
        ...(turn?.error == null ? {} : { error: codexErrorRecord(threadId, turnId, turn.error, false) }) };
    }
    const turnId = identity(params.turnId);
    if (method === "error") {
      // Retain the diagnostic without finishing the turn. Retry/failure
      // attention still belongs to the native controller.
      const error = record(params.error);
      if (!turnId || typeof params.willRetry !== "boolean" || !error || typeof error.message !== "string" ||
          Object.keys(params).some(key => !["threadId", "turnId", "willRetry", "error"].includes(key)) ||
          utf8.encode(canonical(error)).byteLength > this.#limits.maxBufferedBytes)
        throw new TypeError("CODEX_ERROR_NOTIFICATION_INVALID");
      return { type: "error", threadId, error: codexErrorRecord(threadId, turnId, error, params.willRetry) };
    }
    if (method === "turn/moderationMetadata") {
      // Native .162.1 emits this JSON sideband independently of transcript
      // bytes. Validate its declared envelope; it establishes no body, turn
      // outcome or permission fact and must not manufacture a history gap.
      if (!turnId || !Object.hasOwn(params, "metadata") ||
          Object.keys(params).some(key => !["threadId", "turnId", "metadata"].includes(key)) ||
          utf8.encode(canonical(params.metadata)).byteLength > this.#limits.maxBufferedBytes)
        throw new TypeError("CODEX_MODERATION_METADATA_INVALID");
      return undefined;
    }
    if (method === "item/started" || method === "item/completed") {
      if (!turnId) throw new TypeError("CODEX_TURN_INVALID");
      const item = this.#item(params.item, method === "item/completed", threadId, turnId);
      for (const segment of item.segments) codexRowId(threadId, turnId, item.id, segment.channel, segment.index);
      return { type: "item", threadId, turnId, completed: method === "item/completed", item };
    }
    const delta = method === "item/agentMessage/delta" ? ["agentMessage", "assistant", "body"] as const
      : method === "item/plan/delta" ? ["plan", "assistant", "body"] as const
      : method === "item/commandExecution/outputDelta" ? ["commandExecution", "tool", "body"] as const
      : method === "item/reasoning/summaryTextDelta" ? ["reasoning", "reasoning", "summary"] as const
      : method === "item/reasoning/textDelta" ? ["reasoning", "reasoning", "content"] as const : undefined;
    if (delta) {
      const itemId = identity(params.itemId);
      if (!turnId || !itemId) throw new TypeError("CODEX_ITEM_INVALID");
      const index = delta[2] === "summary" ? this.#index(params.summaryIndex) : delta[2] === "content" ? this.#index(params.contentIndex) : undefined;
      codexRowId(threadId, turnId, itemId, delta[2], index);
      return { type: "delta", threadId, turnId, itemId, nativeType: delta[0], kind: delta[1], channel: delta[2],
        ...(index !== undefined ? { index } : {}), text: this.#text(params.delta) };
    }
    if (method === "item/reasoning/summaryPartAdded") {
      const itemId = identity(params.itemId);
      if (!turnId || !itemId) throw new TypeError("CODEX_ITEM_INVALID");
      const index = this.#index(params.summaryIndex); codexRowId(threadId, turnId, itemId, "summary", index);
      return { type: "part", threadId, turnId, itemId, index };
    }
    // Non-transcript notifications and actual callbacks are not reducer inputs.
    if (["thread/settings/updated", "thread/tokenUsage/updated", "thread/goal/updated", "thread/goal/cleared",
      "serverRequest/resolved", "item/mcpToolCall/progress", "item/commandExecution/terminalInteraction"].includes(method)) return undefined;
    throw new TypeError("CODEX_NOTIFICATION_UNSUPPORTED");
  }
  #item(value: unknown, completed: boolean, threadId: string, turnId: string): Item {
    const item = record(value), id = identity(item?.id), type = identity(item?.type);
    if (!item || !id || !type) throw new TypeError("CODEX_ITEM_INVALID");
    const native: Record<string, Json> = { nativeItemId: id, type };
    for (const key of ["phase", "command", "processId", "server", "tool", "name", "namespace", "status", "clientId"])
      if (item[key] === null) native[key] = null;
      else if (item[key] !== undefined) native[key] = this.#text(item[key]);
    if (typeof item.exitCode === "number" && Number.isSafeInteger(item.exitCode)) native.exitCode = item.exitCode;
    // The pinned image-generation status is an arbitrary native string.
    // Only the actual item completion callback certifies its lifecycle.
    const generation = type === "imageGeneration" || type === "image_generation_call";
    const status = generation ? undefined : item.status;
    if (status !== undefined && !["inProgress", "completed", "failed", "declined", "interrupted"].includes(String(status))) throw new TypeError("CODEX_ITEM_STATUS_INVALID");
    if (completed && status === "inProgress") throw new TypeError("CODEX_ITEM_STATUS_INVALID");
    const lifecycle = status === "failed" ? "failed" : status === "declined" || status === "interrupted" ? "interrupted" : "completed";
    const nullable = (raw: unknown): string | null | undefined => raw === null || raw === undefined ? raw : this.#text(raw);
    let kind: RowKind, segments: Segment[], childStart: string | undefined;
    if (type === "agentMessage" || type === "plan") {
      kind = "assistant"; segments = [{ channel: "body", text: this.#text(item.text) }];
      if (type === "agentMessage") {
        if (item.delivery === "async") native.delivery = "async";
        if (item.questions != null) {
          Object.assign(native, codexOptionalQuestionMetadata(item.questions, { ...native, threadId, turnId, channel: "body" }));
        }
      }
    } else if (type === "commandExecution") {
      kind = "tool"; const text = nullable(item.aggregatedOutput); segments = [{ channel: "body", ...(text !== undefined ? { text } : {}) }];
    } else if (type === "reasoning") {
      kind = "reasoning"; segments = [];
      for (const channel of ["summary", "content"]) {
        const parts = item[channel];
        if (!Array.isArray(parts) || parts.length > this.#limits.maxSegments) throw new TypeError("CODEX_REASONING_INVALID");
        parts.forEach((part, index) => segments.push({ channel, index, text: this.#text(part) }));
      }
    } else if (["userMessage", "message", "functionCallOutput", "function_call_output", "custom_tool_call_output", "mcpToolCall", "dynamicToolCall", "imageView", "imageGeneration", "image_generation_call"].includes(type)) {
      kind = type === "userMessage" ? "user" : type === "message" ? "assistant" : "tool";
      const normalized = codexMediaItem(item, JSON.stringify([threadId, turnId, id]), this.#threads.get(threadId)?.scope, generation && !completed ? undefined : this.#media);
      if (normalized.media.length) native.media = normalized.media as unknown as Json;
      if (normalized.unsupported) native.mediaUnsupported = true;
      const content = type === "mcpToolCall" ? record(item.result)?.content : type === "dynamicToolCall" ? item.contentItems
        : ["functionCallOutput", "function_call_output", "custom_tool_call_output"].includes(type) ? item.output : item.content;
      if (content == null) segments = [{ channel: "body", text: null }];
      else if (typeof content === "string") segments = [{ channel: "body", text: this.#text(content) }];
      else {
        if (!Array.isArray(content) || content.length > this.#limits.maxSegments) throw new TypeError("CODEX_CONTENT_INVALID");
        const textTypes = type === "dynamicToolCall" ? ["inputText"] : type === "message" || type.includes("output") || type === "functionCallOutput" ? ["input_text", "output_text"] : ["text"];
        const text = content.filter(raw => textTypes.includes(String(record(raw)?.type))).map(raw => this.#text(record(raw)?.text)).join("\n");
        segments = [{ channel: "body", text: normalized.unsupported && !text ? null : this.#text(text) }];
      }
    } else if (type === "subAgentActivity" || type === "collabAgentToolCall") {
      // These are metadata records, not empty native text bodies. Runtime
      // .162.1 adds nullable model/effort to the checked-in activity schema;
      // preserve only the supplied selection evidence, never inherit a model.
      kind = "tool"; segments = [{ channel: "body", text: null }];
      for (const key of ["model", "reasoningEffort"])
        if (item[key] !== undefined) native[key] = item[key] === null ? null : this.#text(item[key]);
      if (type === "subAgentActivity") {
        const child = identity(item.agentThreadId);
        if (!child || !["started", "interacted", "interrupted", "completed"].includes(String(item.kind)))
          throw new TypeError("CODEX_ACTIVITY_INVALID");
        native.agentThreadId = child; native.activityKind = item.kind as string;
        native.agentPath = this.#text(item.agentPath);
        if (item.kind === "started") childStart = child;
      } else {
        if (item.senderThreadId !== threadId || !["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent",
          "sendMessage", "followupTask", "interruptAgent", "listAgents"].includes(String(item.tool)) ||
          !Array.isArray(item.receiverThreadIds) || item.receiverThreadIds.length > this.#limits.maxThreads)
          throw new TypeError("CODEX_COLLAB_INVALID");
        native.senderThreadId = threadId;
        native.receiverThreadIds = item.receiverThreadIds.map(raw => {
          const receiver = identity(raw); if (!receiver) throw new TypeError("CODEX_COLLAB_INVALID"); return receiver;
        });
        if (item.prompt !== undefined) native.prompt = item.prompt === null ? null : this.#text(item.prompt);
        // Bounded JSON evidence only; no state references grant child capture.
        if (!record(item.agentsStates) || utf8.encode(canonical(item.agentsStates)).byteLength > 4_096)
          throw new TypeError("CODEX_COLLAB_INVALID");
        native.agentsStates = JSON.parse(canonical(item.agentsStates)) as Json;
      }
    } else if (type === "contextCompaction") {
      kind = "notice"; segments = [{ channel: "body", text: null }];
    } else throw new TypeError("CODEX_ITEM_TYPE_UNSUPPORTED");
    if (segments.length > this.#limits.maxSegments || JSON.stringify(native).length > 8_192 ||
        segments.reduce((bytes, segment) => bytes + (typeof segment.text === "string" ? utf8.encode(segment.text).byteLength : 0), 0) > this.#limits.maxTextBytes)
      throw new TypeError("CODEX_ITEM_BOUND_EXCEEDED");
    return { id, type, kind, segments, native, lifecycle, ...(childStart ? { childStart } : {}) };
  }

  #enqueue(event: Event): void {
    const bytes = utf8.encode(JSON.stringify(event)).byteLength;
    if (this.#buffer.length >= this.#limits.maxBufferedEvents || this.#bufferedBytes + bytes > this.#limits.maxBufferedBytes) {
      this.#reject(this.#root, "unownedBufferCapacity", "nativeGap"); return;
    }
    this.#buffer.push({ event, bytes }); this.#bufferedBytes += bytes;
    this.#capture.emit(this.#root.scope, [{ type: "gap", gap: { id: "codex:unownedEvents", kind: "nativeGap" } }]);
  }
  #authorize(event: Extract<Event, { type: "thread" }>): boolean {
    if (this.#blocked.has(event.threadId)) return true;
    if (event.threadId === this.#root.scope.threadId) {
      this.#root.metadata = event.metadata;
      this.#capture.open(this.#root.scope, { ...(event.metadata.native ? { native: event.metadata.native } : {}) }); return true;
    }
    const existing = this.#threads.get(event.threadId);
    if (existing) {
      if (existing.ownership.kind === "root" || existing.ownership.parentThreadId !== event.metadata.parent ||
          (existing.metadata && existing.metadata.context !== event.metadata.context)) this.#quarantine(event.threadId);
      else {
        try { this.#validateContext(event.metadata); }
        catch (error) {
          // A first native context can contradict an earlier activity-only
          // grant. That contradiction revokes routing, just as a later native
          // context change does; a gap alone must not leave the child live.
          if (error instanceof CodexLineageError) this.#quarantine(event.threadId);
          throw error;
        }
        existing.metadata = event.metadata;
        this.#capture.open(existing.scope, { ...(event.metadata.native ? { native: event.metadata.native } : {}) });
      }
      return true;
    }
    const parent = event.metadata.parent && this.#threads.get(event.metadata.parent);
    if (!parent || parent.closed) return false;
    if (this.#threads.size + this.#blocked.size >= this.#limits.maxThreads) { this.#reject(this.#root, "threadCapacity", "nativeGap"); return true; }
    this.#validateContext(event.metadata);
    const child = this.#makeThread(event.threadId, { kind: "threadStarted", parentThreadId: parent.scope.threadId }, event.metadata);
    this.#threads.set(event.threadId, child);
    // A late child announcement does not prove its prior prefix was captured.
    this.#capture.open(child.scope, { knownStart: false, ...(event.metadata.native ? { native: event.metadata.native } : {}) });
    return true;
  }
  #ancestors(parent: Thread): Thread[] {
    const chain: Thread[] = [], seen = new Set<string>(); let current = parent;
    for (;;) {
      if (seen.has(current.scope.threadId) || chain.length >= 32) throw new CodexLineageError();
      seen.add(current.scope.threadId); chain.push(current);
      if (current.ownership.kind === "root") return chain;
      const next = this.#threads.get(current.ownership.parentThreadId);
      if (!next) throw new CodexLineageError(); current = next;
    }
  }
  #validateContext(metadata: CodexThreadMetadata): void {
    const parent = metadata.parent && this.#threads.get(metadata.parent);
    if (!parent) throw new CodexLineageError();
    const chain = this.#ancestors(parent);
    // Actual ancestor IDs plus actually supplied contexts are admissible;
    // an activity grant never fabricates the ancestor's native sessionId.
    const contexts = new Set([metadata.id, ...chain.map(thread => thread.scope.threadId),
      ...chain.flatMap(thread => thread.metadata ? [thread.metadata.context] : [])]);
    if (!contexts.has(metadata.context)) throw new CodexLineageError();
  }
  #quarantine(id: string): void {
    const affected = new Set([id]); let changed = true;
    while (changed) {
      changed = false;
      for (const thread of this.#threads.values()) if (thread.ownership.kind !== "root" &&
          affected.has(thread.ownership.parentThreadId) && !affected.has(thread.scope.threadId)) {
        affected.add(thread.scope.threadId); changed = true;
      }
    }
    for (const target of affected) {
      const thread = this.#threads.get(target); if (!thread || thread === this.#root) continue;
      this.#blocked.add(target); this.#threads.delete(target);
      this.#capture.reset(thread.scope, "codex:changedLiveAncestry");
      this.#reject(thread, "changedLiveAncestry", "nativeGap");
    }
  }
  #grantActivity(parent: Thread, childId: string, activityItemId: string): void {
    if (this.#blocked.has(childId)) return;
    if (childId === this.#root.scope.threadId || childId === parent.scope.threadId) {
      this.#reject(parent, "conflictingActivityOwner", "nativeGap"); return;
    }
    const existing = this.#threads.get(childId);
    if (existing) {
      if (existing.ownership.kind === "root" || existing.ownership.parentThreadId !== parent.scope.threadId) {
        this.#quarantine(childId); this.#reject(parent, "conflictingActivityOwner", "nativeGap");
      }
      return;
    }
    // Quarantine moves an admitted identity into a retained fence. It does not
    // free admission capacity or allow unbounded replacement identities.
    if (this.#threads.size + this.#blocked.size >= this.#limits.maxThreads) { this.#reject(parent, "threadCapacity", "nativeGap"); return; }
    try { this.#ancestors(parent); } catch (error) {
      if (!(error instanceof CodexLineageError)) throw error;
      this.#reject(parent, "unverifiedActivityOwner", "nativeGap"); return;
    }
    const child = this.#makeThread(childId, { kind: "parentActivity", parentThreadId: parent.scope.threadId, activityItemId });
    this.#threads.set(childId, child); this.#capture.open(child.scope, { knownStart: false });
  }
  #drain(): void {
    let progress = true;
    while (progress) {
      progress = false;
      for (let index = 0; index < this.#buffer.length;) {
        const buffered = this.#buffer[index]!;
        const owner = this.#threads.get(buffered.event.threadId);
        let ready = this.#blocked.has(buffered.event.threadId) || !!owner;
        try { if (buffered.event.type === "thread") ready = this.#authorize(buffered.event); }
        catch (error) {
          if (!(error instanceof CodexLineageError)) throw error;
          this.#reject(this.#root, "unverifiedBufferedAncestry", "nativeGap"); ready = true;
        }
        if (ready) {
          this.#buffer.splice(index, 1); this.#bufferedBytes -= buffered.bytes; progress = true;
          if (buffered.event.type !== "thread" && owner) this.#apply(owner, buffered.event);
        } else index++;
      }
    }
    if (!this.#buffer.length) this.#capture.emit(this.#root.scope, [{ type: "clearGap", id: "codex:unownedEvents" }]);
  }
  #tracked(thread: Thread, turnId: string, itemId: string, type: string, kind: RowKind, anchored: boolean): Tracked | undefined {
    const key = JSON.stringify([turnId, itemId]), old = thread.items.get(key);
    if (old) {
      if (old.nativeType !== type) { this.#capture.emit(thread.scope, [this.#gap(thread, "identity", codexRowId(thread.scope.threadId, turnId, itemId))]); return undefined; }
      return old;
    }
    // Completed accumulators are a recent duplicate cache, not a lifetime
    // message quota. Terminal row evidence belongs to the history owner. Keep
    // unfinished items, including their exact prefix/segment state, resident.
    if (this.diagnostics().trackedItems >= this.#limits.maxItems) {
      for (const owner of this.#threads.values()) {
        const released = [...owner.items.values()].find(item => item.completed || owner.completedTurns.has(item.turnId));
        if (released) { owner.items.delete(released.key); break; }
      }
      if (this.diagnostics().trackedItems >= this.#limits.maxItems) { this.#reject(thread, "itemCapacity", "nativeGap"); return undefined; }
    }
    const item: Tracked = { key, turnId, nativeItemId: itemId, nativeType: type, kind,
      segments: new Map(), anchored, completed: false };
    thread.items.set(key, item); return item;
  }
  #segment(thread: Thread, item: Tracked, segment: Segment): { state: SegmentState; fresh: boolean } | undefined {
    const key = JSON.stringify([segment.channel, segment.index ?? null]), existing = item.segments.get(key);
    if (existing) return { state: existing, fresh: false };
    if (item.segments.size >= this.#limits.maxSegments) { this.#reject(thread, "segmentCapacity", "truncated"); return undefined; }
    const state: SegmentState = { id: codexRowId(thread.scope.threadId, item.turnId, item.nativeItemId, segment.channel, segment.index),
      channel: segment.channel, ...(segment.index !== undefined ? { index: segment.index } : {}), hasText: typeof segment.text === "string" };
    item.segments.set(key, state); return { state, fresh: true };
  }
  #native(thread: Thread, item: Tracked, segment: SegmentState, extra: Readonly<Record<string, Json>> = {}): Readonly<Record<string, Json>> {
    return { ...extra, threadId: thread.scope.threadId, turnId: item.turnId, nativeItemId: item.nativeItemId,
      type: item.nativeType, channel: segment.channel, ...(segment.index !== undefined ? { index: segment.index } : {}) };
  }
  #apply(thread: Thread, event: Exclude<Event, { type: "thread" }>): void {
    const actions: Action[] = [];
    const diagnostic = (row: HistoryRecord) => {
      actions.push({ type: "finish", id: row.id, kind: row.kind, lifecycle: "completed",
        text: row.body.kind === "unavailable" ? null : row.body.text, native: row.native });
    };
    if (event.type === "revert") {
      thread.items.clear(); thread.completedTurns.clear(); thread.activeTurn = null;
      this.#capture.reset(thread.scope, "codex:thread/reverted"); return;
    }
    if (event.type === "readBoundary") {
      // The deprecated notification has no item ID. When the modern completion
      // was observed, reuse its exact fact rather than rotating it twice. A new
      // item in the same turn remains a distinct positive edit.
      const completed = [...thread.items.values()].filter(item => item.turnId === event.turnId && item.nativeType === "contextCompaction" && item.completed).at(-1);
      actions.push({ type: "readBoundary", factId: JSON.stringify(["codex", thread.scope.threadId, event.turnId, completed?.nativeItemId ?? "deprecated"]), reason: "Native compaction changed the history read boundary" });
    } else if (event.type === "closed") {
      thread.closed = true;
      actions.push({ type: "activity", activity: { turnId: thread.activeTurn, state: "unknown" } },
        { type: "gap", gap: { id: "codex:nativeThreadClosed", kind: "nativeGap" } });
      for (const item of thread.items.values()) if (!item.completed) {
        item.anchored = false;
        for (const segment of item.segments.values()) actions.push({ type: "gap",
          gap: { id: `nativeGap:${segment.id}`, kind: "nativeGap", rowId: segment.id } });
      }
    } else if (event.type === "status") {
      this.#capture.open(thread.scope, { native: { ...thread.metadata?.native, status: event.status as "idle" | "active" | "notLoaded" | "systemError" } });
      if (event.status === "notLoaded") return;
      if (event.status === "active") actions.push({ type: "activity", activity: { turnId: thread.activeTurn, state: "working" } });
      else if (event.status === "systemError") actions.push({ type: "activity", activity: { turnId: thread.activeTurn, state: "failed" } });
      else if (!thread.activeTurn) actions.push({ type: "activity", activity: { turnId: null, state: "idle" } });
    } else if (event.type === "error") {
      diagnostic(event.error);
    } else if (event.type === "turn") {
      if (event.error) diagnostic(event.error);
      if (event.status === "inProgress") {
        if (thread.completedTurns.has(event.turnId)) return;
        thread.activeTurn = event.turnId; actions.push({ type: "activity", activity: { turnId: event.turnId, state: "working" } });
      } else {
        // Retain recent duplicate fences without refusing a new positive turn
        // completion merely because the session has been used for a long time.
        if (thread.completedTurns.size >= this.#limits.maxTurns && !thread.completedTurns.has(event.turnId)) {
          const retired = thread.completedTurns.values().next().value!;
          for (const [key, item] of thread.items) if (item.turnId === retired) thread.items.delete(key);
          thread.completedTurns.delete(retired);
        }
        thread.completedTurns.add(event.turnId);
        for (const item of thread.items.values()) if (item.turnId === event.turnId && !item.completed)
          for (const segment of item.segments.values()) actions.push(
            { type: "finish", id: segment.id, kind: item.kind, lifecycle: event.status as "completed" | "failed" | "interrupted", text: null },
            this.#gap(thread, "missingFinal", segment.id));
        if (!thread.activeTurn || thread.activeTurn === event.turnId) {
          thread.activeTurn = null;
          actions.push({ type: "activity", activity: { turnId: event.turnId, state: event.status === "failed" ? "failed" : "idle" } });
        }
      }
    } else if (event.type === "item") {
      if (!event.completed && thread.completedTurns.has(event.turnId)) return;
      const item = this.#tracked(thread, event.turnId, event.item.id, event.item.type, event.item.kind, !event.completed);
      if (!item) return;
      const signature = JSON.stringify({ ...event.item, native: { ...event.item.native,
        ...(Array.isArray(event.item.native.media) ? { media: mediaMeaning(event.item.native.media as unknown as NativeMediaOccurrence[]) } : {}) } });
      if (item.completed) {
        if (event.completed && item.finalSignature !== signature) this.#reject(thread, "conflictingFinal", "nativeGap");
        return;
      }
      if (event.completed) { item.completed = true; item.finalSignature = signature; }
      if (event.completed && item.nativeType === "contextCompaction")
        actions.push({ type: "readBoundary", factId: JSON.stringify(["codex", thread.scope.threadId, event.turnId, item.nativeItemId]), reason: "Native compaction changed the history read boundary" });
      const provided = new Set<string>();
      for (const segment of event.item.segments) {
        const tracked = this.#segment(thread, item, segment);
        if (!tracked) continue;
        const state = tracked.state; provided.add(state.id);
        if (typeof segment.text === "string") state.hasText = true;
        if (event.completed) {
          const sealCaptured = item.nativeType !== "commandExecution" && item.anchored && state.hasText;
          actions.push({ type: "finish", id: state.id, kind: item.kind, lifecycle: event.item.lifecycle,
            ...(segment.text !== undefined ? { text: segment.text } : {}), sealCaptured,
            native: this.#native(thread, item, state, event.item.native) });
          if (typeof segment.text === "string" || sealCaptured) actions.push(...this.#clear(state.id));
        } else if (tracked.fresh) {
          actions.push({ type: "start", id: state.id, kind: item.kind,
            ...(typeof segment.text === "string" || (segment.text === null &&
              ["subAgentActivity", "collabAgentToolCall", "imageView", "imageGeneration", "image_generation_call"].includes(item.nativeType)) ? { text: segment.text } : {}),
            native: this.#native(thread, item, state, event.item.native) });
          // Observed .162.1 command callbacks can omit startup output even when
          // item/started preceded execution. A raw delta chain has no proved
          // prefix; only an explicitly supplied full aggregate can heal it.
          if (item.nativeType === "commandExecution") actions.push(this.#gap(thread, "missingPrefix", state.id));
        }
      }
      if (event.completed) for (const state of item.segments.values()) if (!provided.has(state.id)) actions.push({ type: "finish",
        id: state.id, kind: item.kind, lifecycle: event.item.lifecycle, text: null,
        sealCaptured: item.nativeType !== "commandExecution" && item.anchored && state.hasText });
      if (event.completed && ["imageView", "imageGeneration", "image_generation_call"].includes(item.nativeType))
        for (const state of item.segments.values()) actions.push(...this.#clear(state.id));
      if (event.item.native.mediaUnsupported) for (const state of item.segments.values()) actions.push({ type: "gap",
        gap: { id: `unsupportedMedia:${state.id}`, kind: "unsupported", rowId: state.id } });
    } else {
      if (thread.completedTurns.has(event.turnId)) return;
      const type = event.type === "part" ? "reasoning" : event.nativeType, kind = event.type === "part" ? "reasoning" : event.kind;
      const item = this.#tracked(thread, event.turnId, event.itemId, type, kind, false);
      if (!item || item.completed) return;
      const segment = this.#segment(thread, item, { channel: event.type === "part" ? "summary" : event.channel,
        ...(event.index !== undefined ? { index: event.index } : {}) });
      if (!segment) return;
      if (item.nativeType === "commandExecution" && event.type === "delta") {
        // An orphan command suffix remains useful as labelled partial output;
        // unlike assistant text it is never offered as a proved full prefix.
        segment.state.hasText = true;
        actions.push({ type: "append", id: segment.state.id, kind: item.kind, text: event.text,
          channel: `${segment.state.channel}:${segment.state.index ?? 0}` },
          this.#gap(thread, "missingPrefix", segment.state.id));
      } else if (!item.anchored) actions.push(this.#gap(thread, "missingPrefix", segment.state.id));
      else {
        if (segment.fresh) actions.push({ type: "start", id: segment.state.id, kind: item.kind, text: "", native: this.#native(thread, item, segment.state) });
        if (event.type === "delta") {
          segment.state.hasText = true;
          actions.push({ type: "append", id: segment.state.id, kind: item.kind, text: event.text,
            channel: `${segment.state.channel}:${segment.state.index ?? 0}` });
        }
      }
    }
    if (actions.length) this.#capture.emit(thread.scope, actions);
    if (event.type === "item" && event.item.childStart) this.#grantActivity(thread, event.item.childStart, event.item.id);
  }
}

export function createCodexCodec(options: ConstructorParameters<typeof CodexCodec>[0]): CodexCodec {
  return new CodexCodec(options);
}
