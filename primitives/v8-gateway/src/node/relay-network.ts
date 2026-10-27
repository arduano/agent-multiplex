import "node:module";
import { createP2PNode, verifyPinnedSignedTicket, type ConnectOptions, type P2PNode, type P2PNodeOptions, type Peer, type SignedTicket } from "@arduano/p2prpc-core";
import type { AnyRouter } from "@trpc/server";
import { GatewayError } from "../contracts/types.js";
import type { RelayPath } from "./relay-config.js";
export { createP2PNode, createSharedSecretSecurity } from '@arduano/p2prpc-core';

/** Server-side reachability only. Trust pins come from the caller's independent
 * configuration, never from a discovery ticket or a relay's authentication. */
export type RelayRoute = Readonly<{ id: string; relayUrl: string; locator: Readonly<{ kind: "ticket"; ticket: string }> }>;
export type RelayPeer = Pick<ConnectOptions, "expectedPeerId" | "expectedPrincipal">;
export type RelayNetworkOptions<Router extends AnyRouter, Metadata = unknown> = Readonly<{
  paths: readonly RelayPath[];
  /** Every path serves this same router/context/security owner. */
  node: Omit<P2PNodeOptions<Router, Metadata>, "iroh" | "endpointFactory">;
}>;

function failure(): never { throw new GatewayError("FENCED"); }
/** The local authenticated endpoint supplies its own protocol encoding. Remote
 * hints cannot select it; the published codec verifies even this own ticket. */
function ownTicket(node: Pick<P2PNode<AnyRouter>, 'id' | 'ticket'>, ticket = node.ticket()): SignedTicket {
  try {
    if (typeof ticket !== "string" || ticket.length > 16384) return failure();
    const body = ticket.split(".")[1]; if (!body) return failure();
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { protocol?: unknown };
    if (typeof value.protocol !== "string") return failure();
    return verifyPinnedSignedTicket(ticket, { expectedPeerId: node.id, expectedProtocol: value.protocol });
  } catch { return failure(); }
}

/** One independently owned transport endpoint per relay, all attached to one
 * existing application owner. No agent, catalog, native lifetime, retry queue
 * or failover scheduler is created. Explicit creation is the only activation.
 * The injected factory is a trusted testing/adapter seam; production uses the
 * exact published node constructor with its TLS and authentication unchanged. */
export async function openRelayNetwork<Router extends AnyRouter, Metadata = unknown>(
  options: RelayNetworkOptions<Router, Metadata>, factory: typeof createP2PNode = createP2PNode,
) {
  if (!Array.isArray(options.paths) || !options.paths.length || options.paths.length > 16 ||
      Object.hasOwn(options.node, "iroh") || Object.hasOwn(options.node, "endpointFactory")) throw new GatewayError("INVALID");
  const paths = [...options.paths], ids = new Set<string>(), origins = new Set<string>();
  // Validate the entire selection before allocating any endpoint. Normalized
  // private paths have no credential fields to publish or enumerate here.
  for (const path of paths) {
    if (!path || !Object.isFrozen(path) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(path.id) ||
        typeof path.endpointOptions !== "function" || ids.has(path.id) || origins.has(path.relayUrl)) throw new GatewayError("INVALID");
    let url: URL; try { url = new URL(path.relayUrl); } catch { throw new GatewayError("INVALID"); }
    if (url.protocol !== "https:" || url.origin !== path.relayUrl || url.username || url.password) throw new GatewayError("INVALID");
    ids.add(path.id); origins.add(path.relayUrl);
  }
  const common = { ...options.node, protocol: Object.freeze({ ...options.node.protocol }) };
  type Entry = { path: RelayPath; node: P2PNode<Router, Metadata>; protocol: string; closing?: Promise<void> };
  const entries = new Map<string, Entry>();
  let closed = false;
  const entry = (id: string) => { const value = entries.get(id); if (closed || !value || value.closing) throw new GatewayError("CLOSED"); return value; };
  const closeEntry = (value: Entry) => value.closing ??= Promise.resolve().then(() => value.node.close());
  const closeAll = async () => {
    closed = true;
    const results = await Promise.allSettled([...entries.values()].map(closeEntry));
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Relay endpoint cleanup did not settle");
  };
  try {
    for (const path of paths) {
      const node = await factory<Router, Metadata>({ ...common, iroh: path.endpointOptions() });
      // Retain custody before any ticket/identity validation can fail.
      const value: Entry = { path, node, protocol: "" }; entries.set(path.id, value);
      value.protocol = ownTicket(node).protocol;
      if ([...entries.values()].some(other => other !== value && (other.node.id === node.id || other.protocol !== value.protocol))) failure();
    }
  } catch (error) {
    try { await closeAll(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Relay network startup and cleanup failed"); }
    throw new GatewayError("UNAVAILABLE");
  }
  return Object.freeze({
    path(id: string) {
      const value = entry(id);
      return Object.freeze({ id: value.path.id, relayUrl: value.path.relayUrl, node: value.node,
        async route(): Promise<RelayRoute> {
          entry(id); const ticket = await value.node.createTicket(); entry(id);
          const decoded = ownTicket(value.node, ticket);
          if (decoded.protocol !== value.protocol || decoded.directAddresses.length) failure();
          if (decoded.relayUrl === null) throw new GatewayError("UNAVAILABLE");
          if (new URL(decoded.relayUrl).origin !== value.path.relayUrl) failure();
          return Object.freeze({ id, relayUrl: value.path.relayUrl, locator: Object.freeze({ kind: "ticket" as const, ticket }) });
        },
      });
    },
    async connect<Remote extends AnyRouter>(id: string, route: RelayRoute, expected: RelayPeer): Promise<Peer<Remote, Metadata>> {
      const value = entry(id);
      if (!route || route.relayUrl !== value.path.relayUrl || route.locator?.kind !== "ticket" || !expected?.expectedPeerId || !expected.expectedPrincipal) failure();
      let decoded: SignedTicket;
      try { decoded = verifyPinnedSignedTicket(route.locator.ticket, { expectedPeerId: expected.expectedPeerId, expectedProtocol: value.protocol }); }
      catch { return failure(); }
      if (decoded.directAddresses.length || !decoded.relayUrl || new URL(decoded.relayUrl).origin !== value.path.relayUrl) failure();
      const peer = await value.node.connect<Remote>({ locator: { ...route.locator }, expectedPeerId: expected.expectedPeerId, expectedPrincipal: { ...expected.expectedPrincipal } });
      entry(id); return peer;
    },
    closePath(id: string): Promise<void> { const value = entries.get(id); if (!value) return Promise.reject(new GatewayError("INVALID")); return closeEntry(value); },
    close: closeAll,
  });
}
export type RelayNetwork<Router extends AnyRouter, Metadata = unknown> = Awaited<ReturnType<typeof openRelayNetwork<Router, Metadata>>>;
