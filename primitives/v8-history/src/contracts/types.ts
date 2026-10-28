/** Runtime primitives; no React, native SDK, transport, credentials or filesystem imports. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
/** Only references cross the history boundary. Bytes belong to an injected file owner. */
export type MediaResolution = Readonly<{
  state: "available" | "pending" | "unavailable" | "unsupported";
  artifactId?: string;
}>;
export type NativeMediaOccurrence = Readonly<{
  id: string; kind: "image" | "unsupported"; source: "inline" | "disk" | "native" | "unsupported";
  mediaType?: string; sha256?: string; bytes?: number; path?: string; assetId?: string;
  omittedReason?: string; absent?: true; nativeType?: string;
  displayName?: string; taggedFilesEntry?: string; declaredBytes?: number;
}> & MediaResolution;
export type Origin = Readonly<{
  connection: string;
  principal: string;
  host: string;
  nativeSession: string;
  attachment: string;
}>;
export type CodexScope = Readonly<{ kind: "codex"; origin: Origin; threadId: string }>;
export type CopilotScope = Readonly<{ kind: "copilot"; origin: Origin }> & (
  | Readonly<{ agentId: string | null; legacyParentToolCallId?: never }>
  | Readonly<{ agentId: null; legacyParentToolCallId: string }>
);
export type Scope = CodexScope | CopilotScope;
/** Native presentation facts only. They never establish scope ownership, agent
 * execution, or a per-turn model actually used by the provider. */
export type ScopeFacts = Readonly<{
  name?: string; nickname?: string; role?: string; path?: string;
  configuredModel?: string; reasoningEffort?: string;
  invocation?: string; lifecycle?: "running" | "completed" | "failed" | "interrupted";
  startedModel?: string; requestedModel?: string; firstDispatchedModel?: string; reportedUsedModel?: string;
  status?: "idle" | "active" | "notLoaded" | "systemError";
}>;
export type CapturedScope = Readonly<{ scope: Scope; native?: ScopeFacts }>;
export type ScopeInventory = Readonly<{ nativeGeneration: number; entries: readonly CapturedScope[] }>;
export type RowKind = "user" | "assistant" | "reasoning" | "tool" | "delegation" | "notice";
export type Lifecycle = "running" | "completed" | "failed" | "interrupted";
export type Missing = "prefix" | "interior" | "final" | "truncated";
export type Body =
  | Readonly<{ kind: "complete"; text: string; evidence: "nativeFullBody" | "capturedStartThroughEnd" }>
  | Readonly<{ kind: "partial"; text: string; missing: readonly Missing[] }>
  | Readonly<{ kind: "unavailable"; reason: "notCaptured" | "unsupported" | "nativeOmitted" }>;
export type Row = Readonly<{
  id: string;
  kind: RowKind;
  /** Historical records without positive terminal evidence remain unknown. */
  lifecycle: Lifecycle | "unknown";
  body: Body;
  native: Readonly<Record<string, Json>>;
  version: number;
  contentVersion: number;
}>;
/** Capture could not publish all live notifications; native work may continue. */
export const CAPTURE_GAP_ID = "host:capture-gap";
export type Gap = Readonly<{
  id: string;
  kind: "missingPrefix" | "missingFinal" | "nativeGap" | "identity" | "unsupported" | "truncated";
  rowId?: string;
}>;
export type OlderEdge =
  | Readonly<{ state: "unknown"; reason: string }>
  | Readonly<{ state: "end"; evidence: "provedEmptyCapture" | "nativeBoundary" }>
  | Readonly<{ state: "available"; cursor: string }>;
export type Activity = Readonly<{ turnId: string | null; state: "unknown" | "working" | "idle" | "failed" }>;
export type Coverage = Readonly<{ knownStart: boolean; gaps: readonly Gap[] }>;
/** The existing Host acquisition owns this projection; observer waits do not. */
export type HistoryReadTarget = Readonly<{ kind: 'initial' | 'recover' }> | Readonly<{ kind: 'older'; cursor: string }>;
export type HistoryReadState =
  | Readonly<{ state: 'idle' }>
  | Readonly<{ state: 'pending'; target: HistoryReadTarget }>
  | Readonly<{ state: 'settled'; target: HistoryReadTarget; outcome: 'ready' | 'healed' | 'failed' | 'expired' | 'unsupported'; retryToken?: string }>;

export type Snapshot = Readonly<{
  scope: Scope;
  generation: string;
  revision: number;
  /** Native reader lease; independent of retained capture/row generation. */
  readContext?: string;
  rows: readonly Row[];
  retirements: readonly Extract<Change, { kind: "retireRows" }>[];
  olderEdge: OlderEdge;
  coverage: Coverage;
  activity: Activity;
  read: HistoryReadState;
  /** Current Host-proved scopes, projected on the root stream. Absence means
   * this stream makes no inventory claim; it never means an empty inventory. */
  scopeInventory?: ScopeInventory;
}>;
export type Change =
  | Readonly<{ kind: "replaceRow"; row: Row }>
  | Readonly<{ kind: "evictCurrentRows"; rowIds: readonly string[] }>
  | Readonly<{ kind: "retireRows"; rowIds: readonly string[]; evidence: string; replacementId?: string }>;
export type Frame =
  | Readonly<{ kind: "snapshot"; snapshot: Snapshot }>
  | Readonly<{
      kind: "commit"; scope: Scope; generation: string; baseRevision: number; revision: number;
      changes: readonly Change[]; order: readonly string[]; olderEdge: OlderEdge;
      coverage: Coverage; activity: Activity;
      /** Omission preserves the previous acquisition projection. */
      read?: HistoryReadState;
      /** Omitted on ordinary text commits: the previous inventory is unchanged. */
      scopeInventory?: ScopeInventory;
      readContext?: string;
    }>;
export type Cursor = Readonly<{ generation: string; revision: number }>;
/** Native codecs emit typed operations. Only the Host appends raw native deltas. */
export type Action =
  | Readonly<{ type: "start"; id: string; kind: RowKind; text?: string | null; native?: Readonly<Record<string, Json>> }>
  | Readonly<{ type: "append"; id: string; kind: RowKind; text: string; sequence?: number; channel?: string }>
  | Readonly<{ type: "replace"; id: string; kind: RowKind; text: string; native?: Readonly<Record<string, Json>> }>
  | Readonly<{
      type: "finish"; id: string; kind: RowKind; lifecycle: Exclude<Lifecycle, "running">;
      text?: string | null; sealCaptured?: boolean; native?: Readonly<Record<string, Json>>;
    }>
  | Readonly<{ type: "activity"; activity: Activity }>
  | Readonly<{ type: "gap"; gap: Gap }>
  | Readonly<{ type: "clearGap"; id: string }>
  /** File-owner resolution only; cannot create a row or alter native evidence. */
  | Readonly<{ type: "media"; id: string; media: readonly NativeMediaOccurrence[] }>
  /** Positive native history edit; retained rows stay visible while paging is fenced. */
  | Readonly<{ type: "readBoundary"; factId: string; reason: string }>
  | Readonly<{ type: "edge"; edge: OlderEdge }>
  | Readonly<{ type: "retire"; rowIds: readonly string[]; evidence: string; replacementId?: string }>;
/** Private metadata only. Never contains a native payload, procedure or error text. */
export type CaptureDiagnostic = Readonly<{
  at: number;
  stage: "controller" | "notification" | "media" | "lineage" | "reverseRequest" | "transport" | "opening" | "codec" | "capture";
  reason: "unspecified" | "captureConsumerFailed" | "notificationProjectionFailed" | "stagingRejected" | "startupCapacity" | "mediaProjectionFailed" |
    "reverseRequestLost" | "transportDisconnected" | "openingFailed" | "lineageQuarantined" | "lineageConflict" | "lineageContext" | "lineageRetired" |
    "codecCaptureRejected" | "envelope" | "scope" | "retiredLiveAncestry" | "invalidNativeEvent" | "unverifiedLiveAncestry" | "unownedBufferCapacity" |
    "threadCapacity" | "changedLiveAncestry" | "conflictingActivityOwner" | "unverifiedActivityOwner" | "unverifiedBufferedAncestry" | "itemCapacity" |
    "segmentCapacity" | "conflictingFinal";
  errorCode?: string;
  observedThreadId?: string;
  observedTurnId?: string;
  rejected?: number;
  bufferedEvents?: number;
  bufferedBytes?: number;
}>;
export interface CapturePort {
  diagnostic?(scope: Scope, diagnostic: CaptureDiagnostic): void;
  /** Native ownership/authorization must be established before open. No native work is performed. */
  open(scope: Scope, options?: Readonly<{ knownStart?: boolean; native?: ScopeFacts }>): void;
  emit(scope: Scope, actions: readonly Action[]): void;
  /** Revert/actual native epoch change, never a UI reconnect. Fences old readers and item locators. */
  reset(scope: Scope, reason: string): void;
}
export interface NativeCodec {
  /** Native-shaped scripted input only; these codecs do not launch or import native SDKs. */
  observe(value: unknown): void;
}
export type HistoryPage = Readonly<{
  scope: Scope;
  generation: string;
  readContext?: string;
  rows: readonly Row[];
  olderEdge: OlderEdge;
}>;
export type Anchor = Readonly<{ rowId: string; segmentId?: string; offsetPx: number }>;
export type ViewportIntent = "followingLive" | "readingHistory";
export type ApplyResult = "applied" | "duplicate" | "stale" | "needsSnapshot";
export interface ScriptedCounters {
  nativeBodyReads: number;
  nativeMetadataReads: number;
  snapshots: number;
  nativeMutations: number;
}
