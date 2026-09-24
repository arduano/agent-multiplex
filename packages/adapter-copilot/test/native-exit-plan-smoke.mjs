import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {CopilotClient,RuntimeConnection} from '@github/copilot-sdk';
import {CopilotAgentAdapter} from '../src/adapter.ts';
const scratch=await mkdtemp(join(tmpdir(),'copilot-plan-probe-'));
const home=join(scratch,'copilot');await mkdir(home,{mode:0o700});
let providerRequests=0,native,adapter,session;
const provider=createServer((_request,response)=>{providerRequests++;response.writeHead(503).end()});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
try{
 const env={HOME:scratch,COPILOT_HOME:home,COPILOT_AUTO_UPDATE:'false',PATH:process.env.PATH??'/usr/bin:/bin'};
 adapter=new CopilotAgentAdapter({clientOptions:{baseDirectory:home,env,useLoggedInUser:false,logLevel:'none',connection:RuntimeConnection.forStdio({path:createRequire(import.meta.url).resolve(`@github/copilot-${process.platform}-${process.arch}`)})},provider:{type:'openai',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,wireApi:'completions'},defaultModel:'disposable-no-model',clientFactory:options=>{const client=new CopilotClient(options),create=client.createSession.bind(client);client.createSession=async config=>(native=await create(config));return client}});
 assert.equal((await adapter.describe()).available,true);
 session=await adapter.spawn({harness:'copilot',cwd:scratch});
 await session.execute({harness:'copilot',command:{type:'setMode',mode:'plan'}});
 await session.execute({harness:'copilot',command:{type:'setPermissionMode',mode:'allow-all'}});
 await native.rpc.tools.initializeAndValidate();
 const tools=(await native.rpc.tools.getCurrentMetadata()).tools??[];
 const plan=tools.filter(t=>/plan/i.test(t.name)).map(t=>({name:t.name,keys:Object.keys(t)}));
 assert.ok(plan.some(t=>t.name==='exit_plan_mode'),'Native Plan tool unavailable');
 const events=[];let interactionResolve;const interaction=new Promise(resolve=>{interactionResolve=resolve});
 session.subscribe(event=>{
  if(event.kind==='native'&&/exit_plan_mode/.test(event.nativeType))events.push(event.nativeType);
  if(event.kind==='interaction'&&event.requestType==='exitPlan'){
   events.push('interaction.exitPlan');
   void event.resolve({approved:false,feedback:'Disposable plan decline'}).then(()=>interactionResolve(true),()=>interactionResolve(false));
  }
 });
 let toolResult='unknown';
 try{
  const response=await Promise.race([
   native.rpc.tools.execute({name:'exit_plan_mode',toolCallId:'disposable-plan-call',arguments:{summary:'Disposable plan for smoke test',recommendedAction:'exit_only'}}),
   new Promise((_resolve,reject)=>setTimeout(()=>reject(new Error('plan-tool-timeout')),18000)),
  ]);
  toolResult=response?.resultType??'no-resultType';
 }catch(error){toolResult=/timeout/.test(String(error?.message))?'timeout':'native-error'}
 assert.equal(toolResult,'success','Native exit_plan_mode must settle after exact decision');
 assert.deepEqual(events.filter(type=>type==='exit_plan_mode.requested'||type==='interaction.exitPlan'||type==='exit_plan_mode.completed'),['exit_plan_mode.requested','interaction.exitPlan','exit_plan_mode.completed']);
 assert.equal(providerRequests,0,'Native plan-exit path must not make model calls');
 console.log(JSON.stringify({result:'passed',plan,events,toolResult,providerRequests}));
}finally{await session?.stop().catch(()=>undefined);await adapter?.close().catch(()=>undefined);await new Promise(resolve=>provider.close(resolve));await rm(scratch,{recursive:true,force:true})}
