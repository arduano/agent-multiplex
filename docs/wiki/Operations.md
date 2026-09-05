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

## Bootstrap discipline

Enrollment flags are temporary apertures. Open one role at a time, enroll and
pin expected endpoints, verify the topology, then close the aperture and restart
the control if configuration requires it. Defaults are read-only. Keep ordinary
UI credentials separate from topology/authority recovery credentials.

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
