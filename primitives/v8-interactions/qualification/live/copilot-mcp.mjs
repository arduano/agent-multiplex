import {createInterface} from 'node:readline';
/** Actual local MCP server. Its outgoing elicitation request must travel through the native runtime. */
let serial=100,frames=0,initialized=false,clientElicitationCapability=false;const pending=new Map();
const write=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
async function dispatch(message){
 if(++frames>128)throw Error('FIXTURE_FRAME_BOUND');
 if(message.id!==undefined&&!message.method){const p=pending.get(message.id);if(p){clearTimeout(p.timer);pending.delete(message.id);message.error?p.reject(Error('NATIVE_ELICITATION_ERROR')):p.resolve(message.result);}return;}
 if(message.method==='initialize'){clientElicitationCapability=!!message.params?.capabilities?.elicitation;write({id:message.id,result:{protocolVersion:message.params?.protocolVersion??'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'v8_copilot_interactions',version:'0.0.0'}}});return;}
 if(message.method==='notifications/initialized'){initialized=true;return;}
 if(message.method==='ping'){write({id:message.id,result:{}});return;}
 if(message.method==='tools/list'){write({id:message.id,result:{tools:[{name:'v8_interaction_form',description:'Request the one harmless V8 structured form and report its synthetic choice.',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}});return;}
 if(message.method==='tools/call'){
  if(!initialized||message.params?.name!=='v8_interaction_form'||pending.size)throw Error('FIXTURE_UNSUPPORTED_CALL');
  const id=serial++,result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('FIXTURE_RESPONSE_DEADLINE'));},90000);pending.set(id,{resolve,reject,timer});write({id,method:'elicitation/create',params:{mode:'form',message:'V8 Copilot harmless structured confirmation',requestedSchema:{type:'object',properties:{choice:{type:'string',enum:['fixture-choice']},count:{type:'integer',minimum:1,maximum:1},confirmed:{type:'boolean'}},required:['choice','count','confirmed']}}});});
  const valid=result?.action==='accept'&&result.content?.choice==='fixture-choice'&&result.content?.count===1&&result.content?.confirmed===true;
  write({id:message.id,result:{content:[{type:'text',text:valid?'V8_COPILOT_FORM_OK':'V8_COPILOT_FORM_NOT_ACCEPTED'}],structuredContent:{action:result?.action??null,valid,clientElicitationCapability},isError:!valid}});return;
 }
 if(message.id!==undefined)write({id:message.id,error:{code:-32601,message:'Unknown disposable fixture method'}});
}
createInterface({input:process.stdin}).on('line',line=>{if(line.length>65536){process.stdin.destroy();return;}let message;try{message=JSON.parse(line);}catch{process.stdin.destroy();return;}void dispatch(message).catch(()=>{if(message.id!==undefined)write({id:message.id,error:{code:-32000,message:'Disposable MCP request failed'}});});});
process.stdin.on('end',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('FIXTURE_CLOSED'));}pending.clear();});
