import {
  createP2PNode,
  p2pRpcContext,
  SESSION_RENEWAL_CONTRACT,
  type ConnectOptions,
} from "@arduano/p2prpc-core";
import type { OperationContext } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { z } from "zod";
import { canonicalJson } from "../../protocol/index.js";
import {
  GatewayError,
  hostTargetSchema,
  type HostPeer,
  type HostTarget,
  type Viewer,
  type GatewayRequests,
} from "../../gateway/contracts.js";
import {
  createBridgeHost,
  relayBridge,
  type BridgeHost,
  type BinaryWebSocket,
} from "@arduano/p2prpc-core/bridge";
import type { HostEndpointPort } from "../../gateway/node-contracts.js";
import { publicTRPCError } from "../../gateway/node.js";
import { relayConfiguration } from "../relay.js";
import { bridgeDelegationSchema, delegationJson, readBridgeDelegation } from "../delegation.js";
export { bridgeDelegationSchema, readBridgeDelegation } from "../delegation.js";
import type {
  DelegatedViewer,
  BridgeDelegation,
  BorrowedBridgePeer,
  MultiplexBridgeHostOptions,
  MultiplexNodeOptions,
  P2pHostAuthorizer,
} from "../node-contracts.js";
export type {
  P2pHostAuthorizer,
  DelegatedViewer,
  BridgeDelegation,
  BorrowedBridgePeer,
  MultiplexBridgeHostOptions,
  P2pBridgeAuthorizer,
} from "../node-contracts.js";

export const p2prpcProtocol = Object.freeze({
  applicationId: "agent-multiplex.reconstruction",
  contractVersion: "2",
});
/** Published transport only. No endpoint factory, insecure security default,
 * private application topology or local sibling source is accepted here. */
export async function createMultiplexNode<R extends AnyRouter>(options: MultiplexNodeOptions<R>) {
  if (SESSION_RENEWAL_CONTRACT !== 1) throw new Error("Unsupported authenticated renewal contract");
  const { iroh, ...node } = options;
  return createP2PNode({
    ...node,
    protocol: p2prpcProtocol,
    iroh: { ...iroh, relay: relayConfiguration(iroh.relay) },
    limits: {
      maxControlFrameBytes: 2097152,
      maxInboundStreams: 128,
      maxGlobalInboundStreams: 1024,
      maxBufferedBytes: 134217728,
      maxPeerBufferedBytes: 33554432,
      maxQueuedOperations: 1024,
      maxPeerQueuedOperations: 128,
      ...node.limits,
    },
  });
}
export function pinnedTarget(
  endpointId: string,
  locator: ConnectOptions["locator"],
): ConnectOptions {
  if (!/^[a-z2-7]{52}$/.test(endpointId)) throw new TypeError("Invalid pinned endpoint");
  return Object.freeze({
    expectedPeerId: endpointId,
    expectedPrincipal: Object.freeze({
      id: endpointId,
      subject: endpointId,
      issuer: null,
      clientId: null,
      tenantId: null,
    }),
    locator: Object.freeze({ ...locator }),
  });
}

const header = "x-multiplex-context";
const metadataSchema = z
  .object({
    viewer: z
      .object({ connection: z.string().min(1).max(256), principal: z.string().min(1).max(256) })
      .strict(),
    target: hostTargetSchema,
  })
  .strict();
const sameRoute = (left: HostTarget["route"], right: HostTarget["route"]) =>
  left.authority === right.authority &&
  left.host === right.host &&
  left.owner === right.owner &&
  left.routeEpoch === right.routeEpoch;
function exactTarget(
  target: HostTarget,
  host: { readonly route: HostTarget["route"]; readonly manifest: HostTarget["expected"] },
): void {
  if (
    !sameRoute(target.route, host.route) ||
    target.expected.contractId !== host.manifest.contractId ||
    target.expected.contractVersion !== host.manifest.contractVersion ||
    target.expected.compositionId !== host.manifest.compositionId
  )
    throw new GatewayError("FENCED");
}
/** A bounded per-operation request, never credentials or a node-wide mutable
 * current viewer. The verified remote endpoint must authorize this delegation. */
export function p2pHostCallContext(viewer: DelegatedViewer, target: HostTarget): OperationContext {
  try {
    const parsed = metadataSchema.parse({
      viewer: { connection: viewer.connection, principal: viewer.principal },
      target,
    });
    const value = canonicalJson(
      {
        viewer: parsed.viewer,
        target: {
          route: parsed.target.route,
          expected: parsed.target.expected,
          ...(parsed.target.session ? { session: parsed.target.session } : {}),
        },
      },
      8192,
    ).json;
    return p2pRpcContext({ [header]: value });
  } catch {
    throw new GatewayError("INVALID");
  }
}

/** Mount the actual Host router. Its own parsers, middleware and originals stay
 * authoritative; transport metadata never replaces the procedure input. */
export function p2pHostBinding<Router extends AnyRouter>(
  host: HostPeer<Router>,
  authorize: P2pHostAuthorizer,
): Pick<MultiplexNodeOptions<Router>, "router" | "createContext"> {
  return {
    router: host.router,
    async createContext(seed) {
      try {
        const raw = seed.p2p.request.headers[header];
        if (!raw || new TextEncoder().encode(raw).byteLength > 8192)
          throw new GatewayError("INVALID");
        let metadata: z.output<typeof metadataSchema>;
        try {
          metadata = metadataSchema.parse(JSON.parse(raw));
        } catch {
          throw new GatewayError("INVALID");
        }
        exactTarget(metadata.target, host);
        const viewer = await authorize(seed, metadata.viewer, metadata.target);
        if (
          !viewer ||
          viewer.connection !== metadata.viewer.connection ||
          viewer.principal !== metadata.viewer.principal ||
          !viewer.hosts.includes(host.route.host) ||
          !viewer.actions.includes(seed.p2p.request.type === "mutation" ? "control" : "read")
        )
          throw new GatewayError("FORBIDDEN");
        return await host.context(viewer, metadata.target);
      } catch (error) {
        throw publicTRPCError(error);
      }
    },
  };
}

export { createSharedSecretSecurity, createOidcSessionSecurity } from "@arduano/p2prpc-core";

/** Expose the actual Host router over the published bridge. Stable application
 * namespaces come from verified delegation, never the logical peer/session ID. */
export function hostBridge<Router extends AnyRouter, Metadata = unknown>(
  host: HostEndpointPort<Router>,
  options: MultiplexBridgeHostOptions<Router, Metadata>,
): BridgeHost {
  const authority = {
    route: { ...options.route },
    manifest: {
      contractId: options.manifest.contractId,
      contractVersion: options.manifest.contractVersion,
      compositionId: options.manifest.compositionId,
    },
  };
  return createBridgeHost<Router, Metadata>({
    router: host.router,
    async authorizeDelegation(offer) {
      let requested: BridgeDelegation;
      try {
        const raw = offer.headers[bridgeHeader];
        if (!raw || new TextEncoder().encode(raw).byteLength > 8192)
          throw new GatewayError("FORBIDDEN");
        requested = bridgeDelegationSchema.parse(JSON.parse(raw));
        exactTarget(requested.target, authority);
      } catch {
        throw new GatewayError("FORBIDDEN");
      }
      const viewer = await options.authorizeDelegation(offer, requested);
      offer.signal.throwIfAborted();
      if (
        !viewer ||
        viewer.connection !== requested.viewer.connection ||
        viewer.principal !== requested.viewer.principal ||
        !viewer.hosts.includes(authority.route.host) ||
        viewer.actions.some((action) => !requested.viewer.actions.includes(action))
      )
        throw new GatewayError("FORBIDDEN");
      const delegation = bridgeDelegationSchema.parse({
        viewer: { ...viewer, hosts: [authority.route.host] },
        target: requested.target,
      });
      canonicalJson(delegationJson(delegation), 8192);
      exactTarget(delegation.target, authority);
      return {
        id: viewer.principal,
        subject: viewer.connection,
        expiresAt: offer.auth.expiresAt,
        scopes: new Set(viewer.actions),
        claims: delegation,
      };
    },
    async createContext(seed) {
      const { viewer, target } = readBridgeDelegation(seed.bridge.principal);
      exactTarget(target, authority);
      const context = await host.context({
        proof: await options.proof(viewer, target),
        expected: target.expected,
        ...(target.session ? { session: target.session } : {}),
      });
      seed.bridge.request.signal.throwIfAborted();
      return Object.assign({}, context, seed);
    },
    authorizeOperation(context) {
      const { viewer, target } = readBridgeDelegation(context.principal);
      exactTarget(target, authority);
      context.signal.throwIfAborted();
      const action = context.action;
      if (action.kind === "bridge") return false;
      return viewer.actions.includes(
        (action.kind === "rpc" && action.type !== "mutation") || action.kind === "file.pull"
          ? "read"
          : "control",
      );
    },
    ...(options.onIncomingFile ? { onIncomingFile: options.onIncomingFile } : {}),
    ...(options.fileMetadataSchema ? { fileMetadataSchema: options.fileMetadataSchema } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  });
}

const bridgeHeader = "x-multiplex-bridge";

/** One WSS admission uses one route lease and the published transparent relay.
 * Releasing a lease requires actual socket/native-channel closure proofs. */
export async function relayHostBridge(
  gateway: GatewayRequests<BorrowedBridgePeer>,
  socket: BinaryWebSocket,
  options: { readonly viewer: Viewer; readonly target: HostTarget; readonly signal?: AbortSignal },
): Promise<void> {
  let proveSocket!: () => void;
  const socketClosed = new Promise<void>((resolve) => {
    proveSocket = resolve;
  });
  const closed = () => proveSocket();
  socket.addEventListener("close", closed);
  if (socket.readyState === 3) proveSocket();
  let lease: ReturnType<typeof gateway.acquire> | undefined;
  let channel: Promise<void> | undefined;
  const transport: BorrowedBridgePeer = {
    async openBridge(input) {
      if (!lease) throw new GatewayError("FENCED");
      const opened = await lease.transport.openBridge(input);
      channel = opened.closed;
      void channel.catch(() => {});
      return opened;
    },
  };
  try {
    lease = gateway.acquire(options.viewer, options.target);
    const delegation = bridgeDelegationSchema.parse({
      viewer: { ...lease.viewer, hosts: [lease.target.route.host] },
      target: lease.target,
    });
    const headers = { [bridgeHeader]: canonicalJson(delegationJson(delegation), 8192).json };
    const signal = options.signal ? AbortSignal.any([options.signal, lease.signal]) : lease.signal;
    await relayBridge(socket, transport, { headers, signal });
  } finally {
    // Even ordinary relay rejection can follow successful cleanup. Conversely,
    // a rejected cleanup proof never permits erasing this route reservation.
    try {
      if (socket.readyState < 2) socket.close(4000, "Host route ended");
      await Promise.all([socketClosed, ...(channel ? [channel] : [])]);
      lease?.release();
    } finally {
      socket.removeEventListener("close", closed);
    }
  }
}
