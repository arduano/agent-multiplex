import type { AccessStreamItem, FeedControlItem } from "@arduano/agent-multiplex-protocol";

/** One lookahead, at most 64 events / 1 MiB, and a 20 ms collection window.
 * Non-control events and snapshot barriers preserve their original order. */
export async function* childImportBatches(
  source: AsyncIterable<AccessStreamItem>,
  barrier: (item: FeedControlItem) => boolean,
): AsyncGenerator<AccessStreamItem | FeedControlItem[]> {
  const iterator = source[Symbol.asyncIterator]();
  type Next = { value: IteratorResult<AccessStreamItem> } | { error: unknown };
  let pending: Promise<Next> | undefined;
  let buffered: IteratorResult<AccessStreamItem> | undefined;
  const read = () => pending ??= iterator.next().then(value => ({ value }), error => ({ error }));
  const take = (result: Next) => {
    pending = undefined;
    if ("error" in result) throw result.error;
    return result.value;
  };
  try {
    for (;;) {
      const first = buffered ?? take(await read());
      buffered = undefined;
      if (first.done) return;
      if (first.value.kind !== "control") { yield first.value; continue; }
      const batch = [first.value];
      let bytes = Buffer.byteLength(JSON.stringify(batch));
      const deadline = Date.now() + 20;
      while (batch.length < 64 && !barrier(batch.at(-1)!) && bytes < 1024 * 1024) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), remaining); });
        const result = await Promise.race([read(), timeout]);
        clearTimeout(timer);
        if (result === null) break;
        const next = take(result);
        if (next.done) { buffered = next; break; }
        const size = Buffer.byteLength(JSON.stringify(next.value)) + 1;
        if (next.value.kind !== "control" || bytes + size > 1024 * 1024) { buffered = next; break; }
        batch.push(next.value); bytes += size;
      }
      yield batch;
    }
  } finally {
    // The source's abort signal retires the one pending read. A cancellation-
    // ignoring iterator must not block its owner's shutdown or be pulled again.
    void iterator.return?.().catch(() => {});
  }
}
