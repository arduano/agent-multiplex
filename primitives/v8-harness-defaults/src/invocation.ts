import { codexDefaults } from "../../v8-harness-codex/src/protocol.js";
import { copilotDefaults } from "../../v8-harness-copilot/src/protocol.js";
import type { Interaction, ManagedPolicy, NativeRun, RunRef, Selection, StopProof } from "../../v8-session/src/contracts/types.js";
import { check, frozen } from "../../v8-session/src/contracts/validation.js";
import { validateSelection } from "./validation.js";
import { validateInteractions, validateRun, validateStopProof } from "../../v8-session/src/native/validation.js";

/** Caller supplies the real root-tree owner. No disconnect/kill acknowledgement is upgraded. */
export function fullStop(run: RunRef, proofSupplier: () => Promise<unknown>): () => Promise<StopProof> {
  const exact = validateRun(run);
  return async () => validateStopProof(exact, await proofSupplier());
}
export function withManagedDefaults(policyValue: ManagedPolicy, value?: Selection): Selection {
  return policyValue.kind === "codex" ? codexDefaults(policyValue, value) : copilotDefaults(policyValue, value);
}

export function nativeRun(options: Readonly<{
  kind: "codex" | "copilot"; run: RunRef; selection: Selection;
  interactionsComplete: boolean; interactions: readonly Interaction[];
  invoke: NativeRun["invoke"]; stopProof: () => Promise<unknown>;
}>): NativeRun {
  check(typeof options.interactionsComplete === "boolean");
  return frozen({ run: validateRun(options.run), selection: validateSelection(options.kind, options.selection),
    interactionsComplete: options.interactionsComplete, interactions: validateInteractions(options.interactions),
    invoke: options.invoke, stop: fullStop(options.run, options.stopProof) });
}

