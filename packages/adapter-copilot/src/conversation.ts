import { boundedConversationEvidence, type ConversationEvidence, type ConversationItemEvidence } from "@arduano/agent-multiplex-protocol";

/** Native IDs/parentId are event identity/chronology. parentId is never child
 * ownership. No observation counter is synthesized for a history read. */
export function copilotConversationEvidence(payload: unknown, vendorSessionId: string, options: { history?: boolean; sortDirection?: "asc" | "desc"; view?: ConversationEvidence["view"] } = {}): ConversationEvidence {
  const records = options.history && Array.isArray(payload) ? payload : [payload];
  const items: ConversationItemEvidence[] = [];
  for (const [index, value] of records.entries()) {
    const event = object(value), data = object(event?.data);
    const type = text(event?.type), eventId = text(event?.id);
    if (!eventId || !type) continue;
    const nativeId = text(data?.messageId) ?? text(data?.reasoningId) ?? text(data?.toolCallId) ?? eventId;
    const delegation = type.startsWith("subagent.");
    const delegationId = text(data?.toolCallId) ?? text(data?.agentId) ?? eventId;
    const itemId = delegation ? `copilot:subagent:${delegationId}`
      : type === "assistant.reasoning" || type === "assistant.reasoning_delta" ? `copilot:reasoning:${nativeId}` : `copilot:${nativeId}`;
    const settled = ["user.message", "assistant.message", "assistant.reasoning", "assistant.intent", "tool.execution_complete", "subagent.completed", "subagent.failed", "session.error", "session.binary_asset"].includes(type);
    const open = type.endsWith("_delta") || type === "tool.execution_start" || type === "subagent.started";
    const threadId = text(event?.agentId) ?? text(data?.agentId) ?? text(data?.parentToolCallId) ?? text(vendorSessionId);
    if (!threadId) continue;
    items.push({ itemId, threadId, pointer: options.history ? `/${index}` : "",
      position: { kind: "nativeEvent", eventId, ...(text(event?.parentId) ? { afterEventId: text(event?.parentId)! } : {}) },
      revision: { kind: "immutable", recordId: eventId },
      completion: settled ? "settled" : open ? "open" : "unverified",
      persistence: event?.ephemeral === true ? "ephemeral" : "native",
    });
  }
  const chronological = options.sortDirection === "desc" ? [...items].reverse() : items;
  return boundedConversationEvidence({ version: "v1", view: options.view ?? (options.history ? "all" : "primary"), items,
    order: [...new Set(chronological.map(item => item.itemId))], coverage: { kind: "unknown" } });
}

function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
// Leave room for adapter-owned item prefixes inside the 4,096-character wire ID.
function text(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= 4_000 ? value : undefined; }
