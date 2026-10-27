import type { NativeProtocol } from "../../v8-session/src/contracts/native-protocol.js";
import { SessionError, type ManagedPolicy, type Selection, type CodexSelection } from "../../v8-session/src/contracts/types.js";
import { copy } from "../../v8-session/src/contracts/validation.js";
import { managedPolicy, validateChoice, validateCommand, validateEvent, validateSelection } from "../../v8-harness-defaults/src/validation.js";
import { validateNativeCommand } from "../../v8-harness-defaults/src/prepared-send.js";
import { validateNativeRead, validateNativeReadResult } from "../../v8-harness-defaults/src/state.js";

/** Codex-owned admission/selection rules, installed explicitly by its adapter. */
export const codexProtocol: NativeProtocol = Object.freeze<NativeProtocol>({
  policy: value => managedPolicy("codex", value), selection: value => validateSelection("codex", value),
  command: value => validateCommand("codex", value), event: value => validateEvent("codex", value),
  nativeCommand: value => validateNativeCommand("codex", value), read: value => validateNativeRead("codex", value), readResult: validateNativeReadResult,
  urgent: type => ["answer", "codex.interrupt", "codex.steer", "codex.queue.add", "stop"].includes(type),
  settings: type => ["send", "codex.defaults", "codex.turn"].includes(type),
  prepare: (command, id) => command.type === "codex.queue.add" || command.type === "send" ? { ...command, clientUserMessageId: id } : command.type === "codex.mcp.login" ? { ...command, originalId: id } : command,
  controlSteps: () => undefined,
  async preflight(command, observed, catalog, latest) {
    const selection = command.type === "send" || command.type === "codex.defaults" || command.type === "codex.turn" ? command.selection : undefined;
    if (!selection) return;
    if (selection.kind !== "codex") throw new SessionError("INVALID");
    const collaboration = selection.collaboration, model = collaboration?.model ?? selection.model ?? (selection.effort !== undefined ? observed.model : undefined);
    if (!model) { if (selection.effort !== undefined && selection.effort !== null) throw new SessionError("INVALID"); return; }
    validateChoice("codex", { ...selection, model, ...(collaboration ? { effort: collaboration.effort } : {}) }, copy(await catalog()));
    if (selection.model === undefined && !collaboration && observed.model !== latest().model) throw new SessionError("FENCED");
  },
});

/** Trusted creation defaults belong to this harness, separate from observed facts. */
export function codexDefaults(policyValue: ManagedPolicy, value?: Selection): CodexSelection {
  const policy = codexProtocol.policy(policyValue), selected = codexProtocol.selection(value ?? { kind: "codex" });
  if (policy.kind !== "codex" || selected.kind !== "codex") throw new SessionError("INVALID");
  return codexProtocol.selection({ ...selected, access: selected.access ?? policy.access }) as CodexSelection;
}
