import { copilotObservedOwnerId, copilotEventNamesOwner, NATIVE_PAYLOAD_MAX_BYTES, jsonWireByteUpperBound, type NativeHistoryRequest, type JsonValue } from "@arduano/agent-multiplex-protocol";
import type { AdapterNativeHistoryResult } from "@arduano/agent-multiplex-runtime-node-core";
import type { CopilotClient } from "@github/copilot-sdk";
import { copilotJson } from "./json.js";
import { copilotHistoryEventBytes, copilotImageLeaves } from "./images.js";
import { copilotConversationEvidence } from "./conversation.js";
import { copilotHistoryDeliveryFacts } from "./lifecycle.js";
type PersistedRead = CopilotClient["rpc"]["sessions"]["readPersistedEvents"];
type SessionsReadPersistedEventsRequest = Parameters<PersistedRead>[0];
type EventsReadResult = Awaited<ReturnType<PersistedRead>>;

/** Persisted native cursors are single-use. Each page is read exactly once,
 * independently of any live controller; no Resume or vendor-file parsing. */
export async function readCopilotPersistedHistory(vendorSessionId: string, request: NativeHistoryRequest,
  read: (input: SessionsReadPersistedEventsRequest) => Promise<EventsReadResult>): Promise<AdapterNativeHistoryResult> {
  if (request.harness !== "copilot") throw new TypeError("Copilot history harness mismatch");
  const view = request.native?.view ?? "primary", agentId = request.native?.agentId;
  if (!["primary", "subagent"].includes(String(view))) throw new TypeError("Unsupported persisted Copilot history view");
  if (view === "subagent" && (typeof agentId !== "string" || !agentId || agentId.length > 256 || /[\u0000-\u001f]/.test(agentId))) throw new TypeError("Invalid persisted subagent history identifier");
  const direction = request.native?.sortDirection ?? "asc";
  if (direction !== "asc" && direction !== "desc") throw new TypeError("Invalid Copilot history sort direction");
  const prefix = `copilot:persisted:v1:${Buffer.from(JSON.stringify([vendorSessionId, view, agentId ?? null, direction])).toString("base64url")}:`;
  if (request.cursor && (!request.cursor.startsWith(prefix) || request.cursor.length <= prefix.length)) throw new TypeError("Persisted history cursor belongs to another native view");
  // The persisted endpoint advances a single-use native cursor and budgets
  // batches above our wire ceiling. Read one native event per page: no replay,
  // retained overflow buffer or invented continuation is needed. The caller's
  // limit is an upper bound, rather than a promised batch size.
  const cursor = request.cursor?.slice(prefix.length);
  const page = await read({ sessionId: vendorSessionId, ...(cursor ? { cursor } : {}),
    max: 1, direction: direction === "desc" ? "backward" : "forward" });
  if (!Array.isArray(page.events) || page.events.length > 1 || page.events.some(event => !event || typeof event.id !== "string" || typeof event.type !== "string") ||
    typeof page.cursor !== "string" || page.cursor.length > 8192 || typeof page.hasMore !== "boolean" || !["ok", "expired"].includes(page.cursorStatus)) throw new TypeError("Invalid persisted Copilot history page");
  if (page.cursorStatus === "expired") throw new Error("Copilot persisted history cursor expired; reload the conversation");
  if (page.hasMore && (!page.cursor || page.cursor === cursor)) throw new Error("Copilot persisted history cursor did not advance");
  const records = page.events.filter(event => view === "primary" ? !copilotObservedOwnerId(event) : copilotEventNamesOwner(event, agentId as string));
  const payload: JsonValue[] = (direction === "desc" ? [...records].reverse() : records).map(copilotJson);
  let bytes = 256 + jsonWireByteUpperBound(prefix + page.cursor), images = 0;
  for (const [index, event] of payload.entries()) { bytes += copilotHistoryEventBytes(event, index); images += copilotImageLeaves(event).length; }
  // A singleton can still exceed the wire budget; its omission is explicit and
  // advances only with the exact native continuation.
  if (bytes > NATIVE_PAYLOAD_MAX_BYTES || images > 256) {
    if (request.native?.omitOversizedItems !== true) throw new Error("One persisted Copilot history event exceeds the wire limit");
    const event = page.events[0]!;
    return { harness: "copilot", vendorSessionId, payload: [], sortDirection: direction, complete: !page.hasMore,
      ...(page.hasMore ? { nextCursor: prefix + page.cursor } : {}), unavailableItem: { reason: "exceedsWireLimit", nativeItemId: event.id, nativeType: event.type } };
  }
  const messageDeliveryFacts = view === "primary" ? copilotHistoryDeliveryFacts(payload) : [];
  return { harness: "copilot", vendorSessionId, payload, sortDirection: direction, complete: !page.hasMore,
    ...(page.hasMore ? { nextCursor: prefix + page.cursor } : {}), ...(messageDeliveryFacts.length ? { messageDeliveryFacts } : {}),
    conversation: copilotConversationEvidence(payload, vendorSessionId, { history: true, sortDirection: direction, view: view === "primary" ? "primary" : "child" }) };
}
