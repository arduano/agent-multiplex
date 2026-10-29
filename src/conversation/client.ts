import type { SessionFeed } from "../client/contracts.js";
import type { ConversationFeedOptions, StreamSource, SubscriptionStarter } from "./contracts.js";
import { SnapshotStream } from "./internal/stream.js";
/** Browser tRPC subscribe bridge. Frame streams provide their own snapshot
 * overflow replacement; this adapter never silently drops incremental data. */
export function subscriptionStream<T>(
  start: SubscriptionStarter<T>,
  unavailable?: () => void,
): AsyncIterableIterator<T> {
  const stream = new SnapshotStream<T>(64, () => {
    throw new Error("Conversation consumer too slow");
  });
  const subscription = start({
    onData: (value) => {
      try {
        stream.push(value);
      } catch (error) {
        stream.fail(error);
      }
    },
    onError: (error) => stream.fail(error),
    onComplete: () => stream.complete(),
    onConnectionStateChange: (value) => {
      if (value.state === "connecting") unavailable?.();
    },
  });
  stream.cleanup(() => subscription.unsubscribe());
  return stream;
}
function observe<T>(source: () => StreamSource<T>, signal: AbortSignal): AsyncIterableIterator<T> {
  let closed = false,
    completion: (() => void) | undefined,
    closing: Promise<void> | undefined;
  const finished = new Promise<IteratorResult<T>>((resolve) => {
    completion = () => resolve({ done: true, value: undefined });
  });
  const opened = Promise.resolve()
    .then(() => (closed ? undefined : source()))
    .then((value) => value?.[Symbol.asyncIterator]());
  void opened.catch(() => {});
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    completion?.();
    signal.removeEventListener("abort", abort);
    return (closing = opened.then(
      async (iterator) => {
        await iterator?.return?.();
      },
      () => {},
    ));
  };
  const abort = () => {
    void close().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (closed) return { done: true, value: undefined };
      return Promise.race([
        opened.then(async (iterator) =>
          iterator ? iterator.next() : { done: true as const, value: undefined },
        ),
        finished,
      ]);
    },
    async return() {
      await close();
      return { done: true, value: undefined };
    },
  };
}
/** The supplied map is checked against the actual typed router. Native Send,
 * steer/queue/control and Stop remain typed consumer functions, never inferred
 * from a universal vendor union or retried by this binding. */
export function createConversationFeed(options: ConversationFeedOptions): SessionFeed {
  return {
    state: (scope, signal, unavailable) =>
      observe(
        () => options.caller(scope).stateWatch({ session: scope.session }, unavailable),
        signal,
      ),
    history: (run, signal, unavailable) =>
      observe(() => options.caller(run.scope).historyWatch({ run }, unavailable), signal),
    interactions: (run, signal, unavailable) =>
      observe(() => options.caller(run.scope).interactionsWatch({ run }, unavailable), signal),
    baseline: (run) => options.caller(run.scope).baseline({ run }),
    older: (run, cursor) => options.caller(run.scope).older({ run, cursor }),
    dispatch: (scope, command) => options.dispatch(scope, command),
    original: (scope, id) => options.caller(scope).original({ session: scope.session, id }),
  };
}
