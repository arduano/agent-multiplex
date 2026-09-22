# Authenticated transport renewal handoff

Local review candidate only. No pin, release, production service, native session
or other checkout has been changed. The complete
[design and maintenance plan](../design/p2prpc-renewal-vnext.md) owns the new
contract, deployment matrix, rollout order and rollback constraints.

Build requires `npm ci` followed by `npm run prepare:transport-renewal -- ../p2prpc`.
This reads exact upstream source, applies the tracked patch in this worktree,
produces a checksummed local tarball and installs it without rewriting pins.
The three maintained Docker targets consume that same tarball. Release packaging
is intentionally blocked until independent core publication and exact pin review
are separately authorized.

The candidate keeps short authentication lifetimes and replaces authenticated
generations before expiry while preserving ordered QUIC/RPC/feed streams.
Multiplex domain protocol stays v5; its p2prpc application contract changes to
`5.renewal.1`, using independent core `0.3.0-renewal.0`, wire v5 and handshake v4.
The 16 Multiplex package versions and released dependency pins are unchanged.
All p2prpc services must be updated together, including direct personal
work-command/recovery consumers. Irregular Windows/native stalls remain separate.

## Review commits and evidence

| Commit | Change |
| --- | --- |
| `f5a8cef` | Preserve per-hop command ambiguity and recovered receipts during child-feed convergence |
| `5d69365` | Complete independent core patch, renewal contract, real-transport tests and migration design |
| `205aaad` | Coherent Linux/Windows CI, Docker and native receipt boundaries; reproducible candidate preparation |
| `b357e43` | Keep registry authentication available when Docker prune restores the pinned dependency before candidate reinstall |

The clean implementation/build source qualified is
`b357e43e02515f8d25568a2eff800e7d86495368`; subsequent handoff/checkpoint edits
change documentation only. [The checkpoint](../checkpoint-v4.md#authenticated-renewal-review-candidate--2026-09-22)
records exact patch, artifact, image and receipt digests.

Passed: **932 Multiplex tests**, **413 core unit tests**, **26 real-Iroh integration
tests**, both builds/typechecks, core lint and packed/native-import smokes,
repository documentation/checkpoint/release-metadata/secret/workflow checks,
the Docker control tree and 10-runtime/100-session mock scale. Accelerated real
authentication spans three original expiry periods with held reads/mutations,
idle/busy subscriptions, cancellation, rejection/revocation, stale generations,
replacement failure and genuine loss/receipt recovery. All disposable endpoints,
containers, networks and images were cleaned up.

The passing scrubbed local receipt is
`receipts/p2prpc-renewal/qualification-b357e43/`; its `SHA256SUMS` SHA-256 is
`fe817fbe1ed1d38c3db1cf982aa9aad3159a000502ee41393fa56eacd8eb77a3`.
Earlier failed runs are diagnostics, outside that receipt. Docker uses default
TTL; accelerated renewal evidence comes from the real-Iroh suites. Hosted CI,
Windows execution, native model workloads and production activation were not run.

## Maintenance-window handoff

The full [deployment matrix and ordered procedure](../design/p2prpc-renewal-vnext.md#coordinated-migration-and-rollback)
covers authorities/branches, runtimes, gateways, all combined personal hosts,
direct clients, work-command/recovery services and all 16 framework packages.
No p2prpc consumer can remain on the old wire contract during the window.

1. Before scheduling: separately authorize independent core publication and exact
   pin/version updates, remove candidate injection, update release-version
   assertions and repeat qualification on the published graph. Stage every
   service's reviewed artifact and verify fresh-token providers. The current
   branch intentionally blocks release packaging and native release attestation.
2. Record pins, boots, bindings, attachments and unknown operation IDs privately;
   back up supported state; quiesce operator mutations and gateway admission;
   gracefully stop the old service graph under Leo's approved procedure.
3. Install the complete graph. Start authorities, branches, runtimes/combined
   hosts and work-command/recovery services, then gateways, respecting each
   dependency. After each listener starts, mint fresh protocol-bound tickets
   and replace configured and cached locators before starting dependents.
   Preserve independently pinned endpoint keys, catalogs and native identities.
4. Reconcile unknown receipts without redispatch. Verify saved-locator reconnect,
   advancing authentication generations, unchanged logical boots/feed identities,
   contiguous cursors and no renewal-induced reachability or source changes for
   at least **45 minutes**. Keep irregular native stalls separately recorded.
5. If rollback is needed, quiesce again and restore the entire prior compatible
   graph with matching fresh locators. Preserve newly committed journals and
   receipts; this change adds no SQLite migration and requires no database rewind.

Remaining qualification: the final published dependency graph, external consumer
composition, Windows/laptop behavior and the maintenance-window observation.
Custom/OAuth providers must refresh early enough to advance grant expiry; scope
changes or exhausted renewal deadlines fail closed. This local correction does
not qualify or repair irregular Windows/native Copilot stalls.
