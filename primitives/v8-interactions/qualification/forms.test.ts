import assert from "node:assert/strict";
import test from "node:test";
import { InteractionWorkspace } from "../src/client.js";
import { interactionFixture } from "./fixture.js";
import type { InteractionSnapshot } from "../src/contracts.js";
import type { Receipt } from "../../v8-session/src/contracts/types.js";

test("exact private form drafts survive A/B/dismiss/offline, stay outside public snapshots, and scrub old handles on native retirement/auth close",async()=>{
  const f=interactionFixture();try{
    await f.bind();const a=f.register("userInput",{question:"A?",allowFreeform:true}),b=f.register("userInput",{question:"B?",allowFreeform:true});
    const first=f.workspace.form(f.scope,a),second=f.workspace.form(f.scope,b),values={answer:"FORM_A_PRIVATE",selected:["private-selection"],enabled:true};
    first.update(values);values.selected[0]="mutated caller";second.update({answer:"FORM_B_PRIVATE"});
    assert.equal(f.workspace.form(f.scope,a),first);assert.equal(first.getSnapshot(),first.getSnapshot());assert.deepEqual(first.getSnapshot(),{answer:"FORM_A_PRIVATE",selected:["private-selection"],enabled:true});
    const detach=first.subscribe(()=>{});detach();f.connect(false);first.update({...first.getSnapshot(),answer:"FORM_OFFLINE_PRIVATE"});f.connect(true);await f.workspace.refresh(f.scope);
    assert.equal(first.getSnapshot().answer,"FORM_OFFLINE_PRIVATE");assert.equal(second.getSnapshot().answer,"FORM_B_PRIVATE");
    const view=f.workspace.entry(f.scope).getSnapshot();assert.equal(JSON.stringify(view).includes("FORM_"),false);assert.deepEqual(f.counts(),{submitted:0,responses:0});
    let retired=0;first.subscribe(()=>{retired++;assert.deepEqual(first.getSnapshot(),{});});f.owner.completed(a.id,a.run);
    assert.equal(retired,1);assert.deepEqual(first.getSnapshot(),{});assert.throws(()=>first.update({answer:"revive"}),error=>error instanceof Error&&"code"in error&&error.code==="FENCED");assert.throws(()=>f.workspace.form(f.scope,a));
    const replacement=f.register("userInput",{question:"A?",allowFreeform:true});assert.notEqual(replacement.id,a.id);assert.deepEqual(f.workspace.form(f.scope,replacement).getSnapshot(),{});assert.equal(second.getSnapshot().answer,"FORM_B_PRIVATE");
    let closed=0;second.subscribe(()=>{closed++;assert.deepEqual(second.getSnapshot(),{});});f.workspace.close();assert.equal(closed,1);assert.deepEqual(second.getSnapshot(),{});assert.throws(()=>second.update({answer:"closed"}));
  }finally{f.close();}
});

test("private form count/per-form UTF8/aggregate bounds refuse atomically and native removal releases exact capacity",async()=>{
  const f=interactionFixture();try{
    await f.bind();const prompts=Array.from({length:17},(_,i)=>f.register("userInput",{question:`Question${i}?`,allowFreeform:true})),forms=prompts.slice(0,16).map(prompt=>f.workspace.form(f.scope,prompt));
    assert.throws(()=>f.workspace.form(f.scope,prompts[16]!),error=>error instanceof Error&&"code"in error&&error.code==="FULL");
    for(const form of forms.slice(0,4))form.update({text:"x".repeat(31*1024)});
    assert.throws(()=>forms[4]!.update({text:"x".repeat(5*1024)}),error=>error instanceof Error&&"code"in error&&error.code==="FULL");assert.deepEqual(forms[4]!.getSnapshot(),{});
    const old=forms[0]!.getSnapshot();assert.throws(()=>forms[0]!.update({text:"é".repeat(17_000)}));assert.equal(forms[0]!.getSnapshot(),old);
    assert.throws(()=>forms[0]!.update({choices:new Array<string>(2)}));assert.equal(forms[0]!.getSnapshot(),old);
    f.owner.completed(prompts[0]!.id,prompts[0]!.run);assert.deepEqual(forms[0]!.getSnapshot(),{});forms[4]!.update({text:"x".repeat(5*1024)});assert.deepEqual(f.workspace.form(f.scope,prompts[16]!).getSnapshot(),{});
    f.owner.retire();for(const form of forms)assert.deepEqual(form.getSnapshot(),{});assert.throws(()=>f.workspace.form(f.scope,prompts[1]!));
  }finally{f.close();}
});

test("submitted/unknown originals clear drafts and block duplicate answers; replacement handles and stronger terminal receipt observations remain exact",async()=>{
  const f=interactionFixture();let snapshot:InteractionSnapshot=f.owner.current();let observe:((value:InteractionSnapshot)=>void)|undefined,submits=0;
  let rejectHeld:((error:Error)=>void)|undefined,terminal:Receipt|null=null;
  const workspace=new InteractionWorkspace({port:{snapshot:async()=>snapshot,subscribe:(_scope,listener)=>{observe=listener;return()=>{};}},session:{...f.session.port,receipt:async(_scope,id)=>id==="lookup-first"?terminal:null,submit:async request=>{submits++;if(request.id==="lookup-first")return new Promise<Receipt>((_resolve,reject)=>{rejectHeld=reject;});throw Error("lost reply");}}});
  try{
    const prompt=f.register("userInput",{question:"Private?",allowFreeform:true});snapshot=f.owner.current();await workspace.bind(f.scope);const form=workspace.form(f.scope,prompt);form.update({answer:"UNOBSERVED_PRIVATE"});let scrubbed=0;form.subscribe(()=>{scrubbed++;});
    const response=workspace.answer(f.scope,prompt,{type:"copilot.question",answer:"UNOBSERVED_PRIVATE",wasFreeform:true},"original");assert.deepEqual(form.getSnapshot(),{});await assert.rejects(response.result);
    assert.equal(scrubbed,1);assert.equal(workspace.entry(f.scope).getSnapshot().operations[0]?.state,"unknown");assert.throws(()=>workspace.form(f.scope,prompt));assert.throws(()=>workspace.answer(f.scope,prompt,{type:"copilot.question",answer:"again",wasFreeform:true},"replacement"));assert.equal(submits,1);
    const changed={...prompt,run:{...prompt.run,generation:2}},next:InteractionSnapshot={...snapshot,run:changed.run,epoch:0,revision:0,items:[{prompt:changed,state:"pending"}]};observe!(next);const current=workspace.form(f.scope,changed);current.update({answer:"NEW_PRIVATE"});assert.deepEqual(form.getSnapshot(),{});assert.throws(()=>form.update({answer:"old"}));assert.throws(()=>workspace.form(f.scope,prompt));assert.equal(current.getSnapshot().answer,"NEW_PRIVATE");
    observe!({...next,revision:1,items:[{prompt:changed,state:"responseSubmitted"}]});assert.deepEqual(current.getSnapshot(),{});assert.throws(()=>current.update({answer:"submitted"}));assert.equal(JSON.stringify(workspace.entry(f.scope).getSnapshot()).includes("NEW_PRIVATE"),false);
    const last={...changed,run:{...changed.run,generation:3}};observe!({...next,run:last.run,revision:0,items:[{prompt:last,state:"pending"}]});
    const held=workspace.answer(f.scope,last,{type:"copilot.question",answer:"definite refusal",wasFreeform:true},"lookup-first");terminal={scope:f.scope,id:"lookup-first",type:"answer",generation:3,state:"refused"};await workspace.checkReceipt(f.scope,"lookup-first");rejectHeld!(Error("late lost reply"));await assert.rejects(held.result);
    const marker=workspace.entry(f.scope).getSnapshot().operations.find(op=>op.id==="lookup-first");assert.equal(marker?.state,"observed");assert.equal(marker?.receipt?.state,"refused");
    const retry=workspace.answer(f.scope,last,{type:"copilot.question",answer:"explicit new intent after definite refusal",wasFreeform:true},"lookup-retry");await assert.rejects(retry.result);assert.equal(submits,3);
  }finally{workspace.close();f.close();}
});
