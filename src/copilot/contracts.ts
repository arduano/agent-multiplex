import { z } from "zod";
import type { StoredFile } from "../files/contracts.js";
export const COPILOT_SDK_VERSION = "1.0.19";
export const COPILOT_CLI_VERSION = "1.0.95";
const id = z.string().min(1).max(256);
export const copilotSelectionSchema = z
  .object({
    kind: z.literal("copilot").default("copilot"),
    model: id,
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional(),
    mode: z.enum(["interactive", "plan", "autopilot"]).default("interactive"),
    permissions: z.enum(["manual", "assisted", "allow-all"]).default("allow-all"),
  })
  .strict();
export type CopilotSelection = z.output<typeof copilotSelectionSchema>;
export const copilotObservedSelectionSchema = copilotSelectionSchema.extend({
  kind: z.literal("copilot"),
  mode: z.enum(["interactive", "plan", "autopilot"]),
  permissions: z.enum(["manual", "assisted", "allow-all"]),
  nativeProviderId: z.string().min(1).max(256).nullable(),
});
export type CopilotObservedSelection = z.output<typeof copilotObservedSelectionSchema>;
export const copilotMessageSchema = z
  .object({ text: z.string().min(1).max(65536), files: z.array(id).max(32).default([]) })
  .strict();
export type CopilotMessage = z.output<typeof copilotMessageSchema>;
const scopeSchema = z.object({ connection: id, principal: id, host: id, session: id }).strict();
const referenceSchema = z
  .object({
    run: z
      .object({ scope: scopeSchema, generation: z.number().int().positive(), nativeSession: id })
      .strict(),
    attachment: id,
    incarnation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const contentSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
);
export const copilotAnswerSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("copilot.permission"),
      kind: z.enum(["approve-once", "reject", "user-not-available"]),
      feedback: z.string().max(16384).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("copilot.question"),
      answer: z.string().max(16384),
      wasFreeform: z.boolean(),
      extraInfo: z.string().max(16384).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("copilot.plan"),
      approved: z.boolean(),
      selectedAction: id.optional(),
      feedback: z.string().max(16384).optional(),
    })
    .strict(),
  z.discriminatedUnion("action", [
    z
      .object({
        type: z.literal("copilot.elicitation"),
        action: z.literal("accept"),
        content: contentSchema.optional(),
      })
      .strict(),
    z
      .object({ type: z.literal("copilot.elicitation"), action: z.enum(["decline", "cancel"]) })
      .strict(),
  ]),
]);
export const copilotCommandSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("answer"), reference: referenceSchema, answer: copilotAnswerSchema })
    .strict(),
  z
    .object({
      type: z.literal("model"),
      model: id,
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("mode"), mode: z.enum(["interactive", "plan", "autopilot"]) })
    .strict(),
  z
    .object({ type: z.literal("permissions"), mode: z.enum(["manual", "assisted", "allow-all"]) })
    .strict(),
  z.object({ type: z.literal("abort") }).strict(),
  z.object({ type: z.literal("steer"), message: copilotMessageSchema }).strict(),
  z.object({ type: z.literal("queue.promote"), id }).strict(),
  z.object({ type: z.literal("task.cancel"), id }).strict(),
  z.object({ type: z.literal("task.promote"), id }).strict(),
  z.object({ type: z.literal("compact") }).strict(),
  z.object({ type: z.literal("mcp.restart"), server: id }).strict(),
  z
    .object({ type: z.literal("mcp.login"), server: id, forceReauth: z.boolean().optional() })
    .strict(),
]);
export type CopilotCommand = z.output<typeof copilotCommandSchema>;
export type CopilotRead =
  | {
      [Type in "selection" | "models" | "queue" | "tasks" | "task.promotable" | "mcp"]: Readonly<{
        type: Type;
      }>;
    }["selection" | "models" | "queue" | "tasks" | "task.promotable" | "mcp"]
  | Readonly<{
      type: "task.progress";
      id: string;
    }>;
export type CopilotModel = Readonly<{
  model: string;
  name?: string;
  efforts: readonly string[];
  defaultEffort?: string;
}>;
export type CopilotTask = Readonly<{
  id: string;
  kind: "agent" | "shell" | "client";
  status: string;
  description: string;
  model?: string;
  resolvedModel?: string;
  canPromote?: boolean;
  error?: string;
  result?: string;
}>;
export type CopilotMcpServer = Readonly<{
  name: string;
  enabled: boolean;
  status: string;
}>;
export type CopilotLoginLink =
  | Readonly<{
      state: "ready";
      url: string;
      expiresAt: number;
    }>
  | Readonly<{
      state: "unknown" | "expired" | "complete";
    }>;
export type CopilotDiagnostic = Readonly<{
  stage: "sdk" | "history" | "identity" | "callback";
  code: string;
}>;
export type CopilotAsset = Readonly<{
  id: string;
  name: string;
  mediaType: string;
}> &
  (
    | Readonly<{
        state: "pending";
      }>
    | Readonly<{
        state: "ready";
        file: StoredFile;
      }>
    | Readonly<{
        state: "unavailable";
        reason: "noMaterializer" | "capacity" | "nativeOmitted" | "captureFailed" | "identity";
      }>
  );

export type CopilotQueue = Readonly<{
  items: readonly Readonly<{
    id: string;
    text: string;
    kind: string;
    agentMode: string;
    messageId?: string;
  }>[];
  steeringMessages: readonly string[];
  inFlightSteeringCount?: number;
  withdrawableTurnMessageId?: string;
}>;
export type CopilotTaskProgress = Readonly<{
  type: string;
  recentOutput?: string;
  latestIntent?: string;
  phase?: string;
  lastMessage?: string;
  status?: string;
  updatedAt?: string;
  sequence?: number;
  percentage?: number;
  recentActivity?: readonly Readonly<{ message: string; timestamp: string }>[];
}>;
export type CopilotReadResultFor<Request extends CopilotRead> = Request extends {
  type: "selection";
}
  ? CopilotObservedSelection
  : Request extends { type: "models" }
    ? Readonly<{ choices: readonly CopilotModel[] }>
    : Request extends { type: "queue" }
      ? CopilotQueue
      : Request extends { type: "tasks" }
        ? Readonly<{ tasks: readonly CopilotTask[] }>
        : Request extends { type: "task.promotable" }
          ? Readonly<{ task: CopilotTask | null }>
          : Request extends { type: "task.progress" }
            ? Readonly<{ progress: CopilotTaskProgress | null }>
            : Request extends { type: "mcp" }
              ? readonly CopilotMcpServer[]
              : never;
export type CopilotReadResult = CopilotReadResultFor<CopilotRead>;
