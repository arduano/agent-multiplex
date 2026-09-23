import { z } from "zod";

import { commandRecordSchema, type CommandRecord } from "./command.js";
import { projectDelivery, type LifecycleState } from "./lifecycle.js";

export const commandDeliverySchema = z.enum([
  "prepared", "dispatched", "accepted", "queued", "displayed", "consumed", "settled", "failed", "unknown",
]);
export const commandContinuationSchema = z.enum(["waitForReceipt", "observeDelivery", "reviewRequired", "complete"]);
export const commandObservationViewSchema = z.object({
  receipt: commandRecordSchema,
  delivery: commandDeliverySchema,
  continuation: commandContinuationSchema,
}).strict();
export type CommandObservationView = z.infer<typeof commandObservationViewSchema>;

/** Derive a public command view without replay authority or heuristic causality. */
export function commandObservationView(receipt: CommandRecord, state?: LifecycleState): CommandObservationView {
  const command = state?.commands.find((candidate) => candidate.commandId === receipt.commandId && candidate.payloadHash === receipt.payloadHash);
  const delivery = command ? projectDelivery(command, state!).toLowerCase() as CommandObservationView["delivery"]
    : receipt.state === "failed" ? "failed"
      : receipt.state === "outcomeUnknown" ? "unknown"
        : receipt.state === "succeeded" ? "accepted"
          : receipt.state === "started" || receipt.state === "received" ? "dispatched" : "prepared";
  const request = receipt.request && typeof receipt.request === "object" && !Array.isArray(receipt.request)
    ? receipt.request as Record<string, unknown> : undefined;
  const harnessRequest = request?.request && typeof request.request === "object" && !Array.isArray(request.request)
    ? request.request as Record<string, unknown> : undefined;
  const nativeCommand = harnessRequest?.command && typeof harnessRequest.command === "object" && !Array.isArray(harnessRequest.command)
    ? harnessRequest.command as Record<string, unknown> : undefined;
  const kind = command?.kind ?? (nativeCommand?.type === "send" || nativeCommand?.type === "steer" || nativeCommand?.type === "compact" ? nativeCommand.type : "other");
  const continuation: CommandObservationView["continuation"] = receipt.state === "outcomeUnknown" ? "reviewRequired"
    : receipt.state === "failed" || delivery === "settled" || delivery === "consumed" ||
      receipt.state === "succeeded" && (kind !== "send" && kind !== "steer" || command?.messageId === undefined) ? "complete"
      : receipt.state === "succeeded" ? "observeDelivery" : "waitForReceipt";
  return commandObservationViewSchema.parse({ receipt, delivery, continuation });
}
