import { cloneJson, type Json } from "../../protocol/index.js";
import type { RetainedCatalogOptions } from "../contracts.js";
import type { CatalogListing, CatalogSelection, CatalogSnapshot } from "../contracts.js";
/** One bounded catalog projection, separate from retained conversation entries.
 * Commit/reconnect observe snapshots only; no mutation is reachable here. */
export class RetainedCatalog {
  #snapshot: CatalogSnapshot = Object.freeze({ freshness: "unobserved", listing: null });
  readonly #listeners = new Set<() => void>();
  #release: (() => void | Promise<void>) | undefined;
  #closing: Promise<void> | undefined;
  #closed = false;
  constructor(private readonly options: RetainedCatalogOptions) {
    if (
      !options.key ||
      options.key.length > 512 ||
      !Number.isSafeInteger(options.maxRows ?? 100) ||
      (options.maxRows ?? 100) < 1 ||
      (options.maxRows ?? 100) > 100 ||
      !Number.isSafeInteger(options.maxBytes ?? 1048576) ||
      (options.maxBytes ?? 1048576) < 1
    )
      throw Error("Invalid catalog observation bounds");
  }
  getSnapshot = (): CatalogSnapshot => this.#snapshot;
  subscribe = (listener: () => void) => {
    if (this.#closed || this.#listeners.size >= 64) throw Error("Catalog observer unavailable");
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #publish(freshness: CatalogSnapshot["freshness"], listing = this.#snapshot.listing) {
    this.#snapshot = Object.freeze({ freshness, listing });
    for (const listener of this.#listeners)
      try {
        listener();
      } catch {}
  }
  commit(): void {
    if (this.#closed) throw Error("Catalog observer closed");
    if (this.#release) return;
    const selection = cloneJson(
      (this.options.selection ?? {}) as unknown as Json,
      32768,
    ) as CatalogSelection;
    this.#release = this.options.observations.connect({
      key: `catalog:${this.options.key}`,
      open: (signal) =>
        this.options.feed.watch(selection, signal, () => {
          if (!this.#closed) this.#publish("stale");
        }),
      unavailable: () => {
        if (!this.#closed) this.#publish("stale");
      },
      receive: (value) => {
        if (this.#closed) return;
        const fixed = cloneJson(
          value as unknown as Json,
          this.options.maxBytes ?? 1048576,
        ) as unknown as CatalogListing;
        if (
          fixed.coverage !== "snapshot" ||
          fixed.authority !== this.options.identity.authority ||
          !Array.isArray(fixed.rows) ||
          fixed.rows.length > (this.options.maxRows ?? 100) ||
          !Number.isSafeInteger(fixed.total) ||
          fixed.total < 0 ||
          !Number.isSafeInteger(fixed.matching) ||
          fixed.matching < fixed.rows.length ||
          fixed.matching > fixed.total ||
          (fixed.nextOffset !== null &&
            (!Number.isSafeInteger(fixed.nextOffset) || fixed.nextOffset < 1)) ||
          !Array.isArray(fixed.unobservedPinned) ||
          fixed.unobservedPinned.length > 256 ||
          fixed.rows.some(
            (entry) =>
              entry.authority !== this.options.identity.authority ||
              entry.scope.connection !== this.options.identity.connection ||
              entry.scope.principal !== this.options.identity.principal,
          )
        )
          throw Error("Invalid catalog snapshot");
        this.#publish("current", fixed);
      },
    });
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#publish("unobserved", null);
    return (this.#closing = Promise.resolve().then(async () => {
      await this.#release?.();
      this.#listeners.clear();
    }));
  }
}
