import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  newArchiveOperationId, newCommandId, type AccessStreamItem,
  type SourceId, type StreamCursor,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it, vi } from "vitest";
import type { ChildControlNodeConnection } from "../../packages/control-node-core/src/index.js";
import type { ControlNodeSourceClient } from "../../packages/gateway-core/src/index.js";
import { addReplayCleanup, replayFixture } from "../../packages/transport-p2prpc/test/runtime-replay-fixture.js";

// Qualification-only: explicitly provide immutable, separately installed peer
// packages. Default repository tests skip it rather than silently substituting
// this checkout's new control/gateway for the deployed old peers.
const rootPackage = process.env.MUX_MIXED_ROOT_PACKAGE;
const gatewayPackage = process.env.MUX_MIXED_GATEWAY_PACKAGE;
const mixed = rootPackage && gatewayPackage ? describe : describe.skip;

async function mixedPeers(f: Awaited<ReturnType<typeof replayFixture>>) {
  if (!rootPackage || !gatewayPackage) throw new Error("exact peer package paths are required");
  const rootManifest = JSON.parse(readFileSync(join(rootPackage, "package.json"), "utf8"));
  const gatewayManifest = JSON.parse(readFileSync(join(gatewayPackage, "package.json"), "utf8"));
  expect(rootManifest).toMatchObject({ name: "@arduano/agent-multiplex-control-node-core", version: "0.2.4-hotfix.22" });
  expect(gatewayManifest).toMatchObject({ name: "@arduano/agent-multiplex-gateway-core", version: "0.2.4-hotfix.23" });
  const rootModule = await import(pathToFileURL(join(rootPackage, "dist/index.js")).href) as typeof import("../../packages/control-node-core/src/index.js");
  const gatewayModule = await import(pathToFileURL(join(gatewayPackage, "dist/index.js")).href) as typeof import("../../packages/gateway-core/src/index.js");
  const catalog = new rootModule.ControlNodeCatalog({ filename: ":memory:", controlNodeName: "old-root" });
  const errors: unknown[] = [];
  const service = new rootModule.ControlNodeService({ catalog, onChildControlNodePumpError: (_id, error) => errors.push(error) });
  const controller = new AbortController();
  const rootItems: AccessStreamItem[] = [];
  const gatewayItems: AccessStreamItem[] = [];
  addReplayCleanup(async () => { controller.abort(); service.close(); catalog.close(); });
  const local = f.catalog.localControlNode();
  const admission = catalog.attachChild({
    controlNodeId: local.controlNodeId, controlNodeBootId: local.controlNodeBootId,
    feedId: local.feedId, name: local.name, endpointId: "mixed-child-endpoint",
    protocolVersion: 6, capabilities: local.capabilities,
    expectedParentControlNodeId: catalog.localControlNode().controlNodeId,
    childProof: f.catalog.attachmentProof(),
  });
  f.catalog.applyParentAttachment(admission.attachment, "mixed-parent-endpoint");
  f.runtime.applyCanonicalSessions(f.catalog.listSessions());
  const unused = async () => { throw new Error("mixed qualification did not admit this operation"); };
  const link = {
    controlNodeId: local.controlNodeId,
    controlNodeBootId: local.controlNodeBootId,
    attachmentId: admission.attachment.attachmentId,
    lineageId: admission.attachment.lineageId,
  };
  const parentContext = { endpointId: "mixed-parent-endpoint", authenticatedControlNodeId: catalog.localControlNode().controlNodeId };
  const connection: ChildControlNodeConnection = {
    controlNodeId: local.controlNodeId, controlNodeBootId: local.controlNodeBootId,
    endpointId: "mixed-child-endpoint",
    readSubtreeSnapshot: async input => f.control.readSubtreeSnapshot({ ...input, ...link }, parentContext),
    subscribeAggregate: (cursor, signal) => f.control.subscribeAggregate(cursor, link, parentContext, signal),
    listModels: async () => [], listLaunchProfileModels: async () => [],
    refreshInventory: unused, createLaunch: unused, getLaunch: unused,
    listLaunches: unused, searchSessions: unused, getSession: unused,
    resume: unused, stop: unused, archive: unused, getArchive: unused,
    execute: unused, readNativeHistory: unused, resolveInteraction: unused,
  };
  await service.attachChildConnection(connection);
  const sourceId = "mixed-root" as SourceId;
  const client = {
    loadSnapshot: async () => {
      const snapshot = catalog.accessSnapshot();
      return { ...snapshot, ...snapshot.source };
    },
    watch: (cursor: StreamCursor, signal: AbortSignal) => service.events.attach({ sessions: "all", includeNative: true, cursor }, signal),
  } as ControlNodeSourceClient;
  const gateway = new gatewayModule.AccessGatewayProjection([
    { sourceId, displayName: "installed root", endpointId: "mixed-parent-endpoint", client },
  ]);
  await gateway.refreshSource(sourceId);
  const cursor: StreamCursor = { ...catalog.feedCheckpoint(), native: {} };
  const route = (async () => {
    try {
      for await (const item of client.watch(cursor, controller.signal)) {
        rootItems.push(item);
        gateway.ingest(sourceId, item);
      }
    } catch (error) { if (!controller.signal.aborted) errors.push(error); }
  })();
  const observe = (async () => {
    try {
      for await (const item of gateway.attach({ sessions: "all", includeNative: true }, controller.signal)) gatewayItems.push(item);
    } catch (error) { if (!controller.signal.aborted) errors.push(error); }
  })();
  addReplayCleanup(async () => { controller.abort(); await Promise.all([route, observe]); });
  return { catalog, service, gateway, rootItems, gatewayItems, errors, connection, sourceId };
}

mixed("new Host replay against exact installed Root .22 and Gateway .23", () => {
  it.each((["codex", "copilot"] as const).flatMap(harness =>
    (["stopped", "archived", "resumed", "nativeStopped"] as const).map(retirement => ({ harness, retirement }))))(
    "keeps unrelated $harness native output flowing after $retirement and a child reconnect",
    async ({ harness, retirement }) => {
      const f = await replayFixture({ harness });
      const retired = await f.launch();
      retired.session.reply("retired reply");
      if (retirement === "nativeStopped") await retired.session.stop();
      else await f.runtime.stop({ operation: "stop", commandId: newCommandId(), payloadHash: "synthetic-mixed-stop", sessionId: retired.sessionId,
        runtimeNodeId: f.fence.runtimeNodeId, bindingRevision: 1 });
      f.control.publishRuntimeEvent({ ...f.fence, event: { kind: "control", change: { type: "session.upsert", session: f.store.getSession(retired.sessionId)! } } }, f.context);
      if (retirement === "archived") {
        const archiveOperationId = newArchiveOperationId();
        f.runtime.archive({ archiveOperationId, payloadHash: "synthetic-mixed-archive", sessionId: retired.sessionId,
          runtimeNodeId: f.fence.runtimeNodeId, bindingRevision: 1, expectedAuthority: f.catalog.authority() });
        await vi.waitFor(() => expect(f.runtime.getArchive(archiveOperationId)?.state).toBe("succeeded"));
        f.catalog.recordArchive(f.runtime.getArchive(archiveOperationId)!);
      } else if (retirement === "resumed") {
        await f.runtime.resume({ operation: "resume", commandId: newCommandId(), payloadHash: "synthetic-mixed-resume", sessionId: retired.sessionId,
          runtimeNodeId: f.fence.runtimeNodeId, bindingRevision: 1 });
        f.control.publishRuntimeEvent({ ...f.fence, event: { kind: "control", change: { type: "session.upsert", session: f.store.getSession(retired.sessionId)! } } }, f.context);
      }
      const healthy = await f.launch();
      const peers = await mixedPeers(f);
      healthy.session.reply("new reply before reverse-feed connection");
      expect(f.control.heartbeatRuntimeNode(f.fence, f.context)).toMatchObject({ accepted: true });
      f.pump.start();
      await vi.waitFor(() => expect(peers.gatewayItems.filter(item => item.kind === "native" && item.sessionId === healthy.sessionId)).toHaveLength(1));
      healthy.session.reply("live reply after first delivery");
      await vi.waitFor(() => expect(peers.gatewayItems.filter(item => item.kind === "native" && item.sessionId === healthy.sessionId)).toHaveLength(2));
      await peers.service.attachChildConnection(peers.connection);
      await peers.gateway.refreshSource(peers.sourceId);
      healthy.session.reply("live reply after child reconnection");
      await vi.waitFor(() => expect(peers.gatewayItems.filter(item => item.kind === "native" && item.sessionId === healthy.sessionId)).toHaveLength(3));
      const streamed = peers.gatewayItems.filter(item => item.kind === "native" && item.sessionId === healthy.sessionId);
      expect(streamed.map(item => item.kind === "native" && item.sequence)).toEqual([0, 1, 2]);
      for (const item of streamed) expect(item.provenance).toEqual({
        originControlNodeId: f.catalog.localControlNode().controlNodeId,
        authority: peers.catalog.authority(),
      });
      expect(peers.errors).toEqual([]);
      expect(f.errors).toEqual([]);
      expect(f.subscriptions).toHaveLength(1);
      expect(peers.rootItems.filter(item => item.kind === "native" && item.sessionId === retired.sessionId)).toEqual([]);
      expect(peers.catalog.getSession(healthy.sessionId)?.metadataAuthority).toEqual(peers.catalog.authority());
      expect(peers.catalog.listRuntimeNodes()).toHaveLength(1);
      expect(peers.catalog.listRuntimeNodes()[0]).toMatchObject({ presence: "online", reachability: "reachable", ownerControlNodeId: f.catalog.localControlNode().controlNodeId });
      const history = await f.runtime.readNativeHistory(healthy.sessionId, { harness, limit: 20 });
      expect(history.payload.json).toEqual([
        { text: "new reply before reverse-feed connection" },
        { text: "live reply after first delivery" },
        { text: "live reply after child reconnection" },
      ]);
    },
  );
});
