# Current state and fresh-session handoff

Read this page after the root [`AGENTS.md`](../../AGENTS.md) when starting a new
coding-agent session. It is the single current-state summary. Follow only the
links for the role being changed; the rest of the wiki is topical guidance, and
the design documents are the deeper normative contracts.

Last reconciled: 2026-09-07.

Suggested first prompt for a new session:

> Read `AGENTS.md` and `docs/wiki/Current-State.md`, inspect the current Git
> status and commits since `v0.2.2`, then summarize the relevant maintained
> boundary before changing anything. Use the topical guide and deep design only
> for the package you will touch, and preserve unrelated worktree changes.

## Release and compatibility baseline

| Boundary | Current value |
| --- | --- |
| Wire protocol | `5`; coordinated upgrade required from v4 |
| Latest release | [`v0.2.2`](https://github.com/arduano/agent-multiplex/releases/tag/v0.2.2) |
| Signed release commit | `1baacd49d44f9fe3d10f52b5fab0a8175d35a508` |
| Public package graph | 16 released lockstep `@arduano/agent-multiplex-*` packages at `0.2.2` |
| Node runtime / release toolchain | Node `>=24`; releases use Node `24.19.0` and npm `11.17.0` |
| Node transport | Exact public `@arduano/p2prpc-core@0.2.1` from the separate [`arduano/p2prpc`](https://github.com/arduano/p2prpc) repository |
| Native package pins | Codex CLI `0.152.0`; Copilot SDK `1.0.13` and optional CLI `1.0.81`; model qualification waived for this patch |
| Qualified deployment | Linux x86-64 containers; Windows x64 Copilot startup with private local state |

The signed `v0.2.2` release is published. It adds native Copilot permission
controls and uses SDK `1.0.13`, whose `permissions.getMode/setMode` methods match
the retained CLI `1.0.81`. The owner explicitly waived model-using qualification
to unblock laptop YOLO use. Linux and Windows native permission RPC checks,
CI, CodeQL, deterministic Docker checks and artifact publication passed without
model prompts; this is not a passing model-qualification claim. The
[checkpoint](../checkpoint-v4.md#copilot-permissions-release-2026-09-07) owns exact
release identities and workflow evidence. See the
[release exception](Releases.md#tag-and-publication-flow).

Protocol v5, transport, native CLI pins and released migrations are unchanged.
The prior `v0.2.1` Windows patch had an owner-authorized five-minute native soak;
that evidence remains historical and does not requalify `v0.2.2` or the transport
renewal boundary.
GitHub Packages requires an authenticated client with `read:packages`, even for
public packages.

Protocol-v2 `host`, `worker`, `observer`, and `Fleet` code is archived evidence.
Protocol v5 peers reject v4 and earlier peers. Upgrade controls, runtimes,
gateways, and clients together. There is no wire compatibility shim or
`sessions.spawn` network procedure. SQLite v5 migrations are explicit and
transactional; see [upgrade guidance](Backups-Upgrades-and-Recovery.md).

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
- Current source also exposes Copilot native `permissions.mode` and its
  acknowledged setting separately from agent mode. The published baseline above
  does not yet include this additive command; see the
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

## Protocol-v5 release scope

The `0.2.0` source adds bounded runtime-owned images, native image envelopes,
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

The signed release passed exact-SHA CI, CodeQL, deterministic control-tree and
100-agent mock qualification, Windows startup, and native Copilot permission
RPC checks on Linux and Windows. The latter use isolated state, no credentials
and no model prompts. The owner-created exact-commit status explicitly waives
the model-using native four-container run for `v0.2.2`; it does not claim a
passing native-model receipt. Other releases retain the usual qualification
policy unless separately authorized.

The [0.2.2 checkpoint](../checkpoint-v4.md#copilot-permissions-release-2026-09-07)
owns source/tag identities, workflow links and artifact digests. Earlier native
soak evidence remains scoped to its original source. Corporate login, network,
share access and laptop suspend/recovery remain device UAT; the 100-session
result uses mock agents. `receipts/` remains local and gitignored.

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
- General file attachments remain deferred; the v5 attachment surface currently
  supports images.

Protocol v5 is an explicit compatibility boundary; the released v4 evidence
remains historical. There is no partially adopted v2/v3 architecture
to finish. New work should preserve the boundaries above or make
an explicit protocol/design change with tests and migration consequences.

## Documentation authority

- This page owns **current state and fresh-session context**.
- Wiki topic pages own **operator and integration guidance**.
- `docs/design/` owns **deep behavioral invariants**, including the v5 image
  design; older maintained design filenames remain stable for links.
- `docs/checkpoint-v4.md` owns **release qualification evidence**.
- `docs/deployment-v4.md` owns **the detailed personal deployment runbook**.
- `docs/research` and explicitly archived v2/v3 documents are historical input,
  not maintained implementation truth.

When a boundary changes, update its owner and link here instead of copying a
second detailed contract into this page.

## Personal application consumer

[`arduano/leo-multiplex`](https://github.com/arduano/leo-multiplex) is the separate
personal application. Its Windows/WSL installer consumes the published `0.2.2`
artifact graph. The framework now supplies Windows private-state/DACL support
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
