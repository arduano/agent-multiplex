import { z } from "zod";

import { harnessSchema } from "./harness.js";
import { interactionIdSchema, runtimeEpochSchema, sessionIdSchema } from "./ids.js";
import { jsonValueSchema } from "./json.js";
import { nativePayloadSchema } from "./image.js";
import { isoDateSchema } from "./session.js";

export const interactionStateSchema = z.enum([
  "pending",
  "resolved",
  "expired",
  "stale",
]);

export const interactionRecordSchema = z.object({
  interactionId: interactionIdSchema,
  sessionId: sessionIdSchema,
  harness: harnessSchema,
  runtimeEpoch: runtimeEpochSchema,
  nativeRequestId: z.string().optional(),
  requestType: z.enum([
    "approval",
    "permission",
    "userInput",
    "elicitation",
    "exitPlan",
    "other",
  ]),
  payload: nativePayloadSchema,
  ephemeral: z.boolean(),
  state: interactionStateSchema,
  resolution: nativePayloadSchema.optional(),
  createdAt: isoDateSchema,
  expiresAt: isoDateSchema.nullable(),
  resolvedAt: isoDateSchema.nullable(),
});
export type InteractionRecord = z.infer<typeof interactionRecordSchema>;

export const resolveInteractionInputSchema = z.object({
  interactionId: interactionIdSchema,
  sessionId: sessionIdSchema,
  harness: harnessSchema,
  response: jsonValueSchema,
});
export type ResolveInteractionInput = z.infer<typeof resolveInteractionInputSchema>;
