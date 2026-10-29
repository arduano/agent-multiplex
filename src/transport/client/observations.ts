import type {
  ObservationConnector,
  ObservationDiagnostics,
  ObservationOptions,
} from "../contracts.js";
type Job = {
  key: string;
  controller: AbortController;
  active: boolean;
  phase: "opening" | "receiving" | "stopping";
  settled: Promise<void>;
  release?: () => Promise<void>;
};
/** One bounded reconnect loop per retained feed. It releases the actual old
 * iterator before opening its replacement, including late async acquisition. */
export class ObservationSupervisor implements ObservationConnector {
  readonly #jobs = new Set<Job>();
  #closed = false;
  constructor(readonly options: ObservationOptions = {}) {
    for (const value of [
      options.maxFeeds ?? 256,
      options.retryMinMs ?? 250,
      options.retryMaxMs ?? 10000,
    ])
      if (!Number.isSafeInteger(value) || value < 1)
        throw new TypeError("Invalid observation limits");
    if ((options.retryMaxMs ?? 10000) < (options.retryMinMs ?? 250))
      throw new TypeError("Invalid retry limits");
  }
  connect<T>(input: {
    readonly key: string;
    open(signal: AbortSignal): AsyncIterable<T>;
    receive(value: T): void;
    unavailable(): void;
  }): () => Promise<void> {
    if (this.#closed) throw new Error("Observation owner closed");
    if (
      !input.key ||
      input.key.length > 1024 ||
      this.#jobs.size >= (this.options.maxFeeds ?? 256) ||
      [...this.#jobs].some((job) => job.key === input.key)
    )
      throw new Error("Observation admission refused");
    const controller = new AbortController(),
      job: Job = {
        key: input.key,
        controller,
        active: true,
        phase: "opening",
        settled: Promise.resolve(),
      };
    this.#jobs.add(job);
    job.settled = (async () => {
      let failures = 0,
        cleanupProved = true;
      try {
        while (job.active) {
          let iterator: AsyncIterator<T> | undefined;
          try {
            job.phase = "opening";
            iterator = input.open(controller.signal)[Symbol.asyncIterator]();
            const held = iterator;
            let releasing: Promise<void> | undefined;
            job.release = () =>
              (releasing ??= Promise.resolve().then(async () => {
                await held.return?.();
              }));
            job.phase = "receiving";
            while (job.active) {
              const part = await iterator.next();
              if (part.done) break;
              if (!job.active) break;
              input.receive(part.value);
              failures = 0;
            }
          } catch {
            /* One observation failed; its native original is untouched. */
          } finally {
            // Failed cleanup retains this slot and prevents a replacement.
            // It is not silently treated as an observer that disappeared.
            job.phase = "stopping";
            try {
              await job.release?.();
              delete job.release;
            } catch (error) {
              cleanupProved = false;
              job.active = false;
              // Cleanup failure must override the observation outcome: its resource remains owned.
              // eslint-disable-next-line no-unsafe-finally
              throw error;
            }
          }
          if (!job.active) break;
          try {
            input.unavailable();
          } catch {
            /* Diagnostic observer. */
          }
          const delay = Math.min(
            this.options.retryMaxMs ?? 10000,
            (this.options.retryMinMs ?? 250) * 2 ** Math.min(failures++, 16),
          );
          await (this.options.pause ?? pause)(delay, controller.signal);
        }
      } catch (error) {
        if (!controller.signal.aborted)
          try {
            input.unavailable();
          } catch {}
        throw error;
      } finally {
        if (cleanupProved) this.#jobs.delete(job);
      }
    })();
    void job.settled.catch(() => {});
    return async () => {
      job.active = false;
      job.phase = "stopping";
      controller.abort();
      void job.release?.().catch(() => {});
      await job.settled;
    };
  }
  diagnostics(): ObservationDiagnostics {
    return {
      retained: this.#jobs.size,
      opening: [...this.#jobs].filter((job) => job.phase === "opening").length,
      receiving: [...this.#jobs].filter((job) => job.phase === "receiving").length,
      stopping: [...this.#jobs].filter((job) => job.phase === "stopping").length,
    };
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const job of this.#jobs) {
      job.active = false;
      job.controller.abort();
      void job.release?.().catch(() => {});
    }
    await Promise.all([...this.#jobs].map((job) => job.settled));
  }
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
