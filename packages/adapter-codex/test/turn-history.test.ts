import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../src/adapter.js";
import type { CodexRpcClient } from "../src/rpc.js";
import type { Turn } from "../src/generated/v2/Turn.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(close.splice(0).map(action => action())); });

const failedTurn: Turn = {
  id: "failed-turn", items: [], itemsView: "summary", status: "failed",
  error: { message: "The model is at capacity", codexErrorInfo: "serverOverloaded", additionalDetails: "Native failure detail" },
  startedAt: 123, completedAt: 456, durationMs: 333_000,
};
const read = { harness: "codex", includeTurns: true, limit: 1, native: { view: "turns", sortDirection: "desc" } } as const;

async function fixture(respond: (params: Record<string, unknown>) => unknown = () => ({ data: [failedTurn], nextCursor: "older", backwardsCursor: "newer" })) {
  const request = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method === "thread/start") return { thread: { id: "native-thread", cwd: "/work", status: { type: "systemError" } }, model: "mock", reasoningEffort: null };
    if (method === "thread/turns/list") return respond(params!);
    if (method === "thread/unsubscribe") return {};
    throw new Error(`Unexpected native method ${method}`);
  });
  const rpc = {
    start: vi.fn(async () => {}), close: vi.fn(async () => {}), request,
    onNotification: () => () => {}, onServerRequest: () => () => {}, onExit: () => () => {},
  } as unknown as CodexRpcClient;
  const adapter = new CodexAdapter({ rpcClient: rpc });
  close.push(() => adapter.close());
  const session = await adapter.spawn({ harness: "codex", cwd: "/work" });
  request.mockClear();
  return { adapter, session, request };
}

describe("Codex bounded native turn history", () => {
  it("advertises the opt-in view and preserves native errors, status, timestamps and cursors", async () => {
    const f = await fixture();
    expect((await f.adapter.describe()).capabilities).toContainEqual({ name: "history.native.turns", version: "v1", experimental: false });
    const result = await f.session.readNativeHistory({ ...read, cursor: "original", native: {
      ...read.native, threadId: "wrong", cursor: "wrong", limit: 5_000, turnId: "wrong", itemsView: "full", omitOversizedItems: true,
    } });
    expect(result).toEqual({ harness: "codex", vendorSessionId: "native-thread", sortDirection: "desc", complete: false, nextCursor: "older",
      payload: { data: [failedTurn], nextCursor: "older", backwardsCursor: "newer" } });
    expect(f.request.mock.calls).toEqual([["thread/turns/list", {
      threadId: "native-thread", cursor: "original", limit: 1, sortDirection: "desc", itemsView: "summary",
    }]]);
  });

  it.each([undefined, 500])("caps the native turn count with requested limit %s", async limit => {
    const f = await fixture(() => ({ data: [], nextCursor: null, backwardsCursor: null }));
    const page = await f.session.readNativeHistory({ harness: "codex", includeTurns: true, ...(limit === undefined ? {} : { limit }), native: { view: "turns" } });
    expect(f.request.mock.calls).toEqual([["thread/turns/list", { threadId: "native-thread", cursor: null, limit: 100, sortDirection: "asc", itemsView: "summary" }]]);
    expect(page).toEqual({ harness: "codex", vendorSessionId: "native-thread", sortDirection: "asc", complete: true,
      payload: { data: [], nextCursor: null, backwardsCursor: null } });
  });

  it("re-reads oversized batches at the same native cursor without losing turns", async () => {
    const f = await fixture(params => ({ data: Array.from({ length: params.limit as number }, (_, index) => ({ ...failedTurn, id: `turn-${index}`, error: { ...failedTurn.error, additionalDetails: "x".repeat(600_000) } })), nextCursor: `after-${params.limit}`, backwardsCursor: "newer" }));
    const result = await f.session.readNativeHistory({ ...read, limit: 2, cursor: "original" });
    expect(f.request.mock.calls.map(([, params]) => params)).toEqual([
      { threadId: "native-thread", cursor: "original", limit: 2, sortDirection: "desc", itemsView: "summary" },
      { threadId: "native-thread", cursor: "original", limit: 1, sortDirection: "desc", itemsView: "summary" },
    ]);
    expect(result.nextCursor).toBe("after-1");
    expect(result.payload).toMatchObject({ data: [{ id: "turn-0", status: "failed" }] });
  });

  it("preserves turn errors with the native notLoaded view when the summary item is oversized", async () => {
    const metadata = { ...failedTurn, itemsView: "notLoaded" };
    const f = await fixture(params => ({ data: [params.itemsView === "summary"
      ? { ...failedTurn, items: [{ type: "agentMessage", id: "large", text: "x".repeat(2_000_000) }] }
      : metadata], nextCursor: "older", backwardsCursor: "newer" }));
    const result = await f.session.readNativeHistory({ ...read, cursor: "original" });
    expect(f.request.mock.calls.map(([, params]) => params)).toEqual([
      { threadId: "native-thread", cursor: "original", limit: 1, sortDirection: "desc", itemsView: "summary" },
      { threadId: "native-thread", cursor: "original", limit: 1, sortDirection: "desc", itemsView: "notLoaded" },
    ]);
    expect(result.payload).toEqual({ data: [metadata], nextCursor: "older", backwardsCursor: "newer" });
    expect(result.unavailableItem).toBeUndefined();
  });

  it.each([false, true])("handles oversized turn metadata with explicit omission %s", async omitOversizedItems => {
    const f = await fixture(params => ({ data: [{ ...failedTurn, itemsView: params.itemsView, error: { ...failedTurn.error, additionalDetails: "x".repeat(2_000_000) } }], nextCursor: "older", backwardsCursor: "newer" }));
    const result = f.session.readNativeHistory({ ...read, native: { ...read.native, omitOversizedItems } });
    if (omitOversizedItems) await expect(result).resolves.toEqual({ harness: "codex", vendorSessionId: "native-thread", sortDirection: "desc", complete: false, nextCursor: "older",
      payload: { data: [], nextCursor: "older", backwardsCursor: "newer" }, unavailableItem: { reason: "exceedsWireLimit", nativeItemId: "failed-turn" } });
    else await expect(result).rejects.toThrow("exceeds the bounded wire envelope");
    expect(f.request.mock.calls).toHaveLength(2);
  });

  it.each([
    { ...read, native: { view: "unknown" } }, { ...read, includeTurns: false },
    { ...read, native: { ...read.native, sortDirection: "invalid" } },
  ])("rejects unsupported view/direction before calling native history", async invalid => {
    const f = await fixture();
    await expect(f.session.readNativeHistory(invalid)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each([{}, { data: [], nextCursor: 7, backwardsCursor: null }, { data: [failedTurn, failedTurn], nextCursor: null, backwardsCursor: null }])("rejects a malformed native page", async response => {
    const f = await fixture(() => response);
    await expect(f.session.readNativeHistory(read)).rejects.toThrow("Unrecognized Codex turns history page");
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("preserves a native method failure without a full-history fallback or retry", async () => {
    const refusal = new Error("Native turn listing unavailable");
    const f = await fixture(() => { throw refusal; });
    await expect(f.session.readNativeHistory(read)).rejects.toBe(refusal);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});
