import { AdapterOutcomeUnknownError, type AdapterEvent } from "@arduano/agent-multiplex-runtime-node-core";
import { codexCommandSchema, nativeStateRequestSchema, NATIVE_PAYLOAD_MAX_BYTES } from "@arduano/agent-multiplex-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../src/adapter.js";
import { CodexRpcClient, type CodexNotification } from "../src/rpc.js";
import type { ThreadGoal } from "../src/generated/v2/ThreadGoal.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(close.splice(0).map(action => action())); });

const originalGoal: ThreadGoal = {
  threadId: "goal-thread", objective: "Implement native goals", status: "paused", tokenBudget: 50_000,
  tokensUsed: 12_345, timeUsedSeconds: 987, createdAt: 1_783_331_234, updatedAt: 1_783_332_000,
};

async function fixture(resume = false) {
  let notify!: (notification: CodexNotification) => void;
  let exit!: (error: Error) => void;
  let snapshot: unknown = { goal: originalGoal };
  let clearResult: unknown = { cleared: true };
  const thread = { id: originalGoal.threadId, cwd: "/work", updatedAt: 1, status: { type: "idle" } };
  const request = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method === "thread/start" || method === "thread/resume") {
      return { thread, model: "test-model", reasoningEffort: null };
    }
    if (method === "thread/goal/get") return snapshot;
    if (method === "thread/goal/set") return snapshot;
    if (method === "thread/goal/clear") return clearResult;
    if (method === "thread/unsubscribe") return {};
    throw new Error(`Unexpected native method ${method}`);
  });
  const rpc = {
    start: vi.fn(async () => {}), close: vi.fn(async () => {}), request,
    onNotification: (listener: typeof notify) => { notify = listener; return () => {}; },
    onServerRequest: () => () => {},
    onExit: (listener: typeof exit) => { exit = listener; return () => {}; },
  } as unknown as CodexRpcClient;
  const adapter = new CodexAdapter({ rpcClient: rpc });
  close.push(() => adapter.close());
  const session = resume
    ? await adapter.resume({ harness: "codex", vendorSessionId: originalGoal.threadId })
    : await adapter.spawn({ harness: "codex", cwd: "/work" });
  const events: AdapterEvent[] = [];
  session.subscribe(event => events.push(event));
  return { adapter, session, request, notify: (event: CodexNotification) => notify(event), exit: (error: Error) => exit(error), events,
    snapshot: (value: unknown) => { snapshot = value; }, clearResult: (value: unknown) => { clearResult = value; } };
}

const read = { harness: "codex", view: "goal" } as const;

describe("Codex native goal contract", () => {
  it("admits only the live Codex goal view and retains the Copilot queue view", () => {
    expect(nativeStateRequestSchema.parse(read)).toEqual(read);
    expect(nativeStateRequestSchema.parse({ harness: "copilot", view: "pendingMessages" })).toEqual({ harness: "copilot", view: "pendingMessages" });
    for (const invalid of [{ harness: "copilot", view: "goal" }, { ...read, threadId: "other" }, { ...read, view: "history" }]) {
      expect(nativeStateRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("preserves omitted budgets, explicit removal, and all native goal statuses", () => {
    expect(codexCommandSchema.parse({ type: "setGoal", objective: " A real objective " })).toEqual({ type: "setGoal", objective: " A real objective " });
    expect(codexCommandSchema.parse({ type: "setGoal", tokenBudget: null })).toEqual({ type: "setGoal", tokenBudget: null });
    for (const status of ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]) {
      expect(codexCommandSchema.parse({ type: "setGoal", status })).toEqual({ type: "setGoal", status });
    }
  });

  it.each([
    {}, { objective: "" }, { objective: " \n\t" }, { objective: "x".repeat(4_001) },
    { status: "done" }, { tokenBudget: 0 }, { tokenBudget: -1 }, { tokenBudget: 1.5 },
    { tokenBudget: Number.MAX_SAFE_INTEGER + 1 }, { objective: "valid", threadId: "other" },
    { objective: null }, { status: null },
  ])("rejects invalid setter %j", invalid => {
    expect(codexCommandSchema.safeParse({ type: "setGoal", ...invalid }).success).toBe(false);
  });
});

describe("Codex native goal observations", () => {
  it.each([false, true])("reads retained native goal on %s attachment without history or new work", async resume => {
    const f = await fixture(resume);
    expect((await f.adapter.describe()).capabilities).toContainEqual({ name: "thread.goal", version: "v2", experimental: true });
    f.request.mockClear();
    expect(await f.session.readNativeState!(read)).toEqual({ harness: "codex", vendorSessionId: originalGoal.threadId, payload: { goal: originalGoal } });
    expect(f.request.mock.calls).toEqual([["thread/goal/get", { threadId: originalGoal.threadId }]]);
  });

  it("does not cache a goal after root updates, clear, or another native client changes it", async () => {
    const f = await fixture();
    await f.session.readNativeState!(read);
    const next = { ...originalGoal, status: "complete", tokensUsed: 49_990, updatedAt: 1_783_333_000 };
    f.snapshot({ goal: next });
    f.notify({ method: "thread/goal/updated", params: { threadId: originalGoal.threadId, turnId: null, goal: next } });
    expect((await f.session.readNativeState!(read)).payload).toEqual({ goal: next });
    f.snapshot({ goal: null });
    f.notify({ method: "thread/goal/cleared", params: { threadId: originalGoal.threadId } });
    expect((await f.session.readNativeState!(read)).payload).toEqual({ goal: null });
    expect(f.events.filter(event => event.kind === "native")).toEqual([
      { kind: "native", nativeType: "thread/goal/updated", payload: { threadId: originalGoal.threadId, turnId: null, goal: next }, ephemeral: false },
      { kind: "native", nativeType: "thread/goal/cleared", payload: { threadId: originalGoal.threadId }, ephemeral: false },
    ]);
  });

  it("keeps descendant goal event ownership and root lifecycle distinct", async () => {
    const f = await fixture();
    f.notify({ method: "thread/started", params: { thread: { id: "child", parentThreadId: originalGoal.threadId } } });
    const childGoal = { ...originalGoal, threadId: "child", status: "active" };
    f.notify({ method: "thread/goal/updated", params: { threadId: "child", turnId: "child-turn", goal: childGoal } });
    expect(f.events).toContainEqual({ kind: "native", nativeType: "thread/goal/updated", payload: { threadId: "child", turnId: "child-turn", goal: childGoal }, ephemeral: false });
    expect(f.session.status()).toBe("idle");
    expect((await f.session.readNativeState!(read)).payload).toEqual({ goal: originalGoal });
  });

  it.each([{}, { goal: undefined }, { goal: { ...originalGoal, threadId: "other" } },
    { goal: { ...originalGoal, status: "done" } }, { goal: { ...originalGoal, tokensUsed: -1 } },
    { goal: { ...originalGoal, tokenBudget: "100" } }, { goal: { ...originalGoal, objective: "" } },
  ])("reports unavailable state rather than hiding malformed native goal %j", async invalid => {
    const f = await fixture();
    f.snapshot(invalid);
    await expect(f.session.readNativeState!(read)).rejects.toThrow("Unrecognized");
  });

  it("bounds native response bytes and preserves native errors", async () => {
    const f = await fixture();
    f.snapshot({ goal: originalGoal, future: "x".repeat(NATIVE_PAYLOAD_MAX_BYTES) });
    await expect(f.session.readNativeState!(read)).rejects.toThrow("bounded");
    f.request.mockRejectedValueOnce(new Error("Goals are unavailable"));
    await expect(f.session.readNativeState!(read)).rejects.toThrow("Goals are unavailable");
  });

  it.each(["stop", "close", "exit"])("fences late goal reads across %s", async action => {
    const f = await fixture();
    let resolve!: (value: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
    const result = f.session.readNativeState!(read);
    if (action === "stop") await f.session.stop();
    else if (action === "close") await f.adapter.close();
    else f.exit(new Error("app server ended"));
    resolve({ goal: originalGoal });
    await expect(result).rejects.toThrow("stopped");
    f.request.mockClear();
    await expect(f.session.readNativeState!(read)).rejects.toThrow("stopped");
    expect(f.request).not.toHaveBeenCalled();
  });
});

describe("Codex durable native goal commands", () => {
  it("maps create/edit/pause/resume/budget actions directly without implicit fields", async () => {
    const f = await fixture();
    f.request.mockClear();
    for (const patch of [{ objective: "New objective" }, { objective: "Edited objective" },
      { status: "paused" as const }, { status: "active" as const }, { tokenBudget: 100_000 }, { tokenBudget: null }]) {
      expect(await f.session.execute({ harness: "codex", command: { type: "setGoal", ...patch } })).toEqual({ goal: originalGoal });
      expect(f.request).toHaveBeenLastCalledWith("thread/goal/set", { threadId: originalGoal.threadId, ...patch });
    }
    expect(f.request).toHaveBeenCalledTimes(6);
  });

  it.each([true, false])("preserves native clear result %s without retries", async cleared => {
    const f = await fixture();
    f.clearResult({ cleared });
    f.request.mockClear();
    expect(await f.session.execute({ harness: "codex", command: { type: "clearGoal" } })).toEqual({ cleared });
    expect(f.request.mock.calls).toEqual([["thread/goal/clear", { threadId: originalGoal.threadId }]]);
  });

  it("preserves explicit native refusals and transport unknown outcomes without retries", async () => {
    const f = await fixture();
    const command = { harness: "codex", command: { type: "setGoal", status: "active" } } as const;
    const refused = new Error("Cannot resume a complete goal");
    f.request.mockRejectedValueOnce(refused);
    await expect(f.session.execute(command)).rejects.toBe(refused);
    const unknown = new AdapterOutcomeUnknownError("Native transport closed after dispatch");
    f.request.mockRejectedValueOnce(unknown);
    await expect(f.session.execute(command)).rejects.toBe(unknown);
  });

  it("classifies malformed mutation acknowledgements as outcome unknown", async () => {
    const f = await fixture();
    f.snapshot({ goal: null });
    await expect(f.session.execute({ harness: "codex", command: { type: "setGoal", objective: "Real goal" } })).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    f.clearResult({});
    await expect(f.session.execute({ harness: "codex", command: { type: "clearGoal" } })).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
  });

  it.each(["setGoal", "clearGoal"] as const)("fences delayed %s acknowledgement after stop", async type => {
    const f = await fixture();
    let resolve!: (value: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
    const pending = f.session.execute({ harness: "codex", command: type === "setGoal" ? { type, status: "paused" } : { type } });
    await f.session.stop();
    resolve(type === "setGoal" ? { goal: originalGoal } : { cleared: true });
    await expect(pending).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    f.request.mockClear();
    await expect(f.session.execute({ harness: "codex", command: { type: "clearGoal" } })).rejects.toThrow("stopped");
    expect(f.request).not.toHaveBeenCalled();
  });
});
