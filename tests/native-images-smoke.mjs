/** Manual native qualification. Requires explicit model-credit authorization.
 * Reuse the receipt directory on retry: its ledger caps each harness at four turns.
 * Credentials are read from runtime configuration and never written to receipts.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { statSync, existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '@arduano/agent-multiplex-adapter-codex';
import { CopilotAgentAdapter } from '@arduano/agent-multiplex-adapter-copilot';
import { RuntimeNodeService, RuntimeNodeStore } from '@arduano/agent-multiplex-runtime-node-core';
import { newRuntimeNodeId, newRuntimeNodeBootId, newSessionId, newLaunchId, newCommandId } from '@arduano/agent-multiplex-protocol';

const selectedHarnesses=process.argv.includes('--copilot-only')?['copilot']:process.argv.includes('--codex-only')?['codex']:['codex','copilot'];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const receipt = resolve(process.argv[2] ?? join(root, 'receipts', `native-images-${new Date().toISOString().replaceAll(':', '-')}`));
assert(receipt.startsWith(join(root, 'receipts') + '/'), 'receipt must be inside local receipts');
mkdirSync(receipt, { recursive:true, mode:0o700 });
const countsFile = join(receipt, 'call-counts.json');
const counts = existsSync(countsFile) ? JSON.parse(readFileSync(countsFile, 'utf8')) : { codex:0, copilot:0 };
for (const value of Object.values(counts)) assert(Number.isSafeInteger(value) && value >= 0 && value <= 4);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const save = (name, value) => writeFileSync(join(receipt, name), JSON.stringify(value, null, 2) + '\n', { mode:0o600 });
const sourceFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd:root, encoding:'utf8' }).split('\0').filter(Boolean).sort();
const sourceManifest = () => sourceFiles.filter((file) => existsSync(join(root, file))).map((file) => ({ file, sha256:sha(readFileSync(join(root, file))) }));
const testedRoots = ['protocol', 'storage-sqlite', 'runtime-node-core', 'adapter-codex', 'adapter-copilot'].map((name) => `packages/${name}/`);
function boundary() {
  const files = sourceManifest().filter(({ file }) => file === 'package-lock.json' || file === 'tests/native-images-smoke.mjs' || testedRoots.some((prefix) => file.startsWith(prefix)));
  for (const prefix of testedRoots) {
    const dist = join(root, prefix, 'dist');
    for (const entry of readdirSync(dist, { recursive:true, withFileTypes:true })) if (entry.isFile()) {
      const absolute = join(entry.parentPath, entry.name);
      files.push({ file:absolute.slice(root.length+1), sha256:sha(readFileSync(absolute)) });
    }
  }
  files.sort((a,b) => a.file.localeCompare(b.file));
  return { files, sha256:sha(JSON.stringify(files)) };
}
const before = boundary();
save('source-manifest.json', sourceManifest());
save('tested-boundary.json', before);
const work = mkdtempSync(join(tmpdir(), 'multiplex-native-images-'));
const sourceConfig = process.env.AGENT_MULTIPLEX_LIVE_SOURCE_CONFIG ?? join(homedir(), '.codex', 'config.toml');
const sourceKey = process.env.AGENT_MULTIPLEX_LIVE_SOURCE_KEY ?? join(homedir(), '.codex', 'codex-lb-api-key');
let providerUrl = ''; let key = '';
const manifest = { schema:'native-image-smoke-v1', startedAt:new Date().toISOString(), status:'running', protocolVersion:5, gitHead:execFileSync('git', ['rev-parse','HEAD'], { cwd:root, encoding:'utf8' }).trim(), node:process.version, dependencyLockSha256:sha(readFileSync(join(root,'package-lock.json'))), testedBoundarySha256:before.sha256, maximumAuthorizedTurnsPerHarness:4, selectedHarnesses, calls:counts, credentialMaterialRecorded:false, providerEndpointRecorded:false, nativeAuthHomesRecorded:false, nativePackages:Object.fromEntries(['@openai/codex','@github/copilot','@github/copilot-sdk'].map((name)=>[name,JSON.parse(readFileSync(join(root,'node_modules',name,'package.json'),'utf8')).version])), harnesses:{}, limitations:['Targeted native runtime check; control-tree transport and browser display are qualified separately.'] };
const redact = (error) => String(error instanceof Error ? error.message : error).replaceAll(work,'<test-workdir>').replaceAll(key || '\0','<redacted>').replaceAll(providerUrl || '\0','<redacted-endpoint>').replace(/https?:\/\/[^\s"']+/g,'<redacted-endpoint>').replace(/\b(?:sk-[A-Za-z0-9_-]{15,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g,'<redacted>');
const scrub = (error) => redact(error).slice(0,1500);
const until = async (predicate, label, timeout=90_000) => {
  const end = Date.now()+timeout;
  while (Date.now()<end) { const result=await predicate(); if(result) return result; await new Promise((done)=>setTimeout(done,100)); }
  throw new Error(`timed out: ${label}`);
};
function png() {
  const width=192, height=96;
  const raw=Buffer.alloc((width*3+1)*height,255);
  for(let y=0;y<height;y++) { raw[y*(width*3+1)]=0; for(let x=0;x<width;x++) {
    const color=x>=18&&x<74&&y>=20&&y<76?[230,30,30]:(x-143)**2+(y-48)**2<29**2?[25,70,230]:[255,255,255];
    for(let c=0;c<3;c++) raw[y*(width*3+1)+1+x*3+c]=color[c];
  } }
  const crc=(bytes)=>{let value=0xffffffff; for(const byte of bytes){value^=byte;for(let n=0;n<8;n++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
  const chunk=(name,data)=>{const type=Buffer.from(name);const length=Buffer.alloc(4);length.writeUInt32BE(data.length);const sum=Buffer.alloc(4);sum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([length,type,data,sum]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
const bytes=png();
writeFileSync(join(receipt,'synthetic-shapes.png'),bytes,{mode:0o600});

async function qualify(harness) {
  const result={ model:process.env[`AGENT_MULTIPLEX_LIVE_${harness.toUpperCase()}_MODEL`] ?? 'gpt-5.6-sol', status:'running', turns:[], checks:{} };
  manifest.harnesses[harness]=result;
  const workspace=join(work,`${harness}-workspace`), auth=join(work,`${harness}-auth`);
  mkdirSync(workspace,{mode:0o700});mkdirSync(auth,{mode:0o700});
  writeFileSync(join(workspace,'shapes.png'),bytes);
  execFileSync('git',['init','--quiet',workspace]);
  if(harness==='codex') writeFileSync(join(auth,'config.toml'), `model_provider = "codex-lb"\nmodel = ${JSON.stringify(result.model)}\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.codex-lb]\nname = "native image test provider"\nbase_url = ${JSON.stringify(providerUrl)}\nwire_api = "responses"\nenv_key = "MULTIPLEX_NATIVE_SMOKE_PROVIDER_KEY"\n`,{mode:0o600});
  const createAdapter=()=>harness==='codex'
    ? new CodexAdapter({binary:join(root,'node_modules','.bin','codex'),cwd:workspace,environment:{...process.env,CODEX_HOME:auth,MULTIPLEX_NATIVE_SMOKE_PROVIDER_KEY:key}})
    : new CopilotAgentAdapter({defaultModel:result.model,provider:{type:'openai',baseUrl:providerUrl,apiKey:key,wireApi:'responses'},providerModels:[result.model],clientOptions:{baseDirectory:auth,workingDirectory:workspace,logLevel:'none',useLoggedInUser:false}});
  const filename=join(work,`${harness}-runtime.sqlite`), runtimeNodeId=newRuntimeNodeId(), sessionId=newSessionId();
  let boot=newRuntimeNodeBootId(), store, service, events=[], collecting, cancel;
  const start=async()=>{
    store=new RuntimeNodeStore(filename);
    const adapter=createAdapter();
    service=new RuntimeNodeService({store,runtimeNodeId,runtimeNodeBootId:boot,adapters:[adapter],allowedRoots:[workspace],name:`native ${harness} images`});
    const descriptor=await adapter.describe();
    assert(descriptor.available,`${harness} adapter unavailable`);
    result.nativeVersion=descriptor.version; result.runtimeVersion=descriptor.runtimeVersion ?? descriptor.version;
    assert.equal(descriptor.version,harness==='codex'?'0.152.0':'1.0.13');
    cancel=new AbortController();
    collecting=(async()=>{for await(const event of service.events({native:{}},cancel.signal))events.push(event);})();
  };
  const close=async()=>{cancel?.abort();await collecting?.catch(()=>{});if(service)await service.close();store?.close();service=undefined;};
  try {
    await start();
    const profile=service.launchProfiles()[0]; assert(profile);
    const launchId=newLaunchId();
    const input={cwd:workspace,model:result.model,...(harness==='codex'?{approvalPolicy:'never',sandbox:'read-only',effort:'low',...(process.argv.includes('--image-only')?{native:{developerInstructions:'When an image arrives with no text, describe its colored shapes and positions briefly, then put ![shapes](./shapes.png) on its own line. Do not use tools.'}}:{})}:{reasoningEffort:'low',native:{availableTools:[],...(process.argv.includes('--image-only')?{systemMessage:{mode:'append',content:'When an image arrives with no text, describe its colored shapes and positions briefly, then put ![shapes](./shapes.png) on its own line. Do not use tools.'}}:{})}})};
    service.createLaunch({launchId,payloadHash:sha(JSON.stringify(input)),sessionId,runtimeNodeId,profile,harness,input});
    const launch=await until(()=>{const value=service.getLaunch(launchId);return value&&['succeeded','failed','outcomeUnknown'].includes(value.state)?value:false;},`${harness} launch`,30_000);
    assert.equal(launch.state,'succeeded',`launch did not succeed (${launch.state})`);
    const target=()=>({sessionId,runtimeNodeId,runtimeNodeBootId:boot,bindingRevision:1});
    const upload={...target(),imageId:randomUUID(),mediaType:'image/png',byteLength:bytes.length,sha256:sha(bytes)};
    await service.beginImageUpload(upload);
    await service.writeImageUpload({...upload,offset:0,dataBase64:bytes.toString('base64')});
    const image=await service.commitImageUpload(upload);
    result.checks.uploadAndChecksum=true;
    for(let turn=0;turn<(process.argv.includes('--one-turn') ? 1 : 2);turn++) {
      assert(counts[harness]<4,`${harness} authorized turn budget exhausted`);
      const mixed=turn===0&&!process.argv.includes('--image-only');
      const prompt='Describe the attached image briefly. Name each colored shape and its position. Then put this exact Markdown on its own line: ![shapes](./shapes.png). Do not use tools. If my next message contains only an image, describe that image and repeat the same Markdown. Keep each answer under 35 words.';
      const request=harness==='codex'
        ? {harness,command:{type:'send',input:[...(mixed?[{type:'text',text:prompt,text_elements:[]}]:[]),{type:'image',url:null}]}}
        : {harness,command:{type:'send',prompt:mixed?prompt:'',native:{attachments:[{type:'blob',mimeType:'image/png',data:null}]}}};
      const images=[{pointer:harness==='codex'?`/command/input/${mixed?1:0}/url`:'/command/native/attachments/0/data',representation:harness==='codex'?'dataUrl':'base64',image}];
      const eventStart=events.length;
      counts[harness]++;save('call-counts.json',counts);save('manifest.json',manifest);
      const commandId=newCommandId();
      const operation=await service.execute({commandId,payloadHash:sha(JSON.stringify({request,images})),sessionId,runtimeNodeId,bindingRevision:1,request,images});
      assert.equal(operation.state,'succeeded',`native ${harness} dispatch ${operation.state}: ${operation.error ?? ''}`);
      await until(()=>events.slice(eventStart).some((event)=>event.kind==='native'&&(event.nativeType===(harness==='codex'?'turn/completed':'session.idle')))&&(harness==='codex'||events.slice(eventStart).some((event)=>event.kind==='native'&&event.nativeType==='assistant.message')),`${harness} image turn completion`);
      const history=[];let cursor;
      do {
        const page=await service.readNativeHistory(sessionId,{harness,includeTurns:true,limit:100,...(cursor?{cursor}:{})});
        history.push(page.payload);cursor=page.nextCursor;
      }while(cursor&&history.length<20);
      assert(!cursor,'history pagination exceeded test bound');
      const json=JSON.stringify(history.map((page)=>page.json));
      const nativeImages=history.flatMap((page)=>page.images);
      assert(nativeImages.some((slot)=>!('unavailable'in slot.image)),`${harness} history lacks retained image descriptors`);
      assert(!json.includes(bytes.toString('base64')),'native history leaked inline image bytes');
      const assistantText=JSON.stringify(events.slice(eventStart).filter((event)=>event.kind==='native'&&(harness==='codex'?event.nativeType==='item/completed':event.nativeType==='assistant.message')).map((event)=>event.payload.json));
      save(`${harness}-turn-${counts[harness]}-diagnostics.json`, { assistantText:scrub(assistantText), nativeTypes:[...new Set(events.slice(eventStart).filter((event)=>event.kind==='native').map((event)=>event.nativeType))], nativeErrors:events.slice(eventStart).filter((event)=>event.kind==='native'&&/error/i.test(event.nativeType)).map((event)=>scrub(JSON.stringify(event.payload.json))) });
      assert(/red/i.test(assistantText)&&/left/i.test(assistantText)&&/blue/i.test(assistantText)&&/right/i.test(assistantText),`${harness} image description did not identify the two shapes`);
      assert(assistantText.includes('![shapes](./shapes.png)'),`${harness} did not return the workspace Markdown image`);
      const leaks=events.slice(eventStart).filter((event)=>JSON.stringify(event).includes(bytes.toString('base64'))).map((event)=>JSON.parse(redact(JSON.stringify(event).replaceAll(bytes.toString('base64'),'<synthetic-image-base64>'))));
      if(leaks.length) { result.checks.nativeEventInlineBytes=false;save(`${harness}-turn-${counts[harness]}-inline-leaks.json`,leaks); } else result.checks.nativeEventInlineBytes=true;
      assert(!JSON.stringify(store.getCommand(commandId)).includes(bytes.toString('base64')),'command receipt leaked inline bytes');
      result.turns.push({kind:mixed?'text-and-image':'image-only',completed:true,visionDescriptionMatched:true,markdownImageReturned:true,historyPages:history.length,historyImageSlots:nativeImages.length,historyUnavailableSlots:nativeImages.filter((slot)=>'unavailable'in slot.image).length,nativeEventImages:events.slice(eventStart).filter((event)=>event.kind==='native').reduce((count,event)=>count+event.payload.images.length,0)});
      save('manifest.json',manifest);
    }
    const snapshot=await service.resolveImagePath({...target(),sourceKey:`native-smoke:${harness}:markdown`,path:'./shapes.png'});
    assert.equal(snapshot.sha256,sha(bytes));
    writeFileSync(join(workspace,'shapes.png'),'replaced after first display');
    assert.deepEqual(await service.resolveImagePath({...target(),sourceKey:`native-smoke:${harness}:markdown`,path:'./shapes.png'}),snapshot);
    result.checks.workspaceMarkdownImmutableSnapshot=true;
    const stop=await service.stop({operation:'stop',commandId:newCommandId(),payloadHash:sha('stop-native-images'),sessionId,runtimeNodeId,bindingRevision:1});
    assert.equal(stop.state,'succeeded');
    assert.equal((await service.readImage({...target(),imageId:image.imageId,offset:0,length:bytes.length})).dataBase64,bytes.toString('base64'));
    result.checks.stoppedRead=true;
    await close();boot=newRuntimeNodeBootId();await start();
    for(const descriptor of [image,snapshot]) {
      const read=await service.readImage({...target(),imageId:descriptor.imageId,offset:0,length:bytes.length});
      assert.deepEqual(read.image,descriptor);assert.equal(read.dataBase64,bytes.toString('base64'));
    }
    result.checks.restartedReads=true;
    result.status=result.checks.nativeEventInlineBytes===false?'failed':'passed';
    if(result.status==='failed')result.error='native event leaked inline image bytes';
  } catch(error) {result.status='failed';result.error=scrub(error);throw error;}
  finally {await close();}
}
try {
  const config=readFileSync(sourceConfig,'utf8');
  const section=config.match(/^\[model_providers\.codex-lb\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1];
  providerUrl=JSON.parse(section?.match(/^\s*base_url\s*=\s*("[^"\n]+")/m)?.[1]??'null');
  assert(typeof providerUrl==='string'&&/^https?:/.test(providerUrl),'configured test provider unavailable');
  key=readFileSync(sourceKey,'utf8').trim();assert(key.length>=16&&!/[\r\n]/.test(key),'configured provider key invalid');
  for(const harness of selectedHarnesses) {
    try {await qualify(harness);}catch(error){process.stderr.write(`${harness} native image smoke failed: ${scrub(error)}\n`);}
  }
  const after=boundary();
  save('tested-boundary-after.json',after);
  manifest.testedBoundaryUnchanged=after.sha256===before.sha256;
  manifest.status=Object.values(manifest.harnesses).length===selectedHarnesses.length&&Object.values(manifest.harnesses).every((item)=>item.status==='passed')&&manifest.testedBoundaryUnchanged?'passed':'failed';
}catch(error){manifest.status='failed';manifest.error=scrub(error);}
finally {
  rmSync(work,{recursive:true,force:true});
  manifest.cleanup={temporaryRuntimeAndAuthHomesRemoved:!existsSync(work)};
  manifest.finishedAt=new Date().toISOString();save('manifest.json',manifest);
  for(const file of readdirSync(receipt)) {
    if(!file.endsWith('.json'))continue;
    const content=readFileSync(join(receipt,file),'utf8');
    assert(!key||!content.includes(key),'receipt contains provider key');
    assert(!providerUrl||!content.includes(providerUrl),'receipt contains provider endpoint');
  }
  writeFileSync(join(receipt,'SHA256SUMS'),readdirSync(receipt).filter((file)=>file!=='SHA256SUMS'&&statSync(join(receipt,file)).isFile()).sort().map((file)=>`${sha(readFileSync(join(receipt,file)))}  ${file}`).join('\n')+'\n',{mode:0o600});
}
console.log(JSON.stringify({status:manifest.status,calls:counts,receipt}));
process.exitCode=manifest.status==='passed'?0:1;
