# Reference runtime node

The runtime node owns Codex and Copilot processes, a durable SQLite command and
metadata journal, and a stable p2prpc endpoint identity. A control-node outage
does not stop active agent sessions; registration, inventory reconciliation,
heartbeats, and the metadata outbox resume when the connection returns.

Required configuration:

- `AGENT_MULTIPLEX_SHARED_SECRET`: the control node's secret (at least 32 UTF-8
  bytes).
- `AGENT_MULTIPLEX_CONTROL_NODE_ENDPOINT_ID`: the independently trusted Iroh
  endpoint ID. A ticket is reachability data, not identity.
- `AGENT_MULTIPLEX_CONTROL_NODE_TICKET`: the control node's signed locator.
- `AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS`: a JSON string array or OS
  path-delimited list. Launch-provider output, resume, and native path inputs
  are realpath-checked beneath these roots.

Useful optional configuration:

- `AGENT_MULTIPLEX_RUNTIME_NODE_STATE_DIR` (default
  `.agent-multiplex/runtime-node`) and `AGENT_MULTIPLEX_RUNTIME_NODE_NAME`.
- `AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES=codex,copilot` and
  `AGENT_MULTIPLEX_RUNTIME_NODE_ADAPTER_MODE=native|mock`.
- `AGENT_MULTIPLEX_RUNTIME_NODE_CODEX_BINARY`,
  `AGENT_MULTIPLEX_RUNTIME_NODE_CODEX_ARGS` (a JSON string array), and
  `AGENT_MULTIPLEX_RUNTIME_NODE_CODEX_SCOPE`.
- `AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_HOME`,
  `AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_SCOPE`, and
  `AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_LOG_LEVEL`.
- `AGENT_MULTIPLEX_RUNTIME_NODE_MAX_RUNNING_TERMINALS` (default `32`).
- `AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_EXPERIMENTAL_UI_SERVER=1` and optional
  `AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_BINARY` for the experimental stock
  Copilot TUI described below.
- `AGENT_MULTIPLEX_RUNTIME_NODE_HEARTBEAT_MS`,
  `AGENT_MULTIPLEX_RUNTIME_NODE_INVENTORY_REFRESH_MS`,
  `AGENT_MULTIPLEX_RUNTIME_NODE_METADATA_FLUSH_MS`, and
  `AGENT_MULTIPLEX_RUNTIME_NODE_RECONNECT_MAX_MS`.

Protocol-v2 environment variables are rejected with their v4 replacement;
they are never silently treated as defaults. Protocol-v2 identity or SQLite
state must likewise be reset explicitly.

## Launch providers and native backends

The reference daemon wraps each configured Codex/Copilot adapter as a statically
registered native backend and enables the built-in `core.direct/workspace`
launch profile. That profile accepts an existing `cwd` (plus harness-native
model/mode options), enforces the runtime's allowed-root policy, owns no
workspace resources, and advertises `isolation.none`.

Bespoke runtime applications can construct `RuntimeNodeService` with explicit
`backends` and `launchProviders`. A provider owns its JSON input contract,
resource preparation/recovery/compensation, optional resume/stop work, and
idempotent release. A backend owns one harness adapter scope and optional
per-session native cleanup. Both are trusted TypeScript modules imported at
startup; protocol v4 has no dynamic plugin loader. The runtime recomputes each
profile's canonical JSON-Schema hash and rejects conflicting identities before
opening the service.

Launch and archive requests are durably admitted and continue asynchronously.
The runtime persists provider checkpoints, immutable session provenance, cleanup
progress, and archived native-binding tombstones. Archiving releases the
backend before provider-owned resources, then atomically tombstones and removes
the binding so later native inventory cannot resurrect it. Process shutdown is
separate: archiving one session must not close a shared app server.

For true per-session container isolation, place the app server and the
adapter-facing endpoint inside the container (or use another equally isolated
backend). Merely running a CLI or mounting a worktree in a container while
sharing the host app server is not an honest isolation boundary. See
[`../../docs/design/launch-extensions-v4.md`](../../docs/design/launch-extensions-v4.md).

## Managed terminal escape hatch

The terminal side channel exposes only PTYs started and owned by this runtime.
It cannot adopt an arbitrary shell, Codex/Copilot CLI, or tmux pane. Opening a
terminal requires a current active structured-session binding, and every call
is fenced by the session ID, runtime-node ID, binding revision, and runtime boot
ID. A replaced binding or runtime invalidates the old route and stream.

Terminal state is deliberately ephemeral. The runtime keeps only bounded
in-memory output replay and a synthesized xterm screen for reconnect; it keeps
no terminal bytes, screen snapshots, or keyboard credentials in SQLite, the
metadata outbox, control/gateway projections, normalized chat history, or
`readNativeHistory`. Runtime restart drops all PTYs, replay, and leases. Use the
native app-server history API for durable conversation history; a terminal gap
is not reconstructible from local history files.

Multiple clients may attach as viewers. Exactly one client at a time may hold
each terminal's renewable keyboard/resize lease (15-second default TTL). Lease
acquisition has a retry-stable request ID, input has a per-lease sequence, and
takeover compares against the visible current lease before replacing it. Lease
secrets remain client/runtime memory and must not be logged. A slow subscriber
is disconnected when its bounded mailbox fills instead of backpressuring the
PTY.

Gateway authorization is intentionally split:

- `terminal-view` permits terminal lookup and stream attachment but cannot
  create a PTY or send input.
- `terminal-control` also permits open, lease acquire/renew/release, keyboard
  input, resize, and termination where the backend supports it. It implies
  terminal viewing, but not general fleet `read` access.

Both the gateway-to-control source enrollment and the caller's gateway bearer
credential must contain the required scope. A normal operator credential will
therefore usually contain `read`, `terminal-view`, and `terminal-control`.
Terminal frames are opaque and are not redacted: `terminal-view` may reveal
workspace or harness output, while `terminal-control` is equivalent to typing
at that native TUI and can trigger work with the runtime account's OS and
harness credentials. Do not grant either as a harmless extension of `read`.
Managed children do not inherit Agent Multiplex transport, ticket, token,
credential, or lease variables, but that filtering is not a screen-redaction
boundary.

### Codex: implemented shared app-server path

The Codex adapter supervises one worker-local app server on a private Unix
socket. Structured JSON-RPC connections use that socket directly and managed
stock TUIs run as:

```text
codex resume --remote unix://<private-runtime-socket> <vendor-session-id>
```

Both paths address the same native server and session. Closing or terminating
the TUI closes only that managed PTY; the shared app server and structured
adapter remain available. The socket is local to the runtime and is never
published through p2prpc. Custom `AGENT_MULTIPLEX_RUNTIME_NODE_CODEX_ARGS`
are split consistently: global arguments precede the server and resume
commands, while app-server arguments configure only the server path.

This is the stable Multiplex implementation relative to the Copilot fallback,
but it does not change Codex's upstream support status: OpenAI currently marks
the app-server command and WebSocket transport as experimental and unsupported
for production workloads. The repository pins the tested Codex CLI version;
re-run the adapter and live acceptance suites before changing that pin. See the
[official app-server documentation](https://developers.openai.com/codex/app-server/).

### Copilot: opt-in experimental stock TUI

Copilot exposes no supported command that attaches its stock TUI to an already
running headless SDK server. When
`AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_EXPERIMENTAL_UI_SERVER=1`, the runtime
instead starts the exact GitHub Copilot CLI version `1.0.81` with hidden
`--ui-server`, `--no-auto-update`, and a random loopback-only TCP port. The TUI
owns that runtime and the structured adapter connects as a sibling SDK client.
Changing the terminal's foreground session is asynchronous and requires an
explicit confirmation when another session is visible. Terminate and restart
are unavailable because killing the TUI would also kill every structured
session in that adapter scope.

The executable is probed with `--version`; use
`AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_BINARY` only to select a worker-local
`1.0.81` binary. The implementation never relies on auto-update or the SDK's
possibly stale status version. If the opt-in is absent, or the version/startup
probe fails, the runtime gracefully uses the normal structured Copilot adapter
and advertises no Copilot terminal capability.

Current hidden UI-server builds reject an SDK connection when
`COPILOT_CONNECTION_TOKEN` is configured (`AUTHENTICATION_NOT_CONFIGURED`). The
experimental path therefore does not set a connection token. Its random
listener is bound strictly to `127.0.0.1`, the address is never advertised, and
the runtime must remain inside a trusted OS/container boundary. Do not publish
or forward that port. This limitation is why the feature stays opt-in.

## Runtime-node-local Copilot BYOK

When any `AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_*` variable is present,
these are required:

- `AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BASE_URL`
- `AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODEL`

Optional settings are:

- `AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_TYPE` (`openai` by default,
  or `azure`/`anthropic`).
- `AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_WIRE_API`
  (`completions` or `responses`).
- `AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_TRANSPORT`
  (`http` or `websockets`).
- `AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODELS`, a JSON array exposed
  through model discovery.
- Exactly zero or one of
  `AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_API_KEY_FILE` and
  `AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BEARER_TOKEN_FILE`.

For an OpenAI-compatible codex-lb deployment:

```bash
export AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES=copilot
export AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BASE_URL='http://codex-lb.internal/v1'
export AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_TYPE=openai
export AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_WIRE_API=responses
export AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_TRANSPORT=http
export AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODEL=gpt-5.6-sol
export AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODELS='["gpt-5.6-sol","gpt-5.6-terra"]'
export AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_API_KEY_FILE=/run/secrets/codex-lb-api-key
```

Provider credentials stay local: they are injected into SDK sessions, never
sent over p2prpc or stored as control-node metadata. Native provider overrides
are rejected at the runtime-node path-policy boundary. When the experimental
UI-server is enabled, the same provider configuration is translated into its
worker-local `COPILOT_PROVIDER_*` environment; it is not sent to a gateway or
control node.

The event topology has one path. After registration, the control node attaches
to `RuntimeNodeRouter.events.subscribe` over reverse RPC; the runtime node does
not also publish events through the ingress router.
