import type { Json } from "../../protocol/index.js";
import {
  codexMessageSchema,
  type CodexCommand,
  type CodexInput,
  type CodexMessage,
  type CodexPatch,
  type CodexSelection,
  type CodexObservedSelection,
} from "../contracts.js";
import type { CodexRequestPort } from "../node-contracts.js";
import { readGoal } from "./reads.js";
import { check, CodexError, json, object, text } from "./validation.js";

export function sandbox(access: CodexSelection["access"]): Json {
  check("sandbox" in access, "PERMISSION_PROFILE_NOT_SANDBOX");
  return access.sandbox === "danger-full-access"
    ? { type: "dangerFullAccess" }
    : access.sandbox === "read-only"
      ? { type: "readOnly", networkAccess: false }
      : {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        };
}
/** Sticky native collaboration settings take precedence over top-level fields.
 * A patch preserves positively observed instructions or refuses before RPC. */
export function settings(
  patch: CodexPatch,
  current: CodexObservedSelection,
  threadScope = true,
): Record<string, Json> {
  const result: Record<string, Json> = {};
  if (patch.model !== undefined) result.model = patch.model;
  if (patch.effort !== undefined) result.effort = patch.effort;
  let collaboration = patch.collaboration;
  if (threadScope && !collaboration && (patch.model !== undefined || patch.effort !== undefined)) {
    check(current.collaboration, "COLLABORATION_UNOBSERVED");
    collaboration = {
      ...current.collaboration,
      ...(patch.model === undefined ? {} : { model: patch.model }),
      ...(patch.effort === undefined ? {} : { effort: patch.effort }),
    };
  }
  if (collaboration)
    result.collaborationMode = {
      mode: collaboration.mode,
      settings: {
        model: collaboration.model,
        reasoning_effort: collaboration.effort,
        developer_instructions: collaboration.instructions,
      },
    };
  if (patch.access) {
    result.approvalPolicy = patch.access.approval;
    if ("profile" in patch.access) result.permissions = patch.access.profile;
    else result.sandboxPolicy = sandbox(patch.access);
  }
  return result;
}
export function inputs(value: CodexMessage, prepared: readonly CodexInput[]): readonly Json[] {
  return [
    ...(value.text ? [{ type: "text", text: value.text, text_elements: [] }] : []),
    ...prepared,
  ] as Json[];
}
const acknowledged = (value: unknown): Json => {
  check(Object.keys(object(value)).length === 0, "ACK_SHAPE");
  return { acknowledged: true };
};
function accepted(value: unknown): Json {
  return { turnId: text(object(object(value).turn).id) };
}
export async function send(
  rpc: CodexRequestPort,
  threadId: string,
  originalId: string,
  message: unknown,
  selection: CodexObservedSelection,
  prepared: readonly CodexInput[],
): Promise<Json> {
  const value = codexMessageSchema.parse(message),
    native = inputs(value, prepared);
  check(native.length > 0, "EMPTY_MESSAGE");
  return accepted(
    await rpc.request("turn/start", {
      threadId,
      input: native,
      clientUserMessageId: originalId,
      ...settings(value.selection ?? {}, selection),
    }),
  );
}
/** Actual native method/body encoding. An ACK is operation acceptance, never
 * completed model work. Unknown native errors are not rewritten as safe refusal. */
export async function invoke(
  rpc: CodexRequestPort,
  threadId: string,
  originalId: string,
  command: Exclude<CodexCommand, { type: "native" | "nativeAnswer" }>,
  selection: CodexObservedSelection,
  activity: { state: string; turnId: string | null },
  prepared: readonly CodexInput[] = [],
): Promise<Json> {
  switch (command.type) {
    case "settings":
      return acknowledged(
        await rpc.request("thread/settings/update", {
          threadId,
          ...settings(command.patch, selection),
        }),
      );
    case "turnSettings": {
      const result = object(
        await rpc.request("turn/settings/update", {
          threadId,
          turnId: command.turnId,
          ...(command.model === undefined ? {} : { model: command.model }),
          ...(command.effort === undefined ? {} : { effort: command.effort }),
        }),
      );
      check(
        result.status === "applied" || result.status === "targetUnavailable",
        "TURN_SETTINGS_RESULT",
      );
      return { status: result.status };
    }
    case "steer": {
      const result = object(
        await rpc.request("turn/steer", {
          threadId,
          expectedTurnId: command.expectedTurnId,
          input: inputs(command.message, prepared),
        }),
      );
      check(result.turnId === command.expectedTurnId, "STEER_TARGET");
      return { turnId: command.expectedTurnId };
    }
    case "queue": {
      const result = object(
        object(
          await rpc.request("thread/queue/add", {
            threadId,
            clientUserMessageId: originalId,
            input: inputs(command.message, prepared),
          }),
        ).queuedSubmission,
      );
      check(result.clientUserMessageId === originalId, "QUEUE_ORIGINAL");
      return { queuedSubmission: { id: text(result.id), clientUserMessageId: originalId } };
    }
    case "interrupt":
      return acknowledged(
        await rpc.request("turn/interrupt", { threadId, turnId: command.turnId }),
      );
    case "continue":
      check(
        (activity.state === "idle" || activity.state === "failed") && activity.turnId === null,
        "CONTINUE_REQUIRES_POSITIVE_IDLE",
      );
      return accepted(await rpc.request("turn/start", { threadId, input: [] }));
    case "compact":
      return acknowledged(await rpc.request("thread/compact/start", { threadId }));
    case "goal.set": {
      const { type: _type, ...patch } = command;
      const goal = readGoal(await rpc.request("thread/goal/set", { threadId, ...patch }), threadId);
      check(
        goal &&
          (command.objective === undefined || command.objective === goal.objective) &&
          (command.status === undefined || command.status === goal.status) &&
          (command.tokenBudget === undefined || command.tokenBudget === goal.tokenBudget),
        "GOAL_PATCH_UNPROVED",
      );
      return { goal: json(goal, 32768) };
    }
    case "goal.clear": {
      const result = object(await rpc.request("thread/goal/clear", { threadId }));
      check(typeof result.cleared === "boolean");
      return { cleared: result.cleared };
    }
    case "terminal.terminate": {
      const result = object(
        await rpc.request("thread/backgroundTerminals/terminate", {
          threadId,
          processId: command.processId,
        }),
      );
      check(typeof result.terminated === "boolean");
      return { processId: command.processId, terminated: result.terminated };
    }
    case "terminals.clean":
      return acknowledged(await rpc.request("thread/backgroundTerminals/clean", { threadId }));
    case "mcp.reload":
      return acknowledged(await rpc.request("config/mcpServer/reload", undefined));
    case "answer":
      throw new CodexError("CALLBACK_OWNER_REQUIRED");
    case "mcp.login":
      throw new CodexError("PRIVATE_LOGIN_OWNER_REQUIRED");
  }
}
