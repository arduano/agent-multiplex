import { z } from "zod";

import { authorityRefSchema } from "./authority.js";
import {
  controlNodeBootIdSchema,
  controlNodeIdSchema,
  feedIdSchema,
} from "./ids.js";

const isoDateSchema = z.iso.datetime({ offset: true });

/** Permission categories granted to authenticated access-gateway clients. */
export const actionScopeSchema = z.enum([
  "read",
  "agent-launch",
  "agent-archive",
  "agent-control",
  "terminal-view",
  "terminal-control",
  "metadata-propose",
  "topology-admin",
  "authority-admin",
]);
export type ActionScope = z.infer<typeof actionScopeSchema>;

export const actionScopesSchema = z
  .array(actionScopeSchema)
  .max(actionScopeSchema.options.length)
  .refine((scopes) => new Set(scopes).size === scopes.length, {
    message: "action scopes must be unique",
  });
export type ActionScopes = z.infer<typeof actionScopesSchema>;

/** Bootstrap request for a zero-authority gateway. */
export const gatewayEnrollmentSchema = z.object({
  name: z.string().min(1).max(256),
  protocolVersion: z.literal(4),
  requestedScopes: actionScopesSchema.default(["read"]),
});
export type GatewayEnrollment = z.infer<typeof gatewayEnrollmentSchema>;

/**
 * A gateway-local identifier for one configured source. It is not a domain
 * identity and never participates in authority decisions.
 */
export const sourceIdSchema = z.string().min(1).max(256);
export type SourceId = z.infer<typeof sourceIdSchema>;

/**
 * A self-contained description of one control-node projection. Exact coverage
 * lets a zero-authority gateway suppress overlapping sources deterministically.
 */
export const sourceManifestSchema = z
  .object({
    componentKind: z.literal("control-node"),
    protocolVersion: z.literal(4),
    sourceControlNodeId: controlNodeIdSchema,
    sourceControlNodeBootId: controlNodeBootIdSchema,
    authority: authorityRefSchema,
    projectionRootControlNodeId: controlNodeIdSchema,
    coveredControlNodeIds: z.array(controlNodeIdSchema).min(1),
    feedId: feedIdSchema,
    controlCursor: z.number().int().nonnegative(),
    generatedAt: isoDateSchema,
    capabilities: z.array(z.string().min(1).max(256)),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.sourceControlNodeId !== manifest.projectionRootControlNodeId) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceControlNodeId"],
        message: "the serving control node must be the projection root",
      });
    }
    if (manifest.authority.controlNodeId !== manifest.projectionRootControlNodeId) {
      const authorityIsCovered = manifest.coveredControlNodeIds.includes(
        manifest.authority.controlNodeId,
      );
      if (authorityIsCovered) {
        ctx.addIssue({
          code: "custom",
          path: ["authority", "controlNodeId"],
          message:
            "a branch projection must not claim its ancestor authority as covered",
        });
      }
    }
    const covered = new Set(manifest.coveredControlNodeIds);
    if (covered.size !== manifest.coveredControlNodeIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["coveredControlNodeIds"],
        message: "source coverage must not contain duplicate control nodes",
      });
    }
    if (!covered.has(manifest.projectionRootControlNodeId)) {
      ctx.addIssue({
        code: "custom",
        path: ["coveredControlNodeIds"],
        message: "source coverage must include its projection root",
      });
    }
    if (!covered.has(manifest.sourceControlNodeId)) {
      ctx.addIssue({
        code: "custom",
        path: ["coveredControlNodeIds"],
        message: "source coverage must include the serving control node",
      });
    }
  });
export type SourceManifest = z.infer<typeof sourceManifestSchema>;

/** Snapshot-time proof that the exact advertised coverage forms one tree. */
export const sourceCoverageSnapshotSchema = z
  .object({
    manifest: sourceManifestSchema,
    parentByControlNodeId: z.record(
      controlNodeIdSchema,
      controlNodeIdSchema.nullable(),
    ),
  })
  .superRefine((snapshot, ctx) => {
    const covered = new Set<string>(snapshot.manifest.coveredControlNodeIds);
    const parentEntries = Object.entries(snapshot.parentByControlNodeId);
    if (
      parentEntries.length !== covered.size ||
      parentEntries.some(([controlNodeId]) => !covered.has(controlNodeId))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["parentByControlNodeId"],
        message: "coverage topology must contain exactly the advertised control nodes",
      });
      return;
    }
    for (const [controlNodeId, parentControlNodeId] of parentEntries) {
      const atRoot =
        controlNodeId === snapshot.manifest.projectionRootControlNodeId;
      if (atRoot && parentControlNodeId !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["parentByControlNodeId", controlNodeId],
          message: "the projection root must not have a covered parent",
        });
      } else if (
        !atRoot &&
        (parentControlNodeId === null || !covered.has(parentControlNodeId))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["parentByControlNodeId", controlNodeId],
          message: "every non-root covered control node must have a covered parent",
        });
      }
    }
    const parentById = snapshot.parentByControlNodeId as Record<
      string,
      string | null
    >;
    const projectionRoot = snapshot.manifest.projectionRootControlNodeId;
    for (const controlNodeId of covered) {
      let current: string | null = controlNodeId;
      const visited = new Set<string>();
      while (current !== null && current !== projectionRoot) {
        if (visited.has(current)) {
          ctx.addIssue({
            code: "custom",
            path: ["parentByControlNodeId", controlNodeId],
            message: "coverage topology must not contain a cycle",
          });
          break;
        }
        visited.add(current);
        current = parentById[current] ?? null;
      }
    }
  });
export type SourceCoverageSnapshot = z.infer<
  typeof sourceCoverageSnapshotSchema
>;

export const sourceStateSchema = z.enum([
  "disabled",
  "connecting",
  "synchronizing",
  "selected",
  "suppressed",
  "conflict",
  "unavailable",
]);
export type SourceState = z.infer<typeof sourceStateSchema>;

export const sourceDiagnosticSchema = z
  .object({
    sourceId: sourceIdSchema,
    displayName: z.string().min(1).max(256),
    endpointId: z.string().min(1).max(512),
    state: sourceStateSchema,
    manifest: sourceManifestSchema.nullable(),
    selectedBySourceId: sourceIdSchema.optional(),
    reason: z.string().min(1).max(4_096).optional(),
    lastError: z.string().min(1).max(4_096).optional(),
    updatedAt: isoDateSchema,
  })
  .superRefine((diagnostic, ctx) => {
    if (
      diagnostic.state === "suppressed" &&
      diagnostic.selectedBySourceId === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["selectedBySourceId"],
        message: "a suppressed source must identify the selected source",
      });
    }
    if (
      diagnostic.state !== "suppressed" &&
      diagnostic.selectedBySourceId !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["selectedBySourceId"],
        message: "only suppressed sources identify a selected source",
      });
    }
    if (
      (diagnostic.state === "selected" ||
        diagnostic.state === "suppressed" ||
        diagnostic.state === "conflict") &&
      diagnostic.manifest === null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["manifest"],
        message: `${diagnostic.state} sources must have a manifest`,
      });
    }
  });
export type SourceDiagnostic = z.infer<typeof sourceDiagnosticSchema>;
