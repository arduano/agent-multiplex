import { randomBytes } from "node:crypto";
import { initTRPC } from "@trpc/server";
import {
  createMultiplexNode,
  createSharedSecretSecurity,
  hostBridge,
  pinnedTarget,
} from "../../transport/node/p2prpc.js";
import { assetTransferMetadataSchema } from "../../assets/contracts.js";
import type { createReference } from "./application.js";

/** The disposable demo owns two real authenticated local Iroh endpoints.
 * This is explicit process composition, not a transport factory or native agent. */
export function createReferenceBridge(reference: Awaited<ReturnType<typeof createReference>>) {
  const secret = randomBytes(32),
    pins = new Set<string>();
  let gatewayId = "";
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
  const bridge = hostBridge(reference.host, {
    route: reference.bootstrap.route,
    manifest: reference.host.manifest,
    proof: () => reference.viewer,
    authorizeDelegation(offer, requested) {
      return offer.peer.id === gatewayId &&
        offer.auth.principal.id === gatewayId &&
        requested.viewer.connection === reference.viewer.connection &&
        requested.viewer.principal === reference.viewer.principal
        ? reference.viewer
        : null;
    },
    fileMetadataSchema: { "~standard": assetTransferMetadataSchema["~standard"] },
    onIncomingFile: reference.assets.incoming,
    limits: { maxPeers: 16, setupTimeoutMs: 10000, shutdownTimeoutMs: 10000 },
  });
  const t = initTRPC.create({ isDev: false });
  const router = t.router({ ping: t.procedure.query(() => null) });
  let hostNode: Awaited<ReturnType<typeof createMultiplexNode>> | undefined;
  let gatewayNode: Awaited<ReturnType<typeof createMultiplexNode>> | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTask: Promise<void> | undefined;
  let stopping = false;
  let disconnect: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      stopping = true;
      clearInterval(heartbeat);
      disconnect?.();
      const results = await Promise.allSettled([
        bridge.close(),
        gatewayNode?.close(),
        hostNode?.close(),
      ]);
      await heartbeatTask;
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "Reference transport cleanup failed",
        );
    })());
  return {
    diagnostics: () => bridge.diagnostics(),
    close,
    async open() {
      hostNode = await createMultiplexNode({
        router,
        createContext: () => ({}),
        security: security(),
        iroh,
        onBridge: bridge.accept,
        limits: { connectTimeoutMs: 10000, handshakeTimeoutMs: 10000, shutdownTimeoutMs: 10000 },
      });
      const gateway = await createMultiplexNode({
        router,
        createContext: () => ({}),
        security: security(),
        iroh,
        limits: { connectTimeoutMs: 10000, handshakeTimeoutMs: 10000, shutdownTimeoutMs: 10000 },
      });
      gatewayNode = gateway;
      gatewayId = gatewayNode.id;
      pins.add(hostNode.id);
      pins.add(gatewayNode.id);
      const peer = await gateway.connect<typeof router>(
        pinnedTarget(hostNode.id, {
          kind: "ticket",
          ticket: await hostNode.createTicket(),
        }),
      );
      const registration = reference.gateway.registerHost({
        route: reference.bootstrap.route,
        manifest: reference.host.manifest,
        transport: peer,
      });
      disconnect = registration.disconnect;
      const pulse = async () => {
        try {
          await peer.rpc.ping.query();
          if (!stopping) registration.heartbeat();
        } catch {
          /* Missing transport evidence lets topology become stale. */
        } finally {
          if (!stopping) {
            heartbeat = setTimeout(() => {
              heartbeatTask = pulse();
            }, 10000);
            heartbeat.unref();
          }
        }
      };
      heartbeat = setTimeout(() => {
        heartbeatTask = pulse();
      }, 10000);
      heartbeat.unref();
      return hostNode.id;
    },
  };
}
