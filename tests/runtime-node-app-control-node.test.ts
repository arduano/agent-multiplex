import {
  adapterScopeIdSchema,
  emptyMetadataSnapshot,
  newAuthorityEpochId,
  newControlNodeId,
  newOperationId,
  newRealmId,
  newRuntimeEpoch,
  newSessionId,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  type InventorySnapshot,
  type MetadataOperationRecord,
  type MetadataPatch,
  type RuntimeNodeRegistration,
} from "@arduano/agent-multiplex-protocol";
import type { RuntimeNodeStore } from "@arduano/agent-multiplex-runtime-node-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  flushMetadataOutbox,
  refreshAndReconcile,
  register,
  sendHeartbeat,
  superviseControlNodeConnection,
  type RuntimeNodeControlNodePeer,
} from "../apps/runtime-node/src/main.js";
import { PersistentControlNodeLocator } from "../apps/runtime-node/src/control-node-locator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function maintenanceFixture() {
  const runtimeNodeId = newRuntimeNodeId();
  const runtimeNodeBootId = newRuntimeNodeBootId();
  const inventory: InventorySnapshot = {
    runtimeNodeId,
    generation: newRuntimeEpoch(),
    complete: true,
    capturedAt: new Date().toISOString(),
    sessions: [],
  };
  const registration: RuntimeNodeRegistration = {
    runtimeNodeId,
    runtimeNodeBootId,
    name: "maintenance test",
    allowedRoots: ["/tmp"],
    harnesses: [],
    launchProfiles: [],
    protocolVersion: 5,
  };
  const patch: MetadataPatch = {
    operationId: newOperationId(),
    sessionId: newSessionId(),
    expectedAuthority: {
      realmId: newRealmId(),
      controlNodeId: newControlNodeId(),
      epochId: newAuthorityEpochId(),
    },
    set: { "agent.state": "queued" },
  };
  const service = {
    runtimeNodeId,
    describe: vi.fn(async () => registration),
    refreshInventory: vi.fn(async () => inventory),
    applyCanonicalSessions: vi.fn(),
    metadataOutbox: vi.fn(() => [patch]),
    settleMetadataOutbox: vi.fn(),
  };
  const makePeer = () => {
    const register = vi.fn(async () => ({ accepted: true }));
    const heartbeat = vi.fn(async () => ({ accepted: true }));
    const reconcile = vi.fn(async () => ({ sessions: [], controlCursor: 1 }));
    const pushOutbox = vi.fn(async (): Promise<MetadataOperationRecord[]> => []);
    const peer = {
      rpc: { ingress: {
        runtimeNodes: {
          register: { mutate: register },
          heartbeat: { mutate: heartbeat },
          reconcile: { mutate: reconcile },
        },
        metadata: { pushOutbox: { mutate: pushOutbox } },
      } },
    } as unknown as RuntimeNodeControlNodePeer;
    return { peer, register, heartbeat, reconcile, pushOutbox };
  };
  const first = makePeer();
  const second = makePeer();
  const node = { connect: vi.fn(async () => first.peer) };
  const locator = new PersistentControlNodeLocator({
    getSetting: () => undefined,
    setSetting: vi.fn(),
  } as unknown as RuntimeNodeStore, {
    endpointId: "disposable-maintenance-endpoint",
    locator: { kind: "ticket", ticket: "disposable-maintenance-locator" },
  });
  const abort = new AbortController();
  const start = () => superviseControlNodeConnection(
    node, service, runtimeNodeBootId, locator,
    { heartbeatMs: 1_000, inventoryRefreshMs: 2_000, metadataFlushMs: 1_000, reconnectMaxMs: 1 },
    abort.signal,
  );
  return { inventory, patch, service, first, second, node, abort, start };
}

describe("runtime-node independent maintenance", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps heartbeats independent of initial stalled inventory and metadata, with bounded in-flight slots", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = maintenanceFixture();
    const inventoryRead = deferred<InventorySnapshot>();
    const metadataDelivery = deferred<MetadataOperationRecord[]>();
    fixture.service.refreshInventory.mockImplementationOnce(() => inventoryRead.promise);
    fixture.first.pushOutbox.mockImplementationOnce(() => metadataDelivery.promise);
    const running = fixture.start();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(fixture.first.heartbeat).toHaveBeenCalledTimes(35);
    expect(fixture.service.refreshInventory).toHaveBeenCalledTimes(1);
    expect(fixture.first.pushOutbox).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(2);
    inventoryRead.resolve(fixture.inventory);
    metadataDelivery.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.first.reconcile).not.toHaveBeenCalled();
    expect(fixture.service.applyCanonicalSessions).not.toHaveBeenCalled();
    expect(fixture.service.settleMetadataOutbox).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_001);
    expect(fixture.service.refreshInventory).toHaveBeenCalledTimes(2);
    expect(fixture.first.reconcile).toHaveBeenCalledTimes(1);
    expect(fixture.first.pushOutbox.mock.calls[1]).toEqual(fixture.first.pushOutbox.mock.calls[0]);
    fixture.abort.abort();
    await running;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces discovery across reconnects and never submits the retired connection's result", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = maintenanceFixture();
    const inventoryRead = deferred<InventorySnapshot>();
    fixture.service.refreshInventory.mockImplementationOnce(() => inventoryRead.promise);
    fixture.first.heartbeat.mockResolvedValueOnce({ accepted: false });
    fixture.node.connect.mockResolvedValueOnce(fixture.first.peer).mockResolvedValue(fixture.second.peer);
    const running = fixture.start();
    await vi.advanceTimersByTimeAsync(1_005);
    expect(fixture.second.register).toHaveBeenCalledTimes(1);
    expect(fixture.service.refreshInventory).toHaveBeenCalledTimes(1);
    inventoryRead.resolve(fixture.inventory);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.first.reconcile).not.toHaveBeenCalled();
    expect(fixture.second.reconcile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.service.refreshInventory).toHaveBeenCalledTimes(2);
    expect(fixture.second.reconcile).toHaveBeenCalledTimes(1);
    fixture.abort.abort();
    await running;
  });

  it("does not apply late reconciliation or metadata acknowledgements after reconnect", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = maintenanceFixture();
    const reconcile = deferred<{ sessions: []; controlCursor: number }>();
    const metadataDelivery = deferred<MetadataOperationRecord[]>();
    fixture.first.reconcile.mockImplementationOnce(() => reconcile.promise);
    fixture.first.pushOutbox.mockImplementationOnce(() => metadataDelivery.promise);
    fixture.first.heartbeat.mockRejectedValueOnce(new Error("connection lost"));
    fixture.node.connect.mockResolvedValueOnce(fixture.first.peer).mockResolvedValue(fixture.second.peer);
    const running = fixture.start();
    await vi.advanceTimersByTimeAsync(1_005);
    expect(fixture.first.reconcile).toHaveBeenCalledTimes(1);
    expect(fixture.second.register).toHaveBeenCalledTimes(1);
    expect(fixture.second.reconcile).not.toHaveBeenCalled();
    expect(fixture.second.pushOutbox).not.toHaveBeenCalled();
    reconcile.resolve({ sessions: [], controlCursor: 1 });
    metadataDelivery.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.service.applyCanonicalSessions).not.toHaveBeenCalled();
    expect(fixture.service.settleMetadataOutbox).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.service.applyCanonicalSessions).toHaveBeenCalledTimes(1);
    expect(fixture.second.pushOutbox.mock.calls[0]).toEqual(fixture.first.pushOutbox.mock.calls[0]);
    fixture.abort.abort();
    await running;
  });

  it("returns promptly on abort and discards a late native discovery result", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fixture = maintenanceFixture();
    const inventoryRead = deferred<InventorySnapshot>();
    fixture.service.refreshInventory.mockImplementationOnce(() => inventoryRead.promise);
    const running = fixture.start();
    await vi.advanceTimersByTimeAsync(1);
    fixture.abort.abort();
    await running;
    inventoryRead.resolve(fixture.inventory);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.first.reconcile).not.toHaveBeenCalled();
    expect(fixture.service.applyCanonicalSessions).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renews registration after a live reconciliation rejection", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = maintenanceFixture();
    fixture.first.reconcile.mockRejectedValueOnce(new Error("stale registration"));
    fixture.node.connect.mockResolvedValueOnce(fixture.first.peer).mockResolvedValue(fixture.second.peer);
    const running = fixture.start();
    await vi.advanceTimersByTimeAsync(5);
    expect(fixture.second.register).toHaveBeenCalledTimes(1);
    expect(fixture.second.reconcile).toHaveBeenCalledTimes(1);
    fixture.abort.abort();
    await running;
  });

  it("retries local discovery and durable outbox failures without disconnecting the heartbeat", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = maintenanceFixture();
    fixture.service.refreshInventory.mockRejectedValueOnce(new Error("native discovery unavailable"));
    fixture.first.pushOutbox.mockRejectedValueOnce(new Error("metadata acknowledgement unavailable"));
    const running = fixture.start();
    await vi.advanceTimersByTimeAsync(2_001);
    expect(fixture.node.connect).toHaveBeenCalledTimes(1);
    expect(fixture.first.heartbeat).toHaveBeenCalledTimes(2);
    expect(fixture.service.refreshInventory).toHaveBeenCalledTimes(2);
    expect(fixture.first.reconcile).toHaveBeenCalledTimes(1);
    expect(fixture.first.pushOutbox.mock.calls[1]).toEqual(fixture.first.pushOutbox.mock.calls[0]);
    fixture.abort.abort();
    await running;
  });
});

describe("runtime-node control-node RPC path", () => {
  it("uses ingress for registration, heartbeat, reconciliation, and metadata", async () => {
    const runtimeNodeId = newRuntimeNodeId();
    const runtimeNodeBootId = newRuntimeNodeBootId();
    const sessionId = newSessionId();
    const registration: RuntimeNodeRegistration = {
      runtimeNodeId,
      runtimeNodeBootId,
      name: "composite path runtime node",
      allowedRoots: ["/tmp"],
      harnesses: [],
      launchProfiles: [],
      protocolVersion: 5,
    };
    const inventory: InventorySnapshot = {
      runtimeNodeId,
      generation: newRuntimeEpoch(),
      complete: true,
      capturedAt: new Date().toISOString(),
      sessions: [],
    };
    const authority = {
      realmId: newRealmId(),
      controlNodeId: newControlNodeId(),
      epochId: newAuthorityEpochId(),
    };
    const patch: MetadataPatch = {
      operationId: newOperationId(),
      sessionId,
      expectedAuthority: authority,
      set: { "agent.state": "queued" },
    };
    const timestamp = new Date().toISOString();
    const operation: MetadataOperationRecord = {
      operationId: patch.operationId,
      sessionId,
      patch,
      status: "queued",
      canonical: { revision: 0, values: {}, keyRevisions: {} },
      optimistic: {
        revision: 0,
        values: { "agent.state": "queued" },
        keyRevisions: {},
      },
      originControlNodeId: authority.controlNodeId,
      authority,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const registerMutation = vi.fn(async () => ({ accepted: true }));
    const heartbeatMutation = vi.fn(async () => ({
      accepted: true,
      controlCursor: 7,
    }));
    const reconcileMutation = vi.fn(async () => ({ sessions: [], controlCursor: 8 }));
    const pushOutboxMutation = vi.fn(async () => [operation]);
    const peer = {
      rpc: {
        ingress: {
          runtimeNodes: {
            register: { mutate: registerMutation },
            heartbeat: { mutate: heartbeatMutation },
            reconcile: { mutate: reconcileMutation },
          },
          metadata: {
            pushOutbox: { mutate: pushOutboxMutation },
          },
        },
      },
    } as unknown as RuntimeNodeControlNodePeer;

    await register(peer, { describe: async () => registration });
    await sendHeartbeat(peer, { runtimeNodeId }, runtimeNodeBootId);
    const applyCanonicalSessions = vi.fn();
    await refreshAndReconcile(peer, {
      refreshInventory: async () => inventory,
      applyCanonicalSessions,
    }, runtimeNodeBootId);
    const settleMetadataOutbox = vi.fn();
    await flushMetadataOutbox(peer, {
      runtimeNodeId,
      metadataOutbox: () => [patch],
      settleMetadataOutbox,
    }, runtimeNodeBootId);

    expect(registerMutation).toHaveBeenCalledWith(registration);
    expect(heartbeatMutation).toHaveBeenCalledWith({ runtimeNodeId, runtimeNodeBootId });
    expect(reconcileMutation).toHaveBeenCalledWith({
      runtimeNodeId,
      runtimeNodeBootId,
      snapshot: inventory,
    });
    expect(applyCanonicalSessions).toHaveBeenCalledWith([]);
    expect(pushOutboxMutation).toHaveBeenCalledWith({
      runtimeNodeId,
      runtimeNodeBootId,
      patches: [patch],
    });
    expect(settleMetadataOutbox).toHaveBeenCalledWith([operation]);
  });

  it("rejects canonical sessions that were not present in the submitted inventory", async () => {
    const runtimeNodeId = newRuntimeNodeId();
    const runtimeNodeBootId = newRuntimeNodeBootId();
    const inventory: InventorySnapshot = {
      runtimeNodeId,
      generation: newRuntimeEpoch(),
      complete: true,
      capturedAt: new Date().toISOString(),
      sessions: [],
    };
    const timestamp = new Date().toISOString();
    const injected = {
      sessionId: newSessionId(),
      runtimeNodeId,
      harness: "codex" as const,
      adapterScopeId: adapterScopeIdSchema.parse("codex-injected"),
      vendorSessionId: "injected-native-session",
      bindingRevision: 1,
      runtimeEpoch: null,
      cwd: "/tmp",
      availability: "resumable" as const,
      runtimeStatus: "idle" as const,
      metadata: emptyMetadataSnapshot(),
      metadataAuthority: {
        realmId: newRealmId(),
        controlNodeId: newControlNodeId(),
        epochId: newAuthorityEpochId(),
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSeenAt: timestamp,
    };
    const peer = {
      rpc: {
        ingress: {
          runtimeNodes: {
            reconcile: {
              mutate: vi.fn(async () => ({ sessions: [injected], controlCursor: 1 })),
            },
          },
        },
      },
    } as unknown as RuntimeNodeControlNodePeer;
    const applyCanonicalSessions = vi.fn();

    await expect(refreshAndReconcile(peer, {
      refreshInventory: async () => inventory,
      applyCanonicalSessions,
    }, runtimeNodeBootId)).rejects.toThrow("was not submitted");
    expect(applyCanonicalSessions).not.toHaveBeenCalled();
  });

  it("accepts a canonical subset while launch-to-native correlation is deferred", async () => {
    const runtimeNodeId = newRuntimeNodeId();
    const runtimeNodeBootId = newRuntimeNodeBootId();
    const inventory: InventorySnapshot = {
      runtimeNodeId,
      generation: newRuntimeEpoch(),
      complete: true,
      capturedAt: new Date().toISOString(),
      sessions: [{
        harness: "codex",
        adapterScopeId: adapterScopeIdSchema.parse("codex-deferred"),
        vendorSessionId: "deferred-native-session",
        cwd: "/tmp",
        availability: "active",
        runtimeStatus: "idle",
        runtimeEpoch: newRuntimeEpoch(),
      }],
    };
    const peer = {
      rpc: {
        ingress: {
          runtimeNodes: {
            reconcile: {
              mutate: vi.fn(async () => ({ sessions: [], controlCursor: 1 })),
            },
          },
        },
      },
    } as unknown as RuntimeNodeControlNodePeer;
    const applyCanonicalSessions = vi.fn();

    await expect(refreshAndReconcile(peer, {
      refreshInventory: async () => inventory,
      applyCanonicalSessions,
    }, runtimeNodeBootId)).resolves.toBeUndefined();
    expect(applyCanonicalSessions).toHaveBeenCalledWith([]);
  });
});
