# Protocol-v4 implementation checkpoint

Status: active implementation boundary as of 2026-09-04.

Protocol v4 is the clean network break that replaces caller-shaped
`sessions.spawn` with durable launch profiles/providers, adds an explicit
running/stopped/archived catalog lifecycle, and makes archived-session search a
bounded first-class API. Protocol-v2 host/worker source remains archived, and
protocol-v3 peers cannot connect to a v4 process.

This checkpoint describes the maintained surface. The clean repository checks
and all three protocol-v4 Docker qualifications listed below have passed. These
receipts are evidence for the recorded internal/P2P deployment shapes, not a
claim of public multi-tenant hardening or unlimited real-agent capacity.

## Stable architectural boundary

| Role | Authority and durable ownership | Extension surface |
| --- | --- | --- |
| Control node | canonical session catalog and JSON metadata, authority epoch, topology, recursive operation records, immutable control feed | transport-neutral child/runtime connections and the protocol-v4 access/link routers |
| Runtime node | native app-server/SDK bindings, launch/archive/command journals, metadata outbox, provider-private checkpoints, archived-binding tombstones, ephemeral PTYs | statically registered launch providers and native backends |
| Access gateway | operational source configuration/cursors and an in-memory selected projection; no domain authority | statically registered gateway routers receiving only `GatewayLaunchPort` |
| Harness adapter | native inventory, models, sessions, events, interactions, and history for one harness scope | Codex, Copilot, mock, or another explicit native adapter |

Control nodes form a strict tree; every control node is also the aggregate/proxy
for its subtree. A runtime belongs to one control node. A gateway can connect to
one root, one branch, several disjoint branches or realms, or redundant
ancestor/descendant sources. A strict ancestor projection suppresses the
overlapping descendant while keeping it warm. Partial overlap, competing
authority epochs, and duplicate/forked identities fail closed. Recursive cold
lookup additionally rejects the same session, launch, or archive identity from
two sibling subtrees, even when returned operation records are byte-equivalent:
one identity may have only one owning route. Gateways are never sources and
cannot be chained.

The canonical design is
[`docs/design/data-roles-v4.md`](design/data-roles-v4.md). The launch extension
contract and example are in
[`docs/design/launch-extensions-v4.md`](design/launch-extensions-v4.md).

## Protocol-v4 API boundary

The minimum common surface remains intentionally small:

- advertise runtime nodes, native harness scopes, launch profiles, and
  profile-aware models;
- create/get/list/watch durable launch operations;
- search/get running, stopped, or archived logical sessions;
- resume and stop through dedicated, operation-discriminated command envelopes;
- route harness-native commands, model/mode/effort changes, interrupts, and
  native interaction responses without flattening their payloads;
- archive a stopped session through a separately scoped durable operation;
- read native history through the owning app server/SDK only;
- observe bounded native/control streams with explicit reset/gap recovery;
- read and propose CAS updates to namespaced JSON key/value metadata;
- optionally attach to a runtime-owned ephemeral terminal side channel.

Gateway authorization keeps launch and archive distinct: `agent-launch` admits
new durable work, while `agent-archive` releases and removes stopped work. A
credential with one scope does not implicitly receive the other; neither scope
grants metadata authority to the gateway.

Launch input is an opaque JSON object, not a universal form. The caller chooses
the exact runtime, profile, and harness; core does not schedule. Profile identity
contains provider/profile IDs, a contract version, and the canonical request
JSON-Schema hash. Runtime registration advertises it, gateway routing checks it,
and the runtime provider independently validates it. Successful sessions retain
immutable provider/backend provenance so resume, native history, stop, and
archive do not guess from `harness` alone.

The built-in `core.direct/workspace` profile preserves the PoC workflow: launch
Codex or Copilot in an existing runtime-local directory under an allowed root,
with no resource isolation. Rich workflows—PR validation, worktree creation,
container allocation, organizational placement, quotas, and cleanup—belong in
a paired gateway plugin/runtime provider and backend, not in protocol core.

## Session lifecycle and list bounds

The public state is derived from two independent concepts:

- `running`: open catalog record with an active runtime binding;
- `stopped`: open catalog record without an active binding; it remains visible
  and may be resumed;
- `archived`: authority-owned cold record after successful resource release.

Normal snapshots and default search contain running and stopped records only.
They therefore retain relevant resumable work without accumulating archives.
Archived records remain in the canonical SQLite catalog and are available by
explicit `sessions.search({ states: ["archived"], ... })` or identity lookup.
Their stored metadata remains authority-owned, mutable through the ordinary
fenced CAS path, and searchable. Archived metadata changes update only the cold
catalog and search index: they are never queued for delivery to the released
runtime, and archiving retires any older pending runtime-delivery intents.
Neither metadata operations nor cold lookup restore native resources; native
history, resume, and agent control are unavailable without a future explicit
restore design.
Search supports runtime, harness, launch provider/profile, activity-window, and
AND-combined metadata `exists`/structural-`equals` predicates. Page size is
bounded to 500, ordering is stable, and cursors are query-, authority-, and
gateway-source-selection-fenced. An attached aggregate recursively searches
children so pre-attachment archives do not disappear.

Only an explicitly stopped native binding may be archived. Archive cleanup is
backend first, then launch provider, then an atomic runtime tombstone/binding
removal, then the authority's catalog transition. Failure leaves the session
open/stopped; ambiguity is surfaced as `outcomeUnknown`. A persisted tombstone
prevents native inventory from re-importing an archived vendor session after a
runtime restart. There is no implicit age-based archive and no implicit
unarchive.

## Metadata authority

Session metadata is exactly one flat, namespaced key/value JSON document.
Values may themselves be any JSON value. Both clients and runtime/agent-side
code can propose changes, but only the current control-node authority assigns
canonical revisions. Patches carry a complete realm/control/epoch fence and may
compare individual key revisions. Attached branches retain queued optimistic
operations while disconnected; disconnect never promotes them.

The control node maintains a normalized metadata search index in the same
transaction as each session write. Equality compares canonical structural JSON,
not presentation whitespace or object-key order. Provider-private resource
state, credentials, terminal data, and native transcripts never belong in
metadata.

Durable protocol-record comparison also canonicalizes absent and explicitly
`undefined` object members identically, including nested object members. It
still rejects top-level `undefined`, `undefined` array elements, and non-JSON
objects, preventing transport/SQLite representation differences from creating
false operation conflicts without widening the JSON contract.

## Durable operation semantics

Launch and archive calls return after durable admission, not necessarily after
completion. Consumers must handle intermediate states and recover by operation
ID or watch streams.

- Launch: `accepted -> preparing -> nativeStarting -> succeeded`, with
  `cleanupPending -> failed` for definite preparation failures and
  `outcomeUnknown` for unprovable effects.
- Archive: `accepted -> releasing -> succeeded`, or `failed` /
  `outcomeUnknown` when cleanup cannot be proved.
- Native commands: retry-stable command IDs with at-most-once dispatch and an
  explicit `outcomeUnknown` crash/transport result.

Runtime launch recovery never blindly repeats native start after the
`nativeStarting` boundary. Providers explicitly recover interrupted
preparation; compensation and release hooks must be idempotent. Launch success
and its native binding are one transaction. Archive success and its runtime
tombstone are one transaction. Control-node merge rules reject reuse of an
operation ID with another immutable payload or terminal result.

The control node reserves the logical session durably before launch dispatch,
so reconciliation cannot race a successful native start. Runtime validation
failures become durable failed operations, while an admitted operation that was
never dispatched can be redriven safely. Native inventory is correlated only
through successful immutable launch provenance; it cannot import the same
vendor session as an unrelated logical session during launch recovery. Catalog
merge also rejects malformed or regressing downstream records and treats
lifecycle timestamps as evidence rather than trusting remote clock ordering.

## Static plugin boundary

Gateway and runtime extensions are compiled/imported with their application.
There is no marketplace, dynamic loader, remote install, or sandbox in protocol
v4. `GatewayLaunchPort` is deliberately capability-limited, but a plugin is
still trusted in-process JavaScript and must be reviewed as part of the binary.
Runtime providers receive only their launch context and registered backend
lookup; secrets remain constructor/configuration inputs outside protocol data.

Schema hashes and implementation versions are compatibility and recovery
fences, not code-signing. Deployment tooling is responsible for pinning and
auditing the actual package artifact.

## Persistence and migration

- Control-node SQLite uses the immutable v3 bootstrap plus transactional v4
  session-lifecycle migration. It adds lifecycle/activity/provenance columns,
  metadata search indexing, and launch/archive operation tables, backfills v3
  records as open with no launch provenance, and rotates the incompatible feed.
- Runtime-node SQLite uses the immutable v3 bootstrap plus transactional v4
  launch/archive migration. It adds provider journals/checkpoints/provenance and
  archived native-binding tombstones while preserving compatible bindings,
  commands, and metadata state.
- Runtime identity JSON upgrades v3 to v4 atomically while retaining logical
  runtime and Iroh endpoint identity.
- Gateway SQLite remains on its unchanged v3 operational schema because it owns
  only source locators/cursors/health. Its schema number is independent of the
  v4 wire identity.

Migration histories are exact immutable prefixes. Foreign application IDs,
unversioned stores, unknown or rewritten ledger rows, corrupt databases,
future versions, and downgrades fail closed. Do not rename released migration
entries. Preserve each role's SQLite file and endpoint identity together.

## Deliberate limitations

- Codex app-server transport remains upstream-experimental and is version-pinned
  for qualification.
- Copilot stock-TUI attachment remains opt-in and experimental; the supported
  structured SDK path does not depend on it.
- A shared app-server process is not per-session container isolation. Honest
  isolation requires the app server and adapter endpoint inside each managed
  container (or an equivalently isolated backend). The reference direct
  provider advertises `isolation.none`.
- Runtime processes and live sessions do not migrate between machines.
- Protocol core provides no placement, quota, retry, worktree, repository, or
  credential policy.
- Online graceful detach still fails closed pending a durable
  prepare/drain/commit protocol. Forced detach and promotion are explicit
  audited recovery actions.
- Shared-secret enrollment and static bearer authentication target trusted
  personal/internal networks, not public multi-tenant isolation.
- Mock 100-session receipts measure control-path behavior, not capacity for 100
  real model processes.

## Recorded qualification and local rerun

The clean maintained suite at this checkpoint passes 432 tests across 59 test
files, including v3-to-v4 migrations, crash recovery, lifecycle fencing,
recursive collision rejection, archived metadata behavior, transport renewal,
terminal replay/fencing, nonce-bound terminal styles, and bounded browser
WebSocket ingress/egress.

From the repository root, with authenticated read access to the `@arduano`
GitHub Packages scope:

```bash
npm ls --workspaces --depth=0
npm ci --dry-run --ignore-scripts
npm run check:docs
npm run check:release
npm run typecheck
npm test
npm run check:checkpoint
```

Then run the protocol-v4 deterministic tree and mock-scale targets. Run the
four-container native target when spending Codex/Copilot credits is acceptable:

```bash
npm run test:docker:v4:tree
npm run test:docker:v4:mock:scale
AGENT_MULTIPLEX_LIVE_SOAK_MS=930000 \
  npm run test:docker:v4:live:four
npm run release:native-status -- \
  receipts/protocol-v4-live-four-container/<successful-run-id>
```

The live runner requires a clean source tree and records its exact commit. Run
it after merge from a clean `main` equal to `origin/main`. The final command
snapshots, independently rehashes, and validates the complete passing receipt,
requires a completed soak of at least 930 seconds, then records the
repository-owner commit status that publication requires. Its description
binds the run ID and SHA-256 of the receipt inventory. Use `--check-only` to
perform the local validation without changing GitHub state.

The latest successful protocol-v4 receipts are:

- `receipts/protocol-v4-control-tree/20260904T173822Z-c7222b0a5c27`: four
  containers (two control nodes, one runtime, one gateway), two overlapping
  gateway sources, queued metadata during authority loss, warm-source failover,
  recovery, and three exact native-delta reassemblies;
- `receipts/protocol-v4-mock-docker-scale/20260904T174423Z-849005dd923a`: 12
  containers, 10 runtimes, 100 sessions, 100 successful launches and sends,
  3,600 contiguous native events, zero gaps/duplicates, cursor recovery, runtime
  partition recovery, three fleet-wide CAS rounds, and a 15-second soak;
- `receipts/protocol-v4-live-four-container/20260904T105705Z-ac36786c6521`:
  four containers, two real agents (Codex and Copilot), two successful launches,
  280 native events, native history, Codex plan/question/model/interrupt control,
  terminal isolation, metadata CAS, browser reload, responsive/accessibility
  checks, and zero retained credential material.

Each successful receipt includes a manifest and SHA-256 inventory. The two
deterministic receipts above cover this terminal/transport-hardened source tree.
The older live receipt records Codex CLI 0.152.0. Its sibling p2prpc checkout
was dirty, so the manifest pins both the base revision and the exact package
SHA-256; it is prior native-behavior evidence, not qualification of subsequent
terminal and WebSocket hardening. Release publication requires a fresh live run
for the exact merged commit and its owner-recorded qualification status. The
live suite did not exercise stop, resume, or
archive, and its optional 15-minute p2prpc credential-expiry soak was not
performed. Those are explicit limits of that receipt rather than inferred
passes.

The terminal protocol now prefers exact opening-state replay for a fresh
observer: retained raw ANSI output and resize events reconstruct cursor, modes,
wrapping, and subsequent incremental output. The client commits only an explicit
replay-end high-water barrier, so an interrupted partial replay restarts whole.
A synthesized scrollback reset is an explicitly approximate fallback after
bounded raw replay expires or PTY startup output was truncated. The
React terminal moves a synthesized reset to the live edge once; existing
viewers remain free to scroll back. Failed attempt directories are diagnostic
evidence and are not qualification receipts.
