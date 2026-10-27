import { pathToFileURL,fileURLToPath } from 'node:url';
import { resolve,dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomBytes,createPrivateKey,sign } from 'node:crypto';
import { createSocket } from 'node:dgram';
import assert from 'node:assert/strict';
const lane=fileURLToPath(new URL('..',import.meta.url)),framework=resolve(lane,'../..');
const pause=()=>new Promise(r=>setTimeout(r,5));
async function until(test){const end=Date.now()+5000;while(!test()){if(Date.now()>end)throw Error('Published transport bounded observation did not settle');await pause();}}
/** Root runs once after freeze. Real published Iroh endpoints, scripted domain ports,
 * no existing Root/Host topology, no native agent, no model, no relay/discovery.
 */
export async function runPublishedTransportQualification({buildRoot=resolve(lane,'.build'),toolRoot=framework}={}){
 const resolveModule=name=>import.meta.resolve(name),load=p=>import(pathToFileURL(resolve(buildRoot,p)).href);
 const {createP2PNode,createSharedSecretSecurity,verifyPinnedSignedTicket}=await import(resolveModule('@arduano/p2prpc-core'));
 const [{createP2pGatewayRouter,P2pGatewayTransport},{GatewayCoordinator},{HistoryHub},{HistoryWorkspace},{GatewayClient},{McpOwner,McpReadPool},{FixtureSession,target,scope,historyScope,alice,request}]=await Promise.all([
  load('primitives/v8-gateway/src/node/p2prpc.js'),load('primitives/v8-gateway/src/gateway/coordinator.js'),load('primitives/v8-history/src/host/history-owner.js'),load('primitives/v8-history/src/client/workspace.js'),load('primitives/v8-gateway/src/client/coordinator.js'),load('primitives/v8-mcp/src/index.js'),load('primitives/v8-gateway/qualification/fixture.js')
 ]);
 const version=async name=>{let path=dirname(fileURLToPath(resolveModule(name)));for(let n=0;n<6;n++,path=dirname(path)){try{const value=JSON.parse(await readFile(resolve(path,'package.json'),'utf8'));if(value.name===name)return value.version;}catch{}}throw Error('Pinned metadata unavailable');};
 const p2prpc=await version('@arduano/p2prpc-core'),iroh=await version('@momics/iroh-http-node');assert.equal(p2prpc,'0.3.0-renewal.2');assert.equal(iroh,'0.6.2');
 const gateway=new GatewayCoordinator(),session=new FixtureSession(),history=new HistoryHub(),run={scope,generation:1,nativeSession:'native'};history.open(historyScope,{knownStart:true});let nativeReads=0,olderReads=0,controlReads=0;
 session.read=async(current,request)=>{assert.deepEqual(current,run);assert.deepEqual(request,{type:'codex.goal'});controlReads++;return{run,type:'codex.goal',goal:null};};
 const mcp=new McpOwner({run,epoch:1,reads:new McpReadPool(),native:{kind:'codex',status:async()=>{nativeReads++;return{data:[],nextCursor:null};}}});
 gateway.register({target,session,history:{watch:(...args)=>history.watch(...args),older:async()=>{olderReads++;return{scope:historyScope,generation:'fixture',rows:[],olderEdge:{state:'end',evidence:'provedEmptyCapture'}};}},mcp,binding:()=>({run,history:historyScope}),authorizeHistory:s=>JSON.stringify(s)===JSON.stringify(historyScope)});
 const authorized=new Set(),router=createP2pGatewayRouter(gateway,verified=>authorized.has(verified.peer.id)&&verified.auth.principal.subject===verified.peer.id?{...alice,actions:[...alice.actions,'mcpRefresh']}:null),secret=randomBytes(32),nodes=[],clients=[],histories=[],leases=[];
 let cleanup=false,passed=false;const cases=[];
 const options=(irohOptions={})=>({router,protocol:{applicationId:'multiplex-v8-owned-wire-qualification',contractVersion:'1'},security:createSharedSecretSecurity(secret,{authorize:()=>true}),iroh:{bindAddress:'127.0.0.1:0',relay:{mode:'disabled'},discovery:{dns:false,mdns:false},allowAdvertisedAddress:address=>address.startsWith('127.0.0.1:'),allowDirectAddress:address=>address.startsWith('127.0.0.1:'),allowRelayUrl:()=>false,...irohOptions},createContext:ctx=>ctx});
 try{
  // Pinned discoveryInfo excludes loopback-only candidates. Choose our own exact
  // bind port and issue a signed locator with that known local reachability;
  // do not enable discovery, inspect private endpoint fields or alter vendors.
  const reservation=createSocket('udp4');
  await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.bind(0,'127.0.0.1',resolve);});
  const hostAddress=`127.0.0.1:${reservation.address().port}`;await new Promise(resolve=>reservation.close(resolve));
  const hostKey=randomBytes(32),host=await createP2PNode(options({secretKey:hostKey,bindAddress:hostAddress}));nodes.push(host);const a=await createP2PNode(options());nodes.push(a);const b=await createP2PNode(options());nodes.push(b);authorized.add(a.id);authorized.add(b.id);
  const originalTicket=await host.createTicket(),originalBody=JSON.parse(Buffer.from(originalTicket.split('.')[1],'base64url').toString('utf8'));
  const original=verifyPinnedSignedTicket(originalTicket,{expectedPeerId:host.id,expectedProtocol:originalBody.protocol});assert.equal(original.relayUrl,null);
  const issuedAt=Date.now(),body=Buffer.from(JSON.stringify({...original,directAddresses:[hostAddress],issuedAt,expiresAt:issuedAt+90000}));
  const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),hostKey]),format:'der',type:'pkcs8'});
  const signature=sign(null,Buffer.concat([Buffer.from('p2prpc-signed-ticket-v3\0'),body]),privateKey),ticket=`p2prpc3.${body.toString('base64url')}.${signature.toString('base64url')}`;
  const verified=verifyPinnedSignedTicket(ticket,{expectedPeerId:host.id,expectedProtocol:original.protocol});assert.deepEqual(verified.directAddresses,[hostAddress]);assert.equal(verified.relayUrl,null);
  const connect=node=>node.connect({locator:{kind:'ticket',ticket},expectedPeerId:host.id,expectedPrincipal:{subject:host.id,issuer:null,clientId:null,tenantId:null}});
  for(const node of[a,b]){
   const peer=await connect(node),transport=new P2pGatewayTransport(peer),workspace=new HistoryWorkspace({connection:scope.connection,principal:scope.principal}),client=new GatewayClient({transport,history:workspace,targets:[target],onFence:()=>{}});
   clients.push({transport,client,peer});histories.push(workspace);assert.deepEqual(await transport.binding(target),{run,history:historyScope});leases.push(client.observeHistory(scope,historyScope));
  }
  await until(()=>histories.every(w=>!!w.session(historyScope).client.current));cases.push('authenticated exact-pinned published Iroh with two retained viewers and verified explicit owned loopback ticket');
  assert.equal(controlReads,0);const goals=await Promise.all(clients.map(v=>v.client.read(run,{type:'codex.goal'})));assert.ok(goals.every(value=>value.type==='codex.goal'&&value.goal===null));assert.equal(controlReads,2);assert.equal(session.submits.length,0);await assert.rejects(clients[0].client.read(run,{type:'copilot.queue'}));assert.equal(controlReads,2);cases.push('native goal read crosses real published query transport with exact run/kind validation and no mutation or implicit read');
  assert.equal(nativeReads,0);await Promise.all(clients.map(v=>v.client.mcpPort(scope).snapshot(run)));assert.equal(nativeReads,0);await clients[0].client.mcpPort(scope).refresh(run);assert.equal(nativeReads,1);cases.push('retained MCP reads stay passive; only explicit discovery crosses native read port');
  await Promise.all(clients.map(v=>v.transport.older(target,historyScope,'owned-older')));assert.equal(olderReads,2);history.emit(historyScope,[{type:'start',id:'real-wire-row',kind:'assistant',text:'retained capture'}]);await until(()=>histories.every(w=>w.session(historyScope).client.current.rows.length===1));cases.push('two explicit scripted older reads preserve independent real-transport capture streams');
  await clients[0].client.submit(request());assert.equal((await clients[1].transport.receipt(target,'send')).state,'acknowledged');assert.equal(session.submits.length,1);cases.push('one original forwarding and exact receipt read across independent authenticated viewers');
  leases[0].release();clients[0].client.fence();await until(()=>gateway.observation.subscribers===1);history.emit(historyScope,[{type:'append',id:'real-wire-row',kind:'assistant',text:' after other viewer closes'}]);await until(()=>histories[1].session(historyScope).client.current.rows[0].body.text.includes('other viewer'));assert.equal(session.submits.length,1);cases.push('closing one client preserves other viewer, shared peer owner and capture');passed=true;
 }finally{
  for(const lease of leases)lease.release();for(const {client}of clients)client.fence();mcp.retire();gateway.close();const settled=await Promise.allSettled(nodes.map(node=>node.close()));assert.ok(settled.every(v=>v.status==='fulfilled'),'Owned Iroh endpoint cleanup failed');cleanup=true;
 }
 return {passed,cases,p2prpc,iroh,endpoints:nodes.length,cleanup,explicitLoopbackBootstrap:true,p14:'unqualified',nativeAgentCalls:0,modelCalls:0,scope:'new V8 adapter + scripted domain ports on three fresh loopback Iroh endpoints; not existing Root/Host P14 topology'};
}
