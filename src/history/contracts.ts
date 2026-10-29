import type { Json, RunRef } from "../protocol/index.js";

/** A Host proves this binding before handing it to history. Native child IDs
 * are opaque stream identities; history does not authorize ancestry. */
export type HistoryScope = Readonly<{ run: RunRef; attachment: string; stream: string }>;
export type RowKind = "user" | "assistant" | "reasoning" | "tool" | "notice" | "delegation";
export type Lifecycle = "running" | "completed" | "failed" | "interrupted" | "unknown";
export type Missing = "prefix" | "interior" | "final" | "truncated";
export type Body =
  | Readonly<{ kind: "complete"; text: string; evidence: "native" | "captured" }>
  | Readonly<{ kind: "partial"; text: string; missing: readonly Missing[] }>
  | Readonly<{ kind: "unavailable"; reason: "notCaptured" | "nativeOmitted" | "unsupported" }>;
export type HistoryRecord = Readonly<{
  id: string;
  kind: RowKind;
  lifecycle: Lifecycle;
  body: Body;
  native: Readonly<Record<string, Json>>;
}>;
export type Row = HistoryRecord & Readonly<{ version: number }>;
export type Gap = Readonly<{
  id: string;
  kind: "captureLost" | "missingPrefix" | "missingFinal" | "identity" | "unsupported" | "truncated";
  rowId?: string;
}>;
export type OlderEdge =
  | Readonly<{ state: "unknown"; reason: string }>
  | Readonly<{ state: "end"; evidence: "provedEmptyCapture" | "nativeBoundary" }>
  | Readonly<{ state: "available"; cursor: string }>;
export type Activity = Readonly<{
  state: "unknown" | "working" | "idle" | "failed";
  turnId: string | null;
}>;
export type HistorySnapshot = Readonly<{
  scope: HistoryScope;
  generation: number;
  revision: number;
  readEpoch: number;
  /** Residency is not native loss. Once a range leaves this generation, only
   * an explicit reset/new attachment can reestablish a complete window cut. */
  residencyOmitted: boolean;
  rows: readonly Row[];
  olderEdge: OlderEdge;
  gaps: readonly Gap[];
  activity: Activity;
}>;
export type Snapshot = HistorySnapshot;
export type Cursor = Readonly<{ generation: number; revision: number }>;
export type Frame =
  | Readonly<{ kind: "snapshot"; snapshot: Snapshot }>
  | Readonly<{
      kind: "commit";
      scope: HistoryScope;
      generation: number;
      baseRevision: number;
      revision: number;
      readEpoch: number;
      residencyOmitted: boolean;
      rows: readonly Row[];
      evicted: readonly string[];
      /** Explicit ordering authority for newly disjoint rows; not inferred by a view. */
      placement: "before" | "after";
      order: readonly string[];
      olderEdge: OlderEdge;
      gaps: readonly Gap[];
      activity: Activity;
    }>;
/** Upserts are absolute normalized evidence, never raw vendor deltas. */
export type Update = Readonly<{
  rows?: readonly HistoryRecord[];
  olderEdge?: OlderEdge;
  activity?: Activity;
  gaps?: readonly Gap[];
  clearGaps?: readonly string[];
}>;
export type WindowLimits = Readonly<{
  maxRows: number;
  maxBodyBytes: number;
  maxBytes: number;
  maxGaps: number;
  maxReplayFrames: number;
  maxReplayBytes: number;
  maxSubscribers: number;
  maxQueuedFrames: number;
}>;
export type NativePage =
  | Readonly<{
      status: "page";
      scope: HistoryScope;
      rows: readonly HistoryRecord[];
      /** Explicit ordering evidence from the adapter; never inferred from IDs/time. */
      placement: "before" | "after";
      nextCursor: string | null;
      gaps?: readonly Gap[];
    }>
  | Readonly<{ status: "expired" | "unsupported" }>;
export interface HistoryReadPort {
  readonly mode: "repeatable" | "singleUse";
  readonly scope: HistoryScope;
  /** Resolves only when actual read ownership has settled. Observer aborts are
   * deliberately absent. A port uses assertCurrent to roll back late leases. */
  read(
    input: Readonly<{ cursor: string | null; count: number }>,
    assertCurrent: () => void,
  ): Promise<NativePage>;
}
export type ReadTarget =
  Readonly<{ kind: "baseline" }> | Readonly<{ kind: "older"; cursor: string }>;
export type ReadOutcome =
  | Readonly<{ state: "ready" | "expired" | "unsupported" | "stale" | "retired" }>
  | Readonly<{ state: "failed"; code: string }>;
export type ReadObservation = ReadOutcome | Readonly<{ state: "waitingExpired" }>;
export type ReadState =
  | Readonly<{ state: "idle" }>
  | Readonly<{ state: "pending"; target: ReadTarget }>
  | Readonly<{ state: "settled"; target: ReadTarget; outcome: ReadOutcome; retryable: boolean }>;

/** Observation grants no mutation, paging, reset or lifetime authority. */
export interface HistorySnapshotSource {
  readonly scope: HistoryScope;
  getSnapshot(): HistorySnapshot;
}
export interface HistoryFeedSubscription extends AsyncIterableIterator<Frame> {
  return(): Promise<IteratorResult<Frame>>;
}
export interface HistoryFeed extends HistorySnapshotSource {
  readonly subscriberCount: number;
  frame(): Frame;
  subscribe(cursor?: Cursor): HistoryFeedSubscription;
}
/** The issuing window validates the exact opaque object, not just these fields. */
export type ReadFence = Readonly<{ generation: number; readEpoch: number; revision: number }>;
export interface HistoryReadWindow extends HistorySnapshotSource {
  beginRead(): ReadFence;
  readIsCurrent(fence: ReadFence): boolean;
  endRead(fence: ReadFence): void;
  publishRead(
    fence: ReadFence,
    rows: readonly HistoryRecord[],
    olderEdge: OlderEdge,
    placement: "before" | "after",
    gaps?: Update["gaps"],
  ): boolean;
}
export interface ReadBudgetPort {
  readonly maximum: number;
  readonly active: number;
  run<T>(operation: () => Promise<T>): Promise<T>;
}
export interface HistoryReadHandle {
  readonly active: boolean;
  readonly outcome: ReadOutcome | undefined;
  readonly settled: Promise<ReadOutcome>;
  wait(timeoutMs: number, signal?: AbortSignal): Promise<ReadObservation>;
}
export type AcquisitionOptions = Readonly<{
  count?: number;
  maxBytes?: number;
  maxCalls?: number;
  maxCursors?: number;
  maxCursorBytes?: number;
  changed?(): void;
}>;
export interface HistoryAcquisitionPort {
  readonly budget: ReadBudgetPort;
  getState(): ReadState;
  baseline(): HistoryReadHandle;
  older(cursor: string): HistoryReadHandle;
  retry(handle: HistoryReadHandle): HistoryReadHandle;
  retire(): void;
}
