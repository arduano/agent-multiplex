# Authenticated transport renewal handoff

Independent p2prpc core `0.3.0-renewal.0` is published. The complete
[design and maintenance plan](../design/p2prpc-renewal-vnext.md) owns the new
contract, deployment matrix, rollout order and rollback constraints.

The [release](https://github.com/arduano/p2prpc/releases/tag/v0.3.0-renewal.0)
and [publication run](https://github.com/arduano/p2prpc/actions/runs/35841435029)
bind tag `v0.3.0-renewal.0` to commit
`ca7bb6fb7b791813c937ddbf9bde62423d097373`. Candidate validation,
GitHub Packages publication, registry-byte/downstream install verification and
release creation passed. Nine attached release assets include the tarball,
checksums, SBOM, provenance and publication verification. Downloaded release
assets passed `sha256sum -c SHA256SUMS`. The tarball SHA-256 is
`e2b13239b9337ddb5ea1b28542e1d8fcd28bde37f469c18541967b60d6d9b69f`;
a fresh `npm pack` from GitHub Packages reproduced it. Registry integrity is
`sha512-Gr1yK8rE22VKOwz6Hzrg7RpkZIpOjOOForks+kCKOACbTMAn4yF3Y2u4ngnGT8IJFIpYISXFRzxSQP+RgFeVnA==`.
The public npm registry is not this scoped package's source.

The release keeps short authentication lifetimes and replaces authenticated
generations before expiry while preserving ordered QUIC/RPC/feed streams.
Multiplex domain protocol is v6; its p2prpc application contract is
`6.renewal.1`, using independent core `0.3.0-renewal.0`, wire v5 and handshake v4.
All p2prpc services must be updated together, including direct personal
work-command/recovery consumers. Irregular Windows/native stalls remain separate.

## Earlier local candidate evidence

| Commit | Change |
| --- | --- |
| `f5a8cef` | Preserve per-hop command ambiguity and recovered receipts during child-feed convergence |
| `5d69365` | Complete independent core patch, renewal contract, real-transport tests and migration design |
| `205aaad` | Coherent Linux/Windows CI, Docker and native receipt boundaries; reproducible candidate preparation |
| `b357e43` | Keep registry authentication available when Docker prune restores the pinned dependency before candidate reinstall |

The clean implementation/build source for the earlier patch-based candidate is
`b357e43e02515f8d25568a2eff800e7d86495368`; subsequent handoff/checkpoint edits
changed documentation only. [The checkpoint](../checkpoint-v4.md#authenticated-renewal-review-candidate--2026-09-22)
records its exact patch, artifact, image and receipt digests. This receipt does
not qualify the final published dependency graph.

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
TTL; accelerated renewal evidence comes from the real-Iroh suites. That earlier
Multiplex candidate did not run hosted CI, Windows execution, native model
workloads or production activation. The independent core later passed its own
release CI at the published commit.

## Maintenance-window handoff

The full [deployment matrix and ordered procedure](../design/p2prpc-renewal-vnext.md#coordinated-migration-and-rollback)
covers authorities/branches, runtimes, gateways, all combined personal hosts,
direct clients, work-command/recovery services and all 16 framework packages.
No p2prpc consumer can remain on the old wire contract during the window.

1. Pin the published core exactly throughout the framework and direct consumers,
   remove candidate injection, and qualify clean installs of the complete
   published graph. Stage each reviewed service artifact and verify fresh-token
   providers. Rehearse a stopped-state restore of the matching pre-upgrade
   control and runtime units, including SQLite WAL and runtime image files.
2. Record pins, boots, bindings, attachments and unknown operation IDs privately;
   back up the complete control/runtime store set and role identities; quiesce
   operator mutations and gateway admission; gracefully stop the old graph.
3. Install the complete graph while peers are offline. Migrate controls from
   root outward (control v7/v8), then runtimes (runtime v6-v10). Start
   authorities, branches, runtimes/combined hosts and work-command/recovery
   services, then gateways, respecting each dependency. After each listener
   starts, mint fresh protocol-bound tickets and replace configured and cached
   locators before starting dependents. Preserve endpoint pins, catalogs and
   native identities. Require fresh validated control snapshots and cursors.
4. Reconcile unknown receipts without redispatch. Verify saved-locator reconnect,
   advancing authentication generations, unchanged logical boots/feed identities,
   contiguous cursors and no renewal-induced reachability or source changes for
   at least **45 minutes**. Keep irregular native stalls separately recorded.
5. If rollback is needed, stop all v6 roles, restore the **matching pre-upgrade
   control and runtime store set**, reinstall the entire prior compatible graph,
   discard v6 feed/client cursors and distribute fresh tickets from restored
   listeners. Do not open upgraded stores with old binaries. A restore after
   v6 commands or native side effects would discard receipts; reconcile those
   original IDs and prefer a forward fix. Never redispatch uncertain work.

The final published framework/consumer graph passed clean Linux checks and
Leo's disposable no-model Windows host jobs. The corrected framework source
also passed no-model Windows startup, native task/permission, and real-Iroh
renewal checks. Installed Windows/laptop behavior, stopped-state control and
runtime rollback rehearsal, and the maintenance-window observation remain open.
Custom/OAuth providers must refresh early enough to advance grant expiry; scope
changes or exhausted renewal deadlines fail closed. This release does not
qualify or repair irregular Windows/native Copilot stalls.
