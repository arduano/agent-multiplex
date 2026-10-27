import assert from 'node:assert/strict';
import test from 'node:test';
import {viewerBridges} from '../../../v8-interactions/qualification/live/bridge.mjs';
import {respondInBrowser} from './browser.mjs';

test('reusable React native popup answers one exact real HTTP original while SDK-submitted remains weaker than native completion',async()=>{
 const root=new URL('../../.build/primitives/',import.meta.url);
 const core=Object.assign({},...await Promise.all(['v8-gateway/src/gateway/coordinator.js','v8-gateway/src/http/server.js','v8-gateway/src/index.js','v8-history/src/client/workspace.js'].map(path=>import(new URL(path,root)))));
 const {interactionFixture}=await import(new URL('v8-interactions/qualification/fixture.js',root));
 const f=interactionFixture(),bridges=viewerBridges(core);let bridge,nativeAnswer;
 try{
  bridge=await bridges.open({scope:f.scope,sessionPort:f.session.port,interactionPort:f.owner});
  const prompt=f.owner.registerCopilot({token:{},requestId:null,owner:{nativeAgent:'root-a',relation:'root'},method:'userInput',payload:{question:'Choose the owned fixture value',choices:['First','Second'],allowFreeform:false},respond:async answer=>{nativeAnswer=answer;return{kind:'submitted'}}});
  const receipt=await respondInBrowser({bridge,prompt,answer:{type:'copilot.question',answer:'Second',wasFreeform:false},operationId:'react-popup-original'});
  assert.deepEqual(nativeAnswer,{answer:'Second',wasFreeform:false});assert.equal(receipt.state,'acknowledged');
  assert.deepEqual(receipt.outcome,{status:'acknowledged',detail:{response:'submitted',agentWork:'notEstablished'}});
  assert.equal(f.owner.current().items[0].state,'responseSubmitted');assert.equal(f.session.counts().submitted,1);
 }finally{await bridge?.close();await bridges.close();f.close()}
});
