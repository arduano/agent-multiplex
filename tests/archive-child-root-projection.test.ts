import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ControlNodeCatalog } from "@arduano/agent-multiplex-control-node-core";
import { AccessGatewayProjection, type ControlNodeSourceClient } from "@arduano/agent-multiplex-gateway-core";
import {
  newArchiveOperationId, newRuntimeNodeBootId, newRuntimeNodeId,
  type AdapterScopeId, type FeedControlItem, type SourceId,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";

const timestamp = "2037-09-30T00:00:00.000Z";
const releasedAt = "2037-09-30T00:01:00.000Z";

describe("child archive through Root feed to Gateway projection", () => {
  it.each([
    ["codex", "individual"], ["copilot", "individual"],
    ["codex", "batch"], ["copilot", "batch"],
  ] as const)("publishes the archived %s session from %s import without resnapshot", async (harness, mode) => {
    const directory = mkdtempSync(join(tmpdir(), "multiplex-child-archive-projection-"));
    const root = new ControlNodeCatalog({ filename: join(directory, "root.sqlite"), now: () => new Date(timestamp) });
    const child = new ControlNodeCatalog({ filename: join(directory, "child.sqlite"), now: () => new Date(timestamp) });
    let unsubscribe: (() => void) | undefined;
    try {
      const local = child.localControlNode();
      const { attachment } = root.attachChild({
        controlNodeId: local.controlNodeId, controlNodeBootId: local.controlNodeBootId,
        feedId: local.feedId, name: local.name, protocolVersion: 6,
        capabilities: local.capabilities, expectedParentControlNodeId: root.localControlNode().controlNodeId,
        childProof: child.attachmentProof(),
      });
      child.applyParentAttachment(attachment, "fixture-root-endpoint");
      const runtimeNodeId = newRuntimeNodeId();
      child.registerRuntimeNode({
        runtimeNodeId, runtimeNodeBootId: newRuntimeNodeBootId(), name: "fixture-runtime",
        allowedRoots: ["/work"], harnesses: [], protocolVersion: 6,
      });
      const sessions = child.reconcileInventory({
        runtimeNodeId, generation: "stopped-fixtures", complete: true, capturedAt: timestamp,
        sessions: ["target", "untouched"].map(vendorSessionId => ({
          harness, adapterScopeId: "archive-projection-fixture" as AdapterScopeId,
          vendorSessionId, cwd: "/work", availability: "resumable" as const,
          runtimeStatus: "stopped" as const, runtimeEpoch: null, lastActivityAt: timestamp,
        })),
      });
      const target = sessions.find(session => session.vendorSessionId === "target")!;
      const untouched = sessions.find(session => session.vendorSessionId === "untouched")!;
      root.replaceChildSnapshot(local.controlNodeId, attachment.attachmentId, child.accessSnapshot());

      const sourceId = "root" as SourceId;
      let snapshots = 0;
      const sourceClient = {
        loadSnapshot: async () => {
          snapshots++;
          const snapshot = root.accessSnapshot();
          return { manifest: snapshot.source.manifest, parentByControlNodeId: snapshot.source.parentByControlNodeId,
            controlNodes: snapshot.controlNodes, runtimeNodes: snapshot.runtimeNodes, sessions: snapshot.sessions,
            interactions: snapshot.interactions, metadataOperations: snapshot.metadataOperations };
        },
        getSession: async id => root.getSession(id),
        getArchive: async id => root.getArchive(id),
        searchSessions: async query => root.searchSessions(query),
      } satisfies Pick<ControlNodeSourceClient, "loadSnapshot" | "getSession" | "getArchive" | "searchSessions">;
      const gateway = new AccessGatewayProjection([{
        sourceId, endpointId: "fixture-root-endpoint", displayName: "Root", priority: 0,
        client: sourceClient as ControlNodeSourceClient,
      }]);
      await gateway.refreshSource(sourceId);
      expect(gateway.listSessions()).toHaveLength(2);
      await expect(gateway.getSession(target.sessionId)).resolves.toMatchObject({ catalogState: "open" });
      const published: FeedControlItem[] = [];
      // Consume the Root's actual committed control feed, not a fabricated
      // archive event or a Gateway-only cache correction.
      unsubscribe = root.onControl(item => { published.push(item); gateway.ingest(sourceId, item); });
      const beforeChild = child.controlCursor();
      const receipt = child.recordArchive({
        archiveOperationId: newArchiveOperationId(), payloadHash: "fixture-child-archive-stable-envelope",
        sessionId: target.sessionId, runtimeNodeId, bindingRevision: target.bindingRevision,
        expectedAuthority: child.authority(), authority: child.authority(),
        state: "succeeded", releasedAt, catalogRevision: target.catalogRevision + 1,
        createdAt: timestamp, updatedAt: releasedAt,
      });
      const items = child.controlEventsAfter(beforeChild);
      expect(items.map(item => item.change.type)).toEqual(["archive.changed", "session.upsert"]);
      if (mode === "batch") root.importChildControls(local.controlNodeId, attachment.attachmentId, items);
      else for (const item of items) root.importChildControl(local.controlNodeId, attachment.attachmentId, item);

      // This was the broken state: Root SQL was archived, but the warm Gateway
      // still returned the old open session after the redundant child upsert.
      expect(root.getSession(target.sessionId)).toMatchObject({ catalogState: "archived" });
      expect(gateway.listSessions().map(session => session.sessionId)).toEqual([untouched.sessionId]);
      await expect(gateway.getSession(target.sessionId)).resolves.toMatchObject({
        catalogState: "archived", catalogRevision: receipt.catalogRevision, archivedAt: releasedAt,
        bindingRevision: target.bindingRevision, vendorSessionId: target.vendorSessionId,
        metadata: target.metadata, metadataAuthority: root.authority(),
      });
      await expect(gateway.getArchive(receipt.archiveOperationId)).resolves.toMatchObject({ state: "succeeded" });
      expect(root.getSession(untouched.sessionId)).toEqual(untouched);
      const archivedUpserts = published.filter(item => item.change.type === "session.upsert" &&
        item.change.session.sessionId === target.sessionId && item.change.session.catalogState === "archived");
      expect(archivedUpserts).toHaveLength(1);
      expect(archivedUpserts[0]?.provenance).toEqual({
        originControlNodeId: root.localControlNode().controlNodeId, authority: root.authority(),
      });
      expect(items.some(item => item.eventId === archivedUpserts[0]?.eventId)).toBe(false);
      expect(published.find(item => item.change.type === "archive.changed")).toMatchObject({
        eventId: items[0]!.eventId, provenance: items[0]!.provenance,
      });
      expect(snapshots).toBe(1);

      const after = root.controlCursor();
      for (const item of items) expect(root.importChildControl(local.controlNodeId, attachment.attachmentId, item).deduplicated).toBe(true);
      expect(root.controlCursor()).toBe(after);
      expect(gateway.listSessions().map(session => session.sessionId)).toEqual([untouched.sessionId]);
    } finally { unsubscribe?.(); child.close(); root.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
