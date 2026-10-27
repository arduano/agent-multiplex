import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,realpath} from 'node:fs/promises';
import {dirname,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';

const here=dirname(fileURLToPath(import.meta.url)),build=resolve(here,'../.build');
/** Real Chromium external-store consumer; scripted SessionPort, no React/native/process proof. */
export async function runBrowserQualification(){
  const root=await realpath(build),errors=[],external=[],cases=[];
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://127.0.0.1');let filename;
      if(req.method==='GET'&&url.pathname==='/')filename=resolve(here,'browser-harness.html');
      else if(req.method==='GET'&&/^\/modules\/[a-zA-Z0-9_./-]+\.js$/.test(url.pathname)){
        const modulePath=url.pathname.slice('/modules/'.length);
        if(!/^(?:primitives\/v8-session\/src\/(?:client|contracts)\/|primitives\/v8-history\/src\/(?:client|contracts)\/)[a-zA-Z0-9_./-]+\.js$/.test(modulePath)&&modulePath!=='primitives/v8-session/qualification/client-fixture.js')throw new Error('Node module excluded');
        filename=await realpath(resolve(root,modulePath));const rel=relative(root,filename);if(rel.startsWith(`..${sep}`)||!rel.startsWith(`primitives${sep}`))throw new Error('outside fixture');
      }else{res.writeHead(404).end();return}
      const body=await readFile(filename);if(body.length>1024*1024)throw new Error('oversized module');
      res.writeHead(200,{'content-type':filename.endsWith('.html')?'text/html':'text/javascript','cache-control':'no-store','content-security-policy':"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",'x-content-type-options':'nosniff'});res.end(body);
    }catch{res.writeHead(404).end()}
  });
  await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes)});const origin=`http://127.0.0.1:${server.address().port}`;let browser,timer;
  try{
    const work=async()=>{
      browser=await chromium.launch({executablePath:'/run/current-system/sw/bin/chromium',headless:true,timeout:15000,args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking']});
      const context=await browser.newContext({serviceWorkers:'block'});await context.route('**/*',async route=>{if(new URL(route.request().url()).origin!==origin){external.push('external request');await route.abort()}else await route.continue()});
      const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await page.waitForFunction(()=>window.fixtureReady);
      assert.equal(await page.evaluate(async()=> (await fetch('/modules/primitives/v8-lifecycle-default/src/session/owner.js')).status),404);
      await page.locator('#draft-model').fill('next-local');await page.locator('#pin').click();await page.evaluate(()=>window.fixture.entries.a.history.setDraft('retained history draft'));
      await page.locator('#b').click();await page.evaluate(()=>window.fixture.observe('a','background-selected'));await page.locator('#a').click();
      assert.equal(await page.locator('#draft-model').inputValue(),'next-local');assert.equal(await page.locator('#model').textContent(),'background-selected');
      let state=await page.evaluate(()=>window.fixture.state('a'));assert.equal(state.pinned,true);assert.equal(state.historyDraft,'retained history draft');assert.equal((await page.evaluate(()=>window.fixture.counts())).submitted,0);
      cases.push('actual SessionWorkspace and HistoryWorkspace retain draft, pin and background selection through A/B/A without native lifecycle calls');
      await page.locator('#disconnect').click();assert.equal(await page.locator('#phase').textContent(),'running');assert.equal(await page.locator('#activity').textContent(),'idle');assert.equal(await page.locator('#active').textContent(),'true');assert.equal(await page.locator('#connection').textContent(),'disconnected');
      await page.locator('#connect').click();await page.waitForFunction(()=>window.fixture.state().stale===false);assert.equal((await page.evaluate(()=>window.fixture.counts())).submitted,0);
      cases.push('disconnect preserves Running idle as active; reconnect refreshes observation without create, resume, stop or Send');
      const original=await page.evaluate(()=>window.fixture.beginModel('requested-before'));await page.evaluate(()=>window.fixture.flush());
      await page.locator('#draft-model').fill('newer-draft');await page.evaluate(()=>window.fixture.observe('a','newer-native'));await page.locator('#disconnect').click();await page.evaluate(id=>window.fixture.acknowledge(id),original);
      assert.equal(await page.locator('#model').textContent(),'newer-native');assert.equal(await page.locator('#draft-model').inputValue(),'newer-draft');assert.equal(await page.locator('#receipt').textContent(),'acknowledged');
      await page.locator('#connect').click();await page.waitForFunction(()=>window.fixture.state().stale===false);assert.equal((await page.evaluate(()=>window.fixture.counts())).submitted,1);
      cases.push('older original model acknowledgement cannot overwrite newer native selection or editable draft; known receipt survives disconnect without replay');
      await page.evaluate(()=>window.fixture.startObserved('a'));assert.equal(await page.locator('#phase').textContent(),'starting');assert.equal(await page.locator('#active').textContent(),'true');
      await page.evaluate(()=>window.fixture.stopWillFail());await page.locator('#stop').click();await page.waitForFunction(()=>window.fixture.state().issue==='stopUnconfirmed');
      assert.equal(await page.locator('#phase').textContent(),'stopping');assert.equal(await page.locator('#active').textContent(),'true');assert.equal(await page.locator('#issue').textContent(),'Stop not confirmed');
      await page.locator('#b').click();await page.locator('#a').click();assert.equal(await page.locator('#issue').textContent(),'Stop not confirmed');
      await page.evaluate(()=>window.fixture.finishStop('a'));assert.equal(await page.locator('#phase').textContent(),'stopped');assert.equal(await page.locator('#active').textContent(),'false');assert.equal(await page.locator('#receipt').textContent(),'outcomeUnknown');assert.equal((await page.evaluate(()=>window.fixture.counts())).submitted,2);
      cases.push('Starting and unconfirmed Stopping remain active; one stop issue persists through switching until later scripted Stopped, preserving original unknown receipt');
      const privacy=await page.evaluate(async()=>({local:localStorage.length,databases:(await indexedDB.databases()).length,historyHasAnswer:JSON.stringify(window.fixture.entries.a.history.operations).includes('private-answer')}));assert.deepEqual(privacy,{local:0,databases:0,historyHasAnswer:false});
      await page.evaluate(()=>window.fixture.close());assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await context.close();return{passed:true,cases,chromium:browser.version()};
    };return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Session browser fixture exceeded 45 seconds')),45000)})]);
  }finally{clearTimeout(timer);try{await browser?.close()}finally{server.closeAllConnections();await new Promise(resolveClose=>server.close(resolveClose))}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)runBrowserQualification().then(result=>process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error=>{process.stderr.write(`${error.stack}\n`);process.exitCode=1});
