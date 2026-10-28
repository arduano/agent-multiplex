import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

/** The full transcript journey and focused callout gate share these assertions. */
export async function qualifyCaptureCallouts(page, chat, cases, out) {
  const history=chat.locator('[data-action=history]'),loader=chat.locator('[data-action=working-indicator]'),facts=[];
  const frames=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(done)))));
  await page.locator('#session-a').click();await frames();
  const before=await page.evaluate(()=>window.chatFixture.counts());
  try{
    const live=await page.evaluate(()=>window.chatFixture.progress('working'));await frames();
    assert.equal(await loader.count(),1);assert.equal(await history.locator(`[data-row="${live}"] [data-action=partial-content]`).count(),0);
    const excerpt=await page.evaluate(()=>window.chatFixture.progress('working',['prefix','interior','final','truncated']));await frames();
    const loss=history.locator(`[data-row="${excerpt}"] [data-action=partial-content]`);
    assert.equal(await loader.count(),1);await loss.locator('summary').click();
    await loss.getByText('Beginning not captured. Some content not captured. Content truncated.',{exact:true}).waitFor();
    for(const mode of ['idle','stopped','disconnected','gap']){
      const id=await page.evaluate(mode=>window.chatFixture.progress(mode),mode);await frames();
      assert.equal(await loader.count(),0,mode);const retained=history.locator(`[data-row="${id}"] [data-action=partial-content]`);
      assert.equal(await retained.count(),1,mode);await retained.locator('summary').click();await retained.getByText('Final content not captured.',{exact:true}).waitFor();
    }
    cases.push('Only positively current work has a loader; message excerpts retain exact capture gaps');
    const active=await page.evaluate(()=>window.chatFixture.compaction('working'));await frames();
    const activeRow=history.locator(`[data-row="${active}"]`);
    await activeRow.getByText('Compacting context…',{exact:true}).waitFor();
    assert.equal(await chat.locator('.mpx-chat__working').count(),1,'The compaction row replaces the generic working spinner');
    assert.equal(await loader.count(),0);assert.equal(await activeRow.locator('[data-action=partial-content],.mpx-chat__speaker').count(),0);
    await activeRow.scrollIntoViewIfNeeded();await page.screenshot({path:resolve(out,'compacting-context.png')});
    await page.locator('#session-b').click();await page.locator('#session-a').click();await frames();
    assert.equal(await activeRow.locator('.mpx-chat__working').count(),1);
    for(const [mode,label] of [['completed','Context compacted'],['unconfirmed','Compaction status unavailable'],['disconnected','Last observed: compacting context'],['foreign-turn','Last observed: compacting context'],['failed','Context compaction failed'],['interrupted','Context compaction interrupted']]){
      const id=await page.evaluate(mode=>window.chatFixture.compaction(mode),mode);await frames();
      const row=history.locator(`[data-row="${id}"]`);await row.getByText(label,{exact:true}).waitFor();
      assert.equal(await row.locator('.mpx-chat__working,[data-action=partial-content]').count(),0,mode);
      assert.equal(await row.locator('.mpx-chat__muted,.mpx-chat__speaker').count(),0,mode);
      const captured=await page.evaluate(id=>window.chatFixture.snapshot('a').history.rows.find(row=>row.id===id),id);
      facts.push({mode,lifecycle:captured.lifecycle,body:captured.body,native:captured.native,label});
      if(mode==='unconfirmed'){assert.equal(captured.native.compactionCompleted,undefined);assert.equal(captured.body.kind,'partial');}
    }
    cases.push('Compaction needs exact active-turn proof for a spinner and positive item completion for success');
    assert.equal(await loss.locator('summary').innerText(),'Message excerpt');
    for(const empty of [false,true]){
      const id=await page.evaluate(empty=>window.chatFixture.partialTool(empty),empty);await frames();
      const row=history.locator(`[data-row="${id}"]`);await row.locator('details').first().locator('summary').first().click();
      const detail=row.locator('[data-action=partial-content]');assert.equal(await detail.count(),1);
      const label=empty?'Tool output not captured':'Partial output';assert.equal(await detail.locator('summary').innerText(),label);
      assert.equal(await row.locator('pre').count(),empty?0:1,'Empty output has no empty terminal region');
      await detail.locator('summary').click();await detail.getByText(empty?'Beginning not captured. Final content not captured.':'Content truncated.',{exact:true}).waitFor();
      if(!empty)assert.equal(await row.locator('pre').innerText(),'Positively retained tool output');
      assert.equal(await row.getByText(label,{exact:true}).count(),1);
    }
    cases.push('Tool excerpts keep their bytes and loss details without empty terminal blocks or duplicate warnings');
    assert.equal(await chat.getByText('Incomplete content',{exact:true}).count(),0);
    await page.setViewportSize({width:390,height:844});await frames();await page.screenshot({path:resolve(out,'capture-callouts-mobile.png')});
    assert.equal(await chat.evaluate(element=>element.scrollWidth>element.clientWidth+1),false);
    const after=await page.evaluate(()=>window.chatFixture.counts());
    assert.equal(after.submitted,before.submitted);assert.equal(after.older,before.older);
    await writeFile(resolve(out,'callout-facts.json'),JSON.stringify({facts,before,after,nativeModelCalls:0},null,2)+'\n');
    return{facts,submitted:after.submitted-before.submitted,olderReads:after.older-before.older};
  }finally{await page.evaluate(()=>window.chatFixture.progress('idle'));await frames();}
}

/** Actual Transcript + retained workspace; no replacement viewport implementation. */
export async function qualifyTranscriptScrolling(page, chat, cases, out) {
  const history=chat.locator('[data-action=history]'),facts=[],failures=[];
  const frames=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(done)))));
  const geometry=()=>history.evaluate(container=>{
    const state=window.chatFixture.scrollState(),anchor=state?.anchor;
    const row=anchor?[...container.querySelectorAll('[data-row]')].find(row=>row.dataset.row===anchor.rowId):null;
    return{intent:state?.intent,anchor,top:row?row.getBoundingClientRect().top-container.getBoundingClientRect().top:null,scrollTop:container.scrollTop,maximum:container.scrollHeight-container.clientHeight};
  });
  const check=async(name,work)=>{try{await work();facts.push({name,passed:true});cases.push(name);}catch(error){const state=await geometry();facts.push({name,passed:false,error:String(error),state});failures.push(name);}};
  // Settle each view's automatic metadata lookup before measuring viewport-only
  // actions; these lookups are independently owned and not body reads.
  await page.locator('#session-b').click();await frames();await page.locator('#session-a').click();await frames();
  await page.evaluate(()=>{window.chatFixture.history(60,true);window.chatFixture.scrollReset();});await frames();
  const before=await page.evaluate(()=>window.chatFixture.counts());
  await check('Actual upward wheel wins a streamed update before its default scroll',async()=>{
    await history.hover();await page.evaluate(()=>window.chatFixture.armWheelGrowth());await page.mouse.wheel(0,-240);
    await page.waitForFunction(()=>window.chatFixture.wheelGrowths()===1);await frames();
    const state=await geometry();facts.push({wheel:state});
    assert.equal(state.intent,'readingHistory');assert.ok(state.scrollTop<state.maximum-50,JSON.stringify(state));
    const anchor=state.anchor;await frames();assert.deepEqual((await geometry()).anchor,anchor);
  });
  await check('Control Home reaches the real top through row resizing',async()=>{
    await history.focus();await page.keyboard.press('Control+Home');
    await page.waitForFunction(()=>document.querySelector('#chat-container [data-action=history]').scrollTop<1,undefined,{timeout:5000});await frames();
    const state=await geometry();facts.push({home:state});assert.ok(state.scrollTop<1,JSON.stringify(state));assert.equal(state.intent,'readingHistory');
  });
  await check('Prepend and empty terminal page preserve one retained visible row',async()=>{
    // B has never needed to scroll. The explicit read must establish its first
    // anchor from real DOM geometry, without readAt() or a synthetic scroll.
    await page.locator('#session-b').click();await frames();
    const first=await history.evaluate(container=>{const row=container.querySelector('[data-row]');return{id:row.dataset.row,offset:row.getBoundingClientRect().top-container.getBoundingClientRect().top,maximum:container.scrollHeight-container.clientHeight};});
    assert.equal(first.maximum,0);assert.equal(await page.evaluate(()=>window.chatFixture.snapshot('b').history.viewport.intent),'followingLive');
    assert.equal(await page.evaluate(()=>window.chatFixture.snapshot('b').history.viewport.anchor),null);
    const shortPrior=await page.evaluate(()=>window.chatFixture.counts().older);
    await page.evaluate(()=>window.chatFixture.holdOlder());await history.getByRole('button',{name:'Load earlier history',exact:true}).click();
    await page.waitForFunction(prior=>window.chatFixture.counts().older===prior+1,shortPrior);
    const held=await page.evaluate(()=>window.chatFixture.snapshot('b').history.viewport);
    await page.evaluate(()=>window.chatFixture.releaseOlder(false,32));await page.waitForFunction(()=>!window.chatFixture.snapshot('b').history.viewport.loadingOlder);await frames();
    const loaded=await history.evaluate((container,id)=>{const row=[...container.querySelectorAll('[data-row]')].find(row=>row.dataset.row===id);return{offset:row.getBoundingClientRect().top-container.getBoundingClientRect().top,height:container.clientHeight,maximum:container.scrollHeight-container.clientHeight,scrollTop:container.scrollTop,rows:container.querySelectorAll('[data-row]').length};},first.id);
    await history.hover();await page.mouse.wheel(0,-300);
    await page.waitForFunction(top=>document.querySelector('#chat-container [data-action=history]').scrollTop<top-100,loaded.scrollTop);await frames();
    const reached=await history.evaluate(container=>{const top=container.getBoundingClientRect().top,row=[...container.querySelectorAll('[data-row]')].find(row=>row.getBoundingClientRect().bottom>top);return{id:row?.dataset.row,scrollTop:container.scrollTop};});
    facts.push({shortTranscriptOlder:{first,held,loaded,reached}});
    await page.locator('#session-a').click();await frames();
    await page.evaluate(()=>window.chatFixture.readAt('long-20'));await frames();
    const start=await geometry();assert.ok(start.anchor);
    let prior=await page.evaluate(()=>window.chatFixture.counts().older);
    for(const empty of [false,true]){
      await page.evaluate(()=>window.chatFixture.holdOlder());
      // Locate the explicit action without moving the viewport to the top: this
      // isolates page geometry from the separately tested physical input path.
      await history.getByRole('button',{name:'Load earlier history',exact:true}).evaluate(button=>button.click());
      await page.waitForFunction(value=>window.chatFixture.counts().older===value+1,prior);prior++;
      const held=await geometry();await page.evaluate(empty=>window.chatFixture.releaseOlder(empty),empty);
      await page.waitForFunction(()=>!window.chatFixture.scrollState().loadingOlder);await frames();
      const after=await geometry();facts.push({emptyPage:empty,before:held,after});
      assert.equal(after.anchor?.rowId,start.anchor.rowId);assert.ok(Math.abs(after.top-start.top)<=1,JSON.stringify({start,after}));
    }
    assert.equal(await history.getByRole('button',{name:'Load earlier history',exact:true}).count(),0);
    assert.equal(held.intent,'readingHistory');assert.equal(held.anchor?.rowId,first.id);assert.equal(held.loadingOlder,true);
    assert.equal(held.anchor.offsetPx,-first.offset);
    assert.ok(loaded.maximum>100);assert.equal(loaded.rows,33);assert.ok(loaded.offset>=0&&loaded.offset<loaded.height);
    // A formerly short transcript has no trailing space for the old first row
    // to keep its exact y. Retain the existing physical clamp, not a spacer.
    const desiredTop=loaded.scrollTop+loaded.offset-first.offset;
    assert.ok(desiredTop>loaded.maximum);assert.equal(loaded.scrollTop,loaded.maximum);
    assert.ok(reached.id?.startsWith('scroll-prepended-'));assert.ok(reached.scrollTop<loaded.scrollTop-100);
  });
  await check('Physical reading position and tool-row geometry survive A B A and actual unmount',async()=>{
    await page.evaluate(()=>{window.chatFixture.historyTools();window.chatFixture.scrollReset();});await frames();
    const physical=()=>history.evaluate(container=>{
      const top=container.getBoundingClientRect().top,row=[...container.querySelectorAll('[data-row]')].find(row=>row.getBoundingClientRect().bottom>top);
      return{id:row?.dataset.row,offset:row?row.getBoundingClientRect().top-top:null,scrollTop:container.scrollTop,maximum:container.scrollHeight-container.clientHeight,rows:[...container.querySelectorAll('[data-row]')].map(row=>row.dataset.row)};
    });
    const completeScroll=async action=>{
      await history.evaluate(container=>{container.dataset.scrollFinished='false';container.addEventListener('scrollend',()=>{container.dataset.scrollFinished='true';},{once:true});});
      await action();await page.waitForFunction(()=>document.querySelector('#chat-container [data-action=history]').dataset.scrollFinished==='true',undefined,{timeout:5000});await frames();
    };
    await history.focus();await completeScroll(()=>page.keyboard.press('Control+Home'));
    assert.ok((await physical()).scrollTop<1);
    await completeScroll(()=>page.keyboard.press('Control+End'));
    let position=await physical();assert.ok(position.maximum-position.scrollTop<1);
    await history.hover();await completeScroll(()=>page.mouse.wheel(0,-550));
    const start=await physical();assert.ok(start.id);assert.ok(start.maximum-start.scrollTop>100);
    const restore=async()=>{await frames();const after=await physical();const offset=await history.evaluate((container,id)=>{const row=[...container.querySelectorAll('[data-row]')].find(row=>row.dataset.row===id);return row?.getBoundingClientRect().top-container.getBoundingClientRect().top;},start.id);
      assert.deepEqual(after.rows,start.rows);assert.ok(Math.abs(offset-start.offset)<=1,JSON.stringify({start,after,offset}));
      // Estimated content-visibility sizes used to grow this unchanged set of
      // compact rows on remount, despite correctly settled native gestures.
      assert.equal(after.maximum,start.maximum,JSON.stringify({start,after}));return{after,offset};
    };
    await page.locator('#session-b').click();await page.locator('#session-a').click();const switched=await restore();
    await page.evaluate(()=>window.chatFixture.unmount());await page.evaluate(()=>window.chatFixture.remount());await page.waitForFunction(()=>window.chatFixture.refs().a===2);const remounted=await restore();
    facts.push({physicalRemount:{start,switched,remounted}});
    await page.evaluate(()=>{window.chatFixture.history(60,true);window.chatFixture.scrollReset();});await frames();
  });
  await check('Expanding earlier tool output preserves the retained reading position',async()=>{
    await page.evaluate(()=>window.chatFixture.readAt('long-20',11));await frames();const start=await geometry();
    await history.locator('[data-row=scroll-earlier-tool] summary').evaluate(summary=>summary.click());
    await page.waitForFunction(()=>window.chatFixture.snapshot('a').history.expansions.includes('scroll-earlier-tool'));await frames();
    const after=await geometry();facts.push({expanded:{start,after}});
    assert.equal(after.anchor?.rowId,start.anchor.rowId);assert.ok(Math.abs(after.top-start.top)<=1,JSON.stringify({start,after}));
  });
  await check('Container resize preserves the reading anchor at mobile width',async()=>{
    const start=await geometry();await page.setViewportSize({width:390,height:844});await frames();const after=await geometry();facts.push({resize:{start,after}});
    assert.equal(after.anchor?.rowId,start.anchor.rowId);assert.ok(Math.abs(after.top-start.top)<=1,JSON.stringify({start,after}));
  });
  await check('Actual touch scrolling wins a simultaneous streamed row',async()=>{
    await page.evaluate(()=>window.chatFixture.scrollReset());await frames();
    const session=await page.context().newCDPSession(page);
    try{
      await session.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
      await page.evaluate(()=>window.chatFixture.armWheelGrowth(true));
      const point=await history.evaluate(container=>{const box=container.getBoundingClientRect();return{x:Math.round(box.x+box.width/2),y:Math.round(box.y+box.height*.25)};});
      await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,id:1}]});
      for(let step=1;step<=8;step++){
        await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x,y:point.y+step*20,id:1}]});
        await page.evaluate(()=>new Promise(requestAnimationFrame));
      }
      await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await page.waitForFunction(()=>window.chatFixture.wheelGrowths()===2);await frames();
      const state=await geometry();facts.push({touch:state});assert.equal(state.intent,'readingHistory');assert.ok(state.scrollTop<state.maximum-50,JSON.stringify(state));
    }finally{await session.send('Emulation.setTouchEmulationEnabled',{enabled:false});await session.detach();}
  });
  await check('Pointer-controlled scrolling away from the tail leaves follow mode',async()=>{
    await page.evaluate(()=>window.chatFixture.scrollReset());await frames();
    const point=await history.evaluate(container=>{const box=container.getBoundingClientRect();return{x:box.left+2,y:box.top+20};});
    await page.mouse.move(point.x,point.y);await page.mouse.down();
    try{
      // A scrollbar/controller writes native scrollTop while the real pointer
      // gesture is held; the browser emits its ordinary trusted scroll event.
      await history.evaluate(container=>{container.scrollTop-=240;});await frames();
      const state=await geometry();facts.push({pointer:state});assert.equal(state.intent,'readingHistory');assert.ok(state.scrollTop<state.maximum-50,JSON.stringify(state));
    }finally{await page.mouse.up();}
  });
  await check('Only positively current work has a loader; incomplete capture stays quietly inspectable',async()=>{
    await qualifyCaptureCallouts(page,chat,cases,out);
  });
  await check('Admitted composer actions follow once before native events and preserve later reading or retired views',async()=>{
    await page.setViewportSize({width:1440,height:900});await frames();
    await page.evaluate(()=>window.chatFixture.authoringTail());await frames();
    const message=chat.locator('[data-action=message]'),initial=await page.evaluate(()=>window.chatFixture.counts().submitted);
    const top=async()=>{await history.focus();await page.keyboard.press('Control+Home');await page.waitForFunction(()=>document.querySelector('#chat-container [data-action=history]').scrollTop<1);await frames();};
    const draft=Array.from({length:9},(_,index)=>`Delayed own message line ${index}: enough text to wrap naturally.`).join('\n');
    await message.fill(draft);
    const jump=chat.getByRole('button',{name:'Jump to latest',exact:true});if(await jump.count())await jump.click();await frames();
    const tailFacts=[],tailFailures=[];
    const atTail=async(label,ownRow)=>{
      const fact=await history.evaluate((container,{label,ownRow})=>{
        const box=container.getBoundingClientRect(),row=ownRow?[...container.querySelectorAll('[data-row]')].find(row=>row.dataset.row===ownRow):null,composer=document.querySelector('#chat-container [data-action=message]');
        return{label,intent:window.chatFixture.scrollState().intent,scrollTop:container.scrollTop,maximum:container.scrollHeight-container.clientHeight,gap:container.scrollHeight-container.clientHeight-container.scrollTop,historyHeight:container.clientHeight,composerHeight:composer.getBoundingClientRect().height,ownRowTop:row?row.getBoundingClientRect().top-box.top:null,ownRowBottom:row?row.getBoundingClientRect().bottom-box.top:null,lastRow:[...container.querySelectorAll('[data-row]')].at(-1)?.dataset.row};
      },{label,ownRow});tailFacts.push(fact);
      if(fact.intent!=='followingLive'||Math.abs(fact.gap)>1||ownRow&&(fact.lastRow!==ownRow||fact.ownRowBottom<=0||fact.ownRowBottom>fact.historyHeight+1))tailFailures.push(fact);
      return fact;
    };
    await atTail('current-tail-with-tall-draft');
    await page.evaluate(()=>{
      const container=document.querySelector('#chat-container [data-action=history]'),input=document.querySelector('#chat-container [data-action=message]');
      const trace={entries:[],frame:null,active:true};window.sendTailTrace=trace;
      const sample=source=>{if(trace.entries.length<180)trace.entries.push({source,intent:window.chatFixture.scrollState().intent,top:container.scrollTop,maximum:container.scrollHeight-container.clientHeight,height:container.clientHeight,inputHeight:input.getBoundingClientRect().height,draftLength:input.value.length,rows:container.querySelectorAll('[data-row]').length});};
      trace.scroll=()=>sample('scroll');container.addEventListener('scroll',trace.scroll);
      const tick=()=>{if(trace.active){sample('frame');trace.frame=requestAnimationFrame(tick);}};tick();
      window.chatFixture.holdSubmission();window.chatFixture.holdOwnMessage();
    });
    await chat.locator('[data-action=send]').click();
    await page.waitForFunction(count=>window.chatFixture.counts().submitted===count+1&&document.querySelector('#chat-container [data-action=message]').value==='',initial);await frames();
    await atTail('after-admission-and-composer-consume');
    const ownRow=await page.evaluate(()=>window.chatFixture.releaseOwnMessage());
    await history.locator(`[data-row="${ownRow}"]`).waitFor();await frames();
    await atTail('delayed-own-row-after-consume',ownRow);
    assert.equal(await page.evaluate(()=>window.chatFixture.snapshot('a').operations.at(-1).state),'sending','No receipt was needed to follow');
    const assistant=await page.evaluate(()=>window.chatFixture.progress('working'));await frames();await atTail('later-assistant-arrival');
    await page.evaluate(id=>window.chatFixture.growProgress(id),assistant);await frames();await atTail('later-assistant-growth');
    const trace=await page.evaluate(()=>{const trace=window.sendTailTrace;trace.active=false;cancelAnimationFrame(trace.frame);document.querySelector('#chat-container [data-action=history]').removeEventListener('scroll',trace.scroll);return trace.entries;});
    await writeFile(resolve(out,'send-tail-facts.json'),JSON.stringify({tailFacts,tailFailures,trace,nativeModelCalls:0},null,2)+'\n');
    await page.screenshot({path:resolve(out,'send-delayed-own-row.png')});
    await top();const reading=await geometry();await page.evaluate(()=>window.chatFixture.releaseSubmission());
    await page.waitForFunction(()=>window.chatFixture.snapshot('a').operations.at(-1).state==='acknowledged');
    await page.evaluate(id=>window.chatFixture.growProgress(id),assistant);await frames();let state=await geometry();
    assert.equal(state.intent,'readingHistory');assert.equal(state.anchor.rowId,reading.anchor.rowId);assert.ok(Math.abs(state.top-reading.top)<1,'A delayed reply and stream do not steal manual reading');
    for(const action of ['steer','queue']){
      await page.evaluate(()=>window.chatFixture.holdSubmission());await message.fill(action+' from earlier history');
      if(action==='queue'){await chat.getByRole('button',{name:'More message actions',exact:true}).click();await chat.getByRole('menuitem',{name:'Queue message',exact:true}).click();}
      else await chat.locator('[data-action=steer]').click();
      await page.waitForFunction(action=>window.chatFixture.commands().at(-1)===(action==='steer'?'codex.steer':'codex.queue.add'),action);await frames();
      state=await geometry();assert.equal(state.intent,'followingLive');assert.ok(state.maximum-state.scrollTop<1);
      await page.evaluate(()=>window.chatFixture.releaseSubmission());await page.waitForFunction(()=>window.chatFixture.snapshot('a').operations.at(-1).state==='acknowledged');await top();
    }
    await page.evaluate(()=>window.chatFixture.progress('idle'));await frames();await top();
    const invalid='x'.repeat(8193),prior=await page.evaluate(()=>window.chatFixture.counts().submitted);await message.fill(invalid);await chat.locator('[data-action=send]').click();
    await chat.getByText('The action could not be prepared. Your draft is retained.',{exact:true}).waitFor();
    assert.equal(await message.inputValue(),invalid);assert.equal(await page.evaluate(()=>window.chatFixture.counts().submitted),prior);
    await page.evaluate(()=>window.chatFixture.progress('working'));await frames();assert.equal((await geometry()).intent,'readingHistory');
    await page.evaluate(()=>window.chatFixture.progress('idle'));await frames();await message.fill('Complete the shared Send after leaving this view');
    await page.evaluate(()=>window.chatFixture.holdProtection());await chat.locator('[data-action=send]').click();await page.waitForFunction(()=>window.chatFixture.protectionEntered());
    await page.locator('#session-b').click();const other=await page.evaluate(()=>window.chatFixture.snapshot('b').history.viewport);
    await page.evaluate(()=>window.chatFixture.releaseProtection());await page.waitForFunction(count=>window.chatFixture.counts().submitted===count+1,prior);
    assert.deepEqual(await page.evaluate(()=>window.chatFixture.snapshot('b').history.viewport),other);
    assert.equal(await page.evaluate(()=>window.chatFixture.scrollState().intent),'readingHistory','Unmounted initiating component cannot follow its retained view later');
    await page.locator('#session-a').click();await frames();assert.equal((await geometry()).intent,'readingHistory');
    assert.equal((await page.evaluate(()=>window.chatFixture.counts().submitted))-initial,4);
    facts.push({authoring:{submitted:4,heldReceiptFollow:true,delayedOwnRow:ownRow,tailFacts,newStreamFollows:true,manualReadingPreserved:true,invalidDraftRetained:true,unmountedFollowInert:true}});
    assert.deepEqual(tailFailures,[],'Following latest must reach the actual tail after delayed own message and composer/layout changes');
  });
  const after=await page.evaluate(()=>window.chatFixture.counts());
  assert.equal(after.older-before.older,3);assert.equal(after.submitted-before.submitted,4);assert.equal(after.discovery,before.discovery);assert.equal(after.controlReads,before.controlReads);
  await writeFile(resolve(out,'transcript-facts.json'),JSON.stringify({facts,failures,before,after,nativeModelCalls:0},null,2)+'\n');
  await page.screenshot({path:resolve(out,'transcript-reading-mobile.png')});
  assert.deepEqual(failures,[]);
  return{facts,before,after};
}
