import { type AccessStreamItem, type SourceId, type StreamCursor } from "@arduano/agent-multiplex-protocol";
import { ControlNodeCatalog, ControlNodeService, type ChildControlNodeConnection } from "../../control-node-core/src/index.js";
import { AccessGatewayProjection, type ControlNodeSourceClient } from "../../gateway-core/src/index.js";
import { addReplayCleanup, type replayFixture } from "./runtime-replay-fixture.js";

/** Real source control-tree and Gateway projections over an in-process read
 * port. No native vendors, endpoint enrollment, network, or model calls. */
export async function replayTreeFixture(f: Awaited<ReturnType<typeof replayFixture>>) {
  const catalog = new ControlNodeCatalog({ filename: ":memory:", controlNodeName: "stress-root" });
  const errors: unknown[] = [];
  const service = new ControlNodeService({ catalog, onChildControlNodePumpError: (_id, error) => errors.push(error) });
  const controller = new AbortController();
  const rootItems: AccessStreamItem[] = [];
  const gatewayItems: AccessStreamItem[] = [];
  addReplayCleanup(async () => { controller.abort(); service.close(); catalog.close(); });
  const local = f.catalog.localControlNode();
  const admission = catalog.attachChild({ controlNodeId: local.controlNodeId, controlNodeBootId: local.controlNodeBootId,
    feedId: local.feedId, name: local.name, endpointId: "stress-child-endpoint", protocolVersion: 6, capabilities: local.capabilities,
    expectedParentControlNodeId: catalog.localControlNode().controlNodeId, childProof: f.catalog.attachmentProof() });
  f.catalog.applyParentAttachment(admission.attachment, "stress-parent-endpoint");
  f.runtime.applyCanonicalSessions(f.catalog.listSessions());
  const link = { controlNodeId: local.controlNodeId, controlNodeBootId: local.controlNodeBootId,
    attachmentId: admission.attachment.attachmentId, lineageId: admission.attachment.lineageId };
  const parentContext = { endpointId: "stress-parent-endpoint", authenticatedControlNodeId: catalog.localControlNode().controlNodeId };
  const unused = async () => { throw new Error("synthetic read port did not admit this operation"); };
  const connection: ChildControlNodeConnection = {
    controlNodeId: local.controlNodeId, controlNodeBootId: local.controlNodeBootId, endpointId: "stress-child-endpoint",
    readSubtreeSnapshot: async input => f.control.readSubtreeSnapshot({ ...input, ...link }, parentContext),
    subscribeAggregate: (cursor, signal) => f.control.subscribeAggregate(cursor, link, parentContext, signal),
    listModels: async () => [], listLaunchProfileModels: async () => [], refreshInventory: unused, createLaunch: unused, getLaunch: unused,
    listLaunches: unused, searchSessions: unused, getSession: unused, resume: unused, stop: unused, archive: unused, getArchive: unused,
    execute: unused, readNativeHistory: unused, resolveInteraction: unused,
  };
  await service.attachChildConnection(connection);
  const sourceId = "stress-root" as SourceId;
  const client: ControlNodeSourceClient = {
    loadSnapshot: async () => { const snapshot = catalog.accessSnapshot(); return { ...snapshot, ...snapshot.source }; },
    watch: (cursor: StreamCursor, signal: AbortSignal) => service.events.attach({ sessions: "all", includeNative: true, cursor }, signal),
  } as ControlNodeSourceClient;
  const gateway = new AccessGatewayProjection([{ sourceId, displayName: "synthetic root", endpointId: "stress-parent-endpoint", client }]);
  await gateway.refreshSource(sourceId);
  const cursor: StreamCursor = { ...catalog.feedCheckpoint(), native: {} };
  const route = (async () => {
    try { for await (const item of client.watch(cursor, controller.signal)) { rootItems.push(item); gateway.ingest(sourceId, item); } }
    catch (error) { if (!controller.signal.aborted) errors.push(error); }
  })();
  const observe = (async () => {
    try { for await (const item of gateway.attach({ sessions: "all", includeNative: true }, controller.signal)) gatewayItems.push(item); }
    catch (error) { if (!controller.signal.aborted) errors.push(error); }
  })();
  addReplayCleanup(async () => { controller.abort(); await Promise.all([route, observe]); });
  return { catalog, service, gateway, rootItems, gatewayItems, errors, connection, sourceId };
}
