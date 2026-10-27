import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
import {buildApplicationAssets} from '../application/build.mjs';
import {qualifyPromptMatrix,qualifyControlDrafts} from './prompt-browser.mjs';
import {qualifyNativeParity} from './native-parity-browser.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
async function qualifyOpeningControls({browser,startApplication,deferred,until,directory,assets}){
 let app,context,gate;
 try{
  app=await startApplication({directory:join(directory,'opening-controls'),assets});
  const driver=app.driver('main');gate=deferred();driver.openingGate=gate.promise;
  driver.containment.prepareOpening=async input=>{
   const capsule={opening:{scope:input.scope,generation:input.generation,operationId:input.operationId},identity:{attachment:`scripted-attachment-${input.generation}`,process:'scripted-owned-process',containment:'scripted-owned-container',placement:'dedicated'}};
   let stopping;
   return{...capsule,stop:()=>stopping??=Promise.resolve().then(()=>{driver.counts.stops++;return{...capsule,state:'stopped',scope:'nativeTree',noAutomaticContinuation:true,acquisitionSealed:true};})};
  };
  context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const errors=[],external=[];await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==app.url){external.push('external');return route.abort();}return route.continue();});
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(app.url);await page.waitForFunction(()=>window.applicationReady);
  await page.getByRole('button',{name:'Create Codex conversation',exact:true}).click();
  await until(()=>driver.counts.opens===1);
  await page.waitForFunction(()=>{const button=document.querySelector('#stop-opening-main');return button&&!button.disabled;});
  assert.equal(driver.controller.current(),null);assert.equal(await page.locator('#history').count(),0);
  await page.locator('#stop-opening-main').click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Opening agent controls"]')?.textContent.includes('Agent stopped.'));
  assert.equal(driver.counts.stops,1);assert.equal(driver.counts.sends,0);
  assert.equal((await app.diagnostics())[0].nativeBound,false);
  gate.resolve();await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  assert.equal(driver.controller.current(),null);assert.equal(driver.counts.opens,1);assert.equal(await page.locator('#history').count(),0);
  app.revoke();await page.waitForFunction(()=>document.querySelector('[aria-label="Sessions"]')?.textContent.includes('Workspace closed'));
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 }finally{gate?.resolve();await context?.close();await app?.close();}
 return 'pre-ID hung Create remains visible and stoppable through the actual headless/React/wire/Host path; exact sealed custody stops once, late ID cannot create history or Running, and auth denial disposes opening controls';
}

export async function qualifyRetainedSend({browser,startApplication,directory,assets}){
 let app,context,page,failure;
 try{
  app=await startApplication({directory:join(directory,'retained-send'),assets});
  context=await browser.newContext({serviceWorkers:'block'});page=await context.newPage();page.setDefaultTimeout(30000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(app.url);await page.waitForFunction(()=>window.applicationReady);
  await page.locator('#session-main').click();await page.waitForFunction(()=>document.querySelector('#session-status')?.textContent.includes('codex · running'));
  await page.locator('#session-peer').click();await page.waitForFunction(()=>document.querySelector('#session-status')?.textContent.includes('copilot · running'));
  await page.locator('#session-main').click();
  await page.locator('#file-input').setInputFiles({name:'pixel.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')});
  await page.getByRole('button',{name:'Detach pixel.png',exact:true}).waitFor();
  const hold=()=>page.evaluate(()=>{
   const original=Blob.prototype.arrayBuffer;let first=true;window.sendReadBlocked=false;
   Blob.prototype.arrayBuffer=async function(...args){if(first){first=false;window.sendReadBlocked=true;await new Promise(resolve=>{window.releaseSendRead=resolve;});}return original.apply(this,args);};
  });
  await page.locator('#message').fill('one captured intent');await hold();await page.locator('#send').click();await page.waitForFunction(()=>window.sendReadBlocked);
  await page.locator('#session-peer').click();await page.locator('#session-main').click();
  assert.equal(await page.locator('#send').isDisabled(),true);assert.equal(app.stats()[0].sends,0);
  await page.evaluate(()=>window.releaseSendRead());await page.waitForFunction(()=>document.querySelector('#latest-action')?.textContent==='Latest send: accepted');
  assert.equal(app.stats()[0].sends,1);assert.equal(await page.locator('#message').inputValue(),'');

  await page.getByRole('button',{name:'Attach pixel.png',exact:true}).click();await page.locator('#message').fill('old run intent retained');await hold();await page.locator('#send').click();await page.waitForFunction(()=>window.sendReadBlocked);
  await page.locator('#stop').click();await page.waitForFunction(()=>document.querySelector('#session-status')?.textContent.includes('codex · stopped'));
  await page.locator('#resume').click();await page.waitForFunction(()=>{const value=window.applicationTest.snapshot('main');return value.session.native.generation===2&&value.session.native.phase==='running'&&!value.session.requiresRebind&&!value.bindingTransition;});
  assert.equal(app.stats()[0].sends,1);await page.evaluate(()=>window.releaseSendRead());
  await page.waitForFunction(()=>window.applicationTest.snapshot('main').sendPreparation.state==='failed');
  assert.equal(app.stats()[0].sends,1);assert.equal(await page.locator('#message').inputValue(),'old run intent retained');
  assert.deepEqual(errors,[]);
  return ['held attachment preparation survives actual React A/B/A as one retained job and dispatches once','Stop fences a held local preparation before quiet Resume; releasing old I/O cannot send into the new generation and retains the draft'];
 }catch(error){
  const diagnostic={body:await page?.locator('body').innerText({timeout:1000}).catch(()=>'<closed>'),failures:await page?.evaluate(()=>window.applicationTest?.failures()).catch(()=>[]),stats:app?.stats()};
  failure=Error(`${error.message}\nRetained Send fixture: ${JSON.stringify(diagnostic)}`,{cause:error});throw failure;
 }finally{
  await page?.evaluate(()=>window.releaseSendRead?.()).catch(()=>{});const cleanup=[];
  for(const release of[()=>context?.close(),()=>app?.close()])try{await release();}catch(error){cleanup.push(error);}
  if(cleanup.length)throw new AggregateError([...(failure?[failure]:[]),...cleanup],'Retained Send qualification cleanup failed');
 }
}
/** Actual React + HTTP + SQLite + binary files. Only native controllers are
 * scripted; physical native Stop/SDK acceptance is not claimed by this trace. */
export async function runBrowserQualification({buildRoot=resolve(root,'.build')}={}){
 const [{startApplication},{deferred,until}]=await Promise.all([
  import(pathToFileURL(resolve(buildRoot,'primitives/v8-integration/application/server.js')).href),
  import(pathToFileURL(resolve(buildRoot,'primitives/v8-host/qualification/fixture.js')).href),
 ]);
 const directory=await mkdtemp(join(tmpdir(),'v8-application-')),cases=[],errors=[],external=[],activeObserverStreams=new Set(),logicalFeeds=new Map(),receiptLookups=[];let observerOpens=0,logicalSubscriptions=0,creationReads=0,currentChannel,reconnectedFeeds;
 const feedKeys=channel=>[...logicalFeeds.values()].filter(feed=>feed.channel===channel).map(({request:{op,target,scope,run}})=>JSON.stringify({op,target,scope,run})).sort();
 let app,browser,context,page,gate,startup,resuming,releaseReceipt,confirmationGate,timer,failure;
 try{
  const assets=await buildApplicationAssets();app=await startApplication({directory,assets});
  assert.ok(app.stats().every(value=>value.opens===0&&value.sends===0&&value.bodyReads===0));
  browser=await chromium.launch({executablePath:'/run/current-system/sw/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking']});
  context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==app.url){external.push('external');return route.abort();}return route.continue();});
  page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{try{const body=request.postDataJSON();if(body?.op==='watch.open'){observerOpens++;activeObserverStreams.add(request);}if(body?.op==='watch.subscribe'){logicalSubscriptions++;currentChannel=body.channel;logicalFeeds.set(`${body.channel}/${body.id}`,{channel:body.channel,request:body.request});}if(body?.op==='watch.unsubscribe')logicalFeeds.delete(`${body.channel}/${body.id}`);if(body?.op==='catalog.creation')creationReads++;if(body?.op==='receipt')receiptLookups.push(body.id);}catch{}});
  page.on('requestfinished',request=>activeObserverStreams.delete(request));page.on('requestfailed',request=>activeObserverStreams.delete(request));
  const work=async()=>{
   cases.push(...await qualifyNativeParity({browser,startApplication,until,directory,assets}));
   cases.push(await qualifyOpeningControls({browser,startApplication,deferred,until,directory,assets}));
   cases.push(...await qualifyRetainedSend({browser,startApplication,directory,assets}));
   await page.goto(app.url);await page.waitForFunction(()=>window.applicationReady);
   startup=deferred();app.driver('main').containment.certificateGate=startup.promise;
   await page.getByRole('button',{name:'Create Codex conversation',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('#session-status')?.textContent.includes('codex · starting · connected'));
   assert.equal(app.stats()[0].opens,1);assert.equal(app.stats()[0].sends,0);assert.equal(await page.locator('#send').isDisabled(),true);
   const startupAnswer=app.driver('main').requestForm();await page.locator('#confirmation').click();await page.getByLabel('confirmed',{exact:true}).selectOption('true');await page.locator('#confirm-request').click();await startupAnswer;
   assert.equal(app.stats()[0].replies,1);assert.equal(app.stats()[0].sends,0);
   startup.resolve();app.driver('main').containment.certificateGate=undefined;
   await page.waitForFunction(()=>document.querySelector('#session-status')?.textContent.includes('codex · running · connected'));
   assert.equal(app.stats()[0].opens,1);assert.equal(app.stats()[0].discovery,0);
   cases.push('known native identity opens the actual React Starting view before Create acknowledgement; initialization confirmation answers once while Send stays unavailable, then Running needs no continuation');
   const text='first message\n'+Array.from({length:18},(_,i)=>'retained line '+i).join('\n');
   await page.locator('#message').fill(text);await page.evaluate(()=>window.applicationTest.dropNextReply());await page.locator('#send').click();
   await page.waitForFunction(()=>document.querySelector('#latest-action')?.textContent.includes('unobserved'));assert.equal(app.stats()[0].sends,1);
   assert.equal(await page.locator('#message').inputValue(),'');assert.equal(await page.locator('#send').isDisabled(),true);
   await page.locator('#message').fill('new intentional send');await page.locator('#send').click();
   await page.waitForFunction(()=>document.querySelector('#latest-action')?.textContent==='Latest send: accepted');
   await page.getByRole('button',{name:'Check original send',exact:true}).click();await page.getByRole('button',{name:'Check original send',exact:true}).waitFor({state:'detached'});
   assert.match(await page.locator('#history').textContent(),/Scripted response: first message/);assert.match(await page.locator('#history').textContent(),/scripted terminal output/);
   assert.equal(await page.getByRole('alert').count(),0);assert.equal(app.stats()[0].sends,2);cases.push('actual application original Create/Send, draft consumption, text/tool/terminal, and older lost-reply receipt remains actionable after a new intentional Send without replay');

   await page.locator('#file-input').setInputFiles({name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('immutable local preview bytes')});
   await page.waitForFunction(()=>document.querySelector('.files')?.textContent.includes('notes.txt · committed'));
   await page.getByRole('button',{name:'Preview',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#file-preview')?.textContent==='immutable local preview bytes');
   await page.getByRole('button',{name:'Detach notes.txt',exact:true}).click();
   cases.push('actual retained file upload through authenticated wire, worker ledger and immutable ResourceCache preview');

   app.driver('main').holdWork=true;await page.locator('#message').fill('background');await page.locator('#send').click();
   await page.waitForFunction(()=>document.querySelector('#history')?.textContent.includes('Scripted response: background'));
   await page.locator('#message').fill('draft kept across switch');await page.locator('#pin').click();
   await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
   await page.locator('#history').evaluate(element=>{element.scrollTop=80;element.dispatchEvent(new Event('scroll'));});
   const anchor=await page.evaluate(()=>window.applicationTest.snapshot('main').history.viewport.anchor);
   assert.ok(anchor);
   await page.getByRole('button',{name:'Create Copilot conversation',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('#session-status')?.textContent.includes('copilot · running'));
   // Running is a native fact; observer registration completes independently.
   // Wait for the measured wire handoff rather than assuming render is its ACK.
   await until(()=>logicalSubscriptions>=9&&activeObserverStreams.size===1);
   assert.equal(activeObserverStreams.size,1);assert.ok(logicalSubscriptions>=9);assert.equal(creationReads,0);
   app.driver('main').emitText(' captured while pinned in background');app.driver('main').complete();
   await page.getByRole('button',{name:'Conversation A',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('#history')?.textContent.includes('captured while pinned in background'));
   assert.equal(await page.locator('#message').inputValue(),'draft kept across switch');assert.equal(await page.locator('#pin').getAttribute('aria-pressed'),'true');
   assert.equal((await page.evaluate(()=>window.applicationTest.snapshot('main').history.viewport.anchor)).rowId,anchor.rowId);
   assert.ok(await page.locator('#history').evaluate(element=>element.scrollTop>0));cases.push('A/B/A preserves typed session state, draft, logical scroll anchor, files and pinned background capture; at least nine logical observers share one HTTP/1.1 stream without bootstrap starvation');
   cases.push(await qualifyPromptMatrix({app,page,deferred,until}));
   cases.push(await qualifyControlDrafts({app,page}));

   app.driver('main').holdWork=true;await page.locator('#message').fill('automatic reconnect stream');await page.locator('#send').click();
   await page.waitForFunction(()=>document.querySelector('#history')?.textContent.includes('Scripted response: automatic reconnect stream'));
   await page.locator('#message').fill('retained during automatic reconnect');
   const beforeDrop=app.stats(), opensBeforeDrop=observerOpens, channelBeforeDrop=currentChannel, feedsBeforeDrop=feedKeys(currentChannel);
   assert.ok(feedsBeforeDrop.length>0);
   const freshnessBeforeDrop=await page.evaluate(()=>{const s=window.applicationTest.snapshot('main');return {confirmations:s.confirmationsStale,mcp:s.mcpStale};});
   app.interruptObservation();app.driver('main').emitText(' automatically recovered suffix');app.driver('main').complete();
   await page.waitForFunction(()=>document.querySelector('#history')?.textContent.includes('automatically recovered suffix'));
   // Navigation may release an unpinned idle history feed. Recover exactly the
   // retained descriptors, rather than the cumulative startup registration count.
   await until(()=>observerOpens===opensBeforeDrop+1&&activeObserverStreams.size===1&&currentChannel!==channelBeforeDrop&&JSON.stringify(feedKeys(currentChannel))===JSON.stringify(feedsBeforeDrop));
   assert.deepEqual(feedKeys(currentChannel),feedsBeforeDrop);reconnectedFeeds=feedsBeforeDrop.length;
   await page.waitForFunction(before=>{const s=window.applicationTest.snapshot('main');return s.observation.session==='live'&&s.observation.history==='live'&&!s.session.stale&&s.confirmationsStale===before.confirmations&&s.mcpStale===before.mcp;},freshnessBeforeDrop);
   assert.equal(await page.locator('#message').inputValue(),'retained during automatic reconnect');assert.equal(await page.locator('#pin').getAttribute('aria-pressed'),'true');
   assert.deepEqual(app.stats(),beforeDrop);cases.push('spontaneous physical HTTP drop restores the retained React session and pinned stream automatically through one new mux; draft and all domain facts converge without native effects, body reads or discovery');

   await page.locator('#message').fill('offline stream');await page.locator('#send').click();
   await page.waitForFunction(()=>document.querySelector('#history')?.textContent.includes('Scripted response: offline stream'));
   await page.locator('#disconnect').click();await page.waitForFunction(()=>document.querySelector('#session-status')?.textContent.includes('offline'));
   app.driver('main').emitText(' offline captured suffix');app.driver('main').complete();
   await page.locator('#reconnect').click();await page.waitForFunction(()=>document.querySelector('#history')?.textContent.includes('offline captured suffix'));
   assert.ok(app.stats().every(value=>value.bodyReads===0&&value.discovery===0));cases.push('unstable UI reconnect uses Host capture/replay with zero native history reads, no MCP discovery and no native lifecycle change');

   await page.locator('#message').fill('please confirm');await page.locator('#send').click();await page.locator('#confirmation').waitFor();
   await page.locator('#confirmation').click();await page.getByRole('button',{name:'Later',exact:true}).click();assert.equal(app.stats()[0].replies,1);
   await page.getByRole('button',{name:'Conversation B',exact:true}).click();await page.getByRole('button',{name:'Conversation A',exact:true}).click();
   await page.locator('#confirmation').click();await page.getByLabel('confirmed',{exact:true}).selectOption('true');await page.locator('#confirm-request').click();
   await page.waitForFunction(()=>document.querySelector('#history')?.textContent.includes('Tool confirmation returned.'));
   assert.equal(app.stats()[0].replies,2);assert.equal(await page.getByRole('dialog').count(),0);cases.push('concrete Codex scripted reverse request travels through Host original receipt, all-domain wire, headless hook and actual React confirmation exactly once');

   const retired=deferred(),replacement=deferred(),responseReceived=deferred();confirmationGate=deferred();let retiredAnswers=0,replacementAnswer;
   const nativeId=app.driver('main').controller.current().run.nativeSession;
   const callback=(id,message,settled,respond)=>app.driver('main').reverse({id,method:'mcpServer/elicitation/request',token:{},params:{threadId:nativeId,serverName:'scripted-fixture',mode:'form',message,requestedSchema:{type:'object',properties:{confirmed:{type:'boolean'}},required:['confirmed']}},settled:settled.promise,respond});
   callback('scripted-retired-popup','Original popup',retired,async()=>{retiredAnswers++;return{kind:'ack',success:true};});
   await page.waitForFunction(()=>window.applicationTest.snapshot('main').confirmations.items.some(item=>item.prompt.nativeRequestId==='"scripted-retired-popup"'));
   await page.locator('#confirmation').click();await page.getByRole('dialog').waitFor();
   callback('scripted-next-popup','Next popup',replacement,async value=>{replacementAnswer=value;responseReceived.resolve();await confirmationGate.promise;replacement.resolve();return{kind:'ack',success:true};});
   retired.resolve();await page.waitForFunction(()=>{const items=window.applicationTest.snapshot('main').confirmations.items;return items.length===1&&items[0].prompt.nativeRequestId==='"scripted-next-popup"';});
   await page.getByRole('dialog').waitFor({state:'detached'});assert.equal(retiredAnswers,0);assert.equal(replacementAnswer,undefined);
   await page.locator('#confirmation').click();await page.getByRole('button',{name:'Cancel request',exact:true}).click();
   await responseReceived.promise;assert.equal(replacementAnswer.action,'cancel');assert.equal(retiredAnswers,0);
   await page.locator('summary').filter({hasText:'Tools'}).click();
   const next=deferred();let nextAnswer;
   callback('scripted-overlap-popup','Overlapping popup',next,async value=>{nextAnswer=value;next.resolve();return{kind:'ack',success:true};});
   await page.waitForFunction(()=>window.applicationTest.snapshot('main').confirmations.items.some(item=>item.prompt.nativeRequestId==='"scripted-overlap-popup"'&&item.state==='pending'));
   await page.locator('#confirmation').click();await page.getByRole('dialog').waitFor();
   confirmationGate.resolve();await replacement.promise;
   await page.waitForFunction(()=>window.applicationTest.snapshot('main').operations.filter(value=>value.type==='answer').at(-1)?.state==='acknowledged');
   await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
   assert.equal(await page.getByRole('dialog').count(),1);assert.equal(nextAnswer,undefined);
   await page.getByRole('button',{name:'Cancel request',exact:true}).click();await next.promise;assert.equal(nextAnswer.action,'cancel');
   await page.getByRole('dialog').waitFor({state:'detached'});
   assert.equal(await page.locator('summary').filter({hasText:'Tools'}).evaluate(element=>element.parentElement.open),true);
   cases.push('an open confirmation keeps its exact capability; external settlement cannot substitute another prompt, late answer completion cannot dismiss a newer dialog, Cancel preserves native semantics, and receipt retirement retains the open Tools panel');

   await page.locator('#refresh-mcp').click();await page.waitForFunction(()=>document.querySelector('#mcp-status')?.textContent.includes('1 configured servers'));
   assert.equal(app.stats()[0].discovery,1);cases.push('MCP discovery crosses authenticated route only after explicit user refresh');
   await page.locator('#message').fill('long work');await page.locator('#send').click();await page.waitForFunction(()=>document.querySelector('#history')?.textContent.includes('Scripted response: long work'));
   gate=deferred();app.driver('main').containment.stopGate=gate.promise;await page.locator('#stop').click();
   await page.waitForFunction(()=>document.querySelector('#session-status')?.textContent.includes('stopping'));assert.equal(await page.locator('#resume').isDisabled(),true);
   gate.resolve(app.driver('main').containment.proof());await page.waitForFunction(()=>document.querySelector('#session-status')?.textContent.includes('stopped'));
   app.driver('main').containment.stopGate=undefined;
   const sends=app.stats()[0].sends;resuming=deferred();app.driver('main').containment.certificateGate=resuming.promise;
   await page.locator('#resume').click();await page.waitForFunction(()=>window.applicationTest.snapshot('main').operations.some(value=>value.type==='resume'&&value.state==='outcomeUnknown'));
   const resumeId=await page.evaluate(()=>window.applicationTest.snapshot('main').operations.find(value=>value.type==='resume').id),resumeAcknowledged=deferred();
   // Backend notification is only a deterministic test barrier. The user
   // still checks this original through the real authenticated HTTP route.
   releaseReceipt=app.subscribeReceipt('main',resumeId,receipt=>{if(receipt.state==='acknowledged')resumeAcknowledged.resolve();});
   resuming.resolve();app.driver('main').containment.certificateGate=undefined;
   await page.waitForFunction(()=>{const value=window.applicationTest.snapshot('main');return document.querySelector('#session-status')?.textContent.includes('running')&&value.session.native.generation===2&&!value.session.requiresRebind&&value.mcp?.run.generation===2;});
   assert.equal(await page.getByRole('button',{name:'Check original resume',exact:true}).count(),1);
   await resumeAcknowledged.promise;releaseReceipt();releaseReceipt=undefined;
   await page.getByRole('button',{name:'Check original resume',exact:true}).click();await page.getByRole('button',{name:'Check original resume',exact:true}).waitFor({state:'detached'});
   assert.equal(app.stats()[0].resumes,1);assert.equal(app.stats()[0].sends,sends);assert.equal(app.stats()[0].bodyReads,0);assert.equal(app.stats()[0].discovery,1);assert.equal(await page.locator('#pin').getAttribute('aria-pressed'),'true');cases.push('scripted halt keeps Stopping visible until proof; one explicit Resume opens and waits, read-only view attachment follows observed Running despite its original receipt timeout, and exact check never repeats Resume or Send');

   const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="12"><rect width="16" height="12" fill="blue"/></svg>');
   await page.locator('#file-input').setInputFiles({name:'chosen.svg',mimeType:'image/svg+xml',buffer:svg});await page.getByRole('button',{name:'Detach chosen.png',exact:true}).waitFor();
   await page.locator('#message').fill('image original before reload');await page.evaluate(()=>window.applicationTest.dropNextReply());await page.locator('#send').click();
   await page.waitForFunction(()=>document.querySelector('#latest-action')?.textContent.includes('unobserved'));
   const restoredSendId=await page.evaluate(()=>window.applicationTest.snapshot('main').operations.filter(value=>value.type==='send').at(-1).id);
   const nativeSend=app.driver('main').requests.filter(value=>value.method==='turn/start').at(-1);assert.ok(nativeSend.params.input.some(value=>value.type==='image'&&value.url.startsWith('data:image/png;base64,')));
   await page.locator('#file-input').setInputFiles({name:'keep.svg',mimeType:'image/svg+xml',buffer:svg});await page.getByRole('button',{name:'Detach keep.png',exact:true}).waitFor();
   await page.locator('#message').fill('draft restored after reload');await page.waitForFunction(()=>document.querySelector('#composer-storage')?.textContent==='Draft saved');
   const beforeReload=app.stats().map(value=>({opens:value.opens,resumes:value.resumes,sends:value.sends,bodyReads:value.bodyReads})),lookupsBeforeReload=receiptLookups.length;
   await page.reload();await page.waitForFunction(()=>window.applicationReady&&document.querySelector('#message')?.value==='draft restored after reload');
   await page.getByRole('button',{name:'Detach keep.png',exact:true}).waitFor();assert.deepEqual(app.stats().map(value=>({opens:value.opens,resumes:value.resumes,sends:value.sends,bodyReads:value.bodyReads})),beforeReload);
   // Subscription admission now checks restored originals automatically. The
   // inert stored reference must resolve by its exact ID, with no native effect.
   await page.waitForFunction(id=>window.applicationTest.snapshot('main').operations.some(value=>value.id===id&&value.type==='send'&&value.state==='acknowledged'),restoredSendId);
   assert.ok(receiptLookups.slice(lookupsBeforeReload).includes(restoredSendId));assert.equal(await page.getByRole('button',{name:'Check original send',exact:true}).count(),0);
   assert.deepEqual(app.stats().map(value=>({opens:value.opens,resumes:value.resumes,sends:value.sends,bodyReads:value.bodyReads})),beforeReload);
   cases.push('actual React composer converts selected SVG to PNG before one native Send; hard reload restores text/selected file IDs and the inert original, whose exact automatic receipt lookup performs no Create/Send/Resume or history read');

   const deniedContext=await browser.newContext({serviceWorkers:'block'});
   try{
    await deniedContext.addInitScript(()=>{Object.defineProperty(IDBFactory.prototype,'open',{value(){throw new DOMException('Browser storage denied','SecurityError')}})});
    const denied=await deniedContext.newPage();denied.setDefaultTimeout(10000);denied.on('pageerror',error=>errors.push(error.message));await denied.goto(app.url);
    await denied.waitForFunction(()=>document.querySelector('#composer-storage')?.textContent.includes('unavailable'));
    assert.equal(await denied.locator('#send').isDisabled(),true);assert.equal(await denied.locator('#stop').isDisabled(),false);
    await denied.locator('#stop').click();await denied.waitForFunction(()=>document.querySelector('#session-status')?.textContent.includes('stopped'));
   }finally{await deniedContext.close()}
   cases.push('browser storage denial is visible and disables Send while existing authenticated observation and strong Stop remain usable');

   await page.getByRole('button',{name:'Conversation B',exact:true}).click();
   const privateConfig=app.driver('peer').requests.find(value=>value.method==='session.create').params;
   void privateConfig.onUserInputRequest({question:'Unfinished private input',allowFreeform:true},{sessionId:app.driver('peer').controller.current().run.nativeSession});
   await page.locator('#confirmation').click();await page.getByLabel('Your answer',{exact:true}).fill('unfinished-private-auth-value');
   app.revoke();await page.waitForFunction(()=>window.applicationTest.snapshot('main').kind==='disposed');
   assert.equal(await page.locator('#history').count(),0);assert.equal(await page.locator('#file-preview').count(),0);
   assert.equal(await page.getByRole('dialog').count(),0);
   assert.deepEqual(errors,[]);assert.deepEqual(external,[]);cases.push('explicit authenticated namespace denial disposes mounted React views, private previews and all domain observers');
   await page.evaluate(()=>window.applicationTest.close());
   return{passed:true,cases,chromium:browser.version(),observerOpens,logicalSubscriptions,reconnectedFeeds,nativeAgentCalls:0,modelCalls:0,scope:'actual local application with scripted concrete native transports; working-agent physical Stop and production sign-in remain unqualified'};
  };
  return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Application browser qualification exceeded180seconds')),180000);})]);
 }catch(error){
  const body=await page?.locator('body').innerText({timeout:1000}).catch(()=>'<closed>');
  const failures=await page?.evaluate(()=>window.applicationTest?.failures()).catch(()=>[]);
  const hosts=await app?.diagnostics();
  const originals=await page?.evaluate(()=>window.applicationTest?.snapshot('main')?.operations?.slice(-3).map(({id,type,state})=>({id,type,state}))).catch(()=>[]);
  const receipts=await Promise.all((originals??[]).map(async original=>{const value=await app?.receipt('main',original.id);return{type:original.type,client:original.state,host:value?.state,reason:value?.reason,outcome:value?.outcome?.status};}));
  failure=Error(`${error.message}\nScripted application diagnostic: ${JSON.stringify({body,errors,failures,hosts,receipts,stats:app?.stats(),observerOpens,logicalSubscriptions,activeObserverStreams:activeObserverStreams.size,currentFeeds:feedKeys(currentChannel),cases})}`,{cause:error});throw failure;
 }finally{
  clearTimeout(timer);releaseReceipt?.();startup?.resolve();resuming?.resolve();confirmationGate?.resolve();gate?.resolve(app?.driver('main').containment.proof());
  const cleanup=[];
  for(const release of[()=>context?.close(),()=>browser?.close(),()=>app?.close(),()=>rm(directory,{recursive:true,force:true})])try{await release();}catch(error){cleanup.push(error);}
  if(cleanup.length)throw new AggregateError([...(failure?[failure]:[]),...cleanup],'Application qualification cleanup failed');
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)runBrowserQualification().then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
