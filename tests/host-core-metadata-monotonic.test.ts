import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emptyMetadataSnapshot,
  newFeedId,
  newHostBootId,
  newHostId,
  newOperationId,
  newRuntimeEpoch,
  newSessionId,
  newWorkerBootId,
  newWorkerId,
  type HostAttachmentRequest,
  type MetadataOperationRecord,
  type SessionRecord,
  type WorkerDescriptor,
} from "@agent-multiplex/protocol";
import { HostCatalog, HostCoreError, HostService } from "@agent-multiplex/host-core";
import { describe, expect, it } from "vitest";

const timestamp = (): string => new Date().toISOString();

describe("nested metadata monotonicity", () => {
  it("does not let stale child snapshots or live controls roll back canonical metadata receipts", () => {
    const catalog = new HostCatalog({ filename: ":memory:", hostName: "metadata-root" });
    const request: HostAttachmentRequest = {
      hostId: newHostId(),
      hostBootId: newHostBootId(),
      feedId: newFeedId(),
      name: "metadata-child",
      endpointId: "metadata-child-endpoint",
      protocolVersion: 2,
      capabilities: ["topology.nested-hosts"],
    };
    const { attachment, child } = catalog.attachChild(request);
    const worker: WorkerDescriptor = {
      workerId: newWorkerId(),
      workerBootId: newWorkerBootId(),
      ownerHostId: child.hostId,
      name: "metadata-worker",
      presence: "online",
      reachability: "reachable",
      connectedAt: timestamp(),
      lastHeartbeatAt: timestamp(),
      allowedRoots: ["/work"],
      harnesses: [],
      protocolVersion: 2,
    };
    const staleSession: SessionRecord = {
      sessionId: newSessionId(),
      workerId: worker.workerId,
      harness: "codex",
      adapterScopeId: "codex-metadata" as SessionRecord["adapterScopeId"],
      vendorSessionId: "metadata-native-session",
      bindingRevision: 1,
      runtimeEpoch: newRuntimeEpoch(),
      cwd: "/work/project",
      availability: "active",
      runtimeStatus: "idle",
      metadata: emptyMetadataSnapshot(),
      metadataAuthority: {
        hostId: child.hostId,
        epochId: child.authorityEpochId,
      },
      createdAt: timestamp(),
      updatedAt: timestamp(),
      lastSeenAt: timestamp(),
    };
    catalog.importChildSnapshotPage(child.hostId, attachment.attachmentId, {
      rootHostId: child.hostId,
      attachmentId: attachment.attachmentId,
      lineageId: attachment.lineageId,
      checkpoint: { feedId: request.feedId, controlCursor: 0 },
      capturedAt: timestamp(),
      hosts: [child],
      workers: [worker],
      sessions: [staleSession],
      interactions: [],
      metadataOperations: [],
      nextPageToken: null,
    });

    // The root remains the metadata authority while the reverse link is down.
    // Canonical writes made in this window must survive the child's stale
    // pre-settlement state when that link reconnects.
    expect(catalog.markChildDisconnected(child.hostId, child.hostBootId)).toBe(true);

    const authorityEpochId = catalog.localHost().authorityEpochId;
    const acceptedQueued: MetadataOperationRecord = {
      operationId: newOperationId(),
      sessionId: staleSession.sessionId,
      patch: {
        operationId: newOperationId(),
        sessionId: staleSession.sessionId,
        set: { "agent.title": "canonical" },
      },
      status: "queued",
      canonical: emptyMetadataSnapshot(),
      originHostId: child.hostId,
      authorityEpochId,
      createdAt: timestamp(),
      updatedAt: timestamp(),
    };
    acceptedQueued.patch.operationId = acceptedQueued.operationId;
    catalog.recordQueuedMetadataOperation(acceptedQueued);
    const accepted = catalog.applyMetadataOperationAtAuthority(acceptedQueued);
    expect(accepted.status).toBe("accepted");
    expect(accepted.canonical.revision).toBe(1);

    const conflictedQueued: MetadataOperationRecord = {
      operationId: newOperationId(),
      sessionId: staleSession.sessionId,
      patch: {
        operationId: newOperationId(),
        sessionId: staleSession.sessionId,
        set: { "dashboard.note": "must conflict" },
        ifKeyRevision: { "agent.title": null },
      },
      status: "queued",
      canonical: emptyMetadataSnapshot(),
      originHostId: child.hostId,
      authorityEpochId,
      createdAt: timestamp(),
      updatedAt: timestamp(),
    };
    conflictedQueued.patch.operationId = conflictedQueued.operationId;
    catalog.recordQueuedMetadataOperation(conflictedQueued);
    const conflicted = catalog.applyMetadataOperationAtAuthority(conflictedQueued);
    expect(conflicted.status).toBe("conflicted");
    expect(conflicted.canonical.revision).toBe(1);

    // Reattaching the same boot/feed/lineage is an ordinary reconnect, not a
    // new metadata-authority epoch.
    const reconnect = catalog.attachChild({
      ...request,
      previousAttachmentId: attachment.attachmentId,
      previousLineageId: attachment.lineageId,
    });
    expect(reconnect.reconnected).toBe(true);
    expect(reconnect.attachment).toEqual(attachment);

    // The reconnect presents the child's pre-settlement session and queued
    // ledgers. Neither is allowed to replace the root's durable terminal state.
    catalog.importChildSnapshotPage(child.hostId, attachment.attachmentId, {
      rootHostId: child.hostId,
      attachmentId: attachment.attachmentId,
      lineageId: attachment.lineageId,
      checkpoint: { feedId: request.feedId, controlCursor: 0 },
      capturedAt: timestamp(),
      hosts: [catalog.getHost(child.hostId)!],
      workers: [worker],
      sessions: [staleSession],
      interactions: [],
      metadataOperations: [acceptedQueued, conflictedQueued],
      nextPageToken: null,
    });
    expect(catalog.getMetadata(staleSession.sessionId)).toEqual(accepted.canonical);
    expect(catalog.getMetadataOperation(accepted.operationId)).toEqual(accepted);
    expect(catalog.getMetadataOperation(conflicted.operationId)).toEqual(conflicted);

    // A lower revision is a harmless stale replay and advances the feed. The
    // same revision with different contents is corruption and is rejected
    // atomically, leaving both the canonical value and checkpoint intact.
    const staleMetadataImport = catalog.importChildControl(child.hostId, attachment.attachmentId, {
      kind: "control",
      eventId: randomUUID(),
      originHostId: child.hostId,
      feedId: request.feedId,
      cursor: 1,
      change: {
        type: "metadata.changed",
        sessionId: staleSession.sessionId,
        metadata: emptyMetadataSnapshot(),
      },
    });
    expect(catalog.childCheckpoint(child.hostId)?.controlCursor).toBe(1);
    expect(
      catalog.controlEventsAfter(staleMetadataImport.localCursor - 1, {
        through: staleMetadataImport.localCursor,
      })[0]?.change,
    ).toEqual({
      type: "metadata.changed",
      sessionId: staleSession.sessionId,
      metadata: accepted.canonical,
    });
    const staleSessionImport = catalog.importChildControl(child.hostId, attachment.attachmentId, {
      kind: "control",
      eventId: randomUUID(),
      originHostId: child.hostId,
      feedId: request.feedId,
      cursor: 2,
      change: {
        type: "session.upsert",
        session: { ...staleSession, runtimeStatus: "running", updatedAt: timestamp() },
      },
    });
    expect(catalog.getSession(staleSession.sessionId)).toMatchObject({
      runtimeStatus: "running",
      metadata: accepted.canonical,
    });
    expect(
      catalog.controlEventsAfter(staleSessionImport.localCursor - 1, {
        through: staleSessionImport.localCursor,
      })[0]?.change,
    ).toMatchObject({
      type: "session.upsert",
      session: { metadata: accepted.canonical },
    });
    const staleOperationImport = catalog.importChildControl(child.hostId, attachment.attachmentId, {
      kind: "control",
      eventId: randomUUID(),
      originHostId: child.hostId,
      feedId: request.feedId,
      cursor: 3,
      change: { type: "metadata.operation", operation: acceptedQueued },
    });
    expect(catalog.getMetadataOperation(accepted.operationId)).toEqual(accepted);
    expect(
      catalog.controlEventsAfter(staleOperationImport.localCursor - 1, {
        through: staleOperationImport.localCursor,
      })[0]?.change,
    ).toEqual({ type: "metadata.operation", operation: accepted });

    // An equal revision carrying the canonical value may still update native
    // session state without affecting metadata.
    catalog.importChildControl(child.hostId, attachment.attachmentId, {
      kind: "control",
      eventId: randomUUID(),
      originHostId: child.hostId,
      feedId: request.feedId,
      cursor: 4,
      change: {
        type: "session.upsert",
        session: {
          ...staleSession,
          runtimeStatus: "idle",
          metadata: accepted.canonical,
          updatedAt: timestamp(),
        },
      },
    });
    expect(catalog.getSession(staleSession.sessionId)).toMatchObject({
      runtimeStatus: "idle",
      metadata: accepted.canonical,
    });

    // Equal revisions are immutable: a divergent child copy is rejected and
    // the entire imported control (including its checkpoint) rolls back.
    expect(() =>
      catalog.importChildControl(child.hostId, attachment.attachmentId, {
        kind: "control",
        eventId: randomUUID(),
        originHostId: child.hostId,
        feedId: request.feedId,
        cursor: 5,
        change: {
          type: "session.upsert",
          session: {
            ...staleSession,
            metadata: {
              revision: 1,
              values: { "agent.title": "divergent" },
              keyRevisions: { "agent.title": 1 },
            },
            updatedAt: timestamp(),
          },
        },
      }),
    ).toThrowError(HostCoreError);
    expect(catalog.childCheckpoint(child.hostId)?.controlCursor).toBe(4);
    expect(catalog.getMetadata(staleSession.sessionId)).toEqual(accepted.canonical);
    expect(catalog.getMetadataOperation(accepted.operationId)).toEqual(accepted);
    expect(catalog.getMetadataOperation(conflicted.operationId)).toEqual(conflicted);

    catalog.close();
  });

  it("recovers a missing downstream settlement row and queues while its child is detached", () => {
    const filename = join(
      mkdtempSync(join(tmpdir(), "agent-multiplex-metadata-recovery-")),
      "host.sqlite",
    );
    const first = new HostCatalog({ filename, hostName: "durable-metadata-root" });
    const request: HostAttachmentRequest = {
      hostId: newHostId(),
      hostBootId: newHostBootId(),
      feedId: newFeedId(),
      name: "durable-metadata-child",
      endpointId: "durable-metadata-child-endpoint",
      protocolVersion: 2,
      capabilities: ["topology.nested-hosts"],
    };
    const { attachment, child } = first.attachChild(request);
    const worker: WorkerDescriptor = {
      workerId: newWorkerId(),
      workerBootId: newWorkerBootId(),
      ownerHostId: child.hostId,
      name: "durable-metadata-worker",
      presence: "online",
      reachability: "reachable",
      connectedAt: timestamp(),
      lastHeartbeatAt: timestamp(),
      allowedRoots: ["/work"],
      harnesses: [],
      protocolVersion: 2,
    };
    const session: SessionRecord = {
      sessionId: newSessionId(),
      workerId: worker.workerId,
      harness: "codex",
      adapterScopeId: "codex-durable" as SessionRecord["adapterScopeId"],
      vendorSessionId: "durable-native-session",
      bindingRevision: 1,
      runtimeEpoch: newRuntimeEpoch(),
      cwd: "/work/project",
      availability: "active",
      runtimeStatus: "idle",
      metadata: emptyMetadataSnapshot(),
      metadataAuthority: {
        hostId: child.hostId,
        epochId: child.authorityEpochId,
      },
      createdAt: timestamp(),
      updatedAt: timestamp(),
      lastSeenAt: timestamp(),
    };
    first.importChildSnapshotPage(child.hostId, attachment.attachmentId, {
      rootHostId: child.hostId,
      attachmentId: attachment.attachmentId,
      lineageId: attachment.lineageId,
      checkpoint: { feedId: request.feedId, controlCursor: 0 },
      capturedAt: timestamp(),
      hosts: [child],
      workers: [worker],
      sessions: [session],
      interactions: [],
      metadataOperations: [],
      nextPageToken: null,
    });
    const operation = first.submitMetadataPatch({
      operationId: newOperationId(),
      sessionId: session.sessionId,
      set: { "agent.title": "committed before queueing" },
    });
    expect(operation.status).toBe("accepted");
    expect(first.pendingMetadataReplication(child.hostId)).toEqual([]);
    first.close();

    const reopened = new HostCatalog({ filename, hostName: "durable-metadata-root" });
    expect(reopened.pendingMetadataReplication(child.hostId)).toMatchObject([
      { operationId: operation.operationId, status: "accepted" },
    ]);
    reopened.markMetadataReplicationDelivered(child.hostId, operation.operationId);
    reopened.enqueueMetadataReplication(child.hostId, operation);
    expect(reopened.pendingMetadataReplication(child.hostId)).toEqual([]);
    expect(reopened.detachChild(child.hostId, attachment.attachmentId)).toBe(true);
    const service = new HostService({ catalog: reopened, instanceId: "durable-metadata-root" });
    const whileDetached = service.patchMetadata({
      operationId: newOperationId(),
      sessionId: session.sessionId,
      set: { "dashboard.note": "deliver after reconnect" },
    });
    expect(whileDetached.status).toBe("accepted");
    expect(reopened.pendingMetadataReplication(child.hostId)).toContainEqual(whileDetached);

    service.close();
    reopened.close();
  });
});
