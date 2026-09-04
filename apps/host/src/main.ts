import { randomBytes, randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  HostCatalog,
  HostService,
  createP2PAuthorityAcceptanceSigner,
  createCompositeHostRouter,
  type CompositeHostIngressContext,
  type CompositeHostRouter,
} from "@agent-multiplex/host-core";
import {
  P2PWorkerConnection,
  ReconnectableMetadataUpstream,
  WorkerEventPump,
  childHostConnectionFromPeer,
  createHostP2PNode,
  createMultiplexRoleAuthorization,
  type MultiplexP2PNode,
} from "@agent-multiplex/transport-p2prpc";
import type { WorkerRouter } from "@agent-multiplex/worker-core";
import type { HostId, WorkerBootId, WorkerId } from "@agent-multiplex/protocol";
import type { AnyTRPCRouter } from "@trpc/server";

import { hostConfigFromEnvironment } from "./config.js";
import { createHostHttpSurface } from "./http.js";
import { superviseParentHost } from "./parent.js";

const config = hostConfigFromEnvironment();
const instanceId = config.instanceId ?? randomUUID();

const hostSecretKey = await loadOrCreateHostSecretKey(config.identityPath);
const authorityAcceptanceSigner = createP2PAuthorityAcceptanceSigner(hostSecretKey);
const catalog = new HostCatalog({
  filename: config.statePath,
  hostName: config.name,
  maxHostDepth: config.maxHostDepth,
});
const pumps = new Map<string, WorkerEventPump>();
const metadataUpstream = new ReconnectableMetadataUpstream();
let currentP2PTicket: string | undefined;
const service = new HostService({
  catalog,
  instanceId,
  metadataUpstream,
  p2pTicket: () => currentP2PTicket,
  authorityAcceptanceSigner,
  onWorkerConnectionAttached: (connection) => {
    if (!(connection instanceof P2PWorkerConnection)) {
      throw new TypeError("host daemon requires a p2prpc worker connection");
    }
    startPump(connection);
  },
});
const compositeRouter = createCompositeHostRouter(service);

let p2pNode:
  | MultiplexP2PNode<CompositeHostRouter, AnyTRPCRouter>
  | undefined;

p2pNode = await createHostP2PNode<CompositeHostRouter, AnyTRPCRouter>({
  router: compositeRouter,
  sharedSecret: {
    secret: config.sharedSecret,
    sessionTtlMs: 60 * 60_000,
    authorize: createMultiplexRoleAuthorization({
      roleForPrincipal: (principalId, endpointId) => {
        if (principalId !== endpointId) return undefined;
        const enrolled = currentPeerEnrollment(endpointId);
        return enrolled?.role === "childHost"
          ? "child-host"
          : enrolled?.role === "parentHost"
            ? "parent-host"
            : enrolled?.role;
      },
      allowWorkerEnrollment: config.enrollment.workers,
      allowChildHostEnrollment: config.enrollment.childHosts,
      allowObserverEnrollment: config.enrollment.observers,
    }),
  },
  authorizePeerEndpoint: (endpointId) => {
    if (currentPeerEnrollment(endpointId)) return true;
    if (config.parent?.endpointId === endpointId) return true;
    // Coarse admission may open for an enrollment aperture, but per-request
    // role authorization still treats stale enrollment rows as unknown and
    // the ingress service fences role/principal reuse before mutation.
    return config.enrollment.workers ||
      config.enrollment.childHosts ||
      config.enrollment.observers;
  },
  iroh: {
    secretKey: hostSecretKey,
    ticketTtlMs: 30 * 24 * 60 * 60_000,
    relay: { mode: "default" },
    allowAdvertisedAddress: () => true,
    allowDirectAddress: () => true,
    allowRelayUrl: () => true,
  },
  createContext: (context): CompositeHostIngressContext => {
    const endpointId = context.p2p.peer.id;
    const enrolled = currentPeerEnrollment(endpointId);
    return {
      endpointId,
      authenticatedActorId: context.p2p.auth.principal.id,
      ...(enrolled?.role === "worker"
        ? { authenticatedWorkerId: enrolled.principalId as WorkerId }
        : {}),
      ...(enrolled?.role === "childHost" || enrolled?.role === "parentHost"
        ? { authenticatedHostId: enrolled.principalId as HostId }
        : {}),
      createWorkerConnection: (workerId: WorkerId, workerBootId: WorkerBootId) => {
        const peer = p2pNode?.getPeerAs<WorkerRouter>(endpointId);
        if (!peer) throw new Error("authenticated worker peer is no longer connected");
        const connection = new P2PWorkerConnection(
          workerId,
          workerBootId,
          endpointId,
          peer,
        );
        return connection;
      },
      createChildHostConnection: (request) => {
        const peer = p2pNode?.getPeerAs<AnyTRPCRouter>(endpointId);
        if (!peer) throw new Error("authenticated child host is no longer connected");
        return childHostConnectionFromPeer(peer, {
          hostId: request.hostId,
          hostBootId: request.hostBootId,
          currentFence: () => {
            const attachment = catalog.getAttachment(request.hostId);
            if (!attachment) throw new Error("child attachment is no longer active");
            return attachment;
          },
        });
      },
    };
  },
  onError: (error) => console.error("p2prpc:", error.message),
});

function currentPeerEnrollment(endpointId: string) {
  const enrolled = catalog.activePeerEnrollment(endpointId);
  if (
    enrolled?.role === "parentHost" &&
    config.parent?.endpointId !== endpointId
  ) {
    return null;
  }
  return enrolled;
}

currentP2PTicket = await p2pNode.createTicket();
if (p2pNode.id !== authorityAcceptanceSigner.endpointId) {
  throw new Error("p2prpc endpoint does not match the authority acceptance signer");
}
catalog.setLocalEndpointId(p2pNode.id);
const startupTicket = currentP2PTicket;
const ticketRefresh = setInterval(() => {
  const node = p2pNode;
  if (!node) return;
  void node
    .createTicket()
    .then((ticket) => {
      currentP2PTicket = ticket;
    })
    .catch((error: unknown) => console.error("refreshing p2prpc ticket:", error));
}, 10 * 60_000);
ticketRefresh.unref();

const staleSweep = setInterval(() => {
  catalog.markStaleWorkers(new Date(Date.now() - config.workerStaleMs));
  catalog.markStaleChildren(new Date(Date.now() - config.childStaleMs));
  catalog.expireInteractions();
}, Math.max(1_000, Math.min(30_000, Math.floor(config.workerStaleMs / 2))));
staleSweep.unref();

const parentController = new AbortController();
const parentSupervisor = config.parent
  ? superviseParentHost({
      node: p2pNode,
      target: config.parent,
      catalog,
      service,
      metadataUpstream,
      heartbeatMs: config.parentHeartbeatMs,
      reconnectMaxMs: config.reconnectMaxMs,
      signal: parentController.signal,
      onConnected: (parentHostId) =>
        console.log(`Attached to parent host ${parentHostId}`),
      onDisconnected: (error, retryMs) =>
        console.error(
          `parent connection lost; retrying in ${retryMs}ms:`,
          error instanceof Error ? error.message : error,
        ),
    })
  : Promise.resolve();

const http = createHostHttpSurface(service);

http.server.listen(config.port, config.bindAddress, () => {
  console.log(`Agent Multiplex host ${instanceId}`);
  console.log(`Host ID:    ${catalog.localHost().hostId}`);
  console.log(`Mode:       ${config.parent ? "subordinate" : "root"}`);
  console.log(`Dashboard:  http://${config.bindAddress}:${config.port}`);
  console.log(`tRPC:       http://${config.bindAddress}:${config.port}/trpc`);
  console.log(`P2P ID:    ${p2pNode?.id}`);
  console.log(`P2P ticket (treat as a locator, not a credential):\n${startupTicket}`);
});

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  clearInterval(staleSweep);
  clearInterval(ticketRefresh);
  parentController.abort();
  for (const pump of pumps.values()) pump.stop();
  await http.close();
  await p2pNode?.close();
  await parentSupervisor.catch(() => undefined);
  service.close();
  catalog.close();
};
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

function startPump(connection: P2PWorkerConnection): void {
  const previous = pumps.get(connection.endpointId);
  const initialCursor = previous?.cursor;
  previous?.stop();
  const pump = new WorkerEventPump({
    connection,
    ...(initialCursor ? { initialCursor } : {}),
    onItem: async (item) =>
      service.publishWorkerEvent(item, {
        authenticatedWorkerId: connection.workerId,
      }).accepted,
    onError: (error) => console.error(`worker ${connection.workerId} event feed:`, error),
  });
  pumps.set(connection.endpointId, pump);
  pump.start();
}

async function loadOrCreateHostSecretKey(filename: string): Promise<Uint8Array> {
  try {
    const encoded = (await readFile(filename, "utf8")).trim();
    const key = Buffer.from(encoded, "base64url");
    if (key.byteLength !== 32) {
      throw new Error(`${filename} must contain one base64url-encoded 32-byte Iroh key`);
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
    // Concurrent first starts converge on the first key that reached disk.
    if (errorCode(error) !== "EEXIST") throw error;
    const encoded = (await readFile(filename, "utf8")).trim();
    const winner = Buffer.from(encoded, "base64url");
    if (winner.byteLength !== 32) throw new Error(`${filename} contains an invalid Iroh key`);
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
