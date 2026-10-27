import assert from "node:assert/strict";
import test from "node:test";
import { interactionFixture } from "./fixture.js";
import type { NativeAnswer } from "../src/contracts.js";
import {InteractionWorkspace} from "../src/client.js";
test("actual retained workspace observes zero-viewer prompts, preserves background entries and exposes stable snapshots",async()=>{const f=interactionFixture();try{const p=f.register("userInput",{question:"Background?",allowFreeform:true});await f.bind();const entry=f.workspace.entry(f.scope);assert.equal(entry.getSnapshot().snapshot?.items[0]?.prompt.id,p.id);assert.equal(entry.getSnapshot(),entry.getSnapshot());assert.equal(f.workspace.entry(f.scope),entry);let calls=0;entry.subscribe(()=>{throw Error("renderer");});entry.subscribe(()=>calls++);f.register("permission",{kind:"mcp",managedApprovalRequired:true});assert.equal(entry.getSnapshot().snapshot?.items.length,2);assert.equal(calls,1);assert.equal(f.counts().submitted,0);}finally{f.close();}});
test("lost reply checks original receipt after reconnect, with no response-body markers or mutation replay",async()=>{const f=interactionFixture();try{await f.bind();const p=f.register("userInput",{question:"Secret?",allowFreeform:true});f.session.loseNext();await assert.rejects(f.answer(p,{type:"copilot.question",answer:"private-answer-body",wasFreeform:true},"original").result);const entry=f.workspace.entry(f.scope);assert.equal(entry.getSnapshot().operations[0]?.state,"unknown");assert.equal(JSON.stringify(entry.getSnapshot()).includes("private-answer-body"),false);f.connect(false);f.connect(true);await f.workspace.refresh(f.scope);assert.equal(entry.getSnapshot().stale,false);assert.equal((await f.workspace.checkReceipt(f.scope,"original"))?.state,"acknowledged");assert.deepEqual(f.counts(),{submitted:1,responses:1});assert.equal(f.lastPrivate(),"private-answer-body");}finally{f.close();}});
test("disconnect preserves exact prompt, denies response while stale and reconnect never synthesizes an answer",async()=>{const f=interactionFixture();try{await f.bind();const p=f.register("permission",{kind:"mcp",managedApprovalRequired:true});f.connect(false);assert.equal(f.workspace.entry(f.scope).getSnapshot().snapshot?.items[0]?.prompt.id,p.id);assert.throws(()=>f.answer(p,{type:"copilot.permission",kind:"approve-once"},"offline"));f.connect(true);await f.workspace.refresh(f.scope);assert.equal(f.workspace.entry(f.scope).getSnapshot().stale,false);assert.deepEqual(f.counts(),{submitted:0,responses:0});await f.answer(p,{type:"copilot.permission",kind:"reject"},"response").result;assert.equal(f.counts().responses,1);}finally{f.close();}});
test("stale replacement and wrong-harness answers fail before transport",async()=>{const f=interactionFixture();try{await f.bind();const p=f.register("permission",{kind:"mcp"});f.owner.completed(p.id,p.run);f.register("permission",{kind:"mcp"});assert.throws(()=>f.answer(p,{type:"copilot.permission",kind:"approve-once"},"stale"));const current=f.workspace.entry(f.scope).getSnapshot().snapshot!.items[0]!.prompt;assert.throws(()=>f.answer(current,{type:"codex.command",decisionId:"decision:0"} as NativeAnswer,"wrong"));assert.equal(f.counts().submitted,0);}finally{f.close();}});
test("run generation outranks callback epoch/revision; delayed prior generation and changed native binding cannot overwrite",async()=>{const f=interactionFixture();let snapshot=f.owner.current();const workspace=new InteractionWorkspace({port:{snapshot:async()=>snapshot,subscribe:()=>()=>{}},session:f.session.port});try{snapshot={...snapshot,revision:40};await workspace.bind(f.scope);snapshot={...snapshot,run:{...snapshot.run,generation:2},epoch:0,revision:0};await workspace.refresh(f.scope);assert.equal(workspace.entry(f.scope).getSnapshot().snapshot?.run.generation,2);snapshot={...snapshot,run:{...snapshot.run,generation:1},epoch:999,revision:999};await workspace.refresh(f.scope);assert.equal(workspace.entry(f.scope).getSnapshot().snapshot?.run.generation,2);snapshot={...snapshot,run:{...snapshot.run,generation:3,nativeSession:"different"}};await assert.rejects(workspace.refresh(f.scope));snapshot={...snapshot,scope:{...snapshot.scope,principal:"other"},run:{...snapshot.run,scope:{...snapshot.scope,principal:"other"}}};await assert.rejects(workspace.refresh(f.scope));}finally{workspace.close();f.close();}});

test('failed subscription admission rolls back exactly, and concurrent bind retries only the missing initial read', async () => {
 const f=interactionFixture(),snapshot=f.owner.current();let attempts=0,reads=0,off=0,reject!:(error:Error)=>void;
 const callbacks:Array<(value:typeof snapshot)=>void>=[],held=new Promise<typeof snapshot>((_resolve,no)=>{reject=no;});
 const workspace=new InteractionWorkspace({session:f.session.port,port:{subscribe:(_scope,listener)=>{callbacks.push(listener);if(++attempts===1)throw Error('Admission refused');return()=>{off++;};},snapshot:async()=>++reads===1?held:snapshot}});
 try{
  await assert.rejects(workspace.bind(f.scope));assert.throws(()=>workspace.entry(f.scope),error=>error instanceof Error&&'code'in error&&error.code==='FENCED');
  const first=workspace.bind(f.scope),second=workspace.bind(f.scope),reconnect=workspace.refresh(f.scope);await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual([attempts,reads],[2,1]);
  callbacks[0]!({...snapshot,revision:999});assert.equal(workspace.entry(f.scope).getSnapshot().snapshot,null);
  const failures=Promise.all([assert.rejects(first),assert.rejects(second),assert.rejects(reconnect)]);reject(Error('Read failed'));await failures;
  assert.equal(off,0);assert.equal(workspace.entry(f.scope).getSnapshot().stale,true);await workspace.bind(f.scope);assert.deepEqual([attempts,reads],[2,2]);assert.equal(workspace.entry(f.scope).getSnapshot().snapshot?.revision,snapshot.revision);
 }finally{workspace.close();f.close();}assert.equal(off,1);
});

test('namespace disposal scrubs cached facades/forms/original markers, notifies and continues after failed unsubscribe',async()=>{
 const f=interactionFixture();const prompt=f.register('userInput',{question:'Original?',allowFreeform:true});let off=0;
 const callbacks:Array<(snapshot:ReturnType<typeof f.owner.current>)=>void>=[],secondScope={...f.scope,session:'second'};
 const workspace=new InteractionWorkspace({session:f.session.port,port:{subscribe:(_scope,listener)=>{callbacks.push(listener);const ordinal=callbacks.length;return()=>{off++;if(ordinal===1)throw Error('Cleanup refused');};},snapshot:async scope=>{const current=f.owner.current();return scope.session===f.scope.session?current:{...current,scope,run:{...current.run,scope},items:[]};}}});
 try{
  await workspace.bind(f.scope);await workspace.bind(secondScope);const facade=workspace.entry(f.scope),other=workspace.entry(secondScope);facade.getSnapshot();other.getSnapshot();
  f.session.loseNext();await assert.rejects(workspace.answer(f.scope,prompt,{type:'copilot.question',answer:'private',wasFreeform:true},'original').result);assert.equal(facade.getSnapshot().operations[0]?.state,'unknown');
  const next=f.register('userInput',{question:'Retained?',allowFreeform:true});callbacks[0]!(f.owner.current());const form=workspace.form(f.scope,next);form.update({answer:'PRIVATE_FORM'});
  const notices:unknown[]=[],formNotices:unknown[]=[];form.subscribe(()=>formNotices.push(facade.getSnapshot().snapshot));for(const entry of [facade,other])entry.subscribe(()=>notices.push({view:entry.getSnapshot(),form:form.getSnapshot()}));
  workspace.close();assert.equal(off,2);assert.deepEqual(notices,Array.from({length:2},()=>({view:{snapshot:null,connected:false,stale:true,operations:[]},form:{}})));assert.deepEqual(formNotices,[null]);assert.deepEqual(form.getSnapshot(),{});const cleared=facade.getSnapshot();assert.equal(facade.getSnapshot(),cleared);
  assert.throws(()=>facade.subscribe(()=>{}),error=>error instanceof Error&&'code'in error&&error.code==='CLOSED');callbacks[0]!(f.owner.current());assert.equal(facade.getSnapshot(),cleared);
 }finally{workspace.close();f.close();}
});

test('closing during initial read fences late completion without repopulating its cached facade',async()=>{
 const f=interactionFixture();let resolve!:(value:ReturnType<typeof f.owner.current>)=>void;
 const workspace=new InteractionWorkspace({session:f.session.port,port:{subscribe:()=>()=>{},snapshot:()=>new Promise(yes=>{resolve=yes;})}});
 const pending=workspace.bind(f.scope);await new Promise(yes=>setTimeout(yes,0));const facade=workspace.entry(f.scope),failed=assert.rejects(pending,error=>error instanceof Error&&'code'in error&&error.code==='CLOSED');
 workspace.close();resolve(f.owner.current());await failed;assert.deepEqual(facade.getSnapshot(),{snapshot:null,connected:false,stale:true,operations:[]});f.close();
});


test('response Activity rolls after native capability retirement while unknown answers remain protected', async () => {
  const f = interactionFixture();
  try {
    await f.bind(); const held = f.register('userInput', { question: 'Lost?', allowFreeform: true });
    f.session.loseNext(); await assert.rejects(f.answer(held, { type: 'copilot.question', answer: 'private-unknown', wasFreeform: true }, 'unknown').result);
    f.owner.completed(held.id, held.run);
    for (let i = 0; i < 140; i++) {
      const prompt = f.register('userInput', { question: 'Next?', allowFreeform: true });
      await f.answer(prompt, { type: 'copilot.question', answer: 'private-later', wasFreeform: true }, `answer-${i}`).result;
      f.owner.completed(prompt.id, prompt.run);
    }
    const view = f.workspace.entry(f.scope).getSnapshot(); assert.equal(view.operations.length, 33);
    assert.equal(view.operations.some(op => op.id === 'unknown' && op.state === 'unknown'), true);
    assert.equal(JSON.stringify(view).includes('private-later'), false);
    assert.equal((await f.workspace.checkReceipt(f.scope, 'unknown'))?.state, 'acknowledged');
    assert.equal(f.workspace.entry(f.scope).getSnapshot().operations.length, 32);
    assert.deepEqual(f.counts(), { submitted: 141, responses: 141 });
  } finally { f.close(); }
});
