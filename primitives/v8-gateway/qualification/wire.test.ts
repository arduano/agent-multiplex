import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { GatewayCoordinator } from "../src/gateway/coordinator.js";
import { createGatewayHttpHandler, listenLoopback } from "../src/http/server.js";
import { createHmacRouteProof } from "../src/node/route-proof.js";
import { GatewayClient } from "../src/client/coordinator.js";
import { HistoryWorkspace } from "../../v8-history/src/client/workspace.js";
import { HttpGatewayTransport } from "../src/client/http.js";
import { McpOwner, McpReadPool } from "../../v8-mcp/src/index.js";
import { FileHost } from "../../v8-files/src/host/index.js";
import type { FilePort } from "../../v8-files/src/contracts/types.js";
import { HistoryHub } from "../../v8-history/src/host/history-owner.js";
import { alice,target,scope,historyScope,FixtureSession,deferred,until,request } from "./fixture.js";
const coordinatorClient=(transport:HttpGatewayTransport)=>new GatewayClient({transport,history:new HistoryWorkspace({connection:scope.connection,principal:scope.principal}),targets:[target],onFence:()=>{}});
const run={scope,generation:1,nativeSession:"native"};
const binding={run,history:historyScope};
const identity={...alice,actions:[...alice.actions,"fileWrite","mcpRefresh"] as const};
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"v8-wire-")),cwd=join(root,"cwd");await mkdir(cwd);
 const fileScope={...scope,session:"native"},files=await FileHost.open({directory:join(root,"files"),bindings:[{scope:fileScope,cwd,dialect:"posix"}]});
 const session=new FixtureSession(),history=new HistoryHub();history.open(historyScope,{knownStart:true});
 const held=deferred<unknown>(),pool=new McpReadPool({maxActive:1});let reads=0;
 const mcp=new McpOwner({run,epoch:1,reads:pool,native:{kind:"codex",status:()=>{reads++;return held.promise;}}});
 const coordinator=new GatewayCoordinator({reads:1});let current:typeof binding|null=binding;
 let readGate:ReturnType<typeof deferred<void>>|undefined,readCalls=0,captureCalls=0;
 const port:FilePort={async call(method,input){if(method==="read"){readCalls++;await readGate?.promise;}if(method==="capture")captureCalls++;return files.call(method,input);}};
 coordinator.register({target,session,history,authorizeHistory:()=>true,mcp,files:{port,scope:()=>current?fileScope:null},binding:()=>current});
 const server=await listenLoopback(coordinator,async auth=>auth==="Bearer full"?identity:auth==="Bearer read"?{...identity,actions:["read"]}:auth==="Bearer bob"?{...identity,principal:"bob"}:null);
 const client=(token="full",onUnauthenticated?:()=>void)=>new HttpGatewayTransport({url:server.url,authorization:`Bearer ${token}`,...(onUnauthenticated?{onUnauthenticated}:{})});
 return {coordinator,session,server,client,files,fileScope,mcp,held,pool,history,cwd,get reads(){return reads;},get readCalls(){return readCalls;},get captureCalls(){return captureCalls;},setCurrent:(value:typeof binding|null)=>{current=value;},holdRead:()=>readGate=deferred<void>(),async close(){readGate?.resolve();held.resolve({data:[],nextCursor:null});mcp.retire();coordinator.close();await server.close();await files.close();await rm(root,{recursive:true,force:true});}};
}
test("explicit HTTPS file origin admits exact capture and bytes while default and foreign origins fail closed",{timeout:15000},async()=>{
 const f=await fixture(),origin="https://gateway.invalid",allowed=[origin];
 const handler=createGatewayHttpHandler(f.coordinator,async auth=>auth==="Bearer full"?identity:null,{allowedFileOrigins:allowed});
 // Configuration mutation after construction cannot authorize another origin,
 // including before the first file route is acquired.
 allowed.push("https://foreign.invalid");
 const server=createServer(handler);await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
 const endpoint=`http://127.0.0.1:${(server.address() as AddressInfo).port}/v8`;
 const withOrigin=(url:string,value:string)=>new HttpGatewayTransport({url,authorization:"Bearer full",fetch:(input,init)=>{const headers=new Headers(init?.headers);headers.set("origin",value);headers.set("x-forwarded-proto","https");return fetch(input,{...init,headers});}});
 const omitted=withOrigin(f.server.url,origin),foreign=withOrigin(endpoint,"https://foreign.invalid"),exact=withOrigin(endpoint,origin);
 const bytes=new TextEncoder().encode("owned HTTPS first-display file"),capture={scope:f.fileScope,sourceKey:"https-origin-capture",path:"preview.txt"};
 try{
  await writeFile(join(f.cwd,"preview.txt"),bytes);
  await assert.rejects(omitted.filePort(target).call("capture",capture),{code:"FENCED"});assert.equal(f.captureCalls,0);
  await assert.rejects(foreign.filePort(target).call("capture",capture),{code:"FENCED"});assert.equal(f.captureCalls,0);
  const port=exact.filePort(target),artifact=await port.call("capture",capture);assert.equal(f.captureCalls,1);
  assert.equal(artifact.sha256,createHash("sha256").update(bytes).digest("hex"));
  const acquired=await port.call("acquire",{scope:f.fileScope,id:artifact.id});
  try{assert.deepEqual(await port.call("read",{scope:f.fileScope,leaseId:acquired.leaseId,offset:0,length:bytes.length}),bytes);}
  finally{await port.call("release",{scope:f.fileScope,leaseId:acquired.leaseId});}
  assert.equal(f.captureCalls,1);assert.equal(f.session.submits.length,0);assert.equal((await f.files.call("usage",{scope:f.fileScope})).activeReads,0);
 }finally{omitted.close();foreign.close();exact.close();handler.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await f.close();}
});
test("wire binding is Host-derived; passive MCP reads never discover and explicit discovery cancels its observer only",async()=>{
 const f=await fixture(),a=f.client(),readOnly=f.client("read"),client=coordinatorClient(a),readClient=coordinatorClient(readOnly);try{
  assert.deepEqual(await a.binding(target),binding);const port=client.mcpPort(scope),off=port.subscribe(run,()=>{});
  assert.equal((await port.snapshot(run)).freshness,"unobserved");assert.equal(f.reads,0);
  await assert.rejects(readClient.mcpPort(scope).refresh(run),{code:"FORBIDDEN"});
  const abort=new AbortController(),pending=port.refresh(run,{signal:abort.signal,timeoutMs:5000});await until(()=>f.pool.active===1);abort.abort();await assert.rejects(pending);await until(()=>f.pool.observers===0);
  assert.equal(f.pool.active,1);assert.equal(f.reads,1);await a.submit(target,{...request("stop"),command:{type:"stop"}});
  f.held.resolve({data:[],nextCursor:null});await until(()=>f.pool.active===0);assert.equal((await port.snapshot(run)).freshness,"current");
  await assert.rejects(port.snapshot({...run,nativeSession:"other"}),{code:"FENCED"});off();f.setCurrent(null);assert.equal(await a.binding(target),null);await assert.rejects(port.snapshot(run),{code:"FENCED"});
 }finally{client.close();readClient.close();await f.close();}
});
test("same authenticated files route preserves native scope and server byte leases; held download disconnect cannot block Stop",async()=>{
 const f=await fixture(),a=f.client(),readOnly=f.client("read"),foreign=f.client("bob");try{
  const data=new TextEncoder().encode("owned immutable bytes"),manifest={id:"fixture",name:"fixture.txt",mediaType:"text/plain",bytes:data.length,sha256:createHash("sha256").update(data).digest("hex")};
  const port=a.filePort(target);assert.equal(a.filePort({...target}),port);await port.call("begin",{scope:f.fileScope,manifest});await port.call("write",{scope:f.fileScope,id:manifest.id,offset:0,data});await port.call("commit",{scope:f.fileScope,id:manifest.id});
  await assert.rejects(readOnly.filePort(target).call("begin",{scope:f.fileScope,manifest:{...manifest,id:"denied"}}),{code:"FENCED"});await assert.rejects(foreign.filePort(target).call("status",{scope:f.fileScope,id:manifest.id}),{code:"FORBIDDEN"});
  await assert.rejects(port.call("status",{scope,id:manifest.id}),{code:"FENCED"});
  const acquired=await port.call("acquire",{scope:f.fileScope,id:manifest.id});assert.deepEqual(await port.call("read",{scope:f.fileScope,leaseId:acquired.leaseId,offset:0,length:data.length}),data);
  a.close();assert.throws(()=>a.filePort(target),{code:"CLOSED"});await assert.rejects(port.call("read",{scope:f.fileScope,leaseId:acquired.leaseId,offset:0,length:1}),{code:"CLOSED"});await port.call("release",{scope:f.fileScope,leaseId:acquired.leaseId});
  const heldClient=f.client(),heldPort=heldClient.filePort(target),gate=f.holdRead(),pending=heldPort.call("acquire",{scope:f.fileScope,id:manifest.id});await until(()=>f.readCalls>=2);heldClient.close();await assert.rejects(pending);assert.equal((await f.files.call("usage",{scope:f.fileScope})).activeReads,1);
  await f.coordinator.submit(identity,target,{...request("stop"),command:{type:"stop"}});gate.resolve();await until(()=>f.readCalls>=2);await until(()=>f.coordinator.observation.urgent===0);for(let i=0;i<30&&(await f.files.call("usage",{scope:f.fileScope})).activeReads;i++)await new Promise(r=>setTimeout(r,5));assert.equal((await f.files.call("usage",{scope:f.fileScope})).activeReads,0);
 }finally{a.close();readOnly.close();foreign.close();await f.close();}
});

test("one retained HTTP FilePort follows proved epochs, pins old byte leases and refuses stale held mutation without replay",async()=>{
 const f=await fixture(),entered=deferred<void>(),held=deferred<void>();let current={...target},hold=false;const routes:string[]=[],mutations:string[]=[];
 const a=new HttpGatewayTransport({url:f.server.url,authorization:'Bearer full',fetch:async(input,init)=>{
  const body=typeof init?.body==='string'?JSON.parse(init.body):null;
  if(body?.method&&['begin','write','commit'].includes(body.method))mutations.push(body.method);
  const response=await fetch(input,init);if(body?.op==='files.route'){routes.push(body.target.routeEpoch);if(hold){hold=false;entered.resolve();await held.promise;}}return response;
 }});
 const register=(epoch:string)=>{current={...target,routeEpoch:epoch};f.coordinator.register({target:current,session:f.session,history:f.history,authorizeHistory:()=>true,binding:()=>binding,files:{port:f.files,scope:()=>f.fileScope}});};
 const data=new TextEncoder().encode('pinned immutable bytes'),manifest={id:'epoch-file',name:'epoch.txt',mediaType:'text/plain',bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')},port=a.filePort(()=>current);
 try{
  await port.call('begin',{scope:f.fileScope,manifest});await port.call('write',{scope:f.fileScope,id:manifest.id,offset:0,data});await port.call('commit',{scope:f.fileScope,id:manifest.id});
  const first=await port.call('acquire',{scope:f.fileScope,id:manifest.id});register('route-2');
  assert.deepEqual(await port.call('read',{scope:f.fileScope,leaseId:first.leaseId,offset:0,length:data.length}),data);
  const second=await port.call('acquire',{scope:f.fileScope,id:manifest.id});assert.equal(a.filePort(()=>current),port);
  assert.deepEqual(await port.call('read',{scope:f.fileScope,leaseId:second.leaseId,offset:0,length:data.length}),data);assert.deepEqual(routes,['route-1','route-2']);
  register('route-3');hold=true;const pending=port.call('begin',{scope:f.fileScope,manifest:{...manifest,id:'never-dispatched'}});await entered.promise;
  register('route-4');held.resolve();await assert.rejects(pending,{code:'FENCED'});assert.deepEqual(mutations,['begin','write','commit']);
  assert.equal((await port.call('status',{scope:f.fileScope,id:manifest.id})).state,'committed');assert.deepEqual(routes,['route-1','route-2','route-3','route-4']);
  const approved=current;current={...current,principal:'different-account'};
  await assert.rejects(port.call('read',{scope:f.fileScope,leaseId:first.leaseId,offset:0,length:1}),{code:'FENCED'});current=approved;
  for(const lease of [first,second])await port.call('release',{scope:f.fileScope,leaseId:lease.leaseId});assert.equal((await f.files.call('usage',{scope:f.fileScope})).activeReads,0);
 }finally{held.resolve();a.close();await f.close();}
});
test("server auth revocation closes private feeds and late results without cancelling admitted native discovery",async()=>{
 const f=await fixture();let denied=0;const a=f.client("full",()=>{denied++;throw Error("consumer callback");}),client=coordinatorClient(a);try{
  const observed:unknown[]=[],off=client.mcpPort(scope).subscribe(run,v=>observed.push(v));await until(()=>f.coordinator.observation.subscribers===1);
  const refresh=client.mcpPort(scope).refresh(run,{timeoutMs:5000});await until(()=>f.reads===1);f.server.revoke(identity);await assert.rejects(refresh);await until(()=>f.coordinator.observation.subscribers===0&&f.pool.observers===0);const count=observed.length;
  await until(()=>denied===1);await assert.rejects(a.binding(target),{code:"CLOSED"});assert.equal(denied,1);
  let explicitDenials=0;const fresh=f.client("full",()=>{explicitDenials++;throw Error("consumer callback");});
  try{await assert.rejects(fresh.binding(target),{code:"UNAUTHENTICATED"});await assert.rejects(fresh.binding(target),{code:"CLOSED"});assert.equal(explicitDenials,1);}finally{fresh.close();}
  f.held.resolve({data:[],nextCursor:null});await until(()=>f.pool.active===0);assert.equal(observed.length,count);assert.equal((await f.mcp.snapshot(run)).freshness,"current");off();
 }finally{client.close();await f.close();}
});
test("remote authenticated owner proof binds exact scope/route, rejects tampering/replay and fences revocation before forwarding",async()=>{
 const key=randomBytes(32),proof=createHmacRouteProof({issuer:"host",audience:"gateway",secret:key}),wrong=createHmacRouteProof({issuer:"host",audience:"other",secret:key});
 const gateway=new GatewayCoordinator({},proof.verify),session=new FixtureSession(),history=new HistoryHub();history.open(historyScope,{knownStart:true});const route={target,session,history,authorizeHistory:()=>true};
 try{
  await assert.rejects(gateway.registerRemote(route,"Bearer owner-only"),{code:"FORBIDDEN"});await assert.rejects(gateway.registerRemote(route,wrong.issue(target)),{code:"FORBIDDEN"});await assert.rejects(gateway.registerRemote({...route,target:{...target,authority:"other"}},proof.issue(target)),{code:"FORBIDDEN"});
  await gateway.registerRemote(route,proof.issue(target));await gateway.submit(identity,target,request());
  const next={...target,routeEpoch:"route-2"};await gateway.registerRemote({...route,target:next},proof.issue(next));assert.equal((await gateway.receipt(identity,target,"send"))!.state,"acknowledged");
  await assert.rejects(gateway.registerRemote(route,proof.issue(target)),{code:"FENCED"});const queued=gateway.submit(identity,next,request("queued-before-revoke"));proof.revoke();await assert.rejects(queued,{code:"UNAVAILABLE"});assert.throws(()=>gateway.receipt(identity,target,"send"),{code:"UNAVAILABLE"});assert.throws(()=>gateway.submit(identity,next,request("forbidden")),{code:"UNAVAILABLE"});assert.equal(session.submits.length,1);
 }finally{gateway.close();}
});


test("MCP and file prerequisites enter the existing read budget before any held binding or snapshot",async()=>{
  for(const operation of ["snapshot","refresh","watch","files"] as const){
    const coordinator=new GatewayCoordinator({reads:1,readQueue:1}),session=new FixtureSession(),history=new HistoryHub();history.open(historyScope,{knownStart:true});
    const gate=deferred<typeof binding>();let bindings=0,subscriptions=0;
    const mcp={snapshot:async()=>({run,epoch:1,revision:1,freshness:"unobserved" as const,servers:[],coverage:"unknown" as const,observedAt:null,management:"unavailable-no-original-command" as const,kind:"codex" as const,discovery:"thread-scoped-discovery" as const}),refresh:async()=>{throw Error("No discovery required");},subscribe:()=>{subscriptions++;return()=>subscriptions--;}};
    coordinator.register({target,session,history,authorizeHistory:()=>true,binding:()=>{bindings++;return gate.promise;},mcp,files:{scope:()=>({...scope,session:"native"}),port:{call:async()=>{throw Error("No bytes required");}}}});
    // All candidates are structurally valid. The occupied prerequisite owns the only slot.
    const begin=()=>operation==="snapshot"?coordinator.mcpSnapshot(identity,target,run):operation==="refresh"?coordinator.mcpRefresh(identity,target,run):operation==="watch"?coordinator.watchMcp(identity,target,run):coordinator.fileSurface(identity,target);
    const pending=begin();let queued:ReturnType<typeof coordinator.mcpSnapshot>|undefined;
    try{
      await until(()=>bindings===1);assert.equal(coordinator.observation.optionalReads,1);
      queued=coordinator.mcpSnapshot(identity,target,run);
      await assert.rejects(coordinator.mcpSnapshot(identity,target,run),{code:"FULL"});await assert.rejects(coordinator.mcpRefresh(identity,target,run),{code:"FULL"});await assert.rejects(coordinator.watchMcp(identity,target,run),{code:"FULL"});await assert.rejects(coordinator.fileSurface(identity,target),{code:"FULL"});assert.equal(bindings,1,"A waiting read cannot enter held prerequisites");
      await coordinator.submit(identity,target,{...request(`stop-${operation}`),command:{type:"stop"}});assert.equal(session.submits.length,1);assert.equal(coordinator.observation.optionalReads,1);
      gate.resolve(binding);if(operation==="refresh")await assert.rejects(pending,/No discovery required/);else{const value=await pending;if(operation==="watch")await(value as Awaited<ReturnType<typeof coordinator.watchMcp>>).return();}
      assert.equal((await queued).freshness,"unobserved");assert.equal(bindings,2);
      assert.equal(coordinator.observation.optionalReads,0);assert.equal(subscriptions,0);
    }finally{gate.resolve(binding);coordinator.close();await Promise.allSettled(queued?[pending,queued]:[pending]);}
  }
});
