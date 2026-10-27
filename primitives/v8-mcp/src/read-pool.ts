import { McpError,type McpSnapshot,type Observation } from './contracts.js';
import { check } from './validation.js';
type Result={value:McpSnapshot}|{error:McpError};
type Job={observers:Set<(result:Result)=>void>};
/** Share one instance across native-run replacements. Only actual settlement releases a slot. */
export class McpReadPool {
 readonly #jobs=new Map<object,Job>();readonly #maximum:number;readonly #maximumObservers:number;
 constructor(options:Readonly<{maxActive?:number;maxObservers?:number}>={}){this.#maximum=options.maxActive??2;this.#maximumObservers=options.maxObservers??32;check(Number.isSafeInteger(this.#maximum)&&this.#maximum>0&&this.#maximum<=16&&Number.isSafeInteger(this.#maximumObservers)&&this.#maximumObservers>0&&this.#maximumObservers<=128);}
 get active():number{return this.#jobs.size;}
 get observers():number{return[...this.#jobs.values()].reduce((sum,job)=>sum+job.observers.size,0);}
 observe(token:object,start:()=>Promise<McpSnapshot>,options:Observation={}):Promise<McpSnapshot>{
  const timeoutMs=options.timeoutMs??8000;check(Number.isSafeInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=60000);
  if(options.signal?.aborted)return Promise.reject(new McpError('CANCELLED'));
  let job=this.#jobs.get(token);
  if(!job){if(this.#jobs.size>=this.#maximum)return Promise.reject(new McpError('FULL'));job={observers:new Set()};this.#jobs.set(token,job);const held=job;
   const finish=(result:Result)=>{if(this.#jobs.get(token)===held)this.#jobs.delete(token);for(const listener of[...held.observers])listener(result);held.observers.clear();};
   void Promise.resolve().then(start).then(value=>finish({value}),error=>finish({error:error instanceof McpError?error:new McpError('UNAVAILABLE')}));
  }
  if(job.observers.size>=this.#maximumObservers)return Promise.reject(new McpError('FULL'));
  const held=job;
  return new Promise((resolve,reject)=>{let active=true;const finish=(result:Result)=>{if(!active)return;active=false;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);held.observers.delete(finish);if('value'in result)resolve(result.value);else reject(result.error);};
   const abort=()=>finish({error:new McpError('CANCELLED')}),timer=setTimeout(()=>finish({error:new McpError('TIMEOUT')}),timeoutMs);held.observers.add(finish);options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  });
 }
 /** Retires observers, not the underlying work or its capacity reservation. */
 retire(token:object):void {const job=this.#jobs.get(token);if(job)for(const listener of[...job.observers])listener({error:new McpError('FENCED')});}
}
