import { z } from "zod";
import { canonicalJson, type Json } from "../protocol/index.js";
import type { Answer } from "../interactions/contracts.js";
const name = z.string().min(1).max(256);
export const referenceSelectionSchema = z
  .object({
    model: name,
    mode: z.enum(["agent", "plan"]),
    effort: z.enum(["low", "high"]),
  })
  .strict();
export type ReferenceSelection = z.output<typeof referenceSelectionSchema>;
export const referenceMessageSchema = z.object({ text: z.string().max(65536) }).strict();
export const referenceScopeSchema = z
  .object({ connection: name, principal: name, host: name, session: name })
  .strict();
export const referenceRunSchema = z
  .object({
    scope: referenceScopeSchema,
    generation: z.number().int().positive(),
    nativeSession: name,
  })
  .strict();
export const referenceCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("settings"),
      patch: z
        .object({
          model: name.optional(),
          mode: z.enum(["agent", "plan"]).optional(),
          effort: z.enum(["low", "high"]).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("answer"),
      reference: z
        .object({
          run: referenceRunSchema,
          attachment: name,
          incarnation: z.number().int().positive(),
        })
        .strict(),
      answer: z.custom<Answer>((value) => {
        try {
          canonicalJson(value as Json, 16384);
          return !!value && typeof value === "object" && "type" in value;
        } catch {
          return false;
        }
      }),
    })
    .strict(),
  z.object({ type: z.literal("continue") }).strict(),
]);
export type ReferenceCommand = z.output<typeof referenceCommandSchema>;
export type ReferenceBootstrap = Readonly<{
  /** Pinned native Host endpoint, separate from its application owner/route. */
  hostId: string;
  previews?: readonly import("../files/contracts.js").Preview[];
  route: import("../host/contracts.js").HostRoute;
  expected: import("../host/contracts.js").ExpectedHost;
  scopes: readonly Readonly<{ scope: import("../protocol/index.js").SessionScope; name: string }>[];
}>;
