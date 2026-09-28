import {
  canonicalJson,
  toJsonValue,
  type CommandEnvelope,
  type CommandId,
  type CommandRecord,
} from "@arduano/agent-multiplex-protocol";

export interface CommandReceiptReader {
  readonly commands: {
    readonly get: { query(commandId: CommandId): Promise<CommandRecord | null> };
  };
}

/** A receipt lookup never admits or redispatches the saved command. */
export async function readCommandReceipt(
  reader: CommandReceiptReader,
  envelope: CommandEnvelope,
): Promise<CommandRecord | null> {
  const receipt = await reader.commands.get.query(envelope.commandId);
  if (receipt) assertCommandReceipt(envelope, receipt);
  return receipt;
}

/** Validate both routing identity and the complete immutable admitted body. */
export function assertCommandReceipt(envelope: CommandEnvelope, receipt: CommandRecord): void {
  const request = toJsonValue(JSON.parse(JSON.stringify(envelope)) as unknown);
  if (
    receipt.commandId !== envelope.commandId ||
    receipt.payloadHash !== envelope.payloadHash ||
    receipt.sessionId !== envelope.sessionId ||
    receipt.runtimeNodeId !== envelope.runtimeNodeId ||
    canonicalJson(receipt.request) !== canonicalJson(request)
  ) {
    throw new Error("The command receipt does not match the original command");
  }
}
