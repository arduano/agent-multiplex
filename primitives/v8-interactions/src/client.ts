import { SessionError, sameRun, scopeKey, type Receipt, type Submit } from "../../v8-session/src/contracts/types.js";
import { canonical, check, copy, id, scope } from "../../v8-session/src/contracts/validation.js";
import type { AnswerFor, InteractionPort, InteractionSnapshot, NativeAnswer, Prompt, SessionPort, SessionScope } from "./contracts.js";
import { encodeAnswer } from "./native.js";
export type ResponseOperation=Readonly<{id:string;interactionId:string;generation:number;state:"sending"|"unknown"|"observed";receipt:Receipt|null}>;
export type InteractionView=Readonly<{snapshot:InteractionSnapshot|null;connected:boolean;stale:boolean;operations:readonly ResponseOperation[]}>;
export type InteractionEntry=Readonly<{getSnapshot():InteractionView;subscribe(listener:()=>void):()=>void}>;
/** Private RAM only. These values are never part of InteractionView or a receipt. */
export type FormValues=Readonly<Record<string,string|boolean|readonly string[]>>;
export type FormHandle=Readonly<{getSnapshot():FormValues;subscribe(listener:()=>void):()=>void;update(values:FormValues):void}>;
type FormEntry={prompt:Prompt;values:FormValues;bytes:number;retired:boolean;listeners:Set<()=>void>;handle?:FormHandle};
type Entry={scope:SessionScope;value:InteractionSnapshot|null;connected:boolean;stale:boolean;ops:Map<string,ResponseOperation>;forms:Map<string,FormEntry>;formBytes:number;listeners:Set<()=>void>;unsubscribe:(()=>void)|null;initial:boolean;read:Promise<void>|null;token:number;facade?:InteractionEntry};
const emptyForm:FormValues=Object.freeze({});
/** Retained background store. React may render these immutable external-store snapshots in any layout. */
export class InteractionWorkspace {
  readonly #port:InteractionPort;readonly #session:SessionPort;readonly #entries=new Map<string,Entry>();readonly #maxSessions:number;readonly #maxOperations:number;readonly #admit:((scope:SessionScope)=>void)|undefined;#closed=false;
  constructor(options:Readonly<{port:InteractionPort;session:SessionPort;maxSessions?:number;maxOperations?:number;admit?:(scope:SessionScope)=>void}>){this.#port=options.port;this.#session=options.session;this.#admit=options.admit;this.#maxSessions=options.maxSessions??16;this.#maxOperations=options.maxOperations??128;check(Number.isSafeInteger(this.#maxSessions)&&this.#maxSessions>0&&this.#maxSessions<=128&&Number.isSafeInteger(this.#maxOperations)&&this.#maxOperations>0&&this.#maxOperations<=512);}
  async bind(value: SessionScope): Promise<void> {
    scope(value);
    if (this.#closed) throw new SessionError("CLOSED");
    const key = scopeKey(value);
    let entry = this.#entries.get(key);
    if (!entry) {
      if (this.#entries.size >= this.#maxSessions) throw new SessionError("FULL");
      entry = { scope: copy(value), value: null, connected: true, stale: true, ops: new Map(), forms: new Map(), formBytes: 0, listeners: new Set(), unsubscribe: null, initial: false, read: null, token: 0 };
      this.#entries.set(key, entry);
      const admitted = entry;
      try {
        const unsubscribe = this.#port.subscribe(admitted.scope, snapshot => this.#observe(admitted, snapshot));
        if (!this.#current(admitted)) {
          try { unsubscribe(); } catch { /* Already disposed; continue exact cleanup. */ }
        } else admitted.unsubscribe = unsubscribe;
      } catch (error) {
        if (this.#current(admitted)) this.#dispose(admitted);
        throw error;
      }
    }
    if (entry.initial) return;
    await this.refresh(entry.scope);
  }
  /** Stable immutable snapshot until the next observed change, suitable for useSyncExternalStore. */
  entry(value:SessionScope):InteractionEntry{const entry=this.#entry(value);if(entry.facade)return entry.facade;let previous:string|undefined,cached:InteractionView;const getSnapshot=()=>{const stamp=`${entry.token}`;if(stamp!==previous){cached=copy({snapshot:entry.value,connected:entry.connected,stale:entry.stale,operations:[...entry.ops.values()]});previous=stamp;}return cached;};entry.facade=Object.freeze({getSnapshot,subscribe:(listener:()=>void)=>{if(!this.#current(entry))throw new SessionError("CLOSED");if(entry.listeners.size>=128)throw new SessionError("FULL");entry.listeners.add(listener);return()=>entry.listeners.delete(listener);}});return entry.facade;}
  /** Exact pending capability, independent of React mount/selection/connection.
   * Acquire once per opened prompt; an admitted response retires the handle. */
  form(value:SessionScope,prompt:Prompt):FormHandle {
    const entry=this.#entry(value),current=this.#pending(entry,prompt);let form=entry.forms.get(prompt.id);
    if(!form){if(entry.forms.size>=16||entry.formBytes+2>128*1024)throw new SessionError("FULL","Private prompt draft capacity reached");form={prompt:current,values:emptyForm,bytes:2,retired:false,listeners:new Set()};entry.forms.set(prompt.id,form);entry.formBytes+=form.bytes;}
    if(form.handle)return form.handle;const held=form;
    held.handle=Object.freeze({getSnapshot:()=>held.values,subscribe:(listener:()=>void)=>{if(held.retired)return()=>{};if(held.listeners.size>=128)throw new SessionError("FULL");held.listeners.add(listener);return()=>held.listeners.delete(listener);},update:(values:FormValues)=>{
      if(this.#closed||held.retired||entry.forms.get(prompt.id)!==held)throw new SessionError("FENCED","Original prompt draft was retired");this.#pending(entry,held.prompt);
      check(values!==null&&typeof values==="object"&&!Array.isArray(values)&&(Object.getPrototypeOf(values)===Object.prototype||Object.getPrototypeOf(values)===null));
      check(Reflect.ownKeys(values).length===Object.keys(values).length&&Object.values(Object.getOwnPropertyDescriptors(values)).every(field=>"value"in field&&field.enumerable));
      for(const field of Object.values(values))check(typeof field==="string"||typeof field==="boolean"||Array.isArray(field)&&Reflect.ownKeys(field).length===field.length+1&&Object.keys(field).length===field.length&&Object.keys(field).every((key,index)=>key===String(index))&&Object.values(Object.getOwnPropertyDescriptors(field)).every(item=>"value"in item)&&Array.prototype.every.call(field,(item:unknown)=>typeof item==="string"));
      const bytes=new TextEncoder().encode(canonical(values,32*1024)).length;if(entry.formBytes-held.bytes+bytes>128*1024)throw new SessionError("FULL","Private prompt draft byte capacity reached");
      const fixed=copy(values);entry.formBytes+=bytes-held.bytes;held.bytes=bytes;held.values=fixed;this.#notifyForm(held);
    }});return held.handle;
  }
  setConnected(value:SessionScope,connected:boolean):void {if(this.#closed)throw new SessionError("CLOSED");scope(value);const entry=this.#entries.get(scopeKey(value));if(!entry)return;entry.connected=connected;entry.stale=true;this.#notify(entry);}
  async refresh(value: SessionScope): Promise<void> {
    const entry = this.#entry(value);
    if (!entry.connected) throw new SessionError("IO", "Connection is unavailable");
    if (entry.read) return entry.read;
    const pending = Promise.resolve().then(async () => {
      try {
        this.#assertCurrent(entry);
        const snapshot = await this.#port.snapshot(entry.scope);
        this.#assertCurrent(entry);
        this.#observe(entry, snapshot); entry.initial = true;
      } catch (error) {
        if (this.#current(entry)) { entry.stale = true; this.#notify(entry); }
        throw error;
      } finally {
        if (entry.read === pending) entry.read = null;
      }
    });
    entry.read = pending;
    return pending;
  }
  async checkReceipt(value:SessionScope,operationId:string):Promise<Receipt|null>{const entry=this.#entry(value);id(operationId);const op=entry.ops.get(operationId);check(op);const receipt=await this.#session.receipt(entry.scope,operationId);if(receipt){this.#receipt(entry,op,receipt);}return receipt;}
  answer<P extends Prompt>(value:SessionScope,prompt:P,response:AnswerFor<NoInfer<P>>,operationId:string=crypto.randomUUID()):Readonly<{id:string;result:Promise<Receipt>}>{
    const entry=this.#entry(value);this.#admit?.(entry.scope);id(operationId);check(entry.connected&&!entry.stale&&entry.value,"Refresh observations before responding");const snapshot=entry.value,current=this.#pending(entry,prompt);
    const encoded=encodeAnswer(current,response as NativeAnswer);
    this.#prune(entry);
    if(entry.ops.has(operationId))throw new SessionError("CONFLICT","Observe the original receipt rather than resending");if([...entry.ops.values()].filter(op=>!this.#terminal(op)).length>=this.#maxOperations)throw new SessionError("FULL");
    const original:Submit=copy({scope:entry.scope,id:operationId,generation:snapshot.run.generation,command:{type:"answer",interactionId:prompt.id,choice:encoded.choice,value:response as NativeAnswer}});
    const marker:ResponseOperation=copy({id:operationId,interactionId:prompt.id,generation:snapshot.run.generation,state:"sending",receipt:null});entry.ops.set(operationId,marker);this.#retireForm(entry,prompt.id);this.#notify(entry);
    const result=(async()=>{try{const receipt=await this.#session.submit(original);this.#receipt(entry,marker,receipt);return receipt;}catch{const known=entry.ops.get(operationId);if(!this.#closed&&known&&known.receipt?.state!=="acknowledged"&&known.receipt?.state!=="refused"){entry.ops.set(operationId,copy({...known,state:"unknown"}));this.#notify(entry);}throw new SessionError("IO","Check the original response receipt; do not resend");}})();
    return Object.freeze({id:operationId,result});
  }
  /** Browser navigation/unmount never calls this. Workspace owner retires observation explicitly. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#entries.values()) this.#dispose(entry);
  }
  #current(entry: Entry): boolean { return !this.#closed && this.#entries.get(scopeKey(entry.scope)) === entry; }
  #assertCurrent(entry: Entry): void {
    if (this.#closed) throw new SessionError("CLOSED");
    if (!this.#current(entry)) throw new SessionError("FENCED");
  }
  #dispose(entry: Entry): void {
    // Fence callbacks before external cleanup; cached facades still receive the scrubbed view.
    if (this.#entries.get(scopeKey(entry.scope)) === entry) this.#entries.delete(scopeKey(entry.scope));
    const unsubscribe = entry.unsubscribe;
    entry.unsubscribe = null;
    const forms = [...entry.forms.values()];
    entry.forms.clear(); entry.formBytes = 0;
    for (const form of forms) this.#scrubForm(form);
    entry.ops.clear(); entry.value = null; entry.connected = false; entry.stale = true;
    this.#notify(entry); entry.listeners.clear();
    for (const form of forms) { this.#notifyForm(form); form.listeners.clear(); }
    try { unsubscribe?.(); } catch { /* One failed unsubscribe cannot retain another session's state. */ }
  }
  #entry(value:SessionScope):Entry{if(this.#closed)throw new SessionError("CLOSED");scope(value);const entry=this.#entries.get(scopeKey(value));if(!entry)throw new SessionError("FENCED");return entry;}
  #observe(entry:Entry,snapshot:InteractionSnapshot):void{if(!this.#current(entry))return;check(scopeKey(snapshot.scope)===scopeKey(entry.scope)&&scopeKey(snapshot.run.scope)===scopeKey(entry.scope));canonical(snapshot,2*1024*1024);id(snapshot.run.nativeSession);check(Number.isSafeInteger(snapshot.run.generation)&&snapshot.run.generation>0&&Number.isSafeInteger(snapshot.epoch)&&Number.isSafeInteger(snapshot.revision)&&snapshot.epoch>=0&&snapshot.revision>=0&&snapshot.items.length<=512&&["complete","partial"].includes(snapshot.baseline));check(new Set(snapshot.items.map(x=>x.prompt.id)).size===snapshot.items.length);for(const item of snapshot.items){id(item.prompt.id);check(sameRun(item.prompt.run,snapshot.run)&&["pending","responding","responseSubmitted","responseUnknown"].includes(item.state));}const old=entry.value;if(old){check(old.run.nativeSession===snapshot.run.nativeSession,"Native binding changed; explicit new catalog binding required");if(snapshot.run.generation<old.run.generation)return;if(snapshot.run.generation===old.run.generation){if(snapshot.epoch<old.epoch||(snapshot.epoch===old.epoch&&snapshot.revision<old.revision))return;if(snapshot.epoch===old.epoch&&snapshot.revision===old.revision)check(canonical(old,2*1024*1024)===canonical(snapshot,2*1024*1024),"Conflicting interaction revision");}}entry.value=copy(snapshot);entry.stale=!entry.connected;for(const [id,form]of entry.forms){const current=snapshot.items.find(item=>item.prompt.id===id);if(snapshot.issue==="ownershipRetired"||!current||current.state!=="pending"||!sameRun(current.prompt.run,form.prompt.run)||canonical(current.prompt,65536)!==canonical(form.prompt,65536))this.#retireForm(entry,id);}this.#prune(entry);this.#notify(entry);}
  #pending(entry:Entry,prompt:Prompt):Prompt {const snapshot=entry.value,current=snapshot?.items.find(item=>item.prompt.id===prompt.id);check(snapshot&&snapshot.issue!=="ownershipRetired"&&current&&current.state==="pending"&&sameRun(prompt.run,snapshot.run)&&scopeKey(entry.scope)===scopeKey(prompt.run.scope)&&canonical(current.prompt,65536)===canonical(prompt,65536),"Stale native callback");check(![...entry.ops.values()].some(op=>op.interactionId===prompt.id&&op.generation===prompt.run.generation&&op.receipt?.state!=="refused"),"Check the original response receipt; do not resend");return current.prompt;}
  #retireForm(entry:Entry,id:string):void {const form=entry.forms.get(id);if(!form)return;entry.forms.delete(id);entry.formBytes-=form.bytes;this.#scrubForm(form);this.#notifyForm(form);form.listeners.clear();}
  #scrubForm(form: FormEntry): void { form.retired = true; form.values = emptyForm; form.bytes = 0; }
  #notifyForm(form:FormEntry):void {for(const listener of [...form.listeners])try{listener();}catch{/* One renderer cannot retain another renderer's private draft. */}}
  #receipt(entry:Entry,original:ResponseOperation,receipt:Receipt):void{check(receipt.id===original.id&&receipt.type==="answer"&&receipt.generation===original.generation&&scopeKey(receipt.scope)===scopeKey(entry.scope));const old=entry.ops.get(original.id);if(this.#closed||!old)return;if(old.receipt&&(old.receipt.state==="acknowledged"||old.receipt.state==="refused"))return;entry.ops.set(original.id,copy({...old,state:"observed",receipt}));this.#prune(entry);this.#notify(entry);}
  #terminal(op:ResponseOperation):boolean {return op.receipt?.state==="acknowledged"||op.receipt?.state==="refused";}
  #prune(entry:Entry):void {
    // An acknowledged callback still present natively guards against a second
    // answer. Its receipt is final, but that capability has not retired yet.
    const recent=[...entry.ops.values()].filter(op=>this.#terminal(op)&&!(op.receipt?.state==="acknowledged"&&entry.value?.items.some(item=>item.prompt.id===op.interactionId&&item.prompt.run.generation===op.generation)));
    for(const op of recent.slice(0,Math.max(0,recent.length-32)))entry.ops.delete(op.id);
  }
  #notify(entry:Entry):void{entry.token++;for(const listener of [...entry.listeners])try{listener();}catch{/* One renderer cannot block another. */}}
}
