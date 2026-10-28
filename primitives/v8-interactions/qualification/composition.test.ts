import { copilotProtocol } from "../../v8-harness-copilot/src/protocol.js";
import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SessionHost} from "../../v8-lifecycle-default/src/session/index.js";
import type {NativePort,NativeRun,RunRef,SessionScope} from "../../v8-session/src/contracts/types.js";
import {InteractionOwner} from "../src/owner.js";
import {InteractionWorkspace} from "../src/client.js";
test("actual worker-SQLite SessionHost journals one original private answer and bridge preserves native acknowledgement semantics",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"v8-interactions-")),scope:SessionScope={connection:"c",principal:"p",host:"h",session:"logical"};let owner!:InteractionOwner,proofRun!:RunRef,calls=0;const secret="INTERACTION_PRIVATE_532af";
 const port:NativePort={kind:"copilot",protocol:copilotProtocol,placement:"shared",capabilities:{commands:["answer"],fullStop:true,reopen:true,createAndWait:true},catalog:async()=>({available:true,choices:[]}),inspect:async()=>null,start:async(input,emit)=>{
  const run:RunRef={scope:input.scope,generation:input.generation,nativeSession:"native"};proofRun=run;owner=new InteractionOwner({run,kind:"copilot",epoch:1});owner.certifyBaseline({run,complete:true,continuous:true});
  owner.registerCopilot({token:{},requestId:null,owner:{nativeAgent:"native",relation:"root"},method:"userInput",payload:{question:"Private?",allowFreeform:true},respond:async native=>{calls++;assert.deepEqual(native,{answer:secret,wasFreeform:true});return{kind:"ack",success:true};}});
  const native:NativeRun={run,selection:{kind:"copilot"},interactionsComplete:true,interactions:[],stop:async()=>({run,state:"stopped",scope:"nativeTree",noAutomaticContinuation:true}),invoke:async()=>{throw Error("No other calls");}};return owner.wrap({run:native,emit});
 }};
 const host=await SessionHost.open({directory,scope,port,policy:{kind:"copilot",provider:"copilot-only",permissions:"manual"},observationMs:30000});let workspace:InteractionWorkspace|undefined;
 try{
  assert.equal((await host.submit({scope,id:"create",generation:0,command:{type:"create"}})).state,"acknowledged");assert.equal((await host.snapshot(scope)).interactions.length,1);
  workspace=new InteractionWorkspace({port:owner,session:host});await workspace.bind(scope);const prompt=workspace.entry(scope).getSnapshot().snapshot!.items[0]!.prompt;
  const original=workspace.answer(scope,prompt,{type:"copilot.question",answer:secret,wasFreeform:true},"original");const receipt=await original.result;assert.equal(receipt.state,"acknowledged");assert.deepEqual(receipt.outcome,{status:"acknowledged"});assert.equal(calls,1);
  assert.equal((await host.receipt(scope,"original"))?.state,"acknowledged");assert.equal(JSON.stringify(workspace.entry(scope).getSnapshot()).includes(secret),false);
  assert.equal((await host.submit({scope,id:"stop",generation:proofRun.generation,command:{type:"stop"}})).state,"acknowledged");await host.close();
  const bytes=await readFile(join(directory,"session.sqlite"));assert.equal(bytes.includes(Buffer.from(secret)),false);
 }finally{workspace?.close();owner?.retire();await host.terminate();await rm(directory,{recursive:true,force:true});}
});
