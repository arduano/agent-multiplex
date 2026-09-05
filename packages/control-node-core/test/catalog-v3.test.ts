import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emptyMetadataSnapshot,
  newControlNodeBootId,
  newControlNodeId,
  newFeedId,
  newOperationId,
  newRuntimeEpoch,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  type AccessSnapshot,
  type AccessStreamItem,
  type AdapterScopeId,
  type ControlNodeAttachment,
  type ControlNodeDescriptor,
  type MetadataOperationRecord,
  type RuntimeNodeId,
  type SessionRecord,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";

import {
  ControlNodeCatalog,
  ControlNodeCoreError,
  ControlNodeEventHub,
  ControlNodeService,
  type ChildControlNodeConnection,
  type ControlNodeCatalogFailpoint,
  type RuntimeNodeConnection,
} from "../src/index.js";

const now = "2034-01-02T03:04:05.000Z";
const clock = () => new Date(now);

function stateFile(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), `agent-multiplex-${prefix}-`)), "control-node.sqlite");
}

function attach(parent: ControlNodeCatalog, child: ControlNodeCatalog, childEndpointId?: string) {
  const local = child.localControlNode();
  const result = parent.attachChild({
    controlNodeId: local.controlNodeId,
    controlNodeBootId: local.controlNodeBootId,
    feedId: local.feedId,
    name: local.name,
    protocolVersion: 5,
    capabilities: local.capabilities,
    expectedParentControlNodeId: parent.localControlNode().controlNodeId,
    childProof: child.attachmentProof(),
    ...(childEndpointId ? { endpointId: childEndpointId } : {}),
  });
  child.applyParentAttachment(result.attachment, `parent-${parent.localControlNode().controlNodeId}`);
  return result;
}

function addSession(catalog: ControlNodeCatalog, vendorSessionId = "native-session") {
  const runtimeNodeId = newRuntimeNodeId();
  const runtimeNodeBootId = newRuntimeNodeBootId();
  catalog.registerRuntimeNode({
    runtimeNodeId,
    runtimeNodeBootId,
    name: "runtime",
    allowedRoots: ["/work"],
    harnesses: [],
    protocolVersion: 5,
  });
  const [session] = catalog.reconcileInventory({
    runtimeNodeId,
    generation: "inventory-1",
    complete: true,
    capturedAt: now,
    sessions: [{
      harness: "codex",
      adapterScopeId: "codex-test" as AdapterScopeId,
      vendorSessionId,
      cwd: "/work/project",
      availability: "active",
      runtimeStatus: "idle",
      runtimeEpoch: newRuntimeEpoch(),
      lastActivityAt: now,
    }],
  });
  if (!session) throw new Error("test inventory did not create a session");
  return { runtimeNodeId, runtimeNodeBootId, session };
}

describe("ControlNodeCatalog protocol-v4 authority invariants", () => {
  it("persists roles, treats disconnect as presence only, and requires explicit promotion", () => {
    const parent = new ControlNodeCatalog({ filename: stateFile("parent"), now: clock });
    const childFile = stateFile("child");
    let child = new ControlNodeCatalog({ filename: childFile, now: clock });
    const locator = { endpointId: "parent-key", locator: { kind: "ticket", ticket: "secret-ticket" } };
    expect(child.bootstrapDesiredUpstream(locator)).toBe(true);
    const { attachment } = attach(parent, child);
    const inheritedAuthority = parent.authority();
    expect(child.dataRole()).toMatchObject({
      role: "branch",
      authority: inheritedAuthority,
      branch: { lifecycle: "attached", attachmentId: attachment.attachmentId },
    });

    parent.markChildDisconnected(child.localControlNode().controlNodeId);
    expect(parent.getControlNode(child.localControlNode().controlNodeId)).toMatchObject({
      presence: "stale",
      dataRole: { role: "branch", branch: { lifecycle: "attached" } },
    });
    expect(child.dataRole()).toMatchObject({ role: "branch", branch: { lifecycle: "attached" } });

    child.close();
    child = new ControlNodeCatalog({ filename: childFile, now: clock });
    expect(child.dataRole()).toMatchObject({ role: "branch", branch: { lifecycle: "attached" } });
    expect(child.desiredUpstream()).toEqual(locator);

    const receipt = parent.detachChild({
      childControlNodeId: child.localControlNode().controlNodeId,
      attachmentId: attachment.attachmentId,
      lineageId: attachment.lineageId,
      expectedAuthority: inheritedAuthority,
    });
    child.applyDetachmentReceipt(receipt);
    expect(child.dataRole()).toMatchObject({
      role: "branch",
      authority: inheritedAuthority,
      branch: { lifecycle: "detached" },
    });
    expect(child.desiredUpstream()).toBeNull();

    const promotion = child.promote({
      controlNodeId: child.localControlNode().controlNodeId,
      expectedAuthority: inheritedAuthority,
      detachmentTransitionId: receipt.transitionId,
    });
    expect(promotion.authority.controlNodeId).toBe(child.localControlNode().controlNodeId);
    expect(promotion.authority.realmId).not.toBe(inheritedAuthority.realmId);
    expect(promotion.authority.epochId).not.toBe(inheritedAuthority.epochId);
    expect(child.dataRole()).toEqual({ role: "authority", authority: promotion.authority });

    const { session } = addSession(child);
    expect(() => child.submitMetadataPatch({
      operationId: newOperationId(),
      sessionId: session.sessionId,
      expectedAuthority: inheritedAuthority,
      set: { "agent.title": "stale" },
    })).toThrowError(expect.objectContaining<Partial<ControlNodeCoreError>>({ code: "FENCED" }));

    child.close();
    child = new ControlNodeCatalog({ filename: childFile, now: clock });
    expect(child.dataRole()).toEqual({ role: "authority", authority: promotion.authority });
    // A stale parent environment variable cannot resurrect a cleared attachment.
    expect(child.bootstrapDesiredUpstream(locator)).toBe(false);
    expect(child.desiredUpstream()).toBeNull();
    child.close();
    parent.close();
  });

  it("keeps force-detach non-authoritative and fences obsolete promotion receipts", () => {
    const parent = new ControlNodeCatalog({ filename: stateFile("force-parent"), now: clock });
    const child = new ControlNodeCatalog({ filename: stateFile("force-child"), now: clock });
    const first = attach(parent, child);
    const inherited = child.authority();
    const forced = child.forceDetach({
      controlNodeId: child.localControlNode().controlNodeId,
      expectedAuthority: inherited,
      attachmentId: first.attachment.attachmentId,
      lineageId: first.attachment.lineageId,
      acknowledgedUnknownMetadataOutcomes: true,
      audit: { actorId: "operator", reason: "parent permanently lost", requestedAt: now, evidence: [] },
    });
    expect(child.dataRole()).toMatchObject({ role: "branch", authority: inherited, branch: { lifecycle: "detached" } });
    expect(() => child.promote({
      controlNodeId: child.localControlNode().controlNodeId,
      expectedAuthority: inherited,
      detachmentTransitionId: forced.transitionId,
    })).toThrow(/split-brain acknowledgement/);
    const promoted = child.promote({
      controlNodeId: child.localControlNode().controlNodeId,
      expectedAuthority: inherited,
      detachmentTransitionId: forced.transitionId,
      forcedDetachmentAudit: {
        actorId: "operator",
        reason: "accept independent realm",
        requestedAt: now,
        evidence: ["incident-reviewed"],
        acknowledgedSplitBrainRisk: true,
      },
    });
    expect(promoted.authority.realmId).not.toBe(inherited.realmId);
    expect(() => child.promote({
      controlNodeId: child.localControlNode().controlNodeId,
      expectedAuthority: promoted.authority,
      detachmentTransitionId: forced.transitionId,
    })).toThrow(/detached branch/);
    child.close();
    parent.close();
  });

  it("rolls metadata state, journal, and delivery intent back as one transaction", () => {
    let injected: ControlNodeCatalogFailpoint | undefined;
    const catalog = new ControlNodeCatalog({
      filename: stateFile("metadata-atomic"),
      now: clock,
      failpoint: (point) => {
        if (point === injected) throw new Error(`injected ${point}`);
      },
    });
    const { session } = addSession(catalog);
    for (const point of [
      "metadata.authority.afterState",
      "metadata.authority.afterEvents",
      "metadata.authority.afterDeliveryIntent",
    ] as const) {
      const cursor = catalog.controlCursor();
      injected = point;
      expect(() => catalog.submitMetadataPatch({
        operationId: newOperationId(),
        sessionId: session.sessionId,
        expectedAuthority: catalog.authority(),
        set: { "agent.title": point },
      })).toThrow(`injected ${point}`);
      expect(catalog.getMetadata(session.sessionId)).toEqual(emptyMetadataSnapshot());
      expect(catalog.listMetadataOperations({ limit: 100 })).toEqual([]);
      expect(catalog.pendingMetadataDeliveries()).toEqual([]);
      expect(catalog.controlCursor()).toBe(cursor);
    }

    injected = undefined;
    const committed = catalog.submitMetadataPatch({
      operationId: newOperationId(),
      sessionId: session.sessionId,
      expectedAuthority: catalog.authority(),
      set: { "agent.title": "committed" },
    });
    expect(committed.status).toBe("accepted");
    expect(catalog.pendingMetadataDeliveries()).toMatchObject([{
      destinationRuntimeNodeId: session.runtimeNodeId,
      operation: { operationId: committed.operationId },
    }]);
    catalog.close();
  });
});

describe("ControlNodeService snapshot and delivery boundaries", () => {
  it("resnapshots and restarts a child aggregate stream after it terminates", async () => {
    const parentCatalog = new ControlNodeCatalog({ filename: stateFile("pump-recovery-parent"), now: clock });
    const childCatalog = new ControlNodeCatalog({ filename: stateFile("pump-recovery-child"), now: clock });
    const { attachment, child } = attach(
      parentCatalog,
      childCatalog,
      "pump-recovery-child-endpoint",
    );
    const snapshot = childCatalog.accessSnapshot();
    let snapshotReads = 0;
    let subscriptions = 0;
    let finishFirstStream!: () => void;
    const firstStreamCanFinish = new Promise<void>((resolve) => {
      finishFirstStream = resolve;
    });
    let publishAfterRestart!: (item: AccessStreamItem) => void;
    const eventAfterRestart = new Promise<AccessStreamItem>((resolve) => {
      publishAfterRestart = resolve;
    });
    const connection: ChildControlNodeConnection = {
      controlNodeId: child.controlNodeId,
      controlNodeBootId: child.controlNodeBootId,
      endpointId: child.endpointId,
      async readSubtreeSnapshot() {
        snapshotReads += 1;
        return {
          source: snapshot.source,
          attachmentId: attachment.attachmentId,
          lineageId: attachment.lineageId,
          checkpoint: {
            feedId: snapshot.source.manifest.feedId,
            controlCursor: snapshot.source.manifest.controlCursor,
          },
          capturedAt: snapshot.capturedAt,
          controlNodes: snapshot.controlNodes,
          runtimeNodes: snapshot.runtimeNodes,
          sessions: snapshot.sessions,
          interactions: snapshot.interactions,
          metadataOperations: snapshot.metadataOperations,
          nextPageToken: null,
        };
      },
      async *subscribeAggregate(_cursor, signal) {
        subscriptions += 1;
        if (subscriptions === 1) {
          await Promise.race([
            firstStreamCanFinish,
            new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })),
          ]);
          return;
        }
        const item = await eventAfterRestart;
        if (signal?.aborted) return;
        yield item;
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      },
      listModels: () => Promise.resolve([]),
      listLaunchProfileModels: () => Promise.resolve([]),
      refreshInventory: () => Promise.reject(new Error("unused")),
      createLaunch: () => Promise.reject(new Error("unused")),
      getLaunch: () => Promise.reject(new Error("unused")),
      listLaunches: () => Promise.reject(new Error("unused")),
      searchSessions: () => Promise.reject(new Error("unused")),
      getSession: () => Promise.reject(new Error("unused")),
      resume: () => Promise.reject(new Error("unused")),
      stop: () => Promise.reject(new Error("unused")),
      archive: () => Promise.reject(new Error("unused")),
      getArchive: () => Promise.reject(new Error("unused")),
      execute: () => Promise.reject(new Error("unused")),
      readNativeHistory: () => Promise.reject(new Error("unused")),
      resolveInteraction: () => Promise.reject(new Error("unused")),
    };
    const service = new ControlNodeService({ catalog: parentCatalog, now: clock });

    await service.attachChildConnection(connection);
    expect(snapshotReads).toBe(1);
    expect(subscriptions).toBe(1);

    finishFirstStream();
    for (let attempt = 0; attempt < 20 && parentCatalog.getControlNode(child.controlNodeId)?.presence !== "stale"; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(parentCatalog.getControlNode(child.controlNodeId)?.presence).toBe("stale");

    await service.heartbeatChild({
      controlNodeId: child.controlNodeId,
      controlNodeBootId: child.controlNodeBootId,
      attachmentId: attachment.attachmentId,
      lineageId: attachment.lineageId,
      checkpoint: childCatalog.feedCheckpoint(),
    }, {
      endpointId: child.endpointId,
      authenticatedControlNodeId: child.controlNodeId,
    });

    expect(snapshotReads).toBe(2);
    expect(subscriptions).toBe(2);
    expect(parentCatalog.getControlNode(child.controlNodeId)?.presence).toBe("online");

    const runtimeNodeId = newRuntimeNodeId();
    childCatalog.registerRuntimeNode({
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "post-restart-runtime",
      allowedRoots: ["/work"],
      harnesses: [],
      protocolVersion: 5,
    });
    const runtimeEvent = childCatalog.controlEventsAfter(
      snapshot.source.manifest.controlCursor,
    ).find((item) =>
      item.change.type === "runtimeNode.upsert" &&
      item.change.runtimeNode.runtimeNodeId === runtimeNodeId,
    );
    expect(runtimeEvent).toBeDefined();
    publishAfterRestart(runtimeEvent!);
    for (let attempt = 0; attempt < 20 && !parentCatalog.getRuntimeNode(runtimeNodeId); attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(parentCatalog.getRuntimeNode(runtimeNodeId)).toMatchObject({
      runtimeNodeId,
      ownerControlNodeId: child.controlNodeId,
      reachability: "reachable",
    });

    service.close();
    parentCatalog.close();
    childCatalog.close();
  });

  it("assembles all pages before atomically replacing a child projection", async () => {
    const parentCatalog = new ControlNodeCatalog({ filename: stateFile("snapshot-parent"), now: clock });
    const childCatalog = new ControlNodeCatalog({ filename: stateFile("snapshot-child"), now: clock });
    const { attachment, child } = attach(parentCatalog, childCatalog);
    const runtimeNodeId = newRuntimeNodeId();
    const runtimeNodeBootId = newRuntimeNodeBootId();
    const runtime = {
      runtimeNodeId,
      runtimeNodeBootId,
      ownerControlNodeId: child.controlNodeId,
      name: "child-runtime",
      presence: "online" as const,
      reachability: "reachable" as const,
      connectedAt: now,
      lastHeartbeatAt: now,
      allowedRoots: ["/work"],
      harnesses: [],
      protocolVersion: 5 as const,
    };
    const makeSession = (vendor: string): SessionRecord => ({
      sessionId: newSessionId(),
      runtimeNodeId,
      harness: "codex",
      adapterScopeId: "codex-test" as AdapterScopeId,
      vendorSessionId: vendor,
      bindingRevision: 1,
      runtimeEpoch: null,
      cwd: "/work",
      availability: "resumable",
      runtimeStatus: "stopped",
      metadata: emptyMetadataSnapshot(),
      metadataAuthority: parentCatalog.authority(),
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    });
    const retained = makeSession("retained");
    const ghost = makeSession("ghost");
    const base = (sessions: SessionRecord[]): AccessSnapshot => ({
      source: {
        manifest: {
          componentKind: "control-node",
          protocolVersion: 5,
          sourceControlNodeId: child.controlNodeId,
          sourceControlNodeBootId: child.controlNodeBootId,
          authority: parentCatalog.authority(),
          projectionRootControlNodeId: child.controlNodeId,
          coveredControlNodeIds: [child.controlNodeId],
          feedId: child.feedId,
          controlCursor: 7,
          generatedAt: now,
          capabilities: [],
        },
        parentByControlNodeId: { [child.controlNodeId]: null },
      },
      capturedAt: now,
      controlNodes: [childCatalog.localControlNode()],
      runtimeNodes: [runtime],
      sessions,
      interactions: [],
      metadataOperations: [],
    });
    const parentService = new ControlNodeService({ catalog: parentCatalog });

    await parentService.attachChildConnection(pagedConnection(child, attachment, base([retained, ghost])));
    expect(parentCatalog.listSessions().map((item) => item.vendorSessionId).sort()).toEqual(["ghost", "retained"]);

    const broken = pagedConnection(child, attachment, base([retained]), true);
    await expect(parentService.attachChildConnection(broken)).rejects.toThrow("injected page failure");
    expect(parentCatalog.listSessions().map((item) => item.vendorSessionId).sort()).toEqual(["ghost", "retained"]);

    await parentService.attachChildConnection(pagedConnection(child, attachment, base([retained])));
    expect(parentCatalog.listSessions().map((item) => item.vendorSessionId)).toEqual(["retained"]);
    parentService.close();
    parentCatalog.close();
    childCatalog.close();
  });

  it("signals cursor expiry and eventually delivers terminal metadata receipts", async () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("delivery"), now: clock });
    const { runtimeNodeId, runtimeNodeBootId, session } = addSession(catalog);
    const service = new ControlNodeService({ catalog });
    const applied: MetadataOperationRecord[] = [];
    service.attachRuntimeNodeConnection(runtimeConnection(runtimeNodeId, runtimeNodeBootId, applied));
    const committed = await service.patchMetadata({
      operationId: newOperationId(),
      sessionId: session.sessionId,
      expectedAuthority: catalog.authority(),
      set: { "agent.title": "delivered" },
    });
    await service.flushMetadataDeliveries();
    expect(applied.map((item) => item.operationId)).toEqual([committed.operationId]);
    expect(catalog.pendingMetadataDeliveries()).toEqual([]);

    const oldCursor = catalog.controlCursor();
    catalog.compactControlEvents(oldCursor);
    const stream = new ControlNodeEventHub({ catalog }).attach({
      sessions: "all",
      includeNative: false,
      cursor: { feedId: catalog.feedCheckpoint().feedId, controlCursor: oldCursor - 1, native: {} },
    })[Symbol.asyncIterator]();
    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "streamReset", reason: "cursorExpired", recovery: "snapshot" },
    });
    service.close();
    catalog.close();
  });

  it("fails a slow access subscriber explicitly and leaves later subscribers healthy", async () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("subscriber-overflow"), now: clock });
    const hub = new ControlNodeEventHub({
      catalog,
      subscriberBufferSize: 2,
      heartbeatMs: 60_000,
    });
    const slow = hub.attach({
      sessions: "all",
      includeNative: false,
    })[Symbol.asyncIterator]();
    const first = slow.next();
    const runtime = addSession(catalog);
    await expect(first).resolves.toMatchObject({ value: { kind: "control" } });
    catalog.markRuntimeNodeDisconnected(
      runtime.runtimeNodeId,
      runtime.runtimeNodeBootId,
    );
    await expect(slow.next()).rejects.toMatchObject({
      name: "SubscriberOverflowError",
      capacity: 2,
    });

    const controller = new AbortController();
    const healthy = hub.attach({
      sessions: "all",
      includeNative: false,
    }, controller.signal)[Symbol.asyncIterator]();
    const nextHealthy = healthy.next();
    catalog.registerRuntimeNode({
      runtimeNodeId: newRuntimeNodeId(),
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "healthy-runtime",
      allowedRoots: ["/work"],
      harnesses: [],
      protocolVersion: 5,
    });
    const item = await nextHealthy;
    expect(item.value).toMatchObject({ kind: "control" });
    controller.abort();
    await expect(healthy.next()).resolves.toMatchObject({ done: true });
    hub.close();
    catalog.close();
  });

  it("does not install access-stream resources for an already-aborted signal", async () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("subscriber-aborted"), now: clock });
    const hub = new ControlNodeEventHub({ catalog, heartbeatMs: 1 });
    const controller = new AbortController();
    controller.abort();
    const iterator = hub.attach({
      sessions: "all",
      includeNative: true,
    }, controller.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    hub.close();
    catalog.close();
  });
});

function pagedConnection(
  child: ControlNodeDescriptor,
  attachment: ControlNodeAttachment,
  snapshot: AccessSnapshot,
  failSecondPage = false,
): ChildControlNodeConnection {
  const flat = [
    ...snapshot.controlNodes.map((value) => ({ kind: "controlNode" as const, value })),
    ...snapshot.runtimeNodes.map((value) => ({ kind: "runtimeNode" as const, value })),
    ...snapshot.sessions.map((value) => ({ kind: "session" as const, value })),
  ];
  return {
    controlNodeId: child.controlNodeId,
    controlNodeBootId: child.controlNodeBootId,
    async readSubtreeSnapshot(request) {
      const index = request.pageToken === undefined ? 0 : Number(request.pageToken.slice(1));
      if (failSecondPage && index === 1) throw new Error("injected page failure");
      const item = flat[index];
      const result = {
        source: snapshot.source,
        attachmentId: attachment.attachmentId,
        lineageId: attachment.lineageId,
        checkpoint: {
          feedId: snapshot.source.manifest.feedId,
          controlCursor: snapshot.source.manifest.controlCursor,
        },
        capturedAt: snapshot.capturedAt,
        controlNodes: item?.kind === "controlNode" ? [item.value] : [],
        runtimeNodes: item?.kind === "runtimeNode" ? [item.value] : [],
        sessions: item?.kind === "session" ? [item.value] : [],
        interactions: [],
        metadataOperations: [],
        nextPageToken: index + 1 < flat.length ? `p${index + 1}` : null,
      };
      return result;
    },
    async *subscribeAggregate() {},
    listModels: () => Promise.resolve([]),
    listLaunchProfileModels: () => Promise.resolve([]),
    refreshInventory: () => Promise.reject(new Error("unused")),
    createLaunch: () => Promise.reject(new Error("unused")),
    getLaunch: () => Promise.reject(new Error("unused")),
    listLaunches: () => Promise.reject(new Error("unused")),
    searchSessions: () => Promise.reject(new Error("unused")),
    getSession: () => Promise.reject(new Error("unused")),
    resume: () => Promise.reject(new Error("unused")),
    stop: () => Promise.reject(new Error("unused")),
    archive: () => Promise.reject(new Error("unused")),
    getArchive: () => Promise.reject(new Error("unused")),
    execute: () => Promise.reject(new Error("unused")),
    readNativeHistory: () => Promise.reject(new Error("unused")),
    resolveInteraction: () => Promise.reject(new Error("unused")),
  };
}

function runtimeConnection(
  runtimeNodeId: RuntimeNodeId,
  runtimeNodeBootId: ReturnType<typeof newRuntimeNodeBootId>,
  applied: MetadataOperationRecord[],
): RuntimeNodeConnection {
  return {
    runtimeNodeId,
    runtimeNodeBootId,
    refreshInventory: () => Promise.reject(new Error("unused")),
    listModels: () => Promise.resolve([]),
    listLaunchProfiles: () => Promise.resolve([]),
    listLaunchProfileModels: () => Promise.resolve([]),
    createLaunch: () => Promise.reject(new Error("unused")),
    getLaunch: () => Promise.reject(new Error("unused")),
    listLaunches: () => Promise.reject(new Error("unused")),
    resume: () => Promise.reject(new Error("unused")),
    stop: () => Promise.reject(new Error("unused")),
    archive: () => Promise.reject(new Error("unused")),
    getArchive: () => Promise.reject(new Error("unused")),
    execute: () => Promise.reject(new Error("unused")),
    readNativeHistory: () => Promise.reject(new Error("unused")),
    resolveInteraction: () => Promise.reject(new Error("unused")),
    applyMetadata: async (operation) => {
      applied.push(operation);
      return operation;
    },
  };
}
