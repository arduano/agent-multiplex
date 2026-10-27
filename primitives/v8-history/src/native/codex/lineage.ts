import type { ScopeFacts } from "../../contracts/types.js";

/** Metadata-only authorization. Calling this function never opens live capture. */
export interface CodexLineageProof {
  readonly rootThreadId: string;
  readonly threadId: string;
  readonly ancestors: readonly string[];
}

export class CodexLineageError extends Error {
  constructor() { super("CODEX_LINEAGE_UNVERIFIED"); }
}

export const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const identity = (value: unknown): string | undefined => typeof value === "string" &&
  value.length > 0 && value.length <= 1_024 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;

export interface CodexThreadMetadata { readonly id: string; readonly context: string; readonly parent?: string; readonly native?: ScopeFacts }

/** Both native source spellings and the direct parent must agree. */
export function codexThreadMetadata(value: unknown): CodexThreadMetadata {
  const thread = record(value), id = identity(thread?.id), context = identity(thread?.sessionId);
  if (!thread || !id || !context) throw new CodexLineageError();
  const parents: string[] = [];
  if (thread.parentThreadId !== undefined && thread.parentThreadId !== null) {
    const parent = identity(thread.parentThreadId);
    if (!parent) throw new CodexLineageError();
    parents.push(parent);
  }
  const source = record(thread.source);
  for (const spelling of ["subagent", "subAgent"]) {
    const agent = record(source?.[spelling]);
    if (agent && Object.hasOwn(agent, "thread_spawn")) {
      const parent = identity(record(agent.thread_spawn)?.parent_thread_id);
      if (!parent) throw new CodexLineageError();
      parents.push(parent);
    }
  }
  if (new Set(parents).size > 1) throw new CodexLineageError();
  const spawn = record(record(source?.subAgent ?? source?.subagent)?.thread_spawn);
  const facts: Record<string, string> = {};
  for (const [field, raw] of Object.entries({ name: thread.name, nickname: thread.agentNickname, role: thread.agentRole,
    path: spawn?.agent_path, configuredModel: thread.model, reasoningEffort: thread.reasoningEffort })) {
    const value = identity(raw); if (value) facts[field] = value;
  }
  const status = record(thread.status)?.type;
  if (["idle", "active", "notLoaded", "systemError"].includes(String(status))) facts.status = status as string;
  return { id, context, ...(parents[0] ? { parent: parents[0] } : {}), ...(Object.keys(facts).length ? { native: facts as ScopeFacts } : {}) };
}

/**
 * Proves a supplied cold-history chain; no RPC, discovery, resume or live-owner
 * side effect. Context equality alone is insufficient. The .44 source contract
 * allows own context and proved ancestor/root context, never descendant context.
 */
export function proveCodexLineage(input: Readonly<{
  rootThreadId: string;
  threadId: string;
  metadata: readonly unknown[];
  maxDepth?: number;
}>): CodexLineageProof {
  const maximum = input.maxDepth ?? 32;
  if (!identity(input.rootThreadId) || !identity(input.threadId) || input.threadId === input.rootThreadId ||
      !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32 || input.metadata.length > maximum + 1)
    throw new CodexLineageError();
  const nodes = new Map<string, CodexThreadMetadata>();
  for (const raw of input.metadata) {
    const node = codexThreadMetadata(raw);
    if (nodes.has(node.id)) throw new CodexLineageError();
    nodes.set(node.id, node);
  }
  const root = nodes.get(input.rootThreadId);
  if (!root) throw new CodexLineageError();
  const chain: CodexThreadMetadata[] = [], seen = new Set<string>();
  let id = input.threadId;
  while (id !== input.rootThreadId) {
    const node = nodes.get(id);
    if (!node?.parent || seen.has(id) || chain.length >= maximum) throw new CodexLineageError();
    seen.add(id); chain.push(node); id = node.parent;
  }
  const contexts = new Set([root.id, root.context]);
  for (const node of [...chain].reverse()) {
    contexts.add(node.id);
    if (!contexts.has(node.context)) throw new CodexLineageError();
  }
  return Object.freeze({ rootThreadId: root.id, threadId: input.threadId,
    ancestors: Object.freeze(chain.map(node => node.parent!)) });
}
