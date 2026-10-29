import type { HistoryRecord, HistoryScope, NativePage } from "../../src/history/index.js";
export const scope: HistoryScope = {
  run: {
    scope: { connection: "fixture", principal: "owner", host: "host", session: "chat" },
    generation: 1,
    nativeSession: "native",
  },
  attachment: "capture-one",
  stream: "root",
};
export const full = (id: string, text = id): HistoryRecord => ({
  id,
  kind: "assistant",
  lifecycle: "completed",
  body: { kind: "complete", text, evidence: "native" },
  native: {},
});
export const page = (
  rows: readonly HistoryRecord[],
  nextCursor: string | null = null,
): NativePage => ({ status: "page", scope, rows, nextCursor, placement: "before" });
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
