import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {bounded,ensure,packageRoot,makeRuntime,exactRuntimeGone,forceOwnContainer} from './copilot-runtime.mjs';

const CHILD='v8-remaining-child',ANSWER='remaining-choice';
const QUESTION='V8 remaining harmless choice?';
const QUESTION_FINAL='V8_REMAINING_QUESTION_OK',CHILD_FINAL='V8_REMAINING_CHILD_OK',ROOT_CHILD_FINAL='V8_REMAINING_PARENT_OK';
const CHILD_COMMAND="printf 'V8_REMAINING_CHILD_SHELL_OK\\n'";
const PLAN_CONTENT='# V8 remaining harmless plan\nReview this disposable plan and exit only. No implementation, file changes, install, authentication, networks, delegation, model switch or automatic continuation is authorized.';
const rootEvent=event=>!event.agentId&&!event.data?.agentId&&!event.data?.parentToolCallId;
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};

/** Pure boundary checks, exported for an offline oracle; importing this module launches nothing. */
export function remainingToolOffer(tools,stage){
 ensure(Array.isArray(tools),'COPILOT_REMAINING_TOOL_METADATA_MISSING');
 const allowed=stage==='question'?['ask_user']:stage==='plan'?['exit_plan_mode']:['task'];
 const names=tools.map(tool=>tool.name);ensure(names.every(name=>allowed.includes(name)),'COPILOT_REMAINING_UNEXPECTED_OFFER');
 return names;
}
export function remainingChildShell(request,workspace){
 return request?.kind==='shell'&&request.fullCommandText?.trim()===CHILD_COMMAND&&!request.hasWriteFileRedirection&&!request.requestSandboxBypass&&(!request.possibleUrls||request.possibleUrls.length===0)&&(!request.possiblePaths||request.possiblePaths.length===0)&&(!request.resolvedWorkingDirectory||resolve(request.resolvedWorkingDirectory)===resolve(workspace));
}
export function remainingOwnedPlan(prompt){return prompt?.type==='copilot.plan'&&prompt.owner?.relation==='root'&&prompt.plan===PLAN_CONTENT&&Array.isArray(prompt.actions)&&prompt.actions.includes('exit_only');}
export function remainingToolResult(outcome){if(typeof outcome==='string')return'opaque-string';ensure(outcome&&typeof outcome==='object'&&outcome.resultType==='success'&&!outcome.error,'COPILOT_REMAINING_NATIVE_TOOL_FAILED');return'explicit-success';}
export function remainingToolKey(owner,toolCallId){ensure(typeof owner?.nativeAgent==='string'&&owner.nativeAgent&&typeof toolCallId==='string'&&toolCallId,'COPILOT_REMAINING_TOOL_OWNER_ID_REQUIRED');return JSON.stringify([owner.nativeAgent,toolCallId]);}
/** Callback body is validation only. Ownership comes from the one fixed native tool invocation and actual session. */
export function remainingPlanCallbackMatches(event,payload){return event?.toolCallId&&event.planContent===PLAN_CONTENT&&payload?.planContent===PLAN_CONTENT&&typeof event.summary==='string'&&event.summary===payload.summary&&event.recommendedAction===payload.recommendedAction&&Array.isArray(event.actions)&&JSON.stringify(event.actions)===JSON.stringify(payload.actions)&&event.actions.includes('exit_only');}

/** Root alone invokes this under the fresh remaining-20261023 allowance. No historical originals are replayed. */
export async function runCopilotInteractions(ctx){
 const recovery=ctx.remainingRecovery===true,suffix=recovery?'-recovery':'';
 ensure(typeof ctx.model==='string'&&ctx.model.length>0,'COPILOT_REMAINING_UNALLOWED_MODEL');
 for(const path of[ctx.toolRoot,ctx.workspace,ctx.nativeHome,ctx.stateDirectory,ctx.buildRoot])ensure(typeof path==='string'&&isAbsolute(path),'COPILOT_REMAINING_DISPOSABLE_PATH_REQUIRED');
 ensure(resolve(ctx.toolRoot)!==resolve(ctx.nativeHome)&&resolve(ctx.toolRoot)!==resolve(ctx.workspace),'COPILOT_REMAINING_NATIVE_ROOT_OVERLAP');
 const endpoint=new URL(ctx.endpoint);ensure(endpoint.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)&&typeof ctx.key==='string'&&ctx.key,'COPILOT_REMAINING_GUARDED_PROVIDER_REQUIRED');
 ensure(ctx.openViewerBridge&&ctx.respondInBrowser&&ctx.registerNativeCleanup,'COPILOT_REMAINING_ACTUAL_HTTP_BROWSER_CLEANUP_REQUIRED');
 const result={harness:'copilot-remaining',status:'running',passed:false,recovery,currentScope:recovery?['plan','child']:['modelQuestion','plan','child'],cases:{},proofs:[],limitations:[],counts:{rootSends:0,childAdmissions:0,childStarts:0,nativeScenarios:0,controlRpcs:0,replyRpcs:0,sdkPlanCallbacks:0,sdkCallbackResponses:0,unexpectedSdkCallbacks:0,events:0,nativeBodyReads:0,browserAnswers:0},cleanup:{}};
 let client,session,runtime,host,owner,run,scope,emit,liveRun,bridgeA,bridgeB,interactionA,interactionB,sessionWorkspace,history,cleanupPromise;
 let accepting=true,fatal=null,stage='bootstrap',group=null,rootSendPending=false,childGate=false,childUsed=false,childInFlight=false,idle=0,answerOrdinal=0,activePlan=null;
 const interests=[],waiters=new Set(),jobs=new Set(),scheduled=new Set(),requests=new Map(),children=new Set(),models=new Set(),childModels=new Set(),finals=new Map(),childFinals=new Map(),toolStarts=new Map(),toolResults=new Map(),completedRequests=new Set(),responses=new Map(),eventKinds=new Map();
 const record=(name,value)=>ctx.record(`copilot-remaining-${name}`,value);
 const notify=()=>{for(const fn of[...waiters])fn();};
 const fail=code=>{fatal??=code;notify();};
 const active=()=>ensure(accepting&&!fatal,fatal??'COPILOT_REMAINING_OWNER_RETIRED');
 const diagnostic=error=>{let text=String(error?.message??'Native API rejected');for(const secret of[ctx.key,ctx.endpoint,ctx.toolRoot,ctx.workspace,ctx.nativeHome,ctx.stateDirectory])if(secret)text=text.replaceAll(secret,'<private>');return text.replace(/https?:\/\/[^\s"'<>]+/g,'<endpoint>').slice(0,1000);};
 const errorShape=error=>{const shape={name:error?.name??'Error',code:error?.code??null,message:diagnostic(error)};try{const data=error?.data??error?.cause?.data;if(data!==undefined){const json=JSON.stringify(data);shape.data=json.length<=16384?JSON.parse(json):{omitted:true,bytes:json.length};}}catch{shape.data={unavailable:true};}return shape;};
 async function waitFor(predicate,ms,code){await bounded(new Promise((yes,no)=>{const fn=()=>{if(fatal){waiters.delete(fn);no(Error(fatal));}else if(predicate()){waiters.delete(fn);yes();}};waiters.add(fn);fn();}),ms,code);}
 function begin(name,maximum){active();ensure(!group&&result.counts.nativeScenarios<10,'COPILOT_REMAINING_SCENARIO_BOUND');ctx.allowance.admit('copilot-native',`copilot-remaining:${name}${suffix}`);result.counts.nativeScenarios++;group={name,maximum,calls:0};record('scenario',{name,maximumInitiatingControlRpcs:maximum,recovery});}
 function end(){ensure(group,'COPILOT_REMAINING_NO_SCENARIO');record('scenario-complete',{name:group.name,initiatingControlRpcs:group.calls});group=null;}
 async function control(name,work,{cleanup=false}={}){if(!cleanup)active();ensure(result.counts.controlRpcs<50,'COPILOT_REMAINING_CONTROL_RPC_BOUND');if(group&&!cleanup){ensure(group.calls<group.maximum,'COPILOT_REMAINING_GROUP_RPC_BOUND');group.calls++;}result.counts.controlRpcs++;record('control-rpc',{operation:name,scenario:cleanup?null:group?.name??null,ordinal:result.counts.controlRpcs,cleanup});return bounded(work(),45000,`COPILOT_REMAINING_${name.toUpperCase()}_DEADLINE`);}
 async function reply(name,work){active();ensure(result.counts.replyRpcs<16,'COPILOT_REMAINING_REPLY_RPC_BOUND');result.counts.replyRpcs++;record('reply-rpc',{operation:name,ordinal:result.counts.replyRpcs});const ack=await bounded(work(),45000,'COPILOT_REMAINING_NATIVE_REPLY_DEADLINE');ensure(typeof ack?.success==='boolean'&&ack.success,'COPILOT_REMAINING_NATIVE_REPLY_NOT_ACKNOWLEDGED');return{kind:'ack',success:true};}
 function observedOwner(event){const id=event.agentId??event.data?.agentId;if(typeof id==='string'&&id){ensure(children.has(id),'COPILOT_REMAINING_UNPROVED_CHILD');return{nativeAgent:id,relation:'child'};}ensure(!event.data?.parentToolCallId,'COPILOT_REMAINING_UNATTRIBUTED_CHILD');return{nativeAgent:run.nativeSession,relation:'root'};}
 const requestKey=(event,method)=>JSON.stringify([event.agentId??event.data?.agentId??null,method,event.data?.requestId]);
 function answerFor(prompt){
  if(prompt.type==='copilot.question'){ensure(stage==='question'&&prompt.owner.relation==='root'&&prompt.question===QUESTION&&prompt.options.includes(ANSWER),'COPILOT_REMAINING_UNPLANNED_QUESTION');return{type:prompt.type,answer:ANSWER,wasFreeform:false};}
  if(prompt.type==='copilot.plan'){ensure(stage==='plan'&&remainingOwnedPlan(prompt),'COPILOT_REMAINING_PLAN_CONTENT_OR_SAFE_ACTION_UNPROVED');return{type:prompt.type,approved:true,selectedAction:'exit_only'};}
  ensure(prompt.type==='copilot.permission'&&stage==='child'&&prompt.owner.relation==='child'&&childInFlight&&remainingChildShell(prompt.request,ctx.workspace),'COPILOT_REMAINING_UNPLANNED_PERMISSION');return{type:prompt.type,kind:'approve-once'};
 }
 async function respond(prompt){
  active();const answer=answerFor(prompt),operationId=`copilot-remaining-answer-${++answerOrdinal}${suffix}`;
  await waitFor(()=>interactionA.entry(scope).getSnapshot().snapshot?.items.some(item=>item.prompt.id===prompt.id)&&interactionB.entry(scope).getSnapshot().snapshot?.items.some(item=>item.prompt.id===prompt.id),10000,'COPILOT_REMAINING_TWO_VIEWER_PROMPT_DEADLINE');
  const receipt=await bounded(ctx.respondInBrowser({bridge:bridgeA,prompt,answer,operationId}),45000,'COPILOT_REMAINING_BROWSER_ANSWER_DEADLINE');
  result.counts.browserAnswers++;ensure(receipt.id===operationId&&receipt.type==='answer'&&receipt.state==='acknowledged','COPILOT_REMAINING_ORIGINAL_ANSWER_NOT_ACKNOWLEDGED');
  ensure((await host.receipt(scope,operationId))?.state==='acknowledged','COPILOT_REMAINING_DURABLE_ANSWER_MISSING');responses.set(prompt.id,{type:prompt.type,owner:prompt.owner.relation,operationId,receiptState:receipt.state});record('response',{...responses.get(prompt.id),nativeRequestId:prompt.nativeRequestId,browser:true});notify();
 }
 function schedule(prompt){if(scheduled.has(prompt.id))return;ensure(scheduled.size<16,'COPILOT_REMAINING_PROMPT_BOUND');scheduled.add(prompt.id);const job=respond(prompt).catch(error=>{record('response-error',errorShape(error));fail('COPILOT_REMAINING_RESPONSE_REJECTED');});jobs.add(job);void job.finally(()=>jobs.delete(job));}
 function register(event,method,payload){
  ensure(owner&&interactionA&&typeof event.data?.requestId==='string','COPILOT_REMAINING_NATIVE_REQUEST_BEFORE_READY');
  const key=requestKey(event,method);if(requests.has(key))return;
  const requestId=event.data.requestId,proved=observedOwner(event);
  if(method!=='permission')ensure(proved.relation==='root','COPILOT_REMAINING_UNPLANNED_CHILD_UI');
  const plan=method==='exitPlan'?activePlan:null;
  if(plan){ensure(stage==='plan'&&proved.relation==='root'&&event.data.toolCallId===plan.toolCallId&&!plan.event,'COPILOT_REMAINING_PLAN_INVOCATION_UNPROVED');plan.event=event.data;plan.eventReady.resolve(event.data);}
  if(method==='exitPlan')ensure(plan,'COPILOT_REMAINING_PLAN_WITHOUT_OWNED_INVOCATION');
  const prompt=owner.registerCopilot({token:{},requestId,owner:proved,method,payload,respond:async value=>{
   if(method==='permission')return reply('permission',()=>session.rpc.permissions.handlePendingPermissionRequest({requestId,result:value}));
   if(method==='userInput')return reply('question',()=>session.rpc.ui.handlePendingUserInput({requestId,response:value}));
   await bounded(plan.callbackReady.promise,10000,'COPILOT_REMAINING_PLAN_CALLBACK_INGRESS_DEADLINE');active();ensure(activePlan===plan&&plan.event.requestId===requestId&&!plan.responded&&result.counts.sdkCallbackResponses<16,'COPILOT_REMAINING_PLAN_CALLBACK_RESPONSE_FENCED');
   plan.responded=true;result.counts.sdkCallbackResponses++;record('sdk-plan-response-submitted',{requestId,toolCallId:plan.toolCallId,ordinal:result.counts.sdkCallbackResponses,nativeAcknowledgement:false});plan.response.resolve(value);return{kind:'submitted'};
  }});
  requests.set(key,{id:prompt.id,requestId,method,toolCallId:event.data.toolCallId??null,owner:proved,completed:null});schedule(prompt);
 }
 function complete(event,method){const item=requests.get(requestKey(event,method));ensure(item,'COPILOT_REMAINING_UNTRACKED_NATIVE_COMPLETION');item.completed=event.data;completedRequests.add(item.id);owner.completed(item.id,run);}
 function unexpectedCallback(name){result.counts.unexpectedSdkCallbacks++;record('unexpected-sdk-callback',{name,selectedResponder:'native-event-and-exact-pending-rpc'});fail('COPILOT_REMAINING_UNEXPECTED_DIRECT_SDK_CALLBACK');throw Error('COPILOT_REMAINING_UNEXPECTED_DIRECT_SDK_CALLBACK');}
 async function planCallback(payload,invocation){
  const plan=activePlan;record('sdk-plan-callback-ingress',{sessionMatches:invocation?.sessionId===run?.nativeSession,keys:Object.keys(payload??{}),undefinedFields:Object.keys(payload??{}).filter(key=>payload[key]===undefined),payload});
  try{active();ensure(stage==='plan'&&plan&&invocation?.sessionId===run.nativeSession&&!childInFlight&&!plan.callbackSeen&&result.counts.sdkPlanCallbacks<16,'COPILOT_REMAINING_PLAN_CALLBACK_SCOPE_UNPROVED');plan.callbackSeen=true;result.counts.sdkPlanCallbacks++;
   const event=await bounded(plan.eventReady.promise,10000,'COPILOT_REMAINING_PLAN_NATIVE_ID_DEADLINE');ensure(activePlan===plan&&event.toolCallId===plan.toolCallId&&remainingPlanCallbackMatches(event,payload),'COPILOT_REMAINING_PLAN_CALLBACK_BODY_UNPROVED');
   record('sdk-plan-callback-bound',{requestId:event.requestId,toolCallId:plan.toolCallId,sessionMatches:true,soleCallbackIncarnation:true,bodyValidated:true});plan.callbackReady.resolve(true);return await bounded(plan.response.promise,60000,'COPILOT_REMAINING_PLAN_USER_RESPONSE_DEADLINE');
  }catch(error){record('sdk-plan-callback-error',errorShape(error));fail('COPILOT_REMAINING_PLAN_CALLBACK_REJECTED');throw error;}
 }
 async function priorQuestionEvidence(){
  const directory=new URL('../../artifacts/remaining-live-2026-10-23T07-48-56-614Z/',import.meta.url),sums=(await readFile(new URL('SHA256SUMS',directory),'utf8')).split('\n'),hashes={};let prior;
  for(const file of['result.json','observations.scrubbed.json']){const bytes=await readFile(new URL(file,directory)),sha256=createHash('sha256').update(bytes).digest('hex');ensure(sums.some(line=>line.trim()===`${sha256}  ${file}`),'COPILOT_REMAINING_PRIOR_CHECKSUM_MISMATCH');hashes[file]=sha256;if(file==='result.json')prior=JSON.parse(bytes);}
  const old=prior?.harnesses?.copilot;ensure(old?.cases?.modelQuestion?.status==='passed'&&old.cleanup?.runtimeGone&&old.cleanup?.postStopRpcRejected&&prior.sourceUnchanged&&prior.sharedViewerCleanup,'COPILOT_REMAINING_PRIOR_QUESTION_UNQUALIFIED');
  result.cases.modelQuestion={status:'observed-prior-diagnostic',receipt:'remaining-live-2026-10-23T07-48-56-614Z',hashes,retested:false};record('prior-question-evidence',{...result.cases.modelQuestion,priorEnvelopeStatus:prior.status,priorQuestion:old.cases.modelQuestion,noOldMutationReplayed:true,oldRuntimeGone:true});
 }
 function onEvent(event){
  if(!accepting)return;try{
   ensure(result.counts.events++<4096,'COPILOT_REMAINING_EVENT_BOUND');eventKinds.set(event.type,(eventKinds.get(event.type)??0)+1);
   if(['permission.requested','permission.completed','user_input.requested','user_input.completed','exit_plan_mode.requested','exit_plan_mode.completed','human_response.recorded','tool.execution_start','tool.execution_complete','subagent.started','subagent.completed','subagent.failed','assistant.usage','session.mode_changed','session.idle'].includes(event.type))record('native-event',event);
   if(event.type==='subagent.started'){result.counts.childStarts++;ensure(childUsed&&event.data?.agentName===CHILD&&result.counts.childStarts===1,'COPILOT_REMAINING_UNEXPECTED_CHILD');const id=event.agentId??event.data?.agentId;ensure(typeof id==='string'&&id,'COPILOT_REMAINING_CHILD_ID_MISSING');children.add(id);}
   if(event.type==='subagent.completed'){const id=event.agentId??event.data?.agentId;ensure(children.has(id)&&event.data?.agentName===CHILD&&!event.data?.cancelled,'COPILOT_REMAINING_UNPROVED_CHILD_COMPLETION');childInFlight=false;childGate=false;result.childCompletion=event.data;}
   if(event.type==='subagent.failed')fail('COPILOT_REMAINING_NATIVE_CHILD_FAILED');
   const actual=event.type==='subagent.completed'?event.data?.firstDispatchedModel:event.type==='assistant.usage'?event.data?.model:undefined;
   if(typeof actual==='string'){ensure(actual===ctx.model,'COPILOT_REMAINING_ACTUAL_MODEL_MISMATCH');models.add(actual);if(event.type==='subagent.completed'||!rootEvent(event))childModels.add(actual);}
   if(event.type==='assistant.message'){if(rootEvent(event))finals.set(event.data?.originatingMessageId,event.data?.content);else{const id=event.agentId??event.data?.agentId;ensure(children.has(id),'COPILOT_REMAINING_UNPROVED_CHILD_MESSAGE');childFinals.set(id,event.data?.content);}}
   if(event.type==='session.idle'&&rootEvent(event)){idle++;emit?.({run,type:'activity',activity:'idle'});}
   if(event.type==='assistant.turn_start'&&rootEvent(event))emit?.({run,type:'activity',activity:'working'});
   if(event.type==='tool.execution_start'){ensure(typeof event.data?.toolCallId==='string','COPILOT_REMAINING_TOOL_ID_MISSING');const proved=observedOwner(event);toolStarts.set(remainingToolKey(proved,event.data.toolCallId),{...event.data,owner:proved});if(proved.relation==='child')ensure(stage==='child'&&event.data.toolName==='bash'&&event.data.arguments?.command?.trim()===CHILD_COMMAND,'COPILOT_REMAINING_UNPLANNED_CHILD_TOOL');}
   if(event.type==='tool.execution_complete'){ensure(typeof event.data?.toolCallId==='string','COPILOT_REMAINING_TOOL_COMPLETION_ID_MISSING');const proved=observedOwner(event),key=remainingToolKey(proved,event.data.toolCallId),start=toolStarts.get(key);if(start)toolResults.set(key,{...event.data,owner:proved,toolName:start.toolName});}
   if(event.type==='permission.requested'&&!event.data?.resolvedByHook)register(event,'permission',event.data.permissionRequest);
   if(event.type==='permission.completed'){const key=requestKey(event,'permission');if(requests.has(key))complete(event,'permission');}
   if(event.type==='user_input.requested')register(event,'userInput',{question:event.data.question,...(event.data.choices===undefined?{}:{choices:event.data.choices}),...(event.data.allowFreeform===undefined?{}:{allowFreeform:event.data.allowFreeform})});
   if(event.type==='user_input.completed')complete(event,'userInput');
   if(event.type==='exit_plan_mode.requested')register(event,'exitPlan',{actions:event.data.actions,recommendedAction:event.data.recommendedAction,summary:event.data.summary,...(event.data.planContent===undefined?{}:{planContent:event.data.planContent})});
   if(event.type==='exit_plan_mode.completed')complete(event,'exitPlan');
   if(event.type==='session.error')fail('COPILOT_REMAINING_NATIVE_SESSION_ERROR');
  }catch(error){record('ingress-error',{stage,error:errorShape(error)});fail(error.message?.startsWith('COPILOT_')?error.message:'COPILOT_REMAINING_INGRESS_REJECTED');}notify();
 }
 async function settleResponses(){await bounded(Promise.all([...jobs]),50000,'COPILOT_REMAINING_RESPONSE_JOURNAL_DEADLINE');active();}
 async function readyForNext(){await settleResponses();ensure(owner.current().baseline==='complete'&&owner.current().items.length===0,'COPILOT_REMAINING_UNRESOLVED_NATIVE_REQUEST');}
 async function offered(next,filters){await readyForNext();await control(`${next}-tool-filter`,()=>session.rpc.options.update({availableTools:filters,excludedTools:[],includedBuiltinAgents:[],toolFilterPrecedence:'excluded'}));await control(`${next}-tools-initialize`,()=>session.rpc.tools.initializeAndValidate());const metadata=await control(`${next}-tool-metadata`,()=>session.rpc.tools.getCurrentMetadata());record('offered-tools',{stage:next,tools:metadata.tools});remainingToolOffer(metadata.tools,next);return metadata.tools;}
 async function modelSend(name,text,final){
  await readyForNext();ensure(result.counts.rootSends<3,'COPILOT_REMAINING_ROOT_BOUND');ctx.allowance.admit('copilot-root',`copilot-remaining:${name}${suffix}`);result.counts.rootSends++;rootSendPending=true;const before=idle;
  const receipt=await bounded(sessionWorkspace.request(scope,{type:'send',text},`copilot-remaining-${name}-original${suffix}`).result,30000,'COPILOT_REMAINING_MODEL_SEND_DEADLINE');ensure(receipt.state==='acknowledged'&&typeof receipt.outcome?.detail?.nativeMessageId==='string','COPILOT_REMAINING_ORIGINAL_SEND_NOT_ACCEPTED');const id=receipt.outcome.detail.nativeMessageId;
  await waitFor(()=>idle>before&&finals.get(id)?.trim()===final,120000,'COPILOT_REMAINING_MODEL_FINAL_DEADLINE');await settleResponses();return{originalId:receipt.id,nativeMessageId:id,finalObserved:true};
 }
 try{
  if(recovery)await priorQuestionEvidence();
  const core=ctx.core??{},SessionHost=core.SessionHost??(await import(pathToFileURL(join(ctx.buildRoot,'primitives/v8-lifecycle-default/src/session/index.js')).href)).SessionHost;
  const iw=await import(pathToFileURL(join(ctx.buildRoot,'primitives/v8-interactions/src/index.js')).href),sw=await import(pathToFileURL(join(ctx.buildRoot,'primitives/v8-session/src/client/index.js')).href),hw=await import(pathToFileURL(join(ctx.buildRoot,'primitives/v8-history/src/client/index.js')).href);
  const fromApp=createRequire(join(ctx.toolRoot,'package.json')),sdk=await packageRoot(fromApp.resolve('@github/copilot-sdk'),'@github/copilot-sdk'),cli=fromApp.resolve('@github/copilot-linux-x64'),platform=await packageRoot(cli,'@github/copilot-linux-x64');
  ensure(sdk.metadata.version==='1.0.19'&&sdk.metadata.copilotCliVersion==='1.0.95'&&platform.metadata.version==='1.0.95','COPILOT_REMAINING_PIN_MISMATCH');ensure(process.platform==='linux'&&process.arch==='x64','COPILOT_REMAINING_UNQUALIFIED_PLATFORM');
  runtime=await makeRuntime(cli,ctx);ctx.registerNativeCleanup(cleanupNative);
  const {CopilotClient,RuntimeConnection}=await import(pathToFileURL(join(sdk.directory,'dist/index.js')).href),sessionId=randomUUID();scope={connection:'v8-interactions-remaining',principal:'finite-owner',host:'disposable-copilot',session:`logical-${sessionId}`};
  const env={PATH:process.env.PATH??'/run/current-system/sw/bin',LANG:'C.UTF-8',HOME:ctx.nativeHome,COPILOT_HOME:ctx.nativeHome,TMPDIR:join(ctx.nativeHome,'tmp'),XDG_CONFIG_HOME:join(ctx.nativeHome,'xdg-config'),XDG_CACHE_HOME:join(ctx.nativeHome,'xdg-cache'),XDG_DATA_HOME:join(ctx.nativeHome,'xdg-data'),NODE_NO_WARNINGS:'1'};
  client=new CopilotClient({mode:'copilot-cli',connection:RuntimeConnection.forStdio({path:runtime.filename,env}),workingDirectory:ctx.workspace,baseDirectory:ctx.nativeHome,useLoggedInUser:false,logLevel:'none'});
  const port={kind:'copilot',placement:'dedicated',capabilities:{commands:['send','answer'],fullStop:true,openAndWait:true},catalog:async()=>({available:true,choices:[{model:ctx.model,efforts:[]}]}),inspect:async()=>liveRun??null,start:async(input,emitNative)=>{
   ensure(input.nativeSession===null&&!input.continuePendingWork,'COPILOT_REMAINING_NO_OLD_RESUME');run={scope,generation:input.generation,nativeSession:sessionId};emit=emitNative;owner=new iw.InteractionOwner({run,kind:'copilot',epoch:1});
   session=await control('create',()=>client.createSession({sessionId,model:ctx.model,allowedModels:[ctx.model],provider:{type:'openai',wireApi:'responses',transport:'http',baseUrl:ctx.endpoint,apiKey:ctx.key,modelId:ctx.model,wireModel:ctx.model},workingDirectory:ctx.workspace,configDirectory:ctx.nativeHome,streaming:true,includeSubAgentStreamingEvents:true,availableTools:[recovery?'builtin:exit_plan_mode':'builtin:ask_user'],defaultAgent:{excludedTools:['bash']},includedBuiltinAgents:[],customAgentsLocalOnly:true,customAgents:[{name:CHILD,displayName:'Finite remaining V8 child',description:'One exact harmless shell fixture',tools:['bash'],model:ctx.model,prompt:`Invoke bash exactly once with command ${JSON.stringify(CHILD_COMMAND)} and a short description. Do not use any other command, files, networks, skills or delegation. After the successful tool result reply exactly ${CHILD_FINAL}.`}],onEvent,onPermissionRequest:()=>({kind:'no-result'}),onUserInputRequest:()=>unexpectedCallback('userInput'),onExitPlanModeRequest:planCallback,onAutoModeSwitchRequest:()=>{fail('COPILOT_REMAINING_UNEXPECTED_AUTOSWITCH');return'no';},onMcpAuthRequest:()=>{fail('COPILOT_REMAINING_UNEXPECTED_OAUTH');return{kind:'cancelled'};},hooks:{onPreToolUse(input){
    if(input.toolName==='task'){if(stage!=='child'||!childGate||childUsed||input.toolArgs?.agent_type!==CHILD||(input.toolArgs.model!==undefined&&input.toolArgs.model!==ctx.model)){fail('COPILOT_REMAINING_UNALLOWED_CHILD');return{permissionDecision:'deny',permissionDecisionReason:'Only one named finite child is authorized.'};}ctx.allowance.admit('copilot-child',`copilot-remaining:one-child${suffix}`);result.counts.childAdmissions++;childUsed=true;childInFlight=true;return;}
    const expected=stage==='question'&&input.toolName==='ask_user'||stage==='plan'&&input.toolName==='exit_plan_mode'||stage==='child'&&childInFlight&&children.size===1&&input.toolName==='bash'&&input.toolArgs?.command?.trim()===CHILD_COMMAND;
    if(!expected){record('tool-policy-rejected',{stage,name:input.toolName,args:input.toolArgs});fail('COPILOT_REMAINING_UNPLANNED_TOOL');return{permissionDecision:'deny',permissionDecisionReason:'Exact finite native fixture tools only.'};}
   }}}));
   owner.certifyBaseline({run,complete:true,continuous:true});const native={run,selection:{kind:'copilot',model:ctx.model,permissions:'manual',mode:'interactive'},interactionsComplete:true,interactions:[],stop:async()=>{await cleanupNative();ensure(result.cleanup.runtimeGone,'COPILOT_REMAINING_NATIVE_TREE_NOT_PROVED');return{run,state:'stopped',scope:'nativeTree',noAutomaticContinuation:true};},invoke:async command=>{ensure(command.type==='send'&&rootSendPending,'COPILOT_REMAINING_UNADMITTED_SEND');rootSendPending=false;const id=await control('model-send',()=>session.send({prompt:command.text}));ensure(typeof id==='string'&&id,'COPILOT_REMAINING_SEND_ID_MISSING');return{status:'accepted',detail:{nativeMessageId:id}};}};liveRun=owner.wrap({run:native,emit:emitNative});return liveRun;
  }};
  await mkdir(ctx.stateDirectory,{recursive:true,mode:0o700});host=await SessionHost.open({directory:join(ctx.stateDirectory,'session'),scope,port,policy:{kind:'copilot',provider:'copilot-only',permissions:'manual'},observationMs:60000});
  begin('fresh-bootstrap',10);ensure((await host.submit({scope,id:`copilot-remaining-create${suffix}`,generation:0,command:{type:'create'}})).state==='acknowledged','COPILOT_REMAINING_CREATE_NOT_ACKNOWLEDGED');
  bridgeA=await ctx.openViewerBridge({scope,sessionPort:host,interactionPort:owner});bridgeB=await ctx.openViewerBridge({scope,sessionPort:host,interactionPort:owner});
  interactionA=new iw.InteractionWorkspace({port:bridgeA.interactionPort,session:bridgeA.sessionPort});interactionB=new iw.InteractionWorkspace({port:bridgeB.interactionPort,session:bridgeB.sessionPort});await Promise.all([interactionA.bind(scope),interactionB.bind(scope)]);interactionA.entry(scope).subscribe(notify);interactionB.entry(scope).subscribe(notify);
  history=new hw.HistoryWorkspace({connection:scope.connection,principal:scope.principal});sessionWorkspace=new sw.SessionWorkspace({history,port:bridgeA.sessionPort});await sessionWorkspace.bind(scope,{kind:'copilot',agentId:null,origin:{connection:scope.connection,principal:scope.principal,host:scope.host,nativeSession:sessionId,attachment:'1'}});
  const selected=await control('selected-model',()=>session.rpc.model.getCurrent());ensure(selected.modelId===ctx.model,'COPILOT_REMAINING_SELECTED_MODEL_MISMATCH');
  const policy=await control('manual-permissions',()=>session.rpc.permissions.setMode({mode:'manual'}));ensure(policy.success&&policy.mode==='manual','COPILOT_REMAINING_MANUAL_POLICY_NOT_PROVED');
  const required=await control('permission-events',()=>session.rpc.permissions.setRequired({required:true}));ensure(required.success,'COPILOT_REMAINING_PERMISSION_EVENTS_UNAVAILABLE');
  for(const eventType of['user_input.requested','exit_plan_mode.requested']){const interest=await control(`interest-${eventType}`,()=>session.rpc.eventLog.registerInterest({eventType}));ensure(typeof interest.handle==='string','COPILOT_REMAINING_INTEREST_HANDLE_MISSING');interests.push(interest.handle);}
  await control('initial-tools-initialize',()=>session.rpc.tools.initializeAndValidate());const metadata=await control('initial-tool-metadata',()=>session.rpc.tools.getCurrentMetadata());record('offered-tools',{stage:recovery?'recovery-initial-plan':'question',tools:metadata.tools});remainingToolOffer(metadata.tools,recovery?'plan':'question');if(!recovery)ensure(metadata.tools.some(tool=>tool.name==='ask_user'),'COPILOT_REMAINING_ASK_USER_NOT_OFFERED');
  const agents=await control('initial-agent-list',()=>session.rpc.agent.list({})),childDefinition=agents.agents?.find(agent=>agent.name===CHILD);record('initial-agent-list',agents);record('child-definition',childDefinition??null);ensure(childDefinition&&Array.isArray(childDefinition.tools)&&childDefinition.tools.length===1&&childDefinition.tools[0]==='bash'&&(childDefinition.model===ctx.model||childDefinition.models?.includes(ctx.model)),'COPILOT_REMAINING_CHILD_CONFIGURATION_UNPROVED');
  const initialMode=await control('initial-mode',()=>session.rpc.mode.get());ensure(initialMode==='interactive','COPILOT_REMAINING_INITIAL_MODE_NOT_INTERACTIVE');record('initial-mode',initialMode);end();

  if(!recovery){stage='question';ctx.progress('Copilot remaining: one actual Luna root with only ask_user offered, exact native event IDs and real browser reply.');
  const questionOriginal=await modelSend('model-question',`Finite disposable qualification. Invoke ask_user exactly once with question ${JSON.stringify(QUESTION)} and choices [${JSON.stringify(ANSWER)}]. Do not delegate or call any other tool. After the native answer is returned, reply exactly ${QUESTION_FINAL}.`,QUESTION_FINAL);
  const questions=[...requests.values()].filter(request=>request.method==='userInput');ensure(questions.length===1&&questions[0].completed?.answer===ANSWER&&questions[0].completed?.wasFreeform===false&&completedRequests.has(questions[0].id)&&responses.has(questions[0].id),'COPILOT_REMAINING_QUESTION_NATIVE_COMPLETION_UNPROVED');
  const questionTool=questions[0].toolCallId&&toolResults.get(remainingToolKey(questions[0].owner,questions[0].toolCallId));ensure(questionTool?.toolName==='ask_user'&&questionTool.success&&JSON.stringify(questionTool.result).includes(ANSWER),'COPILOT_REMAINING_QUESTION_TOOL_RESULT_UNPROVED');await readyForNext();result.cases.modelQuestion={status:'passed',...questionOriginal,exactNativeRequestId:true,nativePendingRpcAck:true,nativeCompletedEvent:true,exactToolCallId:questions[0].toolCallId,successfulNativeToolResult:true,browser:true};record('question-proof',result.cases.modelQuestion);}

  stage='plan';ctx.progress('Copilot remaining: positively read native mode, refresh exact offered plan tool, use only an offered exit_only action.');
  begin('native-plan-flow',12);const beforeMode=await control('plan-before-mode',()=>session.rpc.mode.get());ensure(beforeMode==='interactive','COPILOT_REMAINING_PLAN_BEFORE_MODE_UNEXPECTED');
  await readyForNext();await control('plan-tool-filter',()=>session.rpc.options.update({availableTools:['builtin:exit_plan_mode'],excludedTools:[],toolFilterPrecedence:'excluded'}));
  const setter=await control('plan-mode-set',()=>session.rpc.mode.set({mode:'plan',planModelConfigured:false}));record('plan-setter-ack',setter);ensure(!setter.modelChanged&&!setter.confirmation&&!setter.deferImplementation,'COPILOT_REMAINING_PLAN_UNSAFE_TRANSITION');
  const appliedMode=await control('plan-mode-read',()=>session.rpc.mode.get());record('plan-actual-mode',{before:beforeMode,afterSet:appliedMode});ensure(appliedMode==='plan','COPILOT_REMAINING_NATIVE_PLAN_MODE_NOT_APPLIED');
  await control('plan-tools-initialize',()=>session.rpc.tools.initializeAndValidate());const planMeta=await control('plan-tool-metadata',()=>session.rpc.tools.getCurrentMetadata());record('offered-tools',{stage:'plan',tools:planMeta.tools});remainingToolOffer(planMeta.tools,'plan');const exit=planMeta.tools.find(tool=>tool.name==='exit_plan_mode');
  if(exit){
   await control('plan-content',()=>session.rpc.plan.update({content:PLAN_CONTENT}));
   const schema=exit.input_schema;ensure(schema?.type==='object'&&schema.properties,'COPILOT_REMAINING_PLAN_SCHEMA_UNAVAILABLE');const values={summary:'V8 remaining harmless plan review',recommendedAction:'exit_only',showFleet:false},args=Object.fromEntries(Object.entries(values).filter(([key])=>Object.hasOwn(schema.properties,key)));ensure((schema.required??[]).every(key=>Object.hasOwn(args,key)),'COPILOT_REMAINING_PLAN_REQUIRED_ARGUMENT_UNSUPPORTED');
   const nativeToolId=`v8-remaining-plan-${randomUUID()}`;activePlan={toolCallId:nativeToolId,event:null,eventReady:deferred(),callbackReady:deferred(),response:deferred(),callbackSeen:false,responded:false};
   const outcome=await control('native-exit-plan',()=>session.rpc.tools.execute({name:exit.name,arguments:args,toolCallId:nativeToolId}));record('plan-native-tool-result',{toolCallId:nativeToolId,outcome});const nativeToolReturn=remainingToolResult(outcome);await settleResponses();
   const plans=[...requests.values()].filter(request=>request.method==='exitPlan');ensure(plans.length===1&&plans[0].completed?.approved===true&&plans[0].completed?.selectedAction==='exit_only'&&responses.has(plans[0].id)&&completedRequests.has(plans[0].id),'COPILOT_REMAINING_PLAN_COMPLETION_UNPROVED');
   ensure(activePlan.callbackSeen&&activePlan.responded&&activePlan.event?.requestId===plans[0].requestId,'COPILOT_REMAINING_SOLE_PLAN_CALLBACK_UNPROVED');const afterMode=await control('plan-after-exit-mode',()=>session.rpc.mode.get());record('plan-after-exit-mode',afterMode);ensure(afterMode==='interactive','COPILOT_REMAINING_EXIT_ONLY_DID_NOT_EXIT');await readyForNext();result.cases.plan={status:'passed',nativeModeBefore:beforeMode,nativeModeAfterSet:appliedMode,nativeModeAfterExit:afterMode,selectedAction:'exit_only',nativeToolReturned:true,nativeToolReturn,nativeRequestId:plans[0].requestId,nativeToolCallId:nativeToolId,originalHostReceipt:true,responseDelivery:'sdkCallbackSubmitted',nativePendingRpcAck:false,nativeCompletedEvent:true,soleSdkCallback:true,browser:true};activePlan=null;
  }else{
   result.cases.plan={status:'unqualified',reason:'NativeExitPlanToolUnavailableAfterPositivePlanModeAndToolReinitialization',nativeModeBefore:beforeMode,nativeModeAfterSet:appliedMode,eventInterestRegistered:true};
   const restored=await control('plan-interactive-restore',()=>session.rpc.mode.set({mode:'interactive',restorePlanModel:false}));record('plan-restore-setter',restored);ensure(!restored.modelChanged&&!restored.confirmation&&!restored.deferImplementation,'COPILOT_REMAINING_PLAN_RESTORE_UNSAFE');ensure((await control('plan-restore-mode-read',()=>session.rpc.mode.get()))==='interactive','COPILOT_REMAINING_PLAN_RESTORE_UNPROVED');
  }
  end();record('plan-proof',result.cases.plan);

  stage='child';begin('child-offer-and-owner',5);const childTools=await offered('child',['builtin:task','builtin:bash']);ensure(childTools.some(tool=>tool.name==='task'),'COPILOT_REMAINING_TASK_NOT_OFFERED');const childAgents=await control('child-agent-list',()=>session.rpc.agent.list({})),configured=childAgents.agents?.find(agent=>agent.name===CHILD);record('child-agent-list',childAgents);ensure(configured?.tools?.length===1&&configured.tools[0]==='bash','COPILOT_REMAINING_CHILD_TOOL_FILTER_CHANGED');ensure((await control('child-mode-read',()=>session.rpc.mode.get()))==='interactive','COPILOT_REMAINING_CHILD_MODE_NOT_INTERACTIVE');end();
  childGate=true;ctx.progress('Copilot remaining: one separate Luna root may dispatch exactly one named Luna child with bash only.');
  const childOriginal=await modelSend('model-child',`Finite disposable qualification. Invoke task exactly once with agent_type ${CHILD}, model ${ctx.model}, name "Remaining harmless child", description "One harmless child permission marker", prompt "Invoke bash exactly once with command ${JSON.stringify(CHILD_COMMAND)} and a short description, then reply exactly ${CHILD_FINAL}. Do not use skills, other tools, files, networks or delegation." Wait for that exact child; do not retry or launch another child. After the successful child result reply exactly ${ROOT_CHILD_FINAL}.`,ROOT_CHILD_FINAL);
  const childPermissions=[...requests.values()].filter(request=>request.method==='permission'&&request.owner.relation==='child'),childShells=[...toolResults.values()].filter(tool=>tool.owner.relation==='child'&&tool.toolName==='bash'),tasks=[...toolResults.values()].filter(tool=>tool.owner.relation==='root'&&tool.toolName==='task');
  ensure(result.counts.childAdmissions===1&&result.counts.childStarts===1&&children.size===1&&result.childCompletion&&childModels.has(ctx.model),'COPILOT_REMAINING_CHILD_ID_MODEL_COMPLETION_UNPROVED');
  ensure(childPermissions.length===1&&childPermissions[0].completed?.result?.kind==='approved'&&responses.has(childPermissions[0].id),'COPILOT_REMAINING_CHILD_PERMISSION_COMPLETION_UNPROVED');
  ensure(childShells.length===1&&childShells[0].success&&JSON.stringify(childShells[0].result).includes('V8_REMAINING_CHILD_SHELL_OK'),'COPILOT_REMAINING_CHILD_SHELL_EFFECT_UNPROVED');
  ensure([...childFinals.values()].some(text=>text?.trim()===CHILD_FINAL)&&tasks.length===1&&tasks[0].success&&JSON.stringify(tasks[0].result).includes(CHILD_FINAL),'COPILOT_REMAINING_CHILD_FINAL_CONSUMPTION_UNPROVED');await readyForNext();
  result.cases.child={status:'passed',...childOriginal,childCount:1,actualChildModel:ctx.model,positiveNativeChildId:true,childTools:['bash'],rootTools:['task'],exactNativePermissionId:true,nativePendingRpcAck:true,nativeCompletedEvent:true,successfulExactShellResult:true,childFinalAndParentTaskResult:true,browser:true};record('child-proof',result.cases.child);
  ensure(models.has(ctx.model),'COPILOT_REMAINING_ACTUAL_MODEL_UNOBSERVED');
  result.proofs.push('Fresh originals only; actual pinned SDK1.0.19/CLI1.0.95 and explicitly selected model through guarded provider only','Two actual retained viewers, authenticated HTTP, Chromium typed popups and worker-SQLite Host answer receipts','Question/permission use exact pending-request RPC acknowledgements; plan uses one actual SDK closure with exact native event ID and controlled invocation plus completed/tool-return/mode proof; no injected callback, dual responder, body read or idle-based healing');
  result.limitations.push('Absent native plan tool remains unqualified even if mode setter acknowledged or mode.get reports plan.','Provider model choice is checked through observed usage/child dispatch; no fallback, rate-limit manipulation, auth, installation or production activity is induced.','Published p2prpc/Iroh cross-viewer older-history defect remains unresolved; this disposable HTTP/native subset does not qualify it.');
  result.passed=result.currentScope.every(name=>result.cases[name]?.status==='passed');result.status=result.passed?(recovery?'passed-native-plan-child-subset':'passed-native-remaining-subset'):'partial-native-remaining-subset';
 }catch(error){result.passed=false;result.status='failed-native-diagnostic';result.reason=fatal??diagnostic(error);record('failure',{stage,reason:result.reason,error:errorShape(error)});}
 finally{
  accepting=false;childGate=false;interactionA?.close();interactionB?.close();sessionWorkspace?.close();await bridgeA?.close().catch(()=>{});await bridgeB?.close().catch(()=>{});
  try{await cleanupNative();}catch(error){record('cleanup-error',errorShape(error));result.passed=false;result.status='failed-native-diagnostic';}
  owner?.retire();if(host)await host.terminate();waiters.clear();result.eventKinds=Object.fromEntries(eventKinds);record('cleanup',result.cleanup);ctx.progress('Copilot remaining: fresh bounded lane ended; exact owned native cleanup checked.');
 }
 return result;
 function cleanupNative(){
  if(cleanupPromise)return cleanupPromise;accepting=false;cleanupPromise=(async()=>{
   if(session){for(const handle of interests.splice(0)){try{await control('release-interest',()=>session.rpc.eventLog.releaseInterest({handle}),{cleanup:true});}catch(error){record('interest-release-error',errorShape(error));}}
    try{await bounded(session.disconnect(),8000,'COPILOT_REMAINING_DISCONNECT_DEADLINE');result.cleanup.sessionDisconnected=true;}catch{result.cleanup.sessionDisconnected=false;}}
   if(client){try{const errors=await bounded(client.stop(),15000,'COPILOT_REMAINING_STOP_DEADLINE');result.cleanup.sdkStopAcknowledged=Array.isArray(errors)&&errors.length===0;}catch{result.cleanup.sdkStopAcknowledged=false;try{await bounded(client.forceStop(),5000,'COPILOT_REMAINING_FORCESTOP_DEADLINE');}catch{}}try{await bounded(client.getStatus(),1000,'COPILOT_REMAINING_POST_STOP_DEADLINE');result.cleanup.postStopRpcRejected=false;}catch{result.cleanup.postStopRpcRejected=true;}}
   if(runtime){let gone=await exactRuntimeGone(runtime);if(!gone.containerRemoved){result.cleanup.forcedOwnedContainer=true;await forceOwnContainer(runtime);gone=await exactRuntimeGone(runtime);}Object.assign(result.cleanup,gone);result.cleanup.runtimeGone=gone.processExited&&gone.containerRemoved;}
   ensure(result.cleanup.runtimeGone===true&&result.cleanup.postStopRpcRejected===true,'COPILOT_REMAINING_OWNED_NATIVE_RELEASE_UNCONFIRMED');})();void cleanupPromise.catch(()=>{});return cleanupPromise;
 }
}
