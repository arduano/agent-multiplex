import { z } from "zod";
import { NATIVE_PAYLOAD_MAX_BYTES, jsonWireByteUpperBound, type JsonValue } from "@arduano/agent-multiplex-protocol";
import { copilotJson } from "./json.js";

/** Native task fields remain native-owned; validate control-relevant fields and
 * preserve the complete bounded snapshot, including unrecognized metadata. */
const id = z.string().min(1).max(4_096);
const status = z.enum(["running", "idle", "completed", "failed", "cancelled"]);
const common = {
  id, description: z.string(), status, startedAt: z.string(),
  completedAt: z.string().optional(),
  executionMode: z.enum(["sync", "background"]).optional(),
  canPromoteToBackground: z.boolean().optional(),
};
const task = z.discriminatedUnion("type", [
  z.object({ ...common, type: z.literal("agent"), toolCallId: z.string(), agentType: z.string(), prompt: z.string(),
    model: z.string().optional(), resolvedModel: z.string().optional(), displayName: z.string().optional() }).passthrough(),
  z.object({ ...common, type: z.literal("shell"), command: z.string(), attachmentMode: z.enum(["attached", "detached"]),
    pid: z.number().int().positive().optional(), logPath: z.string().optional() }).passthrough(),
  z.object({ ...common, type: z.literal("client"), status: z.enum([...status.options, "orphaned"]),
    executionMode: z.literal("background"), clientTaskId: z.string(), canCancel: z.boolean(),
    owner: z.object({ participantId: z.string(), joinId: z.string(), kind: z.enum(["extension", "sdk"]),
      presence: z.enum(["connected", "disconnected"]) }).passthrough(),
    updatedAt: z.string(), activeTimeMs: z.number().nonnegative(), sequence: z.number().int().nonnegative(),
  }).passthrough(),
]);
const line = z.object({ message: z.string(), timestamp: z.string() }).passthrough();
const progress = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent"), recentActivity: z.array(line), latestIntent: z.string().optional() }).passthrough(),
  z.object({ type: z.literal("shell"), recentOutput: z.string(), pid: z.number().int().positive().optional() }).passthrough(),
  z.object({ type: z.literal("client"), recentActivity: z.array(line), status: z.enum([...status.options, "orphaned"]),
    sequence: z.number().int().nonnegative(), updatedAt: z.string(), percentage: z.number().min(0).max(100).optional(),
    phase: z.string().optional(), lastMessage: z.string().optional() }).passthrough(),
]);
const schemas = {
  tasks: z.object({ tasks: z.array(task).max(1_000) }).passthrough(),
  taskProgress: z.object({ progress: progress.nullable().optional() }).passthrough(),
  currentPromotableTask: z.object({ task: task.optional() }).passthrough(),
};

export type CopilotTaskView = "tasks" | "taskProgress" | "currentPromotableTask";
export function taskId(value: unknown): string { return id.parse(value); }
export function taskSnapshot(view: CopilotTaskView, value: unknown): JsonValue {
  if (jsonWireByteUpperBound(value) + 256 > NATIVE_PAYLOAD_MAX_BYTES) {
    throw new Error("Copilot tasks exceed the bounded native state envelope");
  }
  if (!schemas[view].safeParse(value).success) throw new TypeError(`Unrecognized Copilot ${view} snapshot`);
  return copilotJson(value);
}
