import type { CatalogEntry, CatalogQuery } from "../contracts.js";
export function queryCatalog(
  entries: readonly CatalogEntry[],
  query: CatalogQuery = {},
  pinned: readonly string[] = [],
) {
  const offset = query.offset ?? 0,
    limit = query.limit ?? 100,
    text = query.text ?? "";
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    text.length > 256 ||
    pinned.length > 256
  )
    throw new TypeError("Invalid catalog query");
  const pins = new Set(pinned),
    needle = text.trim().toLocaleLowerCase(),
    seen = new Set<string>();
  const rows = entries
    .filter((entry) => {
      const key = JSON.stringify([entry.scope.host, entry.scope.session]);
      if (seen.has(key)) throw new Error("Duplicate catalog identity");
      seen.add(key);
      return (
        (!entry.archived || query.includeArchived) &&
        (!query.host || entry.scope.host === query.host) &&
        (!query.nativeKind || entry.target.nativeKind === query.nativeKind) &&
        (!query.pinnedOnly || pins.has(key)) &&
        (!needle ||
          [entry.name, entry.scope.session, entry.scope.host].some((value) =>
            value.toLocaleLowerCase().includes(needle),
          ))
      );
    })
    .sort(
      (a, b) =>
        Number(pins.has(JSON.stringify([b.scope.host, b.scope.session]))) -
          Number(pins.has(JSON.stringify([a.scope.host, a.scope.session]))) ||
        a.name.localeCompare(b.name) ||
        a.scope.host.localeCompare(b.scope.host) ||
        a.scope.session.localeCompare(b.scope.session),
    );
  return {
    coverage: "snapshot" as const,
    total: entries.length,
    matching: rows.length,
    rows: rows.slice(offset, offset + limit),
    nextOffset: offset + limit < rows.length ? offset + limit : null,
    unobservedPinned: [...pins].filter((key) => !seen.has(key)),
  };
}
