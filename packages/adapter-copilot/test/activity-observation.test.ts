import type { SessionEvent } from "@github/copilot-sdk";
import type { AdapterEvent } from "@arduano/agent-multiplex-runtime-node-core";
import {
  initialLifecycle, lifecycleProjection, LIFECYCLE_VERSION,
  newRuntimeEpoch, newRuntimeNodeBootId, newRuntimeNodeId, newSessionId, reduceLifecycle,
  sessionLifecycleViewSchema, type LifecycleFact,
} from "@arduano/agent-multiplex-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopilotAdapterSession, CopilotSessionBridge } from "../src/session.js";

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture(activity: () => Promise<unknown>) {
  const bridge = new CopilotSessionBridge();
  let state = initialLifecycle({ sessionId: newSessionId(), runtimeNodeId: newRuntimeNodeId(),
    runtimeNodeBootId: newRuntimeNodeBootId(), runtimeEpoch: newRuntimeEpoch(), bindingRevision: 1 });
  const events: AdapterEvent[] = [];
  const apply = (fact: LifecycleFact) => {
    state = reduceLifecycle(state, { version: LIFECYCLE_VERSION, fence: state.fence, sequence: state.nextSequence, fact });
  };
  bridge.subscribe(event => {
    events.push(event);
    if (event.kind === "lifecycle") apply(event.fact);
    if (event.kind === "interaction") apply({ type: "interactionOpened",
      interaction: { id: "pending-root-input", owner: "root", kind: "userInput" } });
  });
  bridge.interactionHydration(true);
  const rpc = { mode: { set: async () => {} }, metadata: { activity } };
  const session = new CopilotAdapterSession({ adapterScopeId: "activity-fixture", cwd: "/disposable",
    runtimeEpoch: state.fence.runtimeEpoch, bridge, settings: {}, onStopped: () => {},
    native: { sessionId: "activity-fixture", rpc, send: async () => "message-id", abort: async () => {},
      setModel: async () => {}, getEvents: async () => [], disconnect: async () => {} },
  });
  let ordinal = 0;
  const emit = (type: string, data: object = {}) => bridge.nativeEvent({ id: `native-${++ordinal}`, type, data,
    timestamp: "2026-10-04T00:00:00.000Z", parentId: null } as SessionEvent);
  emit("session.idle");
  apply({ type: "tasksObserved", revision: 0, items: [] });
  apply({ type: "queueObserved", revision: 0, items: [], unidentifiedSteering: 0, inFlightSteering: 0 });
  emit("assistant.turn_start", { turnId: "0" });
  return { bridge, session, rpc, events, apply, emit, state: () => state,
    view: () => lifecycleProjection(state).view };
}

describe("Copilot fenced activity observation", () => {
  it.each(["rejection", "malformed", "timeout"])("does not retain healthy Working after current activity %s", async failure => {
    vi.useFakeTimers();
    const pending = deferred<unknown>();
    const f = fixture(async () => {
      if (failure === "timeout") return pending.promise;
      if (failure === "malformed") return { processing: false };
      throw new Error("native activity unavailable");
    });
    expect(f.view()).toMatchObject({ status: "working", health: { state: "healthy" } });
    const cycle = f.state().root.cycle;
    const read = f.session.readActivity();
    if (failure === "timeout") await vi.advanceTimersByTimeAsync(15_000);
    await read;
    expect(f.state()).toMatchObject({ continuity: "continuous", aggregateActivity: "unknown",
      nativeAdmission: { state: "open" }, root: { phase: "unknown", cycle, outcome: "none" } });
    expect(f.view()).toMatchObject({ status: "unknown", health: { state: "recovering",
      issues: [{ scope: "lifecycle", code: "observationPending" }] },
      actions: { send: { available: true }, stop: { available: true } } });
    // Existing .27 public field names/codes and the strict schema are retained.
    expect(sessionLifecycleViewSchema.safeParse(f.view()).success).toBe(true);
    f.emit("assistant.message", { content: "final text" });
    f.emit("assistant.turn_end");
    expect(f.view().status).toBe("unknown");
    f.emit("session.idle");
    expect(f.view()).toMatchObject({ status: "finished", health: { state: "healthy" } });
    pending.resolve({ hasActiveWork: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.view().status).toBe("finished");
    f.bridge.close();
  });

  it("keeps root completion unknown after only an inactive snapshot, then heals on exact native idle", async () => {
    const f = fixture(async () => { throw new Error("activity unavailable"); });
    await f.session.readActivity();
    f.rpc.metadata.activity = async () => ({ hasActiveWork: false });
    await f.session.readActivity();
    expect(f.state().root).toMatchObject({ phase: "unknown", outcome: "none" });
    expect(f.view().status).toBe("unknown");
    expect(f.view().actions.send.available).toBe(true);
    f.emit("session.idle");
    expect(f.view().status).toBe("finished");
    f.bridge.close();
  });

  it("does not repair genuine continuity or interaction uncertainty when an activity read fails", async () => {
    const f = fixture(async () => { throw new Error("activity unavailable"); });
    f.apply({ type: "gap" });
    const before = f.state();
    await f.session.readActivity();
    expect(f.state().continuity).toBe("gap");
    expect(f.state().interactions).toEqual(before.interactions);
    expect(f.state().children).toEqual(before.children);
    expect(f.view()).toMatchObject({ status: "unknown", health: { state: "recovering" },
      actions: { send: { available: false, reason: "interactionStateUnknown" } } });
    expect(f.view().health.issues.some(issue => issue.code === "continuityGap")).toBe(true);
    f.bridge.close();
  });

  it.each(["child", "task", "queue", "interaction"])("preserves independent %s evidence when activity becomes unavailable", async kind => {
    const f = fixture(async () => { throw new Error("activity unavailable"); });
    let input: Promise<unknown> | undefined;
    if (kind === "child") f.emit("subagent.started", { toolCallId: "live-child" });
    if (kind === "task") f.apply({ type: "tasksObserved", revision: 0,
      items: [{ id: "live-task", kind: "shell", status: "running" }] });
    if (kind === "queue") f.apply({ type: "queueObserved", revision: 0,
      items: [{ id: "pending-item", messageId: "pending-message", kind: "queued" }], unidentifiedSteering: 0, inFlightSteering: 0 });
    if (kind === "interaction") input = f.bridge.interaction("userInput", { question: "still pending" },
      { ephemeral: true, cancelValue: { answer: "cancelled" }, parseResponse: value => value });
    const before = f.state();
    await f.session.readActivity();
    expect(f.state().children).toEqual(before.children);
    expect(f.state().tasks).toEqual(before.tasks);
    expect(f.state().queue).toEqual(before.queue);
    expect(f.state().interactions).toEqual(before.interactions);
    expect(f.state().continuity).toBe("continuous");
    expect(f.view()).toMatchObject({ status: kind === "interaction" ? "waitingForInput"
      : kind === "queue" ? "working" : "waitingForBackground", health: { state: "recovering" } });
    if (kind === "interaction") {
      expect(f.session.status()).toBe("waitingForInput");
      expect(f.view().actions.resolveInteraction.available).toBe(true);
    }
    f.bridge.close();
    if (input) await expect(input).resolves.toEqual({ answer: "cancelled" });
  });

  it.each(["assistant.turn_start", "session.idle"])("fences an older failed observation behind newer %s", async nativeType => {
    const pending = deferred<unknown>();
    const f = fixture(() => pending.promise);
    const read = f.session.readActivity();
    f.emit(nativeType, { turnId: "new-turn" });
    pending.resolve({ malformed: true });
    await read;
    expect(f.events.some(event => event.kind === "lifecycle" && event.fact.type === "sessionActivityUnavailable")).toBe(false);
    expect(f.view()).toMatchObject({ status: nativeType === "session.idle" ? "finished" : "working",
      health: { state: "healthy" } });
    f.bridge.close();
  });

  it("bounds a busy activity lane without applying stale replies or making another native request", async () => {
    vi.useFakeTimers();
    const pending = deferred<unknown>();
    const activity = vi.fn(() => pending.promise);
    const f = fixture(activity);
    const oldRead = f.session.readActivity();
    await vi.advanceTimersByTimeAsync(0);
    f.emit("assistant.turn_start", { turnId: "new-turn" });
    await f.session.readActivity();
    expect(f.view()).toMatchObject({ status: "working", health: { state: "healthy" } });
    await vi.advanceTimersByTimeAsync(15_000);
    await oldRead;
    expect(f.view().status).toBe("working"); // The old revision cannot regress the new one.
    await f.session.readActivity();
    expect(f.view()).toMatchObject({ status: "unknown", health: { state: "recovering" } });
    expect(activity).toHaveBeenCalledOnce();
    pending.resolve({ hasActiveWork: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.view().status).toBe("unknown");
    f.rpc.metadata.activity = async () => ({ hasActiveWork: false });
    await f.session.readActivity();
    expect(f.state().aggregateActivity).toBe("inactive");
    expect(f.view().status).toBe("unknown"); // A read cannot fabricate session.idle.
    f.emit("assistant.turn_start", { turnId: "next-turn" });
    expect(f.view()).toMatchObject({ status: "working", health: { state: "healthy" } });
    f.bridge.close();
  });
});
