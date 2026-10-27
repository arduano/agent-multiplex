import { invariant } from "./validation.js";

/**
 * Combine exact identity orders without changing either source's shared anchors.
 * New runs attach immediately before their next shared anchor, or immediately
 * after their final shared anchor. A disjoint run uses the stated older edge;
 * its position is not inferred from identifiers, text or timestamps.
 */
export function mergeHistoryOrder(prior: readonly string[], incoming: readonly string[], older: boolean): string[] {
  invariant(new Set(prior).size === prior.length && new Set(incoming).size === incoming.length, "ORDER_DUPLICATE_IDS");
  const positions = new Map(prior.map((id, index) => [id, index]));
  const before = new Map<string, string[]>();
  let lastPosition = -1, lastAnchor: string | undefined, run: string[] = [];
  for (const id of incoming) {
    const position = positions.get(id);
    if (position === undefined) { run.push(id); continue; }
    invariant(position > lastPosition, "HISTORY_ORDER_CONFLICT");
    before.set(id, run); run = []; lastPosition = position; lastAnchor = id;
  }
  if (lastAnchor === undefined) return older ? [...incoming, ...prior] : [...prior, ...incoming];
  const merged: string[] = [];
  for (const id of prior) {
    merged.push(...(before.get(id) ?? []), id);
    if (id === lastAnchor) merged.push(...run);
  }
  return merged;
}
