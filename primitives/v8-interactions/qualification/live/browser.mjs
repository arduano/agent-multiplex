import assert from 'node:assert/strict';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {bounded} from './support.mjs';

const here=dirname(fileURLToPath(import.meta.url));
let bundled;
export async function respondInBrowser({bridge,prompt,answer,operationId}){
  bundled??=build({entryPoints:[join(here,'browser-client.mjs')],bundle:true,platform:'browser',format:'esm',write:false,logLevel:'silent'}).then(value=>value.outputFiles[0].text);
  const source=await bundled,config=bridge.browserConfiguration(),origin=new URL(config.url).origin;
  let browser,page;const errors=[];
  try{
    return await bounded((async()=>{
      browser=await chromium.launch({executablePath:'/run/current-system/sw/bin/chromium',headless:true,timeout:15000,args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking']});
      const context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
      await context.route('**/*',async route=>{
        const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
        if(url.pathname==='/live-ui')return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><title>Owned native interaction qualification</title><style>body{font:16px sans-serif;padding:12px}section{border:1px solid;padding:12px}label{display:block;margin:12px 0}input,select,button{font:inherit;max-width:95%}button{margin:5px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><main id="prompts"></main><script type="module" src="/live-ui.js"></script>'});
        if(url.pathname==='/live-ui.js')return route.fulfill({status:200,contentType:'text/javascript',body:source});
        if(url.pathname==='/v8')return route.continue();return route.abort();
      });
      page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.name));await page.goto(origin+'/live-ui');
      await page.waitForFunction(()=>window.liveReady);await page.evaluate(config=>window.liveConfigure(config),config);
      await page.evaluate(id=>{window.liveOperationId=id},operationId);
      const dialog=page.locator(`[data-prompt-id="${prompt.id}"]`);await dialog.waitFor({state:'visible'});
      assert.equal(await dialog.getAttribute('role'),'dialog');
      // Dismiss is view-only. A fresh configure observes the same actual native capability.
      await dialog.locator('[data-action="dismiss"]').click();assert.equal(await dialog.isVisible(),false);
      await page.evaluate(async config=>{window.liveClose();await window.liveConfigure(config)},config);
      await dialog.waitFor({state:'visible'});
      const field=name=>dialog.getByLabel(name,{exact:true});
      let action;
      if(answer.type==='codex.command'||answer.type==='codex.file')action=answer.decisionId;
      else if(answer.type==='codex.permission')action=answer.grant;
      else if(answer.type==='copilot.permission'){action=answer.kind;if(answer.feedback)await field('feedback').fill(answer.feedback)}
      else if(answer.type==='codex.question'){
        for(const q of prompt.questions){const values=answer.answers[q.id];assert.equal(values.length,1,'Live browser fixture supports one selected answer per question');if(q.options.length&&!q.other)await field(q.id).selectOption(values[0]);else await field(q.id).fill(values[0])}action='submit';
      }else if(answer.type==='copilot.question'){
        if(prompt.freeform)await field('answer').fill(answer.answer);else await field('answer').selectOption(answer.answer);await field('wasFreeform').setChecked(answer.wasFreeform);action='submit';
      }else if(answer.type==='copilot.plan'){
        if(answer.selectedAction)await field('selectedAction').selectOption(answer.selectedAction);if(answer.feedback)await field('feedback').fill(answer.feedback);action=answer.approved?'approve':'reject';
      }else{
        action=answer.action;if(answer.content)for(const [name,value]of Object.entries(answer.content)){
          const schema=prompt.form.fields[name];if(!prompt.form.required.includes(name))await field(`Include ${name}`).setChecked(true);if(typeof value==='boolean')await field(name).setChecked(value);else if(schema.enum&&schema.type!=='array')await field(name).selectOption(value);else await field(name).fill(Array.isArray(value)?value.join('\n'):String(value));
        }
      }
      await dialog.locator(`[data-action="${action}"]`).click();await page.waitForFunction(()=>window.liveReceipt!==null||window.liveFailure!==null);
      const result=await page.evaluate(()=>({receipt:window.liveReceipt,failure:window.liveFailure}));assert.equal(result.failure,null);assert.ok(result.receipt);assert.equal(result.receipt.id,operationId);assert.deepEqual(errors,[]);
      return result.receipt;
    })(),45000,'Actual native browser response');
  }finally{if(page)await page.evaluate(()=>window.liveClose?.()).catch(()=>{});await browser?.close()}
}
