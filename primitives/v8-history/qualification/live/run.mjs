/** Explicit finite owner allowance only; never imported by npm test. */
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,readdir,realpath} from 'node:fs/promises';
import {join,resolve,dirname,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {providerGuard} from './support.mjs';

process.umask(0o077);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const args=new Set(process.argv.slice(2));assert.ok(args.has('--allow-live'),'An explicit finite owner allowance is required');
const harnesses=args.has('--codex-only')?['codex']:args.has('--copilot-only')?['copilot']:['codex','copilot'];
const option=name=>process.argv.find(arg=>arg.startsWith(name+'='))?.slice(name.length+1);
const required=name=>{const value=option(name);assert.ok(value,'Explicit '+name+' is required');return value};
const toolRoot=await realpath(required('--tool-root'));
const model=required('--model'),provider=required('--provider');
assert.match(model,/^[A-Za-z0-9._:/-]{1,128}$/);assert.match(provider,/^[A-Za-z0-9_-]{1,64}$/);
const configPath=resolve(required('--config-file')),keyPath=resolve(required('--key-file'));
const codexRootLimit=args.has('--remaining-codex-root')?1:2;
const copilotRootLimit=args.has('--remaining-copilot-root')?1:2;
const sha=value=>createHash('sha256').update(value).digest('hex');
const artifact=join(root,'artifacts',`live-${new Date().toISOString().replace(/[:.]/g,'-')}`);
await mkdir(artifact,{recursive:true,mode:0o700});
const privateRoot=join(artifact,'private');await mkdir(privateRoot,{mode:0o700});
const configBefore=await readFile(configPath),keyBefore=await readFile(keyPath);
// Extract the selected route in memory. Neither source configuration nor its
// private URL/key enters receipts, stdout, tracked files or the model prompt.
const parsed=JSON.parse(execFileSync('python3',['-c','import tomllib,json,sys; d=tomllib.loads(open(sys.argv[1]).read()); p=d["model_providers"][sys.argv[2]]; print(json.dumps({"endpoint":p["base_url"],"responses":p.get("wire_api")=="responses","mcpConfigured":bool(d.get("mcp_servers"))}))',configPath,provider],{encoding:'utf8'}));
assert.ok(parsed.responses,'The requested route must use Responses');
assert.equal(parsed.mcpConfigured,false,'Configured MCP requires a deliberate isolated preservation mapping before launch');
const realKey=keyBefore.toString('utf8').trim();assert.ok(realKey.length>=16&&!/[\r\n]/.test(realKey));
let guard;
const publicRecords=[],privateStrings=[realKey,parsed.endpoint,privateRoot,artifact,configPath,keyPath];
const scrub=value=>{
 if(typeof value==='string'){let result=value;for(const secret of privateStrings)if(secret)result=result.replaceAll(secret,'<private>');return result.replace(/https?:\/\/[^\s"'<>]+/g,'<endpoint>').slice(0,65_536);}
 if(Array.isArray(value))return value.map(scrub);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['path','instructionSources','gitInfo','auth','apiKey','baseUrl'].includes(key)).map(([key,entry])=>[key,key==='cwd'?'<disposable-workspace>':scrub(entry)]));
 return value;
};
const record=(name,value)=>{if(name==='copilot-notification'&&value?.type==='system.message')value={...value,data:{role:value.data?.role??'system',instructionBodyOmitted:true}};assert.ok(publicRecords.length<4096,'LIVE_RECORD_BOUND');publicRecords.push({name,value:scrub(value)});};
async function manifest(){
 const result=[];
 async function walk(dir){for(const entry of(await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(['artifacts','.build','node_modules'].includes(entry.name))continue;const path=join(dir,entry.name);if(entry.isDirectory())await walk(path);else if(entry.isFile()){if((entry.name==='copilot.mjs'&&!harnesses.includes('copilot'))||(entry.name==='codex.mjs'&&!harnesses.includes('codex')))continue;result.push({file:relative(root,path),sha256:sha(await readFile(path))});}}}
 await walk(root);
 for(const name of ['package.json','package-lock.json'])result.push({file:`tool-root/${name}`,sha256:sha(await readFile(join(toolRoot,name)))});
 for(const name of ['@openai/codex','@github/copilot','@github/copilot-sdk']){const path=join(toolRoot,'node_modules',name,'package.json');result.push({file:`tool-root/node_modules/${name}/package.json`,sha256:sha(await readFile(path))});}
 const native=join(toolRoot,'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex');result.push({file:'tool-root/codex-native-binary',sha256:sha(await readFile(native))});
 const copilot=join(toolRoot,'node_modules/@github/copilot-linux-x64/copilot');result.push({file:'tool-root/copilot-native-binary',sha256:sha(await readFile(copilot))});
 return result;
}
const before=await manifest();await writeFile(join(artifact,'source-manifest.json'),JSON.stringify(before,null,2)+'\n');
const receipt={status:'running',startedAt:new Date().toISOString(),model,provider,allowance:{rootTurnsByHarness:{codex:codexRootLimit,copilot:copilotRootLimit},childTurnsPerHarness:1,maxProviderPostsPerRun:32,noPromptReplay:true},sourceHash:sha(JSON.stringify(before)),harnesses:{},calls:{'codex-root':0,'codex-child':0,'copilot-root':0,'copilot-child':0},limitations:['Direct native-to-primitive qualification; product React/transport/durable Host admission are separate.','Known combined two-viewer older-history Root/Host disconnect remains unresolved.']};
const allowance={admit(kind){assert.ok(Object.hasOwn(receipt.calls,kind));const limit=kind.endsWith('-child')?1:kind==='codex-root'?codexRootLimit:copilotRootLimit;assert.ok(receipt.calls[kind]<limit,`LIVE_TURN_ALLOWANCE_EXHAUSTED:${kind}`);receipt.calls[kind]++;}};
try {
 execFileSync(process.execPath,[join(root,'../../node_modules/typescript/bin/tsc'),'--project',join(root,'tsconfig.json')],{cwd:root,stdio:'pipe',timeout:30_000});
 const core=await import(pathToFileURL(join(root,'.build/src/index.js')).href);
 guard=providerGuard(parsed.endpoint,realKey,model,32);const endpoint=await guard.listen();privateStrings.push(endpoint);
 for(const kind of harnesses){
  const workspace=join(privateRoot,kind,'workspace'),nativeHome=join(privateRoot,kind,'native-home');await mkdir(workspace,{recursive:true,mode:0o700});await mkdir(nativeHome,{mode:0o700});
  const dummyKey=randomBytes(24).toString('hex');privateStrings.push(dummyKey);
  if(kind==='codex')await writeFile(join(nativeHome,'config.toml'),`model = "${model}"\nmodel_provider = "${provider}"\napproval_policy = "on-request"\nsandbox_mode = "danger-full-access"\nmodel_reasoning_effort = "low"\n[features]\nmulti_agent = true\n[agents]\nmax_threads = 2\nmax_depth = 1\n[model_providers.${provider}]\nname = "V8 finite private route"\nbase_url = ${JSON.stringify(endpoint)}\nwire_api = "responses"\nenv_key = "MULTIPLEX_V8_LIVE_KEY"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\nstream_idle_timeout_ms = 120000\n`,{mode:0o600,flag:'wx'});
  console.log(`${kind}: starting owned disposable native session using ${model} via ${provider}`);
  const ctx={skipChild:args.has('--skip-child'),combined:codexRootLimit===1,combinedCopilot:copilotRootLimit===1,toolRoot,workspace,nativeHome,endpoint,key:dummyKey,model,provider,core,record,allowance,progress:message=>console.log(scrub(message))};
  try {const module=await import(`./${kind}.mjs`);const result=await module[kind==='codex'?'runCodexLive':'runCopilotLive'](ctx);receipt.harnesses[kind]=kind==='copilot'&&result.passed?{...result,coverageStatus:result.status,status:'passed-native-subset'}:result;}
  catch(error){receipt.harnesses[kind]={status:'failed',error:scrub(error.message??'Native qualification failed')};console.log(`${kind}: failed (${scrub(error.message??'native failure')})`);}
 }
 const after=await manifest();receipt.sourceUnchanged=JSON.stringify(before)===JSON.stringify(after);
 assert.ok(receipt.sourceUnchanged,'LIVE_SOURCE_CHANGED_DURING_RUN');
 receipt.status=harnesses.every(kind=>receipt.harnesses[kind]?.status?.startsWith('passed'))?'passed-native-subset':'failed-native-diagnostic';
}catch(error){receipt.status='failed-native-diagnostic';receipt.error=scrub(error.message??'Live qualification failed');process.exitCode=1;}
finally{
 if(guard){receipt.providerRequests={...guard.stats};await guard.close();}
 receipt.canonicalConfigAndCredentialUnchanged=configBefore.equals(await readFile(configPath))&&keyBefore.equals(await readFile(keyPath));
 if(!receipt.canonicalConfigAndCredentialUnchanged)receipt.status='failed-native-diagnostic';
 receipt.completedAt=new Date().toISOString();
 await writeFile(join(artifact,'observations.scrubbed.json'),JSON.stringify(publicRecords,null,2)+'\n');
 const text=JSON.stringify(scrub(receipt),null,2)+'\n';await writeFile(join(artifact,'result.json'),text);
 const names=['source-manifest.json','observations.scrubbed.json','result.json'];await writeFile(join(artifact,'SHA256SUMS'),(await Promise.all(names.map(async name=>`${sha(await readFile(join(artifact,name)))}  ${name}`))).join('\n')+'\n');
 console.log(JSON.stringify({status:receipt.status,model,provider,calls:receipt.calls,providerRequests:receipt.providerRequests,receipt:relative(root,artifact)}));
 if(receipt.status!=='passed-native-subset')process.exitCode=1;
}
