import { NATIVE_PAYLOAD_MAX_BYTES, toJsonValue, type NativeHistoryRequest } from "@arduano/agent-multiplex-protocol";
import type { AdapterNativeHistoryResult } from "@arduano/agent-multiplex-runtime-node-core";
import type { CodexRpcClient } from "./rpc.js";
import { codexHistoryPageBytes, codexImageLeaves } from "./images.js";
import { codexHistoryDeliveryFacts } from "./history-delivery.js";
import { codexConversationEvidence } from "./conversation.js";
import type { ThreadReadResponse } from "./generated/v2/ThreadReadResponse.js";
import type { ThreadItemsListResponse } from "./generated/v2/ThreadItemsListResponse.js";
import type { ThreadTurnsListParams } from "./generated/v2/ThreadTurnsListParams.js";
import type { ThreadTurnsListResponse } from "./generated/v2/ThreadTurnsListResponse.js";
const json = (value: unknown) => toJsonValue(JSON.parse(JSON.stringify(value)));

/** Reads native persisted history without attaching or resuming a thread.
 * Live and stopped reads share the exact page normalization and wire bounds. */
export class CodexHistoryReader {
  readonly #authorizedHistoryChildren = new Set<string>();
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
    const childThreadId = request.native?.view === "child"
      ? await this.#authorizedChildThreadId(request.native.threadId) : undefined;
    if (childThreadId && !request.includeTurns) throw new TypeError("Codex child history requires item pagination");
    if (request.includeTurns) {
      const sortDirection = request.native?.sortDirection ?? "asc";
      if (sortDirection !== "asc" && sortDirection !== "desc") throw new TypeError("Invalid Codex history sort direction");
      let limit = Math.min(request.limit ?? 100, 100);
      let response: ThreadItemsListResponse;
      for (;;) {
        response = await this.#rpc.request<ThreadItemsListResponse>("thread/items/list", {
          ...Object.fromEntries(Object.entries(request.native ?? {}).filter(([key]) => key !== "omitOversizedItems" && key !== "view" && key !== "threadId")),
          threadId: childThreadId ?? this.vendorSessionId,
          limit,
          sortDirection,
          cursor: request.cursor ?? null,
          turnId: null,
        });
        this.#assertActive();
        const page = json(response);
        if (codexHistoryPageBytes(page) <= NATIVE_PAYLOAD_MAX_BYTES && codexImageLeaves(page).length <= 256) break;
        if (limit === 1) {
          if (request.native?.omitOversizedItems !== true) throw new Error("One native Codex history item exceeds the bounded wire envelope");
          const item = response.data[0]?.item;
          const payload = json({ ...response, data: [], ...(childThreadId ? { threadId: childThreadId } : {}) });
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
      const payload = json({ ...response, ...(childThreadId ? { threadId: childThreadId } : {}) });
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

  async #authorizedChildThreadId(value: unknown): Promise<string> {
    if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value) || value === this.vendorSessionId) {
      throw new TypeError("Invalid Codex child thread identifier");
    }
    if (this.#authorizedHistoryChildren.has(value)) return value;
    if (this.#sessionTreeId === undefined) {
      this.#sessionTreeId = (await this.#rpc.request<ThreadReadResponse>("thread/read", { threadId: this.vendorSessionId, includeTurns: false })).thread.sessionId;
      this.#assertActive();
    }
    const seen = new Set<string>();
    let threadId = value;
    for (let depth = 0; depth < 32; depth++) {
      if (seen.has(threadId)) throw new TypeError("Cyclic Codex child ancestry");
      seen.add(threadId);
      const response = await this.#rpc.request<ThreadReadResponse>("thread/read", { threadId, includeTurns: false });
      const thread = response?.thread;
      this.#assertActive();
      if (thread?.id !== threadId || thread.sessionId !== this.#sessionTreeId) {
        throw new TypeError("Codex child thread belongs to another session tree");
      }
      const parentId = thread.parentThreadId;
      if (parentId === this.vendorSessionId) {
        for (const id of seen) this.#authorizedHistoryChildren.add(id);
        return value;
      }
      if (typeof parentId !== "string" || !parentId) throw new TypeError("Codex thread is not a descendant of this session");
      threadId = parentId;
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
