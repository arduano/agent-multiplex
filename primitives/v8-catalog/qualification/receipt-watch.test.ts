import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { SessionHost } from "../../v8-lifecycle-default/src/session/index.js";
import { ScriptedPort } from "../../v8-session/qualification/host-fixture.js";
import type { Receipt, SessionSnapshot, NativePort } from "../../v8-session/src/contracts/types.js";
import type { HostCreationStatus } from "../src/contracts/types.js";
import { sessionScope } from "../src/contracts/types.js";
import { sessionCreationHost } from "../../v8-lifecycle-default/src/catalog.js";
import { fixture, request, scope, defer, until } from "./fixtures.js";
const policy={kind:"codex",access:{approval:"on-request",sandbox:"danger-full-access"},provider:"copilot-only"} as const;

test("late committed SessionHost Create receipt publishes catalog binding without a manual check or repeated Create",async()=>{
 const f=await fixture(),r=request(),s=sessionScope(r),native=new ScriptedPort(),gate=defer<void>();native.startGate=gate.promise;
 const host=await SessionHost.open({directory:join(f.directory,"host"),scope:s,port:native,policy,observationMs:5});
 let creates=0,manualReads=0,subscribed=0,released=0;const published:string[]=[];
 const proxy={snapshot:host.snapshot.bind(host),receipt:host.receipt.bind(host),subscribe:host.subscribe.bind(host),submit:host.submit.bind(host),subscribeReceipt:(...args:Parameters<SessionHost["subscribeReceipt"]>)=>{subscribed++;const release=host.subscribeReceipt(...args);return()=>{released++;release();};}};
 const adapter=sessionCreationHost({target:r.target,resolve:async()=>proxy});
 f.authority.register({target:r.target,create:async original=>{creates++;return adapter.create(original);},read:async original=>{manualReads++;return adapter.read(original);},watch:adapter.watch!});
 const ack=defer<void>();host.subscribeReceipt(s,r.id,receipt=>{if(receipt.state==="acknowledged")ack.resolve();});
 const off=f.authority.subscribe(scope,entry=>{if(entry.binding)published.push(entry.binding.nativeSession);});
 try{
  const uncertain=await f.authority.create(r);assert.equal(uncertain.state,"outcomeUnknown");assert.equal(native.starts.length,1);assert.equal(subscribed,1);assert.deepEqual(published,[]);
  gate.resolve();await until(()=>published.length>0);assert.equal(published.at(-1),"native-original");assert.equal(creates,1);assert.equal(manualReads,0);await until(()=>released===1);
  await ack.promise;assert.equal((await host.receipt(s,r.id))!.state,"acknowledged");assert.equal((await host.snapshot(s)).phase,"running");assert.equal((await host.snapshot(s)).issue,undefined);
  assert.equal((await f.authority.get(scope,r.session))!.binding!.nativeSession,"native-original");
 }finally{off();gate.resolve();await host.terminate();await f.dispose();}
});

test("exact receipt subscriptions are bounded, committed and answer-redacted; close discards late notifications",async()=>{
 const f=await fixture(),r=request(),s=sessionScope(r),native=new ScriptedPort(),host=await SessionHost.open({directory:join(f.directory,"host"),scope:s,port:native,policy,observationMs:1000});
 const releases:(()=>void)[]=[];const states:Receipt[]=[];let ackRead:Promise<Receipt|null>|undefined;
 try{
  for(let n=0;n<128;n++)releases.push(host.subscribeReceipt(s,"bounded",()=>{}));assert.throws(()=>host.subscribeReceipt(s,"overflow",()=>{}),{code:"BUSY"});releases.pop()!();releases.push(host.subscribeReceipt(s,"replacement",()=>{}));releases.forEach(release=>release());
  assert.throws(()=>host.subscribeReceipt({...s,principal:"other"},"bounded",()=>{}),{code:"FENCED"});
  const created=defer<void>();const off=host.subscribeReceipt(s,r.id,receipt=>{states.push(receipt);if(receipt.state==="acknowledged"){ackRead=host.receipt(s,r.id);created.resolve();}});await host.submit({scope:s,id:r.id,generation:0,command:{type:"create"}});await created.promise;assert.equal((await ackRead)!.state,"acknowledged");assert.equal(states.at(-1)!.state,"acknowledged");off();
  native.emit({run:native.run!,type:"interactions",complete:true,items:[{id:"form",owner:"root",kind:"elicitation",choices:["accept"]}]});native.outcomes.push({status:"accepted",detail:{secret:"must-not-persist"}});
  const answers:Receipt[]=[],answered=defer<void>();host.subscribeReceipt(s,"answer",receipt=>{answers.push(receipt);if(receipt.state==="acknowledged")answered.resolve();});await host.submit({scope:s,id:"answer",generation:1,command:{type:"answer",interactionId:"form",choice:"accept",value:{private:"sensitive"}}});await answered.promise;assert.equal(answers.at(-1)!.state,"acknowledged");assert.doesNotMatch(JSON.stringify(answers),/must-not-persist|sensitive/);assert.deepEqual(answers.at(-1)!.outcome,{status:"accepted"});
  const held=defer<void>();native.invokeGate=held.promise.then(()=>({status:"accepted" as const}));let late=0;host.subscribeReceipt(s,"late",()=>late++);const pending=host.submit({scope:s,id:"late",generation:1,command:{type:"send",text:"owned"}}).then(value=>({state:"value" as const,value}),error=>({state:"error" as const,error}));await until(()=>native.calls.some(value=>value.type==="send"));await host.terminate();const before=late;held.resolve();await native.invokeGate;const completed=await pending;if(completed.state==="error")assert.equal(completed.error?.code,"CLOSED");await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(late,before);assert.throws(()=>host.subscribeReceipt(s,"other",()=>{}),{code:"CLOSED"});
 }finally{await host.terminate();await f.dispose();}
});

test("catalog watched status is terminal-monotone and replacement/close release old capabilities",async()=>{
 const f=await fixture(),r=request();let listener:((status:HostCreationStatus)=>void)|undefined,releases=0,creates=0;
 const owner={target:r.target,create:async()=>{creates++;return{state:"unknown" as const};},read:async()=>({state:"unknown" as const}),watch:async(_original:unknown,fn:(status:HostCreationStatus)=>void)=>{listener=fn;return()=>{releases++;};}};
 try{
  f.authority.register(owner);assert.equal((await f.authority.create(r)).state,"outcomeUnknown");
  const terminal=defer<void>();const off=f.authority.subscribe(scope,e=>{if(e.binding)terminal.resolve();});listener!({state:"unknown"});listener!({state:"created",binding:{nativeSession:"late",generation:1,kind:"codex",placement:"shared"}});listener!({state:"unknown"});
  // A later unknown callback must not replace a queued positive terminal observation.
  await terminal.promise;assert.equal((await f.authority.get(scope,r.session))!.binding!.nativeSession,"late");assert.equal(releases,1);assert.equal(creates,1);off();
  const next=request("next","b");await f.authority.create(next);const stale=listener!;f.authority.register({...owner,target:{...r.target,owner:"replacement"}});assert.equal(releases,2);stale({state:"created",binding:{nativeSession:"untrusted-late",generation:1,kind:"codex",placement:"shared"}});assert.equal((await f.authority.get(scope,next.session))!.binding,null);
  f.authority.register(owner);await f.authority.create(request("third","c"));await f.authority.close();assert.equal(releases,3);listener!({state:"created",binding:{nativeSession:"after-close",generation:1,kind:"codex",placement:"shared"}});
 }finally{await f.dispose();}
});

test("Create observer deadline cannot label an already Running native initialization uncertain",async t=>{
 const f=await fixture(),r=request(),s=sessionScope(r),native=new ScriptedPort(),host=await SessionHost.open({directory:join(f.directory,"host"),scope:s,port:native,policy,observationMs:137});
 const originalTimer=globalThis.setTimeout;let expired:(()=>void)|undefined,delayed=false;const running:SessionSnapshot[]=[];
 // Own only the caller-observation clock. Native start and SQLite transitions remain actual scripted work.
 t.mock.method(globalThis,"setTimeout",((callback:(...args:unknown[])=>void,ms?:number,...args:unknown[])=>{
  if(ms===137){expired=()=>callback(...args);return originalTimer(()=>{},60000);}return originalTimer(callback,ms,...args);
 }) as unknown as typeof setTimeout);
 const terminal=defer<void>();host.subscribeReceipt(s,r.id,receipt=>{if(receipt.state==="acknowledged")terminal.resolve();});
 host.subscribe(s,snapshot=>{if(snapshot.phase==="running"){running.push(snapshot);if(!delayed){delayed=true;expired?.();}}});
 try{await host.submit({scope:s,id:r.id,generation:0,command:{type:"create"}});await terminal.promise;assert.ok(delayed);assert.ok(expired);assert.ok(running.length);assert.equal((await host.snapshot(s)).issue,undefined);assert.ok(running.every(value=>value.issue!=="startUnconfirmed"));}
 finally{t.mock.restoreAll();await host.terminate();await f.dispose();}
});

test("early owned native identity publishes catalog while Host is Starting and original Create remains unknown",async()=>{
 const f=await fixture(),r=request(),s=sessionScope(r),native=new ScriptedPort(),initialize=defer<void>();let snapshotReleased=0,receiptReleased=0;
 const port:NativePort={kind:native.kind,protocol:native.protocol,placement:native.placement,capabilities:native.capabilities,inspect:native.inspect.bind(native),catalog:native.catalog.bind(native),start:async(input,emit,onOwned)=>{
  const run=await native.start(input,emit),early={...run,initializationComplete:false};await onOwned?.(early);await initialize.promise;return{...run,initializationComplete:true};
 }};
 const host=await SessionHost.open({directory:join(f.directory,"host"),scope:s,port,policy,observationMs:5});
 const proxy={snapshot:host.snapshot.bind(host),receipt:host.receipt.bind(host),submit:host.submit.bind(host),subscribe:(...args:Parameters<SessionHost["subscribe"]>)=>{const release=host.subscribe(...args);return()=>{snapshotReleased++;release();};},subscribeReceipt:(...args:Parameters<SessionHost["subscribeReceipt"]>)=>{const release=host.subscribeReceipt(...args);return()=>{receiptReleased++;release();};}};
 f.authority.register(sessionCreationHost({target:r.target,resolve:async()=>proxy}));
 const unknown=defer<void>();host.subscribeReceipt(s,r.id,value=>{if(value.state==="outcomeUnknown")unknown.resolve();});
 try{
  const created=await f.authority.create(r);await unknown.promise;assert.equal(created.state,"nativeCreated");assert.equal(created.native!.nativeSession,"native-original");assert.equal(native.starts.length,1);
  const current=await host.snapshot(s);assert.equal(current.phase,"starting");assert.equal((await host.receipt(s,r.id))!.state,"outcomeUnknown");assert.equal((await f.authority.get(scope,r.session))!.binding!.nativeSession,"native-original");assert.equal(snapshotReleased,1);assert.equal(receiptReleased,1);
  const acknowledged=defer<void>();host.subscribeReceipt(s,r.id,value=>{if(value.state==="acknowledged")acknowledged.resolve();});initialize.resolve();await acknowledged.promise;assert.equal((await host.snapshot(s)).phase,"running");assert.equal(native.starts.length,1);
 }finally{initialize.resolve();await host.terminate();await f.dispose();}
});
