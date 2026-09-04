import { z } from "zod";

import { interactionRecordSchema } from "./interaction.js";
import { metadataOperationRecordSchema } from "./metadata.js";
import { controlNodeDescriptorSchema } from "./control-node.js";
import { runtimeNodeDescriptorSchema } from "./runtime-node.js";
import { sessionRecordSchema } from "./session.js";
import { sourceCoverageSnapshotSchema } from "./source.js";

/**
 * One atomic access projection and replay barrier. Control nodes create it in
 * a read transaction; gateways replace a source projection only after the
 * entire value validates. Native history deliberately remains app-server-owned.
 */
export const accessSnapshotSchema = z.object({
  source: sourceCoverageSnapshotSchema,
  capturedAt: z.iso.datetime({ offset: true }),
  controlNodes: z.array(controlNodeDescriptorSchema),
  runtimeNodes: z.array(runtimeNodeDescriptorSchema),
  sessions: z.array(sessionRecordSchema),
  interactions: z.array(interactionRecordSchema),
  metadataOperations: z.array(metadataOperationRecordSchema),
}).superRefine((snapshot, ctx) => {
  const authority = snapshot.source.manifest.authority;
  const sameAuthority = (candidate: typeof authority): boolean =>
    candidate.realmId === authority.realmId &&
    candidate.controlNodeId === authority.controlNodeId &&
    candidate.epochId === authority.epochId;
  const advertised = new Set(snapshot.source.manifest.coveredControlNodeIds);
  const actual = new Set(snapshot.controlNodes.map((node) => node.controlNodeId));
  if (
    actual.size !== snapshot.controlNodes.length ||
    advertised.size !== actual.size ||
    [...advertised].some((controlNodeId) => !actual.has(controlNodeId))
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["controlNodes"],
      message: "snapshot control nodes must exactly match advertised coverage",
    });
  }
  const servingNode = snapshot.controlNodes.find(
    (node) => node.controlNodeId === snapshot.source.manifest.sourceControlNodeId,
  );
  if (
    servingNode !== undefined &&
    servingNode.controlNodeBootId !== snapshot.source.manifest.sourceControlNodeBootId
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["source", "manifest", "sourceControlNodeBootId"],
      message: "source manifest boot fence must match the serving control node",
    });
  }
  if (
    servingNode !== undefined &&
    servingNode.feedId !== snapshot.source.manifest.feedId
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["source", "manifest", "feedId"],
      message: "source manifest feed must match the serving control node",
    });
  }
  for (const [index, node] of snapshot.controlNodes.entries()) {
    if (!sameAuthority(node.dataRole.authority)) {
      ctx.addIssue({
        code: "custom",
        path: ["controlNodes", index, "dataRole", "authority"],
        message: "every projected control node must carry the manifest authority fence",
      });
    }
    const advertisedParent = snapshot.source.parentByControlNodeId[node.controlNodeId];
    const atProjectionRoot =
      node.controlNodeId === snapshot.source.manifest.projectionRootControlNodeId;
    if (!atProjectionRoot) {
      if (
        node.dataRole.role !== "branch" ||
        node.dataRole.branch.lifecycle !== "attached" ||
        node.dataRole.branch.parentControlNodeId !== advertisedParent
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["controlNodes", index, "dataRole"],
          message: "non-root control-node roles must match the advertised attached tree edge",
        });
      }
    } else if (
      node.dataRole.role === "branch" &&
      node.dataRole.branch.lifecycle === "attached" &&
      advertised.has(node.dataRole.branch.parentControlNodeId)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["controlNodes", index, "dataRole", "branch", "parentControlNodeId"],
        message: "a projection root's parent must be outside its advertised coverage",
      });
    }
  }
  const runtimeIds = new Set(snapshot.runtimeNodes.map((node) => node.runtimeNodeId));
  if (runtimeIds.size !== snapshot.runtimeNodes.length) {
    ctx.addIssue({
      code: "custom",
      path: ["runtimeNodes"],
      message: "snapshot runtime-node identities must be unique",
    });
  }
  for (const [index, runtime] of snapshot.runtimeNodes.entries()) {
    if (!advertised.has(runtime.ownerControlNodeId)) {
      ctx.addIssue({
        code: "custom",
        path: ["runtimeNodes", index, "ownerControlNodeId"],
        message: "runtime-node owner must be inside snapshot coverage",
      });
    }
  }
  const sessionIds = new Set(snapshot.sessions.map((session) => session.sessionId));
  if (sessionIds.size !== snapshot.sessions.length) {
    ctx.addIssue({
      code: "custom",
      path: ["sessions"],
      message: "snapshot session identities must be unique",
    });
  }
  const nativeBindings = snapshot.sessions.map((session) => [
    session.runtimeNodeId,
    session.harness,
    session.adapterScopeId,
    session.vendorSessionId,
  ].join("\0"));
  if (new Set(nativeBindings).size !== nativeBindings.length) {
    ctx.addIssue({
      code: "custom",
      path: ["sessions"],
      message: "snapshot native session bindings must be unique",
    });
  }
  for (const [index, session] of snapshot.sessions.entries()) {
    if (!runtimeIds.has(session.runtimeNodeId)) {
      ctx.addIssue({
        code: "custom",
        path: ["sessions", index, "runtimeNodeId"],
        message: "session runtime node must be present in the same snapshot",
      });
    }
    if (!sameAuthority(session.metadataAuthority)) {
      ctx.addIssue({
        code: "custom",
        path: ["sessions", index, "metadataAuthority"],
        message: "session metadata authority must match the source manifest",
      });
    }
  }
  for (const [index, interaction] of snapshot.interactions.entries()) {
    if (!sessionIds.has(interaction.sessionId)) {
      ctx.addIssue({
        code: "custom",
        path: ["interactions", index, "sessionId"],
        message: "interaction session must be present in the same snapshot",
      });
    }
    const session = snapshot.sessions.find(
      (candidate) => candidate.sessionId === interaction.sessionId,
    );
    if (session !== undefined && interaction.harness !== session.harness) {
      ctx.addIssue({
        code: "custom",
        path: ["interactions", index, "harness"],
        message: "interaction harness must match its session binding",
      });
    }
  }
  if (new Set(snapshot.interactions.map((item) => item.interactionId)).size !== snapshot.interactions.length) {
    ctx.addIssue({
      code: "custom",
      path: ["interactions"],
      message: "snapshot interaction identities must be unique",
    });
  }
  for (const [index, operation] of snapshot.metadataOperations.entries()) {
    if (!sessionIds.has(operation.sessionId)) {
      ctx.addIssue({
        code: "custom",
        path: ["metadataOperations", index, "sessionId"],
        message: "metadata-operation session must be present in the same snapshot",
      });
    }
  }
  if (new Set(snapshot.metadataOperations.map((item) => item.operationId)).size !== snapshot.metadataOperations.length) {
    ctx.addIssue({
      code: "custom",
      path: ["metadataOperations"],
      message: "snapshot metadata-operation identities must be unique",
    });
  }
});

export type AccessSnapshot = z.infer<typeof accessSnapshotSchema>;
