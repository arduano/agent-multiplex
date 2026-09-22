import type { LifecycleFact } from "@arduano/agent-multiplex-protocol";

/** Reduce native payloads only to facts that their exact identities support.
 * The original native envelope remains the transcript and detailed evidence.
 * Chronological parentId, text, event timing and queue absence never correlate
 * a command to a logical message or a child to another child identity domain. */
export function copilotLifecycleFacts(nativeType: string, payload: unknown): LifecycleFact[] {
  if (!record(payload) || !record(payload.data)) return [];
  const data = payload.data;
  const agentOwner = [payload.agentId, data.agentId].find(nonempty);
  const toolOwner = nonempty(data.parentToolCallId) ? data.parentToolCallId : undefined;
  if (nativeType === "session.background_tasks_changed") return [{ type: "tasksInvalidated" }];
  if (nativeType === "pending_messages.modified") return [{ type: "queueInvalidated" }];
  if (nativeType === "subagent.started" || nativeType === "subagent.completed" || nativeType === "subagent.failed") {
    if (!nonempty(data.toolCallId)) return [];
    return [{ type: "child", id: `tool:${data.toolCallId}`, state: nativeType === "subagent.started" ? "running"
      : nativeType === "subagent.failed" ? "failed" : "completed" }];
  }
  if (agentOwner !== undefined || toolOwner !== undefined) {
    // No alias is guessed between an agent instance and a task/tool-call ID.
    const owner = agentOwner !== undefined ? `agent:${agentOwner}` : `tool:${toolOwner}`;
    if (nativeType === "assistant.turn_start") return [{ type: "child", id: owner, state: "running" }];
    if (nativeType === "session.idle") return [{ type: "child", id: owner, state: "completed" }];
    if (nativeType === "session.error") return [{ type: "child", id: owner, state: "failed" }];
    return [];
  }
  switch (nativeType) {
    case "assistant.turn_start":
      // Native turnId is typically a stringified number, reused by later loops.
      // This ID names the observed start fence; it is never a message identity.
      return nonempty(payload.id) ? [{ type: "rootStarted", cycleId: payload.id }] : [];
    case "assistant.idle": return [{ type: "rootModelIdle" }];
    case "session.idle": return [{ type: "rootIdle", aborted: data.aborted === true }];
    case "session.error": return [{ type: "rootFailed" }];
    case "user.message": {
      if (!nonempty(data.messageId)) return [];
      // The SDK defines this event as displayed content. turnId is present only
      // when an agent-loop turn consumed that exact logical message.
      const facts: LifecycleFact[] = [{ type: "messageDisplayed", messageId: data.messageId, owner: "root" }];
      if (nonempty(data.turnId)) facts.push({ type: "messageConsumed", messageId: data.messageId, owner: "root" });
      return facts;
    }
    case "session.compaction_start": return [{ type: "compaction", phase: "running" }];
    case "session.compaction_complete": return [{ type: "compaction", phase: "observedComplete" }];
    default: return [];
  }
}

function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
