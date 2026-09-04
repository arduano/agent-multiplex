import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emptyMetadataSnapshot,
  newAttachmentId,
  newAuthorityEpochId,
  newFeedId,
  newHostBootId,
  newHostId,
  newLineageId,
  newOperationId,
  newRuntimeEpoch,
  newSessionId,
  newWorkerBootId,
  newWorkerId,
  type HostAttachment,
  type HostAttachmentRequest,
  type HostDescriptor,
  type InventorySnapshot,
  type MetadataOperationRecord,
  type SessionRecord,
  type WorkerDescriptor,
  type WorkerRegistration,
} from "@agent-multiplex/protocol";
import { HostCatalog, HostCoreError } from "@agent-multiplex/host-core";
import { describe, expect, it } from "vitest";

const directWorker = (): WorkerRegistration => ({
  workerId: newWorkerId(),
  workerBootId: newWorkerBootId(),
  name: "direct-worker",
  allowedRoots: ["/work"],
  harnesses: [],
  protocolVersion: 2,
});

const directInventory = (
  worker: WorkerRegistration,
  vendorSessionId = "native-session",
): InventorySnapshot => ({
  workerId: worker.workerId,
  generation: randomUUID(),
  complete: true,
  capturedAt: new Date().toISOString(),
  sessions: [
    {
      harness: "codex",
      adapterScopeId: "codex-default" as InventorySnapshot["sessions"][number]["adapterScopeId"],
      vendorSessionId,
      cwd: "/work/project",
      availability: "active",
      runtimeStatus: "idle",
      runtimeEpoch: newRuntimeEpoch(),
      lastActivityAt: new Date().toISOString(),
    },
  ],
});

const childRequest = (): HostAttachmentRequest => ({
  hostId: newHostId(),
  hostBootId: newHostBootId(),
  feedId: newFeedId(),
  name: "child-host",
  endpointId: "child-endpoint",
  protocolVersion: 2,
  capabilities: ["topology.nested-hosts"],
});

describe("HostCatalog nested topology", () => {
  it("only lets a worker's direct host expire its heartbeat", () => {
    let now = new Date("2030-01-01T00:00:00.000Z");
    const catalog = new HostCatalog({
      filename: ":memory:",
      hostName: "staleness-root",
      now: () => now,
    });
    const localWorker = directWorker();
    catalog.registerWorker(localWorker);
    now = new Date("2030-01-01T00:01:00.000Z");

    const request = childRequest();
    const { attachment, child } = catalog.attachChild(request);
    const descendantWorker: WorkerDescriptor = {
      workerId: newWorkerId(),
      workerBootId: newWorkerBootId(),
      ownerHostId: child.hostId,
      name: "descendant-worker",
      presence: "online",
      reachability: "reachable",
      connectedAt: "2030-01-01T00:00:00.000Z",
      lastHeartbeatAt: "2030-01-01T00:00:00.000Z",
      allowedRoots: ["/work"],
      harnesses: [],
      protocolVersion: 2,
    };
    catalog.importChildSnapshotPage(child.hostId, attachment.attachmentId, {
      rootHostId: child.hostId,
      attachmentId: attachment.attachmentId,
      lineageId: attachment.lineageId,
      checkpoint: { feedId: request.feedId, controlCursor: 0 },
      capturedAt: now.toISOString(),
      hosts: [child],
      workers: [descendantWorker],
      sessions: [],
      interactions: [],
      metadataOperations: [],
      nextPageToken: null,
    });

    expect(catalog.markStaleWorkers(new Date("2030-01-01T00:00:30.000Z"))).toEqual([
      localWorker.workerId,
    ]);
    expect(catalog.getWorker(localWorker.workerId)?.presence).toBe("stale");
    expect(catalog.getWorker(descendantWorker.workerId)?.presence).toBe("online");
    expect(catalog.getWorker(descendantWorker.workerId)?.reachability).toBe("reachable");
    catalog.close();
  });

  it("persists stable host/feed identity while rotating the process boot ID", () => {
    const filename = join(mkdtempSync(join(tmpdir(), "agent-multiplex-topology-")), "host.sqlite");
    const first = new HostCatalog({ filename, hostName: "root-host" });
    const firstHost = first.localHost();
    const worker = directWorker();
    first.registerWorker(worker);
    const [session] = first.reconcileInventory(directInventory(worker));
    expect(first.getWorker(worker.workerId)).toMatchObject({
      ownerHostId: firstHost.hostId,
      reachability: "reachable",
      protocolVersion: 2,
    });
    expect(session?.metadataAuthority).toEqual({
      hostId: firstHost.hostId,
      epochId: firstHost.authorityEpochId,
    });
    first.close();

    const reopened = new HostCatalog({ filename, hostName: "root-host" });
    expect(reopened.localHost()).toMatchObject({
      hostId: firstHost.hostId,
      feedId: firstHost.feedId,
      lineageId: firstHost.lineageId,
      authorityEpochId: firstHost.authorityEpochId,
    });
    expect(reopened.localHost().hostBootId).not.toBe(firstHost.hostBootId);
    expect(reopened.getWorker(worker.workerId)?.reachability).toBe("stale");
    reopened.close();
  });

  it("treats detached child and replaced parent enrollment rows as inactive", () => {
    const catalog = new HostCatalog({ filename: ":memory:", hostName: "enrollment-host" });
    const request = childRequest();
    const attached = catalog.attachChild(request);
    catalog.enrollPeer(request.endpointId!, "childHost", request.hostId);
    expect(catalog.activePeerEnrollment(request.endpointId!)).toEqual({
      role: "childHost",
      principalId: request.hostId,
    });
    expect(catalog.detachChild(request.hostId, attached.attachment.attachmentId)).toBe(true);
    expect(catalog.peerEnrollment(request.endpointId!)).not.toBeNull();
    expect(catalog.activePeerEnrollment(request.endpointId!)).toBeNull();

    const local = catalog.localHost();
    const firstParent = newHostId();
    catalog.applyParentAttachment({
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
      parentHostId: firstParent,
      childHostId: local.hostId,
      rootHostId: firstParent,
      authorityHostId: firstParent,
      authorityEpochId: newAuthorityEpochId(),
      attachedAt: new Date().toISOString(),
    });
    catalog.enrollPeer("first-parent-endpoint", "parentHost", firstParent);
    expect(catalog.activePeerEnrollment("first-parent-endpoint")).toEqual({
      role: "parentHost",
      principalId: firstParent,
    });

    const destinationEpoch = newAuthorityEpochId();
    catalog.forceAdoptAuthority({
      subtreeRootHostId: local.hostId,
      previousRootHostId: firstParent,
      previousAuthorityHostId: firstParent,
      previousAuthorityEpochId: catalog.localHost().authorityEpochId,
      destinationRootHostId: local.hostId,
      destinationAuthorityHostId: local.hostId,
      destinationHostBootId: local.hostBootId,
      destinationAuthorityEpochId: destinationEpoch,
      audit: {
        actorId: "authenticated-operator",
        reason: "test promotion after replacing the configured parent",
        evidence: ["unit-test"],
        acknowledgedSplitBrainRisk: true,
        requestedAt: new Date().toISOString(),
      },
    });
    expect(catalog.peerEnrollment("first-parent-endpoint")).not.toBeNull();
    expect(catalog.activePeerEnrollment("first-parent-endpoint")).toBeNull();
    catalog.close();
  });

  it("rejects a parent attachment that points back into the local subtree", () => {
    const catalog = new HostCatalog({ filename: ":memory:", hostName: "local-host" });
    const local = catalog.localHost();
    const { child } = catalog.attachChild(childRequest());

    expect(() =>
      catalog.applyParentAttachment({
        attachmentId: newAttachmentId(),
        lineageId: newLineageId(),
        parentHostId: child.hostId,
        childHostId: local.hostId,
        rootHostId: child.hostId,
        authorityHostId: child.hostId,
        authorityEpochId: newAuthorityEpochId(),
        attachedAt: new Date().toISOString(),
      }),
    ).toThrowError(HostCoreError);
    expect(catalog.localHost()).toMatchObject({
      hostId: local.hostId,
      parentHostId: null,
      rootHostId: local.hostId,
      attachmentId: null,
    });
    expect(catalog.getHost(child.hostId)?.parentHostId).toBe(local.hostId);
    catalog.close();
  });

  it("enforces topology cycles and maximum depth on live child controls", () => {
    const catalog = new HostCatalog({
      filename: ":memory:",
      hostName: "root-host",
      maxHostDepth: 2,
    });
    const request = childRequest();
    const { attachment, child } = catalog.attachChild(request);
    catalog.importChildSnapshotPage(child.hostId, attachment.attachmentId, {
      rootHostId: child.hostId,
      attachmentId: attachment.attachmentId,
      lineageId: attachment.lineageId,
      checkpoint: { feedId: request.feedId, controlCursor: 0 },
      capturedAt: new Date().toISOString(),
      hosts: [child],
      workers: [],
      sessions: [],
      interactions: [],
      metadataOperations: [],
      nextPageToken: null,
    });

    const grandchild = {
      ...child,
      hostId: newHostId(),
      hostBootId: newHostBootId(),
      feedId: newFeedId(),
      name: "grandchild-host",
      endpointId: "grandchild-endpoint",
      parentHostId: child.hostId,
      rootHostId: child.hostId,
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
    };
    catalog.importChildControl(child.hostId, attachment.attachmentId, {
      kind: "control",
      eventId: randomUUID(),
      originHostId: child.hostId,
      feedId: request.feedId,
      cursor: 1,
      change: { type: "host.upsert", host: grandchild },
    });
    expect(catalog.getHost(grandchild.hostId)?.parentHostId).toBe(child.hostId);

    const greatGrandchild = {
      ...grandchild,
      hostId: newHostId(),
      hostBootId: newHostBootId(),
      feedId: newFeedId(),
      name: "great-grandchild-host",
      endpointId: "great-grandchild-endpoint",
      parentHostId: grandchild.hostId,
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
    };
    expect(() =>
      catalog.importChildControl(child.hostId, attachment.attachmentId, {
        kind: "control",
        eventId: randomUUID(),
        originHostId: child.hostId,
        feedId: request.feedId,
        cursor: 2,
        change: { type: "host.upsert", host: greatGrandchild },
      }),
    ).toThrowError(HostCoreError);
    expect(catalog.getHost(greatGrandchild.hostId)).toBeNull();
    expect(catalog.childCheckpoint(child.hostId)?.controlCursor).toBe(1);
    catalog.close();

    const cycleCatalog = new HostCatalog({
      filename: ":memory:",
      hostName: "cycle-root",
      maxHostDepth: 8,
    });
    const cycleRequest = childRequest();
    const cycleAttachment = cycleCatalog.attachChild(cycleRequest);
    cycleCatalog.importChildSnapshotPage(
      cycleAttachment.child.hostId,
      cycleAttachment.attachment.attachmentId,
      {
        rootHostId: cycleAttachment.child.hostId,
        attachmentId: cycleAttachment.attachment.attachmentId,
        lineageId: cycleAttachment.attachment.lineageId,
        checkpoint: { feedId: cycleRequest.feedId, controlCursor: 0 },
        capturedAt: new Date().toISOString(),
        hosts: [cycleAttachment.child],
        workers: [],
        sessions: [],
        interactions: [],
        metadataOperations: [],
        nextPageToken: null,
      },
    );
    const cyclicHost = {
      ...cycleAttachment.child,
      hostId: newHostId(),
      hostBootId: newHostBootId(),
      feedId: newFeedId(),
      name: "cyclic-host",
      endpointId: "cyclic-endpoint",
      parentHostId: null,
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
    };
    const selfCycle = { ...cyclicHost, parentHostId: cyclicHost.hostId };
    expect(() =>
      cycleCatalog.importChildControl(
        cycleAttachment.child.hostId,
        cycleAttachment.attachment.attachmentId,
        {
          kind: "control",
          eventId: randomUUID(),
          originHostId: cycleAttachment.child.hostId,
          feedId: cycleRequest.feedId,
          cursor: 1,
          change: { type: "host.upsert", host: selfCycle },
        },
      ),
    ).toThrowError(HostCoreError);
    expect(cycleCatalog.getHost(cyclicHost.hostId)).toBeNull();
    cycleCatalog.close();
  });

  it("revalidates unchanged descendants when a live ancestor is reparented", () => {
    const catalog = new HostCatalog({
      filename: ":memory:",
      hostName: "depth-root",
      maxHostDepth: 3,
    });
    const request = childRequest();
    const { attachment, child } = catalog.attachChild(request);
    catalog.importChildSnapshotPage(child.hostId, attachment.attachmentId, {
      rootHostId: child.hostId,
      attachmentId: attachment.attachmentId,
      lineageId: attachment.lineageId,
      checkpoint: { feedId: request.feedId, controlCursor: 0 },
      capturedAt: new Date().toISOString(),
      hosts: [child],
      workers: [],
      sessions: [],
      interactions: [],
      metadataOperations: [],
      nextPageToken: null,
    });

    const ancestor = {
      ...child,
      hostId: newHostId(),
      hostBootId: newHostBootId(),
      feedId: newFeedId(),
      name: "ancestor",
      endpointId: "ancestor-endpoint",
      parentHostId: child.hostId,
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
    };
    const descendant = {
      ...ancestor,
      hostId: newHostId(),
      hostBootId: newHostBootId(),
      feedId: newFeedId(),
      name: "descendant",
      endpointId: "descendant-endpoint",
      parentHostId: ancestor.hostId,
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
    };
    const sibling = {
      ...ancestor,
      hostId: newHostId(),
      hostBootId: newHostBootId(),
      feedId: newFeedId(),
      name: "sibling",
      endpointId: "sibling-endpoint",
      parentHostId: child.hostId,
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
    };
    for (const [cursor, host] of [
      [1, ancestor],
      [2, descendant],
      [3, sibling],
    ] as const) {
      catalog.importChildControl(child.hostId, attachment.attachmentId, {
        kind: "control",
        eventId: randomUUID(),
        originHostId: child.hostId,
        feedId: request.feedId,
        cursor,
        change: { type: "host.upsert", host },
      });
    }

    // The moved ancestor would remain at the configured depth, but its
    // unchanged child would become one edge too deep.
    expect(() =>
      catalog.importChildControl(child.hostId, attachment.attachmentId, {
        kind: "control",
        eventId: randomUUID(),
        originHostId: child.hostId,
        feedId: request.feedId,
        cursor: 4,
        change: {
          type: "host.upsert",
          host: { ...ancestor, parentHostId: sibling.hostId },
        },
      }),
    ).toThrowError(HostCoreError);
    expect(catalog.getHost(ancestor.hostId)?.parentHostId).toBe(child.hostId);
    expect(catalog.childCheckpoint(child.hostId)?.controlCursor).toBe(3);
    catalog.close();
  });

  it("rejects snapshot and live workers whose claimed owner is outside the importing subtree", () => {
    const catalog = new HostCatalog({ filename: ":memory:", hostName: "root-host" });
    const firstRequest = childRequest();
    const secondRequest = { ...childRequest(), endpointId: "second-child-endpoint" };
    const first = catalog.attachChild(firstRequest);
    const second = catalog.attachChild(secondRequest);
    const forgedSnapshotWorker: WorkerDescriptor = {
      workerId: newWorkerId(),
      workerBootId: newWorkerBootId(),
      ownerHostId: catalog.localHost().hostId,
      name: "forged-root-owned-worker",
      presence: "online",
      reachability: "reachable",
      connectedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      allowedRoots: ["/forged"],
      harnesses: [],
      protocolVersion: 2,
    };
    expect(() =>
      catalog.importChildSnapshotPage(first.child.hostId, first.attachment.attachmentId, {
        rootHostId: first.child.hostId,
        attachmentId: first.attachment.attachmentId,
        lineageId: first.attachment.lineageId,
        checkpoint: { feedId: firstRequest.feedId, controlCursor: 0 },
        capturedAt: new Date().toISOString(),
        hosts: [first.child],
        workers: [forgedSnapshotWorker],
        sessions: [],
        interactions: [],
        metadataOperations: [],
        nextPageToken: null,
      }),
    ).toThrowError(HostCoreError);
    expect(catalog.getWorker(forgedSnapshotWorker.workerId)).toBeNull();
    expect(catalog.childCheckpoint(first.child.hostId)).toBeNull();

    for (const [request, attached] of [
      [firstRequest, first],
      [secondRequest, second],
    ] as const) {
      catalog.importChildSnapshotPage(attached.child.hostId, attached.attachment.attachmentId, {
        rootHostId: attached.child.hostId,
        attachmentId: attached.attachment.attachmentId,
        lineageId: attached.attachment.lineageId,
        checkpoint: { feedId: request.feedId, controlCursor: 0 },
        capturedAt: new Date().toISOString(),
        hosts: [attached.child],
        workers: [],
        sessions: [],
        interactions: [],
        metadataOperations: [],
        nextPageToken: null,
      });
    }

    const forgedLiveWorker = {
      ...forgedSnapshotWorker,
      workerId: newWorkerId(),
      workerBootId: newWorkerBootId(),
      ownerHostId: second.child.hostId,
      name: "forged-sibling-owned-worker",
    };
    expect(() =>
      catalog.importChildControl(first.child.hostId, first.attachment.attachmentId, {
        kind: "control",
        eventId: randomUUID(),
        originHostId: first.child.hostId,
        feedId: firstRequest.feedId,
        cursor: 1,
        change: { type: "worker.upsert", worker: forgedLiveWorker },
      }),
    ).toThrowError(HostCoreError);
    expect(catalog.getWorker(forgedLiveWorker.workerId)).toBeNull();
    expect(catalog.childCheckpoint(first.child.hostId)?.controlCursor).toBe(0);

    const legitimateWorker = { ...forgedLiveWorker, ownerHostId: first.child.hostId };
    expect(
      catalog.importChildControl(first.child.hostId, first.attachment.attachmentId, {
        kind: "control",
        eventId: randomUUID(),
        originHostId: first.child.hostId,
        feedId: firstRequest.feedId,
        cursor: 1,
        change: { type: "worker.upsert", worker: legitimateWorker },
      }).accepted,
    ).toBe(true);
    expect(catalog.routeForWorker(legitimateWorker.workerId)?.ownerHostId).toBe(
      first.child.hostId,
    );
    catalog.close();
  });

  it("fences orphan attachments, tuple mismatches, and cross-sibling detaches", () => {
    const catalog = new HostCatalog({ filename: ":memory:", hostName: "root-host" });
    const firstRequest = childRequest();
    const secondRequest = { ...childRequest(), endpointId: "second-child-endpoint" };
    const first = catalog.attachChild(firstRequest);
    const second = catalog.attachChild(secondRequest);
    for (const [request, attached] of [
      [firstRequest, first],
      [secondRequest, second],
    ] as const) {
      catalog.importChildSnapshotPage(attached.child.hostId, attached.attachment.attachmentId, {
        rootHostId: attached.child.hostId,
        attachmentId: attached.attachment.attachmentId,
        lineageId: attached.attachment.lineageId,
        checkpoint: { feedId: request.feedId, controlCursor: 0 },
        capturedAt: new Date().toISOString(),
        hosts: [attached.child],
        workers: [],
        sessions: [],
        interactions: [],
        metadataOperations: [],
        nextPageToken: null,
      });
    }

    const descendantParent = {
      ...first.child,
      hostId: newHostId(),
      hostBootId: newHostBootId(),
      feedId: newFeedId(),
      name: "descendant-parent",
      endpointId: "descendant-parent-endpoint",
      parentHostId: first.child.hostId,
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
    };
    const descendantAttachmentId = newAttachmentId();
    const descendantLineageId = newLineageId();
    const descendant = {
      ...first.child,
      hostId: newHostId(),
      hostBootId: newHostBootId(),
      feedId: newFeedId(),
      name: "descendant-child",
      endpointId: "descendant-child-endpoint",
      parentHostId: descendantParent.hostId,
      attachmentId: descendantAttachmentId,
      lineageId: descendantLineageId,
    };
    for (const [cursor, host] of [
      [1, descendantParent],
      [2, descendant],
    ] as const) {
      catalog.importChildControl(first.child.hostId, first.attachment.attachmentId, {
        kind: "control",
        eventId: randomUUID(),
        originHostId: first.child.hostId,
        feedId: firstRequest.feedId,
        cursor,
        change: { type: "host.upsert", host },
      });
    }
    const canonicalDescendant = catalog.getHost(descendant.hostId)!;
    const exactAttachment: HostAttachment = {
      attachmentId: descendantAttachmentId,
      lineageId: descendantLineageId,
      parentHostId: descendantParent.hostId,
      childHostId: descendant.hostId,
      rootHostId: canonicalDescendant.rootHostId,
      authorityHostId: canonicalDescendant.authorityHostId,
      authorityEpochId: canonicalDescendant.authorityEpochId,
      attachedAt: new Date().toISOString(),
    };
    const orphanHostId = newHostId();
    const orphanAttachment = {
      ...exactAttachment,
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
      childHostId: orphanHostId,
    };
    expect(() =>
      catalog.importChildControl(first.child.hostId, first.attachment.attachmentId, {
        kind: "control",
        eventId: randomUUID(),
        originHostId: first.child.hostId,
        feedId: firstRequest.feedId,
        cursor: 3,
        change: { type: "host.attached", attachment: orphanAttachment },
      }),
    ).toThrowError(HostCoreError);
    expect(() =>
      catalog.importChildControl(first.child.hostId, first.attachment.attachmentId, {
        kind: "control",
        eventId: randomUUID(),
        originHostId: first.child.hostId,
        feedId: firstRequest.feedId,
        cursor: 3,
        change: {
          type: "host.attached",
          attachment: { ...exactAttachment, authorityEpochId: newAuthorityEpochId() },
        },
      }),
    ).toThrowError(HostCoreError);
    expect(catalog.childCheckpoint(first.child.hostId)?.controlCursor).toBe(2);
    expect(
      catalog.importChildControl(first.child.hostId, first.attachment.attachmentId, {
        kind: "control",
        eventId: randomUUID(),
        originHostId: first.child.hostId,
        feedId: firstRequest.feedId,
        cursor: 3,
        change: { type: "host.attached", attachment: exactAttachment },
      }).accepted,
    ).toBe(true);

    expect(() =>
      catalog.importChildControl(first.child.hostId, first.attachment.attachmentId, {
        kind: "control",
        eventId: randomUUID(),
        originHostId: first.child.hostId,
        feedId: firstRequest.feedId,
        cursor: 4,
        change: {
          type: "host.detached",
          hostId: descendant.hostId,
          attachmentId: exactAttachment.attachmentId,
          lineageId: newLineageId(),
        },
      }),
    ).toThrowError(HostCoreError);
    expect(() =>
      catalog.importChildControl(first.child.hostId, first.attachment.attachmentId, {
        kind: "control",
        eventId: randomUUID(),
        originHostId: first.child.hostId,
        feedId: firstRequest.feedId,
        cursor: 4,
        change: {
          type: "host.detached",
          hostId: descendant.hostId,
          attachmentId: second.attachment.attachmentId,
          lineageId: descendantLineageId,
        },
      }),
    ).toThrowError(HostCoreError);
    expect(catalog.getAttachment(second.child.hostId)).toEqual(second.attachment);
    expect(catalog.getHost(descendant.hostId)?.presence).toBe("online");
    expect(catalog.childCheckpoint(first.child.hostId)?.controlCursor).toBe(3);

    expect(
      catalog.importChildControl(first.child.hostId, first.attachment.attachmentId, {
        kind: "control",
        eventId: randomUUID(),
        originHostId: first.child.hostId,
        feedId: firstRequest.feedId,
        cursor: 4,
        change: {
          type: "host.detached",
          hostId: descendant.hostId,
          attachmentId: exactAttachment.attachmentId,
          lineageId: exactAttachment.lineageId,
        },
      }).accepted,
    ).toBe(true);
    expect(catalog.getHost(descendant.hostId)?.presence).toBe("offline");
    catalog.close();
  });

  it("imports a child snapshot, resolves an immediate-child route, and retains cached state on detach", () => {
    const catalog = new HostCatalog({ filename: ":memory:", hostName: "root-host" });
    const request = childRequest();
    const { attachment, child } = catalog.attachChild(request);
    const worker: WorkerDescriptor = {
      workerId: newWorkerId(),
      workerBootId: newWorkerBootId(),
      ownerHostId: child.hostId,
      name: "nested-worker",
      presence: "online",
      reachability: "reachable",
      connectedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      allowedRoots: ["/nested"],
      harnesses: [],
      protocolVersion: 2,
    };
    const session: SessionRecord = {
      sessionId: newSessionId(),
      workerId: worker.workerId,
      harness: "codex",
      adapterScopeId: "codex-default" as SessionRecord["adapterScopeId"],
      vendorSessionId: "nested-thread",
      bindingRevision: 1,
      runtimeEpoch: newRuntimeEpoch(),
      cwd: "/nested/project",
      availability: "active",
      runtimeStatus: "idle",
      metadata: emptyMetadataSnapshot(),
      metadataAuthority: { hostId: child.hostId, epochId: child.authorityEpochId },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    catalog.importChildSnapshotPage(child.hostId, attachment.attachmentId, {
      rootHostId: child.hostId,
      attachmentId: attachment.attachmentId,
      lineageId: attachment.lineageId,
      checkpoint: { feedId: request.feedId, controlCursor: 7 },
      capturedAt: new Date().toISOString(),
      hosts: [child],
      workers: [worker],
      sessions: [session],
      interactions: [],
      metadataOperations: [],
      nextPageToken: null,
    });

    expect(catalog.routeForWorker(worker.workerId)).toMatchObject({
      ownerHostId: child.hostId,
      immediateChildHostId: child.hostId,
      attachmentId: attachment.attachmentId,
    });
    expect(catalog.getSession(session.sessionId)?.metadataAuthority).toEqual({
      hostId: catalog.localHost().hostId,
      epochId: catalog.localHost().authorityEpochId,
    });
    expect(catalog.childCheckpoint(child.hostId)).toEqual({
      feedId: request.feedId,
      controlCursor: 7,
    });

    expect(catalog.detachChild(child.hostId, attachment.attachmentId)).toBe(true);
    expect(catalog.getHost(child.hostId)?.presence).toBe("offline");
    expect(catalog.getWorker(worker.workerId)?.reachability).toBe("unreachable");
    expect(catalog.getSession(session.sessionId)).not.toBeNull();
    catalog.close();
  });

  it("preserves child-projected descendant reachability across snapshot, live updates, reconnect, and heartbeat", () => {
    const catalog = new HostCatalog({ filename: ":memory:", hostName: "reachability-root" });
    const request = childRequest();
    const { attachment, child } = catalog.attachChild(request);
    const grandchild: HostDescriptor = {
      ...child,
      hostId: newHostId(),
      hostBootId: newHostBootId(),
      feedId: newFeedId(),
      name: "offline-grandchild",
      endpointId: "offline-grandchild-endpoint",
      presence: "stale",
      parentHostId: child.hostId,
      rootHostId: child.hostId,
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
      connectedAt: null,
    };
    const worker: WorkerDescriptor = {
      workerId: newWorkerId(),
      workerBootId: newWorkerBootId(),
      ownerHostId: grandchild.hostId,
      name: "unreachable-grandchild-worker",
      presence: "online",
      reachability: "unreachable",
      connectedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      allowedRoots: ["/nested"],
      harnesses: [],
      protocolVersion: 2,
    };
    catalog.importChildSnapshotPage(child.hostId, attachment.attachmentId, {
      rootHostId: child.hostId,
      attachmentId: attachment.attachmentId,
      lineageId: attachment.lineageId,
      checkpoint: { feedId: request.feedId, controlCursor: 0 },
      capturedAt: new Date().toISOString(),
      hosts: [{ ...child, presence: "stale" }, grandchild],
      workers: [worker],
      sessions: [],
      interactions: [],
      metadataOperations: [],
      nextPageToken: null,
    });

    expect(catalog.getHost(child.hostId)?.presence).toBe("online");
    expect(catalog.getHost(grandchild.hostId)?.presence).toBe("stale");
    expect(catalog.getWorker(worker.workerId)?.reachability).toBe("unreachable");

    const liveGrandchild = { ...grandchild, presence: "offline" as const };
    catalog.importChildControl(child.hostId, attachment.attachmentId, {
      kind: "control",
      eventId: randomUUID(),
      originHostId: child.hostId,
      feedId: request.feedId,
      cursor: 1,
      change: { type: "host.upsert", host: liveGrandchild },
    });
    catalog.importChildControl(child.hostId, attachment.attachmentId, {
      kind: "control",
      eventId: randomUUID(),
      originHostId: child.hostId,
      feedId: request.feedId,
      cursor: 2,
      change: {
        type: "worker.upsert",
        worker: { ...worker, reachability: "stale" },
      },
    });
    catalog.importChildControl(child.hostId, attachment.attachmentId, {
      kind: "control",
      eventId: randomUUID(),
      originHostId: child.hostId,
      feedId: request.feedId,
      cursor: 3,
      change: {
        type: "worker.presence",
        workerId: worker.workerId,
        presence: "online",
      },
    });
    expect(catalog.getHost(grandchild.hostId)?.presence).toBe("offline");
    expect(catalog.getWorker(worker.workerId)?.reachability).toBe("stale");

    expect(catalog.markChildDisconnected(child.hostId, child.hostBootId)).toBe(true);
    expect(catalog.getHost(child.hostId)?.presence).toBe("stale");
    expect(catalog.getHost(grandchild.hostId)?.presence).toBe("offline");
    expect(catalog.getWorker(worker.workerId)?.reachability).toBe("unreachable");

    const reconnected = catalog.attachChild({
      ...request,
      previousAttachmentId: attachment.attachmentId,
      previousLineageId: attachment.lineageId,
    });
    expect(reconnected.reconnected).toBe(true);
    expect(
      catalog.heartbeatChild(
        child.hostId,
        child.hostBootId,
        attachment.attachmentId,
        attachment.lineageId,
      ),
    ).toBe(true);
    expect(catalog.getHost(child.hostId)?.presence).toBe("online");
    expect(catalog.getHost(grandchild.hostId)?.presence).toBe("offline");
    expect(catalog.getWorker(worker.workerId)?.reachability).toBe("unreachable");
    catalog.close();
  });

  it("deduplicates imported global events and advances their checkpoint atomically", () => {
    let failAfterProjection = false;
    const catalog = new HostCatalog({
      filename: ":memory:",
      hostName: "root-host",
      failpoint: (name) => {
        if (name === "import.afterProjection" && failAfterProjection) {
          throw new Error("injected import crash");
        }
      },
    });
    const request = childRequest();
    const { attachment, child } = catalog.attachChild(request);
    catalog.importChildSnapshotPage(child.hostId, attachment.attachmentId, {
      rootHostId: child.hostId,
      attachmentId: attachment.attachmentId,
      lineageId: attachment.lineageId,
      checkpoint: { feedId: request.feedId, controlCursor: 0 },
      capturedAt: new Date().toISOString(),
      hosts: [child],
      workers: [],
      sessions: [],
      interactions: [],
      metadataOperations: [],
      nextPageToken: null,
    });
    const eventId = randomUUID();
    const cursorBefore = catalog.controlCursor();
    failAfterProjection = true;
    expect(() =>
      catalog.importChildControl(child.hostId, attachment.attachmentId, {
        kind: "control",
        eventId,
        originHostId: child.hostId,
        feedId: request.feedId,
        cursor: 1,
        change: { type: "host.presence", hostId: child.hostId, presence: "stale" },
      }),
    ).toThrow("injected import crash");
    expect(catalog.controlCursor()).toBe(cursorBefore);
    expect(catalog.childCheckpoint(child.hostId)?.controlCursor).toBe(0);
    expect(catalog.getHost(child.hostId)?.presence).toBe("online");

    failAfterProjection = false;
    const first = catalog.importChildControl(child.hostId, attachment.attachmentId, {
      kind: "control",
      eventId,
      originHostId: child.hostId,
      feedId: request.feedId,
      cursor: 1,
      change: { type: "host.presence", hostId: child.hostId, presence: "stale" },
    });
    expect(first).toMatchObject({ accepted: true, deduplicated: false });
    expect(first.localCursor).toBe(cursorBefore + 1);
    expect(catalog.childCheckpoint(child.hostId)?.controlCursor).toBe(1);
    expect(catalog.controlEventsAfter(cursorBefore)).toMatchObject([
      { eventId, originHostId: child.hostId, feedId: catalog.localHost().feedId },
    ]);

    const duplicate = catalog.importChildControl(child.hostId, attachment.attachmentId, {
      kind: "control",
      eventId,
      originHostId: child.hostId,
      feedId: request.feedId,
      cursor: 1,
      change: { type: "host.presence", hostId: child.hostId, presence: "stale" },
    });
    expect(duplicate).toMatchObject({ deduplicated: true, localCursor: first.localCursor });
    expect(catalog.controlCursor()).toBe(first.localCursor);
    expect(() =>
      catalog.importChildControl(child.hostId, attachment.attachmentId, {
        kind: "control",
        eventId,
        originHostId: child.hostId,
        feedId: request.feedId,
        cursor: 1,
        change: { type: "host.presence", hostId: child.hostId, presence: "online" },
      }),
    ).toThrowError(HostCoreError);

    expect(() =>
      catalog.importChildControl(child.hostId, attachment.attachmentId, {
        kind: "control",
        eventId: randomUUID(),
        originHostId: child.hostId,
        feedId: request.feedId,
        cursor: 3,
        change: { type: "host.presence", hostId: child.hostId, presence: "stale" },
      }),
    ).toThrowError(HostCoreError);
    expect(catalog.childCheckpoint(child.hostId)?.controlCursor).toBe(1);
    catalog.close();
  });

  it("keeps offline metadata optimistic until an authority result settles it", () => {
    const catalog = new HostCatalog({ filename: ":memory:", hostName: "child-host" });
    const worker = directWorker();
    catalog.registerWorker(worker);
    const [session] = catalog.reconcileInventory(directInventory(worker));
    if (!session) throw new Error("expected a local session");
    const parentHostId = newHostId();
    const authorityEpochId = newAuthorityEpochId();
    const parentAttachment: HostAttachment = {
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
      parentHostId,
      childHostId: catalog.localHost().hostId,
      rootHostId: parentHostId,
      authorityHostId: parentHostId,
      authorityEpochId,
      attachedAt: new Date().toISOString(),
    };
    catalog.applyParentAttachment(parentAttachment);

    const operation = catalog.submitMetadataPatch({
      operationId: newOperationId(),
      sessionId: session.sessionId,
      set: { "agent.title": "optimistic title" },
      ifKeyRevision: { "agent.title": null },
    });
    expect(operation).toMatchObject({
      status: "queued",
      canonical: { revision: 0, values: {} },
      optimistic: { revision: 0, values: { "agent.title": "optimistic title" } },
      authorityEpochId,
    });
    expect(catalog.getMetadata(session.sessionId).values).toEqual({});

    const settled: MetadataOperationRecord = {
      ...operation,
      status: "accepted",
      canonical: {
        revision: 1,
        values: { "agent.title": "optimistic title" },
        keyRevisions: { "agent.title": 1 },
      },
      updatedAt: new Date().toISOString(),
    };
    delete settled.optimistic;
    catalog.settleMetadataOperation(settled);
    expect(catalog.getMetadata(session.sessionId)).toEqual(settled.canonical);
    expect(catalog.getMetadataOperation(operation.operationId)?.status).toBe("accepted");
    catalog.close();
  });

  it("marks an overdue child subtree stale without detaching it", () => {
    const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
    const catalog = new HostCatalog({
      filename: ":memory:",
      hostName: "root-host",
      now: () => clock.now,
    });
    const request = childRequest();
    const { attachment, child } = catalog.attachChild(request);
    clock.now = new Date("2026-01-01T00:01:00.000Z");

    expect(
      catalog.markStaleChildren(new Date("2026-01-01T00:00:30.000Z")),
    ).toEqual([child.hostId]);
    expect(catalog.getHost(child.hostId)?.presence).toBe("stale");
    expect(catalog.getAttachment(child.hostId)?.attachmentId).toBe(
      attachment.attachmentId,
    );
    catalog.close();
  });
});
