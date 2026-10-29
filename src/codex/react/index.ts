import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { CodexViewPort, CodexViewSnapshot } from "../client/index.js";

/** Rendering is inert. Only the committed lease requests observations and a
 * missing initial passive baseline; unmount never closes the retained view. */
export function useCodexView(view: CodexViewPort): CodexViewSnapshot {
  const store = useMemo(
    () => ({
      getSnapshot: view.getSnapshot.bind(view),
      subscribe: view.subscribe.bind(view),
    }),
    [view],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => view.commit(), [view]);
  return snapshot;
}
