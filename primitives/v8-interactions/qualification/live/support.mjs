import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {writeFileSync,readFileSync,unlinkSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {StringDecoder} from 'node:string_decoder';

export async function bounded(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`LIVE_DEADLINE:${label}`)),ms)})]);}finally{clearTimeout(timer)}}
export async function until(predicate,label,ms=120000){const end=Date.now()+ms;while(Date.now()<end){const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error(`LIVE_DEADLINE:${label}`)}

/** Single nonrenewable local allowance. Admission precedes dispatch, including provider POSTs. */
export function allowanceLedger(path,initial,{resumeId}={}){
  const state=resumeId?JSON.parse(readFileSync(path,'utf8')):structuredClone(initial);
  if(resumeId){assert.equal(state.id,resumeId,'Different finite allowance');assert.ok(!['running','closing'].includes(state.status),'Prior allowance still owns work');assert.ok(Date.now()<state.deadline,'Original allowance expired')}
  let active=true;
  const save=()=>{writeFileSync(path,JSON.stringify(state,null,2)+'\n',{mode:0o600});const fd=openSync(path,'r');try{fsyncSync(fd)}finally{closeSync(fd)}};
  const ceiling={'codex-root':4,'codex-child':1,'copilot-root':4,'copilot-child':1,'codex-native':16,'copilot-native':16};
  const limit=Object.freeze({...state.limits??ceiling}),providerLimit=state.maxProviderPosts??40;
  assert.deepEqual(Object.keys(limit).sort(),Object.keys(ceiling).sort(),'Complete immutable allowance limits required');
  for(const key of Object.keys(ceiling))assert.ok(Number.isSafeInteger(limit[key])&&limit[key]>=0&&limit[key]<=ceiling[key],'Finite allowance limit outside ceiling');
  assert.ok(Number.isSafeInteger(providerLimit)&&providerLimit>=0&&providerLimit<=40,'Finite provider limit outside ceiling');
  assert.ok(Number.isSafeInteger(state.deadline)&&state.deadline>0,'Invalid finite allowance deadline');
  assert.ok(Number.isSafeInteger(state.providerPosts)&&state.providerPosts>=0&&state.providerPosts<=providerLimit,'Invalid finite provider counter');
  assert.ok(Array.isArray(state.admissions),'Invalid finite admissions');const originals=new Set();
  for(const entry of state.admissions){assert.ok(Object.hasOwn(limit,entry.kind)&&typeof entry.scenario==='string'&&entry.scenario.length>0&&entry.scenario.length<=160,'Invalid finite admission');const original=JSON.stringify([entry.kind,entry.scenario]);assert.ok(!originals.has(original),'Duplicate original admission');originals.add(original)}
  for(const kind of Object.keys(limit))assert.ok(state.admissions.filter(entry=>entry.kind===kind).length<=limit[kind],'Invalid finite admission count');
  const lock=path+'.lock',lockFd=openSync(lock,'wx',0o600);closeSync(lockFd);
  if(!resumeId){try{const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,JSON.stringify(state,null,2)+'\n');fsyncSync(fd)}finally{closeSync(fd)}}catch(error){unlinkSync(lock);throw error}}
  else{state.status='running';save()}
  return {
    get state(){return structuredClone(state)},
    admit(kind,scenario){
      assert.ok(active,'Finite allowance already closed');
      assert.ok(Object.hasOwn(limit,kind),'Unknown allowance kind');
      assert.ok(typeof scenario==='string'&&scenario.length>0&&scenario.length<=160,'Unique scenario required');
      assert.ok(Date.now()<state.deadline,'Finite live allowance expired');
      assert.ok(!state.admissions.some(value=>value.kind===kind&&value.scenario===scenario),'Original live scenario cannot replay');
      assert.ok(state.admissions.filter(value=>value.kind===kind).length<limit[kind],`LIVE_ALLOWANCE_EXHAUSTED:${kind}`);
      state.admissions.push({kind,scenario,at:new Date().toISOString()});save();
    },
    provider(){assert.ok(active,'Finite allowance already closed');assert.ok(Date.now()<state.deadline,'Finite allowance expired');assert.ok(state.providerPosts<providerLimit,'LIVE_PROVIDER_ALLOWANCE_EXHAUSTED');state.providerPosts++;save()},
    seal(){active=false;state.status='closing';save()},
    complete(status){active=false;state.status=status;state.completedAt=new Date().toISOString();save();unlinkSync(lock)},
  };
}

/** Qualification-only projection. No input text, tool name, argument, URL or
 * credential is handed to observers. Input bytes remain private and unchanged. */
export function responsesRequestFacts(body){
  const digest=value=>Object.freeze({byteLength:Buffer.byteLength(value),sha256:createHash('sha256').update(value).digest('hex')});
  const inputImages={count:0,inlinePng:[],opaque:0,unsupported:0,omittedInlinePng:0};
  const tools={count:0,request_user_input:false,ask_user:false,bash:false,exec_command:false,task:false,spawn_agent:false};
  const pending=Array.isArray(body?.tools)?[...body.tools]:[];
  let lastUserTexts=null;
  const image=part=>{
    inputImages.count++;
    if(typeof part.image_url!=='string'){
      if(typeof part.file_id==='string'&&part.file_id.length>0)inputImages.opaque++;
      else inputImages.unsupported++;
      return;
    }
    const url=part.image_url;
    if(!url.startsWith('data:')){if(url.length>0)inputImages.opaque++;else inputImages.unsupported++;return}
    const prefix='data:image/png;base64,',encoded=url.startsWith(prefix)?url.slice(prefix.length):null;
    if(encoded===null||encoded.length===0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)){inputImages.unsupported++;return}
    const bytes=Buffer.from(encoded,'base64');
    if(bytes.toString('base64')!==encoded||bytes.length<8||!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))){inputImages.unsupported++;return}
    if(inputImages.inlinePng.length<64)inputImages.inlinePng.push(digest(bytes));else inputImages.omittedInlinePng++;
  };
  if(typeof body?.input==='string')lastUserTexts=[body.input];
  else if(Array.isArray(body?.input))for(const item of body.input){
    if(!item||typeof item!=='object'||Array.isArray(item))continue;
    // rust-v0.162.1 protocol/models.rs AdditionalTools (serde snake_case),
    // emitted as developer input by core/client.rs for Responses Lite.
    if(item.type==='additional_tools'&&item.role==='developer'&&Array.isArray(item.tools))pending.push(...item.tools);
    const content=item.content;
    if(Array.isArray(content))for(const part of content)if(part&&typeof part==='object'&&!Array.isArray(part)&&part.type==='input_image')image(part);
    if(item.role==='user')lastUserTexts=typeof content==='string'?[content]:Array.isArray(content)?content.filter(part=>part&&typeof part==='object'&&part.type==='input_text'&&typeof part.text==='string').map(part=>part.text):[];
  }
  // Namespace containers are not callable tools; inspect only their declared
  // children, never an arbitrary schema/description/argument object.
  for(let index=0;index<pending.length;index++){
    const tool=pending[index];
    if(tool&&typeof tool==='object'&&!Array.isArray(tool)&&tool.type==='namespace'&&Array.isArray(tool.tools)){for(const child of tool.tools)pending.push(child);continue}
    tools.count++;
    const name=tool?.type==='function'?(tool.name??tool.function?.name):tool?.type==='custom'?tool.name:null;
    if(typeof name==='string'&&Object.hasOwn(tools,name)&&name!=='count')tools[name]=true;
  }
  const lastUserInput=lastUserTexts===null?null:Object.freeze({fragments:Object.freeze(lastUserTexts.slice(-16).map(digest)),omittedFragments:Math.max(0,lastUserTexts.length-16)});
  return Object.freeze({inputImages:Object.freeze({...inputImages,inlinePng:Object.freeze(inputImages.inlinePng)}),tools:Object.freeze(tools),lastUserInput});
}

/** Bounded ephemeral SSE parsing. Only one model token (or unknown) leaves
 * this observer; output text, arguments, response IDs and raw frames do not. */
function responseModelProjection(observer){
  const decoder=new StringDecoder('utf8'),maximum=65536;
  let line='',data='',event='',size=0,discardLine=false,discardEvent=false,invalid=false,observed,completed=false,finished=false;
  const frame=()=>{
    if(!discardEvent&&data){
      const source=data.endsWith('\n')?data.slice(0,-1):data;
      if(source!=='[DONE]')try{
        const value=JSON.parse(source),type=value?.type;
        if(type==='response.created'||type==='response.completed'){
          const model=value.response?.model;
          if(event&&event!==type||typeof model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model))invalid=true;
          else if(observed!==undefined&&observed!==model)invalid=true;
          else{observed=model;if(type==='response.completed')completed=true}
        }else if(event==='response.created'||event==='response.completed')invalid=true;
      }catch{invalid=true}
    }else if(event==='response.created'||event==='response.completed')invalid=true;
    data='';event='';size=0;discardEvent=false;
  };
  const completeLine=()=>{
    if(discardLine){discardLine=false;line='';return}
    const value=line.endsWith('\r')?line.slice(0,-1):line;line='';
    if(value===''){frame();return}
    size+=value.length+1;
    if(size>maximum){invalid=true;discardEvent=true;data='';event='';return}
    if(discardEvent)return;
    if(value.startsWith('data:'))data+=value.slice(5).replace(/^ /,'')+'\n';
    else if(value.startsWith('event:'))event=value.slice(6).replace(/^ /,'');
  };
  return {
    push(chunk){
      if(finished)return;
      const text=decoder.write(chunk);let offset=0;
      while(offset<text.length){
        const end=text.indexOf('\n',offset),part=text.slice(offset,end<0?text.length:end);
        if(!discardLine){if(line.length+part.length>maximum){invalid=true;discardLine=true;discardEvent=true;line='';data='';event=''}else line+=part}
        if(end<0)break;completeLine();offset=end+1;
      }
    },
    finish(success,eventStreamContentType){
      if(finished)return;finished=true;
      if(decoder.end()||line||data||event||discardLine||discardEvent)invalid=true;
      // A fully observed native completion proves its model before the socket
      // closes. Later transport loss cannot erase that fact; partial or invalid
      // frames still cannot establish it. Keep connection outcome orthogonal.
      const model=!invalid&&completed&&observed!==undefined?observed:null;
      const evidence=Object.freeze({streamSucceeded:!!success,eventStreamContentType:!!eventStreamContentType,framesValid:!invalid,completedEvent:completed,modelObserved:observed!==undefined});
      line='';data='';event='';observed=undefined;
      // Observation cannot modify forwarding, expose private errors or create
      // an unhandled async rejection. It is not another admission gate.
      try{Promise.resolve(observer(model,evidence)).catch(()=>{})}catch{}
    },
  };
}

/** Exact model/route, response-body-free accounting, and no native/provider fallback.
 * An optional trusted observer sees only closed facts after finite admission;
 * onResponses also reports responsesLite only for the exact inbound true
 * header; rejection prevents upstream dispatch without refund. Optional
 * onResponseModel receives one actual upstream model token or null per forwarded
 * POST at settlement, with body-free framing/completion booleans as a
 * second diagnostic argument. Missing/conflicting/invalid/oversized completion
 * evidence is unknown. MIME and transport settlement are observed separately:
 * a fully observed, framed and consistent completion proves its model even if
 * the connection later fails or the stream's Content-Type is mislabeled.
 * Its callback cannot change forwarding or admission. */
export function providerGuard({upstream,key,proxyKey,model,ledger,onResponses,onResponseModel}){
  const base=new URL(upstream);assert.ok(['http:','https:'].includes(base.protocol)&&!base.username&&!base.password&&!base.search&&!base.hash);
  assert.ok(typeof proxyKey==='string'&&proxyKey.length>=32&&proxyKey!==key);
  assert.ok(onResponses===undefined||typeof onResponses==='function');
  assert.ok(onResponseModel===undefined||typeof onResponseModel==='function');
  const stats={responsesPosts:0,completed:0,failed:0,rejectedModels:0,rejectedPaths:0,rejectedAuth:0,active:0};
  const sockets=new Set(),requests=new Set();let closing;
  const server=createServer(async(req,res)=>{
    let accounted=false,forward,responseModel,modelStream=false;
    const finish=(success,modelSuccess=success)=>{if(accounted)return;accounted=true;stats.active--;if(success)stats.completed++;else stats.failed++;responseModel?.finish(modelSuccess,modelStream);if(forward)requests.delete(forward)};
    try{
      if(req.headers.authorization!==`Bearer ${proxyKey}`){stats.rejectedAuth++;res.writeHead(401).end('Finite proxy authentication required');return}
      if(req.method!=='POST'||!/^\/(?:v1\/)?responses$/.test(req.url??'')){stats.rejectedPaths++;res.writeHead(400).end('Outside finite route');return}
      const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;assert.ok(length<=2000000,'Provider request bound');chunks.push(chunk)}
      const bytes=Buffer.concat(chunks),body=JSON.parse(bytes.toString('utf8'));
      if(body.model!==model){stats.rejectedModels++;res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:{message:'Model outside live allowance'}}));return}
      ledger.provider();
      if(onResponses)await onResponses(Object.freeze({...responsesRequestFacts(body),responsesLite:req.headers['x-openai-internal-codex-responses-lite']==='true'}));
      assert.ok(closing===undefined&&!req.aborted&&!res.destroyed,'Finite provider observation retired');
      stats.responsesPosts++;stats.active++;
      if(onResponseModel)responseModel=responseModelProjection(onResponseModel);
      const target=new URL(base.href.replace(/\/$/,'')+'/responses');
      const headers={'content-type':'application/json',authorization:`Bearer ${key}`,'content-length':bytes.length};
      for(const name of ['accept','openai-beta','x-codex-turn-metadata','session_id','x-codex-session-id','x-openai-internal-codex-responses-lite'])if(typeof req.headers[name]==='string')headers[name]=req.headers[name];
      let terminal=false,bad=false,tail='';
      forward=(target.protocol==='https:'?httpsRequest:httpRequest)(target,{method:'POST',headers},response=>{
        modelStream=String(response.headers['content-type']??'').split(';',1)[0].trim().toLowerCase()==='text/event-stream';
        res.writeHead(response.statusCode??502,Object.fromEntries(Object.entries(response.headers).filter(([name])=>['content-type','cache-control'].includes(name))));
        response.on('data',chunk=>{const value=tail+chunk.toString('utf8');if(/"type"\s*:\s*"response.completed"/.test(value))terminal=true;if(/"type"\s*:\s*"response.(?:failed|incomplete)"/.test(value))bad=true;tail=value.slice(-4096);responseModel?.push(chunk)});
        response.pipe(res);response.on('end',()=>{tail='';finish(terminal&&!bad&&(response.statusCode??502)<400)});response.on('error',()=>{tail='';finish(terminal&&!bad,false);res.destroy()});
      });
      requests.add(forward);forward.setTimeout(120000,()=>forward.destroy(new Error('Finite provider deadline')));
      forward.on('error',()=>{tail='';finish(terminal&&!bad,false);if(!res.headersSent)res.writeHead(502).end('Finite provider forwarding failed');else res.destroy()});
      res.on('close',()=>{if(!res.writableEnded)forward.destroy()});forward.end(bytes);
    }catch{if(forward)finish(false);else stats.failed++;if(!res.headersSent)res.writeHead(400).end('Finite provider guard refused request');else res.destroy()}
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket))});
  return {stats,async listen(){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});return `http://127.0.0.1:${server.address().port}/v1`},close(){return closing??=(async()=>{for(const request of requests)request.destroy();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve))})()}};
}
