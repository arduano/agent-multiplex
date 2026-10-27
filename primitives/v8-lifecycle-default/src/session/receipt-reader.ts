import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { assertPrivateFileSync } from "../../../../packages/storage-sqlite/src/index.js";
import { SessionError, scopeKey, type CopilotUsage, type SessionAttention, type Receipt, type SessionScope, type SessionSnapshot } from "../../../v8-session/src/contracts/types.js";
import { canonical, id } from "../../../v8-session/src/contracts/validation.js";
import { observedCopilotUsage } from "../../../v8-session/src/contracts/usage.js";
import { observedAttention } from "../../../v8-session/src/contracts/attention.js";
import type { RecordIdentity } from "./journal.js";

/** Passive access to this journal's original receipts. It neither acquires a
 * writer nor changes the observation epoch, inspects native custody or launches
 * a controller. The caller uses its existing bounded SQLite worker. */
function readOwnedJournal<T>(filename: string, scope: SessionScope, identity: RecordIdentity, read: (reader: DatabaseSync) => T): T | null {
  if (!existsSync(filename)) return null;
  assertPrivateFileSync(filename);
  const reader = new DatabaseSync(filename, { readOnly: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
  try {
    if (Number(reader.prepare("PRAGMA application_id").get()!.application_id) !== 0x56385353 || ![3, 4, 5, 6].includes(Number(reader.prepare("PRAGMA user_version").get()!.user_version))) throw new SessionError("FENCED");
    const savedScope = reader.prepare("SELECT scope FROM state WHERE singleton=1").get();
    const savedIdentity = reader.prepare("SELECT json FROM plugin_identity WHERE singleton=1").get();
    if (savedScope?.scope !== scopeKey(scope) || savedIdentity?.json !== canonical(identity)) throw new SessionError("FENCED");
    return read(reader);
  } finally { reader.close(); }
}

export function readJournalOriginal(filename: string, scope: SessionScope, original: string, identity: RecordIdentity, archiveGeneration?: number): Receipt | null {
  return readOwnedJournal(filename, scope, identity, reader => {
    const row = reader.prepare("SELECT operations.receipt,state.json FROM operations CROSS JOIN state WHERE operations.id=? AND state.singleton=1").get(original);
    if (!row) return null;
    const receipt = JSON.parse(String(row.receipt)) as Receipt; canonical(receipt, 12288);
    if (receipt.id !== original || scopeKey(receipt.scope) !== scopeKey(scope)) throw new SessionError("FENCED");
    if (archiveGeneration !== undefined) {
      const snapshot = JSON.parse(String(row.json)) as SessionSnapshot;
      if (receipt.type !== "archive" || receipt.state !== "acknowledged" || receipt.generation !== archiveGeneration || snapshot.generation !== archiveGeneration || snapshot.phase !== "stopped" || snapshot.archive?.id !== original || snapshot.archive.state !== "complete") return null;
    }
    return receipt;
  });
}

export type ArchivedHistoryContext = Readonly<{ nativeSession: string; generation: number; archiveId: string }>;
/** A cold reader's launch context comes only from the native journal's joined
 * positive Archive proof. A released workspace or registry flag is not proof. */
export function readJournalArchivedHistory(filename: string, scope: SessionScope, identity: RecordIdentity): ArchivedHistoryContext | null {
  return readOwnedJournal(filename, scope, identity, reader => {
    const state = reader.prepare("SELECT json FROM state WHERE singleton=1").get(); if (!state) return null;
    const snapshot = JSON.parse(String(state.json)) as SessionSnapshot;
    if (scopeKey(snapshot.scope) !== scopeKey(scope)) throw new SessionError("FENCED");
    if (snapshot.archive?.state !== "complete" || snapshot.phase !== "stopped" || !snapshot.nativeSession || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1) return null;
    id(snapshot.nativeSession); id(snapshot.archive.id);
    const row = reader.prepare("SELECT receipt FROM operations WHERE id=?").get(snapshot.archive.id); if (!row) return null;
    const receipt = JSON.parse(String(row.receipt)) as Receipt; canonical(receipt, 12288);
    if (receipt.type !== "archive" || receipt.state !== "acknowledged" || receipt.id !== snapshot.archive.id || receipt.generation !== snapshot.generation || scopeKey(receipt.scope) !== scopeKey(scope)) return null;
    return { nativeSession: snapshot.nativeSession, generation: snapshot.generation, archiveId: snapshot.archive.id };
  });
}

export type SavedSessionFacts = Readonly<{ usage?: CopilotUsage; attention?: SessionAttention }>;
/** Last saved small observations only. One passive read, no writer/epoch,
 * adapter, native history or separate accounting/attention store. */
export function readJournalFacts(filename: string, scope: SessionScope, identity: RecordIdentity): SavedSessionFacts | null {
  return readOwnedJournal(filename, scope, identity, reader => {
    const row = reader.prepare("SELECT json FROM state WHERE singleton=1").get();
    if (!row) return null;
    const snapshot = JSON.parse(String(row.json)) as SessionSnapshot;
    if (scopeKey(snapshot.scope) !== scopeKey(scope)) throw new SessionError("FENCED");
    let usage: CopilotUsage | undefined;
    if (snapshot.usage !== undefined) {
      if (snapshot.kind !== "copilot" || snapshot.nativeSession === null) throw new SessionError("FENCED");
      usage = observedCopilotUsage(snapshot.usage, snapshot.nativeSession);
    }
    const attention = snapshot.attention === undefined ? undefined : observedAttention(snapshot.attention, snapshot);
    return { ...(usage ? { usage } : {}), ...(attention ? { attention } : {}) };
  });
}
