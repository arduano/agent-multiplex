import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {openSync,closeSync,readFileSync,writeFileSync,fsyncSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

const limits=Object.freeze({launchesPerHarness:2,requestsPerAttempt:64,requestsPerHarness:128,wallMs:40*60_000,modelInference:0});
// Every helper admits before its first native effect. One completed preflight
// failure with no admissions therefore used no CLI slot. Keep the diagnostic,
// its elapsed time and the fixed deadline; never exempt a dispatched attempt.
const preflightFailure=attempt=>attempt.status==='failed-native-diagnostic'&&attempt.requests.length===0;
const launchReservations=attempts=>attempts.filter(attempt=>!preflightFailure(attempt)).length;
export function openCampaign(path,resumeId){
 const startedAt=Date.now();
 const state=resumeId?JSON.parse(readFileSync(path,'utf8')):{id:randomUUID(),startedAt,deadline:startedAt+limits.wallMs,limits,attempts:[],status:'running'};
 assert.deepEqual(state.limits,limits,'Immutable MCP-only limits differ');assert.equal(state.id,resumeId??state.id);assert.equal(state.deadline,state.startedAt+limits.wallMs);assert.ok(Date.now()<state.deadline,'MCP-only campaign expired');
 if(resumeId)assert.equal(state.status,'failed-diagnostic','Only a closed diagnostic can use its remaining finite slots');
 assert.ok(Array.isArray(state.attempts));
 for(const kind of ['codex','copilot']){const previous=state.attempts.filter(a=>a.kind===kind);assert.ok(previous.filter(preflightFailure).length<=1&&previous.length<=limits.launchesPerHarness+1&&launchReservations(previous)<=limits.launchesPerHarness&&previous.reduce((n,a)=>n+a.requests.length,0)<=limits.requestsPerHarness);for(const attempt of previous)assert.ok(attempt.requests.length<=limits.requestsPerAttempt);}
 const lock=path+'.lock',lockFd=openSync(lock,'wx',0o600);closeSync(lockFd);
 const save=()=>{writeFileSync(path,JSON.stringify(state,null,2)+'\n',{mode:0o600});const fd=openSync(path,'r');try{fsyncSync(fd)}finally{closeSync(fd)}};
 try{if(!resumeId){const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,JSON.stringify(state,null,2)+'\n');fsyncSync(fd)}finally{closeSync(fd)}}else{state.status='running';save()}}catch(error){unlinkSync(lock);throw error}
 let active=true;
 return{
  snapshot:()=>structuredClone(state),
  begin(kind){assert.ok(active&&Date.now()<state.deadline);assert.ok(kind==='codex'||kind==='copilot');const previous=state.attempts.filter(a=>a.kind===kind);assert.ok(previous.length<limits.launchesPerHarness+1&&launchReservations(previous)<limits.launchesPerHarness,'Fresh CLI allowance exhausted');
   const attempt={id:randomUUID(),kind,startedAt:new Date().toISOString(),requests:[],status:'running'};state.attempts.push(attempt);save();let accepting=true;
   return{id:attempt.id,admit(label){assert.ok(active&&accepting&&Date.now()<state.deadline,'Native admission closed');assert.ok(typeof label==='string'&&label.length>0&&label.length<=160);assert.ok(attempt.requests.length<limits.requestsPerAttempt,'Native attempt request cap');assert.ok(state.attempts.filter(a=>a.kind===kind).reduce((n,a)=>n+a.requests.length,0)<limits.requestsPerHarness,'Native harness request cap');attempt.requests.push({label,at:new Date().toISOString()});save()},finish(status){accepting=false;attempt.status=status;attempt.completedAt=new Date().toISOString();save()}};
  },
  close(status){if(!active)return;active=false;state.status=status;state.completedAt=new Date().toISOString();save();unlinkSync(lock)},
 };
}

/** No upstream, no credential source and no forwarding path. */
export async function createModelTrap(){
 const stats={requests:0,inferenceAttempts:0,forwarded:0},sockets=new Set();
 const server=createServer((request,response)=>{stats.requests++;if(request.method!=='GET'&&request.method!=='HEAD')stats.inferenceAttempts++;request.resume();response.writeHead(503,{'content-type':'application/json','connection':'close'}).end(JSON.stringify({error:{code:'INFERENCE_DISABLED',message:'Model inference is disabled in local MCP qualification'}}));});
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket))});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 let closing;
 return{endpoint:`http://127.0.0.1:${server.address().port}/v1`,snapshot:()=>({...stats}),close(){closing??=(async()=>{for(const socket of sockets)socket.destroy();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))})();return closing}};
}
