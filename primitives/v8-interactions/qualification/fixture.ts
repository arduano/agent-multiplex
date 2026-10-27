import { scopeKey, type Receipt, type SessionPort, type Submit } from "../../v8-session/src/contracts/types.js";
import { canonical, copy, check } from "../../v8-session/src/contracts/validation.js";
import { InteractionOwner } from "../src/owner.js";
import { InteractionWorkspace } from "../src/client.js";
import type { InteractionPort, Json, NativeAnswer, Prompt, RunRef } from "../src/contracts.js";
export const scope={connection:"fixture",principal:"viewer",host:"scripted",session:"a"};
export const run:RunRef={scope,generation:1,nativeSession:"root-a"};
/** Scripted transport-only fixture. No durability or actual native acceptance claim. */
export function sessionFixture(owner:InteractionOwner){
 const receipts=new Map<string,Receipt>(),originals=new Map<string,string>();let submitted=0,lose=false;
 const port:SessionPort={snapshot:async()=>{throw new Error("Not used by interaction client");},subscribe:()=>()=>{},receipt:async(value,id)=>{check(scopeKey(value)===scopeKey(scope));return receipts.get(id)??null;},submit:async(request:Submit)=>{
  check(scopeKey(request.scope)===scopeKey(scope));const meaning=canonical(request);if(originals.has(request.id)){check(originals.get(request.id)===meaning);return receipts.get(request.id)!;}originals.set(request.id,meaning);submitted++;check(request.command.type==="answer");
  const base={scope:request.scope,id:request.id,type:"answer" as const,generation:request.generation};receipts.set(request.id,copy({...base,state:"dispatched"}));
  try{const outcome=await owner.invoke(request.command),receipt:Receipt=copy({...base,state:outcome.status==="refused"||outcome.status==="targetUnavailable"?"refused":"acknowledged",outcome});receipts.set(request.id,receipt);if(lose){lose=false;throw new Error("Fixture lost reply after original acknowledged");}return receipt;}catch(error){if(receipts.get(request.id)?.state==="dispatched")receipts.set(request.id,copy({...base,state:"outcomeUnknown"}));throw error;}
 }};
 return{port,receipts,counts:()=>({submitted}),loseNext:()=>{lose=true;}};
}
export function interactionFixture(){
 const owner=new InteractionOwner({run,kind:"copilot",epoch:1});owner.certifyBaseline({run,complete:true,continuous:true});const session=sessionFixture(owner);let connected=true;const listeners=new Set<(snapshot:Awaited<ReturnType<InteractionPort["snapshot"]>>)=>void>();
 const readPort:InteractionPort={snapshot:async value=>owner.snapshot(value),subscribe:(value,listener)=>{listeners.add(listener);const unsub=owner.subscribe(value,event=>{if(connected)listener(event);});return()=>{listeners.delete(listener);unsub();};}};
 const workspace=new InteractionWorkspace({port:readPort,session:session.port});let responses=0,lastPrivate:string|null=null;
 const register=(method:"permission"|"userInput"|"elicitation",payload:unknown):Prompt=>owner.registerCopilot({token:{},requestId:method==="permission"?`permission-${owner.current().revision}`:null,owner:{nativeAgent:run.nativeSession,relation:"root"},method,payload,respond:async native=>{responses++;if(method==="userInput")lastPrivate=(native as Record<string,Json>).answer as string;return{kind:"ack",success:true};}});
 return{owner,workspace,session,scope,register,async bind(){await workspace.bind(scope);},connect(value:boolean){connected=value;workspace.setConnected(scope,value);},counts:()=>({...session.counts(),responses}),lastPrivate:()=>lastPrivate,answer(prompt:Prompt,answer:NativeAnswer,id:string){return workspace.answer(scope,prompt,answer,id);},close(){workspace.close();owner.retire();}};
}
