import { z } from "zod";
import type { RunRef, Receipt, Json } from "../protocol/index.js";
import type * as Native from "./protocol/index.js";
import * as schema from "./protocol/schemas.js";
import type { CodexCapturedState } from "./capture-contracts.js";
export type { CodexCapturedState, CodexCapturedItem } from "./capture-contracts.js";

export type * from "./protocol/index.js";
/** Results are full native DTOs. Refusal is Multiplex admission evidence. */
export type CodexReceipt<Result> = Receipt<Result>;
export type CodexCaptureCursor = Readonly<{ attachment: string; revision: number }>;
export type CodexCaptureEvent = Readonly<{
  cursor: CodexCaptureCursor;
  notification: Native.CodexNotification;
}>;
export type CodexCaptureSnapshot = Readonly<{
  run: RunRef;
  attachment: string;
  revision: number;
  source: "host-capture";
  coverage: Readonly<{
    kind: "bounded-observation";
    nativeContinuity: "unproved";
    earlierOmitted: boolean;
    /** Local managed-open provenance; never a native history/read watermark. */
    openedAs: "created" | "resumed" | "unknown";
  }>;
  events: readonly CodexCaptureEvent[];
  state: CodexCapturedState;
}>;
/** Native serde_json index signatures permit undefined statically; captured
 * wire frames have already crossed JSON validation and are actual DTO trees.
 * The intersection records that transport fact without changing vendor DTOs. */
export type CodexCaptureFrame = (
  | Readonly<{ kind: "snapshot" | "gap"; snapshot: CodexCaptureSnapshot }>
  | Readonly<{ kind: "notification"; run: RunRef; event: CodexCaptureEvent }>
) &
  Json;
export type CodexCallbackRef = Readonly<{
  run: RunRef;
  attachment: string;
  requestId: string | number;
  incarnation: number;
}>;
export type CodexCallback =
  | Readonly<{
      method: "item/commandExecution/requestApproval";
      params: Native.CommandExecutionRequestApprovalParams;
    }>
  | Readonly<{
      method: "item/fileChange/requestApproval";
      params: Native.FileChangeRequestApprovalParams;
    }>
  | Readonly<{
      method: "item/permissions/requestApproval";
      params: Native.PermissionsRequestApprovalParams;
    }>
  | Readonly<{ method: "item/tool/requestUserInput"; params: Native.ToolRequestUserInputParams }>
  | Readonly<{
      method: "mcpServer/elicitation/request";
      params: Native.McpServerElicitationRequestParams;
    }>;
export type CodexPendingCallback = Readonly<{
  reference: CodexCallbackRef;
  request: CodexCallback;
  submitted: boolean;
}>;

export const codexRunSchema = z
  .object({
    scope: z
      .object({
        connection: z.string(),
        principal: z.string(),
        host: z.string(),
        session: z.string(),
      })
      .strict(),
    generation: z.number().int().positive(),
    nativeSession: z.string().min(1).max(256),
  })
  .strict();
export const codexCallbackRefSchema = z
  .object({
    run: codexRunSchema,
    attachment: z.string().min(1).max(256),
    requestId: z.union([z.string(), z.number().int()]),
    incarnation: z.number().int().positive(),
  })
  .strict();
const typed = <T>(value: z.ZodType): z.ZodType<T, T> => value as z.ZodType<T, T>;
export const codexNativeSchemas = {
  threadRead: typed<Native.ThreadReadParams>(schema.ThreadReadParamsSchema),
  turnsList: typed<Native.ThreadTurnsListParams>(schema.ThreadTurnsListParamsSchema),
  itemsList: typed<Native.ThreadItemsListParams>(schema.ThreadItemsListParamsSchema),
  settingsUpdate: typed<Native.ThreadSettingsUpdateParams>(schema.ThreadSettingsUpdateParamsSchema),
  turnStart: typed<Native.TurnStartParams>(schema.TurnStartParamsSchema),
  turnSteer: typed<Native.TurnSteerParams>(schema.TurnSteerParamsSchema),
  turnInterrupt: typed<Native.TurnInterruptParams>(schema.TurnInterruptParamsSchema),
  turnSettingsUpdate: typed<Native.TurnSettingsUpdateParams>(schema.TurnSettingsUpdateParamsSchema),
  modelList: typed<Native.ModelListParams>(schema.ModelListParamsSchema),
  queueList: typed<Native.ThreadQueueListParams>(schema.ThreadQueueListParamsSchema),
  queueAdd: typed<Native.ThreadQueueAddParams>(schema.ThreadQueueAddParamsSchema),
  queueStart: typed<Native.ThreadQueueStartParams>(schema.ThreadQueueStartParamsSchema),
  queueUpdate: typed<Native.ThreadQueueUpdateParams>(schema.ThreadQueueUpdateParamsSchema),
  queueDelete: typed<Native.ThreadQueueDeleteParams>(schema.ThreadQueueDeleteParamsSchema),
  queueReorder: typed<Native.ThreadQueueReorderParams>(schema.ThreadQueueReorderParamsSchema),
  goalGet: typed<Native.ThreadGoalGetParams>(schema.ThreadGoalGetParamsSchema),
  goalSet: typed<Native.ThreadGoalSetParams>(schema.ThreadGoalSetParamsSchema),
  goalClear: typed<Native.ThreadGoalClearParams>(schema.ThreadGoalClearParamsSchema),
  terminalsList: typed<Native.ThreadBackgroundTerminalsListParams>(
    schema.ThreadBackgroundTerminalsListParamsSchema,
  ),
  terminalTerminate: typed<Native.ThreadBackgroundTerminalsTerminateParams>(
    schema.ThreadBackgroundTerminalsTerminateParamsSchema,
  ),
  terminalsClean: typed<Native.ThreadBackgroundTerminalsCleanParams>(
    schema.ThreadBackgroundTerminalsCleanParamsSchema,
  ),
  compactStart: typed<Native.ThreadCompactStartParams>(schema.ThreadCompactStartParamsSchema),
  mcpList: typed<Native.ListMcpServerStatusParams>(schema.ListMcpServerStatusParamsSchema),
};
export const codexNativeEffectSchema = z.discriminatedUnion("method", [
  z
    .object({
      type: z.literal("native"),
      method: z.literal("thread/settings/update"),
      params: codexNativeSchemas.settingsUpdate,
    })
    .strict(),
  z
    .object({
      type: z.literal("native"),
      method: z.literal("turn/start"),
      params: codexNativeSchemas.turnStart,
    })
    .strict(),
  z
    .object({
      type: z.literal("native"),
      method: z.literal("turn/steer"),
      params: codexNativeSchemas.turnSteer,
    })
    .strict(),
  z
    .object({
      type: z.literal("native"),
      method: z.literal("turn/interrupt"),
      params: codexNativeSchemas.turnInterrupt,
    })
    .strict(),
  z
    .object({
      type: z.literal("native"),
      method: z.literal("turn/settings/update"),
      params: codexNativeSchemas.turnSettingsUpdate,
    })
    .strict(),
  z
    .object({
      type: z.literal("native"),
      method: z.literal("thread/queue/add"),
      params: codexNativeSchemas.queueAdd,
    })
    .strict(),
  z
    .object({
      type: z.literal("native"),
      method: z.literal("thread/queue/start"),
      params: codexNativeSchemas.queueStart,
    })
    .strict(),
  z
    .object({
      type: z.literal("native"),
      method: z.literal("thread/queue/update"),
      params: codexNativeSchemas.queueUpdate,
    })
    .strict(),
  z
    .object({
      type: z.literal("native"),
      method: z.literal("thread/queue/delete"),
      params: codexNativeSchemas.queueDelete,
    })
    .strict(),
  z
    .object({
      type: z.literal("native"),
      method: z.literal("thread/queue/reorder"),
      params: codexNativeSchemas.queueReorder,
    })
    .strict(),
  z
    .object({
      type: z.literal("native"),
      method: z.literal("thread/goal/set"),
      params: codexNativeSchemas.goalSet,
    })
    .strict(),
  z
    .object({
      type: z.literal("native"),
      method: z.literal("thread/goal/clear"),
      params: codexNativeSchemas.goalClear,
    })
    .strict(),
  z
    .object({
      type: z.literal("native"),
      method: z.literal("thread/backgroundTerminals/terminate"),
      params: codexNativeSchemas.terminalTerminate,
    })
    .strict(),
  z
    .object({
      type: z.literal("native"),
      method: z.literal("thread/backgroundTerminals/clean"),
      params: codexNativeSchemas.terminalsClean,
    })
    .strict(),
  z
    .object({
      type: z.literal("native"),
      method: z.literal("thread/compact/start"),
      params: codexNativeSchemas.compactStart,
    })
    .strict(),
]);
export const codexNativeCallbackResponseSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("item/commandExecution/requestApproval"),
      response: typed<Native.CommandExecutionRequestApprovalResponse>(
        schema.CommandExecutionRequestApprovalResponseSchema,
      ),
    })
    .strict(),
  z
    .object({
      method: z.literal("item/fileChange/requestApproval"),
      response: typed<Native.FileChangeRequestApprovalResponse>(
        schema.FileChangeRequestApprovalResponseSchema,
      ),
    })
    .strict(),
  z
    .object({
      method: z.literal("item/permissions/requestApproval"),
      response: typed<Native.PermissionsRequestApprovalResponse>(
        schema.PermissionsRequestApprovalResponseSchema,
      ),
    })
    .strict(),
  z
    .object({
      method: z.literal("item/tool/requestUserInput"),
      response: typed<Native.ToolRequestUserInputResponse>(
        schema.ToolRequestUserInputResponseSchema,
      ),
    })
    .strict(),
  z
    .object({
      method: z.literal("mcpServer/elicitation/request"),
      response: typed<Native.McpServerElicitationRequestResponse>(
        schema.McpServerElicitationRequestResponseSchema,
      ),
    })
    .strict(),
]);
export const codexNativeAnswerSchema = z
  .object({
    type: z.literal("nativeAnswer"),
    reference: codexCallbackRefSchema,
    answer: codexNativeCallbackResponseSchema,
  })
  .strict();
export type CodexNativeEffect = z.output<typeof codexNativeEffectSchema>;
export type CodexNativeAnswer = z.output<typeof codexNativeAnswerSchema>;
/** Existing receipt identity is preserved; decoding never issues/retries native work. */
export function codexReceipt<Result>(
  receipt: Receipt,
  result: z.ZodType<Result>,
): CodexReceipt<Result> {
  if (receipt.state === "succeeded")
    return { ...receipt, state: "succeeded", result: result.parse(receipt.result) };
  if (receipt.state === "refused") return { ...receipt, state: "refused", result: receipt.result };
  return {
    ...receipt,
    state: receipt.state as "admitted" | "dispatched" | "unknown",
    result: null,
  };
}
