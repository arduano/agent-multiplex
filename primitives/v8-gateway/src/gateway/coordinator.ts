import type { Catalog, SessionSnapshot, Submit, Receipt } from "../../../v8-session/src/contracts/types.js";
import { validateCatalog } from "../../../v8-session/src/native/validation.js";
import { scopeKey } from "../../../v8-session/src/contracts/types.js";
import { canonical, copy, id } from "../../../v8-session/src/contracts/validation.js";
import type { InteractionSnapshot } from "../../../v8-interactions/src/contracts.js";
import { validateScope as historyScope } from "../../../v8-history/src/contracts/validation.js";
import type { Frame, Scope, HistoryPage } from "../../../v8-history/src/contracts/types.js";
import type { HistoryObservation, HistoryRecovery } from "../../../v8-history/src/acquisition/types.js";
import type { ArchivePublication, CatalogScope, CreateRequest, RenameRequest, WatchRequest, MetadataOriginal, CatalogEntry, Creation } from "../../../v8-catalog/src/contracts/types.js";
import { GatewayError, ownerKey, targetKey, targetScope, type GatewayTarget, type Identity, type SessionRoute, type GatewayBinding, type RemoteRouteVerifier, type StreamRequest, type ForwardObservation, type CatalogRoute, type GatewayAction } from "../contracts/types.js";
import { target, authorized, bounded, historyRetryToken } from "../contracts/validation.js";
import type { RunRef } from "../../../v8-session/src/contracts/types.js";
import type { NativeRead, NativeReadResult } from "../../../v8-session/src/contracts/types.js";
import { validateNativeRead, validateNativeReadResult } from "../../../v8-harness-defaults/src/state.js";
import type { McpSnapshot, Observation } from "../../../v8-mcp/src/contracts.js";
import type { FilePort, FileScope } from "../../../v8-files/src/contracts/types.js";
import { ViewerQueue } from "./queue.js";
import { validateLoginLink } from '../../../v8-session/src/contracts/mcp-login.js';
import { hostRpcKey, hostRpcOwnerKey, hostRpcRequest, hostRpcTarget, rpcFault, type HostRpcCall, type HostRpcRegistration, type HostRpcRequest, type HostRpcTarget, type RpcResult } from '../contracts/rpc.js';

type Registered={route:SessionRoute; reachable:boolean;expiresAt?:number;revoked?:AbortSignal;detach?:()=>void};
type Watch={key:string; queue:ViewerQueue<unknown>};
type PendingRead={start():void;reject(error:GatewayError):void};
export type GatewayLimits=Readonly<{routes:number;forward:number;urgent:number;reads:number;readQueue:number;subscribers:number;frames:number;bytes:number}>;
const defaults:GatewayLimits={routes:64,forward:8,urgent:4,reads:4,readQueue:64,subscribers:128,frames:16,bytes:1048576};
const gatewayActions: readonly GatewayAction[] = ['read', 'control', 'catalogWrite', 'fileWrite', 'mcpRefresh'];
const catalogKey = (scope: CatalogScope): string => JSON.stringify([scope.connection, scope.principal, scope.authority]);
/** Snapshot before registration can retire an old route or await a verifier. */
function routeActions(value: readonly GatewayAction[] | undefined): readonly GatewayAction[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > gatewayActions.length) throw new GatewayError('INVALID');
  const actions = [...value];
  if (actions.some(action => !gatewayActions.includes(action)) || new Set(actions).size !== actions.length) throw new GatewayError('INVALID');
  return Object.freeze(actions);
}

/** Routing/observation only: no native lifecycle, catalog state, journal, outbox or replay owner. */
export class GatewayCoordinator {
  readonly #limits:GatewayLimits; readonly #routes=new Map<string,Registered>(); readonly #current=new Map<string,string>();
  readonly #tasks=new Map<string,{meaning:string;promise:Promise<Receipt>}>(); readonly #watches=new Set<Watch>();
  readonly #catalogs=new Map<string,CatalogRoute>();readonly #remoteSeen=new Map<string,number>();readonly #expiryTimers=new Map<string,ReturnType<typeof setTimeout>>(); #active=0;#urgent=0;#reads=0;#closed=false;
  readonly #hostRoutes = new Map<string, HostRpcRegistration>();
  readonly #hostCurrent = new Map<string, string>();
  readonly #readInbox:PendingRead[]=[];
  constructor(limits:Partial<GatewayLimits>={},readonly remoteVerifier?:RemoteRouteVerifier) { this.#limits={...defaults,...limits}; for(const v of Object.values(this.#limits)) bounded(v,1048576); }
  /** Trusted same-process Host composition only. Remote callers must use registerRemote. */
  register(input:SessionRoute):()=>void {
    this.#open(); const t=target(input.target), key=targetKey(t);
    const actions=routeActions(input.actions);
    if(this.#routes.has(key)) throw new GatewayError("FENCED","Route epoch already registered");
    const logical=(v:GatewayTarget)=>JSON.stringify([v.connection,v.principal,v.authority,v.host,v.session]);
    for(const [oldKey,entry] of [...this.#routes])if(logical(entry.route.target)===logical(t)){
      if(entry.route.target.owner!==t.owner&&entry.reachable)throw new GatewayError("FENCED","Conflicting durable owner");
      this.unavailable(entry.route.target);entry.detach?.();clearTimeout(this.#expiryTimers.get(oldKey));this.#expiryTimers.delete(oldKey);this.#routes.delete(oldKey);this.#current.delete(ownerKey(entry.route.target));
    }
    if(this.#routes.size+this.#hostRoutes.size>=this.#limits.routes) throw new GatewayError("FULL");
    const route=Object.freeze({...input,target:t,...(actions===undefined?{}:{actions})}),entry:Registered={route,reachable:true}; this.#routes.set(key,entry); this.#current.set(ownerKey(t),key);
    // Observation-edge release only. Exact registration identity lets a later
    // mount reuse this epoch without a stale disposer retiring its replacement.
    return()=>{
      if(this.#routes.get(key)!==entry)return;
      this.unavailable(t);entry.detach?.();clearTimeout(this.#expiryTimers.get(key));this.#expiryTimers.delete(key);this.#routes.delete(key);
      if(this.#current.get(ownerKey(t))===key)this.#current.delete(ownerKey(t));
    };
  }
  async registerRemote(input:SessionRoute,authorization:string):Promise<void> {
    this.#open();const actions=routeActions(input.actions),frozen={...input,target:target(input.target),...(actions===undefined?{}:{actions})};
    if(!this.remoteVerifier)throw new GatewayError("UNAUTHENTICATED");
    const claim=await this.remoteVerifier(authorization);this.#open();
    if(!claim||!claim.revoked||claim.revoked.aborted||!Number.isSafeInteger(claim.expiresAt)||claim.expiresAt<=Date.now()||canonical(target(claim.target))!==canonical(frozen.target))throw new GatewayError("FORBIDDEN");
    for(const [key,expiresAt]of this.#remoteSeen)if(expiresAt<=Date.now())this.#remoteSeen.delete(key);
    const key=targetKey(frozen.target);if(this.#remoteSeen.has(key))throw new GatewayError("FENCED");if(this.#remoteSeen.size>=128)throw new GatewayError("FULL");
    this.register(frozen);const entry=this.#routes.get(key)!;entry.expiresAt=claim.expiresAt;entry.revoked=claim.revoked;this.#remoteSeen.set(key,claim.expiresAt);
    const revoke=()=>this.unavailable(frozen.target);claim.revoked.addEventListener("abort",revoke,{once:true});entry.detach=()=>claim.revoked.removeEventListener("abort",revoke);if(claim.revoked.aborted)revoke();
    const timer=setTimeout(()=>{this.#expiryTimers.delete(key);this.unavailable(frozen.target);},Math.min(claim.expiresAt-Date.now(),2147483647));timer.unref();this.#expiryTimers.set(key,timer);
  }
  registerCatalog(input:CatalogRoute):void {
    this.#open(); canonical(input.scope); id(input.owner);
    const actions=routeActions(input.actions);
    const key=catalogKey(input.scope);
    if(this.#catalogs.has(key) || this.#catalogs.size>=this.#limits.routes) throw new GatewayError("FENCED");
    this.#catalogs.set(key,Object.freeze({...input,scope:copy(input.scope),...(actions===undefined?{}:{actions})}));
  }
  /** Ends current observations only; the retained owner restores its transport. */
  unavailableCatalog(scope: CatalogScope): void {
    const key = `catalog:${catalogKey(scope)}`;
    for (const watch of [...this.#watches]) if (watch.key === key) watch.queue.fail(new GatewayError('UNAVAILABLE'));
  }
  /** Trusted configured Host/Peer binding. Browser requests cannot register routes. */
  registerHostRpc(input: HostRpcRegistration): () => void {
    this.#open();
    const target = hostRpcTarget(input.target), key = hostRpcKey(target);
    const actions = routeActions(input.actions);
    if (this.#hostRoutes.has(key)) throw new GatewayError('FENCED');
    for (const [oldKey, old] of this.#hostRoutes) {
      const previous = old.target;
      if (previous.connection !== target.connection || previous.principal !== target.principal
        || previous.authority !== target.authority || previous.host !== target.host) continue;
      if (previous.owner !== target.owner) throw new GatewayError('FENCED');
      this.unavailableHostRpc(previous);
      this.#hostRoutes.delete(oldKey);
    }
    if (this.#routes.size + this.#hostRoutes.size >= this.#limits.routes) throw new GatewayError('FULL');
    const registration = Object.freeze({ target, port: input.port, ...(actions === undefined ? {} : { actions }) });
    this.#hostRoutes.set(key, registration);
    this.#hostCurrent.set(hostRpcOwnerKey(target), key);
    // A released route can be mounted again. Release never closes the Host,
    // cancels admitted work or removes a newer registration with the same key.
    return () => {
      if (this.#hostRoutes.get(key) !== registration) return;
      this.unavailableHostRpc(target);
      this.#hostRoutes.delete(key);
    };
  }
  unavailableHostRpc(input: HostRpcTarget): void {
    const target = hostRpcTarget(input), key = hostRpcKey(target);
    if (this.#hostCurrent.get(hostRpcOwnerKey(target)) === key) this.#hostCurrent.delete(hostRpcOwnerKey(target));
    for (const watch of [...this.#watches]) if (watch.key === `rpc:${key}`) watch.queue.fail(new GatewayError('UNAVAILABLE'));
  }
  #rpcRoute(identity: Identity, request: HostRpcRequest, mutation = false): HostRpcRegistration {
    this.#open();
    const target = request.target;
    if (identity.connection !== target.connection || identity.principal !== target.principal
      || !identity.authorities.includes(target.authority) || !identity.actions.includes(mutation ? 'control' : 'read')) throw new GatewayError('FORBIDDEN');
    const key = hostRpcKey(target), registered = this.#hostRoutes.get(key);
    if (!registered || this.#hostCurrent.get(hostRpcOwnerKey(target)) !== key) throw new GatewayError('UNAVAILABLE');
    if (registered.actions && !registered.actions.includes(mutation ? 'control' : 'read')) throw new GatewayError('FORBIDDEN');
    const manifest = registered.port.manifest, expected = request.expected;
    if (manifest.contractId !== expected.contractId || manifest.contractVersion !== expected.contractVersion
      || manifest.compositionId !== expected.compositionId) throw new GatewayError('FENCED');
    return registered;
  }
  rpcCall(identity: Identity, input: HostRpcCall): Promise<RpcResult> {
    const request: HostRpcCall = { ...hostRpcRequest(input), type: input.type };
    // Backend-only standard ports have operation-specific ceilings. Generic
    // plugin mutations use control and must not tunnel through that boundary.
    if (['multiplex', 'multiplexFiles'].some(prefix => request.path === prefix || request.path.startsWith(`${prefix}.`))) throw new GatewayError('FORBIDDEN');
    if (request.type !== 'query' && request.type !== 'mutation') throw new GatewayError('INVALID');
    const caller = copy(identity), registered = this.#rpcRoute(caller, request, request.type === 'mutation');
    const forwarded = { ...caller, actions: registered.actions === undefined ? [...caller.actions] : caller.actions.filter(action => registered.actions!.includes(action)) };
    const work = async (): Promise<RpcResult> => {
      try {
        // Forwarding capacity remains reserved until actual Peer work settles.
        const value = await registered.port.call(copy(forwarded), request);
        if (this.#rpcRoute(caller, request, request.type === 'mutation') !== registered) throw new GatewayError('FENCED');
        return { ok: true, value: value === undefined ? null : copy(value) };
      } catch (error) { return { ok: false, error: rpcFault(error) }; }
    };
    if (request.type === 'query') return this.#read(work, () => { if (this.#rpcRoute(caller, request) !== registered) throw new GatewayError('FENCED'); });
    if (registered.port.urgent?.(request)) {
      if (this.#urgent >= this.#limits.urgent) throw new GatewayError('FULL');
      this.#urgent++;
      return work().finally(() => { this.#urgent--; });
    }
    return this.#mutation(work);
  }
  watchRpc(identity: Identity, input: HostRpcRequest): ViewerQueue<RpcResult> {
    const request = hostRpcRequest(input);
    if (['multiplex', 'multiplexFiles'].some(prefix => request.path === prefix || request.path.startsWith(`${prefix}.`))) throw new GatewayError('FORBIDDEN');
    const caller = copy(identity), registered = this.#rpcRoute(caller, request);
    const forwarded = { ...caller, actions: registered.actions === undefined ? [...caller.actions] : caller.actions.filter(action => registered.actions!.includes(action)) };
    const queue = this.#queue<RpcResult>(`rpc:${hostRpcKey(request.target)}`), controller = new AbortController();
    queue.setCleanup(this.#release(queue, () => controller.abort()));
    void (async () => {
      try {
        for await (const value of registered.port.watch(copy(forwarded), request, controller.signal)) {
          if (controller.signal.aborted) return;
          if (this.#rpcRoute(caller, request) !== registered) throw new GatewayError('FENCED');
          queue.push({ ok: true, value: value === undefined ? null : copy(value) });
        }
        queue.finish();
      } catch (error) {
        if (!controller.signal.aborted) { queue.push({ ok: false, error: rpcFault(error) }); queue.finish(); }
      }
    })();
    return queue;
  }
  /** Observational route loss never changes catalog custody or native lifetime. */
  unavailable(t:GatewayTarget):void {
    const key=targetKey(target(t)), entry=this.#routes.get(key); if(entry) entry.reachable=false;
    for(const watch of [...this.#watches]) if(watch.key===key) watch.queue.fail(new GatewayError("UNAVAILABLE"));
  }
  #open():void {if(this.#closed) throw new GatewayError("CLOSED");}
  #route(identity:Identity,input:GatewayTarget,receipt=false,action:GatewayAction="read"):Registered {
    this.#open(); const t=target(input); authorized(identity,t,action);
    // The current transport can read an old original only after trusted registration proves the exact durable owner.
    const key=receipt?this.#current.get(ownerKey(t)):targetKey(t), entry=key?this.#routes.get(key):undefined;
    if(!entry || !entry.reachable || entry.revoked?.aborted || (entry.expiresAt!==undefined&&entry.expiresAt<=Date.now())) throw new GatewayError("UNAVAILABLE");
    if(entry.route.actions&&!entry.route.actions.includes(action))throw new GatewayError("FORBIDDEN");
    if(!receipt && this.#current.get(ownerKey(t))!==key) throw new GatewayError("FENCED");
    return entry;
  }
  #read<T>(work:()=>Promise<T>,current?:()=>void):Promise<T> {
    this.#open();
    if(this.#reads>=this.#limits.reads&&this.#readInbox.length>=this.#limits.readQueue)return Promise.reject(new GatewayError("FULL"));
    return new Promise<T>((resolve,reject)=>{
      const pending:PendingRead={reject,start:()=>{
        this.#reads++;
        void(async()=>{
          try{
            // Reserve the slot before yielding; even a rejected stale route
            // drains through this same owner without recursive FIFO dispatch.
            await Promise.resolve();this.#open();current?.();
            const value=await work();this.#open();current?.();resolve(value);
          }catch(error){reject(error);}
          finally{this.#reads--;this.#drainReads();}
        })();
      }};
      if(this.#reads<this.#limits.reads)pending.start();else this.#readInbox.push(pending);
    });
  }
  #drainReads():void {while(!this.#closed&&this.#reads<this.#limits.reads&&this.#readInbox.length)this.#readInbox.shift()!.start();}
  #readRoute<T>(identity:Identity,t:GatewayTarget,work:(route:SessionRoute)=>Promise<T>,receipt=false,action:GatewayAction="read"):Promise<T> {
    const caller=copy(identity),requested=target(t),entry=this.#route(caller,requested,receipt,action);
    const current=()=>{if(this.#route(caller,requested,receipt,action)!==entry)throw new GatewayError("FENCED");};
    return this.#read(()=>work(entry.route),current);
  }
  snapshot(identity:Identity,t:GatewayTarget):Promise<SessionSnapshot> {return this.#readRoute(identity,t,route=>route.session.snapshot(targetScope(route.target)));}
  mcpLoginLink(identity: Identity, t: GatewayTarget, input: RunRef, originalId: string) {
    const caller = copy(identity), run = copy(input); id(originalId);
    const entry = this.#route(caller, t, false, 'control'); this.#route(caller, t, false, 'read');
    const route = entry.route;
    if (!route.session.mcpLoginLink) throw new GatewayError('UNAVAILABLE');
    if (scopeKey(run.scope) !== scopeKey(targetScope(route.target))) throw new GatewayError('FENCED');
    const current = () => { if (this.#route(caller, t, false, 'control') !== entry || this.#route(caller, t, false, 'read') !== entry) throw new GatewayError('FENCED'); };
    return this.#read(async () => {
      const link = validateLoginLink(await route.session.mcpLoginLink!(run, originalId));
      return link;
    },current);
  }
  nativeRead(identity:Identity,t:GatewayTarget,input:RunRef,request:NativeRead):Promise<NativeReadResult> {
    const caller=copy(identity),run=copy(input),query=copy(request),entry=this.#route(caller,t),route=entry.route;
    if(!route.session.read)throw new GatewayError("UNAVAILABLE");
    if(scopeKey(run.scope)!==scopeKey(targetScope(route.target)))throw new GatewayError("FENCED");
    return this.#read(async()=>{
      const before=await route.session.snapshot(targetScope(route.target));
      const read=validateNativeRead(before.kind,query);
      if(scopeKey(before.scope)!==scopeKey(run.scope)||before.generation!==run.generation||before.nativeSession!==run.nativeSession)throw new GatewayError("FENCED");
      const value=validateNativeReadResult(run,read,await route.session.read!(run,read));
      const after=await route.session.snapshot(targetScope(route.target));
      if(this.#route(caller,route.target)!==entry||scopeKey(after.scope)!==scopeKey(run.scope)||after.epoch!==before.epoch||after.generation!==run.generation||after.nativeSession!==run.nativeSession||after.phase!==before.phase||after.stopRequested!==before.stopRequested)throw new GatewayError("FENCED");
      return value;
    },()=>{if(this.#route(caller,route.target)!==entry)throw new GatewayError("FENCED");});
  }
  controlCatalog(identity:Identity,t:GatewayTarget):Promise<Catalog> {
    const caller=copy(identity),entry=this.#route(caller,t),route=entry.route;
    if(!route.controlCatalog)throw new GatewayError("UNAVAILABLE");
    return this.#read(async()=>{
      const before=await route.session.snapshot(targetScope(route.target));
      const value=validateCatalog(await route.controlCatalog!());
      const after=await route.session.snapshot(targetScope(route.target));
      if(this.#route(caller,route.target)!==entry||scopeKey(before.scope)!==scopeKey(targetScope(route.target))||scopeKey(after.scope)!==scopeKey(before.scope)||!Number.isSafeInteger(before.epoch)||before.epoch<1||after.epoch!==before.epoch)throw new GatewayError("FENCED");
      return value;
    },()=>{if(this.#route(caller,route.target)!==entry)throw new GatewayError("FENCED");});
  }
  receipt(identity:Identity,t:GatewayTarget,operationId:string):Promise<Receipt|null> {
    id(operationId);return this.#readRoute(identity,t,route=>route.session.receipt(targetScope(route.target),operationId),true);
  }
  submit(identity:Identity,input:GatewayTarget,value:Submit):Promise<Receipt> {
    const {route}=this.#route(identity,input,false,"control"); const request=copy(value);canonical(request);
    if(scopeKey(request.scope)!==scopeKey(targetScope(route.target))) throw new GatewayError("FENCED");
    id(request.id);if(!Number.isSafeInteger(request.generation)||request.generation<0) throw new GatewayError("INVALID");
    // Validate complete meaning before the first forwarding effect; harness-specific validation remains Host-owned.
    if(!request.command || typeof request.command!=="object" || typeof request.command.type!=="string") throw new GatewayError("INVALID");
    const key=JSON.stringify([ownerKey(route.target),request.id]), meaning=canonical(request), old=this.#tasks.get(key);
    if(old) {if(old.meaning!==meaning) throw new GatewayError("FENCED");return old.promise;}
    const urgent=request.command.type==="stop"||request.command.type==="answer"||request.command.type==="codex.interrupt"||request.command.type==="copilot.abort";
    if(urgent?this.#urgent>=this.#limits.urgent:this.#active>=this.#limits.forward) throw new GatewayError("FULL");
    if(urgent)this.#urgent++;else this.#active++;
    // Neither HTTP abort nor caller deadline is passed into admitted forwarding.
    const promise=Promise.resolve().then(()=>{this.#route(identity,route.target,false,"control");return route.session.submit(request);}).finally(()=>{this.#tasks.delete(key);if(urgent)this.#urgent--;else this.#active--;});
    this.#tasks.set(key,{meaning,promise});void promise.catch(()=>undefined);return promise;
  }
  #queue<T>(key:string):ViewerQueue<T> {
    this.#open();if(this.#watches.size>=this.#limits.subscribers) throw new GatewayError("FULL");
    const queue=new ViewerQueue<T>(this.#limits.frames,this.#limits.bytes), watch:Watch={key,queue:queue as ViewerQueue<unknown>};this.#watches.add(watch);
    queue.setCleanup(()=>{this.#watches.delete(watch);});return queue;
  }
  #release<T>(queue:ViewerQueue<T>,unsubscribe:()=>void):()=>void{return()=>{try{unsubscribe();}finally{for(const watch of this.#watches)if(watch.queue===queue as unknown)this.#watches.delete(watch);}};}
  watchSession(identity:Identity,t:GatewayTarget):ViewerQueue<SessionSnapshot> {
    const {route}=this.#route(identity,t), queue=this.#queue<SessionSnapshot>(targetKey(route.target));
    let unsubscribe:()=>void;try{unsubscribe=route.session.subscribe(targetScope(route.target),value=>queue.push(copy(value)),error=>queue.fail(error));}catch(e){queue.fail(e);throw e;}
    queue.setCleanup(this.#release(queue,unsubscribe));return queue;
  }
  #history(route:SessionRoute,scope:Scope):Scope {
    const s=historyScope(scope),t=route.target;
    if(s.origin.connection!==t.connection||s.origin.principal!==t.principal||s.origin.host!==t.host||!route.authorizeHistory(s))throw new GatewayError("FENCED");return copy(s);
  }
  historyScopes(identity:Identity,t:GatewayTarget):Promise<readonly Scope[]> {
    const caller=copy(identity),entry=this.#route(caller,t),route=entry.route;
    if(!route.history.scopes)throw new GatewayError("UNAVAILABLE");
    return this.#read(async()=>{
      const binding=await this.#binding(route); if(!binding)throw new GatewayError("UNAVAILABLE");
      const values=await route.history.scopes!();
      if(this.#route(caller,route.target)!==entry)throw new GatewayError("FENCED");
      if(!Array.isArray(values)||values.length>32)throw new GatewayError("INVALID");
      const seen=new Set<string>(),root=canonical(binding.history),origin=canonical(binding.history.origin);
      const scopes=values.map(value=>{
        const scope=this.#history(route,value),key=canonical(scope);
        if(scope.kind!==binding.history.kind||canonical(scope.origin)!==origin||seen.has(key))throw new GatewayError("FENCED");
        seen.add(key);return scope;
      });
      if(!seen.has(root))throw new GatewayError("FENCED");
      return Object.freeze(scopes);
    },()=>{if(this.#route(caller,route.target)!==entry)throw new GatewayError("FENCED");});
  }
  watchHistory(identity:Identity,input:StreamRequest):ViewerQueue<Frame> {
    const {route}=this.#route(identity,input.target),scope=this.#history(route,input.scope);
    if(input.cursor && (!Number.isSafeInteger(input.cursor.revision)||input.cursor.revision<0||typeof input.cursor.generation!=="string"))throw new GatewayError("INVALID");
    const queue=this.#queue<Frame>(targetKey(route.target));let upstream:AsyncIterableIterator<Frame>;try{upstream=route.history.watch(scope,input.cursor?copy(input.cursor):undefined);}catch(e){queue.fail(e);throw e;}
    queue.setCleanup(this.#release(queue,()=>{void Promise.resolve(upstream.return?.()).catch(()=>undefined);}));
    void(async()=>{try{for await(const frame of upstream)queue.push(copy(frame));queue.finish();}catch(error){queue.fail(error);}})();return queue;
  }
  older(identity:Identity,t:GatewayTarget,input:Scope,cursor:string,generation?:string,retryToken?:string):Promise<HistoryPage> {
    const {route}=this.#route(identity,t),scope=this.#history(route,input);if(typeof cursor!=="string"||!cursor.length||cursor.length>16384)throw new GatewayError("INVALID");if(!route.history.older)throw new GatewayError("UNAVAILABLE");
    const retry=historyRetryToken(retryToken);
    return this.#readRoute(identity,t,async route=>{if(!route.history.older)throw new GatewayError("UNAVAILABLE");return route.history.older(this.#history(route,scope),cursor,generation,retry);});
  }
  recover(identity:Identity,t:GatewayTarget,input:Scope,observation:HistoryObservation={},retryToken?:string):Promise<HistoryRecovery> {
    const caller=copy(identity),entry=this.#route(caller,t),route=entry.route,scope=copy(historyScope(input));
    if(scope.origin.connection!==route.target.connection||scope.origin.principal!==route.target.principal||scope.origin.host!==route.target.host)throw new GatewayError("FENCED");
    const retry=historyRetryToken(retryToken);
    if(!route.history.recover)return Promise.resolve({state:"value",value:{status:"unsupported"}});
    return this.#read(async()=>{
      if(!route.authorizeHistory(scope)){
        if(!route.history.authorize)throw new GatewayError("FENCED");
        const binding=await this.#binding(route);
        if(!binding||scope.kind!==binding.history.kind||canonical(scope.origin)!==canonical(binding.history.origin))throw new GatewayError("FENCED");
        const proof=await route.history.authorize(scope,observation);
        if(this.#route(caller,route.target)!==entry)throw new GatewayError("FENCED");
        if(proof.state!=="value")return proof;
      }
      this.#history(route,scope);
      const result=await route.history.recover!(scope,observation,retry);
      if(this.#route(caller,route.target)!==entry)throw new GatewayError("FENCED");
      return result;
    },()=>{if(this.#route(caller,route.target)!==entry)throw new GatewayError("FENCED");});
  }
  interactionSnapshot(identity:Identity,t:GatewayTarget):Promise<InteractionSnapshot>{return this.#readRoute(identity,t,route=>{if(!route.interactions)throw new GatewayError("UNAVAILABLE");return route.interactions.snapshot(targetScope(route.target));});}
  watchInteractions(identity:Identity,t:GatewayTarget):ViewerQueue<InteractionSnapshot>{
    const {route}=this.#route(identity,t);if(!route.interactions)throw new GatewayError("UNAVAILABLE");const queue=this.#queue<InteractionSnapshot>(targetKey(route.target));
    let unsubscribe:()=>void;try{unsubscribe=route.interactions.subscribe(targetScope(route.target),v=>queue.push(copy(v)),error=>queue.fail(error));}catch(e){queue.fail(e);throw e;}
    queue.setCleanup(this.#release(queue,unsubscribe));return queue;
  }
  async binding(identity:Identity,t:GatewayTarget):Promise<GatewayBinding|null> {
    return this.#readRoute(identity,t,route=>this.#binding(route));
  }
  async #binding(route:SessionRoute):Promise<GatewayBinding|null> {
    if(!route.binding)return null;const [binding,session]=await Promise.all([route.binding(),route.session.snapshot(targetScope(route.target))]);const b=copy(binding);if(!b)return null;
    const t=route.target,r=b.run,h=historyScope(b.history);
    if(scopeKey(r.scope)!==scopeKey(targetScope(t))||!Number.isSafeInteger(r.generation)||r.generation<1||typeof r.nativeSession!=="string"||!r.nativeSession||h.origin.connection!==t.connection||h.origin.principal!==t.principal||h.origin.host!==t.host||h.origin.nativeSession!==r.nativeSession||h.kind!==session.kind||session.generation!==r.generation||session.nativeSession!==r.nativeSession||(h.kind==="codex"&&h.threadId!==r.nativeSession)||(h.kind==="copilot"&&(h.agentId!==null||"legacyParentToolCallId" in h))||!route.authorizeHistory(h))throw new GatewayError("FENCED");
    if(this.#routeForCurrent(route)!==route)throw new GatewayError("FENCED");return b;
  }
  #routeForCurrent(route:SessionRoute):SessionRoute|undefined{const entry=this.#routes.get(this.#current.get(ownerKey(route.target))??"");return entry?.reachable&&!entry.revoked?.aborted&&(entry.expiresAt===undefined||entry.expiresAt>Date.now())?entry.route:undefined;}
  async #mcpRoute(identity:Identity,t:GatewayTarget,run:RunRef,action:GatewayAction="read"):Promise<SessionRoute> {
    const {route}=this.#route(identity,t,false,action);if(!route.mcp)throw new GatewayError("UNAVAILABLE");
    const b=await this.#binding(route);if(!b||canonical(b.run)!==canonical(run))throw new GatewayError("FENCED");return route;
  }
  async mcpSnapshot(identity:Identity,t:GatewayTarget,run:RunRef):Promise<McpSnapshot>{const caller=copy(identity),requested=target(t),frozen=copy(run);return this.#readRoute(caller,requested,async()=>{const route=await this.#mcpRoute(caller,requested,frozen);return route.mcp!.snapshot(frozen);});}
  async mcpRefresh(identity:Identity,t:GatewayTarget,run:RunRef,observation:Observation={}):Promise<McpSnapshot>{
    const caller=copy(identity),requested=target(t),frozen=copy(run);
    // Cancellation releases this observer only. McpReadPool retains actual pending native jobs.
    return this.#readRoute(caller,requested,async()=>{const route=await this.#mcpRoute(caller,requested,frozen,"mcpRefresh");return route.mcp!.refresh(frozen,observation);},false,"mcpRefresh");
  }
  async watchMcp(identity:Identity,t:GatewayTarget,run:RunRef):Promise<ViewerQueue<McpSnapshot>>{
    const caller=copy(identity),requested=target(t),frozen=copy(run);
    return this.#readRoute(caller,requested,async()=>{const route=await this.#mcpRoute(caller,requested,frozen),queue=this.#queue<McpSnapshot>(targetKey(route.target));
    let unsubscribe:()=>void;try{unsubscribe=route.mcp!.subscribe(frozen,v=>queue.push(copy(v)),error=>queue.fail(error));}catch(e){queue.fail(e);throw e;}
    queue.setCleanup(this.#release(queue,unsubscribe));return queue;});
  }
  async fileSurface(identity:Identity,t:GatewayTarget,write=false):Promise<Readonly<{scope:FileScope;port:FilePort}>> {
    return this.#readRoute(identity,t,async route=>{if(!route.files)throw new GatewayError("UNAVAILABLE");
    const b=await this.#binding(route),scope=copy(route.files.scope());
    if(!b||!scope||scope.connection!==route.target.connection||scope.principal!==route.target.principal||scope.host!==route.target.host||scope.session!==b.run.nativeSession)throw new GatewayError("FENCED");
    return {scope,port:route.files.port};},false,write?"fileWrite":"read");
  }
  async #mutation<T>(work:()=>Promise<T>):Promise<T>{this.#open();if(this.#active>=this.#limits.forward)throw new GatewayError("FULL");this.#active++;try{return await work();}finally{this.#active--;}}
  #catalog(identity:Identity,scope:CatalogScope,action:GatewayAction="read"):CatalogRoute {
    this.#open();if(identity.connection!==scope.connection||identity.principal!==scope.principal||!Array.isArray(identity.authorities)||!identity.authorities.includes(scope.authority)||!Array.isArray(identity.actions)||!identity.actions.includes(action))throw new GatewayError("FORBIDDEN");
    const route=this.#catalogs.get(catalogKey(scope));if(!route)throw new GatewayError("UNAVAILABLE");if(route.actions&&!route.actions.includes(action))throw new GatewayError("FORBIDDEN");return route;
  }
  #readCatalog<T>(identity:Identity,input:CatalogScope,work:(route:CatalogRoute,scope:CatalogScope)=>Promise<T>):Promise<T> {
    const caller=copy(identity),scope=copy(input),route=this.#catalog(caller,scope);
    return this.#read(()=>work(route,scope),()=>{if(this.#catalog(caller,scope)!==route)throw new GatewayError("FENCED");});
  }
  catalogList(identity:Identity,scope:CatalogScope):Promise<readonly CatalogEntry[]> {return this.#readCatalog(identity,scope,(r,s)=>r.port.list(s));}
  catalogGet(identity:Identity,scope:CatalogScope,session:string):Promise<CatalogEntry|null> {id(session);return this.#readCatalog(identity,scope,(r,s)=>r.port.get(s,session));}
  catalogCreation(identity:Identity,scope:CatalogScope,operationId:string):Promise<Creation|null> {id(operationId);return this.#readCatalog(identity,scope,(r,s)=>r.port.creation(s,operationId));}
  catalogCreate(identity:Identity,request:CreateRequest):Promise<Creation> {const r=this.#catalog(identity,request.scope,"catalogWrite"),original=copy(request);return this.#mutation(()=>r.port.create(original));}
  catalogRename(identity:Identity,request:RenameRequest):Promise<CatalogEntry> {const r=this.#catalog(identity,request.scope,"catalogWrite"),original=copy(request);return this.#mutation(()=>r.port.rename(original));}
  catalogSetWatched(identity:Identity,request:WatchRequest):Promise<CatalogEntry> {const r=this.#catalog(identity,request.scope,"catalogWrite"),original=copy(request);return this.#mutation(()=>r.port.setWatched(original));}
  catalogMetadataOriginal(identity:Identity,scope:CatalogScope,operationId:string):Promise<MetadataOriginal|null> {id(operationId);return this.#readCatalog(identity,scope,(r,s)=>r.port.metadataOriginal(s,operationId));}
  catalogPublishArchive(identity:Identity,request:ArchivePublication):Promise<CatalogEntry> {const r=this.#catalog(identity,request.scope,"catalogWrite"),original=copy(request);if(!r.port.publishArchive)throw new GatewayError("UNAVAILABLE");return this.#mutation(()=>r.port.publishArchive!(original));}
  watchCatalog(identity:Identity,scope:CatalogScope):ViewerQueue<CatalogEntry> {
    const r=this.#catalog(identity,scope),queue=this.#queue<CatalogEntry>(`catalog:${catalogKey(scope)}`);let unsubscribe:()=>void;try{unsubscribe=r.port.subscribe(copy(scope),v=>queue.push(copy(v)));}catch(e){queue.fail(e);throw e;}
    queue.setCleanup(this.#release(queue,unsubscribe));return queue;
  }
  get observation():ForwardObservation {return Object.freeze({active:this.#active,urgent:this.#urgent,optionalReads:this.#reads,subscribers:this.#watches.size});}
  /** Observation shutdown only. Already forwarded mutations retain their owner and task lifetime. */
  close():void {if(this.#closed)return;this.#closed=true;for(const pending of this.#readInbox.splice(0))pending.reject(new GatewayError("CLOSED"));for(const watch of [...this.#watches])watch.queue.fail(new GatewayError("CLOSED"));for(const entry of this.#routes.values())entry.detach?.();for(const timer of this.#expiryTimers.values())clearTimeout(timer);this.#expiryTimers.clear();this.#remoteSeen.clear();this.#routes.clear();this.#current.clear();this.#catalogs.clear();this.#hostRoutes.clear();this.#hostCurrent.clear();}
}
