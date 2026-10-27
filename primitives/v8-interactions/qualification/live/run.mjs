import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,readFile,readdir,writeFile,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {providerGuard,allowanceLedger,bounded} from './support.mjs';
import {viewerBridges} from './bridge.mjs';
import {respondInBrowser} from './browser.mjs';

process.umask(0o077);
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../..'),framework=resolve(root,'../..');
assert.ok(process.argv.includes('--allow-live'),'Fresh explicit live allowance required');
const selected=process.argv.includes('--codex-only')?['codex']:process.argv.includes('--copilot-only')?['copilot']:['codex','copilot'];
const continuation=process.argv.includes('--continue-unspent');
const remaining=process.argv.includes('--remaining-20261023');
const remainingRecovery=process.argv.includes('--remaining-recovery');
assert.ok(!remainingRecovery||remaining,'Remaining recovery requires the new remaining allowance');
assert.ok(!remaining||!continuation,'Fresh remaining allowance cannot reuse the earlier campaign mode');
const copilotRecoveryStage=process.argv.includes('--copilot-recovery-stage=3')?3:process.argv.includes('--copilot-recovery-stage=2')?2:0;
assert.ok(copilotRecoveryStage===0||(continuation&&selected.length===1&&selected[0]==='copilot'),'Recovery stage requires Copilot-only unspent continuation');
const priorDirectory=join(root,'artifacts/interactions-live-2026-10-23T06-35-21-379Z');
const option=name=>process.argv.find(arg=>arg.startsWith(name+'='))?.slice(name.length+1);
const required=name=>{const value=option(name);assert.ok(value,'Explicit '+name+' is required');return value};
const toolRoot=await realpath(required('--tool-root'));
const model=required('--model'),provider=required('--provider');
assert.match(model,/^[A-Za-z0-9._:/-]{1,128}$/);assert.match(provider,/^[A-Za-z0-9_-]{1,64}$/);
const configPath=resolve(required('--config-file')),keyPath=resolve(required('--key-file'));
const startedAt=new Date().toISOString();
const artifact=join(root,'artifacts',`${remaining?'remaining':'interactions'}-live-${startedAt.replaceAll(':','-').replaceAll('.','-')}`),privateRoot=join(artifact,'private');
await mkdir(privateRoot,{recursive:true,mode:0o700});
const configBefore=await readFile(configPath),keyBefore=await readFile(keyPath);
const route=JSON.parse(execFileSync('python3',['-c','import tomllib,json,sys; d=tomllib.loads(open(sys.argv[1]).read()); p=d["model_providers"][sys.argv[2]]; print(json.dumps({"endpoint":p["base_url"],"responses":p.get("wire_api")=="responses","mcpConfigured":bool(d.get("mcp_servers"))}))',configPath,provider],{encoding:'utf8',timeout:10000}));
assert.ok(route.responses,'Requested provider must use Responses');assert.equal(route.mcpConfigured,false,'Configured MCP needs an explicit isolated preservation mapping');
const realKey=keyBefore.toString('utf8').trim();assert.ok(realKey.length>=16&&!/[\r\n]/.test(realKey));
const proxyKey=randomBytes(32).toString('hex'),secrets=[realKey,proxyKey,route.endpoint,privateRoot,artifact,configPath,keyPath];
function scrub(value){
  if(typeof value==='string'){let result=value;for(const secret of secrets)if(secret)result=result.replaceAll(secret,'<private>');return result.replace(/Bearer\s+\S+/gi,'Bearer <private>').replace(/https?:\/\/[^\s"'<>]+/g,'<endpoint>').slice(0,65536)}
  if(Array.isArray(value))return value.map(scrub);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['auth','apiKey','accessToken','refreshToken','authorization','confirmationId','reviewFingerprint','instructionSources','gitInfo'].includes(key)).map(([key,v])=>[key,['cwd','path','nativeHome','workspace','endpoint','url'].includes(key)?'<private>':scrub(v)]));
  return value;
}
const observations=[];let observationBytes=0;
function record(name,value){
  if(value?.type==='system.message')value={id:value.id,type:value.type,data:{role:value.data?.role??'system',instructionBodyOmitted:true}};
  const entry=scrub({name,value}),text=JSON.stringify(entry);observationBytes+=Buffer.byteLength(text);assert.ok(observations.length<8192&&observationBytes<=12*1024*1024,'Finite observation bound');observations.push(entry);
}
const sha=value=>createHash('sha256').update(value).digest('hex');
async function hashFile(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex')}
async function files(directory){const result=[];for(const entry of(await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(['artifacts','.build','node_modules','.git'].includes(entry.name))continue;const path=join(directory,entry.name);if(entry.isDirectory())result.push(...await files(path));else if(entry.isFile()&&!path.endsWith('.md'))result.push(path)}return result}
async function manifest(){
  const source=[...await files(root)];
  for(const name of ['v8-history','v8-files','v8-session','v8-catalog','v8-gateway'])source.push(...await files(join(framework,'primitives',name,'src')));
  source.push(join(framework,'primitives/v8-history/qualification/live/support.mjs'));
  for(const name of ['tsconfig.json','package.json'])source.push(join(framework,'primitives/v8-integration',name));
  for(const name of ['index.ts','private-path.ts'])source.push(join(framework,'packages/storage-sqlite/src',name));
  for(const base of [framework,toolRoot])for(const name of ['package.json','package-lock.json'])source.push(join(base,name));
  const sdk=join(toolRoot,'node_modules/@github/copilot-sdk');source.push(join(sdk,'package.json'),...await files(join(sdk,'dist')));
  for(const name of ['@openai/codex','@github/copilot','@openai/codex-linux-x64','@github/copilot-linux-x64'])source.push(join(toolRoot,'node_modules',name,'package.json'));
  source.push(join(toolRoot,'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'),join(toolRoot,'node_modules/@github/copilot-linux-x64/copilot'));
  if(continuation)for(const name of ['result.json','SHA256SUMS','read-only-audit.json','read-only-audit.sha256'])source.push(join(priorDirectory,name));
  if(remainingRecovery)for(const receipt of ['remaining-live-2026-10-23T07-46-43-496Z','remaining-live-2026-10-23T07-48-56-614Z'])for(const name of ['result.json','SHA256SUMS','observations.scrubbed.json'])source.push(join(root,'artifacts',receipt,name));
  return Promise.all([...new Set(source)].sort().map(async path=>({file:path.startsWith(toolRoot+'/')?'tool-root/'+relative(toolRoot,path):relative(root,path),sha256:await hashFile(path)})));
}

let guard,bridges,ledger,before;
const limits=remaining?{'codex-root':2,'codex-child':0,'copilot-root':3,'copilot-child':1,'codex-native':10,'copilot-native':10}:undefined;
const wallMinutes=remaining?30:45,maxProviderPosts=remaining?24:40;
const result={status:'preparing',startedAt,model,provider,harnesses:{},allowance:remaining?{limits,maxProviderPosts,wallMinutes,noOriginalReplay:true}:{rootTurnsPerHost:4,childTurnsPerHost:1,nativeProbesPerHost:14,maxProviderPosts,wallMinutes,noOriginalReplay:true},limitations:['Real published p2prpc two-viewer older-history defect remains unresolved','Disposable native/HTTP/Chromium fixture is separate from production React/auth/deployment','Unobserved native prompts and extra OAuth/auto-mode/install requests remain explicitly unqualified']};
try{
  execFileSync(process.execPath,[join(framework,'node_modules/typescript/bin/tsc'),'--project',join(framework,'primitives/v8-integration/tsconfig.json')],{cwd:framework,stdio:'pipe',timeout:60000});
  const buildRoot=join(framework,'primitives/v8-integration/.build');
  const load=file=>import(pathToFileURL(join(buildRoot,'primitives',file)).href);
  const modules=await Promise.all([load('v8-lifecycle-default/src/session/index.js'),load('v8-session/src/client/workspace.js'),load('v8-history/src/index.js'),load('v8-interactions/src/index.js'),load('v8-gateway/src/index.js'),load('v8-gateway/src/gateway/coordinator.js'),load('v8-gateway/src/http/server.js')]);
  const core=Object.assign({},...modules);bridges=viewerBridges(core);
  before=await manifest();const manifestText=JSON.stringify(before,null,2)+'\n';result.sourceHash=sha(manifestText);result.sourceEntries=before.length;await writeFile(join(artifact,'source-manifest.json'),manifestText);
  // Exclusive fixed marker prevents this invocation from silently renewing the owner allowance.
  const resumeId=process.argv.find(arg=>arg.startsWith('--resume-allowance='))?.slice('--resume-allowance='.length);
  ledger=allowanceLedger(join(root,remaining?'artifacts/allowance-native-remaining-20261023.json':'artifacts/allowance-native-interactions-20261023.json'),{id:randomUUID(),status:'running',startedAt,deadline:Date.now()+wallMinutes*60000,admissions:[],providerPosts:0,...(remaining?{limits,maxProviderPosts}: {})},{resumeId});
  result.allowanceId=ledger.state.id;
  guard=providerGuard({upstream:route.endpoint,key:realKey,proxyKey,model,ledger});const endpoint=await guard.listen();secrets.push(endpoint);
  result.status='running';
  for(const kind of selected){
    const base=join(privateRoot,kind),workspace=join(base,'workspace'),nativeHome=join(base,'native-home'),stateDirectory=join(base,'state');
    for(const path of [workspace,nativeHome,stateDirectory])await mkdir(path,{recursive:true,mode:0o700});
    if(kind==='codex')await writeFile(join(nativeHome,'config.toml'),`model = "${model}"\nmodel_provider = "${provider}"\napproval_policy = "on-request"\nsandbox_mode = "danger-full-access"\nmodel_reasoning_effort = "low"\n[features]\nmulti_agent = ${remaining?'false':'true'}\n[agents]\nmax_threads = 2\nmax_depth = 1\n[model_providers.${provider}]\nname = "Finite V8 interaction route"\nbase_url = ${JSON.stringify(endpoint)}\nwire_api = "responses"\nenv_key = "MULTIPLEX_V8_LIVE_KEY"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\nstream_idle_timeout_ms = 120000\n`,{mode:0o600,flag:'wx'});
    const nativeEnvironment={PATH:process.env.PATH,LANG:'C.UTF-8',HOME:nativeHome,CODEX_HOME:nativeHome,MULTIPLEX_V8_LIVE_KEY:proxyKey};
    const phase={active:true,cleanups:new Set()};let allowedCodexCommandDisplays=[];
    if(continuation&&kind==='codex'){
      const bytes=await readFile(join(priorDirectory,'read-only-audit.json'));assert.equal(sha(bytes),(await readFile(join(priorDirectory,'read-only-audit.sha256'),'utf8')).trim());const audit=JSON.parse(bytes);assert.equal(audit.providerRequests,0);assert.equal(audit.cleanup,true);
      for(const command of audit.commands){
        // Only the reviewed harmless completed marker display is eligible; never a generic shell parser.
        assert.equal(command.status,'completed');assert.equal(command.exitCode,0);assert.ok(command.command.startsWith('/run/current-system/sw/bin/bash -lc "printf \'V8_LIVE_CDX_BASELINE'));
        assert.ok(!command.command.includes(';')&&!command.command.includes('&&')&&!command.command.includes('$'));
        allowedCodexCommandDisplays.push(command.command.replaceAll('V8_LIVE_CDX_BASELINE','V8_LIVE_CDX_CHILD_APPROVAL'));
      }
    }
    const ctx={toolRoot,workspace,nativeHome,stateDirectory,receiptDirectory:artifact,endpoint,key:proxyKey,model,provider,core,buildRoot,nativeEnvironment,continuation,remainingRecovery,copilotRecoveryStage,probeCodexUrlShape:continuation,allowedCodexCommandDisplays,allowance:{admit(kind,id){assert.ok(phase.active,'Native lane already retired');ledger.admit(kind,id)}},registerNativeCleanup(fn){phase.cleanups.add(fn)},record,progress:message=>console.log(scrub(message)),openViewerBridge:bridges.open,respondInBrowser,maxRootSends:remaining?limits[`${kind}-root`]:4};
    console.log(`${kind}: disposable native interaction qualification, exact ${model} via ${provider}`);
    let task;
    try{const module=await import(`./${remaining?(kind==='codex'?'codex-permissions':'copilot-remaining'):kind}.mjs`);task=module[kind==='codex'?'runCodexInteractions':'runCopilotInteractions'](ctx);result.harnesses[kind]=await bounded(task,Math.min(18*60000,Math.max(1,ledger.state.deadline-Date.now())),`${kind} native lane`)}
    catch(error){phase.active=false;await Promise.allSettled([...phase.cleanups].map(fn=>Promise.resolve().then(fn)));if(task)await bounded(task.catch(()=>{}),30000,'Retired lane cleanup').catch(()=>{});result.harnesses[kind]={...(error.partialResult??{}),status:'failed-native-diagnostic',error:scrub(error.message??'Native lane failed')};console.log(`${kind}: diagnostic failure (${scrub(error.message??'Native lane failed')})`)}
    finally{phase.active=false}
  }
  assert.equal(JSON.stringify(await manifest()),JSON.stringify(before),'Live source changed during qualification');result.sourceUnchanged=true;
  result.status=selected.every(kind=>result.harnesses[kind]?.status?.startsWith('passed'))?'passed-native-observed-subset':'failed-native-diagnostic';
}catch(error){result.status='failed-native-diagnostic';result.error=scrub(error.message??'Live setup failed');process.exitCode=1}
finally{
  const cleanup=await Promise.allSettled([bridges?.close()]);result.sharedViewerCleanup=cleanup.every(value=>value.status==='fulfilled');
  // Close admission first; proxy shutdown then prevents any late inference from spending allowance.
  ledger?.seal();if(guard){await guard.close();result.providerRequests={...guard.stats}}
  result.canonicalConfigAndCredentialUnchanged=configBefore.equals(await readFile(configPath))&&keyBefore.equals(await readFile(keyPath));
  result.admissions=ledger?.state.admissions??[];result.providerPosts=ledger?.state.providerPosts??0;result.completedAt=new Date().toISOString();
  if(!result.canonicalConfigAndCredentialUnchanged||!result.sharedViewerCleanup)result.status='failed-native-diagnostic';
  ledger?.complete(result.status);
  await writeFile(join(artifact,'observations.scrubbed.json'),JSON.stringify(observations,null,2)+'\n');await writeFile(join(artifact,'result.json'),JSON.stringify(scrub(result),null,2)+'\n');
  const names=['source-manifest.json','observations.scrubbed.json','result.json'];const sums=[];for(const name of names)try{sums.push(`${await hashFile(join(artifact,name))}  ${name}`)}catch(error){if(error.code!=='ENOENT')throw error}await writeFile(join(artifact,'SHA256SUMS'),sums.join('\n')+'\n');
  console.log(JSON.stringify({status:result.status,sourceHash:result.sourceHash,admissions:result.admissions.length,providerPosts:result.providerPosts,receipt:relative(root,artifact)}));
  if(!result.status.startsWith('passed'))process.exitCode=1;
}
