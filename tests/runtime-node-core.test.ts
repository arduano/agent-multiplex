import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  packNativePayload,
  newAuthorityEpochId,
  newCommandId,
  newControlNodeId,
  newLaunchId,
  newOperationId,
  newRealmId,
  newRuntimeEpoch,
  newSessionId,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  type AdapterScopeId,
  type AuthorityRef,
  type CommandRecord,
  type HarnessCatalogEntry,
  type HarnessCommand,
  type HarnessResumeOptions,
  type HarnessSessionSettings,
  type HarnessSpawnOptions,
  type JsonValue,
  type JsonObject,
  type LaunchId,
  type LaunchRecord,
  type LaunchRequest,
  type MetadataOperationRecord,
  type MetadataPatch,
  type MetadataSnapshot,
  type NativeHistoryRequest,
  type NativeHistoryResult,
  type NativeInventoryItem,
  type NativeModel,
  type RuntimeEpoch,
  type RuntimeNodeId,
  type SessionRecord,
  type SessionId,
  type SessionRuntimeStatus,
} from "@arduano/agent-multiplex-protocol";
import {
  AllowedPathPolicy,
  AdapterOutcomeUnknownError,
  PathPolicyError,
  RuntimeNodeEventHub,
  RuntimeNodeProtocolError,
  RuntimeNodeService,
  RuntimeNodeStore,
  createRuntimeNodeRouter,
  type AdapterEvent,
  type AdapterSession,
  type AgentAdapter,
} from "@arduano/agent-multiplex-runtime-node-core";
import { describe, expect, it } from "vitest";

describe("AllowedPathPolicy", () => {
  it("canonicalizes allowed paths and rejects relative, outside, and symlink escapes", async () => {
    const base = mkdtempSync(join(tmpdir(), "agent-multiplex-paths-"));
    const root = join(base, "root");
    const project = join(root, "project");
    const outside = join(base, "outside");
    const escape = join(root, "escape");
    mkdirSync(project, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, escape, "dir");

    const policy = new AllowedPathPolicy([root]);
    await expect(policy.validate(project)).resolves.toBe(realpathSync(project));
    await expect(policy.validate("project")).rejects.toBeInstanceOf(PathPolicyError);
    await expect(policy.validate(outside)).rejects.toBeInstanceOf(PathPolicyError);
    await expect(policy.validate(escape)).rejects.toBeInstanceOf(PathPolicyError);
  });
});

describe("RuntimeNodeStore", () => {
  it.each(["received", "started"] as const)(
    "turns %s commands interrupted by a runtime node restart into outcomeUnknown",
    (state) => {
    const filename = join(
      mkdtempSync(join(tmpdir(), "agent-multiplex-runtime-node-store-")),
      "runtime-node.sqlite",
    );
    const commandId = newCommandId();
    const runtimeNodeId = newRuntimeNodeId();
    const timestamp = new Date().toISOString();
    const started: CommandRecord = {
      commandId,
      payloadHash: "1234567890abcdef",
      sessionId: newSessionId(),
      runtimeNodeId,
      state,
      request: { type: "test" },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const first = new RuntimeNodeStore(filename);
    expect(statSync(filename).mode & 0o777).toBe(0o600);
    first.putCommand(started);
    first.close();

    const reopened = new RuntimeNodeStore(filename);
    expect(reopened.getCommand(commandId)).toMatchObject({
      state: "outcomeUnknown",
      error: expect.stringContaining("requires reconciliation"),
    });
    reopened.close();
    },
  );
});

describe("runtime node metadata operation receipts", () => {
  it("keeps same-authority reconciliation monotonic and preserves runtime-owned liveness", async () => {
    const fixture = await createMetadataRuntimeNode();
    const current = {
      ...requiredSession(fixture),
      runtimeStatus: "running" as const,
      availability: "active" as const,
      metadata: metadataSnapshot(5, { "agent.state": "newest" }),
    };
    fixture.store.putSession(current);
    const stale = {
      ...current,
      runtimeStatus: "stopped" as const,
      availability: "unavailable" as const,
      metadataAuthority: fixture.authority,
      metadata: metadataSnapshot(4, { "agent.state": "stale" }),
    } satisfies SessionRecord;

    fixture.service.applyCanonicalSessions([stale]);

    expect(fixture.store.getSession(fixture.sessionId)).toMatchObject({
      runtimeStatus: "running",
      availability: "active",
      metadata: current.metadata,
    });
    expect(() => fixture.service.applyCanonicalSessions([{
      ...stale,
      metadata: metadataSnapshot(5, { "agent.state": "divergent" }),
    }])).toThrow("divergent metadata at revision 5");
    fixture.service.applyCanonicalSessions([{
      ...stale,
      metadata: metadataSnapshot(6, { "agent.state": "accepted" }),
    }]);
    expect(fixture.store.getSession(fixture.sessionId)).toMatchObject({
      runtimeStatus: "running",
      availability: "active",
      metadata: metadataSnapshot(6, { "agent.state": "accepted" }),
    });

    await fixture.service.close();
    fixture.store.close();
  });

  it("starts a fresh metadata revision domain after an authority transition", async () => {
    const fixture = await createMetadataRuntimeNode();
    const canonical = metadataSnapshot(8, { "agent.state": "old authority" });
    fixture.store.putSession({ ...requiredSession(fixture), metadata: canonical });
    const transferredPatch: MetadataPatch = {
      operationId: newOperationId(),
      sessionId: fixture.sessionId,
      expectedAuthority: fixture.authority,
      set: { "agent.state": "transferred overlay" },
    };
    fixture.service.enqueueMetadata(transferredPatch);
    fixture.service.settleMetadataOutbox([metadataOperationRecord({
      patch: transferredPatch,
      status: "queued",
      canonical,
      optimistic: metadataSnapshot(8, { "agent.state": "transferred overlay" }),
    })]);
    const pendingPatch: MetadataPatch = {
      operationId: newOperationId(),
      sessionId: fixture.sessionId,
      expectedAuthority: fixture.authority,
      set: { "agent.note": "untransferred overlay" },
    };
    fixture.service.enqueueMetadata(pendingPatch);
    const replacementAuthority = authorityRef();
    const replacement = metadataSnapshot(0, { "agent.state": "new authority" });

    fixture.service.applyCanonicalSessions([{
      ...requiredSession(fixture),
      metadataAuthority: replacementAuthority,
      metadata: replacement,
    }]);

    expect(fixture.service.getMetadata(fixture.sessionId)).toEqual(replacement);
    expect(fixture.service.metadataOutbox()).toEqual([pendingPatch]);
    expect(fixture.service.listMetadataOperations({ status: "queued" })).toHaveLength(1);

    const replacementPatch: MetadataPatch = {
      operationId: newOperationId(),
      sessionId: fixture.sessionId,
      expectedAuthority: replacementAuthority,
      set: { "agent.note": "new authority overlay" },
    };
    fixture.service.enqueueMetadata(replacementPatch);
    expect(fixture.service.metadataOutbox()).toEqual([pendingPatch, replacementPatch]);
    expect(fixture.service.getMetadata(fixture.sessionId)).toEqual({
      ...replacement,
      values: {
        "agent.state": "new authority",
        "agent.note": "new authority overlay",
      },
    });

    await fixture.service.close();
    fixture.store.close();
  });

  it("rejects a control-node reconciliation that rewrites a native binding", async () => {
    const fixture = await createMetadataRuntimeNode();
    const current = requiredSession(fixture);

    expect(() => fixture.service.applyCanonicalSessions([{
      ...current,
      metadataAuthority: fixture.authority,
      vendorSessionId: "spoofed-native-session",
    }])).toThrow("changed the runtime-owned native binding");
    expect(() => fixture.service.applyCanonicalSessions([{
      ...current,
      metadataAuthority: fixture.authority,
      sessionId: newSessionId(),
    }])).toThrow("rebound native session");
    expect(fixture.store.listSessions()).toEqual([current]);

    await fixture.service.close();
    fixture.store.close();
  });

  it("durably transfers a queued patch while keeping its optimistic view visible", async () => {
    const filename = join(
      mkdtempSync(join(tmpdir(), "agent-multiplex-metadata-receipt-")),
      "runtime-node.sqlite",
    );
    const fixture = await createMetadataRuntimeNode(filename);
    const canonical = metadataSnapshot(3, { "agent.state": "canonical" });
    fixture.store.putSession({
      ...requiredSession(fixture),
      metadata: canonical,
    });
    const patch: MetadataPatch = {
      operationId: newOperationId(),
      sessionId: fixture.sessionId,
      expectedAuthority: fixture.authority,
      set: { "agent.state": "optimistic", "agent.phase": "queued" },
    };
    const optimistic: MetadataSnapshot = {
      ...canonical,
      values: {
        "agent.state": "optimistic",
        "agent.phase": "queued",
      },
    };
    fixture.service.enqueueMetadata(patch);

    const queued = metadataOperationRecord({
      patch,
      status: "queued",
      canonical,
      optimistic,
    });
    fixture.service.settleMetadataOutbox([queued]);

    expect(fixture.service.metadataOutbox()).toEqual([]);
    expect(fixture.service.getMetadataOperation(patch.operationId)).toEqual(queued);
    expect(fixture.store.getSession(fixture.sessionId)?.metadata).toEqual(canonical);
    expect(fixture.service.getMetadata(fixture.sessionId)).toEqual(optimistic);

    await fixture.service.close();
    fixture.store.close();

    const reopenedStore = new RuntimeNodeStore(filename);
    const reopenedService = new RuntimeNodeService({
      store: reopenedStore,
      runtimeNodeId: fixture.runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "reopened metadata runtime node",
      allowedRoots: [fixture.root],
      adapters: [new FakeAdapter()],
    });
    expect(reopenedService.getMetadataOperation(patch.operationId)).toEqual(queued);
    expect(reopenedService.metadataOutbox()).toEqual([]);
    expect(reopenedStore.getSession(fixture.sessionId)?.metadata).toEqual(canonical);
    expect(reopenedService.getMetadata(fixture.sessionId)).toEqual(optimistic);

    await reopenedService.close();
    reopenedStore.close();
  });

  it("persists an accepted receipt and advances canonical metadata", async () => {
    const fixture = await createMetadataRuntimeNode();
    const initial = metadataSnapshot(1, { "agent.state": "old" });
    fixture.store.putSession({ ...requiredSession(fixture), metadata: initial });
    const patch: MetadataPatch = {
      operationId: newOperationId(),
      sessionId: fixture.sessionId,
      expectedAuthority: fixture.authority,
      set: { "agent.state": "accepted" },
    };
    const canonical = metadataSnapshot(2, { "agent.state": "accepted" });
    fixture.service.enqueueMetadata(patch);
    const accepted = metadataOperationRecord({
      patch,
      status: "accepted",
      canonical,
    });

    fixture.service.settleMetadataOutbox([accepted]);

    expect(fixture.service.metadataOutbox()).toEqual([]);
    expect(fixture.service.getMetadata(fixture.sessionId)).toEqual(canonical);
    expect(fixture.store.getSession(fixture.sessionId)?.metadata).toEqual(canonical);
    expect(fixture.service.getMetadataOperation(patch.operationId)).toEqual(accepted);

    await fixture.service.close();
    fixture.store.close();
  });

  it.each(["accepted", "conflicted"] as const)(
    "replaces a transferred queued receipt when the control node later pushes %s settlement",
    async (status) => {
    const fixture = await createMetadataRuntimeNode();
    const initial = metadataSnapshot(2, { "agent.state": "old" });
    fixture.store.putSession({ ...requiredSession(fixture), metadata: initial });
    const patch: MetadataPatch = {
      operationId: newOperationId(),
      sessionId: fixture.sessionId,
      expectedAuthority: fixture.authority,
      set: { "agent.state": status },
    };
    fixture.service.enqueueMetadata(patch);
    const queued = metadataOperationRecord({
      patch,
      status: "queued",
      canonical: initial,
      optimistic: metadataSnapshot(2, { "agent.state": status }),
    });
    fixture.service.settleMetadataOutbox([queued]);
    const { optimistic: _optimistic, ...queuedBase } = queued;
    const terminal: MetadataOperationRecord = {
      ...queuedBase,
      status,
      canonical: status === "accepted"
        ? metadataSnapshot(3, { "agent.state": status })
        : initial,
      ...(status === "conflicted"
        ? {
            conflicts: [{
              key: "agent.state",
              expectedRevision: 1,
              actualRevision: 2,
              actualValue: "old",
            }],
          }
        : {}),
      updatedAt: new Date(Date.now() + 1).toISOString(),
    };

    expect(fixture.service.applyMetadataSettlement(terminal)).toEqual(terminal);
    expect(fixture.service.applyMetadataSettlement(terminal)).toEqual(terminal);
    expect(fixture.service.getMetadataOperation(patch.operationId)).toEqual(terminal);
    expect(fixture.service.getMetadata(fixture.sessionId)).toEqual(terminal.canonical);
    expect(fixture.service.listMetadataOperations({ status: "queued" })).toEqual([]);

    await fixture.service.close();
    fixture.store.close();
    },
  );

  it("applies a client-originated authority operation without a local queued receipt", async () => {
    const fixture = await createMetadataRuntimeNode();
    const patch: MetadataPatch = {
      operationId: newOperationId(),
      sessionId: fixture.sessionId,
      expectedAuthority: fixture.authority,
      set: { "agent.state": "from-client" },
    };
    const accepted = metadataOperationRecord({
      patch,
      status: "accepted",
      canonical: metadataSnapshot(1, { "agent.state": "from-client" }),
    });

    expect(fixture.service.getMetadataOperation(patch.operationId)).toBeUndefined();
    expect(fixture.service.applyMetadataSettlement(accepted)).toEqual(accepted);
    expect(fixture.service.applyMetadataSettlement(accepted)).toEqual(accepted);
    expect(fixture.service.getMetadataOperation(patch.operationId)).toEqual(accepted);
    expect(fixture.service.getMetadata(fixture.sessionId)).toEqual(accepted.canonical);

    const stale = metadataOperationRecord({
      patch: {
        ...patch,
        operationId: newOperationId(),
        expectedAuthority: authorityRef(),
      },
      status: "accepted",
      canonical: metadataSnapshot(2, { "agent.state": "forged" }),
    });
    expect(() => fixture.service.applyMetadataSettlement(stale)).toThrow(
      "stale or unrelated authority",
    );

    await fixture.service.close();
    fixture.store.close();
  });

  it("establishes the authority when initial spawn metadata settles before reconciliation", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-early-settlement-"));
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "early settlement runtime node",
      allowedRoots: [root],
      adapters: [new FakeAdapter()],
    });
    const sessionId = newSessionId();
    await launchDirectWorkspace(service, {
      launchId: newLaunchId(),
      payloadHash: "early-settlement-spawn",
      sessionId,
      runtimeNodeId,
      harness: "codex",
      input: { cwd: root },
      metadata: { "agent.title": "spawn metadata" },
    });
    const authority = authorityRef();
    const patch: MetadataPatch = {
      operationId: newOperationId(),
      sessionId,
      expectedAuthority: authority,
      set: { "agent.title": "spawn metadata" },
    };
    const accepted = metadataOperationRecord({
      patch,
      status: "accepted",
      canonical: metadataSnapshot(1, { "agent.title": "spawn metadata" }),
    });

    expect(store.getSession(sessionId)?.metadataAuthority).toBeUndefined();
    expect(service.applyMetadataSettlement(accepted)).toEqual(accepted);
    expect(store.getSession(sessionId)).toMatchObject({
      metadataAuthority: authority,
      metadata: accepted.canonical,
    });
    expect(service.applyMetadataSettlement(accepted)).toEqual(accepted);

    await service.close();
    store.close();
  });

  it("settles an outbox response already delivered over the reverse channel", async () => {
    const fixture = await createMetadataRuntimeNode();
    const patch: MetadataPatch = {
      operationId: newOperationId(),
      sessionId: fixture.sessionId,
      expectedAuthority: fixture.authority,
      set: { "agent.state": "raced" },
    };
    fixture.service.enqueueMetadata(patch);
    const accepted = metadataOperationRecord({
      patch,
      status: "accepted",
      canonical: metadataSnapshot(1, { "agent.state": "raced" }),
    });

    // Authority settlement delivery is independent from the push-outbox RPC
    // response and can win that race.
    expect(fixture.service.applyMetadataSettlement(accepted)).toEqual(accepted);
    expect(fixture.service.metadataOutbox()).toEqual([patch]);
    expect(() => fixture.service.settleMetadataOutbox([accepted])).not.toThrow();
    expect(fixture.service.metadataOutbox()).toEqual([]);
    expect(fixture.service.getMetadataOperation(patch.operationId)).toEqual(accepted);

    await fixture.service.close();
    fixture.store.close();
  });

  it("consumes a stale queued acknowledgement after terminal delivery wins the race", async () => {
    const fixture = await createMetadataRuntimeNode();
    const initial = metadataSnapshot(0, {});
    const patch: MetadataPatch = {
      operationId: newOperationId(),
      sessionId: fixture.sessionId,
      expectedAuthority: fixture.authority,
      set: { "agent.state": "terminal-won" },
    };
    fixture.service.enqueueMetadata(patch);
    const accepted = metadataOperationRecord({
      patch,
      status: "accepted",
      canonical: metadataSnapshot(1, { "agent.state": "terminal-won" }),
    });
    const queued: MetadataOperationRecord = {
      ...accepted,
      status: "queued",
      canonical: initial,
      optimistic: accepted.canonical,
      updatedAt: accepted.createdAt,
    };

    expect(fixture.service.applyMetadataSettlement(accepted)).toEqual(accepted);
    expect(fixture.service.metadataOutbox()).toEqual([patch]);
    expect(() => fixture.service.settleMetadataOutbox([{
      ...queued,
      originControlNodeId: newControlNodeId(),
    }])).toThrow("changed metadata operation");
    expect(fixture.service.metadataOutbox()).toEqual([patch]);
    expect(fixture.service.getMetadataOperation(patch.operationId)).toEqual(accepted);
    expect(() => fixture.service.settleMetadataOutbox([queued])).not.toThrow();
    expect(fixture.service.metadataOutbox()).toEqual([]);
    expect(fixture.service.getMetadataOperation(patch.operationId)).toEqual(accepted);
    expect(fixture.service.getMetadata(fixture.sessionId)).toEqual(accepted.canonical);

    await fixture.service.close();
    fixture.store.close();
  });

  it("persists conflict details and removes the rejected optimistic effect", async () => {
    const fixture = await createMetadataRuntimeNode();
    const canonical = metadataSnapshot(5, { "agent.state": "server" });
    fixture.store.putSession({ ...requiredSession(fixture), metadata: canonical });
    const patch: MetadataPatch = {
      operationId: newOperationId(),
      sessionId: fixture.sessionId,
      expectedAuthority: fixture.authority,
      set: { "agent.state": "runtime node" },
      ifKeyRevision: { "agent.state": 4 },
    };
    fixture.service.enqueueMetadata(patch);
    expect(fixture.service.getMetadata(fixture.sessionId).values["agent.state"]).toBe(
      "runtime node",
    );
    const conflicted = metadataOperationRecord({
      patch,
      status: "conflicted",
      canonical,
      conflicts: [
        {
          key: "agent.state",
          expectedRevision: 4,
          actualRevision: 5,
          actualValue: "server",
        },
      ],
    });

    fixture.service.settleMetadataOutbox([conflicted]);

    expect(fixture.service.metadataOutbox()).toEqual([]);
    expect(fixture.service.getMetadata(fixture.sessionId)).toEqual(canonical);
    expect(fixture.service.getMetadataOperation(patch.operationId)).toEqual(conflicted);
    expect(fixture.service.listMetadataOperations({ status: "conflicted" })).toEqual([
      conflicted,
    ]);

    await fixture.service.close();
    fixture.store.close();
  });

  it("does not regress a newer canonical snapshot when an older receipt arrives", async () => {
    const fixture = await createMetadataRuntimeNode();
    const newest = metadataSnapshot(5, { "agent.state": "newest" });
    fixture.store.putSession({ ...requiredSession(fixture), metadata: newest });
    const patch: MetadataPatch = {
      operationId: newOperationId(),
      sessionId: fixture.sessionId,
      expectedAuthority: fixture.authority,
      set: { "agent.note": "late receipt" },
    };
    fixture.service.enqueueMetadata(patch);
    const olderReceipt = metadataOperationRecord({
      patch,
      status: "accepted",
      canonical: metadataSnapshot(4, { "agent.state": "older" }),
    });

    fixture.service.settleMetadataOutbox([olderReceipt]);

    expect(fixture.store.getSession(fixture.sessionId)?.metadata).toEqual(newest);
    expect(fixture.service.getMetadata(fixture.sessionId)).toEqual(newest);
    expect(fixture.service.getMetadataOperation(patch.operationId)).toEqual(
      olderReceipt,
    );

    await fixture.service.close();
    fixture.store.close();
  });

  it("rejects metadata operations fenced to another authority", async () => {
    const fixture = await createMetadataRuntimeNode();
    const stalePatch: MetadataPatch = {
      operationId: newOperationId(),
      sessionId: fixture.sessionId,
      expectedAuthority: authorityRef(),
      set: { "agent.state": "stale" },
    };

    expect(() => fixture.service.enqueueMetadata(stalePatch)).toThrow(
      "stale or unrelated authority",
    );
    expect(fixture.service.metadataOutbox()).toEqual([]);

    await fixture.service.close();
    fixture.store.close();
  });

  it("deduplicates an identical metadata operation and rejects ID reuse", async () => {
    const fixture = await createMetadataRuntimeNode();
    const patch: MetadataPatch = {
      operationId: newOperationId(),
      sessionId: fixture.sessionId,
      expectedAuthority: fixture.authority,
      set: { "agent.state": "once" },
    };

    fixture.service.enqueueMetadata(patch);
    fixture.service.enqueueMetadata({ ...patch, set: { "agent.state": "once" } });
    expect(fixture.service.metadataOutbox()).toEqual([patch]);
    expect(() =>
      fixture.service.enqueueMetadata({
        ...patch,
        set: { "agent.state": "different" },
      }),
    ).toThrow("already used with another patch");

    await fixture.service.close();
    fixture.store.close();
  });

  it("rolls back every acknowledgement when a returned operation is mismatched or unknown", async () => {
    const fixture = await createMetadataRuntimeNode();
    const first: MetadataPatch = {
      operationId: newOperationId(),
      sessionId: fixture.sessionId,
      expectedAuthority: fixture.authority,
      set: { "agent.first": true },
    };
    const second: MetadataPatch = {
      operationId: newOperationId(),
      sessionId: fixture.sessionId,
      expectedAuthority: fixture.authority,
      set: { "agent.second": true },
    };
    fixture.service.enqueueMetadata(first);
    fixture.service.enqueueMetadata(second);
    const canonical = metadataSnapshot(1, { "agent.first": true });
    const valid = metadataOperationRecord({
      patch: first,
      status: "accepted",
      canonical,
    });
    const mismatched = metadataOperationRecord({
      patch: { ...second, set: { "agent.second": "different" } },
      status: "queued",
      canonical: metadataSnapshot(0, {}),
      optimistic: metadataSnapshot(0, { "agent.second": "different" }),
    });

    expect(() => fixture.service.settleMetadataOutbox([valid, mismatched])).toThrow(
      "mismatched metadata operation",
    );
    expect(fixture.service.metadataOutbox()).toEqual([first, second]);
    expect(fixture.service.getMetadataOperation(first.operationId)).toBeUndefined();
    expect(fixture.store.getSession(fixture.sessionId)?.metadata).toEqual(
      metadataSnapshot(0, {}),
    );

    const unknownPatch: MetadataPatch = {
      operationId: newOperationId(),
      sessionId: fixture.sessionId,
      expectedAuthority: fixture.authority,
      set: { "agent.unknown": true },
    };
    expect(() =>
      fixture.service.settleMetadataOutbox([
        metadataOperationRecord({
          patch: unknownPatch,
          status: "queued",
          canonical: metadataSnapshot(0, {}),
          optimistic: metadataSnapshot(0, { "agent.unknown": true }),
        }),
      ]),
    ).toThrow("unknown metadata operation");
    expect(fixture.service.metadataOutbox()).toEqual([first, second]);

    await fixture.service.close();
    fixture.store.close();
  });
});

describe("RuntimeNodeEventHub", () => {
  it("replays never-observed sessions and a replacement runtime epoch", async () => {
    const hub = new RuntimeNodeEventHub({ heartbeatMs: 60_000 });
    const sessionId = newSessionId();
    const firstEpoch = newRuntimeEpoch();
    const first = {
      kind: "native" as const,
      sessionId,
      harness: "codex" as const,
      runtimeEpoch: firstEpoch,
      sequence: 0,
      nativeType: "turn/started",
      payload: { epoch: 1 },
      ephemeral: false,
    };
    hub.publish(first);
    const initial = hub.subscribe({ native: {} })[Symbol.asyncIterator]();
    await expect(initial.next()).resolves.toEqual({ value: first, done: false });
    await initial.return?.();

    const second = {
      ...first,
      runtimeEpoch: newRuntimeEpoch(),
      payload: { epoch: 2 },
    };
    hub.publish(second);
    const replacement = hub.subscribe({
      native: { [sessionId]: { runtimeEpoch: firstEpoch, sequence: 0 } },
    })[Symbol.asyncIterator]();
    await expect(replacement.next()).resolves.toEqual({ value: second, done: false });
    await replacement.return?.();
  });

  it("bounds a stalled subscriber instead of growing without limit", async () => {
    const hub = new RuntimeNodeEventHub({
      heartbeatMs: 60_000,
      subscriberBufferSize: 1,
    });
    const iterator = hub.subscribe({ native: {} })[Symbol.asyncIterator]();

    hub.publish({ kind: "heartbeat" });
    hub.publish({ kind: "heartbeat" });

    await expect(iterator.next()).resolves.toEqual({
      value: { kind: "heartbeat" },
      done: false,
    });
    await expect(iterator.next()).rejects.toMatchObject({
      name: "RuntimeNodeSubscriberOverflowError",
      capacity: 1,
    });
  });

  it("streams durable current-state replay outside the bounded live mailbox", async () => {
    const hub = new RuntimeNodeEventHub({
      heartbeatMs: 60_000,
      subscriberBufferSize: 1,
    });
    const replay = Array.from(
      { length: 5_000 },
      (): RuntimeNodeEventItem => ({ kind: "heartbeat" }),
    );
    const iterator = hub.subscribe(
      { native: {} },
      undefined,
      replay,
    )[Symbol.asyncIterator]();

    // One concurrent live item still fits in the independently bounded
    // mailbox while the finite current-state prefix is being consumed.
    hub.publish({ kind: "heartbeat" });
    for (let index = 0; index < replay.length + 1; index += 1) {
      await expect(iterator.next()).resolves.toEqual({
        value: { kind: "heartbeat" },
        done: false,
      });
    }
    await iterator.return?.();
  });

  it("does not retain or deliver to a subscription whose signal was already aborted", async () => {
    const hub = new RuntimeNodeEventHub({ heartbeatMs: 60_000 });
    const controller = new AbortController();
    controller.abort();
    const iterator = hub
      .subscribe({ native: {} }, controller.signal)
      [Symbol.asyncIterator]();

    hub.publish({ kind: "heartbeat" });

    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  it("reports a gap when a cursor is ahead of the retained native stream", async () => {
    const hub = new RuntimeNodeEventHub({ heartbeatMs: 60_000 });
    const sessionId = newSessionId();
    const runtimeEpoch = newRuntimeEpoch();
    hub.publish({
      kind: "native",
      sessionId,
      harness: "codex",
      runtimeEpoch,
      sequence: 3,
      nativeType: "turn/completed",
      payload: {},
      ephemeral: false,
    });
    const iterator = hub.subscribe({
      native: { [sessionId]: { runtimeEpoch, sequence: 9 } },
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        kind: "nativeGap",
        sessionId,
        recovery: "readNativeHistory",
        reason: expect.stringContaining("behind requested sequence 9"),
      },
      done: false,
    });
    await iterator.return?.();
  });
});

describe("RuntimeNodeService", () => {
  it("fences reverse RPC requests from a stale runtime node boot", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-boot-fence-"));
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeBootId = newRuntimeNodeBootId();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId: newRuntimeNodeId(),
      runtimeNodeBootId,
      name: "boot fenced runtime node",
      allowedRoots: [root],
      adapters: [new FakeAdapter()],
    });
    const caller = createRuntimeNodeRouter(service).createCaller({});

    const selfDescription = await caller.runtimeNode.describe();
    expect(selfDescription).toMatchObject({
      runtimeNodeId: service.runtimeNodeId,
      runtimeNodeBootId,
      protocolVersion: 5,
    });
    expect(selfDescription).not.toHaveProperty("ownerHostId");
    expect(selfDescription).not.toHaveProperty("reachability");

    await expect(caller.inventory.snapshot({
      runtimeNodeBootId: newRuntimeNodeBootId(),
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.inventory.snapshot({ runtimeNodeBootId })).resolves.toMatchObject({
      runtimeNodeId: service.runtimeNodeId,
    });

    const sessionId = newSessionId();
    await launchDirectWorkspace(service, {
      launchId: newLaunchId(),
      payloadHash: "runtime node-metadata-spawn",
      sessionId,
      runtimeNodeId: service.runtimeNodeId,
      harness: "codex",
      input: { cwd: root },
    });
    const unfencedPatch = {
      operationId: newOperationId(),
      sessionId,
      expectedAuthority: authorityRef(),
      set: { "agent.progress": "premature" },
    };
    expect(() => service.enqueueMetadata(unfencedPatch)).toThrow(
      "metadata authority is unknown",
    );
    const authority = authorityRef();
    const localSession = store.getSession(sessionId);
    if (!localSession) throw new Error("spawned session was not persisted");
    store.putSession({ ...localSession, metadataAuthority: authority });
    await expect(caller.metadata.enqueue({
      runtimeNodeBootId,
      patch: {
        operationId: newOperationId(),
        sessionId,
        expectedAuthority: authority,
        set: { "agent.progress": { phase: "testing" } },
      },
    })).resolves.toMatchObject({
      values: { "agent.progress": { phase: "testing" } },
    });
    expect(service.metadataOutbox()).toHaveLength(1);

    await service.close();
    store.close();
  });

  it("returns a partial inventory when one harness is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-partial-runtime node-"));
    const store = new RuntimeNodeStore(":memory:");
    const codex = new FakeAdapter();
    await codex.spawn({ harness: "codex", cwd: root });
    const failing = new FailingCopilotAdapter();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId: newRuntimeNodeId(),
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "partial runtime node",
      allowedRoots: [root],
      adapters: [codex, failing],
    });

    await expect(service.refreshInventory()).resolves.toMatchObject({
      complete: false,
      sessions: [{ harness: "codex", vendorSessionId: "fake-1" }],
    });

    await service.close();
    store.close();
  });

  it("only exposes discovered sessions with canonical cwd paths inside allowed roots", async () => {
    const base = mkdtempSync(join(tmpdir(), "agent-multiplex-inventory-paths-"));
    const root = join(base, "root");
    const project = join(root, "project");
    const projectAlias = join(root, "project-alias");
    const outside = join(base, "outside");
    const outsideAlias = join(root, "outside-alias");
    const missing = join(root, "missing");
    mkdirSync(project, { recursive: true });
    mkdirSync(outside);
    symlinkSync(project, projectAlias, "dir");
    symlinkSync(outside, outsideAlias, "dir");

    const store = new RuntimeNodeStore(":memory:");
    const adapter = new FakeAdapter();
    adapter.sessions.set(
      "inside-alias",
      new FakeSession("inside-alias", projectAlias, adapter.adapterScopeId),
    );
    adapter.sessions.set(
      "outside",
      new FakeSession("outside", outside, adapter.adapterScopeId),
    );
    adapter.sessions.set(
      "outside-alias",
      new FakeSession("outside-alias", outsideAlias, adapter.adapterScopeId),
    );
    adapter.sessions.set(
      "missing",
      new FakeSession("missing", missing, adapter.adapterScopeId),
    );
    adapter.sessions.set(
      "cwdless",
      new FakeSession("cwdless", null, adapter.adapterScopeId),
    );
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId: newRuntimeNodeId(),
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "inventory path runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });

    const snapshot = await service.refreshInventory();

    expect(snapshot.complete).toBe(true);
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({
        vendorSessionId: "inside-alias",
        cwd: realpathSync(project),
      }),
    ]);

    await service.close();
    store.close();
  });

  it("preserves an active runtime node-owned session when native discovery no longer has a valid cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-active-inventory-"));
    const project = join(root, "project");
    mkdirSync(project);
    const canonicalProject = realpathSync(project);
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const adapter = new FakeAdapter();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "active inventory runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });
    await launchDirectWorkspace(service, {
      launchId: newLaunchId(),
      payloadHash: "active-inventory-spawn",
      sessionId: newSessionId(),
      runtimeNodeId,
      harness: "codex",
      input: { cwd: project },
    });
    rmSync(project, { recursive: true });

    await expect(service.refreshInventory()).resolves.toMatchObject({
      sessions: [
        {
          vendorSessionId: "fake-1",
          cwd: canonicalProject,
          availability: "active",
        },
      ],
    });

    await service.close();
    store.close();
  });

  it("reuses an unchanged inventory generation instead of emitting polling churn", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-stable-inventory-"));
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const adapter = new FakeAdapter();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "stable inventory runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });
    const sessionId = newSessionId();
    await launchDirectWorkspace(service, {
      launchId: newLaunchId(),
      payloadHash: "stable-inventory-spawn",
      sessionId,
      runtimeNodeId,
      harness: "codex",
      input: { cwd: root },
    });

    const first = await service.refreshInventory();
    const second = await service.refreshInventory();
    expect(second.sessions).toEqual(first.sessions);
    expect(second.generation).toBe(first.generation);
    expect(second.capturedAt).toBe(first.capturedAt);

    const session = adapter.sessions.get("fake-1");
    if (!session) throw new Error("expected fake session");
    await session.stop();
    const changed = await service.refreshInventory();
    expect(changed.generation).not.toBe(first.generation);
    expect(changed.sessions).toEqual([
      expect.objectContaining({
        vendorSessionId: "fake-1",
        availability: "resumable",
        runtimeStatus: "stopped",
      }),
    ]);

    await service.close();
    store.close();
  });

  it("launches in an allowed folder, delegates native history, streams raw events, and deduplicates requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-runtime-node-"));
    const project = join(root, "project");
    mkdirSync(project);
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const adapter = new FakeAdapter();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "test runtime node",
      allowedRoots: [root],
      adapters: [adapter],
      eventRingSize: 2,
    });
    const launchId = newLaunchId();
    const sessionId = newSessionId();
    const launch = {
      launchId,
      payloadHash: "1234567890abcdef",
      sessionId,
      runtimeNodeId,
      harness: "codex" as const,
      input: { cwd: project },
      metadata: { "agent.title": "native test" },
    };

    const result = await launchDirectWorkspace(service, launch);
    expect(result.state).toBe("succeeded");
    expect(adapter.spawnCalls).toBe(1);
    expect((await launchDirectWorkspace(service, launch)).state).toBe("succeeded");
    expect(adapter.spawnCalls).toBe(1);
    await expect(
      launchDirectWorkspace(service, {
        ...launch,
        launchId: newLaunchId(),
        payloadHash: "different-command-same-session",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(adapter.spawnCalls).toBe(1);
    await expect(
      launchDirectWorkspace(service, { ...launch, payloadHash: "different-payload-hash" }),
    ).rejects.toBeInstanceOf(RuntimeNodeProtocolError);
    await expect(
      launchDirectWorkspace(service, {
        ...launch,
        input: { ...launch.input, cwd: root },
      }),
    ).rejects.toMatchObject({ code: "PAYLOAD_MISMATCH" });

    const [binding] = (await service.refreshInventory()).sessions;
    expect(binding).toMatchObject({
      vendorSessionId: "fake-1",
      cwd: realpathSync(project),
      availability: "active",
    });

    const iterator = service
      .events({ native: {} })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        kind: "control",
        change: {
          type: "session.upsert",
          session: { sessionId, vendorSessionId: "fake-1" },
        },
      },
      done: false,
    });
    const nextEvent = iterator.next();
    const sent = await service.execute({
      commandId: newCommandId(),
      payloadHash: "abcdef1234567890",
      sessionId,
      runtimeNodeId,
      bindingRevision: 1,
      request: {
        harness: "codex",
        command: { type: "send", input: "hello" },
      },
    });
    expect(sent.state).toBe("succeeded");
    await expect(nextEvent).resolves.toMatchObject({
      value: {
        kind: "native",
        sessionId,
        nativeType: "fake/message",
        payload: packNativePayload({ text: "hello" }),
      },
      done: false,
    });

    await expect(
      service.readNativeHistory(sessionId, {
        harness: "codex",
        includeTurns: true,
      }),
    ).resolves.toMatchObject({
      harness: "codex",
      vendorSessionId: "fake-1",
      payload: packNativePayload({ source: "native", prompts: ["hello"] }),
      complete: true,
    });

    await iterator.return?.();
    await service.close();
    store.close();
  });

  it("persists acknowledged harness settings and publishes the updated session projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-runtime-settings-"));
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const adapter = new FakeAdapter();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "settings projection runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });
    const sessionId = newSessionId();
    await launchDirectWorkspace(service, {
      launchId: newLaunchId(),
      payloadHash: "settings-projection-spawn",
      sessionId,
      runtimeNodeId,
      harness: "codex",
      input: { cwd: root },
    });

    const iterator = service.events({ native: {} })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        kind: "control",
        change: {
          type: "session.upsert",
          session: { sessionId, vendorSessionId: "fake-1" },
        },
      },
      done: false,
    });
    const projected = iterator.next();
    await expect(service.execute({
      commandId: newCommandId(),
      payloadHash: "settings-projection-model",
      sessionId,
      runtimeNodeId,
      bindingRevision: 1,
      request: {
        harness: "codex",
        command: { type: "setModel", model: "gpt-5.6-sol" },
      },
    })).resolves.toMatchObject({ state: "succeeded" });

    expect(store.getSession(sessionId)?.harnessSettings).toEqual({
      model: "gpt-5.6-sol",
    });
    await expect(projected).resolves.toMatchObject({
      done: false,
      value: {
        kind: "control",
        change: {
          type: "session.upsert",
          session: {
            sessionId,
            harnessSettings: { model: "gpt-5.6-sol" },
          },
        },
      },
    });

    await iterator.return?.();
    await service.close();
    store.close();
  });

  it("does not replace an active native handle through resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-active-resume-"));
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const adapter = new FakeAdapter();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "active resume runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });
    const sessionId = newSessionId();
    await launchDirectWorkspace(service, {
      launchId: newLaunchId(),
      payloadHash: "active-resume-spawn",
      sessionId,
      runtimeNodeId,
      harness: "codex",
      input: { cwd: root },
    });

    await expect(service.resume({
      operation: "resume",
      commandId: newCommandId(),
      payloadHash: "active-resume-command",
      sessionId,
      runtimeNodeId,
      bindingRevision: 1,
    })).resolves.toMatchObject({
      state: "failed",
      error: expect.stringContaining("already active"),
    });
    expect(adapter.resumeCalls).toHaveLength(0);

    await service.close();
    store.close();
  });

  it("preserves canonical metadata, authority, and creation identity across resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-resume-state-"));
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const adapter = new FakeAdapter();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "resume state runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });
    const sessionId = newSessionId();
    await launchDirectWorkspace(service, {
      launchId: newLaunchId(),
      payloadHash: "resume-state-spawn",
      sessionId,
      runtimeNodeId,
      harness: "codex",
      input: { cwd: root },
    });
    await service.stop({
      operation: "stop",
      commandId: newCommandId(),
      payloadHash: "resume-state-stop",
      sessionId,
      runtimeNodeId,
      bindingRevision: 1,
    });
    const before = store.getSession(sessionId);
    if (!before) throw new Error("spawned session was not persisted");
    const authority = authorityRef();
    const canonical = metadataSnapshot(7, { "agent.state": "canonical" });
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    store.putSession({
      ...before,
      bindingRevision: 3,
      metadata: canonical,
      metadataAuthority: authority,
      createdAt,
      nativeSummary: { title: "preserved native summary" },
    });

    await expect(service.resume({
      operation: "resume",
      commandId: newCommandId(),
      payloadHash: "resume-state-resume",
      sessionId,
      runtimeNodeId,
      bindingRevision: 3,
    })).resolves.toMatchObject({ state: "succeeded" });

    expect(store.getSession(sessionId)).toMatchObject({
      sessionId,
      bindingRevision: 3,
      metadata: canonical,
      metadataAuthority: authority,
      createdAt,
      nativeSummary: { title: "preserved native summary" },
      availability: "active",
    });

    await service.close();
    store.close();
  });

  it("fences callbacks queued by a retired native binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-retired-binding-"));
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const adapter = new FakeAdapter();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "retired binding runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });
    const sessionId = newSessionId();
    await launchDirectWorkspace(service, {
      launchId: newLaunchId(),
      payloadHash: "retired-binding-spawn",
      sessionId,
      runtimeNodeId,
      harness: "codex",
      input: { cwd: root },
    });
    const retired = adapter.sessions.get("fake-1");
    if (!retired) throw new Error("spawned fake session is missing");
    await service.stop({
      operation: "stop",
      commandId: newCommandId(),
      payloadHash: "retired-binding-stop",
      sessionId,
      runtimeNodeId,
      bindingRevision: 1,
    });

    const replacement = new FakeSession("fake-1", root, adapter.adapterScopeId);
    adapter.resumeFactory = () => replacement;
    await service.resume({
      operation: "resume",
      commandId: newCommandId(),
      payloadHash: "retired-binding-resume",
      sessionId,
      runtimeNodeId,
      bindingRevision: 1,
    });

    retired.emitRetired({ kind: "status", status: "error" });
    retired.emitRetired({
      kind: "native",
      nativeType: "fake/stale-event",
      payload: { stale: true },
      ephemeral: false,
    });
    expect(store.getSession(sessionId)).toMatchObject({
      runtimeEpoch: replacement.runtimeEpoch,
      runtimeStatus: "idle",
    });

    await service.close();
    store.close();
  });

  it("retires pending interactions and detaches a stop handle on an ambiguous result", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-ambiguous-stop-"));
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const adapter = new FakeAdapter();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "ambiguous stop runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });
    const sessionId = newSessionId();
    await launchDirectWorkspace(service, {
      launchId: newLaunchId(),
      payloadHash: "ambiguous-stop-spawn",
      sessionId,
      runtimeNodeId,
      harness: "codex",
      input: { cwd: root },
    });
    const session = adapter.sessions.get("fake-1");
    if (!session) throw new Error("expected fake session");
    session.requestInteraction();
    session.stopError = new AdapterOutcomeUnknownError("unsubscribe outcome unknown");
    expect(service.listInteractions(sessionId)).toHaveLength(1);

    await expect(service.stop({
      operation: "stop",
      commandId: newCommandId(),
      payloadHash: "ambiguous-stop-command",
      sessionId,
      runtimeNodeId,
      bindingRevision: 1,
    })).resolves.toMatchObject({ state: "outcomeUnknown" });
    expect(service.listInteractions(sessionId)).toEqual([]);
    await expect(service.refreshInventory()).resolves.toMatchObject({
      sessions: [expect.objectContaining({
        vendorSessionId: "fake-1",
        availability: "resumable",
      })],
    });

    const replay = service.events({ native: {} })[Symbol.asyncIterator]();
    await expect(replay.next()).resolves.toMatchObject({
      value: {
        kind: "control",
        change: {
          type: "session.upsert",
          session: { sessionId, vendorSessionId: "fake-1" },
        },
      },
      done: false,
    });
    const replayed = await replay.next();
    expect(replayed).toMatchObject({
      value: {
        kind: "control",
        change: {
          type: "interaction.changed",
          interaction: { sessionId, state: "stale" },
        },
      },
    });
    expect(replayed.value).not.toHaveProperty("eventId");
    expect(replayed.value).not.toHaveProperty("provenance");
    expect(replayed.value).not.toHaveProperty("feedId");
    expect(replayed.value).not.toHaveProperty("cursor");
    await replay.return?.();
    await service.close();
    store.close();
  });

  it("fences an in-flight interaction resolution when stop retires its runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-interaction-stop-race-"));
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const adapter = new FakeAdapter();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "interaction stop race runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });
    const sessionId = newSessionId();
    await launchDirectWorkspace(service, {
      launchId: newLaunchId(),
      payloadHash: "interaction-stop-race-spawn",
      sessionId,
      runtimeNodeId,
      harness: "codex",
      input: { cwd: root },
    });

    const nativeSession = adapter.sessions.get("fake-1");
    if (!nativeSession) throw new Error("fake session was not spawned");
    let releaseResolution!: () => void;
    nativeSession.interactionResolutionGate = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    nativeSession.requestInteraction();
    const [pending] = service.listInteractions(sessionId);
    if (!pending) throw new Error("fake interaction was not recorded");

    const resolving = service.resolveInteraction({
      interactionId: pending.interactionId,
      sessionId,
      harness: "codex",
      response: { approved: true },
    });
    const fenced = expect(resolving).rejects.toMatchObject({ code: "FENCED" });
    await Promise.resolve();
    expect(nativeSession.interactionResponses).toEqual([{ approved: true }]);

    await expect(service.stop({
      operation: "stop",
      commandId: newCommandId(),
      payloadHash: "interaction-stop-race-stop",
      sessionId,
      runtimeNodeId,
      bindingRevision: 1,
    })).resolves.toMatchObject({ state: "succeeded" });
    expect(service.listInteractions(sessionId)).toEqual([]);

    releaseResolution();
    await fenced;

    const replay = service.events({ native: {} })[Symbol.asyncIterator]();
    await expect(replay.next()).resolves.toMatchObject({
      value: {
        kind: "control",
        change: {
          type: "session.upsert",
          session: { sessionId, vendorSessionId: "fake-1" },
        },
      },
      done: false,
    });
    await expect(replay.next()).resolves.toMatchObject({
      value: {
        kind: "control",
        change: {
          type: "interaction.changed",
          interaction: {
            interactionId: pending.interactionId,
            sessionId,
            state: "stale",
          },
        },
      },
      done: false,
    });
    await replay.return?.();

    await service.close();
    store.close();
  });

  it("infers and canonicalizes an omitted resume cwd from native inventory", async () => {
    const base = mkdtempSync(join(tmpdir(), "agent-multiplex-resume-cwd-"));
    const root = join(base, "root");
    const project = join(root, "project");
    const alias = join(root, "project-alias");
    mkdirSync(project, { recursive: true });
    symlinkSync(project, alias, "dir");
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const adapter = new FakeAdapter();
    adapter.sessions.set(
      "native-with-alias",
      new FakeSession("native-with-alias", alias, adapter.adapterScopeId),
    );
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "resume cwd runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });

    const sessionId = newSessionId();
    bindDiscoveredSession({
      service,
      runtimeNodeId,
      sessionId,
      adapter,
      vendorSessionId: "native-with-alias",
    });
    const result = await service.resume({
      operation: "resume",
      commandId: newCommandId(),
      payloadHash: "resume-cwd-canonical",
      sessionId,
      runtimeNodeId,
      bindingRevision: 1,
    });

    expect(result.state).toBe("succeeded");
    expect(adapter.resumeCalls).toHaveLength(1);
    expect(adapter.resumeCalls[0]).toMatchObject({ cwd: realpathSync(project) });

    await service.close();
    store.close();
  });

  it("rejects an omitted resume cwd discovered outside the allowed roots", async () => {
    const base = mkdtempSync(join(tmpdir(), "agent-multiplex-resume-outside-"));
    const root = join(base, "root");
    const outside = join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const adapter = new FakeAdapter();
    adapter.sessions.set(
      "native-outside",
      new FakeSession("native-outside", outside, adapter.adapterScopeId),
    );
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "outside cwd runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });

    const sessionId = newSessionId();
    bindDiscoveredSession({
      service,
      runtimeNodeId,
      sessionId,
      adapter,
      vendorSessionId: "native-outside",
    });
    const result = await service.resume({
      operation: "resume",
      commandId: newCommandId(),
      payloadHash: "resume-cwd-outside",
      sessionId,
      runtimeNodeId,
      bindingRevision: 1,
    });

    expect(result).toMatchObject({
      state: "failed",
      error: expect.stringContaining("outside configured allowed roots"),
    });
    expect(adapter.resumeCalls).toHaveLength(0);

    await service.close();
    store.close();
  });

  it("rejects a control projection that attaches one native session twice", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-resume-binding-"));
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const adapter = new FakeAdapter();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "binding runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });
    await launchDirectWorkspace(service, {
      launchId: newLaunchId(),
      payloadHash: "original-native-binding",
      sessionId: newSessionId(),
      runtimeNodeId,
      harness: "codex",
      input: { cwd: root },
      metadata: {},
    });

    const conflictingSessionId = newSessionId();
    expect(() => bindDiscoveredSession({
      service,
      runtimeNodeId,
      sessionId: conflictingSessionId,
      adapter,
      vendorSessionId: "fake-1",
      cwd: root,
    })).toThrowError(expect.objectContaining({ code: "FENCED" }));
    expect(store.getSession(conflictingSessionId)).toBeUndefined();
    expect(adapter.resumeCalls).toHaveLength(0);

    await service.close();
    store.close();
  });

  it("revalidates a stored cwd before attaching inactive native history", async () => {
    const base = mkdtempSync(join(tmpdir(), "agent-multiplex-history-cwd-"));
    const root = join(base, "root");
    const project = join(root, "project");
    const outside = join(base, "outside");
    mkdirSync(project, { recursive: true });
    mkdirSync(outside);
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const adapter = new FakeAdapter();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "history cwd runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });
    const sessionId = newSessionId();
    await launchDirectWorkspace(service, {
      launchId: newLaunchId(),
      payloadHash: "history-cwd-spawn",
      sessionId,
      runtimeNodeId,
      harness: "codex",
      input: { cwd: project },
      metadata: {},
    });
    await service.stop({
      operation: "stop",
      commandId: newCommandId(),
      payloadHash: "history-cwd-stop",
      sessionId,
      runtimeNodeId,
      bindingRevision: 1,
    });
    rmSync(project, { recursive: true });
    symlinkSync(outside, project, "dir");

    await expect(
      service.readNativeHistory(sessionId, { harness: "codex", includeTurns: true }),
    ).rejects.toMatchObject({ code: "FENCED" });
    expect(adapter.resumeCalls).toHaveLength(0);

    await service.close();
    store.close();
  });

  it("keeps a temporary history attachment from racing or stopping a live resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-history-resume-race-"));
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const adapter = new FakeAdapter();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "history resume race runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });
    const sessionId = newSessionId();
    await launchDirectWorkspace(service, {
      launchId: newLaunchId(),
      payloadHash: "history-resume-race-spawn",
      sessionId,
      runtimeNodeId,
      harness: "codex",
      input: { cwd: root },
    });
    await service.stop({
      operation: "stop",
      commandId: newCommandId(),
      payloadHash: "history-resume-race-stop",
      sessionId,
      runtimeNodeId,
      bindingRevision: 1,
    });

    let notifyHistoryStarted!: () => void;
    const historyStarted = new Promise<void>((resolve) => {
      notifyHistoryStarted = resolve;
    });
    let releaseHistory!: () => void;
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    const temporary = new FakeSession("fake-1", root, adapter.adapterScopeId);
    temporary.historyStarted = notifyHistoryStarted;
    temporary.historyGate = historyGate;
    const live = new FakeSession("fake-1", root, adapter.adapterScopeId);
    adapter.resumeFactory = (_options, call) => (call === 1 ? temporary : live);

    const history = service.readNativeHistory(sessionId, {
      harness: "codex",
      includeTurns: true,
    });
    await historyStarted;
    const resumed = service.resume({
      operation: "resume",
      commandId: newCommandId(),
      payloadHash: "history-resume-race-resume",
      sessionId,
      runtimeNodeId,
      bindingRevision: 1,
    });
    await Promise.resolve();
    expect(adapter.resumeCalls).toHaveLength(1);

    releaseHistory();
    await expect(history).resolves.toMatchObject({ vendorSessionId: "fake-1" });
    await expect(resumed).resolves.toMatchObject({ state: "succeeded" });
    expect(adapter.resumeCalls).toHaveLength(2);
    expect(temporary.stopCalls).toBe(1);
    expect(live.stopCalls).toBe(0);

    await service.readNativeHistory(sessionId, { harness: "codex", includeTurns: true });
    expect(adapter.resumeCalls).toHaveLength(2);
    expect(live.historyCalls).toBe(1);
    expect(live.stopCalls).toBe(0);

    await service.close();
    store.close();
  });

  it("rechecks the active handle after waiting behind a resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-resume-history-race-"));
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const adapter = new FakeAdapter();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "resume history race runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });
    const sessionId = newSessionId();
    await launchDirectWorkspace(service, {
      launchId: newLaunchId(),
      payloadHash: "resume-history-race-spawn",
      sessionId,
      runtimeNodeId,
      harness: "codex",
      input: { cwd: root },
    });
    await service.stop({
      operation: "stop",
      commandId: newCommandId(),
      payloadHash: "resume-history-race-stop",
      sessionId,
      runtimeNodeId,
      bindingRevision: 1,
    });

    let notifyResumeStarted!: () => void;
    const resumeStarted = new Promise<void>((resolve) => {
      notifyResumeStarted = resolve;
    });
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const live = new FakeSession("fake-1", root, adapter.adapterScopeId);
    adapter.resumeStarted = (_options, call) => {
      if (call === 1) notifyResumeStarted();
    };
    adapter.resumeGate = async (_options, call) => {
      if (call === 1) await resumeGate;
    };
    adapter.resumeFactory = () => live;

    const resumed = service.resume({
      operation: "resume",
      commandId: newCommandId(),
      payloadHash: "resume-history-race-resume",
      sessionId,
      runtimeNodeId,
      bindingRevision: 1,
    });
    await resumeStarted;
    const history = service.readNativeHistory(sessionId, {
      harness: "codex",
      includeTurns: true,
    });
    await Promise.resolve();
    expect(adapter.resumeCalls).toHaveLength(1);

    releaseResume();
    await expect(resumed).resolves.toMatchObject({ state: "succeeded" });
    await expect(history).resolves.toMatchObject({ vendorSessionId: "fake-1" });
    expect(adapter.resumeCalls).toHaveLength(1);
    expect(live.historyCalls).toBe(1);
    expect(live.stopCalls).toBe(0);

    await service.close();
    store.close();
  });

  it("serializes duplicate inactive history attachments", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-history-duplicate-"));
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const adapter = new FakeAdapter();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "duplicate history runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });
    const sessionId = newSessionId();
    await launchDirectWorkspace(service, {
      launchId: newLaunchId(),
      payloadHash: "duplicate-history-spawn",
      sessionId,
      runtimeNodeId,
      harness: "codex",
      input: { cwd: root },
    });
    await service.stop({
      operation: "stop",
      commandId: newCommandId(),
      payloadHash: "duplicate-history-stop",
      sessionId,
      runtimeNodeId,
      bindingRevision: 1,
    });

    let notifyFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const temporarySessions: FakeSession[] = [];
    adapter.resumeFactory = (_options, call) => {
      const temporary = new FakeSession("fake-1", root, adapter.adapterScopeId);
      if (call === 1) {
        temporary.historyStarted = notifyFirstStarted;
        temporary.historyGate = firstGate;
      }
      temporarySessions.push(temporary);
      return temporary;
    };

    const first = service.readNativeHistory(sessionId, {
      harness: "codex",
      includeTurns: true,
    });
    await firstStarted;
    const second = service.readNativeHistory(sessionId, {
      harness: "codex",
      includeTurns: true,
    });
    await Promise.resolve();
    expect(adapter.resumeCalls).toHaveLength(1);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(adapter.resumeCalls).toHaveLength(2);
    expect(temporarySessions.map((session) => session.stopCalls)).toEqual([1, 1]);

    await service.close();
    store.close();
  });

  it("does not emit an unhandled rejection when a serialized command rejection is caught", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-command-rejection-"));
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const adapter = new FakeAdapter();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "command rejection runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });
    const sessionId = newSessionId();
    await launchDirectWorkspace(service, {
      launchId: newLaunchId(),
      payloadHash: "command-rejection-spawn",
      sessionId,
      runtimeNodeId,
      harness: "codex",
      input: { cwd: root },
    });
    const command = {
      commandId: newCommandId(),
      payloadHash: "command-rejection-original",
      sessionId,
      runtimeNodeId,
      bindingRevision: 1,
      request: {
        harness: "codex" as const,
        command: { type: "send" as const, input: "once" },
      },
    };
    await service.execute(command);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(
        service.execute({ ...command, payloadHash: "command-rejection-mismatch" }),
      ).rejects.toMatchObject({ code: "PAYLOAD_MISMATCH" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    await service.close();
    store.close();
  });

  it("does not dispatch resume when no safe cwd can be established", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-resume-no-cwd-"));
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const adapter = new FakeAdapter();
    adapter.sessions.set(
      "native-without-cwd",
      new FakeSession("native-without-cwd", null, adapter.adapterScopeId),
    );
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "missing cwd runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });

    const sessionId = newSessionId();
    bindDiscoveredSession({
      service,
      runtimeNodeId,
      sessionId,
      adapter,
      vendorSessionId: "native-without-cwd",
    });
    const result = await service.resume({
      operation: "resume",
      commandId: newCommandId(),
      payloadHash: "resume-without-cwd",
      sessionId,
      runtimeNodeId,
      bindingRevision: 1,
    });

    expect(result).toMatchObject({
      state: "failed",
      error: expect.stringContaining("has no working directory"),
    });
    expect(adapter.resumeCalls).toHaveLength(0);

    await service.close();
    store.close();
  });

  it("deduplicates interaction resolution and replays the terminal state", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-interaction-replay-"));
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const adapter = new FakeAdapter();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "interaction replay runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });
    const sessionId = newSessionId();
    await launchDirectWorkspace(service, {
      launchId: newLaunchId(),
      payloadHash: "interaction-replay",
      sessionId,
      runtimeNodeId,
      harness: "codex",
      input: { cwd: root },
      metadata: {},
    });

    const nativeSession = adapter.sessions.get("fake-1");
    if (!nativeSession) throw new Error("fake session was not spawned");
    let releaseResolution!: () => void;
    nativeSession.interactionResolutionGate = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    nativeSession.requestInteraction();
    const [pending] = service.listInteractions(sessionId);
    if (!pending) throw new Error("fake interaction was not recorded");

    for (let subscription = 0; subscription < 2; subscription += 1) {
      const iterator = service
        .events({ native: {} })
        [Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({
        value: {
          kind: "control",
          change: {
            type: "session.upsert",
            session: { sessionId, vendorSessionId: "fake-1" },
          },
        },
        done: false,
      });
      await expect(iterator.next()).resolves.toMatchObject({
        value: {
          kind: "control",
          change: {
            type: "interaction.changed",
            interaction: {
              interactionId: pending.interactionId,
              sessionId,
              state: "pending",
            },
          },
        },
        done: false,
      });
      await iterator.return?.();
    }

    const resolution = {
      interactionId: pending.interactionId,
      sessionId,
      harness: "codex",
      response: { approved: true, details: { first: 1, second: 2 } },
    } as const;
    const first = service.resolveInteraction(resolution);
    await Promise.resolve();
    expect(nativeSession.interactionResponses).toEqual([resolution.response]);

    const duplicate = service.resolveInteraction({
      ...resolution,
      response: { details: { second: 2, first: 1 }, approved: true },
    });
    await expect(
      service.resolveInteraction({ ...resolution, response: { approved: false } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(nativeSession.interactionResponses).toHaveLength(1);

    releaseResolution();
    const [resolved, duplicateResult] = await Promise.all([first, duplicate]);
    expect(duplicateResult).toEqual(resolved);
    expect(resolved).toMatchObject({
      interactionId: pending.interactionId,
      state: "resolved",
      resolution: packNativePayload(resolution.response),
    });
    await expect(service.resolveInteraction(resolution)).resolves.toEqual(resolved);
    expect(nativeSession.interactionResponses).toHaveLength(1);

    const afterResolution = service
      .events({ native: {} })
      [Symbol.asyncIterator]();
    await expect(afterResolution.next()).resolves.toMatchObject({
      value: {
        kind: "control",
        change: {
          type: "session.upsert",
          session: { sessionId, vendorSessionId: "fake-1" },
        },
      },
      done: false,
    });
    await expect(afterResolution.next()).resolves.toMatchObject({
      value: {
        kind: "control",
        change: {
          type: "interaction.changed",
          interaction: {
            interactionId: pending.interactionId,
            state: "resolved",
            resolution: packNativePayload(resolution.response),
          },
        },
      },
      done: false,
    });
    await afterResolution.return?.();

    await service.close();
    store.close();
  });
});

interface DirectWorkspaceLaunchInput {
  launchId: LaunchId;
  payloadHash: string;
  sessionId: SessionId;
  runtimeNodeId: RuntimeNodeId;
  harness: "codex" | "copilot";
  input: JsonObject;
  metadata?: LaunchRequest["metadata"];
}

/** Exercise the real v4 provider API while keeping individual fixtures terse. */
async function launchDirectWorkspace(
  service: RuntimeNodeService,
  input: DirectWorkspaceLaunchInput,
): Promise<LaunchRecord> {
  const descriptor = service.launchProfiles().find(
    (candidate) =>
      candidate.providerId === "core.direct" &&
      candidate.profileId === "workspace" &&
      candidate.harnesses.includes(input.harness),
  );
  if (!descriptor) throw new Error(`core.direct/workspace is unavailable for ${input.harness}`);
  const request: LaunchRequest = {
    launchId: input.launchId,
    payloadHash: input.payloadHash,
    sessionId: input.sessionId,
    runtimeNodeId: input.runtimeNodeId,
    profile: {
      profileId: descriptor.profileId,
      providerId: descriptor.providerId,
      contractVersion: descriptor.contractVersion,
      requestSchemaHash: descriptor.requestSchemaHash,
    },
    harness: input.harness,
    input: input.input,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  };
  service.createLaunch(request);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const record = service.getLaunch(request.launchId);
    if (
      record &&
      (record.state === "succeeded" ||
        record.state === "failed" ||
        record.state === "outcomeUnknown")
    ) {
      return record;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for launch ${request.launchId}`);
}

function bindDiscoveredSession(input: {
  service: RuntimeNodeService;
  runtimeNodeId: RuntimeNodeId;
  sessionId: SessionId;
  adapter: FakeAdapter;
  vendorSessionId: string;
  cwd?: string | null;
}): void {
  const timestamp = new Date().toISOString();
  input.service.applyCanonicalSessions([{
    sessionId: input.sessionId,
    runtimeNodeId: input.runtimeNodeId,
    harness: "codex",
    adapterScopeId: input.adapter.adapterScopeId,
    vendorSessionId: input.vendorSessionId,
    bindingRevision: 1,
    runtimeEpoch: null,
    cwd: input.cwd ?? null,
    availability: "resumable",
    runtimeStatus: "stopped",
    launchProvenance: null,
    metadata: metadataSnapshot(0, {}),
    metadataAuthority: authorityRef(),
    catalogState: "open",
    catalogRevision: 1,
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
    lastActivityAt: timestamp,
  }]);
}

interface MetadataRuntimeNodeFixture {
  root: string;
  store: RuntimeNodeStore;
  service: RuntimeNodeService;
  runtimeNodeId: ReturnType<typeof newRuntimeNodeId>;
  sessionId: ReturnType<typeof newSessionId>;
  authority: AuthorityRef;
}

async function createMetadataRuntimeNode(
  filename = ":memory:",
): Promise<MetadataRuntimeNodeFixture> {
  const root = mkdtempSync(join(tmpdir(), "agent-multiplex-metadata-runtime-node-"));
  const store = new RuntimeNodeStore(filename);
  const runtimeNodeId = newRuntimeNodeId();
  const service = new RuntimeNodeService({
    store,
    runtimeNodeId,
    runtimeNodeBootId: newRuntimeNodeBootId(),
    name: "metadata runtime node",
    allowedRoots: [root],
    adapters: [new FakeAdapter()],
  });
  const sessionId = newSessionId();
  await launchDirectWorkspace(service, {
    launchId: newLaunchId(),
    payloadHash: "metadata-runtime-node-spawn",
    sessionId,
    runtimeNodeId,
    harness: "codex",
    input: { cwd: root },
  });
  const authority = authorityRef();
  const session = store.getSession(sessionId);
  if (!session) throw new Error("spawned metadata session was not persisted");
  store.putSession({ ...session, metadataAuthority: authority });
  return { root, store, service, runtimeNodeId, sessionId, authority };
}

function requiredSession(
  fixture: MetadataRuntimeNodeFixture,
): NonNullable<ReturnType<RuntimeNodeStore["getSession"]>> {
  const session = fixture.store.getSession(fixture.sessionId);
  if (!session) throw new Error("metadata test session was not persisted");
  return session;
}

function metadataSnapshot(
  revision: number,
  values: Record<string, JsonValue>,
): MetadataSnapshot {
  return {
    revision,
    values,
    keyRevisions: Object.fromEntries(
      Object.keys(values).map((key) => [key, revision] as const),
    ),
  };
}

function metadataOperationRecord(input: {
  patch: MetadataPatch;
  status: MetadataOperationRecord["status"];
  canonical: MetadataSnapshot;
  optimistic?: MetadataSnapshot;
  conflicts?: MetadataOperationRecord["conflicts"];
}): MetadataOperationRecord {
  const timestamp = new Date().toISOString();
  return {
    operationId: input.patch.operationId,
    sessionId: input.patch.sessionId,
    patch: input.patch,
    status: input.status,
    canonical: input.canonical,
    ...(input.optimistic === undefined ? {} : { optimistic: input.optimistic }),
    ...(input.conflicts === undefined ? {} : { conflicts: input.conflicts }),
    originControlNodeId: newControlNodeId(),
    authority: input.patch.expectedAuthority,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function authorityRef(): AuthorityRef {
  return {
    realmId: newRealmId(),
    controlNodeId: newControlNodeId(),
    epochId: newAuthorityEpochId(),
  };
}

class FakeAdapter implements AgentAdapter {
  readonly harness = "codex" as const;
  readonly adapterScopeId = "fake:codex" as AdapterScopeId;
  readonly sessions = new Map<string, FakeSession>();
  readonly lastActivityAt = new Date().toISOString();
  readonly resumeCalls: HarnessResumeOptions[] = [];
  resumeFactory:
    | ((options: HarnessResumeOptions, call: number) => FakeSession)
    | undefined;
  resumeStarted:
    | ((options: HarnessResumeOptions, call: number) => void)
    | undefined;
  resumeGate:
    | ((options: HarnessResumeOptions, call: number) => Promise<void>)
    | undefined;
  spawnCalls = 0;

  async describe(): Promise<HarnessCatalogEntry> {
    return {
      harness: this.harness,
      adapterScopeId: this.adapterScopeId,
      available: true,
      capabilities: [{ name: "fake" }],
    };
  }

  async listModels(): Promise<NativeModel[]> {
    return [{ harness: "codex", id: "fake-model" }];
  }

  async listSessions(): Promise<NativeInventoryItem[]> {
    return [...this.sessions.values()].map((session) => ({
      harness: "codex",
      adapterScopeId: this.adapterScopeId,
      vendorSessionId: session.vendorSessionId,
      cwd: session.cwd,
      availability: session.status() === "stopped" ? "resumable" : "active",
      runtimeStatus: session.status(),
      runtimeEpoch: session.status() === "stopped" ? null : session.runtimeEpoch,
      lastActivityAt: this.lastActivityAt,
    }));
  }

  async spawn(options: HarnessSpawnOptions): Promise<AdapterSession> {
    if (options.harness !== "codex") throw new Error("wrong harness");
    this.spawnCalls += 1;
    const session = new FakeSession(`fake-${this.spawnCalls}`, options.cwd, this.adapterScopeId);
    this.sessions.set(session.vendorSessionId, session);
    return session;
  }

  async resume(options: HarnessResumeOptions): Promise<AdapterSession> {
    if (options.harness !== "codex") throw new Error("wrong harness");
    this.resumeCalls.push(options);
    const call = this.resumeCalls.length;
    this.resumeStarted?.(options, call);
    await this.resumeGate?.(options, call);
    const replacement = this.resumeFactory?.(options, call);
    if (replacement) {
      this.sessions.set(replacement.vendorSessionId, replacement);
      return replacement;
    }
    const existing = this.sessions.get(options.vendorSessionId);
    if (existing) return existing;
    const session = new FakeSession(
      options.vendorSessionId,
      options.cwd ?? null,
      this.adapterScopeId,
    );
    this.sessions.set(session.vendorSessionId, session);
    return session;
  }

  async close(): Promise<void> {}
}

class FailingCopilotAdapter implements AgentAdapter {
  readonly harness = "copilot" as const;
  readonly adapterScopeId = "fake:unavailable-copilot" as AdapterScopeId;

  async describe(): Promise<HarnessCatalogEntry> {
    return {
      harness: "copilot",
      adapterScopeId: this.adapterScopeId,
      available: false,
      capabilities: [],
      unavailableReason: "fake runtime unavailable",
    };
  }

  async listModels(): Promise<NativeModel[]> {
    throw new Error("fake runtime unavailable");
  }

  async listSessions(): Promise<NativeInventoryItem[]> {
    throw new Error("fake runtime unavailable");
  }

  async spawn(_options: HarnessSpawnOptions): Promise<AdapterSession> {
    throw new Error("fake runtime unavailable");
  }

  async resume(_options: HarnessResumeOptions): Promise<AdapterSession> {
    throw new Error("fake runtime unavailable");
  }

  async close(): Promise<void> {}
}

class FakeSession implements AdapterSession {
  readonly harness = "codex" as const;
  readonly runtimeEpoch: RuntimeEpoch = newRuntimeEpoch();
  readonly #listeners = new Set<(event: AdapterEvent) => void>();
  readonly #prompts: string[] = [];
  readonly interactionResponses: JsonValue[] = [];
  interactionResolutionGate: Promise<void> | undefined;
  historyGate: Promise<void> | undefined;
  historyStarted: (() => void) | undefined;
  historyCalls = 0;
  stopCalls = 0;
  stopError: Error | undefined;
  latestSubscriber: ((event: AdapterEvent) => void) | undefined;
  #settings: HarnessSessionSettings | undefined;
  #status: SessionRuntimeStatus = "idle";

  constructor(
    readonly vendorSessionId: string,
    readonly cwd: string | null,
    readonly adapterScopeId: AdapterScopeId,
  ) {}

  status(): SessionRuntimeStatus {
    return this.#status;
  }

  settings(): HarnessSessionSettings | undefined {
    return this.#settings === undefined ? undefined : { ...this.#settings };
  }

  subscribe(listener: (event: AdapterEvent) => void): () => void {
    this.latestSubscriber = listener;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emitRetired(event: AdapterEvent): void {
    this.latestSubscriber?.(event);
  }

  async execute(request: HarnessCommand): Promise<JsonValue> {
    if (request.harness !== "codex") throw new Error("wrong harness");
    if (request.command.type === "send") {
      const prompt = String(request.command.input);
      this.#prompts.push(prompt);
      this.#emit({
        kind: "native",
        nativeType: "fake/message",
        payload: { text: prompt },
        ephemeral: false,
      });
      return { accepted: true };
    }
    if (request.command.type === "setModel") {
      this.#settings = { ...this.#settings, model: request.command.model };
      this.#emit({ kind: "settings", settings: this.settings()! });
    }
    if (request.command.type === "setEffort") {
      this.#settings = { ...this.#settings, effort: request.command.effort };
      this.#emit({ kind: "settings", settings: this.settings()! });
    }
    if (request.command.type === "setMode") {
      const mode = typeof request.command.mode === "string"
        ? request.command.mode
        : typeof request.command.mode === "object" &&
            request.command.mode !== null &&
            !Array.isArray(request.command.mode) &&
            typeof request.command.mode.mode === "string"
          ? request.command.mode.mode
          : undefined;
      this.#settings = { ...this.#settings, ...(mode ? { mode } : {}) };
      this.#emit({ kind: "settings", settings: this.settings()! });
    }
    if (request.command.type === "stop") await this.stop();
    return { accepted: true };
  }

  async readNativeHistory(request: NativeHistoryRequest): Promise<NativeHistoryResult> {
    if (request.harness !== "codex") throw new Error("wrong harness");
    this.historyCalls += 1;
    this.historyStarted?.();
    await this.historyGate;
    return {
      harness: "codex",
      vendorSessionId: this.vendorSessionId,
      payload: { source: "native", prompts: this.#prompts },
      complete: true,
    };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.#status = "stopped";
    this.#emit({ kind: "status", status: "stopped" });
    if (this.stopError) throw this.stopError;
  }

  requestInteraction(): void {
    this.#emit({
      kind: "interaction",
      nativeRequestId: "fake-interaction",
      requestType: "approval",
      payload: { command: "fake command" },
      ephemeral: false,
      resolve: async (response) => {
        this.interactionResponses.push(response);
        await this.interactionResolutionGate;
      },
    });
  }

  #emit(event: AdapterEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
