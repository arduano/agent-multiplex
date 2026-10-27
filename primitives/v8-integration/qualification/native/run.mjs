import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {dirname,join,relative,resolve,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {allowanceLedger,providerGuard,bounded} from '../../../v8-interactions/qualification/live/support.mjs';
import {limits,seedLimits,integrationLimits,manifest,nativeBudget,redactor,sha,verifyToolMetadata} from './support.mjs';
import {qualifyNativeHost} from './hosts.mjs';

const here=dirname(fileURLToPath(import.meta.url)),integration=resolve(here,'../..'),framework=resolve(integration,'../..');
export async function runNativeModelFree(options={}){
 const requested=[options.allowNativeModelFree,options.allowLunaSeeds,options.allowLiveIntegration].filter(value=>value===true);
 assert.ok(requested.length>0,'Explicit --allow-native-model-free, --allow-luna-seeds or --allow-live-integration is required');
 assert.equal(requested.length,1,'Choose one finite qualification profile');
 assert.equal(options.frozenSource,true,'Selected checkpoint source/toolchain must be frozen before native qualification');
 const profile=options.allowLiveIntegration?'live-integration':options.allowLunaSeeds?'luna-seed':'model-free',bounds=profile==='live-integration'?integrationLimits:profile==='luna-seed'?seedLimits:limits;
 assert.ok(process.platform==='linux'&&process.arch==='x64','Pinned Linux x64 tools required');
 const selected=options.harness??'all';assert.ok(['all','codex','copilot'].includes(selected));
 for(const key of['toolRoot','configFile','keyFile','provider','model'])assert.ok(typeof options[key]==='string'&&options[key].length>0,'Explicit native '+key+' is required');
 const model=options.model,provider=options.provider;
 assert.match(model,/^[A-Za-z0-9._:/-]{1,128}$/);assert.match(provider,/^[A-Za-z0-9_-]{1,64}$/);
 const toolRoot=await realpath(options.toolRoot),configPath=resolve(options.configFile),keyPath=resolve(options.keyFile);
 const buildRoot=await realpath(options.buildRoot??join(integration,'.build'));assert.ok(isAbsolute(buildRoot));
 const tools=await verifyToolMetadata(framework,buildRoot,toolRoot),startedAt=new Date().toISOString(),artifact=join(integration,'artifacts',`native-${profile==='luna-seed'?'luna-seeds':profile}-${startedAt.replaceAll(':','-').replaceAll('.','-')}`),privateRoot=join(artifact,'private');
 await mkdir(privateRoot,{recursive:true,mode:0o700});
 const configBefore=await readFile(configPath),keyBefore=await readFile(keyPath);
 // Parse privately. Captured stdout is never sent to the terminal or receipt.
 const route=JSON.parse(execFileSync('python3',['-c','import tomllib,json,sys; d=tomllib.loads(open(sys.argv[1]).read()); p=d["model_providers"][sys.argv[2]]; print(json.dumps({"endpoint":p["base_url"],"responses":p.get("wire_api")=="responses"}))',configPath,provider],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}));
 assert.equal(route.responses,true,'Selected route must use Responses');const realKey=keyBefore.toString('utf8').trim();assert.ok(realKey.length>=16&&!/[\r\n]/.test(realKey));
 const proxyKey=randomBytes(32).toString('hex'),secrets=[realKey,proxyKey,route.endpoint,privateRoot,artifact,configPath,keyPath,tools.toolRoot,tools.codexPackage,tools.copilotPackage],scrub=redactor(secrets);
 const safeError=error=>scrub(String(error?.message??'Finite native qualification failed')).slice(0,2000),observations=[];let bytes=0;
 const record=(label,value={})=>{const entry=scrub({label,value}),encoded=JSON.stringify(entry);bytes+=Buffer.byteLength(encoded);assert.ok(observations.length<4096&&bytes<=4*1024*1024,'Native observation bound');observations.push(entry)};
 const before=await manifest({framework,integration,buildRoot,tools:tools.inputs});await writeFile(join(artifact,'source-manifest.json'),JSON.stringify(before,null,2)+'\n',{mode:0o600});
 const sourceHash=sha(JSON.stringify(before)),initial={id:randomUUID(),profile,status:'running',startedAt:Date.now(),deadline:Date.now()+bounds.wallMs,providerPosts:0,admissions:[],maxProviderPosts:bounds.modelForwards,limits:{'codex-root':bounds.sendsPerHost?.codex??0,'codex-child':bounds.childrenPerHost?.codex??0,'copilot-root':bounds.sendsPerHost?.copilot??0,'copilot-child':bounds.childrenPerHost?.copilot??0,'codex-native':bounds.groupsPerHost,'copilot-native':bounds.groupsPerHost}};
 const ledger=allowanceLedger(join(artifact,'allowance.json'),initial),budget=nativeBudget(ledger,initial.deadline,bounds),cleanups=new Set(),works=new Set();let guard,attemptedPosts=0,interrupted=false,activeProviderKind=null;
 const interrupt=()=>{interrupted=true;budget.seal();for(const clean of cleanups)void Promise.resolve().then(clean).catch(()=>undefined)};
 process.once('SIGTERM',interrupt);process.once('SIGINT',interrupt);
 const result={profile,status:'running',startedAt,sourceHash,sourceEntries:before.length,versions:tools.versions,actualSdk:tools.actualSdk,limits:bounds,harnesses:{},cleanup:{},providerRequestFacts:[],providerPostsForwarded:0,modelInferenceCalls:0,existingSessionsTouched:false,productionIntegration:false,p14:'unqualified'};
 try{
  // Model-free refuses BEFORE an upstream request exists. Seed forwarding spends
  // its separate finite ledger first. Neither supplies synthetic model output.
  guard=providerGuard({upstream:route.endpoint,key:realKey,proxyKey,model,ledger:{provider(){attemptedPosts++;if(profile!=='model-free')ledger.provider();else throw Error('Model inference forbidden in model-free native qualification')}},onResponses:facts=>{
   assert.ok(activeProviderKind==='codex'||activeProviderKind==='copilot','Provider request outside owned native host');
   assert.ok(result.providerRequestFacts.length<bounds.modelForwards,'Provider fact receipt bound');
   result.providerRequestFacts.push({ordinal:result.providerRequestFacts.length+1,kind:activeProviderKind,...facts});
  }});
  const endpoint=await guard.listen();secrets.push(endpoint);
  const load=async path=>import(pathToFileURL(join(buildRoot,'primitives',path)).href);
  const core=Object.assign({},...await Promise.all(['v8-lifecycle-default/src/node.js','v8-lifecycle-default/src/node.js','v8-harness-codex/src/runtime.js','v8-harness-codex/src/rpc.js','v8-harness-copilot/src/runtime.js','v8-host/src/native/linux.js','v8-gateway/src/index.js','v8-gateway/src/gateway/coordinator.js','v8-gateway/src/http/server.js','v8-history/src/client/workspace.js','v8-session/src/client/workspace.js','v8-files/src/client/index.js','v8-interactions/src/index.js'].map(load)));
  const browser=profile==='live-integration'?await import('./browser.mjs'):null;
  const workDeadline=initial.deadline-bounds.cleanupReserveMs,check=()=>{assert.equal(interrupted,false,'Finite native qualification interrupted');assert.ok(Date.now()<workDeadline,'Finite work deadline reached');assert.ok(attemptedPosts<=bounds.modelForwards,'Provider attempt allowance exhausted');assert.ok(guard.stats.responsesPosts<=bounds.modelForwards);assert.equal(guard.stats.rejectedModels+guard.stats.rejectedAuth+guard.stats.rejectedPaths+guard.stats.failed,0,'Unexpected or failed provider request during qualification')};
  for(const kind of selected==='all'?['codex','copilot']:[selected]){
   check();const localCleanups=new Set(),registerCleanup=fn=>{cleanups.add(fn);localCleanups.add(fn)};const directory=join(privateRoot,kind);await mkdir(directory,{recursive:true,mode:0o700});
   const privateDiagnostic=async(name,raw)=>{
    assert.equal(kind,'codex');assert.equal(name,'startup-stderr.log');assert.ok(raw instanceof Uint8Array&&raw.byteLength<=4096);
    const text=Buffer.from(scrub(Buffer.from(raw).toString('utf8'))).subarray(0,4096),file=join(directory,name);
    await writeFile(file,text,{flag:'wx',mode:0o600});return{status:'captured',bytes:text.length,sha256:sha(text),privateFile:name};
   };
   const context={kind,profile,core,tools,directory,connection:`native-${initial.id}`,seedMarker:`V8_SEED_${kind}_${randomUUID().replaceAll('-','')}`,maxPages:profile==='live-integration'?(kind==='copilot'?64:16):profile==='luna-seed'&&kind==='copilot'?16:3,admitSend:label=>{check();assert.ok(attemptedPosts<bounds.modelForwards,'Provider allowance exhausted before original Send');budget.send(kind,label)},admitChild:label=>budget.child(kind,label),respondInBrowser:browser?input=>browser.respondInBrowser({...input,registerCleanup}):undefined,model,provider,endpoint,key:proxyKey,docker:'/run/current-system/sw/bin/docker',workDeadline,check,safeError,
    private:value=>{assert.ok(typeof value==='string'&&value.length<=4096,'Private identity redaction bound');if(value&&!secrets.includes(value)){assert.ok(secrets.length<128,'Private identity redaction bound');secrets.push(value)}},privateDiagnostic,
    providerFacts:()=>structuredClone(result.providerRequestFacts.filter(entry=>entry.kind===kind)),admit:label=>budget.admit(kind,label),root:label=>budget.root(kind,label),record:(label,value)=>record(`${kind}:${label}`,value),registerNativeCleanup:registerCleanup};
   activeProviderKind=kind;const work=qualifyNativeHost(context);works.add(work);void work.finally(()=>works.delete(work)).catch(()=>undefined);result.harnesses[kind]=await bounded(work,Math.max(1,workDeadline-Date.now()),`native:${profile}:${kind}:deadline`);
   const localClosed=await Promise.allSettled([...localCleanups].map(clean=>bounded(Promise.resolve().then(clean),30000,'Host-local cleanup barrier')));assert.ok(localClosed.every(value=>value.status==='fulfilled'),'Host-local resources did not close before another host');
   const cleanup=result.harnesses[kind].cleanup;assert.ok(cleanup.resources===true&&cleanup.journals===true&&cleanup.allAbsent===true,'Prior harness cleanup must prove exact absence before another host');
   activeProviderKind=null;
  }
  const passed=profile==='live-integration'?'passed-native-live-integration-subset':profile==='luna-seed'?'passed-native-seeded-subset':'passed-native-model-free-subset',partial='partial-native-model-free-subset';
  check();assert.ok(Object.values(result.harnesses).every(value=>value.status===passed||profile==='model-free'&&value.status===partial),'Native subset has diagnostic failures');
  result.status=Object.values(result.harnesses).some(value=>value.status===partial)?partial:passed;
 }catch(error){result.status='failed-native-diagnostic';result.error=safeError(error)}
 finally{
  budget.seal();ledger.seal();const settled=await Promise.allSettled([...cleanups].map(clean=>bounded(Promise.resolve().then(clean),Math.max(1,Math.min(30000,initial.deadline-Date.now())),'owned-native-final-cleanup')));result.cleanup.owners=settled.every(value=>value.status==='fulfilled');if(!result.cleanup.owners){result.status='failed-native-diagnostic';result.cleanup.errors=settled.filter(value=>value.status==='rejected').map(value=>safeError(value.reason))}
  await Promise.allSettled([...works].map(work=>bounded(work,1000,'Retired native helper settlement')));if(works.size){result.status='failed-native-diagnostic';result.cleanup.retiredHelperUnsettled=true}
  if(guard){result.providerPostsForwarded=guard.stats.responsesPosts;result.modelInferenceCalls=guard.stats.responsesPosts;result.providerGuard={...guard.stats,attemptedPosts,forwarded:guard.stats.responsesPosts};await guard.close();result.cleanup.guard=true;if(profile==='model-free'&&(attemptedPosts||Object.values(guard.stats).some(value=>value!==0))||profile!=='model-free'&&(attemptedPosts>bounds.modelForwards||guard.stats.failed||guard.stats.rejectedModels||guard.stats.rejectedAuth||guard.stats.rejectedPaths))result.status='failed-native-diagnostic'}
  result.providerFilesUnchanged=sha(await readFile(configPath))===sha(configBefore)&&sha(await readFile(keyPath))===sha(keyBefore);if(!result.providerFilesUnchanged)result.status='failed-native-diagnostic';
  if(result.status==='passed-native-model-free-subset'||result.status==='passed-native-seeded-subset'||result.status==='passed-native-live-integration-subset'){try{assert.equal(JSON.stringify(await manifest({framework,integration,buildRoot,tools:tools.inputs})),JSON.stringify(before),'Frozen native source/toolchain changed');result.sourceUnchanged=true}catch(error){result.status='failed-native-diagnostic';result.error=safeError(error)}}
  result.budget=budget.snapshot();ledger.complete(result.status.startsWith('passed-')?'complete':result.status.startsWith('partial-')?'complete-partial':'failed-diagnostic');result.completedAt=new Date().toISOString();
  process.off('SIGTERM',interrupt);process.off('SIGINT',interrupt);
  await writeFile(join(artifact,'observations.json'),JSON.stringify(scrub(observations),null,2)+'\n',{mode:0o600});await writeFile(join(artifact,'result.json'),JSON.stringify(scrub(result),null,2)+'\n',{mode:0o600});
  const files=['source-manifest.json','allowance.json','observations.json','result.json'];await writeFile(join(artifact,'SHA256SUMS'),(await Promise.all(files.map(async file=>`${sha(await readFile(join(artifact,file)))}  ${file}\n`))).join(''),{mode:0o600});
 }
 return{profile,status:result.status,sourceHash,receipt:relative(integration,artifact),harnesses:Object.fromEntries(Object.entries(result.harnesses).map(([kind,value])=>[kind,value.status])),cleanup:result.cleanup.owners===true&&result.cleanup.guard===true,p14:'unqualified'};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const option=prefix=>process.argv.find(arg=>arg.startsWith(prefix))?.slice(prefix.length);
 try{const result=await runNativeModelFree({allowNativeModelFree:process.argv.includes('--allow-native-model-free'),allowLunaSeeds:process.argv.includes('--allow-luna-seeds'),allowLiveIntegration:process.argv.includes('--allow-live-integration'),frozenSource:process.argv.includes('--frozen-source'),harness:option('--harness=')??'all',toolRoot:option('--tool-root='),configFile:option('--config-file='),keyFile:option('--key-file='),provider:option('--provider='),model:option('--model='),...(option('--build-root=')?{buildRoot:option('--build-root=')}:{})});
 process.stdout.write(JSON.stringify(result)+'\n');if(!result.status.startsWith('passed-'))process.exitCode=1;}catch{process.stderr.write('Native qualification preflight refused; private configuration details omitted.\n');process.exitCode=1}
}
