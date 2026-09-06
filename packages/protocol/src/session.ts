import { z } from "zod";

import { authorityRefSchema } from "./authority.js";
import { harnessSchema } from "./harness.js";
import {
  adapterScopeIdSchema,
  launchIdSchema,
  runtimeEpochSchema,
  runtimeNodeIdSchema,
  sessionIdSchema,
} from "./ids.js";
import { jsonValueSchema } from "./json.js";
import {
  launchBackendIdSchema,
  launchContractVersionSchema,
  launchImplementationVersionSchema,
  launchProfileIdSchema,
  launchProviderIdSchema,
  launchSchemaHashSchema,
} from "./launch.js";
import { metadataKeySchema, metadataSnapshotSchema } from "./metadata.js";

export const isoDateSchema = z.iso.datetime({ offset: true });

export const sessionAvailabilitySchema = z.enum([
  "active",
  "resumable",
  "unavailable",
]);
export type SessionAvailability = z.infer<typeof sessionAvailabilitySchema>;

export const sessionRuntimeStatusSchema = z.enum([
  "idle",
  "running",
  "waitingForInput",
  "stopped",
  "error",
  "unknown",
]);
export type SessionRuntimeStatus = z.infer<typeof sessionRuntimeStatusSchema>;

/** Authority-owned catalog visibility, independent of runtime liveness. */
export const sessionCatalogStateSchema = z.enum(["open", "archived"]);
export type SessionCatalogState = z.infer<typeof sessionCatalogStateSchema>;

/** Stable user-facing classification derived from catalog state and availability. */
export const sessionStateSchema = z.enum(["running", "stopped", "archived"]);
export type SessionState = z.infer<typeof sessionStateSchema>;

/**
 * Immutable public provenance for provider-created sessions. Provider-private
 * recovery state and credentials never belong in the catalog projection.
 */
export const sessionLaunchProvenanceSchema = z.object({
  launchId: launchIdSchema,
  profileId: launchProfileIdSchema,
  providerId: launchProviderIdSchema,
  backendId: launchBackendIdSchema,
  contractVersion: launchContractVersionSchema,
  requestSchemaHash: launchSchemaHashSchema,
  implementationVersion: launchImplementationVersionSchema,
});
export type SessionLaunchProvenance = z.infer<
  typeof sessionLaunchProvenanceSchema
>;

/** Last settings acknowledged by the native harness for this concrete session. */
export const copilotPermissionsSettingsSchema = z.object({
  mode: z.enum(["manual", "assisted", "allow-all"]),
});
export type CopilotPermissionsSettings = z.infer<typeof copilotPermissionsSettingsSchema>;

export const harnessSessionSettingsSchema = z.object({
  model: z.string().min(1).optional(),
  mode: z.string().min(1).optional(),
  effort: z.string().min(1).nullable().optional(),
  copilotPermissions: copilotPermissionsSettingsSchema.optional(),
});
export type HarnessSessionSettings = z.infer<typeof harnessSessionSettingsSchema>;

const runtimeOwnedSessionFields = {
  sessionId: sessionIdSchema,
  runtimeNodeId: runtimeNodeIdSchema,
  harness: harnessSchema,
  adapterScopeId: adapterScopeIdSchema,
  vendorSessionId: z.string().min(1).max(4_096),
  bindingRevision: z.number().int().positive(),
  runtimeEpoch: runtimeEpochSchema.nullable(),
  cwd: z.string().nullable(),
  availability: sessionAvailabilitySchema,
  runtimeStatus: sessionRuntimeStatusSchema,
  harnessSettings: harnessSessionSettingsSchema.optional(),
  nativeSummary: jsonValueSchema.optional(),
  launchProvenance: sessionLaunchProvenanceSchema.nullable().default(null),
  metadata: metadataSnapshotSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  lastSeenAt: isoDateSchema.nullable(),
  lastActivityAt: isoDateSchema.nullable().default(null),
} as const;

/** Canonical control-node projection. Catalog fields are never runtime-owned. */
export const sessionRecordSchema = z
  .object({
    ...runtimeOwnedSessionFields,
    metadataAuthority: authorityRefSchema,
    catalogState: sessionCatalogStateSchema.default("open"),
    catalogRevision: z.number().int().positive().default(1),
    archivedAt: isoDateSchema.nullable().default(null),
  })
  .superRefine((record, ctx) => {
    if (record.catalogState === "archived" && record.archivedAt === null) {
      ctx.addIssue({
        code: "custom",
        path: ["archivedAt"],
        message: "an archived session must record when it was archived",
      });
    }
    if (record.catalogState === "open" && record.archivedAt !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["archivedAt"],
        message: "an open session cannot have an archive timestamp",
      });
    }
    if (record.catalogState === "archived" && record.availability === "active") {
      ctx.addIssue({
        code: "custom",
        path: ["availability"],
        message: "an archived session cannot retain an active runtime binding",
      });
    }
  });
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

/** Runtime-local binding; it deliberately contains no authority-owned catalog fields. */
export const runtimeNodeSessionRecordSchema = z
  .object({
    ...runtimeOwnedSessionFields,
    metadataAuthority: authorityRefSchema.optional(),
  })
  .strict();
export type RuntimeNodeSessionRecord = z.infer<
  typeof runtimeNodeSessionRecordSchema
>;

export const nativeInventoryItemSchema = z.object({
  harness: harnessSchema,
  adapterScopeId: adapterScopeIdSchema,
  vendorSessionId: z.string().min(1).max(4_096),
  cwd: z.string().nullable(),
  availability: z.enum(["active", "resumable"]),
  runtimeStatus: sessionRuntimeStatusSchema,
  runtimeEpoch: runtimeEpochSchema.nullable(),
  harnessSettings: harnessSessionSettingsSchema.optional(),
  nativeSummary: jsonValueSchema.optional(),
  lastActivityAt: isoDateSchema.nullable(),
});
export type NativeInventoryItem = z.infer<typeof nativeInventoryItemSchema>;

/** A complete or explicitly partial harness inventory generation. */
export const inventorySnapshotSchema = z.object({
  runtimeNodeId: runtimeNodeIdSchema,
  generation: z.string().min(1),
  complete: z.boolean(),
  capturedAt: isoDateSchema,
  sessions: z.array(nativeInventoryItemSchema),
});
export type InventorySnapshot = z.infer<typeof inventorySnapshotSchema>;

export const sessionMetadataPredicateSchema = z.discriminatedUnion("operator", [
  z.object({ operator: z.literal("exists"), key: metadataKeySchema }),
  z.object({
    operator: z.literal("equals"),
    key: metadataKeySchema,
    value: jsonValueSchema,
  }),
]);
export type SessionMetadataPredicate = z.infer<
  typeof sessionMetadataPredicateSchema
>;

const unique = <T>(values: readonly T[]): boolean =>
  new Set(values).size === values.length;

/**
 * One bounded, keyset-paginated query. Metadata predicates use AND semantics;
 * equality is canonical structural JSON equality and existence includes null.
 */
export const sessionSearchInputSchema = z
  .object({
    states: z
      .array(sessionStateSchema)
      .min(1)
      .refine(unique, { message: "session states must be unique" })
      .default(["running", "stopped"]),
    runtimeNodeIds: z
      .array(runtimeNodeIdSchema)
      .min(1)
      .max(1_000)
      .refine(unique, { message: "runtime-node filters must be unique" })
      .optional(),
    harnesses: z
      .array(harnessSchema)
      .min(1)
      .refine(unique, { message: "harness filters must be unique" })
      .optional(),
    providerIds: z
      .array(launchProviderIdSchema)
      .min(1)
      .max(100)
      .refine(unique, { message: "provider filters must be unique" })
      .optional(),
    profileIds: z
      .array(launchProfileIdSchema)
      .min(1)
      .max(100)
      .refine(unique, { message: "profile filters must be unique" })
      .optional(),
    metadata: z.array(sessionMetadataPredicateSchema).max(32).default([]),
    lastActivityAfter: isoDateSchema.optional(),
    lastActivityBefore: isoDateSchema.optional(),
    cursor: z.string().min(1).max(32_768).optional(),
    limit: z.number().int().positive().max(500).default(100),
  })
  .superRefine((query, ctx) => {
    if (
      query.lastActivityAfter !== undefined &&
      query.lastActivityBefore !== undefined &&
      query.lastActivityAfter > query.lastActivityBefore
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["lastActivityAfter"],
        message: "lastActivityAfter must not be later than lastActivityBefore",
      });
    }
  });
export type SessionSearchInput = z.infer<typeof sessionSearchInputSchema>;

export const sessionSearchPageSchema = z.object({
  sessions: z.array(sessionRecordSchema).max(500),
  nextCursor: z.string().min(1).max(32_768).nullable(),
});
export type SessionSearchPage = z.infer<typeof sessionSearchPageSchema>;
