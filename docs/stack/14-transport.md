# 14 — Published browser bridge and observation recovery

The browser calls `connectBridge<ActualHostRouter>` from the separately published
p2prpc `/browser` entry. Its actual `peer.rpc` and `peer.files` run through one
WSS channel, the Gateway's borrowed native Peer, and the Host's bridge. Gateway
routing does not reconstruct routers, enumerate procedures, translate arguments,
forward a second RPC protocol or maintain a file ledger.

`bridgeHostUrl(baseUrl, target)` produces `/host?target=...` and converts HTTP(S)
to WS(S). Routing metadata remains outside actual procedure input. The application
must authenticate and check Origin before accepting a WebSocket; viewer grants
come from that verified context, never BrowserHello or unsigned browser JSON.

## Gateway and Host composition

`relayHostBridge(gateway, socket, {viewer, target, signal?})` acquires one
`Gateway<BorrowedBridgePeer>` lease. The borrowed capability is exactly
`Pick<Peer<AnyRouter>, "openBridge">`; it cannot close the shared physical Peer.
The adapter invokes published `relayBridge` with bounded delegated metadata.
It releases the lease only after the actual socket and any opened native channel
have fulfilled closure proofs. A failed cleanup remains charged. It creates no
second relay, reconnect loop, native lifetime or mutation queue.

`hostBridge(host, options)` passes the actual router to published
`createBridgeHost`. `options.authorizeDelegation(offer, requested)` must verify
the real authenticated Gateway endpoint/principal and derive the allowed Viewer.
The adapter rechecks exact route/composition, prevents grant widening, narrows
Host access to the selected Host, and caps expiry at the authenticated offer.
Delegation is a maximum8192UTF8-byte strict `{viewer,target}` record; oversized
metadata is refused without truncation.

Verified principal claims retain that record. `readBridgeDelegation(principal)`
is the shared decoder for an authenticated BridgeContext or incoming FileOffer;
it is not an authenticator for arbitrary principal-shaped JSON. Application scope
uses the authorized stable `viewer.connection` and `viewer.principal`, never the
logical bridge peer ID or rotating transport session ID. Context creation combines
the actual Host context with the upstream BridgeContext; the kernel is unchanged.
Queries/subscriptions and file pulls require `read`; mutations and file pushes
require `control`. The Host still checks its own schemas, originals, native runs
and callback policy. The published file owner retains capability/session binding,
bytes, transfer attempts and their cleanup.

## Direct native calls and observations

`p2pHostBinding` still mounts the actual Host router on a native p2prpc node.
`p2pHostCallContext` carries bounded per-operation requested scope separately from
input. Its authorizer derives grants from the verified peer/authentication facts.
Consumers borrow the actual typed `Peer<Router>.rpc`; observing/unsubscribing has
no authority over the physical Peer/Node. The application ALPN contract is2.

`ObservationSupervisor` is the one retained observation reconnect owner. It
releases a failed observation, awaits cleanup and resolves current routes before
opening another observation. History, drafts, native facts and exact originals
remain with their existing owners. It never replays a mutation. Applications
compose official tRPC links directly where HTTP is used, including Gateway
topology; there is no framework HTTP client/link factory.

## Dependency and qualification limits

The new bridge is consumed only through an immutable published artifact and lock
integrity. A temporary development installation can qualify source integration,
but is not qualification of the final dependency pin. No sibling checkout or
`file:` dependency is a runtime input. The optional bridge requires Node22+ or a
modern browser with `Promise.withResolvers`; the published native root has a
separately qualified Node20.3 floor. Standard Yamux owns multiplexing and flow
control; numeric QUIC reset codes and priority scheduling are not emulated.

This amendment's focused tests use scripted routing/authority and the actual
public SDK. Existing direct-binding tests retain one exact effect, schema/type
checks, grant denial, independent quiet observers and borrowed cleanup. The
optional physical test uses public `host.createTicket()` plus pinned connect;
it does not synthesize or resign upstream tickets. It remains explicitly opt-in
and is not executed by source qualification.

The browser/WSS/native-Iroh composed proof belongs to the reference acceptance,
with its exact artifact, limits and cleanup recorded separately. Historical P14
multi-hop, two-viewer/native authenticated-renewal claims remain unresolved until
their named topology gate passes. A source check does not close those claims.
