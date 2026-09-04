# Agent Multiplex

Agent Multiplex is a private, distributed control plane for Codex and GitHub
Copilot agent sessions. It keeps native app servers on runtime machines while
presenting one typed access API to CLIs, browsers, mobile clients, or another
internal dashboard.

This repository implements protocol v4. Protocol-v2 `host`, `worker`,
`observer`, and `Fleet` APIs are deliberately not compatibility aliases.
The maintained surface, launch extension boundary, and deliberate limitations
are recorded in [`docs/checkpoint-v4.md`](docs/checkpoint-v4.md).

## Documentation

Start with the [operator and developer wiki](docs/wiki/Home.md). Its focused
guides cover:

- [installation and authentication](docs/wiki/Install-and-Authenticate.md),
  [supported environments](docs/wiki/Packages-and-Environments.md), and
  [architecture/data roles](docs/wiki/Architecture-and-Data-Roles.md);
- [client and gateway embedding](docs/wiki/Clients-and-Gateway-Embedding.md) and
  [paired gateway/runtime launch extensions](docs/wiki/Paired-Launch-Extensions.md);
- [session lifecycle, metadata, archive, and search](docs/wiki/Lifecycle-Metadata-and-Search.md)
  plus [adapters and terminal behavior](docs/wiki/Adapters-and-Terminals.md);
- [operations](docs/wiki/Operations.md),
  [backup/upgrade/recovery](docs/wiki/Backups-Upgrades-and-Recovery.md),
  [security](docs/wiki/Security.md),
  [troubleshooting](docs/wiki/Troubleshooting.md), and
  [release qualification](docs/wiki/Releases.md).

The wiki is the concise entry point. The v4 checkpoint, design documents, and
deployment runbook remain the normative deep references.

## Data roles

```text
CLI / browser / internal dashboard
              |
        HTTP + WebSocket
              |
   access gateway (zero authority)
        /       |        \
      p2prpc  p2prpc    p2prpc
       /         |          \
 control node  branch    control node
 (authority)     |       (other realm)
       |         |
       +--- p2prpc tree ---+
                 |
             p2prpc
                 |
              runtime nodes
          /                       \
 Codex app-server + PTY     Copilot SDK (+ PTY opt-in)
```

- A **control node** owns a durable SQLite catalog. It is either the metadata
  `authority`, an explicitly attached `branch`, or an explicitly detached
  branch. A network failure changes presence only.
- A **runtime node** owns agent processes, native session handles, and its own
  SQLite command/binding/outbox state. Native history is always read through
  the Codex or Copilot app server; Agent Multiplex does not parse history files.
  It may also expose a managed, ephemeral PTY for a bound native session.
- An **access gateway** has no data authority. It can observe one or more
  control nodes, select non-overlapping projections, and propose actions. A
  strict ancestor projection suppresses an overlapping descendant source.
  Immutable overlap forks and duplicate domain identities fail closed instead
  of being merged.
- A **source** is one gateway-to-control-node connection. Gateways do not proxy
  other gateways. Control nodes form a tree, never a DAG.

The detailed invariants are in
[`docs/design/data-roles-v4.md`](docs/design/data-roles-v4.md). Domain-specific
launch composition is described in
[`docs/design/launch-extensions-v4.md`](docs/design/launch-extensions-v4.md).

## Repository layout

| Path | Responsibility |
| --- | --- |
| `packages/protocol` | Protocol-v4 Zod schemas and tRPC contracts |
| `packages/control-node-core` | Authoritative/branch SQLite catalog, recursive routing, fencing, metadata CAS |
| `packages/runtime-node-core` | Static launch-provider/backend registry, durable launch/archive/command journals, bindings, path policy, native stream, terminal broker |
| `packages/gateway-core` | Multi-source validation, ancestor selection, routing, synthetic stream, restricted launch-plugin port |
| `packages/transport-p2prpc` | Authenticated, endpoint-pinned bindings to `@arduano/p2prpc-core` |
| `packages/client` | Browser-safe HTTP/WS access client and retry/cursor helpers |
| `packages/client-p2prpc` | Node-only direct p2prpc control-source client |
| `packages/adapter-{codex,copilot,mock}` | Native harness adapters |
| `apps/control-node` | Reference control-node daemon and trusted-local HTTP edge |
| `apps/runtime-node` | Reconnecting runtime daemon |
| `apps/gateway` | Zero-authority multi-source HTTP/WS edge |
| `apps/cli`, `apps/web` | User-facing access clients |

The old `apps/host` and `packages/host-core` directories are historical v2
source only. They are excluded from workspaces, builds, tests, and packaged
artifacts. Their local READMEs explain the archive boundary; do not repair or
import them as part of v4 work.

## Requirements

- Node.js 24 or newer
- Read access to the `@arduano` scope on GitHub Packages; the transport pins
  `@arduano/p2prpc-core` exactly
- An authenticated Codex installation on each Codex runtime node
- `@github/copilot` credentials, or an explicitly configured compatible BYOK
  provider, on each Copilot runtime node

GitHub's npm registry requires authentication even when a package is public.
Keep the token out of the repository and configure it in your user npm config
or secret manager with `read:packages` access:

```ini
@arduano:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Then install and verify the locked graph:

```bash
npm ci --strict-allow-scripts
npm run check:docs
npm run check:release
npm run typecheck
npm test
npm run check:checkpoint
```

`build`, `typecheck`, and `test` start from physically empty workspace `dist/`
directories. This matters because TypeScript's incremental clean cannot find
outputs whose source modules were renamed or removed. `check:checkpoint`
verifies the exact active workspace/lockfile set, package entry points, pinned
p2prpc package, archive exclusion, and absence of orphaned compiler output.

The sibling `../p2prpc` checkout remains the source-level development and
qualification boundary for transport changes, but a releasable Multiplex tree
never uses a `file:` dependency. Publish and qualify a new immutable p2prpc
version first, then update this repository's exact dependency and lockfile. See
[`docs/deployment-v4.md`](docs/deployment-v4.md) for the reproducible workflow.

## Local bootstrap

Use one randomly generated shared secret of at least 32 UTF-8 bytes for the
nodes in a trust domain. Enrollment flags are temporary bootstrap apertures;
turn them off after the relevant endpoint identities are persisted.

### 1. Start an authority control node

```bash
export AGENT_MULTIPLEX_SHARED_SECRET='replace-with-at-least-32-random-bytes'
export AGENT_MULTIPLEX_CONTROL_NODE_NAME='laptop-authority'
export AGENT_MULTIPLEX_CONTROL_NODE_ALLOW_RUNTIME_NODE_ENROLLMENT=1
export AGENT_MULTIPLEX_CONTROL_NODE_ALLOW_CHILD_CONTROL_NODE_ENROLLMENT=1
export AGENT_MULTIPLEX_CONTROL_NODE_ALLOW_ACCESS_GATEWAY_ENROLLMENT=1
export AGENT_MULTIPLEX_CONTROL_NODE_ACCESS_GATEWAY_SCOPES='["read","agent-launch","agent-archive","agent-control","terminal-view","terminal-control","metadata-propose"]'
npm run dev:control-node
```

Preserve both `.agent-multiplex/control-node.sqlite` and its `.identity` file.
The first is domain state; the second pins the Iroh endpoint identity. The
direct HTTP endpoint is intentionally unauthenticated and therefore accepts
only an explicit loopback IP bind.

### 2. Start a runtime node

Copy the printed control-node endpoint ID and ticket over a trusted channel:

```bash
export AGENT_MULTIPLEX_SHARED_SECRET='replace-with-at-least-32-random-bytes'
export AGENT_MULTIPLEX_CONTROL_NODE_ENDPOINT_ID='<control P2P endpoint>'
export AGENT_MULTIPLEX_CONTROL_NODE_TICKET='<control reachability ticket>'
export AGENT_MULTIPLEX_RUNTIME_NODE_NAME='build-machine-1'
export AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS='["/work"]'
export AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES='codex,copilot'
npm run dev:runtime-node
```

The runtime persists its logical ID, Iroh key, bindings, metadata outbox, and
command journal below `AGENT_MULTIPLEX_RUNTIME_NODE_STATE_DIR` (default
`.agent-multiplex/runtime-node`). A ticket is only a locator; the separately
configured endpoint ID is the trust anchor.

### 3. Start an access gateway

`AGENT_MULTIPLEX_ACCESS_GATEWAY_SOURCES` is a versioned JSON document. Each
entry independently pins a source endpoint and locator:

```bash
export AGENT_MULTIPLEX_SHARED_SECRET='replace-with-at-least-32-random-bytes'
export AGENT_MULTIPLEX_ACCESS_GATEWAY_SOURCES='{
  "version": 1,
  "sources": [{
    "sourceId": "laptop",
    "displayName": "Laptop authority",
    "endpointId": "<control P2P endpoint>",
    "locator": {"kind":"ticket","ticket":"<control ticket>"},
    "priority": 100,
    "requestedScopes": ["read","agent-launch","agent-archive","agent-control","terminal-view","terminal-control","metadata-propose"]
  }]
}'
npm run dev:gateway
```

An unauthenticated gateway is loopback-only. For a LAN or wildcard listener,
set `AGENT_MULTIPLEX_ACCESS_GATEWAY_BEARER_TOKEN_FILE` and explicit scopes;
credentials are accepted in HTTP `Authorization` and WebSocket connection
parameters, never URL query strings.

### 4. Use the CLI

The CLI defaults to the trusted-local control node on port 4317. Point it at a
gateway when using the multi-source edge:

```bash
npm run dev:cli -- --http-url http://127.0.0.1:4318/trpc sources
npm run dev:cli -- --http-url http://127.0.0.1:4318/trpc runtime-nodes
npm run dev:cli -- --http-url http://127.0.0.1:4318/trpc sessions
npm run dev:cli -- --http-url http://127.0.0.1:4318/trpc \
  spawn build-machine-1 codex /work/project --model gpt-5.6-sol
```

Run `npm run dev:cli -- --help` for prompts, steering, interrupts, model/mode
changes, interactions, native history, metadata, and streaming commands.

The CLI `spawn` command discovers an exact launch profile and submits a durable
`launches.create` operation. The built-in `core.direct/workspace` profile is a
deliberately small reference: the caller chooses a runtime node, harness, and
existing runtime-local absolute directory. Placement, worktree/container
creation, repository policy, and richer launch forms are statically composed
gateway plugins and runtime providers rather than protocol-core policy.

`sessions` searches running and stopped records by default. Add
`--state archived`, metadata predicates, provider/profile filters, or activity
windows for bounded cold search. `stop` preserves a resumable session;
`archive` is a separate asynchronous operation that releases backend and
provider resources before removing the record from hot lists.

### 5. Use the web workspace

The gateway serves the production React client at `/`. For local UI work, run
Vite against an existing gateway:

```bash
AGENT_MULTIPLEX_WEB_GATEWAY=http://127.0.0.1:4318 \
  npm run dev --workspace @arduano/agent-multiplex-web -- --host 127.0.0.1
```

For personal or local prototypes, the client accepts a bearer token in the
client-only URL fragment and connects immediately:

```text
http://127.0.0.1:5173/#token=<gateway-bearer-token>
```

Manual connections also update this fragment, making the current URL
bookmarkable across reloads. The fragment is excluded from HTTP requests and
`Referer` headers, but it remains visible to browser history, screenshots of
the address bar, extensions, and anyone who receives the URL. Do not use this
convenience link for shared or production deployments.

The authenticated workspace uses resizable three-pane navigation,
conversation, and inspector regions on desktop. Compact and mobile layouts
keep the conversation primary and expose navigation and inspection as
keyboard-accessible sheets. Agent settings remain harness-native; metadata is
edited as a versioned JSON key/value document; transcripts and history always
come from the native app-server APIs. A session's Terminal tab explicitly opens
or attaches to its runtime-owned PTY; it never opens automatically.

The terminal is an operational escape hatch, not another history source.
Several clients may watch the same bounded live stream, but only one renewable
keyboard lease may write or resize at a time. A read-only client needs
`terminal-view`; opening, taking the keyboard, typing, resizing, or terminating
a supported terminal needs `terminal-control`. Grant `read` as well if the
client must discover sessions. Terminal bytes, screen snapshots, and lease
secrets are memory-only and never enter SQLite, metadata, fleet snapshots,
normalized chat history, or `readNativeHistory`.

The maintained UI implementation contract lives in
[`.agents/skills/agent-multiplex-ui/SKILL.md`](.agents/skills/agent-multiplex-ui/SKILL.md)
and its linked style guide. Layout preferences use the browser-local
`agent-multiplex.ui.layout.v1` key.

## Attaching a branch control node

A desired parent stores three independent values: the parent logical control
node ID, its endpoint identity, and a reachability ticket.

```bash
export AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_ID='<parent control-node ID>'
export AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_ENDPOINT_ID='<parent P2P endpoint>'
export AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_TICKET='<parent ticket>'
npm run dev:control-node
```

Environment data bootstraps a genuinely unconfigured catalog once. Thereafter
the persisted desired upstream wins. An audited branch-local force-detach
clears it, and a stale environment cannot silently reattach a detached or
promoted node. The v4 MVP's online `topology.detach` mutation fails closed until
there is a real durable prepare/drain/commit protocol for graceful detach.

Detachment and promotion are explicit administrative mutations. Promotion is
allowed only after detachment and transactionally mints a fresh realm and
authority epoch. Disconnecting a process never performs either operation.

## Important configuration

### Control node

| Variable | Default |
| --- | --- |
| `AGENT_MULTIPLEX_CONTROL_NODE_STATE` | `.agent-multiplex/control-node.sqlite` |
| `AGENT_MULTIPLEX_CONTROL_NODE_IDENTITY` | `<state>.identity` |
| `AGENT_MULTIPLEX_CONTROL_NODE_NAME` | machine hostname |
| `AGENT_MULTIPLEX_CONTROL_NODE_HTTP_BIND` | `127.0.0.1` |
| `AGENT_MULTIPLEX_CONTROL_NODE_HTTP_PORT` | `4317` |
| `AGENT_MULTIPLEX_CONTROL_NODE_P2P_BIND` | optional stable `IP:UDP-port` for restart-safe ticket reachability |
| `AGENT_MULTIPLEX_CONTROL_NODE_RUNTIME_STALE_MS` | `30000` |
| `AGENT_MULTIPLEX_CONTROL_NODE_CHILD_STALE_MS` | `30000` |
| `AGENT_MULTIPLEX_CONTROL_NODE_ACCESS_GATEWAY_SCOPES` | `["read"]` |
| `AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_HEARTBEAT_MS` | `10000` |
| `AGENT_MULTIPLEX_CONTROL_NODE_RECONNECT_MAX_MS` | `30000` |

### Runtime node

| Variable | Purpose |
| --- | --- |
| `AGENT_MULTIPLEX_CONTROL_NODE_ENDPOINT_ID` | independently trusted control endpoint |
| `AGENT_MULTIPLEX_CONTROL_NODE_TICKET` | bootstrap/fallback locator |
| `AGENT_MULTIPLEX_RUNTIME_NODE_STATE_DIR` | runtime identity and SQLite state |
| `AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS` | required JSON array of existing roots |
| `AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES` | `codex`, `copilot`, or both |
| `AGENT_MULTIPLEX_RUNTIME_NODE_ADAPTER_MODE` | `native` or test-only `mock` |
| `AGENT_MULTIPLEX_RUNTIME_NODE_MAX_RUNNING_TERMINALS` | in-memory PTY limit; default `32` |
| `AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_EXPERIMENTAL_UI_SERVER` | opt in to the stock Copilot TUI; default disabled |
| `AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_BINARY` | optional worker-local Copilot CLI path for the experimental TUI |

Copilot BYOK uses
`AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BASE_URL`, `_MODEL`, optional
`_MODELS`, `_WIRE_API`, `_TRANSPORT`, and exactly one of `_API_KEY_FILE` or
`_BEARER_TOKEN_FILE`. Secrets are read locally and never enter catalog data.

For Codex, one worker-local app server listens on a private Unix socket. The
structured adapter connects directly to the socket, while a managed stock TUI
uses `codex resume --remote` against the same server. Closing the TUI does not
close the structured session or shared app server. This is the maintained
Multiplex path, but OpenAI still labels the app-server command and WebSocket
transport experimental and unsupported for production workloads; the Codex
package is therefore pinned and must be requalified before upgrades. Copilot has no
supported stock-TUI attach command. Its terminal path is therefore an
explicitly experimental, exact-version-pinned CLI `1.0.81` integration using
hidden `--ui-server` and `--no-auto-update`; see the runtime-node README before
enabling it. If its startup probe fails, the runtime keeps the normal structured
Copilot adapter and advertises no Copilot terminal.

## Storage and failure semantics

- Control, runtime, and gateway SQLite files have distinct application IDs,
  immutable per-store migration ledgers, WAL, `synchronous=FULL`, foreign keys,
  strict tables, integrity checks, a lifetime single-writer lock, and
  backup/checkpoint APIs. Control and runtime stores migrate v3 data to v4;
  the unchanged gateway operational schema remains at its v3 target.
- Every authority metadata change, immutable feed event, and delivery intent is
  one transaction. Metadata proposals carry a complete realm/owner/epoch fence.
- Commands are dispatched at most once. Launch/archive operations are durably
  admitted and recover by stable ID. Any unprovable external effect becomes
  `outcomeUnknown`; it is not blindly retried.
- Runtime inventory generations change only when native inventory content
  changes, so frequent health polling does not amplify into catalog/feed churn.
- Runtime and child calls carry boot/attachment/lineage fences. Old process
  epochs and old tree edges cannot commit after replacement.
- Native output is bounded and resumable by native cursor where available.
  Gaps explicitly direct clients to `readNativeHistory`.
- PTY output has only bounded in-memory replay and a synthesized screen reset.
  Runtime restart loses terminals and leases; it does not fabricate terminal
  history from harness files or the native-history API.

This is intended for trusted internal or personal deployment. The shared-secret
bootstrap model is not a multi-tenant identity system; put a properly scoped
gateway and your normal network/identity controls at any organizational edge.

## Project policy

Agent Multiplex is available under the [MIT License](LICENSE). Third-party
agent runtimes, generated protocol declarations, fonts, icons, and dependencies
remain subject to their own terms; see [third-party notices](THIRD_PARTY_NOTICES.md).

Read [SECURITY.md](SECURITY.md) before exposing a gateway or sharing a receipt.
Contribution and support guidance lives under [`.github`](.github/CONTRIBUTING.md);
the [release guide](docs/wiki/Releases.md) covers packages, artifacts, and tags.
