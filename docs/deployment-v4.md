# Protocol-v5 personal deployment runbook

This runbook deploys the smallest supported data-role topology: one durable
authority control node, any number of runtime nodes, and one zero-authority
access gateway. Add branch control nodes only when one machine needs to own a
subtree of runtimes; connecting every runtime directly to the authority is
simpler.

## Persistence and ownership

Back up these paths as units:

| Role | Durable data | Authority |
| --- | --- | --- |
| Control node | `control-node.sqlite` plus WAL/SHM while live, and its identity file | Canonical catalog and metadata |
| Runtime node | runtime state directory plus identity | Native process/session bindings, command journal, metadata outbox |
| Access gateway | `access-gateway.sqlite` plus identity | Operational source locators/cursors only; never domain data |

Managed terminal PTYs, replay screens, subscriber buffers, and keyboard leases
are not backup data. They exist only in runtime memory and disappear on runtime
restart; no control or gateway database contains a copy.

Use each SQLite store from exactly one live process. Stop that process before
copying the raw database, or use the catalog backup API. Preserve file modes;
identity files are created with owner-only permissions. Do not place provider
keys, the shared transport secret, gateway bearer tokens, or raw p2prpc tickets
in logs or backups intended for sharing.

## Build boundary

Protocol v5 pins the independently released `@arduano/p2prpc-core` package.
Configure authenticated read access to the `@arduano` GitHub Packages scope,
then install and verify this tree:

```bash
npm ci --strict-allow-scripts
npm run check:docs
npm run check:release
npm run typecheck
npm test
```

Never copy npm credentials into an image layer. The qualification runners pass
an owner-only npm configuration into BuildKit and remove it after dependency
installation. The protocol-v5 mock acceptance Dockerfile is the reference for
synthetic scale runs; `tests/docker-live-four-container/Dockerfile` is the
reference for the real Codex/Copilot deployment boundary.

Develop transport changes in the sibling `../p2prpc` checkout. Run that
repository's full package and integration qualification, build one immutable
artifact, and release it before updating Multiplex's exact dependency. The
`v0.1.0` release and its authorizing live receipt both use public
`@arduano/p2prpc-core@0.2.1` and record its exact SHA-512 integrity. Some older
historical receipts record a sibling revision and staged-package digest; that
is historical provenance, not permission to restore a `file:` dependency.

Before upgrading a retained deployment, exercise the real transport beyond
both its former six-minute native-handle boundary and p2prpc's default
15-minute authenticated-session boundary:

```bash
AGENT_MULTIPLEX_LIVE_SOAK_MS=930000 \
AGENT_MULTIPLEX_LIVE_KEEP=0 \
npm run test:docker:v4:live
```

This acceptance uses real model calls. It keeps a browser and an independent
gateway stream attached throughout the soak, then requires fresh, exactly
reconstructed Codex and Copilot replies, native-history reads, and a healthy
source/runtime/session projection after transport reauthentication before it
passes. Do not replace this test by increasing the session TTL: retained
deployments must survive ordinary credential renewal.

### Native history around connection renewal

An inbound p2prpc `Peer` is one authenticated-session handle, not the durable
runtime route. The control node pins the endpoint and principal but resolves
the current peer for every reverse RPC and subscription attempt. If a history
read lands in the short interval between expiry and the runtime's next
heartbeat, the gateway returns `SERVICE_UNAVAILABLE` and the web UI retries
that read for a bounded 11.5-second window. It does not parse a transcript or
substitute cached history.

A recovered transient response can therefore appear as one HTTP 503 in browser
network diagnostics while the UI remains in its loading state. A persistent
`Native history unavailable` message, or any `INTERNAL_SERVER_ERROR`, is not an
expected renewal state: retain the gateway/control/runtime logs and check
endpoint enrollment, heartbeat progress, and the runtime's native app server.

## Bootstrap order

1. Generate one high-entropy transport secret for this trust domain and a
   separate bearer token for each gateway user/device.
2. Start the authority with only the runtime enrollment aperture open. Record
   its logical control-node ID, endpoint ID, and initial ticket through a
   trusted channel. If that ticket must remain usable after a process restart,
   configure `AGENT_MULTIPLEX_CONTROL_NODE_P2P_BIND` to a stable UDP
   `IP:port` and keep the same container/host port mapping. The persisted
   endpoint key preserves identity, but cannot make an obsolete ephemeral
   direct address reachable.
3. Start each runtime with the endpoint ID pinned independently from the
   ticket. Confirm it appears online, then close runtime enrollment and restart
   the control node.
4. Open gateway enrollment and configure the control node's grant ceiling.
   Start the gateway with a source that requests no more than that ceiling.
   Confirm `sources` reports `selected`, then close gateway enrollment.
5. Keep control-node HTTP on an explicit loopback address. Publish only the
   access gateway. Any non-loopback gateway bind requires bearer auth.

Gateway authorization has two independent ceilings. A mutation works only when
the gateway-to-control source enrollment grants its category and the caller's
HTTP bearer grants the same category. Defaults on both sides are read-only.
Available categories are `read`, `agent-launch`, `agent-archive`,
`agent-control`, `terminal-view`, `terminal-control`, `metadata-propose`,
`topology-admin`, and `authority-admin`; avoid the last two for ordinary UI
credentials.
`terminal-view` is sufficient to attach to an existing PTY. Opening one,
acquiring or taking over its keyboard lease, input, resize, and supported
termination require `terminal-control`, which also permits viewing but does not
grant general fleet reads. A full operator UI normally needs all of `read`,
`agent-launch`, `agent-archive`, `agent-control`, `terminal-view`, and
`terminal-control` at both ceilings.
Treat both terminal scopes as sensitive. Terminal output is opaque and
unredacted, and `terminal-control` is equivalent to a keyboard at the native
agent TUI under the runtime account's OS and harness permissions.

Enrollment is durable and endpoint-pinned. The current reference daemon does
not yet expose a peer-revocation CLI, so use enrollment flags only on a trusted
bootstrap network and provision a new control-node realm if an enrolled private
endpoint key or the fleet shared secret is compromised.

## Launch providers and lifecycle operations

The reference runtime statically enables `core.direct/workspace`, which launches
into an existing directory and advertises `isolation.none`. Treat any additional
gateway plugin, runtime launch provider, or backend as part of the deployed
application artifact. Protocol v5 has no dynamic plugin loader or sandbox. Pin
the artifact, verify each profile's contract version/schema hash, and keep
provider credentials in runtime-local files or secret injection rather than
launch input or metadata.

Launch and archive mutations are asynchronously accepted durable operations.
Monitor them with `launches.get/list/watch` and `archives.get/watch`; do not
assume the first response is terminal. Preserve retry-stable operation IDs and
never automatically repeat an `outcomeUnknown` effect. Provider preparation,
compensation, stop, and release hooks must remain compatible with the durable
provider implementation version recorded by the runtime.

Normal session views contain open running and stopped sessions. Archived rows
are intentionally cold and must be requested through bounded `sessions.search`
with the `archived` state. Before archive, stop the session and confirm its
runtime status is explicitly `stopped`; “offline” or “unavailable” alone is not
cleanup proof. Archive releases the native backend before provider-owned
resources and persists a native-binding tombstone before the authority hides
the session from hot snapshots.

Back up and restore the control and runtime stores as a coordinated operational
unit when provider resources matter. The control catalog owns canonical archive
visibility, while the runtime store owns cleanup checkpoints and tombstones.
Restoring only one side can require operator reconciliation even though both
databases remain individually valid.

## Managed terminal deployment

Terminals are an explicit escape hatch for sessions already owned by Agent
Multiplex, not a facility for adopting arbitrary CLIs or tmux panes. The web UI
does not auto-open them. Multiple observers may attach, while one client holds
each terminal's short renewable keyboard/resize lease. A dropped client naturally
loses control after the lease expires; do not persist or log the lease secret.

Set a conservative process-wide PTY limit on every runtime:

```bash
export AGENT_MULTIPLEX_RUNTIME_NODE_MAX_RUNNING_TERMINALS=32
```

The runtime keeps bounded screen/replay memory, disconnects slow viewers, and
routes frames through the existing authenticated p2prpc tree. No terminal byte
is added to SQLite, fleet snapshots, the normalized event stream, metadata, or
native history. A process restart is therefore a deliberate terminal boundary:
reopen the TUI if needed and use the harness's structured history API for
conversation recovery.

For Codex, the runtime creates a private Unix-socket app server, connects the
structured adapter directly to it, and starts stock TUIs with `codex resume
--remote` against that same server. Keep the socket directory
runtime-local and owner-only. Do not mount or publish it into a gateway/control
container. Exiting the managed TUI leaves the structured adapter and shared app
server running. OpenAI currently classifies the app-server command and
WebSocket transport as experimental and unsupported for production workloads,
so treat the repository's exact Codex package pin and passing live acceptance
receipt as part of the deployment qualification.

Copilot stock TUI support is off by default because Copilot has no supported
TUI-attach command. To test the hidden UI-server integration, provision the
exact CLI `1.0.81` on that worker and opt in explicitly:

```bash
export AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_EXPERIMENTAL_UI_SERVER=1
export AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_BINARY=/opt/copilot-1.0.81/copilot
```

The runtime probes the executable version, passes `--no-auto-update`, and
falls back to the normal structured Copilot adapter without terminal support if
the probe or startup fails. The TUI owns the shared SDK runtime, so remote
terminate/restart is intentionally unavailable and foreground-session changes
require confirmation.

Hidden UI-server `1.0.81` returns `AUTHENTICATION_NOT_CONFIGURED` when its SDK
client uses `COPILOT_CONNECTION_TOKEN`. The experimental implementation
therefore binds an unadvertised random port strictly to `127.0.0.1` without
that token. Do not publish, forward, or broaden this listener, and treat other
processes in the runtime's OS/container boundary as trusted. Always leave the
feature disabled where that trust assumption is unacceptable.

## Branches and failure behavior

A control-node branch has exactly one persisted desired parent. Configure its
parent logical ID, endpoint ID, and locator together on first bootstrap. Parent
or network failure changes only presence; it never changes authority. A branch
must be explicitly detached and then explicitly promoted before it can accept
canonical metadata. Promotion mints a fresh realm and authority epoch, so
rejoining divergent realms is an administrative merge problem rather than an
automatic reconnect.

Attachment handshakes advertise the child's current role and full subtree
coverage. Fresh authorities, explicitly detached branches, exact same-lineage
reconnects, and child boot rotation are supported. Implicit reparenting,
attaching an ancestor below its descendant, and overlapping an identity already
owned elsewhere in the parent tree fail before enrollment or topology state is
written. Keep control-node
transport authentication inside one trusted administrative domain because the
coverage is an authenticated child claim, not a consensus proof.

Protocol v5 intentionally does not claim an online graceful-detach protocol:
`topology.detach` fails before mutation. Use branch-local `topology.forceDetach`
only after treating the parent link as unavailable; it requires an audit record
and acknowledgement that in-flight metadata outcomes may be unknown. Promotion
then requires an additional split-brain acknowledgement. This conservative
boundary avoids presenting a parent commit plus best-effort child acknowledgement
as an atomic operation.

An access gateway may connect to multiple controls and multiple independent
realms. When it sees both an ancestor and descendant projection, it selects the
ancestor and keeps the descendant synchronized as a warm standby. Partial
overlap, conflicting realm claims, competing epochs, immutable topology or
native-session binding forks, same-revision metadata divergence, and
conflicting settled operation receipts are quarantined rather than merged. A
domain
identity duplicated across otherwise disjoint trees also fails closed; source
priority never resolves an identity conflict.

Warm standbys need not be byte-identical to the selected source. A standby may
lag monotonically in presence, liveness, runtime inventory generations, or
canonical metadata revision, while equal metadata revisions and immutable
bindings must agree. Consequently, failover may temporarily expose an older
canonical revision: the gateway does not guarantee read-your-writes across a
source switch until replication catches up. Retain mutation receipts and
operation identities, and do not resubmit a mutation merely because a read
through the replacement source is stale.

If the selected source becomes unavailable, an overlapping warm candidate is
validated again against the failed source's last accepted snapshot before it
can take over. Disconnecting the selected source therefore cannot erase the
comparison evidence or let a forked standby bypass overlap validation.

A control node is also the supported p2prpc proxy for its whole subtree; no
extra proxy daemon is required. Configure gateways against any mix of roots,
branches, and independent realms. Do not chain access gateways: they are
zero-authority presentation edges and intentionally cannot become sources.

## Operations

- Monitor source state, runtime presence, stream resets/gaps, SQLite integrity,
  disk space, pending metadata outbox/delivery counts, launch/archive/command
  `outcomeUnknown`, and repeated enrollment attempts.
- Treat a gateway source state of `conflict` as an operator incident, not a
  transient connectivity condition. Stop routing mutations through the
  affected overlap, identify the topology, binding, authority, metadata, or
  terminal-receipt disagreement, and restore a consistent projection before
  returning the source to service; priority changes and reconnects do not make
  conflicting domain state safe to merge.
- Treat `outcomeUnknown` as a real distributed-systems state. Do not blindly
  retry a mutation; recover the launch, archive, or command by its identity.
- A native-stream gap is not reconstructed from local files. Request history
  through the owning Codex/Copilot adapter.
- A terminal-stream reset can reconstruct only the bounded in-memory screen.
  Runtime restart or expired replay is not repaired from `readNativeHistory`;
  reopen the terminal and treat the old visual output as gone.
- Monitor terminal count/limit pressure, viewer overflows, expired or repeated
  lease takeovers, backend exits, and experimental Copilot fallback warnings.
- Keep runtimes' allowed-root lists narrow. The direct profile may launch only
  within an allowed existing root, but the native harness still executes with
  that machine's OS permissions.
- Periodically perform a clean shutdown/restart restore drill for every SQLite
  role and run the deterministic Docker acceptance before upgrading either
  Agent Multiplex or p2prpc.
- Supervise each daemon as one process-level transport generation. Ordinary
  peer/session loss reconnects in process; if the local native endpoint itself
  ever becomes terminal, restart the daemon with the same identity and SQLite
  paths instead of trying to rebuild individual source links inside it.

## Current scope boundary

This is suitable for trusted personal/internal deployment behind an existing
network or identity perimeter. The shared-secret transport is one trust domain,
not tenant isolation. The reference gateway uses static bearer credentials and
does not provide TLS termination, token rotation APIs, audit export, rate
limits, or an HA SQLite authority. Put it behind a private overlay or a reverse
proxy providing TLS and your normal identity controls when it leaves localhost.
