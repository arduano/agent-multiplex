# Copilot startup containment hotfix.34 — October 6, 2026

## Source scope

This candidate combines per-binding retained Copilot recovery and exact Stop
cancellation with bounded native cold-start diagnostics. It retains published
`.33` cause retention and `.32` nullable requested child-model admission.
Published SDK/CLI and transport versions, wire contracts, permissions and genuine
interaction-uncertainty fences remain unchanged.

The runtime registers its recovery router before retained-session resume. Native
recovery runs once per boot; reconnect does not redispatch it. Transport heartbeats
continue while inventory waits. A single definite/ambiguous native failure is
persisted for its exact binding and does not take healthy siblings offline.
SQLite/invariant failures still fail the runtime boot; embedding recovery control
and command routes remain separate. Diagnostic observers cannot alter admission.
The fatal recovery promise wakes a stalled connect/registration/heartbeat rather
than waiting for a later maintenance tick. Three negative-control regressions
failed before that correction and all18 app connection tests pass afterward.

Stop's stable received receipt and exact startup cancellation fence commit
atomically before waiting for the binding lock. A cancelled late returned handle
is retired privately; unproved retirement remains outcomeUnknown. Explicit Resume
clears only a Stop fence that preceded its own admission, retaining a newer Stop
race. Missing native history has an explicit adapter error class only for the
existing exact SDK refusal predicate. Other errors remain uncertain where required.

The separate bounded cold-start budget is60 seconds; command/attachment waits
remain15 seconds and native disconnect remains10 seconds. One retained SDK start
promise owns that request, including after timeout. Five-second private progress
records retain startup identity, elapsed/deadline, the originally captured child
PID/state and bounded error/cause codes. A cleared/replaced SDK child getter or an
empty fulfilled forceStop cannot establish the original child's termination.

## Compatibility and deferrals

Append-only runtime migration11 stores fixed per-binding failures and Stop
cancellation fences. Do not rewrite released migrations. Pre-v11 runtime rollback
requires the stopped pre-upgrade runtime database recovery copy. Native histories
remain with the SDK; no product code parses vendor files or fabricates history.
Legacy terminal Stop receipts are not heuristically backfilled. If a legacy intent
needs cancellation, a newly admitted supported Stop is required; an old original-ID
replay remains its immutable original receipt.
Migration holds already-normalized v10 intents as `legacyIntentUnverified` until
a fresh supported Resume or Stop; active old bindings recover normally. The journal
lacks an immutable causal sequence/native epoch fence, so timestamp or row-ID
inference cannot safely backfill historical Stops. Migration holds carry no invented
boot ID. Startup/explicit Resume/Stop commit the latest same-binding metadata and
authority, and genuine durable reads/checkpoint failures retain their original
global failure instead of becoming per-binding native refusals.

Offline terminal Archive receipt replay remains separate authority/binding work;
this release does not claim it. The approximately11-minute Windows control catalog
admission interval remains unclassified. No integrity check, ACL check, endpoint
policy, shared native-owner fence or SDK pending-interaction completeness rule is
weakened. Recurring all-kind interaction uncertainty remains open.

## Qualification

The core producer source `2041bbb` passed189 tests/10 files plus typecheck/build
and checkpoint/docs/release/secrets checks. The adapter producer `37e51b2` plus
`7c7c4e8` passed363 tests/18 files and package TypeScript. Restoring the old
15-second startup budget makes its slow-start regression fail. That lane used a
disposable compiled core API snapshot; combined exact-source gates are required.
Core review correction `4a9b199` passed197 tests/10 files, typecheck and structural
gates. Four regression cases fail on `2041bbb` and pass with the correction; they
cover metadata races, legacy holds and durable read/checkpoint failure containment.

Combined source typecheck and build pass. Repository checkpoint, docs, release and
secrets checks pass. The first combined full suite passed1,480 tests and failed two historical
fixture expectations: runtime schema10 versus newly appended11, and a legacy
error migration fixture retaining the newly added tables. Both fixture definitions
were corrected without changing released migrations or relaxing checks. The
Initial corrected full suite passed1,482 tests/139 files with8 tests/one file skipped.
The final reviewed source passes **1,493 tests/139 files**, with8 tests/one file
skipped, typecheck/build and checkpoint/docs/release/secrets checks. Package
consumer results will be recorded after their receipts settle. No native Windows installed acceptance,
real model call, deployment or stable npm promotion is claimed.

An early checkpoint invocation before generated package output existed failed;
build produced those outputs and the normal checkpoint gate then passed. A mistyped
`node scripts/check:secrets.mjs` invocation did not find a module; the required
`npm run check:secrets` passed unchanged. These command mistakes are not passing
receipts or product regressions.

An unpublished first pack from `7d76a83` passed16 isolated consumers. Review then
added fatal propagation regressions/correction before publication. Its SBOM command
failed because concurrent rebuilding had removed the generated web output; that
partial artifact set is retained locally and is not published or relabeled as the
final release. Final packing/consumer/SBOM gates run sequentially after the
corrected clean source/build gate.
