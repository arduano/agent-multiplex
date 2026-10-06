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

## Remaining acceptance

Packing, all16 isolated consumers, SBOM and deterministic Docker topology/scale
qualification are pending at this source checkpoint. Publication, tag creation,
push, npm stable promotion and native installation belong to the release owner.
Read-only tag inspection found no `hotfix-2026-10-06.2` tag; this source pass did
not create one. No production service stop, policy/VPN change, owner-session
operation or model call occurred. Native private-relay migration and installed
Windows/WSL acceptance remain consumer-owned.
