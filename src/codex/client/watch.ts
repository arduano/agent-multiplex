import type { CodexCaptureCursor, CodexCaptureFrame } from "../native-contracts.js";
import type { RunRef } from "../../protocol/index.js";
import type { CodexReadClient } from "./contracts.js";

/** Callback/iterator adaptation only. The supplied observation owner handles
 * reconnect; overflow fails visibly rather than dropping native deltas. */
export function watch(
  client: CodexReadClient,
  run: RunRef,
  after?: CodexCaptureCursor,
): AsyncIterableIterator<CodexCaptureFrame> {
  const queue: CodexCaptureFrame[] = [];
  let closed = false,
    failure: unknown,
    failed = false,
    received = false;
  let waiter:
    | { resolve(value: IteratorResult<CodexCaptureFrame>): void; reject(error: unknown): void }
    | undefined;
  const held: { subscription?: { unsubscribe(): void } } = {};
  const finish = (discard = false) => {
    closed = true;
    held.subscription?.unsubscribe();
    if (discard || failed) queue.length = 0;
    if (failed) waiter?.reject(failure);
    else waiter?.resolve({ done: true, value: undefined });
    waiter = undefined;
  };
  held.subscription = client.observation.watch.subscribe(
    { run, ...(after ? { after } : {}) },
    {
      onData(value: CodexCaptureFrame) {
        if (closed) return;
        received = true;
        if (waiter) {
          const held = waiter;
          waiter = undefined;
          held.resolve({ done: false, value });
        } else if (queue.length < 32) queue.push(value);
        else {
          failed = true;
          failure = Error("CODEX_OBSERVER_TOO_SLOW");
          finish();
        }
      },
      onError(error) {
        failed = true;
        failure = error;
        finish();
      },
      onConnectionStateChange(state) {
        if (!closed && state.state === "connecting" && (received || state.error)) {
          failed = true;
          failure = state.error ?? Error("CODEX_OBSERVATION_RECONNECTING");
          finish();
        }
      },
      onComplete: () => finish(),
    },
  );
  if (closed) held.subscription.unsubscribe();
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (failed) return Promise.reject(failure);
      const value = queue.shift();
      if (value) return Promise.resolve({ done: false, value });
      if (closed) return Promise.resolve({ done: true, value: undefined });
      if (waiter) return Promise.reject(Error("CODEX_CONCURRENT_NEXT"));
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
      });
    },
    async return() {
      finish(true);
      return { done: true, value: undefined };
    },
  };
}
