import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";

/**
 * Baseline used by the original protocol-v3 store migrations. The migration
 * engine's target is the final configured migration, not this constant.
 */
export const SQLITE_SCHEMA_VERSION = 3;

export type SqliteStoreErrorCode =
  | "APPLICATION_ID_MISMATCH"
  | "CLOSED"
  | "CORRUPT_SCHEMA"
  | "FUTURE_SCHEMA"
  | "INTEGRITY_CHECK_FAILED"
  | "LEGACY_SCHEMA"
  | "UNSAFE_PATH"
  | "WRITER_LOCKED";

export class SqliteStoreError extends Error {
  public readonly code: SqliteStoreErrorCode;
  public readonly details: Readonly<Record<string, unknown>> | undefined;

  public constructor(
    code: SqliteStoreErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "SqliteStoreError";
    this.code = code;
    this.details = details;
  }
}

export interface SqliteMigration {
  /** Schema version established by this migration. */
  version: number;
  name: string;
  apply(database: DatabaseSync): void;
}

export interface HardenedSqliteOptions {
  filename: string;
  /** Stable, store-specific positive 31-bit SQLite application ID. */
  applicationId: number;
  storeName: string;
  /**
   * Immutable ordered migration history. The final entry is the target schema
   * version; an existing ledger must be an exact prefix of this sequence.
   */
  migrations: readonly SqliteMigration[];
  busyTimeoutMs?: number;
  now?: () => Date;
}

export interface SqliteIntegrityDiagnostics {
  quickCheck: readonly string[];
  foreignKeyViolations: readonly Readonly<Record<string, unknown>>[];
}

export interface SqliteDiagnostics {
  filename: string;
  storeName: string;
  applicationId: number;
  userVersion: number;
  journalMode: string;
  foreignKeys: boolean;
  synchronous: string;
  integrity: SqliteIntegrityDiagnostics;
  databaseBytes: number | null;
  walBytes: number | null;
  shmBytes: number | null;
  lockOwner: SqliteWriterLockOwner | null;
}

export interface SqliteCheckpointResult {
  busy: number;
  logFrames: number;
  checkpointedFrames: number;
}

export interface SqliteBackupResult {
  filename: string;
  applicationId: number;
  userVersion: number;
  bytes: number;
  integrity: SqliteIntegrityDiagnostics;
}

export interface SqliteWriterLockOwner {
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  processStartedAt: string;
  storeName: string;
}

type Row = Record<string, unknown>;

/**
 * A single-writer SQLite lifecycle shared by all durable agent-multiplex stores.
 * Schema application is synchronous and atomic; online backups are asynchronous
 * because Node's SQLite backup API copies incrementally without stopping writes.
 */
export class HardenedSqliteDatabase {
  public readonly database: DatabaseSync;
  public readonly filename: string;
  public readonly applicationId: number;
  public readonly storeName: string;

  readonly #fileBacked: boolean;
  readonly #lock: SqliteWriterLock | null;
  readonly #schemaVersion: number;
  #closed = false;

  public constructor(options: HardenedSqliteOptions) {
    assertApplicationId(options.applicationId);
    assertMigrationSet(options.migrations);
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 600_000) {
      throw new RangeError("SQLite busyTimeoutMs must be an integer between 0 and 600000");
    }
    const expectedVersion = options.migrations.at(-1)!.version;

    this.#fileBacked = options.filename !== ":memory:";
    this.filename = this.#fileBacked ? resolve(options.filename) : options.filename;
    this.applicationId = options.applicationId;
    this.storeName = options.storeName;
    this.#schemaVersion = expectedVersion;

    let lock: SqliteWriterLock | null = null;
    let database: DatabaseSync | null = null;
    try {
      if (this.#fileBacked) {
        prepareStateDirectory(this.filename);
        validateSqliteBundle(this.filename);
        lock = SqliteWriterLock.acquire(this.filename, options.storeName, options.now);
        ensureRegularFile(this.filename, true);
      }

      database = new DatabaseSync(this.filename, {
        timeout: busyTimeoutMs,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        allowExtension: false,
      });
      configureConnection(database, busyTimeoutMs);
      initializeOrMigrateSchema(database, options);
      // Journal-mode conversion writes the database header. Perform it only
      // after identity/version validation so rejected legacy or foreign files
      // are inspected without mutation.
      if (this.#fileBacked) database.exec("PRAGMA journal_mode = WAL");
      assertConnectionConfiguration(database, this.#fileBacked, options);
      assertIntegrity(database, options.storeName);
      if (this.#fileBacked) secureSqliteBundle(this.filename);
    } catch (error) {
      const failure = normalizeSqliteOpenError(error, options.storeName);
      try {
        database?.close();
      } catch {
        // Keep the primary initialization error while still releasing the
        // independent process-lifetime writer guard.
      }
      try {
        lock?.release();
      } catch {
        // Keep the primary initialization error. SQLite's OS lock is released
        // when the lock connection closes or, as a final fallback, on exit.
      }
      throw failure;
    }

    this.database = database;
    this.#lock = lock;
  }

  public diagnostics(): SqliteDiagnostics {
    this.#assertOpen();
    const integrity = inspectIntegrity(this.database);
    return {
      filename: this.filename,
      storeName: this.storeName,
      applicationId: pragmaNumber(this.database, "application_id"),
      userVersion: pragmaNumber(this.database, "user_version"),
      journalMode: pragmaString(this.database, "journal_mode"),
      foreignKeys: pragmaNumber(this.database, "foreign_keys") === 1,
      synchronous: synchronousName(pragmaNumber(this.database, "synchronous")),
      integrity,
      databaseBytes: fileSize(this.#fileBacked ? this.filename : null),
      walBytes: fileSize(this.#fileBacked ? `${this.filename}-wal` : null),
      shmBytes: fileSize(this.#fileBacked ? `${this.filename}-shm` : null),
      lockOwner: this.#lock?.owner ?? null,
    };
  }

  /** Run an explicit quick or full integrity audit on the live database. */
  public integrityCheck(mode: "quick" | "full" = "quick"): SqliteIntegrityDiagnostics {
    this.#assertOpen();
    const integrity = inspectIntegrity(this.database, mode);
    assertIntegrityResult(integrity, this.storeName);
    return integrity;
  }

  public checkpoint(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE"):
    SqliteCheckpointResult {
    this.#assertOpen();
    if (!["PASSIVE", "FULL", "RESTART", "TRUNCATE"].includes(mode)) {
      throw new RangeError("unsupported SQLite WAL checkpoint mode");
    }
    const row = this.database.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as Row;
    if (this.#fileBacked) secureSqliteBundle(this.filename);
    return {
      busy: Number(row.busy ?? 0),
      logFrames: Number(row.log ?? 0),
      checkpointedFrames: Number(row.checkpointed ?? 0),
    };
  }

  public async backup(destination: string): Promise<SqliteBackupResult> {
    this.#assertOpen();
    if (destination === ":memory:") {
      throw new SqliteStoreError("UNSAFE_PATH", "a backup destination must be a filesystem path");
    }
    const filename = resolve(destination);
    prepareStateDirectory(filename);
    if (existsSync(filename)) {
      throw new SqliteStoreError(
        "UNSAFE_PATH",
        `refusing to overwrite existing SQLite backup ${filename}`,
      );
    }

    // Reserve the exact path with O_EXCL/O_NOFOLLOW so another process cannot
    // redirect or replace the destination between validation and backup.
    ensureRegularFile(filename, true);
    try {
      await sqliteBackup(this.database, filename);
      secureSqliteBundle(filename);
      const verification = new DatabaseSync(filename, {
        readOnly: true,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        allowExtension: false,
      });
      try {
        const applicationId = pragmaNumber(verification, "application_id");
        const userVersion = pragmaNumber(verification, "user_version");
        if (applicationId !== this.applicationId || userVersion !== this.#schemaVersion) {
          throw new SqliteStoreError(
            "CORRUPT_SCHEMA",
            "online backup did not preserve the SQLite schema identity",
            { applicationId, userVersion },
          );
        }
        const integrity = inspectIntegrity(verification);
        assertIntegrityResult(integrity, `${this.storeName} backup`);
        return {
          filename,
          applicationId,
          userVersion,
          bytes: statSync(filename).size,
          integrity,
        };
      } finally {
        verification.close();
      }
    } catch (error) {
      if (existsSync(filename)) unlinkSync(filename);
      throw error;
    }
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    let failure: unknown;
    try {
      if (this.#fileBacked) this.checkpointForClose();
    } catch (error) {
      failure = error;
    }
    try {
      if (this.#fileBacked) secureSqliteBundle(this.filename);
    } catch (error) {
      failure ??= error;
    }
    let databaseClosed = false;
    try {
      this.database.close();
      databaseClosed = true;
    } catch (error) {
      failure ??= error;
    }
    if (databaseClosed) {
      try {
        this.#lock?.release();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  public [Symbol.dispose](): void {
    this.close();
  }

  private checkpointForClose(): void {
    // A passive checkpoint first makes progress even if a reader is still
    // attached. TRUNCATE then removes the WAL when this process is the final
    // connection, while a busy result safely leaves a valid WAL behind.
    this.database.exec("PRAGMA wal_checkpoint(PASSIVE)");
    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  #assertOpen(): void {
    if (this.#closed) throw new SqliteStoreError("CLOSED", `${this.storeName} database is closed`);
  }
}

function configureConnection(database: DatabaseSync, busyTimeoutMs: number): void {
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA trusted_schema = OFF");
}

function initializeOrMigrateSchema(
  database: DatabaseSync,
  options: HardenedSqliteOptions,
): void {
  const expectedVersion = options.migrations.at(-1)!.version;
  const earliestVersion = options.migrations[0]!.version;
  const actualApplicationId = pragmaNumber(database, "application_id");
  const actualVersion = pragmaNumber(database, "user_version");
  const userTables = database
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Row[];

  if (actualApplicationId === 0 && actualVersion === 0 && userTables.length === 0) {
    applyMigrationSuffix(database, options, 0, true);
    return;
  }

  if (actualApplicationId === 0 && actualVersion === 0) {
    throw new SqliteStoreError(
      "LEGACY_SCHEMA",
      `${options.storeName} contains an unversioned legacy schema; a fresh state directory is required`,
      { tables: userTables.map((row) => String(row.name)) },
    );
  }
  if (actualApplicationId !== options.applicationId) {
    throw new SqliteStoreError(
      "APPLICATION_ID_MISMATCH",
      `${options.storeName} application_id ${actualApplicationId} does not match ${options.applicationId}`,
      { actualApplicationId, expectedApplicationId: options.applicationId },
    );
  }
  if (actualVersion === 0) {
    throw new SqliteStoreError(
      "LEGACY_SCHEMA",
      `${options.storeName} has an application identity but no schema version`,
      { actualVersion, expectedVersion },
    );
  }
  if (actualVersion < 0) {
    throw new SqliteStoreError(
      "CORRUPT_SCHEMA",
      `${options.storeName} has invalid schema version ${actualVersion}`,
      { actualVersion, expectedVersion },
    );
  }
  if (actualVersion > expectedVersion) {
    throw new SqliteStoreError(
      "FUTURE_SCHEMA",
      `${options.storeName} schema v${actualVersion} is newer than this binary`,
      { actualVersion, expectedVersion },
    );
  }
  if (actualVersion < earliestVersion) {
    throw new SqliteStoreError(
      "LEGACY_SCHEMA",
      `${options.storeName} schema v${actualVersion} predates its earliest supported migration v${earliestVersion}`,
      { actualVersion, earliestVersion, expectedVersion },
    );
  }
  const appliedMigrations = validateMigrationLedgerPrefix(database, options, actualVersion);
  if (actualVersion === expectedVersion) return;

  // Refuse to migrate a database that already violates integrity guarantees.
  // The constructor checks again after the migration and WAL configuration.
  assertIntegrity(database, options.storeName);
  applyMigrationSuffix(database, options, appliedMigrations, false, actualVersion);
}

function validateMigrationLedgerPrefix(
  database: DatabaseSync,
  options: HardenedSqliteOptions,
  actualVersion: number,
): number {
  const ledger = database
    .prepare(
      `SELECT type FROM sqlite_schema WHERE name = 'schema_migrations'`,
    )
    .get() as Row | undefined;
  if (!ledger) {
    throw new SqliteStoreError("CORRUPT_SCHEMA", `${options.storeName} migration ledger is missing`);
  }
  if (ledger.type !== "table") {
    throw new SqliteStoreError(
      "CORRUPT_SCHEMA",
      `${options.storeName} migration ledger is not a table`,
    );
  }
  const table = database
    .prepare(
      `SELECT strict FROM pragma_table_list
       WHERE schema = 'main' AND name = 'schema_migrations' AND type = 'table'`,
    )
    .get() as Row | undefined;
  if (Number(table?.strict) !== 1) {
    throw new SqliteStoreError(
      "CORRUPT_SCHEMA",
      `${options.storeName} migration ledger is not a STRICT table`,
    );
  }

  let rows: Row[];
  try {
    rows = database
      .prepare(
        `SELECT version, application_id, name, applied_at
         FROM schema_migrations ORDER BY version`,
      )
      .all() as Row[];
  } catch (cause) {
    throw new SqliteStoreError(
      "CORRUPT_SCHEMA",
      `${options.storeName} migration ledger has an invalid shape`,
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  if (rows.length === 0) {
    throw new SqliteStoreError(
      "CORRUPT_SCHEMA",
      `${options.storeName} migration ledger is empty at schema v${actualVersion}`,
    );
  }
  if (rows.length > options.migrations.length) {
    throw new SqliteStoreError(
      "CORRUPT_SCHEMA",
      `${options.storeName} migration ledger contains migrations unknown to this binary`,
    );
  }
  for (let index = 0; index < rows.length; index += 1) {
    const expected = options.migrations[index]!;
    const actual = rows[index]!;
    if (
      Number(actual.version) !== expected.version ||
      Number(actual.application_id) !== options.applicationId ||
      String(actual.name) !== expected.name ||
      typeof actual.applied_at !== "string" ||
      actual.applied_at.length === 0
    ) {
      throw new SqliteStoreError(
        "CORRUPT_SCHEMA",
        `${options.storeName} migration ledger entry ${index + 1} does not match this binary`,
      );
    }
  }
  const ledgerVersion = Number(rows.at(-1)!.version);
  if (ledgerVersion !== actualVersion) {
    throw new SqliteStoreError(
      "CORRUPT_SCHEMA",
      `${options.storeName} migration ledger establishes v${ledgerVersion}, not schema v${actualVersion}`,
      { actualVersion, ledgerVersion },
    );
  }
  return rows.length;
}

function applyMigrationSuffix(
  database: DatabaseSync,
  options: HardenedSqliteOptions,
  startIndex: number,
  bootstrap: boolean,
  previousVersion = 0,
): void {
  database.exec("BEGIN EXCLUSIVE");
  try {
    if (
      !bootstrap &&
      (
        pragmaNumber(database, "application_id") !== options.applicationId ||
        pragmaNumber(database, "user_version") !== previousVersion ||
        validateMigrationLedgerPrefix(database, options, previousVersion) !== startIndex
      )
    ) {
      throw new SqliteStoreError(
        "CORRUPT_SCHEMA",
        `${options.storeName} migration prefix changed before the upgrade transaction`,
      );
    }
    if (bootstrap) {
      database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY CHECK(version > 0),
          application_id INTEGER NOT NULL,
          name TEXT NOT NULL UNIQUE,
          applied_at TEXT NOT NULL
        ) STRICT;
      `);
    }
    const recordMigration = database.prepare(
      `INSERT INTO schema_migrations(version, application_id, name, applied_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (let index = startIndex; index < options.migrations.length; index += 1) {
      const migration = options.migrations[index]!;
      migration.apply(database);
      recordMigration.run(
        migration.version,
        options.applicationId,
        migration.name,
        (options.now ?? (() => new Date()))().toISOString(),
      );
      database.exec(`PRAGMA user_version = ${migration.version}`);
    }
    if (bootstrap) database.exec(`PRAGMA application_id = ${options.applicationId}`);
    const expectedVersion = options.migrations.at(-1)!.version;
    if (pragmaNumber(database, "application_id") !== options.applicationId) {
      throw new SqliteStoreError(
        "CORRUPT_SCHEMA",
        `${options.storeName} migration changed the database application identity`,
      );
    }
    validateMigrationLedgerPrefix(database, options, expectedVersion);
    assertIntegrity(database, options.storeName);
    database.exec("COMMIT");
  } catch (cause) {
    try { database.exec("ROLLBACK"); }
    catch { /* Preserve the migration failure if a migration disturbed the transaction. */ }
    throw cause;
  }
}

function assertConnectionConfiguration(
  database: DatabaseSync,
  fileBacked: boolean,
  options: HardenedSqliteOptions,
): void {
  const journalMode = pragmaString(database, "journal_mode");
  const foreignKeys = pragmaNumber(database, "foreign_keys");
  const synchronous = pragmaNumber(database, "synchronous");
  if (fileBacked && journalMode !== "wal") {
    throw new SqliteStoreError(
      "CORRUPT_SCHEMA",
      `${options.storeName} failed to enter WAL mode`,
      { journalMode },
    );
  }
  if (foreignKeys !== 1 || synchronous !== 2) {
    throw new SqliteStoreError(
      "CORRUPT_SCHEMA",
      `${options.storeName} connection safety pragmas were not applied`,
      { foreignKeys, synchronous },
    );
  }
}

function inspectIntegrity(
  database: DatabaseSync,
  mode: "quick" | "full" = "quick",
): SqliteIntegrityDiagnostics {
  const quickRows = database
    .prepare(mode === "quick" ? "PRAGMA quick_check" : "PRAGMA integrity_check")
    .all() as Row[];
  const quickCheck = quickRows.map((row) => String(Object.values(row)[0]));
  const foreignKeyViolations = (database.prepare("PRAGMA foreign_key_check").all() as Row[])
    .map((row) => ({ ...row }));
  return { quickCheck, foreignKeyViolations };
}

function assertIntegrity(database: DatabaseSync, storeName: string): void {
  assertIntegrityResult(inspectIntegrity(database), storeName);
}

function assertIntegrityResult(integrity: SqliteIntegrityDiagnostics, storeName: string): void {
  if (
    integrity.quickCheck.length !== 1 ||
    integrity.quickCheck[0] !== "ok" ||
    integrity.foreignKeyViolations.length > 0
  ) {
    throw new SqliteStoreError(
      "INTEGRITY_CHECK_FAILED",
      `${storeName} failed SQLite integrity checks`,
      {
        quickCheck: integrity.quickCheck,
        foreignKeyViolations: integrity.foreignKeyViolations,
      },
    );
  }
}

function pragmaNumber(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Row;
  return Number(Object.values(row)[0]);
}

function pragmaString(database: DatabaseSync, pragma: string): string {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Row;
  return String(Object.values(row)[0]).toLowerCase();
}

function assertApplicationId(applicationId: number): void {
  if (!Number.isSafeInteger(applicationId) || applicationId <= 0 || applicationId > 0x7fff_ffff) {
    throw new RangeError("SQLite applicationId must be a positive signed 31-bit integer");
  }
}

function assertMigrationSet(migrations: readonly SqliteMigration[]): void {
  if (migrations.length === 0) throw new RangeError("at least one SQLite migration is required");
  let previous = 0;
  const names = new Set<string>();
  for (const migration of migrations) {
    if (
      !Number.isSafeInteger(migration.version) ||
      migration.version <= previous ||
      migration.version > 0x7fff_ffff
    ) {
      throw new RangeError(
        "SQLite migrations must have strictly increasing positive signed 31-bit versions",
      );
    }
    if (migration.name.length === 0 || names.has(migration.name)) {
      throw new RangeError("SQLite migration names must be non-empty and unique");
    }
    previous = migration.version;
    names.add(migration.name);
  }
}

function prepareStateDirectory(filename: string): void {
  const directory = dirname(filename);
  const existed = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const status = lstatSync(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new SqliteStoreError(
      "UNSAFE_PATH",
      `SQLite state directory must be a non-symlink directory: ${directory}`,
    );
  }
  const mode = status.mode & 0o777;
  if (existed && mode !== 0o700) {
    throw new SqliteStoreError(
      "UNSAFE_PATH",
      `SQLite state directory must have mode 0700 (found ${mode.toString(8)}): ${directory}`,
    );
  }
  if (!existed) chmodSync(directory, 0o700);
}

function validateSqliteBundle(filename: string): void {
  for (const candidate of sqliteBundleFiles(filename)) {
    if (!existsSync(candidate)) continue;
    const status = lstatSync(candidate);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new SqliteStoreError(
        "UNSAFE_PATH",
        `SQLite state path must be a regular non-symlink file: ${candidate}`,
      );
    }
  }
}

function ensureRegularFile(filename: string, create: boolean): void {
  if (!existsSync(filename) && create) {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const descriptor = openSync(
      filename,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow,
      0o600,
    );
    closeSync(descriptor);
  }
  const status = lstatSync(filename);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new SqliteStoreError(
      "UNSAFE_PATH",
      `SQLite path must be a regular non-symlink file: ${filename}`,
    );
  }
  chmodSync(filename, 0o600);
}

function secureSqliteBundle(filename: string): void {
  for (const candidate of sqliteBundleFiles(filename)) {
    if (!existsSync(candidate)) continue;
    const status = lstatSync(candidate);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new SqliteStoreError(
        "UNSAFE_PATH",
        `SQLite created an unsafe sidecar path: ${candidate}`,
      );
    }
    chmodSync(candidate, 0o600);
  }
}

function sqliteBundleFiles(filename: string): readonly string[] {
  return [filename, `${filename}-wal`, `${filename}-shm`, `${filename}-journal`];
}

function fileSize(filename: string | null): number | null {
  return filename && existsSync(filename) ? statSync(filename).size : null;
}

function synchronousName(value: number): string {
  return ["off", "normal", "full", "extra"][value] ?? `unknown(${value})`;
}

class SqliteWriterLock {
  public readonly owner: SqliteWriterLockOwner;
  readonly #database: DatabaseSync;
  readonly #ownerFilename: string;
  #released = false;

  private constructor(
    database: DatabaseSync,
    ownerFilename: string,
    owner: SqliteWriterLockOwner,
  ) {
    this.#database = database;
    this.#ownerFilename = ownerFilename;
    this.owner = owner;
  }

  public static acquire(
    databaseFilename: string,
    storeName: string,
    now: (() => Date) | undefined,
  ): SqliteWriterLock {
    const filename = `${databaseFilename}.lock.sqlite`;
    const ownerFilename = `${filename}.owner.json`;
    const owner: SqliteWriterLockOwner = {
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: (now ?? (() => new Date()))().toISOString(),
      processStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
      storeName,
    };

    ensureRegularFile(filename, true);
    if (existsSync(ownerFilename)) validateRegularFile(ownerFilename);
    const database = new DatabaseSync(filename, {
      timeout: 0,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    try {
      // SQLite's OS-level exclusive lock is the authority. A killed process
      // releases it automatically, so stale PID files never need to be stolen.
      database.exec("PRAGMA journal_mode = DELETE");
      database.exec("PRAGMA locking_mode = EXCLUSIVE");
      database.exec("BEGIN EXCLUSIVE");
      secureSqliteBundle(filename);
    } catch (error) {
      database.close();
      if (!isSqliteBusy(error)) throw error;
      const existing = readLockOwnerForDiagnostics(ownerFilename);
      throw new SqliteStoreError(
        "WRITER_LOCKED",
        existing
          ? `${storeName} state is already owned by pid ${existing.pid} on ${existing.hostname}`
          : `${storeName} state is already owned by another process`,
        { filename, ...(existing ? { owner: existing } : {}) },
      );
    }

    try {
      writeOwnerAtomically(ownerFilename, owner);
      return new SqliteWriterLock(database, ownerFilename, owner);
    } catch (error) {
      database.exec("ROLLBACK");
      database.close();
      throw error;
    }
  }

  public release(): void {
    if (this.#released) return;
    this.#released = true;
    let failure: unknown;
    try {
      if (existsSync(this.#ownerFilename)) {
        const current = readLockOwnerForDiagnostics(this.#ownerFilename);
        if (!current || current.token !== this.owner.token) {
          throw new SqliteStoreError(
            "WRITER_LOCKED",
            `refusing to remove a ${this.owner.storeName} owner record that changed unexpectedly`,
            { filename: this.#ownerFilename, ...(current ? { owner: current } : {}) },
          );
        }
        // Remove diagnostics while still holding the OS lock; this prevents an
        // old process from deleting a successor's owner record after release.
        unlinkSync(this.#ownerFilename);
      }
    } catch (error) {
      failure = error;
    }
    try {
      this.#database.exec("ROLLBACK");
      this.#database.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }
}

function writeOwnerAtomically(filename: string, value: SqliteWriterLockOwner): void {
  const temporary = `${filename}.${value.token}.tmp`;
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, { encoding: "utf8" });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(temporary, 0o600);
  if (existsSync(filename)) validateRegularFile(filename);
  renameSync(temporary, filename);
}

function readLockOwnerForDiagnostics(filename: string): SqliteWriterLockOwner | null {
  if (!existsSync(filename)) return null;
  validateRegularFile(filename);
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(filename, "utf8"));
  } catch {
    return null;
  }
  if (
    !input ||
    typeof input !== "object" ||
    typeof (input as Row).token !== "string" ||
    !Number.isSafeInteger((input as Row).pid) ||
    typeof (input as Row).hostname !== "string" ||
    typeof (input as Row).acquiredAt !== "string" ||
    typeof (input as Row).processStartedAt !== "string" ||
    typeof (input as Row).storeName !== "string"
  ) {
    return null;
  }
  return input as unknown as SqliteWriterLockOwner;
}

function validateRegularFile(filename: string): void {
  const status = lstatSync(filename);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new SqliteStoreError(
      "UNSAFE_PATH",
      `SQLite state path must be a regular non-symlink file: ${filename}`,
    );
  }
  chmodSync(filename, 0o600);
}

function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const errorCode = (error as { errcode?: unknown }).errcode;
  return errorCode === 5 || errorCode === 6;
}

function normalizeSqliteOpenError(error: unknown, storeName: string): unknown {
  if (error instanceof SqliteStoreError || !error || typeof error !== "object") return error;
  const errorCode = (error as { errcode?: unknown }).errcode;
  if (errorCode !== 11 && errorCode !== 26) return error;
  return new SqliteStoreError(
    "INTEGRITY_CHECK_FAILED",
    `${storeName} is not a readable SQLite database`,
    { cause: error instanceof Error ? error.message : String(error), errorCode },
  );
}
