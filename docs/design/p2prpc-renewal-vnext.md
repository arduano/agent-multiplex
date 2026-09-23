# Authenticated transport renewal, contract 1

Status: independent core `@arduano/p2prpc-core@0.3.0-renewal.0` was published
from [`ca7bb6fb7b791813c937ddbf9bde62423d097373`](https://github.com/arduano/p2prpc/commit/ca7bb6fb7b791813c937ddbf9bde62423d097373)
at tag [`v0.3.0-renewal.0`](https://github.com/arduano/p2prpc/releases/tag/v0.3.0-renewal.0).
This branch requires coordinated replacement of every p2prpc peer. Core
publication alone does not qualify the combined framework and consumer graph;
see the [handoff](../wiki/Transport-Renewal-Handoff.md).

## Problem and maintained boundary

Published p2prpc 0.2.1 retires authenticated connections at an effective maximum
900,000 ms. Closing a child subscription correctly marks its projected subtree
unreachable. The next authenticated heartbeat and snapshot restore it, producing
periodic outages despite unchanged control/runtime boots. Increasing the TTL or
adding a grace period to child presence would conceal the transport defect.
Irregular Windows/native Copilot stalls and root storage stalls are separate
problems; this change makes no claim to repair them.

The correction belongs in p2prpc. Physical QUIC connection lifetime, authenticated
grant lifetime, and domain boot/feed/attachment lifetime are distinct. A fresh
mutual handshake replaces the short-lived authentication generation on the same
physical connection. Existing ordered QUIC streams and their RPC invocations
continue across that boundary. There is one feed iterator and one mutation
invocation, with no mirrored writer, subscription restart, snapshot or replay.

## Contract and security

The independently published core is `0.3.0-renewal.0`, exports
`SESSION_RENEWAL_CONTRACT = 1`, uses transport wire/ALPN v5 and handshake format v4.
Multiplex domain protocol is v6, and its p2prpc application contract becomes
`6.renewal.1`. Older peers fail negotiation. No mixed-version fallback exists.
Every authenticated session exposes a monotonic generation, starting at zero for
each new physical connection. The fresh transcript binds the previous session
identity and next generation as well as both endpoint identities, fresh nonces,
roles, protocol and credentials. Duplicate or stale handoffs fail closed.

The physical QUIC initiator schedules renewal halfway through the remaining
grant. A responder rejects a replacement before one quarter of its installed
grant has elapsed. The original hard
expiry watchdog remains armed throughout preparation; an unfinished handshake
cannot extend it. There is at most one pending replacement. Both endpoints
repeat credential validation, endpoint admission and active-operation policy
checks, including idle subscriptions. Authorization admission is serialized with
handoff. Authority-changing credentials cannot silently inherit the old request
context: principal identity, scopes and claims must remain identical except
token freshness fields `exp`, `iat`, `nbf` and `jti`. Existing procedure contexts
remain immutable admission snapshots; their captured file facades cannot gain
new authority after that generation retires.
A rejected credential or policy check closes the connection promptly. A stalled
or otherwise failed replacement cannot keep old credentials alive past expiry.

Overlap is between the old admitted grant and one uncommitted candidate, not
between two independently writable transports. Only the committed generation
admits operations. No credential, token, raw locator, request body or provider
endpoint belongs in renewal diagnostics. Security events and generation/expiry
counters may be observed without logging credentials.

Revocation is checked whenever the authenticator or authorizer runs, including
renewal. Offline JWT validation cannot discover issuer-side revocation before
its configured key/introspection policy does. Shared-secret membership alone
cannot revoke one holder: endpoint enrollment/policy is required. This design
preserves that trust model and does not promise instantaneous issuer revocation.
The maximum grant lifetime remains 15 minutes. Wall-clock jumps or skew beyond
the configured handshake bound fail closed; they never authorize a longer grant.

## Operation behavior

| Case | Result |
| --- | --- |
| Healthy renewal | Authenticate and commit a new generation; keep peer, connection, RPC streams and feed identity |
| Busy or idle subscription | Keep the same ordered stream and iterator; recheck its authorization during renewal |
| Active read | Continue once, preserving its response and caller cancellation; no hidden read retry |
| Active mutation | Continue its original invocation; never redispatch on renewal |
| Lost mutation acknowledgement | Preserve `OUTCOME_UNKNOWN`; recover the same durable command/operation receipt |
| Cancellation | Cancel only the original RPC/iterator; renewal does not resurrect it or prove rollback |
| Invalid credential, revoked admission or policy | Reject replacement and terminate the connection; domain disconnect is appropriate |
| Replacement timeout or transport failure | Fail closed within the original expiry/deadline; later reconnect is fresh admission |
| Stale/duplicate generation | Reject; cannot publish state, extend the watchdog or create another writer |
| Genuine network loss | End affected streams, report reachability loss, reauthenticate and use ordinary domain recovery |

Successful renewal needs no feed resume operation because stream identity itself
is the continuity proof. The durable child checkpoint and immutable control event
IDs remain authoritative. Runtime event pumping continues to advance only after
commit. Genuine child disconnection still requires the existing validated
snapshot barrier; runtime subscriptions resume from committed native positions,
with explicit gap/history reconciliation when retention requires it. No new
cursor domain, SQLite migration, catalog retention or native history source is
introduced.

The real tree loss/recovery test also covers per-hop ambiguity observations.
Two forwarding controls may record different error text/timestamps for the same
`outcomeUnknown` command. Import retains its existing observation; a delayed
unknown observation cannot regress a recovered success/failure. Exact request
identity and known terminal result conflicts still fail closed. This prevents
receipt recovery from spuriously tearing down the aggregate feed.

A transport cannot guarantee exactly-once external side effects after an
ambiguous failure. It guarantees no automatic RPC replay. Multiplex's immutable
operation payload hashes, stable IDs, journals and read-only receipt recovery
continue to own that boundary. Aborting a noncooperative handler does not undo
its side effects; retained work remains accounted for until settlement.

## Published package and dependency boundary

The independent core was built and published by [run
`35841435029`](https://github.com/arduano/p2prpc/actions/runs/35841435029).
Its candidate validation, GitHub Packages publication, registry-byte/downstream
install verification, and GitHub release jobs all passed. The release has nine
assets, including a tarball, manifest, SHA-256 inventory, SBOM, registry
signatures, provenance bundle, and publication verification. The release
`SHA256SUMS` verifies all five inventoried artifacts. The tarball SHA-256 is
`e2b13239b9337ddb5ea1b28542e1d8fcd28bde37f469c18541967b60d6d9b69f`;
GitHub Packages reports integrity
`sha512-Gr1yK8rE22VKOwz6Hzrg7RpkZIpOjOOForks+kCKOACbTMAn4yF3Y2u4ngnGT8IJFIpYISXFRzxSQP+RgFeVnA==`.
A downstream registry download reproduced the tarball SHA-256. GitHub Packages,
not the public npm registry, is the installation source.

The maintained transport wrapper and lockfile must pin this exact released
version. CI, Docker and release builds must install the locked package directly;
the earlier local candidate patch, injection scripts, Docker reinstall steps,
and release block are superseded. Qualify the final framework and Leo graph
from clean installs and record the resulting exact-source receipts. Successful
candidate-patch tests remain historical evidence, not qualification of the
published graph. Native model workloads require their own authorization.

## Coordinated migration and rollback

Every service using p2prpc must change in one maintenance window. Publication
of the core does not permit rolling old/new service compatibility.

| Deployment unit | Components to rebuild/update together |
| --- | --- |
| Framework graph | All 16 maintained Multiplex packages/apps; transport wrapper and direct client are the direct boundary |
| Authority and branch controls | Composite ingress/link/access routers; embedded controls and authority-worker composition |
| Runtime nodes | Runtime reverse router, heartbeat/registration client, event subscriptions |
| Access gateways | All control-source clients, including NAS and laptop localhost gateways and observer workers |
| Personal combined hosts | work-windows, work-wsl, main-pc, home-nas; embedded runtime and control in each |
| Other personal p2prpc services | Work-command/recovery services and direct consumers of the independent core, even when they do not import Multiplex |
| Browser/HTTP clients | Rebuild the coherent Multiplex graph; the public domain wire API moves to protocol v6 |
| Qualification images | Control tree, mock scale, native four-container build targets |

Maintenance order: stage and verify every signed artifact first; record current
builds, endpoint pins, boots, attachments, active bindings and unknown receipt
IDs privately; take application-supported backups; quiesce new operator
mutations; stop accepting gateway work; stop the old p2prpc service graph using
its supported graceful procedure; install the entire new graph; start authority
controls, branch controls, runtimes/combined hosts and work-command services,
then gateways. Preserve identities, catalogs, native IDs and provider settings.
Reconcile uncertain operations before permitting new actions. Any deliberate
native stop/resume belongs to Leo's reviewed maintenance procedure; this task
authorizes none.

Signed tickets bind the transport protocol as well as the endpoint. Existing
tickets cannot bootstrap the new ALPN, even when the endpoint key is unchanged.
After each upgraded listener starts, privately obtain its fresh signed ticket
and update every dependent parent/control/runtime/gateway locator before starting
that dependent service. Replace both configured bootstrap tickets and persisted
renewed-ticket caches, including bespoke work-command/recovery locators; keep
endpoint identity pins unchanged. A working existing connection is not evidence
that its saved restart locator is valid. Verify a disposable reconnect using the
new saved locator during maintenance, without logging its raw ticket.

Observe at least three real 15-minute expiry boundaries after activation.
Require advancing auth generations on every edge, unchanged logical boots and
feed identities during healthy renewal, contiguous committed cursors, zero
renewal-induced unreachable events or gateway source-selection changes, normal
heartbeats, successful bounded reads, one receipt per submitted operation and
no retained stream/task growth. Test a separately authorized genuine network
loss to confirm that real unavailability still appears and recovery completes.
Record irregular native stalls independently rather than dismissing them as
renewal.

Rollback is the whole compatible service graph, not one p2prpc peer. For the
combined protocol-v6 lifecycle window, use the [lifecycle migration and
rollback procedure](copilot-session-lifecycle-vnext.md#coordinated-maintenance-window-and-rollback):
stop all v6 roles, restore the matching stopped-state pre-upgrade **control and
runtime** store units together, reinstall the complete matching prior graph,
discard v6 feed/client cursors, and mint fresh protocol-bound tickets from each
restored listener in dependency order. The transport package itself adds no
SQLite migration, but the combined change appends control v7/v8 and runtime
v6-v10 migrations. Old binaries cannot open upgraded stores. If v6 admitted
commands or native side effects after the backup, restoring it would discard
receipts; reconcile original IDs and prefer a forward fix. Never blindly replay
an ambiguous command. Failure to stage matching artifacts and rehearsed
control/runtime backup restoration blocks beginning the window.

## Resource and credential-provider obligations

Renewal has independent initiator/responder admission slots, each capped by the
configured pending-handshake limit, and a fixed 64 KiB buffer per admitted
renewal. Application streams cannot consume that reserve. A busy slot queues
within the incumbent expiry fence; genuine exhaustion beyond that deadline
fails closed. Directional reserves prevent simultaneous opposite-role renewals
from holding all slots while waiting for each other. Maximum additional
aggregate renewal buffer capacity is `2 * maxPendingHandshakes * 64 KiB`;
the renewal queue has an additional `maxPeers` bound. Noncooperative credential
and authorization callbacks retain their capacity until actual settlement.
New operations retain incumbent admission during queuing/authentication; the
brief admission barrier begins at active-operation reauthorization.

`getCredential` is invoked for every generation and must obtain fresh authority
when needed. The replacement must advance the effective expiration by at least
one quarter of the previous grant's original lifetime. A cached fixed-expiry
JWT that cannot do that is rejected before handoff, ending the connection;
providers must refresh early instead of repeatedly returning that token. This
intentional provider-contract change prevents geometric reauthentication near
expiry. Shared-secret factories naturally issue a fresh bounded grant. It is
part of the coordinated migration for any direct OAuth/custom core consumer.
