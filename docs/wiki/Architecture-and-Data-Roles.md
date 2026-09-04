# Architecture and data roles

Agent Multiplex separates durable authority, native execution, and presentation.
That separation is the architecture: process names and deployment locations are
secondary.

```text
clients
   |
   | HTTP + WebSocket
   v
access gateway                 zero domain authority
   |\
   | +-- p2prpc --> control node in realm B
   |
   +---- p2prpc --> root control node in realm A
                          |
                          +-- child control node
                          |        |
                          |        +-- runtime nodes
                          +-- runtime nodes
                                   |
                            Codex / Copilot
```

## Roles

### Control node

The control node owns the canonical logical-session catalog, flat JSON metadata,
authority epoch, tree attachment state, durable operations, and immutable
control feed. A control is either an authority, an attached branch whose parent
is authority, or an explicitly detached branch. Network loss changes presence,
not role.

Every control node is also the aggregate/proxy for its subtree. A child has one
parent, and cycles, implicit reparenting, and overlapping sibling ownership fail
closed. An attached branch can be force-detached and then promoted only through
explicit audited recovery operations that mint a new realm and authority epoch.

### Runtime node

The runtime owns app servers/SDK clients, native session handles, launch and
archive checkpoints, at-most-once command state, metadata outbox, binding
tombstones, and managed PTYs. It publishes runtime facts but cannot overwrite
authority-owned metadata or catalog state.

A runtime connects to exactly one control. A control outage does not stop an
agent; the runtime reconnects, reconciles inventory, and flushes durable outbox
work after the route returns.

### Access gateway

The gateway is a zero-authority observer and command edge. It persists source
locators, cursors, and health, then builds an in-memory projection from complete
validated snapshots and live streams. It may connect to a root, a branch,
several disjoint branches, or independent realms.

If a selected ancestor covers a configured descendant, the gateway suppresses
the descendant and keeps it warm. Partial overlaps, incompatible authority
fences, immutable identity forks, or a domain identity appearing in disjoint
selected trees become conflicts; priority never decides correctness.

Gateways cannot be chained. Connect each gateway directly to one or more control
nodes; a control node is the supported subtree proxy.

### Harness adapter

An adapter owns one harness and adapter scope. It lists native sessions/models,
starts or resumes native sessions, streams events and interactions, executes
harness-native commands, and reads native history. Model names, planning modes,
approval prompts, and event payloads remain harness-specific.

## Ownership matrix

| Data | Canonical owner | Replicas or observers |
| --- | --- | --- |
| Logical session identity and archive state | Authority control node | Branch controls and gateways |
| Session metadata and key revisions | Authority control node | Branch controls, runtime cache/outbox, gateways |
| Native binding and vendor session ID | Runtime node | Control catalog and gateway projection |
| Native transcript/history | Harness app server or SDK | Returned on demand; not re-stored by Multiplex |
| Launch/archive/command recovery state | Admitting role plus runtime journal | Projected operation receipts |
| Provider checkpoint and secrets | Runtime provider | Never projected |
| Terminal bytes, screen, and lease | Runtime memory | Bounded live viewers only |
| Gateway source locator/cursor | Gateway operational store | No domain authority |

## Consistency model

Metadata is single-authority and eventually replicated. Every proposal carries
the complete realm/control/epoch fence and optional per-key compare-and-set
revisions. Detached or disconnected branches may retain optimistic queued work,
but they do not become authoritative implicitly.

Runtime and child connections carry boot, attachment, lineage, and binding
fences. A reply from a replaced process or edge cannot commit to the current
generation. Native streams use per-session runtime epochs and sequences;
control streams use feed IDs and cursors. Expired replay produces an explicit
reset or native gap rather than fabricated continuity.

## Read and write paths

A normal read uses the gateway's selected projection. A cold archived search may
recurse into children because a pre-attachment archive need not exist in the
parent's hot snapshot. Duplicate results from sibling subtrees are conflicts,
even when their records are identical, because one identity must have one route.

A mutation enters through a client or plugin, is authorized at the gateway and
source grant ceilings, then routes through exactly one selected control path.
Metadata commits at the authority; native commands commit through the runtime
binding owner. A transport failure after dispatch may produce
`outcomeUnknown`—the caller must query the durable operation ID.

For the full overlap and failover rules, read
[the data-role design](../design/data-roles-v4.md).
