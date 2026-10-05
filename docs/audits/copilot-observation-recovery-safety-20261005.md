# Copilot observation recovery safety — October 5, 2026

Source-only isolated candidate based on exact `.30` checkout
`1dd9ae1bfdef07af4ce931afd0284829bb4400e3`. Published `.29`/`.30` remain
immutable. No protocol/durable schema, migration, release version, Copilot
SDK/CLI, Codex CLI or transport dependency identity changes.

## Evidence and causal limits

The consumer's October 5 Tariff incident retained a task refresh/list settlement
followed five milliseconds later by a current-revision task-observation
failure. Twelve current-revision failures reached the 45-second no-success
watchdog. The 120-second degraded recovery timer subsequently invoked the
embedding's shared Runtime restart, cancelling an active native child. Exact
original task shape/exception was discarded in installed `.29`; this source
candidate does not identify that missing field or certify the native cause.

Source confirms a separate, deterministic defect: any task/queue observation
failure could escalate into shared-owner shutdown without proving that native
children or peer sessions were safe to stop. Snapshot validation, ordinary
invalidation and noncancellable native-read stalls all reached that path.
Verified owner cleanup after initiating shutdown does not justify initiating
shutdown while healthy work remains active.

A second concrete source defect is independent of the captured cause: Runtime
appended `tasksObserved`/`queueObserved` before complete wire-envelope admission.
An otherwise valid lifecycle projection could therefore mark evidence fresh
before the corresponding native snapshot was rejected for wire size/shape.
No retained Tariff snapshot establishes that this ordering caused its incident.

## Correction

- Observation watchdogs retain degraded admission, exact pending interactions,
  children, commands, original receipts and bounded retries; they never request
  shared Copilot owner shutdown. This includes genuine occupied read lanes:
  timeout alone cannot prove owner-wide cleanup is safe.
- The prior `onCopilotObservationRecoveryRequired` option remains deprecated for
  embedding source compatibility but is not invoked by observation watchdogs.
  The reference Runtime app removes its observation-triggered abort controller.
  One private `manualRecoveryRequired` trace is emitted per degraded interval.
- Explicit owner Stop/Recover and independently proved native failure retain
  existing termination and uncertain native ownership fences. No native prompt
  replay, callback answer, synthetic idle/empty state or credential change occurs.
- Fixed typed categories distinguish snapshot admission, invalidation, read
  contention/deadline, retired native owner, unavailable APIs and binding change.
  Unknown native errors remain `nativeReadFailed`; exception text is not matched
  to manufacture a diagnosis. A watchdog may retain the last failed reason only
  for its exact current revision.
- Runtime validates the entire native payload before writing a task/queue
  lifecycle fact. Queue projection/wire failures receive the same bounded fixed
  diagnostics as task rejection. Strict validators and native data remain intact.

Retries remain a single coordinator per binding, fair between task and queue
views, with exponential backoff capped at 30 seconds and periodic refresh at
60 seconds. A fresh exact-revision task and queue observation heals degraded
admission. It does not repair a real continuity gap, uncertain command or partial
interaction hydration. Bounded failure tracing supplements the existing `.30`
validation path/code/type fields; no vendor payload enters the protocol trace.

## Qualification

Task-owned disposable test directories are under
`/dev/shm/copilot-recovery-safety-20261005`; no production filesystem/state moves.
Dependencies were installed into the isolated checkout with strict published
lockfile policy; no stale worktree dependency symlink was used.

- `tsc -b packages/runtime-node-core packages/adapter-copilot apps/runtime-node
  --pretty false` passes.
- Final combined nine focused observation/adapter/shutdown/incident-trace
  suites pass **243 tests**. The prior eight-suite run passed 228, and incident
  tracing separately passed 15 before the combined final rerun.
  The initial three-suite pass contained 88 tests before the extra typed-reason
  regressions were added.
- `check:docs`, `check:release`, `check:secrets` and `git diff --check` pass.
  `check:checkpoint` was attempted after the package-scoped build and correctly
  rejects absent unrelated Gateway `dist/index.js`; a complete repository build
  and that gate remain coordinator-owned rather than claimed passing here.
- Negative control temporarily restores the exact `.30` Runtime service in
  this isolated checkout, runs only the new envelope-admission and occupied-owner
  regressions, then restores the candidate in `finally`: **four regressions fail**
  (zero pass). Candidate source is restored before subsequent qualification.
- The contained-failure fixture holds malformed, oversized, invalid-wire,
  invalidated and timed-out reads across 300 seconds, beyond the former
  165-second destructive threshold. It retains two running children, a separate
  working peer, an exact pending question and unchanged binding/native ownership.
  It checks fair queue refresh, bounded retry count, safe typed failure reason,
  no Stop/close/recovery callback, later admission healing, and no fake clearance
  of the pending question.
- Envelope-admission regressions prove rejected task and queue responses never
  commit observed evidence. Existing stale-revision/late-read, mutation admission,
  explicit Stop and unproved native termination tests continue to apply.

Full combined framework gates, packed consumers, publication, Leo embedding
qualification and installed Windows/WSL acceptance belong to the coordinator.
No native SDK client attachment, remote/service operation or real model call is
included. Captured incidents cannot gain their lost exception retroactively.

## Policy and dependency review

`SECURITY.md` and `THIRD_PARTY_NOTICES.md` were reviewed. The correction changes
availability/recovery policy while preserving trust, credentials, native owner
cleanup and public/durable validation boundaries. It adds no dependency or
third-party source and does not modify vendor code.
