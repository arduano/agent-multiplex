import {
  createP2PNode,
  type P2PNode,
  type P2PNodeLimits,
  type P2PNodeOptions,
  type Peer,
  type PeerIdentity,
} from "@arduano/p2prpc-core";
import type { AnyTRPCRouter } from "@trpc/server";

import { AGENT_MULTIPLEX_P2P_PROTOCOL } from "./constants.js";
import {
  createMultiplexSharedSecretSecurity,
  type MultiplexSharedSecretOptions,
} from "./security.js";
import {
  pinnedConnectOptions,
  type PinnedPeerTarget,
} from "./target.js";

/**
 * p2prpc's general-purpose defaults intentionally admit only a small number
 * of concurrent RPC streams per peer. An access gateway can legitimately fan
 * out one operation to hundreds of sessions through one access-gateway to
 * control-node link, while a control node simultaneously forwards calls to a
 * child branch. Reserve bounded capacity for that workload at every hop.
 *
 * Callers may override individual values through `limits`; the remaining
 * values continue to come from this profile and p2prpc's own defaults.
 */
export const DEFAULT_MULTIPLEX_P2P_LIMITS = Object.freeze({
  maxInboundStreams: 256,
  maxGlobalInboundStreams: 2_048,
  maxPrincipalInboundStreams: 512,
  maxBufferedBytes: 1_024 * 1024 * 1024,
  maxPeerBufferedBytes: 256 * 1024 * 1024,
  maxPrincipalBufferedBytes: 512 * 1024 * 1024,
  maxQueuedOperations: 4_096,
  maxPeerQueuedOperations: 512,
  maxPrincipalQueuedOperations: 1_024,
  maxCallbacks: 4_096,
  maxPeerCallbacks: 512,
  maxPrincipalCallbacks: 1_024,
} satisfies Partial<P2PNodeLimits>);

export type MultiplexP2PNodeOptions<
  TLocalRouter extends AnyTRPCRouter,
  TRemoteRouter extends AnyTRPCRouter,
> = Omit<
  P2PNodeOptions<TLocalRouter>,
  "protocol" | "security" | "onPeer"
> & {
  readonly sharedSecret: MultiplexSharedSecretOptions;
  /** Best-effort notification; use getPeer() when current state matters. */
  readonly onPeer?: (peer: Peer<TRemoteRouter>) => void;
  /**
   * Best-effort notification for nodes that accept heterogeneous router roles.
   * Callers must acquire a role-specific proxy with getPeerAs()/connectAs()
   * before issuing RPCs; this callback deliberately makes no router claim.
   */
  readonly onAnyPeer?: (peer: Peer<AnyTRPCRouter>) => void;
};

/**
 * An agent-multiplex node with protocol identity and shared-secret security
 * fixed in one place. Each node serves its local router and gets a typed proxy
 * for the router served by the remote endpoint.
 */
export class MultiplexP2PNode<
  TLocalRouter extends AnyTRPCRouter,
  TRemoteRouter extends AnyTRPCRouter,
> {
  private constructor(
    readonly raw: P2PNode<TLocalRouter>,
  ) {}

  static async create<
    TLocalRouter extends AnyTRPCRouter,
    TRemoteRouter extends AnyTRPCRouter,
  >(
    options: MultiplexP2PNodeOptions<TLocalRouter, TRemoteRouter>,
  ): Promise<MultiplexP2PNode<TLocalRouter, TRemoteRouter>> {
    const { sharedSecret, onPeer, onAnyPeer, ...nodeOptions } = options;
    const raw = await createP2PNode({
      ...nodeOptions,
      limits: {
        ...DEFAULT_MULTIPLEX_P2P_LIMITS,
        ...nodeOptions.limits,
      },
      protocol: AGENT_MULTIPLEX_P2P_PROTOCOL,
      security: createMultiplexSharedSecretSecurity(sharedSecret),
      ...(onPeer || onAnyPeer
        ? {
            onPeer: (peer) => {
              onAnyPeer?.(peer);
              onPeer?.(peer as Peer<TRemoteRouter>);
            },
          }
        : {}),
    });
    return new MultiplexP2PNode<TLocalRouter, TRemoteRouter>(raw);
  }

  get id(): string {
    return this.raw.id;
  }

  ticket(): string {
    return this.raw.ticket();
  }

  createTicket(): Promise<string> {
    return this.raw.createTicket();
  }

  connect(target: PinnedPeerTarget): Promise<Peer<TRemoteRouter>> {
    return this.raw.connect<TRemoteRouter>(pinnedConnectOptions(target));
  }

  /**
   * Acquire a peer whose router differs from this node's default remote
   * router. Control nodes use this for heterogeneous runtime-node, child,
   * parent, and access-gateway peers while serving one composite router.
   */
  connectAs<TPeerRouter extends AnyTRPCRouter>(
    target: PinnedPeerTarget,
  ): Promise<Peer<TPeerRouter>> {
    return this.raw.connect<TPeerRouter>(pinnedConnectOptions(target));
  }

  /** Force acquisition for a role-specific remote router. */
  ensureConnectedAs<TPeerRouter extends AnyTRPCRouter>(
    target: PinnedPeerTarget,
  ): Promise<Peer<TPeerRouter>> {
    return this.connectAs<TPeerRouter>(target);
  }

  /** Force acquisition/reconnection now instead of waiting for the next RPC. */
  ensureConnected(target: PinnedPeerTarget): Promise<Peer<TRemoteRouter>> {
    return this.connect(target);
  }

  getPeer(endpointId: string): Peer<TRemoteRouter> | undefined {
    return this.raw.getPeer<TRemoteRouter>(endpointId);
  }

  getPeerAs<TPeerRouter extends AnyTRPCRouter>(
    endpointId: string,
  ): Peer<TPeerRouter> | undefined {
    return this.raw.getPeer<TPeerRouter>(endpointId);
  }

  peersSnapshot(): ReturnType<P2PNode<TLocalRouter>["peersSnapshot"]> {
    return this.raw.peersSnapshot();
  }

  close(): Promise<void> {
    return this.raw.close();
  }
}

export function createMultiplexP2PNode<
  TLocalRouter extends AnyTRPCRouter,
  TRemoteRouter extends AnyTRPCRouter,
>(
  options: MultiplexP2PNodeOptions<TLocalRouter, TRemoteRouter>,
): Promise<MultiplexP2PNode<TLocalRouter, TRemoteRouter>> {
  return MultiplexP2PNode.create(options);
}

export type ControlNodeP2PNodeOptions<
  TControlNodeRouter extends AnyTRPCRouter,
  TRemoteRouter extends AnyTRPCRouter,
> = Omit<
  MultiplexP2PNodeOptions<TControlNodeRouter, TRemoteRouter>,
  "preAuthorizePeer"
> & {
  /**
   * Enrollment/pinning policy for any Iroh endpoint key accepted by a
   * composite control node. It runs before the shared-secret handshake and must not
   * infer trust from a ticket.
   */
  readonly authorizePeerEndpoint?: (
    endpointId: string,
    signal: AbortSignal,
  ) => Promise<boolean> | boolean;
};

/** Create the receiving half of protocol-v4 symmetric role connections. */
export function createControlNodeP2PNode<
  TControlNodeRouter extends AnyTRPCRouter,
  TRemoteRouter extends AnyTRPCRouter,
>(
  options: ControlNodeP2PNodeOptions<TControlNodeRouter, TRemoteRouter>,
): Promise<MultiplexP2PNode<TControlNodeRouter, TRemoteRouter>> {
  const { authorizePeerEndpoint, ...nodeOptions } = options;
  if (!authorizePeerEndpoint) {
    throw new TypeError("authorizePeerEndpoint is required");
  }
  return createMultiplexP2PNode<TControlNodeRouter, TRemoteRouter>({
    ...nodeOptions,
    preAuthorizePeer: (peer: PeerIdentity, signal: AbortSignal) =>
      authorizePeerEndpoint(peer.id, signal),
  });
}
