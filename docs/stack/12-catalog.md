# 12 — Root catalog and organization

Root owns logical identity, naming, metadata revisions and the Create workflow.
A Host separately owns native allocation and the effect. A Gateway owns neither.
Catalog reserves a scope durably, commits dispatch before calling Host Create
once, then accepts a positive binding or refusal. Lost replies stay unknown;
reconciliation reads that exact Host original. It never sends Create again.

The Root uses one private journal and atomic metadata/receipt checkpoint writes.
Catalog receives the portable structural `OriginalJournalPort`, not a concrete
SQLite class. The process opens and closes the actual storage handle; Catalog
owns only its borrowed workflow writer. Its record schema and CAS policy stay
inside Catalog, while SQL durability and quota accounting stay inside storage.
Create admission and reservation are one transaction: a bounded checkpoint
failure leaves neither half committed. There is no startup scan, second outbox
or recovery registry. Duplicate admission never reapplies an older reservation.
Do not share that writer with the Host lifecycle. Reconciliation can positively
refuse an admitted reservation whose dispatch never committed after restart,
without any Host call. Once dispatch committed, missing Host evidence cannot
prove non-execution.
A terminal result permanently keeps its ID/hash; metadata changes use revision
CAS and cannot silently clobber concurrent renames when delayed Create evidence
arrives. Scope includes connection, principal, Host and session. Public custom
metadata is bounded JSON; provider configuration and credentials do not belong
here. A future harness family requires no central union edit.
Immutable success receipts retain only the affected revision and positive
binding/Archive fact. Current metadata belongs to the checkpoint/query. This
keeps a valid large metadata update from exceeding the smaller receipt budget
after a native effect already succeeded.

Archive publication consumes positive read-only evidence of an existing Host
Archive original for the exact lifetime. Catalog metadata never Stops an agent.
`reconcileArchive(scope, publicationId)` reads the retained Archive original's
Host ID and generation; an unresolved Create cannot become an Archive read. A lost or
failed read remains unknown. Concurrent checks share one read, and a later
explicit check can settle that same original after restart. It sends neither
Archive nor Create. Delayed positive proof preserves newer CAS metadata.
The consuming Root authenticates and authorizes its catalog procedures. The
pure browser listing function filters/sorts with explicit snapshot coverage,
pagination and missing pins; it does not claim an offline Host has no sessions.

Exports: browser `./catalog`; Node `./catalog/node`. Constructors and imports are
inert with respect to native work. Root close refuses while its actual workflow
calls remain owned; journal close is a separate process responsibility.
Observer callbacks only run after Create's dispatch commit and actual promise
ownership, preventing reentrant inspection from refusing an active admission
or closing its owner before the Host call begins.

Focused strict compilation and all ten actual SQLite/scripted-Host oracles
passed after the ownership correction (26.927s). Coverage includes lost Create
reply/restart/no replay; pending work and late metadata; CAS/immutable originals
and principal fences; positive refusal/future kinds/pins; interruption at the
real atomic admission/dispatch boundary; reservation-bound failure (neither
half committed); observer reentrancy; lost Archive read/restart/reconciliation
with concurrent CAS metadata; unresolved Create/Archive kind separation; and
20KiB metadata through Create/patch/Archive with compact immutable receipts.
The real boundary interruption replaces the earlier hand-built checkpoint
fixture. Temporary private DBs were closed and removed. No model, native agent
or deployed Root was touched. This is source/scripted qualification, not native
or browser proof.

This replaces previous Root/catalog proxy permutations with tests at the actual
metadata/workflow owner. It introduces no V7 catalog adoption, offline native
attachment scan, migration or distributed transaction. Those are not implied by
the independent public Root API or a successful source check.

## F07 contract-first amendment

`catalog/contracts.ts` is the portable review surface; query projection is separate from the Node workflow owner. `CatalogAuthorityPort` lends only catalog operations and the public authority identity. `node-contracts.ts` names private composition inputs; the actual journal and Host factory are private to `server/catalog.ts`.
