import assert from 'node:assert/strict';
import test from 'node:test';
import {inflateSync} from 'node:zlib';
import {integrationLimits,nativeBudget,createSetupCustody} from './support.mjs';
import {runNativeModelFree} from './run.mjs';
import {CHILD_NAME,QUESTION_ANSWER,createChildGate,answerFor,fixtureImage,createNativeEvidence,inputInstructions,visualOrder,completedOriginal,integrationObservation} from './integration.mjs';

test('live profile requires its own explicit allowance and frozen source before any setup',async()=>{
 await assert.rejects(runNativeModelFree({allowLiveIntegration:true}),/source\/toolchain must be frozen/);
 await assert.rejects(runNativeModelFree({allowLiveIntegration:true,allowLunaSeeds:true,frozenSource:true}),/one finite qualification profile/);
 assert.equal(integrationLimits.wallMs,60*60_000);assert.equal(integrationLimits.modelForwards,24);assert.equal(integrationLimits.cleanupReserveMs,120_000);
});
test('live budget admits exactly three Codex/four Copilot originals and one Copilot child, with no replay or replenishment',()=>{
 const events=[],budget=nativeBudget({admit:(kind,id)=>events.push({kind,id})},Date.now()+1000,integrationLimits);
 for(const kind of['codex','copilot'])for(let i=0;i<(kind==='codex'?3:4);i++)budget.send(kind,`send-${i}`);
 assert.throws(()=>budget.send('codex','extra'),/allowance exhausted/);assert.throws(()=>budget.send('copilot','extra'),/allowance exhausted/);assert.throws(()=>budget.child('codex','forbidden'),/allowance exhausted/);
 budget.child('copilot','one-child');assert.throws(()=>budget.child('copilot','another'),/allowance exhausted/);assert.equal(events.length,8);
 const other=nativeBudget({admit(){}},Date.now()+1000,integrationLimits);other.send('codex','original');assert.throws(()=>other.send('codex','original'),/cannot replay/);other.seal();assert.throws(()=>other.child('copilot','after-close'),/admission closed/);
});
test('child permit precedes one exact native task; wrong owner/model/prompt/delegation and second shell cannot pass',()=>{
 const events=[],gate=createChildGate({model:'gpt-6-luna',command:'owned-long-tool',prompt:'exact-child-prompt',admit:()=>events.push('admitted'),violate:()=>events.push('denied')});gate.bindRoot('root');
 const task={sessionId:'root',toolName:'task',toolArgs:{agent_type:CHILD_NAME,model:'gpt-6-luna',prompt:'exact-child-prompt'}};
 assert.ok(gate.beforeTool(task,{sessionId:'root'}).deny);gate.arm();assert.equal(events.at(-1),'admitted');
 for(const changed of[{...task,sessionId:'other'},{...task,toolArgs:{...task.toolArgs,model:'other'}},{...task,toolArgs:{...task.toolArgs,prompt:'other'}},{...task,toolArgs:{...task.toolArgs,mode:'background'}},{...task,toolArgs:{...task.toolArgs,resume:'old'}}])assert.ok(gate.beforeTool(changed,{sessionId:'root'}).deny);
 assert.equal(gate.beforeTool(task,{sessionId:'root'}),null);assert.ok(gate.beforeTool(task,{sessionId:'root'}).deny);gate.observeChild('child');
 const shell={sessionId:'child',toolName:'bash',toolArgs:{command:'owned-long-tool'}};assert.equal(gate.beforeTool(shell,{sessionId:'root'}),null);assert.ok(gate.beforeTool(shell,{sessionId:'root'}).deny);assert.equal(gate.snapshot().children,1);
 const failed=createChildGate({model:'gpt-6-luna',command:'x',prompt:'x',admit:()=>{throw Error('closed')}});failed.bindRoot('root');assert.throws(()=>failed.arm(),/closed/);assert.ok(failed.beforeTool(task,{sessionId:'root'}).deny);
});
test('native answers preserve explicit confirmation scope and reject unrelated prompts or shell mutations',()=>{
 const permission={type:'copilot.permission',request:{kind:'shell',fullCommandText:'owned-tool'}};assert.deepEqual(answerFor(permission,{commands:['owned-tool']}),{type:'copilot.permission',kind:'approve-once'});
 assert.throws(()=>answerFor({...permission,request:{kind:'mcp',fullCommandText:'owned-tool'}},{commands:['owned-tool']}));assert.throws(()=>answerFor({...permission,request:{kind:'shell',fullCommandText:'other'}},{commands:['owned-tool']}));
 const question={type:'copilot.question',options:['fixture-red',QUESTION_ANSWER]};assert.throws(()=>answerFor(question));assert.deepEqual(answerFor(question,{question:true}),{type:question.type,answer:QUESTION_ANSWER,wasFreeform:false});
 assert.throws(()=>answerFor({...question,options:['unrelated']},{question:true}));assert.throws(()=>answerFor({type:'copilot.plan'},{question:true}));
 const codex={type:'codex.question',questions:[{id:'choice',options:['fixture-red','fixture-blue (Recommended)']}]};assert.deepEqual(answerFor(codex,{question:true}),{type:'codex.question',answers:{choice:['fixture-blue (Recommended)']}});assert.deepEqual(answerFor({...codex,questions:[{id:'choice',options:['fixture-red','fixture-blue']}]},{question:true}),{type:'codex.question',answers:{choice:['fixture-blue']}});
 for(const options of[['fixture-blue (recommended)'],['fixture-blue - recommended'],['fixture-blue (Recommended) extra'],['fixture-blue','fixture-blue (Recommended)']])assert.throws(()=>answerFor({...codex,questions:[{id:'choice',options}]},{question:true}));
});
test('actual PNG oracle has red-left/blue-right decoded pixels rather than an acknowledgement-only image claim',()=>{
 const png=fixtureImage();assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);assert.equal(png.readUInt32BE(16),256);assert.equal(png.readUInt32BE(20),128);
 let at=8;const compressed=[];while(at<png.length){const length=png.readUInt32BE(at),name=png.subarray(at+4,at+8).toString();if(name==='IDAT')compressed.push(png.subarray(at+8,at+8+length));at+=length+12}
 const raw=inflateSync(Buffer.concat(compressed));for(const y of[0,63,127]){assert.deepEqual([...raw.subarray(y*769+1,y*769+4)],[255,0,0]);assert.deepEqual([...raw.subarray(y*769+1+255*3,y*769+4+255*3)],[0,0,255])}
 assert.equal(visualOrder('Left: red. Right: blue.'),'red-blue');assert.equal(visualOrder('Left: blue. Right: red.'),'blue-red');
});
test('native child evidence joins actual agent and tool IDs; another owner cannot append its output',()=>{
 const evidence=createNativeEvidence('copilot','gpt-6-luna'),capture=value=>evidence.observe({kind:'copilot',value});let child; evidence.onChild(id=>{child=id});
 capture({type:'subagent.started',agentId:'child',data:{agentName:CHILD_NAME,toolCallId:'task'}});assert.equal(child,'child');
 capture({type:'tool.execution_start',agentId:'child',data:{toolCallId:'shell',toolName:'bash',arguments:{command:'owned'}}});capture({type:'tool.shell_output',agentId:'other',data:{toolCallId:'shell',text:'foreign'}});capture({type:'tool.shell_output',agentId:'child',data:{toolCallId:'shell',text:'owned'}});capture({type:'assistant.usage',agentId:'child',data:{model:'gpt-6-luna'}});
 assert.equal([...evidence.state.tools.values()][0].output,'owned');assert.deepEqual(evidence.summary().childActualModels,['gpt-6-luna']);assert.throws(()=>capture({type:'assistant.usage',agentId:'child',data:{model:'fallback'}}));
});

test('late runtime, Host, listener and reader setup close before cleanup settles and cannot publish',async()=>{
 for(const stage of['runtime','Host','listener','reader']){
  const setup=createSetupCustody(),published=new Set();let resolve,closed=0;const gate=new Promise(done=>{resolve=done}),resource={stage};
  const work=setup.acquire(()=>gate,async value=>{assert.equal(value,resource);closed++},value=>published.add(value));
  setup.seal();let settled=false;const cleanup=setup.settle().then(()=>{settled=true});await Promise.resolve();assert.equal(settled,false);resolve(resource);
  await assert.rejects(work,/setup is retired/);await cleanup;assert.equal(closed,1);assert.equal(published.size,0);assert.equal(setup.pending,0);await assert.rejects(setup.acquire(()=>resource,()=>{},()=>{}),/retired/);
 }
});

test('Copilot input fixture authorizes two separate exact commands without revealing the pixel answer',()=>{
 const text=inputInstructions('copilot',{completeCommand:'complete-owned',diskCommand:'cat-owned',done:'DONE'});
 assert.ok(text.includes('exactly two separate bash invocations, each command once'));assert.ok(text.includes('"complete-owned"'));assert.ok(text.includes('"cat-owned"'));assert.equal(/exactly once|shell once|red|blue/.test(text),false);
});
test('only an exact new user and latest new complete final plus actual idle permit content scoring; missing tool bytes stay unqualified',()=>{
 const secret='PRIVATE_NATIVE_BODY_AND_ID',assistant={id:secret,kind:'assistant',lifecycle:'completed',body:{kind:'complete',text:'Left: blue. Right: red. DONE PRIVATE_NATIVE_BODY_AND_ID'}},user={id:'user',kind:'user',lifecycle:'completed',body:{kind:'complete',text:'original'}},tool={id:'tool',kind:'tool',lifecycle:'completed',body:{kind:'partial',text:'tool-end',missing:['interior']}},history={rows:[user,tool,assistant],activity:{state:'idle'}},native={phase:'running',activity:'idle',interactions:[{secret}]};
 const facts={history,native,previous:new Set(),text:'original',toolMarker:'tool-end'},completed=completedOriginal(facts);assert.equal(completed.assistant,assistant);assert.equal(completed.tool,undefined);assert.equal(completed.assistant.body.text.includes('missing-disk-marker'),false);
 for(const change of[{previous:new Set([secret])},{previous:new Set(['user'])},{native:{...native,activity:'working'}},{native:{...native,phase:'stopped'}},{text:'another original'}])assert.equal(completedOriginal({...facts,...change}),null);
 assert.equal(completedOriginal({...facts,history:{...history,rows:[user,assistant,{...assistant,id:'newest',body:{kind:'complete',text:'missing-required-marker'}}]}}).assistant.id,'newest');
 const observation=integrationObservation({history,native,evidence:createNativeEvidence('copilot','gpt-6-luna'),markers:{mainDone:'DONE',disk:'missing-disk-marker'},stage:'files'});assert.equal(observation.matches.mainDone,true);assert.equal(observation.matches.disk,false);assert.equal(observation.visualOrder,'blue-red');assert.equal(observation.interactionCount,1);assert.equal(observation.shape[2].length,assistant.body.text.length);assert.equal(JSON.stringify(observation).includes(secret),false);assert.equal(JSON.stringify(observation).includes('Left:'),false);
});
test('live completion diagnostics distinguish explicit strings, terminal metadata and row gaps without exposing bodies or identities',()=>{
 const secret='PRIVATE_BODY_PATH_ID',evidence=createNativeEvidence('copilot','gpt-6-luna');
 evidence.observe({kind:'copilot',value:{type:'tool.execution_complete',data:{toolCallId:secret,success:true,result:{content:secret,detailedContent:secret+'!',contents:[{type:'shell_exit',shellId:secret,exitCode:0,outputPreview:secret,outputTruncated:true,outputFilePath:secret},{type:secret,text:secret}],binaryResultsForLlm:[{type:'image',data:secret,mimeType:'image/png'}]}}}});
 const snapshot={rows:[{id:secret,kind:'tool',lifecycle:'completed',body:{kind:'partial',text:secret,missing:['interior']}}],coverage:{gaps:[{id:secret,kind:'unsupported',rowId:secret}]}};
 const observation=integrationObservation({history:snapshot,evidence,stage:'files'}),completion=observation.nativeEvidence.toolCompletions[0];
 assert.equal(completion.contentPresent,true);assert.equal(completion.contentLength,secret.length);assert.equal(completion.detailedPresent,true);assert.deepEqual(completion.contents,[{kind:'shell_exit',textPresent:false,previewPresent:true,outputTruncated:true,exitCode:0},{kind:'unknown',textPresent:true,previewPresent:false,outputTruncated:null,exitCode:null}]);assert.deepEqual(observation.shape[0].missing,['interior']);assert.deepEqual(observation.gaps,[{kind:'unsupported',rowScoped:true,rowKind:'tool'}]);assert.equal(JSON.stringify(observation).includes(secret),false);
});
