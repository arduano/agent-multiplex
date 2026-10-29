import type { Frame, HistoryScope, ReadObservation, Snapshot } from "../history/contracts.js";
import type { AnchorPort, TranscriptViewPort, HistoryReadStatus } from "../client/contracts.js";
import type { RunRef } from "../protocol/index.js";

/** A child is a native history stream under the parent's exact lifetime.
 * It is never a logical session or a lifecycle-control target. */
export interface ChildStreamFeed {
  inventory(run: RunRef): Promise<readonly HistoryScope[]>;
  watch(scope: HistoryScope, signal: AbortSignal): AsyncIterable<Frame>;
  baseline(scope: HistoryScope): Promise<ReadObservation>;
  older(scope: HistoryScope, cursor: string): Promise<ReadObservation>;
}
export type ChildSnapshot = Readonly<{
  scope: HistoryScope;
  history: Snapshot | null;
  freshness: "unobserved" | "current" | "unavailable";
  pinned: boolean;
  retired: boolean;
  revision: number;
  read: HistoryReadStatus;
}>;

export interface ChildStreamView {
  readonly anchor: AnchorPort;
  readonly transcript: TranscriptViewPort;
  getSnapshot(): ChildSnapshot;
  subscribe(listener: () => void): () => void;
  commit(): () => void;
  pin(value: boolean): void;
  baseline(): ReturnType<ChildStreamFeed["baseline"]>;
  older(cursor: string): ReturnType<ChildStreamFeed["older"]>;
}
