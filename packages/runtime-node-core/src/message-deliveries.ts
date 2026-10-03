import {
  commandObservationView,
  isoDateSchema,
  projectDelivery,
  type CommandRecord,
  type LifecycleCommand,
  type LifecycleState,
} from "@arduano/agent-multiplex-protocol";

/** Presentation deadline only: it never establishes a native delivery outcome. */
export const MESSAGE_DELIVERY_WARNING_AFTER_MS = 120_000;
const MESSAGE_DELIVERY_VIEW_LIMIT = 32;

export interface MessageDeliveryCandidate {
  command: LifecycleCommand;
  receipt: CommandRecord;
  text: string;
  imageCount: number;
}

export type MessageDeliveryItem = {
  commandId: LifecycleCommand["commandId"];
  kind: "send" | "steer";
  state: Lowercase<ReturnType<typeof projectDelivery>>;
  text: string;
  imageCount: number;
  createdAt: string;
  messageId?: string;
};

export type MessageDeliveryWarningReason = "deliveryUnconfirmed" | "consumptionUnconfirmed" | "admissionUncertain";
export type MessageDeliveryWarning = MessageDeliveryItem & {
  reason: MessageDeliveryWarningReason;
};

/**
 * Split unresolved admissions from old, unconfirmed delivery reminders.
 * This is a read-only presentation: receipts, delivery evidence and command
 * continuations retain their original meaning. Fresh exact native queue
 * membership always wins over the presentation deadline.
 */
export function projectMessageDeliveries(
  state: LifecycleState,
  candidates: readonly MessageDeliveryCandidate[],
  timestamp: number,
): { items: MessageDeliveryItem[]; omitted: number; warnings: MessageDeliveryWarning[]; warningsOmitted: number } {
  const items: MessageDeliveryItem[] = [];
  const warnings: MessageDeliveryWarning[] = [];
  for (const { command, receipt, text, imageCount } of candidates) {
    if ((command.kind !== "send" && command.kind !== "steer") || command.consumed || command.settled || command.admission === "failed") continue;
    if (receipt.commandId !== command.commandId || receipt.sessionId !== state.fence.sessionId ||
      receipt.runtimeNodeId !== state.fence.runtimeNodeId || receipt.payloadHash !== command.payloadHash) continue;
    // B18: no native identity can refine this definitively succeeded legacy
    // admission. Keep its immutable Accepted receipt without a pending row.
    if (command.admission === "accepted" && command.messageId === undefined && receipt.state === "succeeded" &&
      commandObservationView(receipt, state).continuation === "complete") continue;

    const item: MessageDeliveryItem = { commandId: command.commandId, kind: command.kind,
      state: projectDelivery(command, state).toLowerCase() as MessageDeliveryItem["state"],
      text, imageCount, createdAt: receipt.createdAt,
      ...(command.messageId === undefined ? {} : { messageId: command.messageId }) };
    const queued = command.messageId !== undefined && state.queue.observation.state === "observed" &&
      state.queue.items.some(entry => entry.messageId === command.messageId);
    // Prepared/Dispatched work is still in progress, even if a native call is
    // slow. Only a terminal admission may leave the pending presentation.
    const terminal = (receipt.state === "succeeded" || receipt.state === "outcomeUnknown") &&
      (command.admission === "accepted" || command.admission === "outcomeUnknown");
    const validDate = isoDateSchema.safeParse(receipt.updatedAt).success;
    const receiptTimestamp = validDate ? Date.parse(receipt.updatedAt) : Number.NaN;
    const elapsed = timestamp - receiptTimestamp;
    if (!queued && terminal && Number.isFinite(timestamp) && Number.isFinite(receiptTimestamp) &&
      elapsed >= MESSAGE_DELIVERY_WARNING_AFTER_MS) {
      warnings.push({ ...item, reason: receipt.state === "outcomeUnknown" || command.admission === "outcomeUnknown"
        ? "admissionUncertain" : command.displayed ? "consumptionUnconfirmed" : "deliveryUnconfirmed" });
    } else items.push(item);
  }
  return {
    items: items.slice(-MESSAGE_DELIVERY_VIEW_LIMIT), omitted: Math.max(0, items.length - MESSAGE_DELIVERY_VIEW_LIMIT),
    warnings: warnings.slice(-MESSAGE_DELIVERY_VIEW_LIMIT), warningsOmitted: Math.max(0, warnings.length - MESSAGE_DELIVERY_VIEW_LIMIT),
  };
}
