import type { SessionEvent } from "@github/copilot-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copilotCommandSchema, nativeStateRequestSchema, NATIVE_PAYLOAD_MAX_BYTES } from "@arduano/agent-multiplex-protocol";
import { AdapterOutcomeUnknownError } from "@arduano/agent-multiplex-runtime-node-core";
import { CopilotAdapterSession, CopilotSessionBridge, type CopilotSessionRpc } from "../src/session.js";

const shell = { type: "shell", id: "native-shell-id", description: "Build", status: "running", startedAt: "2026-09-09T00:00:00Z",
  command: "build", attachmentMode: "attached", executionMode: "sync", canPromoteToBackground: true };
const agent = { type: "agent", id: "native-agent-id", description: "Review", status: "idle", startedAt: shell.startedAt,
  toolCallId: "tool-call-id", agentType: "reviewer", prompt: "Review fixture", model: "requested", resolvedModel: "resolved", executionMode: "background", canPromoteToBackground: false };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(override: Partial<NonNullable<CopilotSessionRpc["tasks"]>> = {}) {
  const tasks = { list: vi.fn(async () => ({ tasks: [shell, agent] })), refresh: vi.fn(async () => ({})),
    getProgress: vi.fn(async () => ({ progress: { type: "shell", recentOutput: "A line" } })),
    getCurrentPromotable: vi.fn(async () => ({ task: shell })), promoteToBackground: vi.fn(async () => ({ promoted: true })),
    cancel: vi.fn(async () => ({ cancelled: true })), ...override };
  const rpc: CopilotSessionRpc = { mode: { set: async () => {} }, tasks };
  const getEvents = vi.fn(async () => []), send = vi.fn(async () => "never"), bridge = new CopilotSessionBridge();
  const session = new CopilotAdapterSession({ adapterScopeId: "tasks-test", cwd: "/disposable", runtimeEpoch: "tasks-epoch",
    native: { sessionId: "tasks-session", rpc, send, abort: async () => {}, setModel: async () => {}, getEvents, disconnect: async () => {} },
    bridge, settings: {}, onStopped: () => {} });
  return { session, tasks, rpc, getEvents, send, bridge };
}
afterEach(() => vi.useRealTimers());

describe("native Copilot task observations", () => {
  it("preserves sync shells, idle agents, model attribution and client tasks without history or agent work", async () => {
    const client = { type: "client", id: "native-client", description: "External task", status: "orphaned", startedAt: shell.startedAt,
      executionMode: "background", clientTaskId: "client-local", canCancel: false, activeTimeMs: 100, sequence: 2, updatedAt: shell.startedAt,
      owner: { participantId: "owner", joinId: "join", kind: "sdk", presence: "disconnected" }, extraNativeField: { useful: true } };
    const value = { tasks: [shell, agent, client] }; const f = fixture({ list: async () => value });
    expect((await f.session.readNativeState({ harness: "copilot", view: "tasks" })).payload).toEqual(value);
    expect(f.tasks.refresh).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled(); expect(f.getEvents).not.toHaveBeenCalled();
    expect(f.session.status()).toBe("idle");
  });
  it("uses the exact ID for progress and preserves native absence", async () => {
    const f = fixture({ getProgress: vi.fn(async () => ({ progress: null })), getCurrentPromotable: async () => ({}) });
    expect((await f.session.readNativeState({ harness: "copilot", view: "taskProgress", id: "specific-task" })).payload).toEqual({ progress: null });
    expect(f.tasks.getProgress).toHaveBeenCalledExactlyOnceWith({ id: "specific-task" });
    expect((await f.session.readNativeState({ harness: "copilot", view: "currentPromotableTask" })).payload).toEqual({});
  });
  it("returns the native promotable task without promoting it", async () => {
    const f = fixture();
    expect((await f.session.readNativeState({ harness: "copilot", view: "currentPromotableTask" })).payload).toEqual({ task: shell });
    expect(f.tasks.promoteToBackground).not.toHaveBeenCalled();
  });
  it.each([
    { tasks: [{ ...shell, id: "" }] }, { tasks: [{ ...shell, canPromoteToBackground: "true" }] }, { tasks: [{ ...shell, type: "unknown" }] },
    { tasks: [{ ...agent, resolvedModel: 42 }] }, { tasks: Array.from({ length: 1_001 }, () => shell) }, { tasks: "missing" },
    { tasks: [{ ...shell, command: "x".repeat(NATIVE_PAYLOAD_MAX_BYTES) }] },
  ])("rejects malformed and oversized lists explicitly", async value => {
    const f = fixture({ list: async () => value });
    await expect(f.session.readNativeState({ harness: "copilot", view: "tasks" })).rejects.toThrow(/Unrecognized|bounded/);
  });
  it("does not continue listing after refresh exhausted the one read budget", async () => {
    vi.useFakeTimers(); const native = deferred<unknown>(); const f = fixture({ refresh: vi.fn(() => native.promise) });
    const first = f.session.readNativeState({ harness: "copilot", view: "tasks" }).catch(error => error);
    await vi.advanceTimersByTimeAsync(15_000); expect(await first).toBeInstanceOf(Error);
    await expect(f.session.readNativeState({ harness: "copilot", view: "tasks" })).rejects.toThrow("remains pending");
    expect(f.tasks.refresh).toHaveBeenCalledOnce(); native.resolve({}); await vi.advanceTimersByTimeAsync(0);
    expect(f.tasks.list).not.toHaveBeenCalled();
  });
  it("keeps one progress lane occupied across a timeout and cannot mix task IDs", async () => {
    vi.useFakeTimers(); const native = deferred<unknown>(); const f = fixture({ getProgress: vi.fn(() => native.promise) });
    const first = f.session.readNativeState({ harness: "copilot", view: "taskProgress", id: "one" }).catch(error => error);
    await vi.advanceTimersByTimeAsync(15_000); await first;
    await expect(f.session.readNativeState({ harness: "copilot", view: "taskProgress", id: "two" })).rejects.toThrow("already in progress");
    expect(f.tasks.getProgress).toHaveBeenCalledOnce(); native.resolve({ progress: null }); await vi.advanceTimersByTimeAsync(0);
  });
  it("forwards task-change notifications without inventing whole-session status", () => {
    const f = fixture(); const seen: unknown[] = []; f.session.subscribe(event => seen.push(event));
    const event = { type: "session.background_tasks_changed", id: "changed", parentId: null, data: {}, timestamp: shell.startedAt } as SessionEvent;
    f.bridge.nativeEvent(event);
    expect(seen).toEqual([{ kind: "native", nativeType: event.type, payload: event, ephemeral: false }]);
    expect(f.session.status()).toBe("idle");
  });
  it("fences stopped and unsupported native sessions without dispatch", async () => {
    const f = fixture(); f.rpc.tasks = undefined;
    await expect(f.session.readNativeState({ harness: "copilot", view: "tasks" })).rejects.toThrow("unavailable");
    await f.session.stop(); await expect(f.session.readNativeState({ harness: "copilot", view: "taskProgress", id: "one" })).rejects.toThrow("stopped");
    expect(f.tasks.list).not.toHaveBeenCalled();
  });
});

describe("durable native Copilot task controls", () => {
  it.each([true, false])("preserves exact native cancel/promote results (%s)", async success => {
    const f = fixture({ cancel: vi.fn(async () => ({ cancelled: success })), promoteToBackground: vi.fn(async () => ({ promoted: success })) });
    expect(await f.session.execute({ harness: "copilot", command: { type: "cancelTask", id: "exact-cancel" } })).toEqual({ cancelled: success });
    expect(await f.session.execute({ harness: "copilot", command: { type: "promoteTaskToBackground", id: "exact-promote" } })).toEqual({ promoted: success });
    expect(f.tasks.cancel).toHaveBeenCalledExactlyOnceWith({ id: "exact-cancel" });
    expect(f.tasks.promoteToBackground).toHaveBeenCalledExactlyOnceWith({ id: "exact-promote" });
    expect(f.tasks.list).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it.each([undefined, {}, { cancelled: "yes" }, { promoted: true }])("makes malformed cancel acknowledgements unknown", async result => {
    const f = fixture({ cancel: vi.fn(async () => result) });
    await expect(f.session.execute({ harness: "copilot", command: { type: "cancelTask", id: "exact" } })).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect(f.tasks.cancel).toHaveBeenCalledOnce();
  });
  it("never retries a lost promotion acknowledgement", async () => {
    const f = fixture({ promoteToBackground: vi.fn(async () => { throw new Error("connection lost"); }) });
    await expect(f.session.execute({ harness: "copilot", command: { type: "promoteTaskToBackground", id: "exact" } })).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect(f.tasks.promoteToBackground).toHaveBeenCalledOnce(); expect(f.tasks.cancel).not.toHaveBeenCalled();
  });
  it("requires bounded exact native IDs and rejects extra control parameters", async () => {
    for (const id of ["", "x".repeat(4_097)]) {
      expect(copilotCommandSchema.safeParse({ type: "cancelTask", id }).success).toBe(false);
      expect(nativeStateRequestSchema.safeParse({ harness: "copilot", view: "taskProgress", id }).success).toBe(false);
      const f = fixture(); await expect(f.session.execute({ harness: "copilot", command: { type: "cancelTask", id } })).rejects.toThrow();
      expect(f.tasks.cancel).not.toHaveBeenCalled();
    }
    expect(copilotCommandSchema.safeParse({ type: "promoteTaskToBackground", id: "exact", pid: 123 }).success).toBe(false);
    expect(nativeStateRequestSchema.safeParse({ harness: "copilot", view: "tasks", limit: 100 }).success).toBe(false);
  });
});
