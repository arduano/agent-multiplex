import { AdapterOutcomeUnknownError, type AdapterEvent } from "@arduano/agent-multiplex-runtime-node-core";
import { codexCommandSchema } from "@arduano/agent-multiplex-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../src/adapter.js";
import { CodexRpcClient, CodexRpcError, type CodexNotification } from "../src/rpc.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(close.splice(0).map(action => action())); });
const command = { harness: "codex", command: { type: "compact" } } as const;

async function fixture() {
  let notify!: (notification: CodexNotification) => void;
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === "thread/start") return { thread: { id: "compact-thread", cwd: "/work", updatedAt: 1, status: { type: "idle" } }, model: "fixture", reasoningEffort: null };
    if (method === "thread/compact/start" || method === "thread/unsubscribe") return {};
    throw new Error(`Unexpected native method ${method}`);
  });
  const rpc = { start: async () => {}, close: async () => {}, request,
    onNotification: (listener: typeof notify) => { notify = listener; return () => {}; },
    onServerRequest: () => () => {}, onExit: () => () => {},
  } as unknown as CodexRpcClient;
  const adapter = new CodexAdapter({ rpcClient: rpc });
  close.push(() => adapter.close());
  const session = await adapter.spawn({ harness: "codex", cwd: "/work" });
  const events: AdapterEvent[] = []; session.subscribe(event => events.push(event));
  request.mockClear();
  return { adapter, session, request, events, notify: (event: CodexNotification) => notify(event) };
}

describe("Codex native compaction", () => {
  it("advertises and dispatches the exact bound native start without a prompt or history read", async () => {
    const f = await fixture();
    expect((await f.adapter.describe()).capabilities).toContainEqual({ name: "context.compact", version: "v1", experimental: false });
    expect(await f.session.execute(command)).toEqual({});
    expect(f.request.mock.calls).toEqual([["thread/compact/start", { threadId: "compact-thread" }]]);
    expect(f.session.status()).toBe("idle");
  });

  it("preserves native compaction progress rather than reporting completion from the start acknowledgement", async () => {
    const f = await fixture();
    await f.session.execute(command);
    f.notify({ method: "turn/started", params: { threadId: "compact-thread", turn: { id: "compact-turn", items: [], status: "inProgress", error: null } } });
    expect(f.session.status()).toBe("running");
    f.notify({ method: "item/completed", params: { threadId: "compact-thread", turnId: "compact-turn", item: { id: "compact-item", type: "contextCompaction" } } });
    expect(f.events.some(event => event.kind === "native" && event.nativeType === "item/completed")).toBe(true);
    f.notify({ method: "turn/completed", params: { threadId: "compact-thread", turn: { id: "compact-turn", items: [], status: "completed", error: null } } });
    expect(f.session.status()).toBe("idle");
  });

  it("preserves definite native refusal and transport ambiguity without retry", async () => {
    const f = await fixture();
    const refusal = new CodexRpcError("thread is busy", -32600);
    f.request.mockRejectedValueOnce(refusal);
    await expect(f.session.execute(command)).rejects.toBe(refusal);
    const unknown = new AdapterOutcomeUnknownError("connection closed after dispatch");
    f.request.mockRejectedValueOnce(unknown);
    await expect(f.session.execute(command)).rejects.toBe(unknown);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, [], true, { success: true }])("keeps malformed acknowledgement %j unknown", async response => {
    const f = await fixture(); f.request.mockResolvedValueOnce(response);
    await expect(f.session.execute(command)).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("fences delayed acknowledgement and never activates a retired session", async () => {
    const f = await fixture(); let release!: (value: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.session.execute(command); await f.session.stop(); release({});
    await expect(pending).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    f.request.mockClear(); await expect(f.session.execute(command)).rejects.toThrow("stopped");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("rejects arguments and alternate thread targeting before dispatch", async () => {
    const f = await fixture();
    for (const extra of [{ threadId: "other" }, { customInstructions: "summarize" }, { input: "/compact" }]) {
      const invalid = { type: "compact", ...extra } as const;
      expect(codexCommandSchema.safeParse(invalid).success).toBe(false);
      await expect(f.session.execute({ harness: "codex", command: invalid })).rejects.toThrow();
    }
    expect(f.request).not.toHaveBeenCalled();
  });
});
