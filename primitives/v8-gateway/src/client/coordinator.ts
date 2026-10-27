import type { Catalog, SessionPort, SessionScope, SessionSnapshot, Submit, Receipt, RunRef, NativeRead, NativeReadResult } from "../../../v8-session/src/contracts/types.js";
import { validateCatalog } from "../../../v8-session/src/native/validation.js";
import { validateNativeReadResult } from "../../../v8-harness-defaults/src/state.js";
import { validateLoginLink } from '../../../v8-session/src/contracts/mcp-login.js';
import { scopeKey } from "../../../v8-session/src/contracts/types.js";
import { canonical, copy, id } from "../../../v8-session/src/contracts/validation.js";
import { HistoryWorkspace } from "../../../v8-history/src/client/workspace.js";
import { scopeKey as historyKey } from "../../../v8-history/src/contracts/identity.js";
import type { Scope, HistoryPage } from "../../../v8-history/src/contracts/types.js";
import type { HistoryObservation, HistoryRecovery } from "../../../v8-history/src/acquisition/types.js";
import type { CatalogPort, CatalogScope } from "../../../v8-catalog/src/contracts/types.js";
import type { InteractionPort } from "../../../v8-interactions/src/contracts.js";
import type { McpPort } from "../../../v8-mcp/src/contracts.js";
import { GatewayError, ownerKey, targetKey, targetScope, type GatewayTarget, type GatewayTransport } from "../contracts/types.js";
import { target } from "../contracts/validation.js";
import { hostRpcKey, hostRpcOwnerKey, hostRpcRequest, hostRpcTarget, type HostRpcRequest, type HostRpcTarget } from '../contracts/rpc.js';
type FeedState = "connecting" | "live" | "unavailable" | "disconnected";
type DomainFeedObservation = Readonly<{
    scope: SessionScope;
    kind: "session" | "history" | "interactions";
    /** Present on history feeds so a child cannot overwrite root health. */
    history?: Scope;
}> | Readonly<{
    scope: SessionScope;
    kind: "mcp";
    run: RunRef;
}> | Readonly<{
    scope: CatalogScope;
    kind: "catalog";
}>;
type FeedObservation = DomainFeedObservation | Readonly<{
    target: HostRpcTarget;
    kind: 'rpc';
    key: string;
}>;
export type Observation = DomainFeedObservation & Readonly<{
    state: FeedState;
}>;
type Feed = {
    key: string;
    observation: FeedObservation;
    scope?: SessionScope;
    controller: AbortController | null;
    terminal: boolean;
    admitted: boolean;
    references: number;
    listeners: Set<(value: unknown) => void>;
    states: Set<(value: FeedState) => void>;
    state: FeedState;
    start: (signal: AbortSignal, ready: () => void) => AsyncIterable<unknown>;
    accept?: (value: unknown) => void;
    latest?: unknown;
    hasLatest?: boolean;
};
export type RecoveryClock = Readonly<{
    now(): number;
    setTimeout(callback: () => void, delay: number): unknown;
    clearTimeout(timer: unknown): void;
}>;
const clock: RecoveryClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) };
const retryDelays = [250, 500, 1000, 2000, 4000, 8000, 16000, 30000] as const;
// A remote lifetime's CLOSED is lost reachability, not local disposal. Local
// #closed/#enabled guards still prevent observation renewal after this owner ends.
const terminalCodes = new Set(["INVALID", "FORBIDDEN", "FENCED", "CONFLICT", "OVERFLOW", "ALREADY_ATTEMPTED", "CANCELLED", 'BAD_REQUEST', 'UNAUTHORIZED', 'NOT_FOUND', 'METHOD_NOT_SUPPORTED', 'PRECONDITION_FAILED']);
/** One retained observation owner. Reconnecting never forwards an original mutation. */
export class GatewayClient implements SessionPort {
    readonly #transport: GatewayTransport;
    readonly #history: HistoryWorkspace;
    readonly #targets = new Map<string, GatewayTarget>();
    readonly #hostTargets = new Map<string, HostRpcTarget>();
    readonly #originals = new Map<string, {
        target: GatewayTarget;
        request: Submit;
    }>();
    readonly #feeds = new Map<string, Feed>();
    readonly #onReady: ((observation: Observation) => void | Promise<void>) | undefined;
    readonly #beforeObserve: (() => Promise<void>) | undefined;
    readonly #onFence: () => void;
    readonly #onConnection: ((connected: boolean) => void) | undefined;
    readonly #onObservation: ((observation: Observation) => void) | undefined;
    readonly #maxOperations: number;
    readonly #clock: RecoveryClock;
    readonly #random: () => number;
    readonly #detach: (() => void) | undefined;
    #closed = false;
    #enabled = true;
    #online = true;
    #principal: string;
    #connection: string;
    #timer: unknown;
    #attempt = 0;
    #healthySince: number | null = null;
    #beforeObserving: Promise<void> | undefined;
    #refreshFenced = false;
    constructor(options: Readonly<{
        transport: GatewayTransport;
        history: HistoryWorkspace;
        targets: readonly GatewayTarget[];
        hostTargets?: readonly HostRpcTarget[];
        onFence: () => void;
        onConnection?: (connected: boolean) => void;
        onObservation?: (observation: Observation) => void;
        onReady?: (observation: Observation) => void | Promise<void>;
        /** Read-only trusted route restoration inside the existing retry.
         * Fenced feeds revive only through an actual same-owner route update. */
        beforeObserve?: () => Promise<void>;
        maxOperations?: number;
        clock?: RecoveryClock;
        random?: () => number;
    }>) {
        if (!options.targets.length && !options.hostTargets?.length || options.targets.length + (options.hostTargets?.length ?? 0) > 64)
            throw new GatewayError("INVALID");
        this.#onReady = options.onReady;
        this.#beforeObserve = options.beforeObserve;
        this.#transport = options.transport;
        this.#history = options.history;
        this.#onFence = options.onFence;
        this.#onConnection = options.onConnection;
        this.#onObservation = options.onObservation;
        this.#maxOperations = options.maxOperations ?? 128;
        this.#clock = options.clock ?? clock;
        this.#random = options.random ?? Math.random;
        if (!Number.isSafeInteger(this.#maxOperations) || this.#maxOperations < 1 || this.#maxOperations > 1024)
            throw new GatewayError("INVALID");
        const first = options.targets.length ? target(options.targets[0]) : hostRpcTarget(options.hostTargets![0]);
        this.#principal = first.principal;
        this.#connection = first.connection;
        for (const t of options.targets)
            this.bindRoute(t);
        for (const t of options.hostTargets ?? []) this.bindHostRoute(t);
        this.#detach = this.#transport.onDisconnect?.(error => this.#physicalLost(error));
    }
    #open(): void { if (this.#closed)
        throw new GatewayError("CLOSED"); }
    #ready(): void { this.#open(); if (!this.#enabled || !this.#online)
        throw new GatewayError("UNAVAILABLE"); }
    #target(scope: SessionScope): GatewayTarget { this.#open(); const t = this.#targets.get(scopeKey(scope)); if (!t)
        throw new GatewayError("FENCED"); return t; }
    #observation(feed: Feed, state: FeedState): void { feed.state = state; for (const listener of [...feed.states]) try { listener(state); } catch { /* Presentation isolation. */ } try {
        if (feed.observation.kind !== 'rpc') this.#onObservation?.(copy({ ...feed.observation, state }) as Observation);
    }
    catch { /* Presentation cannot interrupt routing. */ } }
    #connectionState(value: boolean): void { if (this.#online === value)
        return; this.#online = value; this.#history.setConnected(value); try {
        this.#onConnection?.(value);
    }
    catch { /* Presentation cannot prevent observation cleanup. */ } }
    #cancel(feed: Feed): void { feed.controller?.abort(); feed.controller = null; feed.admitted = false; }
    #cancelTimer(): void { if (this.#timer !== undefined) {
        this.#clock.clearTimeout(this.#timer);
        this.#timer = undefined;
    } }
    #failedHealth(): void { if (this.#healthySince !== null && this.#clock.now() - this.#healthySince >= 30000)
        this.#attempt = 0; this.#healthySince = null; }
    #physicalLost(error: unknown): void {
        if (this.#closed || !this.#enabled)
            return;
        if ((error as {
            code?: unknown;
        })?.code === "UNAUTHENTICATED") {
            this.fence();
            return;
        }
        this.#failedHealth();
        if (this.#beforeObserve && (error as {code?: unknown})?.code === "FENCED") this.#refreshFenced = true;
        this.#connectionState(false);
        for (const feed of this.#feeds.values()) {
            this.#cancel(feed);
            feed.terminal ||= terminalCodes.has(String((error as {
                code?: unknown;
            })?.code));
            this.#observation(feed, "unavailable");
        }
        this.#schedule();
    }
    #schedule(): void {
        if (this.#closed || !this.#enabled || this.#timer !== undefined || this.#beforeObserving || !this.#refreshFenced && ![...this.#feeds.values()].some(f => !f.controller && !f.terminal))
            return;
        const delay = retryDelays[Math.min(this.#attempt, retryDelays.length - 1)]! * (0.8 + 0.2 * Math.max(0, Math.min(1, this.#random())));
        this.#attempt++;
        this.#timer = this.#clock.setTimeout(() => { this.#timer = undefined; if (this.#closed || !this.#enabled)
            return; this.#restoreObservations(); }, delay);
    }
    #restoreObservations(): void {
        if (this.#closed || !this.#enabled || this.#beforeObserving) return;
        const fenced = this.#refreshFenced; this.#refreshFenced = false;
        const pending = Promise.resolve().then(() => this.#beforeObserve?.()); this.#beforeObserving = pending;
        void pending.then(() => {
            if (this.#beforeObserving !== pending) return; this.#beforeObserving = undefined;
            if (this.#closed || !this.#enabled) return;
            // FENCED remains terminal. Only bindRoute's proved epoch change or
            // a newly composed RPC descriptor can restart that observation.
            for (const feed of this.#feeds.values()) if (!feed.controller && !feed.terminal) this.#start(feed);
            this.#schedule();
        }, error => {
            if (this.#beforeObserving !== pending) return; this.#beforeObserving = undefined;
            if (this.#closed || !this.#enabled) return;
            if ((error as {code?: unknown})?.code === "UNAUTHENTICATED") { this.fence(); return; }
            const terminal = terminalCodes.has(String((error as {code?: unknown})?.code));
            if (!terminal) this.#refreshFenced ||= fenced;
            for (const feed of this.#feeds.values()) if (!feed.controller) { feed.terminal ||= terminal; this.#observation(feed, "unavailable"); }
            this.#failedHealth(); this.#schedule();
        });
    }
    #start(feed: Feed): void {
        if (this.#closed || !this.#enabled || feed.controller || feed.terminal || this.#feeds.get(feed.key) !== feed)
            return;
        const controller = new AbortController();
        feed.controller = controller;
        feed.admitted = false;
        this.#observation(feed, "connecting");
        const current = () => !this.#closed && !controller.signal.aborted && feed.controller === controller && this.#feeds.get(feed.key) === feed;
        const failed = (error: unknown, refresh = true) => {
            if (!current())
                return;
            if ((error as {
                code?: unknown;
            })?.code === "UNAUTHENTICATED") {
                this.fence();
                return;
            }
            this.#cancel(feed);
            feed.terminal = terminalCodes.has(String((error as {
                code?: unknown;
            })?.code));
            if (refresh && this.#beforeObserve && (error as {code?: unknown})?.code === "FENCED") this.#refreshFenced = true;
            this.#failedHealth();
            this.#observation(feed, "unavailable");
            this.#schedule();
        };
        let restoration: Promise<void> | undefined;
        const admitted = () => {
            if (!current() || restoration)
                return;
            this.#connectionState(true);
            restoration = Promise.resolve().then(() => current() && feed.observation.kind !== 'rpc' ? this.#onReady?.(copy({ ...feed.observation, state: "live" }) as Observation) : undefined).then(() => {
                if (!current())
                    return;
                feed.admitted = true;
                this.#observation(feed, "live");
                if ([...this.#feeds.values()].every(f => f.terminal || f.admitted) && this.#healthySince === null)
                    this.#healthySince = this.#clock.now();
            });
            void restoration.catch(failed);
        };
        void (async () => {
            try {
                // A route update inside the callback can create/start a feed;
                // that feed joins the same restoration before touching transport.
                const preparing = this.#beforeObserving;
                if (preparing) { try { await preparing; } catch (error) { failed(error, false); return; } }
                if (!current()) return;
                for await (const value of feed.start(controller.signal, admitted)) {
                    if (!current())
                        return;
                    feed.accept?.(value);
                    if (feed.observation.kind === 'rpc') { feed.latest = copy(value); feed.hasLatest = true; }
                    for (const listener of [...feed.listeners])
                        try {
                            listener(copy(value));
                        }
                        catch { /* Viewer isolation. */ }
                }
                if (current())
                    throw new GatewayError("UNAVAILABLE", "Observation ended");
            }
            catch (error) {
                failed(error);
            }
        })();
    }
    #retain(input: Omit<Feed, "controller" | "terminal" | "admitted" | "references" | "listeners" | "states" | "state">, listener?: (value: unknown) => void, onState?: (state: FeedState) => void): () => void {
        this.#open();
        let feed = this.#feeds.get(input.key);
        if (feed?.scope && input.scope && scopeKey(feed.scope) !== scopeKey(input.scope))
            throw new GatewayError("FENCED");
        if (!feed) {
            if (this.#feeds.size >= 384)
                throw new GatewayError("FULL");
            this.#failedHealth();
            feed = { ...input, controller: null, terminal: false, admitted: false, references: 0, listeners: new Set(), states: new Set(), state: 'connecting' };
            this.#feeds.set(feed.key, feed);
        }
        if (feed.references >= 128)
            throw new GatewayError("FULL");
        const ownedListener = listener ? (value: unknown) => listener(value) : undefined;
        const ownedState = onState ? (value: FeedState) => onState(value) : undefined;
        feed.references++;
        if (ownedListener)
            feed.listeners.add(ownedListener);
        if (ownedState) feed.states.add(ownedState);
        if (ownedListener && feed.hasLatest) try { ownedListener(copy(feed.latest)); } catch { /* Presentation isolation. */ }
        if (ownedState) try { ownedState(feed.state); } catch { /* Presentation isolation. */ }
        this.#start(feed);
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            if (ownedListener)
                feed!.listeners.delete(ownedListener);
            if (ownedState) feed!.states.delete(ownedState);
            if (--feed!.references !== 0)
                return;
            this.#cancel(feed!);
            this.#feeds.delete(feed!.key);
            if (!this.#feeds.size) this.#refreshFenced = false;
            if (!this.#refreshFenced && ![...this.#feeds.values()].some(f => !f.controller && !f.terminal))
                this.#cancelTimer();
            if (this.#healthySince === null && [...this.#feeds.values()].every(f => f.terminal || f.admitted))
                this.#healthySince = this.#clock.now();
        };
    }
    /** Adds a real Host route before any logical session exists. */
    bindHostRoute(input: HostRpcTarget): void {
        this.#open(); const t = hostRpcTarget(input);
        if (t.connection !== this.#connection || t.principal !== this.#principal) throw new GatewayError('FORBIDDEN');
        for (const previous of this.#hostTargets.values()) if (previous.authority === t.authority && previous.host === t.host && previous.owner !== t.owner) throw new GatewayError('FENCED');
        const key = hostRpcOwnerKey(t), old = this.#hostTargets.get(key);
        if (!old && this.#targets.size + this.#hostTargets.size >= 64) throw new GatewayError('FULL');
        this.#hostTargets.set(key, t);
        if (old && hostRpcKey(old) !== hostRpcKey(t)) for (const feed of this.#feeds.values()) {
            if (feed.observation.kind !== 'rpc' || hostRpcOwnerKey(feed.observation.target) !== key) continue;
            // Existing plugin views belong to the old epoch. Fresh composition
            // prepares new views; old callbacks cannot overwrite them.
            this.#cancel(feed); feed.terminal = true; this.#observation(feed, 'unavailable');
        }
        if (old && hostRpcKey(old) !== hostRpcKey(t)) for (const previous of this.#targets.values()) {
            if (hostRpcOwnerKey(previous) === key) this.bindRoute({...t, session: previous.session});
        }
    }
    /** Public projection source. Reuses this client's sole descriptor/recovery
     * owner; reconnect reopens observations only, never a mutation or native read.
     * Each procedure must stream complete ordered snapshots for its exact scope.
     */
    rpcSource<T>(input: HostRpcRequest, parse: (value: unknown) => T) {
        const request = hostRpcRequest(input), key = `rpc:${canonical(request)}`;
        const current = () => {
            this.#open(); const route = this.#hostTargets.get(hostRpcOwnerKey(request.target));
            if (!route || hostRpcKey(route) !== hostRpcKey(request.target)) throw new GatewayError('FENCED');
            return route;
        };
        current();
        const transport = this.#transport;
        return Object.freeze({ subscribe: (onValue: (value: T) => void, onObservation: (value: 'connecting' | 'live' | 'disconnected') => void) => {
            current();
            let valid = false;
            const release = this.#retain({ key, observation: { kind: 'rpc', key, target: request.target },
                start: async function* (signal, ready) {
                    current(); if (!transport.rpcWatch) throw new GatewayError('UNAVAILABLE');
                    // Mux admission is not a snapshot. Mark live only after a
                    // valid value, never from the subscribe HTTP ACK alone.
                    for await (const result of transport.rpcWatch(request, signal)) {
                        current(); if (!result.ok) throw Object.assign(new Error(result.error.code), { code: result.error.code });
                        canonical(result.value, 1048576); ready(); yield result.value;
                    }
                },
            }, value => {
                let decoded: T;
                try { decoded = parse(value); }
                catch { valid = false; onObservation('disconnected'); return; }
                valid = true; onValue(decoded); onObservation('live');
            }, state => onObservation(state === 'unavailable' ? 'disconnected' : state === 'live' && !valid ? 'connecting' : state));
            return Object.freeze({ release });
        } });
    }
    /** A same-owner route change retires old observations; pending originals retain their durable target. */
    bindRoute(input: GatewayTarget): void {
        this.#open();
        const t = target(input);
        if (t.principal !== this.#principal || t.connection !== this.#connection)
            throw new GatewayError("FORBIDDEN");
        const key = scopeKey(targetScope(t)), old = this.#targets.get(key);
        if (old && ownerKey(old) !== ownerKey(t))
            throw new GatewayError("FENCED");
        if (!old && this.#targets.size + this.#hostTargets.size >= 64)
            throw new GatewayError("FULL");
        this.#targets.set(key, t);
        if (old && old.routeEpoch !== t.routeEpoch) {
            this.#failedHealth();
            for (const feed of this.#feeds.values())
                if (feed.scope && scopeKey(feed.scope) === key) {
                    this.#cancel(feed);
                    feed.terminal = false;
                    this.#start(feed);
                }
        }
    }
    snapshot(scope: SessionScope): Promise<SessionSnapshot> { this.#ready(); return this.#transport.snapshot(this.#target(scope)); }
    mcpLoginLink(input: RunRef, originalId: string) {
        this.#ready(); id(originalId); const run = copy(input), t = this.#target(run.scope);
        if (!this.#transport.mcpLoginLink) throw new GatewayError('UNAVAILABLE');
        return this.#transport.mcpLoginLink(t, run, originalId).then(value => {
            this.#ready(); if (targetKey(this.#target(run.scope)) !== targetKey(t)) throw new GatewayError('FENCED');
            return validateLoginLink(value);
        });
    }
    read(input: RunRef, request: NativeRead): Promise<NativeReadResult> {
        this.#ready(); const run=copy(input),query=copy(request),t=this.#target(run.scope);
        if(!this.#transport.read) throw new GatewayError("UNAVAILABLE");
        return this.#transport.read(t,run,query).then(value=>{
            this.#ready(); if(targetKey(this.#target(run.scope))!==targetKey(t)) throw new GatewayError("FENCED");
            return validateNativeReadResult(run,query,value);
        });
    }
    controlCatalog(scope: SessionScope): Promise<Catalog> {
        this.#ready();
        const t = this.#target(scope);
        if (!this.#transport.controlCatalog)
            throw new GatewayError("UNAVAILABLE");
        return this.#transport.controlCatalog(t).then(value => { this.#ready(); if (targetKey(this.#target(scope)) !== targetKey(t))
            throw new GatewayError("FENCED"); return validateCatalog(value); });
    }
    #receipt(scope: SessionScope, operationId: string, receipt: Receipt | null): Receipt | null {
        this.#open();
        if (receipt === null)
            return null;
        canonical(receipt);
        const original = this.#originals.get(JSON.stringify([scopeKey(scope), operationId]))?.request;
        if (scopeKey(receipt.scope) !== scopeKey(scope) || receipt.id !== operationId || (original && (receipt.type !== original.command.type || receipt.generation !== original.generation)))
            throw new GatewayError("FENCED");
        if (receipt.state === "acknowledged" || receipt.state === "refused")
            this.#originals.delete(JSON.stringify([scopeKey(scope), operationId]));
        return copy(receipt);
    }
    submit(value: Submit): Promise<Receipt> {
        this.#ready();
        const request = copy(value), t = this.#target(request.scope);
        canonical(request);
        id(request.id);
        const key = JSON.stringify([scopeKey(request.scope), request.id]), old = this.#originals.get(key);
        if (old) {
            if (canonical(old.request) !== canonical(request))
                throw new GatewayError("FENCED");
            throw new GatewayError("ALREADY_ATTEMPTED", "Read the original receipt; automatic forwarding is forbidden");
        }
        if (this.#originals.size >= this.#maxOperations + Number(request.command.type === "stop"))
            throw new GatewayError("FULL");
        this.#originals.set(key, { target: t, request });
        return this.#transport.submit(t, request).then(receipt => this.#receipt(request.scope, request.id, receipt)!);
    }
    receipt(scope: SessionScope, operationId: string): Promise<Receipt | null> { this.#ready(); id(operationId); const current = this.#target(scope), old = this.#originals.get(JSON.stringify([scopeKey(scope), operationId])); if (old && ownerKey(old.target) !== ownerKey(current)) throw new GatewayError("FENCED"); return this.#transport.receipt(current, operationId).then(receipt => this.#receipt(scope, operationId, receipt)); }
    subscribe(scope: SessionScope, listener: (snapshot: SessionSnapshot) => void): () => void {
        this.#target(scope);
        const s = copy(scope);
        return this.#retain({ key: `session:${scopeKey(s)}`, scope: s, observation: { scope: s, kind: "session" }, start: (signal, ready) => this.#transport.watchSession(this.#target(s), signal, ready), accept: value => { if (scopeKey((value as SessionSnapshot).scope) !== scopeKey(s))
                throw new GatewayError("FENCED"); } }, listener as (value: unknown) => void);
    }
    observeHistory(scope: SessionScope, value: Scope): Readonly<{
        release(): void;
    }> {
        const t = this.#target(scope), s = copy(value), session = copy(scope);
        if (s.origin.connection !== t.connection || s.origin.principal !== t.principal || s.origin.host !== t.host)
            throw new GatewayError("FENCED");
        const client = this.#history.session(s).client;
        const release = this.#retain({ key: `history:${historyKey(s)}`, scope: session, observation: { scope: session, kind: "history", history: s }, start: (signal, ready) => { const current = client.current; return this.#transport.watchHistory({ target: this.#target(session), scope: s, ...(current ? { cursor: { generation: current.generation, revision: current.revision } } : {}) }, signal, ready); }, accept: value => { if (client.apply(value as Parameters<typeof client.apply>[0]) === "needsSnapshot")
                throw new GatewayError("FENCED", "Retained Host snapshot required"); } });
        return Object.freeze({ release });
    }
    catalogPort(): CatalogPort {
        const scope = (s: CatalogScope) => { this.#open(); if (s.connection !== this.#connection || s.principal !== this.#principal)
            throw new GatewayError("FORBIDDEN"); return copy(s); };
        return Object.freeze({ list: s => { this.#ready(); if (!this.#transport.list)
                throw new GatewayError("UNAVAILABLE"); return this.#transport.list(scope(s)); }, get: (s, session) => { this.#ready(); if (!this.#transport.get)
                throw new GatewayError("UNAVAILABLE"); return this.#transport.get(scope(s), session); }, create: request => { this.#ready(); scope(request.scope); if (!this.#transport.create)
                throw new GatewayError("UNAVAILABLE"); return this.#transport.create(copy(request)); }, creation: (s, id) => { this.#ready(); if (!this.#transport.creation)
                throw new GatewayError("UNAVAILABLE"); return this.#transport.creation(scope(s), id); }, rename: request => { this.#ready(); scope(request.scope); if (!this.#transport.rename)
                throw new GatewayError("UNAVAILABLE"); return this.#transport.rename(copy(request)); }, setWatched: request => { this.#ready(); scope(request.scope); if (!this.#transport.setWatched) throw new GatewayError("UNAVAILABLE"); return this.#transport.setWatched(copy(request)); }, metadataOriginal: (s, id) => { this.#ready(); if (!this.#transport.metadataOriginal) throw new GatewayError("UNAVAILABLE"); return this.#transport.metadataOriginal(scope(s), id); }, publishArchive: request => { this.#ready(); scope(request.scope); if (!this.#transport.publishArchive) throw new GatewayError("UNAVAILABLE"); return this.#transport.publishArchive(copy(request)); }, subscribe: (s, listener) => { const frozen = scope(s); if (!this.#transport.watchCatalog)
                throw new GatewayError("UNAVAILABLE"); return this.#retain({ key: `catalog:${canonical(frozen)}`, observation: { scope: frozen, kind: "catalog" }, start: (signal, ready) => this.#transport.watchCatalog!(frozen, signal, ready) }, listener as (value: unknown) => void); } } satisfies CatalogPort);
    }
    interactionPort(scope: SessionScope): InteractionPort {
        const s = copy(scope);
        this.#target(s);
        const check = (value: SessionScope) => { if (scopeKey(value) !== scopeKey(s))
            throw new GatewayError("FENCED"); };
        return Object.freeze({ snapshot: value => { this.#ready(); check(value); if (!this.#transport.interactionSnapshot)
                throw new GatewayError("UNAVAILABLE"); return this.#transport.interactionSnapshot(this.#target(s)); }, subscribe: (value, listener) => { check(value); if (!this.#transport.watchInteractions)
                throw new GatewayError("UNAVAILABLE"); return this.#retain({ key: `interactions:${scopeKey(s)}`, scope: s, observation: { scope: s, kind: "interactions" }, start: (signal, ready) => this.#transport.watchInteractions!(this.#target(s), signal, ready) }, listener as (value: unknown) => void); } } satisfies InteractionPort);
    }
    mcpPort(scope: SessionScope): McpPort {
        const s = copy(scope);
        this.#target(s);
        const check = (run: RunRef) => { if (scopeKey(run.scope) !== scopeKey(s))
            throw new GatewayError("FENCED"); return copy(run); };
        return Object.freeze({ snapshot: run => { this.#ready(); const frozen = check(run); if (!this.#transport.mcpSnapshot)
                throw new GatewayError("UNAVAILABLE"); return this.#transport.mcpSnapshot(this.#target(s), frozen); }, refresh: (run, observation = {}) => { this.#ready(); const frozen = check(run); if (!this.#transport.mcpRefresh)
                throw new GatewayError("UNAVAILABLE"); return this.#transport.mcpRefresh(this.#target(s), frozen, observation); }, subscribe: (run, listener) => { const frozen = check(run); if (!this.#transport.watchMcp)
                throw new GatewayError("UNAVAILABLE"); return this.#retain({ key: `mcp:${canonical(frozen)}`, scope: s, observation: { scope: s, kind: "mcp", run: frozen }, start: (signal, ready) => this.#transport.watchMcp!(this.#target(s), frozen, signal, ready) }, listener as (value: unknown) => void); } } satisfies McpPort);
    }
    historyScopes(scope: SessionScope): Promise<readonly Scope[]> { this.#ready(); const target=this.#target(scope); if(!this.#transport.historyScopes)throw new GatewayError('UNAVAILABLE'); return this.#transport.historyScopes(target).then(value=>{this.#ready();if(targetKey(this.#target(scope))!==targetKey(target))throw new GatewayError('FENCED');return copy(value);}); }
    older(scope: SessionScope, history: Scope, cursor: string, generation?: string, retryToken?: string): Promise<HistoryPage> { this.#ready(); return this.#transport.older(this.#target(scope), copy(history), cursor, generation, retryToken).then(page => { this.#open(); return page; }); }
    recover(scope: SessionScope, history: Scope, observation: HistoryObservation = {}, retryToken?: string): Promise<HistoryRecovery> { this.#ready(); if (!this.#transport.recover)
        return Promise.resolve({ state: "value", value: { status: "unsupported" } }); return this.#transport.recover(this.#target(scope), copy(history), observation, retryToken).then(value => { this.#open(); return value; }); }
    disconnect(): void { this.#open(); this.#failedHealth(); this.#enabled = false; this.#cancelTimer(); for (const feed of this.#feeds.values()) {
        this.#cancel(feed);
        this.#observation(feed, "disconnected");
    } this.#refreshFenced = false; this.#transport.disconnect?.(); this.#connectionState(false); }
    reconnect(): void { this.#open(); this.#failedHealth(); this.#enabled = true; this.#cancelTimer(); this.#transport.reconnect?.(); if (!this.#beforeObserve) this.#connectionState(true); for (const feed of this.#feeds.values()) {
        this.#cancel(feed);
        feed.terminal = false;
    } this.#restoreObservations(); }
    get originalCount(): number { return this.#originals.size; }
    fence(): void { if (this.#closed)
        return; this.disconnect(); this.#closed = true; this.#detach?.(); try {
        this.#transport.close();
    }
    finally {
        this.#originals.clear();
        this.#targets.clear();
        this.#hostTargets.clear();
        this.#feeds.clear();
        this.#principal = "";
        this.#connection = "";
        try {
            this.#onFence();
        }
        catch { /* Revocation remains complete if detached UI cleanup fails. */ }
    } }
    close(): void { this.fence(); }
}
