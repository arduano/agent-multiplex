import { z } from "zod";
import { NATIVE_PAYLOAD_MAX_BYTES, jsonWireByteUpperBound, type JsonValue } from "@arduano/agent-multiplex-protocol";
import { AdapterNativeStateValidationError, ADAPTER_NATIVE_STATE_DIAGNOSTIC_FIELDS,
  ADAPTER_NATIVE_STATE_VALIDATION_CODES, type AdapterNativeStateValidationIssue } from "@arduano/agent-multiplex-runtime-node-core";
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
    // Native agent tasks can explicitly leave the requested model unknown.
    model: z.string().nullable().optional(), resolvedModel: z.string().optional(), displayName: z.string().optional() }).passthrough(),
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
function validationIssue(value: unknown, issue: z.core.$ZodIssue): AdapterNativeStateValidationIssue {
  let actual = value;
  for (const segment of issue.path) {
    // Native JSON fields are own data properties. Never invoke an accessor just
    // to describe a malformed snapshot, or serialize any rejected value.
    if (actual === null || (typeof actual !== "object" && typeof actual !== "function")) { actual = undefined; break; }
    actual = Object.getOwnPropertyDescriptor(actual, segment)?.value;
  }
  return {
    path: issue.path.slice(0, 8).map(segment => typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0
      ? Math.min(segment, 1_000) : ADAPTER_NATIVE_STATE_DIAGNOSTIC_FIELDS.includes(segment as never) ? segment as AdapterNativeStateValidationIssue["path"][number] : "unknownField"),
    code: ADAPTER_NATIVE_STATE_VALIDATION_CODES.includes(issue.code) ? issue.code : "unknownIssue",
    valueType: actual === null ? "null" : actual instanceof Date ? "date" : Array.isArray(actual) ? "array"
      : typeof actual === "undefined" ? "undefined" : typeof actual === "string" ? "string" : typeof actual === "number" ? "number"
      : typeof actual === "boolean" ? "boolean" : typeof actual === "object" ? "object" : "other",
  };
}
export function taskSnapshot(view: CopilotTaskView, value: unknown): JsonValue {
  let wireBytes: number;
  try { wireBytes = jsonWireByteUpperBound(value); }
  catch {
    // The wire check still precedes schema admission. A Date in a known field
    // can have a useful schema diagnostic, without admitting or converting it.
    let issues: AdapterNativeStateValidationIssue[] = [];
    try {
      const result = schemas[view].safeParse(value);
      if (!result.success) issues = result.error.issues.slice(0, 8).map(issue => validationIssue(value, issue));
    } catch { /* Uninspectable/cyclic data retains only the fixed wire reason. */ }
    throw new AdapterNativeStateValidationError("snapshotWireInvalid", issues);
  }
  if (wireBytes + 256 > NATIVE_PAYLOAD_MAX_BYTES) {
    throw new AdapterNativeStateValidationError("snapshotTooLarge");
  }
  const result = schemas[view].safeParse(value);
  if (!result.success) throw new AdapterNativeStateValidationError("snapshotMalformed", result.error.issues.slice(0, 8).map(issue => validationIssue(value, issue)));
  return copilotJson(value);
}
