import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { NativeRpc, until } from './support.mjs';

export async function runCodexLive(ctx) {
  const {HistoryHub,HistoryWorkspace,createCodexCodec,ReadCoordinator}=ctx.core;
  const require=createRequire(join(ctx.toolRoot,'package.json'));
  const binary=join(require.resolve('@openai/codex-linux-x64/package.json'),'../vendor/x86_64-unknown-linux-musl/bin/codex');
  const environment={...process.env,CODEX_HOME:ctx.nativeHome,MULTIPLEX_V8_LIVE_KEY:ctx.key};
  const hub=new HistoryHub({maxReplayFrames:1,maxRows:64,maxBodyBytes:8192});
  let rpc,codec,scope,workspace,session,lease,stream,cursor,detached=false,detachedAtRevision,rootThread;
  const staged=[],events=[],children=new Set(),sideband={},completed=new Map();
  let nativeBodyReads=0,modelTurns=0,stage='boot',detachProof=false;
  const flush=()=>{if(!stream)return;for(const frame of stream.drain())session.client.apply(frame);if(session.client.current)cursor={generation:session.client.current.generation,revision:session.client.current.revision};};
  function consume(message) {
    events.push(message);assert.ok(events.length<=2048,'CODEX_LIVE_EVENT_BOUND');
    const method=message.method,params=message.params??{};
    if(method==='thread/started'&&rootThread&&params.thread?.id!==rootThread){
      if(!children.has(params.thread?.id)){ctx.allowance.admit('codex-child');children.add(params.thread.id);}
    }
    if(method==='turn/completed')completed.set(JSON.stringify([params.threadId,params.turn?.id]),params.turn?.status);
    const nativeActivity=params.item;
    if(nativeActivity?.type==='subAgentActivity'&&nativeActivity.kind==='started'&&params.threadId===rootThread&&!children.has(nativeActivity.agentThreadId)){ctx.allowance.admit('codex-child');children.add(nativeActivity.agentThreadId);}
    // Legacy mirrors and unscoped setup/control observations are a separate port.
    // Every authoritative thread/item/turn notification with a native scope is retained.
    if(method.startsWith('codex/event/')||!(params.threadId||method==='thread/started')){
      sideband[method]=(sideband[method]??0)+1;return;
    }
    ctx.record('codex-notification',message);
    if(!codec){staged.push(message);assert.ok(staged.length<=128);return;}
    codec.observe(message);flush();
    if(stage==='first'&&!detached&&method==='item/commandExecution/outputDelta'&&typeof params.delta==='string'&&params.delta.length>0){
      assert.ok(hub.snapshot(scope).rows.some(row=>row.kind==='tool'&&row.body.kind!=='unavailable'&&row.body.text.includes(params.delta)));
      detachedAtRevision=hub.snapshot(scope).revision;void stream.return();stream=undefined;lease.release();
      workspace.setConnected(false);detached=true;detachProof=hub.owner(scope).subscriberCount===0;
    }
  }
  const makeRpc=()=>new NativeRpc({binary,args:['app-server','--stdio'],workspace:ctx.workspace,environment,onNotification:consume,onServerRequest:message=>ctx.record('codex-confirmation-required',{method:message.method})});
  const initialize=async()=>{const reply=await rpc.request('initialize',{clientInfo:{name:'multiplex_v8_history_live',title:'Multiplex V8 history live',version:'0.0.0'},capabilities:{experimentalApi:true}});rpc.notify('initialized');return reply;};
  const send=async(text,label)=>{
    ctx.allowance.admit('codex-root');modelTurns++;stage=label;
    const id=`v8-original-${label}`;session.recordOperation(id,{type:'send',text});
    const response=await rpc.request('turn/start',{threadId:rootThread,clientUserMessageId:id,input:[{type:'text',text,text_elements:[]}],model:ctx.model,effort:'low'});
    assert.ok(response.turn?.id);session.observeOperation(id,{state:'nativeAcknowledged',turnId:response.turn.id},true);
    await until(()=>{if(rpc.failure)throw rpc.failure;return completed.has(JSON.stringify([rootThread,response.turn.id]));},`codex ${label} completion`,120_000);
    assert.equal(completed.get(JSON.stringify([rootThread,response.turn.id])),'completed','ROOT_NATIVE_TURN_NOT_SUCCESSFUL');
    return response.turn.id;
  };
  let result={status:'running',model:ctx.model,provider:ctx.provider,checks:{},limitations:[]};
  try {
    rpc=makeRpc();const initialized=await initialize();assert.match(initialized.userAgent??'',/0\.162\.1/);
    const started=await rpc.request('thread/start',{model:ctx.model,modelProvider:ctx.provider,allowProviderModelFallback:false,cwd:ctx.workspace,approvalPolicy:'on-request',sandbox:'danger-full-access',ephemeral:false,historyMode:'paginated',developerInstructions:'You are testing a disposable history stream. Follow the exact requested tiny task; never inspect files, credentials, other sessions, services or networks. Use the requested model for any single requested child. Do not perform unrelated work.'});
    assert.equal(started.model,ctx.model);assert.equal(started.modelProvider,ctx.provider);assert.equal(started.approvalPolicy,'on-request');assert.equal(started.sandbox?.type,'dangerFullAccess');
    rootThread=started.thread.id;
    scope={kind:'codex',threadId:rootThread,origin:{connection:'live-qualification',principal:'owner',host:'codex-disposable',nativeSession:rootThread,attachment:'capture-1'}};
    codec=createCodexCodec({origin:scope.origin,rootThreadId:rootThread,capture:hub,knownStart:true});
    for(const message of staged.splice(0))codec.observe(message);
    workspace=new HistoryWorkspace({connection:'live-qualification',principal:'owner'});session=workspace.session(scope);lease=workspace.select(scope);
    session.setDraft('retained live draft');session.setPinned(true);stream=hub.watch(scope);flush();
    const first=await send("Run exactly this harmless shell command once: printf 'V8_CDX_FIRST\\n'; sleep 1; printf 'V8_CDX_SECOND\\n'. "+(ctx.combined?`Then spawn exactly one native child agent using model ${ctx.model}. Ask it to reply exactly V8_CDX_CHILD_DONE without tools or further agents, and wait for it. `:"")+"Then reply exactly V8_CDX_DONE. Do not inspect files or access networks, and do not perform any unrelated work.",'first');
    assert.ok(detached&&detachProof,'UI_DID_NOT_DETACH_DURING_REAL_OUTPUT');assert.ok(hub.snapshot(scope).revision>detachedAtRevision);
    assert.equal(hub.owner(scope).subscriberCount,0);assert.equal(nativeBodyReads,0);
    const final=hub.snapshot(scope),tool=final.rows.find(row=>row.kind==='tool'&&row.body.kind==='complete'&&row.body.text.includes('V8_CDX_SECOND'));
    assert.ok(tool,'NO_COMPLETE_REAL_COMMAND_OUTPUT');assert.equal(tool.body.text,'V8_CDX_FIRST\nV8_CDX_SECOND\n');
    assert.ok(final.rows.some(row=>row.kind==='assistant'&&row.body.kind==='complete'&&row.body.text.trim()==='V8_CDX_DONE'));
    workspace.setConnected(true);stream=hub.watch(scope,cursor);assert.equal(stream.mode,'snapshot');flush();
    assert.deepEqual(session.client.current,hub.snapshot(scope));
    const duplicate={kind:'snapshot',snapshot:hub.snapshot(scope)};assert.equal(session.client.apply(duplicate),'duplicate');
    lease=workspace.select(scope);const view=lease.view;view.expand(tool.id,true);view.viewport.userScroll('earlier',false);view.viewport.report({rowId:tool.id,offsetPx:7});
    const b={kind:'copilot',agentId:null,origin:{...scope.origin,host:'view-only',nativeSession:'view-only'}};workspace.select(b);
    const restored=workspace.select(scope);lease.release();lease=restored;
    assert.equal(lease.view,view);assert.equal(session.draft,'retained live draft');assert.equal(session.pinned,true);assert.equal(view.viewport.state.anchor.offsetPx,7);assert.ok(view.getSnapshot().expansions.includes(tool.id));
    result.checks={selectedNativeModelAndProvider:true,trustedPermissionDefaults:true,liveCommandBytesExact:true,zeroViewerCapture:true,retainedSnapshotReconnect:true,duplicateFrameIdempotence:true,sessionSwitchState:true,healthyNativeBodyReads:nativeBodyReads,nativeAcknowledgementIsNotDurableHostReceipt:true};
    ctx.progress('Codex real text/tool capture and detached-view reconnect passed.');
    // One separate explicit stored-history audit after all healthy-path assertions.
    const readOwner=new ReadCoordinator({maxConcurrent:1,maxFacts:2,maxAttemptsPerFact:1});
    const audit=readOwner.request({scope,reason:'E20',kind:'nativeBody',factId:'explicit live stored-history audit'},async()=>{nativeBodyReads++;return rpc.request('thread/items/list',{threadId:rootThread,turnId:first,cursor:null,limit:32,sortDirection:'asc'});});
    const observed=await audit.wait(25_000);assert.equal(observed.state,'value');
    const items=observed.value.data;assert.ok(Array.isArray(items));
    ctx.record('codex-history-audit',{items,continuationPresent:!!observed.value.nextCursor});
    const auditedCommand=items.find(entry=>entry.turnId===first&&entry.item?.id===tool.native.nativeItemId&&entry.item?.type==='commandExecution');
    result.checks.storedAuditContainsExactCommand=auditedCommand?.item.aggregatedOutput===tool.body.text;assert.ok(result.checks.storedAuditContainsExactCommand,'STORED_COMMAND_ID_OR_BYTES_MISMATCH');
    result.checks.auditNativeBodyReads=nativeBodyReads;result.checks.auditMoreAvailable=!!observed.value.nextCursor;
    if(!ctx.combined) await send(`Spawn exactly one native child agent using model ${ctx.model}. Ask that child to reply exactly V8_CDX_CHILD_DONE, with no tools, files, networking or further agents. Wait for it to finish, then reply exactly V8_CDX_PARENT_DONE. Do not create a second child.`,'child');flush();
    result.checks.liveChildCount=children.size;
    if(children.size===1){
      const childId=[...children][0],childScope={...scope,threadId:childId};
      const child=hub.snapshot(childScope);result.checks.childScopedFinal=child.rows.some(row=>row.kind==='assistant'&&row.body.kind==='complete'&&row.body.text.trim()==='V8_CDX_CHILD_DONE');
      assert.ok(result.checks.childScopedFinal,'CHILD_FINAL_NOT_CAPTURED');
      assert.ok(!hub.snapshot(scope).rows.some(row=>row.kind==='assistant'&&row.body.kind!=='unavailable'&&row.body.text.trim()==='V8_CDX_CHILD_DONE'));
    }else result.limitations.push('Native child was not emitted; no child capture qualification.');
    result.checks.codecDiagnostics=codec.diagnostics();result.checks.coverageGaps=hub.snapshot(scope).coverage.gaps;
    if(hub.snapshot(scope).coverage.gaps.length)result.limitations.push('Unsupported native scoped events remain explicit coverage gaps; see captured shape evidence.');
    await stream.return();stream=undefined;lease.release();
    const shutdown=await rpc.close();rpc=undefined;result.checks.nativeProcessExitObserved=shutdown.code===0||shutdown.signal==='SIGTERM';assert.ok(result.checks.nativeProcessExitObserved);
    result.status='passed-native-subset';result.nativeTurns=modelTurns;result.sideband=sideband;result.observedNotificationCount=events.length;
    return result;
  } finally {await stream?.return();lease?.release();if(rpc)await rpc.close();}
}
