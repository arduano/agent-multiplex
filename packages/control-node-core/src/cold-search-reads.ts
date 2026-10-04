import { ControlNodeCoreError } from "./errors.js";

const COLD_SEARCH_TIMEOUT_MS = 15_000;
const MAXIMUM_PENDING_SEARCHES = 64;

interface PendingSearch {
  readonly source: object;
  readonly identity: string;
  readonly result: Promise<unknown>;
  close(): void;
}

/** Bound cold-search callers without releasing an unresolved dependency lane.
 * Query and source identities coalesce only the same read. Expiry or cancellation
 * does not prove that an upstream control cancelled its traversal. */
export class ColdSearchReads {
  readonly #pending = new Set<PendingSearch>();
  #closed = false;

  public close(): void {
    this.#closed = true;
    for (const pending of this.#pending) pending.close();
  }

  public read<T>(source: object, identity: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#closed) return Promise.reject(unavailable("cold archive search is closing"));
    if (signal?.aborted) return Promise.reject(unavailable("cold archive search was cancelled"));
    let pending = [...this.#pending].find(entry => entry.source === source && entry.identity === identity);
    if (!pending) {
      if (this.#pending.size >= MAXIMUM_PENDING_SEARCHES) {
        return Promise.reject(unavailable("cold archive search capacity is occupied by pending child reads"));
      }
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;
      let finished = false;
      const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
      const entry: PendingSearch = { source, identity, result, close: () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(unavailable("cold archive search is closing; its child read remains pending"));
      } };
      this.#pending.add(entry);
      const timer = setTimeout(() => {
        finished = true;
        reject(unavailable("cold archive search timed out; a required child has not returned a complete page"));
      }, COLD_SEARCH_TIMEOUT_MS);
      timer.unref();
      const settled = () => {
        clearTimeout(timer);
        this.#pending.delete(entry);
        const accept = !finished;
        finished = true;
        return accept;
      };
      void Promise.resolve().then(() => {
        if (this.#closed) throw unavailable("cold archive search is closing");
        return action();
      }).then(
        value => { if (settled()) resolve(value); },
        error => { if (settled()) reject(error); },
      );
      pending = entry;
    }
    return observeSearch(pending.result as Promise<T>, signal);
  }
}

function observeSearch<T>(result: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return result;
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      if (finished) return false;
      finished = true;
      signal.removeEventListener("abort", abort);
      return true;
    };
    const abort = () => { if (cleanup()) reject(unavailable("cold archive search was cancelled; its child read remains pending")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void result.then(
      value => { if (cleanup()) resolve(value); },
      error => { if (cleanup()) reject(error); },
    );
  });
}

function unavailable(message: string): ControlNodeCoreError {
  return new ControlNodeCoreError("UNAVAILABLE", message);
}
