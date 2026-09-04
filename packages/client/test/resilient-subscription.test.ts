import { describe, expect, it } from "vitest";

import {
  startResilientSubscription,
  SubscriptionBufferOverflowError,
  type SubscriptionCallbacks,
  type SubscriptionProcedure,
} from "../src/resilient-subscription.js";

describe("resilient subscriptions", () => {
  it("fails explicitly instead of dropping when the consumer buffer fills", async () => {
    const procedure = new NumberSubscription();
    const gate = deferred<void>();
    const handle = startResilientSubscription({
      procedure,
      input: () => undefined,
      maxPendingItems: 1,
      onData: () => gate.promise,
    });

    procedure.emit(1);
    procedure.emit(2);

    await expect(handle.done).rejects.toBeInstanceOf(
      SubscriptionBufferOverflowError,
    );
    gate.resolve();
  });
});

class NumberSubscription implements SubscriptionProcedure<void, number> {
  private callbacks: SubscriptionCallbacks<number> | undefined;

  subscribe(
    _input: void,
    callbacks: SubscriptionCallbacks<number>,
  ): { unsubscribe(): void } {
    this.callbacks = callbacks;
    return { unsubscribe: () => undefined };
  }

  emit(value: number): void {
    this.callbacks?.onData(value);
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: [T] extends [void]
    ? (value?: T | PromiseLike<T>) => void
    : (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve } as {
    readonly promise: Promise<T>;
    readonly resolve: [T] extends [void]
      ? (value?: T | PromiseLike<T>) => void
      : (value: T | PromiseLike<T>) => void;
  };
}
