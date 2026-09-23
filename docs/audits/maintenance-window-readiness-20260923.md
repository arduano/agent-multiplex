# Three-repository lifecycle maintenance readiness audit

Date: 2026-09-23. Decision: **do not begin the full clean-break maintenance
window yet**. This is a source and local-test audit, not a native Windows or
deployed-service qualification. No live session, credential, production service,
or native model workload was accessed.

## Closure update, 2026-09-23

The original findings below describe the clean `de0ca6d` audit source and
remain an evidence record. Current framework source fixes the two confirmed
Copilot lifecycle defects: persisted startup reattachment intent survives
repeated failures and partial multi-session recovery, and SDK aggregate
`hasActiveWork` no longer overwrites root-specific phase. Admission and public
action availability now share degraded state; task/queue observation refreshes
periodically, and prolonged degradation requests a runtime-only supervisor
retry after verified native-owner closure. Regressions cover those transitions.
The independent renewal core is published at
`ca7bb6fb7b791813c937ddbf9bde62423d097373`; its exact
`0.3.0-renewal.0` registry integrity is pinned in the framework manifest and
lockfile. The temporary local patch and injection paths were deleted.

A fresh install of this source passed typecheck, 1,050 tests/114 files,
checkpoint, documentation, release-metadata, and source-secret checks. The
published-core Docker control tree and 10-runtime/100-session mock scale passed
with checksummed receipts under `receipts/protocol-v4-control-tree/20260923T092203Z-1d42606337be/`
and `receipts/protocol-v4-mock-docker-scale/20260923T092533Z-9673e1d283cd/`.
These tests are deterministic and contain no model turns. The signed framework
graph at `hotfix-2026-09-23.1` was independently downloaded: all 19 release
assets match the local verified bytes, and `SHA256SUMS` SHA-256 is
`bbe7075d1ab2e1ee5feadb9d989c4f977755f81d70e21749a085ad8880229e53`.
Leo commit `d202e6a77be5c09c07cf439e6beaa9bff361ebf1` pins all 16 `.17`
URLs/overrides and the published core; its clean install, typecheck, build,
1,123 tests (one skip), high-severity audit gate, and 17/13/14 no-model browser
checks pass. Framework CI
[`35846878993`](https://github.com/arduano/agent-multiplex/actions/runs/35846878993)
passed at `4e9cd7c89fd6a7c60f97ca09dbd98444a639a997`; hosted Docker
[`35845951932`](https://github.com/arduano/agent-multiplex/actions/runs/35845951932)
also passed. Leo's published-graph Windows
[`35847256516`](https://github.com/arduano/leo-multiplex/actions/runs/35847256516)
passed both npm 11.15.0 and 12.0.2 jobs at `d202e6a`; all eight downloaded
receipt inventories passed `sha256sum -c SHA256SUMS`. Its later local Nix-only
commit `92cf18aa8d461a81ea5ef16e893621f265c03a00` passed an offline
`nix-build`, typecheck, build and 1,123 tests (one skip), but has no hosted
exact-commit receipt.

Framework Windows run
[`35848271811`](https://github.com/arduano/agent-multiplex/actions/runs/35848271811)
passed native startup, permission and task steps, then failed the real-Iroh
tree's post-loss reconnect assertion. The test attempted reconnection before
the remote endpoint had observed the asynchronously closing old handle. A
local test correction waits for that closure and passed the focused Linux
real-Iroh suite; Windows has not yet rerun on the corrected source. This is a
failed diagnostic, not a passing Windows transport receipt.

The readiness decision remains **no-go for live cutover** until the corrected
framework Windows run, separately authorized synthetic Windows model UAT,
stopped-state control **and** runtime backup/rollback rehearsal, ticket and
locator rotation, and the 45-minute three-generation observation pass.

## Band-aid deletion inventory

| Area | Delete or retire | State and boundary |
| --- | --- | --- |
| Transport candidate overlay | Local patch, preparation/install scripts, Docker reinstall steps, release block, candidate receipt branches | Deleted in framework source; the lockfile now identifies the independently published package. Historical candidate receipts remain labeled as historical evidence. |
| Browser lifecycle inference | Text/image equality, catalog idle, queue disappearance, generic receipt success, and local completion markers as proof of native completion | Removed from the v6 host/reference and companion Leo lifecycle paths. The UI consumes the compact host view and original command observation. |
| Leo gateway task polling | Separate Copilot task-count poller in `apps/server/src/copilot-task-activity.ts` and observer wiring | Deleted at Leo `c2ba0cf`; exact task details and controls remain for users who open them. |
| Leo mobile completion | Native-event-derived completion notices and legacy mobile Copilot markers | Replaced with host lifecycle notices; an append-only migration clears legacy markers without touching Codex entries or device settings. |
| Leo browser status helpers | Dead composer-intent and task-status helper paths and their mirror tests | Deleted at Leo `c2ba0cf`; the remaining task view reports exact native details without inventing overall completion. |
| Cutover configuration | Old ALPN-bound signed tickets, configured/bootstrap locators, and renewed-ticket caches | Rotate only during the stopped, coordinated window; preserve endpoint identity pins and matching backups. Retire old installed graph after rollback safety is established. |

The SDK read timeout, `Unknown` projection, degraded admission, and exact-ID
receipt reconciliation are intentional safety contracts, not cleanup targets.
Retain them until upstream SDK evidence supports a simpler truthful state.

## Audited source and evidence

| Repository/boundary | Exact audited state | What passed |
| --- | --- | --- |
| Agent Multiplex | Clean `de0ca6dc0bf285adaa78ec6b5b30273bdcc3511c`; implementation at `1af20f651e8d5733946154178d8c7f51b738d605`; base `c28811b320f436acbec332b00199716a3c62cfa7` | 1,041 tests/114 files, typecheck, checkpoint/docs/release/secret gates, deterministic control tree and 100-session mock scale. See the [checkpoint](../checkpoint-v4.md#unpublished-protocol-v6-copilot-lifecycle-and-consumer-candidate--2026-09-23). |
| Leo Multiplex | Clean `21280febf603e7c8e5eb398a32f074500dfc5c82`, branch `feat/copilot-lifecycle-vnext-20260923` | Disposable staged graph: typecheck, build, 1,163 tests/one skip, and 13 browser checks across six viewports with no serious/critical axe finding. Local checksummed receipt: `receipts/copilot-lifecycle-packed-graph/qualification-1af20f6-21280fe/`. |
| p2prpc | Independent `main` remained at `6f0bac778d8944e846e50151b5e42a4a7f9982b0`; renewal was a reviewed local patch, not yet a commit or release in that repository | The patch applied cleanly to that upstream. Candidate `0.3.0-renewal.0` tarball SHA-256 was `789da942e6902121a86a12f644c747acb2454dcb8e6bd2448803e16cfbfe05d5`. A fresh local run passed 413 unit tests/15 files and 26 local Iroh integration tests/2 files. Local checksummed receipt: `receipts/maintenance-window-audit-20260923/`. |

The local packed test physically extracted all 16 framework packages and the
candidate core. It reused installed third-party packages and a same-version
compiled Linux `node-pty` binary. It does not qualify a clean published install
or native Windows installation. The tree/scale suites used mock harnesses. The
transport tests used local Iroh connections, not the live fleet.

## Confirmed blockers

1. **Startup reattachment intent is not durable across a second failure.**
   [`RuntimeNodeService` construction](../../packages/runtime-node-core/src/service.ts)
   selects active Copilot rows in memory and immediately writes them as
   `resumable` with a null runtime epoch. `reattachPersistedCopilotSessions()`
   runs later, before control registration. A crash after the write, or a failed
   reattachment followed by the Windows supervisor's restart, leaves no active
   row for the next boot to select. That boot can register while a previously
   active Copilot session stays detached. The existing
   [startup tests](../../packages/runtime-node-core/test/startup-reattach.test.ts)
   cover one successful boot and one failed attempt, not the following boot.
   Preserve a durable exact-binding reattachment intent until an accepted native
   handle is installed, and test two crashes and partial multi-session recovery.

2. **Aggregate native activity is treated as root activity.** Pinned Copilot
   SDK `1.0.14` declares `SessionActivity.hasActiveWork` as including running
   turns *or tasks*. The [adapter](../../packages/adapter-copilot/src/session.ts)
   emits `rootObserved(active)` from that aggregate bit. The
   [reducer](../../packages/protocol/src/lifecycle.ts) then sets root phase to
   Working and may clear a previously observed Finished cycle. Task-only work
   can therefore project Working instead of Waiting for child/task, and its
   later inactive sample can project Ready rather than the prior Finished
   outcome. The [current regression](../../packages/protocol/test/lifecycle.test.ts)
   asserts the aggregate transition without a task-only case. Root phase must
   come from root-specific evidence; the aggregate bit can only establish
   overall activity or invalidate an absence claim.

3. **There is no releasable dependency graph yet.** The framework's
   [`transport-p2prpc` manifest](../../packages/transport-p2prpc/package.json)
   and lockfile still pin public core `0.2.1`, while the new integration
   requires renewal contract 1. Leo's manifest and lockfile still point to
   released framework `.15` tarballs and core `0.2.1`. The local injection is
   intentionally refused by `release:pack`. The p2prpc patch first needs an
   independently reviewed commit/publication; then exact pins, lockfiles, all
   16 Multiplex artifacts and every Leo/direct consumer need a clean-install
   qualification without local links or copied native binaries. Old signed
   tickets bind the prior ALPN; every listener and saved bootstrap/renewed
   locator must be rotated in dependency order while preserving endpoint pins.

4. **The combined rollback instructions conflict.** The transport-only
   [renewal design](../design/p2prpc-renewal-vnext.md) says rollback does not
   restore SQLite because that transport change adds no migration. The
   [combined lifecycle design](../design/copilot-session-lifecycle-vnext.md)
   correctly requires an offline restore of the matching pre-upgrade control
   and runtime store set after protocol-v6 migrations. The transport document
   also still calls the HTTP/WS boundary domain v5. One authoritative combined
   runbook must identify each store, WAL-consistent backup, upgrade, ticket
   distribution, admission gate, and rollback decision. A p2prpc-only rollback
   procedure must not be used for the combined v6 window.

## Conditional defects and qualification gaps

- A stalled task/queue SDK read can set the runtime coordinator's `degraded`
  admission flag for an old invalidation revision while its
  `observationFailed` fact is ignored by the current-revision reducer. In that
  race, the [runtime](../../packages/runtime-node-core/src/service.ts) rejects
  a Copilot mutation but the [public projection](../../packages/protocol/src/lifecycle.ts)
  can still advertise it as available. Add a revision-race regression and make
  admission and published action availability use the same state.
- Task and queue observations refresh on activation, invalidation and known
  gaps. The SDK has no atomic snapshot cursor or guaranteed delta replay. If
  an SDK invalidation is missed without a detectable gap, a stale Waiting or
  Queued state has no periodic authoritative repair. This is conditional on
  native notification loss; it should be bounded and visible in Windows UAT.
- A timed-out native task/queue read keeps its SDK lane occupied until that
  underlying call settles ([read coordinator](../../packages/adapter-copilot/src/reads.ts)).
  After 45 seconds the runtime rejects new Copilot mutations; the Leo
  supervisor retries processes that stop, not a still-running degraded runtime.
  The historical Windows read stall could therefore become prolonged safe
  unavailability rather than an automatically repaired session.
- Leo's `apps/host/src/manage.ts` Windows supervisor
  retries a fully stopped runtime and fails closed when native termination is
  unproved. Portable tests do not establish Task Scheduler, job-object, ACL,
  sign-in, endpoint-security or installed CLI behavior. The historical
  session-specific Windows task-read failures have no proven native cause.
- Leo's Copilot `Finished` copy now describes an observed settled turn and
  invites result review. A separate Codex completion branch still says
  "finished successfully"; it is not a Copilot lifecycle input.
- SDK `1.0.14` / CLI `1.0.88` still lack a caller operation ID echoed across
  native work, a guaranteed root logical message ID, atomic task/queue cursors,
  complete pending-interaction hydration and per-command settlement. The
  implementation intentionally leaves unproved states Unknown. These upstream
  limits do not by themselves justify fabricating a UI completion signal.

## Stability expectation and go criteria

The renewal candidate is likely to remove the specific healthy-link outage at
the old 15-minute authentication expiry; local three-period tests and tree
coverage support that narrower claim. Host-owned lifecycle evidence should
make Copilot status and command delivery more truthful, and the Windows
supervisor should recover some cleanly terminated runtime failures. None of
those facts proves that Copilot's irregular native Windows task-read stalls
will disappear. In a degraded observation, mutation admission intentionally
stops until the native state is fresh, trading availability for safe behavior.

The two confirmed lifecycle defects and revision-race mismatch are fixed and
tested; one complete graph is published and pinned, and the combined rollback
guide is reconciled. Before scheduling the window, complete corrected framework
Windows qualification and synthetic model UAT, rehearse stopped-state backups
and ticket/locator replacement, and qualify the exact installed bytes on the
target Windows host.
Observe real authentication generations across at least three expiry periods,
unchanged logical boots/feeds, contiguous cursors, command receipts and native
task reads. Any model-driven workload requires separate explicit authorization.
