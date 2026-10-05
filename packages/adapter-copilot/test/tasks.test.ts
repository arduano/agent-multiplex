import type { SessionEvent } from "@github/copilot-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copilotCommandSchema, nativeStateRequestSchema, NATIVE_PAYLOAD_MAX_BYTES,
  newLaunchId, newRuntimeNodeId, newRuntimeNodeBootId, newRuntimeEpoch, newSessionId } from "@arduano/agent-multiplex-protocol";
import { AdapterOutcomeUnknownError, AdapterNativeStateReadError, AdapterNativeStateValidationError, RuntimeNodeService, RuntimeNodeStore,
  type AgentAdapter, type CopilotIncidentTraceRecord } from "@arduano/agent-multiplex-runtime-node-core";
import { CopilotAdapterSession, CopilotSessionBridge, type CopilotSessionRpc } from "../src/session.js";
import { taskSnapshot } from "../src/tasks.js";

const shell = { type: "shell", id: "native-shell-id", description: "Build", status: "running", startedAt: "2026-09-09T00:00:00Z",
  command: "build", attachmentMode: "attached", executionMode: "sync", canPromoteToBackground: true };
const agent = { type: "agent", id: "native-agent-id", description: "Review", status: "idle", startedAt: shell.startedAt,
  toolCallId: "tool-call-id", agentType: "reviewer", prompt: "Review fixture", model: "requested", resolvedModel: "resolved", executionMode: "background", canPromoteToBackground: false };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(override: Partial<NonNullable<CopilotSessionRpc["tasks"]>> = {}, cwd = "/disposable") {
  const tasks = { list: vi.fn(async () => ({ tasks: [shell, agent] })), refresh: vi.fn(async () => ({})),
    getProgress: vi.fn(async () => ({ progress: { type: "shell", recentOutput: "A line" } })),
    getCurrentPromotable: vi.fn(async () => ({ task: shell })), promoteToBackground: vi.fn(async () => ({ promoted: true })),
    cancel: vi.fn(async () => ({ cancelled: true })), ...override };
  const rpc: CopilotSessionRpc = { mode: { set: async () => {} }, tasks };
  const getEvents = vi.fn(async () => []), send = vi.fn(async () => "never"), bridge = new CopilotSessionBridge();
  const session = new CopilotAdapterSession({ adapterScopeId: "tasks-test", cwd, runtimeEpoch: newRuntimeEpoch(),
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
    await vi.advanceTimersByTimeAsync(15_000); expect(await first).toBeInstanceOf(AdapterNativeStateReadError);
    expect(await first).toMatchObject({ reason: "nativeReadTimedOut" });
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
    expect(seen).toEqual([{ kind: "native", nativeType: event.type, payload: event, ephemeral: false },
      { kind: "lifecycle", fact: { type: "tasksInvalidated" } }]);
    expect(f.session.status()).toBe("idle");
  });
  it("rejects a delayed empty task snapshot invalidated by newer native work", async () => {
    const response = deferred<unknown>();
    const f = fixture({ list: vi.fn(() => response.promise) });
    const read = f.session.readNativeState({ harness: "copilot", view: "tasks" });
    const result = expect(read).rejects.toMatchObject({ reason: "snapshotInvalidated" });
    await vi.waitFor(() => expect(f.tasks.list).toHaveBeenCalledOnce());
    f.bridge.nativeEvent({ type: "session.background_tasks_changed", id: "new-work", parentId: null,
      data: {}, timestamp: shell.startedAt } as SessionEvent);
    // A read in the new generation must not join the older snapshot.
    await expect(f.session.readNativeState({ harness: "copilot", view: "tasks" })).rejects.toThrow("already in progress");
    response.resolve({ tasks: [] });
    await result;
    expect(f.tasks.list).toHaveBeenCalledOnce();
    expect(f.session.status()).toBe("idle");
  });
  it("accepts refresh-triggered invalidation before listing, then coalesces identical observations", async () => {
    const response = deferred<unknown>();
    const f = fixture({ list: vi.fn(() => response.promise) });
    f.tasks.refresh.mockImplementationOnce(async () => {
      f.bridge.nativeEvent({ type: "session.background_tasks_changed", id: "refresh", parentId: null,
        data: {}, timestamp: shell.startedAt } as SessionEvent);
      return {};
    });
    const first = f.session.readNativeState({ harness: "copilot", view: "tasks" });
    const second = f.session.readNativeState({ harness: "copilot", view: "tasks" });
    await vi.waitFor(() => expect(f.tasks.list).toHaveBeenCalledOnce());
    response.resolve({ tasks: [shell] });
    expect((await first).payload).toEqual({ tasks: [shell] });
    expect((await second).payload).toEqual({ tasks: [shell] });
  });
  it("fences stopped and unsupported native sessions without dispatch", async () => {
    const f = fixture(); f.rpc.tasks = undefined;
    await expect(f.session.readNativeState({ harness: "copilot", view: "tasks" })).rejects.toMatchObject({ reason: "nativeReadUnavailable" });
    await f.session.stop(); await expect(f.session.readNativeState({ harness: "copilot", view: "taskProgress", id: "one" })).rejects.toThrow("stopped");
    expect(f.tasks.list).not.toHaveBeenCalled();
  });
});

describe("bounded task validation diagnostics", () => {
  it.each([
    { field: "resolvedModel", value: null, valueType: "null", reason: "snapshotMalformed" },
    { field: "resolvedModel", value: [], valueType: "array", reason: "snapshotMalformed" },
    { field: "resolvedModel", value: {}, valueType: "object", reason: "snapshotMalformed" },
    { field: "resolvedModel", value: 42, valueType: "number", reason: "snapshotMalformed" },
    { field: "resolvedModel", value: true, valueType: "boolean", reason: "snapshotMalformed" },
    { field: "startedAt", value: new Date("2026-10-04T00:00:00Z"), valueType: "date", reason: "snapshotWireInvalid" },
  ])("retains only the path and type of rejected $field/$valueType", ({ field, value, valueType, reason }) => {
    let error: unknown;
    try { taskSnapshot("tasks", { tasks: [{ ...agent, [field]: value }] }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AdapterNativeStateValidationError);
    expect(error).toMatchObject({ reason, issues: [{ path: ["tasks", 0, field], code: "invalid_type", valueType }] });
  });

  it("describes missing required fields and invalid enums without copying their contents", () => {
    const { agentType: _missing, ...incomplete } = agent;
    let error: unknown;
    try { taskSnapshot("tasks", { tasks: [{ ...incomplete, status: "private-status-sentinel", prompt: "private-prompt-sentinel",
      privatePropertySentinel: { message: "private-error-sentinel" } }] }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ reason: "snapshotMalformed", issues: expect.arrayContaining([
      { path: ["tasks", 0, "agentType"], code: "invalid_type", valueType: "undefined" },
      { path: ["tasks", 0, "status"], code: "invalid_value", valueType: "string" },
    ]) });
    const serialized = JSON.stringify(error);
    for (const sentinel of ["private-status-sentinel", "private-prompt-sentinel", "privatePropertySentinel", "private-error-sentinel", agent.id]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("caps diagnostic issue count and separates wire size from schema rejection", () => {
    let malformed: unknown;
    try { taskSnapshot("tasks", { tasks: Array.from({ length: 12 }, () => ({ ...agent, resolvedModel: null })) }); }
    catch (caught) { malformed = caught; }
    expect(malformed).toMatchObject({ reason: "snapshotMalformed" });
    expect((malformed as AdapterNativeStateValidationError).issues).toHaveLength(8);
    expect(() => taskSnapshot("tasks", { tasks: [{ ...agent, prompt: "x".repeat(NATIVE_PAYLOAD_MAX_BYTES) }] }))
      .toThrow(expect.objectContaining({ reason: "snapshotTooLarge", issues: [] }));
  });

  it("bounds and allowlists metadata at the shared error boundary", () => {
    const error = new AdapterNativeStateValidationError("private-reason-sentinel" as never, [{
      path: ["tasks", 1_001, "privatePropertySentinel", "owner", "participantId", "joinId", "kind", "presence", "private-tail-sentinel"],
      code: "private-code-sentinel", valueType: "private-type-sentinel", message: "private-error-sentinel", input: "private-prompt-sentinel",
    } as never]);
    expect(error.issues).toEqual([{ path: ["tasks", 1_000, "unknownField", "owner", "participantId", "joinId", "kind", "presence"],
      code: "unknownIssue", valueType: "other" }]);
    expect(error.reason).toBe("snapshotMalformed");
    expect(JSON.stringify(error)).not.toContain("private");
  });

  it("carries an actual adapter rejection into the failed observation trace while preserving uncertainty", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "copilot-task-diagnostic-"));
    const { agentType: _missing, ...incomplete } = agent;
    const native = fixture({ list: async () => ({ tasks: [{ ...incomplete, resolvedModel: null,
      prompt: "private-prompt-sentinel", privatePropertySentinel: "private-error-sentinel" }] }) }, cwd);
    native.rpc.queue = { pendingItems: async () => ({ items: [], steeringMessages: [], inFlightSteeringCount: 0 }) };
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId(), traces: CopilotIncidentTraceRecord[] = [];
    const adapter: AgentAdapter = {
      harness: "copilot", adapterScopeId: native.session.adapterScopeId,
      describe: async () => ({ harness: "copilot", adapterScopeId: native.session.adapterScopeId, available: true, capabilities: [] }),
      listModels: async () => [], listSessions: async () => [], spawn: async () => native.session,
      resume: async () => { throw new Error("diagnostic fixture must not resume"); }, close: async () => {},
    };
    const service = new RuntimeNodeService({ store, runtimeNodeId, runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "task diagnostic test", allowedRoots: [cwd], adapters: [adapter], onCopilotIncidentTrace: trace => { traces.push(trace); } });
    try {
      const profile = service.launchProfiles()[0]!, launchId = newLaunchId(), sessionId = newSessionId();
      service.createLaunch({ launchId, sessionId, runtimeNodeId, payloadHash: "task-diagnostic-launch",
        profile: { providerId: profile.providerId, profileId: profile.profileId, contractVersion: profile.contractVersion, requestSchemaHash: profile.requestSchemaHash },
        harness: "copilot", input: { cwd } });
      await vi.waitFor(() => expect(service.getLaunch(launchId)?.state).toBe("succeeded"));
      native.bridge.interactionHydration(true);
      for (const [type, id] of [["assistant.turn_start", "diagnostic-root-start"], ["session.idle", "diagnostic-root-idle"]]) {
        native.bridge.nativeEvent({ type, id, parentId: null, data: {}, timestamp: shell.startedAt } as SessionEvent);
      }
      await vi.waitFor(() => expect(traces).toContainEqual(expect.objectContaining({ kind: "observation", view: "tasks", outcome: "failed",
        revision: 0, currentRevision: 0, failureReason: "snapshotMalformed", validationIssues: [
          { path: ["tasks", 0, "agentType"], code: "invalid_type", valueType: "undefined" },
          { path: ["tasks", 0, "resolvedModel"], code: "invalid_type", valueType: "null" },
        ] })));
      await vi.waitFor(async () => {
        const lifecycle = await service.readLifecycle(sessionId);
        expect(lifecycle.view).toMatchObject({ status: "unknown", health: { state: "recovering",
          issues: [{ scope: "tasks", code: "observationRetrying", diagnosticId: expect.any(String) }] } });
      });
      for (const sentinel of ["private-prompt-sentinel", "privatePropertySentinel", "private-error-sentinel", agent.id]) {
        expect(JSON.stringify(traces)).not.toContain(sentinel);
      }
      expect(native.send).not.toHaveBeenCalled(); expect(native.getEvents).not.toHaveBeenCalled();
    } finally {
      await service.close(); store.close(); rmSync(cwd, { recursive: true, force: true });
    }
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
