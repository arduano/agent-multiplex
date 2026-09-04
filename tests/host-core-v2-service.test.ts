import { randomUUID } from "node:crypto";

import {
  jsonValueSchema,
  newAttachmentId,
  newAuthorityEpochId,
  newCommandId,
  newFeedId,
  newInteractionId,
  newLineageId,
  newHostId,
  newOperationId,
  newRuntimeEpoch,
  newSessionId,
  newWorkerBootId,
  newWorkerId,
  type CommandEnvelope,
  type CommandRecord,
  type FeedControlItem,
  type FeedId,
  type HostAttachment,
  type HostId,
  type HostLinkFence,
  type InteractionRecord,
  type InventorySnapshot,
  type MetadataOperationRecord,
  type MetadataPatch,
  type ResumeCommand,
  type SpawnCommand,
  type WorkerRegistration,
} from "@agent-multiplex/protocol";
import {
  FleetEventHub,
  FleetSubscriberOverflowError,
  HostCatalog,
  HostCoreError,
  HostService,
  type ChildHostConnection,
  type WorkerConnection,
} from "@agent-multiplex/host-core";
import { describe, expect, it } from "vitest";

const timestamp = (): string => new Date().toISOString();

const registration = (): WorkerRegistration => ({
  workerId: newWorkerId(),
  workerBootId: newWorkerBootId(),
  name: "nested-worker",
  allowedRoots: ["/work"],
  harnesses: [
    {
      harness: "codex",
      adapterScopeId: "codex-nested" as WorkerRegistration["harnesses"][number]["adapterScopeId"],
      available: true,
      capabilities: [{ name: "interactive", experimental: false }],
    },
  ],
  protocolVersion: 2,
});

const inventory = (
  worker: WorkerRegistration,
  runtimeEpoch = newRuntimeEpoch(),
): InventorySnapshot => ({
  workerId: worker.workerId,
  generation: randomUUID(),
  complete: true,
  capturedAt: timestamp(),
  sessions: [
    {
      harness: "codex",
      adapterScopeId: worker.harnesses[0]!.adapterScopeId,
      vendorSessionId: "nested-native-session",
      cwd: "/work/project",
      availability: "active",
      runtimeStatus: "idle",
      runtimeEpoch,
      lastActivityAt: timestamp(),
    },
  ],
});

const recordFor = (
  command: SpawnCommand | ResumeCommand | CommandEnvelope,
  state: CommandRecord["state"] = "succeeded",
): CommandRecord => ({
  commandId: command.commandId,
  payloadHash: command.payloadHash,
  sessionId: command.sessionId,
  workerId: command.workerId,
  state,
  request: jsonValueSchema.parse(command),
  result: { routed: true },
  createdAt: timestamp(),
  updatedAt: timestamp(),
});

async function eventually(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function attachInProcessHost(input: {
  parentService: HostService;
  parentCatalog: HostCatalog;
  parentEndpoint: string;
  childService: HostService;
  childCatalog: HostCatalog;
  childEndpoint: string;
  synchronize?: boolean;
}): Promise<{ fence: HostLinkFence; connection: ChildHostConnection }> {
  const child = input.childCatalog.localHost();
  let fence: HostLinkFence | undefined;
  const fenced = (): HostLinkFence => {
    if (!fence) throw new Error("child attachment fence is not ready");
    return fence;
  };
  const parentContext = () => ({
    authenticatedHostId: input.parentCatalog.localHost().hostId,
    endpointId: input.parentEndpoint,
  });
  const connection: ChildHostConnection = {
    hostId: child.hostId,
    hostBootId: child.hostBootId,
    endpointId: input.childEndpoint,
    readSubtreeSnapshot: async (request) =>
      input.childService.readSubtreeSnapshot(
        { ...fenced(), ...request, limit: request.limit ?? 500 },
        parentContext(),
      ),
    subscribeAggregate: (cursor, signal) =>
      input.childService.subscribeAggregate(
        { ...fenced(), cursor },
        parentContext(),
        signal,
      ),
    listModels: (workerId, harness) =>
      input.childService.listModelsFromParent(
        { ...fenced(), workerId, harness },
        parentContext(),
      ),
    refreshInventory: (workerId) =>
      input.childService.refreshFromParent(
        { ...fenced(), workerId },
        parentContext(),
      ),
    spawn: (command) =>
      input.childService.spawnFromParent(
        { ...fenced(), command },
        parentContext(),
      ),
    resume: (command) =>
      input.childService.resumeFromParent(
        { ...fenced(), command },
        parentContext(),
      ),
    execute: (command) =>
      input.childService.executeFromParent(
        { ...fenced(), command },
        parentContext(),
      ),
    readNativeHistory: (sessionId, request) =>
      input.childService.readNativeHistoryFromParent(
        { ...fenced(), sessionId, request },
        parentContext(),
      ),
    resolveInteraction: (interaction) =>
      input.childService.resolveInteractionFromParent(
        { ...fenced(), interaction },
        parentContext(),
      ),
    getCommand: (commandId) =>
      input.childService.getCommandFromParent(
        { ...fenced(), commandId },
        parentContext(),
      ),
    applyMetadata: async (operation) =>
      input.childService.applyMetadataFromParent(
        { ...fenced(), operation },
        parentContext(),
      ),
  };
  const attached = await input.parentService.attachChild(
    {
      hostId: child.hostId,
      hostBootId: child.hostBootId,
      feedId: child.feedId,
      name: child.name,
      endpointId: input.childEndpoint,
      protocolVersion: 2,
      capabilities: child.capabilities,
    },
    {
      authenticatedHostId: child.hostId,
      endpointId: input.childEndpoint,
      childHostConnection: connection,
    },
  );
  fence = {
    hostId: child.hostId,
    hostBootId: child.hostBootId,
    attachmentId: attached.attachment.attachmentId,
    lineageId: attached.attachment.lineageId,
  };
  input.childService.applyParentAttachment(attached.attachment);
  input.childCatalog.enrollPeer(
    input.parentEndpoint,
    "parentHost",
    input.parentCatalog.localHost().hostId,
  );
  if (input.synchronize !== false) {
    await input.parentService.heartbeatChild(
      { ...fence, checkpoint: input.childCatalog.feedCheckpoint() },
      { authenticatedHostId: child.hostId, endpointId: input.childEndpoint },
    );
  }
  return { fence, connection };
}

describe("HostService protocol-v2 integration", () => {
  it("single-files concurrent child refresh pump replacements", async () => {
    const rootCatalog = new HostCatalog({ filename: ":memory:", hostName: "root" });
    const childCatalog = new HostCatalog({ filename: ":memory:", hostName: "child" });
    const rootService = new HostService({ catalog: rootCatalog, instanceId: "root" });
    const childService = new HostService({ catalog: childCatalog, instanceId: "child" });
    const worker = registration();
    const snapshot = inventory(worker);
    const workerConnection: WorkerConnection = {
      workerId: worker.workerId,
      workerBootId: worker.workerBootId,
      refreshInventory: async () => snapshot,
      listModels: async () => [],
      spawn: async (command) => recordFor(command, "failed"),
      resume: async (command) => recordFor(command, "failed"),
      execute: async (command) => recordFor(command, "failed"),
      readNativeHistory: async (_sessionId, request) => ({
        harness: request.harness,
        vendorSessionId: "nested-native-session",
        payload: null,
      }),
      resolveInteraction: async () => {
        throw new Error("unused");
      },
    };
    childService.registerWorker(worker, { workerConnection });
    childService.reconcile(snapshot);
    const { connection } = await attachInProcessHost({
      parentService: rootService,
      parentCatalog: rootCatalog,
      parentEndpoint: "root-endpoint",
      childService,
      childCatalog,
      childEndpoint: "child-endpoint",
    });

    const subscribeAggregate = connection.subscribeAggregate.bind(connection);
    let active = 0;
    let maximumActive = 0;
    let replacements = 0;
    connection.subscribeAggregate = (cursor, signal) => {
      replacements += 1;
      const source = subscribeAggregate(cursor, signal);
      return (async function* () {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          yield* source;
        } finally {
          active -= 1;
        }
      })();
    };

    await Promise.all(
      Array.from({ length: 12 }, () => rootService.refresh(worker.workerId)),
    );
    await eventually(() => expect(active).toBe(1));
    expect(replacements).toBe(1);
    expect(maximumActive).toBe(1);

    rootService.close();
    childService.close();
    rootCatalog.close();
    childCatalog.close();
  });

  it("keeps child metadata queued until its session route is imported, then settles the retry", async () => {
    const rootCatalog = new HostCatalog({ filename: ":memory:", hostName: "root" });
    const childCatalog = new HostCatalog({ filename: ":memory:", hostName: "child" });
    const rootService = new HostService({ catalog: rootCatalog, instanceId: "root" });
    const childService = new HostService({ catalog: childCatalog, instanceId: "child" });
    const workerRegistration = registration();
    const worker = childCatalog.registerWorker(workerRegistration);
    const [sessionBeforeAttach] = childCatalog.reconcileInventory(inventory(workerRegistration));
    if (!sessionBeforeAttach) throw new Error("expected child session");

    const { fence } = await attachInProcessHost({
      parentService: rootService,
      parentCatalog: rootCatalog,
      parentEndpoint: "root-endpoint",
      childService,
      childCatalog,
      childEndpoint: "child-endpoint",
      synchronize: false,
    });

    const child = childCatalog.localHost();
    const session = childCatalog.getSession(sessionBeforeAttach.sessionId);
    if (!session) throw new Error("expected attached child session");
    const snapshot = {
      rootHostId: child.hostId,
      attachmentId: fence.attachmentId,
      lineageId: fence.lineageId,
      checkpoint: childCatalog.feedCheckpoint(),
      capturedAt: timestamp(),
      hosts: [child],
      workers: [worker],
      sessions: [session],
      interactions: [],
      metadataOperations: [],
      nextPageToken: null,
    };

    const queued = childService.patchMetadata({
      operationId: newOperationId(),
      sessionId: session.sessionId,
      set: { "agent.title": "metadata overtook session import" },
    });
    expect(queued.status).toBe("queued");

    const context = {
      authenticatedHostId: child.hostId,
      endpointId: "child-endpoint",
    };
    await expect(
      rootService.pushChildMetadataOutbox({ ...fence, operations: [queued] }, context),
    ).resolves.toEqual([queued]);
    expect(rootCatalog.getSession(session.sessionId)).toBeNull();
    expect(rootCatalog.getMetadataOperation(queued.operationId)).toBeNull();

    rootCatalog.importChildSnapshotPage(child.hostId, fence.attachmentId, snapshot);
    const [settled] = await rootService.pushChildMetadataOutbox(
      { ...fence, operations: [queued] },
      context,
    );
    expect(settled).toMatchObject({
      operationId: queued.operationId,
      status: "accepted",
      canonical: {
        revision: 1,
        values: { "agent.title": "metadata overtook session import" },
      },
    });
    await eventually(() => {
      expect(childCatalog.getMetadataOperation(queued.operationId)?.status).toBe("accepted");
      expect(childService.getMetadata(session.sessionId).values["agent.title"]).toBe(
        "metadata overtook session import",
      );
      expect(rootCatalog.pendingMetadataReplication(child.hostId)).toEqual([]);
    });

    rootService.close();
    childService.close();
    rootCatalog.close();
    childCatalog.close();
  });

  it("delivers lifecycle metadata applied from a child snapshot without a live control race", async () => {
    const rootCatalog = new HostCatalog({ filename: ":memory:", hostName: "root" });
    const childCatalog = new HostCatalog({ filename: ":memory:", hostName: "child" });
    const rootService = new HostService({ catalog: rootCatalog, instanceId: "root" });
    const childService = new HostService({ catalog: childCatalog, instanceId: "child" });
    const worker = registration();
    let snapshot = inventory(worker);
    const workerConnection: WorkerConnection = {
      workerId: worker.workerId,
      workerBootId: worker.workerBootId,
      refreshInventory: async () => snapshot,
      listModels: async () => [],
      spawn: async (command) => {
        const vendorSessionId = `snapshot-${command.sessionId}`;
        snapshot = {
          ...snapshot,
          generation: randomUUID(),
          capturedAt: timestamp(),
          sessions: [
            ...snapshot.sessions,
            {
              harness: command.request.harness,
              adapterScopeId: worker.harnesses[0]!.adapterScopeId,
              vendorSessionId,
              cwd: command.request.cwd,
              availability: "active",
              runtimeStatus: "idle",
              runtimeEpoch: newRuntimeEpoch(),
              lastActivityAt: timestamp(),
            },
          ],
        };
        return {
          ...recordFor(command),
          result: { vendorSessionId },
        };
      },
      resume: async (command) => recordFor(command, "failed"),
      execute: async (command) => recordFor(command, "failed"),
      readNativeHistory: async (_sessionId, request) => ({
        harness: request.harness,
        vendorSessionId: "nested-native-session",
        payload: null,
      }),
      resolveInteraction: async () => {
        throw new Error("unused");
      },
    };
    childService.registerWorker(worker, { workerConnection });
    childService.reconcile(snapshot);

    const { fence, connection } = await attachInProcessHost({
      parentService: rootService,
      parentCatalog: rootCatalog,
      parentEndpoint: "root-endpoint",
      childService,
      childCatalog,
      childEndpoint: "child-endpoint",
      synchronize: false,
    });
    connection.subscribeAggregate = (_cursor, signal) =>
      (async function* () {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      })();
    await rootService.heartbeatChild(
      { ...fence, checkpoint: childCatalog.feedCheckpoint() },
      {
        authenticatedHostId: childCatalog.localHost().hostId,
        endpointId: "child-endpoint",
      },
    );

    const sessionId = newSessionId();
    const command: SpawnCommand = {
      commandId: newCommandId(),
      payloadHash: "snapshot-lifecycle-metadata",
      sessionId,
      workerId: worker.workerId,
      request: { harness: "codex", cwd: "/work/snapshot-spawn" },
      metadata: { "agent.title": "snapshot lifecycle" },
    };
    await expect(rootService.spawn(command)).resolves.toMatchObject({ state: "succeeded" });
    expect(rootService.getMetadata(sessionId)).toMatchObject({
      revision: 1,
      values: { "agent.title": "snapshot lifecycle" },
    });
    await eventually(() => {
      expect(childService.getMetadata(sessionId)).toMatchObject({
        revision: 1,
        values: { "agent.title": "snapshot lifecycle" },
      });
      expect(childCatalog.getMetadataOperation(command.commandId)).toMatchObject({
        status: "accepted",
      });
      expect(rootCatalog.pendingMetadataReplication(childCatalog.localHost().hostId)).toEqual([]);
    });

    rootService.close();
    childService.close();
    rootCatalog.close();
    childCatalog.close();
  });

  it("multiplexes a three-level tree, sibling branch, and direct worker from the root", async () => {
    const rootCatalog = new HostCatalog({ filename: ":memory:", hostName: "root" });
    const relayCatalog = new HostCatalog({ filename: ":memory:", hostName: "relay" });
    const leafCatalog = new HostCatalog({ filename: ":memory:", hostName: "leaf" });
    const siblingCatalog = new HostCatalog({ filename: ":memory:", hostName: "sibling" });
    const rootService = new HostService({ catalog: rootCatalog, instanceId: "root" });
    const relayService = new HostService({ catalog: relayCatalog, instanceId: "relay" });
    const leafService = new HostService({ catalog: leafCatalog, instanceId: "leaf" });
    const siblingService = new HostService({
      catalog: siblingCatalog,
      instanceId: "sibling",
    });

    const rootWorker = registration();
    const leafWorker = registration();
    const siblingWorker = registration();
    const rootSnapshot = inventory(rootWorker);
    let leafSnapshot = inventory(leafWorker);
    const siblingSnapshot = inventory(siblingWorker);
    let leafResolution: InteractionRecord | undefined;
    const rootConnection: WorkerConnection = {
      workerId: rootWorker.workerId,
      workerBootId: rootWorker.workerBootId,
      refreshInventory: async () => rootSnapshot,
      listModels: async () => [{ harness: "codex", id: "root-model" }],
      spawn: async (command) => recordFor(command, "failed"),
      resume: async (command) => recordFor(command, "failed"),
      execute: async (command) => recordFor(command),
      readNativeHistory: async (_sessionId, request) => ({
        harness: request.harness,
        vendorSessionId: "nested-native-session",
        payload: { branch: "root" },
      }),
      resolveInteraction: async () => {
        throw new Error("root interaction was not expected");
      },
      getCommand: async () => null,
    };
    const leafConnection: WorkerConnection = {
      workerId: leafWorker.workerId,
      workerBootId: leafWorker.workerBootId,
      refreshInventory: async () => leafSnapshot,
      listModels: async () => [{ harness: "codex", id: "leaf-model" }],
      spawn: async (command) => {
        const vendorSessionId = `spawn-${command.sessionId}`;
        leafSnapshot = {
          ...leafSnapshot,
          generation: randomUUID(),
          capturedAt: timestamp(),
          sessions: [
            ...leafSnapshot.sessions,
            {
              harness: command.request.harness,
              adapterScopeId: leafWorker.harnesses[0]!.adapterScopeId,
              vendorSessionId,
              cwd: command.request.cwd,
              availability: "active",
              runtimeStatus: "idle",
              runtimeEpoch: newRuntimeEpoch(),
              lastActivityAt: timestamp(),
            },
          ],
        };
        return {
          ...recordFor(command),
          result: { vendorSessionId, branch: "leaf" },
        };
      },
      resume: async (command) => recordFor(command, "failed"),
      execute: async (command) => ({
        ...recordFor(command),
        result: { commandType: command.request.command.type, branch: "leaf" },
      }),
      readNativeHistory: async (_sessionId, request) => ({
        harness: request.harness,
        vendorSessionId: "nested-native-session",
        payload: { branch: "leaf", nativeHistory: true },
      }),
      resolveInteraction: async () => {
        if (!leafResolution) throw new Error("missing leaf interaction result");
        return leafResolution;
      },
      getCommand: async () => null,
    };
    const siblingConnection: WorkerConnection = {
      workerId: siblingWorker.workerId,
      workerBootId: siblingWorker.workerBootId,
      refreshInventory: async () => siblingSnapshot,
      listModels: async () => [{ harness: "codex", id: "sibling-model" }],
      spawn: async (command) => recordFor(command, "failed"),
      resume: async (command) => recordFor(command, "failed"),
      execute: async (command) => recordFor(command),
      readNativeHistory: async (_sessionId, request) => ({
        harness: request.harness,
        vendorSessionId: "nested-native-session",
        payload: { branch: "sibling" },
      }),
      resolveInteraction: async () => {
        throw new Error("sibling interaction was not expected");
      },
      getCommand: async () => null,
    };

    rootService.registerWorker(rootWorker, { workerConnection: rootConnection });
    const [rootSession] = rootService.reconcile(rootSnapshot).sessions;
    leafService.registerWorker(leafWorker, { workerConnection: leafConnection });
    const [leafSession] = leafService.reconcile(leafSnapshot).sessions;
    siblingService.registerWorker(siblingWorker, { workerConnection: siblingConnection });
    const [siblingSession] = siblingService.reconcile(siblingSnapshot).sessions;
    if (!rootSession || !leafSession || !siblingSession) {
      throw new Error("expected one session on every worker");
    }

    await attachInProcessHost({
      parentService: relayService,
      parentCatalog: relayCatalog,
      parentEndpoint: "relay-endpoint",
      childService: leafService,
      childCatalog: leafCatalog,
      childEndpoint: "leaf-endpoint",
    });
    const relayLink = await attachInProcessHost({
      parentService: rootService,
      parentCatalog: rootCatalog,
      parentEndpoint: "root-endpoint",
      childService: relayService,
      childCatalog: relayCatalog,
      childEndpoint: "relay-endpoint",
    });
    await attachInProcessHost({
      parentService: rootService,
      parentCatalog: rootCatalog,
      parentEndpoint: "root-endpoint",
      childService: siblingService,
      childCatalog: siblingCatalog,
      childEndpoint: "sibling-endpoint",
    });

    expect(rootCatalog.routeForWorker(rootWorker.workerId)).toBeNull();
    expect(rootCatalog.routeForWorker(leafWorker.workerId)).toMatchObject({
      ownerHostId: leafCatalog.localHost().hostId,
      immediateChildHostId: relayCatalog.localHost().hostId,
    });
    expect(rootCatalog.routeForWorker(siblingWorker.workerId)).toMatchObject({
      immediateChildHostId: siblingCatalog.localHost().hostId,
    });
    expect(rootService.listSessions()).toHaveLength(3);
    await expect(rootService.listModels(rootWorker.workerId, "codex")).resolves.toMatchObject([
      { id: "root-model" },
    ]);
    await expect(rootService.listModels(leafWorker.workerId, "codex")).resolves.toMatchObject([
      { id: "leaf-model" },
    ]);
    await expect(rootService.listModels(siblingWorker.workerId, "codex")).resolves.toMatchObject([
      { id: "sibling-model" },
    ]);
    await expect(
      rootService.readNativeHistory(leafSession.sessionId, {
        harness: "codex",
        includeTurns: true,
      }),
    ).resolves.toMatchObject({ payload: { branch: "leaf", nativeHistory: true } });

    const execute: CommandEnvelope = {
      commandId: newCommandId(),
      payloadHash: "three-level-execute",
      sessionId: leafSession.sessionId,
      workerId: leafWorker.workerId,
      bindingRevision: leafSession.bindingRevision,
      request: { harness: "codex", command: { type: "interrupt" } },
    };
    await expect(rootService.execute(execute)).resolves.toMatchObject({
      state: "succeeded",
      result: { commandType: "interrupt", branch: "leaf" },
    });

    const spawnedSessionId = newSessionId();
    const spawn: SpawnCommand = {
      commandId: newCommandId(),
      payloadHash: "three-level-spawn",
      sessionId: spawnedSessionId,
      workerId: leafWorker.workerId,
      request: { harness: "codex", cwd: "/work/spawned" },
      metadata: { "agent.title": "three-level spawn" },
    };
    await expect(rootService.spawn(spawn)).resolves.toMatchObject({
      state: "succeeded",
      result: { branch: "leaf" },
    });
    expect(rootService.getSession(spawnedSessionId)).toMatchObject({
      workerId: leafWorker.workerId,
      cwd: "/work/spawned",
    });
    expect(rootService.getMetadata(spawnedSessionId)).toEqual({
      revision: 1,
      values: { "agent.title": "three-level spawn" },
      keyRevisions: { "agent.title": 1 },
    });
    await eventually(() => {
      for (const service of [relayService, leafService]) {
        expect(service.getMetadata(spawnedSessionId)).toEqual({
          revision: 1,
          values: { "agent.title": "three-level spawn" },
          keyRevisions: { "agent.title": 1 },
        });
      }
      for (const catalog of [rootCatalog, relayCatalog, leafCatalog]) {
        expect(catalog.listMetadataOperations({ sessionId: spawnedSessionId })).toMatchObject([
          {
            operationId: spawn.commandId,
            sessionId: spawnedSessionId,
            status: "accepted",
          },
        ]);
      }
    });

    const pending: InteractionRecord = {
      interactionId: newInteractionId(),
      sessionId: leafSession.sessionId,
      harness: "codex",
      runtimeEpoch: leafSession.runtimeEpoch!,
      requestType: "approval",
      payload: { branch: "leaf" },
      ephemeral: false,
      state: "pending",
      createdAt: timestamp(),
      expiresAt: null,
      resolvedAt: null,
    };
    leafService.publishInteraction(pending, {
      authenticatedWorkerId: leafWorker.workerId,
    });
    await eventually(() =>
      expect(rootService.listInteractions()).toContainEqual(pending),
    );
    leafResolution = {
      ...pending,
      state: "resolved",
      resolution: { approved: true },
      resolvedAt: timestamp(),
    };
    await expect(
      rootService.resolveInteraction({
        interactionId: pending.interactionId,
        sessionId: pending.sessionId,
        harness: pending.harness,
        response: { approved: true },
      }),
    ).resolves.toMatchObject({ state: "resolved", resolution: { approved: true } });

    const cursor = rootCatalog.feedCheckpoint();
    const streamAbort = new AbortController();
    const stream = rootService.watchSessions(
      {
        sessions: [leafSession.sessionId],
        includeNative: true,
        cursor: { ...cursor, native: {} },
      },
      streamAbort.signal,
    );
    const nativeRead = (async () => {
      for (;;) {
        const item = await stream.next();
        if (item.done || item.value.kind === "native") return item;
      }
    })();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      leafService.publishWorkerEvent(
        {
          kind: "native",
          sessionId: leafSession.sessionId,
          harness: "codex",
          runtimeEpoch: leafSession.runtimeEpoch!,
          sequence: 0,
          nativeType: "turn/started",
          payload: { branch: "leaf" },
          ephemeral: false,
        },
        { authenticatedWorkerId: leafWorker.workerId },
      ),
    ).toEqual({ accepted: true });
    const nativeItem = await Promise.race([
      nativeRead,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("timed out waiting for recursive native event")), 2_000),
      ),
    ]);
    expect(nativeItem).toMatchObject({
      done: false,
      value: {
        kind: "native",
        sessionId: leafSession.sessionId,
        nativeType: "turn/started",
        payload: { branch: "leaf" },
      },
    });
    streamAbort.abort();
    await stream.return(undefined);

    rootService.detachChildConnection(
      relayLink.connection.hostId,
      relayLink.connection.hostBootId,
    );
    expect(rootService.getHost(relayCatalog.localHost().hostId)?.presence).toBe("stale");
    expect(rootService.getHost(leafCatalog.localHost().hostId)).not.toBeNull();
    expect(rootService.getSession(leafSession.sessionId)).not.toBeNull();
    expect(rootCatalog.getWorker(leafWorker.workerId)?.reachability).toBe("unreachable");
    expect(rootCatalog.getWorker(siblingWorker.workerId)?.reachability).toBe("reachable");
    expect(rootCatalog.getWorker(rootWorker.workerId)?.reachability).toBe("reachable");
    await expect(rootService.listModels(leafWorker.workerId, "codex")).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });

    rootService.close();
    relayService.close();
    leafService.close();
    siblingService.close();
    rootCatalog.close();
    relayCatalog.close();
    leafCatalog.close();
    siblingCatalog.close();
  });

  it("routes recursively through one child, fences the link, and converges metadata", async () => {
    const childCatalog = new HostCatalog({ filename: ":memory:", hostName: "child" });
    const rootCatalog = new HostCatalog({ filename: ":memory:", hostName: "root" });
    const worker = registration();
    const runtimeEpoch = newRuntimeEpoch();
    const workerSnapshot = inventory(worker, runtimeEpoch);
    let interactionResult: InteractionRecord | undefined;
    const workerConnection: WorkerConnection = {
      workerId: worker.workerId,
      workerBootId: worker.workerBootId,
      refreshInventory: async () => workerSnapshot,
      listModels: async () => [
        { harness: "codex", id: "gpt-5.3-codex", name: "Codex" },
      ],
      spawn: async (command) => recordFor(command, "failed"),
      resume: async (command) => recordFor(command, "failed"),
      execute: async (command) => recordFor(command),
      readNativeHistory: async (_sessionId, request) => ({
        harness: request.harness,
        vendorSessionId: "nested-native-session",
        payload: { native: true },
      }),
      resolveInteraction: async () => {
        if (!interactionResult) throw new Error("missing interaction result");
        return interactionResult;
      },
      getCommand: async () => null,
    };

    let fence: HostLinkFence | undefined;
    let rootService: HostService;
    const childService = new HostService({
      catalog: childCatalog,
      instanceId: "child-service",
      metadataUpstream: {
        pushMetadataOutbox: async (operations) => {
          if (!fence) throw new Error("child is not attached");
          return rootService.pushChildMetadataOutbox(
            { ...fence, operations },
            {
              authenticatedHostId: childCatalog.localHost().hostId,
              endpointId: "child-endpoint",
            },
          );
        },
      },
    });
    childService.registerWorker(worker, { workerConnection });
    const [childSession] = childService.reconcile(workerSnapshot).sessions;
    if (!childSession) throw new Error("expected child session");

    const parentContext = () => ({
      authenticatedHostId: rootCatalog.localHost().hostId,
      endpointId: "root-endpoint",
    });
    const fenced = (): HostLinkFence => {
      if (!fence) throw new Error("child is not attached");
      return fence;
    };
    const childConnection: ChildHostConnection = {
      hostId: childCatalog.localHost().hostId,
      hostBootId: childCatalog.localHost().hostBootId,
      endpointId: "child-endpoint",
      readSubtreeSnapshot: async (request) =>
        childService.readSubtreeSnapshot(
          { ...fenced(), ...request, limit: request.limit ?? 500 },
          parentContext(),
        ),
      subscribeAggregate: (cursor, signal) =>
        childService.subscribeAggregate({ ...fenced(), cursor }, parentContext(), signal),
      listModels: (workerId, harness) =>
        childService.listModelsFromParent(
          { ...fenced(), workerId, harness },
          parentContext(),
        ),
      refreshInventory: (workerId) =>
        childService.refreshFromParent({ ...fenced(), workerId }, parentContext()),
      spawn: (command) =>
        childService.spawnFromParent({ ...fenced(), command }, parentContext()),
      resume: (command) =>
        childService.resumeFromParent({ ...fenced(), command }, parentContext()),
      execute: (command) =>
        childService.executeFromParent({ ...fenced(), command }, parentContext()),
      readNativeHistory: (sessionId, request) =>
        childService.readNativeHistoryFromParent(
          { ...fenced(), sessionId, request },
          parentContext(),
        ),
      resolveInteraction: (interaction) =>
        childService.resolveInteractionFromParent(
          { ...fenced(), interaction },
          parentContext(),
        ),
      getCommand: (commandId) =>
        childService.getCommandFromParent(
          { ...fenced(), commandId },
          parentContext(),
        ),
      applyMetadata: async (operation) =>
        childService.applyMetadataFromParent(
          { ...fenced(), operation },
          parentContext(),
        ),
    };

    rootService = new HostService({ catalog: rootCatalog, instanceId: "root-service" });
    const childBeforeAttach = childCatalog.localHost();
    const attached = await rootService.attachChild(
      {
        hostId: childBeforeAttach.hostId,
        hostBootId: childBeforeAttach.hostBootId,
        feedId: childBeforeAttach.feedId,
        name: childBeforeAttach.name,
        endpointId: "child-endpoint",
        protocolVersion: 2,
        capabilities: childBeforeAttach.capabilities,
      },
      {
        authenticatedHostId: childBeforeAttach.hostId,
        endpointId: "child-endpoint",
        childHostConnection: childConnection,
      },
    );
    fence = {
      hostId: attached.attachment.childHostId,
      hostBootId: childBeforeAttach.hostBootId,
      attachmentId: attached.attachment.attachmentId,
      lineageId: attached.attachment.lineageId,
    };
    childService.applyParentAttachment(attached.attachment);
    childCatalog.enrollPeer("root-endpoint", "parentHost", rootCatalog.localHost().hostId);

    // Attachment returns before link authorization. The first fenced heartbeat
    // is the readiness barrier that imports the immutable snapshot and starts replay.
    await rootService.heartbeatChild(
      { ...fence, checkpoint: childCatalog.feedCheckpoint() },
      { authenticatedHostId: childBeforeAttach.hostId, endpointId: "child-endpoint" },
    );
    expect(rootService.getSession(childSession.sessionId)).toMatchObject({
      workerId: worker.workerId,
      metadataAuthority: { hostId: rootCatalog.localHost().hostId },
    });
    await expect(rootService.listModels(worker.workerId, "codex")).resolves.toEqual([
      { harness: "codex", id: "gpt-5.3-codex", name: "Codex" },
    ]);
    await expect(
      rootService.readNativeHistory(childSession.sessionId, {
        harness: "codex",
        includeTurns: true,
      }),
    ).resolves.toMatchObject({ payload: { native: true } });

    const execute: CommandEnvelope = {
      commandId: newCommandId(),
      payloadHash: "recursive-execute",
      sessionId: childSession.sessionId,
      workerId: worker.workerId,
      bindingRevision: childSession.bindingRevision,
      request: { harness: "codex", command: { type: "setModel", model: "gpt-5.3-codex" } },
    };
    await expect(rootService.execute(execute)).resolves.toMatchObject({ state: "succeeded" });

    const pending: InteractionRecord = {
      interactionId: newInteractionId(),
      sessionId: childSession.sessionId,
      harness: "codex",
      runtimeEpoch,
      requestType: "approval",
      payload: { command: "echo nested" },
      ephemeral: false,
      state: "pending",
      createdAt: timestamp(),
      expiresAt: null,
      resolvedAt: null,
    };
    childService.publishInteraction(pending);
    await eventually(() => expect(rootService.listInteractions()).toContainEqual(pending));
    interactionResult = {
      ...pending,
      state: "resolved",
      resolution: { approved: true },
      resolvedAt: timestamp(),
    };
    await expect(
      rootService.resolveInteraction({
        interactionId: pending.interactionId,
        sessionId: pending.sessionId,
        harness: pending.harness,
        response: { approved: true },
      }),
    ).resolves.toMatchObject({ state: "resolved" });

    const rootPatch = rootService.patchMetadata({
      operationId: newOperationId(),
      sessionId: childSession.sessionId,
      set: { "dashboard.priority": 3 },
    });
    expect(rootPatch.status).toBe("accepted");
    await eventually(() =>
      expect(childService.getMetadata(childSession.sessionId).values["dashboard.priority"]).toBe(3),
    );

    const childOperation = childService.patchMetadata({
      operationId: newOperationId(),
      sessionId: childSession.sessionId,
      set: { "agent.title": "from child" },
      ifKeyRevision: { "agent.title": null },
    });
    expect(childOperation.status).toBe("queued");
    await eventually(() => {
      expect(
        rootService.getMetadataOperation(childOperation.operationId)?.status,
      ).toBe("accepted");
      expect(childService.getMetadata(childSession.sessionId).values["agent.title"]).toBe(
        "from child",
      );
    });

    expect(() =>
      childService.readSubtreeSnapshot(
        {
          ...fence!,
          hostBootId: `${fence!.hostBootId}-stale` as HostLinkFence["hostBootId"],
          limit: 500,
        },
        parentContext(),
      ),
    ).toThrowError(HostCoreError);

    rootService.close();
    childService.close();
    rootCatalog.close();
    childCatalog.close();
  });

  it.each(["accepted", "conflicted"] as const)(
    "delivers a later %s metadata receipt to its directly attached worker",
    async (status) => {
      const catalog = new HostCatalog({ filename: ":memory:", hostName: "worker-settlement" });
      const service = new HostService({ catalog, instanceId: "worker-settlement" });
      const worker = registration();
      const delivered: MetadataOperationRecord[] = [];
      const workerConnection: WorkerConnection = {
        workerId: worker.workerId,
        workerBootId: worker.workerBootId,
        refreshInventory: async () => inventory(worker),
        listModels: async () => [],
        spawn: async (command) => recordFor(command),
        resume: async (command) => recordFor(command),
        execute: async (command) => recordFor(command),
        readNativeHistory: async (_sessionId, request) => ({
          harness: request.harness,
          vendorSessionId: "native",
          payload: {},
        }),
        resolveInteraction: async () => {
          throw new Error("unused");
        },
        applyMetadata: async (operation) => {
          delivered.push(operation);
          return operation;
        },
      };
      service.registerWorker(worker, { workerConnection });
      const [session] = service.reconcile(inventory(worker)).sessions;
      if (!session) throw new Error("expected direct worker session");
      const parentHostId = newHostId();
      const attachment: HostAttachment = {
        attachmentId: newAttachmentId(),
        lineageId: newLineageId(),
        parentHostId,
        childHostId: catalog.localHost().hostId,
        rootHostId: parentHostId,
        authorityHostId: parentHostId,
        authorityEpochId: newAuthorityEpochId(),
        attachedAt: timestamp(),
      };
      service.applyParentAttachment(attachment);
      const fence: HostLinkFence = {
        hostId: catalog.localHost().hostId,
        hostBootId: catalog.localHost().hostBootId,
        attachmentId: attachment.attachmentId,
        lineageId: attachment.lineageId,
      };
      const patch: MetadataPatch = {
        operationId: newOperationId(),
        sessionId: session.sessionId,
        set: { "agent.worker": status },
        ...(status === "conflicted"
          ? { ifKeyRevision: { "agent.worker": 4 } }
          : {}),
      };
      const [queued] = service.pushMetadataOutbox(worker.workerId, [patch]);
      if (!queued) throw new Error("expected queued worker metadata operation");
      expect(queued.status).toBe("queued");
      const { optimistic: _optimistic, ...queuedBase } = queued;
      const canonical = status === "accepted"
        ? {
            revision: 1,
            values: { "agent.worker": status },
            keyRevisions: { "agent.worker": 1 },
          }
        : queued.canonical;
      const terminal: MetadataOperationRecord = {
        ...queuedBase,
        status,
        canonical,
        ...(status === "conflicted"
          ? {
              conflicts: [{
                key: "agent.worker",
                expectedRevision: 4,
                actualRevision: null,
              }],
            }
          : {}),
        updatedAt: timestamp(),
      };

      service.applyMetadataFromParent(
        { ...fence, operation: terminal },
        { authenticatedHostId: parentHostId },
      );
      await eventually(() => expect(delivered).toEqual([terminal]));
      expect(catalog.pendingWorkerMetadataReplication(worker.workerId)).toEqual([]);

      service.close();
      catalog.close();
    },
  );

  it("serves snapshot hosts root-first and parent-before-child across page boundaries", () => {
    const localHostId = "ffffffff-ffff-4fff-8fff-ffffffffffff" as HostId;
    const childHostId = "11111111-1111-4111-8111-111111111111" as HostId;
    const grandchildHostId = "00000000-0000-4000-8000-000000000000" as HostId;
    const parentHostId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" as HostId;
    const catalog = new HostCatalog({
      filename: ":memory:",
      hostName: "snapshot-root",
      hostId: localHostId,
    });
    const service = new HostService({ catalog, instanceId: "snapshot-root" });
    const childCatalog = new HostCatalog({
      filename: ":memory:",
      hostName: "snapshot-child",
      hostId: childHostId,
    });
    const grandchildCatalog = new HostCatalog({
      filename: ":memory:",
      hostName: "snapshot-grandchild",
      hostId: grandchildHostId,
    });
    const childLocal = childCatalog.localHost();
    const grandchildLocal = grandchildCatalog.localHost();
    const { attachment, child } = catalog.attachChild({
      hostId: childLocal.hostId,
      hostBootId: childLocal.hostBootId,
      feedId: childLocal.feedId,
      name: childLocal.name,
      protocolVersion: 2,
      capabilities: childLocal.capabilities,
    });
    const grandchildAttachmentId = newAttachmentId();
    catalog.importChildSnapshotPage(child.hostId, attachment.attachmentId, {
      rootHostId: child.hostId,
      attachmentId: attachment.attachmentId,
      lineageId: attachment.lineageId,
      checkpoint: { feedId: childLocal.feedId, controlCursor: 0 },
      capturedAt: timestamp(),
      hosts: [
        child,
        {
          ...grandchildLocal,
          parentHostId: child.hostId,
          rootHostId: child.hostId,
          attachmentId: grandchildAttachmentId,
          authorityHostId: child.hostId,
          authorityEpochId: child.authorityEpochId,
        },
      ],
      workers: [],
      sessions: [],
      interactions: [],
      metadataOperations: [],
      nextPageToken: null,
    });
    const parentAttachment: HostAttachment = {
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
      parentHostId,
      childHostId: localHostId,
      rootHostId: parentHostId,
      authorityHostId: parentHostId,
      authorityEpochId: newAuthorityEpochId(),
      attachedAt: timestamp(),
    };
    service.applyParentAttachment(parentAttachment);
    const fence: HostLinkFence = {
      hostId: localHostId,
      hostBootId: catalog.localHost().hostBootId,
      attachmentId: parentAttachment.attachmentId,
      lineageId: parentAttachment.lineageId,
    };
    const context = { authenticatedHostId: parentHostId };
    const orderedHostIds: HostId[] = [];
    let pageToken: string | undefined;
    for (;;) {
      const page = service.readSubtreeSnapshot(
        {
          ...fence,
          limit: 1,
          ...(pageToken === undefined ? {} : { pageToken }),
        },
        context,
      );
      orderedHostIds.push(...page.hosts.map((host) => host.hostId));
      if (page.nextPageToken === null) break;
      pageToken = page.nextPageToken;
    }
    expect(orderedHostIds).toEqual([localHostId, childHostId, grandchildHostId]);

    service.close();
    catalog.close();
    childCatalog.close();
    grandchildCatalog.close();
  });

  it.each(["feed", "cursor", "heartbeat"] as const)(
    "resnapshots a child on a %s recovery barrier without dropping its attachment",
    async (discontinuity) => {
      const parentCatalog = new HostCatalog({ filename: ":memory:", hostName: "pump-parent" });
      const childCatalog = new HostCatalog({ filename: ":memory:", hostName: "pump-child" });
      const parentService = new HostService({
        catalog: parentCatalog,
        instanceId: "pump-parent",
      });
      const child = childCatalog.localHost();
      const nestedWorkerRegistration = registration();
      const nestedWorker = childCatalog.registerWorker(nestedWorkerRegistration);
      const [nestedSession] = childCatalog.reconcileInventory(
        inventory(nestedWorkerRegistration),
      );
      if (!nestedSession || nestedSession.runtimeEpoch === null) {
        throw new Error("expected a child snapshot session with an active runtime");
      }
      const preexistingInteraction: InteractionRecord = {
        interactionId: newInteractionId(),
        sessionId: nestedSession.sessionId,
        harness: nestedSession.harness,
        runtimeEpoch: nestedSession.runtimeEpoch,
        requestType: "userInput",
        payload: { question: "Choose a plan" },
        ephemeral: false,
        state: "pending",
        createdAt: timestamp(),
        expiresAt: null,
        resolvedAt: null,
      };
      childCatalog.publishInteraction(preexistingInteraction);
      let fence: HostLinkFence | undefined;
      let currentFeed: FeedId = child.feedId;
      let currentCursor = 0;
      let snapshotCalls = 0;
      let subscriptionCalls = 0;
      let releaseDiscontinuity!: () => void;
      const discontinuityReleased = new Promise<void>((resolve) => {
        releaseDiscontinuity = resolve;
      });
      const connection: ChildHostConnection = {
        hostId: child.hostId,
        hostBootId: child.hostBootId,
        readSubtreeSnapshot: async () => {
          if (!fence) throw new Error("missing child fence");
          snapshotCalls += 1;
          return {
            rootHostId: child.hostId,
            attachmentId: fence.attachmentId,
            lineageId: fence.lineageId,
            checkpoint: { feedId: currentFeed, controlCursor: currentCursor },
            capturedAt: timestamp(),
            hosts: [{ ...child, feedId: currentFeed }],
            workers: [nestedWorker],
            sessions: [nestedSession],
            interactions: [preexistingInteraction],
            metadataOperations: [],
            nextPageToken: null,
          };
        },
        subscribeAggregate: async function* (_cursor, signal) {
          subscriptionCalls += 1;
          if (subscriptionCalls === 1) {
            await discontinuityReleased;
            if (signal?.aborted) return;
            if (discontinuity === "heartbeat") {
              parentCatalog.setChildReachability(child.hostId, "stale");
              yield {
                kind: "heartbeat" as const,
                feedId: currentFeed,
                controlCursor: currentCursor,
              };
            } else {
              if (discontinuity === "feed") {
                currentFeed = newFeedId();
                currentCursor = 0;
              } else {
                currentCursor = 2;
              }
              const discontinuous: FeedControlItem = {
                kind: "control",
                eventId: randomUUID(),
                originHostId: child.hostId,
                feedId: currentFeed,
                cursor: discontinuity === "feed" ? 1 : currentCursor,
                change: {
                  type: "host.presence",
                  hostId: child.hostId,
                  presence: "stale",
                },
              };
              yield discontinuous;
            }
          }
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        },
        listModels: async () => [],
        refreshInventory: async () => {
          throw new Error("unused");
        },
        spawn: async () => {
          throw new Error("unused");
        },
        resume: async () => {
          throw new Error("unused");
        },
        execute: async () => {
          throw new Error("unused");
        },
        readNativeHistory: async () => {
          throw new Error("unused");
        },
        resolveInteraction: async () => {
          throw new Error("unused");
        },
      };
      const attached = await parentService.attachChild(
        {
          hostId: child.hostId,
          hostBootId: child.hostBootId,
          feedId: child.feedId,
          name: child.name,
          protocolVersion: 2,
          capabilities: child.capabilities,
        },
        {
          authenticatedHostId: child.hostId,
          childHostConnection: connection,
        },
      );
      fence = {
        hostId: child.hostId,
        hostBootId: child.hostBootId,
        attachmentId: attached.attachment.attachmentId,
        lineageId: attached.attachment.lineageId,
      };
      await parentService.heartbeatChild(
        { ...fence, checkpoint: { feedId: child.feedId, controlCursor: 0 } },
        { authenticatedHostId: child.hostId },
      );
      expect(snapshotCalls).toBe(1);
      expect(parentCatalog.getInteraction(preexistingInteraction.interactionId)).toEqual(
        preexistingInteraction,
      );
      releaseDiscontinuity();
      await eventually(() => {
        expect(snapshotCalls).toBeGreaterThanOrEqual(2);
        expect(subscriptionCalls).toBeGreaterThanOrEqual(2);
        expect(parentCatalog.getHost(child.hostId)?.presence).toBe("online");
        expect(parentCatalog.getAttachment(child.hostId)).toMatchObject({
          attachmentId: fence!.attachmentId,
          lineageId: fence!.lineageId,
        });
        expect(parentCatalog.getInteraction(preexistingInteraction.interactionId)).toEqual(
          preexistingInteraction,
        );
        expect(parentCatalog.getWorker(nestedWorker.workerId)?.reachability).toBe("reachable");
      });

      parentService.close();
      parentCatalog.close();
      childCatalog.close();
    },
  );

  it("rejects duplicate and cross-subtree interactions before importing a snapshot", async () => {
    const parentCatalog = new HostCatalog({ filename: ":memory:", hostName: "interaction-parent" });
    const childCatalog = new HostCatalog({ filename: ":memory:", hostName: "interaction-child" });
    const siblingCatalog = new HostCatalog({ filename: ":memory:", hostName: "interaction-sibling" });
    const parentService = new HostService({ catalog: parentCatalog, instanceId: "interaction-parent" });
    const child = childCatalog.localHost();
    const sibling = siblingCatalog.localHost();
    const childWorkerRegistration = registration();
    const childWorker = childCatalog.registerWorker(childWorkerRegistration);
    const [childSession] = childCatalog.reconcileInventory(inventory(childWorkerRegistration));
    if (!childSession || childSession.runtimeEpoch === null) throw new Error("expected child session");
    const siblingWorkerRegistration = registration();
    const siblingWorker = siblingCatalog.registerWorker(siblingWorkerRegistration);
    const [siblingSession] = siblingCatalog.reconcileInventory(inventory(siblingWorkerRegistration));
    if (!siblingSession || siblingSession.runtimeEpoch === null) throw new Error("expected sibling session");
    const siblingAttachment = parentCatalog.attachChild({
      hostId: sibling.hostId,
      hostBootId: sibling.hostBootId,
      feedId: sibling.feedId,
      name: sibling.name,
      protocolVersion: 2,
      capabilities: sibling.capabilities,
    });
    parentCatalog.importChildSnapshotPage(sibling.hostId, siblingAttachment.attachment.attachmentId, {
      rootHostId: sibling.hostId,
      attachmentId: siblingAttachment.attachment.attachmentId,
      lineageId: siblingAttachment.attachment.lineageId,
      checkpoint: siblingCatalog.feedCheckpoint(),
      capturedAt: timestamp(),
      hosts: [siblingAttachment.child],
      workers: [siblingWorker],
      sessions: [siblingSession],
      interactions: [],
      metadataOperations: [],
      nextPageToken: null,
    });
    const pending = (session = childSession): InteractionRecord => ({
      interactionId: newInteractionId(),
      sessionId: session.sessionId,
      harness: session.harness,
      runtimeEpoch: session.runtimeEpoch!,
      requestType: "approval",
      payload: { command: "echo snapshot" },
      ephemeral: false,
      state: "pending",
      createdAt: timestamp(),
      expiresAt: null,
      resolvedAt: null,
    });
    let mode: "duplicate" | "sibling" = "duplicate";
    let fence: HostLinkFence | undefined;
    const connection: ChildHostConnection = {
      hostId: child.hostId,
      hostBootId: child.hostBootId,
      readSubtreeSnapshot: async () => {
        if (!fence) throw new Error("missing child fence");
        const interaction = mode === "duplicate" ? pending() : pending(siblingSession);
        return {
          rootHostId: child.hostId,
          attachmentId: fence.attachmentId,
          lineageId: fence.lineageId,
          checkpoint: childCatalog.feedCheckpoint(),
          capturedAt: timestamp(),
          hosts: [child],
          workers: [childWorker],
          sessions: [childSession],
          interactions: mode === "duplicate" ? [interaction, interaction] : [interaction],
          metadataOperations: [],
          nextPageToken: null,
        };
      },
      subscribeAggregate: async function* () {},
      listModels: async () => [],
      refreshInventory: async () => { throw new Error("unused"); },
      spawn: async () => { throw new Error("unused"); },
      resume: async () => { throw new Error("unused"); },
      execute: async () => { throw new Error("unused"); },
      readNativeHistory: async () => { throw new Error("unused"); },
      resolveInteraction: async () => { throw new Error("unused"); },
    };
    const attached = await parentService.attachChild(
      {
        hostId: child.hostId,
        hostBootId: child.hostBootId,
        feedId: child.feedId,
        name: child.name,
        protocolVersion: 2,
        capabilities: child.capabilities,
      },
      { authenticatedHostId: child.hostId, childHostConnection: connection },
    );
    fence = {
      hostId: child.hostId,
      hostBootId: child.hostBootId,
      attachmentId: attached.attachment.attachmentId,
      lineageId: attached.attachment.lineageId,
    };
    await expect(
      parentService.heartbeatChild(
        { ...fence, checkpoint: childCatalog.feedCheckpoint() },
        { authenticatedHostId: child.hostId },
      ),
    ).rejects.toThrowError(HostCoreError);
    expect(parentCatalog.routeForWorker(childWorker.workerId)).toBeNull();

    mode = "sibling";
    await expect(
      parentService.heartbeatChild(
        { ...fence, checkpoint: childCatalog.feedCheckpoint() },
        { authenticatedHostId: child.hostId },
      ),
    ).rejects.toThrowError(HostCoreError);
    expect(parentCatalog.routeForWorker(childWorker.workerId)).toBeNull();

    parentService.close();
    parentCatalog.close();
    childCatalog.close();
    siblingCatalog.close();
  });

  it("does not let a feed-reset snapshot resurrect a resolved interaction", async () => {
    const parentCatalog = new HostCatalog({ filename: ":memory:", hostName: "interaction-parent" });
    const childCatalog = new HostCatalog({ filename: ":memory:", hostName: "interaction-child" });
    const parentService = new HostService({ catalog: parentCatalog, instanceId: "interaction-parent" });
    const child = childCatalog.localHost();
    const workerRegistration = registration();
    const worker = childCatalog.registerWorker(workerRegistration);
    const [session] = childCatalog.reconcileInventory(inventory(workerRegistration));
    if (!session || session.runtimeEpoch === null) throw new Error("expected child session");
    const pending: InteractionRecord = {
      interactionId: newInteractionId(),
      sessionId: session.sessionId,
      harness: session.harness,
      runtimeEpoch: session.runtimeEpoch,
      requestType: "approval",
      payload: { command: "echo monotonic" },
      ephemeral: false,
      state: "pending",
      createdAt: timestamp(),
      expiresAt: null,
      resolvedAt: null,
    };
    let snapshotInteraction = pending;
    let snapshotFeed = child.feedId;
    let releaseReset!: () => void;
    const resetReleased = new Promise<void>((resolve) => { releaseReset = resolve; });
    let subscriptionCalls = 0;
    let fence: HostLinkFence | undefined;
    const connection: ChildHostConnection = {
      hostId: child.hostId,
      hostBootId: child.hostBootId,
      readSubtreeSnapshot: async () => {
        if (!fence) throw new Error("missing child fence");
        return {
          rootHostId: child.hostId,
          attachmentId: fence.attachmentId,
          lineageId: fence.lineageId,
          checkpoint: { feedId: snapshotFeed, controlCursor: 0 },
          capturedAt: timestamp(),
          hosts: [{ ...child, feedId: snapshotFeed }],
          workers: [worker],
          sessions: [session],
          interactions: [snapshotInteraction],
          metadataOperations: [],
          nextPageToken: null,
        };
      },
      subscribeAggregate: async function* (_cursor, signal) {
        subscriptionCalls += 1;
        if (subscriptionCalls === 1) {
          await resetReleased;
          if (signal?.aborted) return;
          yield {
            kind: "streamReset" as const,
            previousFeedId: child.feedId,
            feedId: snapshotFeed,
            controlCursor: 0,
            reason: "feedChanged" as const,
            recovery: "snapshot" as const,
          };
        }
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      listModels: async () => [],
      refreshInventory: async () => { throw new Error("unused"); },
      spawn: async () => { throw new Error("unused"); },
      resume: async () => { throw new Error("unused"); },
      execute: async () => { throw new Error("unused"); },
      readNativeHistory: async () => { throw new Error("unused"); },
      resolveInteraction: async () => { throw new Error("unused"); },
    };
    const attached = await parentService.attachChild(
      {
        hostId: child.hostId,
        hostBootId: child.hostBootId,
        feedId: child.feedId,
        name: child.name,
        protocolVersion: 2,
        capabilities: child.capabilities,
      },
      { authenticatedHostId: child.hostId, childHostConnection: connection },
    );
    fence = {
      hostId: child.hostId,
      hostBootId: child.hostBootId,
      attachmentId: attached.attachment.attachmentId,
      lineageId: attached.attachment.lineageId,
    };
    await parentService.heartbeatChild(
      { ...fence, checkpoint: childCatalog.feedCheckpoint() },
      { authenticatedHostId: child.hostId },
    );
    const resolved: InteractionRecord = {
      ...pending,
      state: "resolved",
      resolution: { approved: true },
      resolvedAt: timestamp(),
    };
    parentCatalog.updateInteraction(resolved);
    snapshotFeed = newFeedId();
    snapshotInteraction = pending;
    releaseReset();
    await eventually(() => expect(subscriptionCalls).toBeGreaterThanOrEqual(2));
    expect(parentCatalog.getInteraction(pending.interactionId)).toEqual(resolved);

    parentService.close();
    parentCatalog.close();
    childCatalog.close();
  });

  it("canonicalizes worker controls instead of accepting host feed envelopes", () => {
    const catalog = new HostCatalog({ filename: ":memory:", hostName: "canonical-host" });
    const service = new HostService({ catalog, instanceId: "canonical-service" });
    const worker = registration();
    service.registerWorker(worker);
    const [session] = service.reconcile(inventory(worker)).sessions;
    if (!session) throw new Error("expected session");
    const before = catalog.controlCursor();
    const injectedEventId = randomUUID();

    expect(
      service.publishWorkerEvent(
        {
          kind: "control",
          eventId: injectedEventId,
          originHostId: catalog.localHost().hostId,
          feedId: catalog.localHost().feedId,
          cursor: 999_999,
          change: { type: "session.upsert", session: { ...session, runtimeStatus: "running" } },
        } as never,
        { authenticatedWorkerId: worker.workerId },
      ),
    ).toEqual({ accepted: true });
    const [canonical] = catalog.controlEventsAfter(before);
    expect(canonical).toMatchObject({
      originHostId: catalog.localHost().hostId,
      feedId: catalog.localHost().feedId,
      cursor: before + 1,
      change: { type: "session.upsert", session: { runtimeStatus: "running" } },
    });
    expect(canonical?.eventId).not.toBe(injectedEventId);

    service.close();
    catalog.close();
  });

  it("disconnects a slow observer when its bounded mailbox overflows", async () => {
    const catalog = new HostCatalog({ filename: ":memory:", hostName: "overflow-host" });
    const hub = new FleetEventHub({
      catalog,
      subscriberBufferSize: 1,
      heartbeatMs: 60_000,
    });
    const cursor = catalog.feedCheckpoint();
    const stream = hub.watchHosts({ ...cursor, native: {} });
    const firstRead = stream.next();
    await Promise.resolve();

    const firstChild = new HostCatalog({ filename: ":memory:", hostName: "first-child" });
    const secondChild = new HostCatalog({ filename: ":memory:", hostName: "second-child" });
    for (const child of [firstChild, secondChild]) {
      const descriptor = child.localHost();
      catalog.attachChild({
        hostId: descriptor.hostId,
        hostBootId: descriptor.hostBootId,
        feedId: descriptor.feedId,
        name: descriptor.name,
        protocolVersion: 2,
        capabilities: descriptor.capabilities,
      });
    }
    await firstRead;
    await expect(stream.next()).rejects.toBeInstanceOf(FleetSubscriberOverflowError);

    await stream.return(undefined).catch(() => undefined);
    hub.close();
    firstChild.close();
    secondChild.close();
    catalog.close();
  });
});
