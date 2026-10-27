import type { ArtifactRef, DiskRef } from "../../v8-files/src/contracts/types.js";
import type { ControlFor } from "../../v8-session/src/contracts/types.js";

declare const artifact: ArtifactRef;
declare const file: DiskRef;
declare const codex: (command: ControlFor<"codex">) => void;
declare const copilot: (command: ControlFor<"copilot">) => void;
function onlyTypes(): void {
  codex({ type: "send", text: "", inputs: { kind: "codex", items: [{ type: "image", artifact }, { type: "mention", file, name: "owned" }] } });
  copilot({ type: "send", text: "", inputs: { kind: "copilot", items: [{ type: "blob", artifact }, { type: "file", file }] } });
  // @ts-expect-error Copilot generic blobs are not Codex inputs.
  codex({ type: "send", text: "x", inputs: { kind: "copilot", items: [{ type: "blob", artifact }] } });
  // @ts-expect-error Codex mention controls are not Copilot inputs.
  copilot({ type: "send", text: "x", inputs: { kind: "copilot", items: [{ type: "mention", file, name: "owned" }] } });
  codex({ type: "codex.steer", expectedTurnId: "current", text: "", inputs: { kind: "codex", items: [{ type: "image", artifact }] } });
  codex({ type: "codex.queue.add", text: "", inputs: { kind: "codex", items: [{ type: "localImage", file }] } });
  copilot({ type: "copilot.steer", text: "", inputs: { kind: "copilot", items: [{ type: "blob", artifact }] } });
  // @ts-expect-error A Codex steer cannot contain Copilot attachments.
  codex({ type: "codex.steer", expectedTurnId: "current", text: "x", inputs: { kind: "copilot", items: [{ type: "blob", artifact }] } });
  // @ts-expect-error A Copilot steer has no Codex expected-turn argument.
  copilot({ type: "copilot.steer", expectedTurnId: "guessed", text: "x" });
  // @ts-expect-error Private buffers cannot be submitted by browser actions.
  codex({ type: "send", text: "x", nativeInputs: { kind: "codex", items: [{ type: "image", artifact, bytes: new Uint8Array() }] } });
}
void onlyTypes;
