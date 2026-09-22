import {
  initialLifecycle, lifecycleEvidenceSchema, reduceLifecycle, sameLifecycleFence,
  type LifecycleFact, type LifecycleFence, type LifecycleState,
} from "@arduano/agent-multiplex-protocol";
import type { RuntimeNodeStore } from "./store.js";

/** The runtime is the single evidence writer. Persist before publishing projections. */
export class RuntimeLifecycleJournal {
  public constructor(private readonly store: RuntimeNodeStore) {}

  public read(fence: LifecycleFence): LifecycleState {
    const stored = this.store.getLifecycle(fence.sessionId);
    if (!stored || !sameLifecycleFence(stored.fence, fence)) return initialLifecycle(fence);
    let state = stored;
    // Receipt persistence precedes this derived ledger. Repair a crash between
    // those writes by original identity; this code has no dispatch capability.
    for (const command of stored.commands) {
      if (command.admission === "accepted" || command.admission === "failed") continue;
      const receipt = this.store.getCommand(command.commandId);
      if (!receipt || receipt.sessionId !== fence.sessionId || receipt.runtimeNodeId !== fence.runtimeNodeId || receipt.payloadHash !== command.payloadHash) continue;
      if (receipt.state !== "succeeded" && receipt.state !== "failed" && receipt.state !== "outcomeUnknown") continue;
      const admission = receipt.state === "succeeded" ? "accepted" : receipt.state;
      if (admission === command.admission) continue;
      const result = receipt.result?.json;
      const messageId = result && typeof result === "object" && !Array.isArray(result) && typeof result.messageId === "string" ? result.messageId : undefined;
      state = reduceLifecycle(state, { version: 1, fence, sequence: state.nextSequence, fact: {
        type: "commandReceipt", commandId: command.commandId, payloadHash: command.payloadHash, admission,
        ...(messageId ? { messageId } : {}),
      } });
    }
    if (state !== stored) this.store.putLifecycle(state);
    return state;
  }

  public append(fence: LifecycleFence, fact: LifecycleFact): LifecycleState {
    const current = this.read(fence);
    const evidence = lifecycleEvidenceSchema.parse({ version: 1, fence, sequence: current.nextSequence, fact });
    const next = reduceLifecycle(current, evidence);
    this.store.putLifecycle(next);
    return next;
  }
}
