import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setImmediate} from 'node:timers/promises';
import test from 'node:test';
import {bounded,providerGuard,until} from './support.mjs';

const proxyKey='scripted-model-proxy-credential-01234567890123456789';
const upstreamKey='scripted-private-upstream-credential';
const frame=(type,model,extra={})=>'event: '+type+'\r\ndata: '+JSON.stringify({type,response:{model,...extra}})+'\r\n\r\n';

test('actual upstream model proof is closed, fragmented, bounded and never changes response bytes', {timeout:20000},async()=>{
 const secret='private output α🦊, tool arguments, https://private.invalid/token';
 const created=model=>frame('response.created',model,{id:'private-response-id'});
 const completed=model=>frame('response.completed',model,{output:[{text:secret,arguments:'private-tool-arguments'}]});
 const misleading='data: '+JSON.stringify({type:'response.output_text.delta',delta:secret+' model=gpt-6-sol'})+'\n\n';
 const valid=created('gpt-6-luna')+misleading+completed('gpt-6-luna')+'data: [DONE]\n\n';
 const cases=[
  {bytes:valid,expected:'gpt-6-luna'},
  {bytes:created('gpt-6-sol')+completed('gpt-6-sol'),expected:'gpt-6-sol'},
  {bytes:created('gpt-6-luna')+completed('gpt-6-sol'),expected:null},
  {bytes:created('gpt-6-luna')+frame('response.completed',undefined),expected:null},
  {bytes:created('gpt-6-luna')+completed('https://private.invalid/model'),expected:null},
  {bytes:created('gpt-6-luna')+completed('gpt-6-luna').replace(secret,'x'.repeat(70000)),expected:null},
  {bytes:created('gpt-6-luna')+misleading,expected:null},
  // Actual codex-lb qualification exposed completed SSE labeled with another
  // MIME type. Model identity comes from validated frames, not that label.
  {bytes:created('gpt-6-luna')+completed('gpt-6-luna'),expected:'gpt-6-luna',type:'application/json'},
  {bytes:JSON.stringify({type:'response.completed',response:{model:'gpt-6-luna'}}),expected:null,type:'application/json'},
  {bytes:valid,expected:'gpt-6-luna',interrupt:true},
  {bytes:created('gpt-6-luna'),expected:null,interrupt:true},
 ];
 const requestBytes=Buffer.from(JSON.stringify({model:'gpt-6-luna',input:'private original request'}));
 const observed=[],evidence=[],requests=[],failures=[];let guard,upstream,admissions=0;
 try{
  upstream=createServer(async(req,res)=>{
   try{
    const index=requests.length,chunks=[];requests.push(null);
    for await(const chunk of req)chunks.push(chunk);
    requests[index]={bytes:Buffer.concat(chunks),authorization:req.headers.authorization};
    const current=cases[index],bytes=Buffer.from(current.bytes);
    res.writeHead(200,{'content-type':current.type??'text/event-stream; charset=utf-8'});
    // Small writes split event fields, JSON tokens and multibyte output. The
    // oversized frame uses larger fragments, so this stays a finite local test.
    for(let offset=0;offset<bytes.length;){const size=offset<1024?7:4096;res.write(bytes.subarray(offset,offset+size));offset+=size;await setImmediate()}
    if(current.interrupt){await new Promise(resolve=>{current.interruptNow=resolve});res.destroy()}else res.end();
   }catch(error){failures.push(error);res.destroy()}
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  guard=providerGuard({upstream:`http://127.0.0.1:${upstream.address().port}/v1`,key:upstreamKey,proxyKey,model:'gpt-6-luna',ledger:{provider(){admissions++}},onResponseModel:(model,facts)=>{observed.push(model);evidence.push(facts)}});
  const endpoint=await guard.listen();
  for(const [index,current]of cases.entries()){
   const response=await bounded(fetch(endpoint+'/responses',{method:'POST',headers:{authorization:`Bearer ${proxyKey}`},body:requestBytes}),3000,'local response');
   assert.equal(response.status,200);
   if(current.interrupt){
    // Establish exactly which bytes arrived before the connection fails. This
    // distinguishes a lost socket after an observed completion from a partial
    // response; timing guesses cannot decide model identity.
    const reader=response.body.getReader();let received=0;
    while(received<Buffer.byteLength(current.bytes)){const next=await bounded(reader.read(),3000,'pre-interrupt bytes');assert.equal(next.done,false);received+=next.value.length}
    await until(()=>typeof current.interruptNow==='function','interrupt barrier',3000);current.interruptNow();
    await assert.rejects(bounded(reader.read(),3000,'interrupted local body'));
   }
   else assert.deepEqual(Buffer.from(await bounded(response.arrayBuffer(),3000,'local body')),Buffer.from(current.bytes));
   await until(()=>observed.length===index+1,'local model observation',3000);
   assert.equal(observed[index],current.expected);
  }
  assert.deepEqual(failures,[]);assert.equal(admissions,cases.length);assert.equal(requests.length,cases.length);
  for(const request of requests){assert.deepEqual(request.bytes,requestBytes);assert.equal(request.authorization,'Bearer '+upstreamKey)}
  assert.equal(guard.stats.responsesPosts,cases.length);assert.equal(guard.stats.active,0);
  assert.deepEqual(observed,cases.map(current=>current.expected));
  assert.deepEqual(evidence[0],{streamSucceeded:true,eventStreamContentType:true,framesValid:true,completedEvent:true,modelObserved:true});
  assert.deepEqual(evidence[7],{streamSucceeded:true,eventStreamContentType:false,framesValid:true,completedEvent:true,modelObserved:true});
  assert.deepEqual(evidence[9],{streamSucceeded:false,eventStreamContentType:true,framesValid:true,completedEvent:true,modelObserved:true});
  assert.equal(evidence[10].completedEvent,false);
  for(const facts of evidence)assert.ok(Object.values(facts).every(value=>typeof value==='boolean'));
  const retained=JSON.stringify({observed,evidence,stats:guard.stats});
  for(const privateValue of [secret,'private original request','private-response-id','private-tool-arguments','private.invalid',upstreamKey,proxyKey])assert.equal(retained.includes(privateValue),false);
 }finally{
  await guard?.close();
  if(upstream){upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve))}
 }
});
