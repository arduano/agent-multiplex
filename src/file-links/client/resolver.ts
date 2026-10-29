import { canonicalJson, cloneJson, scopeKey, type Json } from "../../protocol/index.js";
import type { FileLinkResolverOptions } from "../contracts.js";
import type { FileReadPort } from "../../files/contracts.js";
import {
  localFileLink,
  type FileLink,
  type FileLinkLease,
  type FileLinkResult,
} from "../contracts.js";
type Entry = { promise: Promise<FileLinkResult>; actual: boolean; holds: number };
/** Bounded captured-descriptor cache. Handed-out results retain actual file
 * leases; preview disposal never pretends to cancel pending capture/acquire. */
export class FileLinkResolver {
  readonly #entries = new Map<string, Entry>();
  readonly #actual = new Set<Promise<unknown>>();
  readonly #releases = new Set<() => Promise<void>>();
  #closed = false;
  #closing: Promise<void> | undefined;
  #slots = 0;
  constructor(private readonly options: FileLinkResolverOptions) {
    for (const [value, max] of [
      [options.maxEntries ?? 64, 256],
      [options.maxPending ?? 2, 8],
      [options.maxLeases ?? 16, 32],
    ])
      if (!Number.isSafeInteger(value) || value! < 1 || value! > max!)
        throw Error("Invalid file-link limits");
  }
  #track<T>(promise: Promise<T>): Promise<T> {
    this.#actual.add(promise);
    void promise.finally(() => this.#actual.delete(promise)).catch(() => {});
    return promise;
  }
  resolve = async (input: FileLink): Promise<FileLinkLease> => {
    if (
      this.#closed ||
      this.#slots >= (this.options.maxLeases ?? 16) ||
      !localFileLink(input.href) ||
      input.run.scope.connection !== this.options.identity.connection ||
      input.run.scope.principal !== this.options.identity.principal
    )
      return { state: "unavailable" };
    const link = cloneJson(input as unknown as Json, 16384) as unknown as FileLink,
      key = canonicalJson(link as unknown as Json, 16384).json;
    let entry = this.#entries.get(key);
    if (!entry) {
      if (
        [...this.#entries.values()].filter((value) => value.actual).length >=
        (this.options.maxPending ?? 2)
      )
        return { state: "unavailable" };
      if (this.#entries.size >= (this.options.maxEntries ?? 64)) {
        const victim = [...this.#entries].find(([, value]) => !value.actual && !value.holds);
        if (!victim) return { state: "unavailable" };
        this.#entries.delete(victim[0]);
      }
      entry = { actual: true, holds: 0, promise: undefined! };
      const held = entry;
      entry.promise = this.#track(
        Promise.resolve()
          .then(() => this.options.capture(link))
          .then(
            (result) => {
              if (
                result.state !== "ready" ||
                scopeKey(result.preview.file.scope) !== scopeKey(link.run.scope)
              )
                return { state: "unavailable" as const };
              return cloneJson(
                result as unknown as Json,
                2 * 1024 * 1024,
              ) as unknown as FileLinkResult;
            },
            () => ({ state: "unavailable" as const }),
          )
          .finally(() => {
            held.actual = false;
          }),
      );
      this.#entries.set(key, entry);
    }
    entry.holds++;
    this.#slots++;
    let transferred = false,
      freed = false;
    const held = entry;
    const free = () => {
      if (freed) return;
      freed = true;
      held.holds--;
      this.#slots--;
    };
    try {
      const result = await entry.promise;
      if (this.#closed || result.state !== "ready") {
        free();
        return { state: "unavailable" };
      }
      let lease: Awaited<ReturnType<FileReadPort["acquire"]>>;
      try {
        lease = await this.#track(this.options.files.acquire(link.run.scope, result.preview.file));
      } catch {
        free();
        return { state: "unavailable" };
      }
      let releasing: Promise<void> | undefined;
      const release = () =>
        (releasing ??= this.#track(Promise.resolve().then(() => lease.release())).then(() => {
          free();
          this.#releases.delete(release);
        }));
      this.#releases.add(release);
      transferred = true;
      if (
        this.#closed ||
        scopeKey(lease.file.scope) !== scopeKey(link.run.scope) ||
        lease.file.id !== result.preview.file.id ||
        lease.file.sha256 !== result.preview.file.sha256 ||
        lease.file.bytes !== result.preview.file.bytes
      ) {
        await release();
        return { state: "unavailable" };
      }
      return { state: "ready", preview: result.preview, release };
    } catch {
      if (!transferred) free();
      return { state: "unavailable" };
    }
  };
  readiness(): boolean {
    return !this.#actual.size && !this.#slots && !this.#releases.size;
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    return (this.#closing = (async () => {
      await Promise.allSettled([...this.#actual]);
      await Promise.all([...this.#releases].map((release) => release()));
      if (!this.readiness()) throw Error("File link custody remains");
      this.#entries.clear();
    })());
  }
}
