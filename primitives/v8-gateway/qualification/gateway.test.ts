import assert from "node:assert/strict";
import test from "node:test";
import { GatewayCoordinator } from "../src/gateway/coordinator.js";
import { ViewerQueue } from "../src/contracts/queue.js";
import { GatewayError } from "../src/contracts/types.js";
import { GatewayClient } from "../src/client/coordinator.js";
import { HttpGatewayTransport } from "../src/client/http.js";
import { listenLoopback } from "../src/http/server.js";
import { HistoryHub } from "../../v8-history/src/host/history-owner.js";
import { HistoryWorkspace } from "../../v8-history/src/client/workspace.js";
import { SessionWorkspace } from "../../v8-session/src/client/workspace.js";
import { alice,bob,target,scope,historyScope,request,deferred,until,FixtureSession,fixture } from "./fixture.js";
import type { NativeRead, NativeReadResult, Receipt, RunRef, SessionPort } from "../../v8-session/src/contracts/types.js";
import type { CodexScope } from "../../v8-history/src/contracts/types.js";

test("authenticated loopback rejects foreign principal, authority, scope and malformed ingress before forwarding",async()=>{
  const f=await fixture(),session=f.session as FixtureSession;
  try{const client=f.make("bob");await assert.rejects(client.transport.submit(target,request()),{code:"FORBIDDEN"});
    const transport=new HttpGatewayTransport({url:f.server.url,authorization:"Bearer invalid"});await assert.rejects(transport.snapshot(target),{code:"UNAUTHENTICATED"});
    await assert.rejects(f.make().transport.submit({...target,authority:"unrelated"},request()),{code:"FORBIDDEN"});
    await assert.rejects(f.make().transport.submit(target,{...request(),scope:{...scope,host:"foreign"}}),{code:"FENCED"});
    const malformed=await fetch(f.server.url,{method:"POST",headers:{authorization:"Bearer fixture-alice","content-type":"application/json"},body:"{"});assert.equal(malformed.status,409);
    assert.equal(session.submits.length,0);client.client.fence();transport.close();
    const readOnly={...alice,actions:["read"] as const};assert.equal((await f.coordinator.snapshot(readOnly,target)).phase,"running");assert.throws(()=>f.coordinator.submit(readOnly,target,request()),{code:"FORBIDDEN"});assert.equal(session.submits.length,0);
    const missingActions={connection:alice.connection,principal:alice.principal,authorities:alice.authorities} as typeof alice;assert.throws(()=>f.coordinator.snapshot(missingActions,target),{code:"FORBIDDEN"});
  }finally{await f.close();}
});
test("disconnected HTTP caller leaves bounded original forwarding alive and exact late receipt readable without resend",async()=>{
  const session=new FixtureSession();session.gate=deferred<Receipt>();const f=await fixture({session});
  const abort=new AbortController();let submitFetches=0;
  const lossyFetch:typeof fetch=async(input,init)=>{const body=JSON.parse(String(init?.body));if(body.op==="submit"){submitFetches++;const result=fetch(input,{...init,signal:abort.signal});await until(()=>session.submits.length===1);abort.abort();return result;}return fetch(input,init);};
  const viewer=f.make("alice",lossyFetch);
  try{
    const pending=viewer.client.submit(request());await assert.rejects(pending);assert.equal(f.coordinator.observation.active,1);
    viewer.client.disconnect();assert.equal(session.submits.length,1);assert.equal(await f.coordinator.receipt(alice,target,"send"),null);
    session.gate.resolve({scope,id:"send",type:"send",generation:1,state:"acknowledged",outcome:{status:"accepted"}});await until(()=>f.coordinator.observation.active===0);
    viewer.client.reconnect();assert.equal((await viewer.client.receipt(scope,"send"))!.state,"acknowledged");assert.equal(viewer.client.originalCount,0,"terminal receipt retires client tracking; permanent Host dedup owns any explicit duplicate ID");
    assert.equal(submitFetches,1);assert.equal(session.submits.length,1);
  }finally{viewer.client.fence();await f.close();}
});
test("original mutation target and meaning freeze before awaits; concurrent forwarding joins only exact original",async()=>{
  const session=new FixtureSession();session.gate=deferred<Receipt>();const f=await fixture({session});
  try{const mutable=request() as {scope:typeof scope;id:string;generation:number;command:{type:"send";text:string}};
    const first=f.coordinator.submit(alice,target,mutable),same=f.coordinator.submit(alice,target,mutable);mutable.command.text="changed after forwarding";
    await until(()=>session.submits.length===1);assert.equal((session.submits[0]!.command as {text:string}).text,"private original");
    assert.throws(()=>f.coordinator.submit(alice,target,mutable),{code:"FENCED"});session.gate.resolve({scope,id:"send",type:"send",generation:1,state:"acknowledged"});assert.deepEqual(await first,await same);assert.equal(session.submits.length,1);
  }finally{await f.close();}
});
test("same durable owner route replacement permits old receipt reads while stale mutations stay fenced",async()=>{
  const f=await fixture(),session=f.session as FixtureSession;
  try{await f.coordinator.submit(alice,target,request());const next={...target,routeEpoch:"route-2"};f.coordinator.register({target:next,session,history:f.hub,authorizeHistory:()=>true});f.coordinator.unavailable(target);
    assert.equal((await f.coordinator.receipt(alice,target,"send"))!.state,"acknowledged");assert.throws(()=>f.coordinator.submit(alice,target,request("other")),{code:"UNAVAILABLE"});
    assert.equal(session.submits.length,1);const impostor={...next,owner:"different-domain",routeEpoch:"route-3"},other=new FixtureSession();assert.throws(()=>f.coordinator.register({target:impostor,session:other,history:f.hub,authorizeHistory:()=>true}),{code:"FENCED"});f.coordinator.unavailable(next);f.coordinator.register({target:impostor,session:other,history:f.hub,authorizeHistory:()=>true});
    assert.throws(()=>f.coordinator.receipt(alice,target,"send"),{code:"UNAVAILABLE"});assert.equal(other.reads,0);
  }finally{await f.close();}
});
test("slow viewer overflow and cancellation release only their own subscriptions",async()=>{
  const f=await fixture({coordinator:new GatewayCoordinator({frames:2})}),session=f.session as FixtureSession;
  try{const slow=f.coordinator.watchSession(alice,target),healthy=f.coordinator.watchSession(alice,target);await healthy.next();
    for(let i=0;i<3;i++){session.emit();assert.equal((await healthy.next()).done,false);}
    await assert.rejects(slow.next(),{code:"OVERFLOW"});assert.equal(session.listeners.size,1);assert.equal(f.coordinator.observation.subscribers,1);
    session.emit();assert.equal((await healthy.next()).value!.phase,"running");await healthy.return();assert.equal(session.listeners.size,0);assert.equal(session.submits.length,0);
  }finally{await f.close();}
});
test("optional history pressure and held ordinary writes cannot block exact urgent Stop or answer",async()=>{
  const session=new FixtureSession();session.gate=deferred<Receipt>();const coordinator=new GatewayCoordinator({reads:1,readQueue:1,forward:1,urgent:2});const f=await fixture({coordinator,session});
  const older=deferred<any>();coordinator.register({target:{...target,routeEpoch:"route-2"},session,history:{watch:(s,c)=>f.hub.watch(s,c),older:()=>older.promise},authorizeHistory:()=>true});const t={...target,routeEpoch:"route-2"};
  try{const held=coordinator.older(alice,t,historyScope,"older-cursor"),write=coordinator.submit(alice,t,request());await until(()=>session.submits.length===1);
    const queued=coordinator.snapshot(alice,t);await assert.rejects(coordinator.snapshot(alice,t),{code:"FULL"});assert.throws(()=>coordinator.submit(alice,t,request("other-send")),{code:"FULL"});
    await coordinator.submit(alice,t,{...request("stop"),command:{type:"stop"}});await coordinator.submit(alice,t,{...request("answer"),command:{type:"answer",interactionId:"callback",choice:"approve"}});
    assert.equal(session.submits.length,3);session.gate.resolve({scope,id:"send",type:"send",generation:1,state:"acknowledged"});older.resolve({scope:historyScope,generation:"fixture",rows:[],olderEdge:{state:"end",evidence:"nativeBoundary"}});await Promise.all([held,write]);assert.equal((await queued).phase,"running");
  }finally{await f.close();}
});
test("read admission is FIFO and bounded; retired same-epoch mounts and close never dispatch waiting reads",async()=>{
  const coordinator=new GatewayCoordinator({reads:1,readQueue:2}),session=new FixtureSession(),hub=new HistoryHub();hub.open(historyScope);
  const gates=[deferred<void>(),deferred<void>(),deferred<void>()],held=deferred<void>(),closeGate=deferred<void>();let calls=0;
  session.snapshot=async()=>{const gate=gates[calls++];if(gate)await gate.promise;return structuredClone(session.state);};
  let release=coordinator.register({target,session,history:hub,authorizeHistory:()=>true});
  try{
    const first=coordinator.snapshot(alice,target),second=coordinator.snapshot(alice,target),third=coordinator.snapshot(alice,target);
    await until(()=>calls===1);await assert.rejects(coordinator.snapshot(alice,target),{code:"FULL"});
    gates[0]!.resolve();await first;await until(()=>calls===2);assert.equal(coordinator.observation.optionalReads,1);
    gates[1]!.resolve();await second;await until(()=>calls===3);gates[2]!.resolve();await third;
    session.snapshot=async()=>{calls++;await held.promise;return structuredClone(session.state);};
    const active=coordinator.snapshot(alice,target),oldActive=assert.rejects(active,{code:"FENCED"});await until(()=>calls===4);
    const waiting=coordinator.snapshot(alice,target),oldWaiting=assert.rejects(waiting,{code:"FENCED"});
    release();const replacement=new FixtureSession();let replacementCalls=0;
    replacement.snapshot=async()=>{replacementCalls++;await closeGate.promise;return structuredClone(replacement.state);};
    release=coordinator.register({target,session:replacement,history:hub,authorizeHistory:()=>true});
    held.resolve();await Promise.all([oldActive,oldWaiting]);assert.equal(calls,4);assert.equal(replacementCalls,0);
    const current=coordinator.snapshot(alice,target),closedActive=assert.rejects(current,{code:"CLOSED"});await until(()=>replacementCalls===1);
    const queued=coordinator.snapshot(alice,target),closedQueued=assert.rejects(queued,{code:"CLOSED"});
    coordinator.close();await closedQueued;assert.equal(replacementCalls,1);assert.equal(coordinator.observation.optionalReads,1,"An active read remains owned after observer shutdown");
    closeGate.resolve();await closedActive;assert.equal(coordinator.observation.optionalReads,0);assert.equal(session.submits.length+replacement.submits.length,0);
  }finally{for(const gate of gates)gate.resolve();held.resolve();closeGate.resolve();release();coordinator.close();}
});
test("route loss changes freshness only; coordinator shutdown cannot cancel already forwarded original",async()=>{
  const session=new FixtureSession();session.gate=deferred<Receipt>();const f=await fixture({session});
  try{const watch=f.coordinator.watchSession(alice,target);await watch.next();const pending=f.coordinator.submit(alice,target,request());await until(()=>session.submits.length===1);
    f.coordinator.unavailable(target);await assert.rejects(watch.next(),{code:"UNAVAILABLE"});assert.equal(session.state.phase,"running");f.coordinator.close();assert.equal(f.coordinator.observation.active,1);
    session.gate.resolve({scope,id:"send",type:"send",generation:1,state:"acknowledged"});assert.equal((await pending).state,"acknowledged");assert.equal(session.submits.length,1);
  }finally{await f.close();}
});
test("two actual retained Session/History workspaces share capture, replay offline suffixes and keep independent view state",async()=>{
  const f=await fixture(),a=f.make(),b=f.make();const sa=new SessionWorkspace({history:a.history,port:a.client}),sb=new SessionWorkspace({history:b.history,port:b.client});
  const ah=a.client.observeHistory(scope,historyScope),bh=b.client.observeHistory(scope,historyScope);
  try{await Promise.all([sa.bind(scope,historyScope),sb.bind(scope,historyScope)]);a.history.session(historyScope).setDraft("Alice draft");b.history.session(historyScope).setDraft("other panel draft");sa.setPinned(scope,true);
    f.hub.emit(historyScope,[{type:"start",id:"answer",kind:"assistant",text:"hello"}]);await until(()=>!!a.history.session(historyScope).client.current?.rows.length&&!!b.history.session(historyScope).client.current?.rows.length);
    a.client.disconnect();f.hub.emit(historyScope,[{type:"append",id:"answer",kind:"assistant",text:" world"},{type:"finish",id:"answer",kind:"assistant",lifecycle:"completed",sealCaptured:true}]);
    await until(()=>b.history.session(historyScope).client.current?.rows[0]?.lifecycle==="completed");a.client.reconnect();await until(()=>a.history.session(historyScope).client.current?.rows[0]?.lifecycle==="completed");
    assert.equal(a.history.session(historyScope).draft,"Alice draft");assert.equal(b.history.session(historyScope).draft,"other panel draft");assert.equal(a.history.session(historyScope).pinned,true);
    assert.equal(a.history.session(historyScope).client.current!.rows[0]!.body.kind,"complete");assert.equal((f.session as FixtureSession).submits.length,0);assert.equal(f.coordinator.observation.active,0);
    ah.release();await until(()=>f.coordinator.observation.subscribers===3);assert.equal(sb.entry(scope).getSnapshot().native!.phase,"running");
  }finally{ah.release();bh.release();sa.close();sb.close();a.client.fence();b.client.fence();await f.close();}
});
test("authentication replacement fences late original replies, drops private state and forbids adopting another principal workspace",async()=>{
  const session=new FixtureSession();session.gate=deferred<Receipt>();const f=await fixture({session}),a=f.make();
  try{const pending=a.client.submit(request());await until(()=>session.submits.length===1);a.client.fence();assert.equal(a.disposed,1);assert.equal(a.client.originalCount,0);
    session.gate.resolve({scope,id:"send",type:"send",generation:1,state:"acknowledged"});await assert.rejects(pending,{code:"CLOSED"});assert.throws(()=>a.client.snapshot(scope),{code:"CLOSED"});
    const transport=new HttpGatewayTransport({url:f.server.url,authorization:"Bearer fixture-bob"});const oldHistory=a.history;const b=new GatewayClient({transport,history:oldHistory,targets:[{...target,principal:"bob"}],onFence:()=>{}});
    const bobScope={...scope,principal:"bob"},bobHistory={...historyScope,origin:{...historyScope.origin,principal:"bob"}};
    assert.throws(()=>b.observeHistory(bobScope,bobHistory),/Foreign workspace/);assert.throws(()=>b.bindRoute(target),{code:"FORBIDDEN"});b.fence();
  }finally{a.client.fence();await f.close();}
});
test("throwing UI callbacks cannot prevent auth revocation and same-owner route rebinding replaces observation without replay",async()=>{
  const f=await fixture(),session=f.session as FixtureSession;let fenced=0,connections=0;
  const history=new HistoryWorkspace({connection:"fixture",principal:"alice"}),transport=new HttpGatewayTransport({url:f.server.url,authorization:"Bearer fixture-alice"});
  const client=new GatewayClient({transport,history,targets:[target],onConnection:()=>{connections++;throw new Error("consumer");},onFence:()=>{fenced++;throw new Error("consumer");}});
  const lease=client.observeHistory(scope,historyScope),observed:number[]=[];const off=client.subscribe(scope,s=>observed.push(s.revision));
  try{await until(()=>observed.length===1&&!!history.session(historyScope).client.current);const next={...target,routeEpoch:"new-read-route"};f.coordinator.register({target:next,session,history:f.hub,authorizeHistory:()=>true});
    client.bindRoute(next);await until(()=>observed.length>=2&&f.coordinator.observation.subscribers===2);session.emit();await until(()=>observed.at(-1)===session.state.revision);
    f.hub.emit(historyScope,[{type:"start",id:"new-route-answer",kind:"assistant",text:"new route"}]);await until(()=>history.session(historyScope).client.current!.rows.length===1);
    session.gate=deferred<Receipt>();const pending=client.submit(request());await until(()=>session.submits.length===1);assert.doesNotThrow(()=>client.fence());assert.equal(fenced,1);assert.equal(connections,1);assert.equal(client.originalCount,0);
    assert.throws(()=>client.snapshot(scope),{code:"CLOSED"});session.gate.resolve({scope,id:"send",type:"send",generation:1,state:"acknowledged"});await assert.rejects(pending,{code:"CLOSED"});assert.equal(session.submits.length,1);
  }finally{off();lease.release();client.fence();await f.close();}
});


test("viewer producer finish drains accepted FIFO while failure and cancellation discard immediately",async()=>{
  const queue=new ViewerQueue<number>(4,1024);let cleanup=0,closed=0;
  queue.setCleanup(()=>cleanup++);queue.onClose(()=>closed++);queue.push(1);queue.push(2);queue.finish();queue.push(3);await queue.closed;
  assert.equal(cleanup,1);assert.equal(closed,1);assert.deepEqual(await queue.next(),{done:false,value:1});assert.deepEqual(await queue.next(),{done:false,value:2});assert.equal((await queue.next()).done,true);
  queue.finish();await queue.return();assert.equal(cleanup,1);
  for(const mode of ["cancel","fail"] as const){const q=new ViewerQueue<number>(4,1024);q.push(1);q.finish();if(mode==="cancel"){await q.return();assert.equal((await q.next()).done,true);}else{q.fail(undefined);await q.next().then(()=>assert.fail("undefined failure must still reject"),error=>assert.equal(error,undefined));}}
  const waiting=new ViewerQueue<number>(4,1024),next=waiting.next();waiting.fail(undefined);await next.then(()=>assert.fail("waiting consumer must reject"),error=>assert.equal(error,undefined));
});

test("401 revokes once before absent or malformed response body decoding; structured denials still revoke",async()=>{
  for(const body of [null,"", "not json",JSON.stringify({error:"UNAUTHENTICATED"})]){
    let denied=0,fenced=0;const transport=new HttpGatewayTransport({url:"http://127.0.0.1/v8",authorization:"Bearer fixture",fetch:async()=>new Response(body,{status:body?.startsWith("{")?409:401}),onUnauthenticated:()=>denied++});
    const client=new GatewayClient({transport,history:new HistoryWorkspace({connection:scope.connection,principal:scope.principal}),targets:[target],onFence:()=>fenced++});
    const results=await Promise.allSettled([client.snapshot(scope),client.snapshot(scope)]);assert.equal(results.every(v=>v.status==="rejected"),true);assert.equal(denied,1);assert.equal(fenced,1);assert.throws(()=>client.snapshot(scope),{code:"CLOSED"});client.close();
  }
});

test("native read HTTP admits read-only exact-run queries and rejects foreign targets and host-kind misuse before native calls",async()=>{
  const coordinator=new GatewayCoordinator(),session=new FixtureSession(),hub=new HistoryHub();hub.open(historyScope);
  const run:RunRef={scope,generation:1,nativeSession:"native"},calls:{run:RunRef;request:NativeRead}[]=[];
  const port:SessionPort=Object.assign(session,{read:async(r:RunRef,q:NativeRead):Promise<NativeReadResult>=>{calls.push({run:r,request:q});return{run:r,type:"codex.goal",goal:null};}});
  coordinator.register({target,session:port,history:hub,authorizeHistory:()=>true});
  const readOnly={...alice,actions:["read"] as const},server=await listenLoopback(coordinator,async()=>readOnly),transport=new HttpGatewayTransport({url:server.url,authorization:"Bearer scripted-read-only"});
  try{
    assert.deepEqual(await transport.read(target,run,{type:"codex.goal"}),{run,type:"codex.goal",goal:null});
    await assert.rejects(transport.read({...target,principal:"foreign"},run,{type:"codex.goal"}),{code:"FORBIDDEN"});
    await assert.rejects(transport.read(target,{...run,scope:{...scope,session:"foreign"}},{type:"codex.goal"}),{code:"FENCED"});
    await assert.rejects(transport.read(target,{...run,generation:2},{type:"codex.goal"}),{code:"FENCED"});
    await assert.rejects(transport.read(target,run,{type:"copilot.queue"}),{code:"INVALID"});
    await assert.rejects(transport.submit(target,request()),{code:"FORBIDDEN"});
    assert.equal(calls.length,1);assert.deepEqual(calls[0],{run,request:{type:"codex.goal"}});assert.equal(session.submits.length,0);
  }finally{transport.close();coordinator.close();await server.close();}
});

test("native read prerequisite awaits retain the gateway budget and Stop or route replacement fences delayed observations",async()=>{
  const coordinator=new GatewayCoordinator({reads:1}),session=new FixtureSession(),hub=new HistoryHub();hub.open(historyScope);
  const run:RunRef={scope,generation:1,nativeSession:"native"},snapshotGate=deferred<void>(),nativeGate=deferred<NativeReadResult>();
  let snapshots=0,calls=0;
  const port:SessionPort=Object.assign(session,{
    snapshot:async()=>{if(++snapshots===1)await snapshotGate.promise;return structuredClone(session.state);},
    read:async():Promise<NativeReadResult>=>{calls++;return nativeGate.promise;},
  });
  const register=(routeEpoch:string)=>coordinator.register({target:{...target,routeEpoch},session:port,history:hub,authorizeHistory:()=>true});register(target.routeEpoch);
  try{
    const pending=coordinator.nativeRead(alice,target,run,{type:"codex.goal"}),fenced=assert.rejects(pending,{code:"FENCED"});
    await until(()=>snapshots===1);assert.equal(coordinator.observation.optionalReads,1);
    const queued=coordinator.snapshot(alice,target);assert.equal(calls,0);
    snapshotGate.resolve();await until(()=>calls===1);
    session.state={...session.state,phase:"stopped",stopRequested:true};
    nativeGate.resolve({run,type:"codex.goal",goal:null});await fenced;assert.equal((await queued).phase,"stopped");
    assert.equal(coordinator.observation.optionalReads,0);assert.equal(session.submits.length,0);
    session.state={...session.state,phase:"running",stopRequested:false};
    const routeGate=deferred<NativeReadResult>();port.read=async()=>{calls++;return routeGate.promise;};
    const old=coordinator.nativeRead(alice,target,run,{type:"codex.goal"}),retired=assert.rejects(old,error=>["FENCED","UNAVAILABLE"].includes(String((error as {code?:string}).code)));
    await until(()=>calls===2);register("native-read-replacement");routeGate.resolve({run,type:"codex.goal",goal:null});await retired;
    assert.equal(coordinator.observation.optionalReads,0);assert.equal(session.submits.length,0);
  }finally{snapshotGate.resolve();nativeGate.resolve({run,type:"codex.goal",goal:null});coordinator.close();}
});

test("cold child recovery proves the exact root origin before watch or older history becomes authorized",async()=>{
  const coordinator=new GatewayCoordinator(),session=new FixtureSession(),hub=new HistoryHub();hub.open(historyScope,{knownStart:true});
  const root=historyScope as CodexScope,child:CodexScope={...root,threadId:"cold-child"},run:RunRef={scope,generation:1,nativeSession:"native"},proofGate=deferred<void>();
  let proofs=0,recoveries=0,olderReads=0;
  const admitted=(s:typeof historyScope)=>{try{hub.snapshot(s);return true;}catch{return false;}};
  coordinator.register({target,session,binding:()=>({run,history:root}),authorizeHistory:admitted,history:{
    watch:(s,c)=>hub.watch(s,c),
    authorize:async s=>{proofs++;await proofGate.promise;hub.open(s,{knownStart:false});return{state:"value",value:true};},
    recover:async()=>{recoveries++;return{state:"value",value:{status:"ready"}};},
    older:async s=>{olderReads++;return{scope:s,generation:hub.snapshot(s).generation,rows:[],olderEdge:{state:"end",evidence:"nativeBoundary"}};},
  }});
  try{
    assert.throws(()=>coordinator.watchHistory(alice,{target,scope:child}),{code:"FENCED"});
    assert.throws(()=>coordinator.older(alice,target,child,"not-admitted"),{code:"FENCED"});
    const pending=coordinator.recover(alice,target,child);await until(()=>proofs===1);assert.equal(recoveries,0);
    for(const origin of [{...child.origin,nativeSession:"foreign-root"},{...child.origin,attachment:"foreign-attachment"}])
      await assert.rejects(coordinator.recover(alice,target,{...child,origin}),{code:"FENCED"});
    assert.equal(proofs,1);assert.equal(olderReads,0);
    proofGate.resolve();assert.deepEqual(await pending,{state:"value",value:{status:"ready"}});assert.equal(recoveries,1);
    const stream=coordinator.watchHistory(alice,{target,scope:child});try{assert.equal((await stream.next()).value!.kind,"snapshot");}finally{await stream.return();}
    await coordinator.older(alice,target,child,"native-cursor",hub.snapshot(child).generation);assert.equal(olderReads,1);assert.equal(session.submits.length,0);
  }finally{proofGate.resolve();coordinator.close();}
});


test('Gateway terminal originals free global admission and unresolved pressure keeps one Stop reserve', async () => {
  const f = await fixture(), transport = new HttpGatewayTransport({ url: f.server.url, authorization: 'Bearer fixture-alice' });
  const client = new GatewayClient({ transport, history: new HistoryWorkspace({ connection: 'fixture', principal: 'alice' }), targets: [target], onFence: () => {}, maxOperations: 1 });
  try {
    for (let i = 0; i < 40; i++) assert.equal((await client.submit(request(`finished-${i}`))).state, 'acknowledged');
    assert.equal(client.originalCount, 0, 'Gateway retains no terminal receipt cache');
    const session = f.session as FixtureSession; session.gate = deferred<Receipt>();
    const pending = client.submit(request('unknown')); await until(() => session.submits.length === 41);
    assert.throws(() => client.submit(request('full')), { code: 'FULL' });
    const stop = { ...request('reserved-stop'), command: { type: 'stop' as const } };
    assert.equal((await client.submit(stop)).state, 'acknowledged'); assert.equal(client.originalCount, 1);
    session.gate.resolve({ scope, id: 'unknown', generation: 1, type: 'send', state: 'acknowledged' }); await pending;
    assert.equal(client.originalCount, 0); assert.equal(session.submits.length, 42);
  } finally { (f.session as FixtureSession).gate?.resolve({ scope, id: 'unknown', generation: 1, type: 'send', state: 'acknowledged' }); client.fence(); await f.close(); }
});
