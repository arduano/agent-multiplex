import type { z } from "zod";
import { defaultLifecycle, type NativeHarnessDefinition } from "../src/plugin.js";
import { existingDirectoryWorkspace } from "../src/workspace.js";
import type { SessionSnapshot } from "../../v8-session/src/contracts/types.js";
declare const harness: NativeHarnessDefinition<"codex">;
const plugin = defaultLifecycle({ harness, workspace: existingDirectoryWorkspace(), directory: "/qualification-only", policy: { kind: "codex", provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } } });
type Input = z.input<typeof plugin.createInput>;
const good: Input = { session: "one", workspace: { cwd: "/workspace" }, selection: { kind: "codex", effort: "low" } };
// @ts-expect-error Codex lifecycle creation cannot receive Copilot selection fields.
const wrong: Input = { session: "one", workspace: { cwd: "/workspace" }, selection: { kind: "copilot", mode: "autopilot" } };
type Public = z.output<typeof plugin.public.session>;
declare const current: Public;
if (current.native) {
  const codex: "codex" = current.native.kind;
  // @ts-expect-error Copilot mode is absent from the narrowed Codex selection.
  current.native.selection.mode;
  const compatible: SessionSnapshot = current.native;
  void codex; void compatible;
}
void good; void wrong;
