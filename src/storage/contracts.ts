import type { Json, Receipt, SessionScope, Settlement } from "../protocol/index.js";

export type { Original, OperationState, Receipt, Settlement } from "../protocol/index.js";

/** Only the trusted effect owner may select Stop's reserved admission class. */
export type Priority = "normal" | "stop";
export type Limits = Readonly<{
  maxPending: number;
  maxPendingBytes: number;
  maxRequestBytes: number;
  maxResultBytes: number;
  maxRetainedBytes: number;
  reservedStops: number;
  maxCheckpointBytes: number;
  maxCheckpointTotalBytes: number;
  maxCheckpoints: number;
}>;
export type JournalErrorCode =
  "CONFLICT" | "CAPACITY" | "NOT_FOUND" | "INVALID_TRANSITION" | "CLOSED";
export class JournalError extends Error {
  constructor(
    readonly code: JournalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "JournalError";
  }
}
export type JournalTransition = Readonly<{ fresh: boolean; receipt: Receipt }>;
export type UnresolvedOriginal = Readonly<{ receipt: Receipt; request: Json; priority: Priority }>;

/** Borrowed query capability. Lookup never claims dispatch or invokes an effect. */
export interface OriginalReadPort {
  read(scope: SessionScope, id: string): Receipt | null;
  request(scope: SessionScope, id: string): Json | null;
  unresolved(scope: SessionScope): readonly UnresolvedOriginal[];
}

/** Opaque bounded JSON. The domain owner validates its own record and scope. */
export type Checkpoint = Readonly<{ scope: SessionScope; value: Json }>;
export interface CheckpointReadPort {
  checkpoint(scope: SessionScope): Json | null;
  checkpoints(): readonly Checkpoint[];
}
export interface CheckpointPort extends CheckpointReadPort {
  saveCheckpoint(scope: SessionScope, value: Json): void;
}

/** Synchronous commits precede successful returns. A thrown write acknowledges
 * nothing. A duplicate operation never reapplies its optional checkpoint.
 * This port cannot execute, retry, observe or otherwise own external effects. */
export interface OriginalJournalPort extends OriginalReadPort, CheckpointPort {
  /** Stable opaque identity of the underlying writer. A delegated port must
   * forward this token, so wrappers cannot acquire a second domain owner. */
  readonly writerIdentity: object;
  /** Immutable meaning; a fresh original and optional checkpoint commit together. */
  admit(
    scope: SessionScope,
    id: string,
    request: Json,
    options?: { priority?: Priority; checkpoint?: Checkpoint },
  ): JournalTransition;
  /** Only fresh:true grants the single committed dispatch claim. */
  markDispatched(scope: SessionScope, id: string, checkpoint?: Checkpoint): JournalTransition;
  /** Monotonic exact settlement, atomically paired with a checkpoint if advancing. */
  settle(scope: SessionScope, id: string, outcome: Settlement, checkpoint?: Checkpoint): Receipt;
}

/** The process that opens a storage handle owns close. Passing a borrowed port
 * to a lifecycle, catalog or observer does not delegate that responsibility. */
export interface JournalHandle {
  close(): void;
}
