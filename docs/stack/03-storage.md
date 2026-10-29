# 03 — Durable originals and private SQLite

The storage owner records immutable originals before an adapter may perform an
effect. `admit(scope,id,request)` returns a durable receipt; an identical duplicate
returns the same original, and changed request meaning or admission class is a
conflict. Object-key order is immaterial, array order is material. Scope includes
the authenticated connection, principal, Host and logical session.

`markDispatched` gives `fresh:true` only to the single committed transition from
admitted to dispatched. A caller may invoke an effect only after that return.
Restarting or observing unknown work never gives another dispatch claim. A crash
between the dispatch commit and invocation deliberately leaves uncertainty: the
journal cannot establish that an external effect did or did not happen. Its owner
must reconcile that exact original; absence is not permission to retry it.

Settlements distinguish unknown from terminal succeeded/refused. Unknown retains
the request and pending capacity. A known terminal receipt removes the request,
retains its hash and result permanently, and rejects a contradictory settlement.
An admitted original may be refused before dispatch; success or uncertainty
requires the durable dispatch claim. Duplicate terminal settlement is idempotent.
Storage performs no adapter, native, connection or lifecycle action.

The journal is a self-contained module documented in
[`src/storage/README.md`](../../src/storage/README.md). Its portable
`./storage/contracts` entry exposes structural read/write ports, operation DTOs,
limits and errors. `./storage` constructs the Node SQLite handles through an
explicit barrel; `sqlite.ts` owns SQL, transactions, accounting and cleanup, while
`private-file.ts` owns POSIX file checks. A generic effect owner borrows a journal
port instead of depending on SQLite classes or private fields. Handle close stays
with the process that constructed it. These interfaces do not weaken the durable
commit-before-effect contract or introduce a pluggable database framework.
Writer ports forward the underlying journal's stable opaque `writerIdentity`;
domain-owner checks use that token instead of a wrapper object's identity.
Query and close capabilities remain separate and do not need the writer token.

This is a module boundary within the existing public package. A separate
`package.json` would need an independently released protocol dependency and build
lifetime; neither exists here. Adding one would duplicate packaging responsibility
without improving isolation. The portable consumer oracle denies Node ambient
declarations and verifies structural read/write capabilities, synchronous claims
and separately owned close. The existing real SQLite tests retain their actual
durability and platform oracles.

Extraction checks: strict compilation of the current graph and scoped ESLint
passed with zero warnings. The new portable contract oracle passed (one test,
1.164s), without loading SQLite or permitting Node ambient declarations. An AST
comparison of the original-only03 and checkpoint06 implementations confirmed
unchanged SQL and algorithms after excluding moved imports/types/error and the
new writer-identity field. This is a bounded module extraction, not fresh native
or filesystem fault qualification. The coordinator owns restacked-prefix and
whole-source checkpoint checks.

`OriginalReader` is an independent readonly SQLite connection. Exact receipt
lookup does not await pending adapter work or acquire writer ownership. One
`OriginalJournal` owns writes through a separate empty SQLite lock database held
in an OS-released exclusive transaction. This file contains no originals and is
not a second journal. A killed process needs no stale-PID lock stealing. Main
storage uses WAL and FULL synchronization; receipts return only after COMMIT.
Every acquired handle has explicit, idempotent close.

Pending normal count and request-byte bounds are independent of retained terminal
identities. Stop has separately reserved pending slots and retained-byte headroom.
Its classification is a trusted effect-owner decision, never a browser-selected
escape hatch. Admission reserves maximum result bytes so an accepted operation
does not need a fresh quota allocation to settle. The retained logical byte limit
eventually refuses new originals rather than silently forgetting old IDs. It is
not a claim about exact physical SQLite/WAL size or infinite Stop capacity; an
application must deliberately retire an entire completed journal/state scope
when its retention lifetime ends. No individual terminal-ID deletion API exists.

Private storage requires an existing canonical, owner-only POSIX directory and
owner-only regular files. Symlinks, hardlinks, permissive paths and foreign schema
are refused, without changing caller permissions or adopting another database.
Windows ACL qualification is explicitly absent and Windows construction fails
closed. SQLite calls are synchronous and bounded by input quotas/busy timeout;
isolation from a physically stalled filesystem is not claimed by this layer.

The browser-safe protocol helper accepts plain JSON data, rejects accessors,
nonfinite numbers, cycles, sparse arrays and structural/UTF-8 byte excess, sorts
object keys, and clones through that canonical representation. Hashing remains in
Node storage. Receipt DTOs are discriminated: only terminal states carry results.
`Receipt<Result = Json>` preserves a harness router's decoded native success
type without changing durable storage. Pending outcomes still have no result;
refusal remains explicit admission evidence. The journal stores the same bounded
JSON and does not infer native completion from a successful response. Native
routers decode their result using their actual pinned output schema.

Source reference: the single-writer OS lock, private-path and commit-before-effect
principles were checked against the old public implementation at
`61d90fd1cb356ccf15a7d681f8d896e38196ef9d`, especially
`packages/storage-sqlite/src/index.ts` and `private-path.ts`. This layer rewrites
that bounded ownership contract without generation migration ledgers, backup
orchestration, old table projections, PID arbitration or compatibility readers.
Those mechanisms are not imported or claimed necessary. The new focused oracles
replace their applicable storage invariants: canonical conflict and permanent
receipt, actual killed-writer reopen, independent lookup/one writer, unknown and
Stop admission, result reservation, failed writes/no acknowledgement, and private
foreign-state refusal. Adapter/reconnect/native/UI campaigns remain separate.

Validation: the coordinator appended the protocol barrel exports, then a focused
strict NodeNext compile of `src/protocol`, `src/storage` and `test/storage` passed
using TypeScript 5.9.2/Node 24.19.0. Running the emitted
`test/storage/journal.test.js` with Node's test runner, concurrency 1 and a 15-second
per-test deadline passed all 8 unique owner oracles in 21.275 seconds. This includes
a genuine deferred-foreign-key COMMIT refusal, not just a statement refusal.
The crash oracle kills and reaps one test-owned Node process against a disposable
database. Every temporary directory is removed in `finally`; all parent handles
are explicitly closed. No model/provider/native-agent/service allocations were
used. The coordinator still owns the full graph/boundary/package checkpoint;
this focused source proof makes no deployment, native-host, Windows, filesystem
fault-tolerance or browser qualification claim.

Checkpoint: the exact source snapshot at `1139f2f1b6f58844fff4f8c83c3cc96d9215a7e4`
was archived into an independent checkout with its own locked dependency install.
`npm run check` passed strict types, six-module boundary validation, all 9 tests
(including the foundation identity oracle), and the clean production build.
Archive SHA-256: `17e2e9745313aea572708e019ae69858e6672d2fada6a637f9da0c1dd3c6f28d`.
The later checkpoint annotation changes documentation only. No later layer was
present in this verification tree.
