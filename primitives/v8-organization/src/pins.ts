import { CatalogWorkspace, type LogicalEntry } from "../../v8-catalog/src/client/workspace.js";
import { catalogKey, CatalogError, type CatalogScope } from "../../v8-catalog/src/contracts/types.js";
import { check, id, scope as checkScope } from "../../v8-catalog/src/contracts/validation.js";

export interface PinStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; }
export type PinObservation = Readonly<{ session: string; retention: "background" | "provisional" | "notHeld" }>;
export type PinWrite = Readonly<{ persistence: "saved" | "unavailable" | "disabled" }>;
export type PinRestore = Readonly<{
  state: "restored" | "partial" | "absent" | "invalid" | "unavailable" | "disabled";
  applied: readonly string[]; blocked: readonly string[];
}>;
export const pinStorageKey = (scope: CatalogScope): string => { checkScope(scope); return `multiplex:v8:session-pins:${catalogKey(scope)}`; };
const restoreResult = (state: PinRestore["state"], applied: string[] = [], blocked: string[] = []): PinRestore => Object.freeze({ state, applied: Object.freeze(applied), blocked: Object.freeze(blocked) });

/** Scoped browser preference writer; actual retention remains Catalog/Session/HistoryWorkspace. */
export class SessionPins {
  readonly #catalog: CatalogWorkspace; readonly #scope: CatalogScope; readonly #storage: PinStorage | undefined; readonly #limit: number;
  /** Null is an explicitly unfulfilled restored preference, never a claimed observation reference. */
  readonly #pins = new Map<string, LogicalEntry | null>();
  constructor(options: Readonly<{ catalog: CatalogWorkspace; scope: CatalogScope; storage?: PinStorage; maxPins?: number }>) {
    checkScope(options.scope); this.#scope = Object.freeze({ ...options.scope }); this.#catalog = options.catalog; this.#storage = options.storage; this.#limit = options.maxPins ?? 8;
    check(Number.isSafeInteger(this.#limit) && this.#limit > 0 && this.#limit <= 128);
    this.#assertScope();
  }
  #assertScope(): void {
    if (catalogKey(this.#catalog.getScope()) !== catalogKey(this.#scope)) throw new CatalogError("FENCED");
  }
  snapshot(): readonly PinObservation[] {
    return Object.freeze([...this.#pins].map(([session, entry]) => {
      const state = entry?.getSnapshot();
      return Object.freeze({ session, retention: state?.pinned ? state.bound ? "background" as const : "provisional" as const : "notHeld" as const });
    }));
  }
  #save(): PinWrite {
    if (!this.#storage) return Object.freeze({ persistence: "disabled" });
    try { this.#storage.setItem(pinStorageKey(this.#scope), JSON.stringify({ version: 1, scope: this.#scope, pinned: [...this.#pins.keys()] })); return Object.freeze({ persistence: "saved" }); }
    catch { return Object.freeze({ persistence: "unavailable" }); }
  }
  setPinned(session: string, pinned: boolean): PinWrite {
    id(session); check(typeof pinned === "boolean"); this.#assertScope();
    if (pinned) {
      if (!this.#pins.has(session) && this.#pins.size >= this.#limit) throw new CatalogError("FULL", "Pin preference capacity reached; no pin was released");
      const entry = this.#catalog.entry(session); this.#catalog.setPinned(session, true); this.#pins.set(session, entry);
    } else if (this.#pins.has(session)) {
      // A failed restored preference owns no retained reference to release.
      if (this.#pins.get(session)) this.#catalog.setPinned(session, false);
      this.#pins.delete(session);
    }
    return this.#save();
  }
  /** Explicit, additive restoration. Partial capacity failures never compensate by unpinning protected peers. */
  restore(): PinRestore {
    this.#assertScope(); if (!this.#storage) return restoreResult("disabled");
    let raw: string | null; try { raw = this.#storage.getItem(pinStorageKey(this.#scope)); } catch { return restoreResult("unavailable"); }
    if (raw === null) return restoreResult("absent");
    let sessions: string[];
    try {
      check(raw.length <= 256 * 1024); const data: unknown = JSON.parse(raw);
      check(data !== null && typeof data === "object" && !Array.isArray(data));
      const value = data as Record<string, unknown>;
      check(Object.keys(value).every(key => ["version", "scope", "pinned"].includes(key)) && value.version === 1);
      checkScope(value.scope as CatalogScope); check(catalogKey(value.scope as CatalogScope) === catalogKey(this.#scope));
      check(Array.isArray(value.pinned) && value.pinned.length <= this.#limit);
      sessions = value.pinned as string[]; for (const session of sessions) id(session); check(new Set(sessions).size === sessions.length);
    } catch { return restoreResult("invalid"); }
    // Preserve current protected preferences atomically when the combined intent exceeds its own budget.
    if (new Set([...this.#pins.keys(), ...sessions]).size > this.#limit) return restoreResult("partial", [], sessions.filter(session => !this.#pins.has(session)));
    const applied: string[] = [], blocked: string[] = [];
    for (const session of sessions) {
      try { const entry = this.#catalog.entry(session); this.#catalog.setPinned(session, true); this.#pins.set(session, entry); applied.push(session); }
      catch { if (!this.#pins.has(session)) this.#pins.set(session, null); blocked.push(session); }
    }
    // Do not rewrite storage here: unresolved requested pins must remain available for explicit retry.
    return restoreResult(blocked.length ? "partial" : "restored", applied, blocked);
  }
}
