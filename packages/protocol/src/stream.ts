import { z } from "zod";

import { archiveRecordSchema } from "./archive.js";
import {
  authorityPromotionReceiptSchema,
  authorityRefSchema,
  topologyDetachmentReceiptSchema,
} from "./authority.js";
import { commandRecordSchema } from "./command.js";
import {
  controlNodeAttachmentSchema,
  controlNodeDescriptorSchema,
  controlNodePresenceSchema,
} from "./control-node.js";
import { harnessSchema } from "./harness.js";
import {
  feedIdSchema,
  runtimeEpochSchema,
  runtimeNodeIdSchema,
  sessionIdSchema,
  controlNodeIdSchema,
} from "./ids.js";
import { interactionRecordSchema } from "./interaction.js";
import { jsonValueSchema } from "./json.js";
import { launchRecordSchema } from "./launch.js";
import {
  metadataOperationRecordSchema,
  metadataSnapshotSchema,
} from "./metadata.js";
import {
  runtimeNodeDescriptorSchema,
  runtimeNodePresenceSchema,
} from "./runtime-node.js";
import {
  runtimeNodeSessionRecordSchema,
  sessionRecordSchema,
} from "./session.js";

export const streamProvenanceSchema = z.object({
  originControlNodeId: controlNodeIdSchema,
  authority: authorityRefSchema,
});
export type StreamProvenance = z.infer<typeof streamProvenanceSchema>;

export const streamAuthorityRefsSchema = z
  .array(authorityRefSchema)
  .superRefine((refs, ctx) => {
    const keys = refs.map(
      (ref) => `${ref.realmId}\0${ref.controlNodeId}\0${ref.epochId}`,
    );
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: "custom",
        message: "stream authority references must be unique",
      });
    }
    for (let index = 1; index < keys.length; index += 1) {
      if (keys[index - 1]! > keys[index]!) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: "stream authority references must be sorted",
        });
        break;
      }
    }
  });
export type StreamAuthorityRefs = z.infer<typeof streamAuthorityRefsSchema>;

export const controlChangeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("controlNode.upsert"),
    controlNode: controlNodeDescriptorSchema,
  }),
  z.object({
    type: z.literal("controlNode.presence"),
    controlNodeId: controlNodeIdSchema,
    presence: controlNodePresenceSchema,
  }),
  z.object({
    type: z.literal("controlNode.attached"),
    attachment: controlNodeAttachmentSchema,
  }),
  z.object({
    type: z.literal("controlNode.detached"),
    receipt: topologyDetachmentReceiptSchema,
  }),
  z.object({
    type: z.literal("authority.promoted"),
    receipt: authorityPromotionReceiptSchema,
  }),
  z.object({
    type: z.literal("runtimeNode.upsert"),
    runtimeNode: runtimeNodeDescriptorSchema,
  }),
  z.object({
    type: z.literal("runtimeNode.presence"),
    runtimeNodeId: runtimeNodeIdSchema,
    presence: runtimeNodePresenceSchema,
  }),
  z.object({ type: z.literal("session.upsert"), session: sessionRecordSchema }),
  z.object({ type: z.literal("launch.changed"), launch: launchRecordSchema }),
  z.object({ type: z.literal("archive.changed"), archive: archiveRecordSchema }),
  z.object({
    type: z.literal("session.unavailable"),
    sessionId: sessionIdSchema,
  }),
  z.object({
    type: z.literal("metadata.changed"),
    sessionId: sessionIdSchema,
    metadata: metadataSnapshotSchema,
  }),
  z.object({
    type: z.literal("metadata.operation"),
    operation: metadataOperationRecordSchema,
  }),
  z.object({ type: z.literal("command.changed"), command: commandRecordSchema }),
  z.object({
    type: z.literal("interaction.changed"),
    interaction: interactionRecordSchema,
  }),
  z.object({
    type: z.literal("inventory.completed"),
    runtimeNodeId: runtimeNodeIdSchema,
    generation: z.string(),
  }),
]);
export type ControlChange = z.infer<typeof controlChangeSchema>;

const nativeEventCoreSchema = z.object({
  kind: z.literal("native"),
  sessionId: sessionIdSchema,
  harness: harnessSchema,
  runtimeEpoch: runtimeEpochSchema,
  sequence: z.number().int().nonnegative(),
  nativeType: z.string().min(1),
  payload: jsonValueSchema,
  ephemeral: z.boolean(),
});

export const nativeEventSchema = nativeEventCoreSchema.extend({
  provenance: streamProvenanceSchema,
});
export type NativeEvent = z.infer<typeof nativeEventSchema>;

const nativeGapCoreSchema = z.object({
  kind: z.literal("nativeGap"),
  sessionId: sessionIdSchema,
  reason: z.string(),
  recovery: z.literal("readNativeHistory"),
});

export const nativeGapSchema = nativeGapCoreSchema.extend({
  provenance: streamProvenanceSchema,
});
export type NativeGap = z.infer<typeof nativeGapSchema>;

const nativeCursorMapSchema = z.record(
  sessionIdSchema,
  z.object({
    runtimeEpoch: runtimeEpochSchema,
    sequence: z.number().int().nonnegative(),
  }),
);

export const feedCheckpointSchema = z.object({
  feedId: feedIdSchema,
  controlCursor: z.number().int().nonnegative(),
});
export type FeedCheckpoint = z.infer<typeof feedCheckpointSchema>;

export const streamCursorSchema = feedCheckpointSchema.extend({
  controlCursor: z.number().int().nonnegative().default(0),
  native: nativeCursorMapSchema.default({}),
});
export type StreamCursor = z.infer<typeof streamCursorSchema>;

/** Replay state understood by a runtime node; feed identity is deliberately absent. */
export const runtimeNodeEventCursorSchema = z.object({
  native: nativeCursorMapSchema.default({}),
});
export type RuntimeNodeEventCursor = z.infer<
  typeof runtimeNodeEventCursorSchema
>;

export const feedControlItemSchema = z.object({
  kind: z.literal("control"),
  eventId: z.uuid(),
  feedId: feedIdSchema,
  cursor: z.number().int().nonnegative(),
  provenance: streamProvenanceSchema,
  change: controlChangeSchema,
});
export type FeedControlItem = z.infer<typeof feedControlItemSchema>;

/** Signals that the requested feed/cursor cannot be resumed incrementally. */
export const streamResetSchema = z.object({
  kind: z.literal("streamReset"),
  previousFeedId: feedIdSchema.nullable().optional(),
  feedId: feedIdSchema,
  controlCursor: z.number().int().nonnegative(),
  authorityRefs: streamAuthorityRefsSchema,
  reason: z.enum([
    "feedChanged",
    "cursorExpired",
    "topologyChanged",
    "authorityChanged",
    "sourceSelectionChanged",
    "conflict",
  ]),
  recovery: z.literal("snapshot"),
});
export type StreamReset = z.infer<typeof streamResetSchema>;

export const accessHeartbeatSchema = z.object({
  kind: z.literal("heartbeat"),
  feedId: feedIdSchema,
  controlCursor: z.number().int().nonnegative(),
  authorityRefs: streamAuthorityRefsSchema,
});
export type AccessHeartbeat = z.infer<typeof accessHeartbeatSchema>;

export const accessStreamItemSchema = z.discriminatedUnion("kind", [
  feedControlItemSchema,
  nativeEventSchema,
  nativeGapSchema,
  accessHeartbeatSchema,
  streamResetSchema,
]);
export type AccessStreamItem = z.infer<typeof accessStreamItemSchema>;

/** Changes a runtime node can originate before a control node canonicalizes them. */
export const runtimeNodeControlChangeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.upsert"),
    session: runtimeNodeSessionRecordSchema,
  }),
  z.object({
    type: z.literal("interaction.changed"),
    interaction: interactionRecordSchema,
  }),
  z.object({ type: z.literal("launch.changed"), launch: launchRecordSchema }),
  z.object({ type: z.literal("archive.changed"), archive: archiveRecordSchema }),
]);
export type RuntimeNodeControlChange = z.infer<
  typeof runtimeNodeControlChangeSchema
>;

export const runtimeNodeControlItemSchema = z.object({
  kind: z.literal("control"),
  change: runtimeNodeControlChangeSchema,
});
export type RuntimeNodeControlItem = z.infer<
  typeof runtimeNodeControlItemSchema
>;

export const runtimeNodeHeartbeatSchema = z.object({
  kind: z.literal("heartbeat"),
});
export type RuntimeNodeHeartbeat = z.infer<typeof runtimeNodeHeartbeatSchema>;

export const runtimeNodeNativeEventSchema = nativeEventCoreSchema;
export type RuntimeNodeNativeEvent = z.infer<
  typeof runtimeNodeNativeEventSchema
>;

export const runtimeNodeNativeGapSchema = nativeGapCoreSchema;
export type RuntimeNodeNativeGap = z.infer<typeof runtimeNodeNativeGapSchema>;

/**
 * Runtime-node-originated items do not yet carry realm provenance. The
 * receiving control node validates ownership and adds immutable provenance.
 */
export const runtimeNodeEventItemSchema = z.discriminatedUnion("kind", [
  runtimeNodeControlItemSchema,
  runtimeNodeNativeEventSchema,
  runtimeNodeNativeGapSchema,
  runtimeNodeHeartbeatSchema,
]);
export type RuntimeNodeEventItem = z.infer<
  typeof runtimeNodeEventItemSchema
>;

export const accessAttachInputSchema = z.object({
  sessions: z.union([z.literal("all"), z.array(sessionIdSchema)]).default("all"),
  cursor: streamCursorSchema.optional(),
  includeNative: z.boolean().default(true),
});
export type AccessAttachInput = z.infer<typeof accessAttachInputSchema>;
