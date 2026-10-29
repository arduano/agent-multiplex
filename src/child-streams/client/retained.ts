import { createAnchor } from "../../client/anchor.js";
import type {
  AnchorPort,
  ObservationConnector,
  TranscriptSnapshot,
} from "../../client/contracts.js";
import { applyFrame, historyScopeKey, type HistoryScope } from "../../history/index.js";
import { canonicalJson, scopeKey, type Json, type RunRef } from "../../protocol/index.js";
import type { ChildSnapshot, ChildStreamFeed, ChildStreamView } from "../contracts.js";
export type * from "../contracts.js";

const runKey = (run: RunRef) => canonicalJson(run as unknown as Json, 8192).json;
const check = (condition: unknown, code: string): void => {
  if (!condition) throw Error(code);
};
function immutableScope(value: HistoryScope): HistoryScope {
  historyScopeKey(value);
  const result = structuredClone(value);
  Object.freeze(result.run.scope);
  Object.freeze(result.run);
  return Object.freeze(result);
}
type Entry = {
  snapshot: ChildSnapshot;
  anchor: AnchorPort;
  views: number;
  listeners: Set<() => void>;
  release?: () => void | Promise<void>;
  token: number;
};
/** Browser residency/viewport owner only. Transport recovery is the supplied
 * observation connector; transcript reduction remains the history reducer. */
export class RetainedChildStreams {
  readonly #entries = new Map<string, Entry>();
  readonly #cleanup = new Set<Promise<void>>();
  #root: string | undefined;
  #closed = false;
  #observers = 0;
  #views = 0;
  constructor(
    readonly feed: ChildStreamFeed,
    readonly observations: ObservationConnector,
    readonly maximum = 32,
  ) {
    check(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 64, "CHILD_CAPACITY");
  }
  selectRoot(run: RunRef): void {
    check(!this.#closed, "CLOSED");
    this.#root = runKey(run);
    for (const entry of this.#entries.values()) {
      if (
        scopeKey(entry.snapshot.scope.run.scope) === scopeKey(run.scope) &&
        runKey(entry.snapshot.scope.run) !== this.#root
      ) {
        this.#disconnect(entry);
        this.#publish(entry, { retired: true, freshness: "unavailable" });
      } else this.#refresh(entry);
    }
  }
  inventory(run: RunRef): Promise<readonly HistoryScope[]> {
    check(!this.#closed && this.#root === runKey(run), "ROOT_FENCED");
    return this.feed.inventory(structuredClone(run));
  }
  view(scope: HistoryScope): ChildStreamView {
    check(!this.#closed && this.#root === runKey(scope.run), "ROOT_FENCED");
    const key = historyScopeKey(scope);
    let entry = this.#entries.get(key);
    if (!entry) {
      if (this.#entries.size >= this.maximum) {
        const victim = [...this.#entries].find(
          ([, value]) => !value.views && !value.snapshot.pinned && !value.listeners.size,
        );
        check(victim, "CHILD_CAPACITY");
        this.#disconnect(victim![1]);
        this.#entries.delete(victim![0]);
      }
      entry = {
        snapshot: Object.freeze({
          scope: immutableScope(scope),
          history: null,
          freshness: "unobserved",
          pinned: false,
          retired: false,
          revision: 0,
          read: null,
        }),
        anchor: createAnchor(),
        views: 0,
        listeners: new Set(),
        token: 0,
      };
      this.#entries.set(key, entry);
    }
    const selected = entry;
    const current = () => {
      check(
        !this.#closed &&
          this.#entries.get(key) === selected &&
          !selected.snapshot.retired &&
          this.#root === runKey(selected.snapshot.scope.run),
        "ROOT_FENCED",
      );
    };
    const view: Omit<ChildStreamView, "transcript"> = {
      anchor: selected.anchor,
      getSnapshot: () => selected.snapshot,
      subscribe: (listener) => {
        check(
          !this.#closed && this.#entries.get(key) === selected && this.#observers < 128,
          "OBSERVER_CAPACITY",
        );
        this.#observers++;
        const notify = () => listener();
        selected.listeners.add(notify);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          selected.listeners.delete(notify);
          this.#observers--;
        };
      },
      commit: () => {
        current();
        check(this.#views < 64, "VIEW_CAPACITY");
        selected.views++;
        this.#views++;
        this.#refresh(selected);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          selected.views--;
          this.#views--;
          this.#refresh(selected);
        };
      },
      pin: (value) => {
        current();
        this.#publish(selected, { pinned: value });
        this.#refresh(selected);
      },
      baseline: () => {
        current();
        if (selected.snapshot.history?.rows.length) selected.anchor.gesture();
        return this.#read(selected, "baseline", null, () =>
          this.feed.baseline(selected.snapshot.scope),
        );
      },
      older: (cursor) => {
        current();
        selected.anchor.gesture();
        return this.#read(selected, "older", cursor, () =>
          this.feed.older(selected.snapshot.scope, cursor),
        );
      },
    };
    let previous: ChildSnapshot | undefined, projected: TranscriptSnapshot;
    return {
      ...view,
      transcript: {
        anchor: view.anchor,
        subscribe: view.subscribe,
        commit: view.commit,
        baseline: view.baseline,
        older: view.older,
        getSnapshot: () => {
          const snapshot = selected.snapshot;
          if (snapshot !== previous) {
            previous = snapshot;
            const history = snapshot.history;
            projected = Object.freeze({
              revision: snapshot.revision,
              history: Object.freeze({
                current: history,
                rows: history?.rows ?? [],
                residencyOmitted: history?.residencyOmitted ?? false,
                origins: Object.freeze(
                  Object.fromEntries(
                    (history?.rows ?? []).map((row) => [
                      row.id,
                      Object.freeze({ scope: history!.scope, generation: history!.generation }),
                    ]),
                  ),
                ),
              }),
              freshness: snapshot.freshness,
              retired: snapshot.retired,
              read: snapshot.read,
              working:
                !snapshot.retired &&
                snapshot.freshness === "current" &&
                history?.activity.state === "working",
            });
          }
          return projected;
        },
      },
    };
  }
  #read(
    entry: Entry,
    kind: "baseline" | "older",
    cursor: string | null,
    call: () => Promise<import("../../history/index.js").ReadObservation>,
  ) {
    check(entry.snapshot.read?.state !== "pending", "CHILD_READ_PENDING");
    this.#publish(entry, { read: { kind, cursor, state: "pending" } });
    return Promise.resolve()
      .then(call)
      .then(
        (outcome) => {
          if (!this.#closed && !entry.snapshot.retired)
            this.#publish(entry, { read: { kind, cursor, state: "settled", outcome } });
          return outcome;
        },
        (error) => {
          if (!this.#closed && !entry.snapshot.retired)
            this.#publish(entry, {
              read: {
                kind,
                cursor,
                state: "settled",
                outcome: { state: "failed", code: "READ_UNAVAILABLE" },
              },
            });
          throw error;
        },
      );
  }
  #publish(entry: Entry, patch: Partial<Omit<ChildSnapshot, "revision" | "scope">>): void {
    entry.snapshot = Object.freeze({
      ...entry.snapshot,
      ...patch,
      revision: entry.snapshot.revision + 1,
    });
    for (const listener of entry.listeners)
      try {
        listener();
      } catch {
        /* A view does not own the stream. */
      }
  }
  #disconnect(entry: Entry): void {
    entry.token++;
    const release = entry.release;
    delete entry.release;
    if (release) {
      let work: Promise<void>;
      try {
        work = Promise.resolve(release());
      } catch (error) {
        work = Promise.reject(error);
      }
      this.#cleanup.add(work);
      void work.then(
        () => this.#cleanup.delete(work),
        () => {},
      );
    }
  }
  #refresh(entry: Entry): void {
    if (this.#closed || entry.snapshot.retired || (!entry.views && !entry.snapshot.pinned)) {
      this.#disconnect(entry);
      return;
    }
    if (entry.release) return;
    const token = ++entry.token,
      scope = entry.snapshot.scope;
    let active = true;
    const connected = Promise.resolve().then(() =>
      active
        ? this.observations.connect({
            key: `child:${historyScopeKey(scope)}`,
            open: (signal) => this.feed.watch(scope, signal),
            receive: (frame) => {
              if (this.#closed || token !== entry.token || entry.snapshot.retired) return;
              const incoming = frame.kind === "snapshot" ? frame.snapshot.scope : frame.scope;
              check(historyScopeKey(incoming) === historyScopeKey(scope), "CHILD_FRAME_FENCED");
              const result = applyFrame(entry.snapshot.history ?? undefined, frame);
              check(result.status !== "needsSnapshot", "CHILD_SNAPSHOT_REQUIRED");
              this.#publish(entry, { history: result.snapshot ?? null, freshness: "current" });
            },
            unavailable: () => {
              if (!this.#closed && token === entry.token)
                this.#publish(entry, { freshness: "unavailable" });
            },
          })
        : () => {},
    );
    entry.release = () => {
      active = false;
      return connected.then((release) => release());
    };
  }
  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      for (const entry of this.#entries.values()) this.#disconnect(entry);
    }
    await Promise.all([...this.#cleanup]);
  }
}
