# Agent Multiplex protocol v5 data roles

Protocol v5 separates data authority, execution, aggregation, and presentation.
The distinction is an invariant, not merely naming.

## Roles

### Control node

A control node owns the durable catalog for its local runtime nodes and any
attached child control-node projections. Its current `dataRole` is one of:

- `authority`: the one metadata authority for a realm and authority epoch;
- `branch/attached`: a subtree whose metadata authority is an ancestor;
- `branch/detached`: a deliberately detached subtree which retains its old
  authority fence and remains non-authoritative.

Network failure changes presence and reachability only. It never changes
`dataRole`, detaches a branch, or mints authority.

A detached branch becomes authoritative only through `authority.promote`.
Promotion is a local database transaction which mints a fresh realm ID and a
fresh authority epoch ID. Neither identifier is supplied by the caller.

The current MVP deliberately fails closed on the online `topology.detach` mutation.
A correct graceful detach requires a durable prepare/drain/commit handshake
across the child feed and the independently transported metadata outbox; a
single parent-side transaction cannot provide that guarantee. The supported
escape hatch is a branch-local `topology.forceDetach` carrying an operator
audit and explicit acknowledgement of unknown metadata outcomes, followed by
an equally explicit promotion. Transport loss never invokes either action.

### Runtime node

A runtime node owns native agent processes and app-server state. It advertises
statically composed launch profiles, accepts durable launch requests, resumes
and stops bindings, interacts with harness sessions, and streams native events.
It does not decide canonical metadata. Session history remains owned and read by
the native Codex or Copilot app server; Agent Multiplex never parses history
files. It is also the sole owner of any managed PTY and its bounded in-memory
terminal broker.

### Access gateway

An access gateway has `dataAuthority: none`. It is a p2prpc client of one or
more control nodes and exposes the selected projection over HTTP/WebSocket. It
may propose metadata mutations and route agent controls, but it never commits
domain state.

A configured gateway connection is a `source`. Only control nodes can be
sources. There is no gateway-to-gateway upstream mode and no generic p2prpc
proxy role.

Every control node is already the supported aggregate/proxy boundary: it
serves one validated projection for its complete subtree and recursively routes
commands to the owning runtime. A gateway may therefore connect to an
authority root, an attached branch, several disjoint branches or realms, or a
redundant mix of an ancestor and its descendants. In the redundant case the
ancestor is selected and descendants stay synchronized as warm standbys.
Keeping zero-authority gateways out of the source graph preserves a tree-shaped
authority proof and avoids a second, federated manifest protocol.

## Topology

```text
browser / TUI / mobile
          |
     HTTP / WebSocket
          |
    access gateway (zero authority)
       /      |       \
   p2prpc   p2prpc   p2prpc
     |         |        |
 control    control   control
 authority  branch    authority
     |
   p2prpc
     |
 runtime nodes -> Codex/Copilot app servers
```

Control nodes form a tree. Each attached branch has exactly one desired parent.
An access gateway may connect to arbitrary control nodes from one or more trees.

Every attachment request carries the child's durable current role and exact
control-node coverage. The authenticated parent accepts a fresh attachment from
a self-owned authority or an explicitly detached branch, accepts an attached
branch only as an exact replay of its existing attachment receipt, and rejects
any overlap with another part of its tree. Exact reconnects may change the
child's boot ID, but every
overlapping control-node identity must already be projected through that same
immediate child. The child independently rejects a returned receipt if its
proposed parent or authority owner is already inside the child's subtree.

These checks prevent implicit reparenting and practical ancestor/descendant
cycles before either catalog mutates. The subtree proof is an authenticated
claim by the child inside the internal p2prpc trust domain; mutually malicious
or simultaneously attaching peers would require a multi-party reservation
protocol, which is outside the current single-writer MVP.

## Launch extension roles

Launch extensions are trusted modules inside a gateway or runtime process. They
are not additional network nodes or data authorities.

| Extension role | Owns | Must not own |
| --- | --- | --- |
| Gateway plugin | A bespoke request/router shape, caller-facing validation, and construction of a core launch request | Metadata commits, native bindings, topology, or a hidden scheduler in protocol core |
| Runtime launch provider | Domain input validation, provisioning, provider-private recovery checkpoints, compensation, resume preparation, and session-exclusive resource release | Harness-native session behavior or canonical metadata |
| Runtime agent backend | One opaque native execution target around an adapter, plus optional per-session native cleanup | Domain launch forms or canonical catalog state |
| Harness adapter | Codex/Copilot-native inventory, model discovery, start/resume, commands, interactions, events, and native history | Parsing another harness into a false common history model |

The caller selects an exact `runtimeNodeId`, launch profile, harness, logical
`sessionId`, and retry-stable `launchId`. Protocol core does not place work or
choose a profile. A launch profile is fenced by
`providerId + profileId + contractVersion + requestSchemaHash`; its descriptor
also reports implementation version, supported harnesses, availability, and
capabilities. The opaque JSON `input` is interpreted only by the matching
gateway plugin and runtime provider. Credentials are process configuration and
must never be carried in that input.

Gateway plugins receive the deliberately restricted `GatewayLaunchPort`, which
can discover runtimes/profiles/models and create or inspect launches and
sessions. It exposes no metadata mutation, agent command, terminal, source,
topology, or authority methods. This is an API-discipline boundary, not a
sandbox: a statically imported TypeScript module is trusted with the gateway
process. Dynamic package installation and remotely supplied plugin code are
outside protocol v5.

Runtime providers and backends are also registered statically at process
startup. The runtime independently validates every input even when a gateway
plugin already validated it. Registration recomputes the SHA-256 hash of the
provider's canonical JSON Schema and rejects descriptor/hash mismatches,
duplicate profiles, duplicate backend IDs, and duplicate native adapter scopes.
A provider selects one registered backend and returns harness-native spawn
options; immutable launch provenance later routes resume, native history, stop,
and archive cleanup through the same provider/backend identities.

See [`launch-extensions-v4.md`](launch-extensions-v4.md) for the operation
state machines and a concrete PR-review/container composition.

## Session catalog lifecycle

Protocol v5 deliberately separates catalog visibility from transient native
status. The stable user-facing state is derived as follows:

| State | Durable representation | Default visibility | Allowed next actions |
| --- | --- | --- | --- |
| `running` | `catalogState=open` and `availability=active` | Hot snapshots, streams, and default search | Native commands, stop, terminal operations when supported |
| `stopped` | `catalogState=open` and non-active availability | Hot snapshots, streams, and default search | Resume, metadata changes, native history, archive when the runtime confirms `runtimeStatus=stopped` |
| `archived` | `catalogState=archived`, an archive timestamp, and a higher catalog revision | Cold lookup/search only | Stored metadata remains searchable; native history, resume, and control require a future explicit restore design |

“Running” means an open binding currently owned by the runtime; the finer
harness status can still be `idle`, `running`, `waitingForInput`, `error`, or
`unknown`. Likewise, an unreachable open binding is displayed in the stopped
bucket so it remains discoverable, but archive admission is intentionally
stricter: the binding must be non-active and explicitly
`runtimeStatus=stopped`.

Stopping preserves the logical session, native binding, launch provenance, and
provider resources needed for resume. It immediately persists a resumable
runtime record and retires pending interactions. Archiving is a separate,
explicit asynchronous operation; it is never inferred from age, disconnect, or
native inventory absence.

Archived sessions are omitted from hot access/subtree snapshots so lists do not
grow without bound. `sessions.search` is the cold path. It is bounded to 500
rows per page, ordered by last activity then session ID, and supports state,
runtime, harness, provider, profile, activity-window, and metadata filters.
Metadata predicates use AND semantics and support namespaced-key existence or
canonical structural-JSON equality, including `null`. Search cursors are bound
to the exact query and authority epoch; gateway cursors are additionally bound
to the selected source/feed set. Attached controls recursively search child
catalogs so an archive created before attachment remains discoverable without
putting cold rows back into every hot snapshot.

An archive is published as successful only after all of these steps complete:

1. The native backend performs its idempotent per-session release.
2. The launch provider performs its idempotent session-resource release.
3. The runtime atomically writes a native-binding tombstone, removes the live
   binding, and marks the durable archive journal successful.
4. The metadata authority records that success and atomically changes the
   canonical session to `archived` with a new catalog revision.

The backend runs first because the provider may own the container, worktree, or
other substrate required to reach it. A known cleanup failure leaves the
canonical session stopped. An ambiguous effect becomes `outcomeUnknown`; core
does not pretend rollback or blindly repeat it. The runtime tombstone survives
restart and prevents later app-server inventory from resurrecting the released
native binding. Archiving one session never closes a shared app server; process
shutdown remains a separate backend lifecycle.

## Runtime images

Image bytes belong to the runtime that owns the session binding. Controls route
bounded transfers and journal native payload descriptors; gateways retain no
durable image store. Read/path resolution uses `read`, uploads use
`agent-control`, and archive releases retained images. The full byte, path,
retention, and migration rules live in [the image design](images-v5.md).

## Ephemeral terminal side channel

`terminal.side-channel.v1` is a routed operational channel, not a new data
role. A gateway resolves the selected source for the owning session, each
control node resolves exactly one child/runtime next hop, and the runtime
starts or attaches to its own managed PTY. Every operation carries the
session/runtime/binding fence; runtime boot replacement, binding replacement,
or a route-selection change closes stale subscriptions. Gateways and control
nodes neither emulate a terminal nor adopt external CLI processes.

Several observers may attach to one terminal. One renewable runtime-issued
lease authorizes keyboard input and resize; lease takeover is explicit. Lease
acquisition is retry-idempotent by request ID, input is deduplicated by sequence,
and termination/restart operations use terminal-identity compare-and-set where
the backend supports them. These mechanisms limit ambiguous retries without
turning ephemeral terminal actions into durable domain commands.

Terminal output frames contain opaque bytes. Keyboard write frames contain
independently valid UTF-8 text; clients must not split a code point across RPC
frames, and runtimes reject malformed UTF-8 rather than silently substituting
characters.

The runtime retains only a bounded raw output/resize timeline and an in-memory
synthesized screen. A fresh viewer reconstructs exact terminal state from the
raw opening-state timeline while it remains complete. If that timeline has
expired or output was dropped before broker attachment, the runtime marks its
serialized screen reset as synthesized. Exact replay has explicit start/end
barriers; clients commit no intermediate cursor and restart the replay after
disconnect or bounded-queue overflow. ANSI
serialization is a best-effort visual recovery, not an exact cursor/mode
checkpoint. Every descriptor-bearing stream frame binds its descriptor to the
cursor's terminal identity and, except for the opening replay barrier, its exact
sequence. Terminal bytes, screens, cursors, subscriber buffers, and lease
credentials never enter any role's SQLite store, the control feed, source
manifest/snapshot, metadata, normalized native events, chat history, or
`readNativeHistory`. Restart therefore destroys terminal replay and leases.
Durable conversation recovery still calls the owning harness app server.

Codex uses one runtime-local app server on a private Unix socket. Its structured
adapter connects directly to that socket; a managed stock TUI connects to the
same session with `codex resume --remote`. Copilot has no supported
equivalent attach command. Its stock TUI backend is an explicitly opt-in
experimental integration: CLI `1.0.81`, hidden `--ui-server`,
`--no-auto-update`, and a random loopback-only listener. The TUI owns the
Copilot runtime while the structured adapter is a sibling SDK client. Current
UI-server builds cannot authenticate that SDK connection with
`COPILOT_CONNECTION_TOKEN`, so the port must never be published and the
runtime's OS/container boundary is part of the experiment's trust boundary.
Probe failure falls back to structured Copilot with no terminal capability.

Copilot permission policy remains native session state. `setPermissionMode` travels
through the ordinary fenced command journal under `agent-control`; the adapter
calls the pinned native permission API and projects only acknowledged state in
`harnessSettings.copilotPermissions`. Its setter selects native `manual` or `allow-all`;
native `assisted` can be observed but is not an offered setter. It is independent of
the interactive/plan/autopilot mode. Reads on attachment/resume never mutate
permissions, and newer root permission events fence delayed read/mutation
snapshots. Missing, malformed or unsupported state does not imply off or on.

Native permission requests/completions carry the exact pending request ID. An
external native completion retires only that matching interaction, fenced by
the current runtime binding and child provenance. A local resolution already
in flight may finish through its existing acknowledgement rather than being
misreported as an external retirement. A policy toggle never fabricates an
approval response for pending tools, questions, elicitation or plan transitions.
Native refusal remains a definite failure; a dispatched mutation without a
recognized acknowledgement is outcome unknown. Native organization policy and
already-dispatched work remain outside the toggle's authority.

## Source selection

Each source publishes a manifest with:

- the complete authority fence (`realmId`, authority `controlNodeId`, `epochId`);
- its projection root;
- the exact set of covered control-node IDs;
- its feed ID and snapshot barrier cursor.

The serving control node must be that projection root, and its descriptor's
boot and feed IDs must exactly match the manifest. This prevents a valid tree
snapshot from being relabelled with another node's transport or replay fences.

The gateway validates a complete snapshot before making a source eligible.
Selection is deterministic:

1. A strict coverage superset suppresses its descendant projection.
2. Equal coverage uses configured priority, then stable control-node/source ID.
3. Disjoint sibling projections and independent realms coexist.
4. Partial overlap without a subset relation is quarantined.
5. Different authority epochs in one realm are quarantined.
6. Overlapping identities claiming different realms are quarantined.
7. Overlapping snapshots are checked for immutable identity forks, divergent
   metadata at the same canonical revision, and conflicting settled operation
   receipts.
8. Domain identities repeated across otherwise disjoint subtrees are
   quarantined instead of being merged into one apparent record.

Suppressed sources remain synchronized as warm standbys. A source disconnect
only marks it unavailable. A compatible warm standby can then become selected;
this rotates the gateway's synthetic feed and emits `sourceSelectionChanged`.
Compatibility deliberately permits monotonic replication lag: presence,
liveness, runtime generations, and different canonical metadata revisions need
not be byte-identical. Equal revisions and durable bindings must be identical.
When a selected source disconnects, every overlapping candidate is checked
again against its last accepted snapshot before it can take over. This closes
the window where a suppressed live feed could fork after its initial snapshot.

The synthetic feed keeps a bounded, in-memory native-event journal. A client
reconnect on the same feed replays events after each requested
`(sessionId, runtimeEpoch, sequence)` position. Runtime-epoch replacement starts
an independent sequence, while expired positions produce `nativeGap` with
`readNativeHistory` recovery. Source-selection rotation clears both native
positions and retained events. Session selection and `includeNative` are
applied before the bounded subscriber mailbox, so an observer of one session is
not backpressured by unrelated agent output. This journal is delivery state,
not authoritative history; the harness app server remains the history owner.

The maintained gateway and trusted-local control HTTP/WebSocket surfaces cap
each complete HTTP request body, complete inbound WebSocket message, and
socket's queued WebSocket egress at 8 MiB. An inbound peer or outbound response
which crosses its bound is rejected or terminates only that connection; data is
not silently dropped or retained in another unbounded application queue.
Cursor-aware subscriptions reconnect and recover through the ordinary
replay/gap rules. Bespoke HTTP edges must provide equivalent byte-bounded
policies around both their tRPC HTTP and WebSocket adapters.

## Mutation routing

The gateway builds ownership indexes from selected, validated snapshots. A
mutation resolves to exactly one source and is dispatched once. It is never
broadcast. If the connection fails after dispatch and no definitive response is
known, the gateway returns `OUTCOME_UNKNOWN` with the command/operation identity
and does not automatically retry.

Command-to-source ownership is only a cache within one gateway feed. A source
selection change clears it, so later read-only command recovery follows the new
selected projection (including an ancestor-to-descendant warm failover) instead
of contacting the old unavailable source.
The cache is bounded; evicted identities use the same conflict-checked,
read-only lookup across selected disjoint sources.

Read-only identity recovery may query multiple disjoint selected sources. If
more than one returns a different record for the same identity, the gateway
fails closed with a conflict.

Metadata proposals always carry `expectedAuthority`. The authority fence is
checked at the gateway and again by the committing control node.

Final metadata-operation receipts travel back down the authenticated parent
links to the runtime that owns the session. (Here, final/settled is a command
state and is unrelated to the ephemeral PTY.) An attached branch may first
observe a settled receipt when the proposal entered through an ancestor
gateway; in that case it journals the receipt and the next-hop delivery intent
in one transaction. `originControlNodeId` remains attribution, not
authorization: the active parent-link fence, session authority fence, and
immutable operation identity authorize the delivery. Every hop applies
canonical snapshots monotonically—higher revisions advance, equal revisions
must be identical, and older out-of-order receipts are retained and forwarded
without regressing the session or emitting a false metadata change.

## Persistence boundaries

Control-node SQLite stores contain domain state. A canonical singleton role
record is the source of truth; descriptors are projections of that record.
Role transitions are append-only audit records. Metadata compare-and-set,
operation settlement, control event creation, and delivery intent are one
transaction.

Runtime-node SQLite stores contain local bindings, launch/archive/command
journals, provider-private checkpoints, archived-binding tombstones, and
metadata outboxes. Managed PTYs, replay buffers, and keyboard leases are
explicitly excluded.

Private SQLite state uses POSIX directory mode 0700 and regular files at 0600.
On Windows, where those mode bits cannot represent privacy, a protected
inheritable directory DACL and regular-file DACLs must admit only the current
user, SYSTEM, and Administrators. New directories receive that DACL at creation;
existing directories/files with broader access fail closed without repair.
The installed Windows PowerShell/.NET ACL API is the platform implementation;
validation neither changes execution policy nor exposes native subprocess
diagnostics. Embeddings establish private directories before writing identity
files. SQLite's OS writer lock remains authoritative on both platforms, with
no change to released migrations or role ownership.

Runtime shutdown closes admission before draining all previously admitted
native/provider operations, including commands, history, inventory, and
interaction responses. Dependencies stay open until that work settles. It
then attempts terminal, session-handle, backend, and provider cleanup, waits
for every attempt, and reports aggregate failures. Repeated close calls share
the same completion; the embedding process closes SQLite afterward in
`finally`. No new shutdown timeout or forced-cancellation policy is implied.

The Codex RPC client separately gates ordinary requests on its complete
initialization handshake. Closure fences unfinished preparation, retires the
connection, and settles every pending request. Dispatched requests without a
definitive response retain unknown-outcome semantics. Failed initialization
cleans up its connection before a new startup attempt.

Gateway SQLite stores contain operational data only: source configuration,
pinned locators, renewed tickets, independent upstream cursors, and health.
They never contain an authoritative domain projection.

A signed p2prpc ticket is a locator, not a discovery service. A control node
which must remain reachable through a previously issued ticket after process
restart therefore binds Iroh to a stable UDP address/port (or is provisioned
with another supported discovery mechanism). The endpoint secret preserves
identity; the stable listener preserves the ticket's direct route.

All stores use distinct SQLite application IDs, WAL, full synchronization,
foreign keys, integrity checks, strict tables, an exclusive lifetime writer
lock, checkpoint/backup APIs, and immutable migration ledgers. Control and
runtime stores retain their released v3/v4 ledger entries and append v5
migrations for image storage and bounded native payload envelopes. Incompatible
legacy payloads cause an atomic migration refusal; immutable receipts are never
truncated or silently rewritten. See [images](images-v5.md). The
gateway operational schema remains at its unchanged v3 migration target; schema
version is per store, not a claim about wire compatibility. Foreign,
unversioned, future, corrupt, or rewritten migration histories fail closed.

## Trust boundaries

p2prpc peers are pinned and role-authorized. Terminal routes use the same
authenticated, endpoint-pinned tree links as structured operations; no native
app-server or PTY listener is exposed across machines. Gateway HTTP/WS is
either bound to an explicit loopback address without authentication, or
requires bearer authentication. Bearer credentials grant action scopes (`read`,
`agent-launch`, `agent-archive`, `agent-control`, `terminal-view`,
`terminal-control`, `metadata-propose`, `topology-admin`, `authority-admin`);
they never grant data authority.
`terminal-view` permits lookup/attachment only. `terminal-control` also permits
open, lease management, input, resize, and supported termination, and implies
terminal viewing but not general fleet `read`. Terminal output is opaque and
unredacted; control has the native TUI's runtime-account authority. Both the
gateway's enrolled source grant and the caller credential must permit an
action. Gateway
transports accept tokens only in HTTP `Authorization` and WebSocket connection
parameters, never in request URLs or query strings. For explicitly
local/personal prototypes, the web client can
read a bookmarkable `#token=...` fragment and move that value into those two
authenticated transport channels. The browser does not send fragments to the
gateway, but the credential remains exposed to browser history, the address
bar, extensions, screenshots, and anyone receiving the link; production and
shared deployments should not use this convenience bootstrap.

### Static external authentication composition

A bespoke gateway may supply its own HTTP/WebSocket surface to the reference
gateway supervisor. That surface must explicitly declare external authentication
and build an authenticated, scoped request context before invoking the exported
access router. Native bearer configuration cannot be combined with this mode.
The trusted application owns origin/CSRF defenses and authentication expiry for
long-lived connections, and retains the maintained ingress/egress byte bounds.
This embedding API changes no wire contract or data authority.
