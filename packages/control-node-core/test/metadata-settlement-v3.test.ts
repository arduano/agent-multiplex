import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalJson,
  metadataOperationRecordSchema,
  newArchiveOperationId,
  newOperationId,
  newRuntimeEpoch,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  type AdapterScopeId,
  type ControlNodeAttachment,
  type MetadataOperationRecord,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";

import {
  ControlNodeCatalog,
  ControlNodeService,
  type RuntimeNodeConnection,
} from "../src/index.js";

const now = "2040-07-08T09:10:11.000Z";
const clock = () => new Date(now);

function stateFile(prefix: string): string {
  return join(
    mkdtempSync(join(tmpdir(), `agent-multiplex-metadata-settlement-${prefix}-`)),
    "control-node.sqlite",
  );
}

function addSession(catalog: ControlNodeCatalog) {
  const runtimeNodeId = newRuntimeNodeId();
  catalog.registerRuntimeNode({
    runtimeNodeId,
    runtimeNodeBootId: newRuntimeNodeBootId(),
    name: "metadata-settlement-runtime",
    allowedRoots: ["/work"],
    harnesses: [],
    protocolVersion: 5,
  });
  const [session] = catalog.reconcileInventory({
    runtimeNodeId,
    generation: "metadata-settlement-inventory",
    complete: true,
    capturedAt: now,
    sessions: [{
      harness: "codex",
      adapterScopeId: "codex-metadata-settlement-v3" as AdapterScopeId,
      vendorSessionId: "metadata-settlement-native-session",
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

function attachedFixture(prefix: string) {
  const parent = new ControlNodeCatalog({
    filename: stateFile(`${prefix}-parent`),
    controlNodeName: "metadata-settlement-parent",
    now: clock,
  });
  const childFile = stateFile(`${prefix}-child`);
  const child = new ControlNodeCatalog({
    filename: childFile,
    controlNodeName: "metadata-settlement-child",
    now: clock,
  });
  const originalSession = addSession(child);
  const childNode = child.localControlNode();
  const parentEndpointId = `metadata-settlement-parent-${prefix}`;
  const attached = parent.attachChild({
    controlNodeId: childNode.controlNodeId,
    controlNodeBootId: childNode.controlNodeBootId,
    feedId: childNode.feedId,
    name: childNode.name,
    protocolVersion: 5,
    capabilities: childNode.capabilities,
    expectedParentControlNodeId: parent.localControlNode().controlNodeId,
    childProof: child.attachmentProof(),
  });
  child.applyParentAttachment(attached.attachment, parentEndpointId);
  parent.replaceChildSnapshot(
    childNode.controlNodeId,
    attached.attachment.attachmentId,
    child.accessSnapshot(),
  );
  const session = child.getSession(originalSession.sessionId);
  if (!session) throw new Error("attached child session disappeared");
  const service = new ControlNodeService({ catalog: child, now: clock });
  return {
    parent,
    child,
    childFile,
    service,
    session,
    fence: {
      controlNodeId: childNode.controlNodeId,
      controlNodeBootId: childNode.controlNodeBootId,
      attachmentId: attached.attachment.attachmentId,
      lineageId: attached.attachment.lineageId,
    },
    context: {
      endpointId: parentEndpointId,
      authenticatedControlNodeId: parent.localControlNode().controlNodeId,
    },
  };
}

function reidentify(
  template: MetadataOperationRecord,
  overrides: Partial<MetadataOperationRecord> = {},
): MetadataOperationRecord {
  const operationId = newOperationId();
  return metadataOperationRecordSchema.parse({
    ...template,
    operationId,
    patch: {
      ...template.patch,
      operationId,
    },
    ...overrides,
  });
}

function parentFence(
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

describe("protocol-v4 downstream metadata settlement", () => {
  it("keeps archived metadata settlements authority-only and retires prior runtime deliveries", async () => {
    const fixture = attachedFixture("archived-authority-only");
    const beforeArchive = fixture.parent.submitMetadataPatch({
      operationId: newOperationId(),
      sessionId: fixture.session.sessionId,
      expectedAuthority: fixture.parent.authority(),
      set: { "review.disposition": "pending" },
    });
    await fixture.service.applyMetadataFromParent(
      beforeArchive,
      fixture.fence,
      fixture.context,
    );
    expect(fixture.child.pendingMetadataDeliveries()).toHaveLength(1);

    const stopped = fixture.child.markSessionStopped(
      fixture.session.sessionId,
      fixture.session.bindingRevision,
    );
    const archiveOperationId = newArchiveOperationId();
    fixture.child.recordArchive({
      archiveOperationId,
      payloadHash: canonicalJson({ archiveOperationId }).padEnd(16, "0"),
      sessionId: stopped.sessionId,
      runtimeNodeId: stopped.runtimeNodeId,
      bindingRevision: stopped.bindingRevision,
      expectedAuthority: stopped.metadataAuthority,
      authority: stopped.metadataAuthority,
      state: "succeeded",
      releasedAt: now,
      catalogRevision: stopped.catalogRevision + 1,
      createdAt: now,
      updatedAt: now,
    });
    expect(fixture.child.pendingMetadataDeliveries()).toEqual([]);

    const afterArchive = fixture.parent.submitMetadataPatch({
      operationId: newOperationId(),
      sessionId: fixture.session.sessionId,
      expectedAuthority: fixture.parent.authority(),
      set: { "review.disposition": "approved" },
    });
    await fixture.service.applyMetadataFromParent(
      afterArchive,
      fixture.fence,
      fixture.context,
    );
    expect(fixture.child.getSession(fixture.session.sessionId)).toMatchObject({
      catalogState: "archived",
      metadata: afterArchive.canonical,
    });
    expect(fixture.child.pendingMetadataDeliveries()).toEqual([]);

    fixture.service.close();
    fixture.child.close();
    fixture.parent.close();
  });

  it("accepts authority-originated receipts first seen by an attached branch without regressing metadata", async () => {
    const fixture = attachedFixture("unknown-authority-receipt");
    const first = fixture.parent.submitMetadataPatch({
      operationId: newOperationId(),
      sessionId: fixture.session.sessionId,
      expectedAuthority: fixture.parent.authority(),
      set: { "acceptance.authority_round": 1 },
    });
    const second = fixture.parent.submitMetadataPatch({
      operationId: newOperationId(),
      sessionId: fixture.session.sessionId,
      expectedAuthority: fixture.parent.authority(),
      set: { "acceptance.authority_round": 2 },
    });
    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    expect(fixture.child.getMetadataOperation(first.operationId)).toBeNull();
    expect(fixture.child.getMetadataOperation(second.operationId)).toBeNull();

    await expect(fixture.service.applyMetadataFromParent(
      second,
      fixture.fence,
      fixture.context,
    )).resolves.toEqual(second);
    expect(fixture.child.getMetadata(fixture.session.sessionId)).toEqual(second.canonical);
    expect(fixture.child.getMetadataOperation(second.operationId)).toEqual(second);
    expect(fixture.child.pendingMetadataDeliveries()).toMatchObject([{
      destinationRuntimeNodeId: fixture.session.runtimeNodeId,
      operation: { operationId: second.operationId },
    }]);

    const cursorBeforeOlderReceipt = fixture.child.controlCursor();
    await expect(fixture.service.applyMetadataFromParent(
      first,
      fixture.fence,
      fixture.context,
    )).resolves.toEqual(first);
    expect(fixture.child.getMetadata(fixture.session.sessionId)).toEqual(second.canonical);
    expect(fixture.child.getMetadataOperation(first.operationId)).toEqual(first);
    expect(fixture.child.controlEventsAfter(cursorBeforeOlderReceipt).map((item) => item.change))
      .toEqual([
        { type: "metadata.operation", operation: first },
      ]);
    expect(fixture.child.pendingMetadataDeliveries().map((intent) =>
      intent.operation.operationId)).toEqual([second.operationId, first.operationId]);

    const cursorBeforeReplay = fixture.child.controlCursor();
    await expect(fixture.service.applyMetadataFromParent(
      first,
      fixture.fence,
      fixture.context,
    )).resolves.toEqual(first);
    expect(fixture.child.controlCursor()).toBe(cursorBeforeReplay);
    expect(fixture.child.pendingMetadataDeliveries()).toHaveLength(2);

    await expect(fixture.service.applyMetadataFromParent(
      {
        ...first,
        canonical: {
          revision: first.canonical.revision,
          values: { "acceptance.authority_round": "changed replay" },
          keyRevisions: { "acceptance.authority_round": first.canonical.revision },
        },
      },
      fixture.fence,
      fixture.context,
    )).rejects.toMatchObject({ code: "PAYLOAD_MISMATCH" });

    fixture.service.close();
    fixture.child.close();
    const reopened = new ControlNodeCatalog({ filename: fixture.childFile, now: clock });
    expect(reopened.getMetadata(fixture.session.sessionId)).toEqual(second.canonical);
    expect(reopened.getMetadataOperation(first.operationId)).toEqual(first);
    expect(reopened.getMetadataOperation(second.operationId)).toEqual(second);
    expect(reopened.pendingMetadataDeliveries().map((intent) =>
      intent.operation.operationId)).toEqual([second.operationId, first.operationId]);
    reopened.close();
    fixture.parent.close();
  });

  it("rejects divergent, unauthenticated, and invented terminal receipts atomically", async () => {
    const fixture = attachedFixture("receipt-guards");
    const accepted = fixture.parent.submitMetadataPatch({
      operationId: newOperationId(),
      sessionId: fixture.session.sessionId,
      expectedAuthority: fixture.parent.authority(),
      set: { "acceptance.authority_round": 1 },
    });
    await fixture.service.applyMetadataFromParent(
      accepted,
      fixture.fence,
      fixture.context,
    );
    const cursor = fixture.child.controlCursor();
    const deliveryCount = fixture.child.pendingMetadataDeliveries().length;

    const divergent = reidentify(accepted, {
      canonical: {
        revision: accepted.canonical.revision,
        values: { "acceptance.authority_round": "divergent" },
        keyRevisions: { "acceptance.authority_round": accepted.canonical.revision },
      },
    });
    await expect(fixture.service.applyMetadataFromParent(
      divergent,
      fixture.fence,
      fixture.context,
    )).rejects.toMatchObject({ code: "CONFLICT" });

    const unauthenticated = reidentify(accepted, {
      originControlNodeId: fixture.child.localControlNode().controlNodeId,
    });
    await expect(fixture.service.applyMetadataFromParent(
      unauthenticated,
      fixture.fence,
      {
        ...fixture.context,
        authenticatedControlNodeId: fixture.child.localControlNode().controlNodeId,
      },
    )).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const inventedAtAuthority = reidentify(accepted);
    expect(() => fixture.parent.settleMetadataOperation(inventedAtAuthority))
      .toThrowError(expect.objectContaining({ code: "FENCED" }));

    expect(fixture.child.getMetadata(fixture.session.sessionId)).toEqual(accepted.canonical);
    expect(fixture.child.getMetadataOperation(divergent.operationId)).toBeNull();
    expect(fixture.child.getMetadataOperation(unauthenticated.operationId)).toBeNull();
    expect(fixture.child.controlCursor()).toBe(cursor);
    expect(fixture.child.pendingMetadataDeliveries()).toHaveLength(deliveryCount);

    fixture.service.close();
    fixture.child.close();
    fixture.parent.close();
  });

  it("forwards a middle-origin terminal receipt through A -> B -> C to the runtime", async () => {
    const a = new ControlNodeCatalog({ filename: stateFile("tree-a"), controlNodeName: "a", now: clock });
    const b = new ControlNodeCatalog({ filename: stateFile("tree-b"), controlNodeName: "b", now: clock });
    const c = new ControlNodeCatalog({ filename: stateFile("tree-c"), controlNodeName: "c", now: clock });
    const cSessionBeforeAttach = addSession(c);
    const runtime = c.getRuntimeNode(cSessionBeforeAttach.runtimeNodeId);
    if (!runtime) throw new Error("test runtime disappeared");

    const attach = (
      parent: ControlNodeCatalog,
      child: ControlNodeCatalog,
      parentEndpointId: string,
    ) => {
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
      });
      child.applyParentAttachment(result.attachment, parentEndpointId);
      parent.replaceChildSnapshot(
        local.controlNodeId,
        result.attachment.attachmentId,
        child.accessSnapshot(),
      );
      return result.attachment;
    };

    const ab = attach(a, b, "a-parent-endpoint");
    const bc = attach(b, c, "b-parent-endpoint");
    a.replaceChildSnapshot(
      b.localControlNode().controlNodeId,
      ab.attachmentId,
      b.accessSnapshot(),
    );
    const cSession = c.getSession(cSessionBeforeAttach.sessionId);
    if (!cSession) throw new Error("attached runtime session disappeared");

    const appliedAtRuntime: MetadataOperationRecord[] = [];
    let runtimeDeliveryEnabled = false;
    const runtimeConnection: RuntimeNodeConnection = {
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
      applyMetadata: async (operation) => {
        if (!runtimeDeliveryEnabled) throw new Error("runtime delivery held for assertion");
        appliedAtRuntime.push(operation);
        return operation;
      },
    };
    const cService = new ControlNodeService({ catalog: c, now: clock });
    cService.attachRuntimeNodeConnection(runtimeConnection);
    const operationId = newOperationId();
    const queuedAtB = b.submitMetadataPatch({
      operationId,
      sessionId: cSession.sessionId,
      expectedAuthority: a.authority(),
      set: { "acceptance.middle_origin": true },
    });
    const terminal = a.applyMetadataAtAuthority(queuedAtB);
    expect(terminal.originControlNodeId).toBe(b.localControlNode().controlNodeId);
    b.settleMetadataOperation(terminal);

    const bService = new ControlNodeService({ catalog: b, now: clock });
    const cFence = parentFence(c, bc);
    const cContext = {
      endpointId: "b-parent-endpoint",
      authenticatedControlNodeId: b.localControlNode().controlNodeId,
    };
    let deliveryEnabled = false;
    const bToC = {
      controlNodeId: c.localControlNode().controlNodeId,
      controlNodeBootId: c.localControlNode().controlNodeBootId,
      applyMetadata: (operation: MetadataOperationRecord) => {
        if (!deliveryEnabled) return Promise.reject(new Error("delivery held for assertion"));
        return Promise.resolve(cService.applyMetadataFromParent(operation, cFence, cContext));
      },
    };
    await bService.attachChildConnection({
      ...bToC,
      async readSubtreeSnapshot(request) {
        const snapshot = c.accessSnapshot();
        return {
          source: snapshot.source,
          attachmentId: request.attachmentId,
          lineageId: request.lineageId,
          checkpoint: c.feedCheckpoint(),
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
    });

    await bService.flushMetadataDeliveries();
    expect(c.getMetadataOperation(operationId)).toBeNull();
    deliveryEnabled = true;
    expect(await bService.flushMetadataDeliveries()).toBe(1);
    expect(c.getMetadataOperation(operationId)).toEqual(terminal);
    expect(c.getMetadata(cSession.sessionId)).toEqual(terminal.canonical);
    await cService.flushMetadataDeliveries();
    expect(c.pendingMetadataDeliveries()).toHaveLength(1);
    runtimeDeliveryEnabled = true;
    expect(await cService.flushMetadataDeliveries()).toBe(1);
    expect(appliedAtRuntime).toEqual([terminal]);
    expect(c.pendingMetadataDeliveries()).toEqual([]);

    bService.close();
    cService.close();
    c.close();
    b.close();
    a.close();
  });
});
