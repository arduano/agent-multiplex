import type {
  JournalHandle,
  JournalTransition,
  OriginalJournalPort,
  OriginalReadPort,
} from "../../src/storage/contracts.js";
import type { SessionScope } from "../../src/protocol/index.js";

/** A consumer can forward a borrowed journal without inheriting SQLite or its
 * private fields. This fixture is compiled with Node declarations unavailable. */
export function consumer(journal: OriginalJournalPort, scope: SessionScope): void {
  const reads: OriginalReadPort = {
    read: journal.read.bind(journal),
    request: journal.request.bind(journal),
    unresolved: journal.unresolved.bind(journal),
  };
  const forwarded: OriginalJournalPort = {
    ...reads,
    writerIdentity: journal.writerIdentity,
    admit: journal.admit.bind(journal),
    markDispatched: journal.markDispatched.bind(journal),
    settle: journal.settle.bind(journal),
  };
  const claim: JournalTransition = forwarded.markDispatched(scope, "original");
  const closeOwner: JournalHandle = { close() {} };
  closeOwner.close();

  // @ts-expect-error A borrowed query capability cannot dispatch effects.
  reads.markDispatched(scope, "original");
  // @ts-expect-error Borrowing a writer does not delegate process-owned close.
  journal.close();
  // @ts-expect-error A promise cannot acknowledge a synchronous committed claim.
  const asynchronous: OriginalJournalPort["markDispatched"] = async () => claim;
  void asynchronous;
}
