import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  newOperationId,
  newCommandId,
  newInteractionId,
  newRuntimeEpoch,
  newSessionId,
  newWorkerBootId,
  newWorkerId,
  type InventorySnapshot,
  type CommandRecord,
  type InteractionRecord,
  type ResumeCommand,
  type SpawnCommand,
  type WorkerRegistration,
} from "@agent-multiplex/protocol";
import { describe, expect, it } from "vitest";

import {
  FleetEventHub,
  FleetSubscriberOverflowError,
  HostCatalog,
  HostCoreError,
  HostService,
  type WorkerConnection,
} from "@agent-multiplex/host-core";

const registration = (): WorkerRegistration => ({
  workerId: newWorkerId(),
  workerBootId: newWorkerBootId(),
  name: "test-worker",
  allowedRoots: ["/work"],
  harnesses: [
    {
      harness: "codex",
      adapterScopeId: "codex-default" as WorkerRegistration["harnesses"][number]["adapterScopeId"],
      available: true,
      capabilities: [],
    },
  ],
  protocolVersion: 2,
});

const inventory = (worker: WorkerRegistration, vendorSessionId = "thread-1"): InventorySnapshot => ({
  workerId: worker.workerId,
  generation: newRuntimeEpoch(),
  complete: true,
  capturedAt: new Date().toISOString(),
  sessions: [
    {
      harness: "codex",
      adapterScopeId: worker.harnesses[0]!.adapterScopeId,
      vendorSessionId,
      cwd: "/work/project",
      availability: "active",
      runtimeStatus: "idle",
      runtimeEpoch: newRuntimeEpoch(),
      lastActivityAt: new Date().toISOString(),
    },
  ],
});

describe("HostCatalog", () => {
  it("persists catalog/control state and applies idempotent metadata CAS", () => {
    const filename = join(mkdtempSync(join(tmpdir(), "agent-multiplex-host-")), "host.sqlite");
    const worker = registration();
    const first = new HostCatalog({ filename });
    expect(statSync(filename).mode & 0o777).toBe(0o600);
    first.registerWorker(worker, "endpoint-1");
    const [session] = first.reconcileInventory(inventory(worker));
    expect(session).toBeDefined();

    const operationId = newOperationId();
    const accepted = first.patchMetadata({
      operationId,
      sessionId: session!.sessionId,
      set: { "agent.title": "compiler investigation" },
      ifKeyRevision: { "agent.title": null },
    });
    expect(accepted.accepted).toBe(true);
    if (!accepted.accepted) throw new Error("expected accepted patch");
    expect(accepted.snapshot.revision).toBe(1);
    expect(accepted.snapshot.values["agent.title"]).toBe("compiler investigation");

    const duplicate = first.patchMetadata({
      operationId,
      sessionId: session!.sessionId,
      set: { "agent.title": "compiler investigation" },
      ifKeyRevision: { "agent.title": null },
    });
    expect(duplicate.accepted && duplicate.deduplicated).toBe(true);

    expect(() =>
      first.patchMetadata({
        operationId,
        sessionId: session!.sessionId,
        set: { "agent.title": "different payload" },
      }),
    ).toThrowError(HostCoreError);

    const conflict = first.patchMetadata({
      operationId: newOperationId(),
      sessionId: session!.sessionId,
      set: { "agent.title": "lost update" },
      ifKeyRevision: { "agent.title": null },
    });
    expect(conflict.accepted).toBe(false);
    first.close();

    const reopened = new HostCatalog({ filename });
    expect(reopened.getMetadata(session!.sessionId).values["agent.title"]).toBe(
      "compiler investigation",
    );
    expect(reopened.getWorker(worker.workerId)?.presence).toBe("stale");
    expect(reopened.controlEventsAfter(0).some((item) => item.change.type === "metadata.changed")).toBe(
      true,
    );
    reopened.close();
  });

  it("fences nonterminal commands and interactions on worker boot change", () => {
    const catalog = new HostCatalog({ filename: ":memory:" });
    const worker = registration();
    catalog.registerWorker(worker);
    const [session] = catalog.reconcileInventory(inventory(worker));
    expect(session).toBeDefined();
    const timestamp = new Date().toISOString();
    const commandId = newCommandId();
    catalog.acceptCommand({
      commandId,
      payloadHash: "1234567890abcdef",
      sessionId: session!.sessionId,
      workerId: worker.workerId,
      state: "started",
      request: { command: "test" },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    catalog.registerWorker({ ...worker, workerBootId: newWorkerBootId() });
    expect(catalog.getCommand(commandId)?.state).toBe("outcomeUnknown");
    catalog.close();
  });

  it("retains per-key deletion tombstones and rejects stale metadata writers", () => {
    const catalog = new HostCatalog({ filename: ":memory:" });
    const worker = registration();
    catalog.registerWorker(worker);
    const [session] = catalog.reconcileInventory(inventory(worker));
    const set = catalog.patchMetadata({
      operationId: newOperationId(),
      sessionId: session!.sessionId,
      set: { "dashboard.owner": "alice" },
      ifKeyRevision: { "dashboard.owner": null },
    });
    expect(set.accepted).toBe(true);

    const removeOperationId = newOperationId();
    const removed = catalog.patchMetadata({
      operationId: removeOperationId,
      sessionId: session!.sessionId,
      remove: ["dashboard.owner"],
      ifKeyRevision: { "dashboard.owner": 1 },
    });
    expect(removed.accepted).toBe(true);
    if (!removed.accepted) throw new Error("expected accepted removal");
    expect(removed.snapshot.values).not.toHaveProperty("dashboard.owner");
    expect(removed.snapshot.keyRevisions["dashboard.owner"]).toBe(2);

    const stale = catalog.patchMetadata({
      operationId: newOperationId(),
      sessionId: session!.sessionId,
      set: { "dashboard.owner": "bob" },
      ifKeyRevision: { "dashboard.owner": 1 },
    });
    expect(stale).toMatchObject({
      accepted: false,
      conflicts: [{ key: "dashboard.owner", expectedRevision: 1, actualRevision: 2 }],
    });
    const duplicate = catalog.patchMetadata({
      operationId: removeOperationId,
      sessionId: session!.sessionId,
      remove: ["dashboard.owner"],
      ifKeyRevision: { "dashboard.owner": 1 },
    });
    expect(duplicate.accepted && duplicate.deduplicated).toBe(true);
    catalog.close();
  });

  it("keeps one logical session identity across inventory refresh and disappearance", () => {
    const catalog = new HostCatalog({ filename: ":memory:" });
    const worker = registration();
    catalog.registerWorker(worker);
    const [first] = catalog.reconcileInventory(inventory(worker, "stable-thread"));
    const [second] = catalog.reconcileInventory(inventory(worker, "stable-thread"));
    expect(second!.sessionId).toBe(first!.sessionId);
    expect(second!.bindingRevision).toBe(first!.bindingRevision);

    catalog.reconcileInventory({
      workerId: worker.workerId,
      generation: newRuntimeEpoch(),
      complete: true,
      capturedAt: new Date().toISOString(),
      sessions: [],
    });
    expect(catalog.getSession(first!.sessionId)?.availability).toBe("unavailable");

    const [returned] = catalog.reconcileInventory(inventory(worker, "stable-thread"));
    expect(returned!.sessionId).toBe(first!.sessionId);
    expect(returned!.bindingRevision).toBe(first!.bindingRevision);
    catalog.close();
  });
});

describe("FleetEventHub", () => {
  it("bounds slow observer queues and requires cursor-based reconnection", async () => {
    const catalog = new HostCatalog({ filename: ":memory:" });
    const worker = registration();
    catalog.registerWorker(worker);
    const [session] = catalog.reconcileInventory(inventory(worker));
    const hub = new FleetEventHub({
      catalog,
      subscriberBufferSize: 2,
      heartbeatMs: 100_000,
    });
    const stream = hub.attach({
      sessions: "all",
      includeNative: true,
      cursor: { ...catalog.feedCheckpoint(), native: {} },
    });

    // Start the live wait, then publish faster than this observer consumes.
    const first = stream.next();
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let sequence = 0; sequence < 4; sequence += 1) {
      hub.publish({
        kind: "native",
        sessionId: session!.sessionId,
        harness: "codex",
        runtimeEpoch: session!.runtimeEpoch!,
        sequence,
        nativeType: "test/overflow",
        payload: { sequence },
        ephemeral: true,
      });
    }
    expect((await first).done).toBe(false);
    await expect(stream.next()).rejects.toBeInstanceOf(FleetSubscriberOverflowError);

    hub.close();
    catalog.close();
  });

  it("replays buffered native events to a fresh attachment with no native cursor", async () => {
    const catalog = new HostCatalog({ filename: ":memory:" });
    const worker = registration();
    catalog.registerWorker(worker);
    const [session] = catalog.reconcileInventory(inventory(worker));
    const runtimeEpoch = session!.runtimeEpoch!;
    const hub = new FleetEventHub({ catalog, heartbeatMs: 5 });
    for (let sequence = 0; sequence <= 1; sequence += 1) {
      hub.publish({
        kind: "native",
        sessionId: session!.sessionId,
        harness: "codex",
        runtimeEpoch,
        sequence,
        nativeType: "test/event",
        payload: { sequence },
        ephemeral: false,
      });
    }

    const abort = new AbortController();
    const stream = hub.attach(
      {
        sessions: [session!.sessionId],
        includeNative: true,
        cursor: { ...catalog.feedCheckpoint(), native: {} },
      },
      abort.signal,
    );
    const first = await stream.next();
    const second = await stream.next();
    abort.abort();
    await stream.return(undefined);

    expect(first).toMatchObject({
      done: false,
      value: { kind: "native", sessionId: session!.sessionId, sequence: 0 },
    });
    expect(second).toMatchObject({
      done: false,
      value: { kind: "native", sessionId: session!.sessionId, sequence: 1 },
    });
    hub.close();
    catalog.close();
  });

  it("signals a native gap when a requested cursor has left the ring", async () => {
    const catalog = new HostCatalog({ filename: ":memory:" });
    const worker = registration();
    catalog.registerWorker(worker);
    const [session] = catalog.reconcileInventory(inventory(worker));
    const runtimeEpoch = session!.runtimeEpoch!;
    const hub = new FleetEventHub({ catalog, nativeRingSize: 2, heartbeatMs: 100_000 });
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      hub.publish({
        kind: "native",
        sessionId: session!.sessionId,
        harness: "codex",
        runtimeEpoch,
        sequence,
        nativeType: "test/event",
        payload: { sequence },
        ephemeral: false,
      });
    }
    const abort = new AbortController();
    const stream = hub.attach(
      {
        sessions: [session!.sessionId],
        includeNative: true,
        cursor: {
          ...catalog.feedCheckpoint(),
          native: { [session!.sessionId]: { runtimeEpoch, sequence: 0 } },
        },
      },
      abort.signal,
    );
    const first = await stream.next();
    expect(first.value?.kind).toBe("nativeGap");
    abort.abort();
    await stream.return(undefined);
    hub.close();
    catalog.close();
  });
});

describe("HostService", () => {
  it("rejects early session events without throwing so the worker can replay them", () => {
    const catalog = new HostCatalog({ filename: ":memory:" });
    const worker = registration();
    const service = new HostService({ catalog, instanceId: "test-host" });
    service.registerWorker(worker);
    const sessionId = newSessionId();
    const runtimeEpoch = newRuntimeEpoch();
    const context = { authenticatedWorkerId: worker.workerId };

    expect(service.publishWorkerEvent({
      kind: "native",
      sessionId,
      harness: "codex",
      runtimeEpoch,
      sequence: 0,
      nativeType: "turn/started",
      payload: {},
      ephemeral: false,
    }, context)).toEqual({ accepted: false });
    expect(service.publishWorkerEvent({
      kind: "control",
      cursor: 0,
      change: {
        type: "interaction.changed",
        interaction: {
          interactionId: newInteractionId(),
          sessionId,
          harness: "codex",
          runtimeEpoch,
          requestType: "approval",
          payload: {},
          ephemeral: false,
          state: "pending",
          createdAt: new Date().toISOString(),
          expiresAt: null,
          resolvedAt: null,
        },
      },
    }, context)).toEqual({ accepted: false });
    expect(service.publishWorkerEvent({
      kind: "heartbeat",
      controlCursor: 0,
    }, context)).toEqual({ accepted: true });

    service.close();
    catalog.close();
  });

  it("converges replayed interaction resolutions and deduplicates client retries", async () => {
    const catalog = new HostCatalog({ filename: ":memory:" });
    const worker = registration();
    let nativeResolutionCalls = 0;
    let resolved!: InteractionRecord;
    const connection = {
      workerId: worker.workerId,
      workerBootId: worker.workerBootId,
      resolveInteraction: async (): Promise<InteractionRecord> => {
        nativeResolutionCalls += 1;
        return resolved;
      },
    } as WorkerConnection;
    const service = new HostService({ catalog, instanceId: "test-host" });
    service.registerWorker(worker, { workerConnection: connection });
    const [session] = service.reconcile(inventory(worker)).sessions;
    if (!session?.runtimeEpoch) throw new Error("expected an active test session");
    const pending: InteractionRecord = {
      interactionId: newInteractionId(),
      sessionId: session.sessionId,
      harness: "codex",
      runtimeEpoch: session.runtimeEpoch,
      nativeRequestId: "native-approval-1",
      requestType: "approval",
      payload: { command: "test" },
      ephemeral: false,
      state: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: null,
      resolvedAt: null,
    };
    service.publishInteraction(pending);
    resolved = {
      ...pending,
      state: "resolved",
      resolution: { approved: true, details: { first: 1, second: 2 } },
      resolvedAt: new Date().toISOString(),
    };

    await expect(
      service.resolveInteraction({
        interactionId: pending.interactionId,
        sessionId: pending.sessionId,
        harness: pending.harness,
        response: { details: { second: 2, first: 1 }, approved: true },
      }),
    ).resolves.toEqual(resolved);
    expect(nativeResolutionCalls).toBe(1);

    await expect(
      service.resolveInteraction({
        interactionId: pending.interactionId,
        sessionId: pending.sessionId,
        harness: pending.harness,
        response: resolved.resolution!,
      }),
    ).resolves.toEqual(resolved);
    expect(nativeResolutionCalls).toBe(1);
    await expect(
      service.resolveInteraction({
        interactionId: pending.interactionId,
        sessionId: pending.sessionId,
        harness: pending.harness,
        response: { approved: false },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // A reconnect replay of the terminal worker event is idempotent and keeps
    // the host terminal even if an older pending replay follows it.
    expect(
      service.publishWorkerEvent({
        kind: "control",
        cursor: 0,
        change: { type: "interaction.changed", interaction: resolved },
      }),
    ).toEqual({ accepted: true });
    expect(
      service.publishWorkerEvent({
        kind: "control",
        cursor: 0,
        change: { type: "interaction.changed", interaction: pending },
      }),
    ).toEqual({ accepted: true });
    expect(catalog.getInteraction(pending.interactionId)).toEqual(resolved);

    service.close();
    catalog.close();
  });

  it("returns the current p2p reachability ticket on heartbeat", () => {
    const catalog = new HostCatalog({ filename: ":memory:" });
    const worker = registration();
    let ticket = "ticket-one";
    const service = new HostService({
      catalog,
      instanceId: "test-host",
      p2pTicket: () => ticket,
    });
    service.registerWorker(worker);

    expect(service.heartbeat(worker.workerId, worker.workerBootId)).toMatchObject({
      accepted: true,
      p2pTicket: "ticket-one",
    });
    ticket = "ticket-two";
    expect(service.heartbeat(worker.workerId, worker.workerBootId)).toMatchObject({
      accepted: true,
      p2pTicket: "ticket-two",
    });

    service.close();
    catalog.close();
  });

  it("does not journal an outcome-unknown command when its worker is known offline", async () => {
    const catalog = new HostCatalog({ filename: ":memory:" });
    const worker = registration();
    const service = new HostService({ catalog, instanceId: "test-host" });
    service.registerWorker(worker);
    const command: SpawnCommand = {
      commandId: newCommandId(),
      payloadHash: "1234567890abcdef",
      sessionId: newSessionId(),
      workerId: worker.workerId,
      request: { harness: "codex", cwd: "/work/project" },
    };

    await expect(service.spawn(command)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(service.getCommand(command.commandId)).toBeNull();

    service.close();
    catalog.close();
  });

  it("rejects ingress payloads from an endpoint other than the enrolled worker key", () => {
    const catalog = new HostCatalog({ filename: ":memory:" });
    const worker = registration();
    const service = new HostService({ catalog, instanceId: "test-host" });
    service.registerWorker(worker, { endpointId: "endpoint-a" });

    expect(() =>
      service.heartbeat(worker.workerId, worker.workerBootId, {
        endpointId: "endpoint-b",
      }),
    ).toThrowError(HostCoreError);
    expect(() =>
      service.reconcile(inventory(worker), { endpointId: "endpoint-b" }),
    ).toThrowError(HostCoreError);

    service.close();
    catalog.close();
  });

  it("does not let a stale non-worker enrollment re-register as a worker", () => {
    const catalog = new HostCatalog({ filename: ":memory:" });
    const worker = registration();
    const service = new HostService({ catalog, instanceId: "test-host" });
    catalog.enrollPeer("reused-endpoint", "observer", "reused-endpoint");

    expect(() =>
      service.registerWorker(worker, { endpointId: "reused-endpoint" }),
    ).toThrowError(HostCoreError);
    expect(catalog.getWorker(worker.workerId)).toBeNull();

    service.close();
    catalog.close();
  });

  it("starts transport ingestion only after worker registration is canonical", () => {
    const catalog = new HostCatalog({ filename: ":memory:" });
    const worker = registration();
    let callbackObservedCanonical = false;
    const connection = {
      workerId: worker.workerId,
      workerBootId: worker.workerBootId,
    } as WorkerConnection;
    const service = new HostService({
      catalog,
      instanceId: "test-host",
      onWorkerConnectionAttached: (attached) => {
        callbackObservedCanonical = catalog.getWorker(worker.workerId)?.presence === "online";
        expect(attached).toBe(connection);
      },
    });

    service.registerWorker(worker, { workerConnection: connection });

    expect(callbackObservedCanonical).toBe(true);
    service.close();
    catalog.close();
  });

  it("dispatches a spawn once and binds the worker inventory to the preallocated session", async () => {
    const catalog = new HostCatalog({ filename: ":memory:" });
    const worker = registration();
    const snapshot = inventory(worker, "spawned-thread");
    let spawnCalls = 0;
    const connection: WorkerConnection = {
      workerId: worker.workerId,
      workerBootId: worker.workerBootId,
      refreshInventory: async () => snapshot,
      listModels: async () => [],
      spawn: async (command): Promise<CommandRecord> => {
        spawnCalls += 1;
        const timestamp = new Date().toISOString();
        return {
          commandId: command.commandId,
          payloadHash: command.payloadHash,
          sessionId: command.sessionId,
          workerId: command.workerId,
          state: "succeeded",
          request: command,
          result: { sessionId: command.sessionId, vendorSessionId: "spawned-thread" },
          createdAt: timestamp,
          updatedAt: timestamp,
        };
      },
      resume: async () => {
        throw new Error("not used");
      },
      execute: async () => {
        throw new Error("not used");
      },
      readNativeHistory: async () => {
        throw new Error("not used");
      },
      resolveInteraction: async () => {
        throw new Error("not used");
      },
    };
    const service = new HostService({ catalog, instanceId: "test-host" });
    service.registerWorker(worker, { workerConnection: connection });
    const command: SpawnCommand = {
      commandId: newCommandId(),
      payloadHash: "1234567890abcdef",
      sessionId: newSessionId(),
      workerId: worker.workerId,
      request: { harness: "codex", cwd: "/work/project" },
      metadata: { "agent.title": "spawned session" },
    };
    const result = await service.spawn(command);
    expect(result.state).toBe("succeeded");
    expect(service.getSession(command.sessionId)?.vendorSessionId).toBe("spawned-thread");
    expect(service.getMetadata(command.sessionId).values["agent.title"]).toBe("spawned session");
    expect((await service.spawn(command)).state).toBe("succeeded");
    expect(spawnCalls).toBe(1);
    await expect(
      service.spawn({ ...command, payloadHash: "fedcba0987654321" }),
    ).rejects.toMatchObject({ code: "PAYLOAD_MISMATCH" });
    service.close();
    catalog.close();
  });

  it("repairs a terminal spawn binding after refresh failure without replaying metadata", async () => {
    const filename = join(
      mkdtempSync(join(tmpdir(), "agent-multiplex-lifecycle-terminal-")),
      "host.sqlite",
    );
    const worker = registration();
    const snapshot = inventory(worker, "durable-thread");
    let refreshCalls = 0;
    let spawnCalls = 0;
    const connection: WorkerConnection = {
      workerId: worker.workerId,
      workerBootId: worker.workerBootId,
      refreshInventory: async () => {
        refreshCalls += 1;
        if (refreshCalls === 1) throw new Error("inventory temporarily unavailable");
        return snapshot;
      },
      listModels: async () => [],
      spawn: async (command): Promise<CommandRecord> => {
        spawnCalls += 1;
        const timestamp = new Date().toISOString();
        return {
          commandId: command.commandId,
          payloadHash: command.payloadHash,
          sessionId: command.sessionId,
          workerId: command.workerId,
          state: "succeeded",
          request: command,
          result: { sessionId: command.sessionId, vendorSessionId: "durable-thread" },
          createdAt: timestamp,
          updatedAt: timestamp,
        };
      },
      resume: async () => {
        throw new Error("not used");
      },
      execute: async () => {
        throw new Error("not used");
      },
      readNativeHistory: async () => {
        throw new Error("not used");
      },
      resolveInteraction: async () => {
        throw new Error("not used");
      },
    };
    const command: SpawnCommand = {
      commandId: newCommandId(),
      payloadHash: "terminal-refresh-failure",
      sessionId: newSessionId(),
      workerId: worker.workerId,
      request: { harness: "codex", cwd: "/work/project" },
      metadata: { "agent.title": "durable metadata" },
    };

    const firstCatalog = new HostCatalog({ filename });
    const firstService = new HostService({ catalog: firstCatalog, instanceId: "first-host" });
    firstService.registerWorker(worker, { workerConnection: connection });
    await expect(firstService.spawn(command)).resolves.toMatchObject({ state: "succeeded" });
    expect(firstCatalog.getSession(command.sessionId)).toBeNull();
    firstService.close();
    firstCatalog.close();

    const recoveredCatalog = new HostCatalog({ filename });
    const recoveredService = new HostService({
      catalog: recoveredCatalog,
      instanceId: "recovered-host",
    });
    recoveredService.registerWorker(worker, { workerConnection: connection });
    await expect(recoveredService.spawn(command)).resolves.toMatchObject({ state: "succeeded" });
    expect(spawnCalls).toBe(1);
    expect(recoveredService.getSession(command.sessionId)).toMatchObject({
      vendorSessionId: "durable-thread",
    });
    expect(recoveredService.getMetadata(command.sessionId)).toMatchObject({
      revision: 1,
      values: { "agent.title": "durable metadata" },
    });

    await recoveredService.spawn(command);
    expect(spawnCalls).toBe(1);
    expect(recoveredService.getMetadata(command.sessionId).revision).toBe(1);
    recoveredService.close();
    recoveredCatalog.close();
  });

  it("does not allocate a competing logical session when inventory races a spawn result", async () => {
    const catalog = new HostCatalog({ filename: ":memory:" });
    const worker = registration();
    const snapshot = inventory(worker, "racing-thread");
    let service: HostService;
    let sessionsObservedDuringSpawn = -1;
    const connection: WorkerConnection = {
      workerId: worker.workerId,
      workerBootId: worker.workerBootId,
      refreshInventory: async () => snapshot,
      listModels: async () => [],
      spawn: async (command): Promise<CommandRecord> => {
        service.reconcile(snapshot);
        sessionsObservedDuringSpawn = service.listSessions().length;
        const timestamp = new Date().toISOString();
        return {
          commandId: command.commandId,
          payloadHash: command.payloadHash,
          sessionId: command.sessionId,
          workerId: command.workerId,
          state: "succeeded",
          request: command,
          result: { sessionId: command.sessionId, vendorSessionId: "racing-thread" },
          createdAt: timestamp,
          updatedAt: timestamp,
        };
      },
      resume: async () => {
        throw new Error("not used");
      },
      execute: async () => {
        throw new Error("not used");
      },
      readNativeHistory: async () => {
        throw new Error("not used");
      },
      resolveInteraction: async () => {
        throw new Error("not used");
      },
    };
    service = new HostService({ catalog, instanceId: "test-host" });
    service.registerWorker(worker, { workerConnection: connection });
    const command: SpawnCommand = {
      commandId: newCommandId(),
      payloadHash: "inventory-races-spawn",
      sessionId: newSessionId(),
      workerId: worker.workerId,
      request: { harness: "codex", cwd: "/work/project" },
    };

    await expect(service.spawn(command)).resolves.toMatchObject({ state: "succeeded" });
    expect(sessionsObservedDuringSpawn).toBe(0);
    expect(service.listSessions()).toHaveLength(1);
    expect(service.getSession(command.sessionId)).toMatchObject({
      vendorSessionId: "racing-thread",
    });

    service.close();
    catalog.close();
  });

  it("fences resume before dispatch when the vendor session has another logical owner", async () => {
    const catalog = new HostCatalog({ filename: ":memory:" });
    const worker = registration();
    let resumeCalls = 0;
    const connection: WorkerConnection = {
      workerId: worker.workerId,
      workerBootId: worker.workerBootId,
      refreshInventory: async () => inventory(worker, "owned-thread"),
      listModels: async () => [],
      spawn: async () => {
        throw new Error("not used");
      },
      resume: async () => {
        resumeCalls += 1;
        throw new Error("resume must be fenced before dispatch");
      },
      execute: async () => {
        throw new Error("not used");
      },
      readNativeHistory: async () => {
        throw new Error("not used");
      },
      resolveInteraction: async () => {
        throw new Error("not used");
      },
    };
    const service = new HostService({ catalog, instanceId: "test-host" });
    service.registerWorker(worker, { workerConnection: connection });
    const [owner] = service.reconcile(inventory(worker, "owned-thread")).sessions;
    const command: ResumeCommand = {
      commandId: newCommandId(),
      payloadHash: "resume-native-collision",
      sessionId: newSessionId(),
      workerId: worker.workerId,
      request: { harness: "codex", vendorSessionId: "owned-thread" },
    };

    expect(owner).toBeDefined();
    await expect(service.resume(command)).rejects.toMatchObject({ code: "FENCED" });
    expect(resumeCalls).toBe(0);
    expect(service.getCommand(command.commandId)).toBeNull();

    service.close();
    catalog.close();
  });

  it("finishes lifecycle repair when an outcome-unknown command is recovered from the worker", async () => {
    const filename = join(
      mkdtempSync(join(tmpdir(), "agent-multiplex-lifecycle-recovered-")),
      "host.sqlite",
    );
    const worker = registration();
    const command: SpawnCommand = {
      commandId: newCommandId(),
      payloadHash: "recovered-worker-result",
      sessionId: newSessionId(),
      workerId: worker.workerId,
      request: { harness: "codex", cwd: "/work/project" },
      metadata: { "work.item": "ABC-123" },
    };
    const timestamp = new Date().toISOString();
    const interruptedCatalog = new HostCatalog({ filename });
    interruptedCatalog.registerWorker(worker);
    interruptedCatalog.acceptCommand(
      {
        commandId: command.commandId,
        payloadHash: command.payloadHash,
        sessionId: command.sessionId,
        workerId: command.workerId,
        state: "started",
        request: command,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      command,
    );
    interruptedCatalog.close();

    const catalog = new HostCatalog({ filename });
    expect(catalog.getCommand(command.commandId)?.state).toBe("outcomeUnknown");
    let spawnCalls = 0;
    let getCommandCalls = 0;
    const connection: WorkerConnection = {
      workerId: worker.workerId,
      workerBootId: worker.workerBootId,
      refreshInventory: async () => inventory(worker, "recovered-thread"),
      listModels: async () => [],
      spawn: async () => {
        spawnCalls += 1;
        throw new Error("a recovered command must not be dispatched again");
      },
      resume: async () => {
        throw new Error("not used");
      },
      execute: async () => {
        throw new Error("not used");
      },
      readNativeHistory: async () => {
        throw new Error("not used");
      },
      resolveInteraction: async () => {
        throw new Error("not used");
      },
      getCommand: async (): Promise<CommandRecord> => {
        getCommandCalls += 1;
        const recoveredAt = new Date().toISOString();
        return {
          commandId: command.commandId,
          payloadHash: command.payloadHash,
          sessionId: command.sessionId,
          workerId: command.workerId,
          state: "succeeded",
          request: command,
          result: { sessionId: command.sessionId, vendorSessionId: "recovered-thread" },
          createdAt: timestamp,
          updatedAt: recoveredAt,
        };
      },
    };
    const service = new HostService({ catalog, instanceId: "recovered-host" });
    service.registerWorker(worker, { workerConnection: connection });

    await expect(service.spawn(command)).resolves.toMatchObject({ state: "succeeded" });
    expect(getCommandCalls).toBe(1);
    expect(spawnCalls).toBe(0);
    expect(service.getSession(command.sessionId)).toMatchObject({
      vendorSessionId: "recovered-thread",
    });
    expect(service.getMetadata(command.sessionId).values["work.item"]).toBe("ABC-123");
    service.close();
    catalog.close();
  });
});
