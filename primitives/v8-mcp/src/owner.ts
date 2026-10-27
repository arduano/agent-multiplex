import { McpError,type CodexServer,type CopilotServer,type McpPort,type McpSnapshot,type NativeMcpReadPort,type Observation,type RunRef } from './contracts.js';
import { codexPage,copilotConfigured } from './native.js';
import { McpReadPool } from './read-pool.js';
import { MAX_PAGES,MAX_SERVERS,PAGE_SIZE,assertRun,check,copy,validateRun,validateSnapshot } from './validation.js';

/** Observation owner for an existing exact native run; never creates or closes native resources. */
export class McpOwner implements McpPort {
 readonly #run:RunRef;readonly #native:NativeMcpReadPort;readonly #reads:McpReadPool;readonly #listeners=new Set<(value:McpSnapshot)=>void>();readonly #clock:()=>number;
 #snapshot:McpSnapshot;#retired=false;
 constructor(options:Readonly<{run:RunRef;epoch:number;native:NativeMcpReadPort;reads:McpReadPool;now?:()=>number}>){
  validateRun(options.run);check(Number.isSafeInteger(options.epoch)&&options.epoch>=0&&(options.native.kind==='codex'||options.native.kind==='copilot'));this.#run=copy(options.run);this.#native=options.native;this.#reads=options.reads;this.#clock=options.now??Date.now;
  const base={run:this.#run,epoch:options.epoch,revision:0,freshness:'unobserved',coverage:'unknown',observedAt:null,management:options.native.management??'unavailable-no-original-command',servers:[]} as const;
  this.#snapshot=copy(options.native.kind==='codex'?{...base,kind:'codex',discovery:'thread-scoped-discovery'}:{...base,kind:'copilot',discovery:'configured-passive'});
 }
 async snapshot(run:RunRef):Promise<McpSnapshot>{assertRun(this.#run,run);return this.#snapshot;}
 subscribe(run:RunRef,listener:(value:McpSnapshot)=>void):()=>void {assertRun(this.#run,run);if(this.#retired){listener(this.#snapshot);return()=>{};}if(this.#listeners.size>=64)throw new McpError('FULL');this.#listeners.add(listener);return()=>this.#listeners.delete(listener);}
 async refresh(run:RunRef,observation:Observation={}):Promise<McpSnapshot>{this.#active(run);return this.#reads.observe(this,()=>this.#read(),observation);}
 /** Native metadata-change notification marks evidence stale; it never starts a discovery loop. */
 invalidate(run:RunRef):void {this.#active(run);this.#publish({...this.#snapshot,freshness:'stale',issue:'changed'});}
 /** Native-run/auth owner calls this. UI detach merely unsubscribes. */
 retire():void {if(this.#retired)return;this.#retired=true;this.#reads.retire(this);this.#publish({...this.#snapshot,freshness:'retired',issue:'ownershipRetired'});this.#listeners.clear();}
 #active(run:RunRef=this.#run):void {assertRun(this.#run,run);if(this.#retired)throw new McpError('FENCED');}
 async #read():Promise<McpSnapshot>{
  this.#active();const {issue:_,...previous}=this.#snapshot;this.#publish({...previous,freshness:'refreshing'});
  try{
   let servers:readonly CodexServer[]|readonly CopilotServer[],coverage:'enumerated'|'partial'='enumerated';
   if(this.#native.kind==='codex'){
    const rows:CodexServer[]=[],names=new Set<string>(),cursors=new Set<string>();let cursor:string|null=null;
    for(let page=0;page<MAX_PAGES;page++){
     this.#active();const result=codexPage(await this.#native.status({threadId:this.#run.nativeSession,detail:'toolsAndAuthOnly',cursor,limit:PAGE_SIZE}));this.#active();
     for(const server of result.servers){if(names.has(server.name)||rows.length>=MAX_SERVERS)throw new McpError('INVALID');names.add(server.name);rows.push(server);}
     cursor=result.nextCursor;if(cursor===null)break;if(cursors.has(cursor))throw new McpError('INVALID');cursors.add(cursor);if(page===MAX_PAGES-1)coverage='partial';
    }servers=rows;
   }else{servers=copilotConfigured(await this.#native.configured(),this.#native.transports);this.#active();if(new Set(servers.map(server=>server.name)).size!==servers.length)throw new McpError('INVALID');}
   this.#active();const changed=this.#snapshot.issue==='changed',next={...previous,freshness:changed?'stale':'current',coverage,observedAt:this.#clock(),servers,...(changed?{issue:'changed'}:{})} as McpSnapshot;this.#publish(next);return this.#snapshot;
  }catch(error){if(!this.#retired)this.#publish({...this.#snapshot,freshness:'stale',issue:'readFailed'});throw error instanceof McpError?error:new McpError('UNAVAILABLE');}
 }
 #publish(value:McpSnapshot):void {this.#snapshot=validateSnapshot({...value,revision:this.#snapshot.revision+1},this.#run,this.#native.kind);for(const listener of[...this.#listeners])try{listener(this.#snapshot);}catch{/* One viewer cannot own native acquisition or another viewer. */}}
}
