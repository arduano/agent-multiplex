import assert from 'node:assert/strict';
import test from 'node:test';
import { McpOwner,McpReadPool,McpWorkspace,codexMcpReadPort,copilotMcpReadPort,type McpPort,type McpSnapshot,type RunRef } from '../src/index.js';
import { copilotMcpTransports } from '../src/native.js';

const run=(session='logical',generation=1,principal='alice'):RunRef=>({scope:{connection:'connection',principal,host:'host',session},generation,nativeSession:`native-${session}-${generation}`});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};}
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
const code=(expected:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===expected;
const codex=(name='server',extra:Record<string,unknown>={})=>({name,runtimeStatus:'connected',authStatus:'unsupported',tools:{tool:{}},toolsError:null,httpOrigin:'https://private.invalid',resources:[{secret:'resource'}],...extra});
const copilot=(name='server',extra:Record<string,unknown>={})=>({name,enabled:true,live:{status:'connected'},...extra});
const owner=(target:RunRef,native:ConstructorParameters<typeof McpOwner>[0]['native'],reads=new McpReadPool(),epoch=1)=>new McpOwner({run:target,epoch,native,reads,now:()=>123});

test('static MCP transport projection freezes only safe facts; undisclosed configurations keep authentication unknown',async()=>{
 const config={remote:{type:'http',url:'https://private.invalid/mcp',headers:{Authorization:'secret'}},local:{command:'/private/cli',env:{TOKEN:'secret'}}};
 const transports=copilotMcpTransports(config);config.remote.type='sse';assert.ok(Object.isFrozen(transports));assert.deepEqual(transports,{remote:'http',local:'stdio'});assert.doesNotMatch(JSON.stringify(transports),/private|secret|TOKEN|Authorization/);
 const target=run(),host=owner(target,copilotMcpReadPort({rpc:{mcp:{listConfigured:async()=>({servers:[copilot('remote'),copilot('local'),copilot('discovered')]})}}},transports));
 const value=await host.refresh(target);assert.equal(value.management,'unavailable-no-original-command','Transport knowledge alone is not mutation admission');assert.deepEqual(value.servers.map(server=>[server.name,server.transport,server.canAuthenticate]),[['remote','http',true],['local','stdio',false],['discovered','unknown',null]]);
});

test('Codex bounded tools/auth discovery preserves native uncertainty and strips private inventory',async()=>{
 const target=run(),requests:unknown[]=[];const native=codexMcpReadPort({async request(method,params){requests.push({method,params});return{data:[codex('unknown',{runtimeStatus:null,authStatus:'unknown',tools:{},toolsError:'private native discovery error'}),codex('unsupported')],nextCursor:null};}});
 const host=owner(target,native);assert.equal((await host.snapshot(target)).freshness,'unobserved');assert.equal(requests.length,0);
 const snapshot=await host.refresh(target);assert.equal(snapshot.kind,'codex');if(snapshot.kind!=='codex')throw Error('Wrong kind');assert.deepEqual(snapshot.servers,[{name:'unknown',runtimeStatus:null,authStatus:'unknown',toolCount:null,transport:'http',canAuthenticate:true},{name:'unsupported',runtimeStatus:'connected',authStatus:'unsupported',toolCount:1,transport:'http',canAuthenticate:false}]);
 assert.deepEqual(requests,[{method:'mcpServerStatus/list',params:{threadId:target.nativeSession,detail:'toolsAndAuthOnly',cursor:null,limit:32}}]);assert.equal(snapshot.coverage,'enumerated');assert.equal(snapshot.management,'unavailable-no-original-command');assert.doesNotMatch(JSON.stringify(snapshot),/private|https:|resource|authorization/);
 await assert.rejects(host.refresh(run('foreign')),code('FENCED'));assert.equal(requests.length,1);
});

test('Copilot uses passive configured inventory without materializing, tool reads or auth probes',async()=>{
 const target=run();let configured=0,materialized=0,tools=0,auth=0;
 const session={rpc:{mcp:{async listConfigured(){configured++;return{servers:[copilot('configured',{enabled:false,live:{status:'connected',error:'secret error'},url:'https://secret.invalid'})]};},async list(){materialized++;return{};},async listTools(){tools++;return{};},oauth:{async probe(){auth++;return{};}}}}};
 const host=owner(target,copilotMcpReadPort(session)),workspace=new McpWorkspace({connection:'connection',principal:'alice',port:host});await workspace.bind(target,'copilot');const entry=workspace.entry(target),unsubscribe=entry.subscribe(()=>{});unsubscribe();workspace.setConnected(target,false);workspace.setConnected(target,true);await workspace.reobserve(target);assert.equal(configured,0);
 const snapshot=await workspace.refresh(target);assert.equal(snapshot.kind,'copilot');if(snapshot.kind!=='copilot')throw Error('Wrong kind');assert.deepEqual(snapshot.servers,[{name:'configured',enabled:false,runtimeStatus:'connected',transport:'unknown',canAuthenticate:null}]);assert.deepEqual([configured,materialized,tools,auth],[1,0,0,0]);workspace.close();assert.equal((await host.snapshot(target)).freshness,'current');
});

test('coalesced cancellation and timeout retain the actual slot across native-run retirement',async()=>{
 const reads=new McpReadPool({maxActive:1,maxObservers:2}),held=deferred<unknown>(),firstRun=run(),nextRun=run('logical',2);let calls=0;
 const first=owner(firstRun,{kind:'copilot',configured:async()=>{calls++;return held.promise;}},reads),next=owner(nextRun,{kind:'copilot',configured:async()=>({servers:[]})},reads);
 const abort=new AbortController(),a=first.refresh(firstRun,{signal:abort.signal,timeoutMs:1000}),b=first.refresh(firstRun,{timeoutMs:10});await tick();assert.equal(calls,1);abort.abort();await assert.rejects(a,code('CANCELLED'));await assert.rejects(b,code('TIMEOUT'));assert.equal(reads.active,1);assert.equal(reads.observers,0);
 first.retire();const stoppedViewer=new McpWorkspace({connection:'connection',principal:'alice',port:first});await stoppedViewer.bind(firstRun,'copilot');assert.equal(stoppedViewer.entry(firstRun).getSnapshot().snapshot?.freshness,'retired');assert.equal(calls,1);await assert.rejects(stoppedViewer.refresh(firstRun),code('FENCED'));assert.throws(()=>first.subscribe(nextRun,()=>{}),code('FENCED'));stoppedViewer.close();
 await assert.rejects(next.refresh(nextRun),code('FULL'));assert.equal(reads.active,1);held.resolve({servers:[copilot()]});await tick();assert.equal(reads.active,0);assert.equal((await first.snapshot(firstRun)).freshness,'retired');assert.equal((await first.snapshot(firstRun)).servers.length,0);assert.equal((await next.refresh(nextRun)).freshness,'current');assert.equal(reads.active,0);
});

test('one cancelled or overflowing observer cannot cancel a healthy coalesced viewer',async()=>{
 const target=run(),held=deferred<unknown>(),reads=new McpReadPool({maxObservers:2});let calls=0;const host=owner(target,{kind:'copilot',configured:async()=>{calls++;return held.promise;}},reads),signal=new AbortController();
 const first=host.refresh(target,{signal:signal.signal}),healthy=host.refresh(target);await assert.rejects(host.refresh(target),code('FULL'));signal.abort();await assert.rejects(first,code('CANCELLED'));held.resolve({servers:[copilot()]});assert.equal((await healthy).freshness,'current');assert.equal(calls,1);assert.equal(reads.observers,0);
 const preAborted=new AbortController();preAborted.abort();await assert.rejects(host.refresh(target,{signal:preAborted.signal}),code('CANCELLED'));assert.equal(calls,1);
});

test('Codex pagination has one bounded owner and explicit partial coverage',async()=>{
 const target=run();let calls=0;const host=owner(target,{kind:'codex',status:async input=>{calls++;assert.equal(input.detail,'toolsAndAuthOnly');return{data:[codex(`server-${calls}`)],nextCursor:`cursor-${calls}`};}});
 const value=await host.refresh(target);assert.equal(calls,4);assert.equal(value.coverage,'partial');assert.equal(value.servers.length,4);assert.equal('nextCursor'in value,false);
});

test('discovery corruption never converts the previous usable inventory into an empty healthy list',async()=>{
 const target=run();let mode:'good'|'repeated-cursor'|'too-many-tools'|'unknown-status'='good',calls=0;
 const host=owner(target,{kind:'codex',status:async()=>{calls++;return mode==='repeated-cursor'?{data:[codex(`server-${calls}`)],nextCursor:'same'}:{data:[codex('last-good',mode==='too-many-tools'?{tools:Object.fromEntries(Array.from({length:257},(_,i)=>[String(i),{}]))}:mode==='unknown-status'?{runtimeStatus:'future-unqualified'}:{})],nextCursor:null};}});
 await host.refresh(target);for(const next of['repeated-cursor','too-many-tools','unknown-status'] as const){mode=next;await assert.rejects(host.refresh(target),code('INVALID'));const snapshot=await host.snapshot(target);assert.equal(snapshot.freshness,'stale');assert.deepEqual(snapshot.servers.map(server=>server.name),['last-good']);assert.equal(snapshot.issue,'readFailed');}
});

test('native-change during discovery stays stale until a subsequent explicit read',async()=>{
 const target=run(),held=deferred<unknown>();let calls=0;const host=owner(target,{kind:'copilot',configured:async()=>++calls===1?held.promise:{servers:[copilot('newer')]}});
 const pending=host.refresh(target);await tick();host.invalidate(target);held.resolve({servers:[copilot('raced')]});const raced=await pending;assert.equal(raced.freshness,'stale');assert.equal(raced.issue,'changed');assert.equal(calls,1);assert.equal((await host.refresh(target)).freshness,'current');assert.equal(calls,2);
});

test('retained client accepts newer Host epoch and rejects old frames/conflicting same revisions',async()=>{
 const target=run(),old=owner(target,{kind:'copilot',configured:async()=>({servers:[copilot('old')]})},new McpReadPool(),1),fresh=owner(target,{kind:'copilot',configured:async()=>({servers:[copilot('fresh')]})},new McpReadPool(),2);await old.refresh(target);await fresh.refresh(target);
 let listener!:(snapshot:McpSnapshot)=>void,current=await old.snapshot(target);const port:McpPort={snapshot:async()=>current,refresh:async()=>current,subscribe:(_run,fn)=>{listener=fn;return()=>{};}};
 const workspace=new McpWorkspace({connection:'connection',principal:'alice',port});await workspace.bind(target,'copilot');const entry=workspace.entry(target),stable=entry.getSnapshot();assert.equal(entry.getSnapshot(),stable);current=await fresh.snapshot(target);listener(current);listener(await old.snapshot(target));assert.equal(entry.getSnapshot().snapshot?.epoch,2);assert.equal(entry.getSnapshot().snapshot?.servers[0]?.name,'fresh');
 listener(Object.fromEntries(Object.entries(current).reverse()) as McpSnapshot);assert.throws(()=>listener({...current,observedAt:999}),code('CONFLICT'));assert.equal(entry.getSnapshot().stale,true);workspace.close();
});

test('workspace namespaces, session switching and late callbacks cannot rebind another principal',async()=>{
 const target=run(),secondRun=run('other'),held=deferred<McpSnapshot>(),host=owner(target,{kind:'copilot',configured:async()=>({servers:[copilot()]})});await host.refresh(target);const value=await host.snapshot(target);let listener!:(snapshot:McpSnapshot)=>void,unsubscribed=0;
 const port:McpPort={snapshot:async requested=>({...value,run:requested}),refresh:async()=>held.promise,subscribe:(_run,fn)=>{listener=fn;return()=>{unsubscribed++;};}};
 const workspace=new McpWorkspace({connection:'connection',principal:'alice',port});await workspace.bind(target,'copilot');const retained=workspace.entry(target);await workspace.bind(secondRun,'copilot');assert.equal(retained.getSnapshot().snapshot?.servers[0]?.name,'server');
 const bob=new McpWorkspace({connection:'connection',principal:'bob',port});await assert.rejects(bob.bind(target,'copilot'),code('FENCED'));assert.throws(()=>workspace.entry({...target,generation:2}),code('FENCED'));
 let cleared=0;retained.subscribe(()=>{throw Error('Untrusted renderer');});retained.subscribe(()=>{if(retained.getSnapshot().snapshot===null)cleared++;});const late=workspace.refresh(target);workspace.close();held.resolve(value);await assert.rejects(late,code('CLOSED'));listener(value);assert.equal(retained.getSnapshot().snapshot,null);assert.equal(cleared,1);assert.equal(unsubscribed,2);bob.close();
});

test('failed subscription admission rolls back the entry so an explicit bind can retry',async()=>{
 const target=run(),host=owner(target,{kind:'copilot',configured:async()=>({servers:[]})});let attempts=0;
 const port:McpPort={snapshot:requested=>host.snapshot(requested),refresh:(requested,options)=>host.refresh(requested,options),subscribe:(requested,listener)=>{if(++attempts===1)throw Error('Transport admission refused');return host.subscribe(requested,listener);}};
 const workspace=new McpWorkspace({connection:'connection',principal:'alice',port});await assert.rejects(workspace.bind(target,'copilot'));assert.throws(()=>workspace.entry(target),code('FENCED'));await workspace.bind(target,'copilot');assert.equal(attempts,2);assert.equal(workspace.entry(target).getSnapshot().snapshot?.freshness,'unobserved');workspace.close();
});

test('concurrent initial bind shares its read and retries a failed baseline without acquiring another subscription', async () => {
 const target=run(),host=owner(target,{kind:'copilot',configured:async()=>({servers:[]})}),value=await host.snapshot(target);
 let reads=0,subscribed=0,off=0,reject!:(error:Error)=>void;
 const held=new Promise<McpSnapshot>((_resolve,no)=>{reject=no;});
 const workspace=new McpWorkspace({connection:'connection',principal:'alice',port:{snapshot:async()=>++reads===1?held:value,refresh:async()=>value,subscribe:()=>{subscribed++;return()=>{off++;};}}});
 const first=workspace.bind(target,'copilot'),second=workspace.bind(target,'copilot'),reconnect=workspace.reobserve(target);
 await tick();assert.deepEqual([reads,subscribed],[1,1]);
 const failures=Promise.all([assert.rejects(first),assert.rejects(second),assert.rejects(reconnect)]);reject(Error('Initial read failed'));await failures;
 assert.equal(workspace.entry(target).getSnapshot().stale,true);assert.equal(off,0);
 await workspace.bind(target,'copilot');assert.deepEqual([reads,subscribed],[2,1]);assert.equal(workspace.entry(target).getSnapshot().snapshot?.freshness,'unobserved');workspace.close();assert.equal(off,1);
});

test('exact retirement frees bounded generations, scrubs facades and fences callbacks/read completion after same-key replacement', async () => {
 const initial=run(),host=owner(initial,{kind:'copilot',configured:async()=>({servers:[copilot('kept')]})});await host.refresh(initial);const source=await host.snapshot(initial);
 const listeners:Array<(snapshot:McpSnapshot)=>void>=[];let subscribed=0,off=0;const held=deferred<McpSnapshot>();
 const workspace=new McpWorkspace({connection:'connection',principal:'alice',maxRuns:2,port:{snapshot:async target=>({...source,run:target}),refresh:async()=>held.promise,subscribe:(_target,listener)=>{subscribed++;listeners.push(listener);return()=>{off++;};}}});
 await workspace.bind(initial,'copilot');const facade=workspace.entry(initial);let scrubbed=0;facade.subscribe(()=>{if(facade.getSnapshot().snapshot===null)scrubbed++;});
 const pending=workspace.refresh(initial);workspace.retire(initial);workspace.retire(initial);assert.equal(scrubbed,1);assert.deepEqual(facade.getSnapshot(),{snapshot:null,connected:false,stale:true});assert.equal(facade.getSnapshot(),facade.getSnapshot());assert.throws(()=>facade.subscribe(()=>{}),code('CLOSED'));
 await workspace.bind(initial,'copilot');listeners[0]!({...source,revision:99});held.resolve({...source,revision:99});await assert.rejects(pending,code('FENCED'));assert.equal(workspace.entry(initial).getSnapshot().snapshot?.revision,source.revision);
 const current=workspace.entry(initial);listeners[1]!({...source,revision:source.revision+1,freshness:'retired',issue:'ownershipRetired'});assert.equal(off,2);assert.equal(current.getSnapshot().snapshot?.servers[0]?.name,'kept');assert.equal(current.getSnapshot().stale,true);listeners[1]!({...source,revision:999});assert.equal(current.getSnapshot().snapshot?.freshness,'retired');workspace.retire(initial);assert.equal(off,2);
 for(let generation=2;generation<=40;generation++){const next=run('logical',generation);await workspace.bind(next,'copilot');workspace.retire(next);}
 assert.equal(off,subscribed);workspace.close();
 assert.doesNotThrow(()=>new McpWorkspace({connection:'connection',principal:'alice',maxRuns:256,port:host}).close());
});
