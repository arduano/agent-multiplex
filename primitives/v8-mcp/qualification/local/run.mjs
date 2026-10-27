import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,readdir,readFile,writeFile,copyFile,chmod,rm} from 'node:fs/promises';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {openCampaign,createModelTrap} from './campaign.mjs';
import {createFixtureService,fixtureCliPath} from './fixture-server.mjs';
import {qualifyFixtures} from './fixture-direct.mjs';

const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../..'),framework=resolve(root,'../..'),toolRoot=resolve(process.argv.find(arg=>arg.startsWith('--tool-root='))?.slice('--tool-root='.length)??framework);
const sdkRoot=resolve(process.argv.find(arg=>arg.startsWith('--sdk-root='))?.slice('--sdk-root='.length)??join(toolRoot,'node_modules/@modelcontextprotocol/sdk'));
const startedAt=new Date().toISOString(),artifact=join(root,'artifacts',`local-${startedAt.replaceAll(':','-').replaceAll('.','-')}`),privateRoot=join(artifact,'private');
const fixtureOnly=process.argv.includes('--fixtures-only'),selected=process.argv.find(arg=>arg.startsWith('--harness='))?.slice('--harness='.length)??'all';
assert.ok(['all','codex','copilot'].includes(selected));
const resumeId=process.argv.find(arg=>arg.startsWith('--resume='))?.slice('--resume='.length);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
await mkdir(privateRoot,{recursive:true,mode:0o700});
async function files(path){const values=[];for(const entry of(await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(['artifacts','.build','node_modules','.git'].includes(entry.name))continue;const next=join(path,entry.name);if(entry.isDirectory())values.push(...await files(next));else if(entry.isFile()&&!entry.name.endsWith('.md'))values.push(next);else if(!entry.isFile())throw Error('Unexpected source kind')}return values}
async function sourceManifest(){
 const source=fixtureOnly?['campaign.mjs','run.mjs','fixture-server.mjs','fixture-direct.mjs'].map(name=>join(here,name)):[...await files(root),...(await Promise.all(['v8-session','v8-history','v8-files','v8-interactions'].map(lane=>files(join(framework,'primitives',lane,'src'))))).flat(),...['codex-rpc.mjs','copilot-runtime.mjs'].map(name=>join(framework,'primitives/v8-interactions/qualification/live',name)),join(framework,'packages/storage-sqlite/src/index.ts'),join(framework,'packages/storage-sqlite/src/private-path.ts')];
 source.push(join(sdkRoot,'package.json'),join(toolRoot,'package.json'),join(toolRoot,'package-lock.json'),join(framework,'package.json'),join(framework,'package-lock.json'));
 if(!fixtureOnly)for(const path of ['@openai/codex','@github/copilot-sdk','@github/copilot'])source.push(join(toolRoot,'node_modules',path,'package.json'));
 return Promise.all([...new Set(source)].sort().map(async path=>({path:relative(root,path),sha256:sha(await readFile(path))})));
}
async function bounded(work,ms,label){let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms)})])}finally{clearTimeout(timer)}}
const safeError=error=>String(error?.message??'MCP qualification failed').replaceAll(privateRoot,'<owned-private>').slice(0,1000);
const events=[];const record=(label,fields={})=>{assert.ok(events.length<4096,'Local observation bound');const value={label,fields};assert.ok(JSON.stringify(value).length<=32768,'Local observation record bound');events.push(value)};
let campaign,trap,before;
const result={status:'running',startedAt,scope:fixtureOnly?'independent-local-mcp-fixtures':'model-free-native-mcp',harnesses:{},cleanup:{},modelInferenceCalls:0,upstreamForwards:0,existingSessionsTouched:false,productionIntegration:false};
try{
 if(!fixtureOnly)execFileSync(process.execPath,[join(framework,'node_modules/typescript/bin/tsc'),'--project',join(framework,'primitives/v8-integration/tsconfig.json')],{cwd:framework,stdio:'pipe',timeout:60000});
 before=await sourceManifest();const bytes=JSON.stringify(before,null,2)+'\n';result.sourceHash=sha(bytes);result.sourceEntries=before.length;await writeFile(join(artifact,'source-manifest.json'),bytes);
 const fixtureCleanups=new Set();
 try{result.fixtures=await bounded(qualifyFixtures({sdkRoot,workspace:join(privateRoot,'independent-sdk'),registerNativeCleanup:fn=>fixtureCleanups.add(fn)}),45000,'Independent local MCP fixture deadline')}
 finally{const clean=await Promise.allSettled([...fixtureCleanups].map(fn=>bounded(Promise.resolve().then(fn),15000,'Independent fixture cleanup deadline')));assert.ok(clean.every(value=>value.status==='fulfilled'),'Independent MCP fixture cleanup failed')}
 if(!fixtureOnly){
  campaign=openCampaign(join(root,'artifacts/allowance-local-mcp-20261023.json'),resumeId);result.campaignId=campaign.snapshot().id;
  trap=await createModelTrap();
  const buildRoot=join(framework,'primitives/v8-integration/.build');
  const core=Object.assign({},...await Promise.all(['v8-mcp/src/index.js','v8-lifecycle-default/src/session/index.js','v8-interactions/src/index.js'].map(path=>import(pathToFileURL(join(buildRoot,'primitives',path)).href))));
  for(const kind of selected==='all'?['codex','copilot']:[selected]){
   const admission=campaign.begin(kind),base=join(privateRoot,kind),workspace=join(base,'workspace'),nativeHome=join(base,'native-home'),stateDirectory=join(base,'state');
   for(const path of[workspace,nativeHome,stateDirectory])await mkdir(path,{recursive:true,mode:0o700});
   const stdioFile=join(workspace,'owned-mcp-fixture.mjs'),stdioLog=join(workspace,'owned-mcp-stdio.jsonl');await copyFile(fixtureCliPath,stdioFile);await chmod(stdioFile,0o600);
   const service=await createFixtureService({logPath:join(workspace,'owned-mcp-http.jsonl')}),cleanups=new Set();let active=true,work;
   const ctx={toolRoot,sdkRoot,buildRoot,core,workspace,nativeHome,stateDirectory,receiptDirectory:artifact,model:'gpt-6-luna',endpoint:trap.endpoint,key:randomBytes(24).toString('hex'),fixture:{stdioFile,stdioLog,httpUrl:service.url,snapshot:service.snapshot},
    record:(label,fields)=>record(`${kind}:${label}`,fields),registerNativeCleanup:fn=>cleanups.add(fn),admit(type,label){assert.ok(active,'Retired MCP native attempt');assert.ok(type===kind||type===`${kind}-rpc`||type===`${kind}-native`,'Wrong MCP native harness');admission.admit(label)}};
   try{const helper=await import(`./${kind}.mjs`);work=helper[kind==='codex'?'qualifyCodex':'qualifyCopilot'](ctx);result.harnesses[kind]=await bounded(work,Math.min(12*60_000,campaign.snapshot().deadline-Date.now()),'Native MCP attempt deadline')}
   catch(error){active=false;result.harnesses[kind]={status:'failed-native-diagnostic',error:safeError(error),...(error.partialResult?{partial:error.partialResult}:{})};process.stdout.write(`${kind}: diagnostic failure ${safeError(error)}\n`)}
   finally{
    const cleanup=await Promise.allSettled([...cleanups].map(fn=>bounded(Promise.resolve().then(fn),20000,'Native MCP cleanup deadline')));
    active=false;if(work)await bounded(work.catch(()=>{}),1000,'Retired MCP work settlement').catch(()=>{});
    result.cleanup[kind]={helpers:cleanup.every(value=>value.status==='fulfilled'),localHttpClosed:false};
    await service.close();result.cleanup[kind].localHttpClosed=true;
    if(!result.cleanup[kind].helpers)result.harnesses[kind]={...result.harnesses[kind],status:'failed-native-diagnostic',cleanupErrors:cleanup.filter(x=>x.status==='rejected').map(x=>safeError(x.reason))};
    admission.finish(result.harnesses[kind]?.status??'failed-native-diagnostic');
   }
  }
  result.providerTrap=trap.snapshot();assert.equal(result.providerTrap.inferenceAttempts,0,'Native code attempted model inference');assert.equal(result.providerTrap.forwarded,0);result.campaign=campaign.snapshot();
 }
 assert.equal(JSON.stringify(await sourceManifest()),JSON.stringify(before),'Qualification source changed during execution');result.sourceUnchanged=true;
 result.status=fixtureOnly?'passed-independent-local-mcp':Object.values(result.harnesses).every(value=>value.status?.startsWith('passed'))?'passed-native-mcp-subset':'failed-native-diagnostic';
}catch(error){result.status='failed-native-diagnostic';result.error=safeError(error)}
finally{
 if(trap){result.providerTrap=trap.snapshot();await trap.close();result.cleanup.modelTrapClosed=true;if(result.providerTrap.inferenceAttempts!==0||result.providerTrap.forwarded!==0)result.status='failed-native-diagnostic'}
 campaign?.close(result.status.startsWith('passed')?'complete':'failed-diagnostic');
 if(campaign)result.campaign=campaign.snapshot();
 result.completedAt=new Date().toISOString();
 await writeFile(join(artifact,'observations.json'),JSON.stringify(events,null,2)+'\n');await writeFile(join(artifact,'result.json'),JSON.stringify(result,null,2)+'\n');
 const names=['source-manifest.json','observations.json','result.json'],sums=[];for(const name of names)try{sums.push(`${sha(await readFile(join(artifact,name)))}  ${name}`)}catch(error){if(error.code!=='ENOENT')throw error}await writeFile(join(artifact,'SHA256SUMS'),sums.join('\n')+'\n');
 // All paths below this root were created by this invocation. Preserve failed
 // private diagnostics; successful receipts retain only scrubbed facts.
 if(result.status.startsWith('passed'))await rm(privateRoot,{recursive:true,force:true});
 process.stdout.write(JSON.stringify({status:result.status,sourceHash:result.sourceHash,receipt:relative(root,artifact),harnesses:Object.fromEntries(Object.entries(result.harnesses).map(([kind,value])=>[kind,value.status]))})+'\n');
 if(!result.status.startsWith('passed'))process.exitCode=1;
}
