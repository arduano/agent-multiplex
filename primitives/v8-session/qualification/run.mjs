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
const sources=[...await files(root),...await files(join(framework,'primitives/v8-lifecycle-default/src')),...await files(join(framework,'primitives/v8-harness-defaults/src')),...await files(join(framework,'primitives/v8-harness-codex/src')),...await files(join(framework,'primitives/v8-harness-copilot/src')),...await files(join(framework,'primitives/v8-history/src')),...await files(join(framework,'primitives/v8-files/src')),
  join(framework,'packages/storage-sqlite/src/index.ts'),join(framework,'packages/storage-sqlite/src/private-path.ts'),join(framework,'package.json'),join(framework,'package-lock.json')].filter(path=>!path.endsWith('.md'));
const unique=[...new Set(sources)].sort();
const manifest=async()=>Promise.all(unique.map(async path=>({path:relative(root,path),sha256:sha(await readFile(path))})));
const before=await manifest(), manifestText=JSON.stringify(before,null,2)+'\n', sourceHash=sha(manifestText);
await writeFile(join(artifact,'manifest.json'),manifestText);
let log='', receipt;
async function gate(name,args,timeout){
  process.stdout.write(`\n${name}\n`);log+=`\n${name}\n`;
  const child=spawn(process.execPath,args,{cwd:root,detached:true,stdio:['ignore','pipe','pipe']});
  const signalOwned=signal=>{try{process.kill(-child.pid,signal)}catch(error){if(error.code!=='ESRCH')throw error}};
  let output='',overflow=false,expired=false;
  const collect=chunk=>{if(overflow)return;output+=chunk;log+=chunk;process.stdout.write(chunk);if(output.length>8*1024*1024){overflow=true;signalOwned('SIGTERM')}};
  child.stdout.on('data',collect);child.stderr.on('data',collect);
  let force;
  const timer=setTimeout(()=>{expired=true;signalOwned('SIGTERM');force=setTimeout(()=>signalOwned('SIGKILL'),5000)},timeout);
  try{
    await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>code===0&&!overflow&&!expired?done():reject(new Error(`${name} failed (${signal??code})`)))});
    return output;
  }finally{clearTimeout(timer);if(force)clearTimeout(force)}
}
try{
  const browserGraph=await build({entryPoints:[join(root,'src/index.ts')],bundle:true,platform:'browser',format:'esm',write:false,metafile:true,logLevel:'silent'});
  for(const path of Object.keys(browserGraph.metafile.inputs))if(path.includes('/src/host/')||path.includes('/v8-lifecycle-default/')||path.includes('storage-sqlite')||path.includes('process-fixture'))throw new Error('Node owner escaped into browser graph');
  const compiler=require.resolve('typescript/bin/tsc');
  await gate('strict session/native type contract check',[compiler,'--project','tsconfig.json','--noEmit'],45000);
  await gate('isolated closed-source session/history/file/storage build',[compiler,'--project','tsconfig.json'],45000);
  const tests=(await files(join(root,'qualification'))).filter(path=>path.endsWith('.test.ts')).map(path=>join(root,'.build/primitives/v8-session',relative(root,path).replace(/\.ts$/,'.js')));
  const output=await gate('normal temporary-filesystem session invariant suite',['--test','--test-concurrency=1','--test-timeout=60000',...tests],600000);
  const nodeCount=Number(output.match(/(?:#|ℹ) tests (\d+)/)?.[1]);
  if(!Number.isSafeInteger(nodeCount)||nodeCount<1||!/(?:#|ℹ) fail 0\b/.test(output)||!/(?:#|ℹ) skipped 0\b/.test(output))throw new Error('Incomplete Node result');
  const comparison=JSON.parse(output.match(/^.*V8_SESSION_COMPARISON (\[.*\])$/m)?.[1]??'null');
  if(!Array.isArray(comparison)||comparison.length!==8)throw new Error('Incomplete scripted placement comparison');
  await writeFile(join(artifact,'comparison.json'),JSON.stringify({boundary:'Node scaffolding only; native benchmark gated',rows:comparison,nativeMatrix:{status:'not-run-no-fresh-allowance',harnesses:['codex','copilot'],placements:['shared','dedicated'],roots:[1,4],repetitions:2}},null,2)+'\n');
  const {runBrowserQualification}=await import('./browser.mjs');
  const browser=await runBrowserQualification();
  if(!browser.passed||!browser.cases.length)throw new Error('Incomplete Chromium result');
  if(JSON.stringify(await manifest())!==JSON.stringify(before))throw new Error('Qualification source changed during run');
  receipt={status:'isolated-session-qualified',startedAt,completedAt:new Date().toISOString(),sourceHash,
    frameworkHead:execFileSync('git',['rev-parse','HEAD'],{cwd:framework,encoding:'utf8'}).trim(),
    node:process.version,typescript:require('typescript/package.json').version,playwright:require('playwright-core/package.json').version,chromium:browser.chromium,
    tests:{node:nodeCount,browser:browser.cases.length,cases:browser.cases},
    boundary:'scripted native ports; real disposable worker SQLite, owned Linux Node process fixtures, actual retained session/history/file clients; Chromium uses scripted Host',
    liveNativeOrModelCalls:0,productionIntegration:false,realP2prpcTransportTested:false,
    nativePlacementComparison:'gated-no-fresh-allowance',scriptedPlacementRows:comparison.length,
    strongStopBoundary:'exact injected trusted nativeTree proofs; real Codex unsubscribe and Copilot disconnect NOT accepted as strong Stop',
    limitations:['real native stop/child/tool/queue semantics unqualified','Node fixture group tests are not generic platform containment','Windows and power-loss unqualified','product transport/auth/React hooks/popups unqualified','known combined two-viewer Root/Host disconnect unresolved']};
}catch(error){receipt={status:'failed-diagnostic',startedAt,completedAt:new Date().toISOString(),sourceHash,error:String(error.message??'Session gate failed')};process.exitCode=1}
const result=JSON.stringify(receipt,null,2)+'\n';
await writeFile(join(artifact,'result.json'),result);await writeFile(join(artifact,'checks.log'),log);
const checked=['manifest.json','result.json','checks.log'];
try{await readFile(join(artifact,'comparison.json'));checked.push('comparison.json')}catch{}
await writeFile(join(artifact,'SHA256SUMS'),(await Promise.all(checked.map(async file=>`${sha(await readFile(join(artifact,file)))}  ${file}\n`))).join(''));
if(receipt.status==='isolated-session-qualified'){
  const latest=join(root,'artifacts/latest');await rm(latest,{recursive:true,force:true});await cp(artifact,latest,{recursive:true});
}
process.stdout.write(`${receipt.status}: ${relative(root,artifact)} source ${sourceHash}\n`);
if(receipt.tests)process.stdout.write(`${receipt.tests.node} Node invariants; ${receipt.tests.browser} Chromium cases\n`);
if(receipt.error)process.stderr.write(receipt.error+'\n');
