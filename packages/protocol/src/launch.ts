import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

import { capabilitySchema, harnessSchema } from "./harness.js";
import {
  adapterScopeIdSchema,
  launchIdSchema,
  operationIdSchema,
  runtimeNodeIdSchema,
  sessionIdSchema,
  type LaunchId,
  type OperationId,
} from "./ids.js";
import { jsonObjectSchema } from "./json.js";
import { metadataValuesSchema } from "./metadata.js";

const isoDateSchema = z.iso.datetime({ offset: true });

export const launchProfileIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "launch profile IDs may contain letters, digits, dots, underscores, and hyphens",
  );
export type LaunchProfileId = z.infer<typeof launchProfileIdSchema>;

export const launchProviderIdSchema = z
  .string()
  .min(3)
  .max(256)
  .regex(
    /^[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/,
    "launch provider IDs must be lowercase and namespaced, for example core.direct",
  );
export type LaunchProviderId = z.infer<typeof launchProviderIdSchema>;

/**
 * Identifies the backend implementation selected by a launch provider. It is
 * deliberately opaque to protocol core: a backend may be a shared app server,
 * a per-session container, or another provider-owned execution topology.
 */
export const launchBackendIdSchema = z.string().min(1).max(512);
export type LaunchBackendId = z.infer<typeof launchBackendIdSchema>;

export const launchContractVersionSchema = z.number().int().positive();
export const launchSchemaHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "launch request schema hashes must be lowercase SHA-256 hex");
export const launchImplementationVersionSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value, {
    message: "launch implementation versions cannot have surrounding whitespace",
  })
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: "launch implementation versions cannot contain control characters",
  });

/**
 * Exact compatibility fence copied into every request and resulting session.
 * requestSchemaHash is SHA-256 over the provider's canonical JSON Schema.
 */
export const launchProfileIdentitySchema = z.object({
  profileId: launchProfileIdSchema,
  providerId: launchProviderIdSchema,
  contractVersion: launchContractVersionSchema,
  requestSchemaHash: launchSchemaHashSchema,
});
export type LaunchProfileIdentity = z.infer<typeof launchProfileIdentitySchema>;

export const launchProfileDescriptorSchema = launchProfileIdentitySchema
  .extend({
    implementationVersion: launchImplementationVersionSchema,
    harnesses: z
      .array(harnessSchema)
      .min(1)
      .refine((harnesses) => new Set(harnesses).size === harnesses.length, {
        message: "launch profile harnesses must be unique",
      }),
    available: z.boolean(),
    capabilities: z.array(capabilitySchema),
    unavailableReason: z.string().min(1).max(4_096).optional(),
  })
  .superRefine((profile, ctx) => {
    if (!profile.available && profile.unavailableReason === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["unavailableReason"],
        message: "an unavailable launch profile must explain why it is unavailable",
      });
    }
    if (profile.available && profile.unavailableReason !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["unavailableReason"],
        message: "an available launch profile cannot have an unavailable reason",
      });
    }
  });
export type LaunchProfileDescriptor = z.infer<
  typeof launchProfileDescriptorSchema
>;

/**
 * Generic, at-most-once launch envelope. Domain inputs are opaque to core and
 * are validated independently by the statically composed gateway and runtime
 * provider. Credentials are configuration and must never be carried here.
 */
export const launchRequestSchema = z.object({
  launchId: launchIdSchema,
  payloadHash: z.string().min(16).max(256),
  sessionId: sessionIdSchema,
  runtimeNodeId: runtimeNodeIdSchema,
  profile: launchProfileIdentitySchema,
  harness: harnessSchema,
  input: jsonObjectSchema,
  metadata: metadataValuesSchema.optional(),
});
export type LaunchRequest = z.infer<typeof launchRequestSchema>;

/**
 * UUIDv5 namespace for metadata initialization derived from a durable launch.
 * The literal is itself UUIDv5(URL, "agent-multiplex/protocol/v4/launch-metadata-operation").
 * Changing it would break retry identity, so it is part of the v4 protocol.
 */
export const LAUNCH_METADATA_OPERATION_NAMESPACE =
  "4767ef23-7d76-59f1-8004-e76c0475644e" as const;

/** Keep launch-derived writes out of the caller-allocated launch-ID namespace. */
export function launchMetadataOperationId(launchId: LaunchId): OperationId {
  return operationIdSchema.parse(
    uuidv5(launchId, LAUNCH_METADATA_OPERATION_NAMESPACE),
  );
}

export const launchStateSchema = z.enum([
  "accepted",
  "preparing",
  "nativeStarting",
  "cleanupPending",
  "succeeded",
  "failed",
  "outcomeUnknown",
]);
export type LaunchState = z.infer<typeof launchStateSchema>;

export const launchResultSchema = z.object({
  sessionId: sessionIdSchema,
  adapterScopeId: adapterScopeIdSchema,
  vendorSessionId: z.string().min(1).max(4_096),
  backendId: launchBackendIdSchema,
  bindingRevision: z.number().int().positive(),
});
export type LaunchResult = z.infer<typeof launchResultSchema>;

export const launchRecordSchema = launchRequestSchema
  .extend({
    implementationVersion: launchImplementationVersionSchema,
    state: launchStateSchema,
    result: launchResultSchema.optional(),
    statusMessage: z.string().min(1).max(4_096).optional(),
    error: z.string().min(1).max(16_384).optional(),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
  })
  .superRefine((record, ctx) => {
    if (record.state === "succeeded") {
      if (record.result === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["result"],
          message: "a succeeded launch must identify its native session binding",
        });
      } else if (record.result.sessionId !== record.sessionId) {
        ctx.addIssue({
          code: "custom",
          path: ["result", "sessionId"],
          message: "a launch result must bind the launch's reserved logical session",
        });
      }
    } else if (record.result !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["result"],
        message: "only a succeeded launch may publish a native session binding",
      });
    }
    const terminalError = record.state === "failed" || record.state === "outcomeUnknown";
    if (terminalError && record.error === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: `${record.state} launches must include an error`,
      });
    }
    if (!terminalError && record.error !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: "only failed or outcome-unknown launches may include an error",
      });
    }
  });
export type LaunchRecord = z.infer<typeof launchRecordSchema>;

const unique = <T>(values: readonly T[]): boolean =>
  new Set(values).size === values.length;

/** Bounded operation lookup, ordered newest-first by the serving component. */
export const launchListInputSchema = z.object({
  runtimeNodeId: runtimeNodeIdSchema.optional(),
  sessionId: sessionIdSchema.optional(),
  providerId: launchProviderIdSchema.optional(),
  profileId: launchProfileIdSchema.optional(),
  states: z
    .array(launchStateSchema)
    .min(1)
    .refine(unique, { message: "launch states must be unique" })
    .optional(),
  cursor: z.string().min(1).max(32_768).optional(),
  limit: z.number().int().positive().max(500).default(100),
});
export type LaunchListInput = z.infer<typeof launchListInputSchema>;

export const launchListPageSchema = z.object({
  launches: z.array(launchRecordSchema).max(500),
  nextCursor: z.string().min(1).max(32_768).nullable(),
});
export type LaunchListPage = z.infer<typeof launchListPageSchema>;
