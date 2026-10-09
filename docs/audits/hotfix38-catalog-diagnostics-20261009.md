# Gateway diagnostic catalog repair `.38` — October 9, 2026

Source/disposable acceptance only. Consumer deployment is separately owned;
no live service, owner session, private-state edit or model call belongs to this
repair. Framework producer main and all pre-existing worktrees remain intact.

## Defect and contract

Gateway `#broadcastDiagnostics()` incremented the observation revision but
published only unversioned `sources.watch` values. A suppressed or unavailable
unselected source retry left the selected feed/cursor intact. Its next valid
Control delta skipped the invisible revision, causing `GatewayCatalogController`
to invalidate the entire retained observation despite reachable runtimes.

Every diagnostic change now publishes a bounded Gateway-owned `catalog` item on
the ordered access feed and retained replay journal. It advances Gateway revision
and access cursor together, carries source diagnostics/completeness and separately
bounded selected coverage, and changes
no domain authority. Cursor helpers and resilient access watchers commit/dedupe
these items normally. The client requires exact successor revision/cursor and
unchanged selected source identity/boot/feed/cursor/coverage. Source manifest
snapshot timestamps travel with accepted diagnostic and Control observations;
arrival time cannot certify new rows.

Refresh-start synchronizing diagnostics are committed before asynchronous load.
Suppressed source Control cursor advancement also commits its exposed manifest.
Selected snapshot dataset replacement rotates the feed even if source boot/feed
are unchanged; equal datasets can refresh their snapshot timestamp without
rotation. Genuine selected outage, topology/authority/source generation gaps and
missing/reordered commits still require an atomic rebase while retaining stale
rows. No arbitrary revision jump or swallowed fence is accepted.

Private observer mirrors must receive the projection's `watchControl()` stream
including internal commits. Source-event-only forwarding through `catalogEvent`
is insufficient. The consumer owns that composition and UI freshness labels.

## Qualification

The focused regression fails on the original `.37` Gateway source at the exact
next selected delta: `controller.apply(...)` returns false after suppressed retry
and recovered admission. The source is restored only in this owned isolated
worktree for the negative test, then the candidate is restored. This is a source
negative control; the consumer separately retained exact installed `.37` artifact
reproduction before the repair.

New regressions cover suppressed failure/retry/refresh/deferred activation,
unselected cold failure, suppressed cursor advancement, exact final view
comparison, asynchronous refresh visibility, same-feed selected dataset
replacement, missing/reordered/forged revision/identity/boot commits, selected
outage and stale-generation rejection, and access watcher reconnect/deduplication.
The focused pass contains 65 tests across projection and cursor/watch files.
Independent review found that bounded diagnostics can omit a selected source;
explicit bounded coverage now retains its exact manifest independently. The
65-source regression qualifies a timestamp-only selected refresh with incomplete
diagnostics. A separate65-selected mixed-case regression honors independently
truncated diagnostic and coverage windows without weakening their exact fences. Review also found two prior same-stamp mismatches: unavailable
session deltas and archived row/pin retention. The client now mirrors those
accepted projection changes, with exact-view equality regression.
Original fixture failures remain diagnostic receipts, separate from passing
runs. Initial broad/default-`/tmp` runs retain fixture timeouts and an import
failure from the deliberately scriptless dependency preparation. The exact
allowlisted pinned node-pty install builds in this isolated checkout, without a
global script-policy change. Final source fixtures use a short owner-private
process-only tmpfs `TMPDIR`, with original test bounds and worker count; the
NAS default temporary filesystem is degraded bcachefs. Final source gates pass typecheck, build, **1,663 tests /150 files**
(eight tests/one file skipped), checkpoint/docs/release/secrets. Packed consumer
qualification and publication remain separately recorded below.

Receipt directory: `receipts/catalog-diagnostic-order-20261009/` in isolated
producer checkout `catalog-diagnostic-order-20261009`.

All **16** packed packages pass role-isolated consumers, publint/ATTW and the
release-build SBOM (**498 components**,125 web identities). Separate packed
fixtures assert unavailable/archive exact-view parity and both65-source bounded
coverage cases; all remain current/equal. Source, failed diagnostics and packed
logs are retained with checksums in `qualification.json`.

| Candidate identity | Value |
| --- | --- |
| Exact artifact source | `18a55b5decdb12a703011658b060595527729820` |
| Framework lockstep | `0.2.4-hotfix.38`, all16 packages |
| Pack manifest SHA256 | `77898dceac97742c75f05dd6e92165ee9e4148a6bffb78774ba4bc75473c4a99` |
| Independent transport | `0.3.0-renewal.2`, unchanged published URL/SRI |

This documentation followup does not repack or advance the artifact source.
Public distribution and installed acceptance remain consumer-coordinated.

## Compatibility and deployment boundary

All16 framework package versions/internal edges advance to `0.2.4-hotfix.38`.
Published independent transport `0.3.0-renewal.2` and all native/dependency pins
remain unchanged. The Gateway access stream gains a `catalog` variant and Control
catalog source-position evidence carries `generatedAt`; coordinated Gateway and
client packages are required. Control/Runtimes remain unchanged domain owners,
and Control-source admission rejects Gateway observation items. Wire protocol
version remains6; persisted schemas and migrations are unchanged.

No signed candidate publication, stable registry/main promotion or installed
acceptance is claimed here. Consumer immutable payload rebuilding, private
observer composition and installed Gateway/browser acceptance are separate.
Hosted CI billing remains blocked by the owner's decision.
