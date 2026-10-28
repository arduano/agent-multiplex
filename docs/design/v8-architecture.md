# V8 source architecture

V8 is an isolated generic implementation under [primitives](../../primitives/),
separate from the maintained released package graph. Its source, examples and
qualification must be usable from this repository without an application
checkout. Accounts, profiles, credentials, deployment policy and business
workflows belong to consuming applications.

## Typed Host composition

The [Host kernel](../../primitives/v8-plugins/README.md) mounts exactly one
lifecycle plugin, one harness adapter and named static extensions.
[defineHost](../../primitives/v8-plugins/src/host.ts) is inert; `activateHost`
explicitly acquires selected owners. The kernel has no hidden session lifecycle
or native fallback. Plugins are trusted static code, not a sandbox, dynamic
loader or hot-installation system.

The actual Host tRPC router is the API schema. `PublicHostContract` derives
browser-safe native kind, Create input and Host/session/extension DTO types.
An application binds known contracts once; narrowing the Host kind narrows
native methods and custom data together. Runtime checks still enforce identity,
composition, generation and authorization. TypeScript is not a permission
boundary, and an unknown contract is not a generic dynamic UI.

The [default lifecycle](../../primitives/v8-lifecycle-default/README.md) owns
workspace/native creation, originals, Stop/Resume and reconciliation. A typed
workspace strategy allocates or references a directory local to that Host.
Remote placement needs an explicit external domain owner and handoff; a path
does not provision another machine.

Committed Host discovery (`list`/`watchHost`) is inert and scoped to the
authenticated owner. A cold session observation or owner-selected Stop is an
explicit inspection boundary; native generation is never guessed from the
absence of a mounted viewer.

Fresh creation proves quiescence; explicit reopening permits saved native work
to continue. These are separate opening observations. Viewing, reconnecting,
switching and pinning cannot open or continue native work. A separate explicit
promptless Continue uses the harness's supported zero-message operation after
positive inactivity, including terminal provider/network interruption. Native
retrying work remains the same owned work; uncertain outcomes are never replayed.

For installed Linux/WSL Hosts, one delegated service hierarchy contains control,
session and reader subgroups. Native lifetime ends with its owning Host process;
per-session Stop still targets only that session. Parent-invocation provenance
lives in the existing session journal, so exact retirement can reconcile a
pre-capsule opening without allocation scanning or an independent custody store.

[Codex](../../primitives/v8-harness-codex/README.md) and
[Copilot](../../primitives/v8-harness-copilot/README.md) own concrete protocols,
controls, history facets and supported startup contributions. Contributions
are immutable setup data, not independent lifecycle hooks. Unsupported encoders
refuse explicitly. Another native family requires its real protocol, history
and containment implementation, not just a registry string.

Private startup configuration, versioned custody records and public DTOs are
different representations. Public composition identity contains only public
plugin IDs/versions; it must never hash private configuration. Browser exports
exclude native factories, storage, profiles and secrets.

## Durable identity and original operations

The [catalog](../../primitives/v8-catalog/README.md) reserves logical identity
and publishes proven native bindings. The selected Host owns native effects;
a failed catalog publication cannot license another Create. Catalog metadata
and requested cwd are not observations of native execution.

[Session contracts](../../primitives/v8-session/README.md) separate immutable
original command identity, native identity, generation, attachment and receipt
evidence. The default lifecycle keys sessions/originals by authenticated
connection and principal as well as Host/session. Matching display names or
two Gateway routes do not grant cross-account sharing. That needs an explicit
owner-enforced delegation policy.

Durable admission precedes dispatch. Timeout or receipt absence means the
observer lacks an outcome; it does not prove non-execution. Reconciliation
reads the exact original under a positively proved owner. Route epoch is
replaceable transport freshness, not a replacement durable owner. Gateways
never replay mutations or keep a second durable forwarding outbox.

The journal retains compact operation IDs, hashes and exact terminal receipts
until explicit session-data deletion. Terminal payloads release active admission
reservations transactionally; unknown originals remain protected. The independent
finite journal-byte quota does not authorize receipt eviction or a successful
acknowledgement after a failed write. Stop retains reserved admission through the
client and Host gates, subject to actual persistence/authentication availability.

Clients retain unresolved originals and a bounded recent Activity window, plus
originals still protecting local file/edit settlement. A caller-held operation
handle stays immutable after Activity retirement. Restored references only read
receipts. The Gateway's local duplicate check covers retained originals; a raw
explicit duplicate after terminal retirement still meets permanent Host ID/hash
deduplication. Navigation, reconnect and receipt lookup never redispatch it.

Plan associations are recent display metadata plus one preparation, not another
terminal-status or uncertain-effect owner. Their eviction cannot authorize a new
effect; deterministic original identity and saved/Host receipt lookup still apply.

External domain mutations retain their own actual owner and original. The
plugin `originalMutation` helper delegates to that owner; it adds no journal,
workflow queue or retry policy.

## Native lifetime and settings

Stop durably seals new native work and requires positive exact containment
evidence before publishing Stopped. Controller disposal, leader exit, idle,
socket loss and observer cancellation are insufficient. Failed Stop retains
custody and visible stopping/unknown evidence; shared placement must preserve
unrelated peers. Explicit reopening may continue saved native work; fresh
creation separately proves quiescence. Neither replays an original prompt or
automatically chains a promptless Continue.
The [runtime supervisor](../../primitives/v8-runtime/README.md) validates injected
ownership evidence; it does not invent OS authority from a PID.

Stop during workspace/native allocation keeps the actual outstanding operation.
A late allocation cannot bypass its fence. Release/archive is separate from
native Stop, and borrowed directories are not deleted implicitly.

Supported model/mode/reasoning/permission controls remain harness-specific live
actions. Startup contributions or code changes require stopped sessions, settled
custody and sealed admission before owners close. Readiness is momentary; close
rechecks under its fence. Partial cleanup stays failed. A new composition does
not automatically Resume sessions.

Failed composition retains every lifecycle/extension owner that was actually
returned before validation. `HostActivationError.recoveryFor(definition)` restores
that selected lifecycle's type only for the exact static definition, together
with remaining extensions and readiness/close. The kernel supplies no native
Stop or adoption policy; the selected lifecycle's existing controls remain the
authority. Unready owners are preserved, extensions close before their lifecycle
dependency, and failed close is not automatically replayed. A factory that throws
before returning an owner remains responsible for its own partial resources.

## History and retained views

[History](../../primitives/v8-history/README.md) normally streams retained Host
capture/replay, including across zero viewers. Mount, reconnect and scroll do
not authorize native body acquisition. Named cold/gap/older exceptions use exact
scoped evidence and bounded existing read owners. Native pages have no implied
atomic callback cursor: protect newer live evidence and never concatenate an
unproved prefix and suffix.

The Host publishes coherent snapshots or contiguous absolute commits. The
client validates whole frames before publication. Body completeness, native
activity, stream freshness and Send receipt remain independent facts. Historical
records cannot replay callbacks or settle original requests.

The default lifecycle admits complete bodies up to 64 KiB while the Host rolls
old non-running rows out of a 512 KiB serialized current window (also bounded
to 128 rows); retained views and explicit native pages keep their own bounded
residency. Frame validation still caps the wire at 1 MiB. Codex's bounded native
timeline supplies completed-item evidence and terminal-turn error notices through
one cursor, including itemless failures. Error text belongs to those scoped
history rows, not a second error store, and a diagnostic never settles native
turn activity or an original request.

The [retained workspace](../../primitives/v8-workspace/README.md) owns session
state independently of React selection. Views retain pages, anchors and
expansions; sessions retain drafts and originals. A UI pin holds background
observation, not native lifetime. Preparation/render/SSR are inert; committed
leases observe. Capacity refuses instead of silently evicting protected state.
Auth disposal redacts one namespace; disconnect keeps last state marked stale.

The same history stream retains typed read state: idle, pending, or settled with
an exact initial/recovery/older target. The acquisition publishes pending before
dispatch and rows before ready. Observer wait expiry leaves actual work pending;
another mount or viewer cannot renew it. Eligible settled active-read failure
exposes one opaque explicit-retry token, consuming the existing second-attempt
allowance. Duplicate clicks join it; consumed persisted cursors never renew.
Actual generation/read-context replacement clears that projection and fences
late completion. Read pressure is temporary unavailability/capacity, not proof
of a changed owner. Readiness does not imply complete conversation history.

## Files and resource ownership

[Files](../../primitives/v8-files/README.md) separate immutable cached bytes
from disk references, staged inputs, native/request holds and preview leases.
First-preview snapshots preserve displayed identity. Expiry requires relevant
holds to release; bytes stay charged until physical cleanup succeeds. Binary
HTTP transfers remain separate from JSON RPC. An observer deadline cannot
release an underlying file/native read slot early.

## Routing, authentication and cancellation

The [Gateway](../../primitives/v8-gateway/README.md) authenticates and forwards
directly to selected Hosts with bounded independent observers. It owns no
catalog, native lifecycle, transcript or external resource. Its client uses one
descriptor/reconnect scheduler and one HTTP observer mux. Disconnect invalidates
freshness; explicit auth revocation also retires private client state.

Host forwarding verifies configured Peer identity plus signed exact route,
composition, actor, procedure/type and optional generation scope. Host/domain
owners enforce their own permissions. Generic read/control grants do not imply
arbitrary fine-grained domain policy. Grant expiry is not native Stop; the
routing/auth owner must also retire existing observation leases.

Trusted registrations may narrow the authenticated identity's actions per edge.
Grants are validated snapshots, not a union inherited from other Hosts. Exact
session/Host-RPC registration disposers release only their own observations and
allow remount; stale releases cannot retire replacements or cancel native work.

Observer cancellation stops local delivery promptly while admitted work retains
capacity until settlement. Published transport can quarantine a shared
connection when raw opening is cancelled; viewer cancellation therefore must
not abort its shared Peer's admitted opening. The P14 fixtures retain that
counterexample and positive multi-viewer oracle. They do not prove the first
caller in an older incident whose physical-close stack was absent.

## Interactions and MCP

[Interactions](../../primitives/v8-interactions/README.md) retain exact native
prompt identity and one-response capabilities. Private answers stay outside
public snapshots and durable response content. Submission and positive native
settlement are different evidence; reconnect cannot recreate callbacks.

[MCP](../../primitives/v8-mcp/README.md) exposes retained observation and explicit
bounded refresh. Mount/reconnect never discovers or starts native clients.
Adapter/SDK support determines what settlement/catalog continuity can be proved;
missing support remains explicit instead of becoming synthetic success.
The concrete harnesses admit Codex configuration reload and Copilot per-server
reconnect through the existing session-original journal. Their native scopes
remain distinct. Copilot reconnect invokes its native restart without asserting
a successful OAuth login. Effects mark retained MCP evidence stale without
automatically discovering again. Safe transport/auth eligibility facts contain
no endpoint or credential.

Running-agent sign-in is a separate session original. Its bounded authorization
link stays in the controller's transient owner and is returned only by an exact
current-account/run/original lookup requiring read and control authority. The
response is no-store; snapshots, history and receipts never retain the URL.
Display expiry does not cancel the native flow or license replay. Completion correlation
remains harness-specific; stopped/shared authentication and reusable credential
namespaces retain their separate unsupported or unqualified boundaries.

## Runtime and organization

[Organization](../../primitives/v8-organization/README.md) composes catalog and
workspace references without becoming a lifecycle service. Desired pin state,
held references and persistence outcomes remain distinct. Runtime inspection
observes existing ownership; it cannot start a replacement because no attachment
was observed.

## Qualification

[Integration](../../primitives/v8-integration/README.md) composes actual modules
with scripted native transports, real HTTP/SQLite/files/React and bounded
published-transport fixtures. Source manifests and cleanup receipts distinguish
frozen passes from failed diagnostics. Focused tests protect unique invariants;
moved implementations reuse oracles instead of multiplying scheduling fixtures.

Local `artifacts/` directories are ignored, may contain private diagnostics and
are not portable public evidence. Historical hashes/results retain their exact
input scope; later changes need relevant qualification. Native protocol, model
and platform acceptance is separate from scripted source qualification. Opt-in
native runners require fresh finite authorization and explicit disposable
inputs; ordinary tests must not launch native/model work. No source checkpoint
alone claims a published release, deployment, full native conformance or
production authentication.
