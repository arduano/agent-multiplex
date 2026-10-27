import type { CatalogEntry, CatalogPort, CatalogScope, Creation, MetadataOriginal } from '../../../v8-catalog/src/contracts/types.js';
import { catalogKey } from '../../../v8-catalog/src/contracts/types.js';
import { scope as validateScope } from '../../../v8-catalog/src/contracts/validation.js';
import { copy } from '../../../v8-session/src/contracts/validation.js';
import { GatewayError, type GatewayTransport } from '../contracts/types.js';

export type GatewayCatalogTransport = Required<Pick<GatewayTransport,
  'list' | 'get' | 'create' | 'creation' | 'rename' | 'setWatched' | 'metadataOriginal' | 'publishArchive' | 'watchCatalog'>>;

/** One configured catalog scope, with observation leases only. The caller owns
 * reconnection and the transport; this bridge never retries a mutation, retains
 * catalog rows, seals the remote authority or closes a shared Peer. */
export function createGatewayCatalogPort(options: Readonly<{
  scope: CatalogScope;
  transport: GatewayCatalogTransport;
  /** CatalogPort has no observer error channel. Surface loss to the existing
   * connection owner instead of silently presenting an empty/current catalog. */
  onUnavailable(error: unknown): void;
}>) {
  validateScope(options.scope);
  const scope = copy(options.scope), key = catalogKey(scope), transport = options.transport;
  const operations = {
    list: transport.list.bind(transport), get: transport.get.bind(transport), create: transport.create.bind(transport),
    creation: transport.creation.bind(transport), rename: transport.rename.bind(transport), setWatched: transport.setWatched.bind(transport),
    metadataOriginal: transport.metadataOriginal.bind(transport), publishArchive: transport.publishArchive.bind(transport),
    watchCatalog: transport.watchCatalog.bind(transport),
  };
  const unavailable = options.onUnavailable;
  const listeners = new Set<(value: CatalogEntry) => void>(), controller = new AbortController();
  let closed = false, watching = true, closing: Promise<void> | undefined;
  let admitted!: () => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { admitted = resolve; rejectReady = reject; });
  // The owning composition awaits ready before publishing this catalog port.
  void ready.catch(() => {});
  const open = () => { if (closed) throw new GatewayError('CLOSED'); };
  const exact = (value: CatalogScope) => {
    validateScope(value);
    if (catalogKey(value) !== key) throw new GatewayError('FENCED');
  };
  const entry = (value: CatalogEntry) => { exact(value.scope); return copy(value); };
  const creation = (value: Creation | null) => {
    if (!value) return null;
    exact(value.original.scope); entry(value.entry); return copy(value);
  };
  const metadata = (value: MetadataOriginal | null) => {
    if (!value) return null;
    exact(value.request.scope); entry(value.entry); return copy(value);
  };
  const call = async <T>(requested: CatalogScope, work: () => Promise<T>): Promise<T> => {
    open(); exact(requested);
    await ready; open();
    const value = await work(); open(); return value;
  };
  const mutation = <T extends { scope: CatalogScope }, R>(request: T, work: (request: T) => Promise<R>): Promise<R> => {
    const fixed = copy(request); return call(fixed.scope, () => work(fixed));
  };
  const iterator = operations.watchCatalog(copy(scope), controller.signal, admitted)[Symbol.asyncIterator]();
  const observation = (async () => {
    try {
      while (!controller.signal.aborted) {
        const next = await iterator.next();
        if (controller.signal.aborted) break;
        if (next.done) throw new GatewayError('UNAVAILABLE');
        const value = entry(next.value);
        for (const listener of [...listeners]) try { listener(copy(value)); } catch { /* A view cannot retire the catalog connection. */ }
      }
    } catch (error) {
      rejectReady(error);
      if (!closed && !controller.signal.aborted) try { unavailable(error); } catch { /* Owner callback cannot leak a task. */ }
    } finally {
      watching = false; listeners.clear(); rejectReady(new GatewayError(closed ? 'CLOSED' : 'UNAVAILABLE'));
      // Abort first: generator.return may otherwise queue behind a quiet next.
      controller.abort(); await iterator.return?.();
    }
  })();
  void observation.catch(error => { if (!closed) try { unavailable(error); } catch { /* Owner callback cannot leak a task. */ } });
  const port = Object.freeze({
    list: requested => call(requested, () => operations.list(copy(scope))).then(values => values.map(entry)),
    get: (requested, session) => call(requested, () => operations.get(copy(scope), session)).then(value => value && entry(value)),
    create: request => mutation(request, operations.create).then(value => creation(value)!),
    creation: (requested, id) => call(requested, () => operations.creation(copy(scope), id)).then(creation),
    rename: request => mutation(request, operations.rename).then(entry),
    setWatched: request => mutation(request, operations.setWatched).then(entry),
    metadataOriginal: (requested, id) => call(requested, () => operations.metadataOriginal(copy(scope), id)).then(metadata),
    publishArchive: request => mutation(request, operations.publishArchive).then(entry),
    subscribe(requested, listener) {
      open(); exact(requested);
      if (!watching) throw new GatewayError('UNAVAILABLE');
      if (!listeners.has(listener) && listeners.size >= 128) throw new GatewayError('FULL');
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
  } satisfies CatalogPort);
  return Object.freeze({ port, ready,
    close(): Promise<void> {
      if (closing) return closing;
      closed = true; listeners.clear(); rejectReady(new GatewayError('CLOSED')); controller.abort();
      closing = observation;
      return closing;
    },
  });
}
