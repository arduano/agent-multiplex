import { canonicalJson, type Json, type RunRef } from "../../protocol/index.js";
import {
  HistoryAcquisition,
  ReadBudget,
  historyScopeKey,
  type Cursor,
  type HistoryAcquisitionPort,
  type Frame,
  type HistoryScope,
  type HistoryFeedSubscription,
  type HistoryReadHandle,
} from "../../history/index.js";
import type { HostChildPort, ChildStreamService } from "../node-contracts.js";
type Bound = {
  scope: HistoryScope;
  binding: ReturnType<HostChildPort["bind"]>;
  reads: HistoryAcquisitionPort;
  watchers: Set<HistoryFeedSubscription>;
  actual: Set<Promise<unknown>>;
  retired: boolean;
  release?: () => void;
};
const check = (value: unknown, code: string): void => {
  if (!value) throw Error(code);
};
const sameRun = (a: RunRef, b: RunRef) =>
  canonicalJson(a as unknown as Json, 8192).json === canonicalJson(b as unknown as Json, 8192).json;
/** Coordinates reads of existing native child windows, never native lifetimes. */
export class ChildStreamOwner implements ChildStreamService {
  readonly #bindings = new Map<string, Bound>();
  readonly #actual = new Set<Promise<unknown>>();
  readonly #budget = new ReadBudget(2);
  readonly #unsubscribe: () => void;
  #closed = false;
  #watchers = 0;
  #cleanupFailure: Error | undefined;
  constructor(
    private readonly source: HostChildPort,
    private readonly maximum = 32,
    private readonly waitMs = 250,
  ) {
    check(
      Number.isSafeInteger(maximum) &&
        maximum > 0 &&
        maximum <= 64 &&
        Number.isSafeInteger(waitMs) &&
        waitMs >= 0 &&
        waitMs <= 30000,
      "CHILD_LIMIT",
    );
    this.#unsubscribe = source.subscribe(() => {
      for (const bound of this.#bindings.values())
        try {
          source.assertRun(bound.scope.run);
        } catch {
          this.#retire(bound);
        }
    });
  }
  inventory(run: RunRef): readonly HistoryScope[] {
    check(!this.#closed && !this.#cleanupFailure, "CLOSED");
    this.source.assertRun(run);
    const scopes = this.source.inventory(run);
    check(
      scopes.length <= 64 && new Set(scopes.map(historyScopeKey)).size === scopes.length,
      "CHILD_INVENTORY_BOUND",
    );
    for (const scope of scopes) check(sameRun(scope.run, run), "CHILD_RUN_FENCED");
    return structuredClone(scopes);
  }
  #bound(scope: HistoryScope): Bound {
    const key = historyScopeKey(scope);
    check(
      this.inventory(scope.run).some((value) => historyScopeKey(value) === key),
      "CHILD_UNPROVED",
    );
    const known = this.#bindings.get(key);
    if (known) {
      check(!known.retired, "CHILD_RETIRED");
      return known;
    }
    if (this.#bindings.size >= this.maximum) {
      const victim = [...this.#bindings].find(
        ([, value]) => !value.watchers.size && !value.actual.size,
      );
      check(victim, "CHILD_CAPACITY");
      this.#retire(victim![1]);
      check(!this.#cleanupFailure, "CHILD_RELEASE_UNPROVED");
    }
    const binding = this.source.bind(structuredClone(scope));
    let reads: HistoryAcquisitionPort;
    try {
      check(
        historyScopeKey(binding.window.scope) === key &&
          historyScopeKey(binding.port.scope) === key,
        "CHILD_BINDING_FENCED",
      );
      reads = new HistoryAcquisition(binding.window, binding.port, this.#budget, { count: 100 });
    } catch (error) {
      try {
        binding.release?.();
      } catch (cause) {
        this.#cleanupFailure = new Error("Child stream release unproved", { cause });
      }
      throw error;
    }
    const bound: Bound = {
      scope: binding.window.scope,
      binding,
      reads,
      watchers: new Set(),
      actual: new Set(),
      retired: false,
      ...(binding.release ? { release: () => binding.release!() } : {}),
    };
    this.#bindings.set(key, bound);
    return bound;
  }
  watch(scope: HistoryScope, cursor?: Cursor): AsyncIterableIterator<Frame> {
    const bound = this.#bound(scope);
    check(this.#watchers < 128, "CHILD_OBSERVER_CAPACITY");
    const stream = bound.binding.window.subscribe(cursor);
    bound.watchers.add(stream);
    this.#watchers++;
    let active = true;
    const close = async () => {
      if (active) {
        active = false;
        if (bound.watchers.delete(stream)) this.#watchers--;
        await stream.return();
      }
    };
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => {
        if (!active) return { done: true, value: undefined };
        try {
          this.source.assertRun(scope.run);
          const value = await stream.next();
          this.source.assertRun(scope.run);
          return value;
        } catch (error) {
          await close();
          throw error;
        }
      },
      return: async () => {
        await close();
        return { done: true, value: undefined };
      },
    };
  }
  #read(bound: Bound, handle: HistoryReadHandle) {
    const actual = handle.settled;
    if (!bound.actual.has(actual)) {
      bound.actual.add(actual);
      this.#actual.add(actual);
      void actual
        .finally(() => {
          bound.actual.delete(actual);
          this.#actual.delete(actual);
          if (bound.retired && !bound.actual.size) this.#release(bound);
        })
        .catch(() => {});
    }
    return handle.wait(this.waitMs);
  }
  baseline(scope: HistoryScope) {
    const bound = this.#bound(scope);
    return this.#read(bound, bound.reads.baseline());
  }
  older(scope: HistoryScope, cursor: string) {
    const bound = this.#bound(scope);
    return this.#read(bound, bound.reads.older(cursor));
  }
  #retire(bound: Bound): void {
    if (bound.retired) return;
    bound.retired = true;
    bound.reads.retire();
    for (const stream of bound.watchers) {
      this.#watchers--;
      void stream.return();
    }
    bound.watchers.clear();
    if (!bound.actual.size) this.#release(bound);
  }
  #release(bound: Bound): void {
    try {
      bound.release?.();
      delete bound.release;
      const key = historyScopeKey(bound.scope);
      if (this.#bindings.get(key) === bound) this.#bindings.delete(key);
    } catch (cause) {
      this.#cleanupFailure ??= new Error("Child stream release unproved", { cause });
    }
  }
  readiness() {
    return this.#actual.size || this.#cleanupFailure
      ? { ready: false as const, reasons: ["Child history read or release remains owned"] }
      : { ready: true as const };
  }
  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#unsubscribe();
      for (const bound of this.#bindings.values()) this.#retire(bound);
    }
    await Promise.all([...this.#actual]);
    if (this.#cleanupFailure) throw this.#cleanupFailure;
  }
}
