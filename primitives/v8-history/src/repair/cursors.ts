import type { HistoryPage, Scope } from "../contracts/types.js";
import { sameScope } from "../contracts/identity.js";
import { canonical, cloneJson, deepFreeze, invariant, PrimitiveError, validateFrame, validateScope } from "../contracts/validation.js";
export type NativePage = Readonly<{
  page: HistoryPage;
  status: "ok" | "expired";
  hasMore: boolean;
  nextCursor: string | null;
  snapshot?: Readonly<{ id: string; generation: string; byteBoundary: number }>;
}>;
export type PagePort = (request: Readonly<{ scope: Scope; cursor: string | null; count: number }>) => Promise<NativePage>;
function checked(raw: NativePage, scope: Scope, maxBytes: number): NativePage {
  const value = cloneJson(raw);
  invariant(value.status === "ok", "CURSOR_EXPIRED"); invariant(sameScope(value.page.scope, scope), "FOREIGN_PAGE_SCOPE");
  validateFrame({ kind: "snapshot", snapshot: { ...value.page, retirements: [], revision: 0, coverage: { knownStart: false, gaps: [] }, activity: { turnId: null, state: "unknown" } } });
  invariant(new Set(value.page.rows.map(row => row.id)).size === value.page.rows.length, "DUPLICATE_PAGE_ROW");
  invariant(typeof value.hasMore === "boolean" && (value.nextCursor === null || typeof value.nextCursor === "string"), "PAGE_CURSOR");
  invariant(!value.hasMore || (typeof value.nextCursor === "string" && value.nextCursor.length > 0 && value.nextCursor.length <= 4096), "NONADVANCING_CURSOR");
  invariant(value.hasMore
    ? value.page.olderEdge.state === "available" && value.page.olderEdge.cursor === value.nextCursor
    : value.nextCursor === null && value.page.olderEdge.state === "end" && value.page.olderEdge.evidence === "nativeBoundary", "PAGE_BOUNDARY_CONFLICT");
  invariant(new TextEncoder().encode(canonical(value)).byteLength <= maxBytes, "PAGE_TOO_LARGE");
  return deepFreeze(value);
}
/** A retryable active cursor retains the same input boundary when count shrinks. */
export async function readActivePage(port: PagePort, scope: Scope, cursor: string | null, count: number, maxBytes: number): Promise<NativePage> {
  invariant(Number.isSafeInteger(count) && count > 0 && count <= 128 && Number.isSafeInteger(maxBytes) && maxBytes > 0, "PAGE_LIMIT");
  scope = deepFreeze(cloneJson(validateScope(cloneJson(scope))));
  let admitted = count;
  for (;;) {
    const raw = await port({ scope, cursor, count: admitted });
    try {
      const result = checked(raw, scope, maxBytes);
      invariant(result.page.rows.length <= admitted && (!result.hasMore || result.nextCursor !== cursor), "NONADVANCING_CURSOR"); return result;
    } catch (error) {
      if (!(error instanceof PrimitiveError) || error.code !== "PAGE_TOO_LARGE" || admitted === 1) throw error;
      admitted = Math.max(1, Math.floor(admitted / 2));
    }
  }
}
/** Native cold snapshot continuations are consumed before awaiting; never replayed after timeout/error. */
export class PersistedSnapshotReader {
  private used = new Set<string | null>();
  private expected: string | null = null;
  private snapshot: NonNullable<NativePage["snapshot"]> | undefined;
  private pending = false;
  private ended = false;
  private readonly scope: Scope;
  constructor(private readonly port: PagePort, scope: Scope, private readonly maxBytes = 65_536, private readonly maxPages = 16) {
    this.scope = deepFreeze(cloneJson(validateScope(cloneJson(scope))));
    invariant(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 1_048_576 && Number.isSafeInteger(maxPages) && maxPages > 0 && maxPages <= 1024, "PAGE_LIMIT");
  }
  async read(cursor: string | null = null): Promise<NativePage> {
    invariant(!this.pending, "SNAPSHOT_READ_PENDING"); invariant(!this.ended, "SNAPSHOT_ENDED");
    invariant(cursor === this.expected && !this.used.has(cursor), "SNAPSHOT_CURSOR_CONSUMED"); invariant(this.used.size < this.maxPages, "SNAPSHOT_PAGE_LIMIT");
    this.used.add(cursor); this.pending = true;
    try {
      const raw = await this.port({ scope: this.scope, cursor, count: 1 }); // One-record transfer; no consumed-cursor shrink retry.
      const result = checked(raw, this.scope, this.maxBytes);
      invariant(result.snapshot && typeof result.snapshot.id === "string" && result.snapshot.id.length > 0 && result.snapshot.id.length <= 4096 && typeof result.snapshot.generation === "string" && result.snapshot.generation.length > 0 && result.snapshot.generation.length <= 4096 && Number.isSafeInteger(result.snapshot.byteBoundary) && result.snapshot.byteBoundary >= 0, "SNAPSHOT_IDENTITY");
      if (this.snapshot) invariant(canonical(this.snapshot) === canonical(result.snapshot), "SNAPSHOT_BOUNDARY_CHANGED");
      else this.snapshot = result.snapshot;
      invariant(result.page.rows.length <= 1 && (!result.hasMore || result.nextCursor !== cursor), "NONADVANCING_CURSOR");
      this.expected = result.nextCursor; this.ended = !result.hasMore; return result;
    } catch (error) { this.ended = true; throw error; }
    finally { this.pending = false; }
  }
}
