import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {bounded,ensure,packageRoot,makeRuntime,exactRuntimeGone,forceOwnContainer} from './copilot-runtime.mjs';

const SERVER='v8_interaction_fixture',CHILD='v8-interaction-child';
const ROOT_COMMAND="printf 'V8_COPILOT_PERMISSION_OK\\n'",CHILD_COMMAND="printf 'V8_COPILOT_CHILD_PERMISSION_OK\\n'";
const QUESTION='V8 harmless choice?',ANSWER='fixture-choice',FINAL='V8_COPILOT_INTERACTIONS_OK';
const rootEvent=e=>!e.agentId&&!e.data?.agentId&&!e.data?.parentToolCallId;
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
/** Exact native permission identity differs from its presentation prompt's local tool name. */
export function isOwnedMcpPermission(request,offeredName){return offeredName===`${SERVER}-v8_interaction_form`&&request?.kind==='mcp'&&request.serverName===SERVER&&request.toolName===offeredName&&request.args!==null&&typeof request.args==='object'&&!Array.isArray(request.args)&&Object.keys(request.args).length===0;}
/** SDK objects explicitly own optional undefined fields that native JSON omits. Keep all other fields/constraints. */
export function copilotSdkPayload(method,payload){
 ensure(payload&&typeof payload==='object'&&!Array.isArray(payload),'COPILOT_SDK_PAYLOAD_INVALID');
 const optional=method==='elicitation'?['mode','elicitationSource','url','requestedSchema']:method==='userInput'?['choices','allowFreeform']:method==='exitPlan'?['planContent']:[];
 return Object.fromEntries(Object.entries(payload).filter(([key,value])=>value!==undefined||!optional.includes(key)));
}

/** Root launches this function only under its fresh finite allowance. Importing it never launches native/model work. */
export async function runCopilotInteractions(ctx){
 const recoveryStage=[2,3].includes(ctx.copilotRecoveryStage)?ctx.copilotRecoveryStage:ctx.continuation===true?1:0,continuation=recoveryStage>0,rootOnly=recoveryStage===3;
 ensure(typeof ctx.model==='string'&&ctx.model.length>0,'COPILOT_UNALLOWED_MODEL');for(const p of[ctx.toolRoot,ctx.workspace,ctx.nativeHome,ctx.stateDirectory,ctx.buildRoot])ensure(typeof p==='string'&&isAbsolute(p),'COPILOT_DISPOSABLE_ABSOLUTE_PATH_REQUIRED');
 ensure(resolve(ctx.toolRoot)!==resolve(ctx.nativeHome)&&resolve(ctx.toolRoot)!==resolve(ctx.workspace),'COPILOT_NATIVE_ROOT_OVERLAP');
 const endpoint=new URL(ctx.endpoint);ensure(endpoint.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)&&typeof ctx.key==='string'&&ctx.key,'COPILOT_GUARDED_PROVIDER_REQUIRED');
 const result={harness:'copilot',status:'running',passed:false,continuation,recoveryStage,cases:{},proofs:[],limitations:[],counts:{rootSends:0,childAdmissions:0,childStarts:0,nativeProbes:0,nativeRpcs:0,events:0,nativeBodyReads:0,answers:0,browserAnswers:0},cleanup:{}};
 let client,session,host,owner,runtime,run,emit,interactionA,interactionB,bridgeA,bridgeB,sessionWorkspace,history,scope,liveRun,stopped=false,cleanupPromise;
 let accepting=true,fatal=null,activeProbe=null,stage='startup',mode='interactive',idle=0,rootSendPending=false,childGate=false,childInFlight=false,childUsed=false,callbacks=0,reconnectQualified=false,expectedMcpToolName=null,scenarioGroup=null;
 const pendingResponses=new Set(),tokens=new Map(),permissionCaps=new Map(),children=new Set(),models=new Set(),childModels=new Set(),finals=new Map(),kinds=new Map(),waiters=new Set(),scheduled=new Set(),capTypes=new Map();let childPermissionResponses=0;
 const notify=()=>{for(const fn of [...waiters])fn();};
 const fail=code=>{fatal??=code;notify();};
 const record=(name,value)=>ctx.record(`copilot-interactions-${name}`,value);
 const diagnostic=error=>{let m=String(error?.message??'Native API rejected');for(const p of[ctx.key,ctx.endpoint,ctx.nativeHome,ctx.workspace,ctx.toolRoot,ctx.stateDirectory])if(p)m=m.replaceAll(p,'<private>');return m.replace(/https?:\/\/[^\s"'<>]+/g,'<endpoint>').slice(0,500);};
 const errorShape=error=>{const shape={name:typeof error?.name==='string'?error.name.slice(0,80):'Error',code:typeof error?.code==='number'||typeof error?.code==='string'?error.code:null,message:diagnostic(error)};try{const data=error?.data??error?.cause?.data;if(data!==undefined){const encoded=JSON.stringify(data);if(encoded.length<=16384)shape.data=JSON.parse(encoded);else shape.data={omitted:true,bytes:encoded.length};}}catch{shape.data={unavailable:true};}return shape;};
 const active=()=>ensure(accepting&&!fatal,fatal??'COPILOT_OWNER_RETIRED');
 async function waitFor(predicate,ms,code){await bounded(new Promise((yes,no)=>{const fn=()=>{if(fatal){waiters.delete(fn);no(Error(fatal));}else if(predicate()){waiters.delete(fn);yes();}};waiters.add(fn);fn();}),ms,code);}
 function beginContinuation(name,maximum){ensure(continuation&&!scenarioGroup,'COPILOT_CONTINUATION_GROUP_INVALID');active();ctx.allowance.admit('copilot-native',`copilot:continuation-${name}${recoveryStage>=2?`-${recoveryStage}`:''}`);result.counts.nativeProbes++;scenarioGroup={name,maximum,calls:0};record('continuation-scenario',{name,maximumNativeRpcs:maximum});}
 function endContinuation(){if(!scenarioGroup)return;record('continuation-scenario-complete',{name:scenarioGroup.name,nativeRpcs:scenarioGroup.calls});scenarioGroup=null;}
 function rpcCount(operation){result.counts.nativeRpcs++;record('native-rpc',{operation,scenario:scenarioGroup?.name??null,ordinal:result.counts.nativeRpcs});}
 async function probe(name,work){active();if(scenarioGroup){ensure(scenarioGroup.calls<scenarioGroup.maximum,'COPILOT_CONTINUATION_RPC_BOUND');scenarioGroup.calls++;}else{ctx.allowance.admit('copilot-native',`copilot:${continuation?`continuation-${recoveryStage>=2?`${recoveryStage}-`:''}`:''}${name}`);result.counts.nativeProbes++;}rpcCount(name);return bounded(work(),45000,`COPILOT_${name.toUpperCase()}_DEADLINE`);}
 async function optional(name,work){try{return await work();}catch(error){const method=error?.code===-32601||/\bmethod\b.*\bnot found\b|\bunknown method\b/i.test(String(error?.message??'')),schema=['COPILOT_UNSUPPORTED_REQUIRED_TOOL_ARGUMENT','COPILOT_OFFERED_TOOL_SCHEMA_UNAVAILABLE','COPILOT_TOOL_DID_NOT_REQUEST_INTERACTION'].includes(error?.message);if((method||schema)&&!fatal&&(!owner||owner.current().baseline==='complete')&&pendingResponses.size===0){const reason=method?'NativeMethodUnavailable':'ExactOfferedToolOrInteractionUnavailable';result.cases[name]={status:'unsupported',reason};record('unsupported',{scenario:name,reason});return undefined;}throw error;}}
 function observedOwner(event){const id=event.agentId??event.data?.agentId;if(typeof id==='string'&&id){ensure(children.has(id),'COPILOT_UNPROVED_NATIVE_CHILD');return{nativeAgent:id,relation:'child'};}ensure(!event.data?.parentToolCallId,'COPILOT_UNATTRIBUTED_CHILD_PERMISSION');return{nativeAgent:run.nativeSession,relation:'root'};}
 function callbackOwner(invocation){ensure(invocation?.sessionId===run.nativeSession,'COPILOT_UNPROVED_CALLBACK_SESSION');ensure(!childInFlight,'COPILOT_CALLBACK_CHILD_ATTRIBUTION_UNPROVED');return{nativeAgent:run.nativeSession,relation:'root'};}
 async function loadPriorEvidence(){
  const directory=new URL('../../artifacts/interactions-live-2026-10-23T06-35-21-379Z/',import.meta.url),bytes=await readFile(new URL('result.json',directory)),hash=createHash('sha256').update(bytes).digest('hex'),sums=await readFile(new URL('SHA256SUMS',directory),'utf8');
  ensure(sums.split('\n').some(line=>line.trim()===`${hash}  result.json`),'COPILOT_PRIOR_RECEIPT_CHECKSUM_MISMATCH');const prior=JSON.parse(bytes).harnesses?.copilot;
  ensure(prior?.cases?.permission?.status==='passed'&&prior?.cases?.question?.status==='passed'&&prior?.cleanup?.runtimeGone===true,'COPILOT_PRIOR_CASE_NOT_QUALIFIED');
  for(const name of['permission','question'])result.cases[name]={status:'passed-prior-receipt',receipt:'interactions-live-2026-10-23T06-35-21-379Z',sha256:hash,retested:false};
  record('prior-evidence',{receipt:'interactions-live-2026-10-23T06-35-21-379Z',sha256:hash,cases:['permission','question'],noOldMutationReplayed:true});
 }
 function answerFor(prompt){
  if(prompt.type==='copilot.permission'){
   const request=prompt.request;
   const shellContext=prompt.owner.relation==='child'?childInFlight&&request.fullCommandText?.trim()===CHILD_COMMAND:!continuation&&activeProbe?.name==='permission'&&request.fullCommandText?.trim()===ROOT_COMMAND;
   const shell=shellContext&&request.kind==='shell'&&!request.hasWriteFileRedirection&&!request.requestSandboxBypass&&(!request.possibleUrls||request.possibleUrls.length===0)&&(!request.possiblePaths||request.possiblePaths.length===0)&&(!request.resolvedWorkingDirectory||resolve(request.resolvedWorkingDirectory)===resolve(ctx.workspace));
   const mcp=activeProbe?.name==='elicitation'&&isOwnedMcpPermission(request,expectedMcpToolName);
   if(!shell&&!mcp)record('permission-policy-rejected',{expectedServer:SERVER,exactOfferedToolName:expectedMcpToolName,request});
   ensure(shell||mcp,'COPILOT_UNPLANNED_PERMISSION');if(prompt.owner.relation==='child')ensure(shell&&request.fullCommandText?.trim()===CHILD_COMMAND,'COPILOT_UNPLANNED_CHILD_PERMISSION');
   return{type:prompt.type,kind:'approve-once'};
  }
  if(prompt.type==='copilot.question'){ensure(prompt.question.includes('V8')&&prompt.options.includes(ANSWER),'COPILOT_UNPLANNED_QUESTION');return{type:prompt.type,answer:ANSWER,wasFreeform:false};}
  if(prompt.type==='copilot.elicitation'){
   ensure(prompt.mode==='form'&&prompt.message.includes('V8'),'COPILOT_UNPLANNED_ELICITATION');return{type:prompt.type,action:'accept',content:{choice:ANSWER,count:1,confirmed:true}};
  }
  ensure(prompt.type==='copilot.plan','COPILOT_UNPLANNED_CALLBACK');const action=prompt.actions.find(a=>/interactive|manual|agent/i.test(a)&&!/auto/i.test(a));
  ensure(action,'COPILOT_NO_SAFE_OFFERED_PLAN_ACTION');return{type:prompt.type,approved:true,selectedAction:action,feedback:'Approve only this harmless disposable qualification plan.'};
 }
 async function respond(prompt){
  active();const answer=answerFor(prompt),operationId=`copilot-answer-${++callbacks}`;result.counts.answers++;
  const before=interactionA.entry(scope).getSnapshot().snapshot?.items.length??0;
  const snapshot=await owner.snapshot(scope);ensure(snapshot.items.some(i=>i.prompt.id===prompt.id),'COPILOT_PROMPT_NOT_RETAINED');
  // Both actual clients observe the same opaque capability; only one writes the original answer.
  await waitFor(()=>interactionA.entry(scope).getSnapshot().snapshot?.items.some(i=>i.prompt.id===prompt.id)&&interactionB.entry(scope).getSnapshot().snapshot?.items.some(i=>i.prompt.id===prompt.id),10000,'COPILOT_TWO_VIEWER_PROMPT_DEADLINE');
  if(!reconnectQualified&&bridgeA){
   bridgeA.disconnect();interactionA.setConnected(scope,false);ensure((await owner.snapshot(scope)).items.some(i=>i.prompt.id===prompt.id&&i.state==='pending'),'COPILOT_DISCONNECT_RETIRED_NATIVE_CALLBACK');
   await bridgeA.reconnect();interactionA.setConnected(scope,true);await interactionA.refresh(scope);ensure(interactionA.entry(scope).getSnapshot().snapshot?.items.some(i=>i.prompt.id===prompt.id&&i.state==='pending'),'COPILOT_RECONNECT_CHANGED_CALLBACK');
   reconnectQualified=true;record('pending-viewer-reconnect',{sameOpaqueCapability:true,noNativeReplyOrResume:true});
  }
  let receipt,browserUsed=false;
  if(ctx.respondInBrowser&&bridgeA){receipt=await bounded(ctx.respondInBrowser({bridge:bridgeA,prompt,answer,operationId}),40000,'COPILOT_BROWSER_RESPONSE_DEADLINE');result.counts.browserAnswers++;browserUsed=true;}
  else{await interactionA.refresh(scope);receipt=await interactionA.answer(scope,prompt,answer,operationId).result;result.limitations.push('No root browser responder supplied; this response used the actual retained Node client.');}
  ensure(receipt.id===operationId&&receipt.type==='answer'&&receipt.state==='acknowledged','COPILOT_ORIGINAL_ANSWER_NOT_ACKNOWLEDGED');
  ensure((await host.receipt(scope,operationId))?.state==='acknowledged','COPILOT_DURABLE_ANSWER_MISSING');
  if(prompt.type==='copilot.permission'&&prompt.owner.relation==='child')childPermissionResponses++;
  const peer=interactionB.entry(scope).getSnapshot().snapshot?.items.find(i=>i.prompt.id===prompt.id);
  if(peer){let refused=false;try{await interactionB.answer(scope,prompt,answer,`${operationId}-competing`).result;}catch{refused=true;}ensure(refused||!owner.current().items.some(i=>i.prompt.id===prompt.id&&i.state==='pending'),'COPILOT_DUPLICATE_RESPONSE_NOT_FENCED');}
  record('response',{type:prompt.type,owner:prompt.owner.relation,operationId,receiptState:receipt.state,browser:browserUsed,priorObservedItems:before,nativeRequestIdentity:prompt.nativeRequestId!==null});
 }
 function schedule(prompt){
  if(scheduled.has(prompt.id))return;ensure(scheduled.size<128,'COPILOT_CALLBACK_BOUND');scheduled.add(prompt.id);capTypes.set(prompt.id,prompt.type);activeProbe?.caps.add(prompt.id);const job=respond(prompt).catch(error=>{record('response-error',{type:prompt.type,error:errorShape(error)});fail('COPILOT_RESPONSE_REJECTED');});pendingResponses.add(job);void job.finally(()=>pendingResponses.delete(job));
 }
 function callback(method,payload,invocation){
  record('sdk-callback-ingress',{method,keys:Object.keys(payload??{}),undefinedFields:Object.keys(payload??{}).filter(key=>payload[key]===undefined),sameNativeSession:invocation?.sessionId===run?.nativeSession});
  try{active();ensure(owner&&interactionA,'COPILOT_CALLBACK_BEFORE_OWNER_READY');const delivery=deferred(),token={};
   const prompt=owner.registerCopilot({token,requestId:null,owner:callbackOwner(invocation),method,payload:copilotSdkPayload(method,payload),respond:async value=>{delivery.resolve(value);return{kind:'submitted'};}});schedule(prompt);return delivery.promise;
  }catch(error){record('sdk-callback-failure',{method,error:errorShape(error),nativeSdkMayCancelAfterThrow:true});fail('COPILOT_SDK_CALLBACK_REJECTED');throw error;}
 }
 function onEvent(event){
  if(!accepting)return;try{
   ensure(result.counts.events<4096,'COPILOT_EVENT_BOUND');result.counts.events++;kinds.set(event.type,(kinds.get(event.type)??0)+1);
   if(['permission.requested','permission.completed','user_input.requested','user_input.completed','elicitation.requested','elicitation.completed','exit_plan_mode.requested','exit_plan_mode.completed','subagent.started','subagent.completed','assistant.usage','session.idle'].includes(event.type))record('native-event',event);
   if(event.type==='subagent.started'){
    result.counts.childStarts++;ensure(childUsed&&event.data?.agentName===CHILD&&result.counts.childStarts===1,'COPILOT_UNEXPECTED_CHILD');const id=event.agentId??event.data?.agentId;ensure(typeof id==='string'&&id,'COPILOT_CHILD_ID_UNOBSERVED');children.add(id);
   }
   if(event.type==='subagent.completed'){const id=event.agentId??event.data?.agentId;ensure(typeof id==='string'&&children.has(id)&&event.data?.agentName===CHILD,'COPILOT_UNPROVED_CHILD_COMPLETION');childInFlight=false;childGate=false;}
   const actualModel=event.type==='subagent.completed'?event.data?.firstDispatchedModel:event.type==='assistant.usage'?event.data?.model:undefined;
   if(typeof actualModel==='string'){models.add(actualModel);if(event.type==='subagent.completed'||!rootEvent(event))childModels.add(actualModel);ensure(actualModel===ctx.model,'COPILOT_ACTUAL_MODEL_MISMATCH');}
   if(event.type==='assistant.message'&&rootEvent(event))finals.set(event.data.originatingMessageId,event.data.content);
   if(event.type==='session.idle'&&rootEvent(event)){idle++;emit?.({run,type:'activity',activity:'idle'});}
   if(event.type==='assistant.turn_start'&&rootEvent(event))emit?.({run,type:'activity',activity:'working'});
   if(event.type==='permission.requested'){
    const data=event.data;ensure(typeof data?.requestId==='string'&&data.permissionRequest,'COPILOT_PERMISSION_IDENTITY_MISSING');if(data.resolvedByHook)return;
    ensure(owner&&interactionA,'COPILOT_PERMISSION_BEFORE_OWNER_READY');const key=JSON.stringify([event.agentId??data.agentId??null,data.requestId]),old=permissionCaps.get(key);if(old&&owner.current().items.some(i=>i.prompt.id===old))return;let token=tokens.get(event.id);if(!token){token={};tokens.set(event.id,token);}
    const prompt=owner.registerCopilot({token,requestId:data.requestId,owner:observedOwner(event),method:'permission',payload:data.permissionRequest,respond:async value=>{
     rpcCount('permission-native-reply');const response=await session.rpc.permissions.handlePendingPermissionRequest({requestId:data.requestId,result:value});ensure(typeof response?.success==='boolean','COPILOT_PERMISSION_ACK_SHAPE');return{kind:'ack',success:response.success};
    }});permissionCaps.set(key,prompt.id);schedule(prompt);
   }
   if(event.type==='permission.completed'){
    const key=JSON.stringify([event.agentId??event.data?.agentId??null,event.data?.requestId]),id=permissionCaps.get(key);if(id){owner.completed(id,run);permissionCaps.delete(key);}
   }
   if(event.type==='session.error')fail('COPILOT_NATIVE_SESSION_ERROR');
  }catch(error){record('ingress-error',{stage,error:errorShape(error)});fail(error.message?.startsWith('COPILOT_')?error.message:'COPILOT_NATIVE_INGRESS_REJECTED');}notify();
 }
 async function serialTool(name,tool,args,expectedType){
  const context={name,caps:new Set()};activeProbe=context;const before=callbacks;
  try{const outcome=await probe(name,()=>session.rpc.tools.execute({name:tool.name,arguments:args,toolCallId:`v8-${name}-${randomUUID()}`}));
   record('tool-result',{scenario:name,tool:tool.name,result:outcome});
   await bounded(Promise.all([...pendingResponses]),45000,'COPILOT_TOOL_RESPONSE_JOURNAL_DEADLINE');active();
   ensure(callbacks>before&&[...context.caps].some(id=>capTypes.get(id)===expectedType),'COPILOT_TOOL_DID_NOT_REQUEST_INTERACTION');
   // Exact serial native invocation returned after its actual callback. This is stronger than idle/history.
   for(const id of context.caps)owner.completed(id,run);
   result.cases[name]={status:'passed',callbackType:expectedType,exactNativeToolReturned:true,originalReceipts:true};return outcome;
  }finally{activeProbe=null;}
 }
 function argumentsFor(tool,values){const schema=tool?.input_schema;ensure(schema&&schema.type==='object'&&schema.properties,'COPILOT_OFFERED_TOOL_SCHEMA_UNAVAILABLE');const out={};for(const[name,value]of Object.entries(values))if(Object.hasOwn(schema.properties,name))out[name]=value;ensure((schema.required??[]).every(name=>Object.hasOwn(out,name)),'COPILOT_UNSUPPORTED_REQUIRED_TOOL_ARGUMENT');return out;}
 try{
  const core=ctx.core??{},SessionHost=core.SessionHost??(await import(pathToFileURL(join(ctx.buildRoot,'primitives/v8-lifecycle-default/src/session/index.js')).href)).SessionHost;
  const iw=await import(pathToFileURL(join(ctx.buildRoot,'primitives/v8-interactions/src/index.js')).href),sw=await import(pathToFileURL(join(ctx.buildRoot,'primitives/v8-session/src/client/index.js')).href),hw=await import(pathToFileURL(join(ctx.buildRoot,'primitives/v8-history/src/client/index.js')).href);
  const fromApp=createRequire(join(ctx.toolRoot,'package.json')),sdk=await packageRoot(fromApp.resolve('@github/copilot-sdk'),'@github/copilot-sdk'),cli=fromApp.resolve('@github/copilot-linux-x64'),platform=await packageRoot(cli,'@github/copilot-linux-x64');
  ensure(sdk.metadata.version==='1.0.19'&&sdk.metadata.copilotCliVersion==='1.0.95'&&platform.metadata.version==='1.0.95','COPILOT_PIN_MISMATCH');ensure(process.platform==='linux'&&process.arch==='x64','COPILOT_UNQUALIFIED_PLATFORM');
  runtime=await makeRuntime(cli,ctx);ctx.registerNativeCleanup?.(cleanupNative);const fixture=join(ctx.workspace,'copilot-mcp-fixture.mjs');await writeFile(fixture,await readFile(new URL('./copilot-mcp.mjs',import.meta.url)),{mode:0o600,flag:'wx'});
  const {CopilotClient,RuntimeConnection}=await import(pathToFileURL(join(sdk.directory,'dist/index.js')).href);const sessionId=randomUUID();scope={connection:'v8-interactions-live',principal:'finite-owner',host:'disposable-copilot',session:`logical-${sessionId}`};
  const env={PATH:process.env.PATH??'/run/current-system/sw/bin',LANG:'C.UTF-8',HOME:ctx.nativeHome,COPILOT_HOME:ctx.nativeHome,TMPDIR:join(ctx.nativeHome,'tmp'),XDG_CONFIG_HOME:join(ctx.nativeHome,'xdg-config'),XDG_CACHE_HOME:join(ctx.nativeHome,'xdg-cache'),XDG_DATA_HOME:join(ctx.nativeHome,'xdg-data'),NODE_NO_WARNINGS:'1'};
  client=new CopilotClient({mode:'copilot-cli',connection:RuntimeConnection.forStdio({path:runtime.filename,env}),workingDirectory:ctx.workspace,baseDirectory:ctx.nativeHome,useLoggedInUser:false,logLevel:'none'});
  const port={kind:'copilot',placement:'dedicated',capabilities:{commands:['send','answer'],fullStop:true,openAndWait:true},catalog:async()=>({available:true,choices:[{model:ctx.model,efforts:[]}]}),inspect:async()=>liveRun??null,start:async(input,emitNative)=>{
   ensure(input.nativeSession===null&&!input.continuePendingWork,'COPILOT_NO_RESUME_IN_LIVE_LANE');run={scope,generation:input.generation,nativeSession:sessionId};emit=emitNative;owner=new iw.InteractionOwner({run,kind:'copilot',epoch:1});
   session=await probe('create',()=>client.createSession({sessionId,model:ctx.model,allowedModels:[ctx.model],provider:{type:'openai',wireApi:'responses',transport:'http',baseUrl:ctx.endpoint,apiKey:ctx.key,modelId:ctx.model,wireModel:ctx.model},workingDirectory:ctx.workspace,configDirectory:ctx.nativeHome,streaming:true,includeSubAgentStreamingEvents:true,onEvent,onPermissionRequest:()=>({kind:'no-result'}),onUserInputRequest:(request,invocation)=>callback('userInput',request,invocation),onElicitationRequest:context=>callback('elicitation',context,{sessionId:context.sessionId}),onExitPlanModeRequest:(request,invocation)=>callback('exitPlan',request,invocation),onAutoModeSwitchRequest:()=>{fail('COPILOT_UNEXPECTED_AUTOSWITCH');return'no';},onMcpAuthRequest:()=>{fail('COPILOT_UNEXPECTED_OAUTH');return{kind:'cancelled'};},mcpServers:{[SERVER]:{type:'stdio',command:'/usr/local/bin/node',args:[fixture],tools:['v8_interaction_form'],workingDirectory:ctx.workspace,timeout:90000}},customAgentsLocalOnly:true,customAgents:[{name:CHILD,displayName:'Finite V8 interaction child',description:'One exact harmless permission fixture',model:ctx.model,prompt:`Run only this exact shell command once: ${CHILD_COMMAND}. Do not use other tools, files, networks or delegate. Then reply exactly V8_COPILOT_CHILD_OK.`}],hooks:{onPreToolUse(input){if(input.toolName==='task'){if(!childGate||childUsed||input.toolArgs?.agent_type!==CHILD){fail('COPILOT_UNALLOWED_CHILD');return{permissionDecision:'deny',permissionDecisionReason:'Only one named finite child is allowed.'};}ctx.allowance.admit('copilot-child','copilot:one-native-child');childUsed=true;childInFlight=true;result.counts.childAdmissions++;}else if(!['bash','shell','ask_user','exit_plan_mode'].includes(input.toolName)&&input.toolName!==expectedMcpToolName){fail('COPILOT_UNPLANNED_TOOL');return{permissionDecision:'deny',permissionDecisionReason:'Finite fixture tool boundary.'};}}}}));
   owner.certifyBaseline({run,complete:true,continuous:true});const native={run,selection:{kind:'copilot',model:ctx.model,permissions:'manual',mode:'interactive'},interactionsComplete:true,interactions:[],stop:async()=>{await cleanupNative();ensure(result.cleanup.runtimeGone===true,'COPILOT_NATIVE_TREE_NOT_PROVED');stopped=true;return{run,state:'stopped',scope:'nativeTree',noAutomaticContinuation:true};},invoke:async command=>{ensure(command.type==='send','COPILOT_UNEXPECTED_CONTROL');ensure(rootSendPending,'COPILOT_UNADMITTED_ROOT_SEND');rootSendPending=false;rpcCount('model-send');const id=await session.send({prompt:command.text});ensure(typeof id==='string'&&id,'COPILOT_SEND_ID_MISSING');return{status:'accepted',detail:{nativeMessageId:id}};}};liveRun=owner.wrap({run:native,emit:emitNative});return liveRun;
  }};
  await mkdir(ctx.stateDirectory,{recursive:true,mode:0o700});host=await SessionHost.open({directory:join(ctx.stateDirectory,'session'),scope,port,policy:{kind:'copilot',provider:'copilot-only',permissions:'manual'},observationMs:60000});
  if(continuation)beginContinuation('fresh-bootstrap',6);
  ensure((await host.submit({scope,id:'create',generation:0,command:{type:'create'}})).state==='acknowledged','COPILOT_CREATE_NOT_ACKNOWLEDGED');
  if(ctx.openViewerBridge){bridgeA=await ctx.openViewerBridge({scope,sessionPort:host,interactionPort:owner});bridgeB=await ctx.openViewerBridge({scope,sessionPort:host,interactionPort:owner});}
  interactionA=new iw.InteractionWorkspace({port:bridgeA?.interactionPort??owner,session:bridgeA?.sessionPort??host});interactionB=new iw.InteractionWorkspace({port:bridgeB?.interactionPort??owner,session:bridgeB?.sessionPort??host});await Promise.all([interactionA.bind(scope),interactionB.bind(scope)]);interactionA.entry(scope).subscribe(notify);interactionB.entry(scope).subscribe(notify);
  history=new hw.HistoryWorkspace({connection:scope.connection,principal:scope.principal});sessionWorkspace=new sw.SessionWorkspace({history,port:bridgeA?.sessionPort??host});await sessionWorkspace.bind(scope,{kind:'copilot',agentId:null,origin:{connection:scope.connection,principal:scope.principal,host:scope.host,nativeSession:sessionId,attachment:'1'}});
  stage='native-probes';ctx.progress('Copilot: actual owned permission/question/MCP/plan probes through native tool pipeline and durable typed clients.');
  const selected=await optional('modelMetadata',()=>probe('model',()=>session.rpc.model.getCurrent()));if(selected)ensure(selected.modelId===ctx.model,'COPILOT_SELECTED_MODEL_NOT_EXACT');
  const policy=await optional('permissionPolicy',()=>probe('manual-permissions',()=>session.rpc.permissions.setMode({mode:'manual'})));if(policy)ensure(policy.success===true&&policy.mode==='manual','COPILOT_PERMISSION_MODE_NOT_MANUAL');
  const required=await optional('permissionEvents',()=>probe('permission-events',()=>session.rpc.permissions.setRequired({required:true})));if(required)ensure(required.success===true,'COPILOT_PERMISSION_EVENT_BRIDGE_UNAVAILABLE');
  await optional('toolInitialization',()=>probe('tools-initialize',()=>session.rpc.tools.initializeAndValidate()));const metadata=await optional('toolMetadata',()=>probe('tools-metadata',()=>session.rpc.tools.getCurrentMetadata()));if(metadata)ensure(Array.isArray(metadata.tools),'COPILOT_TOOL_METADATA_MISSING');
  const tools=metadata?.tools??[],shell=tools.find(t=>t.name==='bash'||t.name==='shell'),ask=tools.find(t=>t.name==='ask_user'),mcp=tools.find(t=>t.name===`${SERVER}-v8_interaction_form`);let exit=tools.find(t=>t.name==='exit_plan_mode');const task=tools.find(t=>t.name==='task');
  expectedMcpToolName=mcp?.name??null;if(continuation)endContinuation();
  record('offered-tools',{tools:tools.filter(t=>[shell,ask,mcp,exit,task].includes(t)).map(t=>({name:t.name,input_schema:t.input_schema}))});
  if(continuation){await loadPriorEvidence();}
  else if(shell&&policy&&required)await optional('permission',async()=>{const value=await serialTool('permission',shell,argumentsFor(shell,{command:ROOT_COMMAND,description:'One harmless V8 permission marker',timeout:10000}),'copilot.permission');ensure(JSON.stringify(value).includes('V8_COPILOT_PERMISSION_OK'),'COPILOT_PERMISSION_NATIVE_EFFECT_NOT_OBSERVED');});else result.cases.permission={status:'unsupported',reason:'NativeShellOrExactPermissionPolicyUnavailable'};
  if(!continuation&&ask)await optional('question',async()=>{const value=await serialTool('question',ask,argumentsFor(ask,{question:QUESTION,choices:[ANSWER],allowFreeform:false,allow_freeform:false}),'copilot.question');ensure(JSON.stringify(value).includes(ANSWER),'COPILOT_QUESTION_NATIVE_RESPONSE_NOT_RETURNED');});else if(!continuation)result.cases.question={status:'unsupported',reason:'NativeAskUserNotOffered'};
  if(!rootOnly){
  if(recoveryStage===2)beginContinuation('remaining-flows',6);
  if(mcp)await optional('elicitation',async()=>{const value=await serialTool('elicitation',mcp,argumentsFor(mcp,{}),'copilot.elicitation');ensure(JSON.stringify(value).includes('V8_COPILOT_FORM_OK'),'COPILOT_MCP_NATIVE_RESPONSE_NOT_RETURNED');});else result.cases.elicitation={status:'unsupported',reason:'OwnedMcpToolNotOffered'};
  if(typeof session.rpc.mode?.set==='function'&&typeof session.rpc.plan?.update==='function'){
   if(continuation&&recoveryStage!==2)beginContinuation('plan-flow',5);
   await optional('plan',async()=>{const changed=await probe('plan-mode',()=>session.rpc.mode.set({mode:'plan',planModelConfigured:false}));record('plan-mode-result',changed);ensure(changed?.modeApplied!==false&&!changed?.deferImplementation&&!changed?.confirmation&&!changed?.modelChanged,'COPILOT_PLAN_MODE_NOT_SAFELY_APPLIED');mode='plan';
    const planMetadata=await probe('plan-tools-metadata',()=>session.rpc.tools.getCurrentMetadata());exit=planMetadata.tools?.find(t=>t.name==='exit_plan_mode');record('offered-plan-tool',exit?{name:exit.name,input_schema:exit.input_schema}:{unavailable:true});
    if(exit){await probe('plan-content',()=>session.rpc.plan.update({content:'# Harmless V8 plan\nReview this disposable confirmation. Do not modify files, install, authenticate, or access networks.'}));await serialTool('plan',exit,argumentsFor(exit,{summary:'V8 harmless plan review',plan:'Harmless synthetic fixture plan'}),'copilot.plan');}
    else result.cases.plan={status:'unsupported',reason:'NativeExitPlanNotOfferedInPlanMode'};
   });
   if(mode==='plan'){const restored=await probe('interactive-restore',()=>session.rpc.mode.set({mode:'interactive',restorePlanModel:false}));record('interactive-restore-result',restored);ensure(restored?.modeApplied!==false&&!restored?.deferImplementation&&!restored?.confirmation&&!restored?.modelChanged,'COPILOT_INTERACTIVE_RESTORE_NOT_SAFELY_APPLIED');mode='interactive';}
   if(continuation&&recoveryStage!==2)endContinuation();
  }else result.cases.plan={status:'unsupported',reason:'NativePlanControlUnavailable'};
  if(recoveryStage===2)endContinuation();
  }else{result.cases.elicitation={status:'not-retested',reason:'ObservedInPriorDiagnostic'};result.cases.plan={status:'not-retested',reason:'ExitPlanNotOfferedInPriorDiagnostic'};}
  stage='model';active();ensure(mode==='interactive','COPILOT_MODEL_PHASE_NOT_INTERACTIVE');
  const childReady=!rootOnly&&!ctx.skipChild&&policy&&required&&task?.input_schema?.properties?.agent_type&&result.counts.childAdmissions===0;childGate=!!childReady;
  const childInstruction=childReady?`First invoke exactly one task with agent_type ${CHILD}. It is fixed to ${ctx.model}. Wait for its harmless single-command reply; never retry or launch another child. Then `:'Do not delegate. ';
  ctx.allowance.admit('copilot-root',`copilot:${continuation?`continuation-${recoveryStage>=2?`${recoveryStage}-`:''}`:''}model-question-and-child`);result.counts.rootSends++;rootSendPending=true;const beforeIdle=idle;
  const original=sessionWorkspace.request(scope,{type:'send',text:`Finite owned qualification. ${childInstruction}Use ask_user exactly once with question ${JSON.stringify(QUESTION)} and choices [${JSON.stringify(ANSWER)}], freeform disabled. Do not use any other tool or perform other work. Once answered, reply exactly ${FINAL}.`},'copilot-model-original');
  const receipt=await bounded(original.result,30000,'COPILOT_MODEL_SEND_DEADLINE');ensure(receipt.state==='acknowledged'&&receipt.outcome?.detail?.nativeMessageId,'COPILOT_MODEL_ORIGINAL_NOT_ACCEPTED');const messageId=receipt.outcome.detail.nativeMessageId;
  await waitFor(()=>idle>beforeIdle&&finals.get(messageId)===FINAL,90000,'COPILOT_MODEL_FINAL_DEADLINE');await bounded(Promise.all([...pendingResponses]),45000,'COPILOT_MODEL_RESPONSE_RECEIPT_DEADLINE');
  result.cases.model={status:'passed',exactOriginal:true,model:ctx.model,finalObserved:true};
  result.cases.child=childReady?{status:children.size===1&&result.counts.childAdmissions===1&&result.counts.childStarts===1&&childPermissionResponses===1&&childModels.has(ctx.model)?'passed':'unqualified',provedChildren:children.size,exactChildPermissionResponses:childPermissionResponses,actualChildModelObserved:childModels.has(ctx.model)}:{status:'not-run',reason:'ExactChildTaskContractUnavailableOrSkipped'};
  ensure(models.size>0&&[...models].every(model=>model===ctx.model),'COPILOT_ACTUAL_MODEL_UNOBSERVED');
  result.proofs.push('Actual pinned SDK1.0.19/CLI1.0.95; exact explicitly selected model via guarded provider only','Real native callbacks traversed InteractionOwner, existing worker-SQLite Host receipts, two retained viewers and browser response helper where supplied','No native history-body read, native callback injection, automatic mutation resend or existing-session operation');
  result.cases.oauth={status:'not-qualified',reason:'No auth failure or real credential flow induced; unexpected OAuth cancels owned request and fails lane'};
  result.cases.autoModeSwitch={status:'not-qualified',reason:'No rate-limit, fallback or persistent cost/model policy induced; unexpected request answered no and fails lane'};
  result.cases.installation={status:'not-qualified',reason:'No package/install confirmation induced; no installation side effects authorized'};
  result.limitations.push('SDK callback-only userInput/elicitation/plan delivery is submitted, not native acknowledgement; serial native tool return can prove that exact invocation consumed its response. Model callbacks lacking an exact completion join remain responseSubmitted/partial.','Child callbacks without real native owner provenance are not attributed by selected UI, text, idle or assumption.','This is a finite owned native subset, not production activation or the unresolved p2prpc cross-viewer defect.');
  result.passed=(rootOnly?['model']:['permission','question','elicitation','plan','model']).every(name=>['passed','passed-prior-receipt'].includes(result.cases[name]?.status));result.status=result.passed?(rootOnly?'passed-native-root-subset':'passed-native-subset'):'partial-native-subset';
 }catch(error){result.passed=false;result.status='failed-native-diagnostic';result.reason=fatal??diagnostic(error);record('failure',{stage,reason:result.reason,error:errorShape(error)});}
 finally{
  accepting=false;childGate=false;interactionA?.close();interactionB?.close();sessionWorkspace?.close();await bridgeA?.close().catch(()=>{});await bridgeB?.close().catch(()=>{});
  try{await cleanupNative();}catch(error){record('cleanup-error',{error:diagnostic(error)});result.passed=false;result.status='failed-native-diagnostic';}
  owner?.retire();if(host)await host.terminate();waiters.clear();record('cleanup',result.cleanup);ctx.progress('Copilot: finite interaction lane finished and exact owned runtime cleanup checked.');
 }
 return result;
 function cleanupNative(){
  if(cleanupPromise)return cleanupPromise;accepting=false;cleanupPromise=(async()=>{if(session){try{await bounded(session.disconnect(),8000,'COPILOT_DISCONNECT_DEADLINE');result.cleanup.sessionDisconnected=true;}catch{result.cleanup.sessionDisconnected=false;}}
  if(client){try{const errors=await bounded(client.stop(),15000,'COPILOT_STOP_DEADLINE');result.cleanup.sdkStopAcknowledged=Array.isArray(errors)&&errors.length===0;}catch{result.cleanup.sdkStopAcknowledged=false;try{await bounded(client.forceStop(),5000,'COPILOT_FORCESTOP_DEADLINE');}catch{}}try{await bounded(client.getStatus(),1000,'COPILOT_POST_STOP_STATUS_DEADLINE');result.cleanup.postStopRpcRejected=false;}catch{result.cleanup.postStopRpcRejected=true;}}
  if(runtime){let gone=await exactRuntimeGone(runtime);if(!gone.containerRemoved){result.cleanup.forcedOwnedContainer=true;await forceOwnContainer(runtime);gone=await exactRuntimeGone(runtime);}Object.assign(result.cleanup,gone);result.cleanup.runtimeGone=gone.processExited&&gone.containerRemoved;}
  ensure(result.cleanup.runtimeGone===true&&result.cleanup.postStopRpcRejected===true,'COPILOT_OWNED_RUNTIME_RELEASE_UNCONFIRMED');stopped=true;})();void cleanupPromise.catch(()=>{});return cleanupPromise;
 }
}
