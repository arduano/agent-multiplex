# @arduano/agent-multiplex-storage-sqlite

`HardenedSqliteDatabase` owns the single-writer lifecycle, schema migration,
integrity checks, WAL configuration, secure file modes, and online backups for
Agent Multiplex SQLite stores.

## Migration history

`HardenedSqliteOptions.migrations` is an immutable, ordered history. The last
entry defines that store's target schema version; `SQLITE_SCHEMA_VERSION` is the
original v3 bootstrap baseline and is not an engine ceiling. This lets a store
opt into `[v3Bootstrap, v4Upgrade]` without forcing unrelated stores to upgrade
in the same change.

For an empty database, the engine creates the strict `schema_migrations` ledger
and applies the whole history atomically. For an existing database, it requires:

- the configured application ID;
- a positive `PRAGMA user_version` no newer than the target;
- a strict migration ledger whose version, application ID, and immutable name
  rows are an exact, non-empty prefix of the configured history; and
- a final ledger row matching `PRAGMA user_version`.

After validating integrity, every missing migration and ledger receipt is
applied in one exclusive transaction. A failure rolls the entire suffix back,
including `PRAGMA user_version`. Unversioned, foreign, future, missing-ledger,
rewritten-ledger, and unknown-migration stores fail closed; downgrades and
best-effort history repair are intentionally unsupported.

Migration versions and names are durable identities. Never reorder, rename, or
rewrite a released migration. New versions are appended and must fit SQLite's
positive signed 31-bit `user_version` range. Migration callbacks run inside the
engine-owned transaction and must not issue transaction-control statements.
