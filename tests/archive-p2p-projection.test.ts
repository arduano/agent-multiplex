import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adapterScopeIdSchema,
  emptyMetadataSnapshot,
  newArchiveOperationId,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  type ArchiveRecord,
  type RuntimeNodeEventItem,
  type RuntimeNodeSessionRecord,
  type SourceId,
} from "@arduano/agent-multiplex-protocol";
import {
  ControlNodeCatalog,
  ControlNodeService,
} from "@arduano/agent-multiplex-control-node-core";
import {
  AccessGatewayProjection,
  type ControlNodeSourceClient,
} from "@arduano/agent-multiplex-gateway-core";
import {
  createRuntimeNodeRouter,
  RuntimeNodeService,
  RuntimeNodeStore,
  type AgentAdapter,
} from "@arduano/agent-multiplex-runtime-node-core";
import {
  createMultiplexP2PNode,
  P2PRuntimeNodeConnection,
  RuntimeNodeEventPump,
  type MultiplexP2PNode,
} from "@arduano/agent-multiplex-transport-p2prpc";
import type { PeerContext } from "@arduano/p2prpc-core";
import { initTRPC } from "@trpc/server";
import { describe, expect, it } from "vitest";

const t = initTRPC.context<PeerContext>().create();

const adapterScopeId = adapterScopeIdSchema.parse("archive-transport-test");
const adapter: AgentAdapter = {
  harness: "codex",
  adapterScopeId,
  describe: async () => ({
    harness: "codex",
    adapterScopeId,
    available: true,
    capabilities: [],
  }),
  listModels: async () => [],
  listSessions: async () => [],
  spawn: async () => { throw new Error("unused"); },
  resume: async () => { throw new Error("unused"); },
  releaseSession: async () => {},
  close: async () => {},
};

describe("archive projection over real p2prpc transport", () => {
  it("serializes every archive phase and advances control and gateway exact lookup", {
    timeout: 30_000,
  }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "multiplex-archive-p2p-"));
    const runtimeStore = new RuntimeNodeStore(join(directory, "runtime.sqlite"));
    const controlCatalog = new ControlNodeCatalog({
      filename: join(directory, "control.sqlite"),
    });
    const controlService = new ControlNodeService({ catalog: controlCatalog });
    const runtimeNodeId = newRuntimeNodeId();
    const runtimeNodeBootId = newRuntimeNodeBootId();
    const sessionId = newSessionId();
    const authority = controlCatalog.authority();
    const timestamp = new Date().toISOString();
    const runtimeSession: RuntimeNodeSessionRecord = {
      sessionId,
      runtimeNodeId,
      harness: "codex",
      adapterScopeId,
      vendorSessionId: "native-archive-transport",
      bindingRevision: 1,
      runtimeEpoch: null,
      cwd: directory,
      availability: "resumable",
      runtimeStatus: "stopped",
      launchProvenance: null,
      metadata: emptyMetadataSnapshot(),
      metadataAuthority: authority,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSeenAt: timestamp,
      lastActivityAt: timestamp,
    };
    runtimeStore.putSession(runtimeSession);
    const runtimeService = new RuntimeNodeService({
      store: runtimeStore,
      runtimeNodeId,
      runtimeNodeBootId,
      name: "archive transport runtime",
      allowedRoots: [directory],
      adapters: [adapter],
    });
    const runtimeRouter = createRuntimeNodeRouter(runtimeService);
    const controlRouter = t.router({});
    let runtimeNode:
      | MultiplexP2PNode<typeof runtimeRouter, typeof controlRouter>
      | undefined;
    let controlNode:
      | MultiplexP2PNode<typeof controlRouter, typeof runtimeRouter>
      | undefined;
    let pump: RuntimeNodeEventPump | undefined;
    const gatewayAbort = new AbortController();
    let gatewayTask: Promise<void> | undefined;

    try {
      const enrolledEndpointId = "archive-transport-runtime-endpoint";
      controlCatalog.registerRuntimeNode(
        await runtimeService.describe(),
        enrolledEndpointId,
      );
      controlCatalog.mergeRuntimeSession(runtimeSession);

      const sourceId = "control" as SourceId;
      const sourceClient = {
        loadSnapshot: async () => {
          const snapshot = controlService.sourceSnapshot();
          return {
            manifest: snapshot.source.manifest,
            parentByControlNodeId: snapshot.source.parentByControlNodeId,
            controlNodes: snapshot.controlNodes,
            runtimeNodes: snapshot.runtimeNodes,
            sessions: snapshot.sessions,
            interactions: snapshot.interactions,
            metadataOperations: snapshot.metadataOperations,
          };
        },
        watch: (cursor, signal) => controlService.watchSessions({
          sessions: "all",
          cursor,
          includeNative: true,
        }, signal),
        getSession: (id) => controlService.getSession(id),
        searchSessions: (query) => controlService.searchSessions(query),
      } as Pick<
        ControlNodeSourceClient,
        "loadSnapshot" | "watch" | "getSession" | "searchSessions"
      > as ControlNodeSourceClient;
      const gateway = new AccessGatewayProjection([{
        sourceId,
        displayName: "control",
        endpointId: "control-endpoint",
        priority: 0,
        client: sourceClient,
      }]);
      await gateway.refreshSource(sourceId);
      expect(gateway.diagnostics()).toMatchObject([{ state: "selected" }]);
      gatewayTask = gateway.synchronizeSource(sourceId, gatewayAbort.signal, {
        minimumBackoffMs: 10,
        maximumBackoffMs: 20,
      });
      await expect.poll(() => gateway.listSessions().map((item) => item.sessionId))
        .toContain(sessionId);
      await expect(gateway.getSession(sessionId)).resolves.toMatchObject({
        catalogState: "open",
        catalogRevision: 1,
      });

      const sharedSecret = "archive-event-transport-regression".padEnd(64, "x");
      const iroh = {
        relay: { mode: "disabled" as const },
        allowAdvertisedAddress: () => true,
        allowDirectAddress: () => true,
      };
      runtimeNode = await createMultiplexP2PNode({
        router: runtimeRouter,
        sharedSecret: { secret: sharedSecret },
        createContext: (context) => ({ authenticatedPeerId: context.p2p.auth.id }),
        iroh,
      });
      controlNode = await createMultiplexP2PNode({
        router: controlRouter,
        sharedSecret: { secret: sharedSecret },
        createContext: (context) => context,
        iroh,
      });
      const peer = await controlNode.connect({
        endpointId: runtimeNode.id,
        locator: { kind: "ticket", ticket: await runtimeNode.createTicket() },
      });
      const connection = new P2PRuntimeNodeConnection(
        runtimeNodeId,
        runtimeNodeBootId,
        runtimeNode.id,
        peer,
      );
      const archiveStates: ArchiveRecord["state"][] = [];
      const transportErrors: unknown[] = [];
      let runtimeItems = 0;
      pump = new RuntimeNodeEventPump({
        connection,
        retryDelayMs: () => 10,
        onError: (error) => { transportErrors.push(error); },
        onItem: (event: RuntimeNodeEventItem) => {
          runtimeItems += 1;
          if (event.kind === "control" && event.change.type === "archive.changed") {
            archiveStates.push(event.change.archive.state);
          }
          return controlService.publishRuntimeEvent({
            runtimeNodeId,
            runtimeNodeBootId,
            event,
          }, {
            authenticatedRuntimeNodeId: runtimeNodeId,
            endpointId: enrolledEndpointId,
          }).accepted;
        },
      });
      pump.start();
      await expect.poll(() => runtimeItems, { timeout: 10_000 }).toBeGreaterThan(0);
      expect(transportErrors).toEqual([]);

      const archiveOperationId = newArchiveOperationId();
      const accepted = await connection.archive({
        archiveOperationId,
        payloadHash: "archive-transport-regression",
        sessionId,
        runtimeNodeId,
        bindingRevision: 1,
        expectedAuthority: authority,
      });
      expect(accepted.state).toBe("accepted");
      expect(accepted.authority).toEqual(accepted.expectedAuthority);
      expect(accepted.authority).not.toBe(accepted.expectedAuthority);

      await expect.poll(() => archiveStates, { timeout: 10_000 }).toEqual([
        "accepted",
        "releasing",
        "succeeded",
      ]);
      expect(transportErrors).toEqual([]);
      await expect.poll(async () => controlService.getSession(sessionId), {
        timeout: 10_000,
      }).toMatchObject({
        catalogState: "archived",
        catalogRevision: 2,
      });
      await expect.poll(() => gateway.listSessions().some(
        (item) => item.sessionId === sessionId,
      ), { timeout: 10_000 }).toBe(false);
      await expect.poll(async () => gateway.getSession(sessionId), {
        timeout: 10_000,
      }).toMatchObject({
        catalogState: "archived",
        catalogRevision: 2,
      });
    } finally {
      pump?.stop();
      gatewayAbort.abort();
      await Promise.allSettled([
        gatewayTask,
        controlNode?.close(),
        runtimeNode?.close(),
      ]);
      controlService.close();
      controlCatalog.close();
      await runtimeService.close();
      runtimeStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
