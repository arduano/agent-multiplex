import { FileError, assertId, assertScope, scopeKey, type ArtifactRef, type FileManifest, type FileScope } from "../contracts/types.js";
import { snapshotScope } from "./snapshot.js";

export type DraftRecord = Readonly<{
  key: string; scope: FileScope; manifest: FileManifest; blob: Blob; revision: number;
  phase: "draft" | "uploading" | "uncertain" | "committed" | "expired" | "aborted";
  operationIds: readonly string[]; artifact?: ArtifactRef; conflictOf?: string;
}>;
/** Logical browser namespace; deliberately independent of a native file scope. */
export type ComposerScope = FileScope & Readonly<{ authority: string }>;
export type ComposerValue = Readonly<{ text: string; fileIds: readonly string[] }>;
/** Inert draft submission lookup only. edit binds a captured local intent, not
 * a native resubmission capability. Old Send references omit it. */
export type ComposerOriginal = Readonly<{ scope: FileScope; owner: string; id: string; type: "send" | "codex.steer" | "copilot.steer" | "codex.queue.add"; generation: number; edit?: number }>;
export type OriginalProtection = Readonly<{ reference: ComposerOriginal; files: Readonly<{ scope: FileScope; ids: readonly string[] }> | null }>;
export type ComposerRecord = Readonly<{ key: string; scope: ComposerScope; value: ComposerValue; revision: number; edit: number; originals: readonly OriginalProtection[] }>;
export const composerKey = (scope: ComposerScope): string => JSON.stringify([scope.connection, scope.principal, scope.authority, scope.host, scope.session]);
export function composerValue(value: ComposerValue): ComposerValue {
  if (!value || typeof value.text !== "string" || value.text.length > 65_536 || !Array.isArray(value.fileIds) || value.fileIds.length > 8 || new Set(value.fileIds).size !== value.fileIds.length) throw new FileError("INVALID", "Invalid composer draft");
  for (const id of value.fileIds) assertId(id);
  return Object.freeze({ text: value.text, fileIds: Object.freeze([...value.fileIds]) });
}
export function composerScope(scope: ComposerScope): ComposerScope {
  const fixed = snapshotScope(scope);
  if (typeof scope.authority !== "string" || !scope.authority || scope.authority.length > 256) throw new FileError("FENCED");
  return Object.freeze({ ...fixed, authority: scope.authority });
}
export function composerOriginal(value: ComposerOriginal): ComposerOriginal {
  const scope = snapshotScope(value.scope); assertId(value.id);
  if (!["send", "codex.steer", "copilot.steer", "codex.queue.add"].includes(value.type) || !Number.isSafeInteger(value.generation) || value.generation < 1 || typeof value.owner !== "string" || !value.owner || value.owner.length > 4096 || value.edit !== undefined && (!Number.isSafeInteger(value.edit) || value.edit < 0)) throw new FileError("INVALID");
  return Object.freeze({ scope, owner: value.owner, id: value.id, type: value.type, generation: value.generation, ...(value.edit === undefined ? {} : { edit: value.edit }) });
}
const originalKey = (value: ComposerOriginal): string => JSON.stringify([scopeKey(value.scope), value.owner, value.id, value.type, value.generation, value.edit ?? null]);
function copyComposer(record: ComposerRecord): ComposerRecord {
  const scope = composerScope(record.scope);
  if (record.key !== composerKey(scope) || !Number.isSafeInteger(record.revision) || record.revision < 0 || !Number.isSafeInteger(record.edit) || record.edit < 0 || !Array.isArray(record.originals) || record.originals.length > 128) throw new FileError("INVALID");
  return Object.freeze({ key: record.key, scope, value: composerValue(record.value), revision: record.revision, edit: record.edit, originals: Object.freeze(record.originals.map(held => {
    const reference = composerOriginal(held.reference);
    if (scopeKey(reference.scope) !== scopeKey(scope)) throw new FileError("FENCED");
    if (!held.files) return Object.freeze({ reference, files: null });
    const fileScope = snapshotScope(held.files.scope), ids = composerValue({ text: "", fileIds: held.files.ids }).fileIds;
    if (fileScope.connection !== scope.connection || fileScope.principal !== scope.principal || fileScope.host !== scope.host) throw new FileError("FENCED");
    return Object.freeze({ reference, files: Object.freeze({ scope: fileScope, ids }) });
  })) });
}
export interface DraftPersistence {
  list(scope: FileScope): Promise<readonly DraftRecord[]>;
  get(scope: FileScope, id: string): Promise<DraftRecord | undefined>;
  put(record: DraftRecord, expectedRevision: number): Promise<DraftRecord>;
  /** Exact local deletion only; never backend abandon, GC or native release. */
  remove?(scope: FileScope, id: string, expectedRevision: number): Promise<void>;
  getComposer?(scope: ComposerScope): Promise<ComposerRecord | undefined>;
  putComposer?(record: ComposerRecord, expectedRevision: number): Promise<ComposerRecord>;
  /** One transaction updates the existing composer and selected Blob records. */
  original?(scope: ComposerScope, expectedRevision: number, reference: ComposerOriginal, change: "protect" | "settle" | "forget", files?: Readonly<{ scope: FileScope; ids: readonly string[] }>): Promise<ComposerRecord>;
  close(): void;
}
export const draftKey = (scope: FileScope, id: string): string => `${scopeKey(scope)}:${id}`;
const copy = (record: DraftRecord): DraftRecord => Object.freeze({ ...record, scope: Object.freeze({ ...record.scope }), manifest: Object.freeze({ ...record.manifest }), operationIds: Object.freeze([...record.operationIds]), ...(record.artifact ? { artifact: Object.freeze({ ...record.artifact, owner: Object.freeze({ ...record.artifact.owner }) }) } : {}) });
function prepare(records: readonly DraftRecord[], incoming: DraftRecord, expectedRevision: number, maxBytes: number, maxRecords: number): DraftRecord {
  const prior = records.find(record => record.key === incoming.key);
  let next: DraftRecord = { ...incoming, revision: expectedRevision + 1 };
  if ((prior?.revision ?? 0) !== expectedRevision) {
    const id = crypto.randomUUID();
    next = { ...incoming, key: draftKey(incoming.scope, id), manifest: { ...incoming.manifest, id }, revision: 1, phase: "draft", operationIds: [], conflictOf: incoming.manifest.id };
    delete (next as { artifact?: ArtifactRef }).artifact;
  }
  const remaining = records.filter(record => record.key !== next.key);
  if (remaining.length + 1 > maxRecords || remaining.reduce((total, record) => total + record.blob.size, next.blob.size) > maxBytes) throw new FileError("STORAGE_FULL", "Retained browser drafts are full");
  return copy(next);
}
function checkRevision(record: Readonly<{ revision: number }> | undefined, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0 || (record?.revision ?? 0) !== expected) throw new FileError("CONFLICT", "Another browser changed this draft; local edits are retained");
}
function removable(record: DraftRecord | undefined, expected: number): void {
  if (!record) throw new FileError("NOT_FOUND"); checkRevision(record, expected);
  if (record.operationIds.length) throw new FileError("BUSY", "An unresolved original still protects this local file");
}
function admitComposers(records: readonly ComposerRecord[], next: ComposerRecord, maximum: number): void {
  const values = [...records.filter(value => value.key !== next.key), next];
  if (values.length > maximum || values.reduce((bytes, value) => bytes + new TextEncoder().encode(JSON.stringify(value)).byteLength, 0) > 8 * 1024 * 1024) throw new FileError("STORAGE_FULL", "Retained composer metadata is full");
}
function originalChange(prior: ComposerRecord | undefined, records: readonly DraftRecord[], composers: readonly ComposerRecord[], expected: number, input: ComposerOriginal, change: "protect" | "settle" | "forget", files?: Readonly<{ scope: FileScope; ids: readonly string[] }>): Readonly<{ composer: ComposerRecord; records: readonly DraftRecord[] }> {
  if (!prior) throw new FileError("NOT_FOUND", "Flush the composer before recording an original");
  prior = copyComposer(prior); checkRevision(prior, expected); const reference = composerOriginal(input);
  if (scopeKey(prior.scope) !== scopeKey(reference.scope)) throw new FileError("FENCED");
  const same = prior.originals.find(value => value.reference.id === reference.id);
  if (same && originalKey(same.reference) !== originalKey(reference)) throw new FileError("CONFLICT");
  if (change !== "protect" && change !== "settle" && change !== "forget") throw new FileError("INVALID");
  if (change === "protect" && same) {
    const requested = files ? { scope: snapshotScope(files.scope), ids: composerValue({ text: "", fileIds: files.ids }).fileIds } : null;
    if (JSON.stringify(same.files) !== JSON.stringify(requested)) throw new FileError("CONFLICT");
    return { composer: prior, records: [] };
  }
  if (change !== "protect" && !same) return { composer: prior, records: [] };
  if (change === "protect" && prior.originals.length >= 128) throw new FileError("STORAGE_FULL");
  const held = change !== "protect" ? same!.files : files ? { scope: snapshotScope(files.scope), ids: composerValue({ text: "", fileIds: files.ids }).fileIds } : null;
  if (held && (held.scope.connection !== prior.scope.connection || held.scope.principal !== prior.scope.principal || held.scope.host !== prior.scope.host)) throw new FileError("FENCED");
  const changed: DraftRecord[] = [];
  for (const id of held?.ids ?? []) {
    const record = records.find(value => value.key === draftKey(held!.scope, id));
    if (!record) throw new FileError("NOT_FOUND");
    if (change === "protect" && (record.phase !== "committed" || !record.artifact)) throw new FileError("CONFLICT", "Upload and verify files before minting an original");
    if (change === "protect" && record.operationIds.length >= 128 && !record.operationIds.includes(reference.id)) throw new FileError("STORAGE_FULL");
    const linked = composers.flatMap(composer => composer.originals.map(original => ({ key: composer.key, original }))).filter(value => value.original.reference.id === reference.id && value.original.files && scopeKey(value.original.files.scope) === scopeKey(record.scope) && value.original.files.ids.includes(id));
    if (change === "protect" && record.operationIds.includes(reference.id) && linked.length === 0) throw new FileError("CONFLICT", "An older unidentified original already protects this file");
    const protectedElsewhere = linked.some(value => value.key !== prior!.key);
    const operationIds = change === "protect" ? [...new Set([...record.operationIds, reference.id])] : record.operationIds.filter(value => value !== reference.id || protectedElsewhere);
    changed.push(copy({ ...record, operationIds, revision: record.revision + 1 }));
  }
  const originals = change === "protect" ? [...prior.originals, { reference, files: held }] : prior.originals.filter(value => value.reference.id !== reference.id);
  // A terminal receipt after a crash may precede the local consume write.
  // Clear only that exact captured edit, in this same existing transaction.
  const consume = change === "settle" && reference.edit !== undefined && reference.edit === prior.edit;
  return { composer: copyComposer({ ...prior, originals, ...(consume ? { value: { text: "", fileIds: [] }, edit: prior.edit + 1 } : {}), revision: prior.revision + 1 }), records: changed };
}

export class MemoryDraftPersistence implements DraftPersistence {
  readonly #records = new Map<string, DraftRecord>();
  readonly #composers = new Map<string, ComposerRecord>();
  constructor(readonly maxBytes = 256 * 1024 * 1024, readonly maxRecords = 1024) {}
  async list(scope: FileScope): Promise<readonly DraftRecord[]> { return [...this.#records.values()].filter(record => scopeKey(record.scope) === scopeKey(scope)); }
  async get(scope: FileScope, id: string): Promise<DraftRecord | undefined> { return this.#records.get(draftKey(scope, id)); }
  async put(record: DraftRecord, expectedRevision: number): Promise<DraftRecord> {
    record = copy(record);
    const next = prepare([...this.#records.values()], record, expectedRevision, this.maxBytes, this.maxRecords);
    this.#records.set(next.key, next); return next;
  }
  async remove(scope: FileScope, id: string, expectedRevision: number): Promise<void> { const key = draftKey(snapshotScope(scope), id), record = this.#records.get(key); removable(record, expectedRevision); this.#records.delete(key); }
  async getComposer(scope: ComposerScope): Promise<ComposerRecord | undefined> { return this.#composers.get(composerKey(composerScope(scope))); }
  async putComposer(record: ComposerRecord, expectedRevision: number): Promise<ComposerRecord> {
    record = copyComposer(record); const prior = this.#composers.get(record.key); checkRevision(prior, expectedRevision);
    const next = copyComposer({ ...record, revision: expectedRevision + 1, originals: prior?.originals ?? [] }); admitComposers([...this.#composers.values()], next, this.maxRecords); this.#composers.set(next.key, next); return next;
  }
  async original(scope: ComposerScope, expectedRevision: number, reference: ComposerOriginal, change: "protect" | "settle" | "forget", files?: Readonly<{ scope: FileScope; ids: readonly string[] }>): Promise<ComposerRecord> {
    const result = originalChange(this.#composers.get(composerKey(composerScope(scope))), [...this.#records.values()], [...this.#composers.values()], expectedRevision, reference, change, files); admitComposers([...this.#composers.values()], result.composer, this.maxRecords);
    for (const record of result.records) this.#records.set(record.key, record); this.#composers.set(result.composer.key, result.composer); return result.composer;
  }
  close(): void {}
}

/** One atomic transaction accounts all retained Blobs and fences every revision. */
export class IndexedDbDraftPersistence implements DraftPersistence {
  private constructor(readonly database: IDBDatabase, readonly maxBytes: number, readonly maxRecords: number) {}
  static async open(name: string, options: Readonly<{ maxBytes?: number; maxRecords?: number }> = {}): Promise<IndexedDbDraftPersistence> {
    const maxBytes = options.maxBytes ?? 256 * 1024 * 1024, maxRecords = options.maxRecords ?? 1024;
    if (!name || name.length > 256) throw new FileError("INVALID");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 2); let blocked = false;
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("drafts")) request.result.createObjectStore("drafts", { keyPath: "key" }); if (!request.result.objectStoreNames.contains("composers")) request.result.createObjectStore("composers", { keyPath: "key" }); };
      request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
      request.onerror = () => reject(request.error);
      request.onblocked = () => { blocked = true; reject(new FileError("BUSY", "Browser draft database upgrade is blocked")); };
    });
    const result = new IndexedDbDraftPersistence(database, maxBytes, maxRecords);
    database.onversionchange = () => database.close(); return result;
  }
  async list(scope: FileScope): Promise<readonly DraftRecord[]> {
    const key = scopeKey(snapshotScope(scope));
    return new Promise((resolve, reject) => {
      const tx = this.database.transaction("drafts", "readonly"), request = tx.objectStore("drafts").getAll();
      request.onsuccess = () => resolve((request.result as DraftRecord[]).filter(record => scopeKey(record.scope) === key).map(copy));
      request.onerror = () => reject(request.error);
    });
  }
  async get(scope: FileScope, id: string): Promise<DraftRecord | undefined> {
    const key = draftKey(snapshotScope(scope), id);
    return new Promise((resolve, reject) => {
      const tx = this.database.transaction("drafts", "readonly"), request = tx.objectStore("drafts").get(key);
      request.onsuccess = () => resolve(request.result ? copy(request.result as DraftRecord) : undefined);
      request.onerror = () => reject(request.error);
    });
  }
  async put(record: DraftRecord, expectedRevision: number): Promise<DraftRecord> {
    record = copy(record);
    return new Promise((resolve, reject) => {
      const tx = this.database.transaction("drafts", "readwrite"), store = tx.objectStore("drafts"), request = store.getAll();
      let result: DraftRecord | undefined, failure: unknown;
      request.onsuccess = () => {
        try { result = prepare(request.result as DraftRecord[], record, expectedRevision, this.maxBytes, this.maxRecords); store.put(result); }
        catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result!);
      tx.onabort = () => reject(failure ?? tx.error ?? new FileError("IO"));
      tx.onerror = () => { failure ??= tx.error; };
    });
  }
  async remove(scope: FileScope, id: string, expectedRevision: number): Promise<void> {
    const key = draftKey(snapshotScope(scope), id);
    return this.#transaction(["drafts"], tx => new Promise((resolve, reject) => {
      const store = tx.objectStore("drafts"), request = store.get(key);
      request.onsuccess = () => { try { removable(request.result as DraftRecord | undefined, expectedRevision); store.delete(key); resolve(); } catch (error) { reject(error); } }; request.onerror = () => reject(request.error);
    }));
  }
  async getComposer(scope: ComposerScope): Promise<ComposerRecord | undefined> {
    const key = composerKey(composerScope(scope));
    return new Promise((resolve, reject) => { const request = this.database.transaction("composers", "readonly").objectStore("composers").get(key); request.onsuccess = () => resolve(request.result ? copyComposer(request.result as ComposerRecord) : undefined); request.onerror = () => reject(request.error); });
  }
  async putComposer(record: ComposerRecord, expectedRevision: number): Promise<ComposerRecord> {
    record = copyComposer(record);
    return this.#transaction(["composers"], tx => new Promise((resolve, reject) => {
      const store = tx.objectStore("composers"), request = store.getAll();
      request.onsuccess = () => { try {
        const records = request.result as ComposerRecord[], prior = records.find(value => value.key === record.key); checkRevision(prior, expectedRevision);
        const next = copyComposer({ ...record, revision: expectedRevision + 1, originals: prior?.originals ?? [] }); admitComposers(records, next, this.maxRecords); store.put(next); resolve(next);
      } catch (error) { reject(error); } }; request.onerror = () => reject(request.error);
    }));
  }
  async original(scope: ComposerScope, expectedRevision: number, reference: ComposerOriginal, change: "protect" | "settle" | "forget", files?: Readonly<{ scope: FileScope; ids: readonly string[] }>): Promise<ComposerRecord> {
    const key = composerKey(composerScope(scope)); reference = composerOriginal(reference);
    const frozenFiles = files ? { scope: snapshotScope(files.scope), ids: composerValue({ text: "", fileIds: files.ids }).fileIds } : undefined;
    return this.#transaction(["drafts", "composers"], tx => new Promise((resolve, reject) => {
      const drafts = tx.objectStore("drafts"), composers = tx.objectStore("composers"), a = drafts.getAll(), b = composers.getAll(); let done = 0;
      const apply = () => { if (++done !== 2) return; try {
        const all = b.result as ComposerRecord[], result = originalChange(all.find(value => value.key === key), a.result as DraftRecord[], all, expectedRevision, reference, change, frozenFiles); admitComposers(all, result.composer, this.maxRecords);
        for (const record of result.records) drafts.put(record); composers.put(result.composer); resolve(result.composer);
      } catch (error) { reject(error); } }; a.onsuccess = apply; b.onsuccess = apply; a.onerror = () => reject(a.error); b.onerror = () => reject(b.error);
    }));
  }
  #transaction<T>(stores: string[], work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = this.database.transaction(stores, "readwrite"); let result: T, failure: unknown;
      tx.oncomplete = () => resolve(result); tx.onabort = () => reject(failure ?? tx.error ?? new FileError("IO")); tx.onerror = () => { failure ??= tx.error; };
      void work(tx).then(value => { result = value; }, error => { failure = error; try { tx.abort(); } catch { reject(error); } });
    });
  }
  close(): void { this.database.close(); }
}

export interface ExclusiveLock { run<T>(key: string, operation: () => Promise<T>): Promise<T> }
export class LocalExclusiveLock implements ExclusiveLock {
  readonly #tails = new Map<string, Promise<void>>();
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void; const tail = new Promise<void>(resolve => { release = resolve; });
    this.#tails.set(key, tail); await previous;
    try { return await operation(); } finally { release(); if (this.#tails.get(key) === tail) this.#tails.delete(key); }
  }
}
export class BrowserExclusiveLock implements ExclusiveLock {
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (!globalThis.navigator?.locks) throw new FileError("UNSUPPORTED", "Cross-tab transfer ownership requires Web Locks");
    return navigator.locks.request(`multiplex-v8-files:${key}`, { mode: "exclusive" }, operation);
  }
}
