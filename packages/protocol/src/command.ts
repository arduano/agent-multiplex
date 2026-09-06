import { z } from "zod";

import {
  commandIdSchema,
  runtimeNodeIdSchema,
  sessionIdSchema,
} from "./ids.js";
import { jsonObjectSchema, jsonValueSchema, jsonWireByteUpperBound } from "./json.js";
import { commandImageBindingSchema, IMAGE_MAX_COMMAND_IMAGES, nativeImagePointerValue, nativePayloadSchema, NATIVE_PAYLOAD_MAX_BYTES } from "./image.js";
import { isoDateSchema } from "./session.js";

export const commandStateSchema = z.enum([
  "received",
  "started",
  "succeeded",
  "failed",
  "outcomeUnknown",
]);
export type CommandState = z.infer<typeof commandStateSchema>;

export const codexCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("send"),
    input: z.union([z.string(), z.array(jsonValueSchema)]),
    native: jsonObjectSchema.optional(),
  }),
  z.object({
    type: z.literal("steer"),
    input: z.union([z.string(), z.array(jsonValueSchema)]),
    expectedTurnId: z.string().optional(),
    native: jsonObjectSchema.optional(),
  }),
  z.object({ type: z.literal("interrupt"), turnId: z.string().optional() }),
  z.object({ type: z.literal("setModel"), model: z.string().min(1) }),
  z.object({ type: z.literal("setEffort"), effort: z.string().min(1) }),
  z.object({ type: z.literal("setMode"), mode: jsonValueSchema }),
  z.object({
    type: z.literal("updateTurnSettings"),
    turnId: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
    serviceTier: z.string().min(1).nullable().optional(),
  }).refine(
    (value) =>
      value.model !== undefined ||
      value.effort !== undefined ||
      value.summary !== undefined ||
      value.serviceTier !== undefined,
    { message: "at least one running-turn setting is required" },
  ),
  z.object({
    type: z.literal("listBackgroundTerminals"),
    limit: z.number().int().positive().max(1_000).default(100),
  }),
  z.object({
    type: z.literal("terminateBackgroundTerminal"),
    processId: z.string().min(1),
  }),
  z.object({ type: z.literal("cleanBackgroundTerminals") }),
]);

export const copilotCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("send"),
    prompt: z.union([z.string(), jsonObjectSchema]),
    mode: z.literal("enqueue").default("enqueue"),
    native: jsonObjectSchema.optional(),
  }),
  z.object({
    type: z.literal("steer"),
    prompt: z.union([z.string(), jsonObjectSchema]),
    mode: z.literal("immediate").default("immediate"),
    native: jsonObjectSchema.optional(),
  }),
  z.object({ type: z.literal("interrupt") }),
  z.object({ type: z.literal("setModel"), model: z.string().min(1) }),
  z.object({
    type: z.literal("setMode"),
    mode: z.enum(["interactive", "plan", "autopilot"]),
  }),
  z.object({ type: z.literal("setPermissionMode"), mode: z.enum(["manual", "allow-all"]) }).strict(),
]);

export const harnessCommandSchema = z.discriminatedUnion("harness", [
  z.object({ harness: z.literal("codex"), command: codexCommandSchema }),
  z.object({ harness: z.literal("copilot"), command: copilotCommandSchema }),
]);
export type HarnessCommand = z.infer<typeof harnessCommandSchema>;

export const commandEnvelopeSchema = z.object({
  commandId: commandIdSchema,
  payloadHash: z.string().min(16).max(256),
  sessionId: sessionIdSchema,
  runtimeNodeId: runtimeNodeIdSchema,
  bindingRevision: z.number().int().positive(),
  request: harnessCommandSchema,
  /** Pointers are relative to request; the immutable request journal retains references. */
  images: z.array(commandImageBindingSchema).max(IMAGE_MAX_COMMAND_IMAGES).optional(),
}).superRefine((input, context) => {
  const seen = new Set<string>();
  for (const [index, slot] of (input.images ?? []).entries()) {
    if (seen.has(slot.pointer) || nativeImagePointerValue(input.request, slot.pointer) !== null ||
      slot.image.sessionId !== input.sessionId || slot.image.runtimeNodeId !== input.runtimeNodeId ||
      slot.image.bindingRevision !== input.bindingRevision) {
      context.addIssue({ code: "custom", path: ["images", index], message: "command image must target a unique null leaf and the same session binding" });
    }
    seen.add(slot.pointer);
  }
  if (jsonWireByteUpperBound(input) > NATIVE_PAYLOAD_MAX_BYTES) {
    context.addIssue({ code: "custom", message: "command exceeds the bounded wire envelope" });
  }
});
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

/** Provider-routed activation of an existing logical binding. */
export const resumeCommandSchema = z.object({
  operation: z.literal("resume"),
  commandId: commandIdSchema,
  payloadHash: z.string().min(16).max(256),
  sessionId: sessionIdSchema,
  runtimeNodeId: runtimeNodeIdSchema,
  bindingRevision: z.number().int().positive(),
});
export type ResumeCommand = z.infer<typeof resumeCommandSchema>;

/** Provider-aware stop; unlike interrupt, this retires the active binding. */
export const stopCommandSchema = z.object({
  operation: z.literal("stop"),
  commandId: commandIdSchema,
  payloadHash: z.string().min(16).max(256),
  sessionId: sessionIdSchema,
  runtimeNodeId: runtimeNodeIdSchema,
  bindingRevision: z.number().int().positive(),
});
export type StopCommand = z.infer<typeof stopCommandSchema>;

export const commandRecordSchema = z.object({
  commandId: commandIdSchema,
  payloadHash: z.string(),
  sessionId: sessionIdSchema.nullable(),
  runtimeNodeId: runtimeNodeIdSchema,
  state: commandStateSchema,
  request: jsonValueSchema,
  result: nativePayloadSchema.optional(),
  error: z.string().optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type CommandRecord = z.infer<typeof commandRecordSchema>;
