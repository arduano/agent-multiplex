import { z } from "zod";

import { authorityRefSchema } from "./authority.js";
import { jsonValueSchema, type JsonValue } from "./json.js";
import {
  controlNodeIdSchema,
  operationIdSchema,
  sessionIdSchema,
} from "./ids.js";

export const metadataKeyPattern =
  /^[a-z][a-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9._-]*)+$/;

export const metadataKeySchema = z
  .string()
  .min(3)
  .max(256)
  .regex(metadataKeyPattern, "metadata keys must be namespaced, for example agent.title");

export const metadataValuesSchema = z.record(metadataKeySchema, jsonValueSchema);
export const metadataKeyRevisionsSchema = z.record(
  metadataKeySchema,
  z.number().int().nonnegative(),
);

export const metadataSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  values: metadataValuesSchema,
  keyRevisions: metadataKeyRevisionsSchema,
});

export type MetadataSnapshot = z.infer<typeof metadataSnapshotSchema>;

export const emptyMetadataSnapshot = (): MetadataSnapshot => ({
  revision: 0,
  values: {},
  keyRevisions: {},
});

export const metadataPatchSchema = z
  .object({
    operationId: operationIdSchema,
    sessionId: sessionIdSchema,
    expectedAuthority: authorityRefSchema,
    set: metadataValuesSchema.optional(),
    remove: z.array(metadataKeySchema).max(1_024).optional(),
    ifKeyRevision: z
      .record(metadataKeySchema, z.number().int().nonnegative().nullable())
      .optional(),
  })
  .superRefine((patch, ctx) => {
    const setKeys = Object.keys(patch.set ?? {});
    const removeKeys = patch.remove ?? [];
    if (setKeys.length === 0 && removeKeys.length === 0) {
      ctx.addIssue({ code: "custom", message: "a metadata patch must touch at least one key" });
    }
    const duplicateRemove = removeKeys.find(
      (key, index) => removeKeys.indexOf(key) !== index,
    );
    if (duplicateRemove) {
      ctx.addIssue({ code: "custom", message: `remove contains duplicate key ${duplicateRemove}` });
    }
    const overlap = removeKeys.find((key) => Object.hasOwn(patch.set ?? {}, key));
    if (overlap) {
      ctx.addIssue({ code: "custom", message: `${overlap} cannot be set and removed together` });
    }
  });

export type MetadataPatch = z.infer<typeof metadataPatchSchema>;

export const metadataConflictSchema = z.object({
  key: metadataKeySchema,
  expectedRevision: z.number().int().nonnegative().nullable(),
  actualRevision: z.number().int().nonnegative().nullable(),
  actualValue: jsonValueSchema.optional(),
});
export type MetadataConflict = z.infer<typeof metadataConflictSchema>;

export const metadataOperationStatusSchema = z.enum([
  "queued",
  "accepted",
  "conflicted",
  "outcomeUnknown",
]);
export type MetadataOperationStatus = z.infer<typeof metadataOperationStatusSchema>;

/**
 * Durable state for a metadata write as it travels from an origin control node to the
 * session's current metadata authority.
 */
export const metadataOperationRecordSchema = z
  .object({
    operationId: operationIdSchema,
    sessionId: sessionIdSchema,
    patch: metadataPatchSchema,
    status: metadataOperationStatusSchema,
    canonical: metadataSnapshotSchema,
    optimistic: metadataSnapshotSchema.optional(),
    conflicts: z.array(metadataConflictSchema).min(1).optional(),
    originControlNodeId: controlNodeIdSchema,
    authority: authorityRefSchema,
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((operation, ctx) => {
    if (operation.patch.operationId !== operation.operationId) {
      ctx.addIssue({
        code: "custom",
        path: ["patch", "operationId"],
        message: "patch operationId must match the operation record",
      });
    }
    if (operation.patch.sessionId !== operation.sessionId) {
      ctx.addIssue({
        code: "custom",
        path: ["patch", "sessionId"],
        message: "patch sessionId must match the operation record",
      });
    }
    if (
      operation.patch.expectedAuthority.realmId !== operation.authority.realmId ||
      operation.patch.expectedAuthority.controlNodeId !==
        operation.authority.controlNodeId ||
      operation.patch.expectedAuthority.epochId !== operation.authority.epochId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["patch", "expectedAuthority"],
        message: "patch authority fence must match the operation record",
      });
    }
    if (operation.status === "conflicted" && operation.conflicts === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["conflicts"],
        message: "conflicted operations must describe at least one conflict",
      });
    }
    if (operation.status !== "conflicted" && operation.conflicts !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["conflicts"],
        message: "only conflicted operations may include conflicts",
      });
    }
  });
export type MetadataOperationRecord = z.infer<typeof metadataOperationRecordSchema>;

export const metadataPatchResultSchema = z.discriminatedUnion("accepted", [
  z.object({
    accepted: z.literal(true),
    operationId: operationIdSchema,
    snapshot: metadataSnapshotSchema,
    deduplicated: z.boolean(),
  }),
  z.object({
    accepted: z.literal(false),
    operationId: operationIdSchema,
    snapshot: metadataSnapshotSchema,
    conflicts: z.array(metadataConflictSchema).min(1),
  }),
]);

export type MetadataPatchResult = z.infer<typeof metadataPatchResultSchema>;

export interface MetadataOverlay {
  canonical: MetadataSnapshot;
  pending: readonly MetadataPatch[];
}

export function overlayMetadata({ canonical, pending }: MetadataOverlay): MetadataSnapshot {
  const values: Record<string, JsonValue> = { ...canonical.values };
  for (const patch of pending) {
    for (const [key, value] of Object.entries(patch.set ?? {})) {
      values[key] = value;
    }
    for (const key of patch.remove ?? []) {
      delete values[key];
    }
  }
  return { ...canonical, values };
}
