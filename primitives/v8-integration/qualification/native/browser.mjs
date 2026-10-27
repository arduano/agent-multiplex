import assert from 'node:assert/strict';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {bounded} from '../../../v8-interactions/qualification/live/support.mjs';

const here=dirname(fileURLToPath(import.meta.url)),framework=resolve(here,'../../../..');
let bundle;
/** Qualification only: actual reusable React dialog, private form owner and
 * authenticated HTTP clients. It cannot execute or own a native process. */
export async function respondInBrowser({bridge,prompt,answer,operationId,registerCleanup=()=>{}}){
 assert.equal(answer.type,prompt.type);assert.ok(typeof operationId==='string'&&operationId.length>0);
 bundle??=build({entryPoints:[resolve(here,'browser-client.ts')],bundle:true,platform:'browser',format:'esm',target:'es2023',write:false,logLevel:'silent',
  alias:{react:resolve(framework,'node_modules/react'),'react-dom/client':resolve(framework,'node_modules/react-dom/client.js')},define:{'process.env.NODE_ENV':'"development"'}}).then(result=>result.outputFiles[0].text);
 const source=await bundle,config=bridge.browserConfiguration(),origin=new URL(config.url).origin;
 let browser,page,closed=false;const errors=[];
 const close=async()=>{closed=true;if(page)await page.evaluate(()=>window.nativeUiClose?.()).catch(()=>{});await browser?.close()};registerCleanup(close);
 try{return await bounded((async()=>{
  assert.equal(closed,false,'Native prompt UI retired before launch');
  browser=await chromium.launch({executablePath:'/run/current-system/sw/bin/chromium',headless:true,timeout:15000,args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking']});
  if(closed){await browser.close();throw Error('Native prompt UI retired during launch')}
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  await context.route('**/*',route=>{
   const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
   if(url.pathname==='/native-ui')return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><title>V8 native prompt qualification</title><style>body{font:16px sans-serif}dialog{max-width:90vw;max-height:90vh;overflow:auto}label{display:block;margin:12px 0}input,select,button{font:inherit;max-width:95%}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><main id="native-prompts"></main><script type="module" src="/native-ui.js"></script>'});
   if(url.pathname==='/native-ui.js')return route.fulfill({status:200,contentType:'text/javascript',body:source});
   return url.pathname==='/v8'?route.continue():route.abort();
  });
  page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.name));
  await page.goto(origin+'/native-ui');await page.waitForFunction(()=>window.nativeUiReady);
  await page.evaluate(({config,operationId})=>window.nativeUiConfigure(config,operationId),{config,operationId});
  await page.waitForFunction(id=>window.nativeUiHasPrompt(id),prompt.id);
  const open=()=>page.evaluate(id=>window.nativeUiOpen(id),prompt.id);
  await open();let dialog=page.getByRole('dialog');await dialog.waitFor();
  // A mounted listener is disposable. Dismiss/reopen retains the same actual
  // private form and grants no native acknowledgement or continuation.
  await dialog.getByRole('button',{name:'Later',exact:true}).click();await dialog.waitFor({state:'detached'});await open();await dialog.waitFor();
  const field=label=>dialog.getByLabel(label,{exact:true});let action;
  if(answer.type==='codex.command'||answer.type==='codex.file'){
   const decision=prompt.decisions.find(value=>value.id===answer.decisionId);assert.ok(decision);action=decision.label;
  }else if(answer.type==='codex.permission')action={deny:'Deny additional access',turn:'Grant for this turn',session:'Grant for this session'}[answer.grant];
  else if(answer.type==='copilot.permission'){
   if(answer.feedback)await field('Reason for rejecting (optional)').fill(answer.feedback);
   action={'approve-once':'Approve once',reject:'Reject request','user-not-available':'User unavailable'}[answer.kind];
  }else if(answer.type==='codex.question'){
   for(const question of prompt.questions){
    const values=answer.answers[question.id];assert.equal(values?.length,1);const value=values[0],index=question.options.indexOf(value);
    if(question.options.length)await field(`Choice for ${question.header}`).selectOption(index>=0?`option:${index}`:'other');
    if(index<0)await field(`Answer for ${question.header}`).fill(value);
   }action='Send answers';
  }else if(answer.type==='copilot.question'){
   const index=prompt.options.indexOf(answer.answer);
   if(prompt.options.length)await field('Answer choice').selectOption(answer.wasFreeform?'other':`option:${index}`);
   if(answer.wasFreeform)await field('Your answer').fill(answer.answer);action='Send answer';
  }else if(answer.type==='copilot.plan'){
   if(answer.selectedAction)await field('Action after approval').selectOption(answer.selectedAction);
   if(answer.feedback)await field('Plan feedback (optional)').fill(answer.feedback);action=answer.approved?'Approve selected action':'Reject plan';
  }else{
   if(answer.action==='accept'&&answer.content)for(const [name,value]of Object.entries(answer.content)){
    const schema=prompt.form.fields[name],label=schema.title??name;
    if(!prompt.form.required.includes(name))await dialog.getByRole('checkbox',{name:`Include ${label}`,exact:true}).check();
    if(schema.type==='boolean')await field(label).selectOption(String(value));
    else if(schema.type==='array'){for(const item of value)await field(label).getByRole('checkbox',{name:item,exact:true}).check()}
    else if(schema.enum)await field(label).selectOption(`option:${schema.enum.indexOf(value)}`);
    else await field(label).fill(String(value));
   }
   action=answer.action==='accept'?(prompt.mode==='url'?"I've completed this":'Confirm once'):answer.action==='decline'?'Decline request':'Cancel request';
  }
  await dialog.getByRole('button',{name:action,exact:true}).click();await page.waitForFunction(()=>window.nativeUiReceipt!==null||window.nativeUiFailure!==null);
  const result=await page.evaluate(()=>({receipt:window.nativeUiReceipt,failure:window.nativeUiFailure}));
  assert.equal(result.failure,null);assert.ok(result.receipt);assert.equal(result.receipt.id,operationId);assert.deepEqual(result.receipt.scope,prompt.run.scope);assert.deepEqual(errors,[]);
  return result.receipt;
 })(),45000,'Actual reusable React native prompt response')}
 finally{await close()}
}
