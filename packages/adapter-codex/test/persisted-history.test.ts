import { describe, expect, it, vi } from "vitest";
import { CodexHistoryReader } from "../src/history.js";
import type { CodexRpcClient } from "../src/rpc.js";
describe("Codex detached history", () => {
  it("reads native items without loading/resuming the thread", async () => {
    const request = vi.fn(async () => ({ data: [{ turnId: "turn", item: { id: "message", type: "agentMessage", text: "retained" } }], nextCursor: null, backwardsCursor: null }));
    const result = await new CodexHistoryReader({ request } as unknown as CodexRpcClient, "native-session").read({ harness: "codex", limit: 100, includeTurns: true });
    expect(request.mock.calls[0]?.[0]).toBe("thread/items/list"); expect(request).toHaveBeenCalledTimes(1);
    expect(result.complete).toBe(true); expect(result.conversation?.items[0]?.threadId).toBe("native-session");
  });
  it("rejects a foreign child before reading its items", async () => {
    const request = vi.fn(async (_method, input) => ({ thread: { id: input.threadId, sessionId: input.threadId === "native-session" ? "tree-owner" : "foreign", parentThreadId: "native-session" } }));
    const reader = new CodexHistoryReader({ request } as unknown as CodexRpcClient, "native-session");
    await expect(reader.read({ harness: "codex", limit: 100, includeTurns: true, native: { view: "child", threadId: "foreign-child" } })).rejects.toThrow("another session tree");
    expect(request.mock.calls.map(call => call[0])).toEqual(["thread/read", "thread/read"]);
  });
});
