import { z } from "zod";

import { adapterScopeIdSchema } from "./ids.js";
import { jsonObjectSchema, jsonValueSchema } from "./json.js";

export const harnessSchema = z.enum(["codex", "copilot"]);
export type Harness = z.infer<typeof harnessSchema>;

export const nativeSessionKeySchema = z.object({
  harness: harnessSchema,
  adapterScopeId: adapterScopeIdSchema,
  vendorSessionId: z.string().min(1).max(4_096),
});
export type NativeSessionKey = z.infer<typeof nativeSessionKeySchema>;

export const capabilitySchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  experimental: z.boolean().default(false),
});

export const harnessCatalogEntrySchema = z.object({
  harness: harnessSchema,
  adapterScopeId: adapterScopeIdSchema,
  available: z.boolean(),
  version: z.string().optional(),
  runtimeVersion: z.string().optional(),
  capabilities: z.array(capabilitySchema),
  unavailableReason: z.string().optional(),
});
export type HarnessCatalogEntry = z.infer<typeof harnessCatalogEntrySchema>;

export const nativeModelSchema = z.object({
  harness: harnessSchema,
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  native: jsonValueSchema.optional(),
});
export type NativeModel = z.infer<typeof nativeModelSchema>;

/**
 * Reference launch options for the bundled Codex adapter. Launch placement and
 * workspace policy are deliberately provisional rather than protocol core.
 */
export const codexSpawnOptionsSchema = z.object({
  harness: z.literal("codex"),
  cwd: z.string().min(1),
  model: z.string().min(1).optional(),
  approvalPolicy: z.string().optional(),
  sandbox: z.string().optional(),
  effort: z.string().optional(),
  personality: z.string().optional(),
  collaborationMode: jsonValueSchema.optional(),
  native: jsonObjectSchema.optional(),
});

/** Reference launch options interpreted by a matching protocol-v4 profile. */
export const copilotSpawnOptionsSchema = z.object({
  harness: z.literal("copilot"),
  cwd: z.string().min(1),
  model: z.string().min(1).optional(),
  reasoningEffort: z.string().optional(),
  mode: z.enum(["interactive", "plan", "autopilot"]).optional(),
  additionalDirectories: z.array(z.string().min(1)).optional(),
  native: jsonObjectSchema.optional(),
});

export const harnessSpawnOptionsSchema = z.discriminatedUnion("harness", [
  codexSpawnOptionsSchema,
  copilotSpawnOptionsSchema,
]);
export type HarnessSpawnOptions = z.infer<typeof harnessSpawnOptionsSchema>;

export const codexResumeOptionsSchema = z.object({
  harness: z.literal("codex"),
  vendorSessionId: z.string().min(1),
  cwd: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  approvalPolicy: z.string().optional(),
  sandbox: z.string().optional(),
  effort: z.string().optional(),
  personality: z.string().optional(),
  collaborationMode: jsonValueSchema.optional(),
  native: jsonObjectSchema.optional(),
});

export const copilotResumeOptionsSchema = z.object({
  harness: z.literal("copilot"),
  vendorSessionId: z.string().min(1),
  cwd: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoningEffort: z.string().optional(),
  mode: z.enum(["interactive", "plan", "autopilot"]).optional(),
  additionalDirectories: z.array(z.string().min(1)).optional(),
  continuePendingWork: z.boolean().default(false),
  native: jsonObjectSchema.optional(),
});

export const harnessResumeOptionsSchema = z.discriminatedUnion("harness", [
  codexResumeOptionsSchema,
  copilotResumeOptionsSchema,
]);
export type HarnessResumeOptions = z.infer<typeof harnessResumeOptionsSchema>;

export const nativeHistoryRequestSchema = z.discriminatedUnion("harness", [
  z.object({
    harness: z.literal("codex"),
    includeTurns: z.boolean().default(true),
    native: jsonObjectSchema.optional(),
  }),
  z.object({
    harness: z.literal("copilot"),
    cursor: z.string().optional(),
    limit: z.number().int().positive().max(1_000).default(100),
    native: jsonObjectSchema.optional(),
  }),
]);
export type NativeHistoryRequest = z.infer<typeof nativeHistoryRequestSchema>;

export const nativeHistoryResultSchema = z.object({
  harness: harnessSchema,
  vendorSessionId: z.string().min(1),
  payload: jsonValueSchema,
  nextCursor: z.string().optional(),
  complete: z.boolean().optional(),
});
export type NativeHistoryResult = z.infer<typeof nativeHistoryResultSchema>;
