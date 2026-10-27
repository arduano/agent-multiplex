import { catalogKey, CatalogError, type CatalogEntry, type CatalogScope } from "../../v8-catalog/src/contracts/types.js";
import { check, id, scope as checkScope } from "../../v8-catalog/src/contracts/validation.js";

export type CatalogQuery = Readonly<{
  text?: string; kind?: "codex" | "copilot"; host?: string;
  binding?: "bound" | "unbound"; pinnedOnly?: boolean;
  sort?: "name" | "session" | "host"; pinnedFirst?: boolean; offset?: number; limit?: number;
}>;
export type CatalogRow = Readonly<{ entry: CatalogEntry; pinned: boolean }>;
export type CatalogListing = Readonly<{
  /** An additive observed set is not proof of complete/current authority state. */
  coverage: "observed"; totalObserved: number; matching: number;
  rows: readonly CatalogRow[]; nextOffset: number | null;
  /** Preference survives missing metadata; absence is never a tombstone. */
  unobservedPinned: readonly string[];
}>;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Trusted CatalogWorkspace values, not a wire decoder. No transcript read, binding, mutation or new cache. */
export function queryCatalog(entries: readonly CatalogEntry[], scope: CatalogScope, query: CatalogQuery = {}, pinnedSessions: readonly string[] = []): CatalogListing {
  checkScope(scope); check(entries.length <= 512 && pinnedSessions.length <= 128);
  const text = query.text ?? "", sort = query.sort ?? "name", offset = query.offset ?? 0, limit = query.limit ?? 50;
  check(typeof text === "string" && text.length <= 256);
  check(["name", "session", "host"].includes(sort));
  check(query.kind === undefined || ["codex", "copilot"].includes(query.kind));
  check(query.binding === undefined || ["bound", "unbound"].includes(query.binding));
  check(query.pinnedOnly === undefined || typeof query.pinnedOnly === "boolean");
  check(query.pinnedFirst === undefined || typeof query.pinnedFirst === "boolean");
  check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100);
  if (query.host !== undefined) id(query.host);
  const pins = new Set(pinnedSessions), observed = new Set<string>();
  for (const session of pins) id(session);
  const needle = text.trim().toLowerCase(), rows: CatalogRow[] = [];
  for (const entry of entries) {
    checkScope(entry.scope); if (catalogKey(entry.scope) !== catalogKey(scope)) throw new CatalogError("FENCED");
    id(entry.session); if (observed.has(entry.session)) throw new CatalogError("CONFLICT", "Duplicate logical catalog identity"); observed.add(entry.session);
    const pinned = pins.has(entry.session);
    if (query.kind !== undefined && entry.target.kind !== query.kind || query.host !== undefined && entry.target.host !== query.host || query.binding === "bound" && !entry.binding || query.binding === "unbound" && entry.binding || query.pinnedOnly && !pinned) continue;
    if (needle && ![entry.session, entry.metadata.name ?? "", entry.metadata.cwd ?? "", entry.target.host].some(value => value.toLowerCase().includes(needle))) continue;
    rows.push(Object.freeze({ entry, pinned }));
  }
  const field = (entry: CatalogEntry): string => sort === "session" ? entry.session : sort === "host" ? entry.target.host : entry.metadata.name?.trim() || entry.session;
  rows.sort((a, b) => (query.pinnedFirst ? Number(b.pinned) - Number(a.pinned) : 0) || compare(field(a.entry).toLowerCase(), field(b.entry).toLowerCase()) || compare(field(a.entry), field(b.entry)) || compare(a.entry.session, b.entry.session));
  const next = offset + limit;
  return Object.freeze({ coverage: "observed", totalObserved: entries.length, matching: rows.length,
    rows: Object.freeze(rows.slice(offset, next)), nextOffset: next < rows.length ? next : null,
    unobservedPinned: Object.freeze([...pins].filter(session => !observed.has(session)).sort(compare)) });
}
