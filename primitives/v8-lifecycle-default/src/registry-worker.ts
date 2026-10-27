import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { HardenedSqliteDatabase, ensurePrivateDirectorySync } from "../../../packages/storage-sqlite/src/index.js";
import { canonical } from "../../v8-session/src/contracts/validation.js";
import { SessionError, scopeKey } from "../../v8-session/src/contracts/types.js";
import type { PluginIdentity } from "../../v8-plugins/src/contracts.js";
import { readJournalOriginal, readJournalFacts, readJournalArchivedHistory } from "./session/receipt-reader.js";
import type { RecordIdentity } from "./session/journal.js";
import type { CreationRecord } from "./registry.js";
const config = workerData as { directory: string; identity: Record<string, PluginIdentity>; maxSessions: number; custody: { host: string; owner: string } };
let store: HardenedSqliteDatabase | undefined;
parentPort!.on("message", (message: { id: number; method: string; input: Record<string, unknown> }) => {
  try {
    const { input, method } = message; let result: unknown = null;
    if (method === "open") {
      ensurePrivateDirectorySync(config.directory);
      store = new HardenedSqliteDatabase({ filename: join(config.directory, "lifecycle.sqlite"), applicationId: 0x56384c43, storeName: "V8 lifecycle creation", migrations: [{ version: 1, name: "v8-plugin-creation", apply(db) { db.exec("CREATE TABLE identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),json TEXT NOT NULL); CREATE TABLE creations(scope TEXT PRIMARY KEY,namespace TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,json TEXT NOT NULL,UNIQUE(namespace,id))"); } }] });
      const db = store.database;
      db.exec("PRAGMA max_page_count=2048");
      // Deployment revisions may change after quiescence; durable formats may not.
      const identity = canonical({ plugins: Object.fromEntries(Object.entries(config.identity).map(([key, value]) => [key, { id: value.id, recordVersion: value.recordVersion }])), custody: config.custody });
      const prior = db.prepare("SELECT json FROM identity WHERE singleton=1").get();
      if (prior && prior.json !== identity) throw new SessionError("FENCED");
      if (!prior) db.prepare("INSERT INTO identity VALUES(1,?)").run(identity);
    } else if (!store) throw new SessionError("CLOSED");
    else if (method === "list") result = store.database.prepare("SELECT json FROM creations ORDER BY scope").all().map(row => JSON.parse(String(row.json)));
    else if (method === "get") { const row = store.database.prepare("SELECT json FROM creations WHERE scope=?").get(String(input.key)); result = row ? JSON.parse(String(row.json)) : null; }
    else if (method === "native.original" || method === "native.archive" || method === "native.facts" || method === "native.archiveContext") {
      const key = String(input.key), row = store.database.prepare("SELECT json FROM creations WHERE scope=?").get(key);
      if (!row) throw new SessionError("FENCED");
      const record = JSON.parse(String(row.json)) as CreationRecord;
      const filename = join(config.directory, "sessions", createHash("sha256").update(key).digest("hex"), "session", "session.sqlite");
      const identity = Object.fromEntries(Object.entries(config.identity).map(([key, value]) => [key, { id: value.id, recordVersion: value.recordVersion }])) as RecordIdentity;
      if (method === "native.archive" && (!Number.isSafeInteger(input.generation) || Number(input.generation) < 0)) throw new SessionError("INVALID");
      if (method === "native.archiveContext") result = readJournalArchivedHistory(filename, record.scope, identity);
      else if (method === "native.facts") result = readJournalFacts(filename, record.scope, identity);
      else {
        const receipt = readJournalOriginal(filename, record.scope, String(input.id), identity, method === "native.archive" ? Number(input.generation) : undefined);
        result = method === "native.archive" ? receipt !== null : receipt;
      }
    }
    else if (method === "admit") {
      const record = input.record as CreationRecord, key = scopeKey(record.scope), namespace = canonical([record.scope.connection, record.scope.principal, record.scope.host]), hash = canonical({ scope: record.scope, id: record.id, input: record.input, selection: record.selection ?? null }, 32768);
      const row = store.database.prepare("SELECT hash,json FROM creations WHERE scope=? OR (namespace=? AND id=?)").get(key, namespace, record.id);
      if (row) { if (row.hash !== hash) throw new SessionError("CONFLICT"); result = { fresh: false, record: JSON.parse(String(row.json)) }; }
      else {
        // Only the lifecycle's saved successful Archive releases a slot. Keep
        // every original/record; pending or uncertain cleanup still occupies it.
        const occupied = store.database.prepare("SELECT COUNT(*) count FROM creations WHERE json_extract(json, '$.archive.type') IS NOT 'archive' OR json_extract(json, '$.archive.state') IS NOT 'acknowledged'").get()!.count;
        if (Number(occupied) >= config.maxSessions) throw new SessionError("FULL");
        store.database.prepare("INSERT INTO creations VALUES(?,?,?,?,?)").run(key, namespace, record.id, hash, canonical(record, 32768)); result = { fresh: true, record };
      }
    } else if (method === "put") {
      const record = input.record as CreationRecord, key = scopeKey(record.scope);
      const prior = store.database.prepare("SELECT id FROM creations WHERE scope=?").get(key);
      if (!prior || prior.id !== record.id) throw new SessionError("FENCED");
      store.database.prepare("UPDATE creations SET json=? WHERE scope=?").run(canonical(record, 32768), key);
    } else if (method === "close") { store.close(); store = undefined; }
    else throw new SessionError("INVALID");
    parentPort!.postMessage({ id: message.id, result });
  } catch (error) { parentPort!.postMessage({ id: message.id, error: error instanceof SessionError ? error.code : "IO" }); }
});
