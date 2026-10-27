import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';

/** Real authenticated HTTP shared by independent viewers; no native execution ownership. */
export function viewerBridges(core){
  const backends=new Map(),clients=new Set();
  const key=scope=>JSON.stringify([scope.connection,scope.principal,scope.host,scope.session]);
  async function open({scope,sessionPort,interactionPort}){
    const name=key(scope);let pending=backends.get(name);
    if(!pending){
      pending=(async()=>{
        const coordinator=new core.GatewayCoordinator();
        const target={...scope,authority:'live-control',owner:'live-exact-host-owner',routeEpoch:'live-route-1'};
        coordinator.register({target,session:sessionPort,interactions:interactionPort,history:{watch(){throw new Error('No transcript read requested by interaction fixture')}},authorizeHistory:()=>false});
        const token=randomBytes(24).toString('hex');
        try{
          const server=await core.listenLoopback(coordinator,async header=>header===`Bearer ${token}`?{connection:scope.connection,principal:scope.principal,authorities:['live-control'],actions:['read','control']}:null);
          return {coordinator,server,token,target,sessionPort,interactionPort};
        }catch(error){coordinator.close();throw error}
      })();backends.set(name,pending);
    }
    const backend=await pending;assert.equal(backend.sessionPort,sessionPort);assert.equal(backend.interactionPort,interactionPort);
    const history=new core.HistoryWorkspace({connection:scope.connection,principal:scope.principal});
    const transport=new core.HttpGatewayTransport({url:backend.server.url,authorization:`Bearer ${backend.token}`});
    const gateway=new core.GatewayClient({transport,history,targets:[backend.target],onFence:()=>{}});
    const remote=gateway.interactionPort(scope),listeners=new Set();let unsubscribe=null,connected=true,closed=false,epoch=0;
    const check=()=>{if(closed||!connected)throw new Error('Live viewer observation unavailable')};
    const attach=()=>{if(unsubscribe||!listeners.size||!connected||closed)return;const token=epoch;unsubscribe=remote.subscribe(scope,value=>{if(closed||!connected||token!==epoch)return;for(const fn of [...listeners])try{fn(value)}catch{/* One observer cannot affect the native owner. */}})};
    const proxy={async snapshot(s){check();const token=epoch,value=await remote.snapshot(s);check();assert.equal(token,epoch,'Stale live viewer read');return value},subscribe(s,fn){assert.equal(key(s),name);check();listeners.add(fn);attach();return()=>{listeners.delete(fn);if(!listeners.size){unsubscribe?.();unsubscribe=null}}}};
    const result={sessionPort:gateway,interactionPort:proxy,
      disconnect(){if(closed)return;connected=false;epoch++;unsubscribe?.();unsubscribe=null;gateway.disconnect()},
      async reconnect(){if(closed)throw new Error('Closed live viewer');if(!connected){connected=true;epoch++;gateway.reconnect();attach()}return proxy.snapshot(scope)},
      async close(){if(closed)return;closed=true;connected=false;epoch++;unsubscribe?.();unsubscribe=null;listeners.clear();gateway.close();clients.delete(result)},
      // Private capabilities stay in this process; never put them in receipts.
      browserConfiguration:()=>{check();return {url:backend.server.url,authorization:`Bearer ${backend.token}`,target:backend.target,scope}},
    };
    clients.add(result);return result;
  }
  return {open,async close(){const results=await Promise.allSettled([...clients].map(value=>value.close()));const owners=await Promise.allSettled([...backends.values()].map(async pending=>{const backend=await pending;backend.coordinator.close();await backend.server.close()}));for(const result of [...results,...owners])if(result.status==='rejected')throw result.reason}};
}
