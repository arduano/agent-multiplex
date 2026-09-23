# Current state and fresh-session handoff

Read this page after the root [`AGENTS.md`](../../AGENTS.md) when starting a new
coding-agent session. It is the single current-state summary. Follow only the
links for the role being changed; the rest of the wiki is topical guidance, and
the design documents are the deeper normative contracts.

Last reconciled: 2026-09-23 (protocol-v6 lifecycle with published transport renewal pinned).

## Protocol-v6 Copilot lifecycle prerelease

The signed [`0.2.4-hotfix.17` prerelease](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-23.1)
from source `6bb053cd05be66151114ecf397fd4143a0004512` declares protocol v6 as a coordinated clean break
from protocol v5. Controls, runtimes, gateways, clients, and adapters must move
together; there is no mixed-version compatibility branch. The latest published
protocol-v5 packages and every retained release receipt keep their original
scope.

Protocol v6 adds a runtime-owned, durable Copilot lifecycle state under an exact
session/runtime/boot/binding/native-epoch fence. Its executable reducer keeps
root work, tasks, children, queue, interactions, command delivery, compaction,
and stream continuity independent. Catalog rows and `sessions.readLifecycle`
expose only the compact version-2 host view: opaque observation ID, status,
typed health/issues, and action availability. `commands.observe` combines an
original durable receipt with exact delivery evidence and a continuation hint;
`commands.get` remains the raw receipt query. Private fences, reducer revisions
and native sequence are not browser inputs. Missing continuity and incomplete
native hydration remain Unknown; catalog idle, elapsed time, text equality,
queue disappearance, or a successful generic command receipt cannot
manufacture completion. Runtime startup reattaches persisted active Copilot
bindings before control registration, with native pending work disabled.
The runtime now refreshes task and queue observations every minute, blocks
mutations after a 45-second stalled observation, and requests a runtime-only
supervisor retry after 120 more seconds of degradation. Automatic retry requires
verified closure of the old native CLI owner; an unproved forced stop fails
closed while sidecar and control stay online.
The companion Leo branch migrates browser actions and delivery to these host
views, fixes hidden-tab receipt checks and the compaction/terminal-receipt race,
and supervises runtime restart separately from recovery sidecar and control
readiness.

Generic durable command receipts also use typed `CommandError` records with an
allowlisted code, stage, certainty, diagnostic ID, and fixed public text. The
upgrade appends control schema v7 for typed errors, runtime v6 for the same
boundary, runtime v7 for lifecycle evidence, control/runtime v8 for the
version-2 public contract, runtime v9 for crash-safe startup reattachment
intent, and runtime v10 for activity/admission state. Released migration
identities remain immutable.

This branch pins the independently published
`@arduano/p2prpc-core@0.3.0-renewal.0` in its manifest and lockfile. Ordinary renewal keeps the
same RPC/feed streams while replacing short-lived authentication generations.
Read the [transport handoff](Transport-Renewal-Handoff.md), the
[renewal design](../design/p2prpc-renewal-vnext.md), and the
[normative lifecycle design](../design/copilot-session-lifecycle-vnext.md).
The [evidence audit](../audits/copilot-lifecycle-vnext-audit.md) records which
SDK and repository assumptions are confirmed, disproved, conditional, or still
blocked.

This signed graph has no live/native-model, production, Windows, installed-host,
or maintenance-window qualification and has not been deployed. Its 16 tarballs
and three metadata assets were independently downloaded and matched to the
local verified bytes. Deterministic source qualification must be read from the
published-core source and artifact receipts in the [checkpoint](../checkpoint-v4.md#published-core-protocol-v6-source-gate--2026-09-23);
historical protocol-v5 release evidence does not qualify this boundary. The
remaining release history below describes earlier published boundaries.

The [three-repository readiness audit](../audits/maintenance-window-readiness-20260923.md)
records the initial **no-go** findings and dated closure updates. The lifecycle
defects and published framework/consumer pins are fixed; Windows, stopped-state
rollback and live renewal observation still determine cutover readiness.

## Retained catalog startup correction

The `.15` candidate corrects a latent restart defect when a catalog has compacted
past cursor zero: publication initializes from its committed checkpoint before
boot/recovery events. It also keeps slow authority initialization in one retained
lane, exposes health during database open and rejects domain requests before
initialization. Do not activate `.14` on retained roots; the previously published
bytes remain immutable. Catalog, identities, receipts and durability are preserved.
Validation/publication of the correction is in progress.

## Storage reliability prerelease

Published [`0.2.4-hotfix.14`](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-11.1)
adds gateway recovery admission, catalog no-op/coalescing and ordered group
commits, and an opt-in authority-only storage worker with bounded asynchronous
RPC. Protocol v5, migrations, native agent pins, p2prpc and authoritative
WAL/FULL durability are unchanged. The existing filesystem remains in place.
See [operations](Operations.md#storage-stalls-and-an-isolated-authority) and
[the detailed boundary](../design/data-roles-v4.md#storage-progress-admission-and-projection-recovery).

All 928 deterministic tests, typecheck/build, docs/checkpoint/release/secret checks,
16 packed consumers and SBOM pass. All 19 published assets were independently
byte-compared and package integrities verified. Implementation-stage Docker tree
and scale runs pass; their original image/source scope is retained in the
[checkpoint](../checkpoint-v4.md#storage-stall-containment--2026-09-11).
Native-model qualification remains waived. Consumer activation is recorded by Leo;
combined host/runtime storage is not isolated by this authority-only option.

## Independent access HTTP requests

The published [`0.2.4-hotfix.13` prerelease](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-10.1) removes non-streaming HTTP batching from
`createAccessClient`. Each query/mutation now has its own response and cancellation
boundary, so a slow native history/task read cannot hold unrelated fleet reads in
the same batch. p2prpc already uses one QUIC stream per RPC and is unchanged.
Existing authentication, WebSocket subscriptions and mutation identities are
preserved. **884 deterministic tests**, typecheck/build, documentation/release checks,
all16 packed consumers and independently verified public artifacts pass. The
[checkpoint](../checkpoint-v4.md#independent-access-http-requests--2026-09-10) owns the exact evidence; no installed-host or native-model qualification is claimed.

## Imported interaction ownership hotfix

The published [`0.2.4-hotfix.12` prerelease](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-09.3) preserves child projection ownership when an
interaction is resolved, expires, is republished or becomes stale. Previously an
authority-side lifecycle update could clear that marker, causing a later valid
child snapshot to be rejected as an identity takeover. Existing snapshot and
terminal-answer conflict checks remain intact. No migration, protocol or native
dependency change is involved; an existing damaged marker requires a separately
reviewed, backed-up repair. See [interaction guidance](Lifecycle-Metadata-and-Search.md#history-and-interactions).

Typecheck/build, **879 deterministic tests**, checkpoint, documentation,
release metadata and source-secret checks pass. All 16 isolated packed consumers,
the SBOM, deterministic Docker control tree and 100-session/10-runtime scale suite
pass. All 19 published assets were independently downloaded and verified.
Native-model qualification remains waived for this incremental prerelease. The
[checkpoint](../checkpoint-v4.md#imported-interaction-ownership-hotfix--2026-09-09)
records release evidence; installed repair and activation belong to the consumer.

## Native context compaction hotfix

The published [`0.2.4-hotfix.11` prerelease](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-09.2) adds `context.compact` v1 for native Codex and
Copilot context compaction. Codex acknowledges starting native compaction;
Copilot preserves its completion result, including false outcomes. Both use the
existing durable command and active-binding fences without synthetic messages,
implicit resume or automatic mutation retry. See [adapter guidance](Adapters-and-Terminals.md#native-context-compaction).

Typecheck/build, **874 deterministic tests across 92 files**, documentation,
checkpoint, release metadata and source-secret checks pass. All 16 isolated
packed consumers and the release-build SBOM pass; all 19 published assets were
independently downloaded and checksum-verified. The owner waived native-model
qualification for this incremental prerelease. Compaction may itself call a
model, so no live compaction is included in source validation. Protocol v5,
native/transport dependency pins and migrations are unchanged. The [checkpoint](../checkpoint-v4.md#native-context-compaction-hotfix--2026-09-09)
records source and artifact evidence; installed activation remains consumer
maintenance work.

## Copilot native task controls hotfix

The published [`0.2.4-hotfix.10` prerelease](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-09.1) adds capability-gated native Copilot
task lists/progress and durable exact-ID background-promotion/cancellation.
Bounded active-binding reads preserve native task/model/owner fields without
loading history; controls preserve definite no-ops and unknown mutation outcomes.
See [tracked tasks](Adapters-and-Terminals.md#copilot-tracked-tasks).

Typecheck/build, **848 deterministic tests across 90 files**, documentation,
checkpoint, release metadata and high-severity dependency audit gates pass. All
16 isolated packed consumers and the release-build SBOM pass; all 19 published
assets were independently downloaded and checksum-verified.
The owner waived native-model qualification for incremental prerelease publication.
Disposable Linux native shell checks make no model/provider requests; Windows and
model-driven agent/client behavior remain UAT. Protocol v5, native/transport pins
and migrations are unchanged. The [checkpoint](../checkpoint-v4.md#copilot-native-task-controls-hotfix--2026-09-09)
records the source and artifact evidence; installed activation belongs to the consumer.

## Copilot stalled-read and presence recovery hotfix

The published [`0.2.4-hotfix.9` prerelease](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-08.2) bounds read-only Copilot SDK requests and retains
stalled calls until native settlement, preventing refresh/reconnect request piles.
Inventory observes whole-session activity through existing native handles. A failed
observation reports unknown while newer lifecycle events, errors and actionable
input remain authoritative. Runtime presence heartbeats proceed independently of
native inventory and metadata maintenance. Native mode reads/events also keep
acknowledged mode current after plan approval. See [adapter recovery](Adapters-and-Terminals.md#stalled-copilot-reads)
and [process supervision](Operations.md#process-supervision).

Typecheck/build, **826 deterministic tests**, documentation, checkpoint, release
metadata and all 16 isolated packed-consumer checks pass. The release-build SBOM
contains all packages and bundled web identities; all 19 published assets were
independently downloaded and checksum-verified. This remains an incremental prerelease under the owner's native-model
qualification waiver. Protocol v5, transport/native pins and migrations are
unchanged; mutation ambiguity and stable operation IDs retain their existing
semantics. No native-model or installed-rollout qualification is claimed. The
[checkpoint](../checkpoint-v4.md#copilot-stalled-read-recovery-hotfix--2026-09-08)
owns release evidence; installed activation belongs to the personal consumer.

## Bounded Codex failed-turn detail hotfix

The published [`0.2.4-hotfix.8` prerelease](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-08.1) adds optional `history.native.turns` v1. A client
can request one newest native turn to recover its exact status/error after a
reload; existing item history and metadata reads retain their behavior. Native
summary pages stay bounded, falling back to the pinned native `notLoaded` view
for a single oversized summary. No provider decisions are reclassified by the
adapter, and history reads issue no command or automatic retry of agent work.
See [native history](Adapters-and-Terminals.md#bounded-native-history).

The source passes typecheck/build, **783 deterministic tests**, checkpoint,
documentation, release metadata and all 16 isolated packed-consumer checks.
Published artifacts were independently downloaded and checksum-verified.
Native-model qualification is waived
under the existing incremental hotfix exception; no live qualification or
installed rollout is claimed here. Protocol v5, transport/native dependencies
and migrations are unchanged. Publication evidence belongs to the checkpoint;
installed runtime activation belongs to the personal consumer repository.

## Standalone authority attachment hotfix

The published [`0.2.4-hotfix.7` prerelease](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-07.7) repairs attachment of an existing standalone catalog directly to
an authority root. Its first complete snapshot transfers immutable historical
metadata receipts; later replays cannot invent or change those results.
The new control-only migration is `control-node-v5-authority-receipt-handoff`
(version 6). Wire protocol, native bindings and runtime storage are unchanged.
Queued work and receipt deliveries must drain first; formed subtree moves and
populated attachment under an intermediate branch remain explicitly rejected.
See [architecture guidance](Architecture-and-Data-Roles.md#attaching-an-existing-host-catalog).
Typecheck, **768 tests**, documentation, checkpoint, release metadata, all 16
isolated packed consumers and deterministic Docker tree/100-session scale checks
pass for the signed source. Published tarballs were independently downloaded and
checksum-verified. No native-model qualification or stable promotion is claimed;
installed rollout remains in the personal consumer repository. See the
[checkpoint](../checkpoint-v4.md#standalone-authority-handoff-hotfix--2026-09-07).

## Codex goals and unavailable Copilot recovery

The published [`0.2.4-hotfix.6` prerelease](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-07.6) adds capability-gated native Codex goal reads and
durable goal set/clear commands. Objectives, statuses, optional token budgets,
usage and notifications retain their pinned native semantics. It also classifies
Copilot's exact missing-saved-session resume refusal as a definite failure,
keeping Stop/Archive recovery usable. Untouched empty Copilot sessions can still
be absent after restart in CLI 1.0.81; there is no silent recreation or synthetic
history. See [adapter guidance](Adapters-and-Terminals.md).

Typecheck, production build, **758 tests**, checkpoint, documentation, release
metadata and all 16 isolated packed-consumer checks pass. The owner waived
model-using qualification for this batch.
Protocol v5, native/transport pins and migrations are unchanged. Publication and
installed rollout are recorded separately in the checkpoint and consumer repo.

## Copilot lifecycle audit follow-up

The published [`0.2.4-hotfix.5` prerelease](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-07.5) repairs send/resume/permission/shutdown observation
races and adds optional `history.native.primary` v1. Primary reads delegate to
Copilot's native ownership-filtered event log with opaque cursors; children no
longer consume a main-conversation page. Default all-events history stays
available. See [native history](Adapters-and-Terminals.md#bounded-native-history).

Typecheck, **716 tests**, checkpoint, documentation and release-metadata gates
pass. A disposable CLI 1.0.81 / SDK 1.0.13 session verified native primary paging
and continuation across append without any model prompt. No production session
was used for qualification. Wire protocol, transport/native pins and migrations
are unchanged. This remains an unqualified incremental prerelease under the
existing owner exception; artifact and publication evidence belongs to the
[checkpoint](../checkpoint-v4.md#copilot-lifecycle-audit-hotfix--2026-09-07).

## Copilot queue visibility follow-up

The published [`0.2.4-hotfix.4` prerelease](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-07.4) adds capability-gated, read-only
`sessions.readNativeState` for Copilot pending messages and the durable
`steerQueuedMessage` command. Queue reads require a live binding and never resume
sessions. Conversion uses native `queue.sendNow` atomically, preserving the
existing message and attachments. See [pending messages](Adapters-and-Terminals.md#copilot-pending-messages).
Protocol version, transport dependency, native pins and migrations remain
unchanged. Older hosts remain usable without the new capabilities. No native
model calls or host restart are part of this source validation. Typecheck,
678 tests and all 16 isolated packed consumers pass; see the
[checkpoint](../checkpoint-v4.md#copilot-pending-messages-hotfix--2026-09-07).

## Copilot observation follow-up

The published [`0.2.4-hotfix.3` prerelease](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-07.3) restores Copilot's retained model through its
read-only native model snapshot on attachment and observes later root model
changes. It also keeps a session working across `assistant.idle`, which may
still have background agents or attached shell commands, until `session.idle`.
No wire, native dependency, transport or migration boundary changes. The source passes all 655 tests and packed-consumer checks; no native-model
qualification is claimed. See the [checkpoint](../checkpoint-v4.md#copilot-observation-hotfix--2026-09-07) for the exact artifact and test boundaries.

## Urgent session hotfix

The owner authorized incremental hotfix deployment, followed by broad checks
without model calls. The immutable `0.2.4-hotfix.2` GitHub prerelease fixes runtime
liveness after restart and adds bounded newest-first native history reads with
explicit unavailable-item markers. It also permits an explicit runtime listener
address on hosts with many network interfaces.

Deterministic Docker tree/100-session checks passed on the published source.
Current review source additionally passes CI, Windows startup, CodeQL and all
16 independent packed consumers. The
[checkpoint](../checkpoint-v4.md#urgent-session-hotfix-evidence-2026-09-07) records
the separate immutable artifact and tested-source identities. Published reference
executables still print `0.2.3` for `--version`; their package manifests correctly
identify the hotfix. Current source fixes that reporting issue, without replacing
the published bytes. This prerelease has no native-model qualification or stable
promotion. Installed consumer facts and laptop UAT belong to the personal repository.

## Embedded locator refresh release

The published `0.2.3` patch adds a lifetime-fenced `createTicket()` accessor to
`ControlNodeReadyInfo`, so trusted application composition can publish fresh
reachability locally while retaining the running control's identity. The method
exposes no key and is unavailable after shutdown. Wire protocol, native pins,
transport and migrations remain unchanged. See
[gateway embedding](Clients-and-Gateway-Embedding.md#embedding-a-gateway).
The owner explicitly waived model-using qualification for `0.2.3`. Exact-source
non-model gates, signed-tag validation, artifact verification and publication
passed. See the [checkpoint](../checkpoint-v4.md#embedded-locator-release-2026-09-07)
for immutable evidence and the [release exception](Releases.md#tag-and-publication-flow).

Suggested first prompt for a new session:

> Read `AGENTS.md` and `docs/wiki/Current-State.md`, inspect the current Git
> status and commits since `v0.2.3`, then summarize the relevant maintained
> boundary before changing anything. Use the topical guide and deep design only
> for the package you will touch, and preserve unrelated worktree changes.

## Release and compatibility baseline

| Boundary | Current value |
| --- | --- |
| Wire protocol | `6` in maintained source; coordinated upgrade required from protocol v5 |
| Signed stable release | [`v0.2.3`](https://github.com/arduano/agent-multiplex/releases/tag/v0.2.3), protocol v5; later published hotfix prereleases are recorded above |
| Signed release commit | `7b9d3e383fceb299cf3c1f1404358466abe7be23` |
| Public package graph | 16 released lockstep `@arduano/agent-multiplex-*` packages at `0.2.3` |
| Node runtime / release toolchain | Node `>=24`; releases use Node `24.19.0` and npm `11.17.0` |
| Node transport | Released v5 graph: `@arduano/p2prpc-core@0.2.1`; current v6 source pins published `0.3.0-renewal.0` |
| Native package pins | Codex CLI `0.152.0`; Copilot SDK `1.0.14` and optional CLI `1.0.88`; GPT-6 Sol availability is publicly documented but not account-qualified here |
| Qualified deployment | Linux x86-64 containers; Windows x64 Copilot startup with private local state |

The signed `v0.2.3` release adds the embedded control-ticket accessor. It retains
the Copilot permission controls introduced in `v0.2.2` and its exact native pins.
CI, Windows startup, CodeQL, deterministic Docker checks, independent package
consumers and artifact publication passed without model prompts. The owner waiver
is separate from a passing native-model receipt. The
[checkpoint](../checkpoint-v4.md#embedded-locator-release-2026-09-07) owns release
identities, workflow links and artifact verification.

The signed release facts in the preceding paragraphs remain protocol-v5
history. Protocol-v6 source advances the transport pin to `0.3.0-renewal.0`;
native pins are unchanged and new control/runtime migrations are unreleased.
The prior `v0.2.1` Windows patch had an owner-authorized five-minute native soak;
that evidence remains historical and does not requalify later patches or the transport
renewal boundary.
GitHub Packages requires an authenticated client with `read:packages`, even for
public packages.

Protocol-v2 `host`, `worker`, `observer`, and `Fleet` code is archived evidence.
Protocol v6 peers reject protocol-v5 and earlier peers. Upgrade controls,
runtimes, gateways, clients, and adapters together. There is no wire
compatibility shim or `sessions.spawn` network procedure. SQLite migrations are
explicit and transactional; see
[upgrade guidance](Backups-Upgrades-and-Recovery.md).

## The system in one diagram

```text
CLI / web / mobile / bespoke dashboard
                  |
          HTTP + WebSocket
                  |
      access gateway (zero authority)
          /          |          \
       p2prpc      p2prpc      p2prpc
        /             |            \
 authority control   branch      another realm
        |              |
        +---- strict control tree ----+
                       |
                  runtime nodes
                  /           \
          Codex app server   Copilot SDK
```

The data roles, not the process names, define the architecture:

- A **control node** owns the canonical logical-session catalog, flat
  namespaced JSON metadata, topology, authority epoch, durable operations, and
  control feed. Controls form a strict tree; an attached child has one parent.
- A **runtime node** owns native processes and bindings, provider checkpoints,
  launch/archive/command journals, metadata outbox, tombstones, and ephemeral
  PTYs. One runtime connects to one control.
- An **access gateway** owns no domain data. It validates and selects one or
  more control-source projections, suppresses a redundant descendant when its
  ancestor is selected, and routes authorized suggestions. Gateways cannot be
  chained.
- A **harness adapter** preserves Codex or Copilot's native models, modes,
  events, interactions, commands, and history semantics. It does not invent a
  flattened transcript protocol.

Network loss changes availability, never authority. Partial overlap, sibling
identity duplication, incompatible authority epochs, stale boot/binding
generations, and immutable-record forks fail closed. Read the
[data-role design](../design/data-roles-v4.md) before changing these rules.

## Settled product boundaries

- Session creation is the durable `launches.create` flow. The caller chooses an
  exact runtime, harness, and launch-profile identity; core does not schedule.
- The built-in `core.direct/workspace` profile starts Codex or Copilot in an
  existing runtime-local allowed directory and advertises no isolation.
- Domain creation workflows belong in a statically composed gateway plugin and
  matching runtime launch provider/backend. A PR reviewer may validate a PR at
  the gateway, prepare a worktree/container at the runtime, then invoke the
  ordinary launch flow. There is no dynamic plugin marketplace or sandbox.
- Metadata is one flat namespaced key/value document. Values may be any JSON
  value. Both clients and runtime-side integrations propose fenced CAS changes;
  only the current control authority assigns canonical revisions.
- User-visible lifecycle is explicit: **running** and **stopped** remain in hot
  lists; **archived** is cold, searchable authority data after resource release.
  Stop preserves resumability. Archive is never inferred from age, inventory,
  or connectivity, and there is no unarchive/restore operation yet.
- Copilot work lifecycle is a separate runtime-owned evidence state. Session
  rows and `sessions.readLifecycle` expose its bounded host view with status,
  typed health and action availability. Private dimensions and cursors stay at
  the runtime. Offline and Unknown remain distinct, and delivery/settlement
  never derives from transcript text or elapsed time.
- Native history is always requested from the owning Codex app server or
  Copilot SDK. Never parse vendor session files or promote terminal scrollback
  into history.
- An ambiguous external effect is `outcomeUnknown`. Reconcile the same stable
  operation ID and provider resource identity; never issue a blind replacement
  request.
- Images use a bounded runtime-owned byte store. Native payloads carry image
  descriptors and exact JSON pointers; clients interpret the native shape.
  Uploads and first-display file snapshots remain immutable until archive.
  Runtime code neither fetches external URLs nor renders or converts SVG.
  See [images and native payloads](Images-and-Native-Payloads.md).
- A managed terminal is an optional runtime-owned escape hatch for a session
  already bound to Multiplex. Its bytes, screen, viewers, and keyboard lease are
  bounded memory-only state, not catalog or history data.

See [lifecycle, metadata, and search](Lifecycle-Metadata-and-Search.md) and
[paired launch extensions](Paired-Launch-Extensions.md) for the corresponding
state machines and extension contracts.

## Implemented surface

- Durable launch, resume, stop, archive, metadata, and at-most-once native
  command operations with retry-stable identities and recovery fences.
- Protocol-v6 Copilot lifecycle reducer/projections, runtime persistence,
  proactive revision-fenced task/queue observations, exact native delivery
  correlation where the SDK supplies identity, and routed
  `sessions.readLifecycle` snapshot/native-cursor handoff.
- Typed, fixed-message generic command errors with certainty-preserving
  runtime/control migrations and original-ID read-only receipt recovery.
- Running/stopped default search plus explicit archived search, bounded pages,
  stable query-bound cursors, activity/profile/runtime/harness filters, and
  structural metadata predicates.
- Strict control trees, recursive routing/search, queued branch metadata,
  gateway ancestor suppression, warm-source failover, and conflict detection.
- Reconnecting p2prpc node links with independently pinned endpoint identities;
  tickets are locators, not trust anchors.
- Codex native spawn/resume, history, prompt/steer/interrupt, model,
  collaboration/plan mode, reasoning effort, turn settings, approvals,
  `request_user_input`, events, and shared-app-server TUI attachment.
- Copilot SDK spawn/resume, history, prompts, modes, interrupts, interactions,
  events, and runtime-local OpenAI-compatible BYOK configuration. Its stock TUI
  bridge is opt-in and experimental.
- Copilot native `permissions.mode`, published since `0.2.2`, exposes its
  acknowledged setting separately from agent mode; see the
  [adapter guide](Adapters-and-Terminals.md#copilot) for semantics.
- Bounded image upload/read/path resolution across the control tree, immutable
  runtime retention, native image references, browser/CLI attachments, and
  authenticated Markdown image previews.
- A zero-authority multi-source gateway, operator CLI, React web workspace,
  browser-safe client package, and Node-only direct p2prpc client.
- Hardened single-writer SQLite stores with application IDs, immutable migration
  ledgers, integrity checks, WAL, backup/checkpoint APIs, and role-specific
  ownership.

## Find the owning code quickly

| Change | Start here | Then read |
| --- | --- | --- |
| Wire schema or tRPC contract | [`packages/protocol/src`](../../packages/protocol/src) | [Data roles](../design/data-roles-v4.md) |
| Copilot work lifecycle/reducer | [`packages/protocol/src/lifecycle.ts`](../../packages/protocol/src/lifecycle.ts), [`packages/runtime-node-core/src/lifecycle.ts`](../../packages/runtime-node-core/src/lifecycle.ts) | [Lifecycle design](../design/copilot-session-lifecycle-vnext.md) |
| Catalog, authority, tree, metadata | [`packages/control-node-core/src`](../../packages/control-node-core/src) | [Architecture](Architecture-and-Data-Roles.md) |
| Bindings, providers, commands, PTYs | [`packages/runtime-node-core/src`](../../packages/runtime-node-core/src) | [Launch extensions](../design/launch-extensions-v4.md) |
| Multi-source selection and routing | [`packages/gateway-core/src`](../../packages/gateway-core/src) | [Client/gateway embedding](Clients-and-Gateway-Embedding.md) |
| Node transport | [`packages/transport-p2prpc/src`](../../packages/transport-p2prpc/src) | Separate [`arduano/p2prpc`](https://github.com/arduano/p2prpc) repository |
| Codex or Copilot native behavior | [`packages/adapter-codex`](../../packages/adapter-codex), [`packages/adapter-copilot`](../../packages/adapter-copilot) | [Adapters and terminals](Adapters-and-Terminals.md) |
| Browser/HTTP/WS client behavior | [`packages/client/src`](../../packages/client/src) | [Client/gateway embedding](Clients-and-Gateway-Embedding.md) |
| Process composition/configuration | [`apps`](../../apps) | [Install](Install-and-Authenticate.md) and [operations](Operations.md) |
| React operator UI | [`apps/web`](../../apps/web) | [UI skill](../../.agents/skills/agent-multiplex-ui/SKILL.md) |

`apps/host` and `packages/host-core` are outside the active workspaces. Do not
repair or import them to solve a maintained task.

## Start a new work session

1. Read this page and the root `AGENTS.md`.
2. Inspect rather than assume local state:

   ```bash
   git status --short --branch
   git log --oneline --decorate -12
   git diff --stat v0.2.1...HEAD
   ```

3. Pick the owning role/package from the table above, then read only its topical
   guide and deep design. Inspect current source and focused tests before
   editing; generated `dist` output and archived documents are not source truth.
4. Run the nearest focused test while iterating. Before handing off a maintained
   boundary, run:

   ```bash
   npm run check:docs
   npm run check:release
   npm run typecheck
   npm test
   npm run check:checkpoint
   ```

5. Use deterministic Docker tree/scale qualification for cross-role changes.
   Run real Codex/Copilot qualification only when native behavior is affected
   and model-credit use is authorized. A run counts only with a scrubbed,
   checksummed passing receipt from the exact source/dependency boundary.

## Released protocol-v5 scope

This section is historical release context. The `0.2.0` source adds bounded
runtime-owned images, native image envelopes,
client attachments, and appended control/runtime SQLite migrations. It also
hardens launch admission/recovery, Codex RPC lifecycle, runtime shutdown, and
image-queue lifecycle delivery. Runtime component injection, control readiness
callbacks, and gateway HTTP composition support separately owned applications.
Transport and native pins remain unchanged. Upgrade controls, runtimes, gateways,
and clients together; do not mix these packages with v4 peers.

See [lifecycle](Lifecycle-Metadata-and-Search.md),
[adapters](Adapters-and-Terminals.md), and [operations](Operations.md) for the
updated behavior, and [images](Images-and-Native-Payloads.md) for the image API.

## Current qualification evidence

The exact `v0.2.3` signed source passed CI, Windows startup, CodeQL, deterministic
Docker tree/mock scale and immutable publication. All 16 downloaded tarballs
match the release checksums and build-provenance attestations. The owner-created
exact-commit status separately waives native-model qualification for this patch.
No native-model receipt is claimed; earlier evidence retains its original scope.

These receipts predate the protocol-v6 lifecycle boundary. They do not qualify
its reducer, migrations, routed lifecycle query, browser projection, typed
command errors, or transport-renewal contract.

The [0.2.3 checkpoint](../checkpoint-v4.md#embedded-locator-release-2026-09-07)
owns exact identities and digests. Corporate auth/network and physical laptop
outage behavior remain consumer device verification. `receipts/` remains local
and gitignored.

## Deliberate limitations and likely next work

- The trust model is personal/internal shared-secret enrollment plus scoped
  gateway bearers, not public multi-tenant identity or tenant isolation.
- There is no generic scheduler, quota manager, worktree/container policy,
  cross-machine live-session migration, archived-session restore, or graceful
  online detach protocol in core.
- A shared app server is a shared failure/trust domain. Honest per-session
  isolation must place the app server and adapter endpoint inside the isolated
  backend.
- Codex app-server transport is upstream-experimental. Copilot's hidden stock-
  TUI server is more experimental and remains disabled by default.
- Linux x86-64 Docker is qualified. Native Windows is not supported by the
  current Unix-socket Codex supervisor. The Copilot Windows x64 startup path now
  has explicit DACL validation and a separate no-model Windows CI smoke; it is
  separately qualified from the live Linux model run. Corporate auth/network behavior
  still requires laptop UAT, and Windows native output-image paths remain
  unsupported. See [Windows embedding](Install-and-Authenticate.md#windows-copilot-embedding).
- Bespoke launch providers need their own validation, crash-boundary,
  idempotent cleanup, resume/history/archive, and end-to-end tests.
- General file attachments remain deferred; the current attachment surface
  supports images.
- The pinned Copilot SDK supplies no universal caller causal ID, complete
  pending-interaction hydration after resume, native task/queue snapshot cursor,
  or per-command settlement event. Protocol v6 preserves those unknowns and
  correlates display/consumption only when the exact native message identity is
  present.
- Full lifecycle state stays private to the runtime. Catalog streams and the
  public read carry the same compact view; the reference web consumes that view.
- The independently published p2prpc renewal release is pinned in this local
  graph. Final published framework/consumer graph and installed-host
  qualification remain open.

Protocol v6 is an explicit compatibility boundary; released v4/v5 evidence
remains historical. There is no partially adopted v2/v3 architecture to finish.
New work should preserve the boundaries above or make
an explicit protocol/design change with tests and migration consequences.

## Documentation authority

- This page owns **current state and fresh-session context**.
- Wiki topic pages own **operator and integration guidance**.
- `docs/design/` owns **deep behavioral invariants**, including the v5 image
  design and the protocol-v6 Copilot lifecycle design; older maintained design
  filenames remain stable for links.
- `docs/checkpoint-v4.md` owns **release qualification evidence**.
- `docs/deployment-v4.md` owns **the detailed personal deployment runbook**.
- `docs/research` and explicitly archived v2/v3 documents are historical input,
  not maintained implementation truth.

When a boundary changes, update its owner and link here instead of copying a
second detailed contract into this page.

## Personal application consumer

[`arduano/leo-multiplex`](https://github.com/arduano/leo-multiplex) is the separate
personal application. Its laptop fallback candidate consumes the published `0.2.3`
artifact graph; installed consumer status belongs to that repository. The framework now supplies Windows private-state/DACL support
and a trusted static runtime path-policy hook. The personal host can admit
operator-selected directories across C:, D: and UNC shares without broadening
the default framework root fence; see [embedded policy guidance](Paired-Launch-Extensions.md).
Native Windows Codex supervision and output-image paths remain unsupported.

Published-artifact Windows installation, saved launcher/rerun, host registration,
restart and work-command qualification belong to the consumer's runbook and CI.
Corporate Copilot auth/network and physical laptop behavior remain operator UAT.
The consumer records its laptop and NAS gateway deployment separately. Personal
Codex hosts and sessions were not restarted for this Copilot patch. Host
catalogs remain local; the NAS personal web/gateway has no metadata authority.
Provider, UI, authentication and deployment policy remain in the personal repo.
