import type { Peer, PeerContext, PeerIdentity } from "@arduano/p2prpc-core";
import type { AnyTRPCRouter } from "@trpc/server";
import type { RuntimeNodeRouterContext } from "@arduano/agent-multiplex-runtime-node-core";

import {
  createMultiplexP2PNode,
  type MultiplexP2PNode,
  type MultiplexP2PNodeOptions,
} from "./node.js";
import type { PinnedPeerTarget } from "./target.js";

export type RuntimeNodeInitiatedConnectionOptions<
  TRuntimeNodeRouter extends AnyTRPCRouter,
  TControlNodeRouter extends AnyTRPCRouter,
> = Omit<
  MultiplexP2PNodeOptions<TRuntimeNodeRouter, TControlNodeRouter>,
  "preAuthorizePeer" | "onPeer"
> & {
  /** Trusted control-node identity and separately supplied route locator. */
  readonly controlNode: PinnedPeerTarget;
  readonly onControlNodePeer?: (peer: Peer<TControlNodeRouter>) => void;
};

/**
 * Runtime-node-owned outbound connection. The control-node RPC proxy and
 * runtime-node server use the same authenticated QUIC connection; p2prpc
 * reconnects this outbound runtime when a subsequent operation needs it.
 */
export class RuntimeNodeInitiatedConnection<
  TRuntimeNodeRouter extends AnyTRPCRouter,
  TControlNodeRouter extends AnyTRPCRouter,
> {
  private constructor(
    readonly node: MultiplexP2PNode<TRuntimeNodeRouter, TControlNodeRouter>,
    readonly controlNodeTarget: PinnedPeerTarget,
    private controlNodePeer: Peer<TControlNodeRouter>,
  ) {}

  static async create<
    TRuntimeNodeRouter extends AnyTRPCRouter,
    TControlNodeRouter extends AnyTRPCRouter,
  >(
    options: RuntimeNodeInitiatedConnectionOptions<TRuntimeNodeRouter, TControlNodeRouter>,
  ): Promise<RuntimeNodeInitiatedConnection<TRuntimeNodeRouter, TControlNodeRouter>> {
    const { controlNode, onControlNodePeer, ...nodeOptions } = options;
    const node = await createMultiplexP2PNode<TRuntimeNodeRouter, TControlNodeRouter>({
      ...nodeOptions,
      // A runtime node accepts an inbound/revival connection only from its pinned
      // control-node endpoint. The outbound dial independently repeats this pin.
      preAuthorizePeer: (peer: PeerIdentity) => peer.id === controlNode.endpointId,
      ...(onControlNodePeer ? { onPeer: onControlNodePeer } : {}),
    });
    try {
      const controlNodePeer = await node.connect(controlNode);
      return new RuntimeNodeInitiatedConnection(node, controlNode, controlNodePeer);
    } catch (cause) {
      await node.close().catch(() => undefined);
      throw cause;
    }
  }

  get peer(): Peer<TControlNodeRouter> {
    return this.controlNodePeer;
  }

  get rpc(): Peer<TControlNodeRouter>["rpc"] {
    return this.controlNodePeer.rpc;
  }

  /**
   * Establish a live authenticated epoch now. Existing Peer RPC proxies remain
   * valid across p2prpc's retained outbound-runtime reconnection.
   */
  async reconnect(): Promise<Peer<TControlNodeRouter>> {
    this.controlNodePeer = await this.node.ensureConnected(this.controlNodeTarget);
    return this.controlNodePeer;
  }

  close(): Promise<void> {
    return this.node.close();
  }
}

export function connectRuntimeNodeToControlNode<
  TRuntimeNodeRouter extends AnyTRPCRouter,
  TControlNodeRouter extends AnyTRPCRouter,
>(
  options: RuntimeNodeInitiatedConnectionOptions<TRuntimeNodeRouter, TControlNodeRouter>,
): Promise<RuntimeNodeInitiatedConnection<TRuntimeNodeRouter, TControlNodeRouter>> {
  return RuntimeNodeInitiatedConnection.create(options);
}

/** Context mapper for the runtime node's local reverse-RPC router. */
export function createRuntimeNodeRouterContext(
  context: PeerContext,
): RuntimeNodeRouterContext {
  return { authenticatedPeerId: context.p2p.peer.id };
}
