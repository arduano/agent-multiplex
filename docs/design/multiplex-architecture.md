# Original distributed multiplexer architecture exploration

> Historical design input, not the current wire contract. Protocol v4 role,
> authority, topology, persistence, and gateway decisions are normative in
> [`data-roles-v4.md`](data-roles-v4.md).

Status: design sketch following the
[harness/server research](../research/agent-harness-servers-and-multiplexing.md),
29 August 2026.

This is the custom-build shape to use **only if** the Happy, Autonomous Harness,
Agent of Empires+CityHall, AgentAPI Proxy, and applicable commercial pilots
cannot meet the required placement, policy, or native Codex/Copilot fidelity.

## Outcome

Build a small control plane and a worker daemon around existing coding-agent
runtimes:

```text
                      OIDC / company identity
                               |
                     ┌─────────▼──────────┐
                     │ API + event broker │
                     │ scheduler + policy │
                     └──────┬─────────────┘
                            │
              resumable    │    outbound authenticated worker tunnel
             event stream  │
        ┌───────────────────┼────────────────────┐
        │                   │                    │
 ┌──────▼──────┐     ┌──────▼──────┐      ┌──────▼──────┐
 │ Web client  │     │ TUI client  │      │ Worker      │
 │ projections │     │ projections │      │ supervisor  │
 └─────────────┘     └─────────────┘      └──────┬──────┘
                                                 │ stdio / Unix socket
                                ┌────────────────┼───────────────┐
                                │                │               │
                         Codex app-server   Copilot SDK     Claude/ACP
```

The control plane does not invoke models or reimplement tools. It assigns work,
owns the logical session namespace, records events, arbitrates control, and
proxies commands to the runtime that already owns the agent loop.

## Goals and explicit non-goals

Goals:

- one session list and event stream across users, vendors, directories, and
  machines;
- native Codex and Copilot behavior, followed by Claude and generic ACP;
- deterministic command and approval semantics across reconnects;
- durable completed history and enough raw data to diagnose adapter drift;
- outbound-only worker connectivity;
- both web and TUI clients over the same API and projections;
- personal mode with little configuration and an internal-service mode with
  OIDC/RBAC/audit.

Non-goals for the first release:

- a new coding-agent loop;
- seamless live migration of a process and dirty checkout;
- collaborative simultaneous editing of one agent session;
- exactly-once networks—use at-least-once delivery plus idempotency;
- lossless persistence of every token delta;
- arbitrary multi-agent workflow/DAG orchestration;
- making mutually untrusted tenants safe inside one shared OS account.

## Core invariants

1. A logical session has one owning principal and, while live, one assigned
   worker and workspace generation.
2. One broker-owned adapter connection is the upstream controller of a live
   vendor session. Browser tabs and TUIs never race vendor callbacks directly.
3. Every accepted command has a stable command ID. Repeated deliveries reuse
   the worker's recorded attempt/result; if a crash makes a non-idempotent
   vendor call ambiguous, the command becomes `outcome_unknown` and is
   reconciled rather than executed again blindly.
4. Every durable event is uniquely identified within a session epoch and
   receives a broker cursor after commit.
5. Completed messages, terminal tool states, approvals, errors, and turn
   completion are never intentionally discarded. Transient deltas may be
   coalesced.
6. A vendor session ID never stands in for the product session ID.
7. Conversation state and workspace state are tracked separately. Being able to
   resume the former does not imply that the latter exists.
8. Harness listeners are local to their worker. Only the worker tunnel crosses
   a machine boundary.

## Logical entities

```text
Principal
  └─ Project
       └─ LogicalSession
            ├─ WorkspaceGeneration ── Worker
            ├─ VendorBinding (vendor session/thread id + runtime version)
            ├─ Commands
            ├─ Events
            └─ ApprovalRequests
```

Suggested records:

- **principal**: user or service identity and policy boundary;
- **project**: repository source, allowed directories, credential reference,
  and default worker constraints;
- **worker**: identity, labels, capacity, runtime versions, supported adapters,
  health, and drain state;
- **workspace generation**: immutable identity for one checkout/worktree
  incarnation, including path, repository commit/base, container identity, and
  cleanup policy;
- **logical session**: stable user-facing ID, owner, vendor, title, lifecycle,
  current worker/workspace, and control policy;
- **vendor binding**: Codex thread, Copilot session, Claude session, or ACP
  session ID plus adapter and CLI/SDK versions;
- **session epoch**: one adapter attachment/run generation; increment it when a
  new worker-side producer could restart its sequence;
- **command**: stable idempotency key plus delivery, attempt, result, and
  crash-ambiguity state;
- **event**: normalized envelope plus optional raw vendor payload;
- **approval**: durable compare-and-set state for a vendor callback;
- **controller lease**: optional short lease identifying the client allowed to
  mutate an interactive session;
- **audit entry**: actor, action, target, policy result, request ID, and time.

## Worker design

### Registration and connectivity

The worker starts an outbound mTLS, workload-identity-authenticated gRPC stream,
or WSS connection to the control plane. Outbound initiation works behind NAT and
avoids publishing agent runtimes.

On registration it reports:

```json
{
  "worker_id": "w_...",
  "boot_id": "...",
  "labels": { "pool": "engineering", "region": "syd", "gpu": "false" },
  "os": "linux",
  "arch": "x86_64",
  "capacity": { "sessions": 8, "cpu": 16, "memory_mb": 32768 },
  "adapters": {
    "codex": { "version": "0.150.1", "native": true },
    "copilot": { "cli_version": "1.0.81", "sdk_version": "1.0.11" },
    "acp": { "version": "1" }
  }
}
```

The broker returns a connection/lease generation. Commands addressed to an old
worker boot or lease are rejected, preventing a delayed connection from acting
after a replacement has registered.

Heartbeat state should include capacity and session summaries, not full event
history. The worker supports **drain** (finish or stop accepting new sessions)
and **cordon** (no new placement) separately from disconnect.

### Local responsibilities

The worker:

- validates that assigned paths are within configured workspace roots;
- provisions/clones a repository or creates a dedicated worktree;
- obtains narrowly scoped credentials through a broker reference;
- launches and supervises vendor runtimes;
- translates vendor commands/events through an adapter;
- keeps an on-disk command-deduplication journal;
- spools non-acknowledged durable events locally;
- kills orphan processes and cleans workspaces according to policy;
- reports version/capability changes rather than silently changing semantics.

It must not trust a central request containing an arbitrary absolute path. The
worker resolves a project/workspace identifier against its own configured roots
and rejects traversal, symlink escape, and disallowed mounts.

### Vendor process topology

Start with isolation over maximum density:

| Vendor | Initial topology | Later optimization |
|---|---|---|
| Codex | One app-server process per principal/workspace trust boundary; several threads only when they share that boundary | Pool threads in a long-lived per-principal daemon after crash and resource behavior is measured |
| Copilot | One SDK/CLI runtime per principal/container; multiple sessions may share it | Tune session density and split noisy/failing runtimes |
| Claude | One SDK-backed subprocess per session | Container pooling around subprocesses, not sharing an agent process |
| ACP | One process per session unless the implementation explicitly supports safe multiplexing | Adapter-specific pools |
| Terminal fallback | One runtime-owned PTY for a bound native session, ephemeral and clearly marked unstructured | Keep it managed; do not adopt arbitrary processes or tmux panes |

All worker/vendor traffic uses stdio or Unix sockets where possible. Experimental
TCP listeners stay loopback-only and are never treated as an authentication
boundary.

## Placement and workspace lifecycle

### Scheduling inputs

A session request includes hard constraints and soft preferences:

```json
{
  "vendor": "codex",
  "project_id": "p_...",
  "workspace_mode": "new_worktree",
  "constraints": {
    "pool": "engineering",
    "os": "linux",
    "required_adapter": ">=0.150 <0.151",
    "data_region": "au"
  },
  "preferences": { "worker_id": "w_laptop", "warm_repo": true }
}
```

For the MVP, choose among healthy eligible workers by available session slots,
then prefer an already-cached repository and the user's preferred machine. Do
not hide the decision: record a placement explanation in the session and audit
log.

Scheduling state:

```text
requested -> assigned -> provisioning -> starting -> idle/running/waiting
                                        ↘ failed
idle/running/waiting -> stopping -> stopped
any live state -> unreachable (worker lease expired)
```

Assignment is a database compare-and-set with a lease. If provisioning does not
start before the lease expires, the broker may assign a new worker only after
invalidating the old generation. The worker must present the assignment token
before publishing session events.

### One worktree per session

Default to one worktree or checkout per agent session. Two agents writing to the
same dirty tree create races that no event protocol can repair. An explicit
“shared workspace” mode may exist for trusted personal use, with warnings and no
automatic conflict guarantees.

Record:

- repository identity and remote;
- base commit and branch;
- worktree path as resolved on the worker;
- container/OS identity;
- workspace generation;
- cleanup/retention policy;
- optional final commit, patch artifact, and dirty status.

### Pinning and migration

Pin a live session to its worker for the MVP. On a transient disconnect, show it
as unreachable and let the original worker reattach. Do not start a second copy
of a possibly live agent.

Cross-host recovery is a later, explicit workflow:

1. fence the old worker/session epoch and, where the infrastructure permits,
   prove the old sandbox/process has stopped;
2. materialize a clean commit or a patch/archive of workspace state;
3. provision a new workspace generation;
4. restore vendor conversation state if that vendor supports it;
5. start a new epoch and show a migration boundary in the transcript.

Claude SessionStore, Codex rollout data, or Copilot persisted events can help
with step 4. None substitutes for steps 1–3.

A broker fencing token only stops the old worker from publishing or receiving
commands; it cannot stop a partitioned agent from continuing to write files or
call external services. Automated failover is safe only when the compute layer
can fence/terminate the old sandbox or all consequential resources enforce the
same lease. Otherwise recovery must surface the split-brain risk to an operator.

## Command semantics

Use ordinary request APIs for mutation, even if events use WebSocket or SSE:

```text
POST /v1/sessions
POST /v1/sessions/{id}/prompts
POST /v1/sessions/{id}/steer
POST /v1/sessions/{id}/interrupt
POST /v1/approvals/{id}/resolve
POST /v1/sessions/{id}/stop
```

Every mutating request requires an `Idempotency-Key`. The broker stores the
command before dispatch and returns the original result on a retry with the same
actor, target, and key. A key reused for different content is an error.

Command lifecycle:

```text
accepted -> dispatched -> acknowledged -> completed
                      ↘ retryable delivery
accepted/dispatched -> rejected | expired | failed | outcome_unknown
```

Delivery between broker and worker is at least once. Before invoking a vendor,
the worker durably journals the command as started; afterward it records the
terminal outcome before acknowledging it to the broker. Adapter operations that
cannot be made intrinsically idempotent are serialized per session. If the
worker crashes between the vendor effect and its terminal journal write, it
must first reconcile vendor history/state. When the effect cannot be proven or
disproven, report `outcome_unknown` and require an explicit new command rather
than risking a duplicate prompt, approval, or interrupt. End-to-end exactly-once
effects are impossible unless the vendor operation itself supports an
idempotency key.

Do not infer that a timed-out client request failed. Return the command ID so a
client can read its eventual outcome.

## Event model and replay

### Envelope

Keep normalized and raw forms together:

```json
{
  "session_id": "s_...",
  "session_epoch": 3,
  "session_sequence": 418,
  "global_cursor": 923771,
  "worker_id": "w_...",
  "vendor": "codex",
  "vendor_version": "0.150.1",
  "vendor_session_id": "thread_...",
  "turn_id": "turn_...",
  "item_id": "item_...",
  "request_id": null,
  "type": "tool.completed",
  "data": { "tool": "shell", "status": "success", "summary": "..." },
  "raw_vendor_event": { "method": "item/completed", "params": {} },
  "occurred_at": "2026-08-29T02:15:03.114Z",
  "recorded_at": "2026-08-29T02:15:03.190Z"
}
```

`(session_id, session_epoch, session_sequence)` is unique. The worker assigns
the per-epoch sequence before spooling. The broker assigns `global_cursor` in
commit order and acknowledges a durable event only after the database
transaction commits. Do not implement that promise with a bare PostgreSQL
sequence: concurrent transactions can allocate values and then commit in the
opposite order, which could make a reconnecting client skip a late lower
cursor. For the MVP, serialize cursor allocation through a locked feed-counter
row (globally or per tenant) in the same transaction as the event insert;
later, an ordered outbox publisher can preserve the invariant at higher scale.
A worker reconnect sends events after its highest acknowledged contiguous
sequence; duplicate inserts are harmless.

The global cursor is for reconnect and multiplex ordering, not causal ordering
between unrelated sessions. Clients must tolerate cursor gaps caused by RBAC
filtering.

### Canonical event types

Begin with a deliberately small stable set:

```text
session.created | session.assigned | session.status_changed | session.stopped
turn.started | turn.completed
message.delta | message.completed
reasoning.delta | reasoning.completed
tool.started | tool.output | tool.completed
diff.updated
plan.updated
approval.requested | approval.resolved
question.requested | question.resolved
usage.updated
command.completed
adapter.warning | error
```

Do not force every vendor concept into one of these. An event may be
`vendor.<name>` with its raw payload until a useful cross-vendor meaning is
clear. Preserve parent/child and subagent identifiers when vendors provide
them.

### Durable versus transient

Persist as authoritative:

- complete user and assistant messages;
- turn boundaries and outcomes;
- tool start plus terminal result and bounded output;
- approval/question request and resolution;
- usage snapshots needed for accounting;
- errors, adapter warnings, placement, and lifecycle transitions;
- diff/plan snapshots needed to reconstruct the UI.

Token, reasoning, and progress deltas can be broadcast immediately and
coalesced into periodic checkpoints. Under backpressure, discard or combine
only events marked transient; never discard a request or terminal state.

Large tool output, terminal recordings, images, and patch bundles belong in
object storage with a content hash and authorization-checked reference. Do not
inflate every event row with megabytes of output.

### Client streaming and projections

Offer one resumable endpoint, for example:

```text
GET /v1/events?after=923771&session_id=s_1,s_2
```

SSE is adequate if commands remain HTTP requests. A WebSocket is useful when
subscription filters change frequently or the TUI wants one duplex connection.
Whichever transport is chosen, define application-level cursors, keepalives,
and snapshot recovery; WebSocket delivery alone is not replay.

The API maintains materialized session summaries and reduced state. A client
opening a long session should fetch:

1. a current projection/snapshot;
2. a recent transcript page;
3. live events after the snapshot cursor;
4. older pages on demand.

Do not make each client fold millions of raw deltas from cursor zero.

For an initial single API process, commit events and an outbox record in
PostgreSQL, then fan out in process. Add `LISTEN/NOTIFY`, Redis, NATS, or Kafka
only when multiple replicas or measured throughput require it. PostgreSQL is
already the durable coordination system; an extra broker does not create
correctness by itself.

## Approvals, questions, and control arbitration

### One upstream controller

Codex and other runtimes may broadcast a request to several subscribers even
though only one response can win. The adapter connection is therefore the sole
vendor-facing controller. It emits a durable request and waits on the broker,
not on a particular browser socket.

Approval state:

```text
pending --compare-and-set(decision, actor, version)--> resolved
       \--timeout/session-stop-----------------------> expired
```

Resolving the same request with the same decision is idempotent. A different
second decision returns the recorded winner. The worker sends the upstream
response once and journals that action.

Policy can auto-resolve selected requests, but the event and audit record still
identify the policy version as actor. Default timeout behavior should be deny or
cancel, never silently allow.

### Viewer versus controller

Many clients can view a session. Mutation can be controlled in either of two
ways:

- **MVP:** owner/RBAC checks plus per-command compare-and-set; simultaneous
  prompts are serialized.
- **Collaborative mode:** a renewable controller lease is required for prompt,
  steer, interrupt, and approvals. A tab explicitly takes or transfers control;
  everyone else remains read-only.

The lease is a product coordination mechanism, not the worker fencing token.
Worker/session epochs provide the latter.

## Security model

### Trust boundaries

For personal mode, sessions may share the user's OS identity. For internal use,
isolate at least per principal/trust boundary:

- separate container/VM or OS account;
- separate checkout/worktree;
- separate vendor configuration home (`CODEX_HOME`, Claude config, Copilot
  credentials) unless sharing is explicitly intended;
- scoped Git and vendor credentials;
- CPU, memory, process, filesystem, and network limits.

An agent with shell access is code execution. A harness “approval mode” is not
a multi-tenant sandbox. Conversely, a container does not by itself make shared
long-lived credentials safe.

### Identity and authorization

- Users authenticate to the API through OIDC in company mode.
- Workers enroll through a short-lived bootstrap flow and receive a renewable
  workload identity; a human bearer token is not copied to machines.
- RBAC checks both the requested action and session/project ownership.
- Worker labels and project policy restrict where a repository may execute.
- The central API never returns vendor secrets after storage.
- Terminal/raw-shell access is a separate high-risk permission from structured
  prompt/approval access.

### Audit and sensitive data

Audit worker enrollment/drain, placement, session lifecycle, prompts, approvals,
interrupts, controller transfer, terminal attachment, secret-reference use, and
administrative access. Store hashes/references when the content itself is too
sensitive for the audit table.

Raw vendor events and tool output can contain source, prompts, environment
values, and credentials. Give them explicit retention, encryption, redaction,
export, and deletion policies. Redaction is defense in depth; prevent secret
values from entering logs in the first place.

## Failure behavior

| Failure | Required behavior |
|---|---|
| Browser/TUI disconnect | Agent continues; reconnect with last cursor and fetch projection/delta |
| API restarts | Commands/events survive in PostgreSQL; worker reconnects and retransmits unacknowledged events |
| Worker tunnel drops | Mark sessions unreachable after lease; do not duplicate them; accept fenced reattach from the same boot/generation |
| Worker process restarts | New boot ID; reconcile supervised processes and local journals before claiming sessions |
| Harness crashes | Emit adapter error, preserve workspace/vendor ID, apply bounded restart policy; never fabricate completion |
| Duplicate prompt request | Same idempotency key returns the same command; the worker reuses its journal. A crash-ambiguous vendor call is reconciled or marked `outcome_unknown`, never blindly repeated |
| Two approval decisions | Database compare-and-set records one; second caller receives the winner |
| Event duplicate/out of order | Unique epoch/sequence deduplicates; buffer small gaps, request retransmit, then mark a discontinuity |
| Local spool fills | Coalesce/drop transient deltas first; pause new sessions; never silently discard authoritative events |
| Worker permanently lost | Session stays recoverable/unreachable; offer explicit workspace/vendor recovery workflow |
| Vendor schema changes | Quarantine unknown payload as raw event, emit adapter warning, and gate unsupported commands by advertised capability |

## Minimum API surface

User/client API:

```text
GET    /v1/workers                         # scoped inventory/capabilities
GET    /v1/sessions                        # filter by owner/project/state/vendor
POST   /v1/sessions                        # create and place
GET    /v1/sessions/{id}                   # projection + cursor
GET    /v1/sessions/{id}/events            # paginated history
POST   /v1/sessions/{id}/prompts
POST   /v1/sessions/{id}/steer
POST   /v1/sessions/{id}/interrupt
POST   /v1/sessions/{id}/stop
POST   /v1/approvals/{id}/resolve
POST   /v1/questions/{id}/resolve
GET    /v1/events?after={cursor}            # SSE or WebSocket upgrade
```

Worker tunnel messages:

```text
worker.register / worker.heartbeat / worker.drain
assignment.offer / assignment.accept / assignment.reject
command.deliver / command.ack / command.result
event.batch / event.ack / event.nack_gap
session.reconcile / session.fenced
```

Every protocol message carries a schema version, stable message ID, worker boot
ID, and where relevant the assignment/session epoch.

## Storage sketch

PostgreSQL tables for the first implementation:

```text
principals, roles, projects
workers, worker_connections, worker_capabilities
sessions, workspace_generations, vendor_bindings
commands, command_deliveries
events, session_projections
approvals, questions, controller_leases
audit_entries, outbox
```

Important constraints:

- unique `(session_id, epoch, sequence)` on events;
- unique `(actor_id, idempotency_key)` plus request hash on commands;
- one current assignment generation per session;
- one pending vendor request per `(session_id, vendor_request_id, epoch)`;
- optimistic version columns on approvals, projections, and assignments.

Use object storage only for large artifacts. A SQLite deployment can support a
single-user personal mode, but keep the repository interfaces compatible with
PostgreSQL transactions if company mode is likely.

## Adapter contract

Keep vendor-specific types inside adapters and expose capabilities rather than
assuming every method exists:

```ts
interface HarnessAdapter {
  readonly vendor: string;
  probe(): Promise<AdapterCapabilities>;
  start(input: StartInput): Promise<VendorBinding>;
  resume(binding: VendorBinding): Promise<void>;
  prompt(command: PromptCommand): Promise<void>;
  steer?(command: SteerCommand): Promise<void>;
  interrupt(command: InterruptCommand): Promise<void>;
  resolveRequest(command: ResolveRequestCommand): Promise<void>;
  events(): AsyncIterable<AdapterEvent>;
  snapshot(): Promise<AdapterSnapshot>;
  stop(reason: string): Promise<void>;
}
```

Adapter output includes both a normalized candidate and the original vendor
message. The central normalizer validates/enriches it with the logical session,
epoch, sequence, and retention class.

Priority:

1. Codex native app-server;
2. Copilot native SDK;
3. Claude Agent SDK;
4. ACP v1 generic adapter;
5. terminal/tmux compatibility adapter.

## UI projections

Web and TUI share types, reducers, and command APIs. Both should expose:

- session list grouped by project, worker, owner, and attention state;
- clear running / idle / waiting-for-approval / unreachable states;
- transcript with tool, diff, plan, question, and approval cards;
- worker and workspace identity on every session;
- command delivery state rather than optimistic “sent means executed”;
- searchable completed history;
- a raw vendor-event/adapter diagnostic view for developers;
- terminal attachment as an explicit side channel when available.

The browser should not be required to stay open for a command, question, or
approval to complete. The TUI should be a client of the central API, not an SSH
launcher that develops separate semantics.

## MVP delivery plan

### Phase 0: decide adopt, fork, or custom

- Run the Happy, Autonomous Harness, AoE+CityHall, and AgentAPI Proxy bake-offs
  from the research note; evaluate Warp as a buy option if a hosted commercial
  control plane is permissible.
- Implement the Codex/Copilot normalization spike.
- Write down the non-negotiable difference that justifies a fork or custom
  build.

### Phase 1: reliable vertical slice

- one API process and PostgreSQL;
- one worker binary/daemon with outbound connection;
- Codex app-server and Copilot SDK adapters;
- manual worker selection, one worktree per session;
- create/list/prompt/interrupt/approve;
- durable command IDs, event epoch/sequence, reconnect and replay;
- minimal web UI.

For a personal-only pilot, the process can bind loopback and use one local
principal. Before another employee or machine is admitted, pull forward OIDC,
session ownership checks, workload identity, per-principal isolation, scoped
credentials, and audit from Phase 3; those are security gates, not optional
polish for a multi-user deployment.

Acceptance test: start one Codex and one Copilot session on two workers, kill
both client connections during active turns, reconnect, see one continuous
history, and resolve an approval once from either client.

### Phase 2: operator experience

- TUI using the same API/reducers;
- automatic eligible-worker scheduling;
- Claude SDK and ACP adapters;
- session search, diff/tool views, notifications;
- worker drain, reconciliation, bounded runtime restart;
- raw terminal side channel.

### Phase 3: company controls

- OIDC, ownership, RBAC, audit, quotas, and retention;
- secret broker integration and per-principal runtime homes;
- container/VM isolation profiles and network policy;
- admin placement explanations and support access;
- HA API deployment if actual load requires it.

### Phase 4: recovery, only if justified

- clean workspace checkpoint/patch bundles;
- explicit cross-host resume workflows;
- vendor-specific transcript portability;
- failover drills and fencing proofs.

## Implementation choice

A TypeScript monorepo is the shortest native path:

```text
apps/api       Fastify/Hono/Nest-style API + auth + streaming
apps/worker    process supervisor and adapters
apps/web       React
apps/tui       Ink or another terminal renderer
packages/wire  commands, events, schemas, reducers
packages/adapters/{codex,copilot,claude,acp,pty}
```

Reasons: first-class Copilot and Claude SDKs, generated Codex TypeScript
bindings, and shared schemas/reducers across React and a TypeScript TUI. Use
PostgreSQL with explicit SQL or a transaction-capable query layer; keep the
event/command invariants visible rather than burying them in an ORM.

A Rust/Go worker can replace the TypeScript supervisor later if deployment as a
static binary or tighter resource control matters. Do not split languages
before the native integration spike reveals a concrete benefit.

## Decision rule

Choose the smallest option that preserves the required invariant:

- If personal remote spawn plus one panel is enough, adopt/fork **Happy**.
- If a hosted encrypted web/hardware panel over existing tmux agents is enough,
  pilot **Autonomous Harness**.
- If company users can each receive a persistent workspace/pod, adopt/fork
  **AoE+CityHall**.
- If manager federation and RBAC are the main missing pieces and terminal-level
  fidelity is initially acceptable, pilot/fork **AgentAPI Proxy**.
- If a vendor-hosted commercial control plane is acceptable, evaluate **Warp**
  before building equivalent operator surfaces.
- If the system must place individual sessions across arbitrary registered
  machines and centrally merge/arbitrate native Codex and Copilot state, build
  this thin control plane.

That boundary keeps the project focused on the part the ecosystem has not
already built.
