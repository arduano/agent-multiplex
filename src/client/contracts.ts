import type { Frame, HistoryScope, ReadObservation, Row, Snapshot } from "../history/contracts.js";
import type { InteractionSnapshot } from "../interactions/contracts.js";
import type { Json, Receipt, RunRef, SessionScope } from "../protocol/index.js";

import type { ObservationConnector } from "../transport/contracts.js";
export type { ObservationConnector } from "../transport/contracts.js";

export type RowAnchor = Readonly<{ rowId: string; offset: number }>;
export type AnchorSnapshot = Readonly<{
  mode: "followingLive" | "readingHistory";
  anchor: RowAnchor | null;
  revision: number;
}>;
export interface AnchorPort {
  getSnapshot(): AnchorSnapshot;
  subscribe(listener: () => void): () => void;
  captureGeometry(capture: () => RowAnchor | null): () => void;
  gesture(): void;
  observed(anchor: RowAnchor | null, nearBottom: boolean): void;
  read(anchor: RowAnchor | null): void;
  followLatest(): void;
  captureFollow(): () => void;
}
declare const sessionOwner: unique symbol;
/** Equality denotes the exact retained owner, never a matching SessionScope. */
export type SessionOwnerIdentity = Readonly<{ [sessionOwner]: true }>;
export interface SessionReadPort {
  readonly scope: SessionScope;
  getSnapshot(): EntrySnapshot;
  subscribe(listener: () => void): () => void;
}
export type DraftSnapshot = Readonly<{
  text: string;
  archived: boolean;
}>;
export interface DraftPort {
  readonly owner: SessionOwnerIdentity;
  readonly scope: SessionScope;
  getDraft(): DraftSnapshot;
  setDraft(text: string): Promise<void>;
}
export interface OriginalReadPort {
  checkOriginal(id: string): Promise<ClientOriginal | null>;
}
export interface SessionEntryPort extends SessionReadPort, DraftPort, OriginalReadPort {
  pin(value: boolean): Promise<void>;
  submit(command: Command): Promise<OriginalHandle>;
}
export interface SessionViewPort {
  readonly entry: SessionEntryPort;
  readonly anchor: AnchorPort;
  readonly transcript: TranscriptViewPort;
  commit(): () => void;
  submit(command: Command): Promise<OriginalHandle>;
  submitDraft(command: Command): Promise<OriginalHandle>;
  baseline(): Promise<ReadObservation>;
  older(cursor: string): Promise<ReadObservation>;
  close(): void;
}
/** These public names denote capabilities; construction belongs to the workspace. */
export type SessionView = SessionViewPort;
export type SessionEntry = SessionEntryPort;
export type HistoryReadStatus =
  | Readonly<{
      kind: "baseline" | "older";
      cursor: string | null;
      state: "pending";
    }>
  | Readonly<{
      kind: "baseline" | "older";
      cursor: string | null;
      state: "settled";
      outcome: ReadObservation;
    }>
  | null;
export type TranscriptSnapshot = Readonly<{
  revision: number;
  history: HistoryView;
  freshness: "unobserved" | "current" | "unavailable";
  working: boolean;
  retired: boolean;
  read: HistoryReadStatus;
}>;
/** Rendering and scroll intent only: no Send, Stop, draft or fake root state. */
export interface TranscriptViewPort {
  readonly anchor: AnchorPort;
  getSnapshot(): TranscriptSnapshot;
  subscribe(listener: () => void): () => void;
  commit(): () => void;
  baseline(): Promise<ReadObservation>;
  older(cursor: string): Promise<ReadObservation>;
}
export type WorkspaceOptions = Readonly<{
  feed: SessionFeed;
  persistence: ClientPersistence;
  observations: ObservationConnector;
  limits?: Partial<ClientLimits>;
}>;

export type SessionState = Readonly<{
  scope: SessionScope;
  run: RunRef | null;
  phase: "unknown" | "starting" | "running" | "stopping" | "stopped" | "archived";
  activity: "unknown" | "working" | "idle";
  selection: Json;
}>;
export type Command = Readonly<{ id: string; optimisticText?: string }> &
  (
    | Readonly<{
        kind: "send" | "steer" | "queue" | "control";
        run: RunRef;
        payload: Json;
      }>
    | Readonly<{
        kind: "stop";
        run: RunRef | null;
        payload: Readonly<Record<string, Json>> & Readonly<{ generation: number }>;
      }>
  );
export type ClientOriginal = Readonly<{
  command: Command;
  state: "persisting" | "pending" | "unknown" | "succeeded" | "refused" | "localFailure";
  receipt: Receipt | null;
  nativeConfirmed: boolean;
}>;
export type OriginalHandle = Readonly<{
  getSnapshot(): ClientOriginal;
  settled: Promise<ClientOriginal>;
}>;
export type PersistedEntry = Readonly<{
  version: 1;
  scope: SessionScope;
  draft: string;
  pinned: boolean;
  originals: readonly ClientOriginal[];
}>;
export interface ClientPersistence {
  /** Implementations bound actual storage reads to this requested count. */
  load(maxEntries: number): Promise<readonly PersistedEntry[]>;
  /** Success means this exact immutable entry is durably committed. */
  save(value: PersistedEntry): Promise<void>;
}
/** A typed router can implement these structural observations/queries. Reads
 * remain with their actual Host owner after a viewer leaves. */
export interface SessionFeed {
  state(
    scope: SessionScope,
    signal: AbortSignal,
    unavailable?: () => void,
  ): AsyncIterable<SessionState>;
  history(run: RunRef, signal: AbortSignal, unavailable?: () => void): AsyncIterable<Frame>;
  interactions(
    run: RunRef,
    signal: AbortSignal,
    unavailable?: () => void,
  ): AsyncIterable<InteractionSnapshot>;
  baseline(run: RunRef): Promise<ReadObservation>;
  older(run: RunRef, cursor: string): Promise<ReadObservation>;
  dispatch(scope: SessionScope, command: Command): Promise<Receipt>;
  original(scope: SessionScope, id: string): Promise<Receipt | null>;
}
export type HistoryView = Readonly<{
  current: Snapshot | null;
  rows: readonly Row[];
  origins: Readonly<Record<string, Readonly<{ scope: HistoryScope; generation: number }>>>;
  residencyOmitted: boolean;
}>;
export type EntrySnapshot = Readonly<{
  scope: SessionScope;
  revision: number;
  draft: string;
  pinned: boolean;
  state: SessionState | null;
  freshness: "unobserved" | "current" | "unavailable";
  history: HistoryView;
  historyFreshness: "unobserved" | "current" | "unavailable";
  interactions: InteractionSnapshot | null;
  interactionsFreshness: "unobserved" | "current" | "unavailable";
  originals: readonly ClientOriginal[];
  persistenceIssue: boolean;
  historyRead: HistoryReadStatus;
}>;
export type ClientLimits = Readonly<{
  maxEntries: number;
  maxViews: number;
  maxListeners: number;
  maxDraftBytes: number;
  maxOriginals: number;
  reservedStops: number;
  maxOriginalBytes: number;
  maxRequestBytes: number;
  recentOriginals: number;
  maxHistoryRows: number;
  maxHistoryBytes: number;
}>;
