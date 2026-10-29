import type { AnyRouter } from "@trpc/server";
import type { Peer, PeerContext, P2PNodeOptions, IrohEndpointOptions } from "@arduano/p2prpc-core";
import type { HostTarget, Viewer } from "../gateway/contracts.js";
import type { HostEndpointOptions } from "../gateway/node-contracts.js";
import type { BridgeHostOptions, NativeBridgeOffer } from "@arduano/p2prpc-core/bridge";
import type { RelayConfiguration } from "./contracts.js";
/** Borrowed actual typed RPC only. It cannot close the physical peer. */
export type BorrowedP2pPeer<Router extends AnyRouter> = Pick<Peer<Router>, "rpc">;
export type DelegatedViewer = Pick<Viewer, "connection" | "principal">;
/** Metadata is a request, not authentication. Derive the returned grants from
 * the verified endpoint and principal in seed.p2p. */
export type P2pHostAuthorizer = (
  seed: PeerContext,
  requested: DelegatedViewer,
  target: HostTarget,
) => Viewer | null | Promise<Viewer | null>;
export type MultiplexNodeOptions<Router extends AnyRouter> = Omit<
  P2PNodeOptions<Router>,
  "protocol" | "iroh"
> & {
  iroh: Omit<IrohEndpointOptions, "relay" | "relayMode" | "relayUrls"> & {
    relay: RelayConfiguration;
  };
};

/** One borrowed native connection capability; physical close is not exposed. */
export type BorrowedBridgePeer = Pick<Peer<AnyRouter>, "openBridge">;
export type BridgeDelegation = Readonly<{ viewer: Viewer; target: HostTarget }>;
export type P2pBridgeAuthorizer = (
  offer: NativeBridgeOffer,
  requested: BridgeDelegation,
) => Viewer | null | Promise<Viewer | null>;
export interface MultiplexBridgeHostOptions<Router extends AnyRouter, Metadata = unknown>
  extends
    HostEndpointOptions,
    Pick<BridgeHostOptions<Router, Metadata>, "onIncomingFile" | "fileMetadataSchema" | "limits"> {
  authorizeDelegation: P2pBridgeAuthorizer;
}
