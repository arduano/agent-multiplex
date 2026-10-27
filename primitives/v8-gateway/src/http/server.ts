import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { createFileHttpHandler } from "../../../v8-files/src/transport/http.js";
import { canonical, copy } from "../../../v8-session/src/contracts/validation.js";
import type { FilePort } from "../../../v8-files/src/contracts/types.js";
import { targetKey, type GatewayTarget } from "../contracts/types.js";
import type { AddressInfo } from "node:net";
import { GatewayCoordinator } from "../gateway/coordinator.js";
import { GatewayError, type Identity, type ObserverRequest, type ObserverFrame, type WireStream } from "../contracts/types.js";
import { ViewerQueue } from "../gateway/queue.js";

export type CredentialVerifier=(authorization:string|undefined)=>Promise<Identity|null>;
/** Explicit trusted external file origins; omission retains loopback policy. */
export type GatewayHttpOptions=Readonly<{allowedFileOrigins?:readonly string[]}>;
export type Namespace=Readonly<{connection:string;principal:string}>;
export type LoopbackGateway=Readonly<{url:string;revoke(namespace:Namespace):void;close():Promise<void>}>;
const codes=new Set(["INVALID","UNAUTHENTICATED","FORBIDDEN","FENCED","UNAVAILABLE","FULL","OVERFLOW","CLOSED","ALREADY_ATTEMPTED","CANCELLED","TIMEOUT","CONFLICT"]);
function errorCode(e:unknown):GatewayError["code"] {const code=(e as {code?:string})?.code;return code&&codes.has(code)?code as GatewayError["code"]:"UNAVAILABLE";}
async function read(req:IncomingMessage):Promise<Record<string,any>> {
  if(req.headers["content-type"]!=="application/json")throw new GatewayError("INVALID");
  let length=0;const chunks:Buffer[]=[];for await(const chunk of req){const bytes=Buffer.from(chunk);length+=bytes.byteLength;if(length>65536)throw new GatewayError("INVALID");chunks.push(bytes);}
  const value:unknown=JSON.parse(Buffer.concat(chunks).toString("utf8"));if(!value||typeof value!=="object"||Array.isArray(value))throw new GatewayError("INVALID");return value as Record<string,any>;
}
function json(res:ServerResponse,status:number,value:unknown):void {if(res.destroyed||res.writableEnded)return;res.writeHead(status,{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff"});res.end(JSON.stringify(value));}
function writable(res:ServerResponse,queue:ViewerQueue<unknown>):Promise<void>{
  return new Promise(resolve=>{let remove:()=>void=()=>{};const finish=()=>{res.off("drain",finish);res.off("close",finish);remove();resolve();};res.once("drain",finish);res.once("close",finish);remove=queue.onClose(finish);});
}
async function stream<T>(res:ServerResponse,queue:ViewerQueue<T>):Promise<void> {
  const close=()=>{void queue.return();};res.once("close",close);
  res.setHeader("content-type","application/x-ndjson");res.writeHead(200,{"cache-control":"no-store","x-content-type-options":"nosniff"});res.flushHeaders();
  try {
    for await(const value of queue){
      if(res.destroyed||res.writableEnded)break;
      const frame:WireStream<T>={type:"value",value};
      if(!res.write(`${JSON.stringify(frame)}\n`)) {
        await writable(res,queue as ViewerQueue<unknown>);
      }
    }
  }catch(error){if(!res.destroyed&&!res.writableEnded)res.write(`${JSON.stringify({type:"error",code:errorCode(error)})}\n`);}
  finally{res.off("close",close);await queue.return();if(!res.destroyed&&!res.writableEnded)res.end();}
}
/** Reusable authenticated handler. TLS/session issuance/origin policy belongs to the embedder. */
export function createGatewayHttpHandler(coordinator:GatewayCoordinator,verify:CredentialVerifier,options:GatewayHttpOptions={}) {
  const fileOrigins=options.allowedFileOrigins===undefined?undefined:[...options.allowedFileOrigins];
  const revoked=new Set<string>(),active=new Map<ServerResponse,Identity>(),context=new AsyncLocalStorage<Identity>();
  let sealed=false;
  type Logical={active:boolean;queue?:ViewerQueue<unknown>};
  type Channel={id:string;identity:Identity;queue:ViewerQueue<ObserverFrame>;logical:Map<string,Logical>;closed:boolean};
  const channels=new Map<string,Channel>();
  const closeChannel=(channel:Channel)=>{if(channel.closed)return;channel.closed=true;channels.delete(channel.id);for(const logical of channel.logical.values()){logical.active=false;void logical.queue?.return();}channel.logical.clear();void channel.queue.return();};
  const observer=(identity:Identity,id:unknown):Channel=>{const channel=typeof id==="string"?channels.get(id):undefined;if(!channel||channel.closed)throw new GatewayError("UNAVAILABLE");if(canonical(identity)!==canonical(channel.identity))throw new GatewayError("FORBIDDEN");return channel;};
  const logicalId=(id:unknown):string=>{if(typeof id!=="string"||!/^[-a-zA-Z0-9_]{1,128}$/.test(id))throw new GatewayError("INVALID");return id;};
  const acquire=async(identity:Identity,request:ObserverRequest):Promise<ViewerQueue<unknown>>=>{
    switch(request.op){
      case "session.watch":return coordinator.watchSession(identity,request.target) as ViewerQueue<unknown>;
      case "history.watch":return coordinator.watchHistory(identity,request) as ViewerQueue<unknown>;
      case "interactions.watch":return coordinator.watchInteractions(identity,request.target) as ViewerQueue<unknown>;
      case "mcp.watch":return await coordinator.watchMcp(identity,request.target,request.run) as ViewerQueue<unknown>;
      case "catalog.watch":return coordinator.watchCatalog(identity,request.scope) as ViewerQueue<unknown>;
      case 'rpc.watch':return coordinator.watchRpc(identity,request.request) as ViewerQueue<unknown>;
      default:throw new GatewayError("INVALID");
    }
  };
  const subscribeObserver=async(identity:Identity,input:Record<string,any>)=>{
    const channel=observer(identity,input.channel),id=logicalId(input.id);if(channel.logical.has(id))throw new GatewayError("FENCED");if(channel.logical.size>=128)throw new GatewayError("FULL");
    const logical:Logical={active:true};channel.logical.set(id,logical);
    try{
      const queue=await acquire(identity,copy(input.request));
      if(channel.closed||!logical.active||channel.logical.get(id)!==logical){await queue.return();throw new GatewayError("UNAVAILABLE");}
      logical.queue=queue;
      void(async()=>{try{for await(const value of queue){if(channel.closed||!logical.active||channel.logical.get(id)!==logical)return;channel.queue.push({type:"event",id,value});}if(logical.active&&!channel.closed)channel.queue.push({type:"end",id});}
        catch(error){if(logical.active&&!channel.closed)channel.queue.push({type:"error",id,code:errorCode(error)});}
        finally{logical.active=false;if(channel.logical.get(id)===logical)channel.logical.delete(id);await queue.return();}})();
      return null;
    }catch(error){logical.active=false;if(channel.logical.get(id)===logical)channel.logical.delete(id);throw error;}
  };
  const routes=new Map<string,{target:GatewayTarget;handler:ReturnType<typeof createFileHttpHandler>}>();
  const namespace=(v:Namespace)=>JSON.stringify([v.connection,v.principal]);
  const authenticate=async(req:IncomingMessage):Promise<Identity>=>{const identity=await verify(req.headers.authorization);if(!identity||revoked.has(namespace(identity)))throw new GatewayError("UNAUTHENTICATED");return copy(identity);};
  const fileLocation=async(identity:Identity,t:GatewayTarget)=>{
    const surface=await coordinator.fileSurface(identity,t),path=`/v8-files/${createHash("sha256").update(targetKey(t)).digest("hex")}/`;
    if(!routes.has(path)){
      if(routes.size>=128)throw new GatewayError("FULL");
      const port:FilePort={async call(method,input){const identity=context.getStore();if(!identity)throw new GatewayError("UNAUTHENTICATED");const write=!["status","usage","acquire","read","release"].includes(method),current=await coordinator.fileSurface(identity,t,write);return current.port.call(method,input);}};
      const handler=createFileHttpHandler(port,{authenticate:async()=>{const current=context.getStore();if(!current)throw new GatewayError("UNAUTHENTICATED");return(await coordinator.fileSurface(current,t)).scope;},canUpload:()=>context.getStore()?.actions.includes("fileWrite")??false,...(fileOrigins===undefined?{}:{allowedOrigins:fileOrigins})});
      routes.set(path,{target:structuredClone(t),handler});
    }
    return {path,scope:surface.scope};
  };
  const handler=(req:IncomingMessage,res:ServerResponse):void=>{void(async()=>{
    try {
      if(sealed)throw new GatewayError("CLOSED");
      const identity=await authenticate(req);if(sealed)throw new GatewayError("CLOSED");active.set(res,identity);res.once("close",()=>active.delete(res));
      await context.run(identity,async()=>{
      if(req.url?.startsWith("/v8-files/")){
        const match=/^(\/v8-files\/[a-f0-9]{64}\/)(.*)$/.exec(req.url);const route=match?routes.get(match[1]!):undefined;
        if(!route)throw new GatewayError("UNAVAILABLE");
        await coordinator.fileSurface(identity,route.target);if(sealed)throw new GatewayError("CLOSED");req.url=`/${match![2]}`;
        await route.handler(req,res);return;
      }
      if(req.method!=="POST"||req.url!=="/v8")throw new GatewayError("INVALID");
      const input=await read(req);if(sealed)throw new GatewayError("CLOSED");let result:unknown;
      switch(input.op){
        case 'rpc.call':result=await coordinator.rpcCall(identity,input.request);break;
        case "watch.open":{
          if(channels.size>=32)throw new GatewayError("FULL");
          const channel:Channel={id:randomUUID(),identity,queue:new ViewerQueue<ObserverFrame>(128,2097152),logical:new Map(),closed:false};channels.set(channel.id,channel);channel.queue.setCleanup(()=>closeChannel(channel));channel.queue.push({type:"ready",channel:channel.id});
          try{await stream(res,channel.queue);}finally{closeChannel(channel);}return;
        }
        case "watch.subscribe":result=await subscribeObserver(identity,input);break;
        case "watch.unsubscribe":{const channel=observer(identity,input.channel),id=logicalId(input.id),logical=channel.logical.get(id);if(logical){logical.active=false;channel.logical.delete(id);await logical.queue?.return();}result=null;break;}
        case "snapshot":result=await coordinator.snapshot(identity,input.target);break;
        case "native.read":result=await coordinator.nativeRead(identity,input.target,input.run,input.request);break;
        case "controls.catalog":result=await coordinator.controlCatalog(identity,input.target);break;
        case "binding":result=await coordinator.binding(identity,input.target);break;
        case "submit":result=await coordinator.submit(identity,input.target,input.request);break;
        case "receipt":result=await coordinator.receipt(identity,input.target,input.id);break;
        case "mcp.loginLink":result=await coordinator.mcpLoginLink(identity,input.target,input.run,input.originalId);break;
        case "session.watch":await stream(res,coordinator.watchSession(identity,input.target));return;
        case "history.watch":await stream(res,coordinator.watchHistory(identity,{target:input.target,scope:input.scope,...(input.cursor?{cursor:input.cursor}:{})}));return;
        case "history.scopes":result=await coordinator.historyScopes(identity,input.target);break;
        case "history.older":result=await coordinator.older(identity,input.target,input.scope,input.cursor,input.generation,input.retryToken);break;
        case "history.recover":{
          const controller=new AbortController(),cancel=()=>controller.abort();res.once("close",cancel);
          try{result=await coordinator.recover(identity,input.target,input.scope,{signal:controller.signal,...(input.timeoutMs!==undefined?{timeoutMs:input.timeoutMs}:{})},input.retryToken);}finally{res.off("close",cancel);}break;
        }
        case "interactions.snapshot":result=await coordinator.interactionSnapshot(identity,input.target);break;
        case "interactions.watch":await stream(res,coordinator.watchInteractions(identity,input.target));return;
        case "mcp.snapshot":result=await coordinator.mcpSnapshot(identity,input.target,input.run);break;
        case "mcp.watch":await stream(res,await coordinator.watchMcp(identity,input.target,input.run));return;
        case "mcp.refresh":{
          const controller=new AbortController(),cancel=()=>controller.abort();res.once("close",cancel);
          try{result=await coordinator.mcpRefresh(identity,input.target,input.run,{signal:controller.signal,...(input.timeoutMs!==undefined?{timeoutMs:input.timeoutMs}:{})});}finally{res.off("close",cancel);}break;
        }
        case "files.route":result=await fileLocation(identity,input.target);break;
        case "catalog.list":result=await coordinator.catalogList(identity,input.scope);break;
        case "catalog.get":result=await coordinator.catalogGet(identity,input.scope,input.session);break;
        case "catalog.creation":result=await coordinator.catalogCreation(identity,input.scope,input.id);break;
        case "catalog.create":result=await coordinator.catalogCreate(identity,input.request);break;
        case "catalog.rename":result=await coordinator.catalogRename(identity,input.request);break;
        case "catalog.watch.set":result=await coordinator.catalogSetWatched(identity,input.request);break;
        case "catalog.metadata.original":result=await coordinator.catalogMetadataOriginal(identity,input.scope,input.id);break;
        case "catalog.archive.publish":result=await coordinator.catalogPublishArchive(identity,input.request);break;
        case "catalog.watch":await stream(res,coordinator.watchCatalog(identity,input.scope));return;
        default:throw new GatewayError("INVALID");
      }
      if(revoked.has(namespace(identity)))throw new GatewayError("UNAUTHENTICATED");json(res,200,{value:result});
      });
    }catch(error){json(res,errorCode(error)==="UNAUTHENTICATED"?401:errorCode(error)==="FORBIDDEN"?403:409,{error:errorCode(error)});}
  })();};
  return Object.assign(handler,{
    /** Preserve forwarded work and open observations; refuse requests still
     * authenticating/reading their body before the dispatch boundary. */
    sealAdmissions():void{sealed=true;},
    revoke(value:Namespace):void{revoked.add(namespace(value));for(const [res,identity]of active)if(namespace(identity)===namespace(value)){
      if(res.headersSent&&res.getHeader("content-type")==="application/x-ndjson"&&!res.writableEnded)res.end(`${JSON.stringify({type:"error",code:"UNAUTHENTICATED"})}\n`);
      else res.destroy();
    }},
    close():void{sealed=true;for(const channel of [...channels.values()])closeChannel(channel);for(const res of active.keys())res.destroy();active.clear();routes.clear();},
  });
}
/** Disposable authenticated loopback listener for the same reusable HTTP handler. */
export async function listenLoopback(coordinator:GatewayCoordinator,verify:CredentialVerifier):Promise<LoopbackGateway> {
  const handler=createGatewayHttpHandler(coordinator,verify),server=createServer(handler);
  server.requestTimeout=10000;server.headersTimeout=10000;
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",()=>{server.off("error",reject);resolve();});});
  const address=server.address() as AddressInfo;
  return Object.freeze({url:`http://127.0.0.1:${address.port}/v8`,revoke:handler.revoke,async close(){handler.close();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}});
}
