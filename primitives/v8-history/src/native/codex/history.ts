import type { AcquisitionBatch, AcquisitionPort, AcquisitionRequest, HistoryRecord } from "../../acquisition/types.js";
import type { Body, CapturedScope, CodexScope, Gap, Json, RowKind } from "../../contracts/types.js";
import { sameScope } from "../../contracts/identity.js";
import { canonical, cloneJson, deepFreeze, invariant, object, text, validateCapturedScopes, validateScope } from "../../contracts/validation.js";
import { codexRowId } from "./index.js";
import type { NativeMediaHandler } from "../../contracts/media.js";
import { codexMediaItem } from "./media.js";
import { codexOptionalQuestionMetadata } from "./questions.js";

/** The selected native item-list contract, rather than a transcript/stream cursor. */
export interface CodexItemsRequest {
  readonly threadId: string;
  readonly turnId: string | null;
  readonly cursor: string | null;
  readonly limit: number;
  readonly sortDirection: "desc";
}
export interface CodexHistoryEntry {
  readonly turnId: string;
  readonly item: unknown;
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
}
export interface CodexItemsPage {
  readonly data: readonly CodexHistoryEntry[];
  readonly nextCursor: string | null;
  readonly backwardsCursor: string | null;
}
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
function id(value: unknown): asserts value is string {
  invariant(typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value), "CODEX_HISTORY_ID");
}
function cursor(value: unknown): asserts value is string | null {
  invariant(value === null || typeof value === "string" && value.length > 0 && value.length <= 4096, "CODEX_HISTORY_CURSOR");
}
function timestamp(value: unknown): asserts value is number | null {
  invariant(value === null || Number.isSafeInteger(value) && (value as number) >= 0, "CODEX_HISTORY_TIMESTAMP");
}
function string(value: unknown): string {
  invariant(typeof value === "string" && value.length <= 65_536 && bytes(value) <= 65_536, "CODEX_HISTORY_TEXT_BOUND");
  return value;
}
function lifecycle(value: unknown, completedAtMs: number | null): HistoryRecord["lifecycle"] {
  // Message/reasoning items have no status field. The native item-list
  // envelope records the same item completion boundary as item/completed;
  // a page boundary or a turn's idle state cannot substitute for it.
  if (value === undefined) return completedAtMs === null ? "unknown" : "completed";
  invariant(["inProgress", "completed", "failed", "declined", "interrupted"].includes(String(value)), "CODEX_HISTORY_STATUS");
  invariant(value !== "inProgress" || completedAtMs === null, "CODEX_HISTORY_STATUS");
  return value === "inProgress" ? "running" : value === "declined" ? "interrupted" : value as HistoryRecord["lifecycle"];
}
function body(value: unknown, state: HistoryRecord["lifecycle"], immutable = false): Body {
  if (value === null) return { kind: "unavailable", reason: "nativeOmitted" };
  if (value === undefined) return { kind: "unavailable", reason: "notCaptured" };
  const text = string(value);
  return immutable || state === "completed" || state === "failed" || state === "interrupted"
    ? { kind: "complete", text, evidence: "nativeFullBody" }
    : { kind: "partial", text, missing: ["final"] };
}

/**
 * Pure bounded read normalization. Ancestry authorization is injected by the
 * native binding and never grants live capture, child controls or a resume.
 * Native pages have no common live revision: all bodies remain separate read
 * evidence until the acquisition owner resolves exact-identity overlap.
 */
export function createCodexHistoryPort(options: Readonly<{
  scope: CodexScope;
  list: (request: CodexItemsRequest) => Promise<CodexItemsPage>;
  authorize: () => Promise<void>;
  /** Ancestry proof in this same read job; unproved references remain historical text only. */
  discover?: (threadIds: readonly string[], assertCurrent: () => void) => Promise<readonly CapturedScope[]>;
  /** Cheap attachment/authorization fence; this must not perform native reads. */
  assertCurrent?: () => void;
  context?: string;
  media?: NativeMediaHandler;
}>): AcquisitionPort<CodexScope> {
  const scope = deepFreeze(cloneJson(validateScope(cloneJson(options.scope)))) as CodexScope;
  invariant(scope.kind === "codex", "CODEX_HISTORY_SCOPE");
  if (options.context !== undefined) text(options.context, "READ_CONTEXT", 256);
  return Object.freeze({ scope, mode: "active" as const, ...(options.context === undefined ? {} : { context: options.context }),
    async read(request: AcquisitionRequest<CodexScope>, assertCurrent?: () => void): Promise<AcquisitionBatch> {
      invariant(sameScope(scope, request.scope), "CODEX_HISTORY_FOREIGN_SCOPE");
      invariant(Number.isSafeInteger(request.count) && request.count > 0 && request.count <= 128, "CODEX_HISTORY_COUNT");
      cursor(request.cursor);
      const input = deepFreeze(cloneJson(request));
      assertCurrent?.(); options.assertCurrent?.();
      await options.authorize();
      assertCurrent?.(); options.assertCurrent?.();
      const raw = await options.list({ threadId: scope.threadId, turnId: null,
        cursor: input.cursor, limit: input.count, sortDirection: "desc" });
      assertCurrent?.(); options.assertCurrent?.();
      // No getter, cyclic object, overlarge JSON, or partially decoded page is
      // allowed to leak through as useful-looking historical evidence.
      const rawPage = object(raw);
      invariant(Array.isArray(rawPage.data) && rawPage.data.length <= input.count, "CODEX_HISTORY_PAGE_BOUND");
      if (rawPage.threadId !== undefined) invariant(rawPage.threadId === scope.threadId, "CODEX_HISTORY_FOREIGN_THREAD");
      const mediaRows = new Map<string, ReturnType<typeof codexMediaItem>>();
      const projected = rawPage.data.map(rawEntry => {
        const entry = object(rawEntry), item = object(entry.item);
        id(entry.turnId); id(item.id);
        if (entry.threadId !== undefined) invariant(entry.threadId === scope.threadId, "CODEX_HISTORY_FOREIGN_THREAD");
        if (item.threadId !== undefined) invariant(item.threadId === scope.threadId, "CODEX_HISTORY_FOREIGN_THREAD");
        if (item.turnId !== undefined) invariant(item.turnId === entry.turnId, "CODEX_HISTORY_FOREIGN_TURN");
        if (!["userMessage", "message", "functionCallOutput", "function_call_output", "custom_tool_call_output", "mcpToolCall", "dynamicToolCall", "imageView", "imageGeneration", "image_generation_call"].includes(String(item.type))) return rawEntry;
        const generation = item.type === "imageGeneration" || item.type === "image_generation_call";
        const normalized = codexMediaItem(item, JSON.stringify([scope.threadId, entry.turnId, item.id]), scope, generation && entry.completedAtMs == null ? undefined : options.media);
        mediaRows.set(JSON.stringify([entry.turnId, item.id]), normalized);
        return { ...entry, item: normalized.item };
      });
      const page = object(cloneJson({ ...rawPage, data: projected }));
      invariant(Array.isArray(page.data) && page.data.length <= input.count, "CODEX_HISTORY_PAGE_BOUND");
      if (page.threadId !== undefined) invariant(page.threadId === scope.threadId, "CODEX_HISTORY_FOREIGN_THREAD");
      cursor(page.nextCursor); cursor(page.backwardsCursor);
      invariant(page.nextCursor === null || page.nextCursor !== input.cursor, "CODEX_HISTORY_NONADVANCING_CURSOR");
      invariant(page.data.length > 0 || page.backwardsCursor === null, "CODEX_HISTORY_BACKWARDS_CURSOR");
      const seen = new Set<string>(), records: HistoryRecord[] = [], gaps = new Map<string, Gap>(), references = new Set<string>();
      const gap = (type: string, kind: Gap["kind"] = "unsupported") => {
        const key = `codex:history:${kind}:${type}`;
        gaps.set(key, { id: key, kind });
      };
      const reference = (threadId: string) => {
        if (threadId === scope.origin.nativeSession || references.has(threadId)) return;
        if (references.size < 31) references.add(threadId); else gap("child-discovery-capacity", "truncated");
      };
      // Entries, not expanded segments, are reversed exactly once. Native
      // reasoning channel/index order is preserved inside each entry.
      for (const rawEntry of [...page.data].reverse()) {
        const entry = object(rawEntry), item = object(entry.item);
        id(entry.turnId); id(item.id); id(item.type);
        timestamp(entry.startedAtMs); timestamp(entry.completedAtMs);
        if (entry.threadId !== undefined) invariant(entry.threadId === scope.threadId, "CODEX_HISTORY_FOREIGN_THREAD");
        if (item.threadId !== undefined) invariant(item.threadId === scope.threadId, "CODEX_HISTORY_FOREIGN_THREAD");
        if (item.turnId !== undefined) invariant(item.turnId === entry.turnId, "CODEX_HISTORY_FOREIGN_TURN");
        const identity = JSON.stringify([entry.turnId, item.id]);
        invariant(!seen.has(identity), "CODEX_HISTORY_DUPLICATE_ITEM"); seen.add(identity);
        const state = lifecycle(item.type === "imageGeneration" || item.type === "image_generation_call" ? undefined : item.status, entry.completedAtMs);
        const native: Record<string, Json> = { threadId: scope.threadId, turnId: entry.turnId,
          nativeItemId: item.id, type: item.type, startedAtMs: entry.startedAtMs, completedAtMs: entry.completedAtMs };
        for (const key of ["phase", "command", "processId", "server", "tool", "name", "namespace", "status", "clientId", "model", "reasoningEffort"])
          if (item[key] === null) native[key] = null;
          else if (item[key] !== undefined) native[key] = string(item[key]);
        for (const key of ["exitCode", "durationMs"])
          if (item[key] === null) native[key] = null;
          else if (item[key] !== undefined) { invariant(Number.isSafeInteger(item[key]), "CODEX_HISTORY_NUMBER"); native[key] = item[key] as number; }
        if (item.type === "agentMessage") {
          if (item.delivery === "async") native.delivery = "async";
          if (item.questions != null) {
            Object.assign(native, codexOptionalQuestionMetadata(item.questions, { ...native, channel: "body" }));
          }
        }
        const add = (kind: RowKind, value: unknown, channel = "body", index?: number, immutable = false) => {
          const metadata = { ...native, channel, ...(index === undefined ? {} : { index }) };
          invariant(bytes(canonical(metadata)) <= 16_384, "CODEX_HISTORY_METADATA_BOUND");
          records.push({ id: codexRowId(scope.threadId, entry.turnId as string, item.id as string, channel, index), kind,
            lifecycle: state, body: body(value, state, immutable), native: metadata });
        };
        const unsupported = (kind: RowKind = "notice") => {
          gap(item.type as string);
          records.push({ id: codexRowId(scope.threadId, entry.turnId as string, item.id as string), kind,
            lifecycle: state, body: { kind: "unavailable", reason: "unsupported" }, native });
        };
        if (item.type === "agentMessage" || item.type === "plan") add("assistant", item.text);
        else if (item.type === "commandExecution") add("tool", item.aggregatedOutput);
        else if (item.type === "reasoning") {
          let emitted = 0;
          for (const channel of ["summary", "content"]) {
            const parts = item[channel];
            invariant(Array.isArray(parts) && parts.length <= 32, "CODEX_HISTORY_REASONING_BOUND");
            parts.forEach((part, index) => { add("reasoning", part, channel, index); emitted++; });
          }
          // Preserve a metadata-only native reasoning item without fabricating
          // an empty reasoning channel/segment that native did not supply.
          if (!emitted) records.push({ id: codexRowId(scope.threadId, entry.turnId, item.id), kind: "reasoning", lifecycle: state,
            body: { kind: "unavailable", reason: "nativeOmitted" }, native });
        } else if (mediaRows.has(identity)) {
          const normalized = mediaRows.get(identity)!;
          if (item.arguments !== undefined) native.arguments = cloneJson(item.arguments) as Json;
          if (normalized.media.length) native.media = normalized.media as unknown as Json;
          const content = item.type === "mcpToolCall" ? item.result == null ? null : object(item.result).content : item.type === "dynamicToolCall" ? item.contentItems
            : ["functionCallOutput", "function_call_output", "custom_tool_call_output"].includes(String(item.type)) ? item.output : item.content;
          const kind = item.type === "userMessage" ? "user" : item.type === "message" ? "assistant" : "tool";
          if (content == null) { add(kind, null); if (normalized.unsupported) gap("unsupported-media"); }
          else {
            invariant(typeof content === "string" || Array.isArray(content) && content.length <= 32, "CODEX_HISTORY_CONTENT_BOUND");
            const textTypes = item.type === "dynamicToolCall" ? ["inputText"] : item.type === "message" || String(item.type).includes("output") || item.type === "functionCallOutput" ? ["input_text", "output_text"] : ["text"];
            const text = typeof content === "string" ? string(content) : content.map(object).filter(part => textTypes.includes(String(part.type))).map(part => string(part.text)).join("\n");
            if (normalized.unsupported && !text) unsupported(kind);
            else {
              add(kind, text, "body", undefined, item.type === "userMessage");
              if (normalized.unsupported) {
                const record = records.at(-1)!;
                records[records.length - 1] = { ...record, body: { kind: "partial", text, missing: ["interior"] } };
                gap("unsupported-media");
              }
            }
          }
        } else if (item.type === "subAgentActivity") {
          id(item.agentThreadId); id(item.agentPath);
          invariant(["started", "interacted", "interrupted", "completed"].includes(String(item.kind)), "CODEX_HISTORY_ACTIVITY");
          native.agentThreadId = item.agentThreadId; native.agentPath = item.agentPath; native.activityKind = item.kind as string;
          reference(item.agentThreadId);
          add("tool", null);
        } else if (item.type === "collabAgentToolCall") {
          invariant(item.senderThreadId === scope.threadId && Array.isArray(item.receiverThreadIds) && item.receiverThreadIds.length <= 32,
            "CODEX_HISTORY_COLLAB_SCOPE");
          native.senderThreadId = scope.threadId;
          native.receiverThreadIds = item.receiverThreadIds.map(value => { id(value); return value; });
          for (const threadId of native.receiverThreadIds as string[]) reference(threadId);
          if (item.prompt !== undefined) native.prompt = item.prompt === null ? null : string(item.prompt);
          if (item.agentsStates !== undefined) native.agentsStates = cloneJson(object(item.agentsStates)) as Json;
          add("tool", null);
        } else if (item.type === "contextCompaction") add("notice", null);
        else unsupported();
        invariant(bytes(canonical(native)) <= 16_384, "CODEX_HISTORY_METADATA_BOUND");
        invariant(records.length <= 1024, "CODEX_HISTORY_RECORD_BOUND");
      }
      const discovered = options.discover && references.size ? await options.discover([...references], () => { assertCurrent?.(); options.assertCurrent?.(); }) : [];
      assertCurrent?.(); options.assertCurrent?.(); validateCapturedScopes(discovered, scope);
      invariant(discovered.every(entry => entry.scope.kind === "codex" && references.has(entry.scope.threadId)), "CODEX_HISTORY_DISCOVERY_SCOPE");
      if (options.discover) for (const threadId of references) if (!discovered.some(entry => entry.scope.kind === "codex" && entry.scope.threadId === threadId)) gap(`unproved-child:${threadId}`, "identity");
      return deepFreeze({ scope, status: "ok", records, gaps: [...gaps.values()], ...(discovered.length ? { discoveredScopes: discovered } : {}),
        hasMore: page.nextCursor !== null, nextCursor: page.nextCursor });
    },
  });
}
