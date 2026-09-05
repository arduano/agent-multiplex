import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  metadataOperationRecordSchema,
  newOperationId,
  newRuntimeEpoch,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  type AccessSnapshot,
  type AdapterScopeId,
  type ControlChange,
  type FeedControlItem,
  type MetadataOperationRecord,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";

import { ControlNodeCatalog, ControlNodeCoreError } from "../src/index.js";

const now = "2038-05-06T07:08:09.000Z";
const clock = () => new Date(now);

function stateFile(prefix: string): string {
  return join(
    mkdtempSync(join(tmpdir(), `agent-multiplex-metadata-v3-${prefix}-`)),
    "control-node.sqlite",
  );
}

function addSession(catalog: ControlNodeCatalog) {
  const runtimeNodeId = newRuntimeNodeId();
  catalog.registerRuntimeNode({
    runtimeNodeId,
    runtimeNodeBootId: newRuntimeNodeBootId(),
    name: "metadata-runtime",
    allowedRoots: ["/work"],
    harnesses: [],
    protocolVersion: 5,
  });
  const [session] = catalog.reconcileInventory({
    runtimeNodeId,
    generation: "metadata-inventory",
    complete: true,
    capturedAt: now,
    sessions: [{
      harness: "codex",
      adapterScopeId: "codex-metadata-v3" as AdapterScopeId,
      vendorSessionId: "metadata-native-session",
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

function attach(parent: ControlNodeCatalog, child: ControlNodeCatalog) {
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
  child.applyParentAttachment(result.attachment, "metadata-parent-endpoint");
  return result;
}

describe("nested protocol-v4 metadata monotonicity", () => {
  it("keeps authority metadata and terminal receipts canonical across child controls and resnapshots", () => {
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
    const childSession = addSession(child);
    const { attachment } = attach(parent, child);
    const childControlNodeId = child.localControlNode().controlNodeId;
    const attachedChildSession = child.getSession(childSession.sessionId);
    if (!attachedChildSession) throw new Error("attached child session disappeared");
    parent.replaceChildSnapshot(
      childControlNodeId,
      attachment.attachmentId,
      child.accessSnapshot(),
    );

    // The child journals proposals against its stale local copy while the
    // parent commits both terminal outcomes at the one metadata authority.
    const acceptedQueued = child.submitMetadataPatch({
      operationId: newOperationId(),
      sessionId: childSession.sessionId,
      expectedAuthority: parent.authority(),
      set: { "agent.title": "canonical" },
    });
    const accepted = parent.applyMetadataAtAuthority(acceptedQueued);
    expect(accepted.status).toBe("accepted");
    expect(accepted.canonical.revision).toBe(1);

    const conflictedQueued = child.submitMetadataPatch({
      operationId: newOperationId(),
      sessionId: childSession.sessionId,
      expectedAuthority: parent.authority(),
      set: { "dashboard.note": "must conflict" },
      ifKeyRevision: { "agent.title": null },
    });
    const conflicted = parent.applyMetadataAtAuthority(conflictedQueued);
    expect(conflicted.status).toBe("conflicted");
    expect(conflicted.canonical).toEqual(accepted.canonical);

    let childCursor = parent.childCheckpoint(childControlNodeId)!.controlCursor;
    const item = (change: ControlChange): FeedControlItem => ({
      kind: "control",
      eventId: randomUUID(),
      feedId: child.localControlNode().feedId,
      cursor: ++childCursor,
      provenance: {
        originControlNodeId: childControlNodeId,
        authority: parent.authority(),
      },
      change,
    });

    // A lower metadata revision is a harmless stale replay. It consumes the
    // child checkpoint but the parent republishes its canonical state.
    const staleMetadata = item({
      type: "metadata.changed",
      sessionId: childSession.sessionId,
      metadata: attachedChildSession.metadata,
    });
    const metadataImport = parent.importChildControl(
      childControlNodeId,
      attachment.attachmentId,
      staleMetadata,
    );
    expect(parent.getMetadata(childSession.sessionId)).toEqual(accepted.canonical);
    expect(parent.controlEventsAfter(metadataImport.localCursor - 1, 1)[0]?.change)
      .toEqual({
        type: "metadata.changed",
        sessionId: childSession.sessionId,
        metadata: accepted.canonical,
      });

    // Session lifecycle fields remain child-owned, but metadata inside the
    // same record is merged monotonically and the canonical record is emitted.
    const sessionImport = parent.importChildControl(
      childControlNodeId,
      attachment.attachmentId,
      item({
        type: "session.upsert",
        session: { ...attachedChildSession, runtimeStatus: "running" },
      }),
    );
    expect(parent.getSession(childSession.sessionId)).toMatchObject({
      runtimeStatus: "running",
      metadata: accepted.canonical,
      metadataAuthority: parent.authority(),
    });
    expect(parent.controlEventsAfter(sessionImport.localCursor - 1, 1)[0]?.change)
      .toMatchObject({
        type: "session.upsert",
        session: { metadata: accepted.canonical },
      });

    // A queued replay cannot regress or take ownership of a terminal receipt.
    const staleOperation = item({
      type: "metadata.operation",
      operation: acceptedQueued,
    });
    const operationImport = parent.importChildControl(
      childControlNodeId,
      attachment.attachmentId,
      staleOperation,
    );
    expect(parent.getMetadataOperation(accepted.operationId)).toEqual(accepted);
    expect(parent.controlEventsAfter(operationImport.localCursor - 1, 1)[0]?.change)
      .toEqual({ type: "metadata.operation", operation: accepted });

    // Exact event replay remains idempotent after canonicalization.
    expect(parent.importChildControl(
      childControlNodeId,
      attachment.attachmentId,
      staleOperation,
    )).toEqual({
      accepted: true,
      deduplicated: true,
      localCursor: operationImport.localCursor,
    });

    // Equal revisions are immutable. Rejection is atomic, so the checkpoint
    // remains available for a corrected event at the same position.
    const divergent = item({
      type: "metadata.changed",
      sessionId: childSession.sessionId,
      metadata: {
        revision: accepted.canonical.revision,
        values: { "agent.title": "divergent" },
        keyRevisions: { "agent.title": 1 },
      },
    });
    awaitErrorCode(
      () => parent.importChildControl(
        childControlNodeId,
        attachment.attachmentId,
        divergent,
      ),
      "CONFLICT",
    );
    expect(parent.childCheckpoint(childControlNodeId)?.controlCursor)
      .toBe(divergent.cursor - 1);

    const reusedOperation: MetadataOperationRecord = metadataOperationRecordSchema.parse({
      ...acceptedQueued,
      patch: {
        ...acceptedQueued.patch,
        set: { "agent.title": "reused-with-another-payload" },
      },
    });
    const reused = { ...divergent, change: {
      type: "metadata.operation" as const,
      operation: reusedOperation,
    } };
    awaitErrorCode(
      () => parent.importChildControl(
        childControlNodeId,
        attachment.attachmentId,
        reused,
      ),
      "PAYLOAD_MISMATCH",
    );
    expect(parent.childCheckpoint(childControlNodeId)?.controlCursor)
      .toBe(reused.cursor - 1);

    const corrected = {
      ...divergent,
      eventId: randomUUID(),
      change: {
        type: "session.upsert" as const,
        session: { ...attachedChildSession, runtimeStatus: "idle" as const },
      },
    };
    expect(parent.importChildControl(
      childControlNodeId,
      attachment.attachmentId,
      corrected,
    ).deduplicated).toBe(false);
    expect(parent.childCheckpoint(childControlNodeId)?.controlCursor)
      .toBe(corrected.cursor);

    // A reconnect snapshot carries both stale queued ledgers and a stale
    // session copy. Merge it without moving authority receipts into the
    // child's replaceable projection.
    const staleSnapshot = child.accessSnapshot();
    const divergentSnapshot: AccessSnapshot = {
      ...staleSnapshot,
      sessions: staleSnapshot.sessions.map((session) => ({
        ...session,
        metadata: {
          revision: accepted.canonical.revision,
          values: { "agent.title": "divergent-snapshot" },
          keyRevisions: { "agent.title": 1 },
        },
      })),
    };
    awaitErrorCode(
      () => parent.replaceChildSnapshot(
        childControlNodeId,
        attachment.attachmentId,
        divergentSnapshot,
      ),
      "CONFLICT",
    );
    expect(parent.childCheckpoint(childControlNodeId)?.controlCursor)
      .toBe(corrected.cursor);
    expect(parent.getMetadata(childSession.sessionId)).toEqual(accepted.canonical);
    expect(parent.getMetadataOperation(accepted.operationId)).toEqual(accepted);

    const resnapshot: AccessSnapshot = {
      ...staleSnapshot,
      source: {
        ...staleSnapshot.source,
        manifest: {
          ...staleSnapshot.source.manifest,
          controlCursor: corrected.cursor,
        },
      },
    };
    parent.replaceChildSnapshot(
      childControlNodeId,
      attachment.attachmentId,
      resnapshot,
    );
    expect(parent.getMetadata(childSession.sessionId)).toEqual(accepted.canonical);
    expect(parent.getMetadataOperation(accepted.operationId)).toEqual(accepted);
    expect(parent.getMetadataOperation(conflicted.operationId)).toEqual(conflicted);

    parent.detachChild({
      childControlNodeId,
      attachmentId: attachment.attachmentId,
      lineageId: attachment.lineageId,
      expectedAuthority: parent.authority(),
    });
    expect(parent.getMetadataOperation(accepted.operationId)).toEqual(accepted);
    expect(parent.getMetadataOperation(conflicted.operationId)).toEqual(conflicted);

    child.close();
    parent.close();
  });
});

function awaitErrorCode(
  action: () => unknown,
  code: ControlNodeCoreError["code"],
): void {
  expect(action).toThrowError(
    expect.objectContaining<Partial<ControlNodeCoreError>>({ code }),
  );
}
