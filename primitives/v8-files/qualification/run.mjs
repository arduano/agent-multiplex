import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'), framework=resolve(root,'../..');
const require=createRequire(import.meta.url), sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const startedAt=new Date().toISOString(), artifact=join(root,'artifacts',`isolated-${startedAt.replaceAll(':','-').replaceAll('.','-')}`);
await mkdir(artifact,{recursive:true});
async function files(directory){
  const result=[];
  for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    if(['.build','artifacts','node_modules','.git'].includes(entry.name))continue;
    const path=join(directory,entry.name);
    if(entry.isDirectory())result.push(...await files(path));else if(entry.isFile())result.push(path);else throw new Error('Unsupported source file kind');
  }
  return result;
}
// These are source-composition inputs, never dependencies on an external runtime checkout.
const sources=[...await files(root),...await files(join(framework,'primitives/v8-history/src')),
  join(framework,'packages/storage-sqlite/src/index.ts'),join(framework,'packages/storage-sqlite/src/private-path.ts'),
  join(framework,'package.json'),join(framework,'package-lock.json')].filter(path=>!path.endsWith('.md'));
const unique=[...new Set(sources)].sort();
const manifest=async()=>Promise.all(unique.map(async path=>({path:relative(root,path),sha256:sha(await readFile(path))})));
const before=await manifest(), manifestText=JSON.stringify(before,null,2)+'\n', sourceHash=sha(manifestText);
await writeFile(join(artifact,'manifest.json'),manifestText);
let log='', receipt;
async function gate(name,args,timeout){
  process.stdout.write(`\n${name}\n`);log+=`\n${name}\n`;
  const child=spawn(process.execPath,args,{cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,V8_FILES_TMPDIR:undefined}});
  let output='',overflow=false;
  const collect=chunk=>{output+=chunk;log+=chunk;process.stdout.write(chunk);if(output.length>8*1024*1024){overflow=true;child.kill('SIGTERM')}};
  child.stdout.on('data',collect);child.stderr.on('data',collect);
  const timer=setTimeout(()=>child.kill('SIGTERM'),timeout);
  try{
    await new Promise((resolveDone,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>code===0&&!overflow?resolveDone():reject(new Error(`${name} failed (${signal??code})`)))});
    return output;
  }finally{clearTimeout(timer)}
}
try{
  // Browser bundle feasibility also proves no Node storage/worker code is reachable.
  const browserGraph=await build({entryPoints:[join(root,'src/index.ts')],bundle:true,platform:'browser',format:'esm',write:false,metafile:true,logLevel:'silent'});
  for(const path of Object.keys(browserGraph.metafile.inputs))if(path.includes('/src/host/')||path.includes('storage-sqlite')||path.includes('/src/transport/'))throw new Error('Node code escaped into browser graph');
  const compiler=require.resolve('typescript/bin/tsc');
  await gate('strict file contract check',[compiler,'--project','tsconfig.json','--noEmit'],45000);
  await gate('isolated closed-source composition build',[compiler,'--project','tsconfig.json'],45000);
  const tests=(await files(join(root,'qualification'))).filter(path=>path.endsWith('.test.ts')).map(path=>join(root,'.build/primitives/v8-files',relative(root,path).replace(/\.ts$/,'.js')));
  const output=await gate('normal temporary-filesystem invariant suite',['--test','--test-concurrency=1','--test-timeout=60000',...tests],600000);
  const nodeCount=Number(output.match(/(?:#|ℹ) tests (\d+)/)?.[1]);
  if(!Number.isSafeInteger(nodeCount)||nodeCount<1||!/(?:#|ℹ) fail 0\b/.test(output)||!/(?:#|ℹ) skipped 0\b/.test(output))throw new Error('Incomplete Node result');
  const {runBrowserQualification}=await import('./browser.mjs');
  const browser=await runBrowserQualification();
  if(!browser.passed||!browser.cases.length)throw new Error('Incomplete Chromium result');
  if(JSON.stringify(await manifest())!==JSON.stringify(before))throw new Error('Qualification source changed during run');
  receipt={status:'isolated-files-qualified',startedAt,completedAt:new Date().toISOString(),sourceHash,
    frameworkHead:execFileSync('git',['rev-parse','HEAD'],{cwd:framework,encoding:'utf8'}).trim(),
    node:process.version,typescript:require('typescript/package.json').version,playwright:require('playwright-core/package.json').version,chromium:browser.chromium,
    tests:{node:nodeCount,browser:browser.cases.length,cases:browser.cases},
    boundary:'real disposable Linux worker/SQLite/filesystem and HTTP; actual retained history/file clients and two native-shaped conversations; Chromium/IndexedDB/two-tab/DOM harness uses scripted Host',
    filesystem:'default os.tmpdir; no tmpfs override; process crash/reopen only',liveNativeOrModelCalls:0,productionIntegration:false,realP2prpcTransportTested:false,
    oracles:[
      {id:'F1',status:'filesystem-and-scripted',proof:'durable same-ID upload conflict/reply recovery and byte integrity; no Send replay'},
      {id:'F2',status:'chromium',proof:'IndexedDB Blob/revision/original identity recovery, two tabs, session switches and pins'},
      {id:'F3',status:'linux-process-reopen',proof:'seven worker-kill boundaries and ordinary publication-error recovery; no power-loss claim'},
      {id:'F4',status:'linux-filesystem',proof:'first-preview immutable source mapping, changed/deleted path and expired ID fences'},
      {id:'F5',status:'scripted-owner-and-http',proof:'durable dependency holds and actual response/read leases prevent collection; request/native owner is scripted'},
      {id:'F6',status:'filesystem-and-scripted',proof:'finite bytes/entries/metadata/staging/queues, failed checkpoint/unlink and preserved unknown/replaced inodes'},
      {id:'F7',status:'linux-and-loopback-http',proof:'private-root/scope/handle fences, read-only navigation, inert binary downloads and ranges'},
      {id:'F8',status:'chromium-and-scripted',proof:'shared resource/URL lifetime, actual pending-work limits, inert SVG and real history anchor geometry; decoded accounting is not RSS'},
      {id:'F9',status:'native-shaped-only',proof:'Codex/Copilot image preparation and async media byte ownership; no live ingestion/temporary-file consumption claim'},
      {id:'combined two-viewer Root/Host disconnect',status:'unresolved',proof:'outside this isolated file and loopback HTTP boundary'},
    ]};
}catch(error){receipt={status:'failed-diagnostic',startedAt,completedAt:new Date().toISOString(),sourceHash,error:String(error.message??'File gate failed')};process.exitCode=1}
const result=JSON.stringify(receipt,null,2)+'\n';
await writeFile(join(artifact,'result.json'),result);await writeFile(join(artifact,'checks.log'),log);
await writeFile(join(artifact,'SHA256SUMS'),`${sha(manifestText)}  manifest.json\n${sha(result)}  result.json\n${sha(log)}  checks.log\n`);
if(receipt.status==='isolated-files-qualified'){
  const latest=join(root,'artifacts/latest');await rm(latest,{recursive:true,force:true});await cp(artifact,latest,{recursive:true});
}
process.stdout.write(`${receipt.status}: ${relative(root,artifact)} source ${sourceHash}\n`);
if(receipt.tests)process.stdout.write(`${receipt.tests.node} Node invariants; ${receipt.tests.browser} Chromium cases\n`);
if(receipt.error)process.stderr.write(receipt.error+'\n');
