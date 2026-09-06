# Current state and fresh-session handoff

Read this page after the root [`AGENTS.md`](../../AGENTS.md) when starting a new
coding-agent session. It is the single current-state summary. Follow only the
links for the role being changed; the rest of the wiki is topical guidance, and
the design documents are the deeper normative contracts.

Last reconciled: 2026-09-05.

Suggested first prompt for a new session:

> Read `AGENTS.md` and `docs/wiki/Current-State.md`, inspect the current Git
> status and commits since `v0.2.0`, then summarize the relevant maintained
> boundary before changing anything. Use the topical guide and deep design only
> for the package you will touch, and preserve unrelated worktree changes.

## Release and compatibility baseline

| Boundary | Current value |
| --- | --- |
| Wire protocol | `5`; coordinated upgrade required from v4 |
| Latest release | [`v0.2.0`](https://github.com/arduano/agent-multiplex/releases/tag/v0.2.0) |
| Signed release commit | `0e043478538a30a0a42fd854f5f5c8a14309cbf0` |
| Public package graph | 16 released lockstep `@arduano/agent-multiplex-*` packages at `0.2.0` |
| Node runtime / release toolchain | Node `>=24`; releases use Node `24.19.0` and npm `11.17.0` |
| Node transport | Exact public `@arduano/p2prpc-core@0.2.1` from the separate [`arduano/p2prpc`](https://github.com/arduano/p2prpc) repository |
| Qualified native boundaries | Codex CLI `0.152.0`; Copilot SDK `1.0.11` and optional CLI `1.0.81` |
| Qualified deployment | Linux x86-64 containers on a trusted personal/internal network |

The signed `v0.2.0` source passed all exact-commit release prerequisites and
publication completed successfully. The [checkpoint](../checkpoint-v4.md#protocol-v5-release-qualification-2026-09-05)
records its workflow and artifact evidence. The prior `v0.1.0` artifact audit
remains historical evidence there.
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
   git diff --stat v0.2.0...HEAD
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

The signed release has passing exact-SHA CI, CodeQL, deterministic Docker,
and owner-recorded native four-container qualification. The native run completed
the 930-second soak, including fresh Codex and Copilot replies afterward, and
removed its disposable containers, relay, and state. Its manifest records no
retained credential material.

The [v0.2.0 checkpoint section](../checkpoint-v4.md#protocol-v5-release-qualification-2026-09-05)
owns the source/tag identities, workflow links, receipt path, inventory digest,
and publication result. The [release guide](Releases.md) owns reproduction and
artifact-verification procedures. `receipts/` remains local and gitignored;
a fresh clone uses the tracked ledger and linked public workflow/status evidence.

Earlier image development receipts remain scoped to their recorded source and
checks. The final native release run qualifies the documented native control,
history, terminal, browser, and renewal behavior; it does not turn an earlier
failed image trial into passing final-source image evidence. The retained
100-session result exercises mock agents, not 100 simultaneous model processes.

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
  not part of the released Linux qualification. Corporate auth/network behavior
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

The Windows installation handoff is preparing a lockstep `0.2.1` patch release
from the Windows Copilot candidate. It preserves protocol v5, native/transport
pins and existing SQLite migration identities. `0.2.0` remains the public
release until the exact-source prerequisites and signed publication complete.
The release includes Windows private-state/DACL support and a static runtime
path-policy hook needed by the personal Windows installer. The personal app can
allow operator-selected directories across drives and UNC shares without
changing the default framework root fence. See
[embedded policy guidance](Paired-Launch-Extensions.md). It does not add Windows Codex supervision or Windows native
output-image path support. The owner authorized live model qualification with
a five-minute soak for this patch. It does not requalify the 15-minute transport
renewal boundary; the release minimum returns to 930 seconds for other versions. See
[release prerequisites](Releases.md#candidate-checklist).

Native Windows Copilot startup is prepared in
[PR #22](https://github.com/arduano/agent-multiplex/pull/22). Source
`96e2d3e165d7448dbf9cca41658a8467893fd5e7` passed
[Windows x64 CI](https://github.com/arduano/agent-multiplex/actions/runs/34011570520)
for protected DACLs, SQLite writer ownership/reopen, retained image uploads,
Iroh and unauthenticated Copilot SDK startup. The same run qualified the
personal consumer's control/runtime registration, graceful stop and restart
with enrollment closed against its exact recorded source. No native session or
model prompt was created. The framework receipt SHA-256 is
`fdf3eece8ef55ab4d4fa28c2870a048d7c788fa814346681ded909b7f1ea0a2a`.
This is source-candidate Windows startup evidence; the published `0.2.0` graph
is unchanged. Corporate OAuth/network/model UAT and Windows output-image path
reads remain outside this qualification. The personal Windows runbook owns the
installation release gate and complete consumer evidence.

[`arduano/leo-multiplex`](https://github.com/arduano/leo-multiplex) is the separate
personal application consumer of the `0.2.0` package graph. Main-pc owns its
control catalog and runtime; the NAS hosts only the personal web/gateway edge.
Provider, UI, authentication, and deployment policy belong to that repository.
Its deployment status and operator instructions are maintained there.
