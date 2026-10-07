import type { ConversationItemEvidence, ConversationRevision } from "@arduano/agent-multiplex-protocol";

export type ConversationComparison = "older" | "same" | "newer" | "incomparable";

/** Comparing unrelated attachment counters or immutable native records would
 * manufacture evidence. Keep that uncertainty explicit for the caller. */
export function compareConversationRevisions(current: ConversationRevision, incoming: ConversationRevision): ConversationComparison {
  const currentId = current.kind !== "incomparable" ? current.recordId : undefined;
  const incomingId = incoming.kind !== "incomparable" ? incoming.recordId : undefined;
  if (currentId && currentId === incomingId) return "same";
  if (current.kind === "immutable" && incoming.kind === "immutable") return current.recordId === incoming.recordId ? "same" : "incomparable";
  if (current.kind !== "observation" || incoming.kind !== "observation" || current.generation !== incoming.generation) return "incomparable";
  return incoming.sequence === current.sequence ? "same" : incoming.sequence > current.sequence ? "newer" : "older";
}

export function compareConversationItems(current: ConversationItemEvidence, incoming: ConversationItemEvidence): ConversationComparison {
  if (current.itemId !== incoming.itemId || current.threadId !== incoming.threadId) return "incomparable";
  const revision = compareConversationRevisions(current.revision, incoming.revision);
  if (revision === "older" || revision === "same") return revision;
  // A terminal record for this exact native item settles its open projection;
  // an old start/delta cannot reopen it. This proves completion, not chronology
  // between two conflicting terminal snapshots.
  if (current.completion === "settled" && incoming.completion !== "settled") return "older";
  if (incoming.completion === "settled" && current.completion !== "settled") return "newer";
  if (current.position.kind === "nativeEvent" && incoming.position.kind === "nativeEvent") {
    if (incoming.position.afterEventId === current.position.eventId) return "newer";
    if (current.position.afterEventId === incoming.position.eventId) return "older";
  }
  return revision;
}

export interface ConversationOrderResult { readonly ids: readonly string[]; readonly conflict: boolean; }

/** Join two ordered runs only at exact item anchors. Unshared rows retain their
 * admitted placement; persistence is not implied by placement in this view.
 * Deltas do not call this function, so work is bounded to page admission. */
export function mergeConversationOrder(previous: readonly string[], run: readonly string[], placement: "before" | "after" = "after", retainedNativeIds: ReadonlySet<string> = new Set()): ConversationOrderResult {
  const incoming = [...new Set(run)];
  const incomingSet = new Set(incoming);
  const positions = new Map(previous.map((id, index) => [id, index]));
  const anchors = incoming.flatMap((id, index) => positions.has(id) ? [{ id, old: positions.get(id)!, next: index }] : []);
  if (!anchors.length) return { ids: placement === "before" ? [...incoming, ...previous] : [...previous, ...incoming], conflict: false };
  if (anchors.some((anchor, index) => index > 0 && anchor.old < anchors[index - 1]!.old)) {
    // Conflicting runs do not authorize silently moving admitted content. New
    // unknown rows remain bounded at the requested edge for raw inspection.
    const additions = incoming.filter(id => !positions.has(id));
    return { ids: placement === "before" ? [...additions, ...previous] : [...previous, ...additions], conflict: true };
  }
  const result: string[] = [];
  let oldIndex = 0, nextIndex = 0;
  for (const anchor of anchors) {
    // New older context precedes an unshared observed prefix at the first
    // anchor. Between anchors retained rows keep their existing placement.
    if (oldIndex === 0) {
      let retainedPrefix = -1;
      for (let index = oldIndex; index < anchor.old; index++) if (retainedNativeIds.has(previous[index]!) && !incomingSet.has(previous[index]!)) retainedPrefix = index;
      for (; oldIndex <= retainedPrefix; oldIndex++) if (!incomingSet.has(previous[oldIndex]!)) result.push(previous[oldIndex]!);
      for (; nextIndex < anchor.next; nextIndex++) result.push(incoming[nextIndex]!);
      for (; oldIndex < anchor.old; oldIndex++) if (!incomingSet.has(previous[oldIndex]!)) result.push(previous[oldIndex]!);
    } else {
      for (; oldIndex < anchor.old; oldIndex++) if (!incomingSet.has(previous[oldIndex]!)) result.push(previous[oldIndex]!);
      for (; nextIndex < anchor.next; nextIndex++) result.push(incoming[nextIndex]!);
    }
    result.push(anchor.id); oldIndex = anchor.old + 1; nextIndex = anchor.next + 1;
  }
  for (; nextIndex < incoming.length; nextIndex++) result.push(incoming[nextIndex]!);
  for (; oldIndex < previous.length; oldIndex++) if (!incomingSet.has(previous[oldIndex]!)) result.push(previous[oldIndex]!);
  return { ids: result, conflict: false };
}
