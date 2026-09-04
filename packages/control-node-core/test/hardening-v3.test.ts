import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  emptyMetadataSnapshot,
  jsonValueSchema,
  newAttachmentId,
  newAuthorityEpochId,
  newCommandId,
  newControlNodeBootId,
  newControlNodeId,
  newFeedId,
  newInteractionId,
  newLineageId,
  newOperationId,
  newRealmId,
  newRuntimeEpoch,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  newTerminalId,
  type AccessSnapshot,
  type AccessStreamItem,
  type AdapterScopeId,
  type CommandEnvelope,
  type CommandRecord,
  type ControlNodeAttachment,
  type ControlNodeAttachmentRequest,
  type FeedControlItem,
  type InteractionRecord,
  type InventorySnapshot,
  type RuntimeNodeRegistration,
  type SessionRecord,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  ControlNodeCatalog,
  ControlNodeService,
  createAccessRouter,
  type ChildControlNodeConnection,
  type RuntimeNodeConnection,
  type RuntimeNodeIngressContext,
} from "../src/index.js";

const now = "2037-04-05T06:07:08.000Z";
const remoteCommandTime = "2037-04-05T06:08:09.000Z";
const clock = () => new Date(now);
const payloadHash = "a".repeat(64);

function stateFile(prefix: string): string {
  return join(
    mkdtempSync(join(tmpdir(), `agent-multiplex-control-v3-${prefix}-`)),
    "control-node.sqlite",
  );
}

function registration(
  runtimeNodeId = newRuntimeNodeId(),
  runtimeNodeBootId = newRuntimeNodeBootId(),
): RuntimeNodeRegistration {
  return {
    runtimeNodeId,
    runtimeNodeBootId,
    name: "runtime-v3-test",
    allowedRoots: ["/work"],
    harnesses: [{
      harness: "codex",
      adapterScopeId: "codex-v3-test" as AdapterScopeId,
      available: true,
      capabilities: [{ name: "interactive", experimental: false }],
    }],
    protocolVersion: 4,
  };
}

function inventory(
  runtime: RuntimeNodeRegistration,
  runtimeEpoch = newRuntimeEpoch(),
): InventorySnapshot {
  return {
    runtimeNodeId: runtime.runtimeNodeId,
    generation: `inventory-${runtime.runtimeNodeBootId}`,
    complete: true,
    capturedAt: now,
    sessions: [{
      harness: "codex",
      adapterScopeId: runtime.harnesses[0]!.adapterScopeId,
      vendorSessionId: "native-v3-session",
      cwd: "/work/project",
      availability: "active",
      runtimeStatus: "idle",
      runtimeEpoch,
      lastActivityAt: now,
    }],
  };
}

function childRequest(catalog: ControlNodeCatalog): ControlNodeAttachmentRequest {
  const controlNodeId = newControlNodeId();
  return {
    controlNodeId,
    controlNodeBootId: newControlNodeBootId(),
    feedId: newFeedId(),
    name: "child-v3-test",
    protocolVersion: 4,
    capabilities: ["catalog.sqlite-v3"],
    expectedParentControlNodeId: catalog.localControlNode().controlNodeId,
    childProof: {
      currentRole: {
        role: "authority",
        authority: {
          realmId: newRealmId(),
          controlNodeId,
          epochId: newAuthorityEpochId(),
        },
      },
      coveredControlNodeIds: [controlNodeId],
    },
  };
}

function runtimeConnection(
  runtime: RuntimeNodeRegistration,
  overrides: Partial<RuntimeNodeConnection> = {},
): RuntimeNodeConnection {
  return {
    runtimeNodeId: runtime.runtimeNodeId,
    runtimeNodeBootId: runtime.runtimeNodeBootId,
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
    ...overrides,
  };
}

interface RuntimeFixture {
  readonly catalog: ControlNodeCatalog;
  readonly service: ControlNodeService;
  readonly runtime: RuntimeNodeRegistration;
  readonly context: Required<Pick<RuntimeNodeIngressContext, "endpointId" | "authenticatedRuntimeNodeId">>;
  readonly session: SessionRecord;
}

function runtimeFixture(
  overrides: Partial<RuntimeNodeConnection> = {},
): RuntimeFixture {
  const catalog = new ControlNodeCatalog({ filename: stateFile("runtime"), now: clock });
  const service = new ControlNodeService({ catalog, now: clock });
  const runtime = registration();
  const context = {
    endpointId: `runtime-endpoint-${runtime.runtimeNodeId}`,
    authenticatedRuntimeNodeId: runtime.runtimeNodeId,
  };
  service.registerRuntimeNode(runtime, {
    ...context,
    runtimeNodeConnection: runtimeConnection(runtime, {
      endpointId: context.endpointId,
      ...overrides,
    }),
  });
  const [session] = service.reconcile({
    runtimeNodeId: runtime.runtimeNodeId,
    runtimeNodeBootId: runtime.runtimeNodeBootId,
    snapshot: inventory(runtime),
  }, context).sessions;
  if (!session?.runtimeEpoch) throw new Error("test session was not active");
  return { catalog, service, runtime, context, session };
}

function pendingInteraction(session: SessionRecord): InteractionRecord {
  if (!session.runtimeEpoch) throw new Error("test session has no runtime epoch");
  return {
    interactionId: newInteractionId(),
    sessionId: session.sessionId,
    harness: session.harness,
    runtimeEpoch: session.runtimeEpoch,
    nativeRequestId: "native-approval-v3",
    requestType: "approval",
    payload: { command: "echo invariant" },
    ephemeral: false,
    state: "pending",
    createdAt: now,
    expiresAt: null,
    resolvedAt: null,
  };
}

function commandFor(fixture: RuntimeFixture): CommandEnvelope {
  return {
    commandId: newCommandId(),
    payloadHash,
    sessionId: fixture.session.sessionId,
    runtimeNodeId: fixture.runtime.runtimeNodeId,
    bindingRevision: fixture.session.bindingRevision,
    request: {
      harness: "codex",
      command: { type: "setModel", model: "gpt-5.6-codex" },
    },
  };
}

function recordFor(
  command: CommandEnvelope,
  state: CommandRecord["state"] = "succeeded",
): CommandRecord {
  return {
    commandId: command.commandId,
    payloadHash: command.payloadHash,
    sessionId: command.sessionId,
    runtimeNodeId: command.runtimeNodeId,
    state,
    request: jsonValueSchema.parse(command),
    ...(state === "succeeded" ? { result: { accepted: true } } : {}),
    // Runtime timestamps are not authoritative for the command's identity.
    // The control node must retain the timestamp from its accepted request.
    createdAt: remoteCommandTime,
    updatedAt: remoteCommandTime,
  };
}

function attachmentRequest(
  parent: ControlNodeCatalog,
  child: ControlNodeCatalog,
): ControlNodeAttachmentRequest {
  const local = child.localControlNode();
  return {
    controlNodeId: local.controlNodeId,
    controlNodeBootId: local.controlNodeBootId,
    feedId: local.feedId,
    name: local.name,
    ...(local.endpointId ? { endpointId: local.endpointId } : {}),
    protocolVersion: 4,
    capabilities: local.capabilities,
    expectedParentControlNodeId: parent.localControlNode().controlNodeId,
    childProof: child.attachmentProof(),
  };
}

function childSnapshotPage(
  snapshot: AccessSnapshot,
  attachment: ControlNodeAttachment,
) {
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
}

function childSnapshotConnection(
  identity: Pick<
    ChildControlNodeConnection,
    "controlNodeId" | "controlNodeBootId" | "endpointId"
  >,
  attachment: ControlNodeAttachment,
  readSnapshot: () => AccessSnapshot | Promise<AccessSnapshot>,
  options: {
    readonly onSubscribe?: (() => void) | undefined;
    readonly listModels?: ChildControlNodeConnection["listModels"] | undefined;
  } = {},
): ChildControlNodeConnection {
  return {
    ...identity,
    async readSubtreeSnapshot(request) {
      if (
        request.attachmentId !== attachment.attachmentId ||
        request.lineageId !== attachment.lineageId
      ) throw new Error("snapshot requested with a stale attachment fence");
      return childSnapshotPage(await readSnapshot(), attachment);
    },
    async *subscribeAggregate(_cursor, signal) {
      options.onSubscribe?.();
      if (signal?.aborted) return;
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    listModels: options.listModels ?? (() => Promise.resolve([])),
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function peerEnrollment(filename: string, endpointId: string): unknown {
  const database = new DatabaseSync(filename);
  try {
    return database.prepare(`
      SELECT endpoint_id, role, principal_id
      FROM peer_enrollments
      WHERE endpoint_id = ?
    `).get(endpointId);
  } finally {
    database.close();
  }
}

function installFailureTrigger(filename: string, sql: string): void {
  const database = new DatabaseSync(filename);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

describe("control-node protocol-v4 hardening invariants", () => {
  it("rejects fabricated resume lineage on a fresh child attachment", async () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("fresh-lineage"), now: clock });
    const service = new ControlNodeService({ catalog, now: clock });
    const child = childRequest(catalog);

    await expect(service.attachChild({
      ...child,
      resume: {
        attachmentId: newAttachmentId(),
        lineageId: newLineageId(),
        authority: catalog.authority(),
      },
    }, {
      endpointId: "fabricated-lineage-endpoint",
      authenticatedControlNodeId: child.controlNodeId,
    })).rejects.toMatchObject({ code: "FENCED" });
    expect(catalog.getAttachment(child.controlNodeId)).toBeNull();
    expect(catalog.activePeerEnrollment("fabricated-lineage-endpoint")).toBeNull();

    service.close();
    catalog.close();
  });

  it("commits parent attachment and endpoint enrollment atomically", () => {
    const parent = new ControlNodeCatalog({ filename: stateFile("parent-enrollment-source"), now: clock });
    const childFile = stateFile("parent-enrollment-child");
    const child = new ControlNodeCatalog({ filename: childFile, now: clock });
    const request: ControlNodeAttachmentRequest = {
      ...childRequest(parent),
      controlNodeId: child.localControlNode().controlNodeId,
      controlNodeBootId: child.localControlNode().controlNodeBootId,
      feedId: child.localControlNode().feedId,
      childProof: child.attachmentProof(),
    };
    const { attachment } = parent.attachChild(request);
    const endpointId = "durable-parent-endpoint";

    installFailureTrigger(childFile, `
      CREATE TRIGGER fail_parent_role_after_enrollment
      BEFORE UPDATE ON control_node_role
      BEGIN
        SELECT RAISE(ABORT, 'injected parent attachment failure');
      END;
    `);
    expect(() => child.applyParentAttachment(attachment, endpointId)).toThrow(
      /injected parent attachment failure/,
    );
    expect(child.dataRole().role).toBe("authority");
    expect(peerEnrollment(childFile, endpointId)).toBeUndefined();
    installFailureTrigger(childFile, "DROP TRIGGER fail_parent_role_after_enrollment;");

    child.applyParentAttachment(attachment, endpointId);
    expect(child.dataRole()).toMatchObject({
      role: "branch",
      branch: { attachmentId: attachment.attachmentId },
    });
    expect(child.activePeerEnrollment(endpointId)).toEqual({
      role: "parent-control-node",
      principalId: parent.localControlNode().controlNodeId,
      scopes: [],
    });
    const transitionCount = child.listRoleTransitions().length;
    expect(child.applyParentAttachment(attachment, endpointId)).toEqual(
      child.localControlNode(),
    );
    expect(child.listRoleTransitions()).toHaveLength(transitionCount);

    const otherParent = newControlNodeId();
    expect(() => child.enrollPeer(endpointId, "parent-control-node", otherParent)).toThrowError(
      expect.objectContaining({ code: "FENCED" }),
    );
    expect(() => child.enrollPeer("other-parent-endpoint", "parent-control-node", parent.localControlNode().controlNodeId)).toThrowError(
      expect.objectContaining({ code: "FENCED" }),
    );

    child.close();
    parent.close();
  });

  it("commits endpoint enrollment atomically with runtime registration and child attachment", async () => {
    const filename = stateFile("atomic-enrollment");
    const catalog = new ControlNodeCatalog({ filename, now: clock });
    const service = new ControlNodeService({ catalog, now: clock });

    const runtime = registration();
    const runtimeEndpoint = "runtime-atomic-endpoint";
    installFailureTrigger(filename, `
      CREATE TRIGGER fail_runtime_after_enrollment
      BEFORE INSERT ON runtime_nodes
      BEGIN
        SELECT RAISE(ABORT, 'injected runtime registration failure');
      END;
    `);
    expect(() => service.registerRuntimeNode(runtime, {
      endpointId: runtimeEndpoint,
      authenticatedRuntimeNodeId: runtime.runtimeNodeId,
    })).toThrow(/injected runtime registration failure/);
    expect(catalog.getRuntimeNode(runtime.runtimeNodeId)).toBeNull();
    expect(peerEnrollment(filename, runtimeEndpoint)).toBeUndefined();
    installFailureTrigger(filename, "DROP TRIGGER fail_runtime_after_enrollment;");

    service.registerRuntimeNode(runtime, {
      endpointId: runtimeEndpoint,
      authenticatedRuntimeNodeId: runtime.runtimeNodeId,
    });
    expect(catalog.activePeerEnrollment(runtimeEndpoint)).toEqual({
      role: "runtime-node",
      principalId: runtime.runtimeNodeId,
      scopes: [],
    });

    const child = childRequest(catalog);
    const childEndpoint = "child-atomic-endpoint";
    installFailureTrigger(filename, `
      CREATE TRIGGER fail_attachment_after_enrollment
      BEFORE INSERT ON attachments
      BEGIN
        SELECT RAISE(ABORT, 'injected child attachment failure');
      END;
    `);
    await expect(service.attachChild(child, {
      endpointId: childEndpoint,
      authenticatedControlNodeId: child.controlNodeId,
    })).rejects.toThrow(/injected child attachment failure/);
    expect(catalog.getAttachment(child.controlNodeId)).toBeNull();
    expect(catalog.getControlNode(child.controlNodeId)).toBeNull();
    expect(peerEnrollment(filename, childEndpoint)).toBeUndefined();
    installFailureTrigger(filename, "DROP TRIGGER fail_attachment_after_enrollment;");

    await service.attachChild(child, {
      endpointId: childEndpoint,
      authenticatedControlNodeId: child.controlNodeId,
    });
    expect(catalog.activePeerEnrollment(childEndpoint)).toEqual({
      role: "child-control-node",
      principalId: child.controlNodeId,
      scopes: [],
    });

    service.close();
    catalog.close();
  });

  it("rejects a reverse runtime port that omits its authenticated endpoint", () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("reverse-port-identity"), now: clock });
    const service = new ControlNodeService({ catalog, now: clock });
    const runtime = registration();
    const endpointId = "runtime-reverse-port-endpoint";
    expect(() => service.registerRuntimeNode(runtime, {
      endpointId,
      authenticatedRuntimeNodeId: runtime.runtimeNodeId,
      runtimeNodeConnection: runtimeConnection(runtime),
    })).toThrowError(expect.objectContaining({ code: "FENCED" }));
    expect(catalog.getRuntimeNode(runtime.runtimeNodeId)).toBeNull();
    expect(catalog.activePeerEnrollment(endpointId)).toBeNull();

    service.close();
    catalog.close();
  });

  it("rebuilds a runtime reverse port from an authenticated heartbeat after restart", async () => {
    const filename = stateFile("heartbeat-rebind");
    const runtime = registration();
    const context = {
      endpointId: `runtime-endpoint-${runtime.runtimeNodeId}`,
      authenticatedRuntimeNodeId: runtime.runtimeNodeId,
    };
    const firstCatalog = new ControlNodeCatalog({ filename, now: clock });
    const firstService = new ControlNodeService({ catalog: firstCatalog, now: clock });
    firstService.registerRuntimeNode(runtime, {
      ...context,
      runtimeNodeConnection: runtimeConnection(runtime, { endpointId: context.endpointId }),
    });
    firstService.close();
    firstCatalog.close();

    const listModels = vi.fn().mockResolvedValue([]);
    const connection = runtimeConnection(runtime, {
      endpointId: context.endpointId,
      listModels,
    });
    const createRuntimeNodeConnection = vi.fn().mockReturnValue(connection);
    const attached = vi.fn();
    const restartedCatalog = new ControlNodeCatalog({ filename, now: clock });
    const restartedService = new ControlNodeService({
      catalog: restartedCatalog,
      now: clock,
      onRuntimeNodeConnectionAttached: attached,
    });

    expect(restartedService.heartbeatRuntimeNode({
      runtimeNodeId: runtime.runtimeNodeId,
      runtimeNodeBootId: runtime.runtimeNodeBootId,
    }, {
      ...context,
      createRuntimeNodeConnection,
    })).toMatchObject({ accepted: true });
    expect(createRuntimeNodeConnection).toHaveBeenCalledOnce();
    expect(createRuntimeNodeConnection).toHaveBeenCalledWith(
      runtime.runtimeNodeId,
      runtime.runtimeNodeBootId,
    );
    expect(attached).toHaveBeenCalledWith(connection);
    await expect(restartedService.listModels(runtime.runtimeNodeId, "codex"))
      .resolves.toEqual([]);
    expect(listModels).toHaveBeenCalledOnce();

    // An ordinary heartbeat must retain the established reverse port rather
    // than constructing and pumping a duplicate connection.
    restartedService.heartbeatRuntimeNode({
      runtimeNodeId: runtime.runtimeNodeId,
      runtimeNodeBootId: runtime.runtimeNodeBootId,
    }, {
      ...context,
      createRuntimeNodeConnection,
    });
    expect(createRuntimeNodeConnection).toHaveBeenCalledOnce();
    expect(attached).toHaveBeenCalledOnce();

    restartedService.close();
    restartedCatalog.close();
  });

  it("rebuilds one child reverse port from concurrent authenticated heartbeats after restart", async () => {
    const parentFile = stateFile("child-heartbeat-rebind-parent");
    const childEndpointId = "child-heartbeat-rebind-endpoint";
    const parentEndpointId = "parent-heartbeat-rebind-endpoint";
    const childCatalog = new ControlNodeCatalog({
      filename: stateFile("child-heartbeat-rebind-child"),
      endpointId: childEndpointId,
      now: clock,
    });
    const firstParentCatalog = new ControlNodeCatalog({ filename: parentFile, now: clock });
    const firstParentService = new ControlNodeService({ catalog: firstParentCatalog, now: clock });
    const childRequest = attachmentRequest(firstParentCatalog, childCatalog);
    const attached = await firstParentService.attachChild(childRequest, {
      endpointId: childEndpointId,
      authenticatedControlNodeId: childRequest.controlNodeId,
    });
    childCatalog.applyParentAttachment(attached.attachment, parentEndpointId);
    const childRuntime = registration();
    childCatalog.registerRuntimeNode(childRuntime);

    firstParentService.close();
    firstParentCatalog.close();

    const snapshot = childCatalog.accessSnapshot();
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const readSnapshot = vi.fn(async () => {
      await snapshotGate;
      return snapshot;
    });
    const onSubscribe = vi.fn();
    const listModels = vi.fn().mockResolvedValue([]);
    const connection = childSnapshotConnection({
      controlNodeId: childRequest.controlNodeId,
      controlNodeBootId: childRequest.controlNodeBootId,
      endpointId: childEndpointId,
    }, attached.attachment, readSnapshot, { onSubscribe, listModels });
    const createChildControlNodeConnection = vi.fn().mockReturnValue(connection);
    const onAttached = vi.fn();
    const restartedParentCatalog = new ControlNodeCatalog({ filename: parentFile, now: clock });
    const restartedParentService = new ControlNodeService({
      catalog: restartedParentCatalog,
      now: clock,
      onChildControlNodeConnectionAttached: onAttached,
    });
    const heartbeat = {
      controlNodeId: childRequest.controlNodeId,
      controlNodeBootId: childRequest.controlNodeBootId,
      attachmentId: attached.attachment.attachmentId,
      lineageId: attached.attachment.lineageId,
      checkpoint: childCatalog.feedCheckpoint(),
    };
    const context = {
      endpointId: childEndpointId,
      authenticatedControlNodeId: childRequest.controlNodeId,
      createChildControlNodeConnection,
    };

    const firstHeartbeat = restartedParentService.heartbeatChild(heartbeat, context);
    const secondHeartbeat = restartedParentService.heartbeatChild(heartbeat, context);
    expect(createChildControlNodeConnection).toHaveBeenCalledOnce();
    expect(createChildControlNodeConnection).toHaveBeenCalledWith({
      controlNodeId: childRequest.controlNodeId,
      controlNodeBootId: childRequest.controlNodeBootId,
    });
    expect(readSnapshot).toHaveBeenCalledOnce();

    releaseSnapshot();
    await expect(Promise.all([firstHeartbeat, secondHeartbeat])).resolves.toEqual([
      expect.objectContaining({ accepted: true }),
      expect.objectContaining({ accepted: true }),
    ]);
    expect(readSnapshot).toHaveBeenCalledOnce();
    expect(onSubscribe).toHaveBeenCalledOnce();
    expect(onAttached).toHaveBeenCalledOnce();
    expect(restartedParentCatalog.getControlNode(childRequest.controlNodeId)).toMatchObject({
      presence: "online",
    });
    await expect(restartedParentService.listModels(childRuntime.runtimeNodeId, "codex"))
      .resolves.toEqual([]);
    expect(listModels).toHaveBeenCalledWith(childRuntime.runtimeNodeId, "codex");

    restartedParentService.close();
    restartedParentCatalog.close();
    childCatalog.close();
  });

  it("fences a superseded child snapshot before it can replace a newer projection or pump", async () => {
    const childEndpointId = "child-snapshot-generation-endpoint";
    const parentCatalog = new ControlNodeCatalog({
      filename: stateFile("child-snapshot-generation-parent"),
      now: clock,
    });
    const childCatalog = new ControlNodeCatalog({
      filename: stateFile("child-snapshot-generation-child"),
      endpointId: childEndpointId,
      now: clock,
    });
    const request = attachmentRequest(parentCatalog, childCatalog);
    const { attachment } = parentCatalog.attachChild(request);
    childCatalog.applyParentAttachment(
      attachment,
      "parent-snapshot-generation-endpoint",
    );
    const oldSnapshot = childCatalog.accessSnapshot();
    const childRuntime = registration();
    childCatalog.registerRuntimeNode(childRuntime);
    const newSnapshot = childCatalog.accessSnapshot();

    let signalOldStarted!: () => void;
    const oldStarted = new Promise<void>((resolve) => {
      signalOldStarted = resolve;
    });
    let releaseOldSnapshot!: () => void;
    const oldSnapshotGate = new Promise<void>((resolve) => {
      releaseOldSnapshot = resolve;
    });
    const oldSubscribe = vi.fn();
    const newSubscribe = vi.fn();
    const identity = {
      controlNodeId: request.controlNodeId,
      controlNodeBootId: request.controlNodeBootId,
      endpointId: childEndpointId,
    };
    const oldConnection = childSnapshotConnection(
      identity,
      attachment,
      async () => {
        signalOldStarted();
        await oldSnapshotGate;
        return oldSnapshot;
      },
      { onSubscribe: oldSubscribe },
    );
    const newConnection = childSnapshotConnection(
      identity,
      attachment,
      () => newSnapshot,
      { onSubscribe: newSubscribe },
    );
    const service = new ControlNodeService({ catalog: parentCatalog, now: clock });

    const obsoleteSynchronization = service.attachChildConnection(oldConnection);
    await oldStarted;
    await expect(service.attachChildConnection(newConnection)).resolves.toBeUndefined();
    expect(parentCatalog.getRuntimeNode(childRuntime.runtimeNodeId)).toMatchObject({
      runtimeNodeId: childRuntime.runtimeNodeId,
      ownerControlNodeId: request.controlNodeId,
    });
    expect(newSubscribe).toHaveBeenCalledOnce();
    expect(oldSubscribe).not.toHaveBeenCalled();

    releaseOldSnapshot();
    await expect(obsoleteSynchronization).rejects.toMatchObject({ code: "FENCED" });
    expect(parentCatalog.getRuntimeNode(childRuntime.runtimeNodeId)).toMatchObject({
      runtimeNodeId: childRuntime.runtimeNodeId,
      ownerControlNodeId: request.controlNodeId,
    });
    expect(newSubscribe).toHaveBeenCalledOnce();
    expect(oldSubscribe).not.toHaveBeenCalled();

    service.close();
    parentCatalog.close();
    childCatalog.close();
  });

  it("quiesces the old child pump before capturing a replacement snapshot barrier", async () => {
    const childEndpointId = "child-snapshot-barrier-endpoint";
    const parentCatalog = new ControlNodeCatalog({
      filename: stateFile("child-snapshot-barrier-parent"),
      now: clock,
    });
    const childCatalog = new ControlNodeCatalog({
      filename: stateFile("child-snapshot-barrier-child"),
      endpointId: childEndpointId,
      now: clock,
    });
    const request = attachmentRequest(parentCatalog, childCatalog);
    const { attachment } = parentCatalog.attachChild(request);
    childCatalog.applyParentAttachment(attachment, "parent-snapshot-barrier-endpoint");
    const initialSnapshot = childCatalog.accessSnapshot();
    const identity = {
      controlNodeId: request.controlNodeId,
      controlNodeBootId: request.controlNodeBootId,
      endpointId: childEndpointId,
    };
    const oldStreamItem = deferred<AccessStreamItem>();
    const oldStreamSubscribed = deferred<void>();
    const oldStreamFinished = deferred<void>();
    const oldBase = childSnapshotConnection(
      identity,
      attachment,
      () => initialSnapshot,
    );
    const oldConnection: ChildControlNodeConnection = {
      ...oldBase,
      async *subscribeAggregate() {
        oldStreamSubscribed.resolve(undefined);
        try {
          yield await oldStreamItem.promise;
        } finally {
          oldStreamFinished.resolve(undefined);
        }
      },
    };
    const replacementSnapshotCaptured = deferred<void>();
    const releaseReplacementSnapshot = deferred<void>();
    let replayItem: FeedControlItem | undefined;
    const newStreamSubscribed = deferred<void>();
    const newBase = childSnapshotConnection(
      identity,
      attachment,
      async () => {
        // Capture the immutable barrier before the child creates the event
        // that both the retired and replacement streams will observe.
        const captured = childCatalog.accessSnapshot();
        replacementSnapshotCaptured.resolve(undefined);
        await releaseReplacementSnapshot.promise;
        return captured;
      },
    );
    const newConnection: ChildControlNodeConnection = {
      ...newBase,
      async *subscribeAggregate(_cursor, signal) {
        newStreamSubscribed.resolve(undefined);
        if (replayItem) yield replayItem;
        if (signal?.aborted) return;
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const service = new ControlNodeService({ catalog: parentCatalog, now: clock });
    await service.attachChildConnection(oldConnection);
    await oldStreamSubscribed.promise;

    const replacement = service.attachChildConnection(newConnection);
    await replacementSnapshotCaptured.promise;
    const childRuntime = registration();
    childCatalog.registerRuntimeNode(childRuntime);
    replayItem = childCatalog.controlEventsAfter(
      initialSnapshot.source.manifest.controlCursor,
    ).find((item) =>
      item.change.type === "runtimeNode.upsert" &&
      item.change.runtimeNode.runtimeNodeId === childRuntime.runtimeNodeId,
    );
    expect(replayItem).toBeDefined();

    // Even an iterator that ignores AbortSignal cannot mutate the projection:
    // the pump checks its synchronously aborted controller before importing.
    oldStreamItem.resolve(replayItem!);
    await oldStreamFinished.promise;
    expect(parentCatalog.getRuntimeNode(childRuntime.runtimeNodeId)).toBeNull();

    releaseReplacementSnapshot.resolve(undefined);
    await expect(replacement).resolves.toBeUndefined();
    await newStreamSubscribed.promise;
    for (
      let attempt = 0;
      attempt < 20 && !parentCatalog.getRuntimeNode(childRuntime.runtimeNodeId);
      attempt += 1
    ) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(parentCatalog.getRuntimeNode(childRuntime.runtimeNodeId)).toMatchObject({
      runtimeNodeId: childRuntime.runtimeNodeId,
      ownerControlNodeId: request.controlNodeId,
    });
    expect(parentCatalog.childCheckpoint(request.controlNodeId)).toMatchObject({
      feedId: replayItem!.feedId,
      controlCursor: replayItem!.cursor,
    });

    service.close();
    parentCatalog.close();
    childCatalog.close();
  });

  it("does not let an obsolete same-boot disconnect cancel a newer child synchronization", async () => {
    const childEndpointId = "child-generation-detach-endpoint";
    const parentCatalog = new ControlNodeCatalog({
      filename: stateFile("child-generation-detach-parent"),
      now: clock,
    });
    const childCatalog = new ControlNodeCatalog({
      filename: stateFile("child-generation-detach-child"),
      endpointId: childEndpointId,
      now: clock,
    });
    const request = attachmentRequest(parentCatalog, childCatalog);
    const { attachment } = parentCatalog.attachChild(request);
    childCatalog.applyParentAttachment(attachment, "parent-generation-detach-endpoint");
    const snapshot = childCatalog.accessSnapshot();
    const identity = {
      controlNodeId: request.controlNodeId,
      controlNodeBootId: request.controlNodeBootId,
      endpointId: childEndpointId,
    };
    const oldConnection = childSnapshotConnection(identity, attachment, () => snapshot);
    const replacementStarted = deferred<void>();
    const releaseReplacement = deferred<void>();
    const replacementSubscribed = vi.fn();
    const newConnection = childSnapshotConnection(
      identity,
      attachment,
      async () => {
        replacementStarted.resolve(undefined);
        await releaseReplacement.promise;
        return snapshot;
      },
      { onSubscribe: replacementSubscribed },
    );
    const service = new ControlNodeService({ catalog: parentCatalog, now: clock });
    await service.attachChildConnection(oldConnection);

    const replacement = service.attachChildConnection(newConnection);
    await replacementStarted.promise;
    service.detachChildConnection(oldConnection);
    releaseReplacement.resolve(undefined);

    await expect(replacement).resolves.toBeUndefined();
    expect(replacementSubscribed).toHaveBeenCalledOnce();
    expect(parentCatalog.getControlNode(request.controlNodeId)).toMatchObject({
      presence: "online",
    });

    service.close();
    parentCatalog.close();
    childCatalog.close();
  });

  it("tears down a synchronized child pump when its attachment observer closes the service", async () => {
    const childEndpointId = "child-callback-close-endpoint";
    const parentCatalog = new ControlNodeCatalog({
      filename: stateFile("child-callback-close-parent"),
      now: clock,
    });
    const childCatalog = new ControlNodeCatalog({
      filename: stateFile("child-callback-close-child"),
      endpointId: childEndpointId,
      now: clock,
    });
    const request = attachmentRequest(parentCatalog, childCatalog);
    const { attachment } = parentCatalog.attachChild(request);
    childCatalog.applyParentAttachment(attachment, "parent-callback-close-endpoint");
    const streamStarted = deferred<void>();
    const streamFinished = deferred<void>();
    const connection = {
      ...childSnapshotConnection({
        controlNodeId: request.controlNodeId,
        controlNodeBootId: request.controlNodeBootId,
        endpointId: childEndpointId,
      }, attachment, () => childCatalog.accessSnapshot()),
      async *subscribeAggregate(_cursor: unknown, signal?: AbortSignal) {
        streamStarted.resolve(undefined);
        try {
          if (signal?.aborted) return;
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        } finally {
          streamFinished.resolve(undefined);
        }
      },
    } satisfies ChildControlNodeConnection;
    let service!: ControlNodeService;
    service = new ControlNodeService({
      catalog: parentCatalog,
      now: clock,
      onChildControlNodeConnectionAttached: () => service.close(),
    });

    await expect(service.attachChildConnection(connection)).rejects.toMatchObject({
      code: "FENCED",
    });
    await streamStarted.promise;
    await streamFinished.promise;

    parentCatalog.close();
    childCatalog.close();
  });

  it("rejects a heartbeat factory port for another child before synchronizing it", async () => {
    const childEndpointId = "child-factory-identity-endpoint";
    const parentCatalog = new ControlNodeCatalog({
      filename: stateFile("child-factory-identity-parent"),
      now: clock,
    });
    const childCatalog = new ControlNodeCatalog({
      filename: stateFile("child-factory-identity-child"),
      endpointId: childEndpointId,
      now: clock,
    });
    const request = attachmentRequest(parentCatalog, childCatalog);
    const { attachment } = parentCatalog.attachChild(request);
    childCatalog.applyParentAttachment(attachment, "parent-factory-identity-endpoint");
    const readSubtreeSnapshot = vi.fn();
    const foreignConnection = {
      ...childSnapshotConnection({
        controlNodeId: newControlNodeId(),
        controlNodeBootId: request.controlNodeBootId,
        endpointId: childEndpointId,
      }, attachment, () => childCatalog.accessSnapshot()),
      readSubtreeSnapshot,
    };
    const service = new ControlNodeService({ catalog: parentCatalog, now: clock });

    await expect(service.heartbeatChild({
      controlNodeId: request.controlNodeId,
      controlNodeBootId: request.controlNodeBootId,
      attachmentId: attachment.attachmentId,
      lineageId: attachment.lineageId,
      checkpoint: childCatalog.feedCheckpoint(),
    }, {
      endpointId: childEndpointId,
      authenticatedControlNodeId: request.controlNodeId,
      createChildControlNodeConnection: () => foreignConnection,
    })).rejects.toMatchObject({ code: "FENCED" });
    expect(readSubtreeSnapshot).not.toHaveBeenCalled();

    service.close();
    parentCatalog.close();
    childCatalog.close();
  });

  it("fences heartbeat reverse-port recovery by authenticated boot and endpoint", () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("heartbeat-rebind-fence"), now: clock });
    const service = new ControlNodeService({ catalog, now: clock });
    const runtime = registration();
    const endpointId = `runtime-endpoint-${runtime.runtimeNodeId}`;
    service.registerRuntimeNode(runtime, {
      endpointId,
      authenticatedRuntimeNodeId: runtime.runtimeNodeId,
    });
    const createRuntimeNodeConnection = vi.fn();

    expect(() => service.heartbeatRuntimeNode({
      runtimeNodeId: runtime.runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
    }, {
      endpointId,
      authenticatedRuntimeNodeId: runtime.runtimeNodeId,
      createRuntimeNodeConnection,
    })).toThrowError(expect.objectContaining({ code: "FENCED" }));
    expect(createRuntimeNodeConnection).not.toHaveBeenCalled();

    createRuntimeNodeConnection.mockReturnValueOnce(runtimeConnection(runtime, {
      endpointId: "different-authenticated-endpoint",
    }));
    expect(() => service.heartbeatRuntimeNode({
      runtimeNodeId: runtime.runtimeNodeId,
      runtimeNodeBootId: runtime.runtimeNodeBootId,
    }, {
      endpointId,
      authenticatedRuntimeNodeId: runtime.runtimeNodeId,
      createRuntimeNodeConnection,
    })).toThrowError(expect.objectContaining({ code: "FENCED" }));

    const wrongBoot = registration(runtime.runtimeNodeId, newRuntimeNodeBootId());
    createRuntimeNodeConnection.mockReturnValueOnce(runtimeConnection(wrongBoot, {
      endpointId,
    }));
    expect(() => service.heartbeatRuntimeNode({
      runtimeNodeId: runtime.runtimeNodeId,
      runtimeNodeBootId: runtime.runtimeNodeBootId,
    }, {
      endpointId,
      authenticatedRuntimeNodeId: runtime.runtimeNodeId,
      createRuntimeNodeConnection,
    })).toThrowError(expect.objectContaining({ code: "FENCED" }));
    expect(() => service.listModels(runtime.runtimeNodeId, "codex"))
      .toThrowError(expect.objectContaining({ code: "UNAVAILABLE" }));

    service.close();
    catalog.close();
  });

  it.each(["DISCONNECTED", "TIMEOUT"] as const)(
    "maps a nested p2prpc %s failure to SERVICE_UNAVAILABLE at the tRPC boundary",
    async (transportCode) => {
      const transportFailure = Object.assign(new Error("reverse RPC transport failed"), {
        code: transportCode,
      });
      const fixture = runtimeFixture({
        readNativeHistory: () => Promise.reject(Object.assign(
          new Error("runtime bridge failed", { cause: transportFailure }),
          { code: "INTERNAL" },
        )),
      });
      const caller = createAccessRouter(fixture.service).createCaller({
        trustedLocalAccess: true,
      });

      await expect(caller.sessions.readNativeHistory({
        sessionId: fixture.session.sessionId,
        request: { harness: "codex", includeTurns: true },
      })).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        message: "control node dependency is unavailable",
      });

      fixture.service.close();
      fixture.catalog.close();
    },
  );

  it("maps direct terminal attach domain failures at the tRPC boundary", async () => {
    const fixture = runtimeFixture();
    const caller = createAccessRouter(fixture.service).createCaller({
      trustedLocalAccess: true,
    });
    const stream = await caller.terminals.attach({
      sessionId: newSessionId(),
      runtimeNodeId: fixture.runtime.runtimeNodeId,
      bindingRevision: 1,
      terminalId: newTerminalId(),
    });

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "terminal session is unknown",
    });

    fixture.service.close();
    fixture.catalog.close();
  });

  it("rejects endpoint reuse, principal rebinding, and cross-role reuse", async () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("identity-reuse"), now: clock });
    const service = new ControlNodeService({ catalog, now: clock });
    const first = registration();
    service.registerRuntimeNode(first, {
      endpointId: "endpoint-one",
      authenticatedRuntimeNodeId: first.runtimeNodeId,
    });

    const second = registration();
    expect(() => service.registerRuntimeNode(second, {
      endpointId: "endpoint-one",
      authenticatedRuntimeNodeId: second.runtimeNodeId,
    })).toThrowError(expect.objectContaining({ code: "FENCED" }));
    expect(catalog.getRuntimeNode(second.runtimeNodeId)).toBeNull();

    expect(() => service.registerRuntimeNode(first, {
      endpointId: "endpoint-two",
      authenticatedRuntimeNodeId: first.runtimeNodeId,
    })).toThrowError(expect.objectContaining({ code: "FENCED" }));
    expect(catalog.activePeerEnrollment("endpoint-two")).toBeNull();

    const child = childRequest(catalog);
    await expect(service.attachChild(child, {
      endpointId: "endpoint-one",
      authenticatedControlNodeId: child.controlNodeId,
    })).rejects.toMatchObject({ code: "FENCED" });
    expect(catalog.getAttachment(child.controlNodeId)).toBeNull();

    service.close();
    catalog.close();
  });

  it("fails closed when a registered endpoint has no mapped runtime or child identity", async () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("fail-closed"), now: clock });
    const service = new ControlNodeService({ catalog, now: clock });
    const runtime = registration();
    const runtimeFence = {
      runtimeNodeId: runtime.runtimeNodeId,
      runtimeNodeBootId: runtime.runtimeNodeBootId,
    };
    service.registerRuntimeNode(runtime, {
      endpointId: "runtime-fail-closed",
      authenticatedRuntimeNodeId: runtime.runtimeNodeId,
    });

    expect(() => service.heartbeatRuntimeNode(runtimeFence, {
      endpointId: "runtime-fail-closed",
    })).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(() => service.heartbeatRuntimeNode(runtimeFence, {
      authenticatedRuntimeNodeId: runtime.runtimeNodeId,
    })).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(() => service.heartbeatRuntimeNode(runtimeFence, {
      endpointId: "wrong-endpoint",
      authenticatedRuntimeNodeId: runtime.runtimeNodeId,
    })).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(service.heartbeatRuntimeNode(runtimeFence, {
      endpointId: "runtime-fail-closed",
      authenticatedRuntimeNodeId: runtime.runtimeNodeId,
    })).toMatchObject({ accepted: true });

    const child = childRequest(catalog);
    const attached = await service.attachChild(child, {
      endpointId: "child-fail-closed",
      authenticatedControlNodeId: child.controlNodeId,
    });
    const childHeartbeat = {
      controlNodeId: child.controlNodeId,
      controlNodeBootId: child.controlNodeBootId,
      attachmentId: attached.attachment.attachmentId,
      lineageId: attached.attachment.lineageId,
      checkpoint: catalog.feedCheckpoint(),
    };
    await expect(service.heartbeatChild(childHeartbeat, {
      endpointId: "child-fail-closed",
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(service.heartbeatChild(childHeartbeat, {
      endpointId: "child-fail-closed",
      authenticatedControlNodeId: child.controlNodeId,
    })).resolves.toMatchObject({ accepted: true });

    service.close();
    catalog.close();
  });

  it("rejects an obsolete runtime boot on every runtime-originated mutation", async () => {
    const fixture = runtimeFixture();
    const pending = pendingInteraction(fixture.session);
    fixture.service.publishInteraction({
      runtimeNodeId: fixture.runtime.runtimeNodeId,
      runtimeNodeBootId: fixture.runtime.runtimeNodeBootId,
      interaction: pending,
    }, fixture.context);

    const replacement = registration(
      fixture.runtime.runtimeNodeId,
      newRuntimeNodeBootId(),
    );
    fixture.service.registerRuntimeNode(replacement, {
      ...fixture.context,
      runtimeNodeConnection: runtimeConnection(replacement, {
        endpointId: fixture.context.endpointId,
      }),
    });
    const oldFence = {
      runtimeNodeId: fixture.runtime.runtimeNodeId,
      runtimeNodeBootId: fixture.runtime.runtimeNodeBootId,
    };

    expect(() => fixture.service.reconcile({
      ...oldFence,
      snapshot: inventory(fixture.runtime, fixture.session.runtimeEpoch!),
    }, fixture.context)).toThrowError(expect.objectContaining({ code: "FENCED" }));

    await expect(fixture.service.pushRuntimeMetadataOutbox({
      ...oldFence,
      patches: [{
        operationId: newOperationId(),
        sessionId: fixture.session.sessionId,
        expectedAuthority: fixture.catalog.authority(),
        set: { "agent.title": "must-not-apply" },
      }],
    }, fixture.context)).rejects.toMatchObject({ code: "FENCED" });

    const fencedSession = fixture.catalog.getSession(fixture.session.sessionId)!;
    expect(() => fixture.service.publishRuntimeEvent({
      ...oldFence,
      event: {
        kind: "control",
        change: {
          type: "session.upsert",
          session: {
            ...fencedSession,
            availability: "active",
            runtimeStatus: "running",
            runtimeEpoch: fixture.session.runtimeEpoch,
          },
        },
      },
    }, fixture.context)).toThrowError(expect.objectContaining({ code: "FENCED" }));

    expect(() => fixture.service.publishInteraction({
      ...oldFence,
      interaction: pending,
    }, fixture.context)).toThrowError(expect.objectContaining({ code: "FENCED" }));

    expect(fixture.catalog.getMetadata(fixture.session.sessionId).values).toEqual({});
    expect(fixture.catalog.getSession(fixture.session.sessionId)).toMatchObject({
      availability: "resumable",
      runtimeStatus: "stopped",
      runtimeEpoch: null,
    });
    expect(fixture.catalog.getInteraction(pending.interactionId)).toMatchObject({ state: "stale" });

    fixture.service.close();
    fixture.catalog.close();
  });

  it("prevalidates a runtime metadata batch so it cannot partially patch another runtime", async () => {
    const fixture = runtimeFixture();
    const other = registration();
    const otherContext = {
      endpointId: `runtime-endpoint-${other.runtimeNodeId}`,
      authenticatedRuntimeNodeId: other.runtimeNodeId,
    };
    fixture.service.registerRuntimeNode(other, {
      ...otherContext,
      runtimeNodeConnection: runtimeConnection(other, {
        endpointId: otherContext.endpointId,
      }),
    });
    const [otherSession] = fixture.service.reconcile({
      runtimeNodeId: other.runtimeNodeId,
      runtimeNodeBootId: other.runtimeNodeBootId,
      snapshot: inventory(other),
    }, otherContext).sessions;

    const ownOperationId = newOperationId();
    await expect(fixture.service.pushRuntimeMetadataOutbox({
      runtimeNodeId: fixture.runtime.runtimeNodeId,
      runtimeNodeBootId: fixture.runtime.runtimeNodeBootId,
      patches: [{
        operationId: ownOperationId,
        sessionId: fixture.session.sessionId,
        expectedAuthority: fixture.catalog.authority(),
        set: { "agent.title": "must-roll-back" },
      }, {
        operationId: newOperationId(),
        sessionId: otherSession!.sessionId,
        expectedAuthority: fixture.catalog.authority(),
        set: { "agent.title": "foreign" },
      }],
    }, fixture.context)).rejects.toMatchObject({ code: "FENCED" });
    expect(fixture.catalog.getMetadata(fixture.session.sessionId).values).toEqual({});
    expect(fixture.catalog.getMetadataOperation(ownOperationId)).toBeNull();

    fixture.service.close();
    fixture.catalog.close();
  });

  it("stales pending interactions transactionally on boot replacement and emits both changes", () => {
    const fixture = runtimeFixture();
    const pending = pendingInteraction(fixture.session);
    fixture.service.publishInteraction({
      runtimeNodeId: fixture.runtime.runtimeNodeId,
      runtimeNodeBootId: fixture.runtime.runtimeNodeBootId,
      interaction: pending,
    }, fixture.context);
    const cursor = fixture.catalog.controlCursor();

    const replacement = registration(fixture.runtime.runtimeNodeId, newRuntimeNodeBootId());
    fixture.service.registerRuntimeNode(replacement, {
      ...fixture.context,
      runtimeNodeConnection: runtimeConnection(replacement, {
        endpointId: fixture.context.endpointId,
      }),
    });

    expect(fixture.catalog.getSession(fixture.session.sessionId)).toMatchObject({
      availability: "resumable",
      runtimeStatus: "stopped",
      runtimeEpoch: null,
    });
    expect(fixture.catalog.getInteraction(pending.interactionId)).toMatchObject({
      state: "stale",
      resolvedAt: now,
    });
    const changes = fixture.catalog.controlEventsAfter(cursor).map((item) => item.change);
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "session.upsert",
        session: expect.objectContaining({ sessionId: fixture.session.sessionId, runtimeEpoch: null }),
      }),
      expect.objectContaining({
        type: "interaction.changed",
        interaction: expect.objectContaining({ interactionId: pending.interactionId, state: "stale" }),
      }),
    ]));

    fixture.service.close();
    fixture.catalog.close();
  });

  it("retires old interaction epochs on same-boot lifecycle changes and disappearance", () => {
    const fixture = runtimeFixture();
    const first = pendingInteraction(fixture.session);
    fixture.service.publishInteraction({
      runtimeNodeId: fixture.runtime.runtimeNodeId,
      runtimeNodeBootId: fixture.runtime.runtimeNodeBootId,
      interaction: first,
    }, fixture.context);

    const nextEpoch = newRuntimeEpoch();
    const [restarted] = fixture.service.reconcile({
      runtimeNodeId: fixture.runtime.runtimeNodeId,
      runtimeNodeBootId: fixture.runtime.runtimeNodeBootId,
      snapshot: {
        ...inventory(fixture.runtime, nextEpoch),
        generation: "same-boot-restarted",
      },
    }, fixture.context).sessions;
    expect(fixture.catalog.getInteraction(first.interactionId)).toMatchObject({ state: "stale" });
    expect(restarted).toMatchObject({ runtimeEpoch: nextEpoch, availability: "active" });

    const second = pendingInteraction(restarted!);
    fixture.service.publishInteraction({
      runtimeNodeId: fixture.runtime.runtimeNodeId,
      runtimeNodeBootId: fixture.runtime.runtimeNodeBootId,
      interaction: second,
    }, fixture.context);
    fixture.service.reconcile({
      runtimeNodeId: fixture.runtime.runtimeNodeId,
      runtimeNodeBootId: fixture.runtime.runtimeNodeBootId,
      snapshot: {
        ...inventory(fixture.runtime, nextEpoch),
        generation: "same-boot-missing",
        sessions: [],
      },
    }, fixture.context);
    expect(fixture.catalog.getInteraction(second.interactionId)).toMatchObject({ state: "stale" });
    expect(fixture.catalog.getSession(fixture.session.sessionId)).toMatchObject({
      availability: "unavailable",
      runtimeStatus: "unknown",
      runtimeEpoch: null,
    });

    fixture.service.close();
    fixture.catalog.close();
  });

  it("deduplicates exact inventory replay and rejects generation reuse or older snapshots", () => {
    const fixture = runtimeFixture();
    const cursor = fixture.catalog.controlCursor();
    const exact = inventory(fixture.runtime, fixture.session.runtimeEpoch!);
    expect(fixture.service.reconcile({
      runtimeNodeId: fixture.runtime.runtimeNodeId,
      runtimeNodeBootId: fixture.runtime.runtimeNodeBootId,
      snapshot: exact,
    }, fixture.context).sessions).toHaveLength(1);
    expect(fixture.catalog.controlCursor()).toBe(cursor);

    expect(() => fixture.service.reconcile({
      runtimeNodeId: fixture.runtime.runtimeNodeId,
      runtimeNodeBootId: fixture.runtime.runtimeNodeBootId,
      snapshot: {
        ...exact,
        sessions: [{ ...exact.sessions[0]!, runtimeStatus: "running" }],
      },
    }, fixture.context)).toThrowError(expect.objectContaining({ code: "PAYLOAD_MISMATCH" }));
    expect(() => fixture.service.reconcile({
      runtimeNodeId: fixture.runtime.runtimeNodeId,
      runtimeNodeBootId: fixture.runtime.runtimeNodeBootId,
      snapshot: {
        ...exact,
        generation: "older-generation",
        capturedAt: "2037-04-05T06:07:07.000Z",
      },
    }, fixture.context)).toThrowError(expect.objectContaining({ code: "FENCED" }));
    expect(fixture.catalog.controlCursor()).toBe(cursor);

    fixture.service.close();
    fixture.catalog.close();
  });

  it("rejects native events from a retired epoch or wrong harness", () => {
    const fixture = runtimeFixture();
    const fence = {
      runtimeNodeId: fixture.runtime.runtimeNodeId,
      runtimeNodeBootId: fixture.runtime.runtimeNodeBootId,
    };
    const native = {
      kind: "native" as const,
      sessionId: fixture.session.sessionId,
      harness: fixture.session.harness,
      runtimeEpoch: fixture.session.runtimeEpoch!,
      sequence: 0,
      nativeType: "turn/started",
      payload: {},
      ephemeral: false,
    };
    expect(() => fixture.service.publishRuntimeEvent({
      ...fence,
      event: { ...native, runtimeEpoch: newRuntimeEpoch() },
    }, fixture.context)).toThrowError(expect.objectContaining({ code: "FENCED" }));
    expect(() => fixture.service.publishRuntimeEvent({
      ...fence,
      event: { ...native, harness: "copilot" },
    }, fixture.context)).toThrowError(expect.objectContaining({ code: "FENCED" }));
    expect(fixture.service.publishRuntimeEvent({ ...fence, event: native }, fixture.context)).toEqual({
      accepted: true,
    });

    fixture.service.close();
    fixture.catalog.close();
  });

  it("negatively acknowledges pre-inventory runtime events so their cursor can replay", () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("early-runtime-event"), now: clock });
    const service = new ControlNodeService({ catalog, now: clock });
    const runtime = registration();
    const context = {
      endpointId: `runtime-endpoint-${runtime.runtimeNodeId}`,
      authenticatedRuntimeNodeId: runtime.runtimeNodeId,
    };
    service.registerRuntimeNode(runtime, {
      ...context,
      runtimeNodeConnection: runtimeConnection(runtime, { endpointId: context.endpointId }),
    });
    const sessionId = newSessionId();
    const runtimeEpoch = newRuntimeEpoch();
    const native = {
      kind: "native" as const,
      sessionId,
      harness: "codex" as const,
      runtimeEpoch,
      sequence: 0,
      nativeType: "thread/started",
      payload: {},
      ephemeral: false,
    };
    const interaction = {
      kind: "control" as const,
      change: {
        type: "interaction.changed" as const,
        interaction: {
          interactionId: newInteractionId(),
          sessionId,
          harness: "codex" as const,
          runtimeEpoch,
          requestType: "userInput",
          payload: { question: "early" },
          ephemeral: false,
          state: "pending" as const,
          createdAt: now,
          expiresAt: null,
          resolvedAt: null,
        },
      },
    };
    const fence = {
      runtimeNodeId: runtime.runtimeNodeId,
      runtimeNodeBootId: runtime.runtimeNodeBootId,
    };

    expect(service.publishRuntimeEvent({ ...fence, event: native }, context)).toEqual({
      accepted: false,
    });
    expect(service.publishRuntimeEvent({ ...fence, event: interaction }, context)).toEqual({
      accepted: false,
    });

    expect(service.publishRuntimeEvent({
      ...fence,
      event: {
        kind: "control",
        change: {
          type: "session.upsert",
          session: {
            sessionId,
            runtimeNodeId: runtime.runtimeNodeId,
            harness: "codex",
            adapterScopeId: runtime.harnesses[0]!.adapterScopeId,
            vendorSessionId: "early-native-session",
            bindingRevision: 1,
            runtimeEpoch,
            cwd: "/work/project",
            availability: "active",
            runtimeStatus: "idle",
            metadata: emptyMetadataSnapshot(),
            createdAt: now,
            updatedAt: now,
            lastSeenAt: now,
          },
        },
      },
    }, context)).toEqual({ accepted: true });
    expect(catalog.getSession(sessionId)).toMatchObject({ sessionId, runtimeEpoch });
    expect(service.publishRuntimeEvent({ ...fence, event: native }, context)).toEqual({
      accepted: true,
    });
    expect(service.publishRuntimeEvent({ ...fence, event: interaction }, context)).toEqual({
      accepted: true,
    });
    expect(catalog.getInteraction(interaction.change.interaction.interactionId)).toMatchObject({
      state: "pending",
    });

    service.close();
    catalog.close();
  });

  it("rejects a refresh response for another runtime identity", async () => {
    let foreignSnapshot!: InventorySnapshot;
    const fixture = runtimeFixture({
      refreshInventory: async () => foreignSnapshot,
    });
    foreignSnapshot = inventory(registration());
    await expect(fixture.service.refresh(fixture.runtime.runtimeNodeId)).rejects.toMatchObject({
      code: "FENCED",
    });

    fixture.service.close();
    fixture.catalog.close();
  });

  it("does not consume a metadata delivery acknowledged by a replaced runtime boot", async () => {
    let acknowledge!: (operation: ReturnType<RuntimeFixture["catalog"]["submitMetadataPatch"]>) => void;
    let started!: () => void;
    const applying = new Promise<void>((resolve) => { started = resolve; });
    const acknowledgement = new Promise<ReturnType<RuntimeFixture["catalog"]["submitMetadataPatch"]>>(
      (resolve) => { acknowledge = resolve; },
    );
    const fixture = runtimeFixture({
      applyMetadata: async () => {
        started();
        return acknowledgement;
      },
    });
    await fixture.service.flushMetadataDeliveries();
    const operation = fixture.catalog.submitMetadataPatch({
      operationId: newOperationId(),
      sessionId: fixture.session.sessionId,
      expectedAuthority: fixture.catalog.authority(),
      set: { "agent.title": "boot-fenced-delivery" },
    });
    const firstFlush = fixture.service.flushMetadataDeliveries();
    await applying;

    const replacement = registration(
      fixture.runtime.runtimeNodeId,
      newRuntimeNodeBootId(),
    );
    const deliveredToReplacement: string[] = [];
    fixture.service.registerRuntimeNode(replacement, {
      ...fixture.context,
      runtimeNodeConnection: runtimeConnection(replacement, {
        endpointId: fixture.context.endpointId,
        applyMetadata: async (value) => {
          deliveredToReplacement.push(value.operationId);
          return value;
        },
      }),
    });
    acknowledge(operation);
    await expect(firstFlush).resolves.toBe(0);
    expect(fixture.catalog.pendingMetadataDeliveries()).toHaveLength(1);

    await expect(fixture.service.flushMetadataDeliveries()).resolves.toBe(1);
    expect(deliveredToReplacement).toEqual([operation.operationId]);
    expect(fixture.catalog.pendingMetadataDeliveries()).toEqual([]);

    fixture.service.close();
    fixture.catalog.close();
  });

  it("never regresses or replaces a terminal interaction during runtime replay", () => {
    const fixture = runtimeFixture();
    const pending = pendingInteraction(fixture.session);
    const fence = {
      runtimeNodeId: fixture.runtime.runtimeNodeId,
      runtimeNodeBootId: fixture.runtime.runtimeNodeBootId,
    };
    fixture.service.publishInteraction({ ...fence, interaction: pending }, fixture.context);
    const resolved: InteractionRecord = {
      ...pending,
      state: "resolved",
      resolution: { approved: true },
      resolvedAt: now,
    };
    fixture.service.publishInteraction({ ...fence, interaction: resolved }, fixture.context);
    const terminalCursor = fixture.catalog.controlCursor();

    expect(fixture.service.publishInteraction({ ...fence, interaction: pending }, fixture.context)).toEqual(resolved);
    expect(fixture.catalog.getInteraction(pending.interactionId)).toEqual(resolved);
    expect(fixture.catalog.controlCursor()).toBe(terminalCursor);

    expect(() => fixture.service.publishInteraction({
      ...fence,
      interaction: {
        ...resolved,
        resolution: { approved: false },
      },
    }, fixture.context)).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    expect(fixture.catalog.getInteraction(pending.interactionId)).toEqual(resolved);

    fixture.service.close();
    fixture.catalog.close();
  });

  it("correlates interaction resolutions exactly and deduplicates the same client response", async () => {
    let calls = 0;
    let nativeResult: InteractionRecord | undefined;
    const fixture = runtimeFixture({
      resolveInteraction: async () => {
        calls += 1;
        if (!nativeResult) throw new Error("test did not prepare a native result");
        return nativeResult;
      },
    });
    const pending = pendingInteraction(fixture.session);
    fixture.service.publishInteraction({
      runtimeNodeId: fixture.runtime.runtimeNodeId,
      runtimeNodeBootId: fixture.runtime.runtimeNodeBootId,
      interaction: pending,
    }, fixture.context);
    nativeResult = {
      ...pending,
      state: "resolved",
      resolution: { approved: true, detail: { first: 1, second: 2 } },
      resolvedAt: now,
    };
    const resolution = {
      interactionId: pending.interactionId,
      sessionId: pending.sessionId,
      harness: pending.harness,
      response: { detail: { second: 2, first: 1 }, approved: true },
    } as const;

    await expect(fixture.service.resolveInteraction(resolution)).resolves.toEqual(nativeResult);
    await expect(fixture.service.resolveInteraction(resolution)).resolves.toEqual(nativeResult);
    expect(calls).toBe(1);
    await expect(fixture.service.resolveInteraction({
      ...resolution,
      response: { approved: false },
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(calls).toBe(1);

    fixture.service.close();
    fixture.catalog.close();
  });

  it("expires an overdue interaction before attempting native resolution", async () => {
    let calls = 0;
    const fixture = runtimeFixture({
      resolveInteraction: () => {
        calls += 1;
        return Promise.reject(new Error("expired interaction was dispatched"));
      },
    });
    const pending: InteractionRecord = {
      ...pendingInteraction(fixture.session),
      expiresAt: "2037-04-05T06:07:07.000Z",
    };
    fixture.service.publishInteraction({
      runtimeNodeId: fixture.runtime.runtimeNodeId,
      runtimeNodeBootId: fixture.runtime.runtimeNodeBootId,
      interaction: pending,
    }, fixture.context);

    await expect(fixture.service.resolveInteraction({
      interactionId: pending.interactionId,
      sessionId: pending.sessionId,
      harness: pending.harness,
      response: { approved: true },
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(calls).toBe(0);
    expect(fixture.catalog.getInteraction(pending.interactionId)).toMatchObject({
      state: "expired",
      resolvedAt: now,
    });

    fixture.service.close();
    fixture.catalog.close();
  });

  it("rejects a native interaction result that does not match the requested response", async () => {
    let nativeResult: InteractionRecord | undefined;
    const fixture = runtimeFixture({
      resolveInteraction: () => nativeResult
        ? Promise.resolve(nativeResult)
        : Promise.reject(new Error("test did not prepare a native result")),
    });
    const pending = pendingInteraction(fixture.session);
    fixture.service.publishInteraction({
      runtimeNodeId: fixture.runtime.runtimeNodeId,
      runtimeNodeBootId: fixture.runtime.runtimeNodeBootId,
      interaction: pending,
    }, fixture.context);
    nativeResult = {
      ...pending,
      state: "resolved",
      resolution: { approved: false },
      resolvedAt: now,
    };

    await expect(fixture.service.resolveInteraction({
      interactionId: pending.interactionId,
      sessionId: pending.sessionId,
      harness: pending.harness,
      response: { approved: true },
    })).rejects.toMatchObject({ code: "PAYLOAD_MISMATCH" });
    expect(fixture.catalog.getInteraction(pending.interactionId)).toEqual(pending);

    fixture.service.close();
    fixture.catalog.close();
  });

  it("rejects reuse of a command ID and hash with a materially different request", async () => {
    let calls = 0;
    const fixture = runtimeFixture({
      execute: async (command) => {
        calls += 1;
        return recordFor(command);
      },
    });
    const command = commandFor(fixture);
    await expect(fixture.service.execute(command)).resolves.toMatchObject({
      state: "succeeded",
      createdAt: now,
      updatedAt: remoteCommandTime,
    });

    expect(() => fixture.service.execute({
      ...command,
      request: {
        harness: "codex",
        command: { type: "setModel", model: "gpt-5.6-codex-mini" },
      },
    })).toThrowError(expect.objectContaining({ code: "PAYLOAD_MISMATCH" }));
    expect(calls).toBe(1);

    fixture.service.close();
    fixture.catalog.close();
  });

  it.each([
    "commandId",
    "payloadHash",
    "sessionId",
    "runtimeNodeId",
    "request",
    "nonterminalState",
  ] as const)("rejects a forged runtime command response: %s", async (field) => {
    const fixture = runtimeFixture({
      execute: async (command) => {
        const record = recordFor(command);
        switch (field) {
          case "commandId": return { ...record, commandId: newCommandId() };
          case "payloadHash": return { ...record, payloadHash: "b".repeat(64) };
          case "sessionId": return { ...record, sessionId: newSessionId() };
          case "runtimeNodeId": return { ...record, runtimeNodeId: newRuntimeNodeId() };
          case "request": return { ...record, request: { forged: true } };
          case "nonterminalState": return { ...record, state: "started" };
        }
      },
    });
    const command = commandFor(fixture);

    await expect(fixture.service.execute(command)).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    expect(fixture.catalog.getCommand(command.commandId)).toMatchObject({
      commandId: command.commandId,
      state: "outcomeUnknown",
      request: command,
    });

    fixture.service.close();
    fixture.catalog.close();
  });

  it("does not accept an old-boot command response after runtime replacement", async () => {
    let release!: (record: CommandRecord) => void;
    const response = new Promise<CommandRecord>((resolve) => { release = resolve; });
    const fixture = runtimeFixture({ execute: () => response });
    const command = commandFor(fixture);
    const inFlight = fixture.service.execute(command);

    const replacement = registration(
      fixture.runtime.runtimeNodeId,
      newRuntimeNodeBootId(),
    );
    fixture.service.registerRuntimeNode(replacement, {
      ...fixture.context,
      runtimeNodeConnection: runtimeConnection(replacement, {
        endpointId: fixture.context.endpointId,
      }),
    });
    release(recordFor(command));

    await expect(inFlight).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(fixture.catalog.getCommand(command.commandId)).toMatchObject({
      state: "outcomeUnknown",
      error: expect.stringContaining("boot was replaced"),
    });

    fixture.service.close();
    fixture.catalog.close();
  });

  it("recovers a validated terminal command after dispatch outcome became unknown", async () => {
    let dispatched: CommandEnvelope | undefined;
    let recoveryCalls = 0;
    const fixture = runtimeFixture({
      execute: async (command) => {
        dispatched = command;
        throw new Error("reply was lost after dispatch");
      },
      getCommand: async (commandId) => {
        recoveryCalls += 1;
        if (!dispatched || commandId !== dispatched.commandId) return null;
        return recordFor(dispatched);
      },
    });
    const command = commandFor(fixture);
    await expect(fixture.service.execute(command)).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    expect(fixture.catalog.getCommand(command.commandId)).toMatchObject({ state: "outcomeUnknown" });

    await expect(fixture.service.recoverCommand(command.commandId)).resolves.toMatchObject({
      commandId: command.commandId,
      state: "succeeded",
      result: { accepted: true },
      createdAt: now,
      updatedAt: remoteCommandTime,
    });
    expect(recoveryCalls).toBe(1);
    expect(fixture.catalog.getCommand(command.commandId)).toMatchObject({ state: "succeeded" });

    const terminalCursor = fixture.catalog.controlCursor();
    await expect(fixture.service.recoverCommand(command.commandId)).resolves.toMatchObject({
      state: "succeeded",
      createdAt: now,
    });
    expect(recoveryCalls).toBe(1);
    expect(fixture.catalog.controlCursor()).toBe(terminalCursor);

    fixture.service.close();
    fixture.catalog.close();
  });

  it("does not accept a forged terminal result while recovering an unknown command", async () => {
    let dispatched: CommandEnvelope | undefined;
    const fixture = runtimeFixture({
      execute: async (command) => {
        dispatched = command;
        throw new Error("reply was lost after dispatch");
      },
      getCommand: async (commandId) => {
        if (!dispatched || commandId !== dispatched.commandId) return null;
        return {
          ...recordFor(dispatched),
          request: {
            ...dispatched,
            request: {
              harness: "codex",
              command: { type: "setModel", model: "forged-model" },
            },
          },
        };
      },
    });
    const command = commandFor(fixture);
    await expect(fixture.service.execute(command)).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    const cursor = fixture.catalog.controlCursor();

    await expect(fixture.service.recoverCommand(command.commandId)).rejects.toBeDefined();
    expect(fixture.catalog.getCommand(command.commandId)).toMatchObject({
      commandId: command.commandId,
      state: "outcomeUnknown",
      request: command,
      createdAt: now,
    });
    expect(fixture.catalog.controlCursor()).toBe(cursor);

    fixture.service.close();
    fixture.catalog.close();
  });
});
