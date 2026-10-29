import { scopeKey, type SessionScope } from "../../protocol/index.js";
import type {
  ClientLimits,
  SessionEntryPort,
  SessionViewPort,
  WorkspaceOptions,
} from "../contracts.js";
import { SessionEntry } from "./session-entry.js";
import { SessionView } from "./view.js";
import { check, immutable } from "./validation.js";

const defaults: ClientLimits = {
  maxEntries: 32,
  maxViews: 64,
  maxListeners: 64,
  maxDraftBytes: 65536,
  maxOriginals: 128,
  reservedStops: 1,
  maxOriginalBytes: 4194304,
  maxRequestBytes: 65536,
  recentOriginals: 32,
  maxHistoryRows: 512,
  maxHistoryBytes: 2097152,
};
/** One map owns retained entries. Preparing an entry/view does no I/O; only
 * explicit restore, committed view leases and persistent pins open observations. */
export class RetainedWorkspace {
  readonly #entries = new Map<string, SessionEntry>();
  readonly limits: ClientLimits;
  #closed = false;
  #restored: Promise<void> | undefined;
  readonly #options: WorkspaceOptions;
  constructor(options: WorkspaceOptions) {
    this.#options = options;
    this.limits = Object.freeze({ ...defaults, ...options.limits });
    for (const value of Object.values(this.limits))
      check(Number.isSafeInteger(value) && value > 0 && value <= 16777216);
    check(
      this.limits.maxEntries <= 1024 &&
        this.limits.maxViews <= 1024 &&
        this.limits.maxOriginals <= 1024 &&
        this.limits.recentOriginals <= 1024 &&
        this.limits.maxHistoryRows <= 4096,
    );
    check(
      this.limits.maxOriginalBytes <= defaults.maxOriginalBytes &&
        this.limits.maxRequestBytes <= defaults.maxRequestBytes &&
        this.limits.recentOriginals <= defaults.recentOriginals &&
        this.limits.maxDraftBytes <= defaults.maxDraftBytes &&
        this.limits.maxHistoryBytes <= defaults.maxHistoryBytes,
    );
  }
  get entryCount(): number {
    return this.#entries.size;
  }
  entry(scope: SessionScope): SessionEntryPort {
    return this.#entry(scope);
  }
  #entry(scope: SessionScope): SessionEntry {
    check(!this.#closed, "CLOSED");
    const key = scopeKey(scope),
      previous = this.#entries.get(key);
    if (previous) {
      this.#entries.delete(key);
      this.#entries.set(key, previous);
      return previous;
    }
    if (this.#entries.size >= this.limits.maxEntries) {
      const victim = [...this.#entries].find(([, entry]) => entry.evictable);
      check(victim, "FULL");
      // evictable proves all observation cleanup is already settled.
      void victim[1].close().catch(() => {});
      this.#entries.delete(victim[0]);
    }
    const entry = this.#create(scope);
    this.#entries.set(key, entry);
    return entry;
  }
  view(scope: SessionScope): SessionViewPort {
    return new SessionView(this.#entry(scope));
  }
  #create(scope: SessionScope, stored?: import("../contracts.js").PersistedEntry): SessionEntry {
    return new SessionEntry(
      {
        ...this.#options,
        scope,
        limits: this.limits,
        reserveView: () => {
          check(
            [...this.#entries.values()].reduce((sum, entry) => sum + entry.viewCount, 0) <
              this.limits.maxViews,
            "FULL",
          );
        },
      },
      stored,
    );
  }
  restore(): Promise<void> {
    check(!this.#closed, "CLOSED");
    return (this.#restored ??= (async () => {
      const stored = immutable(await this.#options.persistence.load(this.limits.maxEntries));
      check(Array.isArray(stored) && stored.length <= this.limits.maxEntries, "FULL");
      const restored = stored.map((value) => ({
        key: scopeKey(value.scope),
        entry: this.#create(value.scope, value),
      }));
      check(
        new Set(restored.map((value) => value.key)).size === restored.length &&
          restored.every((value) => !this.#entries.has(value.key)),
        "CONFLICT",
      );
      check(this.#entries.size + restored.length <= this.limits.maxEntries, "FULL");
      for (const value of restored) this.#entries.set(value.key, value.entry);
      for (const value of restored) value.entry.startPinned();
    })());
  }
  async settled(): Promise<void> {
    await Promise.all([...this.#entries.values()].map((entry) => entry.settled()));
  }
  async close(): Promise<void> {
    check(
      [...this.#entries.values()].every((entry) => entry.actualWork === 0),
      "PENDING_WORK",
    );
    this.#closed = true;
    await Promise.all([...this.#entries.values()].map((entry) => entry.close()));
    this.#entries.clear();
  }
}
