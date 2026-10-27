import { parentPort, workerData } from "node:worker_threads";
import { join } from "node:path";
import { HardenedSqliteDatabase, ensurePrivateDirectorySync } from "../../../../packages/storage-sqlite/src/index.js";
import { canonical } from "../../../v8-session/src/contracts/validation.js";
import { SessionError, scopeKey, type OpeningIdentity, type ParentStopProof, type OpeningCapsule, type OpeningRef, type OpeningStopProof, type ReaderCustody, type Receipt, type RunRef, type SessionScope, type SessionSnapshot } from "../../../v8-session/src/contracts/types.js";
import { openingCapsule, openingProof, sameOpening, parentIdentity, parentProof } from "../../../v8-session/src/native/opening.js";
import { validateRun } from "../../../v8-session/src/native/validation.js";
import type { RecordIdentity, SessionLimits } from "./journal.js";

const config = workerData as { directory: string; scope: SessionScope; limits: SessionLimits; identity: RecordIdentity };
let store: HardenedSqliteDatabase | undefined;
const get = (id: string): { hash: string; receipt: Receipt } | undefined => {
  const row = store!.database.prepare("SELECT hash,receipt FROM operations WHERE id=?").get(id);
  return row ? { hash: String(row.hash), receipt: JSON.parse(String(row.receipt)) as Receipt } : undefined;
};
const transaction = (fn: () => void): void => { const db = store!.database; db.exec("BEGIN IMMEDIATE"); try { fn(); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; } };
const saved = (snapshot: SessionSnapshot): string => canonical({ ...snapshot, interactions: [], interactionsComplete: false, activity: snapshot.phase === "stopped" ? "idle" : "unknown" });
const putState = (snapshot: SessionSnapshot): void => {
  const row = store!.database.prepare("SELECT json FROM state WHERE singleton=1").get();
  const prior = row && JSON.parse(String(row.json)) as SessionSnapshot | undefined;
  if (prior?.archive && (!snapshot.archive || prior.archive.id !== snapshot.archive.id || snapshot.phase !== "stopped" || snapshot.generation !== prior.generation || prior.archive.state === "complete" && snapshot.archive.state !== "complete")) throw new SessionError("FENCED");
  store!.database.prepare("UPDATE state SET json=? WHERE singleton=1").run(saved(snapshot));
};
const reader = (): ReaderCustody => JSON.parse(String(store!.database.prepare("SELECT reader FROM state WHERE singleton=1").get()!.reader)) as ReaderCustody;
const putReader = (value: ReaderCustody): void => { store!.database.prepare("UPDATE state SET reader=? WHERE singleton=1").run(canonical(value, 12288)); };
const readerOpening = (value: Extract<ReaderCustody, { state: "allocating" | "owned" }>): OpeningRef => value.state === "owned" ? value.capsule.opening : value.opening;
parentPort!.on("message", (message: { id: number; method: string; input: Record<string, unknown> }) => {
  try {
    const input = message.input; let result: unknown;
    if (message.method === "open") {
      ensurePrivateDirectorySync(config.directory);
      store = new HardenedSqliteDatabase({ filename: join(config.directory, "session.sqlite"), applicationId: 0x56385353, storeName: "V8 session", migrations: [{ version: 1, name: "v8-session-initial", apply(db) { db.exec("CREATE TABLE state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),scope TEXT NOT NULL,json TEXT NOT NULL); CREATE TABLE operations(id TEXT PRIMARY KEY,hash TEXT NOT NULL,payload TEXT NOT NULL,receipt TEXT NOT NULL,allocation INTEGER NOT NULL);"); } }, { version: 2, name: "v8-opening-custody", apply(db) { db.exec("ALTER TABLE state ADD COLUMN opening TEXT"); } }, { version: 3, name: "v8-lifecycle-plugin-identity", apply(db) { db.exec("CREATE TABLE plugin_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),json TEXT NOT NULL)"); } }, { version: 4, name: "v8-reader-custody", apply(db) { db.exec("ALTER TABLE state ADD COLUMN reader TEXT"); } }, { version: 5, name: "v8-parent-custody", apply(db) { db.exec("ALTER TABLE state ADD COLUMN parent TEXT"); } }, { version: 6, name: "v8-permanent-terminal-receipts", apply(db) { db.exec("UPDATE operations SET payload='null',allocation=0 WHERE json_extract(receipt,'$.state') IN ('acknowledged','refused'); CREATE INDEX operations_active_allocation ON operations(allocation) WHERE allocation>0"); } }] });
      const db = store.database;
      db.exec(`PRAGMA max_page_count=${Math.max(32, Math.floor(config.limits.maxJournalBytes / 4096))}`);
      const existing = db.prepare("SELECT scope,json FROM state WHERE singleton=1").get();
      if (existing && existing.scope !== scopeKey(config.scope)) throw new SessionError("FENCED");
      const expectedIdentity = canonical(config.identity, 8192);
      for (const value of Object.values(config.identity)) if (!value || typeof value.id !== "string" || !value.id || value.id.length > 128 || !Number.isSafeInteger(value.recordVersion) || value.recordVersion < 1) throw new SessionError("INVALID");
      const pluginIdentity = db.prepare("SELECT json FROM plugin_identity WHERE singleton=1").get();
      if (pluginIdentity ? pluginIdentity.json !== expectedIdentity : existing) throw new SessionError("FENCED");
      if (!pluginIdentity) db.prepare("INSERT INTO plugin_identity(singleton,json) VALUES(1,?)").run(expectedIdentity);
      const initial = input.initial as SessionSnapshot, prior = existing ? JSON.parse(String(existing.json)) as SessionSnapshot : initial;
      if (prior.kind !== initial.kind || prior.placement !== initial.placement) throw new SessionError("FENCED");
      if (!Number.isSafeInteger(prior.epoch) || prior.epoch < 0 || prior.epoch >= Number.MAX_SAFE_INTEGER) throw new SessionError("INVALID");
      const next = { ...prior, capabilities: initial.capabilities, epoch: prior.epoch + 1, revision: 0 };
      transaction(() => {
        if (!existing) db.prepare("INSERT INTO state(singleton,scope,json) VALUES(1,?,?)").run(scopeKey(config.scope), saved(next));
        else putState(next);
        if (db.prepare("SELECT reader FROM state WHERE singleton=1").get()!.reader === null) putReader({ state: existing && prior.nativeSession !== null ? "unconfirmed" : "none" });
        for (const row of db.prepare("SELECT id,receipt FROM operations WHERE allocation>0").all()) {
          const receipt = JSON.parse(String(row.receipt)) as Receipt;
          if (receipt.state === "admitted" || receipt.state === "dispatched") {
            const next = { ...receipt, state: receipt.state === "admitted" ? "refused" : "outcomeUnknown", reason: "processRestart" };
            db.prepare("UPDATE operations SET receipt=? WHERE id=?").run(canonical(next), String(row.id));
            if (next.state === "refused") db.prepare("UPDATE operations SET payload='null',allocation=0 WHERE id=?").run(String(row.id));
          }
        }
      });
      result = JSON.parse(String(db.prepare("SELECT json FROM state WHERE singleton=1").get()!.json));
    } else if (!store) throw new SessionError("CLOSED");
    else if (message.method === "admit") {
      const receipt = input.receipt as Receipt, hash = String(input.hash), prior = get(receipt.id);
      if (prior) { if (prior.hash !== hash) throw new SessionError("CONFLICT"); result = { fresh: false, receipt: prior.receipt }; }
      else {
        const payload = canonical(input.payload), allocation = Buffer.byteLength(payload) + 12288 + 2048;
        const usage = store.database.prepare("SELECT COUNT(*) count,COALESCE(SUM(allocation),0) bytes FROM operations WHERE allocation>0").get()!;
        const stopping = receipt.type === "stop", reserve = stopping ? 0 : 20480;
        // Reserve future receipt/state growth as well as pages already in use.
        // Ordinary originals cannot spend the last Stop's configured DB headroom.
        // Actual filesystem failure remains an IO error, never a false receipt.
        const db = store.database;
        const pageSize = Number(db.prepare("PRAGMA page_size").get()!.page_size);
        const usedPages = Number(db.prepare("PRAGMA page_count").get()!.page_count) - Number(db.prepare("PRAGMA freelist_count").get()!.freelist_count);
        const diskReservation = usedPages * pageSize + Number(usage.bytes) + allocation + (stopping ? 0 : 64 * 1024);
        if (Number(usage.count) >= config.limits.maxOperations - (stopping ? 0 : 1) || Number(usage.bytes) + allocation + 16384 + reserve > config.limits.maxMetadataBytes || diskReservation > config.limits.maxJournalBytes) throw new SessionError("FULL");
        store.database.prepare("INSERT INTO operations VALUES(?,?,?,?,?)").run(receipt.id, hash, payload, canonical(receipt), allocation);
        result = { fresh: true, receipt };
      }
    } else if (message.method === "receipt") result = get(String(input.id))?.receipt ?? null;
    else if (message.method === "parent.read") {
      const value = store.database.prepare("SELECT parent FROM state WHERE singleton=1").get()!.parent;
      result = value === null ? null : parentIdentity(JSON.parse(String(value)) as OpeningIdentity);
    } else if (message.method === "parent.save") {
      const identity = parentIdentity(input.identity as OpeningIdentity), encoded = canonical(identity, 4096);
      const prior = store.database.prepare("SELECT parent FROM state WHERE singleton=1").get()!.parent;
      if (prior !== null && prior !== encoded) throw new SessionError("FENCED");
      store.database.prepare("UPDATE state SET parent=? WHERE singleton=1").run(encoded);
    } else if (message.method === "parent.retired") {
      const prior = store.database.prepare("SELECT parent FROM state WHERE singleton=1").get()!.parent;
      if (prior === null) throw new SessionError("FENCED");
      parentProof(parentIdentity(JSON.parse(String(prior)) as OpeningIdentity), input.proof as ParentStopProof);
      transaction(() => { putReader({ state: "none" }); store!.database.prepare("UPDATE state SET parent=NULL WHERE singleton=1").run(); });
    }
    else if (message.method === "reader.read") result = reader();
    else if (message.method === "reader.begin") {
      const run = validateRun(input.run as RunRef), opening = input.opening as OpeningRef;
      const snapshot = JSON.parse(String(store.database.prepare("SELECT json FROM state WHERE singleton=1").get()!.json)) as SessionSnapshot;
      const archive = snapshot.archive && get(snapshot.archive.id)?.receipt;
      const archived = snapshot.archive?.state === "complete" && archive?.type === "archive" && archive.state === "acknowledged" && archive.id === snapshot.archive.id && archive.generation === run.generation && scopeKey(archive.scope) === scopeKey(run.scope);
      if (scopeKey(run.scope) !== scopeKey(config.scope) || canonical(opening.scope) !== canonical(run.scope) || opening.generation !== run.generation || typeof opening.operationId !== "string" || !opening.operationId || opening.operationId.length > 256 || snapshot.archive && !archived || snapshot.phase !== "stopped" || snapshot.nativeSession !== run.nativeSession || snapshot.generation !== run.generation || reader().state !== "none") throw new SessionError("FENCED");
      putReader({ state: "allocating", run, opening });
    } else if (message.method === "reader.owned") {
      const run = validateRun(input.run as RunRef), capsule = openingCapsule(input.capsule as OpeningCapsule), held = reader();
      if (held.state !== "allocating" || canonical(held.run) !== canonical(run) || canonical(held.opening) !== canonical(capsule.opening)) throw new SessionError("FENCED");
      putReader({ state: "owned", run, capsule });
    } else if (message.method === "reader.released") {
      const held = reader(), proof = input.proof as OpeningStopProof;
      if (held.state !== "allocating" && held.state !== "owned") throw new SessionError("FENCED");
      const capsule = openingCapsule({ opening: proof.opening, identity: proof.identity });
      if (canonical(readerOpening(held)) !== canonical(capsule.opening) || held.state === "owned" && !sameOpening(held.capsule, capsule)) throw new SessionError("FENCED");
      openingProof(capsule, proof); putReader({ state: "none" });
    }
    else if (message.method === "opening.read") {
      const row = store.database.prepare("SELECT opening FROM state WHERE singleton=1").get()!;
      result = row.opening === null ? null : openingCapsule(JSON.parse(String(row.opening)) as OpeningCapsule);
    } else if (message.method === "opening.save") {
      const capsule = openingCapsule(input.capsule as OpeningCapsule), state = JSON.parse(String(store.database.prepare("SELECT json FROM state WHERE singleton=1").get()!.json)) as SessionSnapshot;
      const original = get(capsule.opening.operationId)?.receipt;
      if (scopeKey(capsule.opening.scope) !== scopeKey(config.scope) || capsule.opening.generation !== state.generation || capsule.identity.placement !== state.placement || !["starting", "stopping"].includes(state.phase) || !original || !["create", "resume"].includes(original.type) || original.generation + 1 !== state.generation || !["dispatched", "outcomeUnknown"].includes(original.state)) throw new SessionError("FENCED");
      const row = store.database.prepare("SELECT opening FROM state WHERE singleton=1").get()!;
      if (row.opening !== null) {
        const prior = openingCapsule(JSON.parse(String(row.opening)) as OpeningCapsule);
        if (prior.opening.generation > capsule.opening.generation || prior.opening.generation === capsule.opening.generation && canonical(prior) !== canonical(capsule)) throw new SessionError("FENCED");
      }
      store.database.prepare("UPDATE state SET opening=? WHERE singleton=1").run(canonical(capsule, 8192));
    }
    else if (message.method === "state") { transaction(() => putState(input.snapshot as SessionSnapshot)); }
    else if (message.method === "transition") {
      const receipt = input.receipt as Receipt; canonical(receipt, 12288);
      const prior = get(receipt.id); if (!prior) throw new SessionError("CONFLICT");
      if (["acknowledged", "refused"].includes(prior.receipt.state)) result = prior.receipt;
      else {
        transaction(() => { store!.database.prepare("UPDATE operations SET receipt=? WHERE id=?").run(canonical(receipt, 12288), receipt.id);
          if (receipt.state === "acknowledged" || receipt.state === "refused") store!.database.prepare("UPDATE operations SET payload='null',allocation=0 WHERE id=?").run(receipt.id);
          if (input.snapshot) putState(input.snapshot as SessionSnapshot); }); result = receipt;
      }
    } else if (message.method === "close") { store.close(); store = undefined; }
    else throw new SessionError("INVALID");
    parentPort!.postMessage({ id: message.id, result });
  } catch (error) { parentPort!.postMessage({ id: message.id, error: { code: error instanceof SessionError ? error.code : "IO" } }); }
});
