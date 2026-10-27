import { copy } from '../../../v8-session/src/contracts/validation.js';
import { ViewerQueue } from '../gateway/queue.js';

type Subscription = Readonly<{ unsubscribe(): void }>;
export type PeerObserver<T> = Readonly<{
  onStarted(): void; onData(value: T): void; onError(error: unknown): void; onComplete(): void;
}>;

/** Consumer cancellation never cancels a shared Peer's pending raw stream open. */
export async function* observePeer<T>(
  start: (observer: PeerObserver<T>) => Subscription,
  signal: AbortSignal,
  onStarted?: () => void,
): AsyncIterable<T> {
  if (signal.aborted) return;
  const queue = new ViewerQueue<T>(16, 1048576);
  let subscription: Subscription | undefined, started = false, ended = false, consumerEnded = false;
  const stop = () => {
    if (!subscription || !started || ended) return;
    ended = true;
    subscription.unsubscribe();
  };
  queue.setCleanup(() => { consumerEnded = true; stop(); });
  const abort = () => { void queue.return(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) return;
    subscription = start({
      onStarted: () => { started = true; if (consumerEnded || signal.aborted) stop(); else onStarted?.(); },
      onData: value => { if (!consumerEnded && !ended) queue.push(copy(value)); },
      onError: error => { ended = true; queue.fail(error); },
      onComplete: () => { ended = true; queue.finish(); },
    });
    if (consumerEnded || signal.aborted) stop();
    yield* queue;
  } finally {
    signal.removeEventListener('abort', abort);
    await queue.return();
  }
}
