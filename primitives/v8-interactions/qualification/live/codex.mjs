import assert from 'node:assert/strict';
import {appendFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,dirname,isAbsolute,resolve,relative} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {CodexInteractionRpc} from './codex-rpc.mjs';
import {until} from '../../../v8-history/qualification/live/support.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const METHODS=new Set(['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/requestUserInput','mcpServer/elicitation/request']);
const DEFAULT_ACCESS={approval:'on-request',sandbox:'danger-full-access'};
const asKey=(thread,id)=>JSON.stringify([thread,typeof id,id]);

/** Root-runner-only finite live implementation. Importing this file never starts native/model work. */
export async function runCodexInteractions(ctx){
  assert.ok(typeof ctx.model==='string'&&ctx.model.length>0,'EXPLICIT_ALLOWED_MODEL_REQUIRED');assert.ok(isAbsolute(ctx.nativeHome)&&isAbsolute(ctx.workspace)&&isAbsolute(ctx.stateDirectory));
  const {SessionHost,InteractionOwner,InteractionWorkspace}=ctx.core;assert.ok(SessionHost&&InteractionOwner&&InteractionWorkspace);
  const require=createRequire(join(ctx.toolRoot,'package.json'));
  const binary=join(require.resolve('@openai/codex-linux-x64/package.json'),'../vendor/x86_64-unknown-linux-musl/bin/codex');
  const configFile=join(ctx.nativeHome,'config.toml'),config=await readFile(configFile,'utf8');assert.ok(config.includes(`model_provider = ${JSON.stringify(ctx.provider)}`)&&!config.includes('[mcp_servers.v8_interaction_fixture]'));
  await appendFile(configFile,`\n[mcp_servers.v8_interaction_fixture]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(join(here,'codex-mcp.mjs'))}]\nstartup_timeout_sec = 20\ntool_timeout_sec = 120\n`,{mode:0o600});
  const journalDirectory=join(ctx.stateDirectory,'codex-interaction-journal');await mkdir(journalDirectory,{recursive:true,mode:0o700});
  const outsideDirectory=join(ctx.stateDirectory,'codex-explicit-permission-target');await mkdir(outsideDirectory,{recursive:true,mode:0o700});
  const outsideFile=join(outsideDirectory,'fixture.txt');await writeFile(outsideFile,'V8_OWNED_PERMISSION_TARGET\n',{mode:0o600,flag:'wx'});
  const scope={connection:'v8-live',principal:'finite-owner',host:'codex-disposable',session:'interaction-root'};
  const ownedPath=path=>typeof path==='string'&&isAbsolute(path)&&[ctx.workspace,outsideDirectory].some(base=>{const r=relative(resolve(base),resolve(path));return r===''||(!r.startsWith('..')&&!isAbsolute(r));});
  let rpc,host,owner,run,rootThread,stage='boot',fatal,caughtError,closing=false,answers=0,rootTurns=0,providerSelected=false,browserResponses=0,lostReplies=0;
  let nativeEmit;const children=new Set(),completedTurns=new Map(),capabilities=new Map(),resolvedRequests=new Set(),childRequests=[],answerTasks=new Set(),bridges=[],viewers=[],plans=new Map();
  const observations=[],turnResults=[],nativeReplies=[],prompts=[],nativeProbeResults=[],nativeToolResults=[];let responseDispatches=0,lateDuplicateRefusals=0,readReconnects=0,zeroViewerCapture=false,dropNextViewerReply=true;
  const fail=error=>{fatal??=error;rpc?.rejectObservation(error);};
  const safeRecord=(kind,value)=>ctx.record?.(`codex-interaction-${kind}`,value);
  function settle(message){const {threadId,requestId}=message.params??{},key=asKey(threadId,requestId);resolvedRequests.add(key);rpc.resolved(requestId);const held=capabilities.get(key);if(held){owner.completed(held.prompt.id,run);held.nativeResolved=true;}}
  function observe(message){try{
    if(observations.length>=4096)throw Error('CODEX_INTERACTION_NOTIFICATION_BOUND');observations.push({method:message.method,threadId:message.params?.threadId??null});
    const p=message.params??{};
    if(message.method==='serverRequest/resolved'){settle(message);return;}
    if(message.method==='turn/completed'){completedTurns.set(asKey(p.threadId,p.turn?.id),p.turn?.status);if(p.threadId===rootThread)nativeEmit?.({run,type:'activity',activity:'idle'});}
    if(message.method==='turn/started'&&p.threadId===rootThread)nativeEmit?.({run,type:'activity',activity:'working'});
    if(message.method==='item/started'||message.method==='item/completed'){
      const item=p.item;if(item?.type==='subAgentActivity'&&item.kind==='started'&&p.threadId===rootThread){assert.ok(stage==='child','UNEXPECTED_NATIVE_CHILD');assert.ok(typeof item.agentThreadId==='string');children.add(item.agentThreadId);assert.ok(children.size<=1,'CHILD_BUDGET_EXCEEDED');safeRecord('child-proof',{source:message.method,kind:item.type,relation:'child'});for(let i=childRequests.length-1;i>=0;i--)if(childRequests[i].params.threadId===item.agentThreadId)admitActualRequest(childRequests.splice(i,1)[0]);}
      if(message.method==='item/completed'&&item?.type==='commandExecution'){nativeToolResults.push({stage,relation:p.threadId===rootThread?'root':children.has(p.threadId)?'child':'unproved',type:item.type,status:item.status??null,exitCode:item.exitCode??null,baselineBytesExact:item.aggregatedOutput==='V8_LIVE_CDX_BASELINE\n',childBytesExact:item.aggregatedOutput==='V8_LIVE_CDX_CHILD_APPROVAL\n'});}
    }
  }catch(error){fail(error);}}
  function receiveRequest(message){try{
    assert.ok(METHODS.has(message.method),'UNSUPPORTED_REAL_CODEX_REVERSE_REQUEST');assert.ok(message.params&&typeof message.params.threadId==='string','UNATTRIBUTED_NATIVE_CALLBACK');
    if(message.params.threadId!==rootThread&&!children.has(message.params.threadId)){assert.ok(stage==='child'&&childRequests.length<8,'UNPROVED_NATIVE_CALLBACK_OWNER');childRequests.push(message);return;}
    admitActualRequest(message);
  }catch(error){fail(error);}}
  function admitActualRequest(message){
    assert.ok(owner&&run,'CALLBACK_BEFORE_NATIVE_OWNER');const threadId=message.params.threadId,key=asKey(threadId,message.id),relation=threadId===rootThread?'root':'child';
    const detailBytes=Buffer.byteLength(JSON.stringify(message.params));safeRecord('prompt-native-ingress',{method:message.method,relation,stage,detailBytes,...(detailBytes<=65536?{detail:message.params}:{detailOmitted:true})});assert.ok(detailBytes<=65536,'PROMPT_DIAGNOSTIC_BOUND');
    const prompt=owner.registerCodex({token:{},requestId:JSON.stringify(message.id),owner:{nativeAgent:threadId,relation},method:message.method,params:message.params,respond:async value=>{responseDispatches++;safeRecord('response-dispatch',{method:message.method,relation});return rpc.respond(message.id,value);}});
    const held={prompt,method:message.method,relation,nativeResolved:resolvedRequests.has(key),stage};capabilities.set(key,held);prompts.push({type:prompt.type,relation,stage});safeRecord('prompt',{method:message.method,type:prompt.type,relation,stage});
    if(held.nativeResolved)owner.completed(prompt.id,run);
    assert.ok(answerTasks.size<8,'INTERACTION_RESPONSE_WORK_BOUND');let task;task=answerActual(held).catch(fail).finally(()=>answerTasks.delete(task));answerTasks.add(task);
  }
  function answerFor(prompt){
    if(prompt.type==='codex.command'){
      const command=prompt.detail?.command;assert.ok(typeof command==='string','UNEXPECTED_COMMAND_CONFIRMATION');const rawSafe=/^printf\s+(['"])V8_LIVE_CDX_(?:BASELINE|APPROVAL|CHILD_APPROVAL)(?:\\n)?\1$/u.test(command.trim());assert.ok(rawSafe||(ctx.allowedCodexCommandDisplays??[]).includes(command),'COMMAND_OUTSIDE_HARMLESS_FIXTURE');
      const decision=prompt.decisions.find(d=>d.decision==='accept');assert.ok(decision,'NATIVE_ACCEPT_NOT_OFFERED');return{type:prompt.type,decisionId:decision.id};
    }
    if(prompt.type==='codex.file'){const decision=prompt.decisions.find(d=>d.decision==='decline');assert.ok(decision);return{type:prompt.type,decisionId:decision.id};}
    if(prompt.type==='codex.permission'){
      const p=prompt.requested,networkSafe=p.network===null||p.network===undefined||p.network.enabled===false||p.network.enabled===null;
      const file=p.fileSystem,paths=file?[...(file.read??[])]:[];assert.ok(networkSafe&&(file?.write??[]).length===0&&paths.every(path=>ownedPath(path)&&resolve(path)===resolve(outsideFile)),'PERMISSION_REQUEST_OUTSIDE_OWNED_FIXTURE');return{type:prompt.type,grant:'turn'};
    }
    if(prompt.type==='codex.question'){assert.ok(prompt.questions.every(q=>q.question.includes('V8_LIVE_CDX_')||q.header.includes('Fixture')),'UNEXPECTED_NATIVE_QUESTION');return{type:prompt.type,answers:Object.fromEntries(prompt.questions.map(q=>{assert.ok(q.options.length>0);return[q.id,[q.options[0]]];}))};}
    assert.equal(prompt.type,'codex.elicitation');assert.ok(prompt.message.startsWith('V8 live '),'UNEXPECTED_MCP_ELICITATION');assert.ok(prompt.mode==='form'||prompt.mode==='url','UNSUPPORTED_REAL_MCP_SCHEMA');return prompt.mode==='form'?{type:prompt.type,action:'accept',content:{choice:'accept-fixture',count:1}}:{type:prompt.type,action:'accept'};
  }
  async function answerActual(held){
    await until(()=>{if(fatal)throw fatal;return viewers.length===2;},'Codex response viewers installed',30_000);
    await until(asyncReady(held.prompt.id),'Codex Host receives exact native callback',30_000);
    const answer=answerFor(held.prompt),id=`codex-answer-${++answers}`;let observed,usedBrowser=false;
    if(!zeroViewerCapture){
      await Promise.all(bridges.map(bridge=>bridge.disconnect()));for(const viewer of viewers)viewer.setConnected(scope,false);
      assert.ok(owner.current().items.some(item=>item.prompt.id===held.prompt.id));zeroViewerCapture=true;
      await Promise.all(bridges.map(bridge=>bridge.reconnect()));for(const viewer of viewers){viewer.setConnected(scope,true);await viewer.refresh(scope);}readReconnects++;
    }
    if(ctx.respondInBrowser&&browserResponses===0){observed=await ctx.respondInBrowser({bridge:bridges[0],prompt:held.prompt,answer,operationId:id});browserResponses++;usedBrowser=true;}
    else {
      const before=responseDispatches;const first=viewers[0].answer(scope,held.prompt,answer,id);let second;
      // Compete only while the second observed view still owns the exact prompt; no stale replacement is created.
      try{second=viewers[1].answer(scope,held.prompt,answer,`${id}-competing`).result;}catch{}
      try{observed=await first.result;}catch(error){if(lostReplies===0)throw error;observed=await viewers[0].checkReceipt(scope,id);assert.equal(observed?.state,'acknowledged','LOST_REPLY_ORIGINAL_RECEIPT_NOT_OBSERVED');}
      if(second){const competing=await second;assert.ok(competing.state==='refused'||competing.outcome?.status==='refused');lateDuplicateRefusals++;}
      assert.equal(responseDispatches,before+1,'NATIVE_RESPONSE_INVOKED_TWICE');
    }
    // The Host strips all native answer detail for privacy. Acknowledgement is not agent completion.
    assert.ok(['acknowledged','outcomeUnknown'].includes(observed.state));
    if(observed.state==='outcomeUnknown'){await until(()=>{if(fatal)throw fatal;return held.nativeResolved;},'Codex exact native response resolution',30_000);}
    const receipt=await host.receipt(scope,id);assert.equal(receipt?.state,'acknowledged','ORIGINAL_HOST_RESPONSE_NOT_ACKNOWLEDGED');
    for(const viewer of viewers){await viewer.refresh(scope);}nativeReplies.push({type:held.prompt.type,relation:held.relation,receipt:receipt.state,browser:usedBrowser});
  }
  function asyncReady(capabilityId){let ready=false,checking=false;return()=>{if(fatal)throw fatal;if(!checking){checking=true;void host.snapshot(scope).then(snapshot=>{ready=snapshot.interactions.some(item=>item.id===capabilityId);checking=false;},fail);}return ready;};}
  async function send(label,text,selection){
    const id=`codex-original-${label}`;ctx.allowance.admit('codex-root',id);rootTurns++;stage=label;result.cases[label]={status:'admitted-awaiting-native'};
    plans.set(text,{label,selection});const receipt=await host.submit({scope,id,generation:run.generation,command:{type:'send',text,selection}});assert.ok(['acknowledged','outcomeUnknown'].includes(receipt.state));
    const nativeTurn=turnResults.find(row=>row.id===id);await until(()=>{if(fatal)throw fatal;return turnResults.some(row=>row.id===id);},`Codex ${label} native start`,30_000);
    const current=nativeTurn??turnResults.find(row=>row.id===id);await until(()=>{if(fatal)throw fatal;if(rpc.failure)throw rpc.failure;return completedTurns.has(asKey(rootThread,current.turn));},`Codex ${label} complete`,150_000);
    await Promise.all([...answerTasks]);assert.equal(childRequests.length,0,'CHILD_CALLBACK_WITHOUT_NATIVE_ANCESTRY');assert.equal((await host.receipt(scope,id))?.state,'acknowledged');
    const nativeStatus=completedTurns.get(asKey(rootThread,current.turn));result.cases[label]={status:nativeStatus==='completed'?'passed-native-turn':'native-turn-failed',nativeStatus,actualCallbacks:prompts.filter(p=>p.stage===label).map(p=>({type:p.type,relation:p.relation}))};safeRecord('turn-completed',{scenario:label,nativeStatus});if(nativeStatus!=='completed')result.unqualified.push(`${label}: native turn ended ${nativeStatus}`);return nativeStatus;
  }
  let result={status:'running',harness:'codex',model:ctx.model,provider:ctx.provider,continuation:ctx.continuation===true,cases:{},checks:{},unqualified:[],cleanup:{}};
  const partialResult=()=>structuredClone({...result,nativeTurns:rootTurns,rpcCounts:rpc?.counts??null,checks:{...result.checks,selectedModelProvider:providerSelected,nativeReverseRequests:rpc?.counts.reverseRequests??0,nativeResponseDispatches:responseDispatches,originalHostReceipts:nativeReplies,twoRetainedClients:viewers.length===2,authenticatedHttp:!!ctx.openViewerBridge,actualBrowserResponses:browserResponses,zeroViewerPendingRetention:zeroViewerCapture,readReconnects,lostViewerRepliesDeliberatelyDiscarded:lostReplies,originalReceiptLookupWithoutReplay:lostReplies>0,nativeChildCount:children.size,lateDuplicateRefusals,nativeResolvedCount:resolvedRequests.size,promptTypes:[...new Set(prompts.map(p=>p.type))],childPromptCount:prompts.filter(p=>p.relation==='child').length,nativeToolResults,nativeProbeResults,noSyntheticCallbacks:true,noNativeHistoryReads:true}});
  try{
    const nativeEnvironment={...(ctx.nativeEnvironment??Object.fromEntries(['PATH','LD_LIBRARY_PATH','NIX_LD','NIX_LD_LIBRARY_PATH','LANG','LC_ALL','TZ','TERM'].flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]]]))),CODEX_HOME:ctx.nativeHome,MULTIPLEX_V8_LIVE_KEY:ctx.key};
    rpc=new CodexInteractionRpc({binary,workspace:ctx.workspace,environment:nativeEnvironment,onNotification:observe,onServerRequest:receiveRequest});ctx.registerNativeCleanup?.(()=>rpc.close());await rpc.ready();
    const initialized=await rpc.request('initialize',{clientInfo:{name:'multiplex_v8_interactions_live',title:'Multiplex V8 native interactions live',version:'0.0.0'},capabilities:{experimentalApi:true}});rpc.notify('initialized');assert.match(initialized.userAgent??'',/0\.162\.1/);
    const port={kind:'codex',placement:'dedicated',capabilities:{commands:['send','answer'],fullStop:true,openAndWait:true},catalog:async()=>({available:true,choices:[{model:ctx.model,efforts:['low']}]}),inspect:async()=>null,start:async(input,emit)=>{
      assert.equal(input.continuePendingWork,false);assert.equal(input.nativeSession,null,'THIS_LIVE_PROBE_DOES_NOT_QUALIFY_RESUME');nativeEmit=emit;
      const started=await rpc.request('thread/start',{model:ctx.model,modelProvider:ctx.provider,allowProviderModelFallback:false,cwd:ctx.workspace,approvalPolicy:'on-request',sandbox:'danger-full-access',historyMode:'paginated',ephemeral:false,developerInstructions:'This is an explicitly authorized disposable native-interaction qualification. Follow only the exact requested harmless fixture task. Never inspect credentials, native homes, other sessions/services or networks. Only the named fixture files may be touched. Never spawn children unless the current user turn explicitly requests exactly one child, which must use the explicitly selected model and no further children. Do not manufacture text approvals; use actual native tools when available.'});
      assert.equal(started.model,ctx.model);assert.equal(started.modelProvider,ctx.provider);assert.equal(started.approvalPolicy,'on-request');assert.equal(started.sandbox?.type,'dangerFullAccess');providerSelected=true;rootThread=started.thread.id;run={scope,generation:input.generation,nativeSession:rootThread};owner=new InteractionOwner({run,kind:'codex',epoch:1});
      assert.ok(['idle','systemError'].includes(started.thread.status?.type),'NO_POSITIVE_FRESH_NATIVE_CALLBACK_BASELINE');owner.certifyBaseline({run,complete:true,continuous:true});
      return owner.wrap({run:{run,selection:{kind:'codex',model:ctx.model,effort:'low',access:DEFAULT_ACCESS},interactionsComplete:true,interactions:[],stop:async()=>{const exit=await rpc.close();assert.equal(exit.ownedGroupAbsent,true);closing=true;return{run,state:'stopped',scope:'nativeTree',noAutomaticContinuation:true};},invoke:async command=>{
        assert.equal(command.type,'send');const plan=plans.get(command.text);assert.ok(plan,'UNFROZEN_NATIVE_SEND_PLAN');const selected=command.selection??{kind:'codex',model:ctx.model,effort:'low'},access=selected.access??DEFAULT_ACCESS;
        const sandboxPolicy=access.sandbox==='danger-full-access'?{type:'dangerFullAccess'}:access.sandbox==='read-only'?{type:'readOnly',networkAccess:false}:{type:'workspaceWrite',writableRoots:[ctx.workspace],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true};
        const collaborationMode=selected.collaboration?{mode:selected.collaboration.mode,settings:{model:ctx.model,reasoning_effort:'low',developer_instructions:selected.collaboration.instructions??null}}:undefined;
        const response=await rpc.request('turn/start',{threadId:rootThread,clientUserMessageId:`codex-original-${plan.label}`,input:[{type:'text',text:command.text,text_elements:[]}],model:ctx.model,effort:'low',approvalPolicy:access.approval,sandboxPolicy,...(collaborationMode?{collaborationMode}:{})});assert.ok(response.turn?.id);turnResults.push({id:`codex-original-${plan.label}`,turn:response.turn.id});return{status:'accepted'};
      }},emit});
    }};
    host=await SessionHost.open({directory:journalDirectory,scope,port,policy:{kind:'codex',provider:'configured',access:DEFAULT_ACCESS},observationMs:30_000});
    assert.equal((await host.submit({scope,id:'codex-create',generation:0,command:{type:'create'}})).state,'acknowledged');
    for(let i=0;i<2;i++){const bridge=ctx.openViewerBridge?await ctx.openViewerBridge({scope,sessionPort:host,interactionPort:owner}):{sessionPort:host,interactionPort:owner,disconnect(){},async reconnect(){},async close(){}};bridges.push(bridge);
      const writePort=i===0?{snapshot:bridge.sessionPort.snapshot.bind(bridge.sessionPort),subscribe:bridge.sessionPort.subscribe.bind(bridge.sessionPort),receipt:bridge.sessionPort.receipt.bind(bridge.sessionPort),submit:async request=>{const receipt=await bridge.sessionPort.submit(request);if(request.command.type==='answer'&&dropNextViewerReply){dropNextViewerReply=false;lostReplies++;throw Error('DELIBERATELY_DISCARDED_ALREADY_ACKNOWLEDGED_HTTP_REPLY');}return receipt;}}:bridge.sessionPort;
      const viewer=new InteractionWorkspace({port:bridge.interactionPort,session:writePort});await viewer.bind(scope);viewers.push(viewer);}
    if(!ctx.continuation){
    // Model-free native MCP calls: the local MCP server itself requests actual elicitation.
    let fixture;ctx.allowance.admit('codex-native','mcp-status');
    try{const mcpStatus=await rpc.request('mcpServerStatus/list',{cursor:null,limit:20,threadId:rootThread});fixture=mcpStatus.data?.find(row=>row.name==='v8_interaction_fixture');assert.ok(fixture&&fixture.tools?.fixture_form&&fixture.tools?.fixture_url,'LOCAL_MCP_FIXTURE_NOT_DISCOVERED');nativeProbeResults.push({scenario:'mcp-status',status:'passed'});}
    catch(error){if(fatal||rpc.failure)throw error;result.unqualified.push(`MCP discovery: ${error.message}`);nativeProbeResults.push({scenario:'mcp-status',status:'not-qualified',reason:error.message});}
    for(const tool of ['fixture_form','fixture_url']){if(!fixture?.tools?.[tool]){result.unqualified.push(`${tool}: actual native fixture tool not discovered`);continue;}stage=`mcp-${tool}`;ctx.allowance.admit('codex-native',tool);
      try{const called=await rpc.request('mcpServer/tool/call',{threadId:rootThread,server:'v8_interaction_fixture',tool,arguments:{}},120_000);await Promise.all([...answerTasks]);if(fatal)throw fatal;const content=called.result?.structuredContent??called.structuredContent;
        safeRecord('mcp-call-returned',{tool,isError:called.result?.isError??called.isError??null,structuredContent:content??null});assert.ok(prompts.some(p=>p.stage===stage&&p.type==='codex.elicitation'),'MCP_NO_REAL_NATIVE_ELICITATION');if(content){assert.equal(content.action,'accept');assert.equal(content.contentValid,true);}assert.equal(owner.current().items.length,0,'MCP_RESPONSE_LACKS_NATIVE_RESOLUTION');nativeProbeResults.push({scenario:tool,status:'passed'});result.cases[tool]={status:'passed-native-response'};
      }catch(error){if(fatal||rpc.failure||owner.current().items.length||answerTasks.size)throw error;result.unqualified.push(`${tool}: ${error.message}`);nativeProbeResults.push({scenario:tool,status:'not-qualified',reason:error.message});result.cases[tool]={status:'not-qualified',reason:error.message};}
    }
    const baselineCount=prompts.length;
    const baselineStatus=await send('baseline',"Run exactly one harmless command: printf 'V8_LIVE_CDX_BASELINE\\n'. Do not request escalation, inspect files, call MCP or create children. Reply V8_LIVE_CDX_BASELINE_DONE.",{kind:'codex',model:ctx.model,effort:'low',access:DEFAULT_ACCESS});assert.equal(baselineStatus,'completed','BASELINE_NATIVE_TURN_FAILED');assert.equal(prompts.length,baselineCount,'FULL_ACCESS_BASELINE_GOT_EXTRA_MULTIPLEX_APPROVAL');assert.ok(nativeToolResults.some(row=>row.stage==='baseline'&&row.relation==='root'&&row.exitCode===0&&row.baselineBytesExact),'BASELINE_NATIVE_COMMAND_NOT_PROVED');
    await send('restricted',`This turn explicitly tests native permission popups in a disposable read-only sandbox. First run exactly: printf 'V8_LIVE_CDX_APPROVAL\\n' using require_escalated if needed. Then attempt apply_patch to add only ${join(ctx.workspace,'approval-fixture.txt')} with content V8_LIVE_CDX_FILE. Its file-change approval will be declined; accept the denial and continue. Finally, if request_permissions is available, request only read access to ${outsideFile}, no network and no other paths, without reading it. Never substitute a shell write or report text as a permission callback. Do not create children. Reply V8_LIVE_CDX_RESTRICTED_DONE.`,{kind:'codex',model:ctx.model,effort:'low',access:{approval:'on-request',sandbox:'read-only'}});
    }else{
      result.cases.priorScenarios={status:'skipped-already-admitted',scenarios:['fixture_form','fixture_url','baseline','restricted']};
      if(ctx.probeCodexUrlShape){
        stage='mcp-fixture_url_shape';ctx.allowance.admit('codex-native','fixture_url_shape');
        try{const called=await rpc.request('mcpServer/tool/call',{threadId:rootThread,server:'v8_interaction_fixture',tool:'fixture_url_shape',arguments:{}},120_000);await Promise.all([...answerTasks]);if(fatal)throw fatal;const content=called.structuredContent;safeRecord('mcp-url-shape-returned',{structuredContent:content??null,isError:called.isError??null});assert.equal(called.isError,false);assert.equal(content?.fixture,'fixture_url_shape');assert.equal(content?.action,'accept');assert.ok(['undefined','null','object','array','string','number','boolean'].includes(content?.contentKind));assert.ok(Array.isArray(content.contentKeys)&&Array.isArray(content.resultKeys));assert.equal(owner.current().items.length,0,'MCP_SHAPE_RESPONSE_LACKS_NATIVE_RESOLUTION');nativeProbeResults.push({scenario:'fixture_url_shape',status:'passed-shape-observed',shape:content});result.cases.urlResponseShape={status:'passed-shape-observed',shape:content};}
        catch(error){if(fatal||rpc.failure||owner.current().items.length||answerTasks.size)throw error;result.unqualified.push(`fixture_url_shape: ${error.message}`);nativeProbeResults.push({scenario:'fixture_url_shape',status:'not-qualified',reason:error.message});result.cases.urlResponseShape={status:'not-qualified',reason:error.message};}
      }
    }
    await send('question','Use the actual request_user_input tool once. Ask one question with header Fixture and question V8_LIVE_CDX_QUESTION, offering choices fixture-a and fixture-b. Wait for the real response, then reply V8_LIVE_CDX_QUESTION_DONE. Do not use shell, files, MCP, networks or child agents. Do not simulate a question in assistant text.',{kind:'codex',model:ctx.model,effort:'low',access:DEFAULT_ACCESS,collaboration:{mode:'plan',model:ctx.model,effort:'low',instructions:null}});
    ctx.allowance.admit('codex-child','exact-one-child-interaction');
    await send('child',`Spawn exactly one native child agent using model ${ctx.model}. Ask this one child to perform these bounded native-interaction probes IN THIS ORDER under inherited read-only/on-request permissions: (1) attempt apply_patch only to add ${join(ctx.workspace,'child-file-approval-fixture.txt')} with text V8_LIVE_CDX_CHILD_FILE, and accept its expected file-approval denial without an alternate write; (2) if the actual request_permissions tool is available, request only read permission for ${outsideFile}, no network or other paths, without reading it; (3) run exactly printf 'V8_LIVE_CDX_CHILD_APPROVAL\\n' with require_escalated if needed. Then reply V8_LIVE_CDX_CHILD_DONE. The child must not inspect other files, access networks, spawn children or perform other commands. Wait for this one child then reply V8_LIVE_CDX_PARENT_DONE. Do not create another child or replace unavailable native tools with assistant text.`,{kind:'codex',model:ctx.model,effort:'low',access:{approval:'on-request',sandbox:'read-only'},collaboration:{mode:'default',model:ctx.model,effort:'low',instructions:null}});
    if(fatal)throw fatal;await Promise.all([...answerTasks]);
    for(const type of ['codex.command','codex.file','codex.permission','codex.question','codex.elicitation'])if(!prompts.some(p=>p.type===type))result.unqualified.push(`${type}: no actual native callback observed in its one finite trigger`);
    if(children.size!==1)result.unqualified.push('Native child: no positively proved child observed');if(!prompts.some(p=>p.relation==='child'))result.unqualified.push('Native child interaction ownership: no actual child callback observed');
    const beforeResponses=rpc.counts.responses;await Promise.all(bridges.map(bridge=>bridge.reconnect()));for(const viewer of viewers)await viewer.refresh(scope);assert.equal(rpc.counts.responses,beforeResponses,'RECONNECT_REPLAYED_NATIVE_RESPONSE');
    result.checks={selectedModelProvider:providerSelected,trustedFullAccessBaseline:!ctx.continuation,baselineNativeCommandBytesExact:!ctx.continuation,nativeReverseRequests:rpc.counts.reverseRequests,oneNativeResponsePerOriginal:rpc.counts.responses===responseDispatches,originalHostReceipts:nativeReplies,twoRetainedClients:true,authenticatedHttp:!!ctx.openViewerBridge,actualBrowserResponses:browserResponses,zeroViewerCapture,readReconnects,lostViewerRepliesDeliberatelyDiscarded:lostReplies,originalReceiptLookupWithoutReplay:lostReplies>0,nativeChildCount:children.size,lateDuplicateRefusals,nativeResolvedCount:resolvedRequests.size,promptTypes:[...new Set(prompts.map(p=>p.type))],childPromptCount:prompts.filter(p=>p.relation==='child').length,nativeToolResults,nativeProbeResults,noSyntheticCallbacks:true,noNativeHistoryReads:true};
    const stop=await host.submit({scope,id:'codex-stop',generation:run.generation,command:{type:'stop'}});assert.equal(stop.state,'acknowledged');assert.equal((await host.snapshot(scope)).phase,'stopped');assert.equal(owner.current().issue,'ownershipRetired');result.checks.nativeOwnedGroupExit=true;
    await host.close();result.status=result.unqualified.length?'passed-native-observed-subset':'passed-native-requested-scope';result.nativeTurns=rootTurns;result.rpcCounts=rpc.counts;ctx.progress?.(`Codex native interactions finished ${rootTurns} root turns; ${prompts.length} actual callback(s), ${result.unqualified.length} explicit gap(s).`);return result;
  }catch(error){caughtError=error;result.status='failed-native-diagnostic';result.reason=error.message;error.partialResult=partialResult();throw error;
  }finally{
    const cleanupErrors=[];for(const viewer of viewers)try{viewer.close();}catch(error){cleanupErrors.push(error);}for(const bridge of bridges)try{await bridge.close();}catch(error){cleanupErrors.push(error);}
    if(rpc&&!closing)try{const exit=await rpc.close();result.cleanup.nativeOwnedGroupExit=exit.ownedGroupAbsent===true;}catch(error){safeRecord('cleanup-failed',{message:error.message});cleanupErrors.push(error);}
    if(closing)result.cleanup.nativeOwnedGroupExit=true;try{owner?.retire();}catch(error){cleanupErrors.push(error);}try{await host?.terminate();result.cleanup.hostWriterTerminated=true;}catch(error){cleanupErrors.push(error);}
    if(caughtError)caughtError.partialResult=partialResult();
    if(cleanupErrors.length){const error=new AggregateError(cleanupErrors,'CODEX_INTERACTION_CLEANUP_INCOMPLETE');result.cleanup.errors=cleanupErrors.map(value=>value.message);error.partialResult=partialResult();throw error;}
  }
}
