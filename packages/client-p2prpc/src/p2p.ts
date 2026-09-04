import { initTRPC } from "@trpc/server";

import type { CompositeControlNodeRouter } from "@arduano/agent-multiplex-control-node-core";
import type {
  ActionScope,
  ControlNodeDescriptor,
} from "@arduano/agent-multiplex-protocol";
import {
  createMultiplexP2PNode,
  type MultiplexP2PNode,
  type MultiplexP2PNodeOptions,
  type PinnedPeerTarget,
} from "@arduano/agent-multiplex-transport-p2prpc";

import type { AccessClient } from "@arduano/agent-multiplex-client";

type AccessGatewayP2PContext = Record<string, never>;
const gatewayTrpc = initTRPC.context<AccessGatewayP2PContext>().create();

/** Access gateways expose no p2prpc application RPCs. */
export const p2pAccessGatewayRouter = gatewayTrpc.router({});
export type P2PAccessGatewayRouter = typeof p2pAccessGatewayRouter;

type RemoteCompositeRouter = CompositeControlNodeRouter;

export interface P2PControlNodeSourceOptions {
  /** Gateway-local source ID. */
  readonly sourceId: string;
  /** Independently pinned control-node identity and untrusted locator. */
  readonly target: PinnedPeerTarget;
  /**
   * Optional last-resort locator for the same pinned endpoint. This is used
   * when `target` contains a persisted renewal which is no longer reachable;
   * it is never a second identity and is tried only when the transport dial
   * itself fails.
   */
  readonly fallbackLocator?: PinnedPeerTarget["locator"];
  /** Stable audit/display name sent during enrollment. */
  readonly name?: string;
  /** Requested upper bound; the control node may grant fewer scopes. */
  readonly requestedScopes: readonly ActionScope[];
}

export type P2PAccessGatewayNodeOptions = Omit<
  MultiplexP2PNodeOptions<P2PAccessGatewayRouter, RemoteCompositeRouter>,
  "router" | "createContext" | "preAuthorizePeer" | "onPeer" | "onAnyPeer"
> & {
  readonly sources: readonly P2PControlNodeSourceOptions[];
};

export interface ConnectedControlNodeSource {
  readonly sourceId: string;
  readonly target: PinnedPeerTarget;
  readonly access: AccessClient;
  readonly canonical: ControlNodeDescriptor;
  readonly grantedScopes: readonly ActionScope[];
  /** Renewed reachability locator returned by the pinned control node. */
  readonly renewedTicket: string | undefined;
}

export interface P2PControlNodeSourceHandle {
  readonly sourceId: string;
  readonly target: PinnedPeerTarget;
  readonly connected: ConnectedControlNodeSource | undefined;
  /** Enroll or reconnect this source without disturbing sibling sources. */
  connect(): Promise<ConnectedControlNodeSource>;
  reconnect(): Promise<ConnectedControlNodeSource>;
  /** Replace reachability only; the independently pinned endpoint is immutable. */
  acceptRenewedTicket(ticket: string): boolean;
}

export interface P2PAccessGatewayNodeHandle {
  readonly node: MultiplexP2PNode<P2PAccessGatewayRouter, RemoteCompositeRouter>;
  readonly localEndpointId: string;
  readonly sources: ReadonlyMap<string, P2PControlNodeSourceHandle>;
  connectAll(): Promise<ReadonlyMap<string, PromiseSettledResult<ConnectedControlNodeSource>>>;
  close(): Promise<void>;
}

/**
 * Creates one local p2prpc gateway node with N independently pinned
 * control-node peers. A remote gateway can never be admitted as a source:
 * enrollment and the returned protocol-v4 control-node descriptor are both
 * required before its access client becomes usable.
 */
export async function createP2PAccessGatewayNode(
  options: P2PAccessGatewayNodeOptions,
): Promise<P2PAccessGatewayNodeHandle> {
  const { sources: configuredSources, ...nodeOptions } = options;
  if (configuredSources.length === 0) {
    throw new TypeError("an access gateway requires at least one control-node source");
  }
  const sourceIds = new Set<string>();
  const endpointIds = new Set<string>();
  const sources = configuredSources.map((source) => {
    if (!source.sourceId || sourceIds.has(source.sourceId)) {
      throw new TypeError(`duplicate or empty gateway source ID ${source.sourceId}`);
    }
    if (endpointIds.has(source.target.endpointId)) {
      throw new TypeError(`duplicate pinned control-node endpoint ${source.target.endpointId}`);
    }
    sourceIds.add(source.sourceId);
    endpointIds.add(source.target.endpointId);
    return Object.freeze({
      ...source,
      name: source.name ?? `agent-multiplex-gateway:${source.sourceId}`,
      target: snapshotTarget(source.target),
      ...(source.fallbackLocator === undefined
        ? {}
        : { fallbackLocator: snapshotLocator(source.fallbackLocator) }),
      requestedScopes: Object.freeze([...source.requestedScopes]),
    });
  });

  const node = await createMultiplexP2PNode<
    P2PAccessGatewayRouter,
    RemoteCompositeRouter
  >({
    ...nodeOptions,
    router: p2pAccessGatewayRouter,
    createContext: (): AccessGatewayP2PContext => ({}),
    preAuthorizePeer: (peer) => endpointIds.has(peer.id),
  });

  const handles = new Map<string, P2PControlNodeSourceHandle>();
  for (const source of sources) {
    let target = source.target;
    const fallbackTarget = source.fallbackLocator === undefined
      ? undefined
      : snapshotTarget({
          endpointId: source.target.endpointId,
          locator: source.fallbackLocator,
        });
    let connected: ConnectedControlNodeSource | undefined;
    let connecting: Promise<ConnectedControlNodeSource> | undefined;
    const establish = (): Promise<ConnectedControlNodeSource> => {
      connecting ??= (async () => {
        const peer = await connectWithLocatorFallback(
          node,
          target,
          fallbackTarget,
          (successfulTarget) => {
            target = successfulTarget;
          },
        );
        const composite = peer.rpc;
        if (!composite.ingress?.gateways?.enroll || !composite.access) {
          throw new Error("pinned peer is not a protocol-v4 composite control node");
        }
        const enrollment = await composite.ingress.gateways.enroll.mutate({
          name: source.name,
          protocolVersion: 4,
          requestedScopes: [...source.requestedScopes],
        });
        if (!enrollment.accepted) {
          throw new Error("control node rejected access-gateway enrollment");
        }
        if (
          enrollment.canonical.protocolVersion !== 4 ||
          enrollment.canonical.endpointId !== undefined &&
          enrollment.canonical.endpointId !== target.endpointId
        ) {
          throw new Error("control-node enrollment returned an inconsistent pinned identity");
        }
        const description = await composite.access.system.describe.query();
        if (
          description.protocolVersion !== 4 ||
          description.componentKind !== "control-node" ||
          description.dataAuthority !== "control-node"
        ) {
          throw new Error("pinned peer is not a protocol-v4 control-node source");
        }
        if (enrollment.p2pTicket !== undefined) {
          target = withRenewedTicket(target, enrollment.p2pTicket);
        }
        const result: ConnectedControlNodeSource = Object.freeze({
          sourceId: source.sourceId,
          target,
          access: composite.access as unknown as AccessClient,
          canonical: enrollment.canonical,
          grantedScopes: Object.freeze([...enrollment.grantedScopes]),
          renewedTicket: enrollment.p2pTicket,
        });
        connected = result;
        return result;
      })().finally(() => {
        connecting = undefined;
      });
      return connecting!;
    };
    handles.set(source.sourceId, Object.freeze({
      sourceId: source.sourceId,
      get target() { return target; },
      get connected() { return connected; },
      connect: () => connected ? Promise.resolve(connected) : establish(),
      reconnect: () => {
        connected = undefined;
        return establish();
      },
      acceptRenewedTicket: (ticket: string) => {
        const renewed = withRenewedTicket(target, ticket);
        if (
          target.locator.kind === "ticket" &&
          target.locator.ticket === renewed.locator.ticket
        ) return false;
        target = renewed;
        connected = undefined;
        return true;
      },
    }));
  }

  return Object.freeze({
    node,
    localEndpointId: node.id,
    sources: handles,
    connectAll: async () => {
      const entries = await Promise.all(
        [...handles].map(async ([sourceId, source]) => [
          sourceId,
          await settle(source.connect()),
        ] as const),
      );
      return new Map(entries);
    },
    close: () => node.close(),
  });
}

async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function snapshotTarget(target: PinnedPeerTarget): PinnedPeerTarget {
  return Object.freeze({
    endpointId: target.endpointId,
    locator: snapshotLocator(target.locator),
  });
}

function snapshotLocator(
  locator: PinnedPeerTarget["locator"],
): PinnedPeerTarget["locator"] {
  return locator.kind === "ticket"
    ? Object.freeze({ kind: "ticket" as const, ticket: locator.ticket })
    : locator.kind === "mdns"
      ? Object.freeze({
          kind: "mdns" as const,
          ...(locator.serviceName !== undefined
            ? { serviceName: locator.serviceName }
            : {}),
        })
      : Object.freeze({ kind: "dns" as const });
}

async function connectWithLocatorFallback(
  node: MultiplexP2PNode<P2PAccessGatewayRouter, RemoteCompositeRouter>,
  preferred: PinnedPeerTarget,
  fallback: PinnedPeerTarget | undefined,
  onConnected: (target: PinnedPeerTarget) => void,
) {
  try {
    const peer = await node.ensureConnectedAs<RemoteCompositeRouter>(preferred);
    onConnected(preferred);
    return peer;
  } catch (preferredError) {
    if (fallback === undefined || sameLocator(preferred.locator, fallback.locator)) {
      throw preferredError;
    }
    try {
      const peer = await node.ensureConnectedAs<RemoteCompositeRouter>(fallback);
      onConnected(fallback);
      return peer;
    } catch (fallbackError) {
      throw new AggregateError(
        [preferredError, fallbackError],
        `both preferred and bootstrap locators failed for pinned control node ${preferred.endpointId}`,
      );
    }
  }
}

function sameLocator(
  left: PinnedPeerTarget["locator"],
  right: PinnedPeerTarget["locator"],
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "ticket" && right.kind === "ticket") {
    return left.ticket === right.ticket;
  }
  if (left.kind === "mdns" && right.kind === "mdns") {
    return left.serviceName === right.serviceName;
  }
  return true;
}

function withRenewedTicket(
  target: PinnedPeerTarget,
  ticket: string,
): PinnedPeerTarget & { readonly locator: { readonly kind: "ticket"; readonly ticket: string } } {
  if (ticket.length === 0) throw new TypeError("renewed control-node ticket is empty");
  return Object.freeze({
    endpointId: target.endpointId,
    locator: Object.freeze({ kind: "ticket" as const, ticket }),
  });
}
