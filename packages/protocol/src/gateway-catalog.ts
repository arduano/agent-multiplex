import { z } from "zod";
import { controlNodeDescriptorSchema } from "./control-node.js";
import { feedIdSchema, sessionIdSchema } from "./ids.js";
import { interactionRecordSchema } from "./interaction.js";
import { runtimeNodeDescriptorSchema } from "./runtime-node.js";
import { sessionRecordSchema, sessionSearchPageSchema } from "./session.js";
import { sourceDiagnosticSchema, sourceIdSchema, sourceManifestSchema } from "./source.js";

export const GATEWAY_CATALOG_LIMITS = { sources: 64, controls: 1_024, runtimes: 1_024, sessions: 5_000, interactions: 5_000, pins: 128 } as const;
/** Gateway observation identity, never a Control authority or native watermark. */
export const gatewayCatalogStampSchema = z.object({
  viewId: feedIdSchema,
  revision: z.number().int().nonnegative().safe(),
  feedId: feedIdSchema,
  controlCursor: z.number().int().nonnegative().safe(),
}).strict();
export type GatewayCatalogStamp = z.infer<typeof gatewayCatalogStampSchema>;
export const gatewayCatalogReadSchema = z.object({
  sessionLimit: z.number().int().min(1).max(GATEWAY_CATALOG_LIMITS.sessions).default(500),
  sessionIds: z.array(sessionIdSchema).max(GATEWAY_CATALOG_LIMITS.pins).default([]),
}).strict();
export type GatewayCatalogRead = z.infer<typeof gatewayCatalogReadSchema>;
export const gatewayCatalogCoverageSchema = z.array(z.object({ sourceId: sourceIdSchema, manifest: sourceManifestSchema }).strict()).max(GATEWAY_CATALOG_LIMITS.sources);
export const gatewayCatalogViewSchema = z.object({
  stamp: gatewayCatalogStampSchema,
  sources: z.array(sourceDiagnosticSchema).max(GATEWAY_CATALOG_LIMITS.sources),
  coverage: gatewayCatalogCoverageSchema,
  controlNodes: z.array(controlNodeDescriptorSchema).max(GATEWAY_CATALOG_LIMITS.controls),
  runtimeNodes: z.array(runtimeNodeDescriptorSchema).max(GATEWAY_CATALOG_LIMITS.runtimes),
  sessions: z.array(sessionRecordSchema).max(GATEWAY_CATALOG_LIMITS.sessions),
  pinnedSessions: z.array(sessionRecordSchema).max(GATEWAY_CATALOG_LIMITS.pins),
  interactions: z.array(interactionRecordSchema).max(GATEWAY_CATALOG_LIMITS.interactions),
  complete: z.object({ sources: z.boolean(), controls: z.boolean(), runtimes: z.boolean(), sessions: z.boolean(), interactions: z.boolean() }).strict(),
}).strict();
export type GatewayCatalogView = z.infer<typeof gatewayCatalogViewSchema>;
/** A source read is fenced to routing membership, but the source API does not
 * supply a record watermark. Its contents cannot be compared with a catalog
 * revision. Keep this distinction explicit rather than stamp arrival as truth. */
export const gatewayCatalogEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("projection"), stamp: gatewayCatalogStampSchema }).strict(),
  z.object({ kind: z.literal("source-read"), stamp: gatewayCatalogStampSchema, orderedWithProjection: z.literal(false) }).strict(),
]);
export const gatewayCatalogSessionSchema = z.object({ evidence: gatewayCatalogEvidenceSchema, session: sessionRecordSchema.nullable() }).strict();
export const gatewayCatalogPageSchema = z.object({ evidence: gatewayCatalogEvidenceSchema, page: sessionSearchPageSchema }).strict();

export type GatewayCatalogSession = z.infer<typeof gatewayCatalogSessionSchema>;
export type GatewayCatalogPage = z.infer<typeof gatewayCatalogPageSchema>;

export const gatewayCatalogDeltaSchema = z.object({
  stamp: gatewayCatalogStampSchema,
  source: z.object({ sourceId: sourceIdSchema,
    position: sourceManifestSchema.pick({ sourceControlNodeBootId: true, feedId: true, controlCursor: true, generatedAt: true }),
  }).strict(),
}).strict();
