import { describe, expect, it } from "vitest";

import {
  accessHeartbeatSchema,
  accessSnapshotSchema,
  authorityPromotionReceiptSchema,
  controlNodeAttachmentRequestSchema,
  controlNodeDescriptorSchema,
  metadataPatchSchema,
  newAttachmentId,
  newAuthorityEpochId,
  newAuthorityTransitionId,
  newControlNodeBootId,
  newControlNodeId,
  newFeedId,
  newLineageId,
  newOperationId,
  newRealmId,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  newTopologyTransitionId,
  launchRequestSchema,
  sourceManifestSchema,
  sourceCoverageSnapshotSchema,
} from "../src/index.js";

const now = "2026-09-03T00:00:00.000+00:00";

function authority(controlNodeId = newControlNodeId()) {
  return {
    realmId: newRealmId(),
    controlNodeId,
    epochId: newAuthorityEpochId(),
  };
}

describe("protocol v4 data roles", () => {
  it("requires an authority descriptor to point at itself", () => {
    const controlNodeId = newControlNodeId();
    const value = {
      controlNodeId,
      controlNodeBootId: newControlNodeBootId(),
      feedId: newFeedId(),
      name: "authority",
      presence: "online",
      dataRole: { role: "authority", authority: authority() },
      connectedAt: now,
      lastHeartbeatAt: now,
      protocolVersion: 5,
      capabilities: [],
    };

    expect(controlNodeDescriptorSchema.safeParse(value).success).toBe(false);
    expect(
      controlNodeDescriptorSchema.safeParse({
        ...value,
        dataRole: {
          role: "authority",
          authority: authority(controlNodeId),
        },
      }).success,
    ).toBe(true);
  });

  it("requires promotion to mint both a new realm and epoch", () => {
    const controlNodeId = newControlNodeId();
    const previousAuthority = authority(newControlNodeId());
    const base = {
      transitionId: newAuthorityTransitionId(),
      controlNodeId,
      previousAuthority,
      authority: authority(controlNodeId),
      detachmentTransitionId: newTopologyTransitionId(),
      promotedAt: now,
    };

    expect(authorityPromotionReceiptSchema.safeParse(base).success).toBe(true);
    expect(
      authorityPromotionReceiptSchema.safeParse({
        ...base,
        authority: {
          ...base.authority,
          realmId: previousAuthority.realmId,
        },
      }).success,
    ).toBe(false);
  });

  it("requires attachment proof to cover the child exactly once", () => {
    const childControlNodeId = newControlNodeId();
    const request = {
      controlNodeId: childControlNodeId,
      controlNodeBootId: newControlNodeBootId(),
      feedId: newFeedId(),
      name: "child",
      protocolVersion: 5,
      capabilities: [],
      expectedParentControlNodeId: newControlNodeId(),
      childProof: {
        currentRole: {
          role: "authority",
          authority: authority(childControlNodeId),
        },
        coveredControlNodeIds: [childControlNodeId],
      },
    };

    expect(controlNodeAttachmentRequestSchema.safeParse(request).success).toBe(true);
    expect(controlNodeAttachmentRequestSchema.safeParse({
      ...request,
      childProof: {
        ...request.childProof,
        coveredControlNodeIds: [childControlNodeId, childControlNodeId],
      },
    }).success).toBe(false);
    expect(controlNodeAttachmentRequestSchema.safeParse({
      ...request,
      childProof: {
        ...request.childProof,
        coveredControlNodeIds: [newControlNodeId()],
      },
    }).success).toBe(false);
  });
});

describe("protocol v4 source and stream fences", () => {
  it("accepts only exact, duplicate-free control-node coverage", () => {
    const sourceControlNodeId = newControlNodeId();
    const manifest = {
      componentKind: "control-node",
      protocolVersion: 5,
      sourceControlNodeId,
      sourceControlNodeBootId: newControlNodeBootId(),
      authority: authority(sourceControlNodeId),
      projectionRootControlNodeId: sourceControlNodeId,
      coveredControlNodeIds: [sourceControlNodeId],
      feedId: newFeedId(),
      controlCursor: 0,
      generatedAt: now,
      capabilities: [],
    };

    expect(sourceManifestSchema.safeParse(manifest).success).toBe(true);
    expect(
      sourceManifestSchema.safeParse({
        ...manifest,
        coveredControlNodeIds: [sourceControlNodeId, sourceControlNodeId],
      }).success,
    ).toBe(false);
    expect(
      sourceManifestSchema.safeParse({
        ...manifest,
        projectionRootControlNodeId: newControlNodeId(),
      }).success,
    ).toBe(false);
    expect(
      sourceCoverageSnapshotSchema.safeParse({
        manifest,
        parentByControlNodeId: { [sourceControlNodeId]: null },
      }).success,
    ).toBe(true);
    expect(
      sourceCoverageSnapshotSchema.safeParse({
        manifest,
        parentByControlNodeId: {
          [sourceControlNodeId]: null,
          [newControlNodeId()]: sourceControlNodeId,
        },
      }).success,
    ).toBe(false);
  });

  it("allows a gateway heartbeat to describe zero or many sorted realms", () => {
    const first = authority(newControlNodeId());
    const second = authority(newControlNodeId());
    const refs = [first, second].sort((left, right) =>
      `${left.realmId}\0${left.controlNodeId}\0${left.epochId}`.localeCompare(
        `${right.realmId}\0${right.controlNodeId}\0${right.epochId}`,
      ),
    );
    const base = {
      kind: "heartbeat",
      feedId: newFeedId(),
      controlCursor: 0,
    };

    expect(
      accessHeartbeatSchema.safeParse({ ...base, authorityRefs: [] }).success,
    ).toBe(true);
    expect(
      accessHeartbeatSchema.safeParse({ ...base, authorityRefs: refs }).success,
    ).toBe(true);
    expect(
      accessHeartbeatSchema.safeParse({
        ...base,
        authorityRefs: [refs[1], refs[0]],
      }).success,
    ).toBe(false);
  });

  it("requires every metadata proposal to carry its expected authority", () => {
    const value = {
      operationId: newOperationId(),
      sessionId: newSessionId(),
      expectedAuthority: authority(),
      set: { "agent.title": "test" },
    };

    expect(metadataPatchSchema.safeParse(value).success).toBe(true);
    const { expectedAuthority: _, ...unfenced } = value;
    expect(metadataPatchSchema.safeParse(unfenced).success).toBe(false);
  });

  it("enforces the same namespaced key/value schema for launch metadata", () => {
    const value = {
      launchId: "00000000-0000-4000-8000-000000000001",
      payloadHash: "launch-metadata-protocol-boundary",
      sessionId: newSessionId(),
      runtimeNodeId: "00000000-0000-4000-8000-000000000002",
      profile: {
        profileId: "direct",
        providerId: "core.direct",
        contractVersion: 1,
        requestSchemaHash: "a".repeat(64),
      },
      harness: "codex",
      input: { cwd: "/work/project" },
      metadata: { "agent.title": "valid" },
    };

    expect(launchRequestSchema.safeParse(value).success).toBe(true);
    expect(launchRequestSchema.safeParse({
      ...value,
      metadata: { title: "not namespaced" },
    }).success).toBe(false);
  });

  it("retains detached branch fencing material", () => {
    const childControlNodeId = newControlNodeId();
    const formerParentControlNodeId = newControlNodeId();
    expect(
      controlNodeDescriptorSchema.safeParse({
        controlNodeId: childControlNodeId,
        controlNodeBootId: newControlNodeBootId(),
        feedId: newFeedId(),
        name: "detached branch",
        presence: "offline",
        dataRole: {
          role: "branch",
          authority: authority(formerParentControlNodeId),
          branch: {
            lifecycle: "detached",
            formerParentControlNodeId,
            attachmentId: newAttachmentId(),
            lineageId: newLineageId(),
            attachedAt: now,
            detachedAt: now,
          },
        },
        connectedAt: null,
        lastHeartbeatAt: null,
        protocolVersion: 5,
        capabilities: [],
      }).success,
    ).toBe(true);
  });

  it("requires atomic access snapshots to exactly match advertised coverage", () => {
    const controlNodeId = newControlNodeId();
    const extraControlNodeId = newControlNodeId();
    const authorityRef = authority(controlNodeId);
    const descriptor = {
      controlNodeId,
      controlNodeBootId: newControlNodeBootId(),
      feedId: newFeedId(),
      name: "root",
      presence: "online" as const,
      dataRole: { role: "authority" as const, authority: authorityRef },
      connectedAt: now,
      lastHeartbeatAt: now,
      protocolVersion: 5 as const,
      capabilities: [],
    };
    const manifest = {
      componentKind: "control-node" as const,
      protocolVersion: 5 as const,
      sourceControlNodeId: controlNodeId,
      sourceControlNodeBootId: descriptor.controlNodeBootId,
      authority: authorityRef,
      projectionRootControlNodeId: controlNodeId,
      coveredControlNodeIds: [controlNodeId, extraControlNodeId],
      feedId: descriptor.feedId,
      controlCursor: 0,
      generatedAt: now,
      capabilities: [],
    };
    const value = {
      source: {
        manifest,
        parentByControlNodeId: {
          [controlNodeId]: null,
          [extraControlNodeId]: controlNodeId,
        },
      },
      capturedAt: now,
      controlNodes: [descriptor],
      runtimeNodes: [],
      sessions: [],
      interactions: [],
      metadataOperations: [],
    };
    expect(accessSnapshotSchema.safeParse(value).success).toBe(false);
    expect(
      accessSnapshotSchema.safeParse({
        ...value,
        source: {
          manifest: { ...manifest, coveredControlNodeIds: [controlNodeId] },
          parentByControlNodeId: { [controlNodeId]: null },
        },
      }).success,
    ).toBe(true);
    const complete = {
      ...value,
      source: {
        manifest: { ...manifest, coveredControlNodeIds: [controlNodeId] },
        parentByControlNodeId: { [controlNodeId]: null },
      },
    };
    expect(accessSnapshotSchema.safeParse({
      ...complete,
      source: {
        ...complete.source,
        manifest: {
          ...complete.source.manifest,
          sourceControlNodeBootId: newControlNodeBootId(),
        },
      },
    }).success).toBe(false);
    expect(accessSnapshotSchema.safeParse({
      ...complete,
      source: {
        ...complete.source,
        manifest: { ...complete.source.manifest, feedId: newFeedId() },
      },
    }).success).toBe(false);
  });

  it("rejects two logical sessions bound to one native session in a snapshot", () => {
    const controlNodeId = newControlNodeId();
    const runtimeNodeId = newRuntimeNodeId();
    const authorityRef = authority(controlNodeId);
    const controlNodeBootId = newControlNodeBootId();
    const feedId = newFeedId();
    const session = {
      sessionId: newSessionId(),
      runtimeNodeId,
      harness: "codex" as const,
      adapterScopeId: "codex-test",
      vendorSessionId: "native-session",
      bindingRevision: 1,
      runtimeEpoch: null,
      cwd: "/work",
      availability: "active" as const,
      runtimeStatus: "idle" as const,
      launchProvenance: null,
      metadata: { revision: 0, values: {}, keyRevisions: {} },
      metadataAuthority: authorityRef,
      catalogState: "open" as const,
      catalogRevision: 1,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      lastActivityAt: now,
    };
    const value = {
      source: {
        manifest: {
          componentKind: "control-node" as const,
          protocolVersion: 5 as const,
          sourceControlNodeId: controlNodeId,
          sourceControlNodeBootId: controlNodeBootId,
          authority: authorityRef,
          projectionRootControlNodeId: controlNodeId,
          coveredControlNodeIds: [controlNodeId],
          feedId,
          controlCursor: 0,
          generatedAt: now,
          capabilities: [],
        },
        parentByControlNodeId: { [controlNodeId]: null },
      },
      capturedAt: now,
      controlNodes: [{
        controlNodeId,
        controlNodeBootId,
        feedId,
        name: "root",
        presence: "online" as const,
        dataRole: { role: "authority" as const, authority: authorityRef },
        connectedAt: now,
        lastHeartbeatAt: now,
        protocolVersion: 5 as const,
        capabilities: [],
      }],
      runtimeNodes: [{
        runtimeNodeId,
        runtimeNodeBootId: newRuntimeNodeBootId(),
        ownerControlNodeId: controlNodeId,
        name: "runtime",
        presence: "online" as const,
        reachability: "reachable" as const,
        connectedAt: now,
        lastHeartbeatAt: now,
        allowedRoots: ["/work"],
        harnesses: [],
        launchProfiles: [],
        protocolVersion: 5 as const,
      }],
      sessions: [session, { ...session, sessionId: newSessionId() }],
      interactions: [],
      metadataOperations: [],
    };

    expect(accessSnapshotSchema.safeParse(value).success).toBe(false);
  });

  it("fences interaction records to their session binding", () => {
    const controlNodeId = newControlNodeId();
    const runtimeNodeId = newRuntimeNodeId();
    const authorityRef = authority(controlNodeId);
    const controlNodeBootId = newControlNodeBootId();
    const feedId = newFeedId();
    const sessionId = newSessionId();
    const base = {
      source: {
        manifest: {
          componentKind: "control-node" as const,
          protocolVersion: 5 as const,
          sourceControlNodeId: controlNodeId,
          sourceControlNodeBootId: controlNodeBootId,
          authority: authorityRef,
          projectionRootControlNodeId: controlNodeId,
          coveredControlNodeIds: [controlNodeId],
          feedId,
          controlCursor: 0,
          generatedAt: now,
          capabilities: [],
        },
        parentByControlNodeId: { [controlNodeId]: null },
      },
      capturedAt: now,
      controlNodes: [{
        controlNodeId,
        controlNodeBootId,
        feedId,
        name: "root",
        presence: "online" as const,
        dataRole: { role: "authority" as const, authority: authorityRef },
        connectedAt: now,
        lastHeartbeatAt: now,
        protocolVersion: 5 as const,
        capabilities: [],
      }],
      runtimeNodes: [{
        runtimeNodeId,
        runtimeNodeBootId: newRuntimeNodeBootId(),
        ownerControlNodeId: controlNodeId,
        name: "runtime",
        presence: "online" as const,
        reachability: "reachable" as const,
        connectedAt: now,
        lastHeartbeatAt: now,
        allowedRoots: ["/work"],
        harnesses: [],
        launchProfiles: [],
        protocolVersion: 5 as const,
      }],
      sessions: [{
        sessionId,
        runtimeNodeId,
        harness: "codex" as const,
        adapterScopeId: "codex-test",
        vendorSessionId: "native-session",
        bindingRevision: 1,
        runtimeEpoch: null,
        cwd: "/work",
        availability: "active" as const,
        runtimeStatus: "idle" as const,
        launchProvenance: null,
        metadata: { revision: 0, values: {}, keyRevisions: {} },
        metadataAuthority: authorityRef,
        catalogState: "open" as const,
        catalogRevision: 1,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        lastActivityAt: now,
      }],
      interactions: [],
      metadataOperations: [],
    };
    expect(accessSnapshotSchema.safeParse({
      ...base,
      interactions: [{
        interactionId: newSessionId(),
        sessionId,
        harness: "copilot",
        runtimeEpoch: newSessionId(),
        requestType: "other" as const,
        payload: {},
        ephemeral: false,
        state: "pending" as const,
        createdAt: now,
        expiresAt: null,
        resolvedAt: null,
      }],
    }).success).toBe(false);
  });
});
