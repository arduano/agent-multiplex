import { GatewayCoordinator } from "../src/gateway/coordinator.js";
import { listenLoopback } from "../src/http/server.js";
import { HttpGatewayTransport } from "../src/client/http.js";
import { GatewayClient } from "../src/client/coordinator.js";
import { HistoryHub } from "../../v8-history/src/host/history-owner.js";
import { HistoryWorkspace } from "../../v8-history/src/client/workspace.js";
import type { Scope } from "../../v8-history/src/contracts/types.js";
import { copy } from "../../v8-session/src/contracts/validation.js";
import type { SessionPort, SessionSnapshot, Submit, Receipt } from "../../v8-session/src/contracts/types.js";
import type { GatewayTarget, Identity } from "../src/contracts/types.js";

export const target:GatewayTarget={connection:"fixture",principal:"alice",authority:"root",host:"host",session:"logical",owner:"durable-owner",routeEpoch:"route-1"};
export const scope={connection:target.connection,principal:target.principal,host:target.host,session:target.session};
export const historyScope:Scope={kind:"codex",origin:{connection:"fixture",principal:"alice",host:"host",nativeSession:"native",attachment:"1"},threadId:"native"};
export const alice:Identity={connection:"fixture",principal:"alice",authorities:["root"],actions:["read","control","catalogWrite"]};
export const bob:Identity={connection:"fixture",principal:"bob",authorities:["root"],actions:["read","control","catalogWrite"]};
export const request=(id="send"):Submit=>({scope,id,generation:1,command:{type:"send",text:"private original"}});
export const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
export async function until(test:()=>boolean,ms=5000):Promise<void>{const end=Date.now()+ms;while(!test()){if(Date.now()>=end)throw new Error("Bounded fixture condition did not settle");await new Promise(resolve=>setTimeout(resolve,5));}}
export class FixtureSession implements SessionPort {
  submits:Submit[]=[];reads=0;listeners=new Set<(snapshot:SessionSnapshot)=>void>();receipts=new Map<string,Receipt>();gate:ReturnType<typeof deferred<Receipt>>|undefined;
  state:SessionSnapshot={scope,kind:"codex",placement:"shared",epoch:1,revision:1,generation:1,phase:"running",activity:"idle",nativeSession:"native",stopRequested:false,selection:{kind:"codex"},interactionsComplete:true,interactions:[],capabilities:{commands:["send","answer"],fullStop:true,reopen:true}};
  async snapshot(){return copy(this.state);}
  async submit(value:Submit){this.submits.push(copy(value));const receipt:Receipt={scope:value.scope,id:value.id,type:value.command.type,generation:value.generation,state:"acknowledged",outcome:{status:"accepted"}};const result=value.command.type==="send"&&this.gate?await this.gate.promise:receipt;this.receipts.set(value.id,result);return result;}
  async receipt(_scope:unknown,id:string){this.reads++;return this.receipts.get(id)??null;}
  subscribe(_scope:unknown,listener:(snapshot:SessionSnapshot)=>void){this.listeners.add(listener);listener(copy(this.state));return()=>{this.listeners.delete(listener);};}
  emit(){this.state={...this.state,revision:this.state.revision+1};for(const listener of this.listeners)listener(copy(this.state));}
}
export async function fixture(options:{coordinator?:GatewayCoordinator;session?:SessionPort;fetch?:typeof fetch}={}){
  const coordinator=options.coordinator??new GatewayCoordinator(),session=options.session??new FixtureSession(),hub=new HistoryHub({maxRows:128,maxBodyBytes:65536,maxQueuedFrames:16});hub.open(historyScope,{knownStart:true});
  coordinator.register({target,session,history:hub,authorizeHistory:s=>s.origin.nativeSession==="native"&&s.origin.attachment==="1"});
  const server=await listenLoopback(coordinator,async authorization=>authorization==="Bearer fixture-alice"?alice:authorization==="Bearer fixture-bob"?bob:null);
  const make=(principal="alice",fetchImpl=options.fetch)=>{const history=new HistoryWorkspace({connection:"fixture",principal});let disposed=0;const transport=new HttpGatewayTransport({url:server.url,authorization:`Bearer fixture-${principal}`,...(fetchImpl?{fetch:fetchImpl}:{})});const t={...target,principal};const client=new GatewayClient({transport,history,targets:[t],onFence:()=>{disposed++;}});return{history,transport,client,get disposed(){return disposed;}};};
  return{coordinator,session,hub,server,make,async close(){coordinator.close();await server.close();}};
}
