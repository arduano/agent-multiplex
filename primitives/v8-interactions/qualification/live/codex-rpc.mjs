import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile,readdir} from 'node:fs/promises';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function processStat(pid){try{const text=await readFile(`/proc/${pid}/stat`,'utf8'),tail=text.slice(text.lastIndexOf(')')+2).split(' ');return{pid,state:tail[0],group:Number(tail[2]),start:tail[19]};}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function executingGroup(group){const members=[];for(const name of await readdir('/proc')){if(!/^\d+$/.test(name))continue;const stat=await processStat(Number(name));if(stat?.group===group&&!['Z','X'].includes(stat.state))members.push(stat.pid);}return members;}

/** Owned disposable Codex stdio transport. Explicit reverse responses; never automatic approve/error/retry. */
export class CodexInteractionRpc {
  #child;#exit;#next=1;#pending=new Map();#reverse=new Map();#notification;#request;#failure;#closed=false;#group;#start;
  counts={requests:{},notifications:{},reverseRequests:0,responses:0,stderrBytes:0};
  constructor({binary,args=['app-server','--stdio'],workspace,environment,onNotification,onServerRequest}){
    this.#notification=onNotification;this.#request=onServerRequest;
    assert.ok(Array.isArray(args)&&args.every(value=>typeof value==='string'));this.#child=spawn(binary,args,{cwd:workspace,env:environment,detached:true,stdio:['pipe','pipe','pipe']});this.#group=this.#child.pid;
    this.#exit=new Promise(resolve=>this.#child.once('exit',(code,signal)=>resolve({code,signal})));this.#child.on('error',()=>this.#fail(Error('CODEX_NATIVE_SPAWN_FAILED')));this.#child.stdin.on('error',()=>this.#fail(Error('CODEX_NATIVE_STDIN_CLOSED')));this.#child.stderr.on('data',bytes=>{this.counts.stderrBytes+=bytes.length;});
    const lines=createInterface({input:this.#child.stdout});lines.on('line',line=>{try{assert.ok(line.length<=2_000_000,'CODEX_NATIVE_FRAME_LIMIT');const message=JSON.parse(line);
      if(message.id!==undefined&&typeof message.method==='string'){assert.ok(this.#reverse.size<64,'CODEX_REVERSE_BOUND');const identity=JSON.stringify(message.id);assert.ok(!this.#reverse.has(identity),'CODEX_DUPLICATE_UNSETTLED_REQUEST_ID');this.#reverse.set(identity,{id:message.id,responded:false});this.counts.reverseRequests++;this.#request?.(message);}
      else if(message.id!==undefined){const pending=this.#pending.get(message.id);if(!pending)return;this.#pending.delete(message.id);clearTimeout(pending.timer);if(message.error)pending.reject(Error(`CODEX_RPC_ERROR:${pending.method}:${message.error.code??'unknown'}`));else pending.resolve(message.result);}
      else if(message.method){this.counts.notifications[message.method]=(this.counts.notifications[message.method]??0)+1;this.#notification?.(message);}
    }catch(error){this.#fail(error);}});
    void this.#exit.then(()=>{if(!this.#closed)this.#fail(Error('CODEX_NATIVE_EXITED'));});
  }
  #fail(error){this.#failure??=error;for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.#pending.clear();}
  get failure(){return this.#failure;}
  rejectObservation(error){this.#fail(error);}
  get pid(){return this.#child.pid;}
  async ready(){assert.ok(this.#group>0);this.#start=(await processStat(this.#group))?.start;assert.ok(this.#start,'CODEX_PROCESS_IDENTITY_NOT_OBSERVED');}
  async request(method,params={},timeout=30_000){if(this.#failure)throw this.#failure;assert.ok(!this.#closed);assert.ok(this.#pending.size<32,'CODEX_RPC_PENDING_BOUND');const id=this.#next++;this.counts.requests[method]=(this.counts.requests[method]??0)+1;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.#pending.delete(id);reject(Error(`CODEX_RPC_WAIT_EXPIRED:${method}`));},timeout);this.#pending.set(id,{resolve,reject,timer,method});this.#child.stdin.write(JSON.stringify({id,method,params})+'\n',error=>{if(error){clearTimeout(timer);this.#pending.delete(id);reject(Error('CODEX_RPC_WRITE_FAILED'));}});});}
  notify(method,params){assert.ok(!this.#closed);this.#child.stdin.write(JSON.stringify({method,...(params===undefined?{}:{params})})+'\n');}
  /** Resolves after stdio write only. Positive serverRequest/resolved is separate native proof. */
  async respond(requestId,value){assert.ok(!this.#closed);const held=this.#reverse.get(JSON.stringify(requestId));assert.ok(held&&!held.responded,'CODEX_REVERSE_RESPONSE_ALREADY_OWNED');held.responded=true;this.counts.responses++;await new Promise((resolve,reject)=>this.#child.stdin.write(JSON.stringify({id:requestId,result:value})+'\n',error=>error?reject(Error('CODEX_RESPONSE_WRITE_FAILED')):resolve()));return{kind:'submitted'};}
  resolved(requestId){this.#reverse.delete(JSON.stringify(requestId));}
  async close(){if(this.#closed)return this.#exit;this.#closed=true;const leader=await processStat(this.#group);assert.ok(!leader||leader.start===this.#start,'CODEX_PROCESS_IDENTITY_CHANGED');this.#child.stdin.end();let parentExited=false;void this.#exit.then(()=>{parentExited=true;});const graceful=Date.now()+3000;while(Date.now()<graceful&&(!parentExited||(await executingGroup(this.#group)).length))await pause(25);
    if((await executingGroup(this.#group)).length){try{process.kill(-this.#group,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}const terminate=Date.now()+3000;while(Date.now()<terminate&&(await executingGroup(this.#group)).length)await pause(25);}
    if((await executingGroup(this.#group)).length){try{process.kill(-this.#group,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}const force=Date.now()+3000;while(Date.now()<force&&(await executingGroup(this.#group)).length)await pause(25);}
    assert.equal((await executingGroup(this.#group)).length,0,'CODEX_OWNED_GROUP_STILL_EXECUTING');const result=await Promise.race([this.#exit,pause(1000).then(()=>{throw Error('CODEX_PARENT_EXIT_NOT_OBSERVED');})]);this.#fail(Error('CODEX_NATIVE_CLOSED'));return{...result,ownedGroupAbsent:true};
  }
}
