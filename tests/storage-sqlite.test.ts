import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";

import {
  HardenedSqliteDatabase,
  SQLITE_SCHEMA_VERSION,
  SqliteStoreError,
} from "@arduano/agent-multiplex-storage-sqlite";
import { RuntimeNodeStore } from "../packages/runtime-node-core/src/store.js";
import { describe, expect, it } from "vitest";

const APPLICATION_ID = 0x414d_5453;
const migration = {
  version: SQLITE_SCHEMA_VERSION,
  name: "test-v3-bootstrap",
  apply(database: DatabaseSync): void {
    database.exec("CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT");
  },
} as const;

describe("HardenedSqliteDatabase", () => {
  it("atomically bootstraps schema identity, ledger, safety pragmas, and secure files", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-sqlite-"));
    chmodSync(root, 0o755);
    const filename = join(root, "nested", "state.sqlite");
    const sqlite = open(filename);

    const diagnostics = sqlite.diagnostics();
    expect(diagnostics).toMatchObject({
      applicationId: APPLICATION_ID,
      userVersion: 3,
      journalMode: "wal",
      foreignKeys: true,
      synchronous: "full",
      integrity: { quickCheck: ["ok"], foreignKeyViolations: [] },
    });
    expect(statSync(join(root, "nested")).mode & 0o777).toBe(0o700);
    for (const candidate of [
      filename,
      `${filename}-wal`,
      `${filename}-shm`,
      `${filename}.lock.sqlite`,
      `${filename}.lock.sqlite.owner.json`,
    ]) {
      expect(statSync(candidate).mode & 0o777).toBe(0o600);
    }
    expect(sqlite.integrityCheck("full")).toEqual({
      quickCheck: ["ok"],
      foreignKeyViolations: [],
    });
    sqlite.close();
    expect(existsSync(`${filename}.lock.sqlite.owner.json`)).toBe(false);
    expect(!existsSync(`${filename}-wal`) || statSync(`${filename}-wal`).size === 0).toBe(true);

    const raw = new DatabaseSync(filename, { readOnly: true });
    expect(raw.prepare("SELECT version, application_id, name FROM schema_migrations").get())
      .toEqual({ version: 3, application_id: APPLICATION_ID, name: "test-v3-bootstrap" });
    raw.close();
  });

  it("rejects legacy, foreign, and future schemas without modifying them", () => {
    for (const fixture of [
      { name: "legacy", app: 0, version: 0, code: "LEGACY_SCHEMA" },
      { name: "foreign", app: APPLICATION_ID + 1, version: 3, code: "APPLICATION_ID_MISMATCH" },
      { name: "future", app: APPLICATION_ID, version: 4, code: "FUTURE_SCHEMA" },
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), `agent-multiplex-${fixture.name}-`));
      const filename = join(root, "state.sqlite");
      const raw = new DatabaseSync(filename);
      raw.exec("CREATE TABLE existing(value TEXT)");
      raw.exec(`PRAGMA application_id = ${fixture.app}`);
      raw.exec(`PRAGMA user_version = ${fixture.version}`);
      raw.close();

      expect(() => open(filename)).toThrowError(
        expect.objectContaining<Partial<SqliteStoreError>>({ code: fixture.code }),
      );
      const verify = new DatabaseSync(filename, { readOnly: true });
      expect(verify.prepare("SELECT name FROM sqlite_schema WHERE name = 'schema_migrations'").get())
        .toBeUndefined();
      expect(verify.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      verify.close();
    }
  });

  it("rolls back a failed bootstrap as one transaction", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-bootstrap-"));
    const filename = join(root, "state.sqlite");
    expect(() => new HardenedSqliteDatabase({
      filename,
      applicationId: APPLICATION_ID,
      storeName: "failing store",
      migrations: [{
        version: SQLITE_SCHEMA_VERSION,
        name: "failing-v3-bootstrap",
        apply(database): void {
          database.exec("CREATE TABLE partial(value TEXT) STRICT");
          throw new Error("injected migration failure");
        },
      }],
    })).toThrowError("injected migration failure");

    const raw = new DatabaseSync(filename, { readOnly: true });
    expect(raw.prepare(
      "SELECT name FROM sqlite_schema WHERE name IN ('partial', 'schema_migrations')",
    ).all()).toEqual([]);
    expect(raw.prepare("PRAGMA application_id").get()).toEqual({ application_id: 0 });
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    raw.close();
  });

  it("holds an OS-released exclusive writer guard and can reopen after close", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-writer-"));
    const filename = join(root, "state.sqlite");
    const first = open(filename);
    expect(() => open(filename)).toThrowError(
      expect.objectContaining<Partial<SqliteStoreError>>({ code: "WRITER_LOCKED" }),
    );
    first.close();
    const reopened = open(filename);
    reopened.close();
  });

  it("recovers automatically when the previous writer is killed", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-killed-writer-"));
    const filename = join(root, "state.sqlite");
    open(filename).close();
    const script = `
      import { HardenedSqliteDatabase } from "@arduano/agent-multiplex-storage-sqlite";
      import { DatabaseSync } from "node:sqlite";
      globalThis.store = new HardenedSqliteDatabase({
        filename: process.argv[1],
        applicationId: ${APPLICATION_ID},
        storeName: "killed test store",
        migrations: [{ version: 3, name: "test-v3-bootstrap", apply(database) {
          database.exec("CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT");
        }}],
      });
      process.stdout.write("ready\\n");
      setInterval(() => {}, 60_000);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script, filename], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ready = await Promise.race([
      once(child.stdout!, "data").then(([data]) => String(data)),
      once(child, "exit").then(() => "exited"),
    ]);
    expect(ready).toContain("ready");
    expect(() => {
      const unexpectedlyOpened = open(filename);
      unexpectedlyOpened.close();
    }).toThrowError(
      expect.objectContaining<Partial<SqliteStoreError>>({ code: "WRITER_LOCKED" }),
    );
    child.kill("SIGKILL");
    await once(child, "exit");

    const recovered = open(filename);
    recovered.close();
  });

  it("rejects symlink database paths", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-symlink-"));
    const target = join(root, "target.sqlite");
    writeFileSync(target, "");
    const filename = join(root, "state.sqlite");
    symlinkSync(target, filename);
    expect(() => open(filename)).toThrowError(
      expect.objectContaining<Partial<SqliteStoreError>>({ code: "UNSAFE_PATH" }),
    );
  });

  it("refuses to serve a database with foreign-key violations", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-foreign-key-"));
    const filename = join(root, "state.sqlite");
    const migrations = [{
      version: SQLITE_SCHEMA_VERSION,
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
    }] as const;
    const store = new HardenedSqliteDatabase({
      filename,
      applicationId: APPLICATION_ID,
      storeName: "foreign-key store",
      migrations,
    });
    store.close();
    const raw = new DatabaseSync(filename, { enableForeignKeyConstraints: false });
    raw.prepare("INSERT INTO child(id, parent_id) VALUES (1, 999)").run();
    raw.close();

    expect(() => new HardenedSqliteDatabase({
      filename,
      applicationId: APPLICATION_ID,
      storeName: "foreign-key store",
      migrations,
    })).toThrowError(
      expect.objectContaining<Partial<SqliteStoreError>>({ code: "INTEGRITY_CHECK_FAILED" }),
    );
  });

  it("reports an unreadable SQLite file as an integrity failure", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-corrupt-"));
    const filename = join(root, "state.sqlite");
    writeFileSync(filename, "this is not sqlite");
    expect(() => open(filename)).toThrowError(
      expect.objectContaining<Partial<SqliteStoreError>>({ code: "INTEGRITY_CHECK_FAILED" }),
    );
  });

  it("refuses to weaken or silently rewrite an insecure existing state directory", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-directory-mode-"));
    const stateDirectory = join(root, "state");
    mkdirSync(stateDirectory, { mode: 0o755 });
    const filename = join(stateDirectory, "state.sqlite");
    expect(() => open(filename)).toThrowError(
      expect.objectContaining<Partial<SqliteStoreError>>({ code: "UNSAFE_PATH" }),
    );
    expect(statSync(stateDirectory).mode & 0o777).toBe(0o755);
  });

  it("creates a verified online backup while writes continue", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-backup-"));
    const filename = join(root, "state.sqlite");
    const destination = join(root, "backup", "state.sqlite");
    const sqlite = open(filename);
    sqlite.database.prepare("INSERT INTO records(value) VALUES (?)").run("before");
    const result = await sqlite.backup(destination);
    sqlite.database.prepare("INSERT INTO records(value) VALUES (?)").run("after");
    expect(result).toMatchObject({ applicationId: APPLICATION_ID, userVersion: 3 });

    const backup = new DatabaseSync(destination, { readOnly: true });
    expect(backup.prepare("SELECT value FROM records ORDER BY id").all()).toEqual([
      { value: "before" },
    ]);
    backup.close();
    sqlite.close();
  });
});

describe("RuntimeNodeStore SQLite schema", () => {
  it("uses an independently identified v4 database with STRICT JSON tables", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-runtime-schema-"));
    const filename = join(root, "runtime.sqlite");
    const store = new RuntimeNodeStore(filename);
    expect(store.diagnostics()).toMatchObject({
      applicationId: 0x414d_5254,
      userVersion: 4,
      foreignKeys: true,
      synchronous: "full",
    });
    store.close();

    const raw = new DatabaseSync(filename);
    const tables = raw
      .prepare(
        `SELECT name, strict FROM pragma_table_list
         WHERE schema = 'main' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as Array<{ name: string; strict: number }>;
    expect(tables.every((table) => table.strict === 1)).toBe(true);
    expect(() => raw.prepare(
      `INSERT INTO bindings(session_id, record_json, updated_at)
       VALUES ('invalid', 'not-json', '2026-09-03T00:00:00.000Z')`,
    ).run()).toThrowError(/constraint/i);
    raw.close();
  });
});

function open(filename: string): HardenedSqliteDatabase {
  return new HardenedSqliteDatabase({
    filename,
    applicationId: APPLICATION_ID,
    storeName: "test store",
    migrations: [migration],
  });
}
