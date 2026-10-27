import type { CodexInventoryRequest,CodexMcpReadPort,CodexServer,CopilotMcpReadPort,CopilotServer,McpTransports,McpTransport } from './contracts.js';
import { CODEX_AUTH,CODEX_CONNECTIONS,COPILOT_CONNECTIONS,MAX_SERVERS,MAX_TOOLS,check,copy,id,record } from './validation.js';

/** Structural ports deliberately import no SDK, credentials or native configuration. */
export function codexMcpReadPort(rpc:Readonly<{request(method:'mcpServerStatus/list',params:CodexInventoryRequest):Promise<unknown>}>,management?:'session-originals'):CodexMcpReadPort {
 return Object.freeze({kind:'codex',...(management?{management}:{}),status:(request:CodexInventoryRequest)=>rpc.request('mcpServerStatus/list',request)});
}
export function copilotMcpReadPort(session:Readonly<{rpc:Readonly<{mcp:Readonly<{listConfigured():Promise<unknown>}>}>}>,transports?:McpTransports,management?:'session-originals'):CopilotMcpReadPort {
 return Object.freeze({kind:'copilot',...(transports?{transports:copy(transports)}:{}),...(management?{management}:{}),configured:()=>session.rpc.mcp.listConfigured()});
}
/** Projects trusted static configuration once; never retains endpoints, env or credentials. */
export function copilotMcpTransports(value:unknown):McpTransports {
 const servers=record(value),result:Record<string,McpTransport>=Object.create(null);check(Object.keys(servers).length<=MAX_SERVERS);
 for(const [name,value]of Object.entries(servers)){id(name);const server=record(value);if(server.type==='http'||server.type==='sse')result[name]=server.type;else{check((server.type===undefined||server.type==='local'||server.type==='stdio')&&typeof server.command==='string');result[name]='stdio';}}
 return copy(result);
}
export function codexPage(value:unknown):Readonly<{servers:readonly CodexServer[];nextCursor:string|null}> {
 const page=record(value);check(Array.isArray(page.data)&&page.data.length<=MAX_SERVERS);check(page.nextCursor===null||typeof page.nextCursor==='string'&&page.nextCursor.length>0&&page.nextCursor.length<=2048);
 const servers=page.data.map(value=>{const server=record(value);id(server.name);check(server.runtimeStatus===null||CODEX_CONNECTIONS.includes(server.runtimeStatus as never));check(CODEX_AUTH.includes(server.authStatus as never));
  const tools=record(server.tools),names=Object.keys(tools);check(names.length<=MAX_TOOLS);check(server.toolsError===null||typeof server.toolsError==='string');
  let transport:CodexServer['transport']='unknown',canAuthenticate:boolean|null=null;
  if(server.httpOrigin===null){transport='stdio';canAuthenticate=false;}else if(server.httpOrigin!==undefined){check(typeof server.httpOrigin==='string');const url=new URL(server.httpOrigin);check(['http:','https:'].includes(url.protocol)&&url.origin===server.httpOrigin&&!url.username&&!url.password);transport='http';canAuthenticate=server.authStatus!=='unsupported';}
  return{name:server.name,runtimeStatus:server.runtimeStatus,authStatus:server.authStatus,toolCount:server.toolsError===null?names.length:null,transport,canAuthenticate} as CodexServer;
 });
 return{servers,nextCursor:page.nextCursor as string|null};
}
export function copilotConfigured(value:unknown,transports:McpTransports={}):readonly CopilotServer[] {
 const result=record(value);check(Array.isArray(result.servers)&&result.servers.length<=MAX_SERVERS);
 return result.servers.map(value=>{const server=record(value),live=record(server.live);id(server.name);check(typeof server.enabled==='boolean'&&COPILOT_CONNECTIONS.includes(live.status as never));const transport=Object.hasOwn(transports,server.name)?transports[server.name]!:'unknown';return{name:server.name,enabled:server.enabled,runtimeStatus:live.status,transport,canAuthenticate:transport==='unknown'?null:transport!=='stdio'} as CopilotServer;});
}
