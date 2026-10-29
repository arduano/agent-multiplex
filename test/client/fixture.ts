import { HistoryWindow, type Frame, type HistoryRecord } from "../../src/history/index.js";
import type { InteractionSnapshot } from "../../src/interactions/contracts.js";
import {
  scopeKey,
  type Receipt,
  type RunRef,
  type SessionScope,
} from "../../src/protocol/index.js";
import type {
  ClientPersistence,
  Command,
  ObservationConnector,
  PersistedEntry,
  SessionFeed,
  SessionState,
} from "../../src/client/index.js";

export const scope: SessionScope = {
  connection: "connection",
  principal: "principal",
  host: "host",
  session: "session",
};
export const runFor = (value: SessionScope = scope, generation = 1): RunRef => ({
  scope: value,
  generation,
  nativeSession: `native-${value.session}`,
});
export const runKey = (run: RunRef) =>
  JSON.stringify([scopeKey(run.scope), run.generation, run.nativeSession]);
export const command = (id: string, value = scope): Command => ({
  id,
  kind: "send",
  run: runFor(value),
  payload: { text: id },
  optimisticText: id,
});
export const receipt = (
  id: string,
  state: "succeeded" | "refused" | "unknown" = "succeeded",
  value = scope,
): Receipt => ({
  scope: value,
  id,
  requestHash: "a".repeat(64),
  ...(state === "unknown"
    ? { revision: 1, state, result: null }
    : { revision: 2, state, result: { accepted: state === "succeeded" } }),
});
export const row = (id: string): HistoryRecord => ({
  id,
  kind: "assistant",
  lifecycle: "completed",
  body: { kind: "complete", text: id, evidence: "native" },
  native: {},
});
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export async function until(ready: () => boolean): Promise<void> {
  for (let count = 0; count < 200; count++) {
    if (ready()) return;
    await Promise.resolve();
  }
  throw new Error("Fixture did not settle");
}
class Topic<T> {
  latest: T;
  listeners = new Set<(value: T) => void>();
  constructor(value: T) {
    this.latest = value;
  }
  publish(value: T) {
    this.latest = value;
    for (const receive of this.listeners) receive(value);
  }
  stream(): AsyncIterableIterator<T> {
    const queue = [this.latest];
    let closed = false,
      waiting: ((value: IteratorResult<T>) => void) | undefined;
    const receive = (value: T) => {
      if (closed) return;
      if (waiting) {
        const accept = waiting;
        waiting = undefined;
        accept({ done: false, value });
      } else queue.push(value);
    };
    this.listeners.add(receive);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => {
        if (closed) return Promise.resolve({ done: true, value: undefined });
        const next = queue.shift();
        return next !== undefined
          ? Promise.resolve({ done: false, value: next })
          : new Promise((resolve) => {
              waiting = resolve;
            });
      },
      return: async () => {
        closed = true;
        this.listeners.delete(receive);
        waiting?.({ done: true, value: undefined });
        return { done: true, value: undefined };
      },
    };
  }
}
export class Persistence implements ClientPersistence {
  records = new Map<string, PersistedEntry>();
  saves = 0;
  loads = 0;
  barrier: Promise<void> | undefined;
  fail = false;
  async load(maximum: number) {
    this.loads++;
    return [...this.records.values()].slice(0, maximum);
  }
  async save(value: PersistedEntry) {
    this.saves++;
    if (this.barrier) await this.barrier;
    if (this.fail) throw Error("Private storage failure");
    this.records.set(scopeKey(value.scope), structuredClone(value));
  }
}
export class Connector implements ObservationConnector {
  opened = 0;
  closed = 0;
  cleanupBarrier: Promise<void> | undefined;
  connections = new Set<{ offline(): Promise<void>; online(): void; key: string }>();
  connect<T>(
    input: Readonly<{
      key: string;
      receive(value: T): void;
      open(signal: AbortSignal): AsyncIterable<T>;
      unavailable(): void;
    }>,
  ): () => Promise<void> {
    let active = true,
      abort: AbortController,
      iterator: AsyncIterator<T>;
    let generation = 0;
    const online = () => {
      if (!active) return;
      const current = ++generation;
      abort = new AbortController();
      iterator = input.open(abort.signal)[Symbol.asyncIterator]();
      this.opened++;
      void (async () => {
        try {
          while (active && current === generation) {
            const value = await iterator.next();
            if (value.done) return;
            if (active && current === generation) input.receive(value.value);
          }
        } catch {
          if (active && current === generation) input.unavailable();
        }
      })();
    };
    const offline = async () => {
      generation++;
      abort?.abort();
      input.unavailable();
      await iterator?.return?.();
    };
    const connection = { key: input.key, offline, online };
    this.connections.add(connection);
    online();
    return async () => {
      active = false;
      generation++;
      abort.abort();
      await iterator.return?.();
      this.connections.delete(connection);
      this.closed++;
      if (this.cleanupBarrier) await this.cleanupBarrier;
    };
  }
  async offline() {
    await Promise.all([...this.connections].map((value) => value.offline()));
  }
  online() {
    for (const connection of this.connections) connection.online();
  }
}
export class Feed implements SessionFeed {
  states = new Map<string, Topic<SessionState>>();
  windows = new Map<string, HistoryWindow>();
  dispatches: { scope: SessionScope; command: Command }[] = [];
  originalReads: string[] = [];
  baselineReads = 0;
  olderReads = 0;
  dispatchResult: ((scope: SessionScope, command: Command) => Promise<Receipt>) | undefined;
  originalResult: Receipt | null = null;
  stateTopic(value = scope) {
    const key = scopeKey(value);
    let topic = this.states.get(key);
    if (!topic) {
      topic = new Topic<SessionState>({
        scope: value,
        run: runFor(value),
        phase: "running",
        activity: "idle",
        selection: { model: "scripted" },
      });
      this.states.set(key, topic);
    }
    return topic;
  }
  window(run = runFor()) {
    const key = runKey(run);
    let owner = this.windows.get(key);
    if (!owner) {
      owner = new HistoryWindow({
        run,
        attachment: `capture-${run.generation}`,
        stream: run.nativeSession,
      });
      this.windows.set(key, owner);
    }
    return owner;
  }
  state(value: SessionScope): AsyncIterable<SessionState> {
    return this.stateTopic(value).stream();
  }
  history(run: RunRef): AsyncIterable<Frame> {
    return this.window(run).subscribe();
  }
  interactions(run: RunRef): AsyncIterable<InteractionSnapshot> {
    return new Topic<InteractionSnapshot>({
      run,
      attachment: "callback",
      revision: 0,
      baseline: "complete",
      issue: null,
      items: [],
    }).stream();
  }
  async baseline() {
    this.baselineReads++;
    return { state: "ready" as const };
  }
  async older() {
    this.olderReads++;
    return { state: "ready" as const };
  }
  async dispatch(value: SessionScope, input: Command) {
    this.dispatches.push({ scope: structuredClone(value), command: structuredClone(input) });
    return this.dispatchResult
      ? this.dispatchResult(value, input)
      : receipt(input.id, "succeeded", value);
  }
  async original(_value: SessionScope, id: string) {
    this.originalReads.push(id);
    return this.originalResult;
  }
}
export const fixture = () => ({
  persistence: new Persistence(),
  observations: new Connector(),
  feed: new Feed(),
});
