import { initTRPC, TRPCError } from "@trpc/server";
import type { Peer, PeerContext } from "@arduano/p2prpc-core";
import type { Catalog, SessionSnapshot, Submit, Receipt, RunRef, SessionScope, NativeRead, NativeReadResult, McpLoginLink } from "../../../v8-session/src/contracts/types.js";
import { validateCatalog } from "../../../v8-session/src/native/validation.js";
import { validateLoginLink } from "../../../v8-session/src/contracts/mcp-login.js";
import { scopeKey } from "../../../v8-session/src/contracts/types.js";
import type { Scope, Frame, HistoryPage } from "../../../v8-history/src/contracts/types.js";
import type { HistoryObservation, HistoryRecovery } from "../../../v8-history/src/acquisition/types.js";
import type { ArchivePublication, CatalogScope, CatalogEntry, CreateRequest, RenameRequest, WatchRequest, MetadataOriginal, Creation } from "../../../v8-catalog/src/contracts/types.js";
import type { InteractionSnapshot } from "../../../v8-interactions/src/contracts.js";
import type { McpSnapshot, Observation } from "../../../v8-mcp/src/contracts.js";
import { canonical, copy } from "../../../v8-session/src/contracts/validation.js";
import { GatewayCoordinator } from "../gateway/coordinator.js";
import { ViewerQueue } from "../gateway/queue.js";
import { GatewayError, targetScope, type GatewayTarget, type GatewayTransport, type Identity, type GatewayBinding, type StreamRequest } from "../contracts/types.js";

async function* feed<T>(queue:ViewerQueue<T>,signal:AbortSignal|undefined):AsyncIterable<T>{const abort=()=>{void queue.return();};signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();try{yield*queue;}finally{signal?.removeEventListener("abort",abort);await queue.return();}}
type TargetInput={target:GatewayTarget};
type RunInput=TargetInput&{run:RunRef;timeoutMs?:number};
function input<T>(value:unknown):T {if(new TextEncoder().encode(canonical(value)).byteLength>65536)throw new TRPCError({code:"BAD_REQUEST"});return value as T;}
/** Only verified p2prpc peer/session identity is passed to the deployment policy.
 * Request headers are caller assertions and deliberately absent from this mapper.
 * Binary artifacts retain the authenticated HTTP FilePort, never JSON/base64 RPC.
 */
export function createP2pGatewayRouter(gateway:GatewayCoordinator,mapIdentity:(peer:Readonly<{peer:PeerContext["p2p"]["peer"];auth:PeerContext["p2p"]["auth"]}>)=>Identity|null) {
 const t=initTRPC.context<PeerContext>().create(),p=t.procedure.use(({ctx,next})=>{
  const identity=mapIdentity({peer:ctx.p2p.peer,auth:ctx.p2p.auth});if(!identity)throw new TRPCError({code:"UNAUTHORIZED"});return next({ctx:{identity:copy(identity)}});
 });
 return t.router({
  snapshot:p.input(input<TargetInput>).query(({ctx,input})=>gateway.snapshot(ctx.identity,input.target)),
  mcpLoginLink:p.input(input<RunInput&{originalId:string}>).query(({ctx,input})=>gateway.mcpLoginLink(ctx.identity,input.target,input.run,input.originalId)),
  nativeRead:p.input(input<RunInput&{request:NativeRead}>).query(({ctx,input})=>gateway.nativeRead(ctx.identity,input.target,input.run,input.request)),
  controlCatalog:p.input(input<TargetInput>).query(({ctx,input})=>gateway.controlCatalog(ctx.identity,input.target)),
  binding:p.input(input<TargetInput>).query(({ctx,input})=>gateway.binding(ctx.identity,input.target)),
  submit:p.input(input<TargetInput&{request:Submit}>).mutation(({ctx,input})=>gateway.submit(ctx.identity,input.target,input.request)),
  receipt:p.input(input<TargetInput&{id:string}>).query(({ctx,input})=>gateway.receipt(ctx.identity,input.target,input.id)),
  sessionWatch:p.input(input<TargetInput>).subscription(async function*({ctx,input,signal}){const queue=gateway.watchSession(ctx.identity,input.target);yield*feed(queue,signal);}),
  historyWatch:p.input(input<StreamRequest>).subscription(async function*({ctx,input,signal}){const queue=gateway.watchHistory(ctx.identity,input);yield*feed(queue,signal);}),
  historyScopes:p.input(input<TargetInput>).query(({ctx,input})=>gateway.historyScopes(ctx.identity,input.target)),
  older:p.input(input<TargetInput&{scope:Scope;cursor:string;generation?:string;retryToken?:string}>).mutation(({ctx,input})=>gateway.older(ctx.identity,input.target,input.scope,input.cursor,input.generation,input.retryToken)),
  recover:p.input(input<TargetInput&{scope:Scope;timeoutMs?:number;retryToken?:string}>).mutation(({ctx,input,signal})=>gateway.recover(ctx.identity,input.target,input.scope,{...(signal?{signal}:{}),...(input.timeoutMs!==undefined?{timeoutMs:input.timeoutMs}:{})},input.retryToken)),
  interactionsSnapshot:p.input(input<TargetInput>).query(({ctx,input})=>gateway.interactionSnapshot(ctx.identity,input.target)),
  interactionsWatch:p.input(input<TargetInput>).subscription(async function*({ctx,input,signal}){const queue=gateway.watchInteractions(ctx.identity,input.target);yield*feed(queue,signal);}),
  mcpSnapshot:p.input(input<RunInput>).query(({ctx,input})=>gateway.mcpSnapshot(ctx.identity,input.target,input.run)),
  mcpRefresh:p.input(input<RunInput>).mutation(({ctx,input,signal})=>gateway.mcpRefresh(ctx.identity,input.target,input.run,{...(signal?{signal}:{}),...(input.timeoutMs!==undefined?{timeoutMs:input.timeoutMs}:{})})),
  mcpWatch:p.input(input<RunInput>).subscription(async function*({ctx,input,signal}){const queue=await gateway.watchMcp(ctx.identity,input.target,input.run);yield*feed(queue,signal);}),
  catalogList:p.input(input<{scope:CatalogScope}>).query(({ctx,input})=>gateway.catalogList(ctx.identity,input.scope)),
  catalogGet:p.input(input<{scope:CatalogScope;session:string}>).query(({ctx,input})=>gateway.catalogGet(ctx.identity,input.scope,input.session)),
  catalogCreation:p.input(input<{scope:CatalogScope;id:string}>).query(({ctx,input})=>gateway.catalogCreation(ctx.identity,input.scope,input.id)),
  catalogCreate:p.input(input<{request:CreateRequest}>).mutation(({ctx,input})=>gateway.catalogCreate(ctx.identity,input.request)),
  catalogRename:p.input(input<{request:RenameRequest}>).mutation(({ctx,input})=>gateway.catalogRename(ctx.identity,input.request)),
  catalogSetWatched:p.input(input<{request:WatchRequest}>).mutation(({ctx,input})=>gateway.catalogSetWatched(ctx.identity,input.request)),
  catalogMetadataOriginal:p.input(input<{scope:CatalogScope;id:string}>).query(({ctx,input})=>gateway.catalogMetadataOriginal(ctx.identity,input.scope,input.id)),
  catalogPublishArchive:p.input(input<{request:ArchivePublication}>).mutation(({ctx,input})=>gateway.catalogPublishArchive(ctx.identity,input.request)),
  catalogWatch:p.input(input<{scope:CatalogScope}>).subscription(async function*({ctx,input,signal}){const queue=gateway.watchCatalog(ctx.identity,input.scope);yield*feed(queue,signal);}),
 });
}
export type GatewayP2pRouter=ReturnType<typeof createP2pGatewayRouter>;
import { observePeer, type PeerObserver } from './peer-observer.js';
type Subscription={unsubscribe():void};
/** Per-consumer adapter; closing it retires its observations, never the shared Peer/node. */
export class P2pGatewayTransport implements GatewayTransport {
 readonly #lifetime=new AbortController();#closed=false;
 constructor(readonly peer:Peer<GatewayP2pRouter>){}
 #open():void{if(this.#closed)throw new GatewayError("CLOSED");}
 async #read<T>(work:()=>Promise<T>):Promise<T>{this.#open();const value=await work();this.#open();return value;}
 async #observe<T>(work:()=>Promise<T>,signal:AbortSignal|undefined):Promise<T>{
  this.#open();
  if(signal?.aborted)throw new GatewayError("CANCELLED");
  // Observer cancellation must not abort a shared Peer's in-flight stream open.
  // Published stream admission remains bounded; Host timeoutMs still bounds its
  // read observer. Only the physical Peer owner retires a lost RPC response.
  return new Promise((resolve,reject)=>{
   let active=true;
   const finish=(settle:()=>void)=>{
    if(!active)return;
    active=false;
    signal?.removeEventListener("abort",abort);
    this.#lifetime.signal.removeEventListener("abort",close);
    settle();
   };
   const abort=()=>finish(()=>reject(new GatewayError("CANCELLED")));
   const close=()=>finish(()=>reject(new GatewayError("CLOSED")));
   signal?.addEventListener("abort",abort,{once:true});
   this.#lifetime.signal.addEventListener("abort",close,{once:true});
   try{
    void work().then(value=>finish(()=>resolve(value)),error=>finish(()=>reject(error)));
   }
   catch(error){finish(()=>reject(error));}
  });
 }
 async *#watch<T>(start:(callbacks:PeerObserver<T>)=>Subscription,signal:AbortSignal,onStarted?:()=>void):AsyncIterable<T>{
  this.#open();
  yield* observePeer(start,AbortSignal.any([signal,this.#lifetime.signal]),onStarted);
 }
 binding(target:GatewayTarget):Promise<GatewayBinding|null>{return this.#read(()=>this.peer.rpc.binding.query({target}));}
 snapshot(target:GatewayTarget):Promise<SessionSnapshot>{return this.#read(()=>this.peer.rpc.snapshot.query({target}));}
 mcpLoginLink(target:GatewayTarget,run:RunRef,originalId:string):Promise<McpLoginLink>{return this.#read(()=>this.peer.rpc.mcpLoginLink.query({target,run,originalId})).then(validateLoginLink);}
 read(target:GatewayTarget,run:RunRef,request:NativeRead):Promise<NativeReadResult>{return this.#read(()=>this.peer.rpc.nativeRead.query({target,run,request}));}
 controlCatalog(target:GatewayTarget):Promise<Catalog>{return this.#read(()=>this.peer.rpc.controlCatalog.query({target})).then(validateCatalog);}
 submit(target:GatewayTarget,request:Submit):Promise<Receipt>{return this.#read(()=>this.peer.rpc.submit.mutate({target,request}));}
 receipt(target:GatewayTarget,id:string):Promise<Receipt|null>{return this.#read(()=>this.peer.rpc.receipt.query({target,id}));}
 watchSession(target:GatewayTarget,signal:AbortSignal,onStarted?:()=>void):AsyncIterable<SessionSnapshot>{return this.#watch(cb=>this.peer.rpc.sessionWatch.subscribe({target},cb),signal,onStarted);}
 watchHistory(request:StreamRequest,signal:AbortSignal,onStarted?:()=>void):AsyncIterable<Frame>{return this.#watch(cb=>this.peer.rpc.historyWatch.subscribe(request,cb),signal,onStarted);}
 historyScopes(target:GatewayTarget):Promise<readonly Scope[]>{return this.#read(()=>this.peer.rpc.historyScopes.query({target}));}
 older(target:GatewayTarget,scope:Scope,cursor:string,generation?:string,retryToken?:string):Promise<HistoryPage>{return this.#read(()=>this.peer.rpc.older.mutate({target,scope,cursor,...(generation!==undefined?{generation}:{}),...(retryToken!==undefined?{retryToken}:{})}));}
 recover(target:GatewayTarget,scope:Scope,observation:HistoryObservation={},retryToken?:string):Promise<HistoryRecovery>{return this.#observe(()=>this.peer.rpc.recover.mutate({target,scope,...(observation.timeoutMs!==undefined?{timeoutMs:observation.timeoutMs}:{}),...(retryToken!==undefined?{retryToken}:{})}),observation.signal);}
 list(scope:CatalogScope):Promise<readonly CatalogEntry[]>{return this.#read(()=>this.peer.rpc.catalogList.query({scope}));}
 get(scope:CatalogScope,session:string):Promise<CatalogEntry|null>{return this.#read(()=>this.peer.rpc.catalogGet.query({scope,session}));}
 creation(scope:CatalogScope,id:string):Promise<Creation|null>{return this.#read(()=>this.peer.rpc.catalogCreation.query({scope,id}));}
 create(request:CreateRequest):Promise<Creation>{return this.#read(()=>this.peer.rpc.catalogCreate.mutate({request}));}
 rename(request:RenameRequest):Promise<CatalogEntry>{return this.#read(()=>this.peer.rpc.catalogRename.mutate({request}));}
 setWatched(request:WatchRequest):Promise<CatalogEntry>{return this.#read(()=>this.peer.rpc.catalogSetWatched.mutate({request}));}
 metadataOriginal(scope:CatalogScope,id:string):Promise<MetadataOriginal|null>{return this.#read(()=>this.peer.rpc.catalogMetadataOriginal.query({scope,id}));}
 publishArchive(request:ArchivePublication):Promise<CatalogEntry>{return this.#read(()=>this.peer.rpc.catalogPublishArchive.mutate({request}));}
 watchCatalog(scope:CatalogScope,signal:AbortSignal,onStarted?:()=>void):AsyncIterable<CatalogEntry>{return this.#watch(cb=>this.peer.rpc.catalogWatch.subscribe({scope},cb),signal,onStarted);}
 watchInteractions(target:GatewayTarget,signal:AbortSignal,onStarted?:()=>void):AsyncIterable<InteractionSnapshot>{return this.#watch(cb=>this.peer.rpc.interactionsWatch.subscribe({target},cb),signal,onStarted);}
 watchMcp(target:GatewayTarget,run:RunRef,signal:AbortSignal,onStarted?:()=>void):AsyncIterable<McpSnapshot>{return this.#watch(cb=>this.peer.rpc.mcpWatch.subscribe({target,run},cb),signal,onStarted);}
 interactionSnapshot(target:GatewayTarget):Promise<InteractionSnapshot>{return this.#read(()=>this.peer.rpc.interactionsSnapshot.query({target}));}
 mcpSnapshot(target:GatewayTarget,run:RunRef):Promise<McpSnapshot>{return this.#read(()=>this.peer.rpc.mcpSnapshot.query({target,run}));}
 mcpRefresh(target:GatewayTarget,run:RunRef,observation:Observation={}):Promise<McpSnapshot>{return this.#observe(()=>this.peer.rpc.mcpRefresh.mutate({target,run,...(observation.timeoutMs!==undefined?{timeoutMs:observation.timeoutMs}:{})}),observation.signal);}
 close():void{if(this.#closed)return;this.#closed=true;this.#lifetime.abort();}
}
