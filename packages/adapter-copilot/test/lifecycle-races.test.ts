import type { SessionEvent } from "@github/copilot-sdk";
import { AdapterOutcomeUnknownError, type AdapterEvent } from "@arduano/agent-multiplex-runtime-node-core";
import {
  initialLifecycle, lifecycleProjection, LIFECYCLE_VERSION,
  newRuntimeEpoch, newRuntimeNodeBootId, newRuntimeNodeId, newSessionId, reduceLifecycle,
  type LifecycleFact,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it, vi } from "vitest";
import { CopilotAdapterSession, CopilotSessionBridge } from "../src/session.js";

function fixture() {
  let reject!: (error: Error) => void;
  const reply = new Promise<string>((_, no) => { reject = no; });
  const send = vi.fn(() => reply);
  const bridge = new CopilotSessionBridge();
  const session = new CopilotAdapterSession({
    adapterScopeId: "race-fixture", cwd: "/disposable", runtimeEpoch: "race-epoch",
    native: { sessionId: "race-session", rpc: { mode: { set: async () => {} } },
      send, abort: async () => {}, setModel: async () => {}, getEvents: async () => [], disconnect: async () => {} },
    bridge, settings: {}, onStopped: () => {},
  });
  const emit = (type: string, data: object = {}) => bridge.nativeEvent({
    id: type, type, data, timestamp: "2026-09-07T00:00:00.000Z", parentId: null,
  } as SessionEvent);
  return { session, bridge, send, reject, emit };
}

describe("Copilot command and event ordering", () => {
  it("orders the interaction hydration baseline before startup callbacks", async () => {
    const bridge = new CopilotSessionBridge();
    bridge.interactionHydration(true);
    const response = bridge.interaction("userInput", { question: "disposable" }, {
      ephemeral: true,
      cancelValue: { answer: "cancelled" },
      parseResponse: value => value,
    });
    const events: AdapterEvent[] = [];
    bridge.subscribe(event => events.push(event));
    expect(events.map(event => event.kind === "lifecycle" ? event.fact.type : event.kind)).toEqual([
      "childrenHydrated", "interactionsHydrated", "status", "interaction",
    ]);
    const interaction = events.find((event): event is Extract<AdapterEvent, { kind: "interaction" }> => event.kind === "interaction")!;
    await interaction.resolve({ answer: "ok" });
    await expect(response).resolves.toEqual({ answer: "ok" });
    bridge.close();
  });

  it.each([
    [{ continuePendingWork: false, sessionWasActive: false }, true],
    [{ continuePendingWork: true, sessionWasActive: false }, false],
    [{ continuePendingWork: false, sessionWasActive: true }, false],
    [{ sessionWasActive: false }, false],
    [{ continuePendingWork: false }, false],
    [{}, false],
  ] as const)("certifies only an explicit cold non-continuing resume: %j", (data, certified) => {
    const bridge = new CopilotSessionBridge();
    bridge.interactionHydration(false);
    const events: AdapterEvent[] = [];
    bridge.subscribe(event => events.push(event));
    bridge.nativeEvent({ id: "resume", type: "session.resume", data,
      timestamp: "2026-09-26T00:00:00.000Z", parentId: null } as SessionEvent);
    expect(events.filter((event): event is Extract<AdapterEvent, { kind: "lifecycle" }> =>
      event.kind === "lifecycle" && (event.fact.type === "childrenHydrated" || event.fact.type === "interactionsHydrated"))
      .map(event => event.fact)).toEqual(certified ? [
        { type: "childrenHydrated", items: [], complete: false },
        { type: "interactionsHydrated", items: [], complete: false },
        { type: "childrenHydrated", items: [], complete: true },
        { type: "interactionsHydrated", items: [], complete: true },
      ] : [
        { type: "childrenHydrated", items: [], complete: false },
        { type: "interactionsHydrated", items: [], complete: false },
      ]);
    expect(events.filter(event => event.kind === "lifecycle" && event.fact.type === "coldResumeQuiescent"))
      .toHaveLength(certified ? 1 : 0);
    bridge.close();
  });

  it.each(["interactive", "plan", "autopilot"])("projects certified %s resume as Ready without a completed turn", mode => {
    const bridge = new CopilotSessionBridge();
    bridge.interactionHydration(false);
    let state = initialLifecycle({ sessionId: newSessionId(), runtimeNodeId: newRuntimeNodeId(),
      runtimeNodeBootId: newRuntimeNodeBootId(), runtimeEpoch: newRuntimeEpoch(), bindingRevision: 1 });
    const apply = (fact: LifecycleFact) => {
      state = reduceLifecycle(state, { version: LIFECYCLE_VERSION, fence: state.fence, sequence: state.nextSequence, fact });
    };
    bridge.subscribe(event => { if (event.kind === "lifecycle") apply(event.fact); });
    // Native discovery remains independent of the resume event. The certificate
    // must not fabricate a task or queue observation while these reads are pending.
    bridge.nativeEvent({ id: "resume", type: "session.resume",
      data: { continuePendingWork: false, sessionWasActive: false, mode },
      timestamp: "2026-10-01T00:00:00.000Z", parentId: null } as SessionEvent);
    expect(state.root).toEqual({ phase: "idle", cycle: null, outcome: "none" });
    expect(lifecycleProjection(state).view).toMatchObject({ status: "unknown", health: { state: "recovering" } });
    apply({ type: "tasksObserved", revision: 0, items: [] });
    apply({ type: "queueObserved", revision: 0, items: [], unidentifiedSteering: 0, inFlightSteering: 0 });
    expect(lifecycleProjection(state).view).toMatchObject({ status: "ready", health: { state: "healthy" },
      actions: { send: { available: true }, steer: { available: false } } });
    bridge.nativeEvent({ id: "new-cycle", type: "assistant.turn_start", data: { turnId: "0" },
      timestamp: "2026-10-01T00:00:01.000Z", parentId: "resume" } as SessionEvent);
    expect(lifecycleProjection(state).view.status).toBe("working");
    bridge.nativeEvent({ id: "duplicate-resume", type: "session.resume",
      data: { continuePendingWork: false, sessionWasActive: false },
      timestamp: "2026-10-01T00:00:02.000Z", parentId: "new-cycle" } as SessionEvent);
    expect(lifecycleProjection(state).view.status).toBe("working");
    expect(bridge.status()).toBe("running");
    bridge.close();
  });

  it.each([
    ["root start", (bridge: CopilotSessionBridge) => bridge.nativeEvent({ id: "started", type: "assistant.turn_start",
      data: { turnId: "0" }, timestamp: "2026-10-01T00:00:00.000Z", parentId: null } as SessionEvent), "running"],
    ["root failure", (bridge: CopilotSessionBridge) => bridge.nativeEvent({ id: "failed", type: "session.error",
      data: {}, timestamp: "2026-10-01T00:00:00.000Z", parentId: null } as SessionEvent), "error"],
    ["native root message", (bridge: CopilotSessionBridge) => bridge.nativeEvent({ id: "message", type: "user.message",
      data: { messageId: "current-message" }, timestamp: "2026-10-01T00:00:00.000Z", parentId: null } as SessionEvent), "running"],
    ["active read", (bridge: CopilotSessionBridge) => bridge.observeActivity({ hasActiveWork: true }, bridge.activityRevision), "running"],
    ["command start", (bridge: CopilotSessionBridge) => bridge.beginMessage(), "running"],
  ] as const)("preserves %s racing before a cold resume boundary", (_label, race, status) => {
    const bridge = new CopilotSessionBridge();
    bridge.interactionHydration(false);
    const events: AdapterEvent[] = [];
    bridge.subscribe(event => events.push(event));
    race(bridge);
    bridge.nativeEvent({ id: "late-resume", type: "session.resume",
      data: { continuePendingWork: false, sessionWasActive: false },
      timestamp: "2026-10-01T00:00:01.000Z", parentId: null } as SessionEvent);
    expect(events.some(event => event.kind === "lifecycle" && event.fact.type === "coldResumeQuiescent")).toBe(false);
    expect(events.some(event => event.kind === "lifecycle" && "complete" in event.fact && event.fact.complete)).toBe(false);
    expect(bridge.status()).toBe(status);
    bridge.close();
  });

  it("keeps hydration partial when a pending callback races before the resume boundary", () => {
    const bridge = new CopilotSessionBridge();
    bridge.interactionHydration(false);
    const pending = bridge.interaction("userInput", { question: "still pending" }, {
      ephemeral: true, cancelValue: { answer: "cancelled" }, parseResponse: value => value,
    });
    const events: AdapterEvent[] = [];
    bridge.subscribe(event => events.push(event));
    bridge.nativeEvent({ id: "resume", type: "session.resume",
      data: { continuePendingWork: false, sessionWasActive: false },
      timestamp: "2026-09-26T00:00:00.000Z", parentId: null } as SessionEvent);
    expect(events.some(event => event.kind === "lifecycle" &&
      (event.fact.type === "childrenHydrated" || event.fact.type === "interactionsHydrated") && event.fact.complete)).toBe(false);
    bridge.close();
    return expect(pending).resolves.toEqual({ answer: "cancelled" });
  });

  it("keeps hydration partial when a child callback races before the resume boundary", () => {
    const bridge = new CopilotSessionBridge();
    bridge.interactionHydration(false);
    const events: AdapterEvent[] = [];
    bridge.subscribe(event => events.push(event));
    bridge.nativeEvent({ id: "child", type: "subagent.started", data: { toolCallId: "child-tool" },
      timestamp: "2026-09-26T00:00:00.000Z", parentId: null } as SessionEvent);
    bridge.nativeEvent({ id: "resume", type: "session.resume",
      data: { continuePendingWork: false, sessionWasActive: false },
      timestamp: "2026-09-26T00:00:01.000Z", parentId: "child" } as SessionEvent);
    expect(events.some(event => event.kind === "lifecycle" &&
      (event.fact.type === "childrenHydrated" || event.fact.type === "interactionsHydrated") && event.fact.complete)).toBe(false);
    bridge.close();
  });

  it("keeps hydration partial when a native interaction request races ahead of its callback", () => {
    const bridge = new CopilotSessionBridge();
    bridge.interactionHydration(false);
    const events: AdapterEvent[] = [];
    bridge.subscribe(event => events.push(event));
    bridge.nativeEvent({ id: "request", type: "user_input.requested",
      data: { requestId: "pending", question: "still pending" }, ephemeral: true,
      timestamp: "2026-09-26T00:00:00.000Z", parentId: null } as SessionEvent);
    bridge.nativeEvent({ id: "resume", type: "session.resume",
      data: { continuePendingWork: false, sessionWasActive: false },
      timestamp: "2026-09-26T00:00:01.000Z", parentId: "request" } as SessionEvent);
    expect(events.some(event => event.kind === "lifecycle" &&
      (event.fact.type === "childrenHydrated" || event.fact.type === "interactionsHydrated") && event.fact.complete)).toBe(false);
    bridge.close();
  });

  it("orders a certified boundary before a later callback", async () => {
    const bridge = new CopilotSessionBridge();
    bridge.interactionHydration(false);
    const events: AdapterEvent[] = [];
    bridge.subscribe(event => events.push(event));
    bridge.nativeEvent({ id: "resume", type: "session.resume",
      data: { continuePendingWork: false, sessionWasActive: false },
      timestamp: "2026-09-26T00:00:00.000Z", parentId: null } as SessionEvent);
    const pending = bridge.interaction("elicitation", { message: "new work" }, {
      ephemeral: true, cancelValue: { action: "cancel" }, parseResponse: value => value,
    });
    expect(events.map(event => event.kind === "lifecycle" ? `${event.fact.type}:${"complete" in event.fact ? event.fact.complete : ""}` : event.kind)).toEqual([
      "childrenHydrated:false", "interactionsHydrated:false", "native",
      "childrenHydrated:true", "interactionsHydrated:true", "coldResumeQuiescent:", "status", "interaction",
    ]);
    bridge.close();
    await expect(pending).resolves.toEqual({ action: "cancel" });
  });

  it("fences duplicate, child-owned, retired, and replacement resume boundaries", () => {
    const lifecycle = (bridge: CopilotSessionBridge): AdapterEvent[] => {
      const events: AdapterEvent[] = [];
      bridge.subscribe(event => events.push(event));
      return events;
    };
    const stale = new CopilotSessionBridge(); stale.interactionHydration(false); const staleEvents = lifecycle(stale);
    stale.nativeEvent({ id: "ambiguous", type: "session.resume", data: {},
      timestamp: "2026-09-26T00:00:00.000Z", parentId: null } as SessionEvent);
    stale.nativeEvent({ id: "duplicate", type: "session.resume",
      data: { continuePendingWork: false, sessionWasActive: false },
      timestamp: "2026-09-26T00:00:01.000Z", parentId: "ambiguous" } as SessionEvent);
    expect(staleEvents.some(event => event.kind === "lifecycle" && "complete" in event.fact && event.fact.complete)).toBe(false);
    expect(staleEvents.some(event => event.kind === "lifecycle" && event.fact.type === "coldResumeQuiescent")).toBe(false);
    stale.close();
    stale.nativeEvent({ id: "late", type: "session.resume",
      data: { continuePendingWork: false, sessionWasActive: false },
      timestamp: "2026-09-26T00:00:02.000Z", parentId: "duplicate" } as SessionEvent);

    const childOwned = new CopilotSessionBridge(); childOwned.interactionHydration(false); const childEvents = lifecycle(childOwned);
    childOwned.nativeEvent({ id: "child-resume", type: "session.resume", agentId: "other-session-owner",
      data: { continuePendingWork: false, sessionWasActive: false },
      timestamp: "2026-09-26T00:00:00.000Z", parentId: null } as SessionEvent);
    expect(childEvents.some(event => event.kind === "lifecycle" && "complete" in event.fact && event.fact.complete)).toBe(false);
    expect(childEvents.some(event => event.kind === "lifecycle" && event.fact.type === "coldResumeQuiescent")).toBe(false);
    childOwned.close();

    // A runtime restart creates a fresh bridge/epoch. Only its own first exact
    // boundary may certify that replacement attachment.
    const replacement = new CopilotSessionBridge(); replacement.interactionHydration(false); const replacementEvents = lifecycle(replacement);
    replacement.nativeEvent({ id: "replacement", type: "session.resume",
      data: { continuePendingWork: false, sessionWasActive: false },
      timestamp: "2026-09-26T00:00:00.000Z", parentId: null } as SessionEvent);
    expect(replacementEvents.filter(event => event.kind === "lifecycle" && "complete" in event.fact && event.fact.complete)).toHaveLength(2);
    expect(replacementEvents.filter(event => event.kind === "lifecycle" && event.fact.type === "coldResumeQuiescent")).toHaveLength(1);
    replacement.close();
  });

  it.each(["agentId", "parentToolCallId"])("fences legacy %s child lifecycle and settings", key => {
    const f = fixture();
    f.emit("assistant.turn_start", { turnId: "0" });
    f.emit("session.model_change", { newModel: "root-model" });
    f.emit("session.error", { [key]: "child", message: "Child failed" });
    f.emit("session.idle", { [key]: "child" });
    f.emit("user_input.requested", { [key]: "child" });
    f.emit("session.model_change", { [key]: "child", newModel: "child-model" });
    expect(f.session.status()).toBe("running");
    expect(f.session.settings().model).toBe("root-model");
    f.bridge.close();
  });

  it.each([undefined, "agentId", "parentToolCallId"])("does not revive idle when a permission reply arrives after completion (%s)", ownerKey => {
    const f = fixture();
    let acknowledge!: (value: unknown) => void;
    const reply = new Promise<unknown>(resolve => { acknowledge = resolve; });
    f.bridge.attachPermissions({ getMode: async () => ({ mode: "manual" }), setMode: async () => ({}),
      handlePendingPermissionRequest: () => reply }, () => {});
    const events: AdapterEvent[] = [];
    f.bridge.subscribe(event => events.push(event));
    f.emit("assistant.turn_start", { turnId: "0" });
    const provenance = ownerKey ? { [ownerKey]: "child" } : {};
    f.emit("permission.requested", { requestId: "permission", permissionRequest: { kind: "shell" }, ...provenance });
    expect(f.session.status()).toBe(ownerKey ? "running" : "waitingForInput");
    const request = events.find((event): event is Extract<AdapterEvent, { kind: "interaction" }> => event.kind === "interaction")!;
    expect(request).toBeDefined();
    const resolved = request.resolve({ kind: "approved" });
    f.emit("permission.completed", { requestId: "permission", ...provenance });
    f.emit("session.idle");
    acknowledge({ success: true });
    return resolved.then(() => {
      expect(f.session.status()).toBe("idle");
      f.emit("permission.completed", { requestId: "permission", ...provenance });
      expect(f.session.status()).toBe("idle");
      f.bridge.close();
    });
  });

  it.each([
    ["assistant.turn_start", { turnId: "0" }, "running"],
    ["session.idle", {}, "idle"],
    ["session.error", { message: "Native failure" }, "error"],
  ] as const)("retains newer %s when the send acknowledgement is lost", async (type, data, status) => {
    const f = fixture();
    const command = f.session.execute({ harness: "copilot", command: { type: "send", prompt: "A disposable message" } });
    const result = expect(command).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    f.emit(type, data);
    f.reject(new Error("Disconnected before acknowledgement"));
    await result;
    expect(f.session.status()).toBe(status);
    expect(f.send).toHaveBeenCalledOnce();
    f.bridge.close();
  });

  it("reports unknown activity without later native evidence and never retries", async () => {
    const f = fixture();
    const command = f.session.execute({ harness: "copilot", command: { type: "steer", prompt: "A disposable steer" } });
    const result = expect(command).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    f.reject(new Error("Acknowledgement lost"));
    await result;
    expect(f.session.status()).toBe("unknown");
    expect(f.send).toHaveBeenCalledOnce();
    f.bridge.close();
  });
});
