import { packNativePayload } from "@arduano/agent-multiplex-protocol";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  commandRecordSchema,
  metadataOperationRecordSchema,
  newCommandId,
  newControlNodeId,
  newOperationId,
  newRuntimeEpoch,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  type AccessSnapshot,
  type AdapterScopeId,
  type ControlNodeAttachment,
  type MetadataOperationRecord,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";

import {
  ControlNodeCatalog,
  ControlNodeService,
  type ChildControlNodeConnection,
} from "../src/index.js";

const now = "2039-06-07T08:09:10.000Z";
const clock = () => new Date(now);

function stateFile(prefix: string): string {
  return join(
    mkdtempSync(join(tmpdir(), `agent-multiplex-metadata-race-v3-${prefix}-`)),
    "control-node.sqlite",
  );
}

function addSession(catalog: ControlNodeCatalog, vendorSessionId: string) {
  const runtimeNodeId = newRuntimeNodeId();
  catalog.registerRuntimeNode({
    runtimeNodeId,
    runtimeNodeBootId: newRuntimeNodeBootId(),
    name: `runtime-${vendorSessionId}`,
    allowedRoots: ["/work"],
    harnesses: [],
    protocolVersion: 5,
  });
  const [session] = catalog.reconcileInventory({
    runtimeNodeId,
    generation: `inventory-${vendorSessionId}`,
    complete: true,
    capturedAt: now,
    sessions: [{
      harness: "codex",
      adapterScopeId: "codex-metadata-race-v3" as AdapterScopeId,
      vendorSessionId,
      cwd: "/work/project",
      availability: "active",
      runtimeStatus: "idle",
      runtimeEpoch: newRuntimeEpoch(),
      lastActivityAt: now,
    }],
  });
  if (!session) throw new Error("test inventory did not create a session");
  return session;
}

describe("protocol-v4 child metadata projection ordering", () => {
  it("includes the complete durable metadata receipt journal in authority snapshots", () => {
    const filename = stateFile("complete-operation-snapshot");
    let catalog = new ControlNodeCatalog({
      filename,
      controlNodeName: "complete-operation-snapshot",
      now: clock,
    });
    const session = addSession(catalog, "complete-operation-snapshot");
    const firstOperationId = newOperationId();
    catalog.submitMetadataPatch({
      operationId: firstOperationId,
      sessionId: session.sessionId,
      expectedAuthority: catalog.authority(),
      set: { "snapshot.counter": 0 },
    });
    const originControlNodeId = catalog.authority().controlNodeId;
    catalog.close();

    // Seed the already-validated receipt shape in one SQLite transaction. A
    // public-operation loop would perform 10,001 FULL-sync commits and make
    // this completeness regression unnecessarily slow.
    const database = new DatabaseSync(filename);
    const seed = JSON.parse(String(database.prepare(
      "SELECT record_json FROM metadata_operations WHERE operation_id = ?",
    ).get(firstOperationId)?.record_json)) as Record<string, unknown>;
    const insert = database.prepare(`
      INSERT INTO metadata_operations(
        operation_id, session_id, status, origin_control_node_id, updated_at,
        projection_source, record_json
      ) VALUES (?, ?, 'accepted', ?, ?, NULL, ?)
    `);
    const operationIds = new Set<string>([firstOperationId]);
    database.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 1; index < 10_001; index += 1) {
        const operationId = newOperationId();
        const patch = {
          ...(seed.patch as Record<string, unknown>),
          operationId,
          set: { "snapshot.counter": index },
        };
        const record = { ...seed, operationId, patch };
        insert.run(
          operationId,
          session.sessionId,
          originControlNodeId,
          now,
          JSON.stringify(record),
        );
        operationIds.add(operationId);
      }
      database.exec("COMMIT");
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    } finally {
      database.close();
    }

    catalog = new ControlNodeCatalog({ filename, now: clock });
    const snapshot = catalog.accessSnapshot();
    expect(snapshot.metadataOperations).toHaveLength(10_001);
    expect(new Set(snapshot.metadataOperations.map((item) => item.operationId)))
      .toEqual(operationIds);

    catalog.close();
  }, 30_000);

  it("leaves an early proposal queued, then authenticates and commits it after session projection", async () => {
    const parent = new ControlNodeCatalog({
      filename: stateFile("parent"),
      controlNodeName: "metadata-parent",
      now: clock,
    });
    const child = new ControlNodeCatalog({
      filename: stateFile("child"),
      controlNodeName: "metadata-child",
      now: clock,
    });
    const parentService = new ControlNodeService({ catalog: parent, now: clock });
    const childSessionBeforeAttach = addSession(child, "child-native-session");
    const childEndpointId = "metadata-child-endpoint";
    child.setLocalEndpointId(childEndpointId);
    const childNode = child.localControlNode();
    const attached = parent.attachChild({
      controlNodeId: childNode.controlNodeId,
      controlNodeBootId: childNode.controlNodeBootId,
      feedId: childNode.feedId,
      name: childNode.name,
      endpointId: childEndpointId,
      protocolVersion: 5,
      capabilities: childNode.capabilities,
      expectedParentControlNodeId: parent.localControlNode().controlNodeId,
      childProof: child.attachmentProof(),
    });
    child.applyParentAttachment(attached.attachment, "metadata-parent-endpoint");

    const childSession = child.getSession(childSessionBeforeAttach.sessionId);
    if (!childSession) throw new Error("attached child session disappeared");
    const queued = child.submitMetadataPatch({
      operationId: newOperationId(),
      sessionId: childSession.sessionId,
      expectedAuthority: parent.authority(),
      set: { "agent.title": "metadata overtook session projection" },
    });
    const fence = {
      controlNodeId: childNode.controlNodeId,
      controlNodeBootId: childNode.controlNodeBootId,
      attachmentId: attached.attachment.attachmentId,
      lineageId: attached.attachment.lineageId,
    };
    const context = {
      authenticatedControlNodeId: childNode.controlNodeId,
      endpointId: childEndpointId,
    };

    // The reverse metadata RPC and aggregate feed are independently ordered.
    // Until session.upsert arrives, the parent cannot authenticate the route.
    await expect(parentService.pushChildMetadataOutbox(
      { ...fence, operations: [queued] },
      context,
    )).resolves.toEqual([queued]);
    expect(parent.getSession(childSession.sessionId)).toBeNull();
    expect(parent.getMetadataOperation(queued.operationId)).toBeNull();

    parent.replaceChildSnapshot(
      childNode.controlNodeId,
      attached.attachment.attachmentId,
      child.accessSnapshot(),
    );
    const [settled] = await parentService.pushChildMetadataOutbox(
      { ...fence, operations: [queued] },
      context,
    );
    expect(settled).toMatchObject({
      operationId: queued.operationId,
      status: "accepted",
      canonical: {
        revision: 1,
        values: { "agent.title": "metadata overtook session projection" },
      },
    });
    expect(parent.getMetadata(childSession.sessionId)).toEqual(settled?.canonical);

    // Once the matching session projection exists, both the subtree route and
    // the claimed operation origin are strict authority boundaries.
    const foreignOrigin = queuedRecord({
      sessionId: childSession.sessionId,
      authority: parent.authority(),
      originControlNodeId: newControlNodeId(),
      canonical: settled!.canonical,
    });
    await expect(parentService.pushChildMetadataOutbox(
      { ...fence, operations: [foreignOrigin] },
      context,
    )).rejects.toMatchObject({ code: "FENCED" });

    const parentSession = addSession(parent, "parent-native-session");
    const outsideSubtree = queuedRecord({
      sessionId: parentSession.sessionId,
      authority: parent.authority(),
      originControlNodeId: childNode.controlNodeId,
      canonical: parentSession.metadata,
    });
    await expect(parentService.pushChildMetadataOutbox(
      { ...fence, operations: [outsideSubtree] },
      context,
    )).rejects.toMatchObject({ code: "FENCED" });

    parentService.close();
    child.close();
    parent.close();
  });

  it.each(["snapshot", "feed"] as const)(
    "durably relays a leaf proposal discovered by %s before its outbox RPC",
    async (discovery) => {
      const root = new ControlNodeCatalog({
        filename: stateFile(`three-level-${discovery}-root`),
        controlNodeName: "metadata-root",
        now: clock,
      });
      const intermediate = new ControlNodeCatalog({
        filename: stateFile(`three-level-${discovery}-intermediate`),
        controlNodeName: "metadata-intermediate",
        now: clock,
      });
      const leaf = new ControlNodeCatalog({
        filename: stateFile(`three-level-${discovery}-leaf`),
        controlNodeName: "metadata-leaf",
        now: clock,
      });
      const rootEndpointId = `metadata-${discovery}-root-endpoint`;
      const intermediateEndpointId = `metadata-${discovery}-intermediate-endpoint`;
      const leafEndpointId = `metadata-${discovery}-leaf-endpoint`;
      root.setLocalEndpointId(rootEndpointId);
      intermediate.setLocalEndpointId(intermediateEndpointId);
      leaf.setLocalEndpointId(leafEndpointId);

      // Build from the authority downward so every branch inherits the root's
      // authority fence before it accepts its own child.
      const rootAttachment = attachControlNode(
        root,
        intermediate,
        rootEndpointId,
      );
      const leafSessionBeforeAttach = addSession(
        leaf,
        `${discovery}-leaf-native-session`,
      );
      const leafAttachment = attachControlNode(
        intermediate,
        leaf,
        intermediateEndpointId,
      );

      const rootService = new ControlNodeService({ catalog: root, now: clock });
      const intermediateFence = linkFence(intermediate, rootAttachment);
      const intermediateContext = {
        authenticatedControlNodeId: intermediate.localControlNode().controlNodeId,
        endpointId: intermediateEndpointId,
      };
      let rootReachable = false;
      const forwarded: MetadataOperationRecord[][] = [];
      const intermediateService = new ControlNodeService({
        catalog: intermediate,
        now: clock,
        metadataUpstream: {
          pushMetadataOutbox: async (operations) => {
            forwarded.push([...operations]);
            if (!rootReachable) throw new Error("injected root outage");
            return rootService.pushChildMetadataOutbox(
              { ...intermediateFence, operations: [...operations] },
              intermediateContext,
            );
          },
        },
      });
      const leafFence = linkFence(leaf, leafAttachment);
      const leafContext = {
        authenticatedControlNodeId: leaf.localControlNode().controlNodeId,
        endpointId: leafEndpointId,
      };
      const leafService = new ControlNodeService({
        catalog: leaf,
        now: clock,
        metadataUpstream: {
          pushMetadataOutbox: (operations) =>
            intermediateService.pushChildMetadataOutbox(
              { ...leafFence, operations: [...operations] },
              leafContext,
            ),
        },
      });

      await intermediateService.attachChildConnection(directChildConnection({
        parent: intermediate,
        child: leaf,
        childService: leafService,
        attachment: leafAttachment,
        parentEndpointId: intermediateEndpointId,
        childEndpointId: leafEndpointId,
      }));
      await rootService.attachChildConnection(directChildConnection({
        parent: root,
        child: intermediate,
        childService: intermediateService,
        attachment: rootAttachment,
        parentEndpointId: rootEndpointId,
        childEndpointId: intermediateEndpointId,
      }));

      const leafSession = leaf.getSession(leafSessionBeforeAttach.sessionId);
      if (!leafSession) throw new Error("attached leaf session disappeared");
      const beforeProposal = leaf.controlCursor();
      const queued = leaf.submitMetadataPatch({
        operationId: newOperationId(),
        sessionId: leafSession.sessionId,
        expectedAuthority: root.authority(),
        set: { "agent.title": `${discovery}-first proposal` },
      });

      if (discovery === "snapshot") {
        intermediate.replaceChildSnapshot(
          leaf.localControlNode().controlNodeId,
          leafAttachment.attachmentId,
          leaf.accessSnapshot(),
        );
      } else {
        const event = leaf.controlEventsAfter(beforeProposal).find((item) =>
          item.change.type === "metadata.operation" &&
          item.change.operation.operationId === queued.operationId,
        );
        if (!event) throw new Error("leaf did not publish its queued proposal");
        intermediate.importChildControl(
          leaf.localControlNode().controlNodeId,
          leafAttachment.attachmentId,
          event,
        );
      }

      expect(intermediate.getMetadataOperation(queued.operationId)).toEqual(queued);
      expect(intermediate.pendingMetadataOutbox()).toEqual([]);

      // An ID discovered from the leaf cannot be adopted under another origin,
      // and the child RPC remains fenced to identities inside that child tree.
      expect(() => intermediate.submitMetadataPatch(
        queued.patch,
        intermediate.localControlNode().controlNodeId,
      )).toThrowError(expect.objectContaining({ code: "PAYLOAD_MISMATCH" }));
      const forgedOrigin = metadataOperationRecordSchema.parse({
        ...queued,
        originControlNodeId: intermediate.localControlNode().controlNodeId,
      });
      await expect(intermediateService.pushChildMetadataOutbox(
        { ...leafFence, operations: [forgedOrigin] },
        leafContext,
      )).rejects.toMatchObject({ code: "FENCED" });
      expect(intermediate.pendingMetadataOutbox()).toEqual([]);

      // The first independent RPC adopts the projected record and durably
      // queues it at the intermediate. A failed authority hop must not lose it.
      await expect(leafService.flushMetadataOutbox()).resolves.toBe(0);
      expect(forwarded).toEqual([[queued]]);
      expect(intermediate.pendingMetadataOutbox()).toEqual([queued]);
      expect(leaf.pendingMetadataOutbox()).toEqual([queued]);

      rootReachable = true;
      await expect(intermediateService.flushMetadataOutbox()).resolves.toBe(1);
      await rootService.flushMetadataDeliveries();
      await intermediateService.flushMetadataDeliveries();

      const terminal = root.getMetadataOperation(queued.operationId);
      expect(terminal).toMatchObject({
        operationId: queued.operationId,
        sessionId: queued.sessionId,
        patch: queued.patch,
        status: "accepted",
        originControlNodeId: leaf.localControlNode().controlNodeId,
        authority: root.authority(),
        canonical: {
          revision: 1,
          values: { "agent.title": `${discovery}-first proposal` },
        },
      });
      expect(intermediate.getMetadataOperation(queued.operationId)).toEqual(terminal);
      expect(leaf.getMetadataOperation(queued.operationId)).toEqual(terminal);
      expect(root.getMetadata(queued.sessionId)).toEqual(terminal?.canonical);
      expect(intermediate.getMetadata(queued.sessionId)).toEqual(terminal?.canonical);
      expect(leaf.getMetadata(queued.sessionId)).toEqual(terminal?.canonical);
      expect(intermediate.pendingMetadataOutbox()).toEqual([]);
      expect(leaf.pendingMetadataOutbox()).toEqual([]);
      expect(forwarded).toEqual([[queued], [queued]]);

      leafService.close();
      intermediateService.close();
      rootService.close();
      leaf.close();
      intermediate.close();
      root.close();
    },
  );

  it("accepts a lifecycle command before session projection but still fences a foreign session", () => {
    const parent = new ControlNodeCatalog({
      filename: stateFile("command-parent"),
      controlNodeName: "command-parent",
      now: clock,
    });
    const child = new ControlNodeCatalog({
      filename: stateFile("command-child"),
      controlNodeName: "command-child",
      now: clock,
    });
    const childEndpointId = "command-child-endpoint";
    child.setLocalEndpointId(childEndpointId);
    const childNode = child.localControlNode();
    const attached = parent.attachChild({
      controlNodeId: childNode.controlNodeId,
      controlNodeBootId: childNode.controlNodeBootId,
      feedId: childNode.feedId,
      name: childNode.name,
      endpointId: childEndpointId,
      protocolVersion: 5,
      capabilities: childNode.capabilities,
      expectedParentControlNodeId: parent.localControlNode().controlNodeId,
      childProof: child.attachmentProof(),
    });
    child.applyParentAttachment(attached.attachment, "command-parent-endpoint");

    const runtimeNodeId = newRuntimeNodeId();
    child.registerRuntimeNode({
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "command-child-runtime",
      allowedRoots: ["/work"],
      harnesses: [],
      protocolVersion: 5,
    });
    parent.replaceChildSnapshot(
      childNode.controlNodeId,
      attached.attachment.attachmentId,
      child.accessSnapshot(),
    );

    const logicalSessionId = newSessionId();
    const commandId = newCommandId();
    const command = commandRecordSchema.parse({
      commandId,
      payloadHash: "metadata-projection-race-command",
      sessionId: logicalSessionId,
      runtimeNodeId,
      state: "started",
      request: {
        commandId,
        payloadHash: "metadata-projection-race-command",
        sessionId: logicalSessionId,
        runtimeNodeId,
        request: { harness: "codex", cwd: "/work" },
      },
      createdAt: now,
      updatedAt: now,
    });
    const beforeCommand = child.controlCursor();
    child.acceptCommand(command);
    const [earlyCommandEvent] = child.controlEventsAfter(beforeCommand);
    if (!earlyCommandEvent) throw new Error("child did not publish command event");
    expect(parent.importChildControl(
      childNode.controlNodeId,
      attached.attachment.attachmentId,
      earlyCommandEvent,
    ).accepted).toBe(true);
    expect(parent.getCommand(commandId)).toEqual(command);
    expect(parent.getSession(logicalSessionId)).toBeNull();

    const foreignSession = addSession(parent, "foreign-parent-session");
    const foreignCommandId = newCommandId();
    const foreignCommand = commandRecordSchema.parse({
      commandId: foreignCommandId,
      payloadHash: "foreign-session-command",
      sessionId: foreignSession.sessionId,
      runtimeNodeId,
      state: "started",
      request: { type: "test" },
      createdAt: now,
      updatedAt: now,
    });
    const beforeForeign = child.controlCursor();
    child.acceptCommand(foreignCommand);
    const [foreignEvent] = child.controlEventsAfter(beforeForeign);
    if (!foreignEvent) throw new Error("child did not publish foreign command event");
    const checkpoint = parent.childCheckpoint(childNode.controlNodeId);
    expect(() => parent.importChildControl(
      childNode.controlNodeId,
      attached.attachment.attachmentId,
      foreignEvent,
    )).toThrowError(expect.objectContaining({ code: "FENCED" }));
    expect(parent.getCommand(foreignCommandId)).toBeNull();
    expect(parent.childCheckpoint(childNode.controlNodeId)).toEqual(checkpoint);

    child.close();
    parent.close();
  });

  it("merges independently timestamped nested dispatch states and converges on one terminal result", () => {
    const parent = new ControlNodeCatalog({
      filename: stateFile("proxy-command-parent"),
      controlNodeName: "proxy-command-parent",
      now: clock,
    });
    const child = new ControlNodeCatalog({
      filename: stateFile("proxy-command-child"),
      controlNodeName: "proxy-command-child",
      now: clock,
    });
    const childEndpointId = "proxy-command-child-endpoint";
    child.setLocalEndpointId(childEndpointId);
    const childNode = child.localControlNode();
    const attached = parent.attachChild({
      controlNodeId: childNode.controlNodeId,
      controlNodeBootId: childNode.controlNodeBootId,
      feedId: childNode.feedId,
      name: childNode.name,
      endpointId: childEndpointId,
      protocolVersion: 5,
      capabilities: childNode.capabilities,
      expectedParentControlNodeId: parent.localControlNode().controlNodeId,
      childProof: child.attachmentProof(),
    });
    child.applyParentAttachment(attached.attachment, "proxy-command-parent-endpoint");

    const runtimeNodeId = newRuntimeNodeId();
    child.registerRuntimeNode({
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "proxy-command-runtime",
      allowedRoots: ["/work"],
      harnesses: [],
      protocolVersion: 5,
    });
    parent.replaceChildSnapshot(
      childNode.controlNodeId,
      attached.attachment.attachmentId,
      child.accessSnapshot(),
    );

    const commandId = newCommandId();
    const sessionId = newSessionId();
    const request = {
      commandId,
      payloadHash: "nested-proxy-command-state",
      sessionId,
      runtimeNodeId,
      request: { harness: "codex" as const, cwd: "/work" },
    };
    const parentStartedAt = "2039-06-07T08:09:10.000Z";
    const childStartedAt = "2039-06-07T08:09:11.000Z";
    const completedAt = "2039-06-07T08:09:12.000Z";
    const parentStarted = commandRecordSchema.parse({
      commandId,
      payloadHash: request.payloadHash,
      sessionId,
      runtimeNodeId,
      state: "started",
      request,
      createdAt: parentStartedAt,
      updatedAt: parentStartedAt,
    });
    const childStarted = commandRecordSchema.parse({
      ...parentStarted,
      createdAt: childStartedAt,
      updatedAt: childStartedAt,
    });
    parent.acceptCommand(parentStarted);

    const beforeStarted = child.controlCursor();
    child.acceptCommand(childStarted);
    const [startedEvent] = child.controlEventsAfter(beforeStarted);
    if (!startedEvent) throw new Error("child did not publish its started command");
    expect(parent.importChildControl(
      childNode.controlNodeId,
      attached.attachment.attachmentId,
      startedEvent,
    ).accepted).toBe(true);
    // The parent keeps its own local acceptance timestamps; the child's clock
    // is not meaningful state and must not break the aggregate pump.
    expect(parent.getCommand(commandId)).toEqual(parentStarted);

    const childTerminal = commandRecordSchema.parse({
      ...childStarted,
      state: "succeeded",
      result: packNativePayload({ sessionId, vendorSessionId: "native-proxy-session" }),
      updatedAt: completedAt,
    });
    const beforeTerminal = child.controlCursor();
    child.updateCommand(childTerminal);
    const [terminalEvent] = child.controlEventsAfter(beforeTerminal);
    if (!terminalEvent) throw new Error("child did not publish its terminal command");
    expect(parent.importChildControl(
      childNode.controlNodeId,
      attached.attachment.attachmentId,
      terminalEvent,
    ).accepted).toBe(true);
    expect(parent.getCommand(commandId)).toEqual({
      ...childTerminal,
      createdAt: parentStartedAt,
    });

    // Timestamp tolerance applies only to the duplicate in-flight state. A
    // second terminal payload remains a hard conflict and is rolled back with
    // the child checkpoint.
    const checkpoint = parent.childCheckpoint(childNode.controlNodeId);
    const forgedTerminalEvent = {
      ...terminalEvent,
      eventId: randomUUID(),
      cursor: terminalEvent.cursor + 1,
      change: {
        type: "command.changed" as const,
        command: { ...childTerminal, result: packNativePayload({ forged: true }) },
      },
    };
    expect(() => parent.importChildControl(
      childNode.controlNodeId,
      attached.attachment.attachmentId,
      forgedTerminalEvent,
    )).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    expect(parent.getCommand(commandId)).toEqual({
      ...childTerminal,
      createdAt: parentStartedAt,
    });
    expect(parent.childCheckpoint(childNode.controlNodeId)).toEqual(checkpoint);

    child.close();
    parent.close();
  });
});

function queuedRecord(input: {
  sessionId: MetadataOperationRecord["sessionId"];
  authority: MetadataOperationRecord["authority"];
  originControlNodeId: MetadataOperationRecord["originControlNodeId"];
  canonical: MetadataOperationRecord["canonical"];
}): MetadataOperationRecord {
  const operationId = newOperationId();
  return metadataOperationRecordSchema.parse({
    operationId,
    sessionId: input.sessionId,
    patch: {
      operationId,
      sessionId: input.sessionId,
      expectedAuthority: input.authority,
      set: { "dashboard.note": "must be fenced" },
    },
    status: "queued",
    canonical: input.canonical,
    originControlNodeId: input.originControlNodeId,
    authority: input.authority,
    createdAt: now,
    updatedAt: now,
  });
}

function attachControlNode(
  parent: ControlNodeCatalog,
  child: ControlNodeCatalog,
  parentEndpointId: string,
): ControlNodeAttachment {
  const local = child.localControlNode();
  if (!local.endpointId) throw new Error("child endpoint was not configured");
  const { attachment } = parent.attachChild({
    controlNodeId: local.controlNodeId,
    controlNodeBootId: local.controlNodeBootId,
    feedId: local.feedId,
    name: local.name,
    endpointId: local.endpointId,
    protocolVersion: 5,
    capabilities: local.capabilities,
    expectedParentControlNodeId: parent.localControlNode().controlNodeId,
    childProof: child.attachmentProof(),
  });
  child.applyParentAttachment(attachment, parentEndpointId);
  return attachment;
}

function linkFence(
  child: ControlNodeCatalog,
  attachment: ControlNodeAttachment,
) {
  const local = child.localControlNode();
  return {
    controlNodeId: local.controlNodeId,
    controlNodeBootId: local.controlNodeBootId,
    attachmentId: attachment.attachmentId,
    lineageId: attachment.lineageId,
  };
}

function directChildConnection(input: {
  parent: ControlNodeCatalog;
  child: ControlNodeCatalog;
  childService: ControlNodeService;
  attachment: ControlNodeAttachment;
  parentEndpointId: string;
  childEndpointId: string;
}): ChildControlNodeConnection {
  const child = input.child.localControlNode();
  const fence = linkFence(input.child, input.attachment);
  return {
    controlNodeId: child.controlNodeId,
    controlNodeBootId: child.controlNodeBootId,
    endpointId: input.childEndpointId,
    async readSubtreeSnapshot(request) {
      if (
        request.attachmentId !== input.attachment.attachmentId ||
        request.lineageId !== input.attachment.lineageId
      ) throw new Error("snapshot requested with a stale attachment fence");
      const snapshot: AccessSnapshot = input.child.accessSnapshot();
      return {
        source: snapshot.source,
        attachmentId: input.attachment.attachmentId,
        lineageId: input.attachment.lineageId,
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
    applyMetadata: (operation) => Promise.resolve(input.childService.applyMetadataFromParent(
      operation,
      fence,
      {
        authenticatedControlNodeId: input.parent.localControlNode().controlNodeId,
        endpointId: input.parentEndpointId,
      },
    )),
  };
}
