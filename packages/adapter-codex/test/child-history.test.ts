import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/adapter.js";
import { CodexHistoryReader } from "../src/history.js";
import type { CodexRpcClient } from "../src/rpc.js";
import type { CodexRpcConnection } from "../src/rpc.js";
import { NATIVE_PAYLOAD_MAX_BYTES, toJsonValue } from "@arduano/agent-multiplex-protocol";
import { codexHistoryPageBytes } from "../src/images.js";

function fixture() {
  const listeners = new Set<(message: string) => void>();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const threads: Record<string, { id: string; sessionId: string; parentThreadId: string | null;
    model?: unknown; reasoningEffort?: unknown; updatedAt?: unknown; modelProvider?: unknown; source?: unknown }> = {
    root: { id: "root", sessionId: "tree", parentThreadId: null, model: "parent-only", modelProvider: "provider-only" },
    child: { id: "child", sessionId: "tree", parentThreadId: "root", model: "child-configured", reasoningEffort: "high", updatedAt: 1_800_000_000 },
    nested: { id: "nested", sessionId: "tree", parentThreadId: "child", model: "nested-configured", reasoningEffort: "ultra", updatedAt: 1_800_000_001 },
    foreign: { id: "foreign", sessionId: "other-tree", parentThreadId: "root" },
    unrelated: { id: "unrelated", sessionId: "tree", parentThreadId: null },
  };
  let page = { data: [{ turnId: "turn", item: { id: "reply", type: "agentMessage", text: "child result" } }],
    nextCursor: null as string | null, backwardsCursor: null as string | null };
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
        : message.method === "thread/items/list" ? page : {};
      for (const listener of listeners) listener(JSON.stringify({ id: message.id, result }));
    },
  };
  return { adapter: new CodexAdapter({ createConnection: () => connection }), calls, threads,
    setPage: (value: typeof page) => { page = value; } };
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
        payload: { threadId: "nested", data: [{ item: { text: "child result" } }],
          childThread: { projection: "codex.child-settings.v1", id: "nested", model: "nested-configured", reasoningEffort: "ultra", updatedAt: 1_800_000_001 } } });
      expect(calls.filter(call => call.method === "thread/read").map(call => call.params.threadId)).toEqual(["nested", "child"]);
      expect(calls.find(call => call.method === "thread/items/list")?.params).toMatchObject({ threadId: "nested", limit: 10, sortDirection: "desc" });
      await session.readNativeHistory(request);
      expect(calls.filter(call => call.method === "thread/read").map(call => call.params.threadId)).toEqual(["nested", "child", "nested", "child"]);
      expect(calls.filter(call => call.method === "thread/read").every(call => call.params.includeTurns === false)).toBe(true);
    } finally { await adapter.close(); }
  });

  it("refreshes one reopened child selection and omits settings on older item pages", async () => {
    const { adapter, calls, threads } = fixture();
    try {
      const session = await adapter.spawn({ harness: "codex", cwd: "/workspace" });
      const request = { harness: "codex" as const, includeTurns: true,
        native: { view: "child", threadId: "child", sortDirection: "desc" } };
      const first = await session.readNativeHistory(request);
      expect(first.payload).toMatchObject({ childThread: { id: "child", model: "child-configured" } });
      threads.child!.model = "new-native-configuration";
      threads.child!.reasoningEffort = "medium";
      threads.child!.updatedAt = 1_800_000_002;
      const reopened = await session.readNativeHistory(request);
      expect(reopened.payload).toMatchObject({ childThread: { model: "new-native-configuration", reasoningEffort: "medium", updatedAt: 1_800_000_002 } });
      const oldPage = await session.readNativeHistory({ ...request, cursor: "native-older-cursor" });
      expect(oldPage.payload).not.toHaveProperty("childThread");
      expect(calls.filter(call => call.method === "thread/read").map(call => call.params)).toEqual([
        { threadId: "child", includeTurns: false }, { threadId: "child", includeTurns: false },
      ]);
      expect(calls.filter(call => call.method === "thread/items/list").at(-1)?.params.cursor).toBe("native-older-cursor");
      expect(JSON.stringify(reopened.payload)).not.toContain("parent-only");
      expect(JSON.stringify(reopened.payload)).not.toContain("provider-only");
    } finally { await adapter.close(); }
  });

  it("preserves explicit unavailable and malformed selection without guessing a child model", async () => {
    const { adapter, threads } = fixture();
    try {
      const session = await adapter.spawn({ harness: "codex", cwd: "/workspace" });
      for (const value of [null, undefined, "", " \t ", "invalid\nmodel", "x".repeat(257), { model: "requested-only" }]) {
        threads.child!.model = value;
        threads.child!.reasoningEffort = value;
        threads.child!.updatedAt = "bad-timestamp";
        const result = await session.readNativeHistory({ harness: "codex", includeTurns: true,
          native: { view: "child", threadId: "child" } });
        expect(result.payload).toMatchObject({ childThread: { projection: "codex.child-settings.v1", id: "child", model: null, reasoningEffort: null, updatedAt: null } });
      }
      threads.child!.model = "x".repeat(256);
      threads.child!.reasoningEffort = "ultra";
      threads.child!.updatedAt = 8_640_000_000_001;
      const validModel = await session.readNativeHistory({ harness: "codex", includeTurns: true,
        native: { view: "child", threadId: "child" } });
      expect(validModel.payload).toMatchObject({ childThread: { model: "x".repeat(256), reasoningEffort: "ultra", updatedAt: null } });
    } finally { await adapter.close(); }
  });

  it("rejects changed fresh child ownership before page access even after authorization was cached", async () => {
    for (const replacement of [
      { id: "wrong-child" }, { sessionId: "foreign-tree" }, { parentThreadId: null }, { parentThreadId: "child" },
    ]) {
      const { adapter, calls, threads } = fixture();
      try {
        const session = await adapter.spawn({ harness: "codex", cwd: "/workspace" });
        const request = { harness: "codex" as const, includeTurns: true, native: { view: "child", threadId: "child" } };
        await session.readNativeHistory(request);
        Object.assign(threads.child!, replacement);
        await expect(session.readNativeHistory(request)).rejects.toThrow();
        await expect(session.readNativeHistory({ ...request, cursor: "native-older-cursor" })).rejects.toThrow();
        expect(calls.filter(call => call.method === "thread/items/list")).toHaveLength(1);
      } finally { await adapter.close(); }
    }
  });

  it("does not let a previously authorized descendant certify a changed cyclic parent", async () => {
    const { adapter, calls, threads } = fixture();
    try {
      const session = await adapter.spawn({ harness: "codex", cwd: "/workspace" });
      await session.readNativeHistory({ harness: "codex", includeTurns: true,
        native: { view: "child", threadId: "nested" } });
      threads.child!.parentThreadId = "nested";
      await expect(session.readNativeHistory({ harness: "codex", includeTurns: true,
        native: { view: "child", threadId: "child" } })).rejects.toThrow("Cyclic");
      expect(calls.filter(call => call.method === "thread/items/list")).toHaveLength(1);
    } finally { await adapter.close(); }
  });

  it("includes child settings in the wire budget and preserves them with an explicit oversized-item omission", async () => {
    const { adapter, calls, setPage } = fixture();
    const base = { data: [{ turnId: "turn", item: { id: "large", type: "agentMessage", text: "" } }],
      nextCursor: "native-next", backwardsCursor: null };
    const overhead = codexHistoryPageBytes(toJsonValue(base));
    const page = { ...base, data: [{ ...base.data[0]!, item: { ...base.data[0]!.item,
      text: "x".repeat(NATIVE_PAYLOAD_MAX_BYTES - overhead - 1) } }] };
    expect(codexHistoryPageBytes(toJsonValue(page))).toBeLessThan(NATIVE_PAYLOAD_MAX_BYTES);
    setPage(page);
    try {
      const session = await adapter.spawn({ harness: "codex", cwd: "/workspace" });
      const request = { harness: "codex" as const, includeTurns: true, limit: 1,
        native: { view: "child", threadId: "child", omitOversizedItems: true } };
      const result = await session.readNativeHistory(request);
      expect(result).toMatchObject({ vendorSessionId: "root", complete: false, nextCursor: "native-next",
        unavailableItem: { reason: "exceedsWireLimit", nativeItemId: "large" },
        payload: { threadId: "child", data: [], childThread: { id: "child", model: "child-configured" } } });
      expect(codexHistoryPageBytes(result.payload)).toBeLessThan(NATIVE_PAYLOAD_MAX_BYTES);
      expect(calls.filter(call => call.method === "thread/items/list")).toHaveLength(1);
      await expect(session.readNativeHistory({ ...request, native: { view: "child", threadId: "child" } }))
        .rejects.toThrow("bounded wire envelope");
    } finally { await adapter.close(); }
  });

  it("refuses another tree or a same-tree non-descendant before item access", async () => {
    const { adapter, calls } = fixture();
    try {
      const session = await adapter.spawn({ harness: "codex", cwd: "/workspace" });
      for (const threadId of ["foreign", "unrelated", "root", "", undefined]) {
        await expect(session.readNativeHistory({ harness: "codex", includeTurns: true,
          native: { view: "child", ...(threadId === undefined ? {} : { threadId }) } })).rejects.toThrow();
      }
      expect(calls.some(call => call.method === "thread/items/list")).toBe(false);
    } finally { await adapter.close(); }
  });

  it("reads a cold unloaded child's own context with agreeing direct/source ancestry", async () => {
    const { adapter, calls, threads } = fixture();
    threads.child!.sessionId = "child";
    threads.child!.source = { subAgent: { thread_spawn: { parent_thread_id: "root" } } };
    try {
      const session = await adapter.spawn({ harness: "codex", cwd: "/workspace" });
      const result = await session.readNativeHistory({ harness: "codex", includeTurns: true,
        native: { view: "child", threadId: "child" } });
      expect(result).toMatchObject({ vendorSessionId: "root", payload: { threadId: "child", data: [{ item: { text: "child result" } }] } });
      expect(calls.filter(call => call.method === "thread/items/list")).toHaveLength(1);
      expect(threads.child!.sessionId).toBe("child");
    } finally { await adapter.close(); }
  });

  it("accepts inherited fork-all context only after proving its fork-none ancestor", async () => {
    const { adapter, calls, threads } = fixture();
    threads.child!.sessionId = "child";
    threads.nested!.sessionId = "child";
    try {
      const session = await adapter.spawn({ harness: "codex", cwd: "/workspace" });
      await session.readNativeHistory({ harness: "codex", includeTurns: true, native: { view: "child", threadId: "nested" } });
      expect(calls.filter(call => call.method === "thread/read").map(call => call.params.threadId)).toEqual(["nested", "child"]);
      threads.child!.sessionId = "nested";
      await expect(session.readNativeHistory({ harness: "codex", includeTurns: true,
        native: { view: "child", threadId: "nested" } })).rejects.toThrow("another session tree");
      expect(calls.filter(call => call.method === "thread/items/list")).toHaveLength(1);
    } finally { await adapter.close(); }
  });

  it("accepts canonical and legacy source-only parents but rejects conflicting or malformed ancestry", async () => {
    for (const kind of ["subagent", "subAgent"]) {
      const { adapter, calls, threads } = fixture();
      threads.child!.parentThreadId = null;
      threads.child!.source = { [kind]: { thread_spawn: { parent_thread_id: "root" } } };
      try {
        const session = await adapter.spawn({ harness: "codex", cwd: "/workspace" });
        const request = { harness: "codex" as const, includeTurns: true, native: { view: "child", threadId: "child" } };
        await session.readNativeHistory(request);
        threads.child!.parentThreadId = "nested";
        await expect(session.readNativeHistory(request)).rejects.toThrow("Conflicting");
        threads.child!.parentThreadId = "root";
        threads.child!.source = { [kind]: { thread_spawn: { parent_thread_id: "bad\nparent" } } };
        await expect(session.readNativeHistory(request)).rejects.toThrow("Invalid");
        threads.child!.source = { subagent: { thread_spawn: { parent_thread_id: "root" } }, subAgent: { thread_spawn: { parent_thread_id: "nested" } } };
        await expect(session.readNativeHistory(request)).rejects.toThrow("Conflicting");
        for (const malformed of [null, {}, { parent_thread_id: null }]) {
          threads.child!.source = { [kind]: { thread_spawn: malformed } };
          await expect(session.readNativeHistory(request)).rejects.toThrow("Invalid");
        }
        expect(calls.filter(call => call.method === "thread/items/list")).toHaveLength(1);
      } finally { await adapter.close(); }
    }
  });

  it("bounds metadata ancestry at 32 nodes and never opens items beyond it", async () => {
    for (const count of [32, 33]) {
      const { adapter, calls, threads } = fixture();
      for (let index = 0; index < count; index++) threads[`depth-${index}`] = {
        id: `depth-${index}`, sessionId: `depth-${index}`, parentThreadId: index === count - 1 ? "root" : `depth-${index + 1}`,
      };
      try {
        const session = await adapter.spawn({ harness: "codex", cwd: "/workspace" });
        const result = session.readNativeHistory({ harness: "codex", includeTurns: true, native: { view: "child", threadId: "depth-0" } });
        if (count === 32) await expect(result).resolves.toMatchObject({ payload: { threadId: "depth-0" } });
        else await expect(result).rejects.toThrow("supported bound");
        expect(calls.filter(call => call.method === "thread/read")).toHaveLength(32);
        expect(calls.filter(call => call.method === "thread/items/list")).toHaveLength(count === 32 ? 1 : 0);
      } finally { await adapter.close(); }
    }
  });

  it("fences a retired metadata response and invalid root identity before any item read", async () => {
    const calls: string[] = [];
    let active = true;
    const rpc = { request: async (method: string, params: { threadId: string }) => {
      calls.push(method);
      if (params.threadId === "root") return { thread: { id: "root", sessionId: "root", parentThreadId: null } };
      active = false;
      return { thread: { id: "child", sessionId: "child", parentThreadId: "root" } };
    } } as unknown as CodexRpcClient;
    const reader = new CodexHistoryReader(rpc, "root", () => { if (!active) throw new Error("Attachment retired"); });
    await expect(reader.read({ harness: "codex", includeTurns: true, native: { view: "child", threadId: "child" } })).rejects.toThrow("Attachment retired");
    expect(calls).toEqual(["thread/read", "thread/read"]);
    for (const root of [{ id: "foreign", sessionId: "root" }, { id: "root" }, { id: "root", sessionId: "" }, { id: "root", sessionId: "bad\ncontext" }]) {
      const methods: string[] = [];
      const wrongRoot = new CodexHistoryReader({ request: async (method: string) => { methods.push(method); return { thread: root }; } } as unknown as CodexRpcClient, "root");
      await expect(wrongRoot.read({ harness: "codex", includeTurns: true, native: { view: "child", threadId: "child" } })).rejects.toThrow("another session tree");
      expect(methods).toEqual(["thread/read"]);
    }
  });

});
