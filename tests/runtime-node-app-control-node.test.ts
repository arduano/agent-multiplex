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
import { describe, expect, it, vi } from "vitest";

import {
  flushMetadataOutbox,
  refreshAndReconcile,
  register,
  sendHeartbeat,
  type RuntimeNodeControlNodePeer,
} from "../apps/runtime-node/src/main.js";

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
      protocolVersion: 4,
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
