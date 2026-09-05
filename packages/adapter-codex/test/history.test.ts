import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/adapter.js";
import type { CodexRpcConnection } from "../src/rpc.js";

describe("Codex native history pagination", () => {
  it.each(["text", "numbers"] as const)("retries an oversized %s page at the same cursor with a smaller limit", async (kind) => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const listeners = new Set<(message: string) => void>();
    const connection: CodexRpcConnection = {
      start: async () => undefined,
      close: async () => undefined,
      onMessage: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      onExit: () => () => undefined,
      send: async (encoded) => {
        const message = JSON.parse(encoded);
        requests.push(message);
        if (message.id === undefined) return;
        const result = message.method === "thread/start"
          ? { thread: { id: "native-1", cwd: "/workspace", status: { type: "idle" } }, model: "mock", reasoningEffort: null }
          : message.method === "thread/items/list"
            ? { data: Array.from({ length: message.params.limit }, (_, index) => ({ turnId: "turn-1", item: { type: "agentMessage", id: `item-${index}`, ...(kind === "text" ? { text: "x".repeat(600_000) } : { nativeNumbers: Array(45_000).fill(0.1) }) } })), nextCursor: "native-next", backwardsCursor: "native-previous" }
            : {};
        for (const listener of listeners) listener(JSON.stringify({ id: message.id, result }));
      },
    };
    const adapter = new CodexAdapter({ createConnection: () => connection });
    try {
      const session = await adapter.spawn({ harness: "codex", cwd: "/workspace" });
      const result = await session.readNativeHistory({ harness: "codex", includeTurns: true, limit: 2, cursor: "native-original", native: { threadId: "wrong", cursor: "wrong", turnId: "wrong", limit: 5000 } });
      expect(result.nextCursor).toBe("native-next");
      expect(result.complete).toBe(false);
      const pages = requests.filter((request) => request.method === "thread/items/list");
      expect(pages.map(({ params }) => params.limit)).toEqual([2, 1]);
      expect(pages.every(({ params }) => params.cursor === "native-original" && params.threadId === "native-1" && params.turnId === null)).toBe(true);
    } finally { await adapter.close(); }
  });
});
