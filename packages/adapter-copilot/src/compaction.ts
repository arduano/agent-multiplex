import { z } from "zod";
import { NATIVE_PAYLOAD_MAX_BYTES, jsonWireByteUpperBound, type JsonValue } from "@arduano/agent-multiplex-protocol";
import { copilotJson } from "./json.js";

// Native HistoryCompactResult from the pinned SDK. Preserve acknowledged false
// outcomes, counters, optional summaries and future native fields verbatim.
const resultSchema = z.object({
  success: z.boolean(),
  tokensRemoved: z.number(),
  messagesRemoved: z.number(),
  summaryContent: z.string().optional(),
  contextWindow: z.object({
    tokenLimit: z.number(), currentTokens: z.number(), messagesLength: z.number(),
    systemTokens: z.number().optional(), conversationTokens: z.number().optional(),
    toolDefinitionsTokens: z.number().optional(),
  }).passthrough().optional(),
}).passthrough();

export function compactionResult(value: unknown): JsonValue {
  if (jsonWireByteUpperBound(value) + 256 > NATIVE_PAYLOAD_MAX_BYTES) {
    throw new Error("Copilot compaction result exceeds the bounded native envelope");
  }
  if (!resultSchema.safeParse(value).success) throw new TypeError("Unrecognized Copilot compaction acknowledgement");
  return copilotJson(value);
}
