import { GatewayError } from "./types.js";
/** One viewer owns this bounded queue. Overflow releases only this viewer's observation. */
export class ViewerQueue<T> implements AsyncIterableIterator<T> {
  #values: {value:T; bytes:number}[]=[]; #bytes=0;
  #state:"open"|"finished"|"failed"|"cancelled"="open"; #error: unknown;
  #waiter: {resolve:(value:IteratorResult<T>)=>void;reject:(error:unknown)=>void}|undefined;
  #cleanup: (()=>void)|undefined;
  readonly #terminal=new Set<()=>void>();
  #resolveClosed!:()=>void;
  readonly closed:Promise<void>=new Promise(resolve=>{this.#resolveClosed=resolve;});
  constructor(readonly maxFrames:number, readonly maxBytes:number) {}
  setCleanup(fn:()=>void): void { if(this.#state!=="open"){try{fn();}catch{/* Already closed. */}}else this.#cleanup=fn; }
  onClose(fn:()=>void):()=>void {if(this.#state!=="open"){fn();return()=>{};}this.#terminal.add(fn);return()=>{this.#terminal.delete(fn);};}
  [Symbol.asyncIterator](): AsyncIterableIterator<T> { return this; }
  push(value:T): void {
    if(this.#state!=="open") return;
    const bytes=new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if(bytes > this.maxBytes || this.#values.length >= this.maxFrames || this.#bytes+bytes > this.maxBytes) { this.fail(new GatewayError("OVERFLOW")); return; }
    if(this.#waiter) { const w=this.#waiter; this.#waiter=undefined; w.resolve({done:false,value}); }
    else { this.#values.push({value,bytes}); this.#bytes+=bytes; }
  }
  next():Promise<IteratorResult<T>> {
    if(this.#waiter) return Promise.reject(new GatewayError("INVALID","Concurrent viewer next"));
    if(this.#state==="failed") return Promise.reject(this.#error);
    const item=this.#values.shift(); if(item) { this.#bytes-=item.bytes; return Promise.resolve({done:false,value:item.value}); }
    if(this.#state!=="open") return Promise.resolve({done:true,value:undefined});
    return new Promise((resolve,reject)=>{this.#waiter={resolve,reject};});
  }
  fail(error:unknown):void {
    if(this.#state==="failed"||this.#state==="cancelled")return;
    const wasOpen=this.#state==="open";this.#error=error;this.#state="failed";this.#values=[];this.#bytes=0;if(wasOpen)this.#terminate();
  }
  finish():void {
    if(this.#state!=="open") return; this.#state="finished";this.#terminate();
  }
  #terminate():void {
    const cleanup=this.#cleanup; this.#cleanup=undefined;try{cleanup?.();}catch{/* Optional observation cleanup cannot retain the viewer queue. */}this.#resolveClosed();for(const fn of this.#terminal)try{fn();}catch{/* Observer isolation. */}this.#terminal.clear();
    if(this.#waiter) { const w=this.#waiter; this.#waiter=undefined; if(this.#state==="failed") w.reject(this.#error); else w.resolve({done:true,value:undefined}); }
  }
  async return():Promise<IteratorResult<T>> {
    const wasOpen=this.#state==="open";this.#state="cancelled";this.#values=[];this.#bytes=0;
    if(wasOpen)this.#terminate();return {done:true,value:undefined};
  }
}
