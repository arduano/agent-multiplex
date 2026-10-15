import { AdapterInputNotSubmittedError, AdapterOperationPendingError } from "@arduano/agent-multiplex-runtime-node-core";
import type { HarnessCommand, JsonValue } from "@arduano/agent-multiplex-protocol";
import { CodexRpcError } from "./rpc.js";

export type CodexInputOperation = "send" | "steer" | "interrupt";
export function validateCodexLocalInput(envelope: HarnessCommand): void {
  const command = envelope.command;
  if (command.type !== "send" && command.type !== "steer" && command.type !== "interrupt") return;
  const invalid = () => { throw new AdapterInputNotSubmittedError(command.type, "invalidInput"); };
  if (envelope.harness !== "codex") invalid();
  const id = command.type === "steer" && "expectedTurnId" in command ? command.expectedTurnId
    : command.type === "interrupt" && "turnId" in command ? command.turnId : undefined;
  if (id !== undefined && (typeof id !== "string" || !id.trim() || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id))) invalid();
  if (envelope.harness !== "codex") return;
  const codexCommand = envelope.command;
  if (codexCommand.type !== "send" && codexCommand.type !== "steer") return;
  const input = codexCommand.input;
  if (typeof input === "string") return;
  if (!Array.isArray(input)) invalid();
  for (const value of input as JsonValue[]) {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string" || !value.type.trim()) invalid();
    const item = value as Record<string, JsonValue>;
    if (item.type === "text" && (typeof item.text !== "string" || item.text_elements !== undefined && !Array.isArray(item.text_elements))) invalid();
    if (item.type === "image" && typeof item.url !== "string" && typeof item.fileId !== "string") invalid();
    if ((item.type === "audio" && typeof item.url !== "string") ||
        (["localImage", "localAudio", "skill", "mention"].includes(item.type as string) && typeof item.path !== "string")) invalid();
  }
}
export function codexObservationTimeout(value: number | undefined): number {
  const selected = value ?? (process.platform === "win32" ? 60_000 : 15_000);
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 600_000)
    throw new RangeError("Codex observation budget must be between 1 and 600000 milliseconds");
  return selected;
}

/** Only pinned, operation-specific NotSubmitted branches carry definite proof.
 * Other RPC errors, internal exceptions, and transport loss remain uncertain. */
export function codexInputNotSubmitted(error: unknown, operation: CodexInputOperation): AdapterInputNotSubmittedError | undefined {
  if (error instanceof AdapterInputNotSubmittedError) return error;
  if (!(error instanceof CodexRpcError)) return undefined;
  if (error.phase === "beforeDispatch") return new AdapterInputNotSubmittedError(operation,
    error.code === -32600 ? "invalidInput" : "nativeNotReady", undefined, { cause: error });
  if (operation === "steer" && error.code === -32600) {
    if (error.message === "no active turn to steer")
      return new AdapterInputNotSubmittedError(operation, "noActiveTurn", undefined, { cause: error });
    const mismatch = /^expected active turn id `([^`\r\n]+)` but found `([^`\r\n]+)`$/.exec(error.message);
    if (mismatch && mismatch[2]!.length <= 256 && !/[\u0000-\u001f\u007f]/.test(mismatch[2]!))
      return new AdapterInputNotSubmittedError(operation, "expectedTurnMismatch", mismatch[2], { cause: error });
    if (error.message === "cannot steer a review turn" || error.message === "cannot steer a compact turn")
      return new AdapterInputNotSubmittedError(operation, "activeTurnNotSteerable", undefined, { cause: error });
  }
  if (operation === "send" && error.code === -32603 &&
      /^failed to submit turn input: ActiveTurnNotSteerable \{ turn_kind: (Review|Compact) \}$/.test(error.message))
    return new AdapterInputNotSubmittedError(operation, "activeTurnNotSteerable", undefined, { cause: error });
  if (operation === "interrupt" && error.code === -32600) {
    if (error.message === "no active turn to interrupt")
      return new AdapterInputNotSubmittedError(operation, "noActiveTurn", undefined, { cause: error });
    if (/^expected active turn id [^\r\n]+ but found [^\r\n]+$/.test(error.message))
      return new AdapterInputNotSubmittedError(operation, "expectedTurnMismatch", undefined, { cause: error });
  }
  return undefined;
}

/** This observation ends; ownership stays with the original operation. */
export function observeCodexOperation<T extends JsonValue | undefined>(settlement: Promise<T>, operation: string,
  timeoutMs: number): Promise<T> {
  void settlement.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AdapterOperationPendingError(settlement, operation)), timeoutMs);
    timer.unref();
    void settlement.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
