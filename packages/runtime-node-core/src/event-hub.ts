import {
  type RuntimeNodeNativeEvent,
  type SessionId,
  type RuntimeNodeEventCursor,
  type RuntimeNodeEventItem,
} from "@arduano/agent-multiplex-protocol";

class AsyncQueue<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    resolve(value: IteratorResult<T>): void;
    reject(error: unknown): void;
  }> = [];
  #closed = false;
  #failure: unknown;

  public constructor(
    private readonly capacity: number,
    private readonly onOverflow: () => void,
  ) {}

  public get closed(): boolean {
    return this.#closed;
  }

  public push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else if (this.#values.length >= this.capacity) {
      this.close(new RuntimeNodeSubscriberOverflowError(this.capacity));
      this.onOverflow();
    } else this.#values.push(value);
  }

  public close(failure?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = failure;
    for (const waiter of this.#waiters.splice(0)) {
      if (failure === undefined) waiter.resolve({ value: undefined, done: true });
      else waiter.reject(failure);
    }
  }

  public async next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift();
    if (value !== undefined) return { value, done: false };
    if (this.#closed) {
      if (this.#failure !== undefined) throw this.#failure;
      return { value: undefined, done: true };
    }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }
}

export interface RuntimeNodeEventHubOptions {
  ringSize?: number;
  heartbeatMs?: number;
  subscriberBufferSize?: number;
}

export class RuntimeNodeSubscriberOverflowError extends Error {
  public constructor(public readonly capacity: number) {
    super(`runtime-node event subscriber exceeded its ${capacity}-item buffer`);
    this.name = "RuntimeNodeSubscriberOverflowError";
  }
}

export class RuntimeNodeEventHub {
  readonly #ringSize: number;
  readonly #heartbeatMs: number;
  readonly #subscriberBufferSize: number;
  readonly #rings = new Map<SessionId, RuntimeNodeNativeEvent[]>();
  readonly #listeners = new Set<(item: RuntimeNodeEventItem) => void>();

  public constructor(options: RuntimeNodeEventHubOptions = {}) {
    this.#ringSize = options.ringSize ?? 2_048;
    this.#heartbeatMs = options.heartbeatMs ?? 15_000;
    this.#subscriberBufferSize = options.subscriberBufferSize ?? 4_096;
    for (const value of [
      this.#ringSize,
      this.#heartbeatMs,
      this.#subscriberBufferSize,
    ]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError("runtime-node event-hub limits must be positive integers");
      }
    }
  }

  public publish(item: RuntimeNodeEventItem): void {
    if (item.kind === "native") {
      const ring = this.#rings.get(item.sessionId) ?? [];
      ring.push(item);
      if (ring.length > this.#ringSize) ring.splice(0, ring.length - this.#ringSize);
      this.#rings.set(item.sessionId, ring);
    }
    for (const listener of this.#listeners) listener(item);
  }

  public subscribe(
    cursor: RuntimeNodeEventCursor,
    signal?: AbortSignal,
    initialItems: readonly RuntimeNodeEventItem[] = [],
  ): AsyncIterable<RuntimeNodeEventItem> {
    let close = (): void => undefined;
    const queue = new AsyncQueue<RuntimeNodeEventItem>(
      this.#subscriberBufferSize,
      () => close(),
    );

    if (signal?.aborted) {
      queue.close();
      return queueIterable(queue);
    }

    // Durable control state (most importantly logical session bindings) must
    // precede native replay. A receiver may have lost both during an outage;
    // sending native sequence zero first would be correctly rejected as an
    // unknown session and could create a permanent reconnect loop. Keep this
    // finite replay outside the live bounded mailbox: a healthy worker with
    // more bindings than subscriberBufferSize must not overflow merely by
    // attaching a receiver.
    const replay: RuntimeNodeEventItem[] = [...initialItems];

    // A missing cursor entry means the receiver has never committed an event
    // for that session. Replaying those rings is what makes a rejected first
    // event (sequence zero) recoverable after the subscription is recreated.
    for (const [typedSessionId, ring] of this.#rings) {
      const wanted = cursor.native[typedSessionId];
      const latestEpoch = ring.at(-1)?.runtimeEpoch;
      if (!latestEpoch) continue;
      // If the runtime changed, the new epoch is an independent stream and
      // starts from its own sequence zero even while old-epoch events remain
      // in the bounded ring.
      const replayEpoch = wanted?.runtimeEpoch === latestEpoch
        ? wanted.runtimeEpoch
        : latestEpoch;
      const sameEpoch = ring.filter((event) => event.runtimeEpoch === replayEpoch);
      const first = sameEpoch[0];
      const last = sameEpoch.at(-1);
      const wantedSequence = wanted?.runtimeEpoch === replayEpoch ? wanted.sequence : -1;
      if (last && wantedSequence > last.sequence) {
        replay.push({
          kind: "nativeGap",
          sessionId: typedSessionId,
          reason: `runtime-node ring ends at sequence ${last.sequence}, behind requested sequence ${wantedSequence}`,
          recovery: "readNativeHistory",
        });
      } else if (first && wantedSequence + 1 < first.sequence) {
        replay.push({
          kind: "nativeGap",
          sessionId: typedSessionId,
          reason: `runtime-node ring begins at sequence ${first.sequence}`,
          recovery: "readNativeHistory",
        });
      } else {
        for (const event of sameEpoch) {
          if (event.sequence > wantedSequence) replay.push(event);
        }
      }
    }

    const listener = (item: RuntimeNodeEventItem) => queue.push(item);
    this.#listeners.add(listener);
    const timer = setInterval(() => {
      queue.push({ kind: "heartbeat" });
    }, this.#heartbeatMs);
    timer.unref();

    close = (): void => {
      clearInterval(timer);
      this.#listeners.delete(listener);
      signal?.removeEventListener("abort", close);
      queue.close();
    };
    signal?.addEventListener("abort", close, { once: true });

    return prefixedQueueIterable(replay, queue, close, signal);
  }
}

function prefixedQueueIterable<T>(
  prefix: readonly T[],
  queue: AsyncQueue<T>,
  close: () => void,
  signal?: AbortSignal,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let index = 0;
      return {
        next: () => {
          if (signal?.aborted) {
            close();
            return Promise.resolve({ value: undefined, done: true });
          }
          if (index < prefix.length) {
            return Promise.resolve({ value: prefix[index++]!, done: false });
          }
          return queue.next();
        },
        return: async () => {
          close();
          return { value: undefined, done: true };
        },
      };
    },
  };
}

function queueIterable<T>(
  queue: AsyncQueue<T>,
  close: () => void = () => undefined,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: () => queue.next(),
        return: async () => {
          close();
          return { value: undefined, done: true };
        },
      };
    },
  };
}
