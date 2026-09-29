import {
  LIFECYCLE_VERSION, commandObservationView, initialLifecycle, lifecycleEvidenceSchema,
  lifecycleProjection, reduceLifecycle, sameLifecycleFence, harnessCommandSchema,
  type CommandId, type CommandObservationView, type CommandRecord, type RuntimeLifecycleProjection,
  type LifecycleFact, type LifecycleFence, type LifecycleState,
} from "@arduano/agent-multiplex-protocol";
import type { RuntimeNodeStore } from "./store.js";

/** The runtime is the single evidence writer. Persist before publishing projections. */
export class RuntimeLifecycleJournal {
  public constructor(private readonly store: RuntimeNodeStore) {}

  public read(fence: LifecycleFence): LifecycleState {
    const stored = this.store.getLifecycle(fence.sessionId);
    let state = stored && sameLifecycleFence(stored.fence, fence) ? stored : initialLifecycle(fence);
    if (stored && state !== stored && stored.fence.sessionId === fence.sessionId &&
      stored.fence.runtimeNodeId === fence.runtimeNodeId && stored.fence.bindingRevision === fence.bindingRevision) {
      // A boot/resume starts new task, queue and interaction observations, but
      // exact command IDs and native message IDs remain facts of this binding.
      state = { ...state, commands: stored.commands, displayedMessageIds: stored.displayedMessageIds,
        consumedMessageIds: stored.consumedMessageIds };
    }
    // Receipt persistence precedes this derived ledger. Repair a crash between
    // those writes by original identity; this code has no dispatch capability.
    for (const command of state.commands) {
      const receipt = this.store.getCommand(command.commandId);
      if (!receipt || receipt.sessionId !== fence.sessionId || receipt.runtimeNodeId !== fence.runtimeNodeId || receipt.payloadHash !== command.payloadHash) continue;
      if (receipt.state !== "succeeded" && receipt.state !== "failed" && receipt.state !== "outcomeUnknown") continue;
      const admission = receipt.state === "succeeded" ? "accepted" : receipt.state;
      if ((command.admission === "accepted" || command.admission === "failed") && admission !== command.admission) continue;
      const messageId = receiptMessageId(receipt);
      if (admission === command.admission && (!messageId || command.messageId === messageId)) continue;
      state = reduceLifecycle(state, { version: LIFECYCLE_VERSION, fence, sequence: state.nextSequence, fact: {
        type: "commandReceipt", commandId: command.commandId, payloadHash: command.payloadHash, admission,
        ...(messageId ? { messageId } : {}),
      } });
    }
    if (state !== stored) this.store.putLifecycle(state);
    return state;
  }

  public append(fence: LifecycleFence, fact: LifecycleFact): LifecycleState {
    const current = this.read(fence);
    const evidence = lifecycleEvidenceSchema.parse({ version: LIFECYCLE_VERSION, fence, sequence: current.nextSequence, fact });
    const next = reduceLifecycle(current, evidence);
    this.store.putLifecycle(next);
    return next;
  }

  public projection(fence: LifecycleFence): RuntimeLifecycleProjection {
    return lifecycleProjection(this.read(fence));
  }

  public command(commandId: CommandId, fence?: LifecycleFence): CommandObservationView | null {
    const receipt = this.store.getCommand(commandId);
    if (!receipt) return null;
    return commandObservationView(receipt, fence ? this.read(fence) : undefined);
  }
}

function receiptMessageId(receipt: CommandRecord): string | undefined {
  const envelope = receipt.request && typeof receipt.request === "object" && !Array.isArray(receipt.request)
    ? receipt.request as Record<string, unknown> : undefined;
  const request = harnessCommandSchema.safeParse(envelope?.request);
  const nativeId = request.success && request.data.harness === "codex" &&
    (request.data.command.type === "send" || request.data.command.type === "steer")
    ? request.data.command.native?.clientUserMessageId : undefined;
  if (typeof nativeId === "string" && nativeId.length > 0 && nativeId.length <= 4_096) return nativeId;
  const result = receipt.result?.json;
  return result && typeof result === "object" && !Array.isArray(result) && typeof result.messageId === "string"
    ? result.messageId : undefined;
}
