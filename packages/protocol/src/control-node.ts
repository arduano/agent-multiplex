import { z } from "zod";

import {
  authorityRefSchema,
  controlNodeDataRoleSchema,
} from "./authority.js";
import {
  attachmentIdSchema,
  controlNodeBootIdSchema,
  controlNodeIdSchema,
  feedIdSchema,
  lineageIdSchema,
} from "./ids.js";

const isoDateSchema = z.iso.datetime({ offset: true });

export const controlNodePresenceSchema = z.enum(["online", "offline", "stale"]);
export type ControlNodePresence = z.infer<typeof controlNodePresenceSchema>;

/** Reachability of a route as observed from the serving control node. */
export const routeReachabilitySchema = z.enum([
  "reachable",
  "unreachable",
  "stale",
]);
export type RouteReachability = z.infer<typeof routeReachabilitySchema>;

export const controlNodeDescriptorSchema = z
  .object({
    controlNodeId: controlNodeIdSchema,
    controlNodeBootId: controlNodeBootIdSchema,
    feedId: feedIdSchema,
    name: z.string().min(1).max(256),
    endpointId: z.string().min(1).max(512).optional(),
    presence: controlNodePresenceSchema,
    dataRole: controlNodeDataRoleSchema,
    connectedAt: isoDateSchema.nullable(),
    lastHeartbeatAt: isoDateSchema.nullable(),
    protocolVersion: z.literal(4),
    capabilities: z.array(z.string().min(1).max(256)),
  })
  .superRefine((descriptor, ctx) => {
    if (
      descriptor.dataRole.role === "authority" &&
      descriptor.dataRole.authority.controlNodeId !== descriptor.controlNodeId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["dataRole", "authority", "controlNodeId"],
        message: "an authority role must reference the same control node",
      });
    }
    if (
      descriptor.dataRole.role === "branch" &&
      descriptor.dataRole.branch.lifecycle === "attached" &&
      descriptor.dataRole.branch.parentControlNodeId === descriptor.controlNodeId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["dataRole", "branch", "parentControlNodeId"],
        message: "a branch cannot be its own parent",
      });
    }
  });
export type ControlNodeDescriptor = z.infer<
  typeof controlNodeDescriptorSchema
>;

/**
 * The child's authenticated view of its durable role and complete subtree at
 * attachment time. The parent uses this proof to reject cycles, implicit
 * reparenting, and identity overlap before it mutates its topology.
 */
export const controlNodeAttachmentProofSchema = z.object({
  currentRole: controlNodeDataRoleSchema,
  coveredControlNodeIds: z
    .array(controlNodeIdSchema)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "attachment coverage must not contain duplicate control nodes",
    }),
});
export type ControlNodeAttachmentProof = z.infer<
  typeof controlNodeAttachmentProofSchema
>;

export const controlNodeAttachmentRequestSchema = z
  .object({
    controlNodeId: controlNodeIdSchema,
    controlNodeBootId: controlNodeBootIdSchema,
    feedId: feedIdSchema,
    name: z.string().min(1).max(256),
    endpointId: z.string().min(1).max(512).optional(),
    protocolVersion: z.literal(4),
    capabilities: z.array(z.string().min(1).max(256)),
    expectedParentControlNodeId: controlNodeIdSchema,
    childProof: controlNodeAttachmentProofSchema,
    resume: z
      .object({
        attachmentId: attachmentIdSchema,
        lineageId: lineageIdSchema,
        authority: authorityRefSchema,
      })
      .optional(),
  })
  .superRefine((request, ctx) => {
    if (!request.childProof.coveredControlNodeIds.includes(request.controlNodeId)) {
      ctx.addIssue({
        code: "custom",
        path: ["childProof", "coveredControlNodeIds"],
        message: "attachment coverage must include the child control node",
      });
    }
  });
export type ControlNodeAttachmentRequest = z.infer<
  typeof controlNodeAttachmentRequestSchema
>;

export const controlNodeAttachmentSchema = z
  .object({
    attachmentId: attachmentIdSchema,
    lineageId: lineageIdSchema,
    parentControlNodeId: controlNodeIdSchema,
    childControlNodeId: controlNodeIdSchema,
    authority: authorityRefSchema,
    attachedAt: isoDateSchema,
  })
  .refine(
    (attachment) =>
      attachment.parentControlNodeId !== attachment.childControlNodeId,
    {
      path: ["childControlNodeId"],
      message: "a control node cannot attach to itself",
    },
  );
export type ControlNodeAttachment = z.infer<
  typeof controlNodeAttachmentSchema
>;

export const controlNodeTopologySchema = z.object({
  authority: authorityRefSchema,
  projectionRootControlNodeId: controlNodeIdSchema,
  controlNodes: z.array(controlNodeDescriptorSchema),
  attachments: z.array(controlNodeAttachmentSchema),
});
export type ControlNodeTopology = z.infer<typeof controlNodeTopologySchema>;
