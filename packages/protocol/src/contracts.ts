import { z } from "zod";

import { accessSnapshotSchema } from "./access-snapshot.js";

import {
  archiveRecordSchema,
  archiveRequestSchema,
} from "./archive.js";
import {
  authorityPromoteInputSchema,
  authorityPromotionReceiptSchema,
  topologyDetachInputSchema,
  topologyDetachmentReceiptSchema,
  topologyForceDetachInputSchema,
} from "./authority.js";
import {
  commandEnvelopeSchema,
  commandRecordSchema,
  resumeCommandSchema,
  stopCommandSchema,
} from "./command.js";
import {
  controlNodeAttachmentRequestSchema,
  controlNodeAttachmentSchema,
  controlNodeDescriptorSchema,
} from "./control-node.js";
import {
  harnessCatalogEntrySchema,
  harnessSchema,
  nativeHistoryRequestSchema,
  nativeHistoryResultSchema,
  nativeModelSchema,
} from "./harness.js";
import {
  launchProfileDescriptorSchema,
  launchProfileIdentitySchema,
  launchListInputSchema,
  launchListPageSchema,
  launchProviderIdSchema,
  launchRecordSchema,
  launchRequestSchema,
} from "./launch.js";
import {
  archiveOperationIdSchema,
  commandIdSchema,
  controlNodeIdSchema,
  launchIdSchema,
  operationIdSchema,
  runtimeNodeBootIdSchema,
  runtimeNodeIdSchema,
  sessionIdSchema,
} from "./ids.js";
import {
  interactionRecordSchema,
  resolveInteractionInputSchema,
} from "./interaction.js";
import { jsonValueSchema } from "./json.js";
import { imageContract } from "./image.js";
import {
  metadataOperationRecordSchema,
  metadataOperationStatusSchema,
  metadataPatchSchema,
  metadataSnapshotSchema,
} from "./metadata.js";
import {
  runtimeNodeDescriptorSchema,
  runtimeNodeFenceSchema,
  runtimeNodeRegistrationSchema,
} from "./runtime-node.js";
import {
  inventorySnapshotSchema,
  sessionRecordSchema,
  sessionSearchInputSchema,
  sessionSearchPageSchema,
} from "./session.js";
import {
  actionScopesSchema,
  gatewayEnrollmentSchema,
  sourceDiagnosticSchema,
  sourceManifestSchema,
} from "./source.js";
import {
  accessAttachInputSchema,
  accessStreamItemSchema,
  feedCheckpointSchema,
  runtimeNodeEventCursorSchema,
  runtimeNodeEventItemSchema,
  streamCursorSchema,
} from "./stream.js";
import {
  controlNodeLinkFenceSchema,
  controlNodeSubtreeSnapshotPageSchema,
  controlNodeSubtreeSnapshotRequestSchema,
} from "./topology.js";
import {
  terminalAttachInputSchema,
  terminalDescriptorSchema,
  terminalGetInputSchema,
  terminalInputResultSchema,
  terminalInputSchema,
  terminalLeaseAcquireInputSchema,
  terminalLeaseAcquireResultSchema,
  terminalLeaseReleaseInputSchema,
  terminalLeaseReleaseResultSchema,
  terminalLeaseRenewInputSchema,
  terminalLeaseRenewResultSchema,
  terminalOpenInputSchema,
  terminalOpenResultSchema,
  terminalStreamItemSchema,
  terminalTerminateInputSchema,
} from "./terminal.js";

export const componentKindSchema = z.enum([
  "control-node",
  "runtime-node",
  "access-gateway",
]);
export type ComponentKind = z.infer<typeof componentKindSchema>;

const systemDescriptionBase = {
  application: z.literal("agent-multiplex"),
  protocolVersion: z.literal(5),
  instanceId: z.string().min(1),
  capabilities: z.array(z.string().min(1).max(256)),
} as const;

export const systemDescriptionSchema = z.discriminatedUnion("componentKind", [
  z.object({
    ...systemDescriptionBase,
    componentKind: z.literal("control-node"),
    dataAuthority: z.literal("control-node"),
  }),
  z.object({
    ...systemDescriptionBase,
    componentKind: z.literal("runtime-node"),
    dataAuthority: z.literal("native-agent-state"),
  }),
  z.object({
    ...systemDescriptionBase,
    componentKind: z.literal("access-gateway"),
    dataAuthority: z.literal("none"),
  }),
]);
export type SystemDescription = z.infer<typeof systemDescriptionSchema>;

export const accessGatewayDescriptionSchema = z.object({
  ...systemDescriptionBase,
  componentKind: z.literal("access-gateway"),
  dataAuthority: z.literal("none"),
});
export type AccessGatewayDescription = z.infer<
  typeof accessGatewayDescriptionSchema
>;

/**
 * Authority-neutral access surface. Mutations are proposals or routed agent
 * controls; only a control node may commit domain state.
 */
export const accessContract = {
  images: imageContract,

  system: {
    describe: { input: z.void(), output: systemDescriptionSchema },
  },
  sources: {
    manifest: { input: z.void(), output: sourceManifestSchema.nullable() },
    snapshot: { input: z.void(), output: accessSnapshotSchema.nullable() },
    list: { input: z.void(), output: z.array(sourceDiagnosticSchema) },
    watch: { input: z.void(), output: sourceDiagnosticSchema },
  },
  controlNodes: {
    list: { input: z.void(), output: z.array(controlNodeDescriptorSchema) },
    get: {
      input: controlNodeIdSchema,
      output: controlNodeDescriptorSchema.nullable(),
    },
    watch: {
      input: z.object({ cursor: streamCursorSchema }),
      output: accessStreamItemSchema,
    },
  },
  topology: {
    detach: {
      input: topologyDetachInputSchema,
      output: topologyDetachmentReceiptSchema,
    },
    forceDetach: {
      input: topologyForceDetachInputSchema,
      output: topologyDetachmentReceiptSchema,
    },
  },
  authority: {
    promote: {
      input: authorityPromoteInputSchema,
      output: authorityPromotionReceiptSchema,
    },
  },
  runtimeNodes: {
    list: { input: z.void(), output: z.array(runtimeNodeDescriptorSchema) },
    watch: {
      input: z.object({ cursor: streamCursorSchema }),
      output: accessStreamItemSchema,
    },
  },
  harness: {
    catalog: {
      input: z.object({ runtimeNodeId: runtimeNodeIdSchema.optional() }).optional(),
      output: z.array(harnessCatalogEntrySchema),
    },
    models: {
      input: z.object({
        runtimeNodeId: runtimeNodeIdSchema,
        harness: harnessSchema,
      }),
      output: z.array(nativeModelSchema),
    },
  },
  launchProfiles: {
    list: {
      input: z
        .object({
          runtimeNodeId: runtimeNodeIdSchema.optional(),
          providerId: launchProviderIdSchema.optional(),
          harness: harnessSchema.optional(),
        })
        .optional(),
      output: z.array(launchProfileDescriptorSchema),
    },
    models: {
      input: z.object({
        runtimeNodeId: runtimeNodeIdSchema,
        profile: launchProfileIdentitySchema,
        harness: harnessSchema,
      }),
      output: z.array(nativeModelSchema),
    },
  },
  launches: {
    create: { input: launchRequestSchema, output: launchRecordSchema },
    get: { input: launchIdSchema, output: launchRecordSchema.nullable() },
    list: { input: launchListInputSchema, output: launchListPageSchema },
    watch: {
      input: z.object({ cursor: streamCursorSchema }),
      output: accessStreamItemSchema,
    },
  },
  sessions: {
    search: { input: sessionSearchInputSchema, output: sessionSearchPageSchema },
    get: { input: sessionIdSchema, output: sessionRecordSchema.nullable() },
    refresh: {
      input: z.object({ runtimeNodeId: runtimeNodeIdSchema }),
      output: inventorySnapshotSchema,
    },
    resume: { input: resumeCommandSchema, output: commandRecordSchema },
    stop: { input: stopCommandSchema, output: commandRecordSchema },
    archive: { input: archiveRequestSchema, output: archiveRecordSchema },
    execute: { input: commandEnvelopeSchema, output: commandRecordSchema },
    readNativeHistory: {
      input: z.object({
        sessionId: sessionIdSchema,
        request: nativeHistoryRequestSchema,
      }),
      output: nativeHistoryResultSchema,
    },
    watch: { input: accessAttachInputSchema, output: accessStreamItemSchema },
  },
  archives: {
    get: {
      input: archiveOperationIdSchema,
      output: archiveRecordSchema.nullable(),
    },
    watch: {
      input: z.object({ cursor: streamCursorSchema }),
      output: accessStreamItemSchema,
    },
  },
  terminals: {
    get: { input: terminalGetInputSchema, output: terminalDescriptorSchema.nullable() },
    open: { input: terminalOpenInputSchema, output: terminalOpenResultSchema },
    attach: { input: terminalAttachInputSchema, output: terminalStreamItemSchema },
    lease: {
      acquire: {
        input: terminalLeaseAcquireInputSchema,
        output: terminalLeaseAcquireResultSchema,
      },
      renew: {
        input: terminalLeaseRenewInputSchema,
        output: terminalLeaseRenewResultSchema,
      },
      release: {
        input: terminalLeaseReleaseInputSchema,
        output: terminalLeaseReleaseResultSchema,
      },
    },
    input: { input: terminalInputSchema, output: terminalInputResultSchema },
    terminate: {
      input: terminalTerminateInputSchema,
      output: terminalDescriptorSchema,
    },
  },
  metadata: {
    get: { input: sessionIdSchema, output: metadataSnapshotSchema },
    patch: {
      input: metadataPatchSchema,
      output: metadataOperationRecordSchema,
    },
    operations: {
      get: {
        input: operationIdSchema,
        output: metadataOperationRecordSchema.nullable(),
      },
      list: {
        input: z
          .object({
            sessionId: sessionIdSchema.optional(),
            originControlNodeId: controlNodeIdSchema.optional(),
            status: z.array(metadataOperationStatusSchema).optional(),
            limit: z.number().int().positive().max(1_000).default(100),
          })
          .optional(),
        output: z.array(metadataOperationRecordSchema),
      },
      watch: {
        input: z.object({ cursor: streamCursorSchema }),
        output: accessStreamItemSchema,
      },
    },
  },
  interactions: {
    list: {
      input: z
        .object({
          sessionId: sessionIdSchema.optional(),
          pendingOnly: z.boolean().default(true),
        })
        .optional(),
      output: z.array(interactionRecordSchema),
    },
    resolve: {
      input: resolveInteractionInputSchema,
      output: interactionRecordSchema,
    },
  },
  commands: {
    get: { input: commandIdSchema, output: commandRecordSchema.nullable() },
  },
} as const;

export const runtimeNodeContract = {
  images: imageContract,

  runtimeNode: {
    describe: { input: z.void(), output: runtimeNodeRegistrationSchema },
  },
  inventory: {
    snapshot: {
      input: z.object({ runtimeNodeBootId: runtimeNodeBootIdSchema }),
      output: inventorySnapshotSchema,
    },
    refresh: {
      input: z.object({ runtimeNodeBootId: runtimeNodeBootIdSchema }),
      output: inventorySnapshotSchema,
    },
  },
  harness: {
    catalog: {
      input: z.object({ runtimeNodeBootId: runtimeNodeBootIdSchema }),
      output: z.array(harnessCatalogEntrySchema),
    },
    models: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        harness: harnessSchema,
      }),
      output: z.array(nativeModelSchema),
    },
  },
  launchProfiles: {
    list: {
      input: z.object({ runtimeNodeBootId: runtimeNodeBootIdSchema }),
      output: z.array(launchProfileDescriptorSchema),
    },
    models: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        profile: launchProfileIdentitySchema,
        harness: harnessSchema,
      }),
      output: z.array(nativeModelSchema),
    },
  },
  launches: {
    create: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        request: launchRequestSchema,
      }),
      output: launchRecordSchema,
    },
    get: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        launchId: launchIdSchema,
      }),
      output: launchRecordSchema.nullable(),
    },
    list: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        query: launchListInputSchema,
      }),
      output: launchListPageSchema,
    },
  },
  sessions: {
    resume: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        command: resumeCommandSchema,
      }),
      output: commandRecordSchema,
    },
    stop: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        command: stopCommandSchema,
      }),
      output: commandRecordSchema,
    },
    archive: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        request: archiveRequestSchema,
      }),
      output: archiveRecordSchema,
    },
    readNativeHistory: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        sessionId: sessionIdSchema,
        request: nativeHistoryRequestSchema,
      }),
      output: nativeHistoryResultSchema,
    },
  },
  archives: {
    get: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        archiveOperationId: archiveOperationIdSchema,
      }),
      output: archiveRecordSchema.nullable(),
    },
  },
  terminals: {
    get: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        request: terminalGetInputSchema,
      }),
      output: terminalDescriptorSchema.nullable(),
    },
    open: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        request: terminalOpenInputSchema,
      }),
      output: terminalOpenResultSchema,
    },
    attach: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        request: terminalAttachInputSchema,
      }),
      output: terminalStreamItemSchema,
    },
    lease: {
      acquire: {
        input: z.object({
          runtimeNodeBootId: runtimeNodeBootIdSchema,
          request: terminalLeaseAcquireInputSchema,
        }),
        output: terminalLeaseAcquireResultSchema,
      },
      renew: {
        input: z.object({
          runtimeNodeBootId: runtimeNodeBootIdSchema,
          request: terminalLeaseRenewInputSchema,
        }),
        output: terminalLeaseRenewResultSchema,
      },
      release: {
        input: z.object({
          runtimeNodeBootId: runtimeNodeBootIdSchema,
          request: terminalLeaseReleaseInputSchema,
        }),
        output: terminalLeaseReleaseResultSchema,
      },
    },
    input: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        request: terminalInputSchema,
      }),
      output: terminalInputResultSchema,
    },
    terminate: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        request: terminalTerminateInputSchema,
      }),
      output: terminalDescriptorSchema,
    },
  },
  commands: {
    execute: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        command: commandEnvelopeSchema,
      }),
      output: commandRecordSchema,
    },
    get: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        commandId: commandIdSchema,
      }),
      output: commandRecordSchema.nullable(),
    },
  },
  metadata: {
    get: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        sessionId: sessionIdSchema,
      }),
      output: metadataSnapshotSchema,
    },
    enqueue: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        patch: metadataPatchSchema,
      }),
      output: metadataSnapshotSchema,
    },
    settle: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        operation: metadataOperationRecordSchema,
      }),
      output: metadataOperationRecordSchema,
    },
  },
  interactions: {
    resolve: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        interaction: resolveInteractionInputSchema,
      }),
      output: interactionRecordSchema,
    },
  },
  events: {
    subscribe: {
      input: z.object({
        runtimeNodeBootId: runtimeNodeBootIdSchema,
        cursor: runtimeNodeEventCursorSchema,
      }),
      output: runtimeNodeEventItemSchema,
    },
  },
} as const;

export const controlNodeIngressContract = {
  gateways: {
    enroll: {
      input: gatewayEnrollmentSchema,
      output: z.object({
        accepted: z.boolean(),
        canonical: controlNodeDescriptorSchema,
        grantedScopes: actionScopesSchema,
        /** Fresh reachability only; endpointId remains the trust anchor. */
        p2pTicket: z.string().min(1).optional(),
      }),
    },
  },
  controlNodes: {
    attach: {
      input: controlNodeAttachmentRequestSchema,
      output: z.object({
        accepted: z.boolean(),
        canonical: controlNodeDescriptorSchema,
        attachment: controlNodeAttachmentSchema,
        parentCheckpoint: feedCheckpointSchema,
      }),
    },
    heartbeat: {
      input: controlNodeLinkFenceSchema.extend({
        checkpoint: feedCheckpointSchema,
      }),
      output: z.object({
        accepted: z.boolean(),
        parentCheckpoint: feedCheckpointSchema,
        p2pTicket: z.string().min(1).optional(),
      }),
    },
    pushMetadataOutbox: {
      input: controlNodeLinkFenceSchema.extend({
        operations: z.array(metadataOperationRecordSchema).max(1_000),
      }),
      output: z.array(metadataOperationRecordSchema),
    },
  },
  runtimeNodes: {
    register: {
      input: runtimeNodeRegistrationSchema,
      output: z.object({
        accepted: z.boolean(),
        canonical: runtimeNodeDescriptorSchema,
      }),
    },
    heartbeat: {
      input: z.object({
        runtimeNodeId: runtimeNodeIdSchema,
        runtimeNodeBootId: runtimeNodeBootIdSchema,
      }),
      output: z.object({
        accepted: z.boolean(),
        controlCursor: z.number().int().nonnegative(),
        p2pTicket: z.string().min(1).optional(),
      }),
    },
    reconcile: {
      input: runtimeNodeFenceSchema.extend({
        snapshot: inventorySnapshotSchema,
      }).superRefine((input, ctx) => {
        if (input.snapshot.runtimeNodeId !== input.runtimeNodeId) {
          ctx.addIssue({
            code: "custom",
            path: ["snapshot", "runtimeNodeId"],
            message: "inventory snapshot must match the runtime-node fence",
          });
        }
      }),
      output: z.object({
        sessions: z.array(sessionRecordSchema),
        controlCursor: z.number().int().nonnegative(),
      }),
    },
  },
  metadata: {
    pushOutbox: {
      input: runtimeNodeFenceSchema.extend({
        patches: z.array(metadataPatchSchema).max(1_000),
      }),
      output: z.array(metadataOperationRecordSchema),
    },
  },
  events: {
    publish: {
      input: runtimeNodeFenceSchema.extend({ event: runtimeNodeEventItemSchema }),
      output: z.object({ accepted: z.boolean() }),
    },
  },
  interactions: {
    publish: {
      input: runtimeNodeFenceSchema.extend({ interaction: interactionRecordSchema }),
      output: interactionRecordSchema,
    },
  },
} as const;

/** Fenced recursive surface exposed by an attached branch to its parent. */
export const controlNodeLinkContract = {
  images: {
    beginUpload: { input: controlNodeLinkFenceSchema.extend({ request: imageContract.beginUpload.input }), output: imageContract.beginUpload.output },
    writeUpload: { input: controlNodeLinkFenceSchema.extend({ request: imageContract.writeUpload.input }), output: imageContract.writeUpload.output },
    commitUpload: { input: controlNodeLinkFenceSchema.extend({ request: imageContract.commitUpload.input }), output: imageContract.commitUpload.output },
    abortUpload: { input: controlNodeLinkFenceSchema.extend({ request: imageContract.abortUpload.input }), output: imageContract.abortUpload.output },
    resolvePath: { input: controlNodeLinkFenceSchema.extend({ request: imageContract.resolvePath.input }), output: imageContract.resolvePath.output },
    read: { input: controlNodeLinkFenceSchema.extend({ request: imageContract.read.input }), output: imageContract.read.output },
    limits: { input: controlNodeLinkFenceSchema.extend({ request: imageContract.limits.input }), output: imageContract.limits.output },
  },

  controlNode: {
    describe: { input: z.void(), output: controlNodeDescriptorSchema },
  },
  topology: {
    snapshot: {
      input: controlNodeSubtreeSnapshotRequestSchema,
      output: controlNodeSubtreeSnapshotPageSchema,
    },
    applyDetachment: {
      input: controlNodeLinkFenceSchema.extend({
        receipt: topologyDetachmentReceiptSchema,
      }),
      output: topologyDetachmentReceiptSchema,
    },
  },
  events: {
    subscribe: {
      input: controlNodeLinkFenceSchema.extend({ cursor: streamCursorSchema }),
      output: accessStreamItemSchema,
    },
  },
  harness: {
    models: {
      input: controlNodeLinkFenceSchema.extend({
        runtimeNodeId: runtimeNodeIdSchema,
        harness: harnessSchema,
      }),
      output: z.array(nativeModelSchema),
    },
  },
  launchProfiles: {
    models: {
      input: controlNodeLinkFenceSchema.extend({
        runtimeNodeId: runtimeNodeIdSchema,
        profile: launchProfileIdentitySchema,
        harness: harnessSchema,
      }),
      output: z.array(nativeModelSchema),
    },
  },
  launches: {
    create: {
      input: controlNodeLinkFenceSchema.extend({ request: launchRequestSchema }),
      output: launchRecordSchema,
    },
    get: {
      input: controlNodeLinkFenceSchema.extend({ launchId: launchIdSchema }),
      output: launchRecordSchema.nullable(),
    },
    list: {
      input: controlNodeLinkFenceSchema.extend({ query: launchListInputSchema }),
      output: launchListPageSchema,
    },
  },
  sessions: {
    search: {
      input: controlNodeLinkFenceSchema.extend({
        query: sessionSearchInputSchema,
      }),
      output: sessionSearchPageSchema,
    },
    get: {
      input: controlNodeLinkFenceSchema.extend({
        sessionId: sessionIdSchema,
      }),
      output: sessionRecordSchema.nullable(),
    },
    refresh: {
      input: controlNodeLinkFenceSchema.extend({
        runtimeNodeId: runtimeNodeIdSchema,
      }),
      output: inventorySnapshotSchema,
    },
    resume: {
      input: controlNodeLinkFenceSchema.extend({ command: resumeCommandSchema }),
      output: commandRecordSchema,
    },
    stop: {
      input: controlNodeLinkFenceSchema.extend({ command: stopCommandSchema }),
      output: commandRecordSchema,
    },
    archive: {
      input: controlNodeLinkFenceSchema.extend({ request: archiveRequestSchema }),
      output: archiveRecordSchema,
    },
    readNativeHistory: {
      input: controlNodeLinkFenceSchema.extend({
        sessionId: sessionIdSchema,
        request: nativeHistoryRequestSchema,
      }),
      output: nativeHistoryResultSchema,
    },
  },
  archives: {
    get: {
      input: controlNodeLinkFenceSchema.extend({
        archiveOperationId: archiveOperationIdSchema,
      }),
      output: archiveRecordSchema.nullable(),
    },
  },
  terminals: {
    get: {
      input: controlNodeLinkFenceSchema.extend({ request: terminalGetInputSchema }),
      output: terminalDescriptorSchema.nullable(),
    },
    open: {
      input: controlNodeLinkFenceSchema.extend({ request: terminalOpenInputSchema }),
      output: terminalOpenResultSchema,
    },
    attach: {
      input: controlNodeLinkFenceSchema.extend({ request: terminalAttachInputSchema }),
      output: terminalStreamItemSchema,
    },
    lease: {
      acquire: {
        input: controlNodeLinkFenceSchema.extend({
          request: terminalLeaseAcquireInputSchema,
        }),
        output: terminalLeaseAcquireResultSchema,
      },
      renew: {
        input: controlNodeLinkFenceSchema.extend({
          request: terminalLeaseRenewInputSchema,
        }),
        output: terminalLeaseRenewResultSchema,
      },
      release: {
        input: controlNodeLinkFenceSchema.extend({
          request: terminalLeaseReleaseInputSchema,
        }),
        output: terminalLeaseReleaseResultSchema,
      },
    },
    input: {
      input: controlNodeLinkFenceSchema.extend({ request: terminalInputSchema }),
      output: terminalInputResultSchema,
    },
    terminate: {
      input: controlNodeLinkFenceSchema.extend({
        request: terminalTerminateInputSchema,
      }),
      output: terminalDescriptorSchema,
    },
  },
  commands: {
    execute: {
      input: controlNodeLinkFenceSchema.extend({
        command: commandEnvelopeSchema,
      }),
      output: commandRecordSchema,
    },
    get: {
      input: controlNodeLinkFenceSchema.extend({
        commandId: commandIdSchema,
      }),
      output: commandRecordSchema.nullable(),
    },
  },
  interactions: {
    resolve: {
      input: controlNodeLinkFenceSchema.extend({
        interaction: resolveInteractionInputSchema,
      }),
      output: interactionRecordSchema,
    },
  },
  metadata: {
    settle: {
      input: controlNodeLinkFenceSchema.extend({
        operation: metadataOperationRecordSchema,
      }),
      output: metadataOperationRecordSchema,
    },
  },
} as const;

/** Contract roles a control node implements simultaneously. */
export const compositeControlNodeContract = {
  access: accessContract,
  ingress: controlNodeIngressContract,
  link: controlNodeLinkContract,
} as const;

export const protocolErrorSchema = z.object({
  code: z.enum([
    "NOT_FOUND",
    "CONFLICT",
    "UNAVAILABLE",
    "FENCED",
    "PAYLOAD_MISMATCH",
    "OUTCOME_UNKNOWN",
    "INVALID_PATH",
    "UNSUPPORTED",
    "CURSOR_EXPIRED",
    "UNAUTHORIZED",
  ]),
  message: z.string(),
  details: jsonValueSchema.optional(),
});
export type ProtocolError = z.infer<typeof protocolErrorSchema>;
