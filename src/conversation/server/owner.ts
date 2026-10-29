import {
  canonicalJson,
  scopeKey,
  type Json,
  type RunRef,
  type SessionScope,
} from "../../protocol/index.js";
import {
  HistoryAcquisition,
  ReadBudget,
  type Frame,
  type ReadObservation,
  type ReadState,
  type ReadBudgetPort,
} from "../../history/index.js";
import type { SessionState } from "../../host/index.js";
import type { Answer, InteractionSnapshot } from "../../interactions/contracts.js";
import type { ConversationAnswer, ConversationState } from "../contracts.js";
import { SnapshotStream } from "../internal/stream.js";
const key = (run: RunRef) => canonicalJson(run as unknown as Json, 8192).json;
const equal = (a: unknown, b: unknown) =>
  canonicalJson(a as Json, 262144).json === canonicalJson(b as Json, 262144).json;
import type { ConversationOptions, HistoryBinding } from "../node-contracts.js";
type Bound = {
  history: HistoryBinding;
  reads: HistoryAcquisition;
};
/** Read coordination and observation only; not a native/effect/session owner. */
export class ConversationFeature<Command, Reply extends Answer = Answer> {
  readonly #bindings = new Map<
    string,
    {
      run: RunRef;
      promise: Promise<Bound>;
      bound?: Bound;
    }
  >();
  readonly #bindingChanges = new Set<() => void>();
  readonly #actual = new Set<Promise<unknown>>();
  readonly #observers = new Set<{
    return(): Promise<IteratorResult<unknown>>;
  }>();
  readonly #budget: ReadBudgetPort;
  readonly #maximum: number;
  readonly #wait: number;
  #closed = false;
  #closing: Promise<void> | undefined;
  #closeDone = false;
  constructor(private readonly options: ConversationOptions<Command, Reply>) {
    this.#budget = options.budget ?? new ReadBudget(2);
    this.#maximum = options.maxBindings ?? 256;
    this.#wait = options.waitMs ?? 10000;
    if (
      !Number.isSafeInteger(this.#maximum) ||
      this.#maximum < 1 ||
      this.#maximum > 4096 ||
      !Number.isSafeInteger(this.#wait) ||
      this.#wait < 0 ||
      this.#wait > 30000
    )
      throw new Error("Invalid conversation bounds");
  }
  #state(run: RunRef): SessionState<unknown, unknown> {
    if (this.#closed) throw new Error("Conversation closed");
    const state = this.options.lifecycle.state(run.scope);
    if (state.generation !== run.generation || state.nativeSession !== run.nativeSession)
      throw new Error("Conversation run fenced");
    return state;
  }
  #bindingKey(run: RunRef, state = this.#state(run)): string {
    return JSON.stringify([
      key(run),
      state.phase === "stopped" || state.phase === "archived" ? "cold" : "live",
    ]);
  }
  #bind(run: RunRef, renew = false): Promise<Bound> {
    const state = this.#state(run),
      id = this.#bindingKey(run, state);
    for (const [prior, entry] of this.#bindings)
      if (prior !== id && key(entry.run) === key(run)) entry.bound?.reads.retire();
    const existing = this.#bindings.get(id);
    const expired =
      renew && existing?.bound?.history.resource && !existing.bound.history.resource.usable()
        ? existing.bound
        : undefined;
    if (existing && !expired) return existing.promise;
    if (expired) {
      if (expired.reads.getState().state === "pending")
        throw new Error("Conversation read remains owned");
      expired.reads.retire();
      this.#bindings.delete(id);
    }
    if (this.#bindings.size >= this.#maximum) throw new Error("Conversation binding capacity");
    const entry: {
      run: RunRef;
      promise: Promise<Bound>;
      bound?: Bound;
    } = { run: structuredClone(run), promise: undefined! };
    const acquire = async () => {
      if (expired) await expired.history.resource!.retire();
      const history = await this.options.history(run, state);
      this.#state(run);
      if (
        key(history.window.scope.run) !== key(run) ||
        !equal(history.window.scope, history.port.scope)
      )
        throw new Error("Conversation history scope fenced");
      const port = {
        scope: history.port.scope,
        mode: history.port.mode,
        read: async (input: Parameters<typeof history.port.read>[0], assertCurrent: () => void) => {
          const current = () => {
            assertCurrent();
            if (this.#bindingKey(run) !== id) throw new Error("Conversation read mode fenced");
          };
          current();
          const page = await history.port.read(input, current);
          current();
          return page;
        },
      };
      const reads = new HistoryAcquisition(history.window, port, this.#budget, { count: 100 });
      const bound = { history, reads };
      entry.bound = bound;
      return bound;
    };
    // Selecting an already-retained live stream performs no native I/O.
    // Cold helper acquisition and every actual page share the read budget.
    entry.promise =
      state.phase === "stopped" || state.phase === "archived"
        ? this.#budget.run(acquire)
        : Promise.resolve().then(acquire);
    this.#bindings.set(id, entry);
    this.#actual.add(entry.promise);
    void entry.promise
      .then(() => {
        for (const notify of this.#bindingChanges) notify();
      })
      .catch(() => {});
    void entry.promise
      .finally(() => {
        this.#actual.delete(entry.promise);
      })
      .catch(() => {
        if (this.#bindings.get(id) === entry) this.#bindings.delete(id);
      });
    return entry.promise;
  }
  state(scope: SessionScope): ConversationState {
    if (this.#closed) throw new Error("Conversation closed");
    const state = this.options.lifecycle.state(scope);
    const phase =
      state.phase === "running"
        ? "running"
        : state.phase === "stopped"
          ? "stopped"
          : state.phase === "archived"
            ? "archived"
            : state.phase === "stopping"
              ? "stopping"
              : state.phase === "preparing" || state.phase === "opening"
                ? "starting"
                : "unknown";
    const run =
      state.nativeSession && state.generation > 0 && !["preparing", "opening"].includes(state.phase)
        ? { scope: state.scope, generation: state.generation, nativeSession: state.nativeSession }
        : null;
    return {
      scope: { ...state.scope },
      run,
      phase,
      activity: state.activity,
      selection: state.selection as Json,
    };
  }
  #observe<T>(
    snapshot: () => T,
    subscribe: (listener: () => void) => () => void,
  ): SnapshotStream<T> {
    if (this.#closed) throw new Error("Conversation closed");
    const stream = new SnapshotStream<T>();
    this.#observers.add(stream);
    let previous: T;
    const publish = () => {
      try {
        const value = snapshot();
        if (previous === undefined || !equal(previous, value)) {
          previous = value;
          stream.push(value);
        }
      } catch (error) {
        stream.fail(error);
      }
    };
    const release = subscribe(publish);
    stream.cleanup(() => {
      release();
      this.#observers.delete(stream);
    });
    publish();
    return stream;
  }
  stateWatch(scope: SessionScope): AsyncIterableIterator<ConversationState> {
    scopeKey(scope);
    return this.#observe(
      () => this.state(scope),
      (listener) => this.options.lifecycle.subscribe(listener),
    );
  }
  historyWatch(run: RunRef): AsyncIterableIterator<Frame> {
    this.#state(run);
    let live = true,
      token = 0,
      id: string | undefined,
      selected: Bound | undefined,
      releaseHistory: (() => void) | undefined;
    let heldBinding: Promise<Bound> | undefined;
    const stream = new SnapshotStream<Frame>(8, () => selected!.history.window.frame());
    this.#observers.add(stream);
    const attach = () => {
      if (!live) return;
      try {
        const current = this.#bindingKey(run),
          binding = this.#bind(run);
        if (current === id && binding === heldBinding) return;
        id = current;
        heldBinding = binding;
        const own = ++token;
        releaseHistory?.();
        releaseHistory = undefined;
        void heldBinding!
          .then((bound) => {
            if (!live || own !== token) return;
            selected = bound;
            const source = bound.history.window.subscribe();
            releaseHistory = () => {
              void source.return();
            };
            void (async () => {
              try {
                for await (const frame of source) {
                  if (!live || own !== token) break;
                  stream.push(frame);
                }
              } catch (error) {
                if (live && own === token) stream.fail(error);
              }
            })();
            // A fresh Create's positive empty boundary needs no native history RPC.
            if (bound.history.window.getSnapshot().olderEdge.state === "unknown")
              void bound.reads.baseline().settled.catch(() => {});
          })
          .catch((error) => {
            if (live && own === token) stream.fail(error);
          });
      } catch (error) {
        stream.fail(error);
      }
    };
    const releaseState = this.options.lifecycle.subscribe(attach);
    this.#bindingChanges.add(attach);
    stream.cleanup(() => {
      live = false;
      token++;
      releaseState();
      this.#bindingChanges.delete(attach);
      releaseHistory?.();
      this.#observers.delete(stream);
    });
    attach();
    return stream;
  }
  interactionsWatch(run: RunRef): AsyncIterableIterator<InteractionSnapshot> {
    this.#state(run);
    const owner = this.options.interactions(run);
    if (owner)
      return this.#observe(
        () => {
          this.#state(run);
          const snapshot = owner.getSnapshot();
          if (key(snapshot.run) !== key(run)) throw new Error("Conversation interaction fenced");
          return snapshot;
        },
        (listener) => owner.subscribe(listener),
      );
    const stream = new SnapshotStream<InteractionSnapshot>();
    this.#observers.add(stream);
    stream.cleanup(() => {
      this.#observers.delete(stream);
    });
    void this.#bind(run).then(
      (bound) =>
        stream.push({
          run,
          attachment: bound.history.window.scope.attachment,
          revision: 0,
          baseline: "partial",
          issue: null,
          items: [],
        }),
      (error) => stream.fail(error),
    );
    return stream;
  }
  async baseline(run: RunRef): Promise<ReadObservation> {
    const bound = await this.#bind(run, true),
      handle = bound.reads.baseline(),
      state = bound.reads.getState();
    // A user action can use07's one explicit repeatable retry. Reconnect and
    // the automatic unknown-boundary path never take this branch.
    return (
      handle.outcome?.state === "failed" && state.state === "settled" && state.retryable
        ? bound.reads.retry(handle)
        : handle
    ).wait(this.#wait);
  }
  async older(run: RunRef, cursor: string): Promise<ReadObservation> {
    const bound = await this.#bind(run, true);
    // A renewed helper has a new attachment/frontier. Never replay an old
    // single-use native cursor into that new context; its observer obtains
    // the normal baseline and exposes the new public frontier.
    if (bound.history.window.getSnapshot().olderEdge.state === "unknown") {
      void bound.reads.baseline().settled.catch(() => {});
      return { state: "expired" };
    }
    return bound.reads.older(cursor).wait(this.#wait);
  }
  async readState(run: RunRef): Promise<ReadState> {
    return (await this.#bind(run)).reads.getState();
  }
  answer(input: ConversationAnswer<Reply>) {
    if (this.#closed) throw new Error("Conversation closed");
    return this.options.lifecycle.command(
      input.reference.run.scope,
      input.id,
      this.options.encodeAnswer({ reference: input.reference, answer: input.answer }),
      input.reference.run,
    );
  }
  original(scope: SessionScope, id: string) {
    return this.options.lifecycle.original(scope, id);
  }
  /** Explicit projection retirement; never closes a native agent or read helper. */
  forget(run: RunRef): void {
    const selected = [...this.#bindings].filter(([, entry]) => key(entry.run) === key(run));
    if (
      selected.some(
        ([, entry]) =>
          !entry.bound ||
          entry.bound.reads.getState().state === "pending" ||
          entry.bound.history.window.subscriberCount,
      )
    )
      throw new Error("Conversation observation/read retained");
    for (const [id, entry] of selected) {
      entry.bound!.reads.retire();
      this.#bindings.delete(id);
    }
  }
  readiness() {
    return this.#actual.size || this.#budget.active || (this.#closing && !this.#closeDone)
      ? { ready: false as const, reasons: ["Conversation read or observer cleanup remains owned"] }
      : { ready: true as const };
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    if (!this.readiness().ready) throw new Error("Conversation read remains owned");
    this.#closed = true;
    this.#closing = (async () => {
      await Promise.all([...this.#observers].map((value) => value.return()));
      for (const entry of this.#bindings.values()) entry.bound?.reads.retire();
      this.#bindings.clear();
      this.#bindingChanges.clear();
      this.#closeDone = true;
    })();
    void this.#closing.catch(() => {});
    return this.#closing;
  }
}
