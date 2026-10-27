import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,realpath} from 'node:fs/promises';
import {dirname,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';

const here=dirname(fileURLToPath(import.meta.url)),build=resolve(here,'../.build');
export async function runBrowserQualification({buildRoot=build}={}){
  const [{createFileHttpHandler},{ClientFixturePort}]=await Promise.all([import(pathToFileURL(resolve(buildRoot,'primitives/v8-files/src/transport/http.js')).href),import(pathToFileURL(resolve(buildRoot,'primitives/v8-files/qualification/client-fixture.js')).href)]);
  const scope={connection:'browser-files',principal:'fixture-owner',host:'fixture-host',session:'a'},port=new ClientFixturePort();
  const rpc=createFileHttpHandler(port,{authenticate(req){if(req.headers.cookie!=='fixture_owner=1')throw new Error('fixture authentication missing');return scope},canUpload:()=>true});
  const root=await realpath(buildRoot);
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://127.0.0.1');
      if(url.pathname==='/rpc'||url.pathname.startsWith('/files/')){await rpc(req,res);return}
      let filename;
      if(req.method==='GET'&&url.pathname==='/')filename=resolve(here,'browser-harness.html');
      else if(req.method==='GET'&&/^\/modules\/[a-zA-Z0-9_./-]+\.js$/.test(url.pathname)){
        const modulePath=url.pathname.slice('/modules/'.length);
        if(modulePath!=='primitives/v8-workspace/src/composer.js'&&!/^(?:primitives\/v8-files\/src\/(?:client|contracts|native)\/|primitives\/v8-history\/src\/(?:client|contracts)\/)[a-zA-Z0-9_./-]+\.js$/.test(modulePath))throw new Error('Node module excluded from browser fixture');
        filename=await realpath(resolve(root,modulePath));const rel=relative(root,filename);if(rel.startsWith(`..${sep}`)||!rel.startsWith(`primitives${sep}`))throw new Error('outside fixture');
      }else{res.writeHead(404).end();return}
      const body=await readFile(filename);if(body.length>1024*1024)throw new Error('oversized module');
      res.writeHead(200,{'content-type':filename.endsWith('.html')?'text/html':'text/javascript','cache-control':'no-store','set-cookie':'fixture_owner=1; HttpOnly; SameSite=Strict; Path=/','content-security-policy':"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src blob:; base-uri 'none'; form-action 'none'",'x-content-type-options':'nosniff'});res.end(body);
    }catch{res.writeHead(404).end()}
  });
  await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolveListen)});
  const origin=`http://127.0.0.1:${server.address().port}`,cases=[],errors=[],external=[];
  let browser,timer;
  try{
    const work=async()=>{
      browser=await chromium.launch({executablePath:'/run/current-system/sw/bin/chromium',headless:true,timeout:15000,args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking']});
      const context=await browser.newContext({serviceWorkers:'block'});
      await context.route('**/*',async route=>{if(new URL(route.request().url()).origin!==origin){external.push('external request');await route.abort()}else await route.continue()});
      const open=async()=>{const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);try{await page.waitForFunction(()=>window.fixtureReady)}catch(error){throw new Error(`Browser fixture initialization: ${errors.join('; ')}`,{cause:error})}return page};
      const page=await open();
      assert.equal(await page.evaluate(async()=> (await fetch('/modules/primitives/v8-files/src/host/ledger.js')).status),404);
      assert.equal(await page.evaluate(async()=> (await fetch('/modules/primitives/v8-files/src/transport/http.js')).status),404);
      const initial=await page.evaluate(async()=>{const f=window.fixture,d=await f.save();await f.recordRequest(d.manifest.id);const phase=await f.lost('begin',d.manifest.id);return{id:d.manifest.id,phase}});
      assert.equal(initial.phase,'uncertain');
      await page.reload();await page.waitForFunction(()=>window.fixtureReady);
      const restored=await page.evaluate(()=>window.fixture.reloadState());assert.equal(restored.records[0].id,initial.id);assert.deepEqual(restored.records[0].operationIds,['original-request']);assert.equal(restored.records[0].bytes,4);
      const recovered=await page.evaluate(id=>window.fixture.upload(id),initial.id);assert.equal(recovered.id,initial.id);assert.equal(port.begins.size,1);
      cases.push('actual Chromium hard reload restores IndexedDB Blob, manifest, original request reference and reconciles lost begin using the same ID');
      for(const method of ['write','commit']){
        const result=await page.evaluate(async method=>{const f=window.fixture,d=await f.save();const phase=await f.lost(method,d.manifest.id);f.files.setPinned(f.scope,true);f.select('b');f.files.setConnected(false);const paused=await f.reloadState();f.files.setConnected(true);const artifact=await f.upload(d.manifest.id);f.select('a');return {id:d.manifest.id,artifact:artifact.id,phase,pinned:paused.pinned,records:paused.records}},method);
        assert.equal(result.phase,'uncertain');assert.equal(result.id,result.artifact);assert.equal(result.pinned,true);assert.ok(result.records.some(r=>r.id===result.id));
      }
      cases.push('A/B/A, pin and reconnect retain background transfer identity across lost write and commit replies');
      const second=await open();
      const stale=await page.evaluate(async()=>{const d=await window.fixture.save();return{id:d.manifest.id,revision:d.revision}});
      const conflicts=await Promise.all([page.evaluate(id=>window.fixture.staleEdit(id),stale.id),second.evaluate(id=>window.fixture.staleEdit(id),stale.id)]);
      assert.ok(conflicts.every(c=>c.conflictOf===stale.id));assert.notEqual(conflicts[0].manifest.id,conflicts[1].manifest.id);
      const original=await page.evaluate(id=>window.fixture.persistence.get(window.fixture.scope,id),stale.id);assert.equal(original.revision,1);
      cases.push('two real tabs serialize Web Locks while transactional IndexedDB CAS preserves stale edits as distinct conflict copies');
      const composerFile=await page.evaluate(async()=>{
        const {RetainedComposer}=await import('/modules/primitives/v8-workspace/src/composer.js'),f=window.fixture,draft=await f.save();await f.upload(draft.manifest.id);
        const scope={...f.scope,authority:'catalog',session:'logical'},reference={scope:{...f.scope,session:'logical'},owner:'durable-owner',id:'composer-original',type:'send',generation:1};
        const composer=new RetainedComposer({scope,persistence:f.persistence});await composer.load();composer.edit({text:'retained text',fileIds:[draft.manifest.id]});await composer.flush();await composer.protect(reference,f.scope,[draft.manifest.id]);
        window.composer= composer;window.composerScope=scope;window.composerReference=reference;return{id:draft.manifest.id,reference,scope};
      });
      await second.evaluate(async({scope,reference})=>{const {RetainedComposer}=await import('/modules/primitives/v8-workspace/src/composer.js');window.composer=new RetainedComposer({scope,persistence:window.fixture.persistence});window.composerReference=reference;await window.composer.load();},composerFile);
      const edits=await Promise.all([page.evaluate(async()=>{window.composer.edit({text:'first tab',fileIds:window.composer.getSnapshot().value.fileIds});try{await window.composer.flush();return{state:'saved'}}catch{return{state:'conflict',text:window.composer.getSnapshot().value.text}}}),second.evaluate(async()=>{window.composer.edit({text:'second tab',fileIds:window.composer.getSnapshot().value.fileIds});try{await window.composer.flush();return{state:'saved'}}catch{return{state:'conflict',text:window.composer.getSnapshot().value.text}}})]);
      assert.equal(edits.filter(value=>value.state==='saved').length,1);assert.equal(edits.filter(value=>value.state==='conflict').length,1);assert.ok(edits.find(value=>value.state==='conflict').text.endsWith('tab'));
      await page.evaluate(()=>window.composer.close());await second.evaluate(()=>window.composer.close());
      await page.reload();await page.waitForFunction(()=>window.fixtureReady);
      const composerRestore=await page.evaluate(async({scope,reference,id})=>{
        const {RetainedComposer}=await import('/modules/primitives/v8-workspace/src/composer.js'),f=window.fixture;let restored;
        const composer=new RetainedComposer({scope,persistence:f.persistence,restoreOriginals:refs=>{restored=refs}});await composer.load();
        const captured=composer.capture();composer.edit({text:'away',fileIds:[id]});composer.edit(captured.value);await composer.flush();const consumed=composer.consume(captured);
        let blocked=false;try{const record=await f.persistence.get(f.scope,id);await f.files.clear(f.scope,id,record.revision)}catch(error){blocked=error.code==='BUSY'}
        const isolated=await f.persistence.getComposer({...scope,principal:'another-principal'});
        await composer.settle(reference);await f.files.reload(f.scope);const record=await f.persistence.get(f.scope,id);await f.files.clear(f.scope,id,record.revision);
        const result={text:composer.getSnapshot().value.text,fileIds:composer.getSnapshot().value.fileIds,restored,blocked,consumed,isolated:isolated===undefined,removed:await f.persistence.get(f.scope,id)===undefined};composer.close();return result;
      },composerFile);
      assert.ok(['first tab','second tab'].includes(composerRestore.text));assert.deepEqual(composerRestore.fileIds,[composerFile.id]);assert.deepEqual(composerRestore.restored,[composerFile.reference]);assert.equal(composerRestore.blocked,true);assert.equal(composerRestore.consumed,false);assert.equal(composerRestore.isolated,true);assert.equal(composerRestore.removed,true);
      cases.push('schema2 actual IndexedDB joins composer/original/file protection atomically; two-tab CAS preserves losing edits, reload restores inert refs only, ABA edits survive, and Web Locks/CAS clear only after exact settlement');
      const denial=await page.evaluate(async()=>{
        const {RetainedComposer}=await import('/modules/primitives/v8-workspace/src/composer.js'),{IndexedDbDraftPersistence}=await import('/modules/primitives/v8-files/src/client/persistence.js');
        const persistence=await IndexedDbDraftPersistence.open('v8-composer-denied');Object.defineProperty(persistence.database,'transaction',{value(){throw new DOMException('denied','SecurityError')}});
        const composer=new RetainedComposer({scope:{...window.fixture.scope,authority:'catalog',session:'denied'},persistence});let refused=false;try{await composer.load()}catch{refused=true}
        const state=composer.getSnapshot().state;composer.close();persistence.close();return{refused,state};
      });assert.deepEqual(denial,{refused:true,state:'unavailable'});cases.push('actual browser IndexedDB API denial exposes unavailable storage and never claims an in-memory draft is durable');
      const quota=await page.evaluate(async()=>{
        const {IndexedDbDraftPersistence}=await import('/modules/primitives/v8-files/src/client/persistence.js');
        const f=window.fixture,p=await IndexedDbDraftPersistence.open('v8-files-browser-small',{maxBytes:4,maxRecords:1}),original=await f.persistence.get(f.scope,f.records()[0].manifest.id);
        await p.put({...original,revision:0},0);let rejected=false;
        try{await p.put({...original,key:'different',scope:{...f.scope,session:'b'},revision:0},0)}catch(error){rejected=error.code==='STORAGE_FULL'}
        const retained=await p.list(f.scope);p.close();return{rejected,count:retained.length,bytes:retained[0].blob.size};
      });assert.deepEqual(quota,{rejected:true,count:1,bytes:4});
      cases.push('actual IndexedDB transaction enforces aggregate bytes and record admission across sessions without dropping the existing Blob');
      const copied=await page.evaluate(async()=>{
        const f=window.fixture,original=await f.persistence.get(f.scope,f.records()[0].manifest.id),mutableScope={...f.scope};
        const listing=f.persistence.list(mutableScope);mutableScope.session='b';const listed=await listing;
        const mutableRecord={...original,key:`snapshot-${original.key}`,manifest:{...original.manifest,id:'snapshot-record'},scope:{...f.scope},operationIds:[]};
        const writing=f.persistence.put(mutableRecord,0);mutableRecord.scope.session='b';mutableRecord.manifest.name='mutated.bin';mutableRecord.blob=new Blob(['wrong']);const written=await writing;
        return{listedOriginal:listed.some(r=>r.manifest.id===original.manifest.id),writtenScope:written.scope.session,writtenName:written.manifest.name,expectedName:original.manifest.name,writtenBytes:written.blob.size};
      });assert.equal(copied.listedOriginal,true);assert.equal(copied.writtenScope,'a');assert.equal(copied.writtenName,copied.expectedName);assert.equal(copied.writtenBytes,4);
      const image=await page.evaluate(()=>window.fixture.image());assert.equal(image.converted.provenance.transform,'browser-canvas-png');assert.equal(image.converted.provenance.width,200);assert.equal(image.converted.provenance.height,180);
      const media=await page.evaluate(ref=>window.fixture.delayedAnchor(ref),image.artifact);assert.ok(Math.abs(media.before-media.after)<=1);assert.equal(media.correction,'adjust');assert.equal(media.shared,true);assert.equal(media.rejected,true);assert.equal(media.afterOne,media.beforeRelease);assert.equal(media.afterBoth,media.beforeRelease+1);assert.equal(media.svgRan,false);assert.equal(media.usage.entries,0);
      cases.push('verified SVG stays in image context; canvas conversion carries provenance; delayed actual image geometry preserves the real history anchor');
      cases.push('shared browser image lease revokes its object URL only after final release; expiry blocks new leases without resurrecting cache');
      const binary=await page.evaluate(async ref=>{const lease=await window.fixture.cache.acquire(ref);const result={kind:lease.preview.kind,type:lease.blob.type};lease.release();return result},recovered);assert.deepEqual(binary,{kind:'download',type:'application/octet-stream'});
      cases.push('MIME-spoofed non-image binary remains an inert download resource');
      await page.evaluate(()=>window.fixture.close());await second.evaluate(()=>window.fixture.close());await context.close();
      assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(port.leases.size,0);
      return {passed:true,cases,chromium:browser.version()};
    };
    return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('File browser qualification exceeded 45 seconds')),45000)})]);
  }finally{clearTimeout(timer);try{await browser?.close()}finally{server.closeAllConnections();await new Promise(resolveClose=>server.close(resolveClose))}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)runBrowserQualification().then(result=>process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error=>{process.stderr.write(`${error.stack}\n`);process.exitCode=1});
