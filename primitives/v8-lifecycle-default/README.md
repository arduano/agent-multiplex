# Default lifecycle plugin

`defaultLifecycle()` is an explicitly selected shipped plugin. It owns the
SessionHost engine, original-command journal, opening custody and restart
inspection, plus Host-level creation reservations and workspace preparation.
Generic Host composition never supplies an implicit lifecycle fallback.

A creation reservation retains the immutable logical session, original ID,
workspace input, strategy identity and allocation result before native dispatch.
Creation originals are scoped by connection, principal and Host; changing their
logical target within that namespace refuses. The registry is bound to the
stable Host/durable owner, while route epochs may change.
The allocator receives that original once. A missing result uses its read-only
`original()` method; reconnect, mount and original-receipt reads never allocate.
The existing per-session journal retains native effects under the same original
ID. Public receipts join these phases; there is no second public command outbox.

Workspace strategies provide a typed input/public-data schema and
`allocate`/`original`/`inspect` operations.
[`existingDirectoryWorkspace`](src/workspace.ts) borrows an existing directory;
its `{cwd}` input must be absolute, resolve through `realpath` and name a
directory. Optional `allowedRoots` are copied at definition time and resolved
again when allocating, recovering or inspecting. Containment uses canonical
paths, so a symlink outside a configured root is refused. Omitted roots permit
any existing absolute directory; empty roots permit none. Unavailable roots or
an unproved recovery result fail closed. Definition performs no filesystem IO,
and this strategy never creates or deletes a directory. Root policy is trusted
configuration, separate from persisted strategy identity.

Allocation and original lookup may explicitly return
`{state:'refused',noAllocation:true}`: original-specific proof that no resource
mutation occurred. The pure borrowed-directory strategy returns this proof for
invalid, missing, non-directory or disallowed paths. The lifecycle records a
stable `workspaceRefused` Create receipt and settles pre-native custody; Stop
can acknowledge and update readiness can become true with zero native work.
Generic allocator exceptions still mean unknown, since an owned strategy may
have mutated resources before losing its reply. An explicit later original
lookup may provide the same no-allocation proof; reconnect never retries
allocation. A refused original stays refused after path changes or reopening.

Stop never releases or deletes either borrowed or owned workspaces. Explicit
Archive is a separate irreversible original after positive Stop. Borrowed
workspaces are preserved; an owned workspace needs its strategy's explicit
release capability and positive release result. Unknown allocation never proves
absence. Archive busy/refusal occurs before the durable seal. Once sealed, lost
cleanup results stay uncertain and no lookup replays cleanup.

`maxSessions` bounds occupied creation records, not lifetime history. Only a
saved acknowledged Archive releases its slot; Stop, pending Archive and failed
or uncertain cleanup do not. Archived records and original IDs remain durable,
including across restart, and exact duplicate admission still resolves before
the capacity check. No separate capacity counter or record deletion is used.

Stop during preparation fences native construction. A pending or unknown
allocator retains custody and keeps the session Stopping until the actual
allocation settles or the exact original proves its result. Late successful
allocation is retained with its identity and custom public data; no native
session is launched. Durable plugin/harness/strategy record identities fence
incompatible opens before acquisition. Deployment revisions are separate from
record versions; historical pre-plugin records require an explicit migration.

`createAdmitted` uses the same original and registry promise as `create`, but
returns at durable inventory admission. It does not wait for allocation or native
construction. Explicit `sealAdmissions()` rejects new creation and non-Stop
submissions, including a submission still acquiring its actual SessionHost. It
waits only the existing registry admission frontier, so process shutdown can
Stop every owned record before held native preparation completes. It does not
Stop or close anything. Original receipt reads stay independent. Ordinary
Stop/StopAll keeps future creation available.

The typed router exposes creation, Stop/Resume, exact original lookup, current
public Host/session data, explicit reconciliation and a bounded latest-snapshot
subscription. Host/session custom structures preserve their concrete schema
inference. Native controls stay on the selected harness router. Original-receipt reads do
not wait behind a held constructor. Cold durable receipt lookup uses a bounded
read-only connection to the existing session journal, without native inspection
or an observation-epoch advance.

A durably final acknowledged/refused original also publishes current facts on
the existing session watch at a newer observation revision. Native phase,
activity, identity and generation stay unchanged, including for a late result
from an older run. Retained clients use that pulse to reconcile exact originals;
no new receipt stream, timer or journal is introduced. Nonfinal state transitions
retain their existing ordered snapshot publication.

`DefaultLifecycleSessions.list(context?)` and `subscribeHost(listener, context?)`
publish committed registry facts, including preparing and cold `unobserved`
sessions. Discovery never constructs an adapter, inspects native custody,
resumes, allocates or reads transcript bodies. Supplied contexts select the
exact connection/principal and Host route; omitting context is a trusted
server-side inventory. The typed router's `list` and `watchHost` always use the
authenticated context. `watchHost` delivers a complete initial snapshot and
coalesces pending updates to one latest snapshot, with concrete workspace/native
DTO inference. A cold
explicit session `view`/`watch` remains a separate inspection path and cannot be
treated as inert Host discovery.

Once a non-fresh exact native binding is positively running, `AgentHost` admits
one initial read-only history baseline for that attachment through its existing
acquisition/fact owner. Fresh proved-empty Create and stopped/unbound inspection
do not read. Baseline work and settlement outlive viewer cancellation and finite
waits; later viewers join the same streamed result without another read. Safe
unknown-boundary descriptions report initial loading/failure without exposing
native errors or turning them into beginning-of-history proof. A retired
attachment cannot publish its late result. Explicit recovery remains available
under the same retained fact, not a per-viewer retry loop.

The current Host window holds128 rows; active initial/older loads target100
native entries within512KiB, using bounded same-cursor shrink when necessary.
An older private page does not enlarge current Host residency. A settled page
read failure is unavailable IO, not false scope fencing; actual scope,
generation and reader-context fences remain strict. No native activation,
continuation, Send or stopped-reader allocation follows from UI mount/reconnect.

Observed Copilot accounting is one optional `SessionSnapshot.usage` fact:
native session identity, cumulative `totalNanoAiu`, native `reportedAt` and Host
`observedAt`. The selected Copilot adapter admits only root
`session.usage_checkpoint`/`session.shutdown` events with valid nonnegative safe
integer accounting and a native timestamp. Tokens, child totals and provider
prices never manufacture accounting. Missing remains unknown; a reported zero
is a real fact. The existing serialized session writer checks value/time
monotonicity, commits before publishing, and leaves duplicate freshness unchanged.
Stop and Resume of the same native identity retain the checkpoint; accounting
cannot cross native identities. Archive preserves its last saved fact.

At Host activation, the existing registry worker passively reads only retained
accounting from each exact-owned session journal. Live `list`/`watchHost` views
use only `native.usage`; cold views expose optional `usage` while `native` is null.
The DTO never aliases the same accounting object at both positions, matching the
pinned Peer codec's object-tree contract; this is a historical checkpoint,
not current native ownership evidence. Scope and durable plugin-record identity
are checked before that read. No new table, Gateway accounting owner, poller,
adapter construction, writer epoch advance or transcript seed is involved.
`qualification/usage.test.ts` exercises this through a scripted Copilot controller,
the actual SQLite session owner and a cold Host reopen. Native/model acceptance
and application browser presentation remain independent gates.

The trusted owner helper `sessions.stop(scope, originalId)` selects generation
from existing evidence. Fresh preparation uses generation zero and durably
fences Stop before waiting on construction; retained native evidence uses its
actual generation. Cold attempted custody without that evidence needs explicit
inspection before generation selection. This helper submits through the same
original owner and does not turn timeout, observer disposal or an absent result
into positive containment proof.

Update readiness checks actual preparation, registry IO, native phase, opening
custody, admitted work and arrived-result IO. Close first fences admission and
rechecks every native owner. A Stopped view alone cannot permit an update.
Historical uncertain command receipts may survive a positive exact halt. Once
all native/domain custody is quiescent, update shutdown closes each selected
runtime and disposes its adapter listeners.

`openHost` and `SessionHost.open` are lower-level helpers inside this explicit
plugin package for existing focused qualification and advanced composition.
They are no longer exported by generic `v8-host` or implemented in `v8-session`.

Archive reuses the session original journal. Actual callbacks, reads, file leases
and native consumer holds must quiesce; stopped history readers are retired by
their exact saved allocation capsule. Reader allocation intent and custody use
one private journal slot before launching, never process discovery. Legacy
missing custody stays unavailable. Resource and native-history bytes are
preserved, including uncertain Send audit holds. The read-only `archiveProof`
checks the exact original/generation without opening an adapter or advancing the
observation epoch. Catalog publication has its own metadata authority and never
dispatches Archive.

Completed Archive remains sealed against native mutations. Its exact saved
Stopped run may explicitly Recover or page retained native history through the
same acquisition owner and one journalled sessionless reader. Pending Archive
still refuses history admission. Cold passive context requires the joined
completed snapshot and acknowledged Archive original in the native journal;
an allocation release or registry flag alone grants nothing. This also handles
native completion before registry publication. Reader intent independently
rechecks the exact durable run and Archive proof before native acquisition.

A released workspace is never allocated, inspected or restored for archived
history. The retained session/native-home directory supplies cold context, and
both native runtimes launch auxiliary readers from their retained custody
directory. Agent cwd and original FileHost path policy remain unchanged. Closing
the Host releases the same exact reader capsule. Archive closes current history
observers while preserving its projection for explicit passive access; cold
Hosts start with empty projections. New media capture, file acquisition and
writes remain sealed: unavailable cold media stays explicit, and retained bytes
are not deleted. This is a native-history API contract, not a new Archive UI or
permission to Resume, restore, import or reopen the original workspace.

A fresh controller after positive Stop has no live callback or MCP owner.
AgentHost still exposes the exact stopped run's closed observations: callbacks
are partial/ownership-retired, and unknown MCP inventory is retired with unknown
coverage. These values permit read-only Workspace/history bootstrap without
constructing an adapter-owned native session. Unknown/running sessions with no
owner remain fenced. Only explicit Recover can acquire the stopped reader;
passive mounting never does. Retired MCP observation can be subscribed without
granting discovery or restarting a server.

Root attention uses this same session writer and snapshot. Native-specific
projectors supply content-free work/outcome causes; only accepted semantic
changes receive the existing committed revision stamp. Settings, duplicate
events, reconnects and Stop do not invent completion or unseen markers.
Generation and epoch retain their distinct provenance, so an earlier run's
saved outcome cannot become current work after Resume. Cold discovery reads
usage/attention together through one passive exact-owned journal read/map;
top-level saved facts exist only while `native` is null. No additional journal,
poller, history seed, task owner or notification delivery loop is introduced.
The catalog bridge `lifecycleCreationHost` delegates creation to this owner while
catalog reservation/publication remains with the catalog authority.

[`lifecycleSessionRoute`](src/gateway.ts) projects this selected lifecycle into
the existing Gateway session/history/interaction/MCP/file ports. Constructing a
bridge is inert; explicit reads and observers use the existing exact-scoped
owners, including their cold-history and native inspection boundaries. The
bridge retains observation releases, handles a late acquired subscription after
cancellation, and reuses already attached Host evidence. `bridge.close()` only
releases these observations. It never stops an agent, disposes its native
adapter, deletes its workspace or settles an original. Composition separately
releases the Gateway registration so the edge can be remounted.

Returning a quiet history iterator releases its underlying Hub subscription
before awaiting the wrapper's completion. Host-facade cancellation therefore
wakes a pending history read without another event or bridge closure. A return
during attachment also prevents a late subscription from being acquired. The
existing route owns this cleanup independently of the native session lifetime.

Focused qualification in `qualification/lifecycle.test.ts` covers both scripted
harnesses, immutable original reuse, borrowed workspace preservation and cold
inspection; Stop during a held allocation; lost allocation reply followed by
exact original lookup; incompatible durable record/Host/owner refusal; held constructor Stop with
nonblocking original lookup and exact adapter cleanup; and principal-separated
creation originals. These use actual
private SQLite workers and concrete scripted controllers, with zero model,
provider, native-agent, existing-session or deployment operations.
