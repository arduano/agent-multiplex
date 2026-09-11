# Operations

Operate Agent Multiplex as three distinct stateful roles. One control-node
failure affects authority and routing; one runtime failure affects native
bindings; one gateway failure affects presentation only.

## Recommended topology

For personal deployment, start with:

- one authority control node on the laptop or most durable machine;
- runtimes connected directly to it;
- one authenticated access gateway exposed through the private network.

Add branch controls only when a machine or site needs to own a runtime subtree.
Add more gateways freely for desktop, mobile, or dashboard clients; gateways do
not become sources for each other.

## Process supervision

Run one live writer per SQLite store. Give each daemon:

- a fixed state/identity path on durable local storage;
- the same shared secret for its trust domain through a secret source;
- restart-on-failure with bounded backoff;
- graceful termination time before forced kill;
- stable UDP reachability when restart-safe direct tickets are required;
- logs captured to a restricted sink with secret filtering.

Keep control-node HTTP loopback-only. Expose only a bearer-authenticated gateway
through Tailscale, a LAN, or an identity-aware reverse proxy. Tailscale network
membership does not replace gateway authentication.

Runtime shutdown stops admitting native/provider work and waits for admitted
operations before closing their handles and backends. Give it enough time to
drain; the service does not impose a shutdown timeout. Cleanup continues after
individual failures and reports an aggregate error after all attempts finish.
Embedding applications must close their SQLite store in `finally`, after
awaiting service shutdown, including when shutdown rejects.

Runtime registration starts presence heartbeats without waiting for initial
native inventory or metadata delivery. Both maintenance lanes run independently
and retain one in-flight job across reconnects. Results arriving after connection
retirement or the 30-second acceptance deadline are discarded; a deadline does
not cancel the underlying request or free its slot for duplicate work. Already
dispatched control mutations remain governed by their boot, authority and stable
operation-ID fences. Metadata retries retain those IDs. Presence therefore
reports daemon connectivity independently of a stalled native harness; it does
not prove that agent commands are responsive. Copilot read deadlines and recovery
limits are described in the [adapter guide](Adapters-and-Terminals.md#stalled-copilot-reads).

## Bootstrap discipline

Enrollment flags are temporary apertures. Open one role at a time, enroll and
pin expected endpoints, verify the topology, then close the aperture and restart
the control if configuration requires it. Defaults are read-only. Keep ordinary
UI credentials separate from topology/authority recovery credentials.

For initial standalone-authority attachment to a new root, first inspect and
drain metadata outboxes, pending receipt deliveries and in-flight metadata or
archive operations. Include runtime outboxes in this check: old unknown patches
are deliberately not retargeted to a different authority. Back up each stopped
control and its identity before changing the desired parent. Stop only the
control service when the runtime is independently supervised; control outages
do not require stopping native agents. Run the control catalog's
`assertCanAttach()` preflight before dispatching the first attachment.

The appended control migration records the old authority's immutable receipt
handoff. Upgrade both attaching controls and their new root together; previous
binaries cannot open the new control-store migration. Runtime schema and wire
protocol stay unchanged. After attachment, verify unchanged runtime/native
identities, complete root open-session search, historical receipt reconciliation,
and root-offline operation through any local branch gateway. Cold archived
search may still require an online child; this is not an archive replication
feature. See [architecture guidance](Architecture-and-Data-Roles.md#attaching-an-existing-host-catalog).

## Monitor

At minimum alert on:

- gateway source `unavailable`, `conflict`, frequent reselection, or reset loops;
- authority, branch, runtime, boot, attachment, or feed generation changes;
- runtime heartbeat age and repeated enrollment failures;
- SQLite integrity failures, disk pressure, WAL growth, and backup age;
- pending runtime metadata outbox or control delivery intents that do not drain;
- launch, archive, metadata, or command `outcomeUnknown`;
- native gaps, repeated history failures, and interaction backlog;
- running-terminal limit, viewer overflow, lease-takeover churn, and PTY exits;
- provider-specific resource leaks after failed or archived launches.

Use `agent-multiplex describe`, `sources`, `control-nodes`, `runtime-nodes`,
`sessions`, `interactions`, and `watch` for operator inspection. Use JSON/NDJSON
mode when integrating alerts.

## Capacity

The retained mock qualification ran 100 sessions on 10 runtimes with exact
event reconstruction and no gaps or duplicates. Treat it as a control-plane
baseline only. Size real deployments from measured per-harness app-server,
native child-process, terminal, workspace, and provider resource use.

Prefer horizontal runtime distribution and bounded launch concurrency. A shared
app server improves density but is a larger failure and trust domain. A profile
that promises isolation must run its app server and adapter endpoint inside the
isolated backend.

## Normal maintenance

1. Confirm no unexpected non-terminal or `outcomeUnknown` operations.
2. Take verified backups of each stateful role and its endpoint identity.
3. Run a restore drill away from production paths.
4. Build and test the exact candidate source and p2prpc boundary.
5. Requalify pinned Codex/Copilot dependencies when changed.
6. Drain or stop launches according to provider policy, then upgrade one role
   at a time only when that mixed-version path is qualified.
7. Confirm source selection, runtimes, open sessions, history, and fresh
   commands after restart.

## Incident rules

- `conflict` is a correctness incident, not transient liveness. Stop mutations
  through the overlap and find the authority, topology, binding, metadata, or
  operation fork. Priority cannot make it safe.
- `outcomeUnknown` means a side effect may have happened. Query the same durable
  operation ID and inspect provider/native state before deciding any repair.
- A native gap is recovered with the owning adapter's history API, never vendor
  file parsing.
- A terminal gap has only bounded in-memory screen recovery. After runtime loss,
  its old visual history is gone by design.
- Disconnecting a branch does not promote it. Force-detach and promotion are
  explicit last-resort administrative operations with split-brain risk.

See [Backups, upgrades, and recovery](Backups-Upgrades-and-Recovery.md) and the
detailed [deployment runbook](../deployment-v4.md).

## Storage stalls and an isolated authority

The reference control supports `AGENT_MULTIPLEX_CONTROL_NODE_STORAGE_OWNER=worker`
(or `storageOwner: "worker"` when embedded). This composition is for an authority
with child controls, no upstream and no locally owned runtimes. The existing
catalog, domain service and validating router share one worker and one SQLite
writer; HTTP and QUIC stay on the transport thread. Combined control/runtime
hosts retain the normal composition and need their own maintenance window.

The trusted loopback `/health` endpoint does no filesystem work. It reports the
age of the worker's last progress message, fixed-category catalog timings and
counters, bounded IPC queue count/bytes/age, child-feed failure count, and transport
event-loop delay. Progress older than ten seconds returns 503. This distinguishes
responsive transport from stalled storage; it neither declares native agents
stopped nor grants a stale authority route. The counters describe attempted work,
including rolled-back transactions; elapsed timings describe completed attempts.

IPC admits at most 256 outstanding requests, 32 MiB of arguments and 8 MiB per
payload. Response credits are released only after the receiving thread consumes
them; buffered large replies are capped at 32 MiB with bounded small error replies.
A queued request whose deadline expires is rejected before dispatch. A dispatched
mutation timeout, owner exit or untransferable result is outcome unknown under its
original operation ID. Read failures remain unavailable. Timed-out lanes stay
occupied until settlement; no timer creates another writer or replays a mutation.
Streams pull one item at a time and retain at most 128 handles. Idle pulls have no
synthetic deadline; late stream opens are closed and cancellation retains its slot
until native settlement.

During a complete worker stall, fresh catalog snapshots and authority operations
are unavailable. Gateways retain previously committed display observations and
use validated direct child routes. They never label a cached root snapshot as a
fresh snapshot to authorize failback. Root-only offline rows across a cold client
reload remain a separate display-cache concern. Neither worker threads nor QUIC
can repair a stalled kernel syscall, code page fault or machine-wide failure.

Shutdown closes admission and child pumps, drains admitted domain operations and
then closes the catalog. The transport caller has a bounded shutdown deadline;
a missed drain remains a failure and does not release the SQLite writer lock.
No watchdog starts a replacement worker. Verify the old process actually exited
before restarting; never delete its lock as a timeout workaround. Ordinary runtime
stores retain WAL/FULL durability and existing filesystem placement.
