import type { CommandRecord } from "@arduano/agent-multiplex-protocol";

export interface SubmittedDraft {
  readonly bindingIdentity: string;
  readonly prompt: string;
  readonly imageIds: readonly string[];
}

/** Acceptance may consume only the exact draft submitted by this binding. */
export function maySettleCommandDraft(
  current: SubmittedDraft,
  submitted: SubmittedDraft | undefined,
  receipt: Pick<CommandRecord, "state">,
): boolean {
  return receipt.state === "succeeded" && submitted !== undefined &&
    current.bindingIdentity === submitted.bindingIdentity &&
    current.prompt === submitted.prompt &&
    current.imageIds.length === submitted.imageIds.length &&
    current.imageIds.every((id, index) => id === submitted.imageIds[index]);
}
