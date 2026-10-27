import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import test from 'node:test';
import {providerGuard,responsesRequestFacts} from './support.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJzsAAAAASUVORK5CYII=','base64');
const digest=value=>({byteLength:Buffer.byteLength(value),sha256:createHash('sha256').update(value).digest('hex')});
const proxyKey='scripted-proxy-credential-01234567890123456789';

test('Responses observer sees closed image/tool/current-user facts without changing forwarded bytes or admitted headers',async()=>{
 let guard,upstream,calls=0,admissions=0;const sequence=[],observed=[];
 const text='Current private fixture text — exact bytes';
 const payload={model:'gpt-6-luna',input:[{role:'user',content:'Prior private text'},{role:'assistant',content:[{type:'output_text',text:'Older private output'}]},{role:'user',content:[{type:'input_text',text},{type:'input_image',image_url:'data:image/png;base64,'+png.toString('base64')},{type:'input_image',image_url:'https://private.example/secret.png'},{type:'input_image',file_id:'opaque-private-file'},{type:'input_image',image_url:'data:image/png;base64,invalid'}]}],tools:[{type:'function',name:'request_user_input',description:'private tool documentation',parameters:{secret:'private schema'}},{type:'namespace',name:'functions',tools:[{type:'function',name:'exec_command'},{type:'function',name:'task'}]},{type:'function',function:{name:'ask_user'}},{type:'custom',name:'bash'},{type:'custom',name:'spawn_agent'},{type:'function',name:'unreported-private-tool'}]};
 const bytes=Buffer.from(JSON.stringify(payload,null,1)+'\n');
 const headers={'content-type':'application/json',accept:'text/event-stream','openai-beta':'fixture-beta','x-codex-turn-metadata':'private metadata','session_id':'private session','x-codex-session-id':'private codex session','x-openai-internal-codex-responses-lite':'true'};
 try{
  upstream=createServer(async(req,res)=>{
   calls++;sequence.push('upstream');const chunks=[];for await(const chunk of req)chunks.push(chunk);
   assert.deepEqual(Buffer.concat(chunks),bytes);
   assert.equal(req.headers.authorization,'Bearer scripted-upstream-secret');
   assert.equal(Number(req.headers['content-length']),bytes.length);
   for(const[name,value]of Object.entries(headers))assert.equal(req.headers[name],value);
   res.writeHead(200,{'content-type':'text/event-stream'}).end('data: {"type":"response.completed"}\n\n');
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  guard=providerGuard({upstream:`http://127.0.0.1:${upstream.address().port}/v1`,key:'scripted-upstream-secret',proxyKey,model:'gpt-6-luna',ledger:{provider(){admissions++;sequence.push('admit')}},onResponses:async facts=>{
   sequence.push('observe');assert.equal(admissions,1);observed.push(facts);
   assert.ok(Object.isFrozen(facts)&&Object.isFrozen(facts.inputImages)&&Object.isFrozen(facts.inputImages.inlinePng)&&Object.isFrozen(facts.inputImages.inlinePng[0])&&Object.isFrozen(facts.tools)&&Object.isFrozen(facts.lastUserInput.fragments));
   assert.throws(()=>{facts.inputImages.inlinePng[0].byteLength=0});
  }});
  const endpoint=await guard.listen();
  const send=(body,authorization=proxyKey)=>fetch(endpoint+'/responses',{method:'POST',headers:{...headers,authorization:`Bearer ${authorization}`},body});
  assert.equal((await send(bytes,'wrong-credential')).status,401);
  assert.equal((await send('{"model":"not-allowed"}')).status,400);
  assert.equal(admissions,0);assert.equal(observed.length,0);assert.equal(calls,0);
  const reply=await send(bytes);assert.equal(reply.status,200);await reply.text();
  assert.deepEqual(sequence,['admit','observe','upstream']);
  assert.deepEqual(observed,[{inputImages:{count:4,inlinePng:[digest(png)],opaque:2,unsupported:1,omittedInlinePng:0},tools:{count:7,request_user_input:true,ask_user:true,bash:true,exec_command:true,task:true,spawn_agent:true},lastUserInput:{fragments:[digest(text)],omittedFragments:0},responsesLite:true}]);
  const summary=JSON.stringify(observed);
  for(const secret of [text,'Prior private text','Older private output','private.example','opaque-private-file','private tool documentation','private schema','unreported-private-tool',png.toString('base64'),'scripted-upstream-secret','private metadata','private session'])assert.equal(summary.includes(secret),false);
  assert.equal(guard.stats.responsesPosts,1);assert.equal(guard.stats.completed,1);assert.equal(guard.stats.active,0);
 }finally{await guard?.close();if(upstream)await new Promise(resolve=>upstream.close(resolve))}
});

test('Responses observer rejection consumes admission but creates no upstream request or active forwarding owner',async()=>{
 let guard,upstream,admissions=0,calls=0,observations=0;
 try{
  upstream=createServer((req,res)=>{calls++;req.resume();res.end()});await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  guard=providerGuard({upstream:`http://127.0.0.1:${upstream.address().port}/v1`,key:'scripted-upstream-secret',proxyKey,model:'gpt-6-luna',ledger:{provider(){admissions++}},onResponses:async facts=>{observations++;assert.equal(admissions,1);assert.equal(facts.responsesLite,false);assert.equal(facts.inputImages.count,0);assert.equal(facts.tools.spawn_agent,true);await Promise.resolve();throw Error('Private observer failure must not be exposed')}});
  const endpoint=await guard.listen(),reply=await fetch(endpoint+'/responses',{method:'POST',headers:{authorization:`Bearer ${proxyKey}`},body:'{"model":"gpt-6-luna","input":"private fixture","tools":[{"type":"namespace","name":"functions","tools":[{"type":"function","name":"spawn_agent"}]}]}'});
  assert.equal(reply.status,400);assert.equal(await reply.text(),'Finite provider guard refused request');
  assert.equal(admissions,1);assert.equal(observations,1);assert.equal(calls,0);assert.equal(guard.stats.responsesPosts,0);assert.equal(guard.stats.active,0);assert.equal(guard.stats.failed,1);
 }finally{await guard?.close();if(upstream)await new Promise(resolve=>upstream.close(resolve))}
});

test('Responses facts bound PNG digests and current-user fragments without treating arguments as offered tools or images',()=>{
 const parts=Array.from({length:70},()=>({type:'input_image',image_url:'data:image/png;base64,'+png.toString('base64')}));
 parts.push({type:'input_image',image_url:'data:image/png;base64,a==='},{type:'input_image',image_url:'data:image/png;base64,'+Buffer.from('not a PNG').toString('base64')},{type:'input_image',image_url:'data:image/jpeg;base64,AAAA'},{type:'input_image'});
 const texts=Array.from({length:20},(_,index)=>'private fragment '+index);
 const facts=responsesRequestFacts({input:[{role:'user',content:'old private text'},{type:'function_call',arguments:{type:'input_image',image_url:'do not inspect arguments'}},{role:'user',content:[...parts,...texts.map(text=>({type:'input_text',text}))]}],tools:[{type:'function',name:'different',parameters:{name:'ask_user',tools:[{type:'function',name:'bash'}]}}]});
 assert.equal(facts.inputImages.count,74);assert.equal(facts.inputImages.inlinePng.length,64);assert.equal(facts.inputImages.omittedInlinePng,6);assert.equal(facts.inputImages.unsupported,4);assert.equal(facts.inputImages.opaque,0);
 assert.deepEqual(facts.lastUserInput,{fragments:texts.slice(-16).map(digest),omittedFragments:4});
 assert.deepEqual(facts.tools,{count:1,request_user_input:false,ask_user:false,bash:false,exec_command:false,task:false,spawn_agent:false});
 assert.deepEqual(responsesRequestFacts({input:'scalar user text'}).lastUserInput,{fragments:[digest('scalar user text')],omittedFragments:0});
 assert.equal(responsesRequestFacts({input:[{role:'assistant',content:'not a user input'}]}).lastUserInput,null);
});

test('pinned Codex Lite developer declarations expose only closed tool facts and reject forbidden spawn before upstream dispatch',async()=>{
 const payload={model:'gpt-6-luna',input:[
  {type:'additional_tools',role:'developer',tools:[{type:'namespace',name:'functions',description:'private namespace text',tools:[{type:'function',name:'exec_command',parameters:{secret:'private schema',tools:[{type:'function',name:'task'}]}},{type:'custom',name:'spawn_agent',format:{definition:'private grammar'}}]},{type:'function',name:'private-other-tool'}]},
  {type:'message',role:'developer',tools:[{type:'function',name:'task'}],content:'private prompt pretending to declare tools'},
  {type:'additional_tools',role:'user',tools:[{type:'function',name:'bash'}]},
  {type:'function_call',arguments:{type:'additional_tools',role:'developer',tools:[{type:'function',name:'ask_user'}]}},
  {type:'message',role:'user',content:[{type:'input_text',text:'current private user text'},{type:'input_image',image_url:'data:image/png;base64,'+png.toString('base64')}]},
 ]};
 const facts=responsesRequestFacts(payload);
 assert.deepEqual(facts.tools,{count:3,request_user_input:false,ask_user:false,bash:false,exec_command:true,task:false,spawn_agent:true});
 assert.deepEqual(facts.inputImages,{count:1,inlinePng:[digest(png)],opaque:0,unsupported:0,omittedInlinePng:0});
 assert.deepEqual(facts.lastUserInput,{fragments:[digest('current private user text')],omittedFragments:0});
 const summary=JSON.stringify(facts);for(const secret of ['private namespace text','private schema','private grammar','private-other-tool','private prompt pretending','current private user text',png.toString('base64')])assert.equal(summary.includes(secret),false);
 let guard,upstream,calls=0,admissions=0;
 try{
  upstream=createServer((req,res)=>{calls++;req.resume();res.end()});await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  guard=providerGuard({upstream:`http://127.0.0.1:${upstream.address().port}/v1`,key:'scripted-upstream-secret',proxyKey,model:'gpt-6-luna',ledger:{provider(){admissions++}},onResponses:observed=>{assert.equal(observed.tools.exec_command,true);assert.equal(observed.tools.spawn_agent,false,'Child tools outside finite allowance')}});
  const endpoint=await guard.listen(),reply=await fetch(endpoint+'/responses',{method:'POST',headers:{authorization:`Bearer ${proxyKey}`},body:JSON.stringify(payload)});
  assert.equal(reply.status,400);assert.equal(await reply.text(),'Finite provider guard refused request');
  assert.equal(admissions,1);assert.equal(calls,0);assert.equal(guard.stats.responsesPosts,0);assert.equal(guard.stats.active,0);
 }finally{await guard?.close();if(upstream)await new Promise(resolve=>upstream.close(resolve))}
});

test('closing the guard during a held observer cannot create a late upstream request',async()=>{
 let guard,upstream,calls=0,admissions=0,release,entered;
 const observed=new Promise(resolve=>{entered=resolve}),held=new Promise(resolve=>{release=resolve});
 try{
  upstream=createServer((req,res)=>{calls++;req.resume();res.end()});await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  guard=providerGuard({upstream:`http://127.0.0.1:${upstream.address().port}/v1`,key:'scripted-upstream-secret',proxyKey,model:'gpt-6-luna',ledger:{provider(){admissions++}},onResponses:async facts=>{assert.equal(facts.responsesLite,false,'Only the exact true header proves Lite mode');entered();await held}});
  const endpoint=await guard.listen(),reply=fetch(endpoint+'/responses',{method:'POST',headers:{authorization:`Bearer ${proxyKey}`,'x-openai-internal-codex-responses-lite':'TRUE'},body:'{"model":"gpt-6-luna","input":"private fixture","tools":[{"type":"namespace","name":"functions","tools":[{"type":"function","name":"spawn_agent"}]}]}'}).catch(()=>null);
  await observed;await guard.close();release();await reply;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(admissions,1);assert.equal(calls,0);assert.equal(guard.stats.responsesPosts,0);assert.equal(guard.stats.active,0);assert.equal(guard.stats.failed,1);
 }finally{release?.();await guard?.close();if(upstream)await new Promise(resolve=>upstream.close(resolve))}
});
