import { boundedConversationEvidence, type ConversationEvidence, type ConversationItemEvidence } from "@arduano/agent-multiplex-protocol";

export function codexConversationItemId(itemId: string, threadId?: string, turnId?: string): string {
  return `codex:${JSON.stringify([threadId ?? null, turnId ?? null, itemId])}`;
}

/** Codex item snapshots have no shared native revision. A turn terminal proves
 * completion; page position and the time of a read do not prove freshness. */
export function codexConversationEvidence(payload: unknown, vendorSessionId: string, options: { history?: boolean; nativeType?: string; sortDirection?: "asc" | "desc"; view?: ConversationEvidence["view"] } = {}): ConversationEvidence {
  const root = object(payload), thread = object(root?.thread);
  const threadId = text(root?.threadId) ?? text(thread?.id) ?? vendorSessionId;
  const items: ConversationItemEvidence[] = [];
  const add = (raw: unknown, turnId: string | undefined, pointer: string, completion: ConversationItemEvidence["completion"]) => {
    const item = object(raw), id = text(item?.id);
    if (!id) return;
    items.push({ itemId: codexConversationItemId(id, threadId, turnId), threadId, pointer,
      position: { kind: "unknown" }, revision: { kind: "incomparable" }, completion,
      persistence: options.history || options.nativeType === "item/completed" ? "native" : "ephemeral" });
  };
  if (!options.history) {
    const raw = root?.item ?? (text(root?.itemId) ? { id: root?.itemId } : undefined);
    add(raw, text(root?.turnId), root?.item ? "/item" : "", options.nativeType === "item/completed" ? "settled" : "open");
  } else if (Array.isArray(root?.data) && root.data.some(value => object(value)?.item !== undefined)) {
    root.data.forEach((value, index) => { const row = object(value); add(row?.item, text(row?.turnId), `/data/${index}/item`, "unverified"); });
  } else {
    const turns = Array.isArray(thread?.turns) ? thread.turns : Array.isArray(root?.data) ? root.data : [];
    turns.forEach((value, turnIndex) => {
      const turn = object(value), settled = ["completed", "failed", "interrupted"].includes(text(turn?.status) ?? "");
      const rawItems = Array.isArray(turn?.items) ? turn.items : [];
      rawItems.forEach((item, index) => add(item, text(turn?.id), `${thread ? "/thread/turns" : "/data"}/${turnIndex}/items/${index}`, settled ? "settled" : "unverified"));
    });
  }
  const chronological = options.sortDirection === "desc" ? [...items].reverse() : items;
  return boundedConversationEvidence({ version: "v1", view: options.view ?? "primary", items,
    order: [...new Set(chronological.map(item => item.itemId))], coverage: { kind: "unknown" } });
}

function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function text(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= 1_024 ? value : undefined; }
