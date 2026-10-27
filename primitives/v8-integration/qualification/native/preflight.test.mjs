import assert from 'node:assert/strict';
import test from 'node:test';
import {realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {nativeBudget,seedLimits,ownedCommands,redactor,snapshotObservation,receiptObservation,errorObservation,recoveryObservation,persistedJournalUnavailable,knownUnsentResumeUnavailable,verifyToolMetadata} from './support.mjs';
import {runNativeModelFree} from './run.mjs';

test('native model-free entry refuses absent allowance or source freeze before any native/provider setup',async()=>{
 await assert.rejects(runNativeModelFree({}),/allow-native-model-free/);
 await assert.rejects(runNativeModelFree({allowNativeModelFree:true}),/source\/toolchain must be frozen/);
 await assert.rejects(runNativeModelFree({allowLunaSeeds:true}),/source\/toolchain must be frozen/);
 await assert.rejects(runNativeModelFree({allowNativeModelFree:true,allowLunaSeeds:true,frozenSource:true}),/one finite qualification profile/);
 // Missing explicit inputs refuse before tool, configuration or credential reads.
 await assert.rejects(runNativeModelFree({allowNativeModelFree:true,frozenSource:true}),/Explicit native toolRoot is required/);
 const explicit={allowNativeModelFree:true,frozenSource:true,toolRoot:'/unavailable-owned-tools',configFile:'/unavailable-owned-config',keyFile:'/unavailable-owned-key',provider:'fixture-provider',model:'fixture-model'};
 for(const name of['configFile','keyFile','provider','model']){const input={...explicit};delete input[name];await assert.rejects(runNativeModelFree(input),new RegExp('Explicit native '+name+' is required'));}
 await assert.rejects(runNativeModelFree({...explicit,provider:'invalid.provider'}),{code:'ERR_ASSERTION'});
});
test('seed originals admit once per host and remain separate from model-free and exhausted native groups',()=>{
 const admissions=[],ledger={admit:(kind,label)=>admissions.push({kind,label})},budget=nativeBudget(ledger,Date.now()+1000,seedLimits);
 budget.send('codex','seed-original');budget.send('copilot','seed-original');assert.throws(()=>budget.send('codex','new-original'),/Send allowance exhausted/);assert.equal(admissions.length,2);assert.deepEqual(admissions.map(value=>value.kind),['codex-root','copilot-root']);
 budget.seal();assert.throws(()=>budget.send('copilot','after-close'),/admission closed/);assert.throws(()=>nativeBudget(ledger,Date.now()+1000).send('codex','disallowed'),/Send allowance exhausted/);
});
test('native group/root allowance admits each original once and closing cannot replenish it',()=>{
 const admissions=[],ledger={admit:(kind,label)=>admissions.push({kind,label})},budget=nativeBudget(ledger,Date.now()+1000);
 budget.root('codex','first');budget.root('codex','second');assert.throws(()=>budget.root('codex','third'),/root allowance/);
 assert.throws(()=>budget.admit('codex','first'),/cannot replay/);for(let i=0;i<12;i++)budget.admit('codex',`probe-${i}`);assert.throws(()=>budget.admit('codex','overflow'),/allowance exhausted/);
 budget.seal();assert.throws(()=>budget.admit('copilot','after-close'),/admission closed/);assert.equal(admissions.length,14);
});
test('owned command instrumentation rejects foreign CID and preserves exact cleanup after normal control admission exhausts',async()=>{
 const id='a'.repeat(64),other='b'.repeat(64),calls=[];const commands=ownedCommands({exec:async args=>{calls.push(args);return args[0]==='create'?`${id}\n`:''}},{maxCalls:1});
 await commands.exec(['create','--pull=never','--label','multiplex.v8.kind=agent']);await assert.rejects(commands.exec(['container','inspect',id]),/bound exhausted/);
 commands.beginCleanup();await assert.rejects(commands.exec(['rm','--force','--volumes',other]),/not owned/);assert.equal(calls.length,1);
 await commands.exec(['rm','--force','--volumes',id]);assert.equal((await commands.proveAbsent()).allAbsent,true);assert.equal(calls.length,3);
});
test('fresh unsent Copilot journal exception requires exact native session and native RPC error identity',()=>{
 const id='private-native-session',error={code:-32603,message:`Request sessions.readPersistedEvents failed with message: Persisted event journal is unavailable for session ${id}`};
 assert.equal(persistedJournalUnavailable(error,id),true);assert.equal(persistedJournalUnavailable(error,'other-native'),false);assert.equal(persistedJournalUnavailable({...error,code:-32000},id),false);assert.equal(persistedJournalUnavailable({...error,message:'Other native failure'},id),false);
});
test('Resume limitation requires exact original, known unsent journal exception and new native Resume RPC failure; never a certificate failure',()=>{
 const scope={connection:'fixture',principal:'owner',host:'copilot',session:'logical'},original={scope,id:'original-resume',generation:1,command:{type:'resume'}},receipt={scope,id:original.id,type:'resume',generation:1,state:'outcomeUnknown'},snapshot={scope,phase:'starting',generation:2,nativeSession:'private-native'};
 const value={kind:'copilot',historyUnavailable:true,original,receipt,snapshot,nativeSession:'private-native',beforeDiagnostics:[],afterDiagnostics:[{owner:'agent',stage:'session.resume',state:'failed',nativeCode:-32603}]};
 assert.equal(knownUnsentResumeUnavailable(value),true);
 for(const changed of[{kind:'codex'},{historyUnavailable:false},{receipt:{...receipt,id:'other'}},{snapshot:{...snapshot,phase:'running'}},{snapshot:{...snapshot,nativeSession:'other'}},{beforeDiagnostics:value.afterDiagnostics},{afterDiagnostics:[{owner:'agent',stage:'session.resume',state:'fulfilled'},{owner:'agent',stage:'certificate',state:'failed',nativeCode:-32603}]}])assert.equal(knownUnsentResumeUnavailable({...value,...changed}),false);
});
test('native tool manifest follows compiled Host SDK resolution and includes both private dependency copies plus actual Node executable',async()=>{
 const framework=resolve(fileURLToPath(new URL('../../../..',import.meta.url))),tools=await verifyToolMetadata(framework,join(framework,'primitives/v8-host/.build/native-stage2'));
 assert.equal(tools.actualSdk,'primitives/v8-host/node_modules/@github/copilot-sdk');assert.equal(tools.versions.node,process.version);assert.ok(tools.inputs.includes(await realpath(process.execPath)));
 for(const lane of['v8-host','v8-integration'])for(const file of['@github/copilot-sdk/dist/index.js','@github/copilot-sdk/package.json','vscode-jsonrpc/lib/node/main.js','vscode-jsonrpc/package.json'])assert.ok(tools.inputs.includes(join(framework,'primitives',lane,'node_modules',file)),`Missing concrete private tool input ${lane}/${file}`);
 assert.ok(tools.inputs.some(path=>path.endsWith('/@github/copilot-sdk-linux-x64/prebuilds/linux-x64/runtime.node')));
});
test('native diagnostics keep bounded control evidence and exclude native bodies, provider configuration and private error fields',()=>{
 const secret='qualification-private-secret',scrub=value=>redactor([secret])(value.message);
 const snapshot=snapshotObservation({phase:'starting',activity:'unknown',generation:1,epoch:2,revision:3,nativeSession:secret,stopRequested:false,interactionsComplete:false,interactions:[{payload:secret}],selection:{provider:secret},scope:{principal:secret},raw:secret});
 const receipt=receiptObservation({id:'original-create',type:'create',generation:0,state:'outcomeUnknown',reason:'observationExpired',outcome:{status:'acknowledged',detail:{payload:secret}},scope:{principal:secret},raw:secret});
 const error=errorObservation(Object.assign(Error(`failed ${secret} at https://private.invalid/provider ${'x'.repeat(600)}`),{code:'NATIVE_PAGE_FAILED',response:{apiKey:secret},cause:secret}),scrub);
 const recovery=recoveryObservation({state:'failed',code:'NATIVE_PAGE_FAILED',value:{status:'ready',page:{rows:[secret]}},raw:secret});
 assert.equal(snapshot.nativeId,true);assert.equal(snapshot.interactionCount,1);assert.equal(receipt.state,'outcomeUnknown');assert.equal(error.code,'NATIVE_PAGE_FAILED');assert.ok(error.message.length<=512);assert.deepEqual(recovery,{state:'failed',code:'NATIVE_PAGE_FAILED'});
 const encoded=JSON.stringify({snapshot,receipt,error,recovery});assert.equal(encoded.includes(secret),false);assert.equal(encoded.includes('private.invalid'),false);assert.equal(encoded.includes('response'),false);assert.equal(encoded.includes('selection'),false);assert.equal(encoded.includes('rows'),false);
});
