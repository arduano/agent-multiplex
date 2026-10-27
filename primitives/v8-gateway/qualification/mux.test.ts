import test from "node:test";
import assert from "node:assert/strict";
import { HttpGatewayTransport } from "../src/client/http.js";
import { ViewerQueue } from "../src/contracts/queue.js";
import { GatewayError, type GatewayTransport } from "../src/contracts/types.js";
import { GatewayClient, type RecoveryClock } from "../src/client/coordinator.js";
import { GatewayCoordinator } from "../src/gateway/coordinator.js";
import { listenLoopback } from "../src/http/server.js";
import { HistoryWorkspace } from "../../v8-history/src/client/workspace.js";
import { HistoryHub } from "../../v8-history/src/host/history-owner.js";
import { McpOwner,McpReadPool } from "../../v8-mcp/src/index.js";
import type { CatalogEntry,CatalogPort } from "../../v8-catalog/src/contracts/types.js";
import type { InteractionSnapshot } from "../../v8-interactions/src/contracts.js";
import { alice,target,scope,historyScope,request,FixtureSession,deferred,until,fixture } from "./fixture.js";

test('finite HTTP deadlines cover headers and bodies, fence late responses and never resend an uncertain original', { timeout: 5000 }, async () => {
 for (const heldAt of ['headers', 'body'] as const) {
  const held = deferred<Response>(); let calls = 0, cancelled = 0;
  const transport = new HttpGatewayTransport({ url: 'http://127.0.0.1:1/v8', authorization: 'fixture', requestTimeoutMs: 30,
   fetch: async () => { calls++; return heldAt === 'headers' ? held.promise : new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"value":')); }, cancel() { cancelled++; },
   })); },
  });
  const client = new GatewayClient({ transport, history: new HistoryWorkspace({ connection: scope.connection, principal: scope.principal }), targets: [target], onFence() {} });
  try {
   await assert.rejects(client.submit(request(`uncertain-${heldAt}`)), { code: 'TIMEOUT' });
   assert.equal(client.originalCount, 1); assert.equal(calls, 1);
   if (heldAt === 'headers') held.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })));
   await until(() => cancelled === 1);
   assert.equal(calls, 1, 'Observation expiry cannot replay the original');
  } finally { held.resolve(new Response('{"value":null}')); client.close(); }
 }
});

test('watch opening has a deadline, while an admitted quiet stream outlives that deadline', { timeout: 5000 }, async () => {
 for (const ready of [false, true]) {
  let controller!: ReadableStreamDefaultController<Uint8Array>, posts = 0, cancelled = 0;
  const transport = new HttpGatewayTransport({ url: 'http://127.0.0.1:1/v8', authorization: 'fixture', requestTimeoutMs: 30, fetch: async (_url, init) => {
   const request = JSON.parse(String(init?.body)); posts++;
   if (request.op !== 'watch.open') return new Response('{"value":null}');
   return new Response(new ReadableStream<Uint8Array>({ start(stream) { controller = stream; if (ready) controller.enqueue(new TextEncoder().encode('{"type":"value","value":{"type":"ready","channel":"fixture-channel"}}\n')); }, cancel() { cancelled++; } }));
  } });
  const abort = new AbortController(), iterator = transport.watchSession(target, abort.signal)[Symbol.asyncIterator]();
  try {
   const first = iterator.next();
   if (!ready) { await assert.rejects(first, { code: 'TIMEOUT' }); assert.equal(posts, 1); }
   else {
    await until(() => posts === 2); await new Promise(resolve => setTimeout(resolve, 80));
    controller.enqueue(new TextEncoder().encode(`{"type":"value","value":{"type":"event","id":"w1","value":${JSON.stringify(new FixtureSession().state)}}}\n`));
    assert.equal((await first).value?.phase, 'running');
   }
  } finally { abort.abort(); transport.close(); await iterator.return?.(); await until(() => cancelled === 1); }
 }
});

test("nine logical domain feeds share one physical channel; spontaneous physical recovery and explicit reconnect restore every callback without discovery or effects",async()=>{
 const gateway=new GatewayCoordinator(),sessionA=new FixtureSession(),sessionB=new FixtureSession(),scopeB={...scope,session:"other"},targetB={...target,session:"other"},historyB={...historyScope,origin:{...historyScope.origin,nativeSession:"native-b"},threadId:"native-b"};sessionB.state={...sessionB.state,scope:scopeB,nativeSession:"native-b"};
 const hub=new HistoryHub();hub.open(historyScope,{knownStart:true});hub.open(historyB,{knownStart:true});
 const catalogScope={connection:scope.connection,principal:scope.principal,authority:target.authority};const catalogListeners=new Set<(entry:CatalogEntry)=>void>();
 const entry:CatalogEntry={scope:catalogScope,session:scope.session,target:{host:target.host,owner:target.owner,kind:"codex",placement:"shared"},createId:"create",version:1,revision:1,metadata:{name:"kept",cwd:null},binding:{nativeSession:"native",generation:1,kind:"codex",placement:"shared"}};
 const catalog:CatalogPort={list:async()=>[entry],get:async()=>entry,create:async()=>{throw Error("No mutation expected");},creation:async()=>null,rename:async()=>entry,setWatched:async()=>{throw Error("No mutation expected");},metadataOriginal:async()=>null,subscribe:(_s,fn)=>{catalogListeners.add(fn);return()=>{catalogListeners.delete(fn);};}};gateway.registerCatalog({scope:catalogScope,owner:"catalog-owner",port:catalog});
 const callbackListeners=[new Set<(s:InteractionSnapshot)=>void>(),new Set<(s:InteractionSnapshot)=>void>()];const owners:McpOwner[]=[];let nativeReads=0;
 for(const [n,t,s,h,session]of [[0,target,scope,historyScope,sessionA],[1,targetB,scopeB,historyB,sessionB]] as const){const run={scope:s,generation:1,nativeSession:h.origin.nativeSession},owner=new McpOwner({run,epoch:1,reads:new McpReadPool(),native:{kind:"codex",status:async()=>{nativeReads++;return{data:[],nextCursor:null};}}});owners.push(owner);const snapshot:InteractionSnapshot={scope:s,run,epoch:1,revision:1,baseline:"complete",items:[]};gateway.register({target:t,session,history:hub,mcp:owner,binding:()=>({run,history:h}),authorizeHistory:value=>value.origin.nativeSession===run.nativeSession,interactions:{snapshot:async()=>snapshot,subscribe:(_s,fn)=>{callbackListeners[n]!.add(fn);fn(snapshot);return()=>{callbackListeners[n]!.delete(fn);};}}});}
 const server=await listenLoopback(gateway,async auth=>auth==="Bearer fixture"?alice:null);let physical=0,subscribes=0;const dropConnections:(()=>void)[]=[];
 const fetcher:typeof fetch=async(input,init)=>{
  const body=JSON.parse(String(init?.body));if(body.op==="watch.subscribe")subscribes++;
  const response=await fetch(input,init);if(body.op!=="watch.open")return response;physical++;
  const reader=response.body!.getReader();
  return new Response(new ReadableStream<Uint8Array>({start(controller){dropConnections.push(()=>{controller.error(new TypeError("Owned simulated UI link drop"));void reader.cancel();});void(async()=>{try{for(;;){const part=await reader.read();if(part.done){controller.close();return;}controller.enqueue(part.value);}}catch(error){try{controller.error(error);}catch{/* Already dropped. */}}})();},cancel:()=>reader.cancel()}),{headers:response.headers,status:response.status});
 };
 const transport=new HttpGatewayTransport({url:server.url,authorization:"Bearer fixture",fetch:fetcher}),history=new HistoryWorkspace({connection:scope.connection,principal:scope.principal}),client=new GatewayClient({transport,history,targets:[target,targetB],onFence:()=>{}});
 let catalogEvents=0,interactions=0,mcpEvents=0;const off=[client.catalogPort().subscribe(catalogScope,()=>catalogEvents++),client.subscribe(scope,()=>{}),client.subscribe(scopeB,()=>{})],leases=[client.observeHistory(scope,historyScope),client.observeHistory(scopeB,historyB)];
 for(const t of[target,targetB])off.push(client.interactionPort(t.session===scope.session?scope:scopeB).subscribe(t.session===scope.session?scope:scopeB,()=>interactions++));
 for(const [i,t]of[target,targetB].entries())off.push(client.mcpPort(i?scopeB:scope).subscribe({scope:i?scopeB:scope,generation:1,nativeSession:i?"native-b":"native"},()=>mcpEvents++));
 try{
  await until(()=>gateway.observation.subscribers===9&&interactions===2&&!!history.session(historyB).client.current);assert.equal(physical,1);assert.equal(subscribes,9);assert.equal(nativeReads,0);assert.equal((await transport.snapshot(targetB)).phase,"running");await client.submit({...request("urgent"),command:{type:"stop"}});assert.equal(sessionA.submits.length,1);
  dropConnections[0]!();await until(()=>physical===2&&gateway.observation.subscribers===9&&interactions===4);assert.equal(nativeReads,0);assert.equal(sessionA.submits.length,1);assert.equal(subscribes,18);
  leases[0]!.release();await until(()=>gateway.observation.subscribers===8);sessionB.emit();hub.emit(historyB,[{type:"start",id:"kept",kind:"assistant",text:"first"}]);await until(()=>history.session(historyB).client.current!.rows.length===1);
  client.disconnect();await until(()=>gateway.observation.subscribers===0);assert.equal(physical,2);for(const owner of owners)owner.invalidate((await owner.snapshot(owner===owners[0]?{scope,generation:1,nativeSession:"native"}:{scope:scopeB,generation:1,nativeSession:"native-b"})).run);assert.equal(nativeReads,0);
  leases.push(client.observeHistory(scope,historyScope));off.push(client.interactionPort(scope).subscribe(scope,()=>interactions++));assert.equal(physical,2);client.reconnect();await until(()=>gateway.observation.subscribers===9&&physical===3&&interactions===7);for(const fn of catalogListeners)fn(entry);for(const owner of owners)owner.invalidate((await owner.snapshot(owner===owners[0]?{scope,generation:1,nativeSession:"native"}:{scope:scopeB,generation:1,nativeSession:"native-b"})).run);await until(()=>catalogEvents===1&&mcpEvents===2);assert.equal(nativeReads,0);assert.equal(sessionA.submits.length,1);
 }finally{for(const release of off)release();for(const lease of leases)lease.release();client.fence();owners.forEach(owner=>owner.retire());gateway.close();await server.close();}
});

test("channel controls bind full authenticated capabilities and late async acquisition releases after physical close",async()=>{
 const gateway=new GatewayCoordinator(),session=new FixtureSession(),hub=new HistoryHub();hub.open(historyScope,{knownStart:true});const run={scope,generation:1,nativeSession:"native"},held=deferred<{run:typeof run;history:typeof historyScope}>();let bindings=0;
 const owner=new McpOwner({run,epoch:1,reads:new McpReadPool(),native:{kind:"codex",status:async()=>{throw Error("No discovery");}}});gateway.register({target,session,history:hub,mcp:owner,binding:()=>{bindings++;return held.promise;},authorizeHistory:()=>true});
 const server=await listenLoopback(gateway,async authorization=>authorization==="Bearer full"?alice:authorization==="Bearer attenuated"?{...alice,actions:[]}:null);
 const post=(token:string,value:unknown)=>fetch(server.url,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(value)});
 const response=await post("full",{op:"watch.open"}),reader=response.body!.getReader();const initial=await reader.read(),channel=JSON.parse(new TextDecoder().decode(initial.value).trim()).value.channel as string;
 try{
  const denied=await post("attenuated",{op:"watch.subscribe",channel,id:"forbidden",request:{op:"session.watch",target}});assert.equal(denied.status,403);assert.equal(gateway.observation.subscribers,0);
  const pending=post("full",{op:"watch.subscribe",channel,id:"late",request:{op:"mcp.watch",target,run}});await until(()=>bindings===1);await reader.cancel();await new Promise(resolve=>setTimeout(resolve,20));held.resolve({run,history:historyScope});assert.equal((await pending).status,409);await until(()=>gateway.observation.subscribers===0);
 }finally{held.resolve({run,history:historyScope});await reader.cancel().catch(()=>undefined);owner.retire();gateway.close();await server.close();}
});

test("logical cancellation before subscribe ACK waits exact registration and releases only that feed",async()=>{
 const f=await fixture(),gate=deferred<void>();let held=false,physical=0;
 const transport=new HttpGatewayTransport({url:f.server.url,authorization:"Bearer fixture-alice",fetch:async(input,init)=>{const body=JSON.parse(String(init?.body));if(body.op==="watch.open")physical++;const response=await fetch(input,init);if(body.op==="watch.subscribe"&&!held){held=true;await gate.promise;}return response;}});
 const first=new AbortController(),other=new AbortController(),a=transport.watchSession(target,first.signal)[Symbol.asyncIterator](),b=transport.watchSession(target,other.signal)[Symbol.asyncIterator]();const initialA=a.next(),initialB=b.next();
 try{await until(()=>held&&f.coordinator.observation.subscribers===2);first.abort();await initialA;assert.equal((await initialB).done,false);gate.resolve();await until(()=>f.coordinator.observation.subscribers===1);(f.session as FixtureSession).emit();assert.equal((await b.next()).done,false);assert.equal(physical,1);assert.equal((f.session as FixtureSession).submits.length,0);}
 finally{gate.resolve();first.abort();other.abort();transport.close();await a.return?.();await b.return?.();await f.close();}
});

test("logical failure before subscribe ACK is an explicit iterator error rather than successful EOF",async()=>{
 const f=await fixture({coordinator:new GatewayCoordinator({bytes:2048})}),gate=deferred<void>();let registered=false;
 f.hub.emit(historyScope,[{type:"start",id:"oversized",kind:"assistant",text:"x".repeat(4096)}]);
 const transport=new HttpGatewayTransport({url:f.server.url,authorization:"Bearer fixture-alice",fetch:async(input,init)=>{const response=await fetch(input,init);if(JSON.parse(String(init?.body)).op==="watch.subscribe"){registered=true;await gate.promise;}return response;}}),controller=new AbortController();
 const reader=transport.watchHistory({target,scope:historyScope},controller.signal)[Symbol.asyncIterator]();
 try{await assert.rejects(reader.next(),{code:"OVERFLOW"});assert.equal(registered,true);assert.equal((f.session as FixtureSession).submits.length,0);}
 finally{gate.resolve();controller.abort();transport.close();await reader.return?.();await f.close();}
});

test("parent disconnect aborts a pending observer control and fences late acquisition without aborting effects",async()=>{
 const gateway=new GatewayCoordinator(),session=new FixtureSession(),hub=new HistoryHub();hub.open(historyScope,{knownStart:true});const run={scope,generation:1,nativeSession:"native"},held=deferred<{run:typeof run;history:typeof historyScope}>();let bindings=0,nativeReads=0;
 const owner=new McpOwner({run,epoch:1,reads:new McpReadPool(),native:{kind:"codex",status:async()=>{nativeReads++;return{data:[],nextCursor:null};}}});gateway.register({target,session,history:hub,mcp:owner,binding:()=>{bindings++;return held.promise;},authorizeHistory:()=>true});
 const server=await listenLoopback(gateway,async()=>alice);let registration:AbortSignal|undefined;
 const transport=new HttpGatewayTransport({url:server.url,authorization:"Bearer owned",fetch:async(input,init)=>{if(JSON.parse(String(init?.body)).op==="watch.subscribe")registration=init?.signal??undefined;return fetch(input,init);}});
 const history=new HistoryWorkspace({connection:scope.connection,principal:scope.principal}),client=new GatewayClient({transport,history,targets:[target],onFence:()=>{}}),off=client.mcpPort(scope).subscribe(run,()=>{});
 try{await until(()=>bindings===1&&!!registration);assert.equal(registration!.aborted,false);client.disconnect();assert.equal(registration!.aborted,true);held.resolve({run,history:historyScope});await until(()=>gateway.observation.subscribers===0);client.reconnect();await until(()=>gateway.observation.subscribers===1);assert.equal(nativeReads,0);assert.equal(session.submits.length,0);}
 finally{held.resolve({run,history:historyScope});off();client.close();owner.retire();gateway.close();await server.close();}
});


test("graceful logical EOF before subscribe ACK drains every accepted frame",async()=>{
 const coordinator=new GatewayCoordinator(),session=new FixtureSession(),hub=new HistoryHub();hub.open(historyScope,{knownStart:true});
 const seed=hub.watch(historyScope),frame=(await seed.next()).value!;await seed.return();
 coordinator.register({target,session,history:{watch:()=> (async function*(){yield frame;yield frame;})()},authorizeHistory:()=>true});
 const server=await listenLoopback(coordinator,async()=>alice),gate=deferred<void>();let registration=false;
 const transport=new HttpGatewayTransport({url:server.url,authorization:"Bearer fixture",fetch:async(input,init)=>{const response=await fetch(input,init);if(JSON.parse(String(init?.body)).op==="watch.subscribe"){registration=true;await gate.promise;}return response;}}),control=new AbortController(),iterator=transport.watchHistory({target,scope:historyScope},control.signal)[Symbol.asyncIterator]();
 try{assert.deepEqual((await iterator.next()).value,frame);assert.deepEqual((await iterator.next()).value,frame);assert.equal((await iterator.next()).done,true);assert.equal(registration,true);assert.equal(coordinator.observation.subscribers,0);}
 finally{gate.resolve();control.abort();transport.close();await iterator.return?.();coordinator.close();await server.close();}
});

class FakeClock implements RecoveryClock{
 nowMs=0;serial=0;readonly timers=new Map<number,{at:number;callback:()=>void}>();readonly delays:number[]=[];
 now(){return this.nowMs;}
 setTimeout(callback:()=>void,delay:number){const id=++this.serial;this.delays.push(delay);this.timers.set(id,{at:this.nowMs+delay,callback});return id;}
 clearTimeout(timer:unknown){this.timers.delete(timer as number);}
 async advance(ms:number){this.nowMs+=ms;for(const [id,timer]of [...this.timers])if(timer.at<=this.nowMs){this.timers.delete(id);timer.callback();}await new Promise<void>(resolve=>setImmediate(resolve));}
}
test("remote CLOSED rejoins the same epoch through authenticated restoration; local close cancels renewal",async()=>{
 const clock=new FakeClock(),session=new FixtureSession(),queues:ViewerQueue<typeof session.state>[]=[],epochs:string[]=[];let restores=0,effects=0,bodyReads=0;
 const transport:GatewayTransport={snapshot:()=>session.snapshot(),submit:async()=>{effects++;throw Error('No mutation');},receipt:async()=>null,older:async()=>{bodyReads++;throw Error('No history read');},watchHistory:async function*(){bodyReads++;throw Error('No history read');},watchSession:async function*(current,signal,ready){epochs.push(current.routeEpoch);const queue=new ViewerQueue<typeof session.state>(16,1048576);queues.push(queue);const abort=()=>{void queue.return();};signal.addEventListener('abort',abort,{once:true});try{ready?.();yield*queue;}finally{signal.removeEventListener('abort',abort);await queue.return();}},close(){}};
 const values:number[]=[],client=new GatewayClient({transport,history:new HistoryWorkspace({connection:scope.connection,principal:scope.principal}),targets:[target],onFence(){assert.fail('Same-account restart cannot revoke the client');},clock,random:()=>1,beforeObserve:async()=>{restores++;}}),off=client.subscribe(scope,value=>values.push(value.revision));
 try{
  await clock.advance(0);assert.deepEqual(epochs,[target.routeEpoch]);
  queues[0]!.fail(new GatewayError('CLOSED'));await clock.advance(0);
  assert.equal(clock.timers.size,1);assert.equal(clock.delays.at(-1),250);
  await clock.advance(250);assert.equal(restores,1);assert.deepEqual(epochs,[target.routeEpoch,target.routeEpoch]);
  queues[1]!.push(session.state);await clock.advance(0);assert.deepEqual(values,[session.state.revision]);
  queues[1]!.fail(new GatewayError('CLOSED'));await clock.advance(0);assert.equal(clock.timers.size,1);
  client.close();assert.equal(clock.timers.size,0);await clock.advance(120000);
  assert.equal(restores,1);assert.equal(epochs.length,2);assert.equal(effects,0);assert.equal(bodyReads,0);
 }finally{off();client.close();assert.equal(clock.timers.size,0);}
});
test("one recovery scheduler caps indefinitely, isolates terminal feeds, fences restoration and cancels exact retired descriptors",async()=>{
 const clock=new FakeClock(),queues:ViewerQueue<ReturnType<FixtureSession["snapshot"]> extends Promise<infer T>?T:never>[]=[];let starts=0,restores=0;
 const session=new FixtureSession(),transport:GatewayTransport={snapshot:()=>session.snapshot(),submit:async()=>{throw Error("Never resend");},receipt:async()=>null,older:async()=>{throw Error("No native read");},watchHistory:async function*(){throw Error("No history needed");},watchSession:async function*(_target,signal,ready){starts++;const queue=new ViewerQueue<typeof session.state>(16,1048576);queues.push(queue);const abort=()=>{void queue.return();};signal.addEventListener("abort",abort,{once:true});try{ready?.();yield*queue;}finally{signal.removeEventListener("abort",abort);await queue.return();}},close(){}};
 const seen:number[]=[],events:string[]=[],client=new GatewayClient({transport,history:new HistoryWorkspace({connection:scope.connection,principal:scope.principal}),targets:[target],onFence(){},clock,random:()=>1,onReady:()=>{restores++;},onObservation:observation=>events.push(observation.state)}),off=client.subscribe(scope,value=>seen.push(value.revision));
 try{
  await clock.advance(0);assert.equal(restores,1);
  const expected=[250,500,1000,2000,4000,8000,16000,30000,30000,30000];
  for(const delay of expected){queues.at(-1)!.fail(new GatewayError("UNAVAILABLE"));await clock.advance(0);assert.equal(clock.timers.size,1);assert.equal(clock.delays.at(-1),delay);await clock.advance(delay);}
  assert.equal(starts,11);assert.equal(restores,11);await clock.advance(30000);queues.at(-1)!.fail(new GatewayError("TIMEOUT"));await clock.advance(0);assert.equal(clock.delays.at(-1),250);await clock.advance(250);
  queues.at(-1)!.fail(new GatewayError("FENCED"));await clock.advance(0);assert.equal(clock.timers.size,0);const count=starts;await clock.advance(120000);assert.equal(starts,count);
  client.reconnect();await clock.advance(0);assert.equal(starts,count+1);queues.at(-1)!.push(session.state);await clock.advance(0);assert.deepEqual(seen,[session.state.revision]);
  queues.at(-1)!.fail(new GatewayError("FULL"));await clock.advance(0);assert.equal(clock.timers.size,1);off();assert.equal(clock.timers.size,0);await clock.advance(30000);assert.equal(starts,count+1);
  assert.equal(events.includes("unavailable"),true);
 }finally{off();client.close();assert.equal(clock.timers.size,0);}
});

test("admission restoration cannot block frames and stale restoration cannot revive a replaced feed",async()=>{
 const clock=new FakeClock(),gate=deferred<void>(),session=new FixtureSession(),queues:ViewerQueue<typeof session.state>[]=[];let restored=0;
 const transport:GatewayTransport={snapshot:()=>session.snapshot(),submit:async()=>{throw Error("No effect");},receipt:async()=>null,older:async()=>{throw Error("No native read");},watchHistory:async function*(){},watchSession:async function*(_target,signal,ready){const queue=new ViewerQueue<typeof session.state>(16,1048576);queues.push(queue);const abort=()=>{void queue.return();};signal.addEventListener("abort",abort,{once:true});try{ready?.();yield*queue;}finally{signal.removeEventListener("abort",abort);await queue.return();}},close(){}};
 const events:string[]=[],values:number[]=[],client=new GatewayClient({transport,history:new HistoryWorkspace({connection:scope.connection,principal:scope.principal}),targets:[target],onFence(){},clock,onReady:()=>++restored===1?gate.promise:undefined,onObservation:value=>events.push(value.state)}),off=client.subscribe(scope,value=>values.push(value.revision));
 try{await clock.advance(0);for(let i=0;i<40;i++){queues[0]!.push({...session.state,revision:i});await clock.advance(0);}assert.equal(values.length,40);assert.equal(events.includes("live"),false);
  client.bindRoute({...target,routeEpoch:"new"});await clock.advance(0);assert.equal(restored,2);assert.equal(events.filter(v=>v==="live").length,1);gate.resolve();await clock.advance(0);assert.equal(events.filter(v=>v==="live").length,1);
 }finally{gate.resolve();off();client.close();}
});

test("logical restore failure retries only that feed on the healthy channel and explicit disconnect cancels retry",async()=>{
 const clock=new FakeClock(),other={...scope,session:"other"},otherTarget={...target,session:"other"},session=new FixtureSession(),starts=new Map<string,number>(),queues=new Map<string,ViewerQueue<typeof session.state>>();let restored=0,disconnects=0;
 const transport:GatewayTransport={snapshot:async t=>({...session.state,scope:t.session===scope.session?scope:other}),submit:async()=>{throw Error("No replay");},receipt:async()=>null,older:async()=>{throw Error("No native read");},watchHistory:async function*(){},watchSession:async function*(t,signal,ready){starts.set(t.session,(starts.get(t.session)??0)+1);const queue=new ViewerQueue<typeof session.state>(16,1048576);queues.set(t.session,queue);const abort=()=>{void queue.return();};signal.addEventListener("abort",abort,{once:true});try{ready?.();yield*queue;}finally{signal.removeEventListener("abort",abort);await queue.return();}},disconnect(){disconnects++;},close(){}};
 const observations:string[]=[],client=new GatewayClient({transport,history:new HistoryWorkspace({connection:scope.connection,principal:scope.principal}),targets:[target,otherTarget],onFence(){},clock,random:()=>1,onReady:async value=>{if(value.scope===undefined)throw Error("Missing scope");if(value.kind==="session"&&value.scope.session===scope.session&&++restored===1)throw new GatewayError("UNAVAILABLE");},onObservation:value=>observations.push(`${value.kind}:${"session" in value.scope?value.scope.session:"catalog"}:${value.state}`)}),off=client.subscribe(scope,()=>{}),otherValues:number[]=[],offOther=client.subscribe(other,value=>otherValues.push(value.revision));
 try{
  await clock.advance(0);assert.equal(clock.timers.size,1);assert.equal(starts.get(scope.session),1);assert.equal(starts.get(other.session),1);assert.equal(disconnects,0);
  queues.get(other.session)!.push({...session.state,scope:other});await clock.advance(0);assert.equal(otherValues.length,1);
  await clock.advance(250);assert.equal(starts.get(scope.session),2);assert.equal(starts.get(other.session),1);assert.equal(observations.includes(`session:${scope.session}:live`),true);
  queues.get(scope.session)!.finish();await clock.advance(0);assert.equal(clock.timers.size,1);client.disconnect();assert.equal(clock.timers.size,0);await clock.advance(30000);assert.equal(starts.get(scope.session),2);assert.equal(disconnects,1);
 }finally{off();offOther();client.close();}
});

test("one route restoration joins failed feeds and uses existing backoff, retaining exact originals through a proved epoch replacement",async()=>{
 const clock=new FakeClock(),session=new FixtureSession(),other={...scope,session:'other'},otherTarget={...target,session:'other'},held=deferred<void>();
 const queues:ViewerQueue<typeof session.state>[]=[],epochs:string[]=[],receipts:string[]=[];let restores=0,client!:GatewayClient;
 const {session:_session,...host}=target;
 const transport:GatewayTransport={snapshot:()=>session.snapshot(),submit:async(_t,value)=>{const {outcome:_outcome,...receipt}=await session.submit(value);return{...receipt,state:'outcomeUnknown'};},receipt:async(t,id)=>{receipts.push(t.routeEpoch);return session.receipt(scope,id);},older:async()=>{throw Error('No history read');},watchHistory:async function*(){throw Error('No history acquisition');},watchSession:async function*(t,signal,ready){epochs.push(t.routeEpoch);const queue=new ViewerQueue<typeof session.state>(16,1048576);queues.push(queue);const abort=()=>{void queue.return();};signal.addEventListener('abort',abort,{once:true});try{ready?.();yield*queue;}finally{signal.removeEventListener('abort',abort);await queue.return();}},close(){}};
 client=new GatewayClient({transport,history:new HistoryWorkspace({connection:scope.connection,principal:scope.principal}),targets:[target,otherTarget],hostTargets:[host],onFence(){},clock,random:()=>1,beforeObserve:async()=>{if(++restores===1)await held.promise;client.bindHostRoute({...host,routeEpoch:'route-2'});}});
 const off=[client.subscribe(scope,()=>{}),client.subscribe(other,()=>{})];
 try{
  await clock.advance(0);await client.submit(request());assert.equal(restores,0);
  for(const queue of queues)queue.fail(new GatewayError('UNAVAILABLE'));await clock.advance(0);assert.equal(clock.timers.size,1);
  await clock.advance(250);assert.equal(restores,1);assert.equal(epochs.length,2);assert.equal(clock.timers.size,0);
  held.reject(new GatewayError('UNAVAILABLE'));await clock.advance(0);assert.equal(clock.timers.size,1);assert.equal(clock.delays.at(-1),500);
  await clock.advance(500);assert.equal(restores,2);assert.deepEqual(epochs,['route-1','route-1','route-2','route-2']);
  assert.throws(()=>client.submit(request()),{code:'ALREADY_ATTEMPTED'});
  assert.equal((await client.receipt(scope,request().id))?.state,'acknowledged');assert.deepEqual(receipts,['route-2']);assert.equal(client.originalCount,0);assert.equal(session.submits.length,1);
 }finally{held.resolve();off.forEach(release=>release());client.close();assert.equal(clock.timers.size,0);}
});

for(const changed of [false,true])test(`FENCED gets one configured restoration and ${changed?'a proved new epoch revives its observation':'unchanged configuration keeps it terminal'}`,async()=>{
 const clock=new FakeClock(),session=new FixtureSession(),queues:ViewerQueue<typeof session.state>[]=[],epochs:string[]=[];let restores=0,client!:GatewayClient;
 const {session:_session,...host}=target;
 const transport:GatewayTransport={snapshot:()=>session.snapshot(),submit:async()=>{throw Error('No effects');},receipt:async()=>null,older:async()=>{throw Error('No history read');},watchHistory:async function*(){},watchSession:async function*(t,signal,ready){epochs.push(t.routeEpoch);const queue=new ViewerQueue<typeof session.state>(16,1048576);queues.push(queue);const abort=()=>{void queue.return();};signal.addEventListener('abort',abort,{once:true});try{ready?.();yield*queue;}finally{signal.removeEventListener('abort',abort);await queue.return();}},close(){}};
 client=new GatewayClient({transport,history:new HistoryWorkspace({connection:scope.connection,principal:scope.principal}),targets:[target],hostTargets:[host],onFence(){},clock,random:()=>1,beforeObserve:async()=>{restores++;client.bindHostRoute({...host,routeEpoch:changed?'route-2':'route-1'});}});
 const off=client.subscribe(scope,()=>{});
 try{await clock.advance(0);queues[0]!.fail(new GatewayError('FENCED'));await clock.advance(0);await clock.advance(250);assert.equal(restores,1);assert.deepEqual(epochs,changed?['route-1','route-2']:['route-1']);assert.equal(clock.timers.size,0);await clock.advance(60000);assert.equal(restores,1);}
 finally{off();client.close();}
});
