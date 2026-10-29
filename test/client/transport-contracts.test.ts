import test from "node:test";
import assert from "node:assert/strict";
import type { BorrowedP2pPeer } from "../../src/transport/node-contracts.js";
import type { AnyRouter } from "@trpc/server";
import type { ObservationConnector as TransportConnector } from "../../src/transport/contracts.js";
import type { ObservationConnector as ClientConnector } from "../../src/client/contracts.js";
function capabilities(peer: BorrowedP2pPeer<AnyRouter>, connection: TransportConnector) {
  const sameContract: ClientConnector = connection;
  // @ts-expect-error Observation forwarding borrows no Peer.close authority.
  peer.close();
  // @ts-expect-error A borrowed RPC facet cannot mutate the Peer connection owner.
  void peer.connection;
  return sameContract;
}
void capabilities;
test("the canonical observation port can be supplied without a transport or retained owner", () => {
  const connector: ClientConnector = { connect: () => () => {} };
  const transport: TransportConnector = connector;
  assert.equal(transport, connector);
});
