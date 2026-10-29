import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTRPC } from "@trpc/server";
import { WebSocketServer } from "ws";
import { activateHost } from "../../src/host/index.js";
import { OriginalJournal } from "../../src/storage/index.js";
import { Gateway, gatewayHttpHandler, gatewayRouter } from "../../src/gateway/node.js";
import { hostTargetSchema, type Viewer, type HostTarget } from "../../src/gateway/contracts.js";
import {
  createMultiplexNode,
  createSharedSecretSecurity,
  hostBridge,
  pinnedTarget,
  relayHostBridge,
  type BorrowedBridgePeer,
} from "../../src/transport/node/p2prpc.js";
import { serve } from "../../src/reference/node.js";
import {
  createCodexDemoDefinition,
  codexDemoGatewayRouter,
} from "../../src/reference/codex/node.js";
import { fixture, defaultHandler, selection, type ScriptedWire } from "../codex/fixtures.js";
import {
  nativeHandler,
  nativeThread,
  nativeTurn,
  nativeMessage,
} from "../codex/native-fixtures.js";
import type { RunRef } from "../../src/protocol/index.js";

export async function openCodexBrowserFixture(assets: string) {
  const directory = await mkdtemp(join(tmpdir(), "multiplex-codex-browser-"));
  const startupCleanup: (() => void | Promise<void>)[] = [() => rm(directory, { recursive: true })];
  try {
    const journal = new OriginalJournal({ filename: join(directory, "originals.sqlite") });
    startupCleanup.push(() => journal.close());
    let native: Awaited<ReturnType<typeof fixture>> | undefined;
    let starts = 0,
      sends = 0,
      historyReads = 0,
      gatewayId = "";
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const threadIds = new WeakMap<ScriptedWire, string>();
    const definition = await createCodexDemoDefinition({
      journal,
      selection,
      async adapter(observe) {
        native = await fixture({ observe }, (request, wire) => {
          if (
            [
              "thread/read",
              "thread/items/list",
              "thread/turns/list",
              "thread/timeline/list",
            ].includes(request.method)
          )
            historyReads++;
          if (request.method === "thread/start") {
            const id = `browser-native-${++starts}`;
            threadIds.set(wire, id);
            return {
              ...(defaultHandler(request, wire) as Record<string, unknown>),
              thread: nativeThread(id),
            };
          }
          if (request.method === "turn/start") {
            assert(++sends <= 4, "Finite scripted Send allowance");
            const result = nativeHandler(request, wire) as { turn: ReturnType<typeof nativeTurn> };
            const threadId = threadIds.get(wire)!;
            const message = nativeMessage(`message-${sends}`, `Browser reply ${sends}`);
            wire.emit({
              method: "item/started",
              params: {
                threadId,
                turnId: result.turn.id,
                item: { ...message, text: "" },
                startedAtMs: 1,
              },
            });
            const timer = setTimeout(() => {
              timers.delete(timer);
              wire.emit({
                method: "item/agentMessage/delta",
                params: {
                  threadId,
                  turnId: result.turn.id,
                  itemId: message.id,
                  delta: message.type === "agentMessage" ? message.text : "",
                },
              });
              wire.emit({
                method: "item/completed",
                params: { threadId, turnId: result.turn.id, item: message, completedAtMs: 2 },
              });
              wire.emit({
                method: "turn/completed",
                params: { threadId, turn: nativeTurn(result.turn.id, "completed") },
              });
            }, 30);
            timers.add(timer);
            return result;
          }
          return nativeHandler(request, wire);
        });
        startupCleanup.push(() => native!.cleanup());
        return native.adapter;
      },
    });
    const route = {
      authority: "local-root",
      host: "scripted-codex",
      owner: "local-owner",
      routeEpoch: "browser-case",
    };
    const viewer: Viewer = {
      connection: "browser-case",
      principal: "owner",
      actions: ["read", "control"],
      hosts: [route.host],
    };
    const token = randomUUID();
    const cookie = `codex_demo=${token}`;
    const host = await activateHost(definition, {
      route,
      authenticate: ({ proof }) =>
        proof === token
          ? {
              identity: {
                connection: viewer.connection,
                principal: viewer.principal,
                actions: viewer.actions,
              },
              route,
            }
          : null,
    });
    const runs: RunRef[] = [];
    startupCleanup.push(async () => {
      for (const run of runs)
        await host.sessions.stop(run.scope, `startup-stop-${run.scope.session}`, run.generation);
      await host.close();
    });
    for (const session of ["first", "second"]) {
      assert.equal(
        (
          await host.sessions.create(
            {
              connection: viewer.connection,
              principal: viewer.principal,
              host: route.host,
              session,
            },
            `create-${session}`,
            { cwd: native!.directory },
          )
        ).state,
        "succeeded",
      );
      const state = host.sessions.state({
        connection: viewer.connection,
        principal: viewer.principal,
        host: route.host,
        session,
      });
      assert.equal(state.phase, "running");
      if (state.phase === "running") runs.push(state.run);
    }
    const gateway = new Gateway<BorrowedBridgePeer>({
      authorizePeer: (peer) => peer.route.owner === route.owner,
    });
    startupCleanup.push(() => gateway.close());
    const target: HostTarget = {
      route,
      expected: {
        contractId: host.manifest.contractId,
        contractVersion: host.manifest.contractVersion,
        compositionId: host.manifest.compositionId,
      },
    };
    const custom = codexDemoGatewayRouter({
      async summary() {
        return { label: "Browser Gateway inventory", availableWorkspaces: 2 };
      },
    });
    const gatewayApi = gatewayRouter(gateway, definition.gateway!, custom);
    const gatewayHttp = gatewayHttpHandler(
      gateway,
      {
        async authenticate(request) {
          return request.headers.get("cookie")?.split("; ").includes(cookie) ? viewer : null;
        },
      },
      gatewayApi,
    );
    const secret = randomBytes(32),
      pins = new Set<string>();
    const security = () =>
      createSharedSecretSecurity(secret, {
        authorize: (context) =>
          pins.has(context.remotePeerId) && context.principal.id === context.remotePeerId,
      });
    const iroh = {
      relay: { mode: "disabled" as const },
      discovery: { dns: false, mdns: false },
      allowAdvertisedAddress: () => true,
      allowDirectAddress: () => true,
    };
    const bridge = hostBridge(host, {
      route,
      manifest: host.manifest,
      proof: () => token,
      authorizeDelegation: (offer, requested) =>
        offer.peer.id === gatewayId &&
        offer.auth.principal.id === gatewayId &&
        requested.viewer.connection === viewer.connection &&
        requested.viewer.principal === viewer.principal
          ? viewer
          : null,
      limits: { maxPeers: 2, setupTimeoutMs: 8000, shutdownTimeoutMs: 8000 },
    });
    startupCleanup.push(() => bridge.close());
    const t = initTRPC.create();
    const physicalRouter = t.router({ ping: t.procedure.query(() => "borrowed-peer-alive") });
    const hostNode = await createMultiplexNode({
      router: physicalRouter,
      createContext: () => ({}),
      security: security(),
      iroh,
      onBridge: bridge.accept,
      limits: { connectTimeoutMs: 8000, handshakeTimeoutMs: 8000, shutdownTimeoutMs: 8000 },
    });
    startupCleanup.push(() => hostNode.close());
    const gatewayNode = await createMultiplexNode({
      router: physicalRouter,
      createContext: () => ({}),
      security: security(),
      iroh,
      limits: { connectTimeoutMs: 8000, handshakeTimeoutMs: 8000, shutdownTimeoutMs: 8000 },
    });
    startupCleanup.push(() => gatewayNode.close());
    gatewayId = gatewayNode.id;
    pins.add(hostNode.id);
    pins.add(gatewayNode.id);
    const physical = await gatewayNode.connect<typeof physicalRouter>(
      pinnedTarget(hostNode.id, { kind: "ticket", ticket: await hostNode.createTicket() }),
    );
    gateway.registerHost({ route, manifest: host.manifest, transport: physical });
    const sockets = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: 2097152,
    });
    startupCleanup.push(
      () =>
        new Promise<void>((resolve, reject) =>
          sockets.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const relays = new Set<Promise<void>>();
    const server = await serve({
      assets,
      upgrade(request, socket, head) {
        try {
          const origin = `http://${request.headers.host}`;
          const url = new URL(request.url ?? "/", origin);
          if (
            url.pathname !== "/host" ||
            request.headers.origin !== origin ||
            !request.headers.cookie?.split("; ").includes(cookie)
          )
            throw Error("Unauthorized browser");
          const selected = hostTargetSchema.parse(
            JSON.parse(url.searchParams.get("target") ?? "null"),
          );
          sockets.handleUpgrade(request, socket, head, (websocket) => {
            const work = relayHostBridge(gateway, websocket, { viewer, target: selected });
            relays.add(work);
            void work.finally(() => relays.delete(work)).catch(() => {});
          });
        } catch {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        }
      },
      handler(request) {
        if (new URL(request.url).pathname === "/bootstrap")
          return Promise.resolve(
            Response.json(
              { hostId: hostNode.id, target, runs },
              {
                headers: {
                  "set-cookie": `${cookie}; HttpOnly; SameSite=Strict; Path=/`,
                  "cache-control": "no-store",
                },
              },
            ),
          );
        return gatewayHttp(request);
      },
    });
    startupCleanup.push(() => server.close());
    return {
      url: server.url,
      counts: () => ({
        endpoints: 2,
        scriptedSessions: starts,
        sends,
        historyReads,
        modelPOSTs: 0,
        nativeAgents: 0,
      }),
      physicalAlive: () => physical.rpc.ping.query(),
      async close() {
        for (const timer of timers) clearTimeout(timer);
        const routing = gateway.close();
        for (const socket of sockets.clients) socket.terminate();
        const results = await Promise.allSettled([
          routing,
          server.close(),
          bridge.close(),
          gatewayNode.close(),
          hostNode.close(),
          new Promise<void>((resolve, reject) =>
            sockets.close((error) => (error ? reject(error) : resolve())),
          ),
        ]);
        await Promise.allSettled([...relays]);
        for (const run of runs)
          assert.equal(
            (await host.sessions.stop(run.scope, `cleanup-${run.scope.session}`, run.generation))
              .state,
            "succeeded",
          );
        await host.close();
        journal.close();
        assert(native!.wires.every((wire) => wire.closed));
        assert([...native!.owners.values()].every((owner) => owner.stopped));
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length)
          throw new AggregateError(
            failures.map((failure) => failure.reason),
            "Actual bridge cleanup unproved",
          );
        assert(gateway.readiness());
        assert.equal(bridge.diagnostics().closed, true);
        await rm(native!.directory, { recursive: true });
        await rm(directory, { recursive: true });
        return {
          endpointsClosed: 2,
          listenerClosed: true,
          gatewayReady: true,
          nativeScriptedClosed: true,
          temporaryStateRemoved: true,
        };
      },
    };
  } catch (error) {
    const failures: unknown[] = [error];
    for (const close of startupCleanup.reverse()) {
      try {
        await close();
      } catch (failure) {
        failures.push(failure);
      }
    }
    throw new AggregateError(failures, "Codex browser fixture startup failed", { cause: error });
  }
}
export type CodexBrowserGatewayRouter = ReturnType<
  typeof gatewayRouter<ReturnType<typeof codexDemoGatewayRouter>>
>;
