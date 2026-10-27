import { parentPort, workerData } from "node:worker_threads";
import { join } from "node:path";
import { HardenedSqliteDatabase, ensurePrivateDirectorySync } from "../../../../packages/storage-sqlite/src/index.js";
import { canonical } from "../contracts/validation.js";
import { catalogKey, CatalogError, type ArchivePublication, type CatalogEntry, type CatalogScope, type CreateRequest, type Creation, type CreationState, type NativeBinding, type MetadataRequest, type MetadataOriginal } from "../contracts/types.js";
const config = workerData as { directory: string; scope: CatalogScope; maxSessions: number; maxOperations: number };
let store: HardenedSqliteDatabase | undefined;
const entry = (session: string): CatalogEntry | null => { const r = store!.database.prepare("SELECT json FROM entries WHERE session=?").get(session); return r ? JSON.parse(String(r.json)) as CatalogEntry : null; };
const creation = (id: string): Creation | null => { const r = store!.database.prepare("SELECT original,state FROM creates WHERE id=?").get(id); if (!r) return null; const original = JSON.parse(String(r.original)) as CreateRequest, e = entry(original.session)!; return { original, entry: e, state: String(r.state) as CreationState, native: e.binding ? { ...e.binding } : null, publication: "committed" }; };
const tx = <T>(fn: () => T): T => { const db = store!.database; db.exec("BEGIN IMMEDIATE"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (e) { db.exec("ROLLBACK"); throw e; } };
const put = (e: CatalogEntry): void => { store!.database.prepare("UPDATE entries SET json=? WHERE session=?").run(canonical(e), e.session); };
const capacity = (): void => { const db = store!.database, count = Number(db.prepare("SELECT (SELECT COUNT(*) FROM creates)+(SELECT COUNT(*) FROM renames) count").get()!.count); if (count >= config.maxOperations) throw new CatalogError("FULL"); };
parentPort!.on("message", (m: { id: number; method: string; input: Record<string, unknown> }) => {
  try {
    const i = m.input; let result: unknown;
    if (m.method === "open") {
      ensurePrivateDirectorySync(config.directory);
      store = new HardenedSqliteDatabase({ filename: join(config.directory, "catalog.sqlite"), applicationId: 0x56384341, storeName: "V8 catalog", migrations: [{ version: 1, name: "catalog-initial", apply(db) { db.exec("CREATE TABLE owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1),scope TEXT NOT NULL); CREATE TABLE entries(session TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE creates(id TEXT PRIMARY KEY,original TEXT NOT NULL,state TEXT NOT NULL); CREATE TABLE renames(id TEXT PRIMARY KEY,original TEXT NOT NULL,result TEXT NOT NULL);"); } }] });
      const db = store.database; db.exec("PRAGMA max_page_count=4096");
      const prior = db.prepare("SELECT scope FROM owner WHERE singleton=1").get(); if (prior && prior.scope !== catalogKey(config.scope)) throw new CatalogError("FENCED");
      tx(() => { if (!prior) db.prepare("INSERT INTO owner VALUES(1,?)").run(catalogKey(config.scope)); db.prepare("UPDATE creates SET state='refused' WHERE state='reserved'").run(); db.prepare("UPDATE creates SET state='outcomeUnknown' WHERE state='dispatching'").run(); }); result = null;
    } else if (!store) throw new CatalogError("CLOSED");
    else if (m.method === "reserve") {
      const original = i.original as CreateRequest, prior = creation(original.id);
      if (prior) { if (canonical(prior.original) !== canonical(original)) throw new CatalogError("CONFLICT"); result = { fresh: false, value: prior }; }
      else result = tx(() => {
        capacity(); if (entry(original.session) || store!.database.prepare("SELECT id FROM renames WHERE id=?").get(original.id)) throw new CatalogError("CONFLICT");
        if (Number(store!.database.prepare("SELECT COUNT(*) count FROM entries").get()!.count) >= config.maxSessions) throw new CatalogError("FULL");
        const e: CatalogEntry = { scope: config.scope, session: original.session, target: original.target, createId: original.id, version: 1, revision: 1, metadata: original.metadata, binding: null };
        store!.database.prepare("INSERT INTO entries VALUES(?,?)").run(e.session, canonical(e)); store!.database.prepare("INSERT INTO creates VALUES(?,?,?)").run(original.id, canonical(original), "reserved"); return { fresh: true, value: creation(original.id)! };
      });
    } else if (m.method === "transition") result = tx(() => {
      const c = creation(String(i.id)); if (!c) throw new CatalogError("CONFLICT");
      const next = i.state as CreationState;
      if (c.state === "nativeCreated" || c.state === "refused") return c;
      if (next === "dispatching" && c.state !== "reserved") return c;
      if (next === "nativeCreated") {
        const b = i.binding as NativeBinding, conflict = store!.database.prepare("SELECT session,json FROM entries WHERE session<>?").all(c.entry.session).find(row => { const e = JSON.parse(String(row.json)) as CatalogEntry; return e.target.host === c.entry.target.host && e.target.owner === c.entry.target.owner && e.binding?.nativeSession === b.nativeSession; });
        if (conflict || c.entry.binding && canonical(c.entry.binding) !== canonical(b)) throw new CatalogError("CONFLICT");
        put({ ...c.entry, version: c.entry.version + 1, binding: b });
      }
      store!.database.prepare("UPDATE creates SET state=? WHERE id=?").run(next, c.original.id); return creation(c.original.id)!;
    });
    else if (m.method === "creation") result = creation(String(i.id));
    else if (m.method === "get") result = entry(String(i.session));
    else if (m.method === "list") result = store.database.prepare("SELECT json FROM entries ORDER BY session").all().map(r => JSON.parse(String(r.json)) as CatalogEntry);
    else if (m.method === "metadata.original") {
      const row = store.database.prepare("SELECT original,result FROM renames WHERE id=?").get(String(i.id));
      result = row ? { request: JSON.parse(String(row.original)), entry: JSON.parse(String(row.result)) } satisfies MetadataOriginal : null;
    }
    else if (m.method === "metadata") result = tx(() => {
      // Historical table name, unchanged original/result format and IDs. Both
      // closed metadata intents use this single existing CAS/commit owner.
      const r = i.request as MetadataRequest, prior = store!.database.prepare("SELECT original,result FROM renames WHERE id=?").get(r.id);
      if (prior) { if (String(prior.original) !== canonical(r)) throw new CatalogError("CONFLICT"); return JSON.parse(String(prior.result)) as CatalogEntry; }
      capacity(); if (store!.database.prepare("SELECT id FROM creates WHERE id=?").get(r.id)) throw new CatalogError("CONFLICT"); const e = entry(r.session); if (!e || e.revision !== r.revision) throw new CatalogError("CONFLICT");
      const next = { ...e, revision: e.revision + 1, version: e.version + 1, metadata: { ...e.metadata, ...("watched" in r ? { watched: r.watched } : { name: r.name }) } }; put(next); store!.database.prepare("INSERT INTO renames VALUES(?,?,?)").run(r.id, canonical(r), canonical(next)); return next;
    });
    else if (m.method === "archive") result = tx(() => {
      const r = i.request as ArchivePublication, e = entry(r.session);
      if (!e || e.createId !== i.createId || canonical(e.target) !== canonical(i.target)) throw new CatalogError("FENCED");
      if (e.archive) { if (e.archive.id !== r.id || e.archive.generation !== r.generation) throw new CatalogError("CONFLICT"); return e; }
      const next = { ...e, version: e.version + 1, archive: { id: r.id, generation: r.generation } }; put(next); return next;
    });
    else if (m.method === "close") { store.close(); store = undefined; result = null; }
    else throw new CatalogError("INVALID");
    parentPort!.postMessage({ id: m.id, result });
  } catch (e) { parentPort!.postMessage({ id: m.id, error: e instanceof CatalogError ? e.code : "IO" }); }
});
