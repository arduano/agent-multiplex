import type { CodexAccess, CodexEncodedInput, GoalStatus, Json } from "../../v8-session/src/contracts/types.js";
import type { CodexInventoryRequest } from "../../v8-mcp/src/contracts.js";

/** Closed pinned Codex request bodies shared by the encoder and transport. */
export type CodexOpenParams = Readonly<{ model: string; modelProvider: string; cwd: string; developerInstructions?: string }> & import('./access.js').CodexOpeningAccess;
export type CodexNativeInput = Readonly<{ type: "text"; text: string; text_elements: readonly never[] }> | CodexEncodedInput;
export type CodexSettings = Readonly<{ model?: string; effort?: string | null; approvalPolicy?: CodexAccess["approval"]; permissions?: string; sandboxPolicy?: Json;
  collaborationMode?: Readonly<{ mode: "plan" | "default"; settings: Readonly<{ model: string; reasoning_effort: string | null; developer_instructions: string | null }> }> }>;
export interface CodexRequests {
  "thread/start": CodexOpenParams & Readonly<{ ephemeral: false }>;
  "thread/resume": CodexOpenParams & Readonly<{ threadId: string; excludeTurns: true }>;
  "thread/settings/update": Readonly<{ threadId: string }> & CodexSettings;
  "turn/settings/update": Readonly<{ threadId: string; turnId: string }> & CodexSettings;
  "turn/interrupt": Readonly<{ threadId: string; turnId: string }>;
  "thread/queue/add": Readonly<{ threadId: string; input: readonly CodexNativeInput[]; clientUserMessageId: string }>;
  "turn/steer": Readonly<{ threadId: string; expectedTurnId: string; input: readonly CodexNativeInput[] }>;
  "thread/compact/start": Readonly<{ threadId: string }>;
  "thread/goal/get": Readonly<{ threadId: string }>;
  "thread/goal/set": Readonly<{ threadId: string; objective?: string; status?: GoalStatus; tokenBudget?: number | null }>;
  "thread/goal/clear": Readonly<{ threadId: string }>;
  "thread/backgroundTerminals/list": Readonly<{ threadId: string; cursor: string | null; limit: number }>;
  "thread/backgroundTerminals/terminate": Readonly<{ threadId: string; processId: string }>;
  "thread/backgroundTerminals/clean": Readonly<{ threadId: string }>;
  "turn/start": Readonly<{ threadId: string; input: readonly CodexNativeInput[]; clientUserMessageId?: string }> & CodexSettings;
  "mcpServerStatus/list": CodexInventoryRequest;
  "config/mcpServer/reload": undefined;
  "mcpServer/oauth/login": Readonly<{ name: string; threadId: string; timeoutSecs: number }>;
}

export type CodexInvocationMethod =
  | "thread/settings/update" | "turn/settings/update" | "turn/interrupt"
  | "thread/queue/add" | "turn/steer" | "thread/compact/start"
  | "thread/goal/set" | "thread/goal/clear" | "thread/backgroundTerminals/terminate"
  | "thread/backgroundTerminals/clean" | "turn/start";
/** The tuple union preserves method/body correlation, including union callers. */
export type CodexInvocationRequest = { [M in CodexInvocationMethod]: [method: M, params: CodexRequests[M]] }[CodexInvocationMethod];
export type CodexInvocationRpc = (...request: CodexInvocationRequest) => Promise<unknown>;
