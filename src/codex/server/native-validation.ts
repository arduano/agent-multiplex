import { z } from "zod";
import type { CodexNotification, CodexCallback } from "../native-contracts.js";
import * as schema from "../protocol/schemas.js";

export const notificationSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("thread/started"), params: schema.ThreadStartedNotificationSchema }),
  z.object({
    method: z.literal("thread/status/changed"),
    params: schema.ThreadStatusChangedNotificationSchema,
  }),
  z.object({ method: z.literal("thread/closed"), params: schema.ThreadClosedNotificationSchema }),
  z.object({
    method: z.literal("thread/reverted"),
    params: schema.ThreadRevertedNotificationSchema,
  }),
  z.object({
    method: z.literal("thread/settings/updated"),
    params: schema.ThreadSettingsUpdatedNotificationSchema,
  }),
  z.object({
    method: z.literal("thread/tokenUsage/updated"),
    params: schema.ThreadTokenUsageUpdatedNotificationSchema,
  }),
  z.object({
    method: z.literal("thread/queue/changed"),
    params: schema.ThreadQueueChangedNotificationSchema,
  }),
  z.object({
    method: z.literal("thread/goal/updated"),
    params: schema.ThreadGoalUpdatedNotificationSchema,
  }),
  z.object({
    method: z.literal("thread/goal/cleared"),
    params: schema.ThreadGoalClearedNotificationSchema,
  }),
  z.object({ method: z.literal("turn/started"), params: schema.TurnStartedNotificationSchema }),
  z.object({ method: z.literal("turn/completed"), params: schema.TurnCompletedNotificationSchema }),
  z.object({
    method: z.literal("turn/plan/updated"),
    params: schema.TurnPlanUpdatedNotificationSchema,
  }),
  z.object({
    method: z.literal("turn/diff/updated"),
    params: schema.TurnDiffUpdatedNotificationSchema,
  }),
  z.object({
    method: z.literal("turn/moderationMetadata"),
    params: schema.TurnModerationMetadataNotificationSchema,
  }),
  z.object({ method: z.literal("item/started"), params: schema.ItemStartedNotificationSchema }),
  z.object({ method: z.literal("item/completed"), params: schema.ItemCompletedNotificationSchema }),
  z.object({
    method: z.literal("item/agentMessage/delta"),
    params: schema.AgentMessageDeltaNotificationSchema,
  }),
  z.object({ method: z.literal("item/plan/delta"), params: schema.PlanDeltaNotificationSchema }),
  z.object({
    method: z.literal("item/reasoning/summaryTextDelta"),
    params: schema.ReasoningSummaryTextDeltaNotificationSchema,
  }),
  z.object({
    method: z.literal("item/reasoning/summaryPartAdded"),
    params: schema.ReasoningSummaryPartAddedNotificationSchema,
  }),
  z.object({
    method: z.literal("item/reasoning/textDelta"),
    params: schema.ReasoningTextDeltaNotificationSchema,
  }),
  z.object({
    method: z.literal("item/commandExecution/outputDelta"),
    params: schema.CommandExecutionOutputDeltaNotificationSchema,
  }),
  z.object({
    method: z.literal("item/commandExecution/terminalInteraction"),
    params: schema.TerminalInteractionNotificationSchema,
  }),
  z.object({
    method: z.literal("item/fileChange/patchUpdated"),
    params: schema.FileChangePatchUpdatedNotificationSchema,
  }),
  z.object({
    method: z.literal("item/mcpToolCall/progress"),
    params: schema.McpToolCallProgressNotificationSchema,
  }),
  z.object({
    method: z.literal("serverRequest/resolved"),
    params: schema.ServerRequestResolvedNotificationSchema,
  }),
  z.object({ method: z.literal("error"), params: schema.ErrorNotificationSchema }),
]) as unknown as z.ZodType<CodexNotification>;

export const callbackSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("item/commandExecution/requestApproval"),
    params: schema.CommandExecutionRequestApprovalParamsSchema,
  }),
  z.object({
    method: z.literal("item/fileChange/requestApproval"),
    params: schema.FileChangeRequestApprovalParamsSchema,
  }),
  z.object({
    method: z.literal("item/permissions/requestApproval"),
    params: schema.PermissionsRequestApprovalParamsSchema,
  }),
  z.object({
    method: z.literal("item/tool/requestUserInput"),
    params: schema.ToolRequestUserInputParamsSchema,
  }),
  z.object({
    method: z.literal("mcpServer/elicitation/request"),
    params: schema.McpServerElicitationRequestParamsSchema,
  }),
]) as unknown as z.ZodType<CodexCallback>;

/** Full native output validation; callers choose their explicit procedure. */
export const nativeResults = {
  threadRead: schema.ThreadReadResponseSchema,
  turnsList: schema.ThreadTurnsListResponseSchema,
  itemsList: schema.ThreadItemsListResponseSchema,
  settingsUpdate: schema.ThreadSettingsUpdateResponseSchema,
  turnStart: schema.TurnStartResponseSchema,
  turnSteer: schema.TurnSteerResponseSchema,
  turnInterrupt: schema.TurnInterruptResponseSchema,
  turnSettingsUpdate: schema.TurnSettingsUpdateResponseSchema,
  modelList: schema.ModelListResponseSchema,
  queueList: schema.ThreadQueueListResponseSchema,
  queueAdd: schema.ThreadQueueAddResponseSchema,
  queueStart: schema.ThreadQueueStartResponseSchema,
  queueUpdate: schema.ThreadQueueUpdateResponseSchema,
  queueDelete: schema.ThreadQueueDeleteResponseSchema,
  queueReorder: schema.ThreadQueueReorderResponseSchema,
  goalGet: schema.ThreadGoalGetResponseSchema,
  goalSet: schema.ThreadGoalSetResponseSchema,
  goalClear: schema.ThreadGoalClearResponseSchema,
  terminalsList: schema.ThreadBackgroundTerminalsListResponseSchema,
  terminalTerminate: schema.ThreadBackgroundTerminalsTerminateResponseSchema,
  terminalsClean: schema.ThreadBackgroundTerminalsCleanResponseSchema,
  compactStart: schema.ThreadCompactStartResponseSchema,
  mcpList: schema.ListMcpServerStatusResponseSchema,
};
