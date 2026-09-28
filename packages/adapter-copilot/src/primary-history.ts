import {
  NATIVE_PAYLOAD_MAX_BYTES,
  jsonWireByteUpperBound,
  type JsonValue,
  type NativeHistoryRequest,
} from "@arduano/agent-multiplex-protocol";
import type { AdapterNativeHistoryResult } from "@arduano/agent-multiplex-runtime-node-core";
import { copilotHistoryEventBytes, copilotImageLeaves } from "./images.js";
import { copilotJson } from "./json.js";

export interface CopilotEventLogReadRequest {
  cursor?: string;
  max: number;
  direction: "forward" | "backward";
  agentScope: "primary";
  includeEphemeral: false;
}

const CURSOR_PREFIX = "copilot:primary:v1:";

/** Native ownership filtering happens before the bounded page reaches Multiplex. */
export async function readPrimaryHistory(
  vendorSessionId: string,
  request: NativeHistoryRequest,
  read: (request: CopilotEventLogReadRequest) => Promise<unknown>,
): Promise<AdapterNativeHistoryResult> {
  const sortDirection = request.native?.sortDirection ?? "asc";
  if (sortDirection !== "asc" && sortDirection !== "desc") throw new TypeError("Invalid Copilot history sort direction");
  const prefix = `${CURSOR_PREFIX}${sortDirection}:`;
  if (request.cursor !== undefined && (!request.cursor.startsWith(prefix) || request.cursor.length <= prefix.length)) {
    throw new TypeError("Invalid Copilot primary history cursor");
  }
  const cursor = request.cursor?.slice(prefix.length);
  let maximum = request.limit;
  for (;;) {
    const value = await read({
      ...(cursor === undefined ? {} : { cursor }),
      max: maximum,
      direction: sortDirection === "desc" ? "backward" : "forward",
      agentScope: "primary",
      includeEphemeral: false,
    });
    if (!object(value) || !Array.isArray(value.events) || value.events.length > maximum ||
      typeof value.cursor !== "string" || value.cursor.length > 8_192 || typeof value.hasMore !== "boolean" ||
      (value.cursorStatus !== "ok" && value.cursorStatus !== "expired") ||
      value.events.some(event => !object(event) || typeof event.id !== "string" || typeof event.type !== "string")) {
      throw new TypeError("Unrecognized Copilot primary history page");
    }
    if (value.cursorStatus === "expired") throw new Error("Copilot history cursor expired; reload the conversation");
    if (value.hasMore && (!value.cursor || value.cursor === cursor)) throw new Error("Copilot primary history cursor did not advance");
    // Native backward pages are still chronological within each page. The
    // existing Multiplex sortDirection contract orders the payload itself.
    const events = sortDirection === "desc" ? [...value.events].reverse() : value.events;
    const payload: JsonValue[] = [];
    const nextCursor = `${prefix}${value.cursor}`;
    let bytes = 256 + jsonWireByteUpperBound(nextCursor);
    let images = 0;
    let oversized: JsonValue | undefined;
    for (const item of events) {
      const event = copilotJson(item);
      bytes += copilotHistoryEventBytes(event, payload.length);
      images += copilotImageLeaves(event).length;
      if (bytes > NATIVE_PAYLOAD_MAX_BYTES || images > 256) { oversized = event; break; }
      payload.push(event);
    }
    if (oversized === undefined) {
      return { harness: "copilot", vendorSessionId, payload, sortDirection,
        complete: !value.hasMore, ...(value.hasMore ? { nextCursor } : {}) };
    }
    // A native cursor covers the entire native batch. Truncating that batch
    // would skip unseen events, so retry the same input cursor with fewer items.
    // At most 11 native reads are needed for the protocol's 1,000-item limit.
    if (maximum > 1) { maximum = Math.max(1, Math.floor(maximum / 2)); continue; }
    if (request.native?.omitOversizedItems !== true) throw new Error("One native Copilot history event exceeds the bounded wire envelope");
    const omitted = oversized;
    if (!object(omitted)) throw new TypeError("Unrecognized oversized Copilot primary history event");
    return { harness: "copilot", vendorSessionId, payload: [], sortDirection,
      complete: !value.hasMore, ...(value.hasMore ? { nextCursor } : {}),
      unavailableItem: { reason: "exceedsWireLimit",
        ...(typeof omitted.id === "string" && omitted.id.length <= 1_024 ? { nativeItemId: omitted.id } : {}),
        ...(typeof omitted.type === "string" && omitted.type.length <= 256 ? { nativeType: omitted.type } : {}),
      },
    };
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
