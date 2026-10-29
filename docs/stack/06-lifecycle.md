# 06 — One durable lifecycle and workspace policy

This layer provides the shipped default lifecycle plugin. It composes the
original journal from PR03, exact native custody from PR04 and the typed Host
kernel from PR05. It owns logical session creation, native lifetime transitions
and explicit Create, Send, native command, Stop, Reopen and Archive effects.
The source is a bounded reimplementation rather than the previous registry,
SessionHost, AgentHost and separate lifecycle projections moved unchanged.

The public lifecycle router exposes only lifecycle operations: list/state,
original lookup, Create, Reopen, Stop and Archive. Harness-shaped routers own
messaging and native settings/control procedures. They borrow the same lifecycle's
internal Send/command admission so original identity, generation fencing and
actual effect custody remain with one journal. Removing the public universal
Send/command facade does not create another dispatcher or native owner.

## Durable ownership

`DefaultLifecycle` receives one already-open `OriginalJournal`. Its checkpoints
and original receipts use that same SQLite writer. There is no JSON sidecar,
second outbox, native registry or replacement effect queue. One process-local
lease refuses two lifecycle owners on the same writer; SQLite already refuses
two independent writer instances. The selected process owns the journal's actual
close. The lifecycle cannot silently close a caller-injected storage owner.

Every effect is durably admitted and marked dispatched before the actual port
call. Terminal settlement and the current session checkpoint commit atomically.
A duplicate original returns its existing receipt without dispatch. Original
lookup is an ordinary exact journal read; an independent readonly connection
can look it up while effect work remains unresolved. A thrown native effect
remains unknown, preserving its original identity and request. Retrying a view,
receipt lookup or process reconstruction never invokes it again.

Send and native command include the caller's immutable expected `RunRef` in
their original meaning. Stop, Reopen and Archive include an explicit generation.
A saved Send retried after Reopen returns its old exact receipt; it does not
derive a new target from current state and conflict with itself. A new original
targeting the old generation refuses before native dispatch. Route freshness
does not replace durable scope identity.

Each checkpoint retains native/workspace plugin ID and record-version custody.
An incompatible adapter or workspace strategy refuses before interpreting old
native state. Checkpoint reconstruction validates exact capsule scope/generation
and retained positive Stop proof. Public state omits private containment IDs and
original payloads; its tRPC output schema discriminates running, transitional
and stopped/archived states.

## Opening, Stop and late results

Workspace allocation belongs to the explicit strategy. The default strategy
references an existing absolute Host-local directory, normalizes its real path
and never provisions or deletes it. An owned strategy must implement its actual
release operation for Archive. `refused/noAllocation` is positive refusal;
throwing is an uncertain allocation outcome, not evidence that nothing exists.

The adapter's structural `NativePort.prepare` returns parked custody; native
execution is forbidden until the lifecycle commits that exact opening capsule.
Only then does `open` explicitly Create or Reopen. Fresh Create requires positive
quiescence; Reopen explicitly permits saved native continuation. Initial native
selection defaults to the injected trusted selection and may be overridden in
the Create original. The actual adapter must validate and encode its supported
settings and preserve its trusted permission/provider policy.

Stop synchronously seals further work before its first await. If workspace or
native preparation is pending, the same actual promise remains owned. A late
workspace result cannot launch native work after the seal. Once the native
capsule exists, Stop can seal its launcher and retire its native tree while an
opening reply is still pending. Stopped is published only after an exact
`OpeningStopProof`, including acquisition seal and no automatic continuation,
or positive proof that native acquisition was never attempted. Idle, disconnect
and missing inspection never produce Stopped.

Late opening replies cannot replace Stopped. The outstanding promise still
holds its actual-work reservation; Reopen, Archive and process close refuse
until that work settles. This keeps a stopped native tree distinct from pending
adapter I/O. A mismatched certificate remains uncertain with visible possible
native work. Failed cleanup does not silently release custody.

Explicit inspection captures the current local revision before its await. A
later generation, Stop, native event or settlement invalidates that result, so
an old proof cannot stop the new projected lifetime. A fresh contradictory owned
observation after Stopped makes state uncertain rather than hiding possible
work. Native callbacks are trusted, exact-generation observations, not another
lifecycle owner.

## Restart, archive and capacity

Reconstruction lists committed checkpoints without opening or inspecting native
agents. Previously running/transitional sessions become uncertain until exact
inspection or explicit Stop; no automatic Reopen or Continue exists. Native
Continue is a separately supported adapter command, not a generic fallback.

Archive requires positive Stop and settled actual work. Borrowed workspaces are
retained. Owned workspaces release through their selected strategy, and a failed
release remains uncertain. Archive frees active session capacity while retaining
original receipts and session identity. Admission capacity is independent of
physical file retention, which belongs to the later files module.

## Qualification and replacement decisions

The harness-shaped API amendment retires the public lifecycle Send input typing
checks. Actual harness-router type fixtures now own messaging contracts; the
existing lifecycle owner tests retain their unique durable admission, original
conflict, stale-run, Stop and pending-I/O oracles. Create and requested/observed
selection type checks remain here. The scripted reference harness mounts its
own typed Send/control router; the optional normalized conversation adapter is
not the required Codex API.

The focused suite is `test/host/lifecycle.test.ts`, using actual private SQLite
and real tRPC callers with scripted workspace/native ports. Initial eight cases
passed in 59.019 seconds; FULL fsync on this filesystem dominated runtime.
After owner-lease and exact-target review changes, strict isolated compilation
and affected restart/router/original/late-inspection cases passed separately.
The final suite contains nine owner-level cases. The integration owner runs the
complete layer checkpoint against its declared dependencies before publication.

The initial command compiles only the lifecycle/native/workspace source and its
test into `.cache/lifecycle-check`, using strict repository compiler options.
The focused runner uses concurrency one and a 30-second per-test bound. There
are zero model calls, native CLI allocations, HTTP servers, fleet commands or
installed-state changes. Temporary SQLite directories and all actual readers/
writers are closed and removed. Fake unknown native ownership remains deliberate
test data, without an OS process to stop.

These unique lifecycle oracles replace overlapping prior orchestration fixtures:
exact original deduplication, independent uncertain lookup, Stop during workspace
and native opening, late-result fencing, positive Stop, explicit continuation,
capacity after Archive, inert reconstruction, authenticated account separation
and exact saved targets across generations. Native process/tree proofs remain
PR04 coverage. History, files, interactions, MCP, concrete adapters and UI tests
are neither implemented nor retired here.

## Explicit limits

This is generic scripted lifecycle qualification, not native/platform proof.
No history read or transcript implementation is present; cold stopped history
will use an independent readonly port in PR07 rather than Reopen. Native events
and rich controls are supplied by their later concrete adapters.

A crash before a parked allocation's capsule commits leaves its allocation
outcome uncertain. This layer refuses replay and cannot infer absence from a
failed lookup. Exact adapter/parent-invocation provenance is required to reconcile
that boundary; it is not newly qualified by scripted port tests. Journal I/O
failure does not authorize a successful receipt, an effect retry or a release of
native custody. Storage corruption, full-disk and real process-kill acceptance
remain separate fault cells.

Independent complete checkpoint: source commit `38a13db` archived with SHA-256
`da49888b59b5e82934412b3977d525df2d49664ade76e2f8810a480b1213a629`.
With its own locked install, `npm run check` passed strict types,24 source modules,
all41 tests (including all9 final lifecycle and5 checkpoint cases) and clean build.
The test run completed in40.469 seconds. Future history/files/adapter source was
absent from that tree. This later evidence annotation is documentation only.

## Native resource ownership amendment

The selected structural NativePort also owns read helpers, captured input leases
and attachment cleanup. Its synchronous `readiness` reports retained resource
facts, and lifecycle close waits for the port's exact `close`. Stopped sessions
alone cannot prove those independent resources settled. One native port object
cannot be injected into two lifecycle owners. Close seals admission before its
first await; a failed cleanup retains its owner and does not acknowledge release.
This closes the ownership seam found when integrating the concrete adapters,
without an empty extension, another resource registry or native-family dispatch.

Native `open` receives a synchronous `commitBinding` callback. When a vendor
reveals its native ID before further initialization, the adapter commits that
positive identity before the next native effect. Lost settings replies therefore
leave a resumable known identity under uncertain initialization, rather than
losing the native session. This callback never promotes the lifecycle to Running
or overrides a Stop; final opening proof remains separate.

Amendment evidence: the native-resource ownership snapshot `e5c3906` passed
independent strict types,24-module boundary validation, all10 lifecycle cases
and clean build (38.885s). Snapshot `8ac7c24` adds early binding and passes the
same whole source/type graph, both affected resource/binding cases (7.449s) and
clean build. The final suite has11 lifecycle oracles; its complete combined run
belongs to the final stable checkpoint. No native vendor/model calls occurred.

The final callback is `commitBinding(run: RunRef)`: identity only. It cannot
overwrite saved opening settings with partial native observations. Saved settings
remain intent during opening/uncertain phases; the concrete native controls expose
observed facts, and final opening/proved events update the saved selection. A
final Create result must match an already committed ID as strictly as Reopen.

Final identity-only binding refinement: source `574538e` passes the whole strict
type graph, its affected binding/settings-retention oracle and clean build. It
changes neither the journal/native proof owner nor previous source coverage.

## Positive preparation refusal and deliberate Reopen overrides

Counterexample: a stopped native tree can still have an actual input-release or
read-helper cleanup pending. A predictable BUSY guard previously threw after06
had advanced generation and discarded the old capsule/Stop proof, leaving an
uncertain session even though no new native allocation existed. The lifecycle is
the one owner that can preserve that custody; adding a caller retry or another
recovery registry would duplicate its responsibility.

`NativePort.prepare({opening,cwd,mode,selection})` now returns parked custody or
exactly `{state:"refused",noAllocation:true,code:"BUSY"|"INVALID"|"UNSUPPORTED"}`.
Only a positive adapter-local guard before native allocation/prepare may return
this certificate. A thrown error, malformed certificate, failed cleanup or any
partially acquired allocation remains uncertain. The lifecycle never classifies
an exception as safe by its text. This is the same preparation boundary, not a
second preflight API or a required native catalog/inspection call.

On positive Reopen refusal,06 restores the entire previous stopped checkpoint:
generation, native ID, selection, capsule and Stop proof. No new lifetime was
positively opened. A Stop racing that refusal validates the already-retained
proof and does not replay the previous native Stop. A transient attempted
opening generation may therefore be observed before a positive refusal and used
again by a later successful opening; it was never a proved Running RunRef.
Exact native custody still includes the original's operation ID. Arbitrary late
inspection is independently revision-fenced.

On positive Create refusal, the allocated workspace stays owned, nativeAttempted
becomes false and no capsule/Stop certificate is invented. The stopped session
can Archive; its actual owned workspace release still belongs to its strategy.
An uncertain preparation cannot Archive through this path.

`reopen(scope,id,generation,selection?)` and its typed Host route accept a deliberate
selection override. Its presence and exact JSON participate in the immutable
original meaning. Without an override, saved settings are retained. A positive
refusal rolls back public settings too: the attempted override remains in the
original's admitted meaning/hash, and the owner must supply it again on a new
original. Successful final native observations replace intent as before. This
lets an owner explicitly reconcile unknown native permission facts without
silently escalating to the trusted Create default.

Two added real SQLite/scripted-port oracles pass: BUSY Reopen restores the exact
checkpoint, preserves admission/dedup/conflict semantics, handles a concurrent
Stop without replay and permits a later owner-selected Reopen (3.940s); positive
Create refusal archives without a fabricated Stop proof while an arbitrary
thrown acquisition remains uncertain (3.277s). The first fixture assertion was
corrected to read an admitted request before terminal settlement, matching03's
intentional settled-payload retirement. Isolated strict compilation of06 and
its tests plus the affected10 adapter graph passes. The final lifecycle file
contains13 oracles; the integration owner retains responsibility for the stable
whole-layer checkpoint. No vendor/model/native-agent calls occurred.

Integration review source881be78 passed strict types, source boundaries and build.
Its two new preparation/refusal SQLite oracles passed at2d1d25f (14.04s total).
The final structural input also supplies `previousSelection` only for an explicit
Reopen override, allowing a harness to reject settings it cannot apply atomically
before continuation. Native commands receive the exact admitted `Original` from
the same journal, so callback responses use that identity rather than a second
outbox or invented request hash. Concrete dispatch qualification belongs10/11.

## Atomic initial custody and observer-safe dispatch

Counterexamples: a crash between original admission and the first checkpoint
left an unlocatable Create; a synchronous observer could call Stop while an
opening task had not yet registered its acquisition; and a Stop triggered by a
Send publication could lose to the already-entered native call. These are all
ordering responsibilities of the existing lifecycle owner. The correction
replaces that dispatch ordering rather than adding a queue or recovery registry.

A fresh admissible Create commits its original and generation-zero initial
checkpoint in one journal transaction. That checkpoint positively records that
neither workspace nor native acquisition has been attempted. Duplicates and
capacity/existing-scope refusals do not install or overwrite session state.
Before workspace allocation, the same owner durably marks workspaceAttempted.
Reconstruction can therefore refuse only one exact unresolved Create whose
initial checkpoint proves no allocation was attempted, atomically saving Stopped
with the refused receipt. Any allocation-attempt boundary remains uncertain;
this is not automatic workspace recovery or native continuation.

Dispatch atomically marks the original and current checkpoint, registers a
deferred actual task, and only then publishes. Opening additionally registers
its acquisition and completion task before its first publication. Stop seals
synchronously, and deferred Send/native command dispatch rechecks that seal and
the exact captured RunRef. Caller message, command, input and selection objects
are copied before admission so mutation before the deferred call cannot alter
the admitted meaning. Native observations still validate exact lifetime identity
but save/publish only when phase, activity or selection actually changes;
ordinary unchanged stream chunks no longer force SQLite writes.

Four added owner-level oracles cover atomic rollback and no-attempt restart
refusal, synchronous first-Create Stop before any acquisition, immutable deferred
controls with Stop-before-Send, and zero writes/publications for unchanged native
observations. The preceding13 lifecycle oracles remain intact. Focused strict
compilation and these four cases are qualified separately; the coordinator owns
the subsequent complete layer checkpoint. This is scripted/native-port and real
SQLite evidence, not a vendor process-kill or physical disk-failure claim.

Focused evidence is retained in `.cache/lifecycle-admission-r1`: strict
compilation passed in2.419s and all four new cases passed in21.351s. The exact
former lifecycle from `a942d0f1c718cf8d9e34b5a76941828a7e62d582`, transpiled only
into that isolated test output, fails the first-Create observer case because its
Stop receipt is unknown instead of succeeded (3.599s). Current output was
restored in finally; both runners exited and removed their exact temporary
fixtures. A pre-existing unrelated temporary directory was preserved. No full
13-case replay or vendor/model qualification is implied by these focused checks.

## F07 lifecycle contracts and native schema propagation

Counterexample: generic Send accepted a malformed host message as JSON and
admitted it before the native adapter's pure schema validation. An adapter parse
failure could therefore appear as an unknown native outcome. The faithful
scripted counterexample failed on the former implementation with “Missing
expected exception”; the corrected owner rejects before creating an original or
calling native Send.

`host/contracts.ts` owns portable native/workspace/state contracts;
`host/node-contracts.ts` describes the borrowed journal and lifecycle inputs.
`host/server/lifecycle.ts` retains the sole durable owner,
`host/server/router.ts` exposes the typed default plugin, and
`host/server/workspace.ts` implements the borrowed-directory default.
`host/internal/lifecycle-codec.ts` is private checkpoint machinery. There is no
second selection store, lifecycle owner, effect queue, package or journal.

`NativePort<Command, Message, Requested, Observed>` exposes `commandInput`,
`messageInput`, `selectionInput` and `selectionOutput`. Create, Reopen, Send and
native command inputs infer from those schemas through the actual tRPC router.
The owner parses direct or routed inputs before durable admission and bounds/
copies parsed JSON before dispatch. Transport and journal envelopes remain
vendor-neutral JSON; host schemas are neither a central native-family union nor
a transport plugin registry.

Public `SessionState<Requested, Observed>` correlates `selectionSource` with raw
`selection`: requested settings are intent; observed settings are only the facts
allowed by `selectionOutput`, including meaningful partial/unknown facts. An
observed model is never filled from earlier requested intent. Exact observations
validate before state mutation. Explicit Reopen overrides are requested input;
without an override prior observed facts remain marked observed. Preparation
receives that same discriminator, and the prior discriminator accompanies
`previousSelection` for an explicit override. Positive refusal restores the
entire previous record, including that source.

The checkpoint format and default lifecycle plugin record version are 2 for the
selection-source discriminator. Incompatible records refuse; this amendment
migrates no installed state. Schemas must accept their canonical persisted
output without changing its meaning; reconstruction checks this before custody
interpretation. Optional Zod fields need no competing JSON type system: bounded
canonical copying validates actual values while inferred DTOs retain real
optionality.

Decisive additions: a malformed-message no-admission/no-dispatch oracle, a
requested-input/partial-observation oracle, and compile-only actual router
fixture `test/host/lifecycle-types.ts` proving cross-host message/selection
rejection and correlated observed facts. Existing exact-original, atomic
checkpoint, late-custody, Stop, Reopen and close oracles remain at their owner.
The focused Host suite passes all 29 cases in 30.292 seconds with scripted native
ports and disposable real SQLite. No model calls, native agents, deployment or
live service qualification occurred. The coordinator owns the final combined
source and publication gate.
