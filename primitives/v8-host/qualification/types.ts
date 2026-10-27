import type { CodexTransport } from "../../v8-harness-codex/src/controller.js";
import type { CopilotTransport, CopilotSession } from "../../v8-harness-copilot/src/controller.js";
import type { CopilotBeforeTool, CopilotRuntimeOptions } from "../../v8-harness-copilot/src/runtime.js";
declare const codex: CodexTransport, copilot: CopilotTransport, session: CopilotSession;
if (false) {
  // @ts-expect-error Harness-native method families are distinct.
  void codex.request("session.resume", {});
  // @ts-expect-error Native Send requires an original typed input and thread.
  void codex.request("turn/start", { threadId: "native" });
  // @ts-expect-error Copilot transport is the concrete SDK family, not Codex RPC.
  void copilot.request("turn/start", {});
  // @ts-expect-error Typed Copilot controls cannot invoke Codex defaults.
  void session.rpc.thread.settings.update({});
}
// @ts-expect-error Trusted pre-tool policy cannot bypass native approval.
const allow:CopilotBeforeTool=()=>({permissionDecision:"allow"});
// @ts-expect-error JSON static options cannot carry executable hook capabilities.
const configured:NonNullable<CopilotRuntimeOptions["sessionOptions"]>={hooks:{onPreToolUse:()=>null}};
void allow;void configured;
