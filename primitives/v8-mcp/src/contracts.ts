import type { RunRef } from '../../v8-session/src/contracts/types.js';
export type { RunRef };

export type Freshness='unobserved'|'refreshing'|'current'|'stale'|'retired';
export type Coverage='unknown'|'enumerated'|'partial';
export type CodexConnection='notStarted'|'starting'|'connected'|'authenticationRequired'|'failed'|'cancelled'|'disabled';
export type CodexAuth='unknown'|'unsupported'|'notLoggedIn'|'bearerToken'|'oAuth';
export type CopilotConnection='connected'|'failed'|'needs-auth'|'pending'|'disabled'|'stopped'|'not_configured';
export type McpTransport='stdio'|'http'|'sse';
/** Safe facts only. Unknown configuration never implies authentication authority. */
export type McpServerFacts=Readonly<{transport:McpTransport|'unknown';canAuthenticate:boolean|null}>;
export type McpTransports=Readonly<Record<string,McpTransport>>;
/** toolCount is broad discovery evidence, not the running thread client's current tool catalog. */
export type CodexServer=McpServerFacts&Readonly<{name:string;runtimeStatus:CodexConnection|null;authStatus:CodexAuth;toolCount:number|null}>;
export type CopilotServer=McpServerFacts&Readonly<{name:string;enabled:boolean;runtimeStatus:CopilotConnection}>;
type Common=Readonly<{
 run:RunRef;epoch:number;revision:number;freshness:Freshness;coverage:Coverage;observedAt:number|null;
 /** Commands remain with SessionHost; this observation owner never executes them. */
 management:'unavailable-no-original-command'|'session-originals';issue?:'readFailed'|'changed'|'ownershipRetired';
}>;
export type CodexMcpSnapshot=Common&Readonly<{kind:'codex';discovery:'thread-scoped-discovery';servers:readonly CodexServer[]}>;
export type CopilotMcpSnapshot=Common&Readonly<{kind:'copilot';discovery:'configured-passive';servers:readonly CopilotServer[]}>;
export type McpSnapshot=CodexMcpSnapshot|CopilotMcpSnapshot;
export type Observation=Readonly<{signal?:AbortSignal;timeoutMs?:number}>;
export interface McpPort {
 /** Read retained Host evidence only; neither method invokes native discovery or materializes a server. */
 snapshot(run:RunRef):Promise<McpSnapshot>;
 subscribe(run:RunRef,listener:(snapshot:McpSnapshot)=>void,onError?:(error:unknown)=>void):()=>void;
 /** Explicit bounded discovery; Codex may start temporary MCP clients. Cancellation retains the underlying owner. */
 refresh(run:RunRef,observation?:Observation):Promise<McpSnapshot>;
}
export type CodexInventoryRequest=Readonly<{threadId:string;detail:'toolsAndAuthOnly';cursor:string|null;limit:number}>;
type NativeFacts=Readonly<{management?:'session-originals';transports?:McpTransports}>;
export type CodexMcpReadPort=NativeFacts&Readonly<{kind:'codex';status(request:CodexInventoryRequest):Promise<unknown>}>;
export type CopilotMcpReadPort=NativeFacts&Readonly<{kind:'copilot';configured():Promise<unknown>}>;
export type NativeMcpReadPort=CodexMcpReadPort|CopilotMcpReadPort;
export type McpErrorCode='INVALID'|'FENCED'|'FULL'|'CLOSED'|'UNAVAILABLE'|'TIMEOUT'|'CANCELLED'|'CONFLICT';
export class McpError extends Error {constructor(readonly code:McpErrorCode){super(code);this.name='McpError';}}
