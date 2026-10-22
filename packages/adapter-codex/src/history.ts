import { NATIVE_PAYLOAD_MAX_BYTES, toJsonValue, type NativeHistoryRequest } from "@arduano/agent-multiplex-protocol";
import type { AdapterNativeHistoryResult } from "@arduano/agent-multiplex-runtime-node-core";
import type { CodexRpcClient } from "./rpc.js";
import { codexHistoryPageBytes, codexImageLeaves } from "./images.js";
import { codexHistoryDeliveryFacts } from "./history-delivery.js";
import { codexConversationEvidence } from "./conversation.js";
import type { ThreadReadResponse } from "./generated/v2/ThreadReadResponse.js";
import type { Thread } from "./generated/v2/Thread.js";
import type { ThreadItemsListResponse } from "./generated/v2/ThreadItemsListResponse.js";
import type { ThreadTurnsListParams } from "./generated/v2/ThreadTurnsListParams.js";
import type { ThreadTurnsListResponse } from "./generated/v2/ThreadTurnsListResponse.js";
const json = (value: unknown) => toJsonValue(JSON.parse(JSON.stringify(value)));

/** Only the verified selected child's native configured/persisted selection.
 * This is not requested spawn input or per-turn execution telemetry. */
function childThreadSettings(thread: Thread) {
  const boundedSelection = (value: unknown): string | null => typeof value === "string" &&
    value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
  return {
    projection: "codex.child-settings.v1",
    id: thread.id,
    model: boundedSelection(thread.model),
    reasoningEffort: boundedSelection(thread.reasoningEffort),
    updatedAt: Number.isSafeInteger(thread.updatedAt) && thread.updatedAt >= 0 && thread.updatedAt <= 8_640_000_000_000
      ? thread.updatedAt : null,
  };
}

const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const identity = (value: unknown): string | undefined => typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;

/** Cold native metadata can report a child's own context even when its loaded
 * ancestor shares a context. Context equality alone is not tree ownership. */
function childAncestry(thread: Thread | undefined, expectedId: string): { context: string; parent?: string } {
  const raw = record(thread), context = identity(raw?.sessionId);
  if (!raw || raw.id !== expectedId || !context) throw new TypeError("Codex child thread belongs to another session tree");
  const source = record(raw.source), parents: string[] = [];
  if (raw.parentThreadId !== undefined && raw.parentThreadId !== null) {
    const parent = identity(raw.parentThreadId);
    if (!parent) throw new TypeError("Invalid Codex child parent identity");
    parents.push(parent);
  }
  for (const kind of ["subagent", "subAgent"]) {
    const agent = record(source?.[kind]);
    if (agent && Object.hasOwn(agent, "thread_spawn")) {
      const spawn = record(agent.thread_spawn), parent = identity(spawn?.parent_thread_id);
      if (!parent) throw new TypeError("Invalid Codex child source parent identity");
      parents.push(parent);
    }
  }
  if (new Set(parents).size > 1) throw new TypeError("Conflicting Codex child parent identities");
  const parent = parents[0];
  return { context, ...(parent ? { parent } : {}) };
}

/** Reads native persisted history without attaching or resuming a thread.
 * Live and stopped reads share the exact page normalization and wire bounds. */
export class CodexHistoryReader {
  readonly #authorizedHistoryChildren = new Map<string, string>();
  readonly #rpc: CodexRpcClient;
  readonly #assertActive: () => void;
  #sessionTreeId: string | undefined;
  constructor(rpc: CodexRpcClient, readonly vendorSessionId: string, assertCurrent: () => void = () => {}, sessionTreeId?: string) {
    this.#rpc = rpc; this.#assertActive = assertCurrent; this.#sessionTreeId = sessionTreeId;
  }
  public async read(request: NativeHistoryRequest): Promise<AdapterNativeHistoryResult> {
    this.#assertActive();
    if (request.harness !== "codex") throw new Error("history request harness mismatch");
    if (request.native?.view !== undefined && request.native.view !== "turns" && request.native.view !== "child") throw new TypeError("Unsupported Codex native history view");
    if (request.native?.view === "turns") {
      if (!request.includeTurns) throw new TypeError("Codex turns history requires includeTurns");
      return this.#readNativeTurns(request);
    }
    const child = request.native?.view === "child"
      ? await this.#authorizedChildThread(request.native.threadId, !request.cursor) : undefined;
    const childThreadId = child?.id;
    const childFields = child ? { threadId: child.id,
      ...(child.thread ? { childThread: childThreadSettings(child.thread) } : {}) } : {};
    if (childThreadId && !request.includeTurns) throw new TypeError("Codex child history requires item pagination");
    if (request.includeTurns) {
      const sortDirection = request.native?.sortDirection ?? "asc";
      if (sortDirection !== "asc" && sortDirection !== "desc") throw new TypeError("Invalid Codex history sort direction");
      let limit = Math.min(request.limit ?? 100, 100);
      let response: ThreadItemsListResponse;
      for (;;) {
        this.#assertActive();
        response = await this.#rpc.request<ThreadItemsListResponse>("thread/items/list", {
          ...Object.fromEntries(Object.entries(request.native ?? {}).filter(([key]) => key !== "omitOversizedItems" && key !== "view" && key !== "threadId")),
          threadId: childThreadId ?? this.vendorSessionId,
          limit,
          sortDirection,
          cursor: request.cursor ?? null,
          turnId: null,
        });
        this.#assertActive();
        const page = json({ ...response, ...childFields });
        if (codexHistoryPageBytes(page) <= NATIVE_PAYLOAD_MAX_BYTES && codexImageLeaves(page).length <= 256) break;
        if (limit === 1) {
          if (request.native?.omitOversizedItems !== true) throw new Error("One native Codex history item exceeds the bounded wire envelope");
          const item = response.data[0]?.item;
          const payload = json({ ...response, data: [], ...childFields });
          if (codexHistoryPageBytes(payload) > NATIVE_PAYLOAD_MAX_BYTES) throw new Error("Codex history cursors exceed the bounded wire envelope");
          // Advance only with the real native single-item cursor, preserving a
          // visible omission instead of truncating or inventing native output.
          return {
            harness: "codex", vendorSessionId: this.vendorSessionId, sortDirection,
            payload,
            conversation: codexConversationEvidence(payload, this.vendorSessionId, {
              history: true, sortDirection, view: childThreadId ? "child" : "primary",
            }),
            complete: response.nextCursor === null,
            ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
            unavailableItem: { reason: "exceedsWireLimit",
              ...(item && "id" in item && typeof item.id === "string" && item.id.length <= 1_024 ? { nativeItemId: item.id } : {}),
              ...(item?.type && item.type.length <= 256 ? { nativeType: item.type } : {}),
            },
          };
        }
        // Re-read the same native cursor with a smaller page; never invent a
        // cursor or silently discard native items after the server advanced it.
        limit = Math.max(1, Math.floor(limit / 2));
      }
      const messageDeliveryFacts = !childThreadId ? codexHistoryDeliveryFacts(response, this.vendorSessionId) : [];
      const payload = json({ ...response, ...childFields });
      return {
        harness: "codex", vendorSessionId: this.vendorSessionId,
        payload, sortDirection,
        conversation: codexConversationEvidence(payload, this.vendorSessionId, {
          history: true, sortDirection, view: childThreadId ? "child" : "primary",
        }),
        complete: response.nextCursor === null,
        ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
        ...(messageDeliveryFacts.length ? { messageDeliveryFacts } : {}),
      };
    }
    const response = await this.#rpc.request<ThreadReadResponse>("thread/read", {
      ...(request.native ?? {}),
      threadId: this.vendorSessionId,
      includeTurns: request.includeTurns,
    });
    this.#assertActive();
    return {
      harness: "codex",
      vendorSessionId: this.vendorSessionId,
      payload: json(response),
      conversation: codexConversationEvidence(response, this.vendorSessionId, { history: true }),
      complete: true,
    };
  }

  async #authorizedChildThread(value: unknown, includeSettings: boolean): Promise<{ id: string; thread?: Thread }> {
    if (typeof value !== "string" || identity(value) !== value || value === this.vendorSessionId) throw new TypeError("Invalid Codex child thread identifier");
    // Older pages reuse only a previously proved immutable selection within
    // this attachment. Reopening a selection proves its full ancestry afresh.
    if (this.#authorizedHistoryChildren.has(value) && !includeSettings) return { id: value };
    // A failed fresh proof must retire the earlier authorization, including
    // cursor continuations. Keep at most one bounded proved ancestry chain.
    this.#authorizedHistoryChildren.clear();
    if (this.#sessionTreeId === undefined) {
      this.#assertActive();
      const root = (await this.#rpc.request<ThreadReadResponse>("thread/read", { threadId: this.vendorSessionId, includeTurns: false })).thread;
      this.#assertActive();
      this.#sessionTreeId = childAncestry(root, this.vendorSessionId).context;
    }
    if (!identity(this.#sessionTreeId)) throw new TypeError("Invalid Codex root context identity");
    const seen = new Set<string>(), chain: Array<{ id: string; context: string; parent: string }> = [];
    let threadId = value;
    let selectedThread: Thread | undefined;
    for (let depth = 0; depth < 32; depth++) {
      if (seen.has(threadId)) throw new TypeError("Cyclic Codex child ancestry");
      seen.add(threadId);
      this.#assertActive();
      const response = await this.#rpc.request<ThreadReadResponse>("thread/read", { threadId, includeTurns: false });
      this.#assertActive();
      const thread = response?.thread, metadata = childAncestry(thread, threadId);
      if (threadId === value) selectedThread = thread;
      if (!metadata.parent) throw new TypeError("Codex thread is not a descendant of this session");
      if (seen.has(metadata.parent)) throw new TypeError("Cyclic Codex child ancestry");
      chain.push({ id: threadId, context: metadata.context, parent: metadata.parent });
      if (metadata.parent === this.vendorSessionId) {
        // Prove every edge first. A node's context may name only itself, a
        // proved ancestor, or the managed root context; never a descendant or
        // an unrelated tree. A shared context never substitutes for ancestry.
        const contexts = new Set([this.#sessionTreeId, this.vendorSessionId]);
        for (const node of [...chain].reverse()) {
          contexts.add(node.id);
          if (!contexts.has(node.context)) throw new TypeError("Codex child thread belongs to another session tree");
        }
        for (const node of chain) this.#authorizedHistoryChildren.set(node.id, node.parent);
        return { id: value, ...(includeSettings && selectedThread ? { thread: selectedThread } : {}) };
      }
      threadId = metadata.parent;
    }
    throw new TypeError("Codex child ancestry exceeds the supported bound");
  }

  async #readNativeTurns(request: NativeHistoryRequest): Promise<AdapterNativeHistoryResult> {
    const sortDirection = request.native?.sortDirection ?? "asc";
    if (sortDirection !== "asc" && sortDirection !== "desc") throw new TypeError("Invalid Codex history sort direction");
    let limit = Math.min(request.limit ?? 100, 100);
    let itemsView: ThreadTurnsListParams["itemsView"] = "summary";
    for (;;) {
      const response = await this.#rpc.request<ThreadTurnsListResponse>("thread/turns/list", {
        threadId: this.vendorSessionId, cursor: request.cursor ?? null, limit, sortDirection, itemsView,
      } satisfies ThreadTurnsListParams);
      if (!Array.isArray(response?.data) || response.data.length > limit ||
        !(response.nextCursor === null || typeof response.nextCursor === "string") ||
        !(response.backwardsCursor === null || typeof response.backwardsCursor === "string")) {
        throw new TypeError("Unrecognized Codex turns history page");
      }
      const page = json(response);
      if (codexHistoryPageBytes(page) <= NATIVE_PAYLOAD_MAX_BYTES && codexImageLeaves(page).length <= 256) {
        return {
          harness: "codex", vendorSessionId: this.vendorSessionId, payload: page, sortDirection,
          conversation: codexConversationEvidence(page, this.vendorSessionId, { history: true, sortDirection }),
          complete: response.nextCursor === null,
          ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
        };
      }
      if (limit > 1) {
        // Keep the native input cursor fixed until its whole page fits.
        limit = Math.max(1, Math.floor(limit / 2));
        continue;
      }
      if (itemsView === "summary") {
        // Native summary can contain an oversized last item. The pinned native
        // metadata view preserves error/status without inventing truncated items.
        itemsView = "notLoaded";
        continue;
      }
      if (request.native?.omitOversizedItems !== true) throw new Error("One native Codex history turn exceeds the bounded wire envelope");
      const omitted = json({ ...response, data: [] });
      if (codexHistoryPageBytes(omitted) > NATIVE_PAYLOAD_MAX_BYTES) throw new Error("Codex turns history cursors exceed the bounded wire envelope");
      const turn = response.data[0];
      return {
        harness: "codex", vendorSessionId: this.vendorSessionId, payload: omitted, sortDirection,
        conversation: codexConversationEvidence(omitted, this.vendorSessionId, { history: true, sortDirection }),
        complete: response.nextCursor === null,
        ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
        unavailableItem: { reason: "exceedsWireLimit",
          ...(typeof turn?.id === "string" && turn.id.length <= 1_024 ? { nativeItemId: turn.id } : {}),
        },
      };
    }
  }

}
