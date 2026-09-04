# @arduano/agent-multiplex-transport-p2prpc

The node-to-node transport for Agent Multiplex protocol v4. It wraps
`@arduano/p2prpc-core` at an exact qualified version and fixes the protocol
identity to `agent-multiplex` contract `4`. The sibling `../p2prpc` checkout is
used only while developing and qualifying that independently released package.

Runtime nodes initiate one pinned connection to their control node. Both sides
serve a tRPC router: the runtime node calls the composite control node's
`ingress.*` namespace, while the control node calls `RuntimeNodeRouter` over
the reverse side of the same authenticated connection.

Access gateways independently connect as p2prpc clients to one or more control
nodes. They are never node-to-node proxies and have no domain-data authority.
Every target keeps reachability and identity separate: the locator supplies a
route, while the configured endpoint ID pins both Iroh and the shared-secret
principal.

The role authorization policy isolates `access.*`, `ingress.*`, and `link.*`
by enrolled endpoint role and always rejects p2prpc's unused file channel.
Signed-ticket address and relay egress policy remains explicit in `iroh`; the
wrapper never treats a route hint as identity.

Managed terminal RPC and subscriptions use the same endpoint-pinned reverse
routes as structured session traffic. `terminal-view` gates descriptor reads
and attachment; `terminal-control` gates open, lease, input/resize, and
termination. Terminal frames are streamed end to end and are never placed in a
control feed or transport persistence layer.

Every Multiplex node applies `DEFAULT_MULTIPLEX_P2P_LIMITS`. Its bounded
profile admits 256 concurrent streams per peer, with higher principal/global
ceilings and matching queue, callback, and buffer limits. Callers may override
individual limits.

`P2PRuntimeNodeConnection` adapts the reverse runtime-node proxy to the control
node's transport-neutral `RuntimeNodeConnection` port.
`RuntimeNodeEventPump` retries subscriptions from the last event position that
the receiver actually committed; it never advances its cursor merely because
an item arrived from the network. Ingress-created logical connections resolve
the current authenticated `Peer` for every RPC and subscription attempt. This
keeps runtime and child bindings alive across p2prpc session renewal without
weakening their endpoint, authenticated-principal, boot-ID, or attachment
fences.

`childControlNodeConnectionFromPeer` and
`parentControlNodeConnectionFromPeer` adapt the two directions of a tree edge.
Every recursive call resolves the currently committed attachment fence; an old
physical peer cannot keep using a superseded attachment. The transport exposes
no protocol-v2 compatibility aliases.
