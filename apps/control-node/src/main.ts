#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ControlNodeCatalog,
  ControlNodeService,
  createCompositeControlNodeRouter,
  type CompositeControlNodeRouter,
  type ControlNodeRouterContext,
  type RuntimeNodeConnection,
} from "@arduano/agent-multiplex-control-node-core";
import {
  actionScopesSchema,
  type ActionScope,
  type ControlNodeId,
  type RuntimeNodeId,
} from "@arduano/agent-multiplex-protocol";
import type { RuntimeNodeRouter } from "@arduano/agent-multiplex-runtime-node-core";
import {
  P2PRuntimeNodeConnection,
  ReconnectableMetadataUpstream,
  RuntimeNodeEventPump,
  createControlNodeIngressContextFactory,
  createControlNodeP2PNode,
  createMultiplexRoleAuthorization,
  type MultiplexP2PNode,
  type MultiplexPeerAuthorization,
} from "@arduano/agent-multiplex-transport-p2prpc";
import type { AnyTRPCRouter } from "@trpc/server";

import {
  controlNodeConfigFromEnvironment,
  parseDesiredControlNodeUpstream,
  type ControlNodeAppConfig,
} from "./config.js";
import { createControlNodeHttpSurface } from "./http.js";
import { superviseUpstreamControlNode } from "./upstream.js";

const VERSION = "0.2.2";

export interface ControlNodeReadyInfo {
  readonly controlNodeId: ControlNodeId;
  readonly endpointId: string;
  readonly ticket: string;
  readonly httpUrl: string;
}

export interface ControlNodeAppOptions {
  /** Persist provisioning material privately instead of scraping process output. */
  readonly onReady?: (info: ControlNodeReadyInfo) => void | Promise<void>;
  /** Reference CLI compatibility; embedded hosts can suppress locator output. */
  readonly printTicket?: boolean;
}

/** Start one durable control node and keep it alive until `signal` aborts. */
export async function runControlNode(
  config: ControlNodeAppConfig,
  signal: AbortSignal,
  options: ControlNodeAppOptions = {},
): Promise<void> {
  const instanceId = config.instanceId ?? randomUUID();
  const secretKey = await loadOrCreateControlNodeSecretKey(config.identityPath);
  const catalog = new ControlNodeCatalog({
    filename: config.statePath,
    controlNodeName: config.name,
  });
  const metadataUpstream = new ReconnectableMetadataUpstream();
  const pumps = new Map<RuntimeNodeId, RuntimeNodeEventPump>();
  let currentP2PTicket: string | undefined;
  let p2pNode:
    | MultiplexP2PNode<CompositeControlNodeRouter, AnyTRPCRouter>
    | undefined;
  let http: ReturnType<typeof createControlNodeHttpSurface> | undefined;
  let ticketRefresh: NodeJS.Timeout | undefined;
  let staleSweep: NodeJS.Timeout | undefined;
  const upstreamController = new AbortController();
  let upstreamSupervisor: Promise<void> = Promise.resolve();

  const currentDesiredUpstream = () => {
    const value = catalog.desiredUpstream();
    return value === null ? undefined : parseDesiredControlNodeUpstream(value);
  };
  const currentPeerEnrollment = (endpointId: string) => {
    const enrollment = catalog.activePeerEnrollment(endpointId);
    const desired = currentDesiredUpstream();
    if (
      enrollment?.role === "parent-control-node" &&
      (desired?.endpointId !== endpointId ||
        desired.controlNodeId !== enrollment.principalId)
    ) return null;
    return enrollment;
  };
  const authorizationForPeer = (
    principalId: string,
    endpointId: string,
  ): MultiplexPeerAuthorization | undefined => {
    if (principalId !== endpointId) return undefined;
    const enrollment = currentPeerEnrollment(endpointId);
    if (!enrollment) return undefined;
    switch (enrollment.role) {
      case "runtime-node":
      case "child-control-node":
      case "parent-control-node":
        return { role: enrollment.role, scopes: new Set<ActionScope>() };
      case "access-gateway":
        return {
          role: enrollment.role,
          scopes: new Set(actionScopesSchema.parse(enrollment.scopes)),
        };
      default:
        return undefined;
    }
  };

  let service: ControlNodeService;
  const startPump = (connection: RuntimeNodeConnection): void => {
    if (!(connection instanceof P2PRuntimeNodeConnection)) {
      throw new TypeError("control-node daemon requires a p2prpc runtime connection");
    }
    const previous = pumps.get(connection.runtimeNodeId);
    const initialCursor = previous?.cursor;
    previous?.stop();
    const pump = new RuntimeNodeEventPump({
      connection,
      ...(initialCursor === undefined ? {} : { initialCursor }),
      onItem: (item) =>
        service.publishRuntimeEvent(
          {
            runtimeNodeId: connection.runtimeNodeId,
            runtimeNodeBootId: connection.runtimeNodeBootId,
            event: item,
          },
          {
            authenticatedRuntimeNodeId: connection.runtimeNodeId,
            endpointId: connection.endpointId,
          },
        ).accepted,
      onError: (error) =>
        console.error(`runtime node ${connection.runtimeNodeId} event feed:`, error),
    });
    pumps.set(connection.runtimeNodeId, pump);
    pump.start();
  };

  service = new ControlNodeService({
    catalog,
    instanceId,
    metadataUpstream,
    p2pTicket: () => currentP2PTicket,
    grantedGatewayScopes: (request) =>
      config.enrollment.accessGatewayScopes.filter((scope) =>
        request.requestedScopes.includes(scope)),
    onRuntimeNodeConnectionAttached: startPump,
    onChildControlNodePumpError: (controlNodeId, error) =>
      console.error(
        `child control node ${controlNodeId} event feed:`,
        error instanceof Error ? error.message : error,
      ),
  });

  try {
    if (config.bootstrapUpstream !== undefined) {
      catalog.bootstrapDesiredUpstream(config.bootstrapUpstream);
    }
    const desiredUpstream = currentDesiredUpstream();
    if (
      desiredUpstream?.controlNodeId ===
      catalog.localControlNode().controlNodeId
    ) {
      throw new Error("a control node cannot configure itself as its upstream");
    }

    const compositeRouter = createCompositeControlNodeRouter(service);
    const ingressContext = createControlNodeIngressContextFactory({
      getRuntimeNodePeer: (endpointId) =>
        p2pNode?.getPeerAs<RuntimeNodeRouter>(endpointId),
      getChildControlNodePeer: (endpointId) =>
        p2pNode?.getPeerAs<AnyTRPCRouter>(endpointId),
      runtimeNodeIdForEndpoint: (endpointId) => {
        const enrollment = currentPeerEnrollment(endpointId);
        return enrollment?.role === "runtime-node"
          ? enrollment.principalId as RuntimeNodeId
          : undefined;
      },
      controlNodeIdForEndpoint: (endpointId) => {
        const enrollment = currentPeerEnrollment(endpointId);
        return enrollment?.role === "child-control-node" ||
          enrollment?.role === "parent-control-node"
          ? enrollment.principalId as ControlNodeId
          : undefined;
      },
      childControlNodeFence: (controlNodeId) => {
        const attachment = catalog.getAttachment(controlNodeId);
        if (!attachment) throw new Error("child attachment is no longer active");
        return attachment;
      },
    });

    p2pNode = await createControlNodeP2PNode<
      CompositeControlNodeRouter,
      AnyTRPCRouter
    >({
      router: compositeRouter,
      sharedSecret: {
        secret: config.sharedSecret,
        sessionTtlMs: 60 * 60_000,
        authorize: createMultiplexRoleAuthorization({
          authorizationForPrincipal: (principalId, endpointId) =>
            authorizationForPeer(principalId, endpointId),
          allowRuntimeNodeEnrollment: config.enrollment.runtimeNodes,
          allowChildControlNodeEnrollment: config.enrollment.childControlNodes,
          allowAccessGatewayEnrollment: config.enrollment.accessGateways,
        }),
      },
      authorizePeerEndpoint: (endpointId) => {
        if (currentPeerEnrollment(endpointId)) return true;
        if (currentDesiredUpstream()?.endpointId === endpointId) return true;
        return config.enrollment.runtimeNodes ||
          config.enrollment.childControlNodes ||
          config.enrollment.accessGateways;
      },
      createContext: (context): ControlNodeRouterContext => {
        const mapped = ingressContext(context);
        const enrollment = currentPeerEnrollment(context.p2p.peer.id);
        return {
          ...mapped,
          ...(enrollment?.role === "access-gateway"
            ? { grantedScopes: actionScopesSchema.parse(enrollment.scopes) }
            : {}),
        };
      },
      iroh: {
        secretKey,
        ...(config.p2pBindAddress === undefined
          ? {}
          : { bindAddress: config.p2pBindAddress }),
        ticketTtlMs: 30 * 24 * 60 * 60_000,
        relay: { mode: "default" },
        allowAdvertisedAddress: () => true,
        allowDirectAddress: () => true,
        allowRelayUrl: () => true,
      },
      onError: (error) => console.error("p2prpc:", error.message),
    });

    currentP2PTicket = await p2pNode.createTicket();
    catalog.setLocalEndpointId(p2pNode.id);
    if (desiredUpstream?.endpointId === p2pNode.id) {
      throw new Error("a control node cannot dial its own p2prpc endpoint as upstream");
    }
    const startupTicket = currentP2PTicket;
    ticketRefresh = setInterval(() => {
      const node = p2pNode;
      if (!node) return;
      void node.createTicket()
        .then((ticket) => { currentP2PTicket = ticket; })
        .catch((error: unknown) => console.error("refreshing p2prpc ticket:", error));
    }, 10 * 60_000);
    ticketRefresh.unref();

    staleSweep = setInterval(() => {
      catalog.markStaleRuntimeNodes(
        new Date(Date.now() - config.runtimeNodeStaleMs),
      );
      catalog.markStaleChildren(
        new Date(Date.now() - config.childControlNodeStaleMs),
      );
      catalog.expireInteractions();
    }, Math.max(
      1_000,
      Math.min(
        30_000,
        Math.floor(Math.min(
          config.runtimeNodeStaleMs,
          config.childControlNodeStaleMs,
        ) / 2),
      ),
    ));
    staleSweep.unref();

    upstreamSupervisor = desiredUpstream === undefined
      ? Promise.resolve()
      : superviseUpstreamControlNode({
          node: p2pNode,
          initialUpstream: desiredUpstream,
          catalog,
          service,
          metadataUpstream,
          heartbeatMs: config.upstreamHeartbeatMs,
          reconnectMaxMs: config.reconnectMaxMs,
          signal: upstreamController.signal,
          onConnected: (parentControlNodeId) =>
            console.log(`Attached to upstream control node ${parentControlNodeId}`),
          onDisconnected: (error, retryMs) =>
            console.error(
              `upstream connection lost; retrying in ${retryMs}ms:`,
              error instanceof Error ? error.message : error,
            ),
        });

    http = createControlNodeHttpSurface(service);
    await listen(http.server, config.port, config.bindAddress);
    const address = http.server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    const local = catalog.localControlNode();
    await options.onReady?.({
      controlNodeId: local.controlNodeId,
      endpointId: p2pNode.id,
      ticket: startupTicket,
      httpUrl: `http://${config.bindAddress}:${port}`,
    });
    console.log(`Agent Multiplex control node ${instanceId}`);
    console.log(`Control node ID: ${local.controlNodeId}`);
    console.log(`Data role:       ${local.dataRole.role}`);
    console.log(`Dashboard:       http://${config.bindAddress}:${port}`);
    console.log(`tRPC:            http://${config.bindAddress}:${port}/trpc`);
    console.log(`P2P endpoint:    ${p2pNode.id}`);
    if (options.printTicket ?? true) {
      console.log(`P2P ticket (reachability locator; not a credential):\n${startupTicket}`);
    }

    await aborted(signal);
  } finally {
    if (staleSweep !== undefined) clearInterval(staleSweep);
    if (ticketRefresh !== undefined) clearInterval(ticketRefresh);
    upstreamController.abort();
    for (const pump of pumps.values()) pump.stop();
    await http?.close().catch((error: unknown) =>
      console.error("closing control-node HTTP:", error));
    await p2pNode?.close().catch((error: unknown) =>
      console.error("closing control-node p2prpc:", error));
    await upstreamSupervisor.catch(() => undefined);
    service.close();
    catalog.close();
  }
}

export async function loadOrCreateControlNodeSecretKey(
  filename: string,
): Promise<Uint8Array> {
  try {
    const encoded = (await readFile(filename, "utf8")).trim();
    const key = Buffer.from(encoded, "base64url");
    if (key.byteLength !== 32) {
      throw new Error(
        `${filename} must contain one base64url-encoded 32-byte Iroh key`,
      );
    }
    await chmod(filename, 0o600);
    return key;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  const key = randomBytes(32);
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${Buffer.from(key).toString("base64url")}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await link(temporary, filename);
    await chmod(filename, 0o600);
    return key;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const encoded = (await readFile(filename, "utf8")).trim();
    const winner = Buffer.from(encoded, "base64url");
    if (winner.byteLength !== 32) {
      throw new Error(`${filename} contains an invalid Iroh key`);
    }
    await chmod(filename, 0o600);
    return winner;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(Reflect.get(error, "code"))
    : undefined;
}

function listen(
  server: import("node:http").Server,
  port: number,
  bindAddress: string,
): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, bindAddress);
  });
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveAbort) => {
    signal.addEventListener("abort", () => resolveAbort(), { once: true });
  });
}

function logError(label: string, error: unknown): void {
  console.error(`${label}:`, error instanceof Error ? error.message : error);
}

async function main(): Promise<void> {
  const controller = new AbortController();
  let shutdownStarted = false;
  const stop = (): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log("Shutting down control node...");
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runControlNode(controlNodeConfigFromEnvironment(), controller.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

const entrypoint = process.argv[1]
  ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href
  : undefined;
if (entrypoint === import.meta.url) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes("--version") || arguments_.includes("-V")) {
    console.log(VERSION);
  } else if (arguments_.includes("--help") || arguments_.includes("-h")) {
    console.log(`Agent Multiplex control node ${VERSION}

Usage: agent-multiplex-control-node [--help | --version]

Configuration is supplied through AGENT_MULTIPLEX_* environment variables.
See https://github.com/arduano/agent-multiplex/blob/main/apps/control-node/README.md`);
  } else {
    await main().catch((error: unknown) => {
      logError("control node failed", error);
      process.exitCode = 1;
    });
  }
}
