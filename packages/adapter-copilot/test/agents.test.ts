import type { SessionEvent } from "@github/copilot-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeStateRequestSchema } from "@arduano/agent-multiplex-protocol";
import { CopilotAdapterSession, CopilotSessionBridge, type CopilotSessionRpc } from "../src/session.js";

const registered = { id: "luna-reviewer", name: "luna-reviewer", displayName: "Luna reviewer", description: "Disposable read-only review",
  source: "user", model: "gpt-6-luna", models: ["gpt-6-luna"], modelPolicy: "required", tools: ["read_file"],
  userInvocable: true, disableModelInvocation: false };
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(list = vi.fn<NonNullable<CopilotSessionRpc["agent"]>["list"]>(async () => ({ agents: [registered] }))) {
  const rpc: CopilotSessionRpc = { mode: { set: vi.fn(async () => {}) }, agent: { list } };
  const bridge = new CopilotSessionBridge();
  const send = vi.fn(async () => "never"), getEvents = vi.fn(async () => []), disconnect = vi.fn(async () => {});
  const session = new CopilotAdapterSession({ adapterScopeId: "agents-test", cwd: "/disposable", runtimeEpoch: "agents-epoch",
    native: { sessionId: "agents-session", rpc, send, abort: vi.fn(async () => {}), setModel: vi.fn(async () => {}), getEvents, disconnect },
    bridge, settings: {}, onStopped: () => {} });
  return { session, rpc, bridge, list, send, getEvents, disconnect };
}
const read = { harness: "copilot", view: "agents" } as const;
function updated(agentId?: string) {
  return { type: "session.custom_agents_updated", id: "registry-update", parentId: null, timestamp: "2026-10-04T00:00:00Z",
    data: { agents: [] }, ...(agentId === undefined ? {} : { agentId }) } as SessionEvent;
}
afterEach(() => vi.useRealTimers());

describe("bounded read-only Copilot agent registry", () => {
  it("reads only the existing session registry, preserving the exact required authored model", async () => {
    const f = fixture();
    expect(await f.session.readNativeState(read)).toEqual({ harness: "copilot", vendorSessionId: "agents-session", payload: { agents: [registered] } });
    expect(f.list).toHaveBeenCalledExactlyOnceWith({ includeBuiltInAgents: false, includePrompt: false });
    expect(f.send).not.toHaveBeenCalled(); expect(f.getEvents).not.toHaveBeenCalled(); expect(f.rpc.mode.set).not.toHaveBeenCalled();
    expect(f.session.status()).toBe("idle");
  });

  it("strips prompts, native paths, MCP definitions and arbitrary metadata at every projected level", async () => {
    const f = fixture(vi.fn(async () => ({ agents: [{ ...registered, prompt: "Never forwarded", path: "/not-forwarded",
      mcpServers: { server: { command: "not-forwarded" } }, skills: ["not-forwarded"], extension: { notForwarded: true } }],
      prompt: "Not forwarded", extension: { notForwarded: true } })));
    expect((await f.session.readNativeState(read)).payload).toEqual({ agents: [registered] });
  });

  it("preserves an empty registry, empty tools and omitted model settings without inference", async () => {
    const f = fixture(vi.fn(async () => ({ agents: [] })));
    expect((await f.session.readNativeState(read)).payload).toEqual({ agents: [] });
    f.list.mockResolvedValueOnce({ agents: [{ id: "minimal", name: "minimal", displayName: "", description: "", tools: [] }] });
    expect((await f.session.readNativeState(read)).payload).toEqual({ agents: [{ id: "minimal", name: "minimal", displayName: "", description: "", tools: [] }] });
  });

  it.each([
    null, {}, { agents: "missing" }, { agents: [null] }, { agents: [{ ...registered, id: "" }] },
    { agents: [{ ...registered, model: 42 }] }, { agents: [{ ...registered, models: [42] }] },
    { agents: [{ ...registered, modelPolicy: "fallback" }] }, { agents: [{ ...registered, source: "builtin", prompt: "Builtin prompt" }] },
    { agents: [{ ...registered, tools: null }] }, { agents: [{ ...registered, userInvocable: "yes" }] },
    { agents: [{ ...registered, description: "x".repeat(16_385) }] },
    { agents: [{ ...registered, models: Array.from({ length: 65 }, () => "gpt-6-luna") }] },
    { agents: [{ ...registered, tools: Array.from({ length: 257 }, () => "read_file") }] },
    { agents: Array.from({ length: 1_001 }, () => registered) },
    { agents: Array.from({ length: 100 }, (_, i) => ({ ...registered, id: `agent-${i}`, description: "x".repeat(16_384) })) },
  ])("rejects malformed, built-in or oversized native registry replies", async value => {
    const f = fixture(vi.fn(async () => value));
    await expect(f.session.readNativeState(read)).rejects.toThrow(/Unrecognized|bounded/);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("coalesces the same in-flight registry observation without another native request", async () => {
    const native = deferred<unknown>(); const f = fixture(vi.fn(() => native.promise));
    const first = f.session.readNativeState(read), second = f.session.readNativeState(read);
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
    native.resolve({ agents: [registered] });
    expect((await first).payload).toEqual({ agents: [registered] });
    expect(await second).toEqual(await first); expect(f.list).toHaveBeenCalledOnce();
  });

  it("retains an unacknowledged read lane after timeout; late settlement cannot rewrite that failure", async () => {
    vi.useFakeTimers(); const native = deferred<unknown>(); const f = fixture(vi.fn(() => native.promise));
    const first = f.session.readNativeState(read).catch(error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    const failure = await first; expect(failure).toBeInstanceOf(Error); expect(failure.message).toContain("remains pending");
    await expect(f.session.readNativeState(read)).rejects.toThrow("remains pending");
    expect(f.list).toHaveBeenCalledOnce(); native.resolve({ agents: [registered] }); await vi.advanceTimersByTimeAsync(0);
    expect(await first).toBe(failure);
    f.list.mockResolvedValueOnce({ agents: [] });
    expect((await f.session.readNativeState(read)).payload).toEqual({ agents: [] }); expect(f.list).toHaveBeenCalledTimes(2);
  });

  it("propagates a lost native read response without mutation or automatic retry", async () => {
    const f = fixture(vi.fn(async () => { throw new Error("native registry connection lost"); }));
    await expect(f.session.readNativeState(read)).rejects.toThrow("connection lost");
    expect(f.list).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });

  it("rejects a registry snapshot invalidated by a root registration update", async () => {
    const native = deferred<unknown>(); const f = fixture(vi.fn(() => native.promise));
    const pending = f.session.readNativeState(read); const rejection = expect(pending).rejects.toThrow("invalidated");
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce()); f.bridge.nativeEvent(updated());
    await expect(f.session.readNativeState(read)).rejects.toThrow("already in progress");
    native.resolve({ agents: [registered] }); await rejection; expect(f.list).toHaveBeenCalledOnce();
  });

  it("keeps child registration and task/queue revisions independent of the root registry read", async () => {
    const native = deferred<unknown>(); const f = fixture(vi.fn(() => native.promise));
    const pending = f.session.readNativeState(read); await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
    f.bridge.nativeEvent(updated("child-agent"));
    for (const type of ["session.background_tasks_changed", "pending_messages.modified"]) {
      f.bridge.nativeEvent({ ...updated(), type, data: {} } as SessionEvent);
    }
    native.resolve({ agents: [registered] }); expect((await pending).payload).toEqual({ agents: [registered] });
  });

  it("refuses missing native methods and stopped sessions without dispatch", async () => {
    const f = fixture(); f.rpc.agent = undefined;
    await expect(f.session.readNativeState(read)).rejects.toThrow("unavailable");
    await f.session.stop(); await expect(f.session.readNativeState(read)).rejects.toThrow("stopped");
    expect(f.list).not.toHaveBeenCalled();
  });

  it("does not accept a registry reply after the managed session stops", async () => {
    const native = deferred<unknown>(); const f = fixture(vi.fn(() => native.promise));
    const pending = f.session.readNativeState(read); const rejection = expect(pending).rejects.toThrow("stopped");
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce()); await f.session.stop();
    native.resolve({ agents: [registered] }); await rejection; expect(f.list).toHaveBeenCalledOnce();
  });

  it("adds only the strict agents view while retaining all existing Copilot views", () => {
    expect(nativeStateRequestSchema.parse(read)).toEqual(read);
    for (const extra of [{ includePrompt: true }, { includeBuiltInAgents: true }, { id: "other-session" }]) {
      expect(nativeStateRequestSchema.safeParse({ ...read, ...extra }).success).toBe(false);
    }
    expect(nativeStateRequestSchema.safeParse({ harness: "codex", view: "agents" }).success).toBe(false);
    for (const view of ["pendingMessages", "messageDeliveries", "tasks", "currentPromotableTask"]) {
      expect(nativeStateRequestSchema.safeParse({ harness: "copilot", view }).success).toBe(true);
    }
    expect(nativeStateRequestSchema.safeParse({ harness: "copilot", view: "taskProgress", id: "exact" }).success).toBe(true);
  });
});
