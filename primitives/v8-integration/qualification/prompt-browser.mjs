import assert from 'node:assert/strict';

/** Real browser/Host/wire rendering matrix with concrete scripted callbacks.
 * Explicit fixture retirement below advances SDK-submitted callbacks; it is
 * deliberately not evidence of a real native completion or agent continuation. */
export async function qualifyPromptMatrix({app,page,deferred,until}){
 const seen=new Set(),codex=app.driver('main'),copilot=app.driver('peer'),root=codex.controller.current().run.nativeSession;
 let serial=0;
 const open=async type=>{await page.locator('#confirmation').click();await page.locator(`dialog[data-prompt-type="${type}"]`).waitFor();seen.add(type)};
 const nativeCodex=async(method,params,operate)=>{
  const value=deferred(),settled=deferred();let count=0;
  codex.reverse({id:`matrix-${++serial}`,method,token:{},params:{threadId:root,turnId:'matrix-turn',itemId:`matrix-item-${serial}`,...params},settled:settled.promise,respond:async response=>{count++;value.resolve(response);settled.resolve();return{kind:'ack',success:true}}});
  await operate();const actual=await value.promise;await page.getByRole('dialog').waitFor({state:'detached'});assert.equal(count,1);return actual;
 };
 await page.getByRole('button',{name:'Conversation A',exact:true}).click();
 const command=await nativeCodex('item/commandExecution/requestApproval',{command:'scripted echo',cwd:'/fixture',availableDecisions:['accept','decline']},async()=>{await open('codex.command');assert.equal(await page.getByRole('button',{name:'acceptForSession',exact:true}).count(),0);await page.getByRole('button',{name:'decline',exact:true}).click()});assert.deepEqual(command,{decision:'decline'});
 const file=await nativeCodex('item/fileChange/requestApproval',{reason:'scripted file review'},async()=>{await open('codex.file');await page.getByRole('button',{name:'acceptForSession',exact:true}).click()});assert.deepEqual(file,{decision:'acceptForSession'});
 const permissions={network:{enabled:false},fileSystem:{read:['/fixture/input'],write:null,entries:[{path:{type:'path',path:'/fixture/input'},access:'read'},{path:{type:'path',path:'/fixture/private'},access:'deny'}]}};
 const permission=await nativeCodex('item/permissions/requestApproval',{permissions},async()=>{await open('codex.permission');assert.match(await page.getByRole('dialog').innerText(),/\/fixture\/private/);assert.match(await page.getByRole('dialog').innerText(),/deny/);await page.getByRole('button',{name:'Grant for this turn',exact:true}).click()});assert.deepEqual(permission,{permissions,scope:'turn'});
 const secret='private-form-value-matrix';
 const answers=await nativeCodex('item/tool/requestUserInput',{isBlocking:true,questions:[{id:'secret',header:'Secret value',question:'Enter a private value',isSecret:true,isOther:true,options:null},{id:'choice',header:'Choice',question:'Pick one',isSecret:false,isOther:false,options:[{label:'Alpha',description:'first'},{label:'Beta',description:'second'}]}]},async()=>{
  await open('codex.question');assert.equal(await page.getByLabel('Answer for Secret value',{exact:true}).getAttribute('type'),'password');await page.getByLabel('Answer for Secret value',{exact:true}).fill(secret);await page.getByLabel('Choice for Choice',{exact:true}).selectOption('option:1');
  await page.getByRole('button',{name:'Later',exact:true}).click();await page.getByRole('button',{name:'Conversation B',exact:true}).click();await page.getByRole('button',{name:'Conversation A',exact:true}).click();await open('codex.question');assert.equal(await page.getByLabel('Answer for Secret value',{exact:true}).inputValue(),secret);
  const privateProof=await page.evaluate(async secret=>{
   const snapshot=JSON.stringify(window.applicationTest.snapshot('main'));
   const persisted=await new Promise((resolve,reject)=>{const opening=indexedDB.open('multiplex-v8-drafts');opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result,tx=db.transaction([...db.objectStoreNames],'readonly'),values=[];for(const name of db.objectStoreNames){const request=tx.objectStore(name).getAll();request.onsuccess=()=>values.push(...request.result)}tx.oncomplete=()=>{db.close();resolve(JSON.stringify(values))};tx.onerror=()=>reject(tx.error)}});
   return{publicSnapshot:snapshot.includes(secret),indexedDb:persisted.includes(secret),localStorage:JSON.stringify(localStorage).includes(secret),sessionStorage:JSON.stringify(sessionStorage).includes(secret)};
  },secret);assert.deepEqual(privateProof,{publicSnapshot:false,indexedDb:false,localStorage:false,sessionStorage:false});
  await page.getByRole('button',{name:'Send answers',exact:true}).click();
 });assert.deepEqual(answers,{answers:{secret:{answers:[secret]},choice:{answers:['Beta']}}});
 const unsupported=await nativeCodex('mcpServer/elicitation/request',{serverName:'matrix',mode:'form',message:'Unsupported nested form',requestedSchema:{type:'object',properties:{nested:{type:'object',properties:{}}}}},async()=>{await open('codex.elicitation');assert.equal(await page.locator('#confirm-request').count(),0);assert.equal(await page.getByRole('dialog').getByRole('textbox').count(),0);await page.getByRole('button',{name:'Decline request',exact:true}).click()});assert.deepEqual(unsupported,{action:'decline',content:null,_meta:null});
 const verified=await nativeCodex('mcpServer/elicitation/request',{serverName:'matrix',mode:'url',message:'Explicit verification',url:'https://verification.invalid/step'},async()=>{await open('codex.elicitation');const link=page.getByRole('link',{name:'Open verification page',exact:true});assert.equal(await link.getAttribute('rel'),'noopener noreferrer');await page.getByRole('button',{name:"I've completed this",exact:true}).click()});assert.deepEqual(verified,{action:'accept',content:null,_meta:null});

 await page.getByRole('button',{name:'Conversation B',exact:true}).click();
 copilot.event('permission.requested',{requestId:'matrix-permission',permissionRequest:{kind:'shell',fullCommandText:'scripted echo',intention:'scripted permission',commands:[],possiblePaths:[],possibleUrls:[],hasWriteFileRedirection:false,canOfferSessionApproval:true,managedApprovalRequired:true}});
 await open('copilot.permission');assert.match(await page.getByRole('dialog').innerText(),/Managed policy/);assert.equal(await page.getByRole('button',{name:'Approve for session',exact:true}).count(),0);await page.getByRole('button',{name:'Approve once',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
 assert.deepEqual(copilot.requests.filter(value=>value.method==='permissions.handlePendingPermissionRequest').at(-1).params,{requestId:'matrix-permission',result:{kind:'approve-once',approvedInteractively:true}});
 const config=copilot.requests.find(value=>value.method==='session.create').params,nativeSession=copilot.controller.current().run.nativeSession;
 const sdk=async(type,invoke,operate)=>{
  const before=new Set(copilot.controller.interactions(copilot.controller.current().run).current().items.map(value=>value.prompt.id));
  const response=invoke();await open(type);await operate();const value=await response;
  const owner=copilot.controller.interactions(copilot.controller.current().run);await until(()=>owner.current().items.some(value=>!before.has(value.prompt.id)&&value.state==='responseSubmitted'));const item=owner.current().items.find(value=>!before.has(value.prompt.id)&&value.state==='responseSubmitted');assert.ok(item);assert.equal(item.state,'responseSubmitted');
  // There is no invented native acknowledgement. The explicit scripted owner
  // retirement is only a matrix barrier, after asserting submitted semantics.
  owner.completed(item.prompt.id,item.prompt.run);await page.getByRole('dialog').waitFor({state:'detached'});return value;
 };
 const question=await sdk('copilot.question',()=>config.onUserInputRequest({question:'Choose a native answer',choices:['Yes','No'],allowFreeform:false},{sessionId:nativeSession}),async()=>{assert.equal(await page.getByLabel('Your answer',{exact:true}).count(),0);await page.getByLabel('Answer choice',{exact:true}).selectOption('option:1');await page.getByRole('button',{name:'Send answer',exact:true}).click()});assert.deepEqual(question,{answer:'No',wasFreeform:false});
 const elicitation=await sdk('copilot.elicitation',()=>config.onElicitationRequest({sessionId:nativeSession,mode:'form',message:'Primitive field matrix',requestedSchema:{type:'object',properties:{name:{type:'string',title:'Name',minLength:2,maxLength:10},role:{type:'string',enum:['','reviewer']},count:{type:'integer',minimum:1,maximum:3},ratio:{type:'number',minimum:0,maximum:1},enabled:{type:'boolean'},tags:{type:'array',items:{type:'string',enum:['one','two']},minItems:1,maxItems:1},note:{type:'string'}},required:['name','role','count','ratio','enabled','tags']}}),async()=>{
  await page.getByLabel('Name',{exact:true}).fill('r');await page.getByLabel('role',{exact:true}).selectOption('option:0');await page.getByLabel('count',{exact:true}).fill('1.5');await page.getByLabel('ratio',{exact:true}).fill('0.5');await page.getByLabel('enabled',{exact:true}).selectOption('false');await page.getByRole('checkbox',{name:'one',exact:true}).check();await page.locator('#confirm-request').click();await page.getByRole('dialog').getByRole('alert').waitFor();
  await page.getByLabel('Name',{exact:true}).fill('review');await page.getByLabel('count',{exact:true}).fill('2');await page.locator('#confirm-request').click();
 });assert.deepEqual(elicitation,{action:'accept',content:{name:'review',role:'',count:2,ratio:0.5,enabled:false,tags:['one']}});
 const plan=await sdk('copilot.plan',()=>config.onExitPlanModeRequest({summary:'Review the exact plan',planContent:'Scripted plan body',actions:['exit_only','autopilot'],recommendedAction:'exit_only'},{sessionId:nativeSession}),async()=>{assert.equal(await page.getByLabel('Action after approval',{exact:true}).inputValue(),'');await page.getByRole('button',{name:'Approve selected action',exact:true}).click();await page.getByRole('dialog').getByRole('alert').waitFor();await page.getByLabel('Action after approval',{exact:true}).selectOption('exit_only');await page.getByRole('button',{name:'Approve selected action',exact:true}).click()});assert.deepEqual(plan,{approved:true,selectedAction:'exit_only'});
 await page.getByRole('button',{name:'Conversation A',exact:true}).click();
 assert.equal(seen.size,9);return 'exhaustive nine-type actual Chromium prompt matrix validates exact native answers and unsupported decline, literal permission constraints, managed approve-once, primitive fields and explicit plan action; private secret drafts survive A/B without entering snapshots or browser persistence';
}

export async function qualifyControlDrafts({app,page}){
 const before=app.stats().map(value=>({opens:value.opens,resumes:value.resumes,sends:value.sends,bodyReads:value.bodyReads,discovery:value.discovery}));
 await page.locator('#session-controls > summary').click();await page.locator('#load-models').click();await page.waitForFunction(()=>!document.querySelector('#next-model')?.disabled);
 const observed=await page.evaluate(()=>window.applicationTest.snapshot('main').session.native.selection);
 const sandbox=page.locator('#next-sandbox'),unavailable=await sandbox.locator('option').evaluateAll(options=>options.filter(option=>option.value==='workspace-write'||option.value==='read-only').map(option=>({value:option.value,disabled:option.disabled,explicit:option.textContent.includes('unavailable for Next Send')})));
 assert.deepEqual(unavailable,[{value:'workspace-write',disabled:true,explicit:true},{value:'read-only',disabled:true,explicit:true}]);
 await sandbox.focus();await sandbox.press('End');await sandbox.press('Enter');assert.equal(await sandbox.inputValue(),'danger-full-access');
 const driver=app.driver('main'),threadId=driver.controller.current().run.nativeSession;
 driver.notify('thread/settings/updated',{threadId,threadSettings:{approvalPolicy:'on-request',sandboxPolicy:{type:'readOnly'}}});
 await page.waitForFunction(()=>document.querySelector('#next-sandbox')?.value==='read-only');assert.equal(await sandbox.locator('option:checked').evaluate(option=>option.disabled),true);assert.equal(await page.locator('#codex-sandbox-unavailable').count(),1);
 assert.equal((await page.evaluate(()=>window.applicationTest.snapshot('main').session.native.selection)).access.sandbox,'read-only');
 driver.notify('thread/settings/updated',{threadId,threadSettings:{approvalPolicy:'on-request',activePermissionProfile:{id:'scripted-profile'}}});
 await page.waitForFunction(()=>document.querySelector('#next-sandbox')?.value==='profile');assert.equal(await sandbox.locator('option:checked').evaluate(option=>option.disabled),true);assert.match(await sandbox.locator('option:checked').textContent(),/scripted-profile.*unavailable/);
 await page.locator('#next-approval').selectOption('untrusted');assert.deepEqual((await page.evaluate(()=>window.applicationTest.snapshot('main').session.draft)).access,{profile:'scripted-profile',approval:'untrusted'});
 await sandbox.selectOption('danger-full-access');await page.locator('#next-approval').selectOption('on-request');assert.deepEqual((await page.evaluate(()=>window.applicationTest.snapshot('main').session.draft)).access,{sandbox:'danger-full-access',approval:'on-request'});assert.equal(await page.locator('#codex-sandbox-unavailable').count(),0);
 driver.notify('thread/settings/updated',{threadId,threadSettings:{approvalPolicy:observed.access.approval,sandboxPolicy:{type:'dangerFullAccess'}}});await page.waitForFunction(()=>window.applicationTest.snapshot('main').session.native.selection.access.sandbox==='danger-full-access');
 await page.locator('#next-model').selectOption({label:'gpt-6-luna'});await page.locator('#next-effort').selectOption('effort:0');assert.match(await page.locator('#codex-mode-hint').textContent(),/Choose Default or Plan/);await page.locator('#next-mode').selectOption('default');assert.equal(await page.locator('#codex-mode-hint').count(),0);
 const codex=await page.evaluate(()=>window.applicationTest.snapshot('main').session.draft);assert.equal(codex.kind,'codex');assert.equal(codex.model,'gpt-6-luna');assert.equal(codex.effort,'low');assert.equal(codex.collaboration.mode,'default');
 assert.deepEqual(await page.evaluate(()=>window.applicationTest.snapshot('main').session.native.selection),observed);
 await page.getByRole('button',{name:'Conversation B',exact:true}).click();await page.locator('#session-controls > summary').click();await page.locator('#next-mode').selectOption('plan');await page.locator('#next-permissions').selectOption('manual');
 assert.equal(await page.locator('[aria-label="Codex controls"]').count(),0);const copilot=await page.evaluate(()=>window.applicationTest.snapshot('peer').session.draft);assert.equal(copilot.kind,'copilot');assert.equal(copilot.mode,'plan');assert.equal(copilot.permissions,'manual');
 await page.getByRole('button',{name:'Conversation A',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.applicationTest.snapshot('main').session.draft),codex);
 await page.locator('#session-controls > summary').click();await page.locator('#reset-selection').click();await page.getByRole('button',{name:'Conversation B',exact:true}).click();await page.locator('#session-controls > summary').click();await page.locator('#reset-selection').click();await page.getByRole('button',{name:'Conversation A',exact:true}).click();
 assert.deepEqual(app.stats().map(value=>({opens:value.opens,resumes:value.resumes,sends:value.sends,bodyReads:value.bodyReads,discovery:value.discovery})),before);
 return 'configured model controls retain next-Send intent through A/B; unsupported Codex sandboxes/profiles stay explicit, disabled and preserved, full-access/on-request remains editable, and unknown mode instructions guide explicit mode selection without Send/Resume/history/discovery';
}
