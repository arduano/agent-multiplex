import type { SessionEvent } from "@github/copilot-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newCommandId, newLaunchId, newRuntimeEpoch, newRuntimeNodeBootId,
  newRuntimeNodeId, newSessionId, type JsonValue,
} from "@arduano/agent-multiplex-protocol";
import {
  RuntimeNodeService, RuntimeNodeStore, type AgentAdapter, type CopilotIncidentTraceRecord,
} from "@arduano/agent-multiplex-runtime-node-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopilotAdapterSession, CopilotSessionBridge, type CopilotSessionRpc } from "../src/session.js";

const timestamp = "2026-10-05T00:00:00.000Z";
function taskSnapshot(status: "running" | "completed") {
  return { tasks: ["alpha", "beta"].map(name => ({
    type: "agent", id: `task-${name}`, description: `Fixture ${name}`, status, startedAt: timestamp,
    toolCallId: `tool-${name}`, agentType: "fixture", prompt: "Synthetic task fixture", model: null,
    resolvedModel: "gpt-6-luna", executionMode: "background", canPromoteToBackground: false,
    ...(status === "completed" ? { completedAt: timestamp } : {}), nativeMetadata: { fixture: name },
  })) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function nativeFixture(cwd: string, resumed = false) {
  let snapshot = taskSnapshot("running"), ordinal = 0;
  const bridge = new CopilotSessionBridge();
  const tasks = {
    list: vi.fn(async (): Promise<unknown> => snapshot), refresh: vi.fn(async () => ({})),
    getProgress: vi.fn(async () => ({ progress: null })), getCurrentPromotable: vi.fn(async () => ({})),
    promoteToBackground: vi.fn(async () => ({ promoted: false })), cancel: vi.fn(async () => ({ cancelled: false })),
  };
  const queue = { pendingItems: vi.fn(async () => ({ items: [], steeringMessages: [], inFlightSteeringCount: 0 })),
    sendNow: vi.fn(async () => ({ success: false })) };
  const rpc: CopilotSessionRpc = { mode: { set: vi.fn(async () => {}) }, tasks, queue };
  const send = vi.fn(async () => "fixture-message"), abort = vi.fn(async () => {});
  const getEvents = vi.fn(async () => []), disconnect = vi.fn(async () => {});
  const session = new CopilotAdapterSession({ adapterScopeId: "null-model-lifecycle-test", cwd,
    runtimeEpoch: newRuntimeEpoch(), bridge, settings: {}, onStopped: () => {},
    native: { sessionId: "native-null-model-fixture", rpc, send, abort,
      setModel: vi.fn(async () => {}), getEvents, disconnect },
  });
  const emit = (type: string, data: object = {}) => {
    const id = `native-${resumed ? "resumed" : "initial"}-${++ordinal}`;
    bridge.nativeEvent({ type, id, data, parentId: null, timestamp } as SessionEvent);
    return id;
  };
  bridge.interactionHydration(!resumed);
  if (resumed) emit("session.resume", { continuePendingWork: false, sessionWasActive: false });
  return { session, bridge, emit, tasks, queue, rpc, send, abort, getEvents, disconnect,
    snapshot: () => snapshot, setStatus: (status: "running" | "completed") => { snapshot = taskSnapshot(status); } };
}

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(timestamp); });
afterEach(async () => {
  try { for (const close of cleanup.splice(0)) await close(); }
  finally { vi.useRealTimers(); }
});

async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "multiplex-null-model-lifecycle-"));
  const store = new RuntimeNodeStore(":memory:"), runtimeNodeId = newRuntimeNodeId();
  const native = nativeFixture(cwd);
  let replacement: ReturnType<typeof nativeFixture> | undefined;
  const adapter: AgentAdapter = {
    harness: "copilot", adapterScopeId: native.session.adapterScopeId,
    describe: async () => ({ harness: "copilot", adapterScopeId: native.session.adapterScopeId, available: true, capabilities: [] }),
    listModels: async () => [], listSessions: async () => [], spawn: vi.fn(async () => native.session),
    resume: vi.fn(async () => {
      if (!replacement) throw new Error("No synthetic replacement installed");
      return replacement.session;
    }), close: vi.fn(async () => {}),
  };
  const recovery = vi.fn(), traces: CopilotIncidentTraceRecord[] = [];
  const service = new RuntimeNodeService({ store, runtimeNodeId, runtimeNodeBootId: newRuntimeNodeBootId(),
    name: "null model lifecycle fixture", allowedRoots: [cwd], adapters: [adapter],
    onCopilotObservationRecoveryRequired: recovery, onCopilotIncidentTrace: trace => { traces.push(trace); } });
  cleanup.push(async () => {
    await service.close(); store.close(); rmSync(cwd, { recursive: true, force: true });
  });
  const profile = service.launchProfiles()[0]!, launchId = newLaunchId(), sessionId = newSessionId();
  service.createLaunch({ launchId, sessionId, runtimeNodeId, payloadHash: "null-model-lifecycle-launch",
    profile: { providerId: profile.providerId, profileId: profile.profileId,
      contractVersion: profile.contractVersion, requestSchemaHash: profile.requestSchemaHash },
    harness: "copilot", input: { cwd } });
  await vi.waitFor(() => expect(service.getLaunch(launchId)?.state).toBe("succeeded"));
  const lifecycle = () => service.readLifecycle(sessionId);
  const state = async () => { await lifecycle(); return store.getLifecycle(sessionId)!; };
  const observed = async () => vi.waitFor(async () => {
    const current = await state();
    expect(current.tasks.observation.state).toBe("observed");
    expect(current.queue.observation.state).toBe("observed");
  });
  const assertNoNativeMutations = () => {
    expect(recovery).not.toHaveBeenCalled(); expect(adapter.resume).not.toHaveBeenCalled();
    expect(adapter.close).not.toHaveBeenCalled(); expect(native.disconnect).not.toHaveBeenCalled();
    expect(native.tasks.cancel).not.toHaveBeenCalled(); expect(native.tasks.promoteToBackground).not.toHaveBeenCalled();
    expect(native.abort).not.toHaveBeenCalled(); expect(native.send).not.toHaveBeenCalled();
    expect(native.getEvents).not.toHaveBeenCalled();
  };
  return { native, store, adapter, service, runtimeNodeId, sessionId, traces, recovery, lifecycle, state,
    observed, assertNoNativeMutations, replacement: () => (replacement = nativeFixture(cwd, true)) };
}

function startBackground(native: ReturnType<typeof nativeFixture>) {
  const cycle = native.emit("assistant.turn_start", { turnId: "0" });
  for (const name of ["alpha", "beta"]) native.emit("subagent.started", { toolCallId: `tool-${name}` });
  native.emit("assistant.idle");
  return cycle;
}
function completeBackground(native: ReturnType<typeof nativeFixture>) {
  for (const name of ["alpha", "beta"]) native.emit("subagent.completed", { toolCallId: `tool-${name}` });
  native.setStatus("completed");
  native.emit("session.background_tasks_changed");
}

describe("null-model native tasks through adapter and Runtime lifecycle", () => {
  it("observes two running null-model tasks, then publishes healthy Finished and Send after exact completion and root idle", async () => {
    const f = await fixture();
    const cycle = startBackground(f.native);
    await f.observed();
    expect(await f.state()).toMatchObject({ root: { phase: "paused", cycle, outcome: "none" },
      tasks: { revision: 0, observation: { state: "observed", failures: 0 }, items: [
        { id: "task-alpha", kind: "agent", status: "running" }, { id: "task-beta", kind: "agent", status: "running" },
      ] }, children: { items: [{ id: "tool:tool-alpha", state: "running" }, { id: "tool:tool-beta", state: "running" }] } });
    expect((await f.lifecycle()).view).toMatchObject({ status: "waitingForBackground", health: { state: "healthy", issues: [] } });
    expect((await f.service.readNativeState(f.sessionId, { harness: "copilot", view: "tasks" })).payload.json)
      .toEqual(f.native.snapshot());
    // The repair interval must not turn valid null metadata into stalled admission.
    await vi.advanceTimersByTimeAsync(60_000);
    await f.observed();
    expect((await f.lifecycle()).view.health).toEqual({ state: "healthy", issues: [] });

    completeBackground(f.native);
    await vi.waitFor(async () => expect((await f.state()).tasks).toMatchObject({ revision: 1,
      observation: { state: "observed" }, items: [{ status: "completed" }, { status: "completed" }] }));
    expect((await f.lifecycle()).view.status).toBe("unknown"); // Completion cannot invent a root idle boundary.
    f.native.emit("session.idle", { aborted: false });
    expect((await f.lifecycle()).view).toMatchObject({ status: "finished", health: { state: "healthy", issues: [] },
      actions: { send: { available: true, reason: "available" } } });
    expect((await f.service.readNativeState(f.sessionId, { harness: "copilot", view: "tasks" })).payload.json)
      .toEqual(f.native.snapshot());
    expect((await f.state()).children.items).toEqual([
      { id: "tool:tool-alpha", state: "completed" }, { id: "tool:tool-beta", state: "completed" },
    ]);
    expect(f.traces.some(trace => trace.kind === "observation" && trace.view === "tasks" && trace.outcome === "failed")).toBe(false);
    f.assertNoNativeMutations();
  });

  it("keeps a genuine pending callback blocking Send after null-model task completion and root idle", async () => {
    const f = await fixture();
    startBackground(f.native);
    await f.observed();
    const response = f.native.bridge.interaction("userInput", { question: "Synthetic pending question" },
      { ephemeral: true, cancelValue: { answer: "cancelled" }, parseResponse: value => value });
    completeBackground(f.native);
    f.native.emit("session.idle");
    await f.observed();
    expect((await f.lifecycle()).view).toMatchObject({ status: "waitingForInput", health: { state: "healthy", issues: [] },
      actions: { send: { available: false, reason: "waitingForInput" }, resolveInteraction: { available: true } } });
    const pending = f.service.listInteractions(f.sessionId).find(item => item.state === "pending")!;
    expect((await f.state()).interactions.items).toEqual([{ id: pending.interactionId, owner: "root", kind: "userInput" }]);
    const receipt = await f.service.execute({ commandId: newCommandId(), payloadHash: "pending-null-model-send",
      sessionId: f.sessionId, runtimeNodeId: f.runtimeNodeId, bindingRevision: 1,
      request: { harness: "copilot", command: { type: "send", prompt: "Synthetic blocked send", mode: "enqueue" } } });
    expect(receipt).toMatchObject({ state: "failed", error: { code: "UNAVAILABLE", certainty: "definiteFailure" } });
    f.assertNoNativeMutations();
    const answer: JsonValue = { answer: "Fixture resolved" };
    await f.service.resolveInteraction({ interactionId: pending.interactionId, sessionId: f.sessionId,
      harness: "copilot", response: answer });
    await expect(response).resolves.toEqual(answer);
    expect((await f.lifecycle()).view).toMatchObject({ status: "finished", health: { state: "healthy", issues: [] },
      actions: { send: { available: true } } });
  });

  it("rejects a delayed completed null-model snapshot after newer task invalidation and waits for fresh running tasks", async () => {
    const f = await fixture();
    startBackground(f.native);
    await f.observed();
    // Whole-session idle still cannot erase independently observed running tasks.
    f.native.emit("session.idle");
    expect((await f.lifecycle()).view.status).toBe("waitingForBackground");
    const oldReply = deferred<unknown>(), freshReply = deferred<unknown>();
    f.native.tasks.list.mockImplementationOnce(() => oldReply.promise).mockImplementationOnce(() => freshReply.promise);
    const reads = f.native.tasks.list.mock.calls.length;
    f.native.emit("session.background_tasks_changed");
    await vi.waitFor(() => expect(f.native.tasks.list).toHaveBeenCalledTimes(reads + 1));
    f.native.emit("session.background_tasks_changed");
    await f.lifecycle();
    oldReply.resolve(taskSnapshot("completed"));
    await vi.waitFor(() => expect(f.native.tasks.list).toHaveBeenCalledTimes(reads + 2));
    expect((await f.state()).tasks).toMatchObject({ revision: 2, observation: { state: "pending" },
      items: [{ status: "running" }, { status: "running" }] });
    expect((await f.lifecycle()).view).toMatchObject({ status: "unknown", health: { state: "recovering" } });
    freshReply.resolve(taskSnapshot("running"));
    await f.observed();
    expect((await f.lifecycle()).view).toMatchObject({ status: "waitingForBackground", health: { state: "healthy", issues: [] } });
    expect(f.traces).toContainEqual(expect.objectContaining({ kind: "observation", view: "tasks",
      outcome: "staleRevision", revision: 1, currentRevision: 2 }));
    f.assertNoNativeMutations();
  });

  it("fences a late completed null-model observation across explicit synthetic Stop and Resume", async () => {
    const f = await fixture();
    startBackground(f.native);
    await f.observed();
    const oldFence = (await f.lifecycle()).fence, lateReply = deferred<unknown>();
    f.native.tasks.list.mockImplementationOnce(() => lateReply.promise);
    const reads = f.native.tasks.list.mock.calls.length;
    f.native.emit("session.background_tasks_changed");
    await vi.waitFor(() => expect(f.native.tasks.list).toHaveBeenCalledTimes(reads + 1));
    await expect(f.service.stop({ operation: "stop", commandId: newCommandId(), payloadHash: "null-model-fixture-stop",
      sessionId: f.sessionId, runtimeNodeId: f.runtimeNodeId, bindingRevision: 1 })).resolves.toMatchObject({ state: "succeeded" });
    const replacement = f.replacement();
    await expect(f.service.resume({ operation: "resume", commandId: newCommandId(), payloadHash: "null-model-fixture-resume",
      sessionId: f.sessionId, runtimeNodeId: f.runtimeNodeId, bindingRevision: 1 })).resolves.toMatchObject({ state: "succeeded" });
    const cycle = startBackground(replacement);
    await f.observed();
    const before = await f.lifecycle();
    expect(before.fence.runtimeEpoch).not.toBe(oldFence.runtimeEpoch);
    expect(before.view).toMatchObject({ status: "waitingForBackground", health: { state: "healthy", issues: [] } });
    lateReply.resolve(taskSnapshot("completed"));
    await vi.waitFor(() => expect(f.traces).toContainEqual(expect.objectContaining({ kind: "observation", view: "tasks", outcome: "retiredBinding" })));
    expect(await f.lifecycle()).toEqual(before);
    expect(await f.state()).toMatchObject({ root: { cycle }, tasks: { revision: 0,
      observation: { state: "observed" }, items: [{ status: "running" }, { status: "running" }] } });
    expect(f.recovery).not.toHaveBeenCalled(); expect(f.native.disconnect).toHaveBeenCalledOnce();
    expect(f.adapter.resume).toHaveBeenCalledOnce(); expect(f.adapter.close).not.toHaveBeenCalled();
    for (const native of [f.native, replacement]) {
      expect(native.tasks.cancel).not.toHaveBeenCalled(); expect(native.abort).not.toHaveBeenCalled();
      expect(native.send).not.toHaveBeenCalled(); expect(native.getEvents).not.toHaveBeenCalled();
    }
    expect(replacement.disconnect).not.toHaveBeenCalled();
  });
});
