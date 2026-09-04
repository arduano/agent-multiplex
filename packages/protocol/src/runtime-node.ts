import { z } from "zod";

import { routeReachabilitySchema } from "./control-node.js";
import { harnessCatalogEntrySchema } from "./harness.js";
import { launchProfileDescriptorSchema } from "./launch.js";
import {
  controlNodeIdSchema,
  runtimeNodeBootIdSchema,
  runtimeNodeIdSchema,
} from "./ids.js";

const isoDateSchema = z.iso.datetime({ offset: true });

export const runtimeNodePresenceSchema = z.enum([
  "online",
  "offline",
  "stale",
]);
export type RuntimeNodePresence = z.infer<typeof runtimeNodePresenceSchema>;

export const runtimeNodeDescriptorSchema = z.object({
  runtimeNodeId: runtimeNodeIdSchema,
  runtimeNodeBootId: runtimeNodeBootIdSchema,
  ownerControlNodeId: controlNodeIdSchema,
  name: z.string().min(1).max(256),
  endpointId: z.string().min(1).max(512).optional(),
  presence: runtimeNodePresenceSchema,
  reachability: routeReachabilitySchema,
  connectedAt: isoDateSchema.nullable(),
  lastHeartbeatAt: isoDateSchema.nullable(),
  allowedRoots: z.array(z.string()),
  harnesses: z.array(harnessCatalogEntrySchema),
  launchProfiles: z.array(launchProfileDescriptorSchema).default([]),
  protocolVersion: z.literal(4),
});
export type RuntimeNodeDescriptor = z.infer<
  typeof runtimeNodeDescriptorSchema
>;

export const runtimeNodeRegistrationSchema = runtimeNodeDescriptorSchema.pick({
  runtimeNodeId: true,
  runtimeNodeBootId: true,
  name: true,
  allowedRoots: true,
  harnesses: true,
  launchProfiles: true,
  protocolVersion: true,
});
export type RuntimeNodeRegistration = z.infer<
  typeof runtimeNodeRegistrationSchema
>;

/** Complete process-epoch fence on every runtime-node initiated mutation. */
export const runtimeNodeFenceSchema = z.object({
  runtimeNodeId: runtimeNodeIdSchema,
  runtimeNodeBootId: runtimeNodeBootIdSchema,
});
export type RuntimeNodeFence = z.infer<typeof runtimeNodeFenceSchema>;
