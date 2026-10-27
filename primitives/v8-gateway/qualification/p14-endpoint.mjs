import { IrohEndpoint } from '@arduano/p2prpc-core/advanced';

// Test-only observation at the published transport seam. No vendor patch,
// alternate codec, credential handling or domain behavior belongs here.
const closeReasons = new Set([
  'RPC stream cleanup failed', 'RPC stream opening was cancelled',
  'Late RPC stream cleanup failed', 'Bidirectional stream opening was cancelled',
  'Bidirectional stream adoption was cancelled', 'Bidirectional stream opening failed',
  'Unidirectional stream opening was cancelled', 'Unidirectional stream adoption was cancelled',
  'Unidirectional stream opening failed', 'Stream adoption failed',
  'Late bidirectional stream cleanup failed', 'Late unidirectional stream cleanup failed',
  'Stream cleanup failed', 'File stream cleanup failed', 'Node closed',
  'Peer closed', 'Connection closed', 'Dial cancelled',
]);
const errorCodes = new Set([
  'CANCELLED', 'DISCONNECTED', 'INTERNAL', 'INVALID_FRAME', 'INVALID_INPUT',
  'OUTCOME_UNKNOWN', 'REJECTED', 'RESOURCE_LIMIT', 'TIMEOUT', 'UNAUTHORIZED',
]);
const safeReason = value => {
  const reason = new TextDecoder().decode(value);
  return closeReasons.has(reason) ? reason : 'other transport close reason';
};
function safeError(cause) {
  return errorCodes.has(cause?.code) ? cause.code : 'operation failed';
}
function safeStack() {
  // Keep function + file basename + source coordinates, never absolute paths.
  return new Error().stack?.split('\n').slice(2).flatMap(line => {
    const location = line.match(/(?:\/|\\)([A-Za-z0-9_.-]+\.[cm]?js):(\d+):(\d+)\)?$/);
    if (!location) return [];
    const name = line.match(/^\s*at ([A-Za-z0-9_.$<> ]+) \(/)?.[1]?.slice(0, 100) ?? 'anonymous';
    return [`${name} (${location[1]}:${location[2]}:${location[3]})`];
  }).slice(0, 8) ?? [];
}

/**
 * Fresh local native endpoints, with bounded credential-free transport events.
 *
 * Pass endpointFactory to createAdvancedP2PNode, retaining the caller's normal
 * security/authorization. armOpenBarrier() affects one raw outbound openBi:
 * acquired resolves only after Iroh has created its real native stream, while
 * delivery to the managed caller remains held until release(). It does not
 * delay native stream creation or synthesize a stream/transport error.
 */
export function createP14EndpointHarness({ maxEvents = 512, iroh = {} } = {}) {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 16 || maxEvents > 8192) {
    throw new RangeError('P14 maxEvents must be between 16 and 8192');
  }
  const started = performance.now(), log = [], barriers = new Set();
  let sequence = 0, dropped = 0, endpointOrdinal = 0, connectionOrdinal = 0, streamOrdinal = 0, armed;
  const emit = event => {
    const value = Object.freeze({ sequence: ++sequence, milliseconds: Math.round(performance.now() - started), ...event });
    if (log.length < maxEvents) log.push(value);
    else dropped++;
  };
  const operation = async (identity, name, run) => {
    emit({ ...identity, operation: name, phase: 'start' });
    try {
      const result = await run();
      emit({ ...identity, operation: name, phase: 'end' });
      return result;
    } catch (cause) {
      emit({ ...identity, operation: name, phase: 'error', error: safeError(cause) });
      throw cause;
    }
  };
  const send = (inner, identity) => Object.freeze({
    writeAll: data => operation(identity, 'send.writeAll', () => inner.writeAll(data)),
    finish: () => operation(identity, 'send.finish', () => inner.finish()),
    reset: code => operation(identity, 'send.reset', () => inner.reset(code)),
    setPriority: value => operation(identity, 'send.setPriority', () => inner.setPriority(value)),
  });
  const recv = (inner, identity) => Object.freeze({
    readExact: size => operation(identity, 'recv.readExact', () => inner.readExact(size)),
    expectEnd: () => operation(identity, 'recv.expectEnd', () => inner.expectEnd()),
    stop: code => operation(identity, 'recv.stop', () => inner.stop(code)),
  });
  const bidi = (inner, connection) => {
    const identity = { ...connection, stream: ++streamOrdinal };
    return Object.freeze({ send: send(inner.send, identity), recv: recv(inner.recv, identity) });
  };
  const wrapConnection = (inner, endpoint) => {
    const identity = { endpoint, connection: ++connectionOrdinal };
    emit({ ...identity, operation: 'connection', phase: 'admitted', side: inner.side });
    let closure;
    return Object.freeze({
      remoteId: inner.remoteId,
      side: inner.side,
      openBi: options => {
        const barrier = armed;
        if (barrier) { armed = undefined; barrier.claimed = true; }
        return operation(identity, 'openBi', async () => {
          let stream;
          try { stream = bidi(await inner.openBi(options), identity); }
          catch (cause) { barrier?.fail(); throw cause; }
          if (barrier) {
            emit({ ...identity, operation: 'openBi.barrier', phase: 'acquired' });
            barrier.acquire();
            await barrier.delivery;
            emit({ ...identity, operation: 'openBi.barrier', phase: 'released' });
          }
          return stream;
        });
      },
      acceptBi: () => operation(identity, 'acceptBi', async () => bidi(await inner.acceptBi(), identity)),
      openUni: options => operation(identity, 'openUni', async () => send(await inner.openUni(options), { ...identity, stream: ++streamOrdinal })),
      acceptUni: () => operation(identity, 'acceptUni', async () => recv(await inner.acceptUni(), { ...identity, stream: ++streamOrdinal })),
      closed: () => closure ??= operation(identity, 'closed', () => inner.closed()),
      close: (code, reason) => {
        emit({ ...identity, operation: 'close', phase: 'requested', code: String(code), reason: safeReason(reason), stack: safeStack() });
        return inner.close(code, reason);
      },
      stats: () => inner.stats(),
      ...(inner.pathChanges ? { pathChanges: signal => inner.pathChanges(signal) } : {}),
    });
  };
  return Object.freeze({
    endpointFactory: async alpn => {
      const endpoint = ++endpointOrdinal;
      const inner = await IrohEndpoint.create(alpn, {
        bindAddress: '127.0.0.1:0',
        allowAdvertisedAddress: address => address.startsWith('127.0.0.1:'),
        allowDirectAddress: address => address.startsWith('127.0.0.1:'),
        allowRelayUrl: () => false,
        ...iroh,
        relay: { mode: 'disabled' },
        discovery: { dns: false, mdns: false },
      });
      return Object.freeze({
        id: inner.id,
        get address() { return inner.address; },
        createTicket: () => inner.createTicket(),
        connect: (ticket, protocol, expected) => operation({ endpoint }, 'endpoint.connect', async () => wrapConnection(await inner.connect(ticket, protocol, expected), endpoint)),
        connectLocator: (locator, protocol, expected, signal) => operation({ endpoint }, 'endpoint.connectLocator', async () => wrapConnection(await inner.connectLocator(locator, protocol, expected, signal), endpoint)),
        accept: () => operation({ endpoint }, 'endpoint.accept', async () => {
          const connection = await inner.accept();
          return connection ? wrapConnection(connection, endpoint) : null;
        }),
        advertise: options => inner.advertise(options),
        browse: options => inner.browse(options),
        diagnostics: () => inner.diagnostics(),
        close: () => operation({ endpoint }, 'endpoint.close', () => inner.close()),
      });
    },
    events: () => Object.freeze([...log]),
    get droppedEvents() { return dropped; },
    armOpenBarrier: () => {
      if (armed) throw new Error('An outbound open barrier is already armed');
      let resolveAcquired, rejectAcquired, resolveDelivery, acquired = false, released = false;
      const acquiredPromise = new Promise((resolve, reject) => { resolveAcquired = resolve; rejectAcquired = reject; });
      // A failed/open-never-started barrier can be retired without an unhandled rejection.
      void acquiredPromise.catch(() => {});
      const barrier = {
        claimed: false,
        delivery: new Promise(resolve => { resolveDelivery = resolve; }),
        acquire: () => { acquired = true; resolveAcquired(); },
        fail: () => { rejectAcquired(new Error('Native stream acquisition failed')); barrier.release(); },
        release: () => {
          if (released) return;
          released = true;
          if (armed === barrier) armed = undefined;
          if (!barrier.claimed && !acquired) rejectAcquired(new Error('Open barrier retired before acquisition'));
          resolveDelivery();
          barriers.delete(barrier);
        },
      };
      barriers.add(barrier); armed = barrier;
      return Object.freeze({ acquired: acquiredPromise, release: barrier.release });
    },
    releaseAll: () => { for (const barrier of [...barriers]) barrier.release(); },
  });
}
