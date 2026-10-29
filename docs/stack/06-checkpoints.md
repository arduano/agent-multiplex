# 06 — Atomic lifecycle checkpoints

The existing original-operation writer now owns one checkpoint table in the same
private SQLite database. `saveCheckpoint(scope,value)` persists an explicit
lifecycle snapshot. `checkpoint(scope)` and `checkpoints()` expose independent
readonly lookup and restart discovery. Reading a saved native identity does not
open, resume or continue it; the lifecycle owner interprets and validates its
record before any permitted effect. Storage only validates bounded plain JSON.

The module's portable contracts extend with `CheckpointReadPort`,
`CheckpointPort` and the optional atomic checkpoint arguments on
`OriginalJournalPort`. `DefaultLifecycle` borrows that structural writer port;
it neither imports the SQLite implementation nor owns its handle close.
Checkpoint values remain opaque at the storage boundary. Lifecycle owns record
validation, native custody and interpretation of saved state.
The existing lifecycle restart/ownership oracle also passes with a faithful
bound wrapper around its real SQLite writer: forwarding `writerIdentity` cannot
acquire a second lifecycle owner. This affected check passed alone (one test,
8.339s); it neither opened a native agent nor repeated the leaf storage campaign.

`settle(scope,id,outcome,{scope,value})` commits an advancing receipt and its
checkpoint in one transaction. A snapshot write, quota or COMMIT refusal rolls
both back; the caller receives no successful receipt. Checkpoint scope may differ
from original scope, which allows a create original to durably identify its newly
created session. This does not grant cross-principal authority: authenticated
lifecycle policy owns that decision before using this storage API.

Duplicate terminal settlements and repeated unknown settlements are inert. They
return their existing receipt without reapplying an old checkpoint over a newer
session state. The separate explicit save operation supports fresh observations
that are not new original-operation outcomes. An identical checkpoint save avoids
rewriting its row. There is still one DB writer, one operation journal and no
workflow/recovery owner inside storage.

Checkpoint limits independently bound each canonical value (default 256 KiB),
total retained logical key/value bytes (64 MiB) and distinct records (4096).
Replacing a record credits its prior bytes and does not consume another slot.
Canonical JSON and private POSIX paths retain the PR03 contract. Checkpoint quota
is separate from the result bytes already reserved for accepted originals; a
lifecycle owner must handle a refused snapshot transaction as unresolved local
publication, not claim that a native effect was undone or repeat it. Physical
disk exhaustion and synchronous I/O stalls remain distinct runtime failures.

The pre-release schema advances from version 1 to 2 by appending this table in
one writer transaction. Fresh journals create both schemas together. Existing
originals, results and accounting are untouched. A readonly connection to version
1 refuses with an explicit writer-upgrade requirement; it never attempts its own
migration. This is not V7 import or compatibility machinery.

Five focused oracles cover restart discovery without native opening, statement
refusal rolling back receipt plus snapshot, deferred COMMIT refusal with exact
reopen, independent count/value/total-byte bounds, inert duplicate snapshots and
the append-only version-1 upgrade preserving exact original receipts. They add
atomic snapshot invariants to the PR03 journal suite rather than repeating its
crash, private-path or immutable-original campaigns.

Validation: focused strict TypeScript 5.9.2/Node 24.19.0 compilation of protocol,
storage and storage tests passed. The unchanged emitted checkpoint and journal
tests passed together: 13 tests, concurrency 1, a 15-second per-test deadline,
65.022 seconds total on this filesystem. All test databases are disposable and
removed in `finally`; the inherited crash oracle reaps its own killed Node
writer. There were no native-agent/provider/model or service operations. The
coordinator owns the later full-graph/archive gate; these results do not claim
native lifecycle or deployment qualification.

Integration extends the existing checkpoint transaction boundary to admission
and dispatch: `admit(...,{checkpoint})` writes a fresh original and initial
checkpoint together; `markDispatched(scope,id,checkpoint?)` commits dispatch and
its custody snapshot together. Duplicate originals never restore a stale
snapshot. This removes the admission/reservation crash gap without a second
store, startup scan or outbox. These additive APIs belong to06, where checkpoint
schema and settlement were introduced;03 still owns the original-only journal.
