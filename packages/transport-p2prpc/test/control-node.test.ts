import {
  emptyMetadataSnapshot,
  metadataOperationRecordSchema,
  newAttachmentId,
  newAuthorityEpochId,
  newControlNodeBootId,
  newControlNodeId,
  newFeedId,
  newLineageId,
  newOperationId,
  newRealmId,
  newSessionId,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  ReconnectableMetadataUpstream,
  parentControlNodeConnectionFromPeer,
} from "../src/control-node.js";

describe("parent control-node p2prpc binding", () => {
  it("injects the current attachment fence and reconnects metadata", async () => {
    const controlNodeId = newControlNodeId();
    const controlNodeBootId = newControlNodeBootId();
    let attachmentId = newAttachmentId();
    let lineageId = newLineageId();
    const heartbeat = vi.fn().mockResolvedValue({
      accepted: true,
      parentCheckpoint: { feedId: newFeedId(), controlCursor: 3 },
    });
    const pushMetadataOutbox = vi.fn().mockImplementation(
      async (input: { operations: unknown[] }) => input.operations,
    );
    const peer = {
      identity: { id: "parent-endpoint" },
      rpc: {
        ingress: {
          controlNodes: {
            attach: { mutate: vi.fn() },
            heartbeat: { mutate: heartbeat },
            pushMetadataOutbox: { mutate: pushMetadataOutbox },
          },
        },
      },
    };
    const connection = parentControlNodeConnectionFromPeer(
      peer as unknown as Parameters<typeof parentControlNodeConnectionFromPeer>[0],
      {
        controlNodeId,
        controlNodeBootId,
        currentAttachment: () => ({ attachmentId, lineageId }),
      },
    );
    const checkpoint = { feedId: newFeedId(), controlCursor: 9 };
    await connection.heartbeat(checkpoint);
    expect(heartbeat).toHaveBeenCalledWith({
      controlNodeId,
      controlNodeBootId,
      attachmentId,
      lineageId,
      checkpoint,
    });

    const now = new Date().toISOString();
    const operationId = newOperationId();
    const sessionId = newSessionId();
    const authority = {
      realmId: newRealmId(),
      controlNodeId: newControlNodeId(),
      epochId: newAuthorityEpochId(),
    };
    const operation = metadataOperationRecordSchema.parse({
      operationId,
      sessionId,
      patch: {
        operationId,
        sessionId,
        expectedAuthority: authority,
        set: { "agent.title": "queued" },
      },
      status: "queued",
      canonical: emptyMetadataSnapshot(),
      optimistic: {
        ...emptyMetadataSnapshot(),
        values: { "agent.title": "queued" },
      },
      originControlNodeId: controlNodeId,
      authority,
      createdAt: now,
      updatedAt: now,
    });
    const upstream = new ReconnectableMetadataUpstream();
    await expect(upstream.pushMetadataOutbox([operation])).rejects.toThrow(
      /unavailable/,
    );
    upstream.attach(connection);
    await expect(upstream.pushMetadataOutbox([operation])).resolves.toEqual([
      operation,
    ]);
    expect(pushMetadataOutbox).toHaveBeenCalledWith({
      controlNodeId,
      controlNodeBootId,
      attachmentId,
      lineageId,
      operations: [operation],
    });

    attachmentId = newAttachmentId();
    lineageId = newLineageId();
    await connection.heartbeat(checkpoint);
    expect(heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({ attachmentId, lineageId }),
    );
    upstream.detach(connection);
    expect(upstream.connected).toBe(false);
  });
});
