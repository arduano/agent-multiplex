import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

export async function until(predicate, label, timeout=120_000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) { const value=predicate(); if(value)return value; await new Promise(resolve=>setTimeout(resolve,25)); }
  throw new Error(`LIVE_TIMEOUT:${label}`);
}
export function providerGuard(upstream, key, model, maxPosts=32) {
  const base=new URL(upstream); assert.ok(['http:','https:'].includes(base.protocol)&&!base.username&&!base.password&&!base.search&&!base.hash);
  const stats={responsesPosts:0,completed:0,failed:0,rejectedModels:0,requestsByModel:{},active:0,abortedAfterTerminal:0,transportEnded:0,failedOrIncomplete:0,closedWithoutTerminal:0};
  const sockets=new Set();
  const server=createServer(async(req,res)=>{
    const chunks=[];let length=0;
    try {
      assert.equal(req.method,'POST');assert.match(req.url??'',/^\/(?:v1\/)?responses(?:\?.*)?$/);
      for await (const chunk of req) {length+=chunk.length;assert.ok(length<=2_000_000,'PROVIDER_BODY_BOUND');chunks.push(chunk);}
      const bytes=Buffer.concat(chunks),body=JSON.parse(bytes.toString('utf8'));
      if(body.model!==model) {stats.rejectedModels++;res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:{message:'Requested model is outside the finite allowance'}}));return;}
      assert.ok(stats.responsesPosts<maxPosts,'PROVIDER_REQUEST_ALLOWANCE_EXHAUSTED');
      stats.responsesPosts++;stats.requestsByModel[model]=(stats.requestsByModel[model]??0)+1;stats.active++;
      const target=new URL(base.href.replace(/\/$/,'')+'/responses');
      const headers={'content-type':'application/json','authorization':`Bearer ${key}`,'content-length':bytes.length};
      for(const name of ['accept','openai-beta','x-codex-turn-metadata','session_id','x-codex-session-id'])if(typeof req.headers[name]==='string')headers[name]=req.headers[name];
      let terminal=false,badTerminal=false,accounted=false,tail='';
      const finish=failed=>{if(accounted)return;accounted=true;stats.active--;stats.transportEnded++;if(terminal&&!badTerminal&&!failed)stats.completed++;else if(terminal&&!badTerminal)stats.completed++;else if(badTerminal){stats.failedOrIncomplete++;stats.failed++;}else{stats.closedWithoutTerminal++;if(failed)stats.failed++;}};
      const forward=(target.protocol==='https:'?httpsRequest:httpRequest)(target,{method:'POST',headers},response=>{
        res.writeHead(response.statusCode??502,Object.fromEntries(Object.entries(response.headers).filter(([name])=>['content-type','cache-control'].includes(name))));
        response.on('data',chunk=>{const text=tail+chunk.toString('utf8');if(/"type"\s*:\s*"response.completed"/.test(text))terminal=true;if(/"type"\s*:\s*"response.(?:failed|incomplete)"/.test(text))badTerminal=true;tail=text.slice(-4096);});
        response.pipe(res);response.on('end',()=>finish((response.statusCode??502)>=400));response.on('error',()=>{if(terminal)stats.abortedAfterTerminal++;finish(true);res.destroy();});
      });
      forward.setTimeout(120_000,()=>forward.destroy(new Error('PROVIDER_TIMEOUT')));
      forward.on('error',()=>{finish(true);if(!res.headersSent)res.writeHead(502).end('Provider forwarding failed');else res.destroy();});
      res.on('close',()=>{if(!res.writableEnded)forward.destroy();});forward.end(bytes);
    } catch {stats.failed++;if(!res.headersSent)res.writeHead(400).end('Finite provider guard refused request');else res.destroy();}
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  return {
    stats,
    async listen(){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}/v1`;},
    async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));},
  };
}

/** Minimal owned stdio RPC. No connection to a pre-existing daemon/session. */
export class NativeRpc {
  #child;#next=1;#pending=new Map();#notifications;#serverRequest;#failure;#closed=false;#exit;
  readonlyCounts={requests:{},notifications:{},reverseRequests:0,stderrBytes:0};
  constructor({binary,args,workspace,environment,onNotification,onServerRequest}) {
    this.#notifications=onNotification;this.#serverRequest=onServerRequest;
    this.#child=spawn(binary,args,{cwd:workspace,env:environment,stdio:['pipe','pipe','pipe']});
    this.#exit=new Promise(resolve=>this.#child.once('exit',(code,signal)=>resolve({code,signal})));
    this.#child.on('error',()=>this.#fail(new Error('NATIVE_SPAWN_FAILED')));
    this.#child.stdin.on('error',()=>this.#fail(new Error('NATIVE_STDIN_CLOSED')));
    this.#child.stderr.on('data',bytes=>{this.readonlyCounts.stderrBytes+=bytes.length;});
    const lines=createInterface({input:this.#child.stdout});
    lines.on('line',line=>{
      if(line.length>2_000_000){this.#fail(new Error('NATIVE_FRAME_LIMIT'));return;}
      try {
        const message=JSON.parse(line);
        if(message.id!==undefined&&message.method){
          this.readonlyCounts.reverseRequests++;
          this.#serverRequest?.(message);
          // Do not approve a server confirmation or invent a tool result.
          this.#child.stdin.write(JSON.stringify({id:message.id,error:{code:-32000,message:'Live qualification requires an actual user confirmation'}})+'\n');
          this.#fail(new Error('NATIVE_CONFIRMATION_REQUIRED'));return;
        }
        if(message.id!==undefined){
          const pending=this.#pending.get(message.id);if(!pending)return;
          this.#pending.delete(message.id);clearTimeout(pending.timer);
          if(message.error)pending.reject(new Error(`NATIVE_RPC_ERROR:${pending.method}:${message.error.code??'unknown'}`));else pending.resolve(message.result);
        }else if(message.method){this.readonlyCounts.notifications[message.method]=(this.readonlyCounts.notifications[message.method]??0)+1;this.#notifications(message);}
      }catch(error){this.#fail(error);}
    });
    void this.#exit.then(()=>{if(!this.#closed)this.#fail(new Error('NATIVE_EXITED'));});
  }
  #fail(error){this.#failure??=error;for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.#pending.clear();}
  get failure(){return this.#failure;}
  get pid(){return this.#child.pid;}
  async request(method,params={},timeout=25_000){
    if(this.#failure)throw this.#failure;assert.ok(!this.#closed);const id=this.#next++;
    this.readonlyCounts.requests[method]=(this.readonlyCounts.requests[method]??0)+1;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.#pending.delete(id);reject(new Error(`NATIVE_RPC_WAIT_EXPIRED:${method}`));},timeout);
      this.#pending.set(id,{resolve,reject,timer,method});
      this.#child.stdin.write(JSON.stringify({id,method,params})+'\n');
    });
  }
  notify(method,params){assert.ok(!this.#closed);this.#child.stdin.write(JSON.stringify({method,...(params?{params}:{})})+'\n');}
  async close(){
    if(this.#closed)return this.#exit;this.#closed=true;
    this.#child.stdin.end();let timer;
    try {return await Promise.race([this.#exit,new Promise(resolve=>{timer=setTimeout(()=>{this.#child.kill('SIGTERM');resolve(null);},3000);})]).then(async result=>{
      if(result)return result;
      let forced;try{return await Promise.race([this.#exit,new Promise((_,reject)=>{forced=setTimeout(()=>{this.#child.kill('SIGKILL');reject(new Error('NATIVE_EXIT_RELEASE_TIMEOUT'));},3000);})]);}finally{clearTimeout(forced);}
    });}finally{clearTimeout(timer);this.#fail(new Error('NATIVE_CLOSED'));}
  }
}
