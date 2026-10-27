import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {allowanceLedger,providerGuard} from './support.mjs';
import {viewerBridges} from './bridge.mjs';
import {respondInBrowser} from './browser.mjs';
import {copilotSdkPayload,isOwnedMcpPermission} from './copilot.mjs';
import {permissionAnswer,permissionToolOutcome} from './codex-permissions.mjs';

test('Codex live permission fixture authorizes only the exact owned read path and preserves unknown-constraint refusal',()=>{
  const path='/owned/finite/read.txt',prompt={type:'codex.permission',requested:{network:{enabled:false},fileSystem:{read:[path],write:[]}}};
  assert.deepEqual(permissionAnswer(prompt,path,'turn'),{type:'codex.permission',grant:'turn'});assert.deepEqual(permissionAnswer(prompt,path,'deny'),{type:'codex.permission',grant:'deny'});
  const literal={path:{type:'path',path},access:'read'},current={...prompt,requested:{...prompt.requested,fileSystem:{...prompt.requested.fileSystem,entries:[literal]}}};
  assert.deepEqual(permissionAnswer(current,path,'turn'),{type:'codex.permission',grant:'turn'});
  assert.equal(permissionToolOutcome(JSON.stringify({permissions:{fileSystem:current.requested.fileSystem},scope:'turn'}),path,'turn').literalEntriesPreserved,true);
  for(const requested of [{...prompt.requested,network:{enabled:true}},{...prompt.requested,fileSystem:{read:[path],write:[path]}},{...prompt.requested,fileSystem:{read:[path,'/foreign'],write:[]}},{...prompt.requested,fileSystem:{read:[path],entries:[]}},{...prompt.requested,fileSystem:{read:[path],write:[],globDepth:1}},{...prompt.requested,other:{}}])assert.throws(()=>permissionAnswer({...prompt,requested},path,'turn'));
  assert.throws(()=>permissionAnswer(prompt,'/foreign','turn'));assert.throws(()=>permissionAnswer(prompt,path,'session'));
  assert.equal(permissionToolOutcome(JSON.stringify({permissions:{file_system:{read:[path]}},scope:'turn'}),path,'turn').verified,true);
  assert.equal(permissionToolOutcome([{type:'input_text',text:JSON.stringify({permissions:{},scope:'turn'})}],path,'deny').verified,true);
  for(const output of ['Assistant says granted',JSON.stringify({permissions:{file_system:{read:[path]}},scope:'session'}),JSON.stringify({permissions:{file_system:{write:[path]}},scope:'turn'}),JSON.stringify({permissions:{network:{enabled:true}},scope:'turn'})])assert.equal(permissionToolOutcome(output,path,'turn').verified,false);
});

test('captured SDK optional fields cross strict JSON without erasing unknown fields or schema constraints',async()=>{
  const {normalizeCopilot}=await import(new URL('../../../v8-integration/.build/primitives/v8-interactions/src/index.js',import.meta.url));
  const scope={connection:'fixture',principal:'owner',host:'host',session:'logical'},run={scope,generation:1,nativeSession:'native'},owner={nativeAgent:'native',relation:'root'};
  const schema={type:'object',properties:{count:{type:'integer',minimum:1,maximum:1}},required:['count']};
  const sdk={sessionId:'native',message:'V8 captured form',mode:'form',elicitationSource:'fixture',requestedSchema:schema,url:undefined};
  const normalize=payload=>normalizeCopilot(run,'capability',null,owner,'elicitation',payload);
  assert.throws(()=>normalize(sdk));
  const prompt=normalize(copilotSdkPayload('elicitation',sdk));assert.equal(prompt.mode,'form');assert.equal(prompt.form.fields.count.minimum,1);assert.equal(prompt.form.fields.count.maximum,1);assert.ok(Object.hasOwn(sdk,'url'));
  assert.throws(()=>normalize(copilotSdkPayload('elicitation',{...sdk,unknown:undefined})));
  assert.throws(()=>normalize(copilotSdkPayload('elicitation',{...sdk,requestedSchema:{...schema,unknown:undefined}})));
  assert.equal(normalize(copilotSdkPayload('elicitation',{...sdk,requestedSchema:{...schema,additionalProperties:false}})).mode,'unsupported');
});

test('native MCP permission accepts only the exact offered namespaced identity and owned empty fixture arguments',()=>{
  const offered='v8_interaction_fixture-v8_interaction_form',native={kind:'mcp',serverName:'v8_interaction_fixture',toolName:offered,args:{}};
  assert.equal(isOwnedMcpPermission(native,offered),true);
  for(const altered of [{...native,toolName:'v8_interaction_form'},{...native,serverName:'foreign'},{...native,kind:'shell'},{...native,args:null},{...native,args:[]},{...native,args:{path:'foreign'}},{...native,toolName:offered+'-extra'}])assert.equal(isOwnedMcpPermission(altered,offered),false);
  assert.equal(isOwnedMcpPermission(native,'foreign-'+offered),false);
});

test('live allowance is exclusive/nonrenewable and proxy authentication/model checks precede upstream admission',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'v8-live-preflight-')),path=join(directory,'ledger.json');let guard,upstream;
  const ledger=allowanceLedger(path,{id:'fixture',status:'running',deadline:Date.now()+60000,providerPosts:0,admissions:[]});
  try{
    assert.throws(()=>allowanceLedger(path,{id:'renewed'}));ledger.admit('codex-root','original');assert.throws(()=>ledger.admit('codex-root','original'));
    let calls=0;upstream=createServer((req,res)=>{calls++;req.resume();req.on('end',()=>res.writeHead(200,{'content-type':'text/event-stream'}).end('data: {"type":"response.completed"}\n\n'))});
    await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
    guard=providerGuard({upstream:`http://127.0.0.1:${upstream.address().port}/v1`,key:'upstream-fixture-private',proxyKey:'proxy-fixture-private-1234567890123456',model:'gpt-6-luna',ledger});
    const endpoint=await guard.listen();
    const send=(token,model)=>fetch(endpoint+'/responses',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({model})});
    assert.equal((await send('wrong','gpt-6-luna')).status,401);assert.equal((await send('proxy-fixture-private-1234567890123456','other')).status,400);assert.equal(calls,0);assert.equal(ledger.state.providerPosts,0);
    assert.equal((await send('proxy-fixture-private-1234567890123456','gpt-6-luna')).status,200);assert.equal(calls,1);assert.equal(ledger.state.providerPosts,1);
    ledger.seal();assert.throws(()=>ledger.admit('codex-root','after-close'));assert.throws(()=>ledger.provider());ledger.complete('fixture-complete');
    const resumed=allowanceLedger(path,{}, {resumeId:'fixture'});assert.equal(resumed.state.providerPosts,1);assert.throws(()=>resumed.admit('codex-root','original'));resumed.complete('fixture-complete');
  }finally{await guard?.close();if(upstream)await new Promise(resolve=>upstream.close(resolve));await rm(directory,{recursive:true,force:true})}
});

test('fresh lower allowance limits survive resume and cannot inherit or renew the earlier campaign budget',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'v8-narrow-allowance-')),path=join(directory,'ledger.json');
  const limits={'codex-root':1,'codex-child':0,'copilot-root':1,'copilot-child':1,'codex-native':1,'copilot-native':1};let ledger;
  try{
    ledger=allowanceLedger(path,{id:'narrow',status:'running',deadline:Date.now()+60000,providerPosts:0,admissions:[],limits,maxProviderPosts:1});
    assert.throws(()=>ledger.admit('codex-child','no-child'));ledger.admit('codex-root','only-root');assert.throws(()=>ledger.admit('codex-root','another-root'));
    ledger.provider();assert.throws(()=>ledger.provider());ledger.complete('fixture-closed');
    ledger=allowanceLedger(path,{limits:{...limits,'codex-root':4},maxProviderPosts:40},{resumeId:'narrow'});
    const snapshot=ledger.state;snapshot.providerPosts=-100;snapshot.limits['codex-root']=4;snapshot.admissions.length=0;
    assert.equal(ledger.state.maxProviderPosts,1);assert.equal(ledger.state.limits['codex-child'],0);assert.throws(()=>ledger.admit('codex-root','after-resume'));assert.throws(()=>ledger.provider());ledger.complete('fixture-closed');
  }finally{await rm(directory,{recursive:true,force:true})}
});

test('actual Chromium response over shared HTTP preserves optional fields, native field names and live feeds after idempotent reconnect',async()=>{
  const buildRoot=new URL('../../../v8-integration/.build/primitives/',import.meta.url);
  const modules=await Promise.all(['v8-gateway/src/gateway/coordinator.js','v8-gateway/src/http/server.js','v8-gateway/src/index.js','v8-history/src/client/workspace.js'].map(path=>import(new URL(path,buildRoot))));
  const core=Object.assign({},...modules),{interactionFixture}=await import(new URL('v8-interactions/qualification/fixture.js',buildRoot));
  const fixture=interactionFixture(),bridges=viewerBridges(core);let bridge;let nativeAnswer;
  try{
    bridge=await bridges.open({scope:fixture.scope,sessionPort:fixture.session.port,interactionPort:fixture.owner});let updates=0;const stop=bridge.interactionPort.subscribe(fixture.scope,()=>updates++);
    await bridge.reconnect();await bridge.reconnect();
    const prompt=fixture.owner.registerCopilot({token:{},requestId:null,owner:{nativeAgent:'root-a',relation:'root'},method:'elicitation',payload:{mode:'form',message:'V8 browser preflight',requestedSchema:{type:'object',properties:{'choice"punctuation':{type:'string',enum:['fixture']},optional:{type:'integer'}},required:['choice"punctuation']}},respond:async value=>{nativeAnswer=value;return{kind:'ack',success:true}}});
    const receipt=await respondInBrowser({bridge,prompt,answer:{type:'copilot.elicitation',action:'accept',content:{'choice"punctuation':'fixture'}},operationId:'preflight-original'});
    assert.equal(receipt.state,'acknowledged');assert.deepEqual(nativeAnswer,{action:'accept',content:{'choice"punctuation':'fixture'}});assert.ok(updates>0);assert.equal(fixture.session.counts().submitted,1);stop();
  }finally{await bridge?.close();await bridges.close();fixture.close()}
});
