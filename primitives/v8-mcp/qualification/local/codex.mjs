import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CodexInteractionRpc} from '../../../v8-interactions/qualification/live/codex-rpc.mjs';
import {readFixtureLog} from './fixture-server.mjs';

const SERVER_STDIO='v8_mcp_stdio',SERVER_HTTP='v8_mcp_http',SERVER_FAILED='v8_mcp_unavailable';
const TEXT='V8_MCP_CONFIRMED',MESSAGE='Confirm the owned V8 MCP fixture',DEFAULTS={approval:'on-request',sandbox:'danger-full-access'};
const ALLOWED=new Set(['initialize','thread/start','mcpServerStatus/list','mcpServer/tool/call']);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const asKey=(thread,id)=>JSON.stringify([thread,typeof id,id]);
function texts(value){assert.ok(Array.isArray(value?.content));return value.content.filter(item=>item?.type==='text'&&typeof item.text==='string').map(item=>item.text).join('\n');}
function local(value){const url=new URL(value);assert.ok(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!url.username&&!url.password);return url.href;}

/** Root invokes this only inside its reviewed finite, model-free local-MCP runner. Importing launches nothing. */
export async function qualifyCodex(ctx){
 for(const path of[ctx.toolRoot,ctx.buildRoot,ctx.nativeHome,ctx.workspace,ctx.stateDirectory])assert.ok(isAbsolute(path),'FRESH_ABSOLUTE_ROOT_REQUIRED');
 assert.notEqual(resolve(ctx.nativeHome),resolve(ctx.toolRoot));assert.notEqual(resolve(ctx.workspace),resolve(ctx.toolRoot));
 assert.equal(ctx.model,'gpt-6-luna');assert.ok(ctx.key&&ctx.fixture&&isAbsolute(ctx.fixture.stdioFile)&&isAbsolute(ctx.fixture.stdioLog));
 const endpoint=local(ctx.endpoint),httpUrl=local(ctx.fixture.httpUrl),failedHttpUrl=httpUrl+'/unavailable',provider='v8-mcp-no-model';
 const load=async file=>import(pathToFileURL(join(ctx.buildRoot,'primitives',file)).href);
 const core={...await load('v8-lifecycle-default/src/session/index.js'),...await load('v8-interactions/src/index.js'),...await load('v8-mcp/src/index.js'),...ctx.core};
 const {SessionHost,InteractionOwner,InteractionWorkspace,McpOwner,McpReadPool,McpWorkspace,codexMcpReadPort}=core;
 assert.ok(SessionHost&&InteractionOwner&&InteractionWorkspace&&McpOwner&&McpReadPool&&McpWorkspace&&codexMcpReadPort);
 const require=createRequire(join(ctx.toolRoot,'package.json')),packageFile=require.resolve('@openai/codex-linux-x64/package.json'),metadata=JSON.parse(await readFile(packageFile,'utf8')),generic=JSON.parse(await readFile(require.resolve('@openai/codex/package.json'),'utf8'));
 assert.equal(generic.version,'0.162.1','PINNED_APPLICATION_CODEX_REQUIRED');
 assert.equal(metadata.version,'0.162.1-linux-x64','PINNED_APPLICATION_CODEX_PLATFORM_REQUIRED');
 assert.equal(generic.optionalDependencies?.['@openai/codex-linux-x64'],'npm:@openai/codex@0.162.1-linux-x64','PINNED_APPLICATION_CODEX_PLATFORM_ALIAS_REQUIRED');
 const binary=join(packageFile,'../vendor/x86_64-unknown-linux-musl/bin/codex');
 const config=['model = "gpt-6-luna"','model_provider = "'+provider+'"','approval_policy = "on-request"','sandbox_mode = "danger-full-access"',
  '[model_providers.'+provider+']','name = "Owned MCP qualification; inference forbidden"','base_url = '+JSON.stringify(endpoint),'wire_api = "responses"','env_key = "V8_MCP_DUMMY_KEY"','requires_openai_auth = false','request_max_retries = 0','stream_max_retries = 0',
  '[mcp_servers.'+SERVER_STDIO+']','command = '+JSON.stringify(process.execPath),'args = '+JSON.stringify([ctx.fixture.stdioFile,'--stdio','--log',ctx.fixture.stdioLog]),'startup_timeout_sec = 15','tool_timeout_sec = 30',
  '[mcp_servers.'+SERVER_HTTP+']','url = '+JSON.stringify(httpUrl),'startup_timeout_sec = 15','tool_timeout_sec = 30',
  '[mcp_servers.'+SERVER_FAILED+']','url = '+JSON.stringify(failedHttpUrl),'startup_timeout_sec = 3','tool_timeout_sec = 5'].join('\n')+'\n';
 await mkdir(ctx.nativeHome,{recursive:true,mode:0o700});await writeFile(join(ctx.nativeHome,'config.toml'),config,{mode:0o600,flag:'wx'});
 const result={harness:'codex',status:'running',passed:false,modelFree:true,pin:'0.162.1',cases:{},counts:{requests:0,responses:0,processStarts:0,notifications:0,inventoryRequests:0,bodyReads:0,modelRequests:0},cleanup:{},limitations:[]};
 const scope={connection:'v8-mcp-local',principal:'finite-owner',host:'owned-codex',session:'mcp-local-root'};
 let rpc,host,interactions,viewerA,viewerB,mcp,workspaceA,workspaceB,run,liveRun,activeCall,fatal,cleanupPromise;
 const pending=new Map(),answerTasks=new Set(),resolved=new Set(),notifications=new Map();let answerOrdinal=0;
 const record=(name,value)=>ctx.record('codex-mcp-'+name,value);
 const admit=label=>{assert.ok(result.counts.requests+result.counts.responses+result.counts.processStarts<64,'CODEX_NATIVE_ADMISSION_BOUND');(ctx.admit??((kind,label)=>ctx.allowance.admit(kind,label)))('codex',label);};
 const fail=error=>{fatal??=error;rpc?.rejectObservation(error);};
 async function until(predicate,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(fatal)throw fatal;if(rpc?.failure)throw rpc.failure;if(await predicate())return;await sleep(20);}throw Error('CODEX_MCP_WAIT_EXPIRED:'+label);}
 async function request(method,params,label=method){assert.ok(ALLOWED.has(method),'MODEL_OR_MANAGEMENT_RPC_FORBIDDEN');admit(label);result.counts.requests++;if(method==='mcpServerStatus/list')result.counts.inventoryRequests++;return rpc.request(method,params,30000);}
 async function answer(held){
  await until(()=>viewerA&&viewerB,'response viewers');
  await Promise.all([viewerA.refresh(scope),viewerB.refresh(scope)]);
  const response={type:'codex.elicitation',action:'accept',content:{confirmation:TEXT}},operation='codex-mcp-form-'+(++answerOrdinal);
  const receipt=await viewerA.answer(scope,held.prompt,response,operation).result;assert.equal(receipt.state,'acknowledged');assert.equal((await host.receipt(scope,operation))?.state,'acknowledged');
  await until(()=>held.resolved,'exact elicitation settlement');record('form-answer',{operation,originalReceipt:true,delivery:'submitted',exactNativeResolved:true});
 }
 function reverse(message){try{
  assert.equal(message.method,'mcpServer/elicitation/request','UNEXPECTED_NATIVE_CONFIRMATION');
  const p=message.params;assert.ok(run&&interactions&&activeCall?.tool==='elicit');assert.equal(p.threadId,run.nativeSession);assert.equal(p.serverName,activeCall.server);assert.equal(p.mode,'form');assert.equal(p.message,MESSAGE);
  assert.equal(p.requestedSchema?.type,'object');assert.deepEqual(p.requestedSchema.required,['confirmation']);assert.deepEqual(Object.keys(p.requestedSchema.properties??{}),['confirmation']);assert.equal(p.requestedSchema.properties.confirmation.type,'string');
  const key=asKey(p.threadId,message.id);assert.ok(!pending.has(key),'DUPLICATE_ELICITATION_ORIGINAL');assert.ok(pending.size<4);
  const prompt=interactions.registerCodex({token:{},requestId:JSON.stringify(message.id),owner:{nativeAgent:run.nativeSession,relation:'root'},method:message.method,params:p,respond:async value=>{admit('elicitation-response');result.counts.responses++;return rpc.respond(message.id,value);}});
  const held={prompt,resolved:resolved.has(key)};pending.set(key,held);if(held.resolved)interactions.completed(prompt.id,run);
  let task;task=answer(held).catch(fail).finally(()=>answerTasks.delete(task));answerTasks.add(task);
 }catch(error){fail(error);}}
 function observe(message){try{
  assert.ok(result.counts.notifications++<4096,'CODEX_MCP_NOTIFICATION_BOUND');notifications.set(message.method,(notifications.get(message.method)??0)+1);const p=message.params??{};
  assert.ok(!['turn/started','turn/completed','item/agentMessage/delta'].includes(message.method),'MODEL_WORK_FORBIDDEN');
  if(message.method==='serverRequest/resolved'){const key=asKey(p.threadId,p.requestId);resolved.add(key);rpc.resolved(p.requestId);const held=pending.get(key);if(held){held.resolved=true;interactions.completed(held.prompt.id,run);}}
  if(message.method==='mcpServer/startupStatus/updated'&&mcp&&p.threadId===run.nativeSession&&[SERVER_STDIO,SERVER_HTTP,SERVER_FAILED].includes(p.name)){mcp.invalidate(run);record('native-status',{server:p.name,status:p.status});}
  if(/oauth.*completed|oauth.*login/i.test(message.method))throw Error('OAUTH_OUTSIDE_LOCAL_SCOPE');
 }catch(error){fail(error);}}
 async function call(server,tool,args,scenario){
  assert.ok(!activeCall,'SERIAL_NATIVE_TOOL_OWNERSHIP');activeCall={server,tool};try{const value=await request('mcpServer/tool/call',{threadId:run.nativeSession,server,tool,arguments:args},scenario);
   await Promise.all([...answerTasks]);if(fatal)throw fatal;const text=texts(value);assert.ok(text.length<=4096&&text.startsWith('V8_MCP_'),'UNEXPECTED_FIXTURE_TOOL_BODY');record('tool-result',{server,tool,isError:value.isError===true,text});return{value,text};
  }finally{activeCall=null;}
 }
 try{
  const environment={PATH:process.env.PATH??'/run/current-system/sw/bin',LANG:'C.UTF-8',HOME:ctx.nativeHome,CODEX_HOME:ctx.nativeHome,XDG_CONFIG_HOME:join(ctx.nativeHome,'xdg-config'),XDG_CACHE_HOME:join(ctx.nativeHome,'xdg-cache'),XDG_DATA_HOME:join(ctx.nativeHome,'xdg-data'),V8_MCP_DUMMY_KEY:ctx.key};
  admit('native-process-start');result.counts.processStarts++;rpc=new CodexInteractionRpc({binary,args:['app-server','--stdio'],workspace:ctx.workspace,environment,onNotification:observe,onServerRequest:reverse});ctx.registerNativeCleanup(cleanupNative);await rpc.ready();
  const initialized=await request('initialize',{clientInfo:{name:'multiplex_v8_mcp_local',version:'0.0.0'},capabilities:{experimentalApi:true}});assert.match(initialized.userAgent??'',/\b0\.162\.1(?![\d.])/);admit('initialized-notification');result.counts.requests++;rpc.notify('initialized');
  const port={kind:'codex',placement:'dedicated',capabilities:{commands:['answer'],fullStop:true,openAndWait:true},catalog:async()=>({available:true,choices:[{model:ctx.model,efforts:[]}]}),inspect:async()=>liveRun??null,start:async(input,emitNative)=>{
   assert.equal(input.nativeSession,null);assert.equal(input.continuePendingWork,false);
   const started=await request('thread/start',{model:ctx.model,modelProvider:provider,cwd:ctx.workspace,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:'danger-full-access',ephemeral:true});
   assert.equal(started.model,ctx.model);assert.equal(started.modelProvider,provider);assert.equal(started.approvalPolicy,'on-request');assert.equal(started.approvalsReviewer,'user');assert.equal(started.sandbox?.type,'dangerFullAccess');
   run={scope,generation:input.generation,nativeSession:started.thread.id};interactions=new InteractionOwner({run,kind:'codex',epoch:1});interactions.certifyBaseline({run,complete:true,continuous:true});
   liveRun=interactions.wrap({run:{run,selection:{kind:'codex',model:ctx.model,access:DEFAULTS},interactionsComplete:true,interactions:[],stop:async()=>{await cleanupNative();assert.equal(result.cleanup.ownedGroupAbsent,true);return{run,state:'stopped',scope:'nativeTree',noAutomaticContinuation:true};},invoke:async()=>{throw Error('NO_SEND_OR_NATIVE_MANAGEMENT_IN_MCP_QUALIFICATION');}},emit:emitNative});return liveRun;
  }};
  host=await SessionHost.open({directory:join(ctx.stateDirectory,'codex-mcp-session'),scope,port,policy:{kind:'codex',provider:'configured',access:DEFAULTS},observationMs:30000});
  assert.equal((await host.submit({scope,id:'codex-mcp-create',generation:0,command:{type:'create'}})).state,'acknowledged');
  viewerA=new InteractionWorkspace({port:interactions,session:host});viewerB=new InteractionWorkspace({port:interactions,session:host});await Promise.all([viewerA.bind(scope),viewerB.bind(scope)]);
  const reads=new McpReadPool({maxActive:2,maxObservers:4});mcp=new McpOwner({run,epoch:(await host.snapshot(scope)).epoch,native:codexMcpReadPort({request}),reads});
  workspaceA=new McpWorkspace({connection:scope.connection,principal:scope.principal,port:mcp});workspaceB=new McpWorkspace({connection:scope.connection,principal:scope.principal,port:mcp});
  const beforeBind=result.counts.inventoryRequests;await Promise.all([workspaceA.bind(run,'codex'),workspaceB.bind(run,'codex')]);assert.equal(result.counts.inventoryRequests,beforeBind);
  const abort=new AbortController(),beforeRead=result.counts.inventoryRequests,a=workspaceA.refresh(run,{signal:abort.signal}),b=workspaceB.refresh(run);abort.abort();await assert.rejects(a,error=>error.code==='CANCELLED');let initial=await b;
  assert.equal(result.counts.inventoryRequests,beforeRead+1);assert.equal(initial.kind,'codex');assert.equal(initial.management,'unavailable-no-original-command');assert.equal(initial.coverage,'enumerated');
  const ready=value=>[SERVER_STDIO,SERVER_HTTP].every(name=>value.servers.some(server=>server.name===name&&server.runtimeStatus==='connected'&&server.toolCount>=5))&&value.servers.some(server=>server.name===SERVER_FAILED&&server.runtimeStatus==='failed');
  for(let attempt=1;attempt<4&&!ready(initial);attempt++){await sleep(150);initial=await workspaceB.refresh(run);}
  assert.ok(ready(initial),'FIXTURE_CONNECTED_AND_FAILED_INVENTORY_NOT_OBSERVED');
  result.cases.inventory={status:'passed',actualOwnerWorkspace:true,transports:['stdio','http'],coalescedReads:1,bindReads:0,cancelledViewerDidNotCancelOwner:true,failedServer:true,maximumReadinessAcquisitions:4};
  for(const server of[SERVER_STDIO,SERVER_HTTP]){
   const echo=await call(server,'echo',{text:'codex'},server+'-echo');assert.equal(echo.value.isError??false,false);assert.equal(echo.text,'V8_MCP_ECHO:codex');
   const failure=await call(server,'fail',{},server+'-fail');assert.equal(failure.value.isError,true);assert.equal(failure.text,'V8_MCP_EXPECTED_ERROR');
   const initialCount=(await mcp.snapshot(run)).servers.find(item=>item.name===server).toolCount;
   const changed=await call(server,'change_tools',{},server+'-change-tools');assert.equal(changed.value.isError??false,false);assert.match(changed.text,/^V8_MCP_GENERATION:\d+$/);
   const generation=Number(changed.text.split(':').at(-1));
   const extra=await call(server,'extra',{},server+'-extra');assert.equal(extra.value.isError??false,false);assert.equal(extra.text,'V8_MCP_EXTRA:'+generation);
   // Broad inventory creates independent discovery clients on this pin. The
   // named native request is the documented way to reuse the thread client.
   // Keep it a separate direct qualification probe, not an N+1 product refresh.
   const startsBefore=(await readFixtureLog(ctx.fixture.stdioLog)).filter(event=>event.event==='start').length;
   const initializesBefore=ctx.fixture.snapshot().events.filter(event=>event.event==='initialize').length;
   const named=await request('mcpServerStatus/list',{threadId:run.nativeSession,serverName:server,detail:'toolsAndAuthOnly',cursor:null,limit:32},server+'-live-tools');
   assert.ok(Array.isArray(named.data)&&named.data.length===1&&named.data[0].name===server&&named.nextCursor===null,'NAMED_MCP_DISCOVERY_SCOPE_MISMATCH');
   assert.equal(named.data[0].toolsError,null);const namedCount=Object.keys(named.data[0].tools).length;
   const startsAfter=(await readFixtureLog(ctx.fixture.stdioLog)).filter(event=>event.event==='start').length;
   const initializesAfter=ctx.fixture.snapshot().events.filter(event=>event.event==='initialize').length;
   const liveCatalog=namedCount>initialCount,reused=startsBefore===startsAfter&&initializesBefore===initializesAfter;
   record('catalog-scope',{server,initialDiscoveryCount:initialCount,namedCount,liveCatalog,namedReusedThreadClient:reused});
   if(!liveCatalog||!reused)result.limitations.push(server+': named native inventory did not prove live catalog continuity');
   const broad=await workspaceB.refresh(run);assert.equal(broad.servers.find(item=>item.name===server)?.toolCount,initialCount,'INDEPENDENT_DISCOVERY_FIXTURE_STATE_CHANGED');
   const beforeResponses=result.counts.responses,form=await call(server,'elicit',{},server+'-elicit');
   result.cases[server]={status:liveCatalog&&reused?'passed':'partial',nativeEcho:true,nativeToolError:true,liveCatalog, namedReusedThreadClient:reused,broadDiscoveryIndependent:true,extraTool:true,elicitation:form.value.isError===true?'unsupported':'passed'};
   if(form.value.isError===true){assert.equal(form.text,'V8_MCP_ELICIT_UNSUPPORTED');assert.equal(result.counts.responses,beforeResponses);result.limitations.push(server+': native MCP client did not advertise form elicitation support');}
   else{assert.equal(form.text,'V8_MCP_ELICIT:accept:'+TEXT);assert.equal(result.counts.responses,beforeResponses+1);assert.equal(interactions.current().items.length,0);}
  }
  const wait=call(SERVER_STDIO,'wait',{ms:200},'stdio-wait-through-viewer-detach');workspaceA.close();workspaceB.close();const waited=await wait;assert.equal(waited.text,'V8_MCP_WAIT:200');assert.equal(waited.value.isError??false,false);
  workspaceA=new McpWorkspace({connection:scope.connection,principal:scope.principal,port:mcp});const beforeRebind=result.counts.inventoryRequests;await workspaceA.bind(run,'codex');assert.equal(result.counts.inventoryRequests,beforeRebind);assert.ok(workspaceA.entry(run).getSnapshot().snapshot.servers.length>=2);
  result.cases.viewerLifetime={status:'passed',nativeToolCompletedAfterAllMcpViewersDetached:true,retainedRebindWithoutNativeRead:true};
  assert.equal((await host.submit({scope,id:'codex-mcp-stop',generation:run.generation,command:{type:'stop'}})).state,'acknowledged');assert.equal((await host.snapshot(scope)).phase,'stopped');mcp.retire();
  result.passed=result.limitations.length===0;result.status=result.passed?'passed-native-local-mcp-subset':'partial-native-local-mcp-subset';
 }catch(error){result.status='failed-native-diagnostic';result.passed=false;result.reason=fatal?.message??error.message;record('failure',{reason:result.reason});}
 finally{
  workspaceA?.close();workspaceB?.close();viewerA?.close();viewerB?.close();mcp?.retire();interactions?.retire();
  try{await cleanupNative();}catch(error){result.status='failed-native-diagnostic';result.passed=false;result.cleanup.error=error.message;}
  try{await host?.terminate();result.cleanup.hostWriterTerminated=true;}catch{result.status='failed-native-diagnostic';result.passed=false;result.cleanup.hostWriterTerminated=false;}
  result.notifications=Object.fromEntries(notifications);result.rpcCounts=rpc?.counts??null;record('result',result);
 }
 return result;
 function cleanupNative(){if(cleanupPromise)return cleanupPromise;cleanupPromise=(async()=>{if(rpc){const exit=await rpc.close();result.cleanup.ownedGroupAbsent=exit.ownedGroupAbsent===true;assert.equal(result.cleanup.ownedGroupAbsent,true);}else result.cleanup.ownedGroupAbsent=true;
  const events=await readFixtureLog(ctx.fixture.stdioLog),starts=events.filter(event=>event.event==='start'&&event.transport==='stdio');assert.ok(starts.length<=8,'OWNED_STDIO_PROCESS_BOUND');if(result.cases.inventory?.status==='passed')assert.ok(starts.length>=1,'OWNED_STDIO_PROCESS_IDENTITY_NOT_OBSERVED');
  const originalExecuting=async original=>{assert.ok(Number.isSafeInteger(original.pid)&&original.pid>0&&typeof original.start==='string','OWNED_STDIO_IDENTITY_REQUIRED');try{const stat=await readFile('/proc/'+original.pid+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');return fields[19]===original.start&&!['Z','X'].includes(fields[0]);}catch(error){if(error.code==='ENOENT')return false;throw error;}};
  for(const original of starts){for(let check=0;check<100&&await originalExecuting(original);check++)await sleep(20);assert.equal(await originalExecuting(original),false,'OWNED_STDIO_CLI_STILL_EXECUTING');}
  result.cleanup.fixtureCliStarts=starts.length;result.cleanup.fixtureCliOriginalsExited=true;result.cleanup.fixtureCloseNotifications=events.filter(event=>event.event==='stop'&&event.transport==='stdio').length;
 })();void cleanupPromise.catch(()=>{});return cleanupPromise;}
}
