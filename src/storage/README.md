# Durable original journal

This module owns immutable original-operation identities, the single committed
dispatch claim and monotonic receipts. It never calls a Host,
adapter, transport or effect. Domain owners decide what a request means and
validate their saved records before using them.

| Entry or file                          | Responsibility                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `./storage/contracts` / `contracts.ts` | Portable structural ports, DTOs, limits and errors; no Node or storage imports                  |
| `./storage` / `index.ts`               | Explicit Node construction exports and contract re-exports                                      |
| `sqlite.ts`                            | One SQLite writer, independent reader, schema, transactions, hashing, quotas and handle cleanup |
| `private-file.ts`                      | POSIX private-path ownership, safe file creation, sidecar checks and fsync                      |

`OriginalReadPort` permits exact receipt/request lookup and unresolved-original
discovery. `OriginalJournalPort` additionally admits, claims dispatch and settles
operations. These methods are synchronous: a successful return follows COMMIT;
an exception is not an acknowledgement. Only a fresh dispatch claim permits the
effect owner to invoke the external operation. Storage never retries one.

Ports are borrowed capabilities. The process that constructs `OriginalJournal`
or `OriginalReader` retains the separate `JournalHandle.close()` responsibility.
Passing a port to lifecycle, Catalog or an observer does not transfer close.
One domain owner retains its one writer identity; a wrapper must not be used to
claim multiple owners of the same underlying writer. The journal's opaque
`writerIdentity` token stays stable across delegated ports. Writer borrowers key
their ownership checks on that token, so a faithful wrapper cannot acquire a
second lifecycle or Catalog owner. Query and close capabilities
do not carry this token.

The platform implementation retains WAL/FULL durability, a separate OS-released
exclusive writer lock, private POSIX paths and bounded synchronous SQLite calls.
Windows ACL support and isolation from a physically stalled filesystem remain
unqualified.

The module has one public package boundary, rather than a nested `package.json`.
Its protocol DTOs already belong to the framework, and there is no independent
release or dependency lifecycle to justify another package. Structural contracts
provide the needed isolation without an extra build or package graph.

`test/storage` retains the real SQLite owner oracles: permanent meanings, killed
writer/reopen, independent reads, reserved Stop capacity, refused writes/COMMIT,
private/foreign-state refusal. The portable
consumer fixture is compiled with Node declarations denied and checks that query,
write and close capabilities remain distinct. It does not fake a durable backend.
