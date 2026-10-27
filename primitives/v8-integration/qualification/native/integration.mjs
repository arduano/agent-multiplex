import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {bounded,until} from '../../../v8-interactions/qualification/live/support.mjs';
import {sha,recoveryObservation} from './support.mjs';

export const CHILD_NAME='v8-matrix-child',QUESTION_ANSWER='fixture-blue';
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const clean=value=>typeof value==='string'&&value.length>0&&value.length<=4096;
const quote=value=>`'${value.replaceAll("'","'\\''")}'`;
export const longCommand=marker=>`printf '%s\\n' ${quote(marker)}; i=0; while [ "$i" -lt 180 ]; do sleep 1; printf '%s\\n' ${quote(marker+'_TICK')}; i=$((i+1)); done`;
export function createChildGate({model,command,prompt,admit,violate=()=>{}}){
 let root=null,armed=false,used=false,shellUsed=false;const children=new Set();
 const deny=reason=>{violate(reason);return{deny:reason}};
 return{bindRoot(id){assert.ok(clean(id)&&root===null);root=id},observeChild(id){assert.ok(used&&clean(id)&&children.size===0);children.add(id)},arm(){assert.ok(root&&!armed&&!used);admit();armed=true},snapshot:()=>({armed,used,children:children.size}),beforeTool(input,invocation){
  try{
   if(!armed||!root||invocation.sessionId!==root)return deny('Child fixture is not admitted for this native owner.');
   if(input.toolName==='task'){
    const args=input.toolArgs;
    if(input.sessionId!==root||used||!args||args.agent_type!==CHILD_NAME||args.prompt!==prompt||args.model!==model||(args.mode!==undefined&&args.mode!=='sync')||Object.keys(args).some(key=>!['agent_type','prompt','model','mode','name','description'].includes(key)))return deny('Only one exact named child invocation is admitted.');
    used=true;return null;
   }
   if(input.toolName==='bash'&&children.has(input.sessionId)&&input.toolArgs?.command?.trim()===command&&!shellUsed){shellUsed=true;return null;}
   return deny('Only the admitted child shell invocation is permitted.');
  }catch{return deny('The child admission guard could not establish the original invocation.');}
 }};
}
export function answerFor(prompt,{question=false,commands=[]}={}){
 if(prompt.type==='copilot.permission'){
  assert.equal(prompt.request?.kind,'shell');assert.ok(commands.includes(prompt.request.fullCommandText?.trim()),'Unplanned native shell permission');
  return{type:prompt.type,kind:'approve-once'};
 }
 if(prompt.type==='codex.command'){
  const detail=prompt.detail;assert.ok(commands.includes(detail?.command?.trim()),'Unplanned Codex command permission');
  const decision=prompt.decisions.find(value=>value.decision==='accept');assert.ok(decision);return{type:prompt.type,decisionId:decision.id};
 }
 assert.ok(question,'Unexpected native confirmation category');
 const offeredBlue=options=>{const offered=options.filter(value=>value===QUESTION_ANSWER||value===QUESTION_ANSWER+' (Recommended)');assert.equal(offered.length,1,'Exact fixture-blue option was not offered unambiguously');return offered[0]};
 if(prompt.type==='copilot.question')return{type:prompt.type,answer:offeredBlue(prompt.options),wasFreeform:false};
 assert.equal(prompt.type,'codex.question');assert.ok(prompt.questions.length>0);
 return{type:prompt.type,answers:Object.fromEntries(prompt.questions.map(q=>[q.id,[offeredBlue(q.options)]]))};
}
export function createNativeEvidence(kind,model){
 assert.ok(clean(model),'Explicit allowed model required');
 const state={events:0,outputs:0,childStarts:0,childIds:new Set(),childModels:new Set(),rootModels:new Set(),tools:new Map(),questions:0,completions:[]};let childListener=()=>{};
 const leaves=value=>Array.isArray(value)?value.slice(0,10).map(leaf=>({kind:['text','terminal','shell_exit','image','audio','resource','resource_link','blob','file'].includes(leaf?.type)?leaf.type:'unknown',textPresent:typeof leaf?.text==='string',previewPresent:typeof leaf?.outputPreview==='string',outputTruncated:typeof leaf?.outputTruncated==='boolean'?leaf.outputTruncated:null,exitCode:Number.isSafeInteger(leaf?.exitCode)?leaf.exitCode:null})):null;
 return{state,onChild(fn){childListener=fn},observe(capture){
  if(capture.kind!==kind)return;assert.ok(++state.events<=8192,'Native observation bound');const e=capture.value;
  if(kind==='copilot'){
   const d=e?.data??{},agent=e?.agentId??d.agentId;
   if(e?.type==='subagent.started'){assert.equal(d.agentName,CHILD_NAME);assert.equal(++state.childStarts,1);assert.ok(clean(agent));state.childIds.add(agent);childListener(agent)}
   if(e?.type==='assistant.usage'&&typeof d.model==='string'){if(agent)assert.ok(state.childIds.has(agent),'Unproved child usage owner');assert.equal(d.model,model);(agent?state.childModels:state.rootModels).add(d.model)}
   if(e?.type==='tool.execution_start'){
    assert.ok(clean(d.toolCallId)&&state.tools.size<64);state.tools.set(JSON.stringify([agent??null,d.toolCallId]),{agent:agent??null,id:d.toolCallId,name:d.toolName,command:d.arguments?.command??null,output:'',completed:false});
   }
   if(['tool.shell_output','tool.execution_partial_result','tool.execution_complete'].includes(e?.type)){
    const tool=state.tools.get(JSON.stringify([agent??null,d.toolCallId]));if(tool){const text=e.type==='tool.shell_output'?d.text:e.type==='tool.execution_partial_result'?d.partialOutput:d.result?.detailedContent??d.result?.content;if(typeof text==='string'){state.outputs++;tool.output=(e.type==='tool.shell_output'?tool.output+text:text).slice(-16384)}if(e.type==='tool.execution_complete'){tool.completed=true;tool.success=d.success===true}}
    if(e.type==='tool.execution_complete'){assert.ok(state.completions.length<64,'Native completion diagnostic bound');state.completions.push({owner:agent?'child':'root',success:typeof d.success==='boolean'?d.success:null,contentPresent:typeof d.result?.content==='string',contentLength:typeof d.result?.content==='string'?d.result.content.length:0,detailedPresent:typeof d.result?.detailedContent==='string',detailedLength:typeof d.result?.detailedContent==='string'?d.result.detailedContent.length:0,contentsCount:Array.isArray(d.result?.contents)?d.result.contents.length:null,contents:leaves(d.result?.contents),binaryCount:Array.isArray(d.result?.binaryResultsForLlm)?d.result.binaryResultsForLlm.length:null,binary:leaves(d.result?.binaryResultsForLlm)});}
   }
  }else{
   if(e?.method==='item/commandExecution/outputDelta')state.outputs++;
  }
 },summary(){return{events:state.events,outputEvents:state.outputs,childStarts:state.childStarts,childActualModels:[...state.childModels],rootActualModels:[...state.rootModels],tools:state.tools.size,toolCompletions:structuredClone(state.completions)}}};
}
function crc(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0)}return(value^0xffffffff)>>>0}
/** Small deterministic actual PNG, left red/right blue; expected colors never enter the prompt. */
export function fixtureImage(){
 const width=256,height=128,raw=Buffer.alloc((1+width*3)*height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const at=y*(1+width*3)+1+x*3;raw[at]=x<width/2?255:0;raw[at+2]=x<width/2?0:255}
 const chunk=(name,data)=>{const type=Buffer.from(name),length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([length,type,data,sum])};
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
export function visualOrder(text){
 const colors=typeof text==='string'?text.match(/\b(?:red|blue)\b/gi):null;
 if(!colors||colors.length<2)return 'unobserved';const pair=colors.slice(0,2).map(color=>color.toLowerCase()).join('-');return pair==='red-blue'||pair==='blue-red'?pair:'other';
}
export function inputInstructions(kind,{completeCommand,diskCommand,done}){
 const shell=kind==='copilot'?`Use exactly two separate bash invocations, each command once: first ${JSON.stringify(completeCommand)}, then ${JSON.stringify(diskCommand)}.`:`Invoke the shell once with command ${JSON.stringify(completeCommand)}.`;
 return `Finite owned qualification. Do not delegate. Inspect the attached image. Begin your final response with Left: <color>. Right: <color>. ${kind==='copilot'?'Read the uploaded text document and the attached disk file; include both exact contents in your final response. ':''}${shell} Wait for successful tool results, then return the visual answer${kind==='copilot'?' and both text contents':''} and ${done}. Do not use other tools, commands, network or files.`;
}
/** Native terminal evidence lets the caller score content without waiting for
 * missing bytes or treating an older final as this original's completion. */
export function completedOriginal({history,native,previous,text,toolMarker=null}){
 if(history?.activity?.state!=='idle'||native?.activity!=='idle'||native?.phase!=='running')return null;
 const fresh=history.rows.filter(row=>!previous.has(row.id)),user=fresh.find(row=>row.kind==='user'&&row.lifecycle==='completed'&&row.body.kind==='complete'&&row.body.text===text),assistant=fresh.findLast(row=>row.kind==='assistant'&&row.lifecycle==='completed'&&row.body.kind==='complete');
 if(!user||!assistant)return null;
 const tool=toolMarker?fresh.find(row=>row.kind==='tool'&&row.lifecycle==='completed'&&row.body.kind==='complete'&&row.body.text.includes(toolMarker)):null;
 return{user,assistant,...(tool?{tool}:{})};
}
/** Closed diagnostic projection: no bodies, IDs, scopes, native errors or keys. */
export function integrationObservation({history,native,evidence,markers={},stage}){
 const rows=history?.rows??[],safeRows=rows.slice(0,128),contains=value=>typeof value==='string'&&value.length>0&&rows.some(row=>row.body?.kind!=='unavailable'&&typeof row.body?.text==='string'&&row.body.text.includes(value));
 const rowMatches=row=>Object.fromEntries(['mainDone','doc','disk','toolStart','toolEnd','questionDone','answer','rootRunning','childRunning'].map(key=>[key,typeof markers[key]==='string'&&markers[key].length>0&&typeof row.body?.text==='string'&&row.body.text.includes(markers[key])]));
 const latest=rows.findLast(row=>row.kind==='assistant'&&row.lifecycle==='completed'&&row.body?.kind==='complete');
 const gaps=history?.coverage?.gaps??[],rowKind=row=>['user','assistant','reasoning','tool','delegation','notice'].includes(row?.kind)?row.kind:'unknown';
 return{stage:['files','question','root-stop','child-stop'].includes(stage)?stage:'unknown',phase:['starting','running','stopping','stopped'].includes(native?.phase)?native.phase:'unknown',activity:['idle','working','waiting','unknown'].includes(native?.activity)?native.activity:'unknown',historyActivity:['idle','working','failed','unknown'].includes(history?.activity?.state)?history.activity.state:'unknown',interactionCount:Array.isArray(native?.interactions)?native.interactions.length:0,rows:rows.length,rowsTruncated:rows.length>128,shape:safeRows.map(row=>({kind:rowKind(row),lifecycle:['running','completed','failed','interrupted','unknown'].includes(row.lifecycle)?row.lifecycle:'unknown',bodyKind:['complete','partial','unavailable'].includes(row.body?.kind)?row.body.kind:'unknown',missing:row.body?.kind==='partial'&&Array.isArray(row.body.missing)?row.body.missing.filter(value=>['prefix','interior','final','truncated'].includes(value)).slice(0,4):[],length:typeof row.body?.text==='string'?row.body.text.length:0,matches:rowMatches(row)})),gapCount:gaps.length,gapsTruncated:gaps.length>128,gaps:gaps.slice(0,128).map(gap=>({kind:['missingPrefix','missingFinal','nativeGap','identity','unsupported','truncated'].includes(gap.kind)?gap.kind:'unknown',rowScoped:typeof gap.rowId==='string',rowKind:rowKind(rows.find(row=>row.id===gap.rowId))})),matches:Object.fromEntries(['mainDone','doc','disk','toolStart','toolEnd','questionDone','answer','rootRunning','childRunning'].map(key=>[key,contains(markers[key])])),visualOrder:visualOrder(latest?.body?.text),nativeEvidence:evidence.summary()};
}
const sameRow=(a,b)=>a&&b&&a.id===b.id&&a.kind===b.kind&&a.lifecycle===b.lifecycle&&a.body.kind==='complete'&&b.body.kind==='complete'&&a.body.text===b.body.text;

/** All native launch/cleanup belongs to hosts.mjs. This is only the finite
 * ordered scenario using the same actual Host/wire/retained clients. */
export async function qualifyIntegration({ctx,result,probe,runtime,bridge,send,ack,hosts,readers,commands,openHost,openReader}){
 const {kind,core}=ctx,marker=`V8_MATRIX_${kind}_${randomUUID().replaceAll('-','')}`,completeStart=marker+'_TOOL_START',completeEnd=marker+'_TOOL_END',rootMarker=marker+'_ROOT_RUNNING',childMarker=marker+'_CHILD_RUNNING';
 const completeCommand=`printf '%s\\n' ${quote(completeStart)}; sleep 0.2; printf '%s\\n' ${quote(completeEnd)}`,rootCommand=longCommand(rootMarker),childCommand=longCommand(childMarker);
 let main,wire,bound,childEvidence,childWire,childBound,releasePrompt=()=>{};
 const markerFacts={mainDone:marker+'_M1_DONE',toolStart:completeStart,toolEnd:completeEnd,questionDone:marker+'_QUESTION_DONE',answer:QUESTION_ANSWER,rootRunning:rootMarker,childRunning:childMarker};
 const promptAnswers=[],promptJobs=new Set(),seen=new Set(),contentFailures=[];result.contentFailures=contentFailures;
 let fatal=null,stage='files';const fail=reason=>{fatal??=Error(reason)},check=()=>{ctx.check();if(fatal)throw fatal};
 const evidence=createNativeEvidence(kind,ctx.model),allowedCommands=new Set([completeCommand]),toolUses=new Map();
 const tap=evidence=>capture=>{try{evidence.observe(capture)}catch(error){fail(error.message)}};
 const beforeTool=(input,invocation)=>{
  if(input.sessionId!==invocation.sessionId)return{deny:'Root fixture cannot execute a child tool.'};
  const key=input.toolName==='bash'?input.toolArgs?.command?.trim():input.toolName;
  if((input.toolName==='bash'&&allowedCommands.has(key)||stage==='question'&&input.toolName==='ask_user')&&!toolUses.has(key)){toolUses.set(key,1);return null;}
  fail('Unexpected root tool outside the finite fixture');return{deny:'Only the exact finite fixture tools are permitted.'};
 };
 try{
 ctx.root('integration-main');result.counts.roots++;
 main=await runtime('main',false,{beforeTool,onCapture:tap(evidence),sessionOptions:{availableTools:['builtin:bash','builtin:ask_user'],excludedTools:[]}});
 wire=await bridge(main);
 await probe('integration-create-observe',async()=>{const original=await send(main,wire,'create');await ack(main,wire,original);bound=await wire.bind();result.cases.create={status:'passed',nativeId:true,originalReceipt:original.request.id,authenticatedHttp:true,zeroSendsAtCreate:true}});
 const firstId=bound.binding.run.nativeSession,baselineReads=result.counts.readPortCalls,passive=commands.snapshot();
 wire.client.disconnect();wire.client.reconnect();bound.retained.history.setPinned(true);const side=wire.sessions.select(main.scope,'side');side.release();bound.retained.history.setPinned(false);assert.equal(result.counts.readPortCalls,baselineReads);assert.equal(commands.snapshot().identified,passive.identified);
 function observePrompts(connection,item,question,extraCommands=[]){
  const release=connection.client.interactionPort(item.scope).subscribe(item.scope,snapshot=>{
   for(const pending of snapshot.items)if(pending.state==='pending'&&!seen.has(pending.prompt.id)){
    seen.add(pending.prompt.id);if(seen.size>24){fail('Native prompt bound');continue}
    const task=(async()=>{check();const prompt=pending.prompt,answer=answerFor(prompt,{question:question(),commands:[...allowedCommands,...extraCommands]});
     if(prompt.owner.relation==='child')assert.ok(extraCommands.length===1&&prompt.type==='copilot.permission');
     const receipt=await ctx.respondInBrowser({bridge:connection,prompt,answer,operationId:`matrix-answer-${randomUUID()}`});check();assert.equal(receipt.state,'acknowledged');assert.equal(receipt.outcome?.status,'acknowledged');
     promptAnswers.push({type:prompt.type,id:prompt.id,response:receipt.outcome?.detail?.response,relation:prompt.owner.relation,originalReceipt:receipt.id});
    })().catch(error=>fail(error.message));promptJobs.add(task);void task.finally(()=>promptJobs.delete(task));
   }
  });return release;
 }
 releasePrompt=observePrompts(wire,main,()=>stage==='question');
 const current=()=>bound.retained.history.client.current;
 async function originalSend(connection,item,label,text,inputs){
  check();ctx.admitSend(label);result.counts.sends++;
  await connection.sessions.refresh(item.scope);const beforeRows=new Set(connection.sessions.entry(item.scope).history.client.current?.rows.map(row=>row.id)??[]);const handle=connection.sessions.agent(item.scope).actions.send(text,undefined,inputs);
  void handle.result.catch(()=>{});const original={request:handle.request,observed:null};const receipt=await ack(item,connection,original);check();assert.equal(receipt.outcome?.status,'accepted');return{...original,receipt,beforeRows};
 }
 async function completed(label,connection,item,original,{toolMarker=null}={}){
  const before=baselineReads;
  return until(()=>{check();assert.equal(result.counts.readPortCalls,before,'Healthy native path cannot fetch history');const value=bound.retained.history.client.current,native=bound.retained.getSnapshot().native;if(!value||!native)return null;
   // A completed original can fail content without losing native ownership.
   // Return its evidence now; callers keep the cell failed and only advance
   // through explicit quiet Stop/cold read/Resume and independent originals.
   return completedOriginal({history:value,native,previous:original.beforeRows,text:original.request.command.text,toolMarker});
  },label,180000);
 }
 const frozen=[];
 await probe('integration-prepared-inputs-and-tool',async()=>{
  const fileScope={...main.scope,session:firstId},port=wire.transport.filePort(wire.target),persistence=new core.MemoryDraftPersistence(),files=new core.FileWorkspace({history:wire.history,persistence,port});
  try{
   await files.bind(fileScope,bound.binding.history);const image=fixtureImage(),draft=await files.saveDraft(fileScope,{name:'matrix-image.png',mediaType:'image/png',blob:new Blob([image],{type:'image/png'})}),artifact=await files.upload(fileScope,draft.manifest.id);
   const inputs=kind==='codex'?{kind,items:[{type:'image',artifact}]}:{kind,items:[{type:'blob',artifact}]};
   let docMarker,diskMarker,diskCommand;
   if(kind==='copilot'){
    docMarker=marker+'_DOC_'+randomUUID().replaceAll('-','');diskMarker=marker+'_DISK_'+randomUUID().replaceAll('-','');const doc=await files.saveDraft(fileScope,{name:'matrix-note.txt',mediaType:'text/plain',blob:new Blob([docMarker],{type:'text/plain'})}),document=await files.upload(fileScope,doc.manifest.id),path=join(main.cwd,'matrix-disk.txt');
    await writeFile(path,diskMarker,{flag:'wx',mode:0o600});diskCommand=`cat -- ${quote(path)}`;allowedCommands.add(diskCommand);markerFacts.doc=docMarker;markerFacts.disk=diskMarker;
    inputs.items.push({type:'blob',artifact:document},{type:'file',file:{kind:'disk',owner:fileScope,sourceKey:'matrix-disk',path},displayName:'matrix-disk.txt'});
   }
   const text=inputInstructions(kind,{completeCommand,diskCommand,done:marker+'_M1_DONE'});
   const providerBefore=Math.max(0,...(ctx.providerFacts?.()??[]).map(fact=>fact.ordinal));
   const original=await originalSend(wire,main,'integration-main-files',text,inputs);
   const usage=await port.call('usage',{scope:fileScope});assert.equal(usage.activeReads,0,'Native RPC return must release prepared artifact read leases');
   const rows=await completed('prepared-inputs-tool-final',wire,main,original,{toolMarker:completeEnd});
   const facts=(ctx.providerFacts?.()??[]).filter(fact=>fact.ordinal>providerBefore),imageSha256=sha(image),actualImageDelivery=facts.some(fact=>fact.inputImages.inlinePng.some(value=>value.sha256===imageSha256&&value.byteLength===image.length)),actualVisualResult=visualOrder(rows.assistant.body.text)==='red-blue',actualMarkers=[marker+'_M1_DONE',...(docMarker?[docMarker,diskMarker]:[])].every(value=>rows.assistant.body.text.includes(value)),toolTerminal=!!rows.tool&&rows.tool.body.text.includes(completeStart),passed=actualImageDelivery&&actualVisualResult&&actualMarkers&&toolTerminal;
   if(!passed)contentFailures.push('preparedInputs');assert.equal(evidence.state.childStarts,0);frozen.push(...Object.values(rows));
   result.cases.preparedInputs={status:passed?'passed':'failed-native-content',originalReceipt:original.request.id,uploadedImage:true,actualImageDelivery,providerRequestsObserved:facts.length,actualVisualResult,actualMarkers,toolTerminal,nativeOutputEvents:evidence.state.outputs,referenceOnlyWire:true,preparedReadLeasesReleased:true,terminalStreaming:evidence.state.outputs>0?'actual-native-output-events':'not-established-completed-output-only',...(kind==='copilot'?{uploadedDocument:true,trustedDiskReference:true,actualDocumentMarkers:actualMarkers}:{genericUploadedDocument:'unsupported-not-translated'}),imageSha256};
  }finally{files.close();persistence.close()}
 },240000);
 await probe('integration-real-question',async()=>{
  stage='question';
  const selection=kind==='codex'?{kind,collaboration:{mode:'plan',model:ctx.model,effort:'low',instructions:'For this one owned qualification, ask the requested native user question before returning the answer. Do not execute tools other than request_user_input.'}}:undefined;
  const text=`Finite owned qualification. Do not delegate or run commands. Use ${kind==='codex'?'request_user_input':'ask_user'} exactly once now to ask which fixture color to choose, offering fixture-red and fixture-blue; the native " (Recommended)" suffix is allowed on the recommended option. Wait for my answer through that tool, then return exactly ${marker}_QUESTION_DONE followed by the selected answer. Do not simulate the question in assistant text.`;
  check();ctx.admitSend('integration-main-question');result.counts.sends++;await wire.sessions.refresh(main.scope);const beforeRows=new Set(current()?.rows.map(row=>row.id)??[]);const handle=wire.sessions.agent(main.scope).actions.send(text,selection);void handle.result.catch(()=>{});const original={request:handle.request,observed:null,beforeRows};await ack(main,wire,original);
  const rows=await completed('real-question-final',wire,main,original);await Promise.all([...promptJobs]);check();
  const responses=promptAnswers.filter(answer=>answer.type===`${kind}.question`);frozen.push(...Object.values(rows));
  const questionTool=current().rows.find(row=>!original.beforeRows.has(row.id)&&row.kind==='tool'&&row.lifecycle==='completed'&&row.native.toolName==='ask_user'&&row.body.kind==='complete'&&row.body.text.includes(QUESTION_ANSWER));
  const nativeAfter=bound.retained.getSnapshot().native,callbackSettled=kind==='codex'&&responses.length===1&&nativeAfter?.interactionsComplete===true&&nativeAfter.interactions.length===0;
  const actualMarkers=[marker+'_QUESTION_DONE',QUESTION_ANSWER].every(value=>rows.assistant.body.text.includes(value)),passed=responses.length===1&&actualMarkers&&(kind==='codex'?callbackSettled:!!questionTool);if(!passed)contentFailures.push('question');if(questionTool)frozen.push(questionTool);
  result.cases.question={status:passed?'passed':'failed-native-content',originalReceipt:original.request.id,actualBrowser:responses.length===1,oneAnswerOriginal:responses[0]?.originalReceipt,delivery:responses[0]?.response,actualAssistantFinal:actualMarkers,nativeToolResult:!!questionTool,callbackNativeCompletion:responses.length!==1?'unobserved':kind==='copilot'?'not-established-SDK-submitted':callbackSettled?'exact-native-request-settled':'not-observed',baselineAfterAnswer:kind==='copilot'?'may-remain-partial':callbackSettled?'observed':'partial'};
 },240000);
 main.markCompleted();releasePrompt();
 await probe('integration-quiet-stop',async()=>{const stopped=await send(main,wire,'stop');await ack(main,wire,stopped);assert.equal((await wire.client.snapshot(main.scope)).phase,'stopped')});
 await probe('integration-writer-reopen',async()=>{await wire.close();await main.host.terminate();hosts.delete(main.host);const before=commands.snapshot().identified;main.host=await openHost(main.options);assert.equal((await main.host.binding()).run.nativeSession,firstId);assert.equal(commands.snapshot().identified,before);wire=await bridge(main);bound=await wire.bind();assert.equal(result.counts.readPortCalls,baselineReads);result.cases.writerInspection={status:'passed',nativeIdPreserved:true,noActivation:true}});
 await probe('integration-explicit-cold-reader',async()=>{
  const saved=await main.host.binding(),reader=await openReader(()=>main.runtime.prepareHistoryReader(saved.run,saved.history));
  try{
   const recovery=await wire.client.recover(main.scope,saved.history,{timeoutMs:15000});ctx.record('integration-cold-result',recoveryObservation(recovery));assert.equal(recovery.state,'value');assert.equal(recovery.value.status,'ready');await until(()=>current()?.olderEdge.state!=='unknown','cold-publication',5000);
   let pages=1,older=0;const matched=()=>frozen.every(row=>bound.view.getSnapshot().rows.some(value=>sameRow(value,row)));
   while(pages<ctx.maxPages&&bound.view.getSnapshot().olderEdge.state==='available'&&(!matched()||older===0)){
    check();const token=bound.view.beginOlderRead();try{const page=await wire.client.older(main.scope,token.scope,token.cursor,token.generation);assert.equal(bound.view.applyPage(page,token),'applied');pages++;older++}finally{bound.view.finishOlderRead(token)}
   }
   const same=matched(),snapshot=bound.view.getSnapshot();result.cases.coldHistory={status:same&&older>0?'passed':'partial-native-page-cap',selectedRows:frozen.length,matched:same,actualOlderPages:older,pages,cap:ctx.maxPages,fullHistoryBoundary:snapshot.olderEdge.state==='end',noActivation:(await wire.client.snapshot(main.scope)).phase==='stopped'};
   assert.ok(same&&older>0,'Cold page cap did not establish selected live row/body joins and a real older cursor');assert.equal(result.cases.coldHistory.noActivation,true);
  }finally{await reader.close();readers.delete(reader)}
 },180000);
 await probe('integration-quiet-resume',async()=>{
  const reads=result.counts.readPortCalls,saved=await main.host.binding(),resumed=await send(main,wire,'resume');await ack(main,wire,resumed);await wire.sessions.refresh(main.scope);const binding=await wire.transport.binding(wire.target);assert.ok(binding);assert.equal(binding.run.nativeSession,firstId);assert.equal(binding.run.generation,saved.run.generation+1);const oldView=bound.view;bound=await wire.rebind();assert.equal(bound.view,oldView,'Explicit rebind must preserve the retained view');
  await delay(300);check();const snapshot=await wire.client.snapshot(main.scope);assert.equal(snapshot.phase,'running');assert.equal(snapshot.activity,'idle');assert.equal(snapshot.interactionsComplete,true);assert.equal(snapshot.interactions.length,0);assert.equal(result.counts.readPortCalls,reads);result.cases.resume={status:'passed-completed-main-boundary',nativeIdPreserved:true,noNewSend:true,quietMs:300,callbackCertificate:'actual-post-reopen',interruptedResume:'not-attempted'};
 });
 stage='root-stop';allowedCommands.clear();allowedCommands.add(rootCommand);releasePrompt=observePrompts(wire,main,()=>false);
 await probe('integration-working-root-stop',async()=>{
  const text=`Finite owned qualification. Do not delegate. Execute exactly this one shell command in the foreground: ${JSON.stringify(rootCommand)}. Keep waiting for the tool; do not cancel it, background it, run another command or finish early. The owner will Stop this session.`;
  const selected=kind==='codex'?{kind,collaboration:{mode:'default',model:ctx.model,effort:'low',instructions:'Execute the one exact owned shell fixture and wait for its completion. Do not delegate.'}}:undefined;
  check();ctx.admitSend('integration-main-working-stop');result.counts.sends++;await wire.sessions.refresh(main.scope);const operation=wire.sessions.agent(main.scope).actions.send(text,selected);void operation.result.catch(()=>{});await ack(main,wire,{request:operation.request,observed:null});
  const tool=await until(()=>{check();const snapshot=current();return snapshot?.rows.find(row=>row.kind==='tool'&&row.lifecycle==='running'&&row.body.kind!=='unavailable'&&row.body.text.includes(rootMarker))},'actual-root-tool-output-before-stop',120000);assert.equal((await wire.client.snapshot(main.scope)).activity,'working');
  const stopped=await send(main,wire,'stop');await ack(main,wire,stopped);const snapshot=await wire.client.snapshot(main.scope);assert.equal(snapshot.phase,'stopped');assert.equal(snapshot.activity,'idle');const proof=await commands.proveAbsent();assert.equal(proof.allAbsent,true);result.cases.rootWorkingStop={status:'passed',originalReceipt:operation.request.id,stopReceipt:stopped.request.id,actualToolOutput:true,toolIdPositive:clean(tool.id),nativeTreeAbsent:true,noInterruptedResume:true};
 },180000);releasePrompt();
 if(kind==='codex')result.cases.childWorkingStop={status:'unqualified',reason:'Pinned native pre-spawn hooks fail open; no new hook trust/config/mount machinery added solely for this qualification.'};
 else{
  stage='child-stop';childEvidence=createNativeEvidence(kind,ctx.model);const childPrompt=`Run bash exactly once with command ${JSON.stringify(childCommand)}. Wait in the foreground. Do not delegate, use any other tool or command, or finish early; the owner will Stop this native tree.`,gate=createChildGate({model:ctx.model,command:childCommand,prompt:childPrompt,admit:()=>ctx.admitChild('integration-one-child'),violate:fail});
  childEvidence.onChild(id=>gate.observeChild(id));ctx.root('integration-child-root');result.counts.roots++;
  const child=await runtime('child-stop',false,{beforeTool:gate.beforeTool,onCapture:tap(childEvidence),sessionOptions:{availableTools:['builtin:task','builtin:bash'],excludedTools:[],customAgents:[{name:CHILD_NAME,displayName:'One owned V8 child',description:'Run exactly one owned long shell command until owner Stop.',tools:['bash'],model:ctx.model,prompt:childPrompt}]}});childWire=await bridge(child);
  await probe('integration-child-create',async()=>{const original=await send(child,childWire,'create');await ack(child,childWire,original);childBound=await childWire.bind();gate.bindRoot(childBound.binding.run.nativeSession)});
  const unprompt=observePrompts(childWire,child,()=>false,[childCommand]);
  try{await probe('integration-working-child-stop',async()=>{
   gate.arm();const text=`Finite owned qualification. Invoke task exactly once with agent_type ${CHILD_NAME}, model ${ctx.model}, prompt ${JSON.stringify(childPrompt)}, name "Owned child Stop fixture", description "One long owned child tool". Wait for that exact child. Do not retry, respawn, background, use other tools or delegate again. The owner will Stop the entire native tree while the child shell works.`;
   const original=await originalSend(childWire,child,'integration-child-working-stop',text);
   const childReads=result.counts.readPortCalls;const active=await until(()=>{check();return[...childEvidence.state.tools.values()].find(tool=>childEvidence.state.childIds.has(tool.agent)&&tool.name==='bash'&&tool.command?.trim()===childCommand&&!tool.completed&&tool.output.includes(childMarker))},'actual-child-tool-output-before-stop',180000);
   assert.equal(result.counts.readPortCalls,childReads);assert.equal(childEvidence.state.childStarts,1);assert.equal(gate.snapshot().used,true);assert.equal((await childWire.client.snapshot(child.scope)).activity,'working');
   const stopped=await send(child,childWire,'stop');await ack(child,childWire,stopped);assert.equal((await childWire.client.snapshot(child.scope)).phase,'stopped');assert.equal((await commands.proveAbsent()).allAbsent,true);
   result.cases.childWorkingStop={status:'passed',originalReceipt:original.request.id,stopReceipt:stopped.request.id,childCount:1,onePreEffectPermit:true,nativeAncestry:true,actualChildToolOutput:true,actualChildModel:childEvidence.state.childModels.has(ctx.model)?ctx.model:'unqualified-usage-not-observed',providerModelFence:ctx.model,toolIdPositive:clean(active.id),nativeTreeAbsent:true,noInterruptedResume:true};
  },240000)}finally{unprompt()}
  result.cases.childEvidence=childEvidence.summary();
 }
 await Promise.all([...promptJobs]);check();result.cases.nativeEvidence=evidence.summary();result.cases.browserAnswers={count:promptAnswers.length,categories:[...new Set(promptAnswers.map(answer=>answer.type))],responses:promptAnswers.map(answer=>({type:answer.type,response:answer.response,relation:answer.relation}))};
 assert.equal(result.counts.sends,kind==='codex'?3:4);result.contentFailures=contentFailures;result.status=contentFailures.length?'failed-native-diagnostic':'passed-native-live-integration-subset';if(contentFailures.length)result.error='Required native content cells failed: '+contentFailures.join(', ');
 }finally{
  releasePrompt();
  try{const observation=integrationObservation({history:bound?.retained.history.client.current,native:bound?.retained.getSnapshot().native,evidence,markers:markerFacts,stage});
   result.cases.finalObservation=observation;ctx.record('integration-final-observation',observation);
   if(childEvidence){const childObservation=integrationObservation({history:childBound?.retained.history.client.current,native:childBound?.retained.getSnapshot().native,evidence:childEvidence,markers:{childRunning:childMarker},stage:'child-stop'});result.cases.childFinalObservation=childObservation;ctx.record('integration-child-final-observation',childObservation)}
   result.cases.browserAnswers={count:promptAnswers.length,categories:[...new Set(promptAnswers.map(answer=>answer.type))],responses:promptAnswers.map(answer=>({type:answer.type,response:answer.response,relation:answer.relation}))};
  }catch{/* Diagnostic projection cannot replace the original failure or cleanup. */}
 }
}
