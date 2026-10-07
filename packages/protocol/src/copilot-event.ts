/** Browser-safe native ownership description. Agent and tool-call IDs retain
 * separate domains; chronological event.parentId never describes an owner. */
export interface CopilotEventDescriptor {
  readonly agentId?: string;
  readonly legacyAgentId?: string;
  readonly parentToolCallId?: string;
  /** A malformed marker cannot certify root-only durable delivery. */
  readonly ownershipMarked: boolean;
  readonly delegation?: {
    readonly toolCallId?: string;
    readonly agentId?: string;
    readonly parentId?: string;
  };
}

export function describeCopilotEvent(raw: unknown): CopilotEventDescriptor {
  const event = object(raw), data = object(event?.data);
  const agentId = nonempty(event?.agentId), legacyAgentId = nonempty(data?.agentId);
  const parentToolCallId = nonempty(data?.parentToolCallId);
  const delegation = event?.type === "subagent.started" || event?.type === "subagent.completed" || event?.type === "subagent.failed"
    ? { ...field("toolCallId", nonempty(data?.toolCallId)), ...field("agentId", agentId ?? legacyAgentId), ...field("parentId", nonempty(data?.parentId)) }
    : undefined;
  return { ...field("agentId", agentId), ...field("legacyAgentId", legacyAgentId), ...field("parentToolCallId", parentToolCallId),
    ownershipMarked: [event?.agentId, data?.agentId, data?.parentToolCallId].some(value => value !== undefined),
    ...(delegation ? { delegation } : {}) };
}

/** Compatibility routing label, not evidence that an agent and tool ID alias. */
export function copilotObservedOwnerId(raw: unknown): string | undefined {
  const owner = describeCopilotEvent(raw);
  return owner.agentId ?? owner.legacyAgentId ?? owner.parentToolCallId;
}

export function copilotEventNamesOwner(raw: unknown, id: string): boolean {
  const owner = describeCopilotEvent(raw);
  return owner.agentId === id || owner.legacyAgentId === id || owner.parentToolCallId === id;
}

function field<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : { [key]: value } as Record<K, string>;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function nonempty(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
