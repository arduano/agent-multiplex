import { useEffect, useMemo, useSyncExternalStore } from "react";
import type {
  AnchorSnapshot,
  EntrySnapshot,
  SessionView,
  TranscriptSnapshot,
  TranscriptViewPort,
} from "../../client/contracts.js";

/** Subscription setup is inert. Network leases exist only after commit, and
 * StrictMode cleanup/replay never disposes the retained entry. */
export function useSessionView(view: SessionView): EntrySnapshot {
  const entry = view.entry;
  const store = useMemo(
    () => ({
      subscribe: entry.subscribe.bind(entry),
      getSnapshot: entry.getSnapshot.bind(entry),
    }),
    [entry],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => view.commit(), [view]);
  return snapshot;
}
export function useViewAnchor(view: import("../contracts.js").AnchoredViewPort): AnchorSnapshot {
  const anchor = view.anchor;
  const store = useMemo(
    () => ({
      subscribe: anchor.subscribe.bind(anchor),
      getSnapshot: anchor.getSnapshot.bind(anchor),
    }),
    [anchor],
  );
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useTranscriptView(view: TranscriptViewPort): TranscriptSnapshot {
  const store = useMemo(
    () => ({
      subscribe: view.subscribe.bind(view),
      getSnapshot: view.getSnapshot.bind(view),
    }),
    [view],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => view.commit(), [view]);
  return snapshot;
}
