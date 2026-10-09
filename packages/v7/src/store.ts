import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { jsonValueSchema } from "@arduano/agent-multiplex-protocol";
import { V7Error } from "./errors.js";
import type { JsonValue, RequestReceipt, RequestState, SessionBinding, SessionMetadata } from "./protocol.js";

export interface V7StoreOptions { filename: string; role: "host" | "root"; instanceId: string; now?: () => Date }
export function canonicalJson(input: unknown): string {
  const value = jsonValueSchema.parse(input);
  const normalize = (v: JsonValue): JsonValue => Array.isArray(v) ? v.map(normalize)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize(v[k]!)])) : v;
  return JSON.stringify(normalize(value));
}
export function requestHash(input: unknown): string { return createHash("sha256").update(canonicalJson(input)).digest("hex"); }
const unpack = <T>(value: unknown): T => JSON.parse(String(value)) as T;

/** One application database, one connection, one OS-released exclusive lease.
 * No ACL probes, lock files, repair policies, persisted online state or migrations.
 * V7's clean break intentionally refuses another role/identity/schema. */
export class V7Store {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  #closed = false;
  public readonly role: "host" | "root";
  public readonly instanceId: string;
  public constructor(options: V7StoreOptions) {
    this.role = options.role; this.instanceId = options.instanceId;
    this.#now = options.now ?? (() => new Date());
    if (options.filename !== ":memory:") mkdirSync(dirname(options.filename), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(options.filename, { timeout: 0, enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false, allowExtension: false });
    this.#db = db;
    try {
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE;");
      db.exec(`CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, role TEXT NOT NULL, instance_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, operation TEXT NOT NULL, payload_hash TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS receipt_events (request_id TEXT NOT NULL REFERENCES requests(request_id), ordinal INTEGER NOT NULL, state TEXT NOT NULL, result TEXT, error TEXT, at TEXT NOT NULL, PRIMARY KEY(request_id,ordinal));`);
      db.prepare("INSERT OR IGNORE INTO identity VALUES(1,7,?,?)").run(this.role, this.instanceId);
      const identity = db.prepare("SELECT * FROM identity WHERE singleton=1").get()!;
      if (identity.version !== 7 || identity.role !== this.role || identity.instance_id !== this.instanceId) {
        throw new V7Error("STORE_IDENTITY", "V7 state belongs to another schema, role or identity");
      }
      db.exec(this.role === "host"
        ? "CREATE TABLE IF NOT EXISTS bindings (session_id TEXT PRIMARY KEY, vendor_session_id TEXT NOT NULL UNIQUE, value TEXT NOT NULL);"
        : "CREATE TABLE IF NOT EXISTS registry (session_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, value TEXT NOT NULL);");
      db.exec("COMMIT");
      // EXCLUSIVE locking_mode retains this connection's OS lock after commit.
      // Process death releases it automatically. There is no stale-lock recovery.
      for (const request of this.receipts()) {
        if (request.state === "admitted") this.transition(request.requestId, "failed", {
          error: { code: "PROCESS_RESTART", message: "Process ended before dispatch; request was not replayed" },
        });
        if (request.state === "dispatched") this.transition(request.requestId, "outcomeUnknown", {
          error: { code: "PROCESS_RESTART", message: "Process ended after dispatch; check the original native operation" },
        });
      }
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* Initialization may already have committed. */ }
      db.close();
      if (error instanceof Error && "errcode" in error && error.errcode === 5) {
        throw new V7Error("WRITER_LOCKED", "V7 state is already owned by another process", { cause: error });
      }
      throw error;
    }
  }
  public now(): string { return this.#now().toISOString(); }
  public transaction<T>(action: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.#db.exec("COMMIT"); return result; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  public admit(requestId: string, sessionId: string, operation: string, payload: unknown): { receipt: RequestReceipt; fresh: boolean } {
    const text = canonicalJson(payload), hash = requestHash(payload);
    const existing = this.receipt(requestId);
    if (existing) {
      if (existing.sessionId !== sessionId || existing.operation !== operation || existing.payloadHash !== hash) {
        throw new V7Error("REQUEST_CONFLICT", "Request ID already names a different immutable operation");
      }
      return { receipt: existing, fresh: false };
    }
    const at = this.now();
    this.transaction(() => {
      this.#db.prepare("INSERT INTO requests VALUES(?,?,?,?,?,?)").run(requestId, sessionId, operation, hash, text, at);
      this.#db.prepare("INSERT INTO receipt_events VALUES(?,0,'admitted',NULL,NULL,?)").run(requestId, at);
    });
    return { receipt: this.receipt(requestId)!, fresh: true };
  }
  public receipt(requestId: string): RequestReceipt | null {
    const row = this.#db.prepare(`SELECT r.*, e.state,e.result,e.error,e.at FROM requests r JOIN receipt_events e USING(request_id)
      WHERE r.request_id=? ORDER BY e.ordinal DESC LIMIT 1`).get(requestId);
    if (!row) return null;
    return { requestId: String(row.request_id), sessionId: String(row.session_id), operation: String(row.operation),
      payloadHash: String(row.payload_hash), state: String(row.state) as RequestState,
      request: unpack<JsonValue>(row.payload),
      createdAt: String(row.created_at), updatedAt: String(row.at),
      ...(row.result === null ? {} : { result: unpack<JsonValue>(row.result) }),
      ...(row.error === null ? {} : { error: unpack<{ code: string; message: string }>(row.error) }) };
  }
  public requestPayload(requestId: string): JsonValue | null {
    const row = this.#db.prepare("SELECT payload FROM requests WHERE request_id=?").get(requestId);
    return row ? unpack<JsonValue>(row.payload) : null;
  }
  public receipts(): RequestReceipt[] {
    return this.#db.prepare("SELECT request_id FROM requests ORDER BY created_at,request_id").all()
      .map(row => this.receipt(String(row.request_id))!);
  }
  public receiptEvents(requestId: string): Array<{ state: RequestState; at: string }> {
    return this.#db.prepare("SELECT state,at FROM receipt_events WHERE request_id=? ORDER BY ordinal").all(requestId)
      .map(row => ({ state: String(row.state) as RequestState, at: String(row.at) }));
  }
  public transition(requestId: string, state: RequestState, outcome: {
    result?: JsonValue; error?: { code: string; message: string };
  } = {}): RequestReceipt {
    const current = this.receipt(requestId);
    if (!current) throw new V7Error("REQUEST_MISSING", "Request is not admitted");
    const permitted = current.state === "admitted" ? ["dispatched", "failed"]
      : current.state === "dispatched" ? ["succeeded", "failed", "outcomeUnknown"]
      : current.state === "outcomeUnknown" ? ["succeeded", "failed"] : [];
    if (!permitted.includes(state)) throw new V7Error("REQUEST_TERMINAL", "Request receipt cannot take this transition");
    this.#db.prepare(`INSERT INTO receipt_events SELECT ?,COALESCE(MAX(ordinal),-1)+1,?,?,?,?
      FROM receipt_events WHERE request_id=?`).run(requestId, state,
      outcome.result === undefined ? null : canonicalJson(outcome.result),
      outcome.error === undefined ? null : canonicalJson(outcome.error), this.now(), requestId);
    return this.receipt(requestId)!;
  }
  public binding(sessionId: string): SessionBinding | null {
    this.assertRole("host");
    const row = this.#db.prepare("SELECT value FROM bindings WHERE session_id=?").get(sessionId);
    return row ? unpack<SessionBinding>(row.value) : null;
  }
  public bindings(): SessionBinding[] {
    this.assertRole("host"); return this.#db.prepare("SELECT value FROM bindings ORDER BY session_id").all().map(row => unpack<SessionBinding>(row.value));
  }
  public putBinding(binding: SessionBinding): void {
    this.assertRole("host");
    const previous = this.binding(binding.sessionId);
    if (previous && (previous.hostId !== binding.hostId || previous.harness !== binding.harness ||
      previous.vendorSessionId !== binding.vendorSessionId || previous.adapterScopeId !== binding.adapterScopeId)) {
      throw new V7Error("BINDING_CONFLICT", "Native binding identity is immutable");
    }
    this.#db.prepare("INSERT INTO bindings VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET value=excluded.value")
      .run(binding.sessionId, binding.vendorSessionId, canonicalJson(binding));
  }
  public metadata(sessionId: string): SessionMetadata | null {
    this.assertRole("root"); const row = this.#db.prepare("SELECT value FROM registry WHERE session_id=?").get(sessionId);
    return row ? unpack<SessionMetadata>(row.value) : null;
  }
  public registry(): SessionMetadata[] {
    this.assertRole("root"); return this.#db.prepare("SELECT value FROM registry ORDER BY session_id").all().map(row => unpack<SessionMetadata>(row.value));
  }
  public putMetadata(metadata: SessionMetadata): void {
    this.assertRole("root");
    const previous = this.metadata(metadata.sessionId);
    if (previous && previous.hostId !== metadata.hostId) throw new V7Error("SESSION_OWNER", "Session belongs to another Host");
    this.#db.prepare("INSERT INTO registry VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET value=excluded.value")
      .run(metadata.sessionId, metadata.hostId, canonicalJson(metadata));
  }
  private assertRole(role: "host" | "root"): void {
    if (this.role !== role) throw new V7Error("STORE_ROLE", "Store operation belongs to another role");
  }
  public close(): void { if (!this.#closed) { this.#closed = true; this.#db.close(); } }
}
