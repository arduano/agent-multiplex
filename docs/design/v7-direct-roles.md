# V7 direct roles and native ownership

V7 is an independent, fresh-state generation alongside the maintained V6 roles.
Its standalone [package contract](../../packages/v7/CONTRACT.md) and
[browser-safe wire types](../../packages/v7/src/protocol.ts) are normative for
this generation. V6 Control trees, runtime journals and Gateway projections are
not a compatibility layer or a V7 implementation.

## Durable state

Each Host and Root has one SQLite application database and one worker-owned
connection. `await V7Store.open(...)` completes initialization before service
construction. Every database operation runs in that worker, while committed
bindings/metadata remain available to synchronous lists and snapshots in memory.
A slow fsync delays its own durable acknowledgement, never the transport loop.
Native dispatch waits for that acknowledgement; durability stays FULL.
`locking_mode=EXCLUSIVE` keeps its OS-released lease across committed writes.
A second process refuses immediately; killing the owner releases the lease
without inspecting PIDs or deleting lock files. The database records its schema,
role and instance identity and refuses any mismatch. Initial deployment supplies
new V7 locations; no V6 migration or session adoption occurs.

The Host database contains native binding references and an immutable request
ledger. The Root database contains session title/pinning/metadata, logical
archive state, one metadata revision per document, and the same generic request
ledger for its own admission edge. Metadata set/remove/title/pin/archive patches
merge atomically at the writer. Optional expected revision is a whole-document
compare-and-set; native status changes do not advance it.
Neither database contains transcripts, native queue copies, online state,
interaction callbacks, boot recovery intents or installation transactions.

One request ID names one operation, target and canonical input hash. Inputs and
receipt transitions append once. A same-ID repeat reads that request; it cannot
dispatch again. After process death, admitted requests fail and dispatched
requests become outcomeUnknown. Explicit original-ID receipt reconciliation may
accept a proved terminal Host result without repeating its effect.

## Native sessions

Only create, Resume and Recover obtain native handles. Stopped/archived history
uses an explicit side-effect-free native read hook, never vendor file parsing or
a hidden Resume. Image preparation retains descriptor references in the request
and must succeed before any native effect. Starting a Host does not
list, open, reattach or continue native sessions. Bindings remain stopped until
the owner chooses Resume. Stop retains native history; Archive stops/releases
the local controller and marks its binding and Root registry archived.

Codex live and detached reads use the same native history normalizer. Copilot
detached reads use `sessions.readPersistedEvents` and its process-local,
single-use native continuations. They request one event per native page because
the SDK's batch byte budget exceeds the wire ceiling and consumed cursors cannot
be retried. This trades stopped-history throughput for bounded, complete pages
without a second history cache. Oversized singleton omission requires explicit
caller consent and carries the exact native continuation. Live primary/child
reads retain the native scoped event-log endpoint and its larger page batches.

Each attachment owns its handle, callback map, bounded ordered event lane and
bounded replay ring. History/state reads do not share its mutation admission
slot or any global maintenance slot. A second simultaneous mutation fails
immediately; there is no Host prompt queue. Copilot queue views are native reads,
and Codex retains its native send/steer semantics.

Interaction callbacks stay attached to their native owner. A fresh client reads
current callbacks directly; it never reconstructs them from history. A native
partial interaction baseline stays uncertain until that attachment supplies
positive completeness evidence. Safety facts apply immediately at native ingress,
independent of a pending presentation/image transfer. A real lost native event stays uncertain until
explicit recovery; an expired observer replay only asks the view to refresh.

Malformed native payloads, overflowing subscribers, failed history reads and
diagnostic exceptions affect one session/observer. They cannot make a healthy
Host or peer session offline. Diagnostics are optional and cannot block service
startup or heartbeat composition.

## Root observations

Root owns one route per exact Host ID. Authenticated transport supplies the
descriptor and one complete Host binding view. Connection tokens fence obsolete
updates and detach events. The Root keeps current native views in memory and
clears them on disconnect; durable user metadata and archive state remain.

Root observers begin with one complete snapshot, followed by consecutive deltas
in the same Root boot. Slow observers must obtain another snapshot. There is no
multi-source selection, branch authority promotion, fallback catalog or durable
metadata replication outbox. Transport reconnection leaves native handles alive.

## Qualification boundary

Disposable regressions cover request identity/deduplication, crash before/after
dispatch, process-killed writer leases, zero startup attachment, native queue
consumption, busy-session admission, slow history, stale attachment responses,
native callback resolution, partial interaction hydration, native/replay gaps,
poisoned-session isolation, Root-owned rename/archive, stale connection tokens,
original-ID reconciliation and ordered snapshots/deltas. Worker stalls additionally
qualify presence, committed views, healthy peer streams and durable-before-native
dispatch; consumer regressions cover images, detached history, atomic archive
patches, metadata compare-and-set and exact attachment fences.

These tests make no model calls, touch no installed state and establish no live
fleet or Windows native acceptance. Personal application composition, service
registration and sealed native payload qualification are consumer-owned.
