# Coding-agent harness servers and distributed session multiplexing

Research snapshot: **29 August 2026**

This note investigates the integration surfaces behind Codex, GitHub Copilot
CLI, Claude Code, and adjacent coding agents, then evaluates existing software
against this target:

> One TUI and web UI in which a user can create, observe, steer, interrupt, and
> approve many heterogeneous coding-agent sessions, even when those sessions
> live in different directories or on dynamically selected machines.

The short answer is:

- **Do not build another agent loop.** Codex app-server, the Copilot SDK, the
  Claude Agent SDK, and ACP already expose the local agent loops.
- **Do not assume that a remote terminal is an agent protocol.** It is a useful
  escape hatch, but it loses structured approvals, tool state, usage, stable
  message identity, and reliable replay.
- **There are now credible projects to pilot or fork.** Happy is the closest
  match to the cross-machine daemon and unified-stream idea. Agent of Empires
  plus CityHall is the closest self-hosted TUI/web and company-workspace stack.
  AgentAPI Proxy is a smaller but unusually relevant multi-manager federation
  prototype. Autonomous Harness is a close encrypted web/hardware panel for
  existing tmux agents. Warp is the closest polished commercial analogue if a
  vendor-hosted control plane is acceptable.
- **There is still no exact off-the-shelf match** for heterogeneous native
  integrations, arbitrary worker registration and per-session placement,
  durable global replay, one-controller approval arbitration, and both a TUI
  and browser UI.
- If those exact properties matter, build a **thin distributed control plane**
  around native vendor runtimes. The novel part is placement, identity,
  durability, policy, and fan-out—not model orchestration.

## Recommendation at a glance

| Intended use | First experiment | Likely decision |
|---|---|---|
| Personal, sessions already live on several machines | [Happy](https://github.com/slopus/happy) | Adopt or fork if its web/desktop UI is acceptable; test Copilot through its generic ACP runner, then add a native SDK adapter and TUI only if needed. |
| Personal, existing tmux agents including Copilot, with optional desk hardware | [Autonomous Harness](https://github.com/autonomous-ai/autonomous-harness) | Pilot the encrypted hosted web/device panel. It already spans machines and engines, but uses transcript/terminal adapters and its central service is not self-hosted in the public repo. |
| Personal, TUI-first and mostly one host at a time | [Agent of Empires](https://github.com/agent-of-empires/agent-of-empires), [Agent Deck](https://github.com/asheshgoplani/agent-deck), then [Codeg](https://github.com/xintaofei/codeg) | One may already be sufficient. AoE has the richest combination of structured ACP, TUI, web, worktrees, and terminal fallback. |
| Internal service where one isolated workspace/pod per user is acceptable | [Agent of Empires + CityHall](https://github.com/agent-of-empires/cityhall) | Pilot before writing a control plane. It already has OIDC, RBAC, per-user persistent AoE workspaces, and Docker/Kubernetes/process backends. |
| Internal service requiring session-level placement across registered managers | [AgentAPI Proxy](https://github.com/takutakahashi/agentapi-proxy), plus a native integration spike | Its polling external/native managers and central routing are close to the desired topology; expect to replace terminal-derived fidelity and first-match placement. |
| Internal service requiring central audit/replay and strict native Codex/Copilot fidelity | Native integration spike, then a small custom control plane | Build the fleet layer; reuse the vendor runtimes and borrow UI/daemon ideas from Happy, AoE, and AgentAPI Proxy. |
| Company willing to use a commercial, vendor-hosted control plane | [Warp Automation Platform](https://docs.warp.dev/platform/) | Evaluate before building. It is polished and has self-hosted execution, but the orchestration plane and transcripts remain Warp-hosted and Copilot is absent. |

The most useful near-term bake-off is not a large prototype. Run Happy,
Autonomous Harness, AoE+CityHall, and AgentAPI Proxy in their intended
topologies, then normalize one Codex turn and one Copilot turn into the same
event envelope. That will answer whether a fork saves more work than it
constrains.

## What “app server” means here

The ecosystem uses several overlapping terms. Keeping the layers separate
prevents a great deal of accidental architecture:

1. **Harness/runtime**: owns the model loop, context, tools, sandbox, and vendor
   session. Examples: Codex CLI/app-server, Copilot CLI runtime, Claude Code.
2. **Harness protocol or SDK**: lets an application start and control that
   runtime and receive structured events. Examples: Codex app-server protocol,
   Copilot SDK, Claude Agent SDK, ACP.
3. **Worker/runner**: a trusted process beside a checkout that launches one or
   more harness runtimes and maintains an outbound connection.
4. **Control plane**: owns users, logical sessions, placement, policy, commands,
   event durability, and reconnect state.
5. **Presentation client**: web, TUI, desktop, or mobile UI.

A harness app server is usually a **local, bidirectional RPC process**, not an
Internet-facing application server. A typical interaction is:

```text
client                         harness runtime
  | initialize --------------------> |
  | create/resume session ----------> |
  | prompt --------------------------> |
  | <--- turn/message/tool deltas --- |
  | <--- approval request ----------- |
  | approval decision --------------> |
  | <--- completed + usage ---------- |
```

Three details matter to a distributed UI:

- Events and commands flow in both directions. Approvals and user questions
  are runtime-to-client requests that must receive exactly one answer.
- “Session persisted” commonly means conversation history, not the checkout,
  uncommitted files, credentials, custom tool memory, or a live subprocess.
- Most vendor transports assume local trust. The fleet boundary belongs outside
  the harness protocol.

## Requirements used for the comparison

The target system needs more than a grid of terminals:

- many concurrent sessions and many working directories;
- Codex and Copilot first, Claude and ACP-capable agents next;
- local hosts, SSH-accessible hosts, and dynamically allocated workers;
- structured messages, tools, diffs, plans, usage, questions, and approvals;
- durable history plus resumable live streaming after network loss;
- one user-facing namespace over every machine;
- web and TUI clients, with multiple read-only viewers if desired;
- an unambiguous single controller for prompts, interrupts, and approvals;
- authentication, authorization, credential isolation, and audit for company use;
- version-pinned adapters and retention of raw vendor events for debugging.

No current open-source project satisfies that complete list without material
changes. Several satisfy large, useful subsets.

## Codex: use app-server as the primary integration

### Shape of the runtime

OpenAI describes **Codex app-server** as the surface for deep product
integrations; the SDK is aimed more at programmatic and CI-style automation.
The official [app-server documentation](https://developers.openai.com/codex/app-server/)
defines a bidirectional JSON-RPC-like protocol in which the `"jsonrpc"` field is
omitted.

Its conceptual model is:

```text
thread (durable conversation and configuration)
  └─ turn (one unit of agent work)
       └─ item (message, command, file change, tool call, reasoning, ...)
```

A single process can own many threads, and threads can have different working
directories. The surface includes thread start/read/list/resume/fork/archive
and deletion; turn start, steering, and interruption; models and configuration;
auth/account state; token usage; diffs and tools; and server-initiated approval
and input requests. This is enough to build a rich UI without interpreting the
terminal screen.

### Transports and trust boundary

The documented transports are:

- stdio with one JSON value per line;
- WebSocket over a Unix-domain socket;
- an experimental, unsupported TCP WebSocket listener.

The server rejects browser-originated WebSocket requests, so a web application
needs its own backend proxy. OpenAI's [remote access guidance](https://developers.openai.com/codex/remote/)
and [connection guidance](https://developers.openai.com/codex/remote-connections/)
favor SSH, a VPN, or a relay rather than exposing app-server itself.

Current builds can require either a capability token or a signed bearer token
during the WebSocket handshake. That protects a listener, but it does not add
fleet RBAC, per-session authorization, placement, or audit, and the TCP
WebSocket transport remains experimental and unsupported.

The current CLI still labels the app-server command experimental, and the
official documentation labels its remote WebSocket mode unsupported for
production workloads. App-server remains the richest first-party integration
surface, but treat it as a pinned, tested worker-local dependency behind this
project's stable adapter boundary.

For this project, run app-server under the worker and speak stdio or a Unix
socket. Do not publish the experimental TCP listener as the fleet API.

### Multiplexing already present in Codex

Current Codex has two related first-party ideas worth separating from this
project:

- `codex agents` is a local multi-session experience over a shared app-server
  daemon.
- Codex Remote and `codex --remote` / `codex agents --remote` let the stock TUI
  connect remotely.

These validate the daemon-plus-client model and may be enough for a Codex-only
personal workflow. They are not a reusable heterogeneous, multi-user scheduler
or audit plane.

### Persistence and reconnect behavior

Codex stores conversation rollouts as JSONL and maintains session metadata in
SQLite. Thread lifecycle is not the same thing as process lifetime: the current
server keeps a thread loaded while it has subscribers or activity, and gives a
last-unsubscribed idle thread a 30-minute grace period before unloading it. The
wire surface can read and resume persisted threads. The current
[implementation tests](https://github.com/openai/codex/blob/03861e69ef549717c0fc7045abad56321d4a082b/codex-rs/app-server/tests/suite/v2/thread_resume.rs#L4717)
also show a still-running thread replaying pending command and file-change
approval requests on resume. Ordinary live notifications still are **not** a
cursor-addressed event log: reconstruct durable state from thread history and
persist the project's own normalized stream rather than expecting every
missed delta or lifecycle notification to replay.

Treat the vendor thread ID as a foreign key, not as the product's logical
session ID. Persist at least:

```text
logical session -> worker -> workspace generation -> Codex thread -> Codex version
```

### The approval fan-out trap

App-server can deliver a server request to subscribed connections. Inspection
of OpenAI's source at commit
[`2181224`](https://github.com/openai/codex/blob/2181224dad147a9ed37e698b66487aba54acdb65/codex-rs/app-server/src/outgoing_message.rs)
shows one pending callback per request ID: the request is sent to target
connections, but the first response removes and resolves that callback. Later
responses find no callback.

Consequently, do **not** connect every browser tab directly as an independent
controller. The broker/worker adapter should be the one upstream subscriber.
It should turn the vendor request into a durable project-level
`approval.requested` event, accept one authorized decision through an
idempotent command endpoint, and send exactly one response upstream. Any number
of clients may view the request.

### Other Codex cautions

- Generate version-matched TypeScript bindings with `codex app-server
  generate-ts --out ...`; do not maintain a hand-written copy of a fast-moving
  schema.
- Send a stable `clientInfo.name` during initialization. For an enterprise
  integration, OpenAI's documentation asks developers to have that name added
  to the known-clients list so the Compliance Logs Platform can identify it.
- Pin and test a small Codex CLI version matrix. Online documentation can be
  ahead of the binary installed on a worker. This research locally verified
  `codex-cli 0.150.1`.
- Model item deltas are presentation updates, not a complete durable history.
  Reconcile them into completed records and keep the raw payload.
- App-server's sandbox is not the worker security boundary. In particular,
  shell/process facilities can have different sandbox semantics, and current
  experimental process methods and shell-command APIs require explicit review.
- Keep one broker-owned upstream connection per live runtime/session group and
  fan out downstream yourself.

### Codex integration decision

Use app-server natively. ACP through `codex-acp` is a useful compatibility
adapter, but it throws away Codex-specific surface area and adds another moving
part. PTY capture should be the final fallback for custom commands and stock TUI
attachment, not the main data path.

## GitHub Copilot: use the native SDK, retain ACP as fallback

### Native SDK runtime model

The open-source [GitHub Copilot SDK](https://github.com/github/copilot-sdk) is
now GA and MIT-licensed, with TypeScript, Python, Go, .NET, Java, and Rust
clients. At the research date, the current stable release was `v1.0.11`; the
repository also published a `v1.0.13-preview.2` preview.

The application does not call a hosted “session API” directly:

```text
application -> language SDK -> local Copilot CLI runtime -> GitHub/model/tools
```

The SDK protocol is JSON-RPC 2.0 using LSP-style `Content-Length` framing.
Normal launch is stdio. The SDK can launch a TCP runtime or attach to an
existing URI, and experimental FFI support exists. For a persistent worker-side
runtime, GitHub documents `copilot --headless --port 4321`; one such runtime can
carry multiple SDK clients and Copilot sessions.

TCP includes a connection-token handshake, but that is not a substitute for
TLS, workload identity, authorization, or network policy. Keep it local to the
worker or place it behind the worker tunnel.

### Session and event surface

The SDK exposes session create, resume, list, and delete; send, steer, queue,
abort, and disconnect; model and configuration controls; custom tools; MCP;
permissions; user input and elicitation; and structured session events.

Copilot's event envelope is particularly useful for normalization. Events have
identifiers and timestamps, can link to a parent, can carry a subagent ID, and
can be marked ephemeral. Persisted events can be replayed, while token/progress
deltas are explicitly ephemeral. User-input and elicitation request/completion
events are also ephemeral in the current
[event table](https://github.com/github/copilot-sdk/blob/50ce37e19258524c6de82651652971e96d7ae5f3/docs/features/streaming-events.md),
whereas permission requests are persisted. The adapter must therefore durably
record and arbitrate an interactive request as soon as it arrives instead of
assuming resume will replay it. That distinction should influence the common
event store rather than be flattened away.

Callbacks for permission requests, user input, and elicitation have the same
single-controller consequence as Codex approvals: the worker adapter owns the
callback, downstream clients submit an arbitrated decision.

Copilot also uses the term **Fleet Mode** for a runtime feature that dispatches
parallel subagents inside one parent session. That is useful agent-loop
orchestration, but it is not a registry or scheduler for the project's fleet of
machines.

### Multi-user and persistence caveats

Copilot documents `mode: "empty"` as a baseline for shared or multi-user
applications. It prevents assumptions about the stock coding-agent setup, but
it does not make host filesystem tools safe for mutually untrusted users.

The SDK's current
[multi-tenancy guide](https://github.com/github/copilot-sdk/blob/50ce37e19258524c6de82651652971e96d7ae5f3/docs/setup/multi-tenancy.md)
is unusually server-oriented. It documents isolated runtimes per user as well
as a shared runtime in `mode: "empty"`, per-session GitHub credentials,
per-runtime `COPILOT_HOME`, and `sessionFs` callbacks that route session-scoped
storage through an application's own provider. Its scaling guidance covers
sticky runtimes versus shared session storage. These are useful building
blocks, but the application still owns user authorization, worker placement,
workspace isolation, locking, and the global event catalog.

Authentication also has two materially different paths. User GitHub tokens can
be supplied per session. A GitHub App installation token, by contrast, must be
injected into the runtime environment as `COPILOT_GITHUB_TOKEN`, currently
expires after one hour, and requires restarting or rotating the runtime rather
than passing it through the per-session token option. See the pinned
[server-to-server authentication guide](https://github.com/github/copilot-sdk/blob/50ce37e19258524c6de82651652971e96d7ae5f3/docs/auth/server-to-server-tokens.md).
Model this as a secret-broker/runtime-lifecycle concern, not merely a session
field.

For a full coding agent, prefer a runtime/container per principal or trust
boundary. A per-session `cwd` and GitHub credentials do not isolate arbitrary
host tools. With persistence enabled, the
[session state](https://github.com/github/copilot-sdk/blob/50ce37e19258524c6de82651652971e96d7ae5f3/docs/features/session-persistence.md)
includes conversation history, tool results, planning state, and session
artifacts; provider keys and in-memory custom-tool state are not persisted.
Resuming also does not recreate an arbitrary external repository checkout. The
control plane must provision those separately.

### GitHub-hosted remote and cloud surfaces

The similarly named features have different placement semantics:

- a [remote session](https://github.com/github/copilot-sdk/blob/50ce37e19258524c6de82651652971e96d7ae5f3/docs/features/remote-sessions.md)
  promotes a locally executing SDK session to GitHub Mission Control so it is
  reachable from GitHub web/mobile;
- a [cloud session](https://github.com/github/copilot-sdk/blob/50ce37e19258524c6de82651652971e96d7ae5f3/docs/features/cloud-sessions.md)
  executes on GitHub-hosted compute.

Both provide a first-party Copilot panel and are worth testing before building
a Copilot-only UI. They require GitHub identity, repository context,
entitlements, and organization policy. Neither is a scheduler for arbitrary
company machines or an internally operated cross-vendor session plane.

### Copilot ACP server

Copilot CLI also provides an [ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server).
ACP v1 is stable, but GitHub labels this implementation public preview. It can
run over stdio NDJSON and localhost TCP, and one connection can host multiple
sessions. It covers prompting, cancellation, history, list/close, tools, MCP,
diffs, plans, selectors, usage, and approvals.

The CLI's ACP documentation also notes that tool filtering and reasoning effort
are chosen when the ACP server process starts and apply to all sessions it
hosts. A shared ACP process therefore also shares that policy; split processes
when sessions require different tool or reasoning configurations.

It does not currently advertise every optional ACP lifecycle capability, such
as the standard resume/delete/additional-directory set. Prefer the native SDK
for the first-class Copilot adapter; use `copilot --acp` when a generic ACP path
is more valuable than complete fidelity.

### Distribution terms

The SDK itself is MIT. Copilot CLI is distributed under GitHub's own license;
the inspected terms allow unmodified redistribution as part of an application
that adds material functionality, subject to GitHub's license and service
terms. An internal bundle still needs a terms review. This paragraph is an
engineering observation, not legal advice.

### Copilot integration decision

Use one SDK-managed runtime per principal/container unless measurements show
that safely sharing it is worthwhile. Preserve Copilot's native event identity
and ephemeral flag. Add ACP as the generic path and keep PTY mode only for users
who explicitly want the stock terminal experience.

## Claude Code: use the Agent SDK when adding the third adapter

Anthropic's official [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
exposes the Claude Code loop in TypeScript and Python. It includes structured
streaming, built-in and custom tools, permissions, hooks, usage, subagents, and
session resume/fork.

Important differences from the multi-session Codex/Copilot processes:

- a Claude SDK query/session is effectively backed by its own subprocess;
- Anthropic's [hosting guide](https://code.claude.com/docs/en/agent-sdk/hosting)
  recommends a per-session directory and container isolation for hosted use;
- session resume restores conversation context, not an absent checkout;
- [SessionStore](https://code.claude.com/docs/en/agent-sdk/session-storage)
  can mirror transcript JSONL into S3, Redis, Postgres, or a custom store so
  another host can resume it;
- mirror writes are best effort and can report `mirror_error`, so the project
  event log should remain its own durability mechanism.

For an embedded/internal service, follow Anthropic's authentication terms.
Agent SDK documentation directs third-party products toward API-key/platform
authentication unless Anthropic has approved using claude.ai login and its rate
limits in that setting.

### Claude-specific multiplexer and fleet products

Anthropic now exposes three useful comparisons to this project:

- [Agent view](https://code.claude.com/docs/en/agent-view) is the
  `claude agents` local TUI. It dispatches and monitors background Claude Code
  sessions across projects, shows attention state, permits peek/reply and full
  attachment, and keeps sessions alive under a supervisor. It is a research
  preview and a local Claude-only experience.
- [Claude Code self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments)
  are a public beta for Team and Enterprise. Anthropic's control plane queues a
  cloud session to an environment; runners inside the company network poll
  outward, claim leased work, clone the repository, and spawn Claude Code child
  processes. Web, mobile, desktop, terminal, and scheduled surfaces share the
  session. The execution/checkouts stay on company infrastructure, but the
  queue, session stream, transcript, and model inference remain
  Anthropic-hosted. This is a very close vendor-specific reference architecture,
  not a heterogeneous control plane.
- [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)
  is a separate beta API product: a hosted agent harness with persistent
  sessions/events, SSE, steering, scheduling, and either Anthropic-managed or
  [self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes).
  A self-hosted environment worker polls an Anthropic work queue and runs tools
  locally, while tool inputs/results and orchestration still pass through
  Anthropic.

These products may solve a Claude-only workflow and provide excellent designs
to study. They do not expose a reusable control plane for Codex and Copilot.

## ACP: valuable adapter boundary, not the fleet protocol

The [Agent Client Protocol](https://agentclientprotocol.com/) is the emerging
common editor/UI-to-agent protocol. ACP v1 is the stable wire version; ACP v2
work is still unstable at the research date. The standard transport is
newline-delimited JSON-RPC over stdio, and one connection can carry concurrent
sessions.

Stable surfaces cover session creation and, where implemented, list/resume/
close; prompts and streaming updates; permission requests; cancellation; tools,
plans, and related capabilities. Remote HTTP/WebSocket transport remains a
work in progress.

ACP is an excellent fourth adapter and a useful way to support a long tail of
agents. It deliberately does not solve:

- machine registration and placement;
- checkout/worktree provisioning;
- global durable replay;
- corporate identity, ownership, quotas, or audit;
- leader/controller arbitration;
- a secure cross-machine tunnel.

ACP and MCP are also different layers: ACP drives an agent from a UI; MCP gives
an agent access to tools and resources.

### Licensing and service terms are separate layers

Codex's open-source implementation and ACP use Apache-2.0, while the Copilot
SDK uses MIT. Those source licenses make adapters and internal modifications
straightforward, but they do not replace the authentication, entitlement,
acceptable-use, or service terms of the vendor runtime behind each adapter.
Internal or personal use reduces distribution concerns; it does not eliminate
that service-side review, especially if vendor CLIs are bundled into workers or
credentials are brokered for several employees.

## What exists off the shelf

### Tier 1: serious pilot or fork candidates

#### Happy

[Happy](https://github.com/slopus/happy) is the closest architectural match to
the requested cross-machine product. It is MIT-licensed and includes:

- a machine daemon that registers with a central service and spawns child
  sessions;
- remote spawn/resume RPC from web/mobile to a selected machine;
- provider runners for Claude, Codex, and Gemini;
- a unified encrypted session event protocol;
- durable encrypted session messages and machine/session metadata;
- user-, machine-, and session-scoped realtime connections;
- web, mobile, and macOS clients, remote permissions, and notifications;
- a self-hostable server.

Its documented architecture is unusually relevant: normal updates and RPC use
one Socket.IO service, machine daemons register RPC handlers, and server-side
messages/state carry update sequence information. See its pinned
[CLI architecture](https://github.com/slopus/happy/blob/b824cd0a4681d41af631a8e422a813873e4455b0/docs/cli-architecture.md),
[realtime/RPC design](https://github.com/slopus/happy/blob/b824cd0a4681d41af631a8e422a813873e4455b0/docs/realtime-sync-and-rpc.md),
and [session protocol](https://github.com/slopus/happy/blob/b824cd0a4681d41af631a8e422a813873e4455b0/docs/session-protocol.md).

Gaps for this target:

- no native Copilot SDK integration; Happy's pinned
  [generic ACP runner](https://github.com/slopus/happy/blob/b824cd0a4681d41af631a8e422a813873e4455b0/packages/happy-cli/src/agent/acp/runAcp.ts)
  makes `happy acp -- copilot --acp --stdio` plausible, but that combination
  was not exercised in this research and would inherit Copilot ACP's preview
  status and narrower surface;
- no TUI control panel;
- machines are addressed, but there is no policy scheduler selecting an
  arbitrary eligible worker;
- identity and encrypted sync are personal-product oriented, not OIDC/RBAC and
  centrally readable audit/policy;
- E2EE is an asset for personal use but conflicts with a requirement for the
  server to inspect tool arguments or enforce content-aware approvals;
- parts of the Codex integration have been in migration, so native app-server
  fidelity must be verified against the current code and tests.

**Verdict:** first choice for a cross-machine personal pilot and a strong source
base if machine daemons plus one encrypted panel are the essence of the project.

#### Autonomous Harness

[Autonomous Harness](https://github.com/autonomous-ai/autonomous-harness) is an
MIT-licensed machine bridge paired with a hosted web application and optional
desk hardware. Its daemon watches tmux processes on macOS/Linux and supports a
large engine list that includes Claude, Codex, Copilot, Cursor, OpenCode, and
others. A user's machines dial an encrypted relay, and the web/device surfaces
show agents across those machines. The bridge can stream normalized messages,
turns, tools, todos, and subagents; inject prompts; cancel; drive terminal
questions and approvals; browse workspace files; and explicitly create a new
tmux agent in a selected absolute directory. These claims were inspected at
commit [`1e07c4c`](https://github.com/autonomous-ai/autonomous-harness/tree/1e07c4ccc3c14719cb8b3b020155fd4215a8dbdc).

The architecture is highly relevant but has a different product boundary:

- the CLI path tails vendor transcript/state files, observes processes, and
  drives the terminal; even its thoughtful permission support parses the pane,
  so it is not native Codex app-server or Copilot SDK fidelity;
- the public repository contains the bridge and a provider protocol, but not
  the hosted relay/chat backend needed to self-host the complete product;
- end-to-end encryption keeps prompts and results opaque to the relay, which is
  excellent for personal use but prevents central content audit/policy;
- there is no TUI, capacity-aware scheduler, OIDC/RBAC company plane, or
  demonstrated durable global event cursor;
- normal agent discovery observes user-started tmux processes, while explicit
  remote creation selects a machine and absolute directory rather than placing
  work through policy.

Its separate provider protocol is also worth noting: an existing internal agent
platform can expose agent list/create/send/cancel/history operations over
HTTPS JSON-RPC and SSE, then use the Harness web/device UI as a client. That is
a product integration option, not a reusable fleet protocol.

**Verdict:** one of the best immediate personal pilots when Copilot support,
several machines, and the optional physical panel matter. Mine its engine
fixtures, terminal fallback, encryption, and device UX; do not treat its public
repository as a self-hostable native-event company control plane.

#### Agent of Empires + CityHall

[Agent of Empires (AoE)](https://github.com/agent-of-empires/agent-of-empires)
is MIT-licensed and now offers a TUI, web UI, CLI, and HTTP API. It combines
persistent tmux sessions with a structured ACP view, worktrees, multi-repo
workspaces, optional container isolation, durable SQLite event replay, diffs,
tools, approvals, queued prompts, and notifications. Codex and Claude have
built-in structured adapters; Copilot is terminal-backed today, but a custom
ACP command can launch `copilot --acp --stdio`. AoE can attach its TUI to one
remote daemon with `AOE_DAEMON_URL`; it does not aggregate unrelated daemons by
itself. See the pinned
[structured-view documentation](https://github.com/agent-of-empires/agent-of-empires/blob/1929ce52a66ff2b4fdb19e8e0e18c7d6fc62711c/docs/structured-view.md)
and [structured-view internals](https://github.com/agent-of-empires/agent-of-empires/blob/1929ce52a66ff2b4fdb19e8e0e18c7d6fc62711c/docs/development/internals/structured-view.md).

[CityHall](https://github.com/agent-of-empires/cityhall) is the corresponding
self-hosted multi-user control plane. It already implements accounts, OIDC,
RBAC, credential storage, per-user persistent AoE workspaces, proxying, idle
stop, version selection, and Docker, Kubernetes, and bare-process provisioners.
The Kubernetes backend creates one Deployment, Service, and PVC per user. Its
[workspace design](https://github.com/agent-of-empires/cityhall/blob/114f2730f20fab7ed67efd048ee99d5ceed73377/docs/workspaces.md)
is very close to an internal coding-agent SaaS.

The mismatch is the placement and stream boundary. CityHall allocates one
long-lived AoE workspace per user, and the user's sessions live inside it. It
does not register arbitrary existing machines, place each session independently,
or merge event logs from several AoE daemons into one global cursor. Audit is
selective log events rather than a complete normalized action/event ledger.

**Verdict:** likely the best self-hosted company pilot if a per-user pod is an
acceptable isolation and scheduling unit. Forking this pair may be substantially
cheaper than a greenfield internal service.

#### AgentAPI Proxy

[AgentAPI Proxy](https://github.com/takutakahashi/agentapi-proxy) is an
MIT-licensed session proxy and provisioner around
[Coder's AgentAPI](https://github.com/coder/agentapi). It supplies a central
session catalog and search API, path-based routing to individual session
servers, ownership/RBAC, API keys and GitHub OAuth, persistence options, and
local-process and Kubernetes provisioners. A separate
[web UI](https://github.com/takutakahashi/agentapi-ui) consumes the proxy.

Its current external/native manager path is especially relevant. An external
manager polls the parent proxy's allocation queue, creates or adopts a session,
and reports its route; native managers can register labels and run on ordinary
machines. The pinned
[external-manager design](https://github.com/takutakahashi/agentapi-proxy/blob/59d37797a96491a000b5d3b65e98744aea8fb024/docs/external-session-manager.md)
therefore resembles an outbound worker registration system more closely than
most projects in this survey.

Important gaps remain:

- after allocation, the parent must be able to reach each manager's advertised
  public URL to proxy normal session traffic; this commonly needs a VPN,
  Tailscale, or reverse tunnel rather than one outbound worker stream;
- selection accepts an explicit manager, a default, or `allocator.*` label
  constraints, but the current
  [selection code](https://github.com/takutakahashi/agentapi-proxy/blob/59d37797a96491a000b5d3b65e98744aea8fb024/internal/app/server.go)
  returns the first matching user/team manager rather than making a
  capacity-aware placement decision;
- the base AgentAPI integration drives a PTY and derives updates from screen
  changes, so it is not a substitute for native Codex/Copilot events,
  approvals, and replay;
- there is no TUI or demonstrated global normalized event cursor, and Copilot
  is not first-class;
- the proxy is MIT, but the inspected web UI repository had no visible license
  file, so confirm its reuse terms before treating the UI as forkable.

**Verdict:** a serious federation/control-plane pilot and perhaps the most
direct codebase to mine for manager registration, allocation, routing, and
RBAC. Its session data path and adapter fidelity would still need substantial
work for the exact target.

#### Codeg

[Codeg](https://github.com/xintaofei/codeg) is an Apache-2.0 ACP-oriented client
and server with desktop, headless/server, Docker, web, iOS, and Android
surfaces. It provides structured tools and permissions, searchable/resumable
sessions, worktrees, a task board, automations, multi-agent delegation, split
panes, and git/editor views. Its built-in catalog covers many agents; Copilot
can be registered through ACP.

It is a strong rich-UI candidate. Its remote workspace support is oriented
toward connecting to complete Codeg workspace servers, rather than workers
registering into a shared scheduler. Publicly visible controls are token-based;
there is no demonstrated multi-user ownership, OIDC/RBAC, arbitrary placement,
or one global durable event cursor.

**Verdict:** pilot for UI/product fit or mine it for ACP/UI patterns. It is less
directly aligned with a company fleet plane than Happy or AoE+CityHall.

#### Agent Deck

[Agent Deck](https://github.com/asheshgoplani/agent-deck) is an MIT-licensed Go
application with a polished TUI and browser UI over persistent tmux sessions.
It supports Codex, Claude, Gemini, OpenCode, Copilot, custom commands, groups,
worktrees, forks, costs, status, conductors/watchers, and SSH remotes. Its remote
commands expose remote sessions beside local ones, and non-loopback web access
uses a bearer token.

Its core fidelity is terminal/tmux plus hooks. Copilot is primarily an organized
launch target; Codex notify hooks provide coarse status. Cross-machine
completion draining is pull-oriented rather than a durable acknowledged event
stream, and it has no shared scheduler, SSO/RBAC, or tenancy/audit plane.

**Verdict:** excellent zero-build personal TUI trial; a weaker base for the
structured distributed service.

#### OpenHands Agent Canvas

[OpenHands Agent Canvas](https://github.com/OpenHands/OpenHands) is a stronger
candidate than its historical “single OpenHands agent” reputation suggests. It
is an MIT-licensed web control center that can register several local, remote,
VM, container, cloud, or company Agent Server backends. Current Agent Servers
can run OpenHands, Claude Code, Codex, Gemini, or custom ACP agents. The
underlying [Software Agent SDK and Agent Server](https://github.com/OpenHands/software-agent-sdk)
provide multi-conversation REST/WebSocket APIs, durable JSONL events and
workspace files, while a separate Automation Server covers schedules,
webhooks, run history, and dispatch.

Its current frontend **switches** between registered backends; it does not merge
their conversation lists or events into one global stream. Self-hosted Agent
Servers use a session API key, and the browser stores credentials for registered
backends, rather than workers opening outbound tunnels to an OIDC/RBAC control
plane. Codex and Claude are reached through ACP adapters, and Copilot is not in
the built-in catalog. There is no TUI.

**Verdict:** top-tier web/ACP and agent-server substrate to pilot, especially if
backend switching is close enough. The remaining aggregation, identity,
outbound-worker, Copilot, and TUI work is still central to this project's goal.

#### HarnessRouter Community Edition and UHP

[HarnessRouter Community Edition](https://github.com/HarnessRouter/harnessrouter)
is an Apache-2.0 single-container web console and gateway for Codex, Claude
Code, OpenCode, Pi, Hermes, and other harnesses. One runner launches an agent
CLI per isolated session/workspace; its gateway supports concurrency,
checkpoints, stored turns, cancellation, idempotency, and SSE. It currently
installs vendor CLIs into the persistent volume rather than redistributing
them.

Of greater architectural interest is its open
[Unified Harness Protocol (UHP)](https://unifiedharnessprotocol.org/): a
versioned OpenAPI/JSON Schema, conformance-tested HTTP contract based on the
OpenAI Responses shape. UHP standardizes harness discovery/configuration,
sessions, files, streaming event sequences, cancellation, idempotency, and
session sharing. Unlike ACP, it is already HTTP/SSE-shaped for a service
boundary. Its own architecture explicitly leaves the execution mechanism—local
processes, containers, queues, or remote workers—out of scope.

Current UHP is task/turn oriented and does not specify interactive vendor
approval/question callbacks, steering, machine registration, placement, or a
global multi-session cursor. Community Edition is deliberately one-owner and
one-box, without Copilot, a TUI, or fleet identity.

**Verdict:** pilot the product as a web harness console and seriously consider
using or extending UHP as the northbound public API. Do not mistake it for the
missing worker/control-plane protocol.

#### Warp Automation Platform / Oz

[Warp Automation Platform](https://docs.warp.dev/platform/) is the closest
polished commercial analogue. Its Oz web application provides a team run
catalog, durable transcripts, status, sharing, costs, schedules, integrations,
and live inspection/steering. Runs can select Warp Agent, Claude Code, or Codex,
and the UI works on desktop and mobile. Warp supports both hosted execution and
self-hosted worker patterns.

This is not a fully self-hosted or provider-neutral answer. Warp's
[deployment documentation](https://docs.warp.dev/platform/deployment-patterns/)
says self-hosted execution is Enterprise-only and explicitly describes it as
customer-hosted execution with Warp-hosted orchestration: orchestration
metadata and session transcripts pass through Warp's backend, and inference
requests route through Warp to model providers. It does not provide Copilot as
a harness, an open control plane to extend, or the requested TUI.

**Verdict:** evaluate it as a buy option and as a product benchmark if the
hosted control plane and commercial terms are acceptable. It does not remove
the need for a custom system when full internal custody, Copilot, or arbitrary
provider adapters are hard requirements.

### Tier 2: useful components and references

| Project | Useful part | Why it is not the whole answer |
|---|---|---|
| [Agent of Empires](https://github.com/agent-of-empires/agent-of-empires) without CityHall | Probably the strongest local TUI/web session manager; structured ACP plus terminal fallback | One daemon boundary unless paired with CityHall or a new aggregator |
| [AgentAPI](https://github.com/coder/agentapi) | Uniform HTTP/SSE façade over many CLIs | It drives a terminal and derives updates from screen changes; useful fallback, not native fidelity or fleet placement |
| [ACP UI](https://github.com/formulahendry/acp-ui) | Cross-platform generic ACP client, including web-to-WebSocket | A client, not scheduler, identity plane, durable broker, or worker manager |
| [acpx](https://github.com/openclaw/acpx) | Headless ACP backend with persistent named sessions, permissions, queues, and raw NDJSON | Local ACP control/reference rather than distributed control plane |
| [Agent of Empires CityHall](https://github.com/agent-of-empires/cityhall) | Ready-made multi-user provisioning and proxy pattern | Per-user workspace, not per-session worker registry/global broker |
| [AgentRQ](https://github.com/agentrq/agentrq) | Human-agent task board through MCP | Agents participate through tools; it does not own their native live sessions |
| [Jockey](https://github.com/recailai/jockey) | ACP multi-agent desktop UI and role/context experiments | Desktop orchestration rather than remote fleet service; several features remain roadmap items |
| [OpenCode server](https://opencode.ai/docs/server/) | Native HTTP/OpenAPI server with SSE events | Strong OpenCode adapter/reference, one vendor rather than the cross-vendor fleet plane |
| [amux](https://github.com/mixpeek/amux) | Strong single-host web/phone control plane over tmux: scheduling, board, SQLite event journal, recovery, and an emerging structured protocol | One server machine rather than aggregate arbitrary workers; no Copilot or native Codex app-server path. MIT plus Commons Clause, not plain MIT |
| [Harness Remote](https://github.com/giuliastro/harness-remote) | Machine daemon, web/desktop/mobile clients, project/task/worktree model, and ACP adapters | Its multi-machine fleet is still roadmap item #146; current Codex ACP mode deliberately auto-allows tool permissions, which is unsuitable for central approval policy |
| [Mission Control](https://github.com/builderz-labs/mission-control) | Rich self-hosted task, governance, heartbeat, cost, audit, WebSocket/SSE, and runtime-adapter dashboard | Governs work around runtimes; adapter depth varies and it is not a native, lossless live-session multiplexer |
| [Paperclip](https://github.com/paperclipai/paperclip) | Durable task checkout, heartbeats, budgets, governance, and multi-organization patterns | Business/task orchestration rather than interactive vendor-session control and replay |

Terminal-first projects remain valuable because a human sometimes needs the
vendor's exact TUI. The right design can offer a raw-terminal side channel while
keeping structured events authoritative where an adapter exists.

Execution substrates such as [Coder](https://github.com/coder/coder),
[Daytona](https://github.com/daytonaio/daytona),
[E2B](https://github.com/e2b-dev/E2B), Kubernetes, and Nomad solve workspace
provisioning, isolation, and placement.
They are good foundations under a worker pool, but they do not understand
Codex/Copilot turns, approvals, event replay, or session ownership, so they do
not replace this semantic control plane.

## Capability scorecard

Legend: **Yes** = present and central to the design; **Partial** = usable with a
constraint or adapter; **No** = material new work. “Fleet” means multiple
registered machines visible through one service, not merely connecting the UI
to one remote daemon.

| Candidate | Structured Codex | Structured Copilot | Web | TUI | Fleet / remote spawn | Durable structured replay | Multi-user identity | Placement unit |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Happy | Yes, native app-server; pilot reliability | Partial/generic ACP, unverified | Yes | No | Yes/selected machine | Yes | Partial | Session on chosen machine |
| Autonomous Harness | Transcript/terminal-derived | Transcript/terminal-derived | Yes, hosted | No | Yes/selected machine | Partial/local source history | Personal SSO/E2EE | Tmux agent on chosen machine/path |
| AoE + CityHall | Yes via ACP | Partial/custom ACP | Yes | Partial in locked-down CityHall use | Partial | Yes inside each AoE workspace | Yes, OIDC/RBAC | One workspace/pod per user |
| AoE alone | Yes via ACP | Partial/custom ACP | Yes | Yes | One remote daemon | Yes | Token/passphrase | Session on that daemon |
| AgentAPI Proxy | Screen-derived | Screen-derived | Yes, separate UI | No | Yes, polling managers | Partial/per manager | Yes, OAuth/RBAC | First explicit/default/label match |
| Codeg | Yes via ACP | Partial/ACP registration | Yes | No | Partial remote workspaces | Yes per server | Token-oriented | Session on connected server |
| OpenHands Agent Canvas | Yes via ACP | No/bespoke ACP possible | Yes | No | Multiple selectable backends | Yes per Agent Server | API key; richer cloud editions separate | Conversation on selected backend |
| HarnessRouter CE | Native wrapper | No | Yes | No | No, one box | Yes per server/session | Single-owner login | Session on local runner |
| Agent Deck | Coarse terminal/hooks | Terminal | Yes | Yes | SSH remotes, manual | PTY/tmux, not structured | Token-oriented | Tmux session on named host |
| Warp Platform | Yes | No | Yes | No | Yes, Enterprise workers | Yes | Yes, commercial | Run in selected environment/pool |
| AgentAPI | Screen-derived | Screen-derived | API only | No | No | Partial SSE/session state | No | One local process |
| Custom thin control plane | Native | Native | Build | Build | Yes | Yes | Choose OIDC/RBAC | Session on eligible worker |

The scorecard intentionally does not call ACP adapters equivalent to a native
vendor SDK. They can render a useful structured session while still omitting
vendor-specific controls.

## What to adopt and what to build

### Adopt unchanged where possible

- Codex app-server and generated version-specific bindings.
- Copilot SDK and its native event model.
- Claude Agent SDK when Claude support enters scope.
- ACP v1 as the generic adapter contract.
- Vendor authentication flows and model/tool implementations.
- Git worktrees, containers/OS isolation, and SSH/VPN primitives.
- PostgreSQL and ordinary transactional/outbox patterns before introducing a
  dedicated log broker.

### Pilot or fork before rebuilding

- Happy for the worker daemon, remote spawn, encrypted sync, and cross-machine
  UI model.
- Autonomous Harness for multi-machine terminal discovery, broad engine
  fixtures, E2EE pairing, question/approval fallback, and hardware-panel UX.
- AoE for the TUI/web session experience, structured event reducer, durable
  replay, worktree lifecycle, and terminal fallback.
- CityHall for internal identity, per-user isolation, proxying, provisioning,
  and admin workflows.
- AgentAPI Proxy for multi-manager registration, label routing, session
  ownership/RBAC, and native/Kubernetes provisioner patterns.
- Codeg for a broad ACP client and rich code-oriented UI.
- OpenHands Agent Canvas/Server for a mature web frontend, remote backend
  registry, conversation API, and ACP execution substrate.
- UHP as a possible versioned northbound API rather than inventing every public
  session/task schema from zero.

There are three plausible fork strategies:

1. **Happy base**: add Copilot SDK, a TUI, an OIDC/RBAC identity mode, a worker
   eligibility/scheduler layer, and more explicit command idempotency.
2. **AoE+CityHall base**: make AoE daemons/workers register outward, move from
   per-user-only workspace placement to optional per-session placement, and add
   a central event index/cursor. Wire Copilot natively instead of only through
   terminal/custom ACP.
3. **AgentAPI Proxy base**: replace the PTY-derived provider path with native
   Codex/Copilot adapters, make the post-allocation data path use the outbound
   manager tunnel, add capacity-aware selection, and build a TUI over the same
   session/event API.

Any of these forks may still be cheaper than reconciling a brand-new frontend,
worker, session reducer, provisioning system, and auth plane at once.

### Build if exact fleet semantics are required

Build these project-specific pieces:

- logical session registry and ownership;
- worker registration, heartbeats, capabilities, drain, and placement;
- workspace/worktree provisioning and generation tracking;
- native adapter supervisors and version compatibility matrix;
- normalized durable event log plus retained raw vendor payloads;
- idempotent prompt/approve/interrupt/steer APIs;
- controller lease and approval arbitration;
- resumable multiplexed stream for web and TUI;
- SSO/RBAC, credential brokering, policy, quotas, and audit as required;
- UI projections and search across every session.

Do not initially build:

- a new model/tool loop;
- transparent live migration of a dirty working tree;
- Kafka/NATS solely because the product has “events”;
- cross-vendor lowest-common-denominator objects that discard raw detail;
- a PTY parser as the authoritative adapter for Codex or Copilot.

## Recommended architecture

```text
                         ┌───────────────┐
                         │ Web UI / TUI  │
                         └───────┬───────┘
                                 │ commands + resumable stream
                      ┌──────────▼──────────┐
                      │ Central API/broker  │
                      │ sessions, scheduler │
                      │ auth, durable log   │
                      └──────────┬──────────┘
                                 │ outbound authenticated tunnels
                ┌────────────────┴────────────────┐
        ┌───────▼────────┐               ┌────────▼───────┐
        │ Worker A       │               │ Worker B       │
        │ checkout(s)    │               │ checkout(s)    │
        │ Codex/Copilot  │               │ Codex/Claude   │
        │ native runtime │               │ native runtime │
        └────────────────┘               └────────────────┘
```

Workers initiate outbound mTLS or workload-identity-authenticated WSS
connections. Harness ports remain private; stdio or Unix sockets connect the
worker adapter to the runtime. Each live vendor session has one upstream
controller, while the broker may fan its events out to many viewers.

The companion [architecture note](../design/multiplex-architecture.md) gives the
event envelope, lifecycle, security model, and MVP phases.

## A concrete two-week technical bake-off

1. **Happy and Autonomous Harness personal trials**
   - register two machines;
   - remotely start/resume Codex from the web client on each;
   - disconnect one machine mid-turn and record exactly what replays;
   - inspect how permission callbacks and duplicate RPCs behave;
   - run Copilot through Happy's generic ACP runner and test prompts,
     permissions, interruption, and reconnect; estimate native Copilot SDK and
     TUI integration only where ACP proves insufficient;
   - repeat with one Codex and one Copilot tmux session in Autonomous Harness,
     including remote creation and an approval, and decide whether its hosted
     relay plus terminal-derived fidelity are acceptable.
2. **AoE+CityHall trial**
   - deploy CityHall with its Kubernetes or Docker backend;
   - create two users and verify OIDC/RBAC boundaries;
   - run Codex and Claude structured sessions, then register Copilot ACP;
   - test approvals from two browser tabs and reconnect during a tool call;
   - decide whether one workspace per user is a feature or a blocker.
3. **AgentAPI Proxy trial**
   - register two external or native managers with different labels;
   - create sessions by explicit manager and `allocator.*` constraints;
   - verify ownership/RBAC, manager loss, route recovery, and replay behavior;
   - test the reverse-network path required for normal session traffic;
   - estimate replacing AgentAPI's screen-derived path with the native Codex
     app-server and Copilot SDK adapters.
4. **OpenHands and UHP fit checks**
   - register two OpenHands Agent Servers in one Canvas and verify whether
     backend switching or lack of an aggregate list is acceptable;
   - run Codex ACP on both and attempt Copilot as a custom ACP agent;
   - run one Codex session through HarnessRouter CE, inspect stored/replayed
     UHP events, and map the missing approval/steer operations;
   - decide whether UHP should be the public task/session API even if the worker
     tunnel remains custom.
5. **Native normalization spike**
   - pin one Codex and one Copilot version;
   - start one session of each through their native API;
   - map messages, tools, approvals, completion, usage, and errors into one
     envelope while retaining the raw payload;
   - replay the combined stream into a tiny terminal renderer.
6. **Decision gate**
   - adopt if a candidate meets the real operator workflow;
   - fork if the missing work is localized;
   - build the thin control plane only if placement, policy, or native fidelity
     cuts across the candidate's core assumptions.

## Suggested implementation order for a custom path

1. Codex and Copilot adapters; worker registration; session start/list/prompt,
   approve, and interrupt; durable per-session sequence; resumable web stream.
2. Minimal multi-session web UI and raw-event diagnostics.
3. TUI, Claude and generic ACP adapters, scheduler constraints, and worktree
   provisioning.
4. OIDC/RBAC, audit, quotas, credential brokering, and retention policies.
5. Migration/checkpointing only if host failure recovery proves more valuable
   than simply resuming on the pinned worker.

A TypeScript monorepo is a pragmatic starting point: Copilot and Claude have
first-class TypeScript SDKs, Codex generates TypeScript bindings, and React plus
Ink can share schemas and reducers. A Rust or Go worker remains reasonable if
process supervision and a single static binary outweigh shared types; that is a
later implementation choice, not an architectural dependency.

## Sources and volatility notes

Primary vendor sources:

- OpenAI: [Codex app-server](https://developers.openai.com/codex/app-server/),
  [Remote](https://developers.openai.com/codex/remote/), and
  [remote connections](https://developers.openai.com/codex/remote-connections/).
- GitHub: [Copilot SDK](https://github.com/github/copilot-sdk),
  [Copilot CLI ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server),
  and [Copilot CLI releases](https://github.com/github/copilot-cli/releases).
- Anthropic: [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview),
  [sessions](https://code.claude.com/docs/en/agent-sdk/sessions),
  [session storage](https://code.claude.com/docs/en/agent-sdk/session-storage),
  [hosting](https://code.claude.com/docs/en/agent-sdk/hosting),
  [agent view](https://code.claude.com/docs/en/agent-view),
  [self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments),
  and [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview).
- ACP: [protocol site](https://agentclientprotocol.com/) and the inspected
  [protocol repository](https://github.com/agentclientprotocol/agent-client-protocol/tree/9e6f550706b94705e8080b69f7cf46ca3cdb7614).

Open-source projects were inspected from their current branches on 29 August
2026. Exact commits are linked for the core architectural claims. These projects
and vendor schemas are moving quickly; re-run the bake-off and compatibility
tests before committing to an integration.
