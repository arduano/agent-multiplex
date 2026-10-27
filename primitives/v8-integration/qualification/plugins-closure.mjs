import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readdir,readFile,writeFile,copyFile,lstat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const framework=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function files(directory){
 const found=[];
 for(const entry of await readdir(directory,{withFileTypes:true})){
  const path=join(directory,entry.name);
  if(entry.isSymbolicLink())throw Error('Symlink in copied runtime source');
  if(entry.isDirectory())found.push(...await files(path));else if(entry.isFile())found.push(path);
 }
 return found.sort();
}
async function finite(command,args,cwd,timeoutMs){
 const child=spawn(command,args,{cwd,stdio:['ignore','pipe','pipe'],detached:true});
 let output='',expired=false,overflow=false;
 const stop=signal=>{try{process.kill(-child.pid,signal)}catch(error){if(error.code!=='ESRCH')throw error;}};
 const collect=value=>{if(output.length<1024*1024)output+=value;else{overflow=true;stop('SIGTERM');}};
 child.stdout.on('data',collect);child.stderr.on('data',collect);
 let forced;
 const timer=setTimeout(()=>{expired=true;stop('SIGTERM');forced=setTimeout(()=>stop('SIGKILL'),3000);},timeoutMs);
 try{
  const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);});
  if(code!==0||expired||overflow)throw Error(`Offline package install failed (${expired?'deadline':overflow?'output bound':code}): ${output.slice(-6000)}`);
 }finally{clearTimeout(timer);if(forced)clearTimeout(forced);}
 return output;
}
async function until(read,timeout=30000){const end=Date.now()+timeout;while(!await read()){if(Date.now()>=end)throw Error('Copied application observation deadline');await new Promise(resolve=>setTimeout(resolve,20));}}

/** Bounded source-package closure, not a deployment/native acceptance claim.
 * The only construction is disposable scripted Host owners; no native factory
 * is invoked. All npm packages use the retained offline cache and exact pins. */
export async function runPluginClosureQualification({buildRoot}){
 const started=Date.now(),directory=await mkdtemp(join(tmpdir(),'v8-plugins-closure-'));
 const pkg=join(directory,'package');let app,result;
 try{
  await mkdir(pkg,{recursive:true,mode:0o700});
  const rootManifest=JSON.parse(await readFile(join(framework,'package.json'),'utf8'));
  const dependencies={'@trpc/client':rootManifest.dependencies['@trpc/client'],'@trpc/server':rootManifest.dependencies['@trpc/server'],zod:rootManifest.dependencies.zod,react:'19.2.8','react-dom':'19.2.8','@github/copilot':'1.0.95','@github/copilot-sdk':'1.0.19','@openai/codex':'0.162.1'};
  for(const value of Object.values(dependencies))assert.ok(!/^(?:file:|link:|workspace:|\.\.?\/)/.test(value));
  await writeFile(join(pkg,'package.json'),JSON.stringify({name:'multiplex-v8-plugin-closure',version:'0.0.0',private:true,type:'module',dependencies,overrides:{'@github/copilot':'1.0.95'}},null,2)+'\n');
  const copied=[];
  for(const file of await files(join(buildRoot,'primitives'))){
   const path=relative(buildRoot,file);
   if(!file.endsWith('.js')||(!path.includes('/src/')&&!path.includes('/v8-integration/application/')&&!path.endsWith('/v8-host/qualification/fixture.js')))continue;
   const output=join(pkg,path);await mkdir(dirname(output),{recursive:true,mode:0o700});await copyFile(file,output);copied.push({path,sha256:sha(await readFile(output))});
  }
  for(const name of['index.js','private-path.js']){
   const path=`packages/storage-sqlite/src/${name}`,output=join(pkg,path);await mkdir(dirname(output),{recursive:true,mode:0o700});await copyFile(join(buildRoot,path),output);copied.push({path,sha256:sha(await readFile(output))});
  }
  for(const path of['primitives/v8-lifecycle-default/src/registry-worker.js','primitives/v8-lifecycle-default/src/session/journal-worker.js','primitives/v8-files/src/host/worker.js','primitives/v8-catalog/src/authority/worker.js'])assert.ok((await lstat(join(pkg,path))).isFile(),`Missing explicit worker: ${path}`);
  await finite('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund','--no-progress','--bin-links=false','--registry=https://registry.npmjs.org'],pkg,120000);
  await files(join(pkg,'node_modules')); // Published npm closure itself contains no symlink dependency.
  const lock=JSON.parse(await readFile(join(pkg,'package-lock.json'),'utf8'));
  for(const value of Object.values(lock.packages??{}))if(value&&typeof value==='object'){
   assert.ok(!value.link,'Installed package must not link outside the closure');
   if(typeof value.resolved==='string')assert.ok(!/^(?:file:|link:|workspace:)/.test(value.resolved));
  }
  const versions={};
  for(const[name,version]of Object.entries({'@trpc/server':'11.18.0','@trpc/client':'11.18.0',zod:'4.1.5',react:'19.2.8','react-dom':'19.2.8','@github/copilot':'1.0.95','@github/copilot-sdk':'1.0.19','@openai/codex':'0.162.1'})){
   const installed=JSON.parse(await readFile(join(pkg,'node_modules',name,'package.json'),'utf8')).version;assert.equal(installed,version);versions[name]=installed;
  }
  const assets=join(pkg,'assets');await mkdir(assets,{mode:0o700});
  const browser=await build({entryPoints:[join(pkg,'primitives/v8-integration/application/client.js')],outfile:join(assets,'client.js'),platform:'browser',format:'esm',target:'es2023',bundle:true,metafile:true,define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'});
  for(const input of Object.keys(browser.metafile.inputs)){
   const absolute=resolve(input);assert.ok(absolute.startsWith(pkg+'/'),'Browser import escaped standalone package');
   assert.ok(!/\/src\/(?:host|node|authority|gateway|http)\//.test(input)&&!input.includes('storage-sqlite')&&!input.includes('v8-lifecycle-default'),'Native owner entered browser bundle');
  }
  for(const file of['index.html','style.css'])await copyFile(join(framework,'primitives/v8-integration/application',file),join(assets,file));
  const codex=await import(pathToFileURL(join(pkg,'primitives/v8-harness-codex/src/node.js')).href);
  const copilot=await import(pathToFileURL(join(pkg,'primitives/v8-harness-copilot/src/node.js')).href);
  assert.equal(typeof codex.codexHarness,'function');assert.equal(typeof copilot.copilotHarness,'function');
  const sdk=await import(pathToFileURL(join(pkg,'node_modules/@github/copilot-sdk/dist/index.js')).href);
  assert.equal(typeof sdk.CopilotClient,'function');
  const {startApplication}=await import(pathToFileURL(join(pkg,'primitives/v8-integration/application/server.js')).href);
  app=await startApplication({directory:join(directory,'private-state'),assets});
  const home=await fetch(app.url),cookie=home.headers.get('set-cookie')?.split(';')[0];await home.arrayBuffer();assert.ok(cookie);
  const configuration=await fetch(new URL('/configuration',app.url),{headers:{cookie}}).then(response=>response.json());
  const request=async body=>{
   const response=await fetch(new URL('/v8',app.url),{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(body)});
   const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result.value;
  };
  const cases=[];
  for(const target of configuration.targets){
   const kind=target.session==='main'?'codex':'copilot',scope={connection:target.connection,principal:target.principal,host:target.host,session:target.session};
   const create={scope:configuration.scope,id:`closure-create-${target.session}`,session:target.session,target:{host:target.host,owner:target.owner,kind,placement:'dedicated'},metadata:{name:'Copied package session',cwd:null}};
   await request({op:'catalog.create',request:create});
   await until(async()=>{const value=await request({op:'catalog.creation',scope:configuration.scope,id:create.id});return value?.state==='nativeCreated';});
   const initial=await request({op:'snapshot',target});assert.equal(initial.phase,'running');const native=initial.nativeSession;
   await request({op:'submit',target,request:{scope,id:`closure-stop-${target.session}`,generation:initial.generation,command:{type:'stop'}}});
   await until(async()=>(await request({op:'snapshot',target})).phase==='stopped');
   await request({op:'submit',target,request:{scope,id:`closure-resume-${target.session}`,generation:initial.generation,command:{type:'resume'}}});
   await until(async()=>(await request({op:'snapshot',target})).phase==='running');
   const resumed=await request({op:'snapshot',target});assert.equal(resumed.nativeSession,native);assert.equal(resumed.generation,initial.generation+1);
   const counts=app.stats().find(value=>value.id===target.session);assert.equal(counts.opens,1);assert.equal(counts.resumes,1);assert.equal(counts.sends,0);assert.equal(counts.bodyReads,0);
   cases.push(`standalone ${kind} plugin Create/Stop/same-ID quiet Resume through HTTP and actual SQLite owners`);
  }
  await app.close();app=undefined;
  result={passed:true,cases,files:copied.length,sourceHash:sha(JSON.stringify(copied.sort((a,b)=>a.path.localeCompare(b.path)))),versions,
   browserInputs:Object.keys(browser.metafile.inputs).length,dependencyClosure:'exact published npm offline; scripts disabled; no local/file/link runtime dependencies',
   nativeEntryImports:true,sdkEntryImport:true,modelCalls:0,providerCalls:0,nativeAgentCalls:0,elapsedMs:Date.now()-started,
   limitations:['source package assembled from compiled private V8 modules; not a published release','no real native factory or CLI launch','no platform binary/containment or deployment acceptance','Chromium behavior qualified separately','p2prpc/Iroh transport package closure is qualified separately; not imported by this in-process application']};
 }catch(error){result={passed:false,cases:[],failure:String(error.message??error),elapsedMs:Date.now()-started,modelCalls:0,providerCalls:0,nativeAgentCalls:0};}
 finally{
  try{await app?.close();}catch(error){result={...result,passed:false,cleanupFailure:String(error.message??error)};}
  await rm(directory,{recursive:true,force:true});
 }
 return {...result,cleanup:!result.cleanupFailure};
}
