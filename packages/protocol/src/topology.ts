import { z } from "zod";

import {
  attachmentIdSchema,
  controlNodeBootIdSchema,
  controlNodeIdSchema,
  lineageIdSchema,
} from "./ids.js";
import { interactionRecordSchema } from "./interaction.js";
import { metadataOperationRecordSchema } from "./metadata.js";
import { runtimeNodeDescriptorSchema } from "./runtime-node.js";
import { isoDateSchema, sessionRecordSchema } from "./session.js";
import { sourceCoverageSnapshotSchema } from "./source.js";
import { feedCheckpointSchema } from "./stream.js";
import { controlNodeDescriptorSchema } from "./control-node.js";

/** Fence carried on calls from a parent to one currently attached branch. */
export const controlNodeLinkFenceSchema = z.object({
  controlNodeId: controlNodeIdSchema,
  controlNodeBootId: controlNodeBootIdSchema,
  attachmentId: attachmentIdSchema,
  lineageId: lineageIdSchema,
});
export type ControlNodeLinkFence = z.infer<
  typeof controlNodeLinkFenceSchema
>;

export const controlNodeSubtreeSnapshotRequestSchema =
  controlNodeLinkFenceSchema.extend({
    pageToken: z.string().min(1).optional(),
    limit: z.number().int().positive().max(5_000).default(500),
  });
export type ControlNodeSubtreeSnapshotRequest = z.infer<
  typeof controlNodeSubtreeSnapshotRequestSchema
>;

/**
 * One page from an immutable subtree snapshot. Every page in a traversal has
 * the same manifest and checkpoint; replay begins strictly after that barrier.
 */
export const controlNodeSubtreeSnapshotPageSchema = z.object({
  source: sourceCoverageSnapshotSchema,
  attachmentId: attachmentIdSchema,
  lineageId: lineageIdSchema,
  checkpoint: feedCheckpointSchema,
  capturedAt: isoDateSchema,
  controlNodes: z.array(controlNodeDescriptorSchema),
  runtimeNodes: z.array(runtimeNodeDescriptorSchema),
  sessions: z.array(sessionRecordSchema),
  interactions: z.array(interactionRecordSchema),
  metadataOperations: z.array(metadataOperationRecordSchema),
  nextPageToken: z.string().min(1).nullable(),
}).superRefine((page, ctx) => {
  if (
    page.checkpoint.feedId !== page.source.manifest.feedId ||
    page.checkpoint.controlCursor !== page.source.manifest.controlCursor
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["checkpoint"],
      message: "snapshot checkpoint must equal the source manifest replay barrier",
    });
  }
  const itemCount = page.controlNodes.length + page.runtimeNodes.length +
    page.sessions.length + page.interactions.length + page.metadataOperations.length;
  if (page.nextPageToken !== null && itemCount === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["nextPageToken"],
      message: "a non-terminal snapshot page must make progress",
    });
  }
});
export type ControlNodeSubtreeSnapshotPage = z.infer<
  typeof controlNodeSubtreeSnapshotPageSchema
>;

export const controlNodeSubtreeSnapshotSchema =
  controlNodeSubtreeSnapshotPageSchema;
export type ControlNodeSubtreeSnapshot = ControlNodeSubtreeSnapshotPage;
