# 07 — Streamed history and bounded reads

This layer implements pure history evidence and read-acquisition owners. It
imports only the protocol entry point; it imports no native adapter, filesystem,
storage, transport, client workspace or UI. Import and construction perform no
I/O. Native codecs and cold reader allocation are later Host/adapter work.

## Contract and ownership

`src/history/index.ts` exports the explicit browser-safe entry. `HistoryWindow`
owns one Host-proved `{run, attachment, stream}`. The run binds logical identity,
native ID and opening generation; attachment distinguishes capture ownership;
stream is an opaque root/child identity. History cannot establish ancestry or
authorize any of these fields. There is no lifetime global child/scope map.

Adapters provide absolute normalized records, including positive full-body
evidence. The window assigns monotonic row/commit versions. Commits describe
absolute replacements, exact order and residency eviction. Native history edits
explicitly reset the capture generation; no per-row semantic tombstone store is
introduced in this layer.
The pure `applyFrame` reducer rejects foreign scopes, contradictory versions and
missing revisions; stale generations cannot overwrite a newer baseline.
Replay is bounded by frames and bytes. A missed cursor or slow subscriber gets
one coherent current snapshot, not a silently dropped delta. Quiet iterator
return immediately settles a held next and releases only that observer.

The current window defaults to 128 rows, 64 KiB per body and 512 KiB serialized total.
Prior settled rows may leave residency only at the far edge relative to insertion:
an older page trims the recent tail; live append trims the old prefix. Eviction
stops at a protected edge instead of jumping over it into an interior range.
Actual running rows and every newly published batch are protected. An oversized protected batch fails atomically,
allowing read acquisition to reduce its request. UTF8 truncation is explicit
partial evidence. Terminal lifecycles cannot reopen through weaker orphan
observations, and complete terminal bodies cannot be downgraded. Conflicting
row kinds, full identities and order fail atomically.
Gap details roll with a retained omission marker. Separate `residencyOmitted`
evidence survives all later updates in that generation, including a live append
after tail trimming. Prefix eviction loses the prior older cursor unless an
incoming read positively supplies the exact new oldest boundary; it otherwise
sets an unknown edge. No native cursor or recovery authority is invented. An
explicit authorized baseline reset/new attachment can reestablish the cut; an
observer cannot erase residency omission. This bounded current window does not
promise that all previously loaded pages remain resident. A later retained-view
owner may retain page evidence or explicitly acquire another authorized baseline.
Eviction never heals a capture gap. Native activity is independent of body coverage.

`HistoryAcquisition` owns one read attachment, one baseline and one paging
frontier, with at most two retained episode handles. A `ReadBudget` spans successive
attachments and reserves before invoking a port. Observer abort/expiry and
attachment retirement do not free actual native I/O. Handles expose settlement
separately from finite waits. Retired late results cannot publish.

Consumers declare the facets they actually borrow: `HistorySnapshotSource`
exposes only the current evidence, `HistoryFeed` adds frame/subscription
observation, and `HistoryReadWindow` permits fenced read publication. Their
intersection grants neither live `update`, baseline reset nor owner close.
`HistoryAcquisitionPort`, `HistoryReadHandle` and `ReadBudgetPort` describe
retained read ownership without importing their implementation classes. These
are contracts for the same owners, not additional projections or budgets.
The issuing window still accepts only its exact outstanding `ReadFence` object;
copying the public fields cannot forge a publication capability.

The F07 interface extraction preserves all 15 window/read cases. The retained
observer-expiry case now supplies structural window and shared-budget facets;
the live-join case also refuses a copied fence before accepting the original.
Focused strict compilation and the existing Node-free browser contract graph
pass. This changes consumer coupling, not native reader admission or evidence.

Normalized pages explicitly state ascending identity order and before/after
placement. Shared-anchor merging does not infer order from IDs or timestamps.
Read publication preserves rows updated since the read fence; native edits or
reader-boundary changes fence the entire late page. Only the adapter can prove
its native page/capture cut. This pure merge is not a claim that an upstream
vendor exposes an atomic snapshot/live join.

Repeatable oversized reads halve count at the exact same native cursor, including
atomic current-window pressure. No new cursor is substituted. Single-use readers
consume input before await and never replay it. Opaque monotonic frontier tokens
keep native cursors private and make superseded public tokens stale without
retaining old request IDs. Single-use native cursor consumption additionally has
a bounded 4096-entry/1 MiB proof set per actual reader lease, so longer native
cursor cycles are refused before replay. Exhaustion refuses the read; it never
forgets consumption or silently starts a replacement reader. Empty intermediate pages preserve an available cursor;
expired/unsupported/failed reads never prove an end. One explicit retry is
available only for a failed repeatable input. There is no automatic retry loop.

## Provenance and replaced coverage

Reference commit: `61d90fd1cb356ccf15a7d681f8d896e38196ef9d`.
The shared-anchor ordering algorithm is adapted from
`primitives/v8-history/src/contracts/order.ts`. Absolute frames/current residency
and quiet iterator cancellation are distilled from `host/history-owner.ts`.
Actual-read reservation and observer waits follow `repair/read-coordinator.ts`;
same-cursor shrinking and protected live joins follow `acquisition/owner.ts`.
These algorithms are independently implemented here with smaller contracts.

The previous scope registry, exception-code taxonomy, native codecs, media
projection, per-view anchors, client workspace and lifetime request maps are
not restored. Their old APIs or suite counts are not compatibility
requirements. Tests retain the unique ordering, atomicity, completeness,
single-use input, real reservation and cancellation invariants instead.

## Qualification and limits

Focused tests use actual window/acquisition owners with controlled read ports.
They cover absolute replay/duplicate conflicts, queue reset and immediate return,
running/protected capacity, UTF8/gap honesty, stale native edits, live/read joins,
same-cursor shrink with remaining records reachable, cyclic native cursor
refusal, observer expiry/abort,
retired hung-read reservation, single-use failure and one explicit retry.
Focused strict TypeScript compilation and all 15 owner/read tests pass. The
retained-terminal regression first failed when an old observation reopened a
completed row, then passed after the owner correction. The original edge-eviction
algorithm also failed the 100-recent +100-older/128-capacity contiguous-range
oracle; insertion-relative edge eviction passes without silently losing the
proximal range. A protected tail refuses atomically and an explicit baseline
reset permits a fresh read. The commands are:

```sh
node node_modules/typescript/bin/tsc --target ES2023 --lib ES2023,DOM,DOM.Iterable --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax --noImplicitOverride --noFallthroughCasesInSwitch --types node --rootDir . --outDir .build/history-lane src/history/index.ts test/history/window.test.ts test/history/reads.test.ts
node --test --test-concurrency=1 --test-timeout=10000 .build/history-lane/test/history/window.test.js .build/history-lane/test/history/reads.test.js
```

No native process/model/provider, network, installed state or service is used.
This does **not** qualify stopped/cold native history browsing: later Host code
must supply an authorized read-only reader without Resume, keep its lease until
actual settlement and provide provenance/cursor semantics through this port.
Durable capture restoration, child retirement policy, native codecs, native
atomicity and independent per-view anchors remain explicit later-layer work.

## Retained client ordering seam

Commit frames also carry explicit `placement: before | after`, and the entry
exports the existing pure shared-anchor algorithm as `mergeHistoryOrder`.
This lets a later bounded retained view order a disjoint older page without
guessing from IDs. It grants no ordering across an unanchored replacement
snapshot; that snapshot must replace the view cut instead. PR15's actual
retained-entry oracle covers this seam. No additional history owner is introduced.

Independent checkpoint: source `bc56865`, archive SHA-256
`8eed1f1de6eca32707a1f2cdb522b9c2f91ca37777c24034f71e166b08992c30`.
Own locked install, full strict typecheck,29-module boundary graph, all15 unique
history/read cases and clean build passed. The unchanged journal/runtime/lifecycle
ancestry retains the complete41-case PR06 gate; those fsync-heavy suites were not
replayed for this leaf-only change. Source and test graph are independently
buildable without any future layer. This annotation changes documentation only.

Client integration amendment: commit `06a94a4` with the explicit placement seam
passed an independent locked install, strict types,29-module boundary check,
all15 history cases and clean build. No historical effect/fixture was replayed.
The added field records known insertion direction; it does not authorize merging
an unanchored snapshot or establish vendor ordering. Earlier archive evidence
above applies to the pre-amendment snapshot as stated.
