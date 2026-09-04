import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  HardenedSqliteDatabase,
  SqliteStoreError,
  type SqliteMigration,
} from "../src/index.js";

const APPLICATION_ID = 0x414d_4d47;
const V3_APPLIED_AT = "2038-01-02T03:04:05.000Z";
const V4_APPLIED_AT = "2039-02-03T04:05:06.000Z";

describe("HardenedSqliteDatabase migration history", () => {
  it("bootstraps and reopens a schema whose target is newer than the repository baseline", async () => {
    const filename = fixturePath("fresh-v4");
    const applied: number[] = [];
    const sqlite = open(filename, history((version) => applied.push(version)), V4_APPLIED_AT);

    expect(applied).toEqual([3, 4]);
    expect(sqlite.diagnostics()).toMatchObject({
      applicationId: APPLICATION_ID,
      userVersion: 4,
      journalMode: "wal",
      foreignKeys: true,
      synchronous: "full",
    });
    expect(ledger(sqlite.database)).toEqual([
      {
        version: 3,
        application_id: APPLICATION_ID,
        name: "fixture-v3-bootstrap",
        applied_at: V4_APPLIED_AT,
      },
      {
        version: 4,
        application_id: APPLICATION_ID,
        name: "fixture-v4-generation",
        applied_at: V4_APPLIED_AT,
      },
    ]);
    expect(strictTables(sqlite.database)).toEqual([
      { name: "records", strict: 1 },
      { name: "schema_migrations", strict: 1 },
      { name: "v4_audit", strict: 1 },
    ]);

    const backupPath = join(fixturePath("backup-parent"), "copy.sqlite");
    await expect(sqlite.backup(backupPath)).resolves.toMatchObject({
      applicationId: APPLICATION_ID,
      userVersion: 4,
    });
    sqlite.close();

    const replayed: number[] = [];
    const reopened = open(filename, history((version) => replayed.push(version)));
    expect(replayed).toEqual([]);
    expect(reopened.diagnostics().userVersion).toBe(4);
    reopened.close();
  });

  it("upgrades an exact v3 ledger prefix to v4 without replaying the bootstrap", () => {
    const filename = fixturePath("v3-to-v4");
    createV3Fixture(filename);

    const applied: number[] = [];
    const upgraded = open(filename, history((version) => applied.push(version)), V4_APPLIED_AT);
    expect(applied).toEqual([4]);
    expect(upgraded.database.prepare(
      "SELECT id, value, generation FROM records ORDER BY id",
    ).all()).toEqual([{ id: 1, value: "preserved", generation: 1 }]);
    expect(ledger(upgraded.database)).toEqual([
      {
        version: 3,
        application_id: APPLICATION_ID,
        name: "fixture-v3-bootstrap",
        applied_at: V3_APPLIED_AT,
      },
      {
        version: 4,
        application_id: APPLICATION_ID,
        name: "fixture-v4-generation",
        applied_at: V4_APPLIED_AT,
      },
    ]);
    expect(upgraded.diagnostics()).toMatchObject({
      userVersion: 4,
      journalMode: "wal",
      foreignKeys: true,
      synchronous: "full",
      integrity: { quickCheck: ["ok"], foreignKeyViolations: [] },
    });
    upgraded.close();
  });

  it("rolls back the whole missing suffix when a later migration fails", () => {
    const filename = fixturePath("suffix-rollback");
    createV3Fixture(filename);
    const failingHistory = [
      ...history(),
      {
        version: 5,
        name: "fixture-v5-failure",
        apply(database: DatabaseSync): void {
          database.exec("CREATE TABLE v5_partial(id INTEGER PRIMARY KEY) STRICT");
          throw new Error("injected v5 migration failure");
        },
      },
    ] satisfies readonly SqliteMigration[];

    expect(() => open(filename, failingHistory)).toThrow("injected v5 migration failure");

    const raw = new DatabaseSync(filename, { readOnly: true });
    expect(pragmaNumber(raw, "user_version")).toBe(3);
    expect(ledger(raw)).toEqual([{
      version: 3,
      application_id: APPLICATION_ID,
      name: "fixture-v3-bootstrap",
      applied_at: V3_APPLIED_AT,
    }]);
    expect(tableNames(raw)).not.toContain("v4_audit");
    expect(tableNames(raw)).not.toContain("v5_partial");
    expect(raw.prepare("PRAGMA table_info(records)").all())
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "generation" })]));
    raw.close();

    const recovered = open(filename, history());
    expect(recovered.diagnostics().userVersion).toBe(4);
    recovered.close();
  });

  it("rolls back migrations that rewrite schema identity or ledger history", () => {
    for (const fixture of [
      {
        name: "application-id",
        migration: {
          version: 4,
          name: "fixture-v4-foreign-app",
          apply(database: DatabaseSync): void {
            database.exec(`PRAGMA application_id = ${APPLICATION_ID + 1}`);
          },
        },
      },
      {
        name: "ledger-history",
        migration: {
          version: 4,
          name: "fixture-v4-rewrite-history",
          apply(database: DatabaseSync): void {
            database.exec("UPDATE schema_migrations SET name = 'rewritten-v3'");
          },
        },
      },
    ] satisfies Array<{ name: string; migration: SqliteMigration }>) {
      const filename = fixturePath(`migration-tamper-${fixture.name}`);
      createV3Fixture(filename);
      const [v3] = history();

      expect(() => open(filename, [v3!, fixture.migration])).toThrow();

      const verify = new DatabaseSync(filename, { readOnly: true });
      expect(pragmaNumber(verify, "application_id")).toBe(APPLICATION_ID);
      expect(pragmaNumber(verify, "user_version")).toBe(3);
      expect(ledger(verify)).toEqual([{
        version: 3,
        application_id: APPLICATION_ID,
        name: "fixture-v3-bootstrap",
        applied_at: V3_APPLIED_AT,
      }]);
      verify.close();
    }
  });

  it("checks prefix integrity before running an upgrade", () => {
    const filename = fixturePath("invalid-prefix-integrity");
    const v3 = {
      version: 3,
      name: "foreign-key-v3-bootstrap",
      apply(database: DatabaseSync): void {
        database.exec(`
          CREATE TABLE parent(id INTEGER PRIMARY KEY) STRICT;
          CREATE TABLE child(
            id INTEGER PRIMARY KEY,
            parent_id INTEGER NOT NULL REFERENCES parent(id)
          ) STRICT;
        `);
      },
    } satisfies SqliteMigration;
    open(filename, [v3]).close();
    const tamper = new DatabaseSync(filename, { enableForeignKeyConstraints: false });
    tamper.exec("INSERT INTO child(id, parent_id) VALUES (1, 999)");
    tamper.close();
    let applied = false;
    const v4 = {
      version: 4,
      name: "foreign-key-v4-upgrade",
      apply(database: DatabaseSync): void {
        applied = true;
        database.exec("CREATE TABLE v4_should_not_exist(id INTEGER PRIMARY KEY) STRICT");
      },
    } satisfies SqliteMigration;

    expect(() => open(filename, [v3, v4])).toThrowError(
      expect.objectContaining<Partial<SqliteStoreError>>({ code: "INTEGRITY_CHECK_FAILED" }),
    );
    expect(applied).toBe(false);
    const verify = new DatabaseSync(filename, { readOnly: true });
    expect(pragmaNumber(verify, "user_version")).toBe(3);
    expect(tableNames(verify)).not.toContain("v4_should_not_exist");
    verify.close();
  });

  it.each([
    {
      name: "missing ledger",
      tamper(database: DatabaseSync): void {
        database.exec("DROP TABLE schema_migrations");
      },
    },
    {
      name: "empty ledger",
      tamper(database: DatabaseSync): void {
        database.exec("DELETE FROM schema_migrations");
      },
    },
    {
      name: "renamed prefix entry",
      tamper(database: DatabaseSync): void {
        database.exec("UPDATE schema_migrations SET name = 'rewritten-v3' WHERE version = 3");
      },
    },
    {
      name: "foreign ledger application ID",
      tamper(database: DatabaseSync): void {
        database.exec(`UPDATE schema_migrations SET application_id = ${APPLICATION_ID + 1}`);
      },
    },
    {
      name: "user version ahead of its prefix",
      tamper(database: DatabaseSync): void {
        database.exec("PRAGMA user_version = 4");
      },
    },
    {
      name: "unknown migration entry",
      tamper(database: DatabaseSync): void {
        database.prepare(
          `INSERT INTO schema_migrations(version, application_id, name, applied_at)
           VALUES (4, ?, 'unknown-v4', ?)`,
        ).run(APPLICATION_ID, V4_APPLIED_AT);
        database.exec("PRAGMA user_version = 4");
      },
    },
    {
      name: "non-STRICT ledger",
      tamper(database: DatabaseSync): void {
        database.exec(`
          ALTER TABLE schema_migrations RENAME TO old_schema_migrations;
          CREATE TABLE schema_migrations AS SELECT * FROM old_schema_migrations;
          DROP TABLE old_schema_migrations;
        `);
      },
    },
    {
      name: "invalid ledger shape",
      tamper(database: DatabaseSync): void {
        database.exec(`
          DROP TABLE schema_migrations;
          CREATE TABLE schema_migrations(
            version INTEGER PRIMARY KEY,
            application_id INTEGER NOT NULL,
            name TEXT NOT NULL UNIQUE
          ) STRICT;
          INSERT INTO schema_migrations VALUES (3, ${APPLICATION_ID}, 'fixture-v3-bootstrap');
        `);
      },
    },
  ])("rejects an inconsistent $name before applying v4", ({ tamper }) => {
    const filename = fixturePath("inconsistent-prefix");
    createV3Fixture(filename);
    const raw = new DatabaseSync(filename);
    tamper(raw);
    const versionBefore = pragmaNumber(raw, "user_version");
    const journalBefore = pragmaString(raw, "journal_mode");
    raw.close();

    expect(() => open(filename, history())).toThrowError(
      expect.objectContaining<Partial<SqliteStoreError>>({ code: "CORRUPT_SCHEMA" }),
    );

    const verify = new DatabaseSync(filename, { readOnly: true });
    expect(pragmaNumber(verify, "user_version")).toBe(versionBefore);
    expect(pragmaString(verify, "journal_mode")).toBe(journalBefore);
    expect(tableNames(verify)).not.toContain("v4_audit");
    verify.close();
  });

  it("rejects unversioned, unknown, and future stores without migrating them", () => {
    const unversioned = fixturePath("unversioned");
    const rawUnversioned = new DatabaseSync(unversioned);
    rawUnversioned.exec(`
      CREATE TABLE legacy(value TEXT);
      PRAGMA application_id = ${APPLICATION_ID};
    `);
    rawUnversioned.close();
    expect(() => open(unversioned, history())).toThrowError(
      expect.objectContaining<Partial<SqliteStoreError>>({ code: "LEGACY_SCHEMA" }),
    );

    const unsupportedLegacy = fixturePath("unsupported-legacy");
    const rawLegacy = new DatabaseSync(unsupportedLegacy);
    rawLegacy.exec(`
      CREATE TABLE legacy_v2(value TEXT);
      PRAGMA application_id = ${APPLICATION_ID};
      PRAGMA user_version = 2;
    `);
    rawLegacy.close();
    expect(() => open(unsupportedLegacy, history())).toThrowError(
      expect.objectContaining<Partial<SqliteStoreError>>({ code: "LEGACY_SCHEMA" }),
    );

    const unknown = fixturePath("unknown");
    createV3Fixture(unknown);
    const rawUnknown = new DatabaseSync(unknown);
    rawUnknown.exec(`PRAGMA application_id = ${APPLICATION_ID + 1}`);
    rawUnknown.close();
    expect(() => open(unknown, history())).toThrowError(
      expect.objectContaining<Partial<SqliteStoreError>>({ code: "APPLICATION_ID_MISMATCH" }),
    );

    const future = fixturePath("future");
    open(future, history()).close();
    const rawFuture = new DatabaseSync(future);
    rawFuture.exec("PRAGMA user_version = 5");
    rawFuture.close();
    expect(() => open(future, history())).toThrowError(
      expect.objectContaining<Partial<SqliteStoreError>>({ code: "FUTURE_SCHEMA" }),
    );

    for (const filename of [unversioned, unsupportedLegacy, unknown]) {
      const verify = new DatabaseSync(filename, { readOnly: true });
      expect(tableNames(verify)).not.toContain("v4_audit");
      verify.close();
    }
    const verifyFuture = new DatabaseSync(future, { readOnly: true });
    expect(pragmaNumber(verifyFuture, "user_version")).toBe(5);
    expect(tableNames(verifyFuture)).toContain("v4_audit");
    verifyFuture.close();
  });

  it("rejects migration versions that SQLite cannot represent", () => {
    expect(() => new HardenedSqliteDatabase({
      filename: ":memory:",
      applicationId: APPLICATION_ID,
      storeName: "invalid migration store",
      migrations: [{
        version: 0x8000_0000,
        name: "unrepresentable-version",
        apply(): void {},
      }],
    })).toThrow("positive signed 31-bit versions");
  });
});

function history(onApply: (version: number) => void = () => undefined): SqliteMigration[] {
  return [
    {
      version: 3,
      name: "fixture-v3-bootstrap",
      apply(database): void {
        onApply(3);
        database.exec(`
          CREATE TABLE records(
            id INTEGER PRIMARY KEY,
            value TEXT NOT NULL
          ) STRICT;
        `);
      },
    },
    {
      version: 4,
      name: "fixture-v4-generation",
      apply(database): void {
        onApply(4);
        database.exec(`
          ALTER TABLE records
            ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0);
          CREATE TABLE v4_audit(
            id INTEGER PRIMARY KEY,
            message TEXT NOT NULL
          ) STRICT;
        `);
      },
    },
  ];
}

function createV3Fixture(filename: string): void {
  const [v3] = history();
  const sqlite = open(filename, [v3!], V3_APPLIED_AT);
  sqlite.database.prepare("INSERT INTO records(value) VALUES (?)").run("preserved");
  sqlite.close();
}

function open(
  filename: string,
  migrations: readonly SqliteMigration[],
  appliedAt = V4_APPLIED_AT,
): HardenedSqliteDatabase {
  return new HardenedSqliteDatabase({
    filename,
    applicationId: APPLICATION_ID,
    storeName: "migration fixture store",
    migrations,
    now: () => new Date(appliedAt),
  });
}

function fixturePath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `agent-multiplex-${name}-`)), "state.sqlite");
}

function ledger(database: DatabaseSync): Record<string, unknown>[] {
  if (!tableNames(database).includes("schema_migrations")) return [];
  try {
    return database.prepare(
      `SELECT version, application_id, name, applied_at
       FROM schema_migrations ORDER BY version`,
    ).all() as Record<string, unknown>[];
  } catch {
    return [];
  }
}

function tableNames(database: DatabaseSync): string[] {
  return (database.prepare(
    `SELECT name FROM sqlite_schema
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all() as Array<{ name: string }>).map(({ name }) => name);
}

function strictTables(database: DatabaseSync): Array<{ name: string; strict: number }> {
  return database.prepare(
    `SELECT name, strict FROM pragma_table_list
     WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all() as Array<{ name: string; strict: number }>;
}

function pragmaNumber(database: DatabaseSync, pragma: string): number {
  return Number(Object.values(database.prepare(`PRAGMA ${pragma}`).get()!)[0]);
}

function pragmaString(database: DatabaseSync, pragma: string): string {
  return String(Object.values(database.prepare(`PRAGMA ${pragma}`).get()!)[0]).toLowerCase();
}
