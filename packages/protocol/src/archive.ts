import { z } from "zod";

import { authorityRefSchema } from "./authority.js";
import {
  archiveOperationIdSchema,
  runtimeNodeIdSchema,
  sessionIdSchema,
} from "./ids.js";

const isoDateSchema = z.iso.datetime({ offset: true });

/**
 * Authority-fenced request to release one stopped session's exclusive
 * provider resources and then remove it from the open catalog.
 */
export const archiveRequestSchema = z.object({
  archiveOperationId: archiveOperationIdSchema,
  payloadHash: z.string().min(16).max(256),
  sessionId: sessionIdSchema,
  runtimeNodeId: runtimeNodeIdSchema,
  bindingRevision: z.number().int().positive(),
  expectedAuthority: authorityRefSchema,
});
export type ArchiveRequest = z.infer<typeof archiveRequestSchema>;

export const archiveStateSchema = z.enum([
  "accepted",
  "releasing",
  "succeeded",
  "failed",
  "outcomeUnknown",
]);
export type ArchiveState = z.infer<typeof archiveStateSchema>;

export const archiveRecordSchema = archiveRequestSchema
  .extend({
    authority: authorityRefSchema,
    state: archiveStateSchema,
    releasedAt: isoDateSchema.nullable(),
    catalogRevision: z.number().int().positive().optional(),
    error: z.string().min(1).max(16_384).optional(),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
  })
  .superRefine((record, ctx) => {
    if (
      record.expectedAuthority.realmId !== record.authority.realmId ||
      record.expectedAuthority.controlNodeId !== record.authority.controlNodeId ||
      record.expectedAuthority.epochId !== record.authority.epochId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedAuthority"],
        message: "the archive request fence must match the operation authority",
      });
    }
    if (record.state === "succeeded" && record.releasedAt === null) {
      ctx.addIssue({
        code: "custom",
        path: ["releasedAt"],
        message: "a succeeded archive operation must record resource release",
      });
    }
    if (record.state !== "succeeded" && record.releasedAt !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["releasedAt"],
        message: "only a succeeded archive operation may record resource release",
      });
    }
    if (record.state === "succeeded" && record.catalogRevision === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["catalogRevision"],
        message: "a succeeded archive operation must publish the catalog revision",
      });
    }
    if (record.state !== "succeeded" && record.catalogRevision !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["catalogRevision"],
        message: "only a succeeded archive operation may publish a catalog revision",
      });
    }
    const terminalError = record.state === "failed" || record.state === "outcomeUnknown";
    if (terminalError && record.error === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: `${record.state} archive operations must include an error`,
      });
    }
    if (!terminalError && record.error !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: "only failed or outcome-unknown archive operations may include an error",
      });
    }
  });
export type ArchiveRecord = z.infer<typeof archiveRecordSchema>;
