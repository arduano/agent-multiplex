# Three-repository lifecycle maintenance readiness audit

Date: 2026-09-23. Decision: **do not begin the full clean-break maintenance
window yet**. This is a source and local-test audit, not a native Windows or
deployed-service qualification. No live session, credential, production service,
or native model workload was accessed.

## Audited source and evidence

| Repository/boundary | Exact audited state | What passed |
| --- | --- | --- |
| Agent Multiplex | Clean `de0ca6dc0bf285adaa78ec6b5b30273bdcc3511c`; implementation at `1af20f651e8d5733946154178d8c7f51b738d605`; base `c28811b320f436acbec332b00199716a3c62cfa7` | 1,041 tests/114 files, typecheck, checkpoint/docs/release/secret gates, deterministic control tree and 100-session mock scale. See the [checkpoint](../checkpoint-v4.md#unpublished-protocol-v6-copilot-lifecycle-and-consumer-candidate--2026-09-23). |
| Leo Multiplex | Clean `21280febf603e7c8e5eb398a32f074500dfc5c82`, branch `feat/copilot-lifecycle-vnext-20260923` | Disposable staged graph: typecheck, build, 1,163 tests/one skip, and 13 browser checks across six viewports with no serious/critical axe finding. Local checksummed receipt: `receipts/copilot-lifecycle-packed-graph/qualification-1af20f6-21280fe/`. |
| p2prpc | Independent `main` remains clean at `6f0bac778d8944e846e50151b5e42a4a7f9982b0`; renewal is the [reviewed patch](../../transport-candidate/p2prpc-renewal.patch), not a commit or release in that repository | The patch applies cleanly to that upstream. Candidate `0.3.0-renewal.0` tarball SHA-256 is `789da942e6902121a86a12f644c747acb2454dcb8e6bd2448803e16cfbfe05d5`. A fresh local run passed 413 unit tests/15 files and 26 local Iroh integration tests/2 files. Local checksummed receipt: `receipts/maintenance-window-audit-20260923/`. |

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
- Leo's `apps/web/src/client/session-status.ts` status copy
  describes Finished as a turn that "finished successfully". The lifecycle
  contract establishes only observed non-aborted session settlement, not the
  user's objective or per-command success. Correct that wording before operator
  activation.
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

Before scheduling the window, fix and test the two confirmed lifecycle defects
and the revision-race mismatch; publish and pin one complete graph; reconcile
the combined migration/rollback guide; rehearse stopped-state backups and
ticket/locator replacement; and qualify the exact installed bytes on Windows.
Observe real authentication generations across at least three expiry periods,
unchanged logical boots/feeds, contiguous cursors, command receipts and native
task reads. Any model-driven workload requires separate explicit authorization.
