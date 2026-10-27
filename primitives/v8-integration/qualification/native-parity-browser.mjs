import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/** Real React, retained clients, HTTP, journal and immutable file owner. Only
 * native RPC responses/events are scripted. No model or provider is contacted. */
export async function qualifyNativeParity({browser,startApplication,until,directory,assets}) {
 let app,context,page,failure;
 try {
  app=await startApplication({directory:join(directory,'native-parity'),assets});
  const codex=app.driver('main'),copilot=app.driver('peer');codex.holdWork=true;
  let goal=null;
  codex.action=async(method,input)=>{
   if(method==='turn/steer')return{turnId:input.expectedTurnId};
   if(method==='thread/queue/add')return{queuedSubmission:{id:'native-queued',clientUserMessageId:input.clientUserMessageId,input:input.input}};
   if(method==='thread/goal/get')return{goal};
   if(method==='thread/goal/set'){const{threadId,...patch}=input;goal={threadId,objective:'',status:'active',tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:0,updatedAt:0,...goal,...patch};return{goal};}
   if(method==='thread/goal/clear'){const cleared=goal!==null;goal=null;return{cleared};}
   return{};
  };
  copilot.tasks[0].canCancel=true;
  context=await browser.newContext({viewport:{width:1000,height:900},serviceWorkers:'block'});
  const errors=[],external=[];await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==app.url){external.push('external');return route.abort();}return route.continue();});
  page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(app.url);await page.waitForFunction(()=>window.applicationReady);
  await page.locator('#session-main').click();await page.waitForFunction(()=>document.querySelector('#session-status')?.textContent.includes('codex · running'));
  await page.locator('#message').fill('original work');await page.locator('#send').click();
  await page.waitForFunction(()=>document.querySelector('#latest-action')?.textContent==='Latest send: accepted');
  await page.locator('#native-actions summary').click();
  await page.locator('#message').fill('steer exactly this turn');
  await page.evaluate(()=>window.applicationTest.dropNextReply());await page.locator('#steer-input').click();
  await page.waitForFunction(()=>window.applicationTest.snapshot('main').operations.some(item=>item.type==='codex.steer'&&item.state==='unobserved'));
  const steer=await page.evaluate(()=>window.applicationTest.snapshot('main').operations.find(item=>item.type==='codex.steer').id);
  await page.getByRole('button',{name:'Check original codex.steer',exact:true}).click();
  await page.waitForFunction(id=>window.applicationTest.snapshot('main').operations.find(item=>item.id===id)?.state==='acknowledged',steer);
  assert.equal(codex.requests.filter(item=>item.method==='turn/steer').length,1);assert.equal(codex.counts.sends,1);
  const exact=codex.requests.find(item=>item.method==='turn/steer').params;
  assert.equal(exact.expectedTurnId,'scripted-turn-1');assert.equal(exact.input[0].text,'steer exactly this turn');
  await page.locator('#enqueue-input').click();
  await page.waitForFunction(()=>window.applicationTest.snapshot('main').operations.some(item=>item.type==='codex.queue.add'&&item.state==='acknowledged'));
  const queued=await page.evaluate(()=>window.applicationTest.snapshot('main').operations.find(item=>item.type==='codex.queue.add').id);
  assert.equal(codex.requests.find(item=>item.method==='thread/queue/add').params.clientUserMessageId,queued);assert.equal(codex.counts.sends,1);
  await page.locator('#read-goal').click();await page.waitForFunction(()=>window.applicationTest.snapshot('main').session.nativeReads.some(item=>item.value?.type==='codex.goal'&&item.value.goal===null));
  await page.locator('#message').fill('finish native parity');await page.locator('#set-goal').click();await until(()=>goal?.objective==='finish native parity');
  await page.locator('#read-goal').click();await page.locator('#goal-paused').waitFor();await page.locator('#goal-paused').click();await until(()=>goal?.status==='paused');
  await page.locator('#read-goal').click();await page.waitForFunction(()=>window.applicationTest.snapshot('main').session.nativeReads.some(item=>item.value?.goal?.status==='paused'));
  await page.locator('#compact-context').click();await until(()=>codex.requests.some(item=>item.method==='thread/compact/start'));

  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  const path=join(codex.options.cwd,'native-output.png');await writeFile(path,png);
  const params={threadId:'scripted-codex-native',turnId:'scripted-turn-1',item:{type:'imageView',id:'native-output',path}};
  codex.notify('item/completed',params);
  await page.getByRole('button',{name:'Preview agent image',exact:true}).waitFor();
  await writeFile(path,Buffer.from('changed after immutable capture'));
  codex.notify('item/completed',params);await page.getByRole('button',{name:'Preview agent image',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#file-preview img')?.naturalWidth===1);
  assert.equal(codex.counts.sends,1);assert.equal(codex.counts.bodyReads,0);

  const goalReads=codex.requests.filter(item=>item.method==='thread/goal/get').length;
  await page.locator('#session-peer').click();await page.waitForFunction(()=>document.querySelector('#session-status')?.textContent.includes('copilot · running'));
  await page.locator('#native-actions summary').click();await page.locator('#read-queue').click();await page.locator('#promote-queue-0').waitFor();
  await page.locator('#promote-queue-0').click();await until(()=>copilot.requests.some(item=>item.method==='queue.sendNow'));
  assert.deepEqual(copilot.requests.find(item=>item.method==='queue.sendNow').params,{id:'scripted-queue'});
  await page.locator('#read-queue').click();await page.locator('#promote-queue-0').waitFor();assert.equal(copilot.counts.sends,0,'false atomic promotion must not fall back to Send');
  await page.locator('#read-tasks').click();await page.locator('#promote-task-0').waitFor();
  await page.locator('#promote-task-0').click();await page.locator('#cancel-task-0').click();await page.locator('#read-progress-0').click();
  await page.locator('#read-promotable').click();await page.locator('#promote-current-task').waitFor();
  await page.waitForFunction(()=>window.applicationTest.snapshot('peer').session.nativeReads.filter(item=>item.state==='available').length===4);
  for(const method of['tasks.promoteToBackground','tasks.cancel','tasks.getProgress']){await until(()=>copilot.requests.some(item=>item.method===method));assert.deepEqual(copilot.requests.find(item=>item.method===method).params,{id:'scripted-task'});}
  await page.locator('#message').fill('immediate steer');await page.locator('#steer-input').click();await until(()=>copilot.requests.some(item=>item.method==='session.send'));
  assert.equal(copilot.requests.find(item=>item.method==='session.send').params.mode,'immediate');
  const queueReads=copilot.requests.filter(item=>item.method==='queue.pendingItems').length;
  await page.locator('#session-main').click();await page.waitForFunction(()=>window.applicationTest.snapshot('main').session.nativeReads.some(item=>item.value?.goal?.status==='paused'));
  assert.equal(codex.requests.filter(item=>item.method==='thread/goal/get').length,goalReads);
  await page.locator('#session-peer').click();assert.equal(copilot.requests.filter(item=>item.method==='queue.pendingItems').length,queueReads);
  await page.locator('#disconnect').click();await page.waitForFunction(()=>window.applicationTest.snapshot('peer').session.nativeReads.every(item=>item.stale));
  assert.equal(copilot.requests.filter(item=>item.method==='queue.pendingItems').length,queueReads);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  return [
   'React Codex exact-turn Steer survives a lost reply as one original; explicit queue admission uses that original client ID without another Send; goal reads/status mutations and compaction use their native methods',
   'native disk output streams pending-to-available through the actual Host/file owner and previews immutable original PNG bytes after source replacement and event replay, with zero body-history reads',
   'React Copilot atomic false queue promotion never resends; task/progress/promotable actions retain exact IDs, Steer uses immediate mode, and shared observations survive A/B/A and become stale offline without background reads',
  ];
 }catch(error){failure=error;throw Error(`${error.message}\nNative parity: ${JSON.stringify({body:(await page?.locator('body').innerText({timeout:1000}).catch(()=>'<closed>'))?.slice(-3000),stats:app?.stats(),failures:await page?.evaluate(()=>window.applicationTest?.failures()).catch(()=>[])})}`,{cause:error});}
 finally{const cleanup=[];for(const release of[()=>context?.close(),()=>app?.close()])try{await release();}catch(error){cleanup.push(error);}if(cleanup.length)throw new AggregateError([...(failure?[failure]:[]),...cleanup],'Native parity cleanup failed');}
}
