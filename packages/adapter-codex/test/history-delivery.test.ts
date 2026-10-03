import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/adapter.js";
import { codexHistoryDeliveryFacts } from "../src/history-delivery.js";
import type { CodexRpcConnection } from "../src/rpc.js";

const entry = (clientId: unknown = "exact-client", turnId: unknown = "exact-turn") => ({
  turnId, item: { type: "userMessage", id: "native-item", clientId, content: [] },
});

describe("Codex historical message delivery", () => {
  it("requires an exact client identity and containing turn without text inference", () => {
    expect(codexHistoryDeliveryFacts({ data: [entry(), entry(null), entry("", "turn"), entry("client", ""),
      entry("client", null), { ...entry(), item: { type: "agentMessage", id: "exact-client", text: "same text" } }] }, "root"))
      .toEqual([{ type: "messageConsumed", messageId: "exact-client", owner: "root" }]);
  });

  it("rejects foreign ownership wherever a native producer supplies it", () => {
    expect(codexHistoryDeliveryFacts({ threadId: "foreign", data: [entry()] }, "root")).toEqual([]);
    expect(codexHistoryDeliveryFacts({ data: [{ ...entry(), threadId: "foreign" },
      { ...entry(), item: { ...entry().item, threadId: "foreign" } }] }, "root")).toEqual([]);
  });

  it("the real adapter extracts root item pages and never child/turn pages", async () => {
    const listeners = new Set<(message: string) => void>();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const connection: CodexRpcConnection = {
      start: async () => undefined, close: async () => undefined,
      onMessage: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      onExit: () => () => undefined,
      send: async encoded => {
        const message = JSON.parse(encoded); requests.push(message);
        if (message.id === undefined) return;
        const result = message.method === "thread/start"
          ? { thread: { id: "root", sessionId: "tree", cwd: "/workspace", status: { type: "idle" } }, model: "fixture", reasoningEffort: null }
          : message.method === "thread/read"
            ? { thread: { id: "child", sessionId: "tree", parentThreadId: "root" } }
            : message.method === "thread/items/list"
              ? { data: [entry()], nextCursor: null, backwardsCursor: null }
              : message.method === "thread/turns/list"
                ? { data: [], nextCursor: null, backwardsCursor: null } : {};
        for (const listener of listeners) listener(JSON.stringify({ id: message.id, result }));
      },
    };
    const adapter = new CodexAdapter({ createConnection: () => connection });
    try {
      const session = await adapter.spawn({ harness: "codex", cwd: "/workspace" });
      const root = await session.readNativeHistory({ harness: "codex", includeTurns: true, limit: 1 });
      expect(root.messageDeliveryFacts).toEqual([{ type: "messageConsumed", messageId: "exact-client", owner: "root" }]);
      const child = await session.readNativeHistory({ harness: "codex", includeTurns: true, limit: 1, native: { view: "child", threadId: "child" } });
      expect(child.messageDeliveryFacts).toBeUndefined();
      expect(child.payload).toMatchObject({ threadId: "child" });
      const turns = await session.readNativeHistory({ harness: "codex", includeTurns: true, limit: 1, native: { view: "turns" } });
      expect(turns.messageDeliveryFacts).toBeUndefined();
      expect(requests.filter(request => request.method === "thread/items/list").map(request => request.params.threadId)).toEqual(["root", "child"]);
    } finally { await adapter.close(); }
  });
});
