import type { ClientPersistence, PersistedEntry } from "../../client/index.js";
import { scopeKey } from "../../protocol/index.js";

/** A concrete browser storage adapter, not another original queue. Failure is
 * reported to the retained entry before dispatch; restore never replays work.
 * A namespace belongs exclusively to one retained workspace. Independent tabs
 * must use independent stable IDs, rather than overwrite another owner's jobs. */
export function browserPersistence(storage: Storage, namespace: string): ClientPersistence {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(namespace)) throw new TypeError("Invalid storage namespace");
  const prefix = `${namespace}:`;
  return {
    async load(maxEntries) {
      if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || storage.length > 1024)
        throw new Error("BROWSER_STORAGE_CAPACITY");
      const values: PersistedEntry[] = [];
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(prefix)) continue;
        if (values.length >= maxEntries) throw new Error("BROWSER_STORAGE_CAPACITY");
        const text = storage.getItem(key);
        if (!text || text.length > 8 * 1024 * 1024) throw new Error("BROWSER_STORAGE_INVALID");
        const value = JSON.parse(text) as PersistedEntry;
        if (key !== `${prefix}${encodeURIComponent(scopeKey(value.scope))}`)
          throw new Error("BROWSER_STORAGE_INVALID");
        values.push(value); // The retained owner validates the entire record.
      }
      return values;
    },
    async save(value) {
      const key = `${prefix}${encodeURIComponent(scopeKey(value.scope))}`,
        text = JSON.stringify(value);
      if (text.length > 8 * 1024 * 1024) throw new Error("BROWSER_STORAGE_CAPACITY");
      storage.setItem(key, text);
    },
  };
}
