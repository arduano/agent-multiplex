import type { CodexAccess, ControlFor } from "../src/contracts/types.js";
declare const codex: (command: ControlFor<"codex">) => void;
declare const copilot: (command: ControlFor<"copilot">) => void;
if (false) {
  codex({ type: "codex.interrupt", turnId: "original" });
  copilot({ type: "copilot.model", model: "m", providerId: "exact", effort: null });
  // @ts-expect-error A Codex client cannot call a Copilot setter.
  codex({ type: "copilot.mode", mode: "plan" });
  // @ts-expect-error A Copilot client cannot call Codex exact-turn interruption.
  copilot({ type: "codex.interrupt", turnId: "original" });
  // @ts-expect-error Native profile and sandbox are mutually exclusive.
  const conflicting: CodexAccess = { approval: "on-request", profile: "selected", sandbox: "danger-full-access" };
  void conflicting;
}
