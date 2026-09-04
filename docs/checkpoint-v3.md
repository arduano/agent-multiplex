# Protocol-v3 consolidation checkpoint

Status: superseded historical checkpoint as of 2026-09-04. The maintained
boundary is [`checkpoint-v4.md`](checkpoint-v4.md).

This document is the handoff between the completed transport/data-authority
work and the next audit of domain-specific APIs. It records what is intentional
today, what is verified, and what must not accidentally become a compatibility
promise.

## Maintained system

The active product is a protocol-v3 control plane with three data roles:

| Role | Owns | Does not own |
| --- | --- | --- |
| Control node | canonical metadata, catalog, authority epoch, topology and immutable control feed in SQLite | agent processes or terminal bytes |
| Runtime node | native app servers/SDKs, session bindings, command journal, metadata outbox and ephemeral managed PTYs | canonical metadata decisions |
| Access gateway | source health/cursors and a selected multi-source projection | any domain authority or native agent state |

Control nodes form a tree. A runtime belongs to one control node. A gateway can
observe one or more independently pinned control nodes and selects a strict
ancestor over an overlapping descendant. Gateways never serve as sources to
other gateways. This keeps the authority graph a tree while allowing many
zero-authority clients and presentation layers.

The active code boundary is the 15 workspaces listed in the root
`package.json`. `apps/host` and `packages/host-core` are archived protocol-v2
source. They are intentionally absent from npm workspaces, the TypeScript
project graph, Vitest, Docker build contexts, and v3 package output.

## API boundary at this checkpoint

The fact that an operation is currently reachable through the tRPC router does
not mean its product policy is frozen. Use these categories during the next
audit.

### Core distributed contract

- Logical IDs, boot IDs, binding revisions, topology lineage and authority
  fences.
- Control/runtime descriptors, inventory reconciliation and reachability.
- JSON key/value metadata snapshots, compare-and-set proposals, outbox
  settlement and operation status.
- Bounded cursor streams, explicit gaps, source selection and recursive
  routing.
- At-most-once command journaling and explicit `outcomeUnknown` results.
- Pending interaction publication and one routed resolution.
- Native-history delegation to the harness, without reading history files.
- The separately scoped, ephemeral terminal side channel.

Changes here require protocol-version and migration reasoning.

### Harness-native capability surface

- Codex and Copilot command unions, model identifiers, reasoning controls and
  modes.
- Harness-native approval/question response shapes.
- Adapter inventory, model discovery, resume, event translation and native
  history calls.
- Codex's managed shared app-server/TUI topology and Copilot's opt-in
  experimental UI-server topology.

These are typed and routed end to end, but remain versioned against their
native harness. They should not be flattened into a pretend universal agent
API.

### Provisional domain-policy surface

- `sessions.spawn` and its harness-specific spawn options.
- Who selects a runtime, directory, model, mode and initial metadata.
- Workspace/worktree preparation, repository admission and cleanup.
- Placement, quotas, scheduling, retries and agent naming.
- Runtime-local adapter enablement, credentials, provider configuration and
  policy defaults.
- Which resumable native sessions should be imported or exposed.

The reference implementation currently lets the caller name a runtime node,
harness and existing absolute `cwd`. The runtime canonicalizes the path,
enforces its configured allowed roots, rejects credential-bearing provider
overrides, calls the selected adapter once, binds the returned vendor session,
and reports the result through the command journal. It does not create a
worktree, allocate a machine, choose organization policy, or retry an ambiguous
native launch.

That simple launch path is useful for the PoC, but its request shape and UI are
the explicit subject of the next audit. Embedders should treat it as a
reference extension point rather than the minimum common denominator.

## Persistence and ownership invariants

- Control, runtime and gateway stores have different SQLite application IDs,
  schema version 3, strict tables, WAL, full synchronization, integrity checks,
  explicit backup/checkpoint APIs and a process-lifetime single-writer guard.
- A disconnect affects presence only. It cannot detach a branch or create a
  metadata authority.
- Runtime and recursive routes carry process/attachment fences. Superseded
  edges cannot commit through an old connection.
- Native session history is always fetched from the Codex app server or
  Copilot SDK. Multiplex never parses rollout/history files.
- Terminal bytes, replay screens and keyboard credentials are memory-only.
  Runtime restart intentionally loses them.
- Provider credentials and bearer/shared secrets remain outside catalog data,
  projections, event payloads and receipts.

## Verified baseline

The clean consolidation build and full local suite pass 50 files and 344
tests. The preceding mixed real-harness acceptance receipt is:

`receipts/protocol-v3-live-four-container/20260904T043102Z-d81cca90e079`

Its `checks.json` reports every check true. It covers one authority, one
zero-authority gateway, separate Codex and Copilot runtimes, UI-driven spawn,
streaming chat, model/mode changes, plan questions, interrupts, metadata CAS,
native history, a two-viewer Codex terminal lifecycle, responsive/accessibility
checks, and terminal-data ephemerality. All 78 receipt checksums were verified.

Other maintained deterministic acceptance targets are:

- `npm run test:docker:v3:mock:scale` — 10 runtime containers and 100 mock
  sessions with concurrent traffic and reconnects.
- `npm run test:docker:v3:tree` — authority/branch routing and overlapping
  gateway-source selection.
- `npm run test:docker:v3:live:four` — the credit-consuming mixed native stack.

The older `tests/docker-{codex-e2e,codex-interactive-e2e,copilot-*}` and
`tests/docker-nested-hosts` harnesses target the archived host/worker protocol.
They are retained as evidence only and are not expected to build against v3.

## Known limitations accepted at the checkpoint

- OpenAI still describes the Codex app-server command/WebSocket transport as
  experimental. The tested CLI is pinned to `@openai/codex@0.152.0`.
- Copilot's stock TUI cannot supportedly attach to a headless SDK runtime. Its
  exact-version hidden UI-server integration stays disabled by default.
- Shared-secret enrollment is suitable for trusted personal/internal
  deployments, not multi-tenant identity or public ingress.
- Online graceful detach intentionally fails closed pending a durable
  prepare/drain/commit protocol. Force-detach and promotion are explicit
  operator recovery actions.
- Runtime processes and native sessions do not migrate between machines.
- The 100-session result validates the protocol/control path with mock agents;
  it is not a capacity claim for 100 real model processes.
- There is no repository-level Git history at this filesystem root. This is a
  reproducible clean state, not an immutable commit or tag.

## Reproduction and hygiene

From the repository root:

```bash
npm ls --workspaces --depth=0
npm ci --dry-run --ignore-scripts
npm test
```

`npm run build`, `npm run typecheck`, and `npm test` physically remove every
active workspace `dist/` first. This prevents removed or renamed modules from
surviving TypeScript's incremental clean and leaking into packages or Docker
images. `npm run check:checkpoint` then verifies workspace/lockfile alignment,
package entry points, archive isolation, the relative `../p2prpc` dependency,
and that every compiler output corresponds to current source.

Codex bindings in `packages/adapter-codex/src/generated` are generated, not
hand-maintained. For the pinned version, this command must produce a byte-for-
byte identical tree:

```bash
node_modules/.bin/codex app-server generate-ts --experimental \
  --out packages/adapter-codex/src/generated
```

The v1 transport remains a file dependency on `../p2prpc/packages/core`, tested
from the sibling checkout at commit
`6220c97d2ec5a3fd463c4265d059e4f5896c1ec1`. That checkout currently has
local changes, so the commit alone is not a complete immutable transport
provenance record; preserve or commit both repositories before calling this a
release snapshot.
