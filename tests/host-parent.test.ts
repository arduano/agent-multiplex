import {
  newAttachmentId,
  newAuthorityEpochId,
  newFeedId,
  newHostId,
  newLineageId,
  type HostAttachment,
} from "@agent-multiplex/protocol";
import {
  HostCatalog,
  HostService,
} from "@agent-multiplex/host-core";
import { ReconnectableMetadataUpstream } from "@agent-multiplex/transport-p2prpc";
import { describe, expect, it, vi } from "vitest";

import { superviseParentHost } from "../apps/host/src/parent.js";

describe("subordinate host parent supervisor", () => {
  it("attaches once, enrolls its parent before the readiness heartbeat, and retains topology", async () => {
    const catalog = new HostCatalog({ filename: ":memory:", hostName: "aggregate" });
    const metadataUpstream = new ReconnectableMetadataUpstream();
    const service = new HostService({
      catalog,
      instanceId: "aggregate-boot",
      metadataUpstream,
    });
    const local = catalog.setLocalEndpointId("child-endpoint");
    const parentHostId = newHostId();
    const attachment: HostAttachment = {
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
      parentHostId,
      childHostId: local.hostId,
      rootHostId: parentHostId,
      authorityHostId: parentHostId,
      authorityEpochId: newAuthorityEpochId(),
      attachedAt: new Date().toISOString(),
    };
    const attach = vi.fn().mockResolvedValue({
      accepted: true,
      canonical: { ...local, parentHostId, attachmentId: attachment.attachmentId },
      attachment,
      parentCheckpoint: { feedId: newFeedId(), controlCursor: 0 },
    });
    const heartbeat = vi.fn().mockImplementation(async () => {
      expect(catalog.peerEnrollment("parent-endpoint")).toEqual({
        role: "parentHost",
        principalId: parentHostId,
      });
      return {
        accepted: true,
        parentCheckpoint: { feedId: newFeedId(), controlCursor: 0 },
      };
    });
    const peer = {
      identity: { id: "parent-endpoint" },
      rpc: {
        ingress: {
          hosts: {
            attach: { mutate: attach },
            heartbeat: { mutate: heartbeat },
            pushMetadataOutbox: { mutate: vi.fn().mockResolvedValue([]) },
          },
        },
      },
    };
    const node = { connectAs: vi.fn().mockResolvedValue(peer) };
    const controller = new AbortController();

    try {
      await superviseParentHost({
        node: node as never,
        target: {
          endpointId: "parent-endpoint",
          locator: { kind: "ticket", ticket: "parent-ticket" },
        },
        catalog,
        service,
        metadataUpstream,
        heartbeatMs: 10,
        reconnectMaxMs: 10,
        signal: controller.signal,
        onConnected: () => controller.abort(),
      });

      expect(attach).toHaveBeenCalledWith(expect.objectContaining({
        hostId: local.hostId,
        hostBootId: local.hostBootId,
        feedId: local.feedId,
        endpointId: "child-endpoint",
      }));
      expect(heartbeat).toHaveBeenCalledWith(expect.objectContaining({
        hostId: local.hostId,
        hostBootId: local.hostBootId,
        attachmentId: attachment.attachmentId,
        lineageId: attachment.lineageId,
      }));
      expect(catalog.localHost()).toMatchObject({
        parentHostId,
        rootHostId: parentHostId,
        authorityHostId: parentHostId,
        attachmentId: attachment.attachmentId,
      });
      expect(metadataUpstream.connected).toBe(false);
    } finally {
      controller.abort();
      service.close();
      catalog.close();
    }
  });

  it("does not reattach to stale configured parent after explicit local promotion", async () => {
    const catalog = new HostCatalog({ filename: ":memory:", hostName: "recovering-aggregate" });
    const metadataUpstream = new ReconnectableMetadataUpstream();
    const service = new HostService({
      catalog,
      instanceId: "recovering-aggregate-boot",
      metadataUpstream,
    });
    const local = catalog.setLocalEndpointId("recovering-child-endpoint");
    const parentHostId = newHostId();
    const attachment: HostAttachment = {
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
      parentHostId,
      childHostId: local.hostId,
      rootHostId: parentHostId,
      authorityHostId: parentHostId,
      authorityEpochId: newAuthorityEpochId(),
      attachedAt: new Date().toISOString(),
    };
    const attach = vi.fn().mockResolvedValue({
      accepted: true,
      canonical: { ...local, parentHostId, attachmentId: attachment.attachmentId },
      attachment,
      parentCheckpoint: { feedId: newFeedId(), controlCursor: 0 },
    });
    const heartbeat = vi.fn().mockImplementation(async () => {
      const attached = catalog.localHost();
      catalog.forceAdoptAuthority({
        subtreeRootHostId: attached.hostId,
        previousRootHostId: attached.rootHostId,
        previousAuthorityHostId: attached.authorityHostId,
        previousAuthorityEpochId: attached.authorityEpochId,
        destinationRootHostId: attached.hostId,
        destinationAuthorityHostId: attached.hostId,
        destinationHostBootId: attached.hostBootId,
        destinationAuthorityEpochId: newAuthorityEpochId(),
        audit: {
          actorId: "authenticated-operator",
          reason: "old parent is irrecoverable",
          evidence: ["unit-test"],
          acknowledgedSplitBrainRisk: true,
          requestedAt: new Date().toISOString(),
        },
      });
      throw new Error("old parent link was fenced by promotion");
    });
    const peer = {
      identity: { id: "parent-endpoint" },
      rpc: {
        ingress: {
          hosts: {
            attach: { mutate: attach },
            heartbeat: { mutate: heartbeat },
            pushMetadataOutbox: { mutate: vi.fn().mockResolvedValue([]) },
          },
        },
      },
    };
    const node = { connectAs: vi.fn().mockResolvedValue(peer) };
    const controller = new AbortController();

    try {
      await superviseParentHost({
        node: node as never,
        target: {
          endpointId: "parent-endpoint",
          locator: { kind: "ticket", ticket: "parent-ticket" },
        },
        catalog,
        service,
        metadataUpstream,
        heartbeatMs: 10,
        reconnectMaxMs: 1,
        signal: controller.signal,
      });

      expect(node.connectAs).toHaveBeenCalledTimes(1);
      expect(attach).toHaveBeenCalledTimes(1);
      expect(catalog.localHost()).toMatchObject({
        parentHostId: null,
        attachmentId: null,
        rootHostId: local.hostId,
        authorityHostId: local.hostId,
      });
    } finally {
      controller.abort();
      service.close();
      catalog.close();
    }
  });
});
