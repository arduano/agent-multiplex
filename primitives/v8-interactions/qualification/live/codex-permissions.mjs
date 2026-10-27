import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {isAbsolute,join,resolve} from 'node:path';
import {CodexInteractionRpc} from './codex-rpc.mjs';
import {until} from './support.mjs';

const FEATURE='request_permissions_tool';
const DEFAULT_ACCESS={approval:'on-request',sandbox:'danger-full-access'};
const key=(thread,id)=>JSON.stringify([thread,typeof id,id]);
const ownKeys=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(name=>names.includes(name));
function exactReadEntry(entry,expectedPath){
  return ownKeys(entry,['path','access'])&&entry.access==='read'&&ownKeys(entry.path,['type','path'])&&entry.path.type==='path'&&typeof entry.path.path==='string'&&isAbsolute(entry.path.path)&&resolve(entry.path.path)===resolve(expectedPath);
}

/** Finite fixture authorization: one exact owned read path, never a write/network/future grant. */
export function permissionAnswer(prompt,expectedPath,grant){
  assert.equal(prompt.type,'codex.permission');assert.ok(['turn','deny'].includes(grant));
  const requested=prompt.requested;assert.ok(ownKeys(requested,['network','fileSystem']),'UNSUPPORTED_PERMISSION_PROFILE');
  const network=requested.network;
  assert.ok(network===null||network===undefined||(ownKeys(network,['enabled'])&&(network.enabled===false||network.enabled===null)),'NETWORK_PERMISSION_OUTSIDE_FIXTURE');
  const files=requested.fileSystem;assert.ok(ownKeys(files,['read','write','entries']),'UNSUPPORTED_FILESYSTEM_CONSTRAINT');
  assert.ok(Array.isArray(files.read)&&files.read.length===1&&typeof files.read[0]==='string'&&isAbsolute(files.read[0])&&resolve(files.read[0])===resolve(expectedPath),'READ_PERMISSION_OUTSIDE_FIXTURE');
  assert.ok(files.write===null||files.write===undefined||(Array.isArray(files.write)&&files.write.length===0),'WRITE_PERMISSION_OUTSIDE_FIXTURE');
  if(files.entries!==undefined)assert.ok(Array.isArray(files.entries)&&files.entries.length===1&&exactReadEntry(files.entries[0],expectedPath),'LITERAL_ENTRY_DOES_NOT_MIRROR_EXACT_READ');
  return{type:'codex.permission',grant};
}

/** Only a named native tool output can call this. Assistant text is never an outcome oracle. */
export function permissionToolOutcome(output,expectedPath,grant){
  try{
    const text=typeof output==='string'?output:Array.isArray(output)&&output.length>0&&output.every(item=>item?.type==='input_text'&&typeof item.text==='string')?output.map(item=>item.text).join('\n'):null;
    assert.ok(text!==null&&Buffer.byteLength(text)<=65536,'Unsupported native output body');
    const body=JSON.parse(text);assert.ok(ownKeys(body,['permissions','scope','strict_auto_review','strictAutoReview'])&&body.scope==='turn','Unsupported native result envelope');
    for(const name of ['strict_auto_review','strictAutoReview'])assert.ok(body[name]===undefined||typeof body[name]==='boolean','Unsupported review flag');
    const permissions=body.permissions;assert.ok(ownKeys(permissions,['network','file_system','fileSystem']),'Unsupported granted profile');
    assert.ok(!(Object.hasOwn(permissions,'file_system')&&Object.hasOwn(permissions,'fileSystem')),'Conflicting native filesystem profiles');
    const network=permissions.network;assert.ok(network===null||network===undefined||(ownKeys(network,['enabled'])&&(network.enabled===false||network.enabled===null)),'Unexpected network grant');
    const files=permissions.file_system??permissions.fileSystem;
    assert.ok(files===null||files===undefined||ownKeys(files,['read','write','entries']),'Unsupported native filesystem constraints');
    const reads=files?.read??[],writes=files?.write??[];assert.ok(Array.isArray(reads)&&Array.isArray(writes)&&writes.length===0,'Unexpected write grant');
    if(grant==='turn'){
      assert.ok(reads.length===1&&typeof reads[0]==='string'&&isAbsolute(reads[0])&&resolve(reads[0])===resolve(expectedPath),'Granted read profile differs from original');
      if(files.entries!==undefined)assert.ok(Array.isArray(files.entries)&&files.entries.length===1&&exactReadEntry(files.entries[0],expectedPath),'Native literal entry does not mirror original read');
    }else{assert.equal(grant,'deny');assert.equal(reads.length,0,'Denied request returned a read grant');assert.ok(files?.entries===undefined||(Array.isArray(files.entries)&&files.entries.length===0),'Denied request returned filesystem entries');}
    return{verified:true,scope:'turn',decision:grant,filesystemKey:Object.hasOwn(permissions,'file_system')?'file_system':Object.hasOwn(permissions,'fileSystem')?'fileSystem':'omitted',literalEntriesPreserved:files?.entries!==undefined};
  }catch(error){return{verified:false,reason:error.message};}
}

/** Fresh remaining allowance only. Importing never starts native or model work; root alone invokes. */
export async function runCodexInteractions(ctx){
  assert.ok(typeof ctx.model==='string'&&ctx.model.length>0,'EXPLICIT_ALLOWED_MODEL_REQUIRED');
  assert.ok(isAbsolute(ctx.nativeHome)&&isAbsolute(ctx.workspace)&&isAbsolute(ctx.stateDirectory));
  const {SessionHost,InteractionOwner,InteractionWorkspace}=ctx.core;
  assert.ok(SessionHost&&InteractionOwner&&InteractionWorkspace&&ctx.openViewerBridge&&ctx.respondInBrowser);
  const require=createRequire(join(ctx.toolRoot,'package.json'));
  const binary=join(require.resolve('@openai/codex-linux-x64/package.json'),'../vendor/x86_64-unknown-linux-musl/bin/codex');
  const config=await readFile(join(ctx.nativeHome,'config.toml'),'utf8');
  assert.ok(/approval_policy\s*=\s*"on-request"/.test(config)&&/sandbox_mode\s*=\s*"danger-full-access"/.test(config),'BASELINE_POLICY_CHANGED');
  const targets=join(ctx.stateDirectory,'extra-permission-targets');
  await mkdir(targets,{recursive:true,mode:0o700});
  const scenarios=ctx.remainingRecovery?[
    {id:'codex-extra-permission-literal-entry-grant',file:join(targets,'literal-entry-new-read.txt'),grant:'turn'},
  ]:[
    {id:'codex-extra-permission-grant-turn',file:join(targets,'grant-read.txt'),grant:'turn'},
    {id:'codex-extra-permission-deny',file:join(targets,'deny-read.txt'),grant:'deny'},
  ];
  for(const scenario of scenarios)await writeFile(scenario.file,'V8_PERMISSION_TARGET_NOT_TO_BE_READ\n',{mode:0o600,flag:'wx'});
  const scope={connection:'v8-live-remaining',principal:'finite-owner',host:'codex-disposable',session:'extra-permission-root'};
  let rpc,host,owner,run,emitNative,rootThread,current,fatal,caughtError,closing=false,rootTurns=0,nativeCalls=0,nativeHistoryReads=0,nativeOutcomeAudits=0,browserAnswers=0,responseCalls=0,competingRefusals=0,lostReplies=0,dropNext=true;
  const bridges=[],viewers=[],held=new Map(),completedTurns=new Map(),turnByOriginal=new Map(),responseTasks=new Set(),events=[];
  const result={harness:'codex',status:'running',feature:FEATURE,model:ctx.model,provider:ctx.provider,cases:{},proofs:[],limitations:[],counts:{},cleanup:{}};
  const record=(name,value)=>ctx.record?.(`codex-extra-permission-${name}`,value);
  const fail=error=>{fatal??=error;rpc?.rejectObservation(error);};
  const snapshot=()=>structuredClone({...result,counts:{rootTurns,childTurns:0,nativeCalls,nativeHistoryReads,nativeOutcomeAudits,browserAnswers,responseCalls,competingRefusals,lostReplies,events:events.length},rpcCounts:rpc?.counts??null});
  const request=async(method,params,timeout=30_000)=>{assert.ok(++nativeCalls<=50,'NATIVE_RPC_BOUND');return rpc.request(method,params,timeout);};
  const drainResponses=async()=>{await Promise.all([...responseTasks]);if(fatal)throw fatal;};
  function observe(message){try{
    assert.ok(events.length<2048,'NATIVE_EVENT_BOUND');events.push(message.method);
    const p=message.params??{};
    if(message.method==='serverRequest/resolved'){
      const record=held.get(key(p.threadId,p.requestId));rpc.resolved(p.requestId);
      if(record){record.resolved=true;owner.completed(record.prompt.id,run);}
    }
    if(message.method==='turn/completed'&&p.threadId===rootThread){completedTurns.set(p.turn?.id,p.turn?.status);emitNative?.({run,type:'activity',activity:'idle'});}
    if(message.method==='turn/started'&&p.threadId===rootThread)emitNative?.({run,type:'activity',activity:'working'});
    if((message.method==='item/started'||message.method==='item/completed')&&p.item?.type==='subAgentActivity')throw Error('CHILD_OUTSIDE_ZERO_CHILD_ALLOWANCE');
    if(message.method==='item/completed'&&p.threadId===rootThread&&p.item?.type==='functionCallOutput'&&p.item.name==='request_permissions'){
      const output=p.item.output;assert.ok(Buffer.byteLength(JSON.stringify(output))<=65536,'NATIVE_TOOL_OUTPUT_BOUND');
      record('native-tool-output',{scenario:current?.id??null,name:p.item.name,output});
      if(current){result.cases[current.id].nativeToolOutputObserved=true;result.cases[current.id].nativeToolOutputSource='notification';result.cases[current.id].nativeToolOutcome=permissionToolOutcome(output,current.file,current.grant);}
    }
  }catch(error){fail(error);}}
  function reverse(message){try{
    const detail=message.params;assert.ok(detail&&Buffer.byteLength(JSON.stringify(detail))<=65536,'NATIVE_PROMPT_BOUND');
    record('native-request',{method:message.method,scenario:current?.id??null,detail});
    const files=detail.permissions?.fileSystem;
    record('native-entry-semantics',{scenario:current?.id??null,entryCount:Array.isArray(files?.entries)?files.entries.length:null,entryShapes:Array.isArray(files?.entries)?files.entries.slice(0,32).map(entry=>({access:entry?.access??null,pathValueKind:typeof entry?.path,pathDiscriminant:entry?.path&&typeof entry.path==='object'?entry.path.type??null:null,mirrorsExactOwnedRead:current?exactReadEntry(entry,current.file):false})):[]});
    assert.equal(message.method,'item/permissions/requestApproval','OTHER_NATIVE_INTERACTION_CANNOT_QUALIFY_EXTRA_PERMISSIONS');
    assert.ok(current&&detail.threadId===rootThread,'UNPROVED_PERMISSION_OWNER');
    assert.equal(result.cases[current.id].callbacks,0,'PERMISSION_REQUEST_MUST_NOT_RETRY');
    const prompt=owner.registerCodex({token:{},requestId:JSON.stringify(message.id),owner:{nativeAgent:rootThread,relation:'root'},method:message.method,params:detail,respond:async value=>{
      responseCalls++;record('native-response',{scenario:current.id,scope:value.scope,readCount:value.permissions?.fileSystem?.read?.length??0,writeCount:value.permissions?.fileSystem?.write?.length??0,networkEnabled:value.permissions?.network?.enabled===true});
      return rpc.respond(message.id,value);
    }});
    permissionAnswer(prompt,current.file,current.grant);result.cases[current.id].callbacks++;
    const recordHeld={prompt,resolved:false,scenario:current};held.set(key(rootThread,message.id),recordHeld);
    let task;task=answer(recordHeld).catch(fail).finally(()=>responseTasks.delete(task));responseTasks.add(task);
  }catch(error){fail(error);}}
  async function waitHostCallback(id){await until(async()=>{if(fatal)throw fatal;return(await host.snapshot(scope)).interactions.some(item=>item.id===id);},'Exact Host permission capability',30_000);}
  async function refresh(){for(const viewer of viewers){viewer.setConnected(scope,true);await viewer.refresh(scope);}}
  async function answer(recordHeld){
    await waitHostCallback(recordHeld.prompt.id);
    for(const viewer of viewers)await viewer.refresh(scope);
    const scenario=recordHeld.scenario,decision=permissionAnswer(recordHeld.prompt,scenario.file,scenario.grant),id=`${scenario.id}-answer`;
    const before=responseCalls;let receipt;
    if(browserAnswers===0){
      await Promise.all(bridges.map(bridge=>bridge.disconnect()));for(const viewer of viewers)viewer.setConnected(scope,false);
      assert.ok(owner.current().items.some(item=>item.prompt.id===recordHeld.prompt.id));result.proofs.push('Exact native permission capability retained with both viewers disconnected');
      await Promise.all(bridges.map(bridge=>bridge.reconnect()));await refresh();
      receipt=await ctx.respondInBrowser({bridge:bridges[0],prompt:recordHeld.prompt,answer:decision,operationId:id});browserAnswers++;
      result.cases[scenario.id].browser=true;
    }else{
      const first=viewers[0].answer(scope,recordHeld.prompt,decision,id);let second;
      try{second=viewers[1].answer(scope,recordHeld.prompt,decision,`${id}-competing`).result;}catch{}
      try{receipt=await first.result;}catch(error){if(lostReplies===0)throw error;receipt=await viewers[0].checkReceipt(scope,id);assert.equal(receipt?.state,'acknowledged','ORIGINAL_RECEIPT_NOT_RECOVERED');result.proofs.push('Deliberately discarded acknowledged HTTP response recovered by original ID without replay');}
      if(second){const duplicate=await second;assert.equal(duplicate.state,'refused');competingRefusals++;}
      result.cases[scenario.id].browser=false;
    }
    assert.ok(['acknowledged','outcomeUnknown'].includes(receipt.state));
    await until(()=>{if(fatal)throw fatal;return recordHeld.resolved;},'Exact native permission response resolved',30_000);
    assert.equal((await host.receipt(scope,id))?.state,'acknowledged');assert.equal(responseCalls,before+1,'PERMISSION_RESPONDED_TWICE');
    result.cases[scenario.id].originalReceipt='acknowledged';result.cases[scenario.id].nativeResolved=true;
    await refresh();
  }
  try{
    assert.ok(ctx.nativeEnvironment,'Root-owned sanitized native environment required');
    ctx.allowance.admit('codex-native',ctx.remainingRecovery?'extra-permission-literal-entry-bootstrap':'extra-permission-fresh-bootstrap');record('bootstrap',{maximumInitiatingRpcs:2,recovery:ctx.remainingRecovery===true});
    rpc=new CodexInteractionRpc({binary,args:['--enable',FEATURE,'app-server','--stdio'],workspace:ctx.workspace,environment:{...ctx.nativeEnvironment,CODEX_HOME:ctx.nativeHome,MULTIPLEX_V8_LIVE_KEY:ctx.key},onNotification:observe,onServerRequest:reverse});
    ctx.registerNativeCleanup?.(()=>rpc.close());await rpc.ready();
    const initialized=await request('initialize',{clientInfo:{name:'multiplex_v8_extra_permissions',title:'V8 bounded extra permissions',version:'0.0.0'},capabilities:{experimentalApi:true}});rpc.notify('initialized');assert.match(initialized.userAgent??'',/0\.162\.1/);
    const port={kind:'codex',placement:'dedicated',capabilities:{commands:['send','answer'],fullStop:true,openAndWait:true},catalog:async()=>({available:true,choices:[{model:ctx.model,efforts:['low']}]}),inspect:async()=>null,start:async(input,emit)=>{
      assert.equal(input.nativeSession,null);assert.equal(input.continuePendingWork,false);emitNative=emit;
      const started=await request('thread/start',{model:ctx.model,modelProvider:ctx.provider,allowProviderModelFallback:false,cwd:ctx.workspace,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:'danger-full-access',ephemeral:false,historyMode:'paginated',developerInstructions:'This is a fresh explicitly authorized finite native extra-permissions qualification. Use only the actual request_permissions tool for the exact one owned read path specified in the current user turn. Do not run shell commands, read files, write files, call MCP, access networks, spawn children, inspect credentials or perform unrelated work. Never replace an unavailable native tool with assistant text or another tool. Each turn permits one permission request only; do not repeat a denied request.'});
      assert.equal(started.model,ctx.model);assert.equal(started.modelProvider,ctx.provider);assert.equal(started.approvalPolicy,'on-request');assert.equal(started.approvalsReviewer,'user');assert.equal(started.sandbox?.type,'dangerFullAccess');
      rootThread=started.thread.id;run={scope,generation:input.generation,nativeSession:rootThread};owner=new InteractionOwner({run,kind:'codex',epoch:1});
      assert.ok(['idle','systemError'].includes(started.thread.status?.type));owner.certifyBaseline({run,complete:true,continuous:true});result.proofs.push('Fresh native thread preserves selected model/provider and on-request/full-access baseline');
      return owner.wrap({run:{run,selection:{kind:'codex',model:ctx.model,effort:'low',access:DEFAULT_ACCESS},interactionsComplete:true,interactions:[],stop:async()=>{const exit=await rpc.close();assert.equal(exit.ownedGroupAbsent,true);closing=true;result.cleanup.nativeOwnedGroupExit=true;return{run,state:'stopped',scope:'nativeTree',noAutomaticContinuation:true};},invoke:async command=>{
        assert.equal(command.type,'send');assert.ok(current&&command.text===current.text,'UNFROZEN_EXTRA_PERMISSION_SEND');
        const reply=await request('turn/start',{threadId:rootThread,clientUserMessageId:current.id,input:[{type:'text',text:command.text,text_elements:[]}],model:ctx.model,effort:'low',approvalPolicy:'on-request',approvalsReviewer:'user',sandboxPolicy:{type:'readOnly',networkAccess:false}});
        assert.ok(reply.turn?.id);turnByOriginal.set(current.id,reply.turn.id);return{status:'accepted'};
      }},emit});
    }};
    host=await SessionHost.open({directory:join(ctx.stateDirectory,'extra-permission-session'),scope,port,policy:{kind:'codex',provider:'configured',access:DEFAULT_ACCESS},observationMs:30_000});
    assert.equal((await host.submit({scope,id:'codex-extra-permission-create',generation:0,command:{type:'create'}})).state,'acknowledged');
    for(let i=0;i<2;i++){
      const bridge=await ctx.openViewerBridge({scope,sessionPort:host,interactionPort:owner});bridges.push(bridge);
      const session=i===0?{snapshot:bridge.sessionPort.snapshot.bind(bridge.sessionPort),subscribe:bridge.sessionPort.subscribe.bind(bridge.sessionPort),receipt:bridge.sessionPort.receipt.bind(bridge.sessionPort),submit:async request=>{const receipt=await bridge.sessionPort.submit(request);if(dropNext&&request.command.type==='answer'){dropNext=false;lostReplies++;throw Error('DELIBERATELY_DISCARDED_ACKNOWLEDGED_REPLY');}return receipt;}}:bridge.sessionPort;
      const viewer=new InteractionWorkspace({port:bridge.interactionPort,session});await viewer.bind(scope);viewers.push(viewer);
    }
    let feature;
    for(let page=0,cursor=null;page<2&&!feature;page++){
      ctx.allowance.admit('codex-native',`${ctx.remainingRecovery?'extra-permission-literal-entry-feature-page':'extra-permission-feature-page'}-${page}`);
      const reply=await request('experimentalFeature/list',{threadId:rootThread,cursor,limit:100});feature=reply.data?.find(item=>item.name===FEATURE);cursor=reply.nextCursor;
      if(!cursor)break;
    }
    assert.ok(feature&&feature.enabled===true,'NATIVE_REQUEST_PERMISSIONS_FEATURE_NOT_ENABLED');
    result.feature={name:feature.name,enabled:feature.enabled,defaultEnabled:feature.defaultEnabled,stage:feature.stage};record('feature',result.feature);
    for(const scenario of scenarios){
      current={...scenario,text:`Use the real request_permissions tool exactly once. Request only read access to ${scenario.file}; request no network access and no write access. The precise tool arguments are permissions: {file_system: {read: [${JSON.stringify(scenario.file)}]}, network: {enabled: false}}. You may explain the harmless native qualification in justification. Wait for the actual client response. The client will ${scenario.grant==='turn'?'grant only that exact read permission for this turn':'deny this one new permission request'}; accept that response and do not retry. Do not run shell/apply_patch/other tools, read the target file, use MCP/network or create children. Finish with V8_EXTRA_PERMISSION_${scenario.grant==='turn'?'GRANTED':'DENIED'} only after the actual native tool returns. If the native tool is unavailable, say V8_EXTRA_PERMISSION_UNAVAILABLE without pretending it ran.`};
      ctx.allowance.admit('codex-root',current.id);rootTurns++;result.cases[current.id]={status:'admitted-awaiting-native',callbacks:0,decision:current.grant};
      const receipt=await host.submit({scope,id:current.id,generation:run.generation,command:{type:'send',text:current.text,selection:{kind:'codex',model:ctx.model,effort:'low',access:{approval:'on-request',sandbox:'read-only'}}}});assert.ok(['acknowledged','outcomeUnknown'].includes(receipt.state));
      await until(()=>{if(fatal)throw fatal;return turnByOriginal.has(current.id);},'Native permission turn started',30_000);
      const turn=turnByOriginal.get(current.id);await until(()=>{if(fatal)throw fatal;if(rpc.failure)throw rpc.failure;return completedTurns.has(turn);},'Native permission turn completed',150_000);await drainResponses();
      const nativeStatus=completedTurns.get(turn);assert.equal((await host.receipt(scope,current.id))?.state,'acknowledged');
      if(nativeStatus==='completed'&&result.cases[current.id].callbacks===1&&result.cases[current.id].nativeToolOutputObserved!==true){
        // Explicit qualification audit exception, separate from healthy UI/history streaming.
        ctx.allowance.admit('codex-native',`extra-permission-original-outcome-audit:${current.id}`);nativeHistoryReads++;nativeOutcomeAudits++;
        try{
          const page=await request('thread/items/list',{threadId:rootThread,turnId:turn,cursor:null,limit:32,sortDirection:'asc'});
          assert.ok(Array.isArray(page.data)&&page.data.length<=32,'NATIVE_OUTCOME_AUDIT_BOUND');
          const outputs=page.data.filter(entry=>entry.turnId===turn&&entry.item?.type==='functionCallOutput'&&entry.item.name==='request_permissions');
          result.cases[current.id].nativeOutcomeAudit={pages:1,items:page.data.length,moreAvailable:!!page.nextCursor,namedOutputs:outputs.length};
          record('explicit-outcome-audit',{original:current.id,...result.cases[current.id].nativeOutcomeAudit});
          if(outputs.length===1&&!page.nextCursor){const output=outputs[0].item.output;assert.ok(Buffer.byteLength(JSON.stringify(output))<=65536,'NATIVE_AUDITED_OUTPUT_BOUND');result.cases[current.id].nativeToolOutputObserved=true;result.cases[current.id].nativeToolOutputSource='explicit-native-items-audit';result.cases[current.id].nativeToolOutcome=permissionToolOutcome(output,current.file,current.grant);record('audited-native-tool-output',{original:current.id,name:'request_permissions',output});}
        }catch(error){if(fatal||rpc.failure)throw error;result.cases[current.id].nativeOutcomeAuditError=error.message;record('explicit-outcome-audit-unavailable',{original:current.id,reason:error.message});}
      }
      if(result.cases[current.id].callbacks!==1||nativeStatus!=='completed'||result.cases[current.id].nativeToolOutputObserved!==true||result.cases[current.id].nativeToolOutcome?.verified!==true){
        result.cases[current.id].status='not-qualified';result.cases[current.id].nativeStatus=nativeStatus;
        result.limitations.push(`${current.id}: ${result.cases[current.id].callbacks} actual extra-permission callbacks, native status ${nativeStatus}, named tool output observed ${result.cases[current.id].nativeToolOutputObserved===true}, native granted/denied outcome verified ${result.cases[current.id].nativeToolOutcome?.verified===true}`);
      }else{result.cases[current.id].status='passed-native-permission';result.cases[current.id].nativeStatus=nativeStatus;}
      record('case',result.cases[current.id]);assert.equal(owner.current().items.length,0,'UNSETTLED_PERMISSION_CANNOT_ADVANCE');
    }
    const before=rpc.counts.responses;await Promise.all(bridges.map(bridge=>bridge.reconnect()));await refresh();assert.equal(rpc.counts.responses,before,'RECONNECT_REPLAYED_PERMISSION');
    assert.equal((await host.submit({scope,id:'codex-extra-permission-stop',generation:run.generation,command:{type:'stop'}})).state,'acknowledged');assert.equal((await host.snapshot(scope)).phase,'stopped');assert.equal(owner.current().issue,'ownershipRetired');
    await host.close();result.status=result.limitations.length?'completed-native-attempt-with-gaps':'passed-native-extra-permissions';
    result.counts=snapshot().counts;result.rpcCounts=rpc.counts;ctx.progress?.(`Codex extra permissions: ${rootTurns} bounded roots, ${responseCalls} actual responses, ${result.limitations.length} explicit gap(s).`);return result;
  }catch(error){caughtError=error;result.status='failed-native-diagnostic';result.reason=error.message;error.partialResult=snapshot();throw error;
  }finally{
    const failures=[];for(const viewer of viewers)try{viewer.close();}catch(error){failures.push(error);}for(const bridge of bridges)try{await bridge.close();}catch(error){failures.push(error);}
    if(rpc&&!closing)try{const exit=await rpc.close();result.cleanup.nativeOwnedGroupExit=exit.ownedGroupAbsent===true;}catch(error){failures.push(error);}
    try{owner?.retire();}catch(error){failures.push(error);}try{await host?.terminate();result.cleanup.hostWriterTerminated=true;}catch(error){failures.push(error);}
    if(caughtError)caughtError.partialResult=snapshot();if(failures.length){const error=new AggregateError(failures,'EXTRA_PERMISSION_CLEANUP_INCOMPLETE');result.cleanup.failures=failures.map(item=>item.message);error.partialResult=snapshot();throw error;}
  }
}
