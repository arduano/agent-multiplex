// Disposable, one-prompt real Copilot plan-exit probe; no laptop session/state.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeConnection} from '@github/copilot-sdk';
import {CopilotAgentAdapter} from '../src/adapter.ts';
assert.equal(process.env.COPILOT_TEST_MODEL,'gpt-6-luna');
const endpoint=new URL(process.env.COPILOT_TEST_BASE_URL??'');
assert.ok(['http:','https:'].includes(endpoint.protocol)&&!endpoint.username&&!endpoint.password);
const key=(await readFile(process.env.COPILOT_TEST_KEY_FILE??'','utf8')).trim();assert.ok(key.length>=16);
const home=await mkdtemp(join(tmpdir(),'luna-exit-plan-'));await mkdir(join(home,'project'),{mode:0o700});
let adapter,session,phase='start',promptCount=0,deadline;
let interactionSeen=false,completed=false,idle=false,nativeRequestSeen=false;const counts={};
const env={HOME:home,COPILOT_HOME:join(home,'copilot'),COPILOT_AUTO_UPDATE:'false',XDG_CACHE_HOME:join(home,'cache'),PATH:process.env.PATH??'/usr/bin:/bin',SSL_CERT_FILE:'/run/ca-bundle.pem'};
try{
 adapter=new CopilotAgentAdapter({clientOptions:{baseDirectory:env.COPILOT_HOME,env,useLoggedInUser:false,logLevel:'none',connection:RuntimeConnection.forStdio({path:createRequire(import.meta.url).resolve(`@github/copilot-${process.platform}-${process.arch}`)})},provider:{type:'openai',baseUrl:endpoint.href,wireApi:'responses',transport:'http',apiKey:key},defaultModel:'gpt-6-luna',providerModels:['gpt-6-luna']});
 assert.equal((await adapter.describe()).available,true);
 session=await adapter.spawn({harness:'copilot',cwd:join(home,'project'),model:'gpt-6-luna'});
 phase='mode';await session.execute({harness:'copilot',command:{type:'setMode',mode:'plan'}});
 await session.execute({harness:'copilot',command:{type:'setPermissionMode',mode:'allow-all'}});
 let resolveDone,rejectDone;const done=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject});
 deadline=setTimeout(()=>rejectDone(new Error('plan request/whole-session idle deadline')),125000);
 session.subscribe(event=>{
  if(event.kind==='native'){
   counts[event.nativeType]=(counts[event.nativeType]??0)+1;
   if(event.nativeType==='exit_plan_mode.requested')nativeRequestSeen=true;
   if(event.nativeType==='exit_plan_mode.completed')completed=true;
   if(event.nativeType==='session.idle')idle=true;
   if(event.nativeType==='session.error')rejectDone(new Error('native session error'));
  }
  if(event.kind==='interaction'){
   counts[`interaction.${event.requestType}`]=(counts[`interaction.${event.requestType}`]??0)+1;
   if(event.requestType==='exitPlan'){
    interactionSeen=true;
    void event.resolve({approved:true,selectedAction:'exit_only'}).catch(()=>rejectDone(new Error('exact plan resolution rejected')));
   }
   if(event.requestType==='userInput')void event.resolve({answer:'No additional details are needed.',wasFreeform:true}).catch(()=>{});
  }
  if(interactionSeen&&completed&&idle)resolveDone();
 });
 phase='one-model-prompt';promptCount++;
 await session.execute({harness:'copilot',command:{type:'send',prompt:'In Plan mode, draft a one-sentence disposable plan to answer 2+2, then call exit_plan_mode with recommendedAction exit_only. Do not execute any plan or inspect files. Keep the final response to one sentence.'}});
 await done;clearTimeout(deadline);deadline=undefined;
 console.log(JSON.stringify({result:'passed',promptCount,interactionSeen,nativeRequestSeen,completed,idle,counts}));
}catch(error){const text=String(error?.message??error).toLowerCase();console.error(JSON.stringify({result:'failed',phase,promptCount,interactionSeen,nativeRequestSeen,completed,idle,category:/deadline/.test(text)?'NATIVE_TURN_TIMEOUT':/native session error/.test(text)?'NATIVE_SESSION_ERROR':'PROBE_FAILED',counts}));process.exitCode=1}
finally{if(deadline)clearTimeout(deadline);await session?.stop().catch(()=>{});await adapter?.close().catch(()=>{});await rm(home,{recursive:true,force:true})}
