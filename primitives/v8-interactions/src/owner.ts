import { SessionError, sameRun, scopeKey, type ControlCommand, type NativeControlCommand, type Harness, type Interaction, type NativeEvent, type NativeOutcome, type NativeRun, type RunRef, type SessionScope } from "../../v8-session/src/contracts/types.js";
import { canonical, check, copy, id, scope } from "../../v8-session/src/contracts/validation.js";
import type { BridgeOptions, CallbackOwner, Delivery, InteractionPort, InteractionSnapshot, Json, NativeAnswer, Pending, Prompt } from "./contracts.js";
import { choices, encodeAnswer, normalizeCodex, normalizeCopilot, type CodexMethod, type CopilotMethod } from "./native.js";

type Held = { prompt: Prompt; state: Pending["state"]; respond(value: Json): Promise<Delivery> };
type SharedRegistration = Readonly<{ token: object; requestId: string | null; owner: CallbackOwner; respond(value: Json): Promise<Delivery> }>;
export type RegisterCodex = Omit<SharedRegistration,"requestId"> & Readonly<{ requestId: string; method: CodexMethod; params: unknown }>;
export type RegisterCopilot = SharedRegistration & Readonly<{ method: CopilotMethod; payload: unknown }>;
/** Per-native-run callback ownership. In-memory on purpose: closures are never durable state. */
export class InteractionOwner implements InteractionPort {
  readonly #run: RunRef; readonly #kind: Harness; readonly #epoch: number;
  readonly #pending = new Map<string,Held>(); readonly #listeners=new Set<(snapshot:InteractionSnapshot)=>void>();
  readonly #maxPending: number; readonly #maxBytes: number;
  readonly #tokens=new WeakMap<object,Prompt>(); readonly #vendors=new Map<string,Held>();
  #bytes=0; #revision=0; #complete=false; #lost=false; #retired=false; #issue:InteractionSnapshot["issue"];
  #emit: ((event:NativeEvent)=>void)|undefined;
  constructor(options: Readonly<{run:RunRef;kind:Harness;epoch:number;maxPending?:number;maxBytes?:number}>) {
    scope(options.run.scope);id(options.run.nativeSession);check(Number.isSafeInteger(options.run.generation)&&options.run.generation>0&&Number.isSafeInteger(options.epoch)&&options.epoch>=0);check(options.kind==="codex"||options.kind==="copilot");
    this.#run=copy(options.run);this.#kind=options.kind;this.#epoch=options.epoch;this.#maxPending=options.maxPending??128;this.#maxBytes=options.maxBytes??1024*1024;
    check(Number.isSafeInteger(this.#maxPending)&&this.#maxPending>0&&this.#maxPending<=512&&Number.isSafeInteger(this.#maxBytes)&&this.#maxBytes>=1024&&this.#maxBytes<=4*1024*1024);
  }
  async snapshot(value: SessionScope): Promise<InteractionSnapshot> {this.#assertScope(value);return this.current();}
  subscribe(value:SessionScope,listener:(snapshot:InteractionSnapshot)=>void):()=>void {this.#assertScope(value);if(this.#listeners.size>=128)throw new SessionError("FULL");this.#listeners.add(listener);return()=>this.#listeners.delete(listener);}
  current():InteractionSnapshot {return copy({scope:this.#run.scope,run:this.#run,epoch:this.#epoch,revision:this.#revision,baseline:this.#ready()?"complete":"partial",items:[...this.#pending.values()].map(({prompt,state})=>({prompt,state})),...(this.#issue?{issue:this.#issue}:{})});}
  /** Only the adapter may certify a complete same-owner baseline; idle/history/empty permission reads cannot. */
  certifyBaseline(proof:Readonly<{run:RunRef;complete:boolean;continuous:boolean}>):void {
    check(!this.#retired&&sameRun(this.#run,proof.run));if(!proof.complete||!proof.continuous){this.gap();return;}
    // An ingress loss cannot be repaired just by rereading an empty callback map.
    check(!this.#lost,"Native discontinuity needs a new certified native owner, never an empty-map repair");this.#complete=true;this.#publish();
  }
  gap():void {if(this.#retired)return;this.#lost=true;this.#complete=false;this.#issue="nativeGap";this.#publish();}
  registerCodex(input:RegisterCodex):Prompt {try{check(this.#kind==="codex");const previous=this.#tokens.get(input.token);if(previous){check(this.#pending.has(previous.id),"Original callback already retired");return previous;}const capability=this.#newId();return this.#register(normalizeCodex(this.#run,capability,input.requestId,input.owner,input.method,input.params),input.respond.bind(input),input.token);}catch(error){if(this.#issue!=="capacity")this.gap();throw error;}}
  registerCopilot(input:RegisterCopilot):Prompt {try{check(this.#kind==="copilot");const previous=this.#tokens.get(input.token);if(previous){check(this.#pending.has(previous.id),"Original callback already retired");return previous;}const capability=this.#newId();return this.#register(normalizeCopilot(this.#run,capability,input.requestId,input.owner,input.method,input.payload),input.respond.bind(input),input.token);}catch(error){if(this.#issue!=="capacity")this.gap();throw error;}}
  /** Exact capability settlement; raw vendor IDs must not be used here. */
  completed(capabilityId:string,run:RunRef):void {check(sameRun(this.#run,run));const held=this.#pending.get(capabilityId);if(!held)return;this.#remove(held);this.#publish();}
  /** Lose observation ownership without answering, stopping, or replaying anything. */
  retire():void {if(this.#retired)return;this.#retired=true;this.#complete=false;this.#issue="ownershipRetired";this.#pending.clear();this.#vendors.clear();this.#bytes=0;this.#publish();this.#emit=undefined;}
  wrap(options:BridgeOptions):NativeRun {
    check(sameRun(options.run.run,this.#run));check(!this.#emit,"One native owner bridge only");const run=options.run,invoke=run.invoke.bind(run),stop=run.stop.bind(run),emit=options.emit;this.#emit=event=>emit(event);
    const view=this.#summary();return Object.freeze({run:this.#run,selection:run.selection,interactionsComplete:view.complete,interactions:view.items,stop:async()=>{const proof=await stop();this.halted(proof);return proof;},invoke:(command:NativeControlCommand)=>command.type==="answer"?this.invoke(command):invoke(command)});
  }
  /** Trusted adapter also calls this for a spontaneous native halt. Disconnect is not a halt proof. */
  halted(proof:import("../../v8-session/src/contracts/types.js").StopProof):void {canonical(proof);check(proof.state==="stopped"&&proof.scope==="nativeTree"&&proof.noAutomaticContinuation===true&&sameRun(this.#run,proof.run));this.retire();}
  async invoke(command:Extract<ControlCommand,{type:"answer"}>):Promise<NativeOutcome> {
    if(this.#retired)return {status:"targetUnavailable"};id(command.interactionId);const held=this.#pending.get(command.interactionId);
    if(!held)return {status:"targetUnavailable"};
    // The original SessionHost receipt owns repeated same-request observation. Another operation cannot call the closure twice.
    if(held.state!=="pending")return {status:"refused",detail:{reason:"responseAlreadyOwned"}};
    let encoded:ReturnType<typeof encodeAnswer>;try{encoded=encodeAnswer(held.prompt,command.value as NativeAnswer);check(command.choice===encoded.choice,"Decision differs from frozen offered response");}catch{return {status:"refused",detail:{reason:"invalidNativeAnswer"}};}
    held.state="responding";this.#publish();
    const delivery=held.respond,nativeValue=copy(encoded.value),original=held;
    const result=(async():Promise<NativeOutcome>=>{try{
      const reply=await delivery(nativeValue);canonical(reply);check(reply&&typeof reply==="object");
      if(reply.kind==="submitted"){check(Object.keys(reply).length===1);if(this.#pending.get(original.prompt.id)===original&&!this.#retired){original.state="responseSubmitted";this.#publish();}return {status:"acknowledged",detail:{response:"submitted",agentWork:"notEstablished"}};}
      check(reply.kind==="ack"&&typeof reply.success==="boolean"&&Object.keys(reply).length===2);
      if(this.#pending.get(original.prompt.id)===original&&!this.#retired){this.#remove(original);this.#publish();}
      return reply.success?{status:"acknowledged",detail:{response:"nativeAcknowledged",agentWork:"notEstablished"}}:{status:"targetUnavailable",detail:{response:"resolvedElsewhereOrExpired"}};
    }catch{if(this.#pending.get(original.prompt.id)===original&&!this.#retired){original.state="responseUnknown";this.#publish();}throw new SessionError("IO","Original native response was dispatched; do not replay");}})();
    return result;
  }
  #register(prompt:Prompt,respond:Held["respond"],token:object):Prompt {
    check(!this.#retired,"Native owner retired");const bytes=new TextEncoder().encode(canonical(prompt,65536)).length;
    check(token&&typeof token==="object");const vendor=this.#vendor(prompt),previous=vendor===null?undefined:this.#vendors.get(vendor);if(previous)this.#remove(previous);
    if(this.#pending.size>=this.#maxPending||this.#bytes+bytes>this.#maxBytes){this.#lost=true;this.#complete=false;this.#issue="capacity";this.#publish();throw new SessionError("FULL");}
    // A live native callback incarnation is an adapter-owned token, not a new viewer or replay frame.
    const held:Held={prompt:copy(prompt),state:"pending",respond};this.#pending.set(prompt.id,held);this.#tokens.set(token,held.prompt);if(vendor!==null)this.#vendors.set(vendor,held);this.#bytes+=bytes;this.#publish();return held.prompt;
  }
  #newId():string {check(!this.#retired);return crypto.randomUUID();}
  #assertScope(value:SessionScope):void {scope(value);if(scopeKey(value)!==scopeKey(this.#run.scope))throw new SessionError("FENCED");}
  #ready():boolean{return this.#complete&&!this.#lost&&!this.#retired&&![...this.#pending.values()].some(held=>held.state!=="pending");}
  #summary():Readonly<{complete:boolean;items:readonly Interaction[]}> {return {complete:this.#ready(),items:[...this.#pending.values()].filter(held=>held.state==="pending").map(({prompt})=>({id:prompt.id,owner:prompt.owner.nativeAgent,kind:prompt.type.endsWith("question")?"userInput":prompt.type.endsWith("elicitation")?"elicitation":prompt.type.endsWith("plan")?"exitPlan":prompt.type.endsWith("permission")?"permission":"approval",choices:choices(prompt),blocking:prompt.type==="codex.question"?prompt.blocking:true}))};}
  #vendor(prompt:Prompt):string|null{return prompt.nativeRequestId===null?null:JSON.stringify([prompt.owner.nativeAgent,prompt.harness==="codex"?"jsonrpc":prompt.type,prompt.nativeRequestId]);}
  #remove(held:Held):void {if(this.#pending.get(held.prompt.id)!==held)return;this.#pending.delete(held.prompt.id);const vendor=this.#vendor(held.prompt);if(vendor!==null&&this.#vendors.get(vendor)===held)this.#vendors.delete(vendor);this.#bytes-=new TextEncoder().encode(canonical(held.prompt,65536)).length;}
  #publish():void {this.#revision++;const summary=this.#summary();try{this.#emit?.({run:this.#run,type:"interactions",...summary});}catch{/* Host observation failure cannot replay or re-enable callbacks. */}const view=this.current();for(const listener of [...this.#listeners])try{listener(view);}catch{/* One viewer cannot break callback ownership. */}}
}
