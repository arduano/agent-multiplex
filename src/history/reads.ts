import type {
  HistoryReadPort,
  AcquisitionOptions,
  HistoryAcquisitionPort,
  HistoryReadHandle,
  HistoryReadWindow,
  ReadBudgetPort,
  ReadObservation,
  ReadOutcome,
  ReadState,
  ReadTarget,
} from "./contracts.js";
import {
  bytes,
  check,
  HistoryError,
  historyScopeKey,
  immutable,
  integer,
  text,
} from "./validation.js";

/** Share this actual-I/O budget across successive reader attachments. Closing
 * an observer/attachment never releases a hung read's reservation. */
export class ReadBudget implements ReadBudgetPort {
  #active = 0;
  readonly #maximum: number;
  constructor(maximum = 2) {
    integer(maximum, 1);
    check(maximum <= 128, "INVALID_LIMIT");
    this.#maximum = maximum;
  }
  get maximum(): number {
    return this.#maximum;
  }
  get active(): number {
    return this.#active;
  }
  run<T>(operation: () => Promise<T>): Promise<T> {
    check(this.#active < this.maximum, "READ_BUSY");
    this.#active++;
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        this.#active--;
      });
  }
}
interface Job {
  key: string;
  target: ReadTarget;
  nativeCursor: string | null;
  active: boolean;
  retired: boolean;
  attempts: number;
  outcome: ReadOutcome | undefined;
  settled: Promise<ReadOutcome>;
}
export class ReadHandle implements HistoryReadHandle {
  constructor(private readonly job: Job) {}
  get active(): boolean {
    return this.job.active;
  }
  get outcome(): ReadOutcome | undefined {
    return this.job.retired ? { state: "retired" } : this.job.outcome;
  }
  /** Always waits for actual I/O settlement, even after retirement. */
  get settled(): Promise<ReadOutcome> {
    return this.job.settled;
  }
  async wait(timeoutMs: number, signal?: AbortSignal): Promise<ReadObservation> {
    integer(timeoutMs);
    check(timeoutMs <= 30000, "WAIT_LIMIT");
    signal?.throwIfAborted();
    if (this.outcome) return this.outcome;
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    try {
      return await Promise.race([
        this.job.settled,
        new Promise<ReadObservation>((resolve, reject) => {
          timer = setTimeout(() => resolve({ state: "waitingExpired" }), timeoutMs);
          abort = () => reject(new DOMException("History observation cancelled", "AbortError"));
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }
}
type Episode = Readonly<{ job: Job; handle: ReadHandle }>;

/** One admitted read attachment and paging frontier, not an effect journal or
 * transcript store. Native cursors stay private; monotonic public frontier
 * tokens make old public cursors stale without retaining public request IDs. A
 * bounded per-native-lease proof set additionally rejects cyclic native cursors. */
export class HistoryAcquisition implements HistoryAcquisitionPort {
  readonly budget: ReadBudgetPort;
  #baseline: Episode | undefined;
  #older: Episode | undefined;
  #latest: Episode | undefined;
  #frontier: { key: string; token: string; nativeCursor: string } | undefined;
  #closed = false;
  #serial = 0;
  #consumed = new Set<string>();
  #cursorBytes = 0;
  readonly #maxCursors: number;
  readonly #maxCursorBytes: number;
  readonly count: number;
  readonly maxBytes: number;
  readonly maxCalls: number;
  readonly mode: HistoryReadPort["mode"];
  readonly #readPort: HistoryReadPort["read"];
  constructor(
    private readonly window: HistoryReadWindow,
    port: HistoryReadPort,
    budget: ReadBudgetPort = new ReadBudget(),
    private readonly options: AcquisitionOptions = {},
  ) {
    check(historyScopeKey(window.scope) === historyScopeKey(port.scope), "FOREIGN_READ_PORT");
    check(port.mode === "repeatable" || port.mode === "singleUse", "INVALID_READ_MODE");
    this.mode = port.mode;
    this.#readPort = port.read.bind(port);
    this.#maxCursors = options.maxCursors ?? 4096;
    this.#maxCursorBytes = options.maxCursorBytes ?? 1048576;
    integer(this.#maxCursors, 1);
    integer(this.#maxCursorBytes, 1);
    check(this.#maxCursors <= 4096 && this.#maxCursorBytes <= 1048576, "INVALID_LIMIT");
    this.budget = budget;
    this.count = options.count ?? 100;
    this.maxBytes = options.maxBytes ?? 524288;
    this.maxCalls = options.maxCalls ?? 8;
    for (const value of [this.count, this.maxBytes, this.maxCalls]) integer(value, 1);
    check(this.count <= 128 && this.maxBytes <= 1048576 && this.maxCalls <= 16, "INVALID_LIMIT");
    Object.freeze(this);
  }
  #key(): string {
    const value = this.window.getSnapshot();
    return JSON.stringify([value.generation, value.readEpoch]);
  }
  #changed(): void {
    try {
      this.options.changed?.();
    } catch {
      /* Observation cannot alter actual read ownership. */
    }
  }
  getState(): ReadState {
    const job = this.#latest?.job;
    if (!job) return { state: "idle" };
    if (job.retired)
      return immutable({
        state: "settled",
        target: job.target,
        outcome: { state: "retired" },
        retryable: false,
      });
    if (job.active) return immutable({ state: "pending", target: job.target });
    return immutable({
      state: "settled",
      target: job.target,
      outcome: job.outcome!,
      retryable:
        this.mode === "repeatable" &&
        job.outcome?.state === "failed" &&
        job.attempts < 2 &&
        !this.#closed &&
        job.key === this.#key(),
    });
  }
  baseline(): HistoryReadHandle {
    check(!this.#closed, "CLOSED");
    const key = this.#key();
    if (this.#baseline?.job.key === key) return this.#baseline.handle;
    check(this.mode !== "singleUse" || !this.#baseline, "SINGLE_USE_READER_CONSUMED");
    const value = this.#start(key, { kind: "baseline" }, null, 1);
    this.#baseline = value;
    return value.handle;
  }
  older(cursor: string): HistoryReadHandle {
    check(!this.#closed, "CLOSED");
    text(cursor, 16384);
    const key = this.#key();
    if (
      this.#older?.job.key === key &&
      this.#older.job.target.kind === "older" &&
      this.#older.job.target.cursor === cursor
    )
      return this.#older.handle;
    const edge = this.window.getSnapshot().olderEdge;
    check(
      this.#frontier?.key === key &&
        this.#frontier.token === cursor &&
        edge.state === "available" &&
        edge.cursor === cursor,
      "STALE_CURSOR",
    );
    const value = this.#start(key, { kind: "older", cursor }, this.#frontier.nativeCursor, 1);
    this.#older = value;
    return value.handle;
  }
  /** One explicit retry of the exact repeatable input. Never used by wait,
   * reconnect, timeout or a single-use persisted native cursor. */
  retry(handle: HistoryReadHandle): HistoryReadHandle {
    check(!this.#closed, "CLOSED");
    const prior = [this.#baseline, this.#older].find((value) => value?.handle === handle);
    check(prior && prior.job.key === this.#key(), "STALE_READ");
    check(
      this.mode === "repeatable" &&
        !prior.job.active &&
        prior.job.outcome?.state === "failed" &&
        prior.job.attempts < 2,
      "RETRY_NOT_ADMITTED",
    );
    const next = this.#start(
      prior.job.key,
      prior.job.target,
      prior.job.nativeCursor,
      prior.job.attempts + 1,
    );
    if (prior === this.#baseline) this.#baseline = next;
    else this.#older = next;
    return next.handle;
  }
  #start(key: string, target: ReadTarget, nativeCursor: string | null, attempts: number): Episode {
    check(!this.#latest?.job.active, "READ_BUSY");
    const job: Job = {
      key,
      target: immutable(target),
      nativeCursor,
      active: true,
      retired: false,
      attempts,
      outcome: undefined,
      settled: undefined!,
    };
    // Reserve before publishing the job or invoking a reentrant native port.
    const work = this.budget.run(() => this.#read(job));
    const value = { job, handle: new ReadHandle(job) };
    this.#latest = value;
    job.settled = work
      .catch((error) => ({
        state: "failed" as const,
        code: error instanceof HistoryError ? error.code : "READ_FAILED",
      }))
      .then((outcome) => {
        job.active = false;
        job.outcome = immutable(job.retired ? { state: "retired" } : outcome);
        this.#changed();
        return job.outcome;
      });
    this.#changed();
    return value;
  }
  async #read(job: Job): Promise<ReadOutcome> {
    if (this.#closed || job.key !== this.#key()) return { state: "stale" };
    const fence = this.window.beginRead();
    const current = () =>
      !this.#closed && !job.retired && job.key === this.#key() && this.window.readIsCurrent(fence);
    const assertCurrent = () => check(current(), "STALE_READ");
    let count = this.mode === "singleUse" ? 1 : this.count;
    if (this.mode === "singleUse") this.#frontier = undefined;
    try {
      for (let call = 0; call < this.maxCalls; call++) {
        if (!current()) return { state: "stale" };
        try {
          if (this.mode === "singleUse") {
            const key = JSON.stringify(job.nativeCursor),
              size = bytes(key);
            check(!this.#consumed.has(key), "CURSOR_REPLAY");
            check(
              this.#consumed.size < this.#maxCursors &&
                this.#cursorBytes + size <= this.#maxCursorBytes,
              "CURSOR_PROOF_FULL",
            );
            this.#consumed.add(key);
            this.#cursorBytes += size;
          }
          const batch = await this.#readPort(
            Object.freeze({ cursor: job.nativeCursor, count }),
            assertCurrent,
          );
          if (!current()) return { state: "stale" };
          check(bytes(batch) <= this.maxBytes, "PAGE_TOO_LARGE");
          if (batch.status === "expired" || batch.status === "unsupported")
            return { state: batch.status };
          check(
            batch.status === "page" &&
              historyScopeKey(batch.scope) === historyScopeKey(this.window.scope),
            "FOREIGN_PAGE",
          );
          check(Array.isArray(batch.rows) && batch.rows.length <= count, "PAGE_TOO_LARGE");
          if (batch.nextCursor !== null) {
            text(batch.nextCursor, 8192);
            check(batch.nextCursor !== job.nativeCursor, "NONADVANCING_CURSOR");
            if (this.mode === "singleUse")
              check(!this.#consumed.has(JSON.stringify(batch.nextCursor)), "CURSOR_REPLAY");
          }
          const serial = this.#serial + 1;
          integer(serial, 1);
          const token = JSON.stringify([this.window.scope.attachment, job.key, serial]);
          const edge =
            batch.nextCursor === null
              ? { state: "end" as const, evidence: "nativeBoundary" as const }
              : { state: "available" as const, cursor: token };
          if (!this.window.publishRead(fence, batch.rows, edge, batch.placement, batch.gaps ?? []))
            return { state: "stale" };
          this.#serial = serial;
          this.#frontier =
            batch.nextCursor === null
              ? undefined
              : { key: job.key, token, nativeCursor: batch.nextCursor };
          return { state: "ready" };
        } catch (error) {
          if (!current()) return { state: "stale" };
          if (
            !(error instanceof HistoryError) ||
            !["PAGE_TOO_LARGE", "WINDOW_FULL"].includes(error.code) ||
            this.mode === "singleUse" ||
            count === 1
          )
            throw error;
          count = Math.max(1, Math.floor(count / 2));
        }
      }
      throw new HistoryError("READ_CALL_LIMIT");
    } finally {
      this.window.endRead(fence);
    }
  }
  retire(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#frontier = undefined;
    for (const value of [this.#baseline, this.#older, this.#latest])
      if (value) value.job.retired = true;
    this.#changed();
  }
}
