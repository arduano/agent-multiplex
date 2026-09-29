import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/adapter.js";
import type { CodexRpcConnection } from "../src/rpc.js";

function fixture() {
  const listeners = new Set<(message: string) => void>();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const threads: Record<string, { id: string; sessionId: string; parentThreadId: string | null }> = {
    root: { id: "root", sessionId: "tree", parentThreadId: null },
    child: { id: "child", sessionId: "tree", parentThreadId: "root" },
    nested: { id: "nested", sessionId: "tree", parentThreadId: "child" },
    foreign: { id: "foreign", sessionId: "other-tree", parentThreadId: "root" },
    unrelated: { id: "unrelated", sessionId: "tree", parentThreadId: null },
  };
  const connection: CodexRpcConnection = {
    start: async () => undefined, close: async () => undefined,
    onMessage: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onExit: () => () => undefined,
    send: async encoded => {
      const message = JSON.parse(encoded);
      calls.push(message);
      if (message.id === undefined) return;
      const result = message.method === "thread/start"
        ? { thread: { ...threads.root, cwd: "/workspace", status: { type: "idle" } }, model: "mock", reasoningEffort: null }
        : message.method === "thread/read" ? { thread: threads[message.params.threadId] }
        : message.method === "thread/items/list"
          ? { data: [{ turnId: "turn", item: { id: "reply", type: "agentMessage", text: "child result" } }],
            nextCursor: null, backwardsCursor: null } : {};
      for (const listener of listeners) listener(JSON.stringify({ id: message.id, result }));
    },
  };
  return { adapter: new CodexAdapter({ createConnection: () => connection }), calls };
}

describe("Codex child native history", () => {
  it("reads only a verified descendant and retains the logical root binding", async () => {
    const { adapter, calls } = fixture();
    try {
      const session = await adapter.spawn({ harness: "codex", cwd: "/workspace" });
      const request = { harness: "codex" as const, includeTurns: true, limit: 10,
        native: { view: "child", threadId: "nested", sortDirection: "desc" } };
      const first = await session.readNativeHistory(request);
      expect(first).toMatchObject({ harness: "codex", vendorSessionId: "root", complete: true,
        payload: { threadId: "nested", data: [{ item: { text: "child result" } }] } });
      expect(calls.filter(call => call.method === "thread/read").map(call => call.params.threadId)).toEqual(["nested", "child"]);
      expect(calls.find(call => call.method === "thread/items/list")?.params).toMatchObject({ threadId: "nested", limit: 10, sortDirection: "desc" });
      await session.readNativeHistory(request);
      expect(calls.filter(call => call.method === "thread/read")).toHaveLength(2);
    } finally { await adapter.close(); }
  });

  it("refuses another tree or a same-tree non-descendant before item access", async () => {
    const { adapter, calls } = fixture();
    try {
      const session = await adapter.spawn({ harness: "codex", cwd: "/workspace" });
      for (const threadId of ["foreign", "unrelated", "root", ""]) {
        await expect(session.readNativeHistory({ harness: "codex", includeTurns: true,
          native: { view: "child", threadId } })).rejects.toThrow();
      }
      expect(calls.some(call => call.method === "thread/items/list")).toBe(false);
    } finally { await adapter.close(); }
  });
});
