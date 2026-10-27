import { MultiplexWorkspace } from '../src/index.js';
import { MemoryDraftPersistence, type DraftPersistence } from '../../v8-files/src/client/persistence.js';
import type { FilePort } from '../../v8-files/src/contracts/types.js';
import { HistoryWorkspace } from '../../v8-history/src/client/workspace.js';
import type { Scope, Snapshot } from '../../v8-history/src/contracts/types.js';
import { ClientFixture } from '../../v8-session/qualification/client-fixture.js';
import { scopeKey, type RunRef, type SessionScope, type Catalog } from '../../v8-session/src/contracts/types.js';
import { InteractionOwner } from '../../v8-interactions/src/owner.js';
import { McpOwner } from '../../v8-mcp/src/owner.js';
import { McpReadPool } from '../../v8-mcp/src/read-pool.js';
import type { CatalogEntry, CatalogPort, Creation, CreateRequest } from '../../v8-catalog/src/contracts/types.js';
import type { Binding, WorkspaceObservation, WorkspacePorts } from '../src/contracts.js';
export const catalogScope = { connection: 'fixture', principal: 'owner', authority: 'authority' };
export const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
export function workspaceFixture(options: Readonly<{ access?: WorkspacePorts['access']; hostForKind?: Readonly<{ codex: string; copilot: string }>; kinds?: Readonly<{ a: 'codex' | 'copilot'; b: 'codex' | 'copilot' }>; hostForSession?: Readonly<{ a: string; b: string }>; maxSessions?: number; controlCatalog?: (scope: SessionScope) => Promise<Catalog>; persistence?: DraftPersistence; files?: FilePort; bindingGate?: Promise<void>; createGate?: Promise<void>; creationReadGate?: Promise<void>; rename?: CatalogPort['rename']; setWatched?: CatalogPort['setWatched']; metadataOriginal?: CatalogPort['metadataOriginal']; publishArchive?: CatalogPort['publishArchive']; older?: WorkspacePorts['older']; historyScopes?: (scope: SessionScope) => Promise<readonly Scope[]>; domainRead?: (domain: 'interactions' | 'mcp', run: RunRef) => Promise<void> }> = {}) {
  const native = new ClientFixture(), bindings = new Map<string, Binding>(), owners = new Map<string, InteractionOwner>(), mcps = new Map<string, McpOwner>();
  let observation: (value: WorkspaceObservation) => void = () => {}; const heldHistory = new Map<string, ReturnType<typeof deferred<void>>>();
  const rows: CatalogEntry[] = []; let history!: HistoryWorkspace, closed = 0, discovery = 0, streams = 0, streamStarts = 0, bindingReads = 0, catalogEffects = 0, older = 0, controlReads = 0, mcpSubscriptions = 0, mcpReleases = 0;
  let creation: Creation | null = null; const creationReads: string[] = [], catalogListeners = new Set<(entry: CatalogEntry) => void>();
  const installDomains = (session: string, binding: Binding) => {
    const run = binding.run, kind = binding.history.kind;
    const owner = new InteractionOwner({ run, kind, epoch: run.generation }); owner.certifyBaseline({ run, complete: true, continuous: true }); owners.set(session, owner);
    const mcp = new McpOwner({ run, epoch: run.generation, reads: new McpReadPool(), native: kind === 'codex' ? { kind, status: async () => { discovery++; return { data: [], nextCursor: null }; } } : { kind, configured: async () => { discovery++; return { servers: [] }; } } }); mcps.set(session, mcp);
  };
  for (const session of ['a', 'b'] as const) {
    const kind = options.kinds?.[session] ?? (session === 'a' ? 'codex' : 'copilot');
    const scope: SessionScope = { connection: catalogScope.connection, principal: catalogScope.principal, host: options.hostForSession?.[session] ?? options.hostForKind?.[kind] ?? 'host', session }; const nativeSession = `native-${session}`;
    const origin = { connection: scope.connection, principal: scope.principal, host: scope.host, nativeSession, attachment: `attachment-${session}` };
    const attached: Scope = kind === 'codex' ? { kind, origin, threadId: nativeSession } : { kind, origin, agentId: null };
    const run = { scope, generation: 1, nativeSession }; bindings.set(session, { run, history: attached }); native.add(scope, kind);
    installDomains(session, { run, history: attached });
    rows.push({ scope: catalogScope, session, target: { host: scope.host, owner: 'durable-owner', kind, placement: 'shared' }, createId: `create-${session}`, version: 1, revision: 1, metadata: { name: session.toUpperCase(), cwd: '/owned' }, binding: { kind, generation: 1, nativeSession, placement: 'shared' } });
  }
  const initialBinding = rows[0]!.binding!; if (options.createGate) rows[0] = { ...rows[0]!, binding: null };
  native.invoke = async request => ({ scope: request.scope, id: request.id, type: request.command.type, generation: request.generation, state: 'acknowledged', ...(request.command.type === 'answer' ? { outcome: await owners.get(request.scope.session)!.invoke(request.command) } : {}) });
  const catalog: CatalogPort = { list: async () => rows, get: async (_, session) => rows.find(row => row.session === session) ?? null, subscribe: (_, listener) => { catalogListeners.add(listener); return () => { catalogListeners.delete(listener); }; }, ...(options.publishArchive ? { publishArchive: options.publishArchive } : {}),
    creation: async (_, operationId) => { creationReads.push(operationId); await options.creationReadGate; if (creation && operationId !== creation.original.id) throw new Error('Wrong original'); return creation; },
    create: async original => {
      catalogEffects++; if (!options.createGate) throw new Error('No create in fixture');
      creation = { original, entry: rows[0]!, state: 'dispatching', native: null, publication: 'pending' };
      void options.createGate.then(() => { rows[0] = { ...rows[0]!, binding: initialBinding, version: 2 }; creation = { original, entry: rows[0]!, state: 'nativeCreated', native: initialBinding, publication: 'committed' }; for (const listener of [...catalogListeners]) listener(rows[0]!); }); return creation;
    }, rename: async request => { catalogEffects++; if (options.rename) return options.rename(request); throw new Error('No rename in fixture'); }, setWatched: async request => { catalogEffects++; if (options.setWatched) return options.setWatched(request); throw new Error('No watch in fixture'); }, metadataOriginal: async (scope, id) => options.metadataOriginal?.(scope, id) ?? null };
  const workspace = new MultiplexWorkspace({ scope: catalogScope, ...(options.maxSessions ? { maxSessions: options.maxSessions } : {}), persistence: options.persistence ?? new MemoryDraftPersistence(), connect(context) {
    history = context.history; observation = context.onObservation;
    return { session: native, catalog, access: options.access ?? (() => ({ read: true, control: true, fileWrite: true, mcpRefresh: true, catalogWrite: true })), receiptOwner: scope => JSON.stringify([catalogScope.authority, scope.host, 'durable-owner']), binding: async scope => { bindingReads++; await options.bindingGate; return bindings.get(scope.session)!; },
      controlCatalog: async scope => { controlReads++; return options.controlCatalog ? options.controlCatalog(scope) : { available: false, choices: [] }; },
      ...(options.historyScopes ? { historyScopes: options.historyScopes } : {}),
      filePort: () => options.files ?? { call: async () => { throw new Error('No fixture file operation'); } },
      interactionPort: scope => ({ snapshot: async current => { const value = await owners.get(scope.session)!.snapshot(current); await options.domainRead?.('interactions', value.run); return value; }, subscribe: (current, listener) => owners.get(scope.session)!.subscribe(current, listener) }),
      mcpPort: scope => ({ snapshot: async run => { const value = await mcps.get(scope.session)!.snapshot(run); await options.domainRead?.('mcp', run); return value; }, subscribe: (run, listener) => { const off = mcps.get(scope.session)!.subscribe(run, listener); mcpSubscriptions++; return () => { mcpSubscriptions--; mcpReleases++; off(); }; }, refresh: (run, observed) => mcps.get(scope.session)!.refresh(run, observed) }),
      observeHistory: (scope, attached) => { streams++; streamStarts++; observation({ scope, kind: 'history', history: attached, state: 'connecting' }); const client = history.session(attached).client; if (!client.current) client.apply({ kind: 'snapshot', snapshot: initialHistory(attached) }); observation({ scope, kind: 'history', history: attached, state: 'live' }); let released = false; return { release: () => { if (released) return; released = true; streams--; } }; },
      older: async (scope, attached, cursor, generation) => { older++; if (options.older) return options.older(scope, attached, cursor, generation); return { scope: attached, generation: 'host-generation', rows: [{ id: 'older', kind: 'user', lifecycle: 'completed', body: { kind: 'complete', text: 'older private page', evidence: 'nativeFullBody' }, native: {}, version: 1, contentVersion: 1 }], olderEdge: { state: 'end', evidence: 'nativeBoundary' } }; },
      close: () => { closed++; },
    };
  } });
  return { workspace, native, bindings, owners, mcps, creationReads, get history() { return history; }, counts: () => ({ closed, discovery, streams, streamStarts, bindingReads, catalogEffects, older, controlReads, mcpSubscriptions, mcpReleases, submitted: native.submitted.length }),
    createRequest(): CreateRequest { const entry = rows[0]!; return { scope: catalogScope, id: entry.createId, session: entry.session, target: entry.target, metadata: entry.metadata }; },
    advance(session = 'a', sameHistoryScope = false) { const before = bindings.get(session)!, generation = before.run.generation + 1, binding: Binding = { run: { ...before.run, generation }, history: sameHistoryScope ? before.history : { ...before.history, origin: { ...before.history.origin, attachment: `attachment-${session}-${generation}` } } }; bindings.set(session, binding); installDomains(session, binding); native.publish(binding.run.scope, { generation }); return binding; },
    observation: (value: WorkspaceObservation) => observation(value),
    holdHistoryFeed(session: string) { const scope = bindings.get(session)!.run.scope, gate = deferred<void>(); heldHistory.set(session, gate); observation({ scope, kind: 'history', state: 'connecting' }); return gate.promise.then(() => { heldHistory.delete(session); observation({ scope, kind: 'history', state: 'unavailable' }); }); },
    closeHistoryFeed(session: string) { heldHistory.get(session)!.resolve(); },
    snapshot(session = 'a') { const scope = bindings.get(session)!.run.scope; return native.snapshots.get(scopeKey(scope))!; },
    async open() { return { a: await workspace.open('a'), b: await workspace.open('b') }; },
  };
}
function initialHistory(scope: Scope): Snapshot { return { scope, generation: 'host-generation', revision: 1, rows: [{ id: 'row', kind: 'assistant', lifecycle: 'completed', body: { kind: 'complete', text: 'retained history', evidence: 'nativeFullBody' }, native: {}, version: 1, contentVersion: 1 }], retirements: [], read: { state: 'idle' }, olderEdge: { state: 'available', cursor: 'owned-older-edge' }, coverage: { knownStart: true, gaps: [] }, activity: { turnId: null, state: 'idle' } }; }
