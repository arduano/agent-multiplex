// Local fake endpoints/process only; this suite never invokes a native harness or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {providerGuard,NativeRpc} from './live/support.mjs';
async function fixture(terminal='response.completed') {
 let calls=0,authorization;
 const upstream=createServer(async(req,res)=>{for await(const chunk of req)void chunk;calls++;authorization=req.headers.authorization;res.writeHead(200,{'content-type':'text/event-stream'});res.end(`event: ${terminal}\ndata: ${JSON.stringify({type:terminal})}\n\n`);});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const guard=providerGuard(`http://127.0.0.1:${upstream.address().port}/v1`,'private-fixture-secret','gpt-6-luna',1),url=await guard.listen();
 return {guard,url,calls:()=>calls,authorization:()=>authorization,async close(){await guard.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));}};
}
const post=(url,model)=>fetch(url+'/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer dummy'},body:JSON.stringify({model,stream:true,input:'local fixture only'})});
test('live provider guard refuses another model/path before upstream and injects only its private upstream credential',async()=>{
 const f=await fixture();try {
  const rejected=await post(f.url,'unallowed-model');assert.equal(rejected.status,400);await rejected.text();assert.equal(f.calls(),0);
  const wrongPath=await fetch(f.url+'/not-responses');assert.equal(wrongPath.status,400);await wrongPath.text();assert.equal(f.calls(),0);
  const accepted=await post(f.url,'gpt-6-luna');assert.equal(accepted.status,200);await accepted.text();assert.equal(f.calls(),1);assert.equal(f.authorization(),'Bearer private-fixture-secret');
  assert.equal(f.guard.stats.rejectedModels,1);assert.equal(f.guard.stats.completed,1);assert.equal(f.guard.stats.active,0);
  const exhausted=await post(f.url,'gpt-6-luna');assert.equal(exhausted.status,400);await exhausted.text();assert.equal(f.calls(),1);
 }finally{await f.close();}
});
test('live provider accounting distinguishes terminal inference failure from a clean transport end',async()=>{
 const f=await fixture('response.incomplete');try{const response=await post(f.url,'gpt-6-luna');await response.text();assert.equal(f.guard.stats.completed,0);assert.equal(f.guard.stats.failedOrIncomplete,1);assert.equal(f.guard.stats.active,0);}finally{await f.close();}
});
test('owned stdio RPC shutdown observes exact fake process exit and refuses later requests',async()=>{
 const script=`let text='';process.stdin.on('data',chunk=>{text+=chunk;for(;;){const n=text.indexOf('\\n');if(n<0)break;const m=JSON.parse(text.slice(0,n));text=text.slice(n+1);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{echo:m.method}})+'\\n');}});process.stdin.on('end',()=>process.exit(0));`;
 const rpc=new NativeRpc({binary:process.execPath,args:['-e',script],workspace:process.cwd(),environment:process.env,onNotification:()=>{}});
 assert.deepEqual(await rpc.request('fixture/echo'),{echo:'fixture/echo'});assert.equal((await rpc.close()).code,0);
 await assert.rejects(rpc.request('after/close'));assert.equal(rpc.readonlyCounts.requests['fixture/echo'],1);
});
