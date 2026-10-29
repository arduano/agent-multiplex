import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  scopeKey,
  type Json,
  type SessionScope,
  type Receipt,
  type Settlement,
} from "../protocol/index.js";
import { existingSidecars, privateFile } from "./private-file.js";

import {
  JournalError,
  type JournalHandle,
  type Limits,
  type OriginalJournalPort,
  type OriginalReadPort,
  type Priority,
} from "./contracts.js";

const defaults: Limits = {
  maxPending: 128,
  maxPendingBytes: 4 * 1024 * 1024,
  maxRequestBytes: 64 * 1024,
  maxResultBytes: 16 * 1024,
  maxRetainedBytes: 64 * 1024 * 1024,
  reservedStops: 1,
};
const applicationId = 0x4d585331;
const schema = `CREATE TABLE originals (
 scope TEXT NOT NULL, id TEXT NOT NULL, request_hash TEXT NOT NULL,
 priority TEXT NOT NULL CHECK(priority IN ('normal','stop')),
 state TEXT NOT NULL CHECK(state IN ('admitted','dispatched','unknown','succeeded','refused')),
 revision INTEGER NOT NULL, request_json TEXT, request_bytes INTEGER NOT NULL,
 result_json TEXT, retained_bytes INTEGER NOT NULL,
 PRIMARY KEY(scope,id),
 CHECK ((state IN ('succeeded','refused') AND request_json IS NULL AND result_json IS NOT NULL)
 OR (state IN ('admitted','dispatched','unknown') AND request_json IS NOT NULL AND result_json IS NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX pending_originals ON originals(priority) WHERE state IN ('admitted','dispatched','unknown');
CREATE TABLE journal_usage (singleton INTEGER PRIMARY KEY CHECK(singleton=1), retained_bytes INTEGER NOT NULL CHECK(retained_bytes>=0)) STRICT;
INSERT INTO journal_usage VALUES(1,0);`;
type Row = {
  scope: string;
  id: string;
  request_hash: string;
  priority: Priority;
  state: Receipt["state"];
  revision: number;
  request_json: string | null;
  result_json: string | null;
  request_bytes: number;
  retained_bytes: number;
};
function identity(scope: SessionScope, id: string): string {
  if (typeof id !== "string" || !id.length || id.length > 256 || /[\x00-\x1f\x7f]/.test(id))
    throw new TypeError("Invalid original id");
  return scopeKey(scope);
}
function receipt(row: Row): Receipt {
  const [connection, principal, host, session] = JSON.parse(row.scope) as [
    string,
    string,
    string,
    string,
  ];
  const original = {
    scope: Object.freeze({ connection, principal, host, session }),
    id: row.id,
    requestHash: row.request_hash,
    revision: row.revision,
  };
  return Object.freeze(
    row.state === "succeeded" || row.state === "refused"
      ? { ...original, state: row.state, result: JSON.parse(row.result_json!) as Json }
      : { ...original, state: row.state, result: null },
  );
}
function open(filename: string, readOnly: boolean): DatabaseSync {
  privateFile(filename, !readOnly);
  existingSidecars(filename);
  const db = new DatabaseSync(filename, { readOnly, timeout: 1000 });
  try {
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;");
    if (!readOnly) db.exec("PRAGMA synchronous=FULL;");
    const id = db.prepare("PRAGMA application_id").get() as { application_id: number };
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (id.application_id === 0 && version.user_version === 0 && !readOnly) {
      const count = db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema").get() as { n: number };
      if (count.n) throw new Error("Refusing unrecognized SQLite database");
      db.exec(
        `BEGIN IMMEDIATE; ${schema} PRAGMA application_id=${applicationId}; PRAGMA user_version=1; COMMIT;`,
      );
    } else if (id.application_id !== applicationId || version.user_version !== 1)
      throw new Error("Unsupported original journal schema");
    if (!readOnly) db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    existingSidecars(filename);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Exact lookup is a separate readonly connection, never a wait on an effect. */
class JournalReads {
  protected closed = false;
  constructor(protected readonly database: DatabaseSync) {}
  protected assertOpen(): void {
    if (this.closed) throw new JournalError("CLOSED", "Original journal is closed");
  }
  protected row(scope: SessionScope, id: string): Row | undefined {
    this.assertOpen();
    return this.database
      .prepare("SELECT * FROM originals WHERE scope=? AND id=?")
      .get(identity(scope, id), id) as Row | undefined;
  }
  read(scope: SessionScope, id: string): Receipt | null {
    const row = this.row(scope, id);
    return row ? receipt(row) : null;
  }
  request(scope: SessionScope, id: string): Json | null {
    const row = this.row(scope, id);
    return row?.request_json === null || !row ? null : (JSON.parse(row.request_json) as Json);
  }
  unresolved(
    scope: SessionScope,
  ): readonly Readonly<{ receipt: Receipt; request: Json; priority: Priority }>[] {
    this.assertOpen();
    return (
      this.database
        .prepare(
          "SELECT * FROM originals WHERE scope=? AND state IN ('admitted','dispatched','unknown') ORDER BY id",
        )
        .all(scopeKey(scope)) as Row[]
    ).map((row) =>
      Object.freeze({
        receipt: receipt(row),
        request: JSON.parse(row.request_json!) as Json,
        priority: row.priority,
      }),
    );
  }
  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }
}

export class OriginalReader extends JournalReads implements OriginalReadPort, JournalHandle {
  constructor(filename: string) {
    super(open(filename, true));
  }
}

/** One writer owns originals. This class never invokes an adapter or effect. */
export class OriginalJournal extends JournalReads implements OriginalJournalPort, JournalHandle {
  readonly writerIdentity: object = Object.freeze({});
  private readonly lock: DatabaseSync;
  private readonly limits: Limits;
  constructor(options: { filename: string; limits?: Partial<Limits> }) {
    const limits = { ...defaults, ...options.limits };
    for (const value of Object.values(limits))
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Invalid journal limit");
    const lockname = options.filename + ".writer.sqlite";
    privateFile(lockname, true);
    existingSidecars(lockname);
    const lock = new DatabaseSync(lockname, { timeout: 0 });
    try {
      lock.exec("PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;");
      super(open(options.filename, false));
      this.lock = lock;
      this.limits = limits;
    } catch (error) {
      lock.close();
      throw error;
    }
  }
  private transaction<T>(action: () => T): T {
    this.assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        /* preserve original write/commit failure */
      }
      throw error;
    }
  }
  admit(
    scope: SessionScope,
    id: string,
    request: Json,
    options: { priority?: Priority } = {},
  ): Readonly<{ fresh: boolean; receipt: Receipt }> {
    const key = identity(scope, id);
    const encoded = canonicalJson(request, this.limits.maxRequestBytes);
    const hash = createHash("sha256").update(encoded.json).digest("hex");
    const priority = options.priority ?? "normal";
    if (priority !== "normal" && priority !== "stop")
      throw new TypeError("Invalid admission priority");
    return this.transaction(() => {
      const existing = this.row(scope, id);
      if (existing) {
        if (existing.request_hash !== hash || existing.priority !== priority)
          throw new JournalError("CONFLICT", "Original id already has another meaning");
        return { fresh: false, receipt: receipt(existing) };
      }
      const usage = this.database
        .prepare(
          `SELECT
        (SELECT retained_bytes FROM journal_usage WHERE singleton=1) AS retained,
        SUM(CASE WHEN priority='normal' THEN 1 ELSE 0 END) AS normal_count,
        COALESCE(SUM(CASE WHEN priority='normal' THEN request_bytes ELSE 0 END),0) AS normal_bytes,
        SUM(CASE WHEN priority='stop' THEN 1 ELSE 0 END) AS stop_count
        FROM originals WHERE state IN ('admitted','dispatched','unknown')`,
        )
        .get() as {
        retained: number;
        normal_count: number | null;
        normal_bytes: number;
        stop_count: number | null;
      };
      const fixed = Buffer.byteLength(key) + Buffer.byteLength(id) + 256;
      const allocation = fixed + encoded.bytes + this.limits.maxResultBytes;
      const stopReserve =
        this.limits.reservedStops *
        (8192 + this.limits.maxRequestBytes + this.limits.maxResultBytes);
      const available = this.limits.maxRetainedBytes - (priority === "normal" ? stopReserve : 0);
      if (
        usage.retained + allocation > available ||
        (priority === "normal" &&
          ((usage.normal_count ?? 0) >= this.limits.maxPending ||
            usage.normal_bytes + encoded.bytes > this.limits.maxPendingBytes)) ||
        (priority === "stop" && (usage.stop_count ?? 0) >= this.limits.reservedStops)
      )
        throw new JournalError("CAPACITY", "Original journal admission capacity exhausted");
      this.database
        .prepare("INSERT INTO originals VALUES (?,?,?,?, 'admitted',1,?,?,NULL,?)")
        .run(key, id, hash, priority, encoded.json, encoded.bytes, allocation);
      this.database
        .prepare("UPDATE journal_usage SET retained_bytes=retained_bytes+? WHERE singleton=1")
        .run(allocation);
      return { fresh: true, receipt: receipt(this.row(scope, id)!) };
    });
  }
  markDispatched(scope: SessionScope, id: string): Readonly<{ fresh: boolean; receipt: Receipt }> {
    return this.transaction(() => {
      const row = this.row(scope, id);
      if (!row) throw new JournalError("NOT_FOUND", "Original not admitted");
      if (row.state !== "admitted") return { fresh: false, receipt: receipt(row) };
      this.database
        .prepare(
          "UPDATE originals SET state='dispatched',revision=revision+1 WHERE scope=? AND id=?",
        )
        .run(identity(scope, id), id);
      return { fresh: true, receipt: receipt(this.row(scope, id)!) };
    });
  }
  settle(scope: SessionScope, id: string, outcome: Settlement): Receipt {
    const encoded =
      outcome.state === "unknown"
        ? null
        : canonicalJson(outcome.result, this.limits.maxResultBytes);
    if (!["unknown", "succeeded", "refused"].includes(outcome.state))
      throw new TypeError("Invalid settlement");
    return this.transaction(() => {
      const row = this.row(scope, id);
      if (!row) throw new JournalError("NOT_FOUND", "Original not admitted");
      if (row.state === "succeeded" || row.state === "refused") {
        if (row.state !== outcome.state || row.result_json !== encoded?.json)
          throw new JournalError("CONFLICT", "Original already has a different outcome");
        return receipt(row);
      }
      if (row.state === "admitted" && outcome.state !== "refused")
        throw new JournalError("INVALID_TRANSITION", "Original has not been dispatched");
      if (row.state === "unknown" && outcome.state === "unknown") return receipt(row);
      if (outcome.state === "unknown")
        this.database
          .prepare(
            "UPDATE originals SET state='unknown',revision=revision+1 WHERE scope=? AND id=?",
          )
          .run(identity(scope, id), id);
      else {
        this.database
          .prepare(
            "UPDATE originals SET state=?,revision=revision+1,request_json=NULL,result_json=?,retained_bytes=retained_bytes-request_bytes,request_bytes=0 WHERE scope=? AND id=?",
          )
          .run(outcome.state, encoded!.json, identity(scope, id), id);
        this.database
          .prepare("UPDATE journal_usage SET retained_bytes=retained_bytes-? WHERE singleton=1")
          .run(row.request_bytes);
      }
      return receipt(this.row(scope, id)!);
    });
  }
  override close(): void {
    if (this.closed) return;
    const errors: unknown[] = [];
    try {
      super.close();
    } catch (error) {
      errors.push(error);
    } finally {
      this.closed = true;
    }
    try {
      this.lock.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Original journal cleanup failed");
  }
}
