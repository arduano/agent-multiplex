import { check, object, text } from "./validation.js";
export type ThreadMetadata = Readonly<{ id: string; context: string; parent: string | null }>;
/** Native metadata's direct/source parent spellings must agree. Session/context
 * equality alone never grants another agent's history or callback authority. */
export function threadMetadata(value: unknown): ThreadMetadata {
  const row = object(value),
    parents: string[] = [];
  if (row.parentThreadId != null) parents.push(text(row.parentThreadId));
  const source = row.source && typeof row.source === "object" ? object(row.source) : {};
  for (const key of ["subagent", "subAgent"]) {
    if (source[key] && typeof source[key] === "object") {
      const agent = object(source[key]);
      if (agent.thread_spawn) parents.push(text(object(agent.thread_spawn).parent_thread_id));
    }
  }
  check(new Set(parents).size <= 1, "CONTRADICTORY_PARENT");
  return { id: text(row.id), context: text(row.sessionId), parent: parents[0] ?? null };
}
export function proveLineage(
  root: string,
  selected: string,
  metadata: readonly unknown[],
): readonly string[] {
  const nodes = new Map<string, ThreadMetadata>();
  check(metadata.length <= 33, "ANCESTRY_BOUND");
  for (const value of metadata) {
    const node = threadMetadata(value);
    check(!nodes.has(node.id), "ANCESTRY_DUPLICATE");
    nodes.set(node.id, node);
  }
  const owner = nodes.get(root);
  check(owner, "ANCESTRY_ROOT_MISSING");
  const chain: ThreadMetadata[] = [],
    seen = new Set<string>();
  let id = selected;
  while (id !== root) {
    const node = nodes.get(id);
    check(node?.parent && !seen.has(id) && chain.length < 32, "ANCESTRY_UNPROVED");
    seen.add(id);
    chain.push(node);
    id = node.parent;
  }
  const contexts = new Set([owner.id, owner.context]);
  for (const node of [...chain].reverse()) {
    contexts.add(node.id);
    check(contexts.has(node.context), "ANCESTRY_CONTEXT");
  }
  return chain.map((node) => node.parent!);
}
