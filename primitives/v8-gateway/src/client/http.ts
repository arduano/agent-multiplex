import type { Catalog, SessionSnapshot, Submit, Receipt, SessionScope, RunRef, NativeRead, NativeReadResult, McpLoginLink } from "../../../v8-session/src/contracts/types.js";
import { validateLoginLink } from '../../../v8-session/src/contracts/mcp-login.js';
import { validateCatalog } from "../../../v8-session/src/native/validation.js";
import type { Scope, Frame, HistoryPage } from "../../../v8-history/src/contracts/types.js";
import type { HistoryObservation, HistoryRecovery } from "../../../v8-history/src/acquisition/types.js";
import type { ArchivePublication, CatalogScope, CatalogEntry, CreateRequest, Creation, RenameRequest, WatchRequest, MetadataOriginal } from "../../../v8-catalog/src/contracts/types.js";
import type { InteractionSnapshot } from "../../../v8-interactions/src/contracts.js";
import type { McpSnapshot, Observation } from "../../../v8-mcp/src/contracts.js";
import type { FilePort, FileInputs, FileOutputs, FileMethod } from "../../../v8-files/src/contracts/types.js";
import { FileError, scopeKey as fileScopeKey } from "../../../v8-files/src/contracts/types.js";
import { createHttpFilePort } from "../../../v8-files/src/client/http-port.js";
import type { GatewayBinding, FileLocation } from "../contracts/types.js";
import { ownerKey, targetKey } from "../contracts/types.js";
import { copy } from "../../../v8-session/src/contracts/validation.js";
import { ViewerQueue } from "../contracts/queue.js";
import { GatewayError, type GatewayTransport, type GatewayTarget, type StreamRequest, type ObserverFrame, type WireStream } from "../contracts/types.js";
import type { HostRpcCall, HostRpcRequest, RpcResult } from '../contracts/rpc.js';

type Mux={controller:AbortController;channel:string|null;ready:Promise<void>;resolve():void;reject(error:unknown):void;queues:Map<string,ViewerQueue<unknown>>;ended:boolean};
/** Authenticated POSTs keep credentials out of URLs. No automatic fetch retry or mutation resend. */
export class HttpGatewayTransport implements GatewayTransport {
  readonly #url:string;#credential:string;readonly #fetch:typeof fetch;readonly #requestTimeoutMs:number;#closed=false;readonly #streams=new Set<AbortController>();readonly #lifetime=new AbortController();readonly #disposers=new Set<()=>void>();readonly #filePorts=new Map<string,{port:FilePort;route:()=>GatewayTarget}>();readonly #onUnauthenticated:(()=>void)|undefined;#denied=false;
  #disconnectListener:((error:unknown)=>void)|undefined;#mux:Mux|null=null;#connected=true;#logicalId=0;
  constructor(options:Readonly<{url:string;authorization:string;fetch?:typeof fetch;onUnauthenticated?:()=>void;requestTimeoutMs?:number}>) {
    const url=new URL(options.url);if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new GatewayError("INVALID");
    this.#requestTimeoutMs=options.requestTimeoutMs??15000;
    if(!Number.isSafeInteger(this.#requestTimeoutMs)||this.#requestTimeoutMs<1||this.#requestTimeoutMs>30000)throw new GatewayError("INVALID");
    this.#url=url.href;this.#credential=options.authorization;this.#onUnauthenticated=options.onUnauthenticated;this.#fetch=(options.fetch??globalThis.fetch).bind(globalThis);
  }
  #unauthenticated():void{if(this.#denied)return;this.#denied=true;try{this.#disconnectListener?.(new GatewayError("UNAUTHENTICATED"));}catch{/* Observer isolation. */}this.close();try{this.#onUnauthenticated?.();}catch{/* Consumer cannot interrupt revocation. */}}
  async #json<T>(response:Response,signal?:AbortSignal):Promise<T>{
    if(!response.body)throw new GatewayError("UNAVAILABLE");const reader=response.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
    const abort=()=>{void reader.cancel().catch(()=>undefined);};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>2097152)throw new GatewayError("OVERFLOW");chunks.push(part.value);}const all=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.byteLength;}return JSON.parse(new TextDecoder().decode(all)) as T;}
    finally{signal?.removeEventListener('abort',abort);await reader.cancel().catch(()=>undefined);}
  }
  async #response(body:unknown,signal?:AbortSignal):Promise<Response>{
    if(this.#closed)throw new GatewayError("CLOSED");
    let response:Response;try{response=await this.#fetch(this.#url,{method:"POST",headers:{"content-type":"application/json",...(this.#credential?{authorization:this.#credential}:{})},body:JSON.stringify(body),cache:"no-store",redirect:"error",signal:signal?AbortSignal.any([signal,this.#lifetime.signal]):this.#lifetime.signal});}catch(error){if(this.#closed)throw new GatewayError("CLOSED");throw error;}
    if(this.#closed||signal?.aborted){void response.body?.cancel().catch(()=>undefined);throw this.#closed?new GatewayError('CLOSED'):signal!.reason;}
    if(response.status===401){this.#unauthenticated();void response.body?.cancel().catch(()=>undefined);throw new GatewayError("UNAUTHENTICATED");}
    if(!response.ok){const error=await this.#json<{error?:GatewayError["code"]}>(response,signal);if(error.error==="UNAUTHENTICATED")this.#unauthenticated();throw new GatewayError(error.error??"UNAVAILABLE");}return response;
  }
  async #read<T>(body:unknown,signal?:AbortSignal):Promise<T>{
    if(this.#closed)throw new GatewayError('CLOSED');
    const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new GatewayError('TIMEOUT')),this.#requestTimeoutMs);
    const combined=AbortSignal.any([deadline.signal,this.#lifetime.signal,...(signal?[signal]:[])]);
    let abort:()=>void=()=>{};
    try{
      const expired=new Promise<never>((_resolve,reject)=>{abort=()=>reject(this.#denied?new GatewayError('UNAUTHENTICATED'):this.#closed?new GatewayError('CLOSED'):combined.reason);combined.addEventListener('abort',abort,{once:true});if(combined.aborted)abort();});
      // Expiry ends this observation, never the Gateway/Host's admitted effect.
      // The response path cancels even a late custom-fetch body after expiry.
      const work=(async()=>{combined.throwIfAborted();const response=await this.#response(body,combined);const result=await this.#json<{value:T}>(response,combined);combined.throwIfAborted();return result.value;})();
      return await Promise.race([work,expired]);
    }catch(error){if(error instanceof GatewayError&&error.code==='UNAUTHENTICATED')throw error;if(this.#closed)throw new GatewayError('CLOSED');throw error;}
    finally{clearTimeout(timer);combined.removeEventListener('abort',abort);}
  }
  async *#wire<T>(body:unknown,signal:AbortSignal):AsyncIterable<T>{
    const own=new AbortController();this.#streams.add(own);const abort=()=>own.abort();signal.addEventListener("abort",abort,{once:true});if(signal.aborted)own.abort();
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    const cancel=()=>{void reader?.cancel().catch(()=>undefined);};own.signal.addEventListener('abort',cancel,{once:true});
    try{const response=await this.#response(body,own.signal);if(!response.body)throw new GatewayError("UNAVAILABLE");reader=response.body.getReader();let buffer="";const decoder=new TextDecoder();
      for(;;){const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true});
        if(buffer.length>2097152)throw new GatewayError("OVERFLOW");
        let end:number;while((end=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;const value=JSON.parse(line) as WireStream<T>;
          if(value.type==="error"){if(value.code==="UNAUTHENTICATED")this.#unauthenticated();throw new GatewayError(value.code);}if(value.type!=="value")throw new GatewayError("INVALID");if(this.#closed||own.signal.aborted)throw new GatewayError("CLOSED");yield value.value;}
      }
      if(buffer.trim())throw new GatewayError("INVALID");
    }finally{signal.removeEventListener("abort",abort);own.abort();own.signal.removeEventListener('abort',cancel);await reader?.cancel().catch(()=>undefined);this.#streams.delete(own);}
  }
  #endMux(mux:Mux,error:unknown):void{
    if(mux.ended)return;mux.ended=true;if(this.#mux===mux)this.#mux=null;mux.controller.abort();mux.reject(error);
    for(const queue of mux.queues.values())queue.fail(error);mux.queues.clear();try{this.#disconnectListener?.(error);}catch{/* Observer isolation. */}
  }
  #observer():Mux{
    if(this.#closed)throw new GatewayError("CLOSED");if(!this.#connected)throw new GatewayError("UNAVAILABLE");if(this.#mux)return this.#mux;
    let resolve!:()=>void,reject!:(error:unknown)=>void;const ready=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});void ready.catch(()=>undefined);
    const mux:Mux={controller:new AbortController(),channel:null,ready,resolve,reject,queues:new Map(),ended:false};this.#mux=mux;
    const opening=setTimeout(()=>this.#endMux(mux,new GatewayError('TIMEOUT')),this.#requestTimeoutMs);
    void(async()=>{try{
      for await(const frame of this.#wire<ObserverFrame>({op:"watch.open"},mux.controller.signal)){
        if(mux.ended||this.#closed)return;
        if(frame.type==="ready"){if(mux.channel||typeof frame.channel!=="string"||frame.channel.length>128)throw new GatewayError("INVALID");mux.channel=frame.channel;clearTimeout(opening);mux.resolve();}
        else if(frame.type==="event"){if(!mux.channel)throw new GatewayError("INVALID");mux.queues.get(frame.id)?.push(copy(frame.value));}
        else if(frame.type==="end"){mux.queues.get(frame.id)?.finish();}
        else if(frame.type==="error"){if(frame.code==="UNAUTHENTICATED")this.#unauthenticated();mux.queues.get(frame.id)?.fail(new GatewayError(frame.code));}
        else throw new GatewayError("INVALID");
      }
      this.#endMux(mux,new GatewayError("UNAVAILABLE"));
    }catch(error){this.#endMux(mux,error);}finally{clearTimeout(opening);}})();return mux;
  }
  async *#watch<T>(body:unknown,signal:AbortSignal,onStarted?:()=>void):AsyncIterable<T>{
    if(signal.aborted)return;const mux=this.#observer();if(mux.queues.size>=128)throw new GatewayError("FULL");
    const id=`w${++this.#logicalId}`,queue=new ViewerQueue<T>(16,1048576);mux.queues.set(id,queue as ViewerQueue<unknown>);
    const abort=()=>{void queue.return();};signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();let registration:Promise<unknown>|undefined;
    try{
      const ready=await Promise.race([mux.ready.then(()=>true),queue.closed.then(()=>false)]);if(!ready||signal.aborted){if(!signal.aborted)yield*queue;return;}
      // Queue exists before subscribe POST: a synchronous Host snapshot may beat its HTTP ACK.
      registration=this.#read({op:"watch.subscribe",channel:mux.channel,id,request:copy(body)},mux.controller.signal);
      void registration.catch(error=>{if(!(error instanceof GatewayError&&["INVALID","FORBIDDEN","FENCED","UNAVAILABLE","FULL"].includes(error.code)))this.#endMux(mux,error);});
      const admitted=await Promise.race([registration.then(()=>true),queue.closed.then(()=>false)]);if(!admitted||signal.aborted){if(!signal.aborted)yield*queue;return;}
      onStarted?.();
      yield*queue;
    }finally{
      signal.removeEventListener("abort",abort);if(mux.queues.get(id)===queue as unknown)mux.queues.delete(id);await queue.return();
      // Never reorder unsubscribe before the original subscribe has actually settled.
      if(registration)void registration.then(async()=>{if(mux.ended||this.#closed)return;try{await this.#read({op:"watch.unsubscribe",channel:mux.channel,id},mux.controller.signal);}catch(error){this.#endMux(mux,error);}}).catch(()=>undefined);
    }
  }
  onDisconnect(listener:(error:unknown)=>void):()=>void{if(this.#disconnectListener)throw new GatewayError("CONFLICT");this.#disconnectListener=listener;return()=>{if(this.#disconnectListener===listener)this.#disconnectListener=undefined;};}
  disconnect():void{if(this.#closed)return;this.#connected=false;if(this.#mux)this.#endMux(this.#mux,new GatewayError("UNAVAILABLE"));}
  reconnect():void{if(this.#closed)throw new GatewayError("CLOSED");this.#connected=true;}
  binding(target:GatewayTarget):Promise<GatewayBinding|null>{return this.#read({op:"binding",target});}
  rpcCall(request:HostRpcCall):Promise<RpcResult>{return this.#read({op:'rpc.call',request});}
  rpcWatch(request:HostRpcRequest,signal:AbortSignal,onStarted?:()=>void):AsyncIterable<RpcResult>{return this.#watch({op:'rpc.watch',request},signal,onStarted);}
  snapshot(target:GatewayTarget):Promise<SessionSnapshot>{return this.#read({op:"snapshot",target});}
  read(target:GatewayTarget,run:RunRef,request:NativeRead):Promise<NativeReadResult>{return this.#read({op:"native.read",target,run,request});}
  mcpLoginLink(target:GatewayTarget,run:RunRef,originalId:string):Promise<McpLoginLink>{return this.#read({op:'mcp.loginLink',target,run,originalId}).then(validateLoginLink);}
  controlCatalog(target:GatewayTarget):Promise<Catalog>{return this.#read({op:"controls.catalog",target}).then(validateCatalog);}
  submit(target:GatewayTarget,request:Submit):Promise<Receipt>{return this.#read({op:"submit",target,request});}
  receipt(target:GatewayTarget,id:string):Promise<Receipt|null>{return this.#read({op:"receipt",target,id});}
  watchSession(target:GatewayTarget,signal:AbortSignal,onStarted?:()=>void):AsyncIterable<SessionSnapshot>{return this.#watch({op:"session.watch",target},signal,onStarted);}
  watchHistory(request:StreamRequest,signal:AbortSignal,onStarted?:()=>void):AsyncIterable<Frame>{return this.#watch({op:"history.watch",...request},signal,onStarted);}
  historyScopes(target:GatewayTarget):Promise<readonly Scope[]>{return this.#read({op:"history.scopes",target});}
  older(target:GatewayTarget,scope:Scope,cursor:string,generation?:string,retryToken?:string):Promise<HistoryPage>{return this.#read({op:"history.older",target,scope,cursor,...(generation!==undefined?{generation}:{}),...(retryToken!==undefined?{retryToken}:{})});}
  recover(target:GatewayTarget,scope:Scope,observation:HistoryObservation={},retryToken?:string):Promise<HistoryRecovery>{return this.#read({op:"history.recover",target,scope,...(observation.timeoutMs!==undefined?{timeoutMs:observation.timeoutMs}:{}),...(retryToken!==undefined?{retryToken}:{})},observation.signal);}
  list(scope:CatalogScope):Promise<readonly CatalogEntry[]>{return this.#read({op:"catalog.list",scope});}
  get(scope:CatalogScope,session:string):Promise<CatalogEntry|null>{return this.#read({op:"catalog.get",scope,session});}
  create(request:CreateRequest):Promise<Creation>{return this.#read({op:"catalog.create",request});}
  creation(scope:CatalogScope,id:string):Promise<Creation|null>{return this.#read({op:"catalog.creation",scope,id});}
  rename(request:RenameRequest):Promise<CatalogEntry>{return this.#read({op:"catalog.rename",request});}
  setWatched(request:WatchRequest):Promise<CatalogEntry>{return this.#read({op:"catalog.watch.set",request});}
  metadataOriginal(scope:CatalogScope,id:string):Promise<MetadataOriginal|null>{return this.#read({op:"catalog.metadata.original",scope,id});}
  publishArchive(request:ArchivePublication):Promise<CatalogEntry>{return this.#read({op:"catalog.archive.publish",request});}
  watchCatalog(scope:CatalogScope,signal:AbortSignal,onStarted?:()=>void):AsyncIterable<CatalogEntry>{return this.#watch({op:"catalog.watch",scope},signal,onStarted);}
  watchInteractions(target:GatewayTarget,signal:AbortSignal,onStarted?:()=>void):AsyncIterable<InteractionSnapshot>{return this.#watch({op:"interactions.watch",target},signal,onStarted);}
  watchMcp(target:GatewayTarget,run:RunRef,signal:AbortSignal,onStarted?:()=>void):AsyncIterable<McpSnapshot>{return this.#watch({op:"mcp.watch",target,run},signal,onStarted);}
  interactionSnapshot(target:GatewayTarget):Promise<InteractionSnapshot>{return this.#read({op:"interactions.snapshot",target});}
  mcpSnapshot(target:GatewayTarget,run:RunRef):Promise<McpSnapshot>{return this.#read({op:"mcp.snapshot",target,run});}
  mcpRefresh(target:GatewayTarget,run:RunRef,observation:Observation={}):Promise<McpSnapshot>{return this.#read({op:"mcp.refresh",target,run,...(observation.timeoutMs!==undefined?{timeoutMs:observation.timeoutMs}:{})},observation.signal);}
  /** A getter follows only the caller's already-proved same-owner route. Each
   * local byte lease retains the exact HTTP port that acquired its bytes. */
  filePort(input:GatewayTarget|(()=>GatewayTarget)):FilePort {
    if(this.#closed)throw new GatewayError("CLOSED");let route:()=>GatewayTarget;
    if(typeof input==="function")route=input;else{const fixed=copy(input);route=()=>fixed;}
    const key=ownerKey(route()),old=this.#filePorts.get(key);
    if(old){old.route=route;return old.port;}if(this.#filePorts.size>=64)throw new GatewayError("FULL");
    type Binding={key:string;location:FileLocation;port:FilePort};let binding:{key:string;pending:Promise<Binding>}|undefined,acquiring=0;
    const leases=new Map<string,{input:FileInputs["release"];binding:Binding}>();
    const current=()=>{const value=copy(entry.route());if(ownerKey(value)!==key)throw new GatewayError("FENCED");return value;};
    const dispose=()=>{for(const lease of leases.values())void lease.binding.port.call("release",lease.input).catch(()=>undefined);leases.clear();};this.#disposers.add(dispose);
    const resolve=()=>{
      const t=current(),epoch=targetKey(t);if(binding?.key===epoch)return binding.pending;
      const pending=(async():Promise<Binding>=>{
      const location=await this.#read<FileLocation>({op:"files.route",target:t});
      if(location.scope.connection!==t.connection||location.scope.principal!==t.principal||location.scope.host!==t.host||!/^\/v8-files\/[a-f0-9]{64}\/$/.test(location.path))throw new GatewayError("FENCED");
      const base=new URL(location.path,this.#url),authenticated:typeof fetch=async(input,init)=>{
        if(this.#closed)throw new GatewayError("CLOSED");const url=new URL(input instanceof Request?input.url:String(input));
        if(url.origin!==base.origin||!url.pathname.startsWith(base.pathname)||url.search||url.hash)throw new GatewayError("FENCED");
        const headers=new Headers(init?.headers);if(this.#credential)headers.set("authorization",this.#credential);
        const response=await this.#fetch(input,{...init,headers,redirect:"error",cache:"no-store",signal:init?.signal?AbortSignal.any([init.signal,this.#lifetime.signal]):this.#lifetime.signal});if(response.status===401){this.#unauthenticated();void response.body?.cancel().catch(()=>undefined);throw new GatewayError("UNAUTHENTICATED");}return response;
      };
      return {key:epoch,location,port:createHttpFilePort(base.href,authenticated)};
      })();binding={key:epoch,pending};void pending.catch(()=>{if(binding?.pending===pending)binding=undefined;});return pending;
    };
    const facade:FilePort=Object.freeze({call:async<M extends FileMethod>(method:M,input:FileInputs[M]):Promise<FileOutputs[M]>=>{
      if(this.#closed){if(method==="release")return undefined as FileOutputs[M];throw new GatewayError("CLOSED");}const frozen=structuredClone(input);
      if(method!=="release")current();
      if(method==="acquire"&&leases.size+acquiring>=4)throw new FileError("BUSY");if(method==="acquire")acquiring++;
      try{
      const lease=(method==="read"||method==="release")?leases.get((frozen as FileInputs["release"]).leaseId):undefined;
      if(method==="release"&&!lease)return undefined as FileOutputs[M];if(method==="read"&&!lease)throw new FileError("FENCED");
      const resolved=lease?.binding??await resolve();
      if(fileScopeKey(frozen.scope)!==fileScopeKey(resolved.location.scope))throw new GatewayError("FENCED");
      if(!lease&&targetKey(current())!==resolved.key)throw new GatewayError("FENCED");
      const value=await resolved.port.call(method,frozen);
      if(method==="acquire"){
        const acquired=value as FileOutputs["acquire"],input={scope:resolved.location.scope,leaseId:acquired.leaseId};
        if(this.#closed){await resolved.port.call("release",input);throw new GatewayError("CLOSED");}leases.set(acquired.leaseId,{input,binding:resolved});
      }
      if(method==="release")leases.delete((frozen as FileInputs["release"]).leaseId);
      if(this.#closed)throw new GatewayError("CLOSED");return value;
      }finally{if(method==="acquire")acquiring--;}
    }});const entry={port:facade,route};this.#filePorts.set(key,entry);return facade;
  }
  /** New credentials require a new transport/client namespace. Never mutate authentication in place. */
  close():void{if(this.#closed)return;this.disconnect();this.#closed=true;this.#credential="";this.#lifetime.abort();for(const stream of this.#streams)stream.abort();this.#streams.clear();for(const dispose of this.#disposers)dispose();this.#disposers.clear();this.#filePorts.clear();}
}
