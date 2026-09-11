import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  newCommandId, newOperationId, newRuntimeEpoch, newRuntimeNodeBootId, newRuntimeNodeId, packNativePayload,
  type AdapterScopeId, type ControlNodeAttachmentRequest, type CommandEnvelope,
  type SourceId,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it, vi } from "vitest";
import { ControlNodeCatalog, ControlNodeEventHub, ControlNodeService, type RuntimeNodeConnection } from "../src/index.js";
import { AccessGatewayProjection, type ControlNodeSourceClient } from "../../gateway-core/src/index.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "multiplex-handoff-"));
  const parentFile = join(directory, "root.sqlite");
  const childFile = join(directory, "child.sqlite");
  return {
    parentFile, childFile,
    parent: new ControlNodeCatalog({ filename: parentFile, controlNodeName: "root" }),
    child: new ControlNodeCatalog({ filename: childFile, controlNodeName: "child" }),
  };
}

function populate(catalog: ControlNodeCatalog) {
  const runtimeNodeId = newRuntimeNodeId();
  const runtimeNodeBootId = newRuntimeNodeBootId();
  catalog.registerRuntimeNode({ runtimeNodeId, runtimeNodeBootId, name: "runtime", allowedRoots: ["/work"], harnesses: [], protocolVersion: 5 });
  const [session] = catalog.reconcileInventory({
    runtimeNodeId, generation: "fixture", complete: true, capturedAt: new Date().toISOString(),
    sessions: [{ harness: "codex", adapterScopeId: "fixture" as AdapterScopeId,
      vendorSessionId: `native-${runtimeNodeId}`, cwd: "/work", availability: "active", runtimeStatus: "idle",
      runtimeEpoch: newRuntimeEpoch(), lastActivityAt: new Date().toISOString() }],
  });
  const first = catalog.submitMetadataPatch({ operationId: newOperationId(), sessionId: session!.sessionId,
    expectedAuthority: catalog.authority(), set: { "agent.title": "Before attachment" } });
  const second = catalog.submitMetadataPatch({ operationId: newOperationId(), sessionId: session!.sessionId,
    expectedAuthority: catalog.authority(), set: { "agent.title": "Existing title" } });
  for (const delivery of catalog.pendingMetadataDeliveries()) {
    catalog.acknowledgeMetadataDelivery(delivery.sequence, delivery.destinationRuntimeNodeId, delivery.operation.operationId);
  }
  return { session: catalog.getSession(session!.sessionId)!, first, second, runtimeNodeBootId };
}

function request(parent: ControlNodeCatalog, child: ControlNodeCatalog): ControlNodeAttachmentRequest {
  const local = child.localControlNode();
  const role = child.dataRole();
  return { controlNodeId: local.controlNodeId, controlNodeBootId: local.controlNodeBootId, feedId: local.feedId,
    name: local.name, endpointId: "fixture-child-endpoint", protocolVersion: 5, capabilities: local.capabilities,
    expectedParentControlNodeId: parent.localControlNode().controlNodeId, childProof: child.attachmentProof(),
    ...(role.role === "branch" && role.branch.lifecycle === "attached" ? {
      resume: { attachmentId: role.branch.attachmentId, lineageId: role.branch.lineageId, authority: role.authority },
    } : {}),
  };
}

function attach(parent: ControlNodeCatalog, child: ControlNodeCatalog) {
  const admission = parent.attachChild(request(parent, child));
  child.applyParentAttachment(admission.attachment, "fixture-parent-endpoint");
  parent.replaceChildSnapshot(child.localControlNode().controlNodeId, admission.attachment.attachmentId, child.accessSnapshot());
  return admission.attachment;
}

describe("standalone authority receipt handoff", () => {
  it.each([false, true])("immediately resets session-filtered streams before new-authority native output (selected=%s)", selected => {
    const { parent, child } = fixture();
    const { session } = populate(child);
    const hub = new ControlNodeEventHub({ catalog: child, heartbeatMs: 60_000 });
    const controller = new AbortController();
    return (async () => {
      try {
        const previous = child.feedCheckpoint();
        const native = { kind: "native" as const, sessionId: session.sessionId, harness: "codex" as const, runtimeEpoch: session.runtimeEpoch!,
          sequence: 0, nativeType: "test/native", payload: packNativePayload({ text: "Before attachment" }), ephemeral: false,
          provenance: { originControlNodeId: child.localControlNode().controlNodeId, authority: child.authority() } };
        hub.publish(native);
        const iterator = hub.attach({ sessions: selected ? [session.sessionId] : [], includeNative: true }, controller.signal)[Symbol.asyncIterator]();
        const next = iterator.next();
        const admission = parent.attachChild(request(parent, child));
        child.applyParentAttachment(admission.attachment, "fixture-parent-endpoint");
        hub.publish({ kind: "native", sessionId: session.sessionId, harness: "codex", runtimeEpoch: session.runtimeEpoch!,
          sequence: 1, nativeType: "test/native", payload: packNativePayload({ text: "After attachment" }), ephemeral: false,
          provenance: { originControlNodeId: child.localControlNode().controlNodeId, authority: child.authority() } });
        await expect(next).resolves.toEqual({ done: false, value: {
          kind: "streamReset", previousFeedId: previous.feedId, ...child.feedCheckpoint(),
          authorityRefs: [parent.authority()], reason: "feedChanged", recovery: "snapshot",
        } });
        await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
        const reattached = hub.attach({ sessions: [session.sessionId], includeNative: true,
          cursor: { ...child.feedCheckpoint(), native: {} } }, controller.signal)[Symbol.asyncIterator]();
        // The pre-attachment event must not survive in the native replay ring.
        // A gap in the same runtime epoch points the observer to native history.
        await expect(reattached.next()).resolves.toMatchObject({ done: false, value: {
          kind: "nativeGap", sessionId: session.sessionId, recovery: "readNativeHistory",
          provenance: { authority: parent.authority() },
        } });
        await reattached.return?.();
      } finally { controller.abort(); hub.close(); child.close(); parent.close(); }
    })();
  });

  it("publishes imported historical receipts to an already watching root gateway", async () => {
    const { parent, child } = fixture();
    let unsubscribe: (() => void) | undefined;
    try {
      const { session, first, second } = populate(child);
      const admission = parent.attachChild(request(parent, child));
      const sourceId = "handoff-root" as SourceId;
      const loadSnapshot = vi.fn(async () => {
        const snapshot = parent.accessSnapshot();
        return { ...snapshot, ...snapshot.source };
      });
      const client = { loadSnapshot } as unknown as ControlNodeSourceClient;
      const gateway = new AccessGatewayProjection([{ sourceId, displayName: "root", endpointId: "fixture-root", client }]);
      await gateway.refreshSource(sourceId);
      expect(gateway.getMetadataOperation(first.operationId)).toBeNull();
      const events: string[] = [];
      unsubscribe = parent.onControl(item => { events.push(item.change.type); gateway.ingest(sourceId, item); });
      child.applyParentAttachment(admission.attachment, "fixture-parent-endpoint");
      parent.replaceChildSnapshot(child.localControlNode().controlNodeId, admission.attachment.attachmentId, child.accessSnapshot());
      expect(loadSnapshot).toHaveBeenCalledOnce();
      expect(gateway.listSessions().map(record => record.sessionId)).toEqual([session.sessionId]);
      expect(gateway.getMetadataOperation(first.operationId)).toEqual(first);
      expect(gateway.getMetadataOperation(second.operationId)).toEqual(second);
      expect(events.indexOf("session.upsert")).toBeLessThan(events.indexOf("metadata.operation"));
      parent.replaceChildSnapshot(child.localControlNode().controlNodeId, admission.attachment.attachmentId, child.accessSnapshot());
      expect(gateway.listMetadataOperations()).toHaveLength(2);
      expect(gateway.getMetadataOperation(first.operationId)).toEqual(first);
    } finally { unsubscribe?.(); child.close(); parent.close(); }
  });

  it("reconciles a lost initial reply across both control restarts without replacing the admission", () => {
    const f = fixture();
    let parent = f.parent;
    let child = f.child;
    try {
      populate(child);
      const req = request(parent, child);
      const admission = parent.attachChild(req);
      child.close(); parent.close();
      parent = new ControlNodeCatalog({ filename: f.parentFile });
      child = new ControlNodeCatalog({ filename: f.childFile });
      const next = request(parent, child);
      expect(next.controlNodeBootId).not.toBe(req.controlNodeBootId);
      const recovered = parent.attachChild(next);
      expect(recovered.attachment).toEqual(admission.attachment);
      expect(recovered.child.controlNodeBootId).toBe(next.controlNodeBootId);
      child.applyParentAttachment(recovered.attachment, "fixture-parent-endpoint");
      parent.replaceChildSnapshot(next.controlNodeId, recovered.attachment.attachmentId, child.accessSnapshot());
      expect(parent.listSessions()).toHaveLength(1);
      expect(() => parent.attachChild(next)).toThrow();
    } finally { parent.close(); child.close(); }
  });

  it("retains two independently populated branches while both are offline", async () => {
    const f = fixture();
    const other = new ControlNodeCatalog({ filename: join(mkdtempSync(join(tmpdir(), "handoff-sibling-")), "other.sqlite") });
    let service: ControlNodeService | undefined;
    try {
      const a = populate(f.child);
      const b = populate(other);
      attach(f.parent, f.child);
      const otherRequest = { ...request(f.parent, other), endpointId: "fixture-other-endpoint" };
      const second = f.parent.attachChild(otherRequest);
      other.applyParentAttachment(second.attachment, "fixture-parent-endpoint");
      f.parent.replaceChildSnapshot(otherRequest.controlNodeId, second.attachment.attachmentId, other.accessSnapshot());
      f.parent.markChildDisconnected(f.child.localControlNode().controlNodeId);
      f.parent.markChildDisconnected(other.localControlNode().controlNodeId);
      service = new ControlNodeService({ catalog: f.parent });
      const rows = await service.searchSessions({ states: ["running", "stopped"], metadata: [], limit: 100 });
      expect(rows.sessions.map((session) => session.sessionId).sort()).toEqual([a.session.sessionId, b.session.sessionId].sort());
      expect(f.parent.accessSnapshot().metadataOperations).toHaveLength(4);
    } finally { service?.close(); f.parent.close(); f.child.close(); other.close(); }
  });

  it("refuses undelivered historical results before parent enrollment, preserving the delivery intent", () => {
    const { parent, child } = fixture();
    try {
      const { session } = populate(child);
      const unsettled = child.submitMetadataPatch({ operationId: newOperationId(), sessionId: session.sessionId,
        expectedAuthority: child.authority(), set: { "agent.title": "Not delivered" } });
      const req = request(parent, child);
      const cursor = parent.controlCursor();
      expect(() => child.assertCanAttach()).toThrow(/delivered/);
      expect(() => parent.attachChild(req)).toThrow(/delivered/);
      expect(parent.controlCursor()).toBe(cursor);
      expect(parent.activePeerEnrollment(req.endpointId!)).toBeNull();
      expect(child.pendingMetadataDeliveries()[0]?.operation).toEqual(unsettled);
    } finally { parent.close(); child.close(); }
  });

  it("retains exact historical receipts, advances metadata only through root and keeps offline hot rows after restart", async () => {
    const f = fixture();
    let parent = f.parent;
    let child = f.child;
    try {
      const { session, first, second } = populate(child);
      const oldFeed = child.feedCheckpoint().feedId;
      const before = child.getSession(session.sessionId)!;
      const attachment = attach(parent, child);
      expect(child.feedCheckpoint().feedId).not.toBe(oldFeed);
      expect(parent.getSession(session.sessionId)).toMatchObject({
        sessionId: before.sessionId, vendorSessionId: before.vendorSessionId, bindingRevision: before.bindingRevision,
        runtimeEpoch: before.runtimeEpoch, metadata: before.metadata, metadataAuthority: parent.authority(),
      });
      expect(parent.accessSnapshot().metadataOperations).toEqual([first, second].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.operationId.localeCompare(b.operationId)));
      expect(child.getMetadataOperation(first.operationId)).toEqual(first);
      expect(child.submitMetadataPatch(first.patch)).toEqual(first);
      expect(parent.submitMetadataPatch(first.patch, first.originControlNodeId)).toEqual(first);
      expect(parent.submitMetadataPatch(first.patch)).toEqual(first);
      expect(child.settleMetadataOperation(first)).toEqual(first);
      expect(() => child.submitMetadataPatch({ ...first.patch, operationId: newOperationId() })).toThrow(/authority/);
      expect(() => parent.submitMetadataPatch({ ...first.patch, set: { "agent.title": "tampered" } }, first.originControlNodeId)).toThrow(/immutable/);

      const queued = child.submitMetadataPatch({ operationId: newOperationId(), sessionId: session.sessionId,
        expectedAuthority: parent.authority(), set: { "agent.title": "After reconnect" } });
      expect(queued.status).toBe("queued");
      expect(parent.getSession(session.sessionId)!.metadata).toEqual(before.metadata);
      parent.markChildDisconnected(child.localControlNode().controlNodeId);
      parent.close();
      parent = new ControlNodeCatalog({ filename: f.parentFile });
      child.close();
      child = new ControlNodeCatalog({ filename: f.childFile });
      const service = new ControlNodeService({ catalog: parent });
      const offline = await service.searchSessions({ states: ["running", "stopped"], metadata: [], limit: 100 });
      expect(offline.sessions.map((record) => record.sessionId)).toEqual([session.sessionId]);
      service.close();
      expect(child.pendingMetadataOutbox()).toEqual([queued]);
      const replay = parent.attachChild(request(parent, child));
      expect(replay.attachment).toEqual(attachment);
      child.applyParentAttachment(replay.attachment, "fixture-parent-endpoint");
      parent.replaceChildSnapshot(child.localControlNode().controlNodeId, attachment.attachmentId, child.accessSnapshot());
      const settled = parent.applyMetadataAtAuthority(queued);
      child.settleMetadataOperation(settled, { authenticatedParent: true });
      expect(child.pendingMetadataOutbox()).toEqual([]);
      expect(child.getSession(session.sessionId)!.metadata.values["agent.title"]).toBe("After reconnect");
      expect(parent.getMetadataOperation(first.operationId)).toEqual(first);
      expect(child.getMetadataOperation(first.operationId)).toEqual(first);
    } finally { parent.close(); child.close(); }
  });

  it("closes baseline admission atomically and refuses forged, changed or later historical receipts", () => {
    const { parent, child } = fixture();
    try {
      const { first, second } = populate(child);
      const req = request(parent, child);
      const admission = parent.attachChild(req);
      expect(parent.attachChild(req).attachment).toEqual(admission.attachment);
      child.applyParentAttachment(admission.attachment, "fixture-parent-endpoint");
      const snapshot = child.accessSnapshot();
      const invalid = { ...snapshot, metadataOperations: snapshot.metadataOperations.map((operation) =>
        operation.operationId === first.operationId ? { ...operation, status: "queued" as const } : operation) };
      expect(() => parent.replaceChildSnapshot(req.controlNodeId, admission.attachment.attachmentId, invalid)).toThrow(/authority/);
      expect(parent.listSessions()).toEqual([]);
      parent.replaceChildSnapshot(req.controlNodeId, admission.attachment.attachmentId, snapshot);
      const fakeId = newOperationId();
      const fake = { ...first, operationId: fakeId, patch: { ...first.patch, operationId: fakeId } };
      expect(() => parent.replaceChildSnapshot(req.controlNodeId, admission.attachment.attachmentId, {
        ...snapshot, metadataOperations: [...snapshot.metadataOperations, fake],
      })).toThrow(/authority/);
      expect(() => parent.replaceChildSnapshot(req.controlNodeId, admission.attachment.attachmentId, {
        ...snapshot, metadataOperations: snapshot.metadataOperations.map((operation) =>
          operation.operationId === first.operationId ? { ...operation, updatedAt: "2040-01-01T00:00:00.000Z" } : operation),
      })).toThrow(/authority/);
      // A resnapshot cannot erase the authority's historical idempotency ledger.
      parent.replaceChildSnapshot(req.controlNodeId, admission.attachment.attachmentId, { ...snapshot, metadataOperations: [] });
      expect(parent.getMetadataOperation(first.operationId)).toEqual(first);
      expect(parent.getMetadataOperation(second.operationId)).toEqual(second);
      expect(() => parent.attachChild(req)).toThrow();
    } finally { parent.close(); child.close(); }
  });

  it("rejects nested authority transfer and queued old-authority work before admitting the edge", () => {
    const { parent, child } = fixture();
    const extra = new ControlNodeCatalog({ filename: join(mkdtempSync(join(tmpdir(), "handoff-extra-")), "extra.sqlite") });
    try {
      attach(parent, child);
      populate(extra);
      const extraRequest = request(child, extra);
      const cursor = child.controlCursor();
      expect(() => child.attachChild(extraRequest)).toThrow(/directly/);
      expect(child.controlCursor()).toBe(cursor);
      expect(child.getAttachment(extraRequest.controlNodeId)).toBeNull();
      expect(() => parent.assertCanAttach()).toThrow(/subtree/);
      expect(() => extra.attachChild({ ...request(extra, extra), childProof: { ...extra.attachmentProof(), coveredControlNodeIds: [extra.localControlNode().controlNodeId, parent.localControlNode().controlNodeId] } })).toThrow();
    } finally { parent.close(); child.close(); extra.close(); }

    // Simulate a persisted unresolved proposal left by an earlier interrupted
    // authority transition. Preflight must preserve it for explicit recovery.
    const pendingFixture = fixture();
    const { first } = populate(pendingFixture.child);
    pendingFixture.child.close();
    pendingFixture.parent.close();
    {
      const db = new DatabaseSync(pendingFixture.childFile);
      const queued = { ...first, status: "queued" };
      db.prepare("UPDATE metadata_operations SET status='queued', record_json=? WHERE operation_id=?").run(JSON.stringify(queued), first.operationId);
      db.close();
      const check = new ControlNodeCatalog({ filename: pendingFixture.childFile });
      try {
        expect(() => check.assertCanAttach()).toThrow(/queued metadata/);
        expect(check.getMetadataOperation(first.operationId)?.status).toBe("queued");
      } finally { check.close(); }
    }
  });

  it("keeps native local branch commands usable with no parent connection", async () => {
    const { parent, child } = fixture();
    let service: ControlNodeService | undefined;
    try {
      const { session, runtimeNodeBootId } = populate(child);
      attach(parent, child);
      service = new ControlNodeService({ catalog: child });
      const execute = vi.fn(async (command: CommandEnvelope) => ({
        commandId: command.commandId, payloadHash: command.payloadHash, sessionId: command.sessionId,
        runtimeNodeId: command.runtimeNodeId, request: command, state: "succeeded",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }));
      service.attachRuntimeNodeConnection({ runtimeNodeId: session.runtimeNodeId, runtimeNodeBootId, execute } as unknown as RuntimeNodeConnection);
      const command: CommandEnvelope = { commandId: newCommandId(), payloadHash: "a".repeat(64), sessionId: session.sessionId, runtimeNodeId: session.runtimeNodeId,
        bindingRevision: session.bindingRevision, request: { harness: "codex", command: { type: "interrupt" } } };
      await service.execute(command);
      expect(execute).toHaveBeenCalledOnce();
    } finally { service?.close(); parent.close(); child.close(); }
  });
});
