# Same-parent bootstrap fallback hotfix.35 — October 6, 2026

## Source scope and fences

Lockstep `0.2.4-hotfix.35` is based on reviewed implementation
`0f6a1ab0c9df41175fd39dd8fbb7347b6119321d` and retains
[hotfix.34 startup containment](hotfix34-startup-containment-20261006.md).
The reference control supervisor snapshots its configured startup bootstrap
and tries the durable selected locator first. A failed dial permits bootstrap
fallback only when both logical parent and pinned endpoint match the durable
selection and the locator differs. Successful fallback dialing alone never
persists a locator or selects a parent.

After asynchronous dial, attachment and heartbeat, the supervisor rechecks
the durable selection. Explicit detach, cleared selection or an identity change
cancels the attempt; a newer same-parent locator restarts the durable dial.
Only an accepted authenticated heartbeat may renew the durable locator, using
the same-identity and exact-locator comparison fence. Saved attachment, boot,
authority, metadata and replay checks remain unchanged.

Regression coverage includes primary success, accepted fallback renewal,
identity mismatch, rejected attachment, failed fallback, concurrent detach and
locator changes at dial/attach/heartbeat, cleared selection, restart preference
and same-parent replacement during an established connection. The maintained
[architecture](../wiki/Architecture-and-Data-Roles.md) and
[data-role design](../design/data-roles-v4.md) record the behavior.

Transport, native SDK/CLI, wire and durable schema versions are unchanged from
the reviewed base. This is reachability fallback for an already-selected parent;
it adds no live reparent operation or implicit configuration rewrite. Migration11
rollback requirements and unresolved Copilot interaction uncertainty remain as
documented for `.34`.

## Exact source qualification

The combined `.35` source and exact published dependency boundary pass:

- `npm run typecheck`.
- `npm test -- --maxWorkers=1`: **1,514 passing tests / 140 passing files**, with
  eight tests and one file skipped. Its pretest performs the full release build.
- `npm run check:checkpoint`, `npm run check:docs`, `npm run check:release` and
  `npm run check:secrets`.

The full suite uses unchanged timeouts and fresh process-only mode0700
`/dev/shm/lr35._6m_gij6`; that fixture namespace was removed after success.
Node is `24.19.0`, npm `11.17.0`. The protected ignored receipt is
`receipts/hotfix35-release-2bd1a04811604bfea06d48c51a10819c/`, with per-command
stdout/stderr, elapsed times and the completed source summary. The test stdout
filename is `02---.stdout.log` because the runner retained the `--` argument as
its command label.

An earlier producer full run passed1,511 tests/139 files but failed three Codex
runtime cases in one file, with eight tests/one file skipped. Its overlong
protected `TMPDIR` exceeded Unix `sun_path` and produced `listen EINVAL`.
Physical `/tmp` runs also retained latency failures and a missing fixture-native
node-pty import; a direct native rebuild repaired only that fixture worktree.
Those failed receipts are diagnostic evidence. The later successful short-path
run is separate evidence and does not relabel the earlier failures or increase
timeouts.

## Packed artifacts and independent consumers

Clean artifact source `47f3b7ee416541dced114f46509f84172ce40c21` produces all
**16** lockstep `.35` tarballs. `sha256sum -c SHA256SUMS` passes for the complete
set. All16 role-isolated consumers pass declaration/import/browser/CLI surfaces,
publint/ATTW and the reviewed exact Iroh/Koffi dependency boundary. SBOM generation
passes with498 components, all16 released packages and125 web-bundled identities.
Packing, verification and SBOM run sequentially without concurrent rebuilding.

Stock `npm run release:verify` first fails with transport registry E401. Its
original stdout/stderr remain in the ignored receipt. The unchanged reviewed
published-transport verifier then passes using independent
`@arduano/p2prpc-core@0.3.0-renewal.1` at its exact public release URL and locked
SRI; product dependencies and registry policy do not change. That verifier's
SHA-256 is `31b2593ffd60b1f91da78f027e826da29dc945e3f1b4ef21ae5925e944f985af`.

| Evidence | SHA-256 |
| --- | --- |
| `SHA256SUMS` | `c2f9b06d393b07bbd6fe27a7912d9d326d7d5c73cde7976134f4e836a0cfedd1` |
| `pack-manifest.json` | `bf257ff73af2b3c2204ea0ff6cc4c02de8b7633a2bca710c8d4370fd81118b0c` |
| `sbom.cdx.json` | `e750ee31f9bd305c06a6a21fa5ad025c9de0d35a0aba7e90639c3d8abdfc5113` |

This qualification documentation follows in a separate commit; the exact
artifact source and packed bytes stay unchanged. Artifacts remain in this
release worktree's ignored `release-artifacts/`; the source and package gate
receipt remains in the protected ignored namespace recorded above.

## Remaining acceptance

Deterministic Docker topology/scale qualification is pending. Read-only review
finds that the stock runners use default public Iroh relay behavior and provide
no relay override. Their bridge network is not an offline/private-relay fence.
The release owner must resolve that fixture-policy boundary before running the
required suites; no successful Docker result or native/private-relay migration
acceptance is inferred from the source and package gates.

Publication, tag creation, push, npm stable promotion and native installation
belong to the release owner.
Read-only tag inspection found no `hotfix-2026-10-06.2` tag; this source pass did
not create one. No production service stop, policy/VPN change, owner-session
operation or model call occurred. Native private-relay migration and installed
Windows/WSL acceptance remain consumer-owned.
