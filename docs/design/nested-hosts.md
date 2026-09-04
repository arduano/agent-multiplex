# Archived protocol-v2 nested-host design

> Historical reference only. The implementation has since made clean protocol
> breaks. See [`data-roles-v4.md`](data-roles-v4.md) for the active
> control-node/runtime-node/access-gateway model.

Agent Multiplex hosts form a strict, dynamically reconfigurable tree. A host
may own direct workers and child hosts at the same time, but it has at most one
active parent attachment. Observers are not topology members: any number of
Node, TUI, gateway, or service clients may connect without changing presence or
ownership.

```text
browser/mobile -- HTTP/SSE/WS --> edge gateway -- p2prpc observer --> root
                                                                    /    \
                                                        p2prpc child      worker
                                                            /   \
                                                        child           worker
                                                          |
                                                        worker
```

Every parent materializes its child's subtree so `fleet.*` remains a flat,
embeddable API. It also records one immediate-child route for every imported
worker. Commands keep their original command, worker, and session IDs at every
hop; each host journals the same idempotency key before recursively forwarding
the call. Native history is always requested from the leaf harness adapter and
is never reconstructed by an aggregate.

## Identity and fencing

- `hostId` survives every restart and reattachment while the host catalog is
  preserved. Replacing that catalog creates a new host and feed identity.
- `hostBootId` changes on process start and fences an obsolete live process.
- `feedId` belongs to the durable catalog. It survives a normal restart but
  changes when the catalog is replaced.
- `attachmentId` identifies one parent/child enrollment and fences stale calls.
- `lineageId` and the metadata authority epoch preserve ownership across
  disconnects and explicit transfers.

A network disconnect does not detach or promote a child. The parent retains a
stale projection and the child continues controlling its local subtree. The
MVP deliberately has no live-reparent operation: changing parent requires
an explicit operator-controlled detach/reprovision workflow. It is never an
automatic disconnect response. The authority offer/accept/consume records are
destination-bound proof primitives, not an operational subtree migration;
they do not attach a subtree at the destination or move its workspace. Forced
adoption is an audited recovery action because software cannot stop an
unreachable old root from accepting divergent writes.

## Event replication

Control cursors are local to one feed and are never forwarded as if they were
global. A parent atomically applies a child control item, records its global
event ID, assigns a new local cursor, and advances the per-child checkpoint.
This makes replay after a crash idempotent. Native positions remain the native
`(sessionId, runtimeEpoch, sequence)` tuple and gaps recover through the harness
history API. Each control node keeps the latest tuple per session in memory,
discarding duplicate or non-advancing events before retention and broadcast.
When the session runtime epoch changes, its old native ring is discarded; the
replacement epoch starts an independent sequence at zero.

Each subscriber has a bounded mailbox. Slow clients reconnect from the last
committed feed-aware cursor instead of consuming unbounded host memory. A feed
mismatch produces an explicit snapshot reset.

Replacing a child transport connection always establishes a new immutable
snapshot barrier before event replay, including when the durable `feedId` and
checkpoint are unchanged. This restarts control/native streaming without
changing the attachment, lineage, host, worker, or session identities.
If only the aggregate subscription ends, the parent marks the projection stale
but retains the authenticated reverse connection; the next child heartbeat
establishes the same fresh snapshot barrier and restarts the pump.

## Metadata

The current tree root is the only host that increments canonical metadata
revisions or evaluates key-level CAS conditions. Subordinates persist writes as
`queued` operations and expose an optimistic view while forwarding the original
operation and preconditions upward. Terminal `accepted` or `conflicted`
operations and canonical snapshots replicate down the owning route.
The leaf host durably retains terminal delivery until the direct worker accepts
it over the reverse, boot-fenced Worker RPC. A failed delivery is retried when
that worker reconnects or heartbeats, so its transferred optimistic receipt
cannot remain `queued` forever.

Detaching never silently changes the authority. A detached subtree can keep
serving cached canonical metadata and queue writes. Cross-root relocation is
outside the current MVP; do not use the authority proof procedures as a live
migration workflow.

The experimental authority proof exchange is cross-root, not a recursive call
through the old tree. An orchestrator asks the source root to mint and consume
the capability and asks the independent destination root to accept it. The
offer names the destination's persistent p2prpc Ed25519 endpoint. That endpoint
signs every acceptance field, and the source verifies the signature before it
projects the new authority epoch, so an observer cannot manufacture acceptance
for an offer it obtained. The four operator mutations are available on
`fleet.authority.*`; fenced `link.authority.*` calls retain the executing
root's catalog fencing. It currently records and projects proof/epoch state
only; topology relocation and post-move reconnect fencing remain embedding
responsibilities. The standard role policy deliberately grants no child
access to `ingress.authority.*`.

`forceAdopt` is the explicit split-brain recovery path. Its durable audit actor
is always replaced with the authenticated transport principal by the host; an
unauthenticated direct HTTP caller cannot perform this mutation. With the
shared-secret p2prpc profile, the authenticated actor is the observer/parent
endpoint ID (for a browser deployment this is normally the gateway endpoint).

## Transport surfaces

One composite p2prpc router is exposed by every host:

- `fleet.*` is the observer and recursive-control API;
- `ingress.hosts.*` and `ingress.workers.*` receive attached children/workers,
  while `ingress.observers.*` enrolls non-topology clients;
- `link.*` is the parent-to-child snapshot, event, and recursive-routing API.

The downstream metadata settlement procedure is `link.metadata.settle`
(`apply` is reserved by tRPC's callable proxy implementation).

Authorization is based on the authenticated endpoint principal and exact RPC
path. Enrolled observers receive the complete Fleet API, while worker and host
link principals cannot cross into each other's ingress procedures. In
particular, an enrolled child can call `ingress.hosts.*`, never authority
mutations. The current `../p2prpc` transport is Node-only, so browser and mobile
applications use the edge gateway; gateway-to-host communication is still
p2prpc.
