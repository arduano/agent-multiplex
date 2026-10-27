import type { CodexInvocationRpc } from "../src/request-contract.js";
import type { TRPCClient } from "@trpc/client";
import type { CodexHarnessRouter } from "../src/router.js";
import type { CopilotHarnessRouter } from "../../v8-harness-copilot/src/router.js";
import type { CodexHarnessOptions } from "../src/plugin.js";
import { copilotAgents, copilotSettings, type CopilotAgent } from "../../v8-harness-copilot/src/contributions.js";
import { copilotInstructions } from "../../v8-harness-copilot/src/contributions.js";

declare const codex: TRPCClient<CodexHarnessRouter>, copilot: TRPCClient<CopilotHarnessRouter>, invoke: CodexInvocationRpc;
declare const ambiguousMethod: "turn/start" | "turn/interrupt";
if (false) {
  void invoke("turn/start", { threadId: "native", input: [] });
  void invoke("turn/interrupt", { threadId: "native", turnId: "exact-turn" });
  // @ts-expect-error A valid queue body cannot be paired with interrupt.
  void invoke("turn/interrupt", { threadId: "native", input: [], clientUserMessageId: "original" });
  // @ts-expect-error A union method cannot erase its required body correlation.
  void invoke(ambiguousMethod, { threadId: "native", input: [] });
  // @ts-expect-error Native effort is not an arbitrary JSON value.
  void invoke("thread/settings/update", { threadId: "native", effort: { invalid: true } });

  // @ts-expect-error Codex cannot invoke the Copilot mode control.
  void codex.submit.mutate({ id: "original", generation: 1, command: { type: "copilot.mode", mode: "plan" } });
  // @ts-expect-error Copilot cannot invoke the Codex interrupt control.
  void copilot.submit.mutate({ id: "original", generation: 1, command: { type: "codex.interrupt", turnId: "turn" } });
  // The actual Codex driver now exposes its pinned defaults-update encoder.
  void codex.submit.mutate({ id: "original", generation: 1, command: { type: "codex.defaults", selection: { kind: "codex", model: "m" } } });
  void codex.submit.mutate({ id: "turn-original", generation: 1, command: { type: "codex.turn", turnId: "exact-turn", selection: { kind: "codex", effort: "high" } } });
  void codex.read.query({ generation: 1, nativeSession: "native", request: { type: "codex.terminals", cursor: "next-page", limit: 10 } });
  void codex.submit.mutate({ id: "terminate-original", generation: 1, command: { type: "codex.terminal.terminate", processId: "native-process" } });
  void codex.submit.mutate({ id: "reload-original", generation: 1, command: { type: "codex.mcp.reload" } });
  void copilot.submit.mutate({ id: "reconnect-original", generation: 1, command: { type: "copilot.mcp.reconnect", serverName: "configured" } });
  void codex.submit.mutate({ id: 'login-codex', generation: 1, command: { type: 'codex.mcp.login', serverName: 'configured' } });
  void copilot.submit.mutate({ id: 'login-copilot', generation: 1, command: { type: 'copilot.mcp.login', serverName: 'configured', forceReauth: true } });
  void codex.loginLink.query({ generation: 1, nativeSession: 'native', originalId: 'login-codex' });
  // @ts-expect-error Codex has no native force-reauth semantic.
  void codex.submit.mutate({ id: 'bad-login', generation: 1, command: { type: 'codex.mcp.login', serverName: 'configured', forceReauth: true } });
  // @ts-expect-error Trusted original ID is injected by prepare, never supplied as native fields.
  void copilot.submit.mutate({ id: 'bad-login', generation: 1, command: { type: 'copilot.mcp.login', serverName: 'configured', originalId: 'forged' } });
  // @ts-expect-error Codex has no native per-server Copilot restart action.
  void codex.submit.mutate({ id: "wrong-mcp", generation: 1, command: { type: "copilot.mcp.reconnect", serverName: "configured" } });
  // @ts-expect-error Copilot has no Codex configuration-wide reload action.
  void copilot.submit.mutate({ id: "wrong-mcp", generation: 1, command: { type: "codex.mcp.reload" } });
  // @ts-expect-error Wrong harness native history/control read.
  void copilot.read.query({ generation: 1, nativeSession: "native", request: { type: "codex.goal" } });
  // @ts-expect-error Copilot does not expose native Codex terminal management.
  void copilot.read.query({ generation: 1, nativeSession: "native", request: { type: "codex.terminals" } });
  // @ts-expect-error Contributions are statically targeted to one harness.
  const options: Pick<CodexHarnessOptions, "contributions"> = { contributions: [copilotInstructions({ id: "wrong", text: "wrong" })] };
  // @ts-expect-error Managed settings cannot be enabled without a supported token contract.
  copilotSettings({ id: "unsupported", enableManagedSettings: true });
  const child: CopilotAgent = { name: "child", prompt: "One task.", model: "gpt-6-luna", reasoningEffort: "xhigh", tools: [] };
  copilotAgents({ id: "supported-child", agents: [child] });
  // @ts-expect-error Only the pinned Copilot SDK effort values are supported.
  copilotAgents({ id: "bad-effort", agents: [{ name: "child", prompt: "task", reasoningEffort: "ultra" }] });
  // @ts-expect-error A native model identifier is a string.
  copilotAgents({ id: "bad-model", agents: [{ name: "child", prompt: "task", model: 42 }] });
  // @ts-expect-error Unknown native settings must not become forwarded configuration.
  copilotAgents({ id: "unknown-setting", agents: [{ name: "child", prompt: "task", unsupportedSetting: true }] });
  // @ts-expect-error Codex effort spelling is not the Copilot custom-agent field.
  copilotAgents({ id: "wrong-harness-fields", agents: [{ name: "child", prompt: "task", effort: "high" }] });
  // @ts-expect-error Copilot custom-agent configuration cannot enter a Codex harness.
  const childOptions: Pick<CodexHarnessOptions, "contributions"> = { contributions: [copilotAgents({ id: "wrong-harness", agents: [child] })] };
  void childOptions;
  void options;
}
