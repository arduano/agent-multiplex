import { z } from "zod";

import {
  attachmentIdSchema,
  authorityEpochIdSchema,
  authorityTransitionIdSchema,
  controlNodeIdSchema,
  lineageIdSchema,
  operationIdSchema,
  realmIdSchema,
  topologyTransitionIdSchema,
} from "./ids.js";
import { jsonValueSchema } from "./json.js";

const isoDateSchema = z.iso.datetime({ offset: true });

/** The complete fence identifying the one metadata authority for a realm. */
export const authorityRefSchema = z.object({
  realmId: realmIdSchema,
  controlNodeId: controlNodeIdSchema,
  epochId: authorityEpochIdSchema,
});
export type AuthorityRef = z.infer<typeof authorityRefSchema>;

export const branchLifecycleSchema = z.enum(["attached", "detached"]);
export type BranchLifecycle = z.infer<typeof branchLifecycleSchema>;

export const attachedBranchStateSchema = z.object({
  lifecycle: z.literal("attached"),
  parentControlNodeId: controlNodeIdSchema,
  attachmentId: attachmentIdSchema,
  lineageId: lineageIdSchema,
  attachedAt: isoDateSchema,
});
export type AttachedBranchState = z.infer<typeof attachedBranchStateSchema>;

export const detachedBranchStateSchema = z.object({
  lifecycle: z.literal("detached"),
  formerParentControlNodeId: controlNodeIdSchema,
  attachmentId: attachmentIdSchema,
  lineageId: lineageIdSchema,
  attachedAt: isoDateSchema,
  detachedAt: isoDateSchema,
});
export type DetachedBranchState = z.infer<typeof detachedBranchStateSchema>;

export const branchStateSchema = z.discriminatedUnion("lifecycle", [
  attachedBranchStateSchema,
  detachedBranchStateSchema,
]);
export type BranchState = z.infer<typeof branchStateSchema>;

/**
 * A control node is either the authority for its realm or a branch retaining
 * that authority fence. Transport connectivity never changes this role.
 */
export const controlNodeDataRoleSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("authority"),
    authority: authorityRefSchema,
  }),
  z.object({
    role: z.literal("branch"),
    authority: authorityRefSchema,
    branch: branchStateSchema,
  }),
]);
export type ControlNodeDataRole = z.infer<typeof controlNodeDataRoleSchema>;

export const topologyDetachInputSchema = z.object({
  childControlNodeId: controlNodeIdSchema,
  attachmentId: attachmentIdSchema,
  lineageId: lineageIdSchema,
  expectedAuthority: authorityRefSchema,
});
export type TopologyDetachInput = z.infer<typeof topologyDetachInputSchema>;

export const authorityTransitionAuditSchema = z.object({
  actorId: z.string().min(1).max(512),
  reason: z.string().min(1).max(4_096),
  incidentId: z.string().min(1).max(512).optional(),
  evidence: z.array(jsonValueSchema).max(256).default([]),
  requestedAt: isoDateSchema,
});
export type AuthorityTransitionAudit = z.infer<
  typeof authorityTransitionAuditSchema
>;

/** Local emergency detach. It never mints authority or implies promotion. */
export const topologyForceDetachInputSchema = z.object({
  /** Explicit gateway routing target; it must be the local branch committing the transition. */
  controlNodeId: controlNodeIdSchema,
  expectedAuthority: authorityRefSchema,
  attachmentId: attachmentIdSchema,
  lineageId: lineageIdSchema,
  audit: authorityTransitionAuditSchema,
  acknowledgedUnknownMetadataOutcomes: z.literal(true),
});
export type TopologyForceDetachInput = z.infer<
  typeof topologyForceDetachInputSchema
>;

export const topologyDetachmentReceiptSchema = z.discriminatedUnion("mode", [
  z.object({
    transitionId: topologyTransitionIdSchema,
    mode: z.literal("graceful"),
    childControlNodeId: controlNodeIdSchema,
    formerParentControlNodeId: controlNodeIdSchema,
    attachmentId: attachmentIdSchema,
    lineageId: lineageIdSchema,
    previousAuthority: authorityRefSchema,
    metadataBarrier: z.number().int().nonnegative(),
    detachedAt: isoDateSchema,
  }),
  z.object({
    transitionId: topologyTransitionIdSchema,
    mode: z.literal("forced"),
    childControlNodeId: controlNodeIdSchema,
    formerParentControlNodeId: controlNodeIdSchema,
    attachmentId: attachmentIdSchema,
    lineageId: lineageIdSchema,
    previousAuthority: authorityRefSchema,
    metadataBarrier: z.null(),
    detachedAt: isoDateSchema,
    audit: authorityTransitionAuditSchema,
    unresolvedMetadataOperationIds: z.array(operationIdSchema).max(10_000),
  }),
]);
export type TopologyDetachmentReceipt = z.infer<
  typeof topologyDetachmentReceiptSchema
>;

export const authorityPromotionAuditSchema = authorityTransitionAuditSchema.extend({
  evidence: z.array(jsonValueSchema).min(1).max(256),
  acknowledgedSplitBrainRisk: z.literal(true),
});
export type AuthorityPromotionAudit = z.infer<
  typeof authorityPromotionAuditSchema
>;

/**
 * Promotion is valid only for a detached branch. Realm and epoch IDs are
 * intentionally absent: the committing control node mints them atomically.
 */
export const authorityPromoteInputSchema = z.object({
  /** Explicit gateway routing target; promotion always commits on this detached branch. */
  controlNodeId: controlNodeIdSchema,
  expectedAuthority: authorityRefSchema,
  detachmentTransitionId: topologyTransitionIdSchema,
  forcedDetachmentAudit: authorityPromotionAuditSchema.optional(),
});
export type AuthorityPromoteInput = z.infer<typeof authorityPromoteInputSchema>;

export const authorityPromotionReceiptSchema = z.object({
  transitionId: authorityTransitionIdSchema,
  controlNodeId: controlNodeIdSchema,
  previousAuthority: authorityRefSchema,
  authority: authorityRefSchema,
  detachmentTransitionId: topologyTransitionIdSchema,
  promotedAt: isoDateSchema,
  audit: authorityPromotionAuditSchema.optional(),
}).superRefine((receipt, ctx) => {
  if (receipt.authority.controlNodeId !== receipt.controlNodeId) {
    ctx.addIssue({
      code: "custom",
      path: ["authority", "controlNodeId"],
      message: "a promoted authority must be owned by the promoted control node",
    });
  }
  if (
    receipt.authority.realmId === receipt.previousAuthority.realmId ||
    receipt.authority.epochId === receipt.previousAuthority.epochId
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["authority"],
      message: "promotion must mint a new realm and authority epoch",
    });
  }
});
export type AuthorityPromotionReceipt = z.infer<
  typeof authorityPromotionReceiptSchema
>;
