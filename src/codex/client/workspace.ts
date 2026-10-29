import { createAnchor } from "../../client/anchor.js";
import type { RunRef } from "../../protocol/index.js";
import type {
  CodexCaptureFrame,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadTurnsListParams,
  ThreadTurnsListResponse,
  ThreadItemsListParams,
  ThreadItemsListResponse,
} from "../native-contracts.js";
import { CodexCapture, immutable, key } from "../capture.js";
import type {
  CodexClientLimits,
  CodexEntrySnapshot,
  CodexPage,
  CodexPageEvidence,
  CodexViewPort,
  CodexViewSnapshot,
  CodexWorkspaceOptions,
} from "./contracts.js";
import { watch } from "./watch.js";

const defaults: CodexClientLimits = {
  maxEntries: 32,
  maxViews: 64,
  maxPages: 16,
  maxPageBytes: 4 * 1024 * 1024,
  maxItems: 512,
  maxPendingReads: 2,
  maxCaptureBytes: 4 * 1024 * 1024,
};
export const codexItemKey = (threadId: string, turnId: string, itemId: string): string =>
  key([threadId, turnId, itemId]);
type Cached = { evidence: CodexPageEvidence; bytes: number };
/** One browser content owner per exact native run. It observes only; it has no
 * native lifetime, journal, draft or command-dispatch authority. */
class Entry {
  readonly run: RunRef;
  readonly capture: CodexCapture;
  readonly views = new Set<CodexView>();
  readonly listeners = new Set<() => void>();
  readonly pages = new Map<string, Cached>();
  readonly jobs = new Map<string, Promise<CodexPageEvidence>>();
  readonly epochs = new Map<string, number>();
  #snapshot: CodexEntrySnapshot;
  #watch: { release(): Promise<void> } | undefined;
  #cleanup: Promise<void> | undefined;
  #closed = false;
  readonly #controller = new AbortController();
  #leases = 0;
  constructor(
    readonly options: CodexWorkspaceOptions,
    readonly limits: CodexClientLimits,
    run: RunRef,
  ) {
    this.run = immutable(run);
    this.capture = new CodexCapture(this.run, limits.maxItems, limits.maxCaptureBytes);
    this.#snapshot = immutable({
      ...this.capture.snapshot(),
      capture: this.capture.capture,
      run: this.run,
      revision: 0,
      freshness: "unobserved",
      pinned: false,
    });
  }
  getSnapshot = (): CodexEntrySnapshot => this.#snapshot;
  get idle(): boolean {
    return !this.#leases && !this.#snapshot.pinned && !this.jobs.size && !this.#cleanup;
  }
  publish(patch: Partial<CodexEntrySnapshot> = {}): void {
    this.#snapshot = Object.freeze({
      ...this.#snapshot,
      ...patch,
      revision: this.#snapshot.revision + 1,
    });
    for (const view of this.views) view.changed();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
  }
  lease(): () => void {
    if (this.#closed) throw Error("CODEX_CLIENT_CLOSED");
    this.#leases++;
    this.#demand();
    let held = true;
    return () => {
      if (held) {
        held = false;
        this.#leases--;
        this.#demand();
      }
    };
  }
  pin(value: boolean): void {
    if (this.#closed || typeof value !== "boolean") throw Error("CODEX_CLIENT_CLOSED");
    this.publish({ pinned: value });
    this.#demand();
  }
  #demand(): void {
    const needed = !this.#closed && (!!this.#leases || this.#snapshot.pinned);
    if (needed && !this.#watch && !this.#cleanup) {
      const token = {};
      let active = true;
      const connected = Promise.resolve().then(() =>
        active
          ? this.options.observations.connect({
              key: `codex:${key(this.run)}`,
              open: () => watch(this.options.client, this.run, this.capture.cursor),
              receive: (frame: CodexCaptureFrame) => {
                if (!active || this.#closed) return;
                const invalidated = this.capture.apply(frame);
                for (const thread of invalidated) {
                  if (
                    [...this.views].some((view) => view.threadId === thread) ||
                    [...this.pages.values()].some(
                      (page) => page.evidence.page.params.threadId === thread,
                    )
                  )
                    this.epochs.set(thread, (this.epochs.get(thread) ?? 0) + 1);
                  for (const [id, page] of this.pages)
                    if (page.evidence.page.params.threadId === thread)
                      this.pages.set(id, {
                        ...page,
                        evidence: immutable({ ...page.evidence, state: "stale" }),
                      });
                }
                this.publish({
                  ...this.capture.snapshot(),
                  capture: this.capture.capture,
                  freshness: "current",
                });
              },
              unavailable: () => {
                if (active && !this.#closed) this.publish({ freshness: "unavailable" });
              },
            })
          : () => {},
      );
      void connected.catch(() => {
        if (active && !this.#closed) this.publish({ freshness: "unavailable" });
      });
      this.#watch = Object.assign(token, {
        release: async () => {
          active = false;
          await (
            await connected
          )();
        },
      });
      this.publish({ freshness: "connecting" });
    } else if (!needed && this.#watch) {
      const held = this.#watch;
      this.#watch = undefined;
      this.publish({
        freshness: this.#snapshot.freshness === "unobserved" ? "unobserved" : "unavailable",
      });
      this.#cleanup = held.release();
      void this.#cleanup.then(
        () => {
          this.#cleanup = undefined;
          this.#demand();
        },
        () => {
          // Failed observer cleanup remains owned and prevents a second watch.
        },
      );
    }
  }
  read(request: PageRequest, reuse = false): Promise<CodexPageEvidence> {
    if (this.#closed) throw Error("CODEX_CLIENT_CLOSED");
    const epoch = this.epochs.get(request.params.threadId) ?? 0;
    const input = immutable(request);
    const id = key([epoch, input]);
    const cached = this.pages.get(id)?.evidence;
    if (reuse && cached?.state === "current") return Promise.resolve(cached);
    const existing = this.jobs.get(id);
    if (existing) return existing;
    if (this.jobs.size >= this.limits.maxPendingReads) throw Error("CODEX_READ_CAPACITY");
    const read = async (): Promise<CodexPage> => {
      switch (input.kind) {
        case "thread": {
          const params = input.params;
          return {
            kind: "thread",
            params,
            result: await this.options.client.thread.read.query(
              { run: this.run, params },
              { signal: this.#controller.signal },
            ),
          };
        }
        case "turns": {
          const params = input.params;
          return {
            kind: "turns",
            params,
            result: await this.options.client.thread.turns.query(
              { run: this.run, params },
              { signal: this.#controller.signal },
            ),
          };
        }
        case "items": {
          const params = input.params;
          return {
            kind: "items",
            params,
            result: await this.options.client.thread.items.query(
              { run: this.run, params },
              { signal: this.#controller.signal },
            ),
          };
        }
      }
    };
    const task: Promise<CodexPageEvidence> = Promise.resolve()
      .then(read)
      .then((page) => {
        const state: CodexPageEvidence["state"] =
          epoch === (this.epochs.get(input.params.threadId) ?? 0) && !this.#closed
            ? "current"
            : "stale";
        const evidence = immutable({ key: id, source: "native-read" as const, state, page });
        const size = new TextEncoder().encode(key(evidence)).byteLength;
        if (size > this.limits.maxPageBytes) throw Error("CODEX_PAGE_BYTES");
        const candidate = new Map(this.pages);
        candidate.delete(id);
        candidate.set(id, { evidence, bytes: size });
        const bytes = () => [...candidate.values()].reduce((sum, value) => sum + value.bytes, 0);
        while (candidate.size > this.limits.maxPages || bytes() > this.limits.maxPageBytes) {
          const victim = [...candidate.keys()].find(
            (value) => value !== id && ![...this.views].some((view) => view.protects(value)),
          );
          if (!victim) throw Error("CODEX_PAGE_CAPACITY");
          candidate.delete(victim);
        }
        this.pages.clear();
        for (const [name, value] of candidate) this.pages.set(name, value);
        this.publish();
        return evidence;
      })
      .finally(() => {
        if (this.jobs.get(id) === task) this.jobs.delete(id);
      });
    this.jobs.set(id, task);
    return task;
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#controller.abort();
    this.#demand();
    await Promise.allSettled([...this.jobs.values()]);
    await this.#cleanup;
    this.pages.clear();
  }
}

/** A native page cursor and scroll anchor belong to this view. Other views can
 * share read work/bytes without consuming this view's continuation frontier. */
type PageRequest = CodexPage extends infer Page
  ? Page extends CodexPage
    ? Omit<Page, "result">
    : never
  : never;
class CodexView implements CodexViewPort {
  readonly anchor = createAnchor();
  readonly run: RunRef;
  #listeners = new Set<() => void>();
  #pages: string[] = [];
  #snapshot: CodexViewSnapshot;
  #leases = 0;
  #closed = false;
  #initial = false;
  #pending = 0;
  #readFailure: { error: unknown } | undefined;
  #read: CodexViewSnapshot["read"] = { state: "idle" };
  constructor(
    readonly entry: Entry,
    readonly threadId: string,
  ) {
    this.run = entry.run;
    this.#snapshot = Object.freeze({
      revision: 0,
      threadId,
      entry: entry.getSnapshot(),
      pages: [],
      read: this.#read,
    });
    entry.views.add(this);
  }
  getSnapshot = (): CodexViewSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    if (this.#closed || this.#listeners.size >= 64) throw Error("CODEX_LISTENER_CAPACITY");
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  changed(): void {
    this.#snapshot = Object.freeze({
      revision: this.#snapshot.revision + 1,
      threadId: this.threadId,
      entry: this.entry.getSnapshot(),
      pages: Object.freeze(
        this.#pages.map(
          (id) =>
            this.entry.pages.get(id)?.evidence ??
            Object.freeze({ key: id, state: "evicted" as const }),
        ),
      ),
      read: this.#read,
    });
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {}
    }
    this.#initialHistory();
  }
  protects(id: string): boolean {
    if (!this.#leases) return false;
    if (this.#pages.at(-1) === id) return true;
    const anchor = this.anchor.getSnapshot().anchor;
    const page = this.entry.pages.get(id)?.evidence.page;
    if (!anchor || !page) return false;
    if (page.kind === "items")
      return page.result.data.some(
        ({ turnId, item }) => anchor.rowId === codexItemKey(this.threadId, turnId, item.id),
      );
    const turns = page.kind === "turns" ? page.result.data : page.result.thread.turns;
    return turns.some((turn) =>
      turn.items.some((item) => anchor.rowId === codexItemKey(this.threadId, turn.id, item.id)),
    );
  }
  commit(): () => void {
    if (this.#closed) throw Error("CODEX_VIEW_CLOSED");
    const release = this.entry.lease();
    this.#leases++;
    this.#initialHistory();
    let held = true;
    return () => {
      if (held) {
        held = false;
        this.#leases--;
        release();
      }
    };
  }
  #initialHistory(): void {
    if (
      !this.#closed &&
      this.#leases &&
      !this.#initial &&
      this.entry.getSnapshot().freshness === "current" &&
      this.entry.options.loadInitialHistory !== false
    ) {
      this.#initial = true;
      const captured = this.entry.getSnapshot();
      if (
        this.threadId === this.run.nativeSession &&
        captured.capture?.coverage.openedAs === "created" &&
        !captured.capture.coverage.earlierOmitted &&
        !captured.omitted
      )
        return;
      // An observed native item is already a useful recent baseline. Older
      // stored history remains an explicit per-view pagination exception.
      if (
        captured.items.some(
          (entry) => entry.threadId === this.threadId && entry.continuity === "captured",
        ) ||
        captured.turns.some(
          (entry) => entry.threadId === this.threadId && entry.turn.items.length > 0,
        )
      )
        return;
      // Only a missing initial baseline invokes passive reads, with exact
      // in-flight work/current cached pages shared by the retained entry.
      void Promise.allSettled([
        ...(captured.threads[this.threadId]
          ? []
          : [this.#readPage({ kind: "thread", params: { threadId: this.threadId } }, true)]),
        this.#readPage(
          {
            kind: "turns",
            params: {
              threadId: this.threadId,
              limit: 100,
              sortDirection: "desc",
              itemsView: "full",
            },
          },
          true,
        ),
      ]);
    }
  }
  pin(value: boolean): void {
    this.entry.pin(value);
  }
  readThread(params: Omit<ThreadReadParams, "threadId"> = {}): Promise<ThreadReadResponse> {
    return this.#readPage({ kind: "thread", params: { ...params, threadId: this.threadId } }).then(
      (value) => {
        if (value.page.kind !== "thread") throw Error("CODEX_READ_KIND");
        return value.page.result;
      },
    );
  }
  readTurns(
    params: Omit<ThreadTurnsListParams, "threadId"> = {},
  ): Promise<ThreadTurnsListResponse> {
    return this.#readPage({ kind: "turns", params: { ...params, threadId: this.threadId } }).then(
      (value) => {
        if (value.page.kind !== "turns") throw Error("CODEX_READ_KIND");
        return value.page.result;
      },
    );
  }
  readItems(
    params: Omit<ThreadItemsListParams, "threadId"> = {},
  ): Promise<ThreadItemsListResponse> {
    return this.#readPage({ kind: "items", params: { ...params, threadId: this.threadId } }).then(
      (value) => {
        if (value.page.kind !== "items") throw Error("CODEX_READ_KIND");
        return value.page.result;
      },
    );
  }
  #readPage(input: PageRequest, initial = false): Promise<CodexPageEvidence> {
    if (this.#closed || !this.#leases) throw Error("CODEX_VIEW_UNCOMMITTED");
    if (!initial && input.kind !== "thread") this.anchor.gesture();
    if (!this.#pending) this.#readFailure = undefined;
    this.#pending++;
    this.#read = { state: "pending" };
    this.changed();
    let actual: Promise<CodexPageEvidence>;
    try {
      actual = this.entry.read(input, initial);
    } catch (error) {
      actual = Promise.reject(error);
    }
    return actual
      .then(
        (value) => {
          if (!this.#closed) {
            this.#pages = [...this.#pages.filter((id) => id !== value.key), value.key].slice(
              -this.entry.limits.maxPages,
            );
          }
          return value;
        },
        (error) => {
          if (!this.#closed) this.#readFailure = { error };
          throw error;
        },
      )
      .finally(() => {
        this.#pending--;
        this.#read = this.#pending
          ? { state: "pending" }
          : this.#readFailure
            ? { state: "failed", error: this.#readFailure.error }
            : { state: "ready" };
        this.changed();
      });
  }
  close(): void {
    if (this.#leases || this.#pending) throw Error("CODEX_VIEW_PENDING");
    this.#closed = true;
    this.entry.views.delete(this);
    this.#listeners.clear();
  }
}

export class CodexWorkspace {
  readonly limits: CodexClientLimits;
  #entries = new Map<string, Entry>();
  #closed = false;
  constructor(readonly options: CodexWorkspaceOptions) {
    this.limits = Object.freeze({ ...defaults, ...options.limits });
    for (const [name, value] of Object.entries(this.limits))
      if (
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > defaults[name as keyof CodexClientLimits]
      )
        throw Error("CODEX_INVALID_LIMIT");
  }
  view(run: RunRef, threadId = run.nativeSession): CodexViewPort {
    if (this.#closed || !threadId || threadId.length > 256) throw Error("CODEX_CLIENT_CLOSED");
    const id = key(run);
    let entry = this.#entries.get(id);
    if (!entry) {
      if (this.#entries.size >= this.limits.maxEntries) {
        const victim = [...this.#entries].find(([, value]) => value.idle && !value.views.size);
        if (!victim) throw Error("CODEX_ENTRY_CAPACITY");
        void victim[1].close();
        this.#entries.delete(victim[0]);
      }
      entry = new Entry(this.options, this.limits, run);
      this.#entries.set(id, entry);
    }
    if (
      [...this.#entries.values()].reduce((sum, value) => sum + value.views.size, 0) >=
      this.limits.maxViews
    )
      throw Error("CODEX_VIEW_CAPACITY");
    return new CodexView(entry, threadId);
  }
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#entries.values()].map((entry) => entry.close()));
    this.#entries.clear();
  }
}
