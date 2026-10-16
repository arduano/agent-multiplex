import { jsonWireByteUpperBound } from "@arduano/agent-multiplex-protocol";
import { EventQueue } from "./events.js";

export const ORIGIN_HEARTBEAT_INTERVAL_MS = 10_000;
/** Observer-owned bounded multiplexing. Heartbeats never wait for presentation
 * materialization, native tokens, or a durable write. They prove this precise
 * subscription's producer is still serving, not that native work is finished. */
export function originObservedStream<T, O>(source: (signal: AbortSignal) => AsyncIterable<T>, wrap: (item: T) => O,
  heartbeat: () => O, signal?: AbortSignal): AsyncIterable<O> {
  return (async function* () {
    const lifetime = new AbortController(), abort = () => lifetime.abort();
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    let timer: ReturnType<typeof setInterval> | undefined, iterator: AsyncIterator<T> | undefined;
    const queue = new EventQueue<{ value: O } | { done: true }>(512, abort, 8 * 1024 * 1024, jsonWireByteUpperBound);
    const close = () => { if (timer) clearInterval(timer); queue.close(); }; lifetime.signal.addEventListener("abort", close, { once: true });
    const beat = () => { try { queue.push({ value: heartbeat() }); } catch (error) { queue.close(error instanceof Error ? error : new Error("Origin observation failed")); } };
    try {
      if (!lifetime.signal.aborted) {
        iterator = source(lifetime.signal)[Symbol.asyncIterator]();
        beat(); timer = setInterval(beat, ORIGIN_HEARTBEAT_INTERVAL_MS); timer.unref?.();
        void (async () => { try {
          while (!lifetime.signal.aborted) {
            const next = await iterator!.next(); if (lifetime.signal.aborted) return;
            if (next.done) { if (timer) clearInterval(timer); queue.push({ done: true }); return; } queue.push({ value: wrap(next.value) });
          }
        } catch (error) { if (!lifetime.signal.aborted) queue.close(error instanceof Error ? error : new Error("Origin observation failed")); } })();
      } else queue.close();
      for await (const next of queue) { if ("done" in next) break; yield next.value; }
    } finally {
      lifetime.abort(); if (timer) clearInterval(timer); queue.close();
      signal?.removeEventListener("abort", abort); lifetime.signal.removeEventListener("abort", close);
      try { void Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* Never block on a retired peer. */ }
    }
  })();
}
