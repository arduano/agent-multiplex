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

/** Synchronous commits precede successful returns. A thrown write acknowledges
 * nothing. This port cannot execute, retry, observe or otherwise own external effects. */
export interface OriginalJournalPort extends OriginalReadPort {
  /** Stable opaque identity of the underlying writer. Delegated ports forward it. */
  readonly writerIdentity: object;
  /** Admit immutable meaning before any effect may be dispatched. */
  admit(
    scope: SessionScope,
    id: string,
    request: Json,
    options?: { priority?: Priority },
  ): JournalTransition;
  /** Only fresh:true grants the single committed dispatch claim. */
  markDispatched(scope: SessionScope, id: string): JournalTransition;
  /** Monotonic settlement of the exact original. */
  settle(scope: SessionScope, id: string, outcome: Settlement): Receipt;
}

/** The process that opens a storage handle owns close. Passing a borrowed port
 * to a lifecycle, catalog or observer does not delegate that responsibility. */
export interface JournalHandle {
  close(): void;
}
