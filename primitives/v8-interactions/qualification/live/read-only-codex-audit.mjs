import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {allowanceLedger} from './support.mjs';
import {CodexInteractionRpc} from './codex-rpc.mjs';

assert.ok(process.argv.includes('--allow-owned-native-read'));
const arg=name=>process.argv.find(value=>value.startsWith(name+'='))?.slice(name.length+1);
const provider=arg('--provider');assert.match(provider??'',/^[A-Za-z0-9_-]{1,64}$/,'Explicit provider ID required');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),name=arg('--receipt');assert.match(name??'',/^interactions-live-[0-9TZ-]+$/);
const artifact=join(root,'artifacts',name),base=join(artifact,'private/codex'),nativeHome=join(base,'native-home'),workspace=join(base,'workspace');
const allowancePath=join(root,'artifacts/allowance-native-interactions-20261023.json');
const ledger=allowanceLedger(allowancePath,{}, {resumeId:arg('--allowance-id')});
let rpc,deny;const result={scope:'exact owned stopped disposable session, native read API only',modelCalls:0,providerRequests:0,commands:[],turns:[],cleanup:false};
try{
  ledger.admit('codex-native','read-only-stopped-command-audit');
  const db=new DatabaseSync(join(base,'state/codex-interaction-journal/session.sqlite'),{readOnly:true});let snapshot;try{snapshot=JSON.parse(db.prepare('SELECT json FROM state WHERE singleton=1').get().json)}finally{db.close()}
  assert.ok(snapshot.nativeSession);deny=createServer((req,res)=>{result.providerRequests++;req.resume();res.writeHead(403).end('Model calls forbidden during read-only native audit')});await new Promise(resolve=>deny.listen(0,'127.0.0.1',resolve));
  const endpoint=`http://127.0.0.1:${deny.address().port}/v1`;
  const binary=join(resolve(arg('--tool-root')),'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex');
  rpc=new CodexInteractionRpc({binary,args:['-c',`model_providers.${provider}.base_url=${JSON.stringify(endpoint)}`,'app-server','--stdio'],workspace,environment:{PATH:process.env.PATH,LANG:'C.UTF-8',HOME:nativeHome,CODEX_HOME:nativeHome,MULTIPLEX_V8_LIVE_KEY:'read-only-native-audit-no-upstream-credential'},onNotification(){},onServerRequest(){throw new Error('Read-only audit cannot respond to native requests')}});await rpc.ready();
  await rpc.request('initialize',{clientInfo:{name:'multiplex_v8_read_only_audit',version:'0.0.0'},capabilities:{experimentalApi:true}});rpc.notify('initialized');
  const turns=await rpc.request('thread/turns/list',{threadId:snapshot.nativeSession,cursor:null,limit:4,sortDirection:'desc',itemsView:'notLoaded'});
  for(const turn of turns.data){result.turns.push({id:turn.id,status:turn.status});const items=await rpc.request('thread/items/list',{threadId:snapshot.nativeSession,turnId:turn.id,cursor:null,limit:32,sortDirection:'asc'});for(const entry of items.data){const item=entry.item;if(item?.type==='commandExecution')result.commands.push({turnId:entry.turnId,itemId:item.id,command:item.command,status:item.status,exitCode:item.exitCode});if(item?.type==='userMessage')result.turns[result.turns.length-1].clientId=item.clientId??null}}
  assert.equal(result.providerRequests,0);assert.equal(rpc.counts.requests['turn/start']??0,0);assert.equal(rpc.counts.requests['thread/resume']??0,0);result.rpcCounts=rpc.counts;
}catch(error){result.error=String(error.message??'Read-only native audit failed')}
finally{
  if(rpc){try{const closed=await rpc.close();result.cleanup=closed.ownedGroupAbsent===true}catch(error){result.cleanup=false;result.cleanupError=String(error.message)}}
  if(deny)await new Promise(resolve=>deny.close(resolve));ledger.seal();ledger.complete(result.error?'read-audit-diagnostic':'read-audit-complete');
  const text=JSON.stringify(result,null,2)+'\n';await writeFile(join(artifact,'read-only-audit.json'),text,{mode:0o600});await writeFile(join(artifact,'read-only-audit.sha256'),createHash('sha256').update(text).digest('hex')+'\n',{mode:0o600});
  console.log(text.replaceAll(artifact,'<owned-receipt>').replaceAll(nativeHome,'<owned-home>').replaceAll(workspace,'<owned-workspace>'));if(result.error||!result.cleanup)process.exitCode=1;
}
