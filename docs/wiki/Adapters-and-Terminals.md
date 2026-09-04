# Adapters and terminals

Adapters preserve native harness behavior behind a small common lifecycle. They
do not force Codex and Copilot models, modes, approvals, questions, or event
payloads into one invented schema.

## Common adapter contract

An adapter owns one `harness` and `adapterScopeId` and implements:

- harness catalog, model, and native-session discovery;
- native spawn and resume;
- session status and acknowledged settings where observable;
- native command execution and interaction responses;
- ordered native event subscription;
- native history reads;
- stop and optional idempotent session release.

The runtime wraps adapters in named backends. A successful launch records the
provider, profile, implementation, backend, adapter scope, vendor session ID,
and binding revision. Resume, history, stop, and archive use that provenance
instead of guessing from `harness`.

## Codex

The runtime supervises one worker-local `codex app-server` on an owner-only
Unix-socket directory. Structured adapter connections and managed stock TUIs
address the same server and vendor session. The adapter supports native model,
collaboration mode, reasoning effort, turn settings, prompts/steering,
interrupts, approvals and `request_user_input`, events, and `thread/read`
history according to the pinned Codex version.

A managed TUI runs conceptually as:

```text
codex resume --remote unix://<private-runtime-socket> <vendor-session-id>
```

Closing the TUI closes only its PTY. It does not close the structured session or
shared app server. The socket is never published through p2prpc.

The maintained adapter is pinned to Codex CLI `0.152.0`. OpenAI classifies the
app-server command and WebSocket transport as experimental; re-run adapter and
live qualifications for every upgrade.

## Copilot

The supported path uses the Copilot SDK for session creation, native modes,
prompts, interrupts, interactions, events, and history. Provider/model selection
is runtime-local. An OpenAI-compatible BYOK provider can use the Responses wire
API and a runtime-local API-key or bearer-token file; its secret is never
projected.

Copilot has no supported stock-TUI attach command. The optional TUI bridge is
therefore experimental and disabled by default. It pins CLI `1.0.81`, starts its
hidden `--ui-server --no-auto-update` mode on a random loopback-only port, and
connects the structured adapter as a sibling SDK client. A failed probe falls
back to structured Copilot with no terminal capability.

The hidden server does not accept the expected SDK connection-token mode, so
the loopback listener assumes other processes inside the runtime OS/container
boundary are trusted. Never publish or forward it. Remote terminate/restart is
unavailable because the TUI owns the shared SDK runtime.

## Mock

The mock adapter provides deterministic Codex-shaped sessions, chunks, status,
and metadata behavior for integration and scale testing. The 100-session
receipt validates control-plane fan-in, cursors, CAS, reconnect, and UI behavior.
It does not model real app-server memory, provider latency, token use, or OS
process pressure.

## Managed terminal side channel

The terminal is an explicit escape hatch for a session already owned by
Multiplex. It cannot adopt an arbitrary shell, tmux pane, or independently
started CLI.

Every terminal operation is fenced by session, runtime, binding revision, and
runtime boot. The runtime holds:

- the PTY process;
- a bounded raw output/resize timeline and synthesized fallback screen;
- current viewers;
- one short renewable keyboard/resize lease.

Several observers may attach. While the raw timeline is complete, a new viewer
reconstructs the terminal from its opening dimensions and the exact ordered
output/resize events. An explicit end barrier commits the replay high-water;
partial replay is discarded and retried after disconnect or bounded-buffer
overflow. Descriptor-bearing frames are self-fenced to their cursor's terminal
identity and relevant sequence. A serialized screen reset is used when the
bounded timeline expires or startup bytes were dropped, and is explicitly
approximate. Copilot's experimental adapter-scoped PTY also uses a synthesized
reset after a foreground-session switch: transition output is buffered for the
new owner, but the hidden UI server cannot prove an exact native redraw
boundary. Only the lease holder may send sequenced input or resize. Takeover
is explicit and compares the currently visible lease. Slow viewers are
disconnected instead of backpressuring the PTY.

Terminal bytes, screen snapshots, and lease secrets are memory-only. They never
enter SQLite, metadata, fleet snapshots, normalized native events, or native
history. Runtime restart drops them; reopen a terminal and use structured native
history for conversation recovery.

## Terminal permissions and risk

`terminal-view` reveals opaque, unredacted harness and workspace output.
`terminal-control` can open a terminal, take the keyboard lease, type, resize,
and request supported termination. It is equivalent to keyboard access under
the runtime account's OS and harness credentials. Neither permission should be
treated as a harmless extension of fleet `read`.

Keep `AGENT_MULTIPLEX_RUNTIME_NODE_MAX_RUNNING_TERMINALS` conservative. Leave
Copilot terminal support off unless the loopback trust and exact-version risks
are accepted. Never persist or log a terminal lease secret.
