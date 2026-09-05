# Protocol-v5 live four-container acceptance

This is the integration receipt for the smallest realistic mixed-harness
deployment:

1. one durable authority control node;
2. one zero-authority access gateway serving the browser UI;
3. one runtime node owning a real `codex app-server` child;
4. one runtime node owning the real Copilot SDK/CLI runtime using codex-lb BYOK.

The browser and verifier connect only to the bearer-authenticated gateway. The
control node publishes no host port, and the two runtime nodes publish no
ports. Playwright runs on the Docker host and is not a fifth application
container.

On hosts where codex-lb is reachable only through a private overlay interface,
the runner also creates a credential-file-blind reverse relay as a transient
`systemd --user` service. It binds only to the isolated Docker bridge, is not a
container or public ingress, and remains available when a retained run exits.

## What it proves

- the gateway projects one protocol-v5 authority and two simultaneously online
  harness-specific runtime nodes;
- Playwright uses the web UI—not a test-only API—to launch one Codex and one
  Copilot session in `/workspace/project`. It explicitly selects the
  runtime-advertised `core.direct/workspace@1` profile and requested model;
  final RPC checks match the complete schema/implementation fence, native
  binding, launch provenance, and initial metadata;
- Chat is the default workspace. Playwright explicitly opens the managed stock
  Codex TUI, attaches a second independent read-only browser, takes the sole
  renewable keyboard/resize lease in the first browser, and observes terminal
  output in both clients;
- a private raw-input canary is pasted as one frame and observed by both terminal viewers,
  then erased before Enter. Only its SHA-256 digest enters the receipt; a
  byte/base64 scan proves it is absent from all four application SQLite
  stores, native-history responses, fleet event journal, and application logs;
- the Codex TUI submits a separate semantic prompt, both viewers observe its
  exact reply, a viewport resize propagates to the second viewer, and a
  confirmation stops only the managed TUI. Structured Codex chat completes a
  fresh prompt afterward, proving the shared app server remains usable;
- Copilot's hidden UI-server path stays explicitly disabled. The Terminal tab
  shows its opt-in experimental warning and exposes no open action;
- both sessions stream exact, independently identifiable replies into the chat
  UI, and a browser reload rehydrates their conversation through native harness
  history;
- an optional retained-connection soak sends fresh, exactly reconstructed
  Codex and Copilot replies and reloads native history after the liveness
  window; use at least `930000` ms to cross p2prpc's default 15-minute
  authenticated-session boundary;
- a temporary native-history 503 during peer replacement is accepted only
  when the browser's bounded retry recovers it; the receipt records it while
  every unrelated or unrecovered browser error remains fatal;
- the Codex session switches to a second native model, enters native Plan mode,
  emits one blocking `request_user_input`, accepts its typed answer through the
  UI, and returns to the default collaboration mode;
- the chat exposes a running shell command and incremental command output, then
  interrupts that active Codex turn through the UI before its terminal marker;
- the UI performs a compare-and-set metadata edit and displays the committed
  JSON values and revision;
- the same authenticated UI remains usable at six desktop, tablet, phone, and
  short-landscape viewports, with navigation/inspector sheets reachable,
  focus restored on close, no document overflow or clipped core controls, and
  no serious or critical axe violations;
- an independent gateway watcher records gap-free native event sequences and
  exact Codex and Copilot delta reconstruction;
- native history is read through Codex `thread/read` and Copilot
  `CopilotSession.getEvents()`; no history files are parsed;
- the two runtime containers contain the expected live native child processes;
- credentials, the provider URL, bearer token, shared secret, and raw p2prpc
  ticket are absent from the sanitized, checksummed receipt.

This mixed-harness smoke deliberately covers a focused interactive subset. The
harness-specific suites remain the deeper source for approval, steering,
subagent, stop/resume, and provider edge cases.

The gateway and control-node grant ceilings intentionally omit `agent-archive`
because this receipt leaves both sessions open and actively bound. It proves
the durable v4 launch transition and the resulting running catalog state, but
does not claim live stop/resume/archive coverage; those destructive lifecycle
paths remain deterministic-suite qualifications.

## Run

The test consumes real model credits:

```bash
npm run test:docker:v4:live:four
```

The root script should map that command to:

```bash
bash tests/docker-live-four-container/run.sh
```

The Docker build installs the exact published `@arduano/p2prpc-core` version
pinned in the workspace lockfile. Defaults use `~/.codex/config.toml` and
`~/.codex/codex-lb-api-key`. Relevant overrides are:

```bash
AGENT_MULTIPLEX_LIVE_SOURCE_CONFIG=/path/to/codex/config.toml \
AGENT_MULTIPLEX_LIVE_SOURCE_KEY=/path/to/codex-lb-api-key \
AGENT_MULTIPLEX_LIVE_CODEX_MODEL=gpt-5.6-sol \
AGENT_MULTIPLEX_LIVE_CODEX_SECOND_MODEL=gpt-5.6-terra \
AGENT_MULTIPLEX_LIVE_COPILOT_MODEL=gpt-5.6-sol \
npm run test:docker:v4:live:four
```

Receipts are stored under `receipts/protocol-v4-live-four-container/<run-id>/`.
A failed run is deliberately retained. By default the exact containers,
network, temporary workspaces, and image are removed. Set
`AGENT_MULTIPLEX_LIVE_KEEP=1` to preserve all four containers, the network,
image, bridge-only provider relay service, and temporary runtime directory for manual inspection; the receipt then
contains a redacted `handoff.json` with container names, the published UI URL,
host-only paths, and an exact generated `cleanup-retained.sh`, but never
credentials or raw locators. The cleanup script fences Docker resources by
immutable IDs, fences the relay by its unit and `ExecStart`, preserves recovery
state on a mismatch, and writes `cleanup-retained-result.json`.

The Playwright contract uses stable semantic test IDs: `auth-token`,
`connect-button`, `spawn-button`, `spawn-dialog`, `spawn-runtime-select`,
`spawn-harness-select`, `spawn-profile-select`, `spawn-cwd-input`, `spawn-model-select`,
`spawn-mode-select`, `spawn-effort-select`, `spawn-title-input`,
`spawn-submit`, `spawn-status`, `session-card`, `selected-session-id`,
`chat-transcript`, `chat-message` with `data-role`, `command-output`,
`prompt-input`, `send-button`, `agent-settings-button`, `model-select`, `model-button`, `mode-select`,
`mode-button`, `action-status`, `interrupt-button`, `interaction-card`,
`interaction-answer`, `interaction-other-answer`, `interaction-response`, `answer-button`,
`resolve-button`, `metadata-editor`, `metadata-json`, `metadata-save`,
`metadata-status`, `metadata-reset`, `metadata-reset-dialog`, and
`metadata-reset-confirm`, plus `session-chat-tab`, `session-terminal-tab`,
`terminal-panel`, `terminal-open-button`, `terminal-toolbar`,
`terminal-viewport`, `terminal-stream-status`, `terminal-dimensions`, `terminal-take-keyboard`,
`terminal-release-keyboard`, `terminal-terminate-button`,
`terminal-confirm-dialog`, `terminal-restart-button`, and
`copilot-terminal-warning`.

Terminal evidence is deliberately different from ordinary chat evidence.
Opaque PTY frames are never copied into the receipt. The one raw canary lives
in a private temporary file until the post-run ephemerality scanner finishes,
then is deleted before the receipt checksum and cleanup phases. The retained
`terminal-ephemerality.json` contains only its digest, length, scan counts, and
boolean assertions.

The suite targets current protocol-v5 source. Existing command names and receipt
directory paths containing `v4` remain stable; historical receipts retain their
original protocol/source identity and do not qualify v5.
