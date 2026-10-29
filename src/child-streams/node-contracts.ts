import type { RunRef } from "../protocol/index.js";
import type {
  HistoryScope,
  HistoryReadPort,
  HistoryFeed,
  HistoryReadWindow,
  Cursor,
  Frame,
  ReadObservation,
} from "../history/contracts.js";
export interface HostChildPort {
  /** Native lineage has already been positively proved. No guessed task IDs. */
  inventory(run: RunRef): readonly HistoryScope[];
  bind(
    scope: HistoryScope,
  ): Readonly<{ window: HistoryFeed & HistoryReadWindow; port: HistoryReadPort; release?(): void }>;
  assertRun(run: RunRef): void;
  /** Existing parent lifecycle observation, not another native attachment. */
  subscribe(listener: () => void): () => void;
}
export interface ChildStreamService {
  inventory(run: RunRef): readonly HistoryScope[];
  watch(scope: HistoryScope, cursor?: Cursor): AsyncIterableIterator<Frame>;
  baseline(scope: HistoryScope): Promise<ReadObservation>;
  older(scope: HistoryScope, cursor: string): Promise<ReadObservation>;
}
