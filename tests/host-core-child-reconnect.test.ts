import { randomUUID } from "node:crypto";

import {
  newRuntimeEpoch,
  newWorkerBootId,
  newWorkerId,
  type HostAttachment,
  type HostLinkFence,
  type InventorySnapshot,
  type WorkerRegistration,
} from "@agent-multiplex/protocol";
import {
  HostCatalog,
  HostService,
  type ChildHostConnection,
  type WorkerConnection,
} from "@agent-multiplex/host-core";
import { describe, expect, it } from "vitest";

const timestamp = (): string => new Date().toISOString();

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

describe("HostService child-host reconnect", () => {
  it("restarts a completed aggregate pump from the next child heartbeat", async () => {
    const parentCatalog = new HostCatalog({ filename: ":memory:", hostName: "parent" });
    const childCatalog = new HostCatalog({ filename: ":memory:", hostName: "child" });
    const parentService = new HostService({ catalog: parentCatalog, instanceId: "parent" });
    const childService = new HostService({ catalog: childCatalog, instanceId: "child" });
    const parentHostId = parentCatalog.localHost().hostId;
    const child = childCatalog.localHost();
    let fence: HostLinkFence | undefined;
    let snapshotCalls = 0;
    let subscriptionCalls = 0;
    const connection: ChildHostConnection = {
      hostId: child.hostId,
      hostBootId: child.hostBootId,
      readSubtreeSnapshot: async (request) => {
        snapshotCalls += 1;
        if (!fence) throw new Error("child attachment fence is not ready");
        return childService.readSubtreeSnapshot(
          { ...fence, ...request, limit: request.limit ?? 500 },
          { authenticatedHostId: parentHostId },
        );
      },
      subscribeAggregate: (cursor, signal) => {
        subscriptionCalls += 1;
        if (subscriptionCalls === 1) {
          return (async function* () {
            return;
          })();
        }
        if (!fence) throw new Error("child attachment fence is not ready");
        return childService.subscribeAggregate(
          { ...fence, cursor },
          { authenticatedHostId: parentHostId },
          signal,
        );
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
    childService.applyParentAttachment(attached.attachment);

    await parentService.heartbeatChild(
      { ...fence, checkpoint: childCatalog.feedCheckpoint() },
      { authenticatedHostId: child.hostId },
    );
    await eventually(() => {
      expect(snapshotCalls).toBe(1);
      expect(subscriptionCalls).toBe(1);
      expect(parentCatalog.getHost(child.hostId)?.presence).toBe("stale");
    });

    await parentService.heartbeatChild(
      { ...fence, checkpoint: childCatalog.feedCheckpoint() },
      { authenticatedHostId: child.hostId },
    );
    await eventually(() => {
      expect(snapshotCalls).toBe(2);
      expect(subscriptionCalls).toBe(2);
      expect(parentCatalog.getHost(child.hostId)?.presence).toBe("online");
    });

    parentService.close();
    childService.close();
    parentCatalog.close();
    childCatalog.close();
  });

  it("resynchronizes and restarts streaming on a same-feed reconnect without changing identity", async () => {
    const parentCatalog = new HostCatalog({ filename: ":memory:", hostName: "parent" });
    const childCatalog = new HostCatalog({ filename: ":memory:", hostName: "child" });
    const parentService = new HostService({ catalog: parentCatalog, instanceId: "parent" });
    const childService = new HostService({ catalog: childCatalog, instanceId: "child" });
    const worker: WorkerRegistration = {
      workerId: newWorkerId(),
      workerBootId: newWorkerBootId(),
      name: "reconnect-worker",
      allowedRoots: ["/work"],
      harnesses: [
        {
          harness: "codex",
          adapterScopeId: "reconnect-codex" as WorkerRegistration["harnesses"][number]["adapterScopeId"],
          available: true,
          capabilities: [{ name: "interactive", experimental: false }],
        },
      ],
      protocolVersion: 2,
    };
    const runtimeEpoch = newRuntimeEpoch();
    const inventory: InventorySnapshot = {
      workerId: worker.workerId,
      generation: randomUUID(),
      complete: true,
      capturedAt: timestamp(),
      sessions: [
        {
          harness: "codex",
          adapterScopeId: worker.harnesses[0]!.adapterScopeId,
          vendorSessionId: "same-feed-native-session",
          cwd: "/work/reconnect",
          availability: "active",
          runtimeStatus: "idle",
          runtimeEpoch,
          lastActivityAt: timestamp(),
        },
      ],
    };
    const workerConnection: WorkerConnection = {
      workerId: worker.workerId,
      workerBootId: worker.workerBootId,
      refreshInventory: async () => inventory,
      listModels: async () => [],
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
    childService.registerWorker(worker, { workerConnection });
    const [childSession] = childService.reconcile(inventory).sessions;
    if (!childSession) throw new Error("expected a child session");

    const parentHostId = parentCatalog.localHost().hostId;
    const childBeforeAttach = childCatalog.localHost();
    let fence: HostLinkFence | undefined;
    let snapshotCalls = 0;
    let subscriptionCalls = 0;
    const parentContext = () => ({ authenticatedHostId: parentHostId });
    const fenced = (): HostLinkFence => {
      if (!fence) throw new Error("child attachment fence is not ready");
      return fence;
    };
    const createConnection = (): ChildHostConnection => ({
      hostId: childBeforeAttach.hostId,
      hostBootId: childBeforeAttach.hostBootId,
      readSubtreeSnapshot: async (request) => {
        snapshotCalls += 1;
        return childService.readSubtreeSnapshot(
          { ...fenced(), ...request, limit: request.limit ?? 500 },
          parentContext(),
        );
      },
      subscribeAggregate: (cursor, signal) => {
        subscriptionCalls += 1;
        return childService.subscribeAggregate(
          { ...fenced(), cursor },
          parentContext(),
          signal,
        );
      },
      listModels: async () => [],
      refreshInventory: async () => inventory,
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
    });
    const attachmentRequest = (previous?: HostAttachment) => ({
      hostId: childBeforeAttach.hostId,
      hostBootId: childBeforeAttach.hostBootId,
      feedId: childBeforeAttach.feedId,
      name: childBeforeAttach.name,
      protocolVersion: 2 as const,
      capabilities: childBeforeAttach.capabilities,
      ...(previous
        ? {
            previousAttachmentId: previous.attachmentId,
            previousLineageId: previous.lineageId,
          }
        : {}),
    });
    const childContext = (connection: ChildHostConnection) => ({
      authenticatedHostId: childBeforeAttach.hostId,
      childHostConnection: connection,
    });

    const firstConnection = createConnection();
    const initial = await parentService.attachChild(
      attachmentRequest(),
      childContext(firstConnection),
    );
    fence = {
      hostId: childBeforeAttach.hostId,
      hostBootId: childBeforeAttach.hostBootId,
      attachmentId: initial.attachment.attachmentId,
      lineageId: initial.attachment.lineageId,
    };
    childService.applyParentAttachment(initial.attachment);
    await parentService.heartbeatChild(
      { ...fence, checkpoint: childCatalog.feedCheckpoint() },
      { authenticatedHostId: childBeforeAttach.hostId },
    );
    await eventually(() => expect(subscriptionCalls).toBe(1));
    expect(snapshotCalls).toBe(1);
    expect(parentService.getSession(childSession.sessionId)?.sessionId).toBe(
      childSession.sessionId,
    );
    const importedFeed = parentCatalog.childCheckpoint(
      childBeforeAttach.hostId,
      initial.attachment.attachmentId,
    );
    expect(importedFeed?.feedId).toBe(childBeforeAttach.feedId);

    parentService.detachChildConnection(firstConnection.hostId, firstConnection.hostBootId);
    expect(parentCatalog.getAttachment(childBeforeAttach.hostId)).toEqual(initial.attachment);
    expect(parentService.getSession(childSession.sessionId)?.sessionId).toBe(
      childSession.sessionId,
    );
    expect(parentCatalog.getHost(childBeforeAttach.hostId)?.presence).toBe("stale");
    expect(parentCatalog.getWorker(worker.workerId)?.reachability).toBe("unreachable");

    const secondConnection = createConnection();
    const reconnected = await parentService.attachChild(
      attachmentRequest(initial.attachment),
      childContext(secondConnection),
    );
    expect(reconnected.attachment).toEqual(initial.attachment);
    expect(reconnected.canonical).toMatchObject({
      hostId: childBeforeAttach.hostId,
      hostBootId: childBeforeAttach.hostBootId,
      feedId: childBeforeAttach.feedId,
      attachmentId: initial.attachment.attachmentId,
      lineageId: initial.attachment.lineageId,
    });
    childService.applyParentAttachment(reconnected.attachment);
    await parentService.heartbeatChild(
      { ...fence, checkpoint: childCatalog.feedCheckpoint() },
      { authenticatedHostId: childBeforeAttach.hostId },
    );
    await eventually(() => {
      expect(snapshotCalls).toBe(2);
      expect(subscriptionCalls).toBe(2);
      expect(parentCatalog.getHost(childBeforeAttach.hostId)?.presence).toBe("online");
      expect(parentCatalog.getWorker(worker.workerId)?.reachability).toBe("reachable");
    });
    expect(parentCatalog.getAttachment(childBeforeAttach.hostId)).toEqual(initial.attachment);
    expect(parentService.getSession(childSession.sessionId)).toMatchObject({
      sessionId: childSession.sessionId,
      workerId: worker.workerId,
    });

    const childCurrent = childService.getSession(childSession.sessionId);
    if (!childCurrent) throw new Error("child session disappeared during reconnect");
    expect(
      childService.publishWorkerEvent(
        {
          kind: "control",
          change: {
            type: "session.upsert",
            session: { ...childCurrent, runtimeStatus: "running", lastSeenAt: timestamp() },
          },
        },
        { authenticatedWorkerId: worker.workerId },
      ),
    ).toEqual({ accepted: true });
    await eventually(() =>
      expect(parentService.getSession(childSession.sessionId)?.runtimeStatus).toBe("running"),
    );

    const observerCursor = parentCatalog.feedCheckpoint();
    const observerAbort = new AbortController();
    const observer = parentService.watchSessions(
      {
        sessions: [childSession.sessionId],
        includeNative: true,
        cursor: { ...observerCursor, native: {} },
      },
      observerAbort.signal,
    );
    const nativeRead = (async () => {
      for (;;) {
        const item = await observer.next();
        if (item.done || item.value.kind === "native") return item;
      }
    })();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      childService.publishWorkerEvent(
        {
          kind: "native",
          sessionId: childSession.sessionId,
          harness: "codex",
          runtimeEpoch,
          sequence: 0,
          nativeType: "turn/started",
          payload: { afterReconnect: true },
          ephemeral: false,
        },
        { authenticatedWorkerId: worker.workerId },
      ),
    ).toEqual({ accepted: true });
    await expect(
      Promise.race([
        nativeRead,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("timed out waiting for reconnected native stream")), 2_000),
        ),
      ]),
    ).resolves.toMatchObject({
      done: false,
      value: {
        kind: "native",
        sessionId: childSession.sessionId,
        nativeType: "turn/started",
        payload: { afterReconnect: true },
      },
    });
    observerAbort.abort();
    await observer.return(undefined);

    parentService.close();
    childService.close();
    parentCatalog.close();
    childCatalog.close();
  });
});
