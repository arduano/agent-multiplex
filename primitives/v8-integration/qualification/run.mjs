import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,readdir,readFile,writeFile,cp,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'), framework=resolve(root,'../..');
const require=createRequire(import.meta.url), sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const startedAt=new Date().toISOString();
const artifact=join(root,'artifacts',`composed-${startedAt.replaceAll(':','-').replaceAll('.','-')}`);
await mkdir(artifact,{recursive:true});
async function files(directory){
  const result=[];
  for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    if(['.build','artifacts','node_modules','.git'].includes(entry.name))continue;
    const path=join(directory,entry.name);
    if(entry.isDirectory())result.push(...await files(path));else if(entry.isFile())result.push(path);else throw new Error('Unsupported source kind');
  }
  return result;
}
const lanes=['v8-catalog','v8-interactions','v8-gateway','v8-mcp','v8-runtime','v8-organization','v8-host','v8-workspace','v8-plugins','v8-lifecycle-default','v8-harness-codex','v8-harness-copilot','v8-harness-defaults'];
const reusable=['v8-history','v8-files','v8-session'];
// Existing unique native-page, merge, cursor and view-token oracles; no copied suite.
const historyTests=['acquisition.test.ts','acquisition-host.test.ts','acquisition-boundaries.test.ts','acquisition-codex.test.ts','acquisition-copilot.test.ts','media.test.ts','host.test.ts','codex.test.ts','copilot.test.ts'].map(file=>join(framework,'primitives/v8-history/qualification',file));
const historyFixture=join(framework,'primitives/v8-history/qualification/fixtures/codex-live-20261023.json');
const fileQualification=['browser.mjs','browser-harness.html','client-fixture.ts','composer.test.ts','native-capture.test.ts'].map(file=>join(framework,'primitives/v8-files/qualification',file));
const sessionTests=['opening-ready.test.ts','opening-custody.test.ts','client-opening.test.ts','client-originals.test.ts','client.test.ts','native-invocation.test.ts','native-validation.test.ts','native-types.ts'].map(file=>join(framework,'primitives/v8-session/qualification',file));
// Reuse the decisive changed-owner tests without replaying their unrelated slow
// full suites. Their source remains frozen; unselected tests are reported as such.
const boundaryTests=[
  {name:'actual Host effort contradiction blocks Send',source:'v8-session/qualification/host.test.ts',pattern:'actual Host cannot Send after high-effort request',expected:1},
  {name:'actual FileHost cross-scope staging expiry',source:'v8-files/qualification/host.test.ts',pattern:'Host (new staging admission expires stale uploads across scopes|global staging expiry preserves failed-unlink)',expected:2},
  {name:'native preview auth-retirement resource cleanup',source:'v8-files/qualification/client.test.ts',pattern:'decoded image URL is revoked when auth retirement rejects final file release',expected:1},
].map(value=>({...value,path:join(framework,'primitives',value.source)}));
const sourceFiles=async()=>[...await files(root),...(await Promise.all(lanes.map(lane=>files(join(framework,'primitives',lane))))).flat(),
  ...(await Promise.all(reusable.map(lane=>files(join(framework,'primitives',lane,'src'))))).flat(),
  ...['host-fixture.ts','client-fixture.ts'].map(file=>join(framework,'primitives/v8-session/qualification',file)),
  ...sessionTests,...historyTests,historyFixture,...fileQualification,...boundaryTests.map(value=>value.path),
  join(framework,'packages/storage-sqlite/src/index.ts'),join(framework,'packages/storage-sqlite/src/private-path.ts'),
  join(framework,'package.json'),join(framework,'package-lock.json'),
  ...['@arduano/p2prpc-core','@momics/iroh-http-node'].map(name=>join(framework,'node_modules',name,'package.json')),
  ...(await Promise.all(['@arduano/p2prpc-core','@momics/iroh-http-node'].map(name=>files(join(framework,'node_modules',name))))).flat().filter(path=>/\.(?:[cm]?js|node)$/.test(path)),
  ...(await Promise.all(['react','react-dom','scheduler','@types/react','@types/react-dom','esbuild','@esbuild/linux-x64','playwright-core'].map(name=>files(join(framework,'node_modules',name))))).flat()].filter(path=>!path.endsWith('.md'));
const manifest=async()=>Promise.all([...new Set(await sourceFiles())].sort().map(async path=>({path:relative(root,path),sha256:sha(await readFile(path))})));
const before=await manifest(), manifestText=JSON.stringify(before,null,2)+'\n', sourceHash=sha(manifestText);
await writeFile(join(artifact,'manifest.json'),manifestText);
let log='',receipt;
async function gate(name,args,timeout){
  process.stdout.write(`\n${name}\n`);log+=`\n${name}\n`;
  const child=spawn(process.execPath,args,{cwd:root,detached:true,stdio:['ignore','pipe','pipe']});
  const signal=kind=>{try{process.kill(-child.pid,kind)}catch(error){if(error.code!=='ESRCH')throw error}};
  let output='',expired=false,overflow=false,force;
  const terminate=()=>{signal('SIGTERM');force??=setTimeout(()=>signal('SIGKILL'),5000)};
  const collect=chunk=>{if(overflow)return;output+=chunk;log+=chunk;process.stdout.write(chunk);if(output.length>8*1024*1024){overflow=true;terminate()}};
  child.stdout.on('data',collect);child.stderr.on('data',collect);
  const timer=setTimeout(()=>{expired=true;terminate()},timeout);
  try{
    await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',(code,kind)=>code===0&&!expired&&!overflow?done():reject(new Error(`${name} failed (${kind??code})`)))});
    return output;
  }finally{clearTimeout(timer);if(force)clearTimeout(force);signal('SIGKILL')}
}
try{
  for(const lane of lanes){
    const graph=await build({entryPoints:[join(framework,'primitives',lane,'src/index.ts')],bundle:true,platform:'browser',format:'esm',write:false,metafile:true,logLevel:'silent'});
    for(const path of Object.keys(graph.metafile.inputs))if(/\/src\/(?:host|node|authority|gateway|http)\//.test(path)||path.includes('storage-sqlite'))throw new Error(`Node owner escaped browser graph: ${lane}`);
  }
  const compiler=require.resolve('typescript/bin/tsc');
  await gate('strict composed source/type contracts',[compiler,'--project','tsconfig.json','--noEmit'],60000);
  await rm(join(root,'.build'),{recursive:true,force:true});
  await gate('closed source build including dynamic workers',[compiler,'--project','tsconfig.json'],60000);
  // These retained tests resolve ../../qualification/fixtures from compiled output.
  await mkdir(join(root,'.build/primitives/qualification/fixtures'),{recursive:true});
  await cp(historyFixture,join(root,'.build/primitives/qualification/fixtures/codex-live-20261023.json'));
  const testSources=[...await files(join(root,'qualification')),...(await Promise.all(lanes.map(lane=>files(join(framework,'primitives',lane,'qualification'))))).flat(),...sessionTests,...historyTests,...fileQualification].filter(path=>path.endsWith('.test.ts'));
  const tests=testSources.sort().map(path=>join(root,'.build',relative(framework,path).replace(/\.ts$/,'.js')));
  const output=await gate('bounded normal-filesystem new seams and composed traces',['--test','--test-concurrency=2','--test-timeout=60000',...tests],600000);
  const nodeCount=Number(output.match(/(?:#|ℹ) tests (\d+)/)?.[1]);
  if(!Number.isSafeInteger(nodeCount)||nodeCount<1||!/(?:#|ℹ) fail 0\b/.test(output)||!/(?:#|ℹ) skipped 0\b/.test(output))throw new Error('Incomplete Node result');
  const boundaryResults=[];
  for(const selected of boundaryTests){
    const compiled=join(root,'.build',relative(framework,selected.path).replace(/\.ts$/,'.js'));
    const output=await gate(selected.name,['--test','--test-concurrency=1','--test-timeout=60000',`--test-name-pattern=${selected.pattern}`,compiled],120000);
    const passed=Number(output.match(/(?:#|ℹ) pass (\d+)/)?.[1]);
    if(passed!==selected.expected||!/(?:#|ℹ) fail 0\b/.test(output)||!/(?:#|ℹ) cancelled 0\b/.test(output))throw new Error(`Incomplete selected boundary: ${selected.name}`);
    boundaryResults.push({name:selected.name,passed,source:selected.source,pattern:selected.pattern});
  }
  const offlineLiveTests=(await Promise.all(['v8-interactions/qualification/live','v8-mcp/qualification/local','v8-integration/qualification/native'].map(path=>files(join(framework,'primitives',path))))).flat().filter(path=>path.endsWith('.test.mjs')).sort();
  const preflight=await gate('offline live-lane admission and actual browser preflight',['--test','--test-concurrency=1','--test-timeout=60000',...offlineLiveTests],90000);
  const preflightCount=Number(preflight.match(/(?:#|ℹ) tests (\d+)/)?.[1]);
  if(!Number.isSafeInteger(preflightCount)||preflightCount<1||!/(?:#|ℹ) fail 0\b/.test(preflight)||!/(?:#|ℹ) skipped 0\b/.test(preflight))throw new Error('Incomplete offline live-lane preflight');
  const browsers=[];
  for(const lane of [...lanes,'v8-files','v8-integration']){
    const path=join(framework,'primitives',lane,'qualification/browser.mjs');
    try{await readFile(path)}catch(error){if(error.code==='ENOENT')continue;throw error}
    const {runBrowserQualification}=await import(path);
    const browser=await runBrowserQualification({buildRoot:join(root,'.build')});
    if(!browser.passed||!browser.cases.length)throw new Error(`Incomplete browser result: ${lane}`);
    browsers.push({lane,...browser});
  }
  if(!browsers.length)throw new Error('No browser seam qualified');
  const {runPluginBrowserQualification}=await import('../../v8-workspace/qualification/plugins-browser.mjs');
  const pluginBrowser=await runPluginBrowserQualification({buildRoot:join(root,'.build')});
  if(!pluginBrowser.passed||!pluginBrowser.cases.length)throw new Error('Incomplete typed plugin React proof');
  browsers.push({lane:'v8-plugins-react',...pluginBrowser});
  const {runPluginClosureQualification}=await import('./plugins-closure.mjs');
  const pluginClosure=await runPluginClosureQualification({buildRoot:join(root,'.build')});
  log+='\nstandalone-plugin-closure:'+JSON.stringify(pluginClosure)+'\n';
  if(!pluginClosure.passed||!pluginClosure.cleanup)throw new Error(`Incomplete standalone plugin closure: ${pluginClosure.failure??pluginClosure.cleanupFailure??'unknown'}`);
  const publishedOutput=await gate('bounded published p2prpc/Iroh adapter and shared-hop cancellation',['qualification/published.mjs',join(artifact,'p14')],120000);
  const publishedLine=publishedOutput.split('\n').find(line=>line.startsWith('published-transport-result:'));
  if(!publishedLine)throw new Error('Missing published transport result');
  const publishedTransport=JSON.parse(publishedLine.slice('published-transport-result:'.length));
  if(!publishedTransport.passed||!publishedTransport.cleanup||publishedTransport.p14!=='v8-shared-hop-qualified'||publishedTransport.historicalP14InitialCloseCaller!=='unproved')throw new Error('Incomplete published shared-hop transport qualification');
  if(JSON.stringify(await manifest())!==JSON.stringify(before))throw new Error('Source changed during qualification');
  receipt={status:'isolated-composition-qualified',startedAt,completedAt:new Date().toISOString(),sourceHash,sourceEntries:before.length,
    frameworkHead:execFileSync('git',['rev-parse','HEAD'],{cwd:framework,encoding:'utf8'}).trim(),
    node:process.version,typescript:require('typescript/package.json').version,playwright:require('playwright-core/package.json').version,
    tests:{node:nodeCount+preflightCount+boundaryResults.reduce((sum,value)=>sum+value.passed,0),coreNode:nodeCount,selectedBoundaries:boundaryResults,offlineLivePreflight:preflightCount,preflightIncludesChromium:true,browser:browsers.reduce((sum,b)=>sum+b.cases.length,0),browsers},
    boundary:'explicit lifecycle/harness plugins, typed heterogeneous React and generic Host tRPC; actual worker SQLite, files, authenticated HTTP, shared published transport, standalone closure and scripted native boundaries',
    liveNativeOrModelCalls:0,productionIntegration:false,realP2prpcTransportTested:true,publishedTransport,pluginClosure,
    limitations:['scripted native controllers do not qualify physical working-agent full-tree halt or all native SDK compatibility','production sign-in/TLS and fleet routing remain separate','V8 shared-hop cancellation is qualified; historical P14 first-close caller remains unproved','no deployment or existing-session operation']};
}catch(error){receipt={status:'failed-diagnostic',startedAt,completedAt:new Date().toISOString(),sourceHash,error:String(error.message??'Composed gate failed')};process.exitCode=1}
await writeFile(join(artifact,'result.json'),JSON.stringify(receipt,null,2)+'\n');
await writeFile(join(artifact,'checks.log'),log);
await writeFile(join(artifact,'SHA256SUMS'),(await Promise.all(['manifest.json','result.json','checks.log'].map(async file=>`${sha(await readFile(join(artifact,file)))}  ${file}\n`))).join(''));
if(receipt.status==='isolated-composition-qualified'){
  const latest=join(root,'artifacts/latest');await rm(latest,{recursive:true,force:true});await cp(artifact,latest,{recursive:true});
}
process.stdout.write(`${receipt.status}: ${relative(root,artifact)} source ${sourceHash}\n`);
if(receipt.tests)process.stdout.write(`${receipt.tests.node} Node; ${receipt.tests.browser} Chromium cases\n`);
if(receipt.error)process.stderr.write(receipt.error+'\n');
