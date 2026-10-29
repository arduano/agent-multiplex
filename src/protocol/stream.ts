/** Bind one producer iterator to its actual request. Closing wakes an observer
 * immediately; return() still awaits the producer's real cleanup. A transport's
 * outer async generator may otherwise queue return behind a quiet next(). */
export function closeOnAbort<T>(
  source: AsyncIterable<T>,
  signal?: AbortSignal,
): AsyncIterableIterator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let closed = false,
    retirement: Promise<IteratorResult<T>> | undefined;
  let end!: (result: IteratorResult<T>) => void;
  const ended = new Promise<IteratorResult<T>>((resolve) => {
    end = resolve;
  });
  const close = () => {
    if (!closed) {
      closed = true;
      end({ done: true, value: undefined });
      signal?.removeEventListener("abort", abort);
    }
    return (retirement ??= Promise.resolve().then(async () => {
      await iterator.return?.();
      return { done: true as const, value: undefined };
    }));
  };
  const abort = () => {
    void close().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (closed) return { done: true, value: undefined };
      try {
        const part = await Promise.race([ended, iterator.next()]);
        if (part.done) await close();
        return closed ? { done: true, value: undefined } : part;
      } catch (error) {
        await close();
        throw error;
      }
    },
    return: close,
  };
}
