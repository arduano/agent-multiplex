import { z } from "zod";
import { jsonWireByteUpperBound, toJsonValue } from "./json.js";

export const CONVERSATION_EVIDENCE_MAX_BYTES = 192 * 1_024;

const identity = z.string().min(1).max(4_096);

/** Positions and revisions are different facts. A page index is neither. */
export const conversationPositionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown") }),
  z.object({ kind: z.literal("nativeEvent"), eventId: identity, afterEventId: identity.optional() }),
  z.object({ kind: z.literal("observation"), generation: identity, sequence: z.number().int().nonnegative() }),
]);
export type ConversationPosition = z.infer<typeof conversationPositionSchema>;

export const conversationRevisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("incomparable") }),
  z.object({ kind: z.literal("immutable"), recordId: identity }),
  z.object({ kind: z.literal("observation"), generation: identity, sequence: z.number().int().nonnegative() }),
]);
export type ConversationRevision = z.infer<typeof conversationRevisionSchema>;

/** Descriptors refer into the accompanying native JSON; content/images are not
 * copied into a second wire transcript. Item identity is adapter-owned. */
export const conversationItemEvidenceSchema = z.object({
  itemId: identity,
  threadId: identity,
  pointer: z.string().max(4_096).regex(/^(?:|\/(?:[^~]|~[01])*)$/),
  position: conversationPositionSchema,
  revision: conversationRevisionSchema,
  completion: z.enum(["open", "settled", "unverified"]),
  persistence: z.enum(["native", "ephemeral"]),
});
export type ConversationItemEvidence = z.infer<typeof conversationItemEvidenceSchema>;

export const conversationEvidenceSchema = z.object({
  version: z.literal("v1"),
  view: z.enum(["primary", "all", "child"]),
  items: z.array(conversationItemEvidenceSchema).max(1_000),
  /** A supported native ordered run. Omissions never certify deletion. */
  order: z.array(identity).max(1_000),
  coverage: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unknown") }),
    z.object({ kind: z.literal("observation"), generation: identity, throughSequence: z.number().int().nonnegative() }),
  ]),
}).superRefine((value, context) => {
  if (jsonWireByteUpperBound(toJsonValue(value)) > CONVERSATION_EVIDENCE_MAX_BYTES) context.addIssue({ code: "custom", message: "Conversation evidence exceeds its bounded wire budget" });
});
export type ConversationEvidence = z.infer<typeof conversationEvidenceSchema>;

/** Metadata may be partial; absent descriptors/coverage never imply absent
 * native content. Native payload retains its independent full budget. */
export function boundedConversationEvidence(evidence: ConversationEvidence): ConversationEvidence {
  let items = evidence.items.slice(0, 1_000);
  for (;;) {
    const keys = new Set(items.map(item => item.itemId));
    const result = { ...evidence, items, order: evidence.order.filter(key => keys.has(key)).slice(0, 1_000) };
    if (jsonWireByteUpperBound(toJsonValue(result)) <= CONVERSATION_EVIDENCE_MAX_BYTES) return result;
    if (!items.length) throw new TypeError("Conversation evidence header exceeds its wire budget");
    items = items.slice(0, Math.floor(items.length / 2));
  }
}

/** Only the live effect owner can stamp an observed mutable update. A history
 * response cannot call this with its arrival time or a fabricated watermark. */
export function stampConversationObservation(evidence: ConversationEvidence, generation: string, sequence: number): ConversationEvidence {
  return {
    ...evidence,
    items: evidence.items.map(item => ({ ...item,
      position: item.position.kind === "unknown" ? { kind: "observation", generation, sequence } : item.position,
      revision: item.revision.kind === "incomparable" ? { kind: "observation", generation, sequence } : item.revision,
    })),
  };
}
