import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {bounded,until} from '../../../v8-interactions/qualification/live/support.mjs';
import {qualifyIntegration} from './integration.mjs';
import {limits,ownedCommands,createSetupCustody,snapshotObservation,receiptObservation,errorObservation,recoveryObservation,persistedJournalUnavailable,knownUnsentResumeUnavailable} from './support.mjs';

const delay=ms=>new Promise(done=>setTimeout(done,ms));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return{promise,resolve}};
const policy=kind=>kind==='codex'?{kind,provider:'copilot-only',access:{approval:'on-request',sandbox:'danger-full-access'}}:{kind,provider:'copilot-only',permissions:'manual'};
const original=(scope,generation,type)=>({scope,id:`model-free-${type}-${randomUUID()}`,generation,command:{type}});

/** Real native factories/containers/SDK only. Dependency wrapping below observes
 * actual control results and holds an actual custody callback; it fabricates no
 * native request, response, event, ID, certificate observation or provider text. */
export async function qualifyNativeHost(ctx){
 const {kind,core,tools}=ctx,seeded=ctx.profile==='luna-seed',integration=ctx.profile==='live-integration',maxPages=ctx.maxPages??limits.maxPages;
 assert.ok(Number.isSafeInteger(maxPages)&&maxPages>0&&maxPages<=(integration?(kind==='copilot'?64:16):seeded&&kind==='copilot'?16:3));
 const result={kind,profile:ctx.profile,status:'running',cases:{},cleanup:{},counts:{roots:0,readPortCalls:0,sends:0},limitations:[integration?'Finite prepared-input/tool/question/completed-Resume/root-Stop subset; Codex child Stop and interrupted Resume stay unqualified.':seeded?'One completed original Send per fresh dedicated root; interrupted tools, pending work and children remain unqualified.':'Only fresh unsent dedicated sessions; pending tool/child continuation remains a live-matrix boundary.','SDK/native internal IPC count is not measured; explicit probe groups, page reads and owned container controls are bounded separately.',seeded?'Native cold paging is finite; an available edge at the page cap remains explicitly incomplete.':'Fresh empty native history cannot qualify nonempty older-page joining.','P14 remains unqualified.']};
 const commands=ownedCommands(core.dockerCommands(ctx.docker),integration?{maxCalls:384}:{});
 const held=[],hosts=new Set(),bridges=new Set(),readers=new Set(),listenerClosers=new Set(),setup=createSetupCustody();let accepting=true,closing,persistedUnavailable=false;
 const diagnostics=stage=>{for(const item of held)if(typeof item.runtime?.diagnostics==='function')try{ctx.record('native-runtime-diagnostic',{stage,role:item.early?'pre-id':'main',observation:item.runtime.diagnostics()})}catch{/* RAM diagnostics cannot interrupt exact cleanup. */}};
 const cleanup=()=>closing??=(async()=>{
  accepting=false;setup.seal();commands.beginCleanup?.();for(const value of held)value.release.resolve();
  const outcomes=await Promise.allSettled([
   ...[...bridges].map(value=>value.close()),
   ...[...readers].map(value=>value.close()),
   ...held.map(value=>value.runtime?.close()),
   ...[...listenerClosers].map(close=>close()),setup.settle(),
  ]);
  const journals=await Promise.allSettled([...hosts].map(host=>host.terminate()));
  diagnostics('after-cleanup');
  result.cleanup={resources:outcomes.every(value=>value.status==='fulfilled'),journals:journals.every(value=>value.status==='fulfilled')};Object.assign(result.cleanup,await commands.proveAbsent());
  assert.ok(result.cleanup.resources&&result.cleanup.journals,'Owned native cleanup failed');
 })();
 ctx.registerNativeCleanup(cleanup);ctx.admit('owned-cleanup');
 const probe=async(label,work,timeoutMs=45000)=>{assert.ok(accepting);ctx.admit(label);ctx.check();const value=await bounded(Promise.resolve().then(work),Math.min(timeoutMs,ctx.workDeadline-Date.now()),`native:${kind}:${label}`);ctx.check();return value};
 async function runtime(name,early=false,extra={}){
  assert.equal(accepting,true,'Native setup is retired');
  const base=join(ctx.directory,name),home=join(base,'home'),cwd=join(base,'workspace'),launch=join(base,'launch');for(const path of[base,home,cwd,launch])await mkdir(path,{recursive:true,mode:0o700});assert.equal(accepting,true,'Native setup is retired');
  const scope={connection:ctx.connection,principal:'native-model-free-owner',host:`native-${kind}`,session:`${name}-${randomUUID()}`},release=deferred(),published=deferred();
  let value;const stderr=[];let stderrBytes=0,quietCompleted=false;
  const item={runtime:undefined,release,published,scope,base,cwd,early,stderr,name,markCompleted(){assert.ok((seeded||integration)&&!early);quietCompleted=true},markSeedCompleted(){assert.ok(seeded&&!early);quietCompleted=true}};held.push(item);
  const catalog=async()=>({available:true,choices:[{model:ctx.model,...(kind==='copilot'?{providerId:ctx.provider}:{}),efforts:['low']}]});
  if(kind==='codex'){
   value=core.createCodexRuntime({directory:launch,home,cwd,binary:tools.codexBinary,packageRoot:tools.codexPackage,model:ctx.model,environment:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',MULTIPLEX_V8_MODEL_FREE_KEY:ctx.key},provider:{id:ctx.provider,baseUrl:ctx.endpoint,environmentKey:'MULTIPLEX_V8_MODEL_FREE_KEY',copilotOnly:true},catalog,docker:ctx.docker,commands,...(seeded||integration?{multiAgent:false}:{}),
    wire:input=>core.spawnCodexWire(input,bytes=>{if(stderrBytes<4096){const part=Buffer.from(bytes).subarray(0,4096-stderrBytes);stderr.push(Buffer.from(part));stderrBytes+=part.length}}),
    certifyOpenAndWait:async(input,run)=>{
     // A fresh opening, or the exact completed seed below, is the only admitted
     // boundary. These native samples cannot certify arbitrary pending work.
     ctx.check();const a=await value.readControlState(run);await delay(200);ctx.check();const b=await value.readControlState(run);
     for(const state of[a,b]){assert.equal(state.status.type,'idle','Native control state was not idle');assert.equal(state.connected,true);assert.equal(state.pendingReverse,0);assert.equal(state.ambiguousReverse,false);assert.equal(state.turnStarts,0);assert.equal(state.itemStarts,0)}
     const completedSeed=(seeded||integration)&&quietCompleted&&!early;
     result.cases.controlBoundary??=[];result.cases.controlBoundary.push({fresh:input.nativeSession===null,samples:[a,b],quietMs:200,noNewSends:true,scope:completedSeed?(integration?'completed-owned-main-no-children':'completed-owned-seed-no-children'):'fresh-unsent-model-free-only'});
     return{run,noAutomaticContinuation:true,callbacksComplete:input.nativeSession===null||completedSeed,continuous:true};
    }});
  }else value=await setup.acquire(()=>core.createCopilotRuntime({scope,nativeHome:home,cwd,launchDirectory:launch,cliBinary:tools.copilotBinary,cliPackageRoot:tools.copilotPackage,model:ctx.model,...(integration?{modelCapabilities:{supports:{vision:true}}}:{}),provider:{id:ctx.provider,copilotOnly:true,config:{type:'openai',wireApi:'responses',transport:'http',baseUrl:ctx.endpoint,apiKey:ctx.key,modelId:ctx.model,wireModel:ctx.model}},catalog,docker:ctx.docker,readerLifetimeMs:60000,...(seeded?{sessionOptions:{availableTools:[],excludedTools:[]}}:{}),...(extra.sessionOptions?{sessionOptions:extra.sessionOptions}:{}),...(extra.beforeTool?{beforeTool:extra.beforeTool}:{})},{commands}),value=>value.close(),value=>{item.runtime=value});
  item.runtime=value;
  assert.equal(typeof value.close,'function','Actual runtime must expose owned cleanup');

  const controller=new Proxy(value.controller,{get(target,key){
   if(key==='observe'&&extra.onCapture)return listener=>target.observe(capture=>{extra.onCapture(capture);listener(capture)});
   if(key==='openAndWait'&&early)return(input,emit,onOwned,onOpening)=>target.openAndWait(input,emit,onOwned,async opening=>{await onOpening?.(opening);published.resolve();await release.promise});
   const property=Reflect.get(target,key,target);return typeof property==='function'?property.bind(target):property;
  }});
  const options={scope,directory:join(base,'host'),cwd,controller,nativeInputRoots:value.nativeInputRoots,policy:policy(kind),history:{...(integration?{limits:{count:1,maxCalls:maxPages,maxEpisodes:maxPages}}:{}),port:(run,attached)=>{
    ctx.private(run.nativeSession);const port=value.history.port(run,attached);return{scope:port.scope,mode:port.mode,...(port.context===undefined?{}:{context:port.context}),read:async(request,assertCurrent)=>{assert.ok(++result.counts.readPortCalls<=maxPages,'Native page read cap exceeded');ctx.check();try{return await port.read(request,assertCurrent)}catch(error){
    const unavailable=kind==='copilot'&&port.mode==='persisted'&&persistedJournalUnavailable(error,run.nativeSession);if(unavailable)persistedUnavailable=true;
    ctx.record('native-history-read-error',{mode:port.mode,page:result.counts.readPortCalls,cursorPresent:request.cursor!==null,error:unavailable?{code:'UNAVAILABLE',category:'persistedJournalUnavailable'}:errorObservation(error,ctx.safeError)});throw error}}};
  }},observationMs:1000};
  item.options=options;item.host=await openHost(options);return item;
 }
 async function openHost(options){return setup.acquire(()=>core.openHost(options),host=>host.terminate(),host=>hosts.add(host))}
 async function openReader(work){return setup.acquire(work,reader=>reader.close(),reader=>readers.add(reader))}
 async function bridge(item){
  assert.equal(accepting,true,'Native setup is retired');
  const {scope}=item,target={...scope,authority:'native-model-free',owner:`owner-${randomUUID()}`,routeEpoch:randomUUID()},coordinator=new core.GatewayCoordinator();
  coordinator.register({target,session:item.host.session,history:item.host.history,interactions:item.host.interactions,mcp:item.host.mcp,files:{port:item.host.files,scope:()=>item.host.fileScope()},controlCatalog:()=>item.host.controlCatalog(),binding:()=>item.host.binding(),authorizeHistory:attached=>{try{item.host.history.snapshot(attached);return attached.origin.connection===scope.connection&&attached.origin.principal===scope.principal&&attached.origin.host===scope.host}catch{return false}}});
  const authorization=`Bearer ${randomBytes(32).toString('hex')}`,identity={connection:scope.connection,principal:scope.principal,authorities:[target.authority],actions:['read','control','fileWrite']};
  let closeListener;const listener=await setup.acquire(()=>core.listenLoopback(coordinator,async token=>token===authorization?identity:null),listener=>listener.close(),listener=>{let closed;closeListener=()=>closed??=listener.close();listenerClosers.add(closeListener)});
  assert.equal(accepting,true,'Native setup is retired');const transport=new core.HttpGatewayTransport({url:listener.url,authorization}),history=new core.HistoryWorkspace({connection:scope.connection,principal:scope.principal});
  const client=new core.GatewayClient({transport,history,targets:[target],onFence:()=>{}}),sessions=new core.SessionWorkspace({port:client,history});let observation,lease,binding,closed=false;
  const api={target,client,transport,history,sessions,browserConfiguration:()=>({url:listener.url,authorization,target,scope}),async bind(){
   binding=await transport.binding(target);assert.ok(binding);ctx.private(binding.run.nativeSession);const retained=await sessions.bind(scope,binding.history);lease=sessions.select(scope);observation=client.observeHistory(scope,binding.history);await until(()=>retained.history.client.current,'retained-native-history',5000);return{binding,retained,view:lease.view};
  },async rebind(){
   const next=await transport.binding(target);assert.ok(next);ctx.private(next.run.nativeSession);observation?.release();const retained=await sessions.rebind(scope,next.history);binding=next;observation=client.observeHistory(scope,next.history);await until(()=>retained.history.client.current,'rebound-native-history',5000);return{binding,retained,view:lease.view};
  },async close(){if(closed)return;closed=true;lease?.release();observation?.release();sessions.close();client.close();coordinator.close();await closeListener()}};

  bridges.add(api);return api;
 }
 async function send(item,connection,type){const request=original(item.scope,(await connection.client.snapshot(item.scope)).generation,type);const observed=await connection.client.submit(request);assert.equal(request.command.type=== 'send',false);return{request,observed}}
 async function ack(item,connection,operation){
  let receipt=operation.observed;
  try{return await until(async()=>{receipt=await connection.client.receipt(item.scope,operation.request.id);if(receipt?.state==='refused')throw Error(`Native ${operation.request.command.type} refused`);return receipt?.state==='acknowledged'?receipt:null},`native-${operation.request.command.type}-receipt`,30000)}
  catch(error){
   let snapshot=null,snapshotRead='unavailable';
   try{snapshot=await bounded(connection.client.snapshot(item.scope),Math.max(1,Math.min(1500,ctx.workDeadline-Date.now())),'Native acknowledgement diagnostic snapshot');if(snapshot.nativeSession)ctx.private(snapshot.nativeSession);snapshotRead='value'}catch{/* Diagnostic read cannot replace the original failure. */}
   ctx.record('original-ack-diagnostic',{original:{id:operation.request.id,type:operation.request.command.type,generation:operation.request.generation},observedReceipt:receiptObservation(receipt),snapshotRead,snapshot:snapshotObservation(snapshot)});
   throw error;
  }
 }
 async function seed(item,connection,bound){
  assert.ok(seeded&&!item.early);assert.match(ctx.seedMarker,/^V8_SEED_(codex|copilot)_[a-f0-9]{32}$/);
  const text=`Reply with exactly ${ctx.seedMarker}. Do not use tools or delegate.`,gate=deferred();
  const request=Object.freeze({scope:item.scope,id:`seed-send-${randomUUID()}`,generation:bound.binding.run.generation,command:Object.freeze({type:'send',text})});
  const operation={request,observed:null};
  // Freeze/admit this one original before dispatch. Hold only delivery to this
  // harness: the genuine HTTP/Host/native request and stream run normally.
  // Even an unavailable submit reply is reconciled by exact receipt reads only.
  ctx.admitSend('seed-original');assert.equal(++result.counts.sends,1);
  let sawWorking=false,sawTerminalIdle=false,unexpectedWork=false;
  const unobserve=bound.retained.history.client.subscribe(()=>{
   const current=bound.retained.history.client.current;if(!current)return;
   if(current.activity.state==='working')sawWorking=true;
   if(sawWorking&&current.activity.state==='idle')sawTerminalIdle=true;
   if(current.rows.some(row=>row.kind==='tool'||row.kind==='delegation'))unexpectedWork=true;
  });
  const delivered=connection.client.submit(request).then(receipt=>gate.promise.then(()=>({receipt})),error=>gate.promise.then(()=>({error})));
  try{
   const receipt=await ack(item,connection,operation);assert.equal(receipt.outcome?.status,'accepted');
   const nativeOriginal=kind==='codex'?receipt.outcome.detail?.turnId:receipt.outcome.detail?.messageId;
   assert.ok(typeof nativeOriginal==='string'&&nativeOriginal.length>0);ctx.private(nativeOriginal);
   const captured=await until(()=>{
    ctx.check();assert.equal(result.counts.readPortCalls,0,'Live seed evidence must precede every native history read');
    const current=bound.retained.history.client.current,native=bound.retained.getSnapshot().native;if(!current||!native)return null;
    assert.equal(unexpectedWork,false,'Seed cannot expand into tools or children');
    const user=current.rows.find(row=>row.kind==='user'&&row.body.kind==='complete'&&row.body.text===text&&row.lifecycle==='completed');
    const assistant=current.rows.find(row=>row.kind==='assistant'&&row.body.kind==='complete'&&row.body.text.trim()===ctx.seedMarker&&row.lifecycle==='completed');
    if(!user||!assistant||!sawTerminalIdle||current.activity.state!=='idle'||native.activity!=='idle')return null;
    if(kind==='codex'){
     assert.equal(user.native.turnId,nativeOriginal);assert.equal(assistant.native.turnId,nativeOriginal);assert.equal(current.activity.turnId,nativeOriginal);
    }else{
     if(user.native.messageId!==undefined)assert.equal(user.native.messageId,nativeOriginal);
     if(assistant.native.originatingMessageId!==undefined)assert.equal(assistant.native.originatingMessageId,nativeOriginal);
    }
    return{user,assistant};
   },'native-seed-user-assistant-terminal',Math.max(1,Math.min(110000,ctx.workDeadline-Date.now())));
   item.markSeedCompleted();
   result.cases.seed={status:'passed-native-stream-boundary',originalReceipt:request.id,oneOriginal:true,submitReplyHeldByHarness:true,readOnlyReceiptCheck:true,noResend:true,nativeAcceptance:true,userCaptured:true,assistantCaptured:true,nativeWorkingThenTerminalIdle:true,nativeBodyReadsBeforeCapture:0,tools:0,children:0};
   return captured;
  }finally{
   unobserve();gate.resolve();const returned=await bounded(delivered,Math.max(1,Math.min(1500,ctx.workDeadline-Date.now())),'seed-original-reply-release').catch(()=>null);
   ctx.record('seed-original',{original:{id:request.id,type:'send',generation:request.generation},submitReply:returned?.receipt?'returned':returned?.error?'unavailable':'pending',readOnlyChecks:true,mutationCount:result.counts.sends});
  }
 }
 try{
  if(integration){await qualifyIntegration({ctx,result,probe,runtime,bridge,send,ack,hosts,readers,commands,openHost,openReader})}
  else{
  ctx.root('fresh-main-root');result.counts.roots++;const main=await runtime('main'),wire=await bridge(main);
  const created=await probe('create',async()=>{const value=await send(main,wire,'create');await ack(main,wire,value);return value});
  let bound=await probe('retained-observers',()=>wire.bind());const firstId=bound.binding.run.nativeSession;
  const passive=commands.snapshot();const reads=result.counts.readPortCalls;wire.client.disconnect();wire.client.reconnect();bound.retained.history.setPinned(true);const other=wire.sessions.select(main.scope,'side');other.release();bound.retained.history.setPinned(false);
  assert.equal(result.counts.readPortCalls,reads);assert.equal(commands.snapshot().identified,passive.identified);ctx.check();result.cases.create={status:'passed',nativeId:true,originalReceipt:created.request.id,authenticatedHttp:true,zeroSendsAtCreate:true};
  const captured=seeded?await probe('seed-send',()=>seed(main,wire,bound),120000):null;
  const stopBeforeReader=async connection=>{const stopping=await send(main,connection,'stop');await ack(main,connection,stopping);assert.equal((await connection.client.snapshot(main.scope)).phase,'stopped')};
  if(seeded)await probe('stop-before-reader',()=>stopBeforeReader(wire));
  await probe('writer-inspection',async()=>{await wire.close();await main.host.terminate();hosts.delete(main.host);main.host=await openHost(main.options);assert.equal((await main.host.binding()).run.nativeSession,firstId);assert.equal(commands.snapshot().identified,passive.identified)});
  const restored=await bridge(main);bound=await restored.bind();assert.equal(bound.retained.history.client.current.coverage.knownStart,false);assert.equal(result.counts.readPortCalls,reads);result.cases.writerInspection={status:'passed',nativeIdPreserved:true,newObservation:true,noActivation:true};
  if(!seeded)await probe('stop-before-reader',()=>stopBeforeReader(restored));
  const saved=await main.host.binding();assert.equal(saved.run.nativeSession,firstId);
  const prepared=await probe('prepare-sessionless-reader',()=>openReader(()=>main.runtime.prepareHistoryReader(saved.run,saved.history)));
  const priorHistory=bound.retained.history.client.current;
  const recovery=await probe('cold-baseline',()=>restored.client.recover(main.scope,saved.history,{timeoutMs:10000}));ctx.record('cold-baseline-result',recoveryObservation(recovery));
  const unavailable=kind==='copilot'&&persistedUnavailable&&recovery.state==='failed'&&recovery.code==='READ_FAILED';
  if(unavailable){const retained=bound.retained.history.client.current;assert.equal(retained.coverage.knownStart,false);assert.equal(retained.olderEdge.state,'unknown');assert.deepEqual(retained.rows,priorHistory.rows);assert.deepEqual(retained.coverage.gaps,priorHistory.coverage.gaps)}
  else{assert.equal(recovery.state,'value');assert.equal(recovery.value.status,'ready');await until(()=>bound.retained.history.client.current?.olderEdge.state!=='unknown','native-baseline-publication',5000)}
  let pages=1,olderPages=0;
  await probe('bounded-older-pages',async()=>{while(!unavailable&&pages<maxPages&&bound.retained.history.client.current&&bound.view.getSnapshot().olderEdge.state==='available'){
    const token=bound.view.beginOlderRead();try{const page=await restored.client.older(main.scope,token.scope,token.cursor,token.generation);assert.equal(bound.view.applyPage(page,token),'applied');pages++;olderPages++}finally{bound.view.finishOlderRead(token)}
  }});
  assert.equal((await restored.client.snapshot(main.scope)).phase,'stopped','Native history acquisition must not activate the agent');
  const cold=bound.view.getSnapshot(),capReached=!unavailable&&pages===maxPages&&cold.olderEdge.state==='available';
  result.cases.coldHistory=unavailable?{status:'passed-exception-unavailable',nativeBodyQualified:false,category:'persistedJournalUnavailable',knownStart:false,olderEdge:'unknown',retainedRowsUnchanged:true,retainedExplicitGapsUnchanged:true,olderScope:'not-exercised-native-journal-unavailable',activityUnchanged:true,noActivation:true}:{status:seeded?'pending-native-seeded-boundary':'passed-native-model-free-boundary',pages,olderPages,capReached,olderEdge:cold.olderEdge.state,...(cold.olderEdge.state==='end'?{empty:cold.rows.length===0}:{}),olderScope:olderPages?'actual-native-cursor':'not-exercised-no-native-older-cursor',activityUnchanged:true,noActivation:true};
  if(seeded){
   assert.equal(unavailable,false,'A completed native seed must have readable persisted history');
   const recoveredUser=cold.rows.find(row=>row.id===captured.user.id),recoveredAssistant=cold.rows.find(row=>row.id===captured.assistant.id);
   const same=(a,b)=>a?.body.kind==='complete'&&a.body.text===b.body.text&&a.lifecycle===b.lifecycle;
   const userRecovered=same(recoveredUser,captured.user),assistantRecovered=same(recoveredAssistant,captured.assistant);
   Object.assign(result.cases.coldHistory,{status:userRecovered&&assistantRecovered?'passed-native-seeded-boundary':capReached?'partial-native-page-cap':'failed-native-seed-recovery',nativeBodyQualified:userRecovered&&assistantRecovered,userRecovered,assistantRecovered,sameNativeRowIdentities:!!recoveredUser&&!!recoveredAssistant,nonempty:cold.rows.length>0,fullHistoryBoundary:cold.olderEdge.state==='end'});
   assert.ok(userRecovered&&assistantRecovered,'Bounded cold history did not recover both actual captured seed rows');
  }
  await probe('close-sessionless-reader',()=>prepared.close());readers.delete(prepared);
  let partialResume=false;
  const resumeReads=result.counts.readPortCalls,beforeDiagnostics=main.runtime.diagnostics?.()??[];
  await probe('resume-without-send',async()=>{
   const resumed=await send(main,restored,'resume');
   // An exact known unsent/no-journal exception is partial evidence only. A
   // bare RPC code, a missing callback certificate, or a seeded failure cannot
   // take this branch. Keep the original unknown and Stop its exact custody.
   const checked=await until(async()=>{
    ctx.check();const receipt=await restored.client.receipt(main.scope,resumed.request.id);
    if(receipt?.state==='refused')throw Error('Native resume refused');
    if(receipt?.state==='acknowledged')return{partial:false};
    if(!seeded&&receipt?.state==='outcomeUnknown'){
     const snapshot=await restored.client.snapshot(main.scope);
     if(knownUnsentResumeUnavailable({kind,historyUnavailable:unavailable,original:resumed.request,receipt,snapshot,nativeSession:firstId,beforeDiagnostics,afterDiagnostics:main.runtime.diagnostics?.()??[]}))return{partial:true};
    }
    return null;
   },'native-resume-original-receipt',30000);
   if(checked.partial){
    partialResume=true;result.cases.resume={status:'partialResumeUnavailable',originalReceipt:resumed.request.id,originalOutcomeUnknown:true,nativeIdPreserved:true,phase:'starting',nativeResumePassed:false,classification:'unsent-native-state-unavailable-boundary',noSend:true};
   }else{
    const after=await restored.client.snapshot(main.scope);assert.equal(after.nativeSession,firstId);assert.equal(after.phase,'running');assert.equal(after.generation,saved.run.generation+1);await delay(200);ctx.check();
    const quiet=await restored.client.snapshot(main.scope);ctx.record('resumed-quiet-observation',{native:snapshotObservation(quiet),originalReceipt:resumed.request.id,quietMs:200,noNewSend:true});assert.equal(quiet.phase,'running');assert.equal(quiet.activity,'idle');assert.equal(quiet.interactionsComplete,true);assert.equal(quiet.interactions.length,0);
    result.cases.resume={status:seeded?'passed-completed-seed-boundary':'passed-fresh-unsent-boundary',originalReceipt:resumed.request.id,nativeIdPreserved:true,noNewSend:true,quietMs:200,nativeBodyReadsUnchanged:true};
   }
   assert.equal(result.counts.readPortCalls,resumeReads);assert.equal(result.counts.sends,seeded?1:0);
  });
  await probe('stop-resumed',async()=>{const value=await send(main,restored,'stop');await ack(main,restored,value)});
  ctx.root('fresh-pre-id-root');result.counts.roots++;const early=await runtime('pre-id',true),earlyWire=await bridge(early);
  const pending=earlyWire.client.submit(original(early.scope,0,'create'));await bounded(early.published.promise,20000,'early-native-custody-publication');const before=await earlyWire.client.snapshot(early.scope);assert.equal(before.phase,'starting');assert.equal(before.nativeSession,null);
  await probe('stop-pre-id-custody',async()=>{const value=await send(early,earlyWire,'stop');await ack(early,earlyWire,value)});early.release.resolve();const uncertain=await pending;assert.equal(uncertain.state,'outcomeUnknown');assert.equal((await earlyWire.client.snapshot(early.scope)).phase,'stopped');assert.equal((await earlyWire.client.snapshot(early.scope)).nativeSession,null);
  result.cases.earlyCustody={status:'passed-owned-prelaunch-boundary',actualAllocatedContainer:true,nativeId:false,originalUnknown:true,acquisitionSealed:true,notAHungRunningCliTest:true};
  assert.equal(result.counts.sends,seeded?1:0);result.counts.containerControls=commands.snapshot();result.status=seeded?'passed-native-seeded-subset':partialResume?'partial-native-model-free-subset':'passed-native-model-free-subset';
  }
 }catch(error){
  diagnostics('failure');
  if(kind==='codex')for(const item of held){const observation=item.runtime?.diagnostics?.();if(observation?.rpc?.requests?.initialize===1&&observation.rpc.responses===0&&observation.wire?.state==='closed'&&observation.wire.exitCode!==null&&observation.wire.exitCode!==0){try{ctx.record('native-startup-stderr',await ctx.privateDiagnostic('startup-stderr.log',Buffer.concat(item.stderr)))}catch{ctx.record('native-startup-stderr',{status:'unavailable'})}break}}
  result.status='failed-native-diagnostic';result.error=ctx.safeError(error);ctx.record('native-diagnostic',{error:result.error});
 }
 finally{await cleanup().catch(error=>{result.status='failed-native-diagnostic';result.cleanup.error=ctx.safeError(error)});ctx.record('native-result',result)}
 return result;
}
