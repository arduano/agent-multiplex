/** Negative control only. This deliberately unsafe historical ordering lets
 * observer cancellation unsubscribe an admitted stream while it is opening.
 * Never use it as the production observation adapter. It is self-contained so
 * the public transport oracle does not load a private application's source.
 */
const encoder = new TextEncoder();
function jsonWireByteUpperBound(value) {
  if (value === null || typeof value === 'boolean') return 16;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(16, JSON.stringify(value).length);
  if (typeof value === 'string') return Math.max(16, encoder.encode(value).byteLength + 6, encoder.encode(JSON.stringify(value)).byteLength);
  if (Array.isArray(value)) return 16 + value.reduce((bytes, member) => bytes + 1 + jsonWireByteUpperBound(member), 0);
  if (typeof value === 'object' && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    let bytes = 16;
    for (const [key, member] of Object.entries(value)) if (member !== undefined) bytes += jsonWireByteUpperBound(key) + 2 + jsonWireByteUpperBound(member);
    return bytes;
  }
  throw new TypeError('Wire byte bounds require plain JSON protocol data');
}
export function subscriptionIterable(subscribe, signal, maximum = 128, maximumBytes = 8 * 1024 * 1024) {
  return { async *[Symbol.asyncIterator]() {
    const queue = []; let queuedBytes = 0; let wake; let done = false; let failure;
    const stop = () => { done = true; wake?.(); };
    const subscription = subscribe({ next(value) {
      if (done) return;
      const bytes = jsonWireByteUpperBound(value);
      if (queue.length >= maximum || queuedBytes + bytes > maximumBytes) { failure = new Error('V7_STREAM_OVERFLOW'); stop(); return; }
      queue.push({ value, bytes }); queuedBytes += bytes; wake?.();
    }, error(error) { failure = error; stop(); }, complete: stop });
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    try {
      while (!done || queue.length) {
        if (queue.length) { const item = queue.shift(); queuedBytes -= item.bytes; yield item.value; continue; }
        await new Promise(resolve => { wake = resolve; }); wake = undefined;
      }
      if (failure) throw failure;
    } finally { subscription.unsubscribe(); signal?.removeEventListener('abort', stop); }
  } };
}
