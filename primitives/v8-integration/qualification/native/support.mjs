import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readdir,readFile,realpath} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join,relative} from 'node:path';

export const limits=Object.freeze({freshRootsPerHost:2,groupsPerHost:14,wallMs:8*60_000,cleanupReserveMs:60_000,maxPages:3,modelForwards:0});
export const seedLimits=Object.freeze({...limits,groupsPerHost:16,wallMs:20*60_000,maxPages:16,modelForwards:6,sendsPerHost:{codex:1,copilot:1},childrenPerHost:{codex:0,copilot:0}});
export const integrationLimits=Object.freeze({...limits,groupsPerHost:16,wallMs:60*60_000,cleanupReserveMs:120_000,maxPages:64,modelForwards:24,sendsPerHost:{codex:3,copilot:4},childrenPerHost:{codex:0,copilot:1}});
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
// Closed projections only: never serialize native responses, selection/provider
// configuration, interaction payloads, history bodies, cursor strings or errors.
export function snapshotObservation(value){
 if(!value||typeof value!=='object')return null;
 return{phase:value.phase,activity:value.activity,generation:value.generation,epoch:value.epoch,revision:value.revision,nativeId:typeof value.nativeSession==='string'&&value.nativeSession.length>0,stopRequested:value.stopRequested,interactionsComplete:value.interactionsComplete,interactionCount:Array.isArray(value.interactions)?value.interactions.length:0,...(value.issue===undefined?{}:{issue:value.issue})};
}
export function receiptObservation(value){
 if(!value||typeof value!=='object')return null;
 return{id:value.id,type:value.type,generation:value.generation,state:value.state,...(typeof value.reason==='string'?{reason:value.reason.slice(0,128)}:{}),...(value.outcome&&typeof value.outcome.status==='string'?{outcomeStatus:value.outcome.status}:{})};
}
export function errorObservation(value,scrub){
 const code=value?.code;
 return{code:typeof code==='string'&&/^[A-Za-z0-9_:-]{1,64}$/.test(code)||Number.isSafeInteger(code)?code:'UNCLASSIFIED',message:typeof value?.message==='string'?scrub({message:value.message}).slice(0,512):'Native history read failed'};
}
export function recoveryObservation(value){
 const state=['value','failed','waitingExpired','healed','retired'].includes(value?.state)?value.state:'invalid';
 return{state,...(state==='value'&&['ready','stale','expired','unsupported'].includes(value?.value?.status)?{status:value.value.status}:{}),...(state==='failed'&&typeof value.code==='string'&&/^[A-Za-z0-9_:-]{1,64}$/.test(value.code)?{code:value.code}:{})};
}
export function persistedJournalUnavailable(error,nativeSession){
 return error?.code===-32603&&typeof nativeSession==='string'&&nativeSession.length>0&&error?.message===`Request sessions.readPersistedEvents failed with message: Persisted event journal is unavailable for session ${nativeSession}`;
}
export function knownUnsentResumeUnavailable({kind,historyUnavailable,original,receipt,snapshot,nativeSession,beforeDiagnostics,afterDiagnostics}){
 if(kind!=='copilot'||historyUnavailable!==true||!original||original.command?.type!=='resume'||!receipt||!snapshot||typeof nativeSession!=='string'||!nativeSession)return false;
 if(receipt.id!==original.id||receipt.type!=='resume'||receipt.generation!==original.generation||receipt.state!=='outcomeUnknown'||JSON.stringify(receipt.scope)!==JSON.stringify(original.scope))return false;
 if(snapshot.phase!=='starting'||snapshot.nativeSession!==nativeSession||snapshot.generation!==original.generation+1||JSON.stringify(snapshot.scope)!==JSON.stringify(original.scope))return false;
 if(!Array.isArray(beforeDiagnostics)||!Array.isArray(afterDiagnostics)||beforeDiagnostics.some(value=>value.stage==='session.resume'))return false;
 const resumed=afterDiagnostics.filter(value=>value.stage==='session.resume'&&value.owner==='agent');
 return resumed.length===1&&resumed[0].state==='failed'&&resumed[0].nativeCode===-32603;
}
export async function hashFile(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex')}
export function redactor(secrets){
 return function scrub(value){
  if(typeof value==='string'){let text=value;for(const secret of secrets)if(secret)text=text.replaceAll(secret,'<private>');return text.replace(/Bearer\s+\S+/gi,'Bearer <private>').replace(/https?:\/\/[^\s"'<>]+/g,'<endpoint>').slice(0,32768)}
  if(Array.isArray(value))return value.map(scrub);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['auth','apiKey','accessToken','refreshToken','authorization','confirmationId','reviewFingerprint','instructionSources','gitInfo','environment'].includes(key)).map(([key,item])=>[key,['home','nativeHome','cwd','directory','path','workspace','endpoint','url','process','containment','attachment','nativeSession','threadId'].includes(key)?'<private>':scrub(item)]));
  return value;
 };
}
async function sourceFiles(directory){const result=[];for(const entry of(await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(['artifacts','.build','node_modules','.git'].includes(entry.name))continue;const path=join(directory,entry.name);if(entry.isDirectory())result.push(...await sourceFiles(path));else if(entry.isFile()&&!path.endsWith('.md'))result.push(path);else if(!entry.isFile())throw Error('Unexpected qualification source kind')}return result}
export async function manifest({framework,integration,buildRoot,tools}){
 const inputs=[...await sourceFiles(join(integration,'qualification/native'))];
 for(const name of ['v8-host','v8-runtime','v8-history','v8-session','v8-files','v8-interactions','v8-gateway','v8-workspace','v8-plugins','v8-lifecycle-default','v8-harness-codex','v8-harness-copilot','v8-harness-defaults'])inputs.push(...await sourceFiles(join(framework,'primitives',name,'src')));
 for(const path of ['packages/storage-sqlite/src/index.ts','packages/storage-sqlite/src/private-path.ts','primitives/v8-interactions/qualification/live/support.mjs','package.json','package-lock.json','primitives/v8-host/package.json','primitives/v8-host/package-lock.json','primitives/v8-integration/package.json','primitives/v8-integration/package-lock.json'])inputs.push(join(framework,path));
 inputs.push(...await sourceFiles(join(integration,'application')),...await sourceFiles(buildRoot),...tools);
 for(const name of['react','react-dom','scheduler'])inputs.push(...await dependencyFiles(join(framework,'node_modules',name)));
 for(const name of['esbuild','@esbuild/linux-x64','playwright-core'])inputs.push(...await dependencyFiles(join(framework,'node_modules',name)));
 return Promise.all([...new Set(inputs)].sort().map(async path=>({path:relative(framework,path),sha256:await hashFile(path)})));
}
export function nativeBudget(ledger,deadline,bounds=limits){
 const counts={codex:{freshRoots:0,groups:[],sends:[],children:[]},copilot:{freshRoots:0,groups:[],sends:[],children:[]}};let sealed=false;
 const active=kind=>{assert.ok(!sealed&&Date.now()<deadline,'Finite native admission closed');assert.ok(Object.hasOwn(counts,kind));return counts[kind]};
 const original=(values,label)=>assert.ok(typeof label==='string'&&label.length>0&&label.length<=100&&!values.includes(label),'Original native probe cannot replay');
 const admit=(kind,label)=>{const state=active(kind);original(state.groups,label);assert.ok(state.groups.length<bounds.groupsPerHost,'Native group allowance exhausted');ledger.admit(`${kind}-native`,`${kind}:${label}`);state.groups.push(label)};
 return{admit,root(kind,label){const state=active(kind);assert.ok(state.freshRoots<bounds.freshRootsPerHost,'Fresh native root allowance exhausted');admit(kind,label);state.freshRoots++},send(kind,label){const state=active(kind);const limit=bounds.sendsPerHost?.[kind]??(bounds.modelForwards>0?1:0);assert.ok(state.sends.length<limit,'Send allowance exhausted');original(state.sends,label);ledger.admit(`${kind}-root`,`${kind}:${label}`);state.sends.push(label)},child(kind,label){const state=active(kind);assert.ok(state.children.length<(bounds.childrenPerHost?.[kind]??0),'Child allowance exhausted');original(state.children,label);ledger.admit(`${kind}-child`,`${kind}:${label}`);state.children.push(label)},snapshot:()=>structuredClone(counts),seal(){sealed=true}};
}
/** Qualification setup only: async allocation cannot publish after cleanup.
 * Resource-specific owners still perform all real shutdown. */
export function createSetupCustody(){
 let sealed=false,lateFailures=0;const pending=new Set();
 return{async acquire(acquire,dispose,publish){
  assert.equal(sealed,false,'Native setup is retired');
  const work=(async()=>{const value=await acquire();if(sealed){try{await dispose(value)}catch(error){lateFailures++;throw error}throw Error('Native setup is retired')}publish(value);return value})();
  pending.add(work);try{return await work}finally{pending.delete(work)}
 },seal(){sealed=true},async settle(){await Promise.allSettled([...pending]);assert.equal(lateFailures,0,'Late native setup cleanup failed')},get pending(){return pending.size}};
}
/** Delegate-only inspection/control instrumentation. No mock native result and
 * no ambient name lookup: every subsequent CID must come from this invocation. */
export function ownedCommands(base,{maxAgentAllocations=3,maxReaderAllocations=1,maxCalls=160}={}){
 const allocated=new Map();let calls=0,agents=0,readers=0,removed=0,closing=false,cleanupCalls=0;
 const cid=value=>assert.ok(typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)&&allocated.has(value),'Container is not owned by this qualification');
 return{allocated,async exec(args){
  calls++;assert.ok(closing?++cleanupCalls<=64:calls<=maxCalls,'Owned container control bound exhausted');assert.ok(Array.isArray(args));
  let kind;
  if(args[0]==='create'){
   const labels=args.filter(value=>typeof value==='string'&&value.startsWith('multiplex.v8.kind='));assert.equal(labels.length,1);kind=labels[0].slice('multiplex.v8.kind='.length);assert.ok(kind==='agent'||kind==='reader');assert.ok(args.includes('--pull=never'));
   if(kind==='agent')assert.ok(++agents<=maxAgentAllocations);else assert.ok(++readers<=maxReaderAllocations);
  }else if(args[0]==='container'&&args[1]==='ls'){const filter=args[args.indexOf('--filter')+1];assert.ok(typeof filter==='string'&&filter.startsWith('id='));cid(filter.slice(3));}
  else if(args[0]==='container'&&args[1]==='inspect')cid(args[2]);
  else if(args[0]==='rm'){assert.equal(args.length,4);assert.equal(args[1],'--force');assert.equal(args[2],'--volumes');cid(args[3]);}
  else throw Error('Unplanned container control command');
  const result=await base.exec(args);
  if(kind){const id=result.trim();assert.match(id,/^[a-f0-9]{64}$/);assert.ok(!allocated.has(id));allocated.set(id,{kind,removed:false});}
  if(args[0]==='rm'){const owned=allocated.get(args[3]);if(!owned.removed)removed++;owned.removed=true;}
  return result;
 },beginCleanup(){closing=true},snapshot(){return{calls,cleanupCalls,agentAllocations:agents,readerAllocations:readers,identified:allocated.size,removeAcknowledgements:removed}},
 async proveAbsent(){for(const id of allocated.keys()){const output=await this.exec(['container','ls','--all','--no-trunc','--filter',`id=${id}`,'--format','{{.ID}}']);assert.equal(output.trim(),'','Exact owned containment remains present')}return{allAbsent:true,...this.snapshot()}}};
}
async function dependencyFiles(directory){
 const result=[];for(const entry of(await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(entry.name==='.bin')continue;const path=join(directory,entry.name);if(entry.isDirectory())result.push(...await dependencyFiles(path));else if(entry.isFile()&&/\.(?:[cm]?js|node|json)$/.test(entry.name))result.push(path);else if(entry.isSymbolicLink())throw Error('Private toolchain must use published installed files')}
 return result;
}
export async function verifyToolMetadata(framework,buildRoot=join(framework,'primitives/v8-integration/.build'),toolRoot=join(framework,'primitives/v8-host')){
 const platform=join(toolRoot,'node_modules/@openai/codex-linux-x64'),copilot=join(toolRoot,'node_modules/@github/copilot-linux-x64'),sdk=join(framework,'primitives/v8-integration/node_modules/@github/copilot-sdk');
 const paths=[join(toolRoot,'node_modules/@openai/codex/package.json'),join(platform,'package.json'),join(copilot,'package.json'),join(sdk,'package.json')],metadata=await Promise.all(paths.map(async path=>JSON.parse(await readFile(path,'utf8'))));
 assert.equal(metadata[0].version,'0.162.1');assert.equal(metadata[1].version,'0.162.1-linux-x64');assert.equal(metadata[2].version,'1.0.95');assert.equal(metadata[3].version,'1.0.19');assert.equal(metadata[3].copilotCliVersion,'1.0.95');
 // Resolve from the actual compiled driver's location, not the runner's SDK.
 // require/import conditions select different entries in the SAME package; both
 // complete dist trees and native/transitive packages are hashed below.
 const require=createRequire(join(buildRoot,'primitives/v8-harness-copilot/src/runtime.js'));let sdkRoot=dirname(require.resolve('@github/copilot-sdk'));
 for(let steps=0;;steps++){assert.ok(steps<8,'Actual SDK metadata unavailable');try{const meta=JSON.parse(await readFile(join(sdkRoot,'package.json'),'utf8'));if(meta.name==='@github/copilot-sdk'){assert.equal(meta.version,'1.0.19');assert.equal(meta.copilotCliVersion,'1.0.95');break}}catch(error){if(error?.code!=='ENOENT')throw error}sdkRoot=dirname(sdkRoot)}
 const privateInstalls=[join(toolRoot,'node_modules'),join(framework,'primitives/v8-integration/node_modules')],actualSdk=await realpath(sdkRoot);
 assert.ok(privateInstalls.some(directory=>relative(directory,actualSdk)!==''&&!relative(directory,actualSdk).startsWith('..')),'Actual SDK is outside private pinned installs');
 const nodeBinary=await realpath(process.execPath),dockerBinary=await realpath('/run/current-system/sw/bin/docker'),chromiumLauncher=await realpath('/run/current-system/sw/bin/chromium');
 const codexBinary=join(platform,'vendor/x86_64-unknown-linux-musl/bin/codex'),copilotBinary=join(copilot,'copilot');
 return{toolRoot,codexPackage:platform,codexBinary,copilotPackage:copilot,copilotBinary,actualSdk:relative(framework,actualSdk),inputs:[...paths,codexBinary,copilotBinary,nodeBinary,dockerBinary,chromiumLauncher,join(framework,'node_modules/@esbuild/linux-x64/bin/esbuild'),...(await Promise.all(privateInstalls.map(dependencyFiles))).flat()],versions:{codex:metadata[0].version,codexPlatform:metadata[1].version,copilot:metadata[2].version,copilotSdk:metadata[3].version,node:process.version}};
}
