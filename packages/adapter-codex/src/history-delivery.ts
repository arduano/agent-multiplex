import type { AdapterNativeHistoryResult } from "@arduano/agent-multiplex-runtime-node-core";

/** Only a root-thread item page requested from the bound native thread may
 * certify consumption. Child pages and summaries never call this function. */
export function codexHistoryDeliveryFacts(value: unknown, vendorSessionId: string): NonNullable<AdapterNativeHistoryResult["messageDeliveryFacts"]> {
  if (!record(value) || !Array.isArray(value.data)) return [];
  if (value.threadId !== undefined && value.threadId !== vendorSessionId) return [];
  return value.data.flatMap(entry => {
    if (!record(entry) || typeof entry.turnId !== "string" || entry.turnId.length === 0 || !record(entry.item)) return [];
    if (entry.threadId !== undefined && entry.threadId !== vendorSessionId) return [];
    const item = entry.item;
    if (item.type !== "userMessage" || typeof item.clientId !== "string" || item.clientId.length === 0 || item.clientId.length > 4_096) return [];
    if (item.threadId !== undefined && item.threadId !== vendorSessionId) return [];
    return [{ type: "messageConsumed" as const, messageId: item.clientId, owner: "root" as const }];
  });
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
