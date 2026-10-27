import type { Catalog, SessionPort, SessionScope, SessionSnapshot, Submit, Receipt, RunRef, NativeRead, NativeReadResult, McpLoginLink } from "../../../v8-session/src/contracts/types.js";
import type { Cursor, Frame, Scope, HistoryPage } from "../../../v8-history/src/contracts/types.js";
import type { HistoryObservation, HistoryRecovery } from "../../../v8-history/src/acquisition/types.js";
import type { ReadObservation } from "../../../v8-history/src/repair/read-coordinator.js";
export type { HistoryObservation, HistoryRecovery } from "../../../v8-history/src/acquisition/types.js";
import type { ArchivePublication, CatalogPort, CatalogScope, CatalogEntry, CreateRequest, RenameRequest, WatchRequest, MetadataOriginal, Creation } from "../../../v8-catalog/src/contracts/types.js";
import type { FilePort, FileScope } from "../../../v8-files/src/contracts/types.js";
import type { McpPort, McpSnapshot, Observation as McpObservation } from "../../../v8-mcp/src/contracts.js";
import type { InteractionPort, InteractionSnapshot } from "../../../v8-interactions/src/contracts.js";

/** owner is the durable request domain (Catalog HostTarget.owner); routeEpoch is replaceable transport freshness. */
export type GatewayTarget = Readonly<{ connection: string; principal: string; authority: string; host: string; session: string; owner: string; routeEpoch: string }>;
/** Injected trusted verifier output. No credential or provider configuration belongs in this value. */
export type GatewayAction="read"|"control"|"catalogWrite"|"fileWrite"|"mcpRefresh";
export type Identity = Readonly<{ connection: string; principal: string; authorities: readonly string[]; actions:readonly GatewayAction[] }>;
export type GatewayErrorCode = "INVALID" | "UNAUTHENTICATED" | "FORBIDDEN" | "FENCED" | "UNAVAILABLE" | "FULL" | "OVERFLOW" | "CLOSED" | "ALREADY_ATTEMPTED" | "CANCELLED" | "TIMEOUT" | "CONFLICT";
export class GatewayError extends Error { constructor(readonly code: GatewayErrorCode, message: string = code) { super(message); this.name = "GatewayError"; } }
export interface HistoryPort {
  /** Already proved/captured scopes only. No native discovery or body read. */
  scopes?(): readonly Scope[] | Promise<readonly Scope[]>;
  /** Explicit cold selected-child proof. No provisional visible scope or native effects. */
  authorize?(scope: Scope, observation?: HistoryObservation): Promise<ReadObservation<true>>;
  /** This reads retained Host capture/replay only. It must not attach/resume or fetch native bodies. */
  watch(scope: Scope, cursor?: Cursor): AsyncIterableIterator<Frame>;
  /** Optional explicit exception read. Never invoked by watch/reconnect. */
  older?(scope: Scope, cursor: string, generation?: string, retryToken?: string): Promise<HistoryPage>;
  /** Host-derived cold/gap fact only. Results contain no transcript body. */
  recover?(scope: Scope, observation?: HistoryObservation, retryToken?: string): Promise<HistoryRecovery>;
}
export type GatewayBinding=Readonly<{run:RunRef;history:Scope}>;
export type FileSurface=Readonly<{port:FilePort;scope:()=>FileScope|null}>;
/** Supplied only by the Host assembly, never by a browser-derived catalog projection. */
export type SessionRoute = Readonly<{ target: GatewayTarget; /** Optional trusted route ceiling, intersected with the authenticated identity. */ actions?: readonly GatewayAction[]; session: SessionPort; history: HistoryPort; interactions?: InteractionPort; mcp?:McpPort; files?:FileSurface; binding?:()=>GatewayBinding|null|Promise<GatewayBinding|null>; controlCatalog?:()=>Promise<Catalog>; authorizeHistory(scope: Scope): boolean }>;
export type RemoteRouteClaim=Readonly<{target:GatewayTarget;expiresAt:number;revoked:AbortSignal}>;
/** Authenticated peer verifier: returning a caller's asserted owner without verification violates this port. */
export type RemoteRouteVerifier=(authorization:string)=>Promise<RemoteRouteClaim|null>;
export type FileLocation=Readonly<{path:string;scope:FileScope}>;
export type StreamRequest = Readonly<{ target: GatewayTarget; scope: Scope; cursor?: Cursor }>;
export type WireStream<T> = Readonly<{ type: "value"; value: T }> | Readonly<{ type: "error"; code: GatewayErrorCode }>;
export interface GatewayTransport {
  rpcCall?(request: import('./rpc.js').HostRpcCall): Promise<import('./rpc.js').RpcResult>;
  rpcWatch?(request: import('./rpc.js').HostRpcRequest, signal: AbortSignal, onStarted?: () => void): AsyncIterable<import('./rpc.js').RpcResult>;
  snapshot(target: GatewayTarget): Promise<SessionSnapshot>;
  read?(target: GatewayTarget, run: RunRef, request: NativeRead): Promise<NativeReadResult>;
  mcpLoginLink?(target: GatewayTarget, run: RunRef, originalId: string): Promise<McpLoginLink>;
  /** Explicit read of configured choices; absence is unavailable, never native discovery. */
  controlCatalog?(target: GatewayTarget): Promise<Catalog>;
  submit(target: GatewayTarget, request: Submit): Promise<Receipt>;
  receipt(target: GatewayTarget, id: string): Promise<Receipt | null>;
  watchSession(target: GatewayTarget, signal: AbortSignal, onStarted?:()=>void): AsyncIterable<SessionSnapshot>;
  watchHistory(request: StreamRequest, signal: AbortSignal, onStarted?:()=>void): AsyncIterable<Frame>;
  historyScopes?(target: GatewayTarget): Promise<readonly Scope[]>;
  watchCatalog?(scope:CatalogScope, signal:AbortSignal, onStarted?:()=>void):AsyncIterable<CatalogEntry>;
  watchInteractions?(target:GatewayTarget, signal:AbortSignal, onStarted?:()=>void):AsyncIterable<InteractionSnapshot>;
  watchMcp?(target:GatewayTarget, run:RunRef, signal:AbortSignal, onStarted?:()=>void):AsyncIterable<McpSnapshot>;
  list?(scope:CatalogScope):Promise<readonly CatalogEntry[]>;
  get?(scope:CatalogScope, session:string):Promise<CatalogEntry|null>;
  create?(request:CreateRequest):Promise<Creation>;
  creation?(scope:CatalogScope, id:string):Promise<Creation|null>;
  rename?(request:RenameRequest):Promise<CatalogEntry>;
  setWatched?(request:WatchRequest):Promise<CatalogEntry>;
  metadataOriginal?(scope:CatalogScope,id:string):Promise<MetadataOriginal|null>;
  publishArchive?(request:ArchivePublication):Promise<CatalogEntry>;
  interactionSnapshot?(target:GatewayTarget):Promise<InteractionSnapshot>;
  mcpSnapshot?(target:GatewayTarget, run:RunRef):Promise<McpSnapshot>;
  mcpRefresh?(target:GatewayTarget, run:RunRef, observation?:McpObservation):Promise<McpSnapshot>;
  older(target: GatewayTarget, scope: Scope, cursor: string, generation?: string, retryToken?: string): Promise<HistoryPage>;
  recover?(target: GatewayTarget, scope: Scope, observation?: HistoryObservation, retryToken?: string): Promise<HistoryRecovery>;
  /** Explicit observation reconnect only; commands are never replayed. */
  onDisconnect?(listener:(error:unknown)=>void):()=>void;
  disconnect?(): void;
  reconnect?(): void;
  /** Destructive auth boundary, not a transport disconnect. */
  close(): void;
}
export type CatalogRoute = Readonly<{ scope: CatalogScope; owner: string; actions?: readonly GatewayAction[]; port: CatalogPort }>;
export type ForwardObservation = Readonly<{ active: number; urgent: number; optionalReads: number; subscribers: number }>;
export const targetScope = (t: GatewayTarget): SessionScope => ({ connection: t.connection, principal: t.principal, host: t.host, session: t.session });
export const ownerKey = (t: GatewayTarget): string => JSON.stringify([t.connection,t.principal,t.authority,t.host,t.session,t.owner]);
export const targetKey = (t: GatewayTarget): string => JSON.stringify([ownerKey(t),t.routeEpoch]);


export type ObserverRequest = Readonly<{op:"session.watch"|"interactions.watch";target:GatewayTarget}> | Readonly<{op:"history.watch"}&StreamRequest> | Readonly<{op:"mcp.watch";target:GatewayTarget;run:RunRef}> | Readonly<{op:"catalog.watch";scope:CatalogScope}> | Readonly<{op:'rpc.watch';request:import('./rpc.js').HostRpcRequest}>;
export type ObserverFrame = Readonly<{type:"ready";channel:string}> | Readonly<{type:"event";id:string;value:unknown}> | Readonly<{type:"error";id:string;code:GatewayErrorCode}> | Readonly<{type:"end";id:string}>;
