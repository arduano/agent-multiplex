import { describe, expect, it } from "vitest";

import {
  accessContract,
  archiveRecordSchema,
  controlChangeSchema,
  gatewayEnrollmentSchema,
  launchIdSchema,
  launchMetadataOperationId,
  launchProfileDescriptorSchema,
  launchListInputSchema,
  launchRecordSchema,
  newArchiveOperationId,
  newAuthorityEpochId,
  newControlNodeId,
  newLaunchId,
  newRealmId,
  newRuntimeNodeId,
  newSessionId,
  runtimeNodeControlChangeSchema,
  runtimeNodeSessionRecordSchema,
  resumeCommandSchema,
  sessionRecordSchema,
  sessionSearchInputSchema,
  stopCommandSchema,
  systemDescriptionSchema,
} from "../src/index.js";

const now = "2026-09-04T00:00:00.000+00:00";
const later = "2026-09-04T00:01:00.000+00:00";

function authority() {
  return {
    realmId: newRealmId(),
    controlNodeId: newControlNodeId(),
    epochId: newAuthorityEpochId(),
  };
}

function profile() {
  return {
    profileId: "review.container",
    providerId: "example.container",
    contractVersion: 1,
    requestSchemaHash: "a".repeat(64),
  };
}

function launchRequest() {
  return {
    launchId: newLaunchId(),
    payloadHash: "0123456789abcdef",
    sessionId: newSessionId(),
    runtimeNodeId: newRuntimeNodeId(),
    profile: profile(),
    harness: "codex" as const,
    input: { pullRequestUrl: "https://example.test/org/repo/pull/42" },
    metadata: { "review.pull_request": 42 },
  };
}

function acceptedLaunch() {
  return {
    ...launchRequest(),
    implementationVersion: "1.0.0",
    state: "accepted" as const,
    createdAt: now,
    updatedAt: now,
  };
}

function canonicalSession() {
  return {
    sessionId: newSessionId(),
    runtimeNodeId: newRuntimeNodeId(),
    harness: "codex" as const,
    adapterScopeId: "codex-test",
    vendorSessionId: "native-session",
    bindingRevision: 1,
    runtimeEpoch: null,
    cwd: "/work",
    availability: "resumable" as const,
    runtimeStatus: "stopped" as const,
    launchProvenance: null,
    metadata: { revision: 0, values: {}, keyRevisions: {} },
    metadataAuthority: authority(),
    catalogState: "open" as const,
    catalogRevision: 1,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    lastActivityAt: now,
  };
}

describe("protocol v4 launch profiles and records", () => {
  it("derives launch metadata operations in a fixed UUIDv5 namespace", () => {
    const first = launchIdSchema.parse("00000000-0000-4000-8000-000000000001");
    const second = launchIdSchema.parse("00000000-0000-4000-8000-000000000002");

    expect(launchMetadataOperationId(first))
      .toBe("f881e7c5-c185-51fd-ba2e-b1f0da243e98");
    expect(launchMetadataOperationId(first)).not.toBe(first);
    expect(launchMetadataOperationId(second)).not.toBe(launchMetadataOperationId(first));
  });

  it("durably distinguishes resume from stop commands", () => {
    const common = {
      commandId: newLaunchId(),
      payloadHash: "0123456789abcdef",
      sessionId: newSessionId(),
      runtimeNodeId: newRuntimeNodeId(),
      bindingRevision: 1,
    };
    expect(resumeCommandSchema.parse({ operation: "resume", ...common }).operation)
      .toBe("resume");
    expect(stopCommandSchema.parse({ operation: "stop", ...common }).operation)
      .toBe("stop");
    expect(resumeCommandSchema.safeParse({ operation: "stop", ...common }).success)
      .toBe(false);
  });

  it("uses an exact lowercase schema-hash compatibility fence", () => {
    const descriptor = {
      ...profile(),
      implementationVersion: "1.0.0",
      harnesses: ["codex"],
      available: true,
      capabilities: [],
    };

    expect(launchProfileDescriptorSchema.safeParse(descriptor).success).toBe(true);
    for (const implementationVersion of [" 1.0.0", "1.0.0\n", "x".repeat(257)]) {
      expect(launchProfileDescriptorSchema.safeParse({
        ...descriptor,
        implementationVersion,
      }).success).toBe(false);
    }
    expect(
      launchProfileDescriptorSchema.safeParse({
        ...descriptor,
        requestSchemaHash: "A".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      launchProfileDescriptorSchema.safeParse({
        ...descriptor,
        available: false,
      }).success,
    ).toBe(false);
    expect(
      launchProfileDescriptorSchema.safeParse({
        ...descriptor,
        unavailableReason: "not applicable while available",
      }).success,
    ).toBe(false);
    expect(
      launchProfileDescriptorSchema.safeParse({
        ...descriptor,
        available: false,
        unavailableReason: "container runtime is offline",
      }).success,
    ).toBe(true);
  });

  it("locks launch results and errors to the appropriate states", () => {
    const accepted = acceptedLaunch();
    const result = {
      sessionId: accepted.sessionId,
      adapterScopeId: "codex-test",
      vendorSessionId: "native-session",
      backendId: "container-42",
      bindingRevision: 1,
    };

    expect(launchRecordSchema.safeParse(accepted).success).toBe(true);
    expect(
      launchRecordSchema.safeParse({
        ...accepted,
        state: "succeeded",
        result,
        updatedAt: later,
      }).success,
    ).toBe(true);
    expect(
      launchRecordSchema.safeParse({ ...accepted, state: "succeeded" }).success,
    ).toBe(false);
    expect(
      launchRecordSchema.safeParse({
        ...accepted,
        state: "succeeded",
        result: { ...result, sessionId: newSessionId() },
      }).success,
    ).toBe(false);
    expect(
      launchRecordSchema.safeParse({ ...accepted, state: "failed" }).success,
    ).toBe(false);
    expect(
      launchRecordSchema.safeParse({
        ...accepted,
        state: "failed",
        error: "clone failed",
      }).success,
    ).toBe(true);
    expect(
      launchRecordSchema.safeParse({
        ...accepted,
        state: "preparing",
        error: "premature terminal error",
      }).success,
    ).toBe(false);
    expect(
      launchRecordSchema.safeParse({
        ...accepted,
        state: "outcomeUnknown",
        result,
        error: "lost contact after native start",
      }).success,
    ).toBe(false);
  });

  it("bounds launch-operation discovery", () => {
    expect(launchListInputSchema.parse({})).toMatchObject({ limit: 100 });
    expect(
      launchListInputSchema.safeParse({
        states: ["preparing", "outcomeUnknown"],
        limit: 500,
      }).success,
    ).toBe(true);
    expect(launchListInputSchema.safeParse({ limit: 501 }).success).toBe(false);
    expect(
      launchListInputSchema.safeParse({ states: ["accepted", "accepted"] })
        .success,
    ).toBe(false);
  });
});

describe("protocol v4 archive and catalog lifecycle", () => {
  it("fences archive records and makes release/catalog results terminal-only", () => {
    const expectedAuthority = authority();
    const accepted = {
      archiveOperationId: newArchiveOperationId(),
      payloadHash: "0123456789abcdef",
      sessionId: newSessionId(),
      runtimeNodeId: newRuntimeNodeId(),
      bindingRevision: 1,
      expectedAuthority,
      authority: expectedAuthority,
      state: "accepted" as const,
      releasedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    expect(archiveRecordSchema.safeParse(accepted).success).toBe(true);
    expect(
      archiveRecordSchema.safeParse({
        ...accepted,
        authority: authority(),
      }).success,
    ).toBe(false);
    expect(
      archiveRecordSchema.safeParse({
        ...accepted,
        state: "succeeded",
        releasedAt: later,
        catalogRevision: 2,
        updatedAt: later,
      }).success,
    ).toBe(true);
    expect(
      archiveRecordSchema.safeParse({
        ...accepted,
        state: "succeeded",
        releasedAt: later,
      }).success,
    ).toBe(false);
    expect(
      archiveRecordSchema.safeParse({
        ...accepted,
        state: "releasing",
        releasedAt: later,
        catalogRevision: 2,
      }).success,
    ).toBe(false);
    expect(
      archiveRecordSchema.safeParse({
        ...accepted,
        state: "failed",
      }).success,
    ).toBe(false);
    expect(
      archiveRecordSchema.safeParse({
        ...accepted,
        state: "failed",
        error: "release failed",
      }).success,
    ).toBe(true);
  });

  it("keeps open, archived, and runtime-originated session fields separate", () => {
    const open = canonicalSession();
    expect(sessionRecordSchema.safeParse(open).success).toBe(true);
    expect(
      sessionRecordSchema.safeParse({
        ...open,
        catalogState: "archived",
        archivedAt: later,
        availability: "active",
      }).success,
    ).toBe(false);
    expect(
      sessionRecordSchema.safeParse({
        ...open,
        catalogState: "archived",
        archivedAt: later,
      }).success,
    ).toBe(true);
    expect(
      sessionRecordSchema.safeParse({
        ...open,
        catalogState: "open",
        archivedAt: later,
      }).success,
    ).toBe(false);

    const { catalogState: _, catalogRevision: __, archivedAt: ___, ...runtime } =
      open;
    expect(runtimeNodeSessionRecordSchema.safeParse(runtime).success).toBe(true);
    expect(runtimeNodeSessionRecordSchema.safeParse(open).success).toBe(false);
  });
});

describe("protocol v4 session search and streams", () => {
  it("defaults to the bounded open catalog and validates metadata/activity filters", () => {
    expect(sessionSearchInputSchema.parse({})).toMatchObject({
      states: ["running", "stopped"],
      metadata: [],
      limit: 100,
    });
    expect(
      sessionSearchInputSchema.safeParse({
        states: ["archived"],
        metadata: [
          { operator: "exists", key: "review.pull_request" },
          { operator: "equals", key: "review.status", value: "pending" },
        ],
        lastActivityAfter: now,
        lastActivityBefore: later,
        limit: 500,
      }).success,
    ).toBe(true);
    expect(sessionSearchInputSchema.safeParse({ limit: 501 }).success).toBe(false);
    expect(
      sessionSearchInputSchema.safeParse({
        metadata: Array.from({ length: 33 }, (_, index) => ({
          operator: "exists",
          key: `review.key_${index}`,
        })),
      }).success,
    ).toBe(false);
    expect(
      sessionSearchInputSchema.safeParse({ states: ["running", "running"] }).success,
    ).toBe(false);
    expect(
      sessionSearchInputSchema.safeParse({
        metadata: [{ operator: "exists", key: "not_namespaced" }],
      }).success,
    ).toBe(false);
    expect(
      sessionSearchInputSchema.safeParse({
        lastActivityAfter: later,
        lastActivityBefore: now,
      }).success,
    ).toBe(false);
  });

  it("carries launch and archive transitions on both stream layers", () => {
    const launch = acceptedLaunch();
    const expectedAuthority = authority();
    const archive = {
      archiveOperationId: newArchiveOperationId(),
      payloadHash: "0123456789abcdef",
      sessionId: launch.sessionId,
      runtimeNodeId: launch.runtimeNodeId,
      bindingRevision: 1,
      expectedAuthority,
      authority: expectedAuthority,
      state: "accepted" as const,
      releasedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    expect(
      controlChangeSchema.safeParse({ type: "launch.changed", launch }).success,
    ).toBe(true);
    expect(
      runtimeNodeControlChangeSchema.safeParse({
        type: "launch.changed",
        launch,
      }).success,
    ).toBe(true);
    expect(
      controlChangeSchema.safeParse({ type: "archive.changed", archive }).success,
    ).toBe(true);
    expect(
      runtimeNodeControlChangeSchema.safeParse({
        type: "archive.changed",
        archive,
      }).success,
    ).toBe(true);
  });
});

describe("protocol v4 compatibility boundary", () => {
  it("rejects v3 peers and contains no sessions.spawn contract", () => {
    const description = {
      application: "agent-multiplex",
      componentKind: "access-gateway",
      dataAuthority: "none",
      instanceId: "gateway",
      capabilities: [],
    };
    expect(
      systemDescriptionSchema.safeParse({ ...description, protocolVersion: 5 })
        .success,
    ).toBe(true);
    expect(
      systemDescriptionSchema.safeParse({ ...description, protocolVersion: 3 })
        .success,
    ).toBe(false);
    expect(
      gatewayEnrollmentSchema.safeParse({
        name: "gateway",
        protocolVersion: 5,
        requestedScopes: ["read", "agent-launch"],
      }).success,
    ).toBe(true);
    expect(
      gatewayEnrollmentSchema.safeParse({
        name: "gateway",
        protocolVersion: 3,
      }).success,
    ).toBe(false);
    expect("spawn" in accessContract.sessions).toBe(false);
    expect("list" in accessContract.sessions).toBe(false);
    expect("search" in accessContract.sessions).toBe(true);
    expect("list" in accessContract.launches).toBe(true);
    expect("watch" in accessContract.launches).toBe(true);
    expect("watch" in accessContract.archives).toBe(true);
  });
});
