import { sameRun } from '../../v8-session/src/contracts/types.js';
import { canonical,copy } from '../../v8-session/src/contracts/validation.js';
import { McpError,type McpSnapshot,type RunRef } from './contracts.js';
export { canonical,copy };
export const MAX_SERVERS=128,MAX_TOOLS=256,MAX_PAGES=4,PAGE_SIZE=32,MAX_SNAPSHOT_BYTES=65536;
export const CODEX_CONNECTIONS=['notStarted','starting','connected','authenticationRequired','failed','cancelled','disabled'] as const;
export const CODEX_AUTH=['unknown','unsupported','notLoggedIn','bearerToken','oAuth'] as const;
export const COPILOT_CONNECTIONS=['connected','failed','needs-auth','pending','disabled','stopped','not_configured'] as const;
export function check(value:unknown):asserts value {if(!value)throw new McpError('INVALID');}
export function id(value:unknown):asserts value is string {check(typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value));}
export function record(value:unknown):Record<string,unknown>{check(value&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null));return value as Record<string,unknown>;}
function keys(value:Record<string,unknown>,allowed:readonly string[]):void {check(Object.keys(value).every(key=>allowed.includes(key)));}
export function validateRun(run:RunRef):void {const value=record(run);keys(value,['scope','generation','nativeSession']);const scope=record(run.scope);keys(scope,['connection','principal','host','session']);for(const value of Object.values(scope))id(value);check(Object.keys(scope).length===4);id(run.nativeSession);check(Number.isSafeInteger(run.generation)&&run.generation>0);}
export function assertRun(expected:RunRef,actual:RunRef):void {validateRun(actual);if(!sameRun(expected,actual))throw new McpError('FENCED');}
export function validateSnapshot(value:McpSnapshot,run:RunRef,kind?:'codex'|'copilot'):McpSnapshot {
 canonical(value,MAX_SNAPSHOT_BYTES);const raw=record(value);keys(raw,['run','epoch','revision','freshness','coverage','observedAt','management','issue','kind','discovery','servers']);assertRun(run,value.run);
 check(Number.isSafeInteger(value.epoch)&&value.epoch>=0&&Number.isSafeInteger(value.revision)&&value.revision>=0&&['unobserved','refreshing','current','stale','retired'].includes(value.freshness)&&['unknown','enumerated','partial'].includes(value.coverage));
 check(value.observedAt===null||Number.isSafeInteger(value.observedAt)&&value.observedAt>=0);check(['unavailable-no-original-command','session-originals'].includes(value.management));check(value.issue===undefined||['readFailed','changed','ownershipRetired'].includes(value.issue));
 check((value.kind==='codex'&&value.discovery==='thread-scoped-discovery'||value.kind==='copilot'&&value.discovery==='configured-passive')&&(!kind||value.kind===kind));
 check(Array.isArray(value.servers)&&value.servers.length<=MAX_SERVERS);const names=new Set<string>();
 for(const server of value.servers){const raw=record(server);id(server.name);check(!names.has(server.name));names.add(server.name);
  check(['unknown','stdio','http','sse'].includes(server.transport)&&[true,false,null].includes(server.canAuthenticate));
  if(value.kind==='codex'){keys(raw,['name','runtimeStatus','authStatus','toolCount','transport','canAuthenticate']);check(raw.runtimeStatus===null||CODEX_CONNECTIONS.includes(raw.runtimeStatus as never));check(CODEX_AUTH.includes(raw.authStatus as never));check(raw.toolCount===null||Number.isSafeInteger(raw.toolCount)&&Number(raw.toolCount)>=0&&Number(raw.toolCount)<=MAX_TOOLS);}
  else{keys(raw,['name','enabled','runtimeStatus','transport','canAuthenticate']);check(typeof raw.enabled==='boolean'&&COPILOT_CONNECTIONS.includes(raw.runtimeStatus as never));}
 }
 return copy(value);
}
