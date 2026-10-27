import type { NativeProtocol } from "../../v8-session/src/contracts/native-protocol.js";
import { SessionError, type ControlCommand, type ManagedPolicy, type Selection, type CopilotSelection } from "../../v8-session/src/contracts/types.js";
import { copy } from "../../v8-session/src/contracts/validation.js";
import { managedPolicy, validateChoice, validateCommand, validateEvent, validateSelection } from "../../v8-harness-defaults/src/validation.js";
import { validateNativeCommand } from "../../v8-harness-defaults/src/prepared-send.js";
import { validateNativeRead, validateNativeReadResult } from "../../v8-harness-defaults/src/state.js";

/** Copilot owns settings order; lifecycle owns the original and fences each step. */
export const copilotProtocol: NativeProtocol = Object.freeze<NativeProtocol>({
  policy: value => managedPolicy("copilot", value), selection: value => validateSelection("copilot", value),
  command: value => validateCommand("copilot", value), event: value => validateEvent("copilot", value),
  nativeCommand: value => validateNativeCommand("copilot", value), read: value => validateNativeRead("copilot", value), readResult: validateNativeReadResult,
  urgent: type => ["answer", "copilot.abort", "copilot.steer", "copilot.queue.promote", "copilot.task.cancel", "copilot.task.promote", "stop"].includes(type),
  settings: type => ["send", "copilot.model", "copilot.mode", "copilot.permissions"].includes(type),
  prepare: (command, originalId) => command.type === "copilot.mcp.login" ? { ...command, originalId } : command,
  controlSteps(command, observed, capabilities) {
    if (command.type !== "send" || command.selection?.kind !== "copilot") return undefined;
    const selection = command.selection, result: ControlCommand[] = [];
    if (selection.mode !== undefined) result.push({ type: "copilot.mode", mode: selection.mode });
    if (selection.model !== undefined || selection.effort !== undefined) {
      const model = selection.model ?? observed.model; if (!model) throw new SessionError("INVALID");
      const providerId = selection.providerId ?? (observed.kind === "copilot" && (selection.model === undefined || selection.model === observed.model) ? observed.providerId : undefined);
      result.push({ type: "copilot.model", model, ...(providerId ? { providerId } : {}), ...(selection.effort !== undefined ? { effort: selection.effort } : {}) });
    }
    if (selection.permissions !== undefined) {
      if (selection.permissions === "assisted") throw new SessionError("UNSUPPORTED");
      result.push({ type: "copilot.permissions", mode: selection.permissions });
    }
    for (const step of result) if (!capabilities.commands.includes(step.type)) throw new SessionError("UNSUPPORTED");
    return copy(result);
  },
  async preflight(command, observed, catalog, latest) {
    const selection = command.type === "send" ? command.selection : command.type === "copilot.model" ? { kind: "copilot" as const, model: command.model, ...(command.providerId ? { providerId: command.providerId } : {}), ...(command.effort !== undefined ? { effort: command.effort } : {}) } : undefined;
    if (!selection) return;
    if (selection.kind !== "copilot") throw new SessionError("INVALID");
    const model = selection.model ?? (selection.effort !== undefined ? observed.model : undefined);
    if (!model) { if (selection.effort !== undefined && selection.effort !== null) throw new SessionError("INVALID"); return; }
    validateChoice("copilot", { ...selection, model, ...(selection.providerId === undefined && observed.kind === "copilot" && observed.providerId !== undefined ? { providerId: observed.providerId } : {}) }, copy(await catalog()));
    if (selection.model === undefined && observed.model !== latest().model) throw new SessionError("FENCED");
  },
});

/** Trusted creation defaults belong to this harness, separate from observed facts. */
export function copilotDefaults(policyValue: ManagedPolicy, value?: Selection): CopilotSelection {
  const policy = copilotProtocol.policy(policyValue), selected = copilotProtocol.selection(value ?? { kind: "copilot" });
  if (policy.kind !== "copilot" || selected.kind !== "copilot") throw new SessionError("INVALID");
  return copilotProtocol.selection({ ...selected, permissions: selected.permissions ?? policy.permissions }) as CopilotSelection;
}
