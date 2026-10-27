import assert from "node:assert/strict";
import test from "node:test";
import { request as httpRequest } from "node:http";
import { GatewayCoordinator } from "../src/gateway/coordinator.js";
import { GatewayClient, type Observation } from "../src/client/coordinator.js";
import { HttpGatewayTransport } from "../src/client/http.js";
import { HistoryWorkspace } from "../../v8-history/src/client/workspace.js";
import { target,scope,historyScope,request,deferred,until,fixture,FixtureSession,alice } from "./fixture.js";
import type { CatalogEntry, CatalogPort, Creation } from "../../v8-catalog/src/contracts/types.js";
import type { InteractionSnapshot } from "../../v8-interactions/src/contracts.js";

test("actual HTTP slow reader overflows its bounded stream while healthy retained viewer and second older read remain independent",async()=>{
  const f=await fixture({coordinator:new GatewayCoordinator({frames:4,bytes:262144,reads:2})}),session=f.session as FixtureSession,observations:Observation[]=[];
  let scriptedExceptionReads=0;
  const next={...target,routeEpoch:"two-viewer-route"};f.coordinator.register({target:next,session,history:{watch:(s,c)=>f.hub.watch(s,c),older:async s=>{scriptedExceptionReads++;return{scope:s,generation:f.hub.owner(s).snapshot().generation,rows:[],olderEdge:{state:"end",evidence:"nativeBoundary"}};}},authorizeHistory:()=>true});
  const history=new HistoryWorkspace({connection:scope.connection,principal:scope.principal}),transport=new HttpGatewayTransport({url:f.server.url,authorization:"Bearer fixture-alice"});
  const client=new GatewayClient({transport,history,targets:[next],onFence:()=>{},onObservation:v=>observations.push(v)}),lease=client.observeHistory(scope,historyScope);
  let slow:ReturnType<typeof httpRequest>|undefined;
  try{
    await until(()=>!!history.session(historyScope).client.current);assert.equal(scriptedExceptionReads,0);
    const headers=new Promise<void>((resolve,reject)=>{slow=httpRequest(f.server.url,{method:"POST",headers:{authorization:"Bearer fixture-alice","content-type":"application/json"}},response=>{response.pause();resolve();});slow.once("error",reject);slow.end(JSON.stringify({op:"history.watch",target:next,scope:historyScope}));});await headers;
    await until(()=>f.coordinator.observation.subscribers===2);
    const pages=await Promise.all([transport.older(next,historyScope,"first-viewer-older"),transport.older(next,historyScope,"second-viewer-older")]);
    assert.equal(pages.length,2);assert.equal(scriptedExceptionReads,2);assert.equal(session.state.phase,"running");assert.equal(f.coordinator.observation.subscribers,2);
    const text="x".repeat(60000);f.hub.emit(historyScope,[{type:"start",id:"large",kind:"assistant",text}]);
    let produced=0;
    for(let i=0;i<400&&f.coordinator.observation.subscribers===2;i++){
      f.hub.emit(historyScope,[{type:"replace",id:"large",kind:"assistant",text:`${i}:${text}`}]);produced++;
      const revision=f.hub.owner(historyScope).snapshot().revision;await until(()=>history.session(historyScope).client.current!.revision===revision);
    }
    await until(()=>f.coordinator.observation.subscribers===1);assert.ok(produced<400,"Slow viewer reached bounded closure");
    f.hub.emit(historyScope,[{type:"finish",id:"large",kind:"assistant",lifecycle:"completed",sealCaptured:true}]);await until(()=>history.session(historyScope).client.current!.rows[0]!.lifecycle==="completed");
    assert.equal(scriptedExceptionReads,2);assert.equal(session.submits.length,0);assert.equal(session.state.phase,"running");
    assert.ok(observations.some(v=>v.state==="live"));
  }finally{slow?.destroy();lease.release();client.fence();await f.close();}
});
test("oversized retained snapshot closes only requesting viewer and emits observation freshness without native lifetime changes",async()=>{
  const f=await fixture({coordinator:new GatewayCoordinator({bytes:2048})}),session=f.session as FixtureSession,events:Observation[]=[];
  const history=new HistoryWorkspace({connection:"fixture",principal:"alice"}),transport=new HttpGatewayTransport({url:f.server.url,authorization:"Bearer fixture-alice"}),client=new GatewayClient({transport,history,targets:[target],onFence:()=>{},onObservation:v=>events.push(v)});
  try{f.hub.emit(historyScope,[{type:"start",id:"big",kind:"assistant",text:"s".repeat(4096)}]);const lease=client.observeHistory(scope,historyScope);
    await until(()=>events.some(v=>v.kind==="history"&&v.state==="unavailable"));assert.equal(f.coordinator.observation.subscribers,0);assert.equal(session.state.phase,"running");
    assert.equal((await transport.snapshot(target)).phase,"running");await transport.submit(target,{...request("urgent"),command:{type:"stop"}});assert.equal(session.submits.length,1);lease.release();
  }finally{client.fence();await f.close();}
});
test("typed catalog and interaction reads route only to authenticated owner; callback answers retain SessionPort write ownership",async()=>{
  const f=await fixture(),session=f.session as FixtureSession,catalogScope={connection:"fixture",principal:"alice",authority:"root"};
  const entry:CatalogEntry={scope:catalogScope,session:"logical",target:{host:"host",owner:"durable-owner",kind:"codex",placement:"shared"},createId:"create",version:1,revision:1,metadata:{name:"Original",cwd:null},binding:{nativeSession:"native",generation:1,kind:"codex",placement:"shared"}};
  const creation:Creation={original:{scope:catalogScope,id:"create",session:"logical",target:entry.target,metadata:entry.metadata},entry,state:"nativeCreated",native:entry.binding,publication:"committed"};
  let catalogReads=0,creates=0,answers=0;const catalog:CatalogPort={list:async()=>{catalogReads++;return[entry];},get:async()=>entry,creation:async()=>creation,create:async()=>{creates++;return creation;},rename:async()=>entry,setWatched:async()=>{throw Error("not used");},metadataOriginal:async()=>null,subscribe:(_s,listener)=>{listener(entry);return()=>{};}};
  f.coordinator.registerCatalog({scope:catalogScope,owner:"catalog-owner",port:catalog});
  const interactions:InteractionSnapshot={scope,run:{scope,generation:1,nativeSession:"native"},epoch:1,revision:1,baseline:"complete",items:[]};
  const t={...target,routeEpoch:"with-interactions"};f.coordinator.register({target:t,session,history:f.hub,interactions:{snapshot:async()=>interactions,subscribe:(_s,listener)=>{listener(interactions);return()=>{};}},authorizeHistory:()=>true});
  const viewer=f.make(),transport=viewer.transport;viewer.client.bindRoute(t);
  try{assert.equal((await transport.list(catalogScope))[0]!.metadata.name,"Original");assert.equal((await transport.creation(catalogScope,"create"))!.state,"nativeCreated");
    assert.equal((await viewer.client.interactionPort(scope).snapshot(scope)).baseline,"complete");const seen=deferred<void>();const off=viewer.client.interactionPort(scope).subscribe(scope,()=>seen.resolve());await seen.promise;off();
    await viewer.client.submit({...request("reply"),command:{type:"answer",interactionId:"opaque-interaction",choice:"approve"}});answers=session.submits.filter(v=>v.command.type==="answer").length;assert.equal(answers,1);
    await assert.rejects(transport.list({...catalogScope,principal:"bob"}),{code:"FORBIDDEN"});assert.equal(catalogReads,1);assert.equal(creates,0);
  }finally{viewer.client.fence();await f.close();}
});
