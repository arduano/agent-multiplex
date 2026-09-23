import { describe, expect, it } from "vitest";
import {
  initialLifecycle, lifecycleFactSchema, lifecycleProjection, lifecycleStateSchema,
  LIFECYCLE_VERSION, newCommandId, newRuntimeEpoch, newRuntimeNodeBootId,
  newRuntimeNodeId, newSessionId, offlineLifecycleView, projectDelivery,
  projectLifecycle, reconcileLifecycle, reduceLifecycle,
  type LifecycleFact, type LifecycleState,
} from "../src/index.js";

const fence = () => ({ sessionId: newSessionId(), runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId(), runtimeEpoch: newRuntimeEpoch(), bindingRevision: 1 });
const step = (s: LifecycleState, fact: LifecycleFact, sequence = s.nextSequence) => reduceLifecycle(s, { version: LIFECYCLE_VERSION, fence: s.fence, sequence, fact });
function ready() {
  let s = initialLifecycle(fence());
  s = step(s, { type: "rootObserved", active: false });
  s = step(s, { type: "tasksObserved", revision: 0, items: [] });
  s = step(s, { type: "queueObserved", revision: 0, items: [], unidentifiedSteering: 0, inFlightSteering: 0 });
  s = step(s, { type: "childrenHydrated", items: [], complete: true });
  return step(s, { type: "interactionsHydrated", items: [], complete: true });
}
function command(s = ready()) {
  const commandId = newCommandId();
  s = step(s, { type: "commandPrepared", commandId, payloadHash: "same-payload", kind: "steer" });
  s = step(s, { type: "commandReceipt", commandId, payloadHash: "same-payload", admission: "dispatched" });
  return { s, commandId };
}

describe("runtime-owned lifecycle dimensions", () => {
  it("correlates acknowledgment before and after root echo; never child, UUID, text, absence or time", () => {
    for (const echoFirst of [true, false]) {
      let { s, commandId } = command();
      const ack: LifecycleFact = { type: "commandReceipt", commandId, payloadHash: "same-payload", admission: "accepted", messageId: "logical" };
      const echo: LifecycleFact = { type: "messageDisplayed", owner: "root", messageId: "logical" };
      for (const fact of echoFirst ? [echo, ack] : [ack, echo]) s = step(s, fact);
      expect(projectDelivery(s.commands[0]!, s)).toBe("Displayed");
      expect(s.commands[0]!.consumed).toBe(false);
      expect(s.commands[0]!.settled).toBe(false);
    }
    let { s, commandId } = command();
    expect(lifecycleFactSchema.safeParse({ type: "messageDisplayed", owner: "root" }).success).toBe(false);
    s = step(s, { type: "messageDisplayed", owner: "agent:child", messageId: "logical" });
    s = step(s, { type: "commandReceipt", commandId, payloadHash: "same-payload", admission: "accepted", messageId: "logical" });
    s = step(s, { type: "queueObserved", revision: 0, items: [], unidentifiedSteering: 0, inFlightSteering: 0 });
    expect(projectDelivery(s.commands[0]!, s)).toBe("Accepted");
  });
  it("queue drain before display and delayed steer never settle commands", () => {
    let { s, commandId } = command();
    s = step(s, { type: "commandReceipt", commandId, payloadHash: "same-payload", admission: "accepted", messageId: "m" });
    s = step(s, { type: "queueObserved", revision: 0, items: [{ id: "queue-id", messageId: "m", kind: "steering" }], unidentifiedSteering: 1, inFlightSteering: 1 });
    expect(projectDelivery(s.commands[0]!, s)).toBe("Queued");
    s = step(s, { type: "queueObserved", revision: 0, items: [], unidentifiedSteering: 0, inFlightSteering: 0 });
    expect(projectDelivery(s.commands[0]!, s)).toBe("Accepted");
    s = step(s, { type: "messageDisplayed", owner: "root", messageId: "m" });
    s = step(s, { type: "messageConsumed", owner: "root", messageId: "m" });
    expect(projectDelivery(s.commands[0]!, s)).toBe("Consumed");
    s = step(s, { type: "rootIdle", aborted: false });
    expect(s.commands[0]!.settled).toBe(false);
  });
  it("keeps root, child, task, interaction, queue and terminal outcome orthogonal", () => {
    let s = ready();
    s = step(s, { type: "rootStarted", cycleId: "event-uuid" });
    s = step(s, { type: "child", id: "tool:child", state: "running" });
    s = step(s, { type: "tasksObserved", revision: 0, items: [{ id: "shell", kind: "shell", status: "running" }] });
    expect(projectLifecycle(s)).toBe("Working");
    s = step(s, { type: "rootModelIdle" });
    expect(s.root.phase).toBe("paused");
    expect(projectLifecycle(s)).toBe("Waiting for child/task");
    expect(s.children.items[0]!.state).toBe("running");
    s = step(s, { type: "rootIdle", aborted: false });
    expect(projectLifecycle(s)).toBe("Waiting for child/task");
    expect(s.children.items[0]!.state).toBe("settled");
    s = step(s, { type: "interactionOpened", interaction: { id: "exact-input", kind: "userInput", owner: "root" } });
    expect(projectLifecycle(s)).toBe("Waiting for input");
    s = step(s, { type: "tasksObserved", revision: 0, items: [] });
    s = step(s, { type: "interactionClosed", id: "unrelated" });
    expect(projectLifecycle(s)).toBe("Waiting for input");
    s = step(s, { type: "interactionClosed", id: "exact-input" });
    expect(projectLifecycle(s)).toBe("Finished");
    s = step(s, { type: "queueObserved", revision: 0, items: [{ id: "q", kind: "queued" }], unidentifiedSteering: 0, inFlightSteering: 0 });
    expect(projectLifecycle(s)).toBe("Queued");
  });
  it("rejects stale empty snapshots after invalidation and does not invent completion on errors", () => {
    let s = ready();
    s = step(s, { type: "rootStarted", cycleId: "start" });
    s = step(s, { type: "tasksInvalidated" });
    s = step(s, { type: "tasksObserved", revision: 0, items: [] });
    s = step(s, { type: "rootIdle", aborted: false });
    expect(s.tasks.observation.state).toBe("pending");
    expect(projectLifecycle(s)).toBe("Unknown");
    s = step(s, { type: "rootFailed" });
    s = step(s, { type: "rootIdle", aborted: false });
    expect(projectLifecycle(s)).toBe("Failed");
    expect(projectLifecycle(s, false)).toBe("Offline");
    s = step(s, { type: "rootStarted", cycleId: "new-start" });
    s = step(s, { type: "rootIdle", aborted: true });
    expect(projectLifecycle(s)).toBe("Interrupted");
  });
  it("revision-fences observation failures and clears degraded health only after recovery", () => {
    let s = ready();
    s = step(s, { type: "tasksInvalidated" });
    const revision = s.tasks.revision;
    s = step(s, {
      type: "observationFailed",
      view: "tasks",
      revision,
      failures: 3,
      diagnosticId: "00000000-0000-4000-8000-000000000001",
      stalled: true,
    });
    expect(s.tasks.observation).toEqual({
      state: "retrying",
      failures: 3,
      diagnosticId: "00000000-0000-4000-8000-000000000001",
      stalled: true,
    });
    const degraded = lifecycleProjection(s).view;
    expect(degraded.health).toMatchObject({
      state: "degraded",
      issues: [{ scope: "tasks", code: "observationStalled" }],
    });
    expect(degraded.actions.send).toEqual({ available: false, reason: "nativeObservationDegraded" });
    expect(degraded.actions.stop).toEqual({ available: true, reason: "available" });

    s = step(s, { type: "tasksInvalidated" });
    const afterInvalidation = s;
    s = step(s, {
      type: "observationFailed",
      view: "tasks",
      revision,
      failures: 4,
      diagnosticId: "00000000-0000-4000-8000-000000000002",
      stalled: true,
    });
    expect(s.tasks).toEqual(afterInvalidation.tasks);
    s = step(s, { type: "tasksObserved", revision: s.tasks.revision, items: [] });
    const observed = s;
    s = step(s, {
      type: "observationFailed",
      view: "tasks",
      revision: s.tasks.revision,
      failures: 5,
      diagnosticId: "00000000-0000-4000-8000-000000000003",
      stalled: true,
    });
    expect(s.tasks).toEqual(observed.tasks);
    expect(lifecycleProjection(s).view.health.state).toBe("healthy");
  });
  it("publishes an opaque compact view and applies host reachability centrally", () => {
    const state = ready();
    const projection = lifecycleProjection(state);
    expect(projection).toMatchObject({
      version: LIFECYCLE_VERSION,
      fence: state.fence,
      nextSequence: state.nextSequence,
      view: {
        version: LIFECYCLE_VERSION,
        status: "ready",
        health: { state: "healthy", issues: [] },
      },
    });
    expect(Object.keys(projection.view).sort()).toEqual(["actions", "health", "observationId", "status", "version"]);
    expect(projection.view).not.toHaveProperty("fence");
    expect(projection.view).not.toHaveProperty("nextSequence");
    expect(projection.view).not.toHaveProperty("root");

    const offline = offlineLifecycleView(projection.view);
    expect(offline).toMatchObject({
      status: "offline",
      health: { state: "offline", issues: [{ scope: "lifecycle", code: "hostUnavailable" }] },
    });
    expect(Object.values(offline.actions).every(action => !action.available && action.reason === "hostOffline")).toBe(true);
    expect(offline.observationId).not.toBe(projection.view.observationId);
  });
  it("keeps outcomeUnknown independent of observed effects and later authoritative receipts", () => {
    let { s, commandId } = command();
    s = step(s, { type: "commandReceipt", commandId, payloadHash: "same-payload", admission: "outcomeUnknown" });
    s = step(s, { type: "compaction", phase: "running" });
    s = step(s, { type: "compaction", phase: "observedComplete" });
    s = step(s, { type: "messageDisplayed", messageId: "late", owner: "root" });
    expect(s.commands[0]!.admission).toBe("outcomeUnknown");
    s = step(s, { type: "commandReceipt", commandId, payloadHash: "same-payload", admission: "accepted", messageId: "late" });
    expect(s.commands[0]).toMatchObject({ admission: "accepted", displayed: true, settled: false });
    s = step(s, { type: "commandReceipt", commandId, payloadHash: "same-payload", admission: "outcomeUnknown" });
    expect(s.commands[0]!.admission).toBe("accepted");
    expect(() => step(s, { type: "commandReceipt", commandId, payloadHash: "different", admission: "failed" })).toThrow("identity conflict");
  });
  it("gaps, duplicate, out-of-order, source generation and binding changes fail closed", () => {
    let s = ready();
    const before = s;
    expect(step(s, { type: "rootStarted", cycleId: "late" }, 0)).toBe(s);
    s = step(s, { type: "interactionOpened", interaction: { id: "possibly-lost-close", owner: "root", kind: "userInput" } });
    s = step(s, { type: "rootModelIdle" }, s.nextSequence + 1);
    expect(s.continuity).toBe("gap");
    expect(s.root.phase).toBe("unknown");
    expect(s.interactions).toEqual({ completeness: "partial", items: [] });
    s = step(s, { type: "rootIdle", aborted: false });
    expect(projectLifecycle(s)).toBe("Unknown");
    expect(reconcileLifecycle(s, before, 2, 2)).toBe(s);
    const snapshot = { ...ready(), fence: s.fence, nextSequence: s.nextSequence + 1 };
    expect(reconcileLifecycle(s, snapshot, 1, 2)).toBe(s);
    expect(reconcileLifecycle(s, snapshot, 2, 2).continuity).toBe("continuous");
    expect(reduceLifecycle(s, { version: LIFECYCLE_VERSION, sequence: s.nextSequence, fence: { ...s.fence, runtimeEpoch: newRuntimeEpoch() }, fact: { type: "rootIdle", aborted: false } })).toBe(s);
    s = step(s, { type: "rootStarted", cycleId: "recovery-boundary" });
    expect(s).toMatchObject({ continuity: "continuous", root: { phase: "working", cycle: "recovery-boundary" },
      tasks: { observation: { state: "pending" } }, queue: { observation: { state: "pending" } }, interactions: { completeness: "partial" } });
    expect(projectLifecycle(s)).toBe("Working");

    s = step(s, { type: "child", id: "agent:post-gap-child", state: "running" });
    s = step(s, { type: "gap" });
    expect(s.children.items[0]!.state).toBe("unknown");
    s = step(s, { type: "rootIdle", aborted: false });
    expect(s.children).toMatchObject({ completeness: "complete", items: [{ state: "settled" }] });
    expect(s.continuity).toBe("continuous");

    let jumped = ready();
    jumped = step(jumped, { type: "rootStarted", cycleId: "observed-after-loss" }, jumped.nextSequence + 1);
    expect(jumped).toMatchObject({ continuity: "continuous", root: { phase: "working", cycle: "observed-after-loss" },
      tasks: { observation: { state: "pending" } }, queue: { observation: { state: "pending" } } });
  });
  it("partial reconnect interaction hydration never proves absence", () => {
    let s = ready();
    s = step(s, { type: "interactionOpened", interaction: { id: "raced-request", owner: "root", kind: "userInput" } });
    s = step(s, { type: "interactionsHydrated", items: [], complete: false });
    expect(s.interactions.items).toEqual([{ id: "raced-request", owner: "root", kind: "userInput" }]);
    expect(projectLifecycle(s)).toBe("Waiting for input");
    s = step(s, { type: "interactionClosed", id: "raced-request" });
    s = step(s, { type: "interactionOpened", interaction: { id: "child-request", owner: "agent:child", kind: "permission" } });
    expect(projectLifecycle(s)).toBe("Unknown");
  });
  it("does not revive a prior Finished result after unidentified recovered activity", () => {
    let s = ready();
    s = step(s, { type: "rootStarted", cycleId: "cycle-one" });
    s = step(s, { type: "rootIdle", aborted: false });
    expect(projectLifecycle(s)).toBe("Finished");
    s = step(s, { type: "rootObserved", active: true });
    expect(s.root).toEqual({ phase: "working", cycle: null, outcome: "none" });
    expect(projectLifecycle(s)).toBe("Working");
    s = step(s, { type: "rootObserved", active: false });
    expect(s.root).toEqual({ phase: "idle", cycle: null, outcome: "none" });
    expect(projectLifecycle(s)).toBe("Ready");
  });
  it("keeps model pause and terminal outcomes distinct until a new root cycle", () => {
    let s = ready();
    s = step(s, { type: "rootStarted", cycleId: "cycle" });
    s = step(s, { type: "rootModelIdle" });
    expect(projectLifecycle(s)).toBe("Unknown");
    s = step(s, { type: "rootFailed" });
    s = step(s, { type: "rootIdle", aborted: true });
    expect(s.root.outcome).toBe("failed");
    s = step(s, { type: "rootStarted", cycleId: "next" });
    s = step(s, { type: "rootIdle", aborted: true });
    s = step(s, { type: "rootIdle", aborted: false });
    expect(s.root.outcome).toBe("interrupted");
  });
  it("tracks child completeness independently across loss and quiescent recovery", () => {
    let s = ready();
    s = step(s, { type: "gap" });
    expect(s.children).toEqual({ completeness: "partial", items: [] });
    s = step(s, { type: "rootStarted", cycleId: "new-cycle" });
    expect(s.children.completeness).toBe("partial");
    s = step(s, { type: "tasksObserved", revision: s.tasks.revision, items: [] });
    s = step(s, { type: "queueObserved", revision: s.queue.revision, items: [], unidentifiedSteering: 0, inFlightSteering: 0 });
    expect(projectLifecycle(s)).toBe("Working");
    s = step(s, { type: "rootIdle", aborted: false });
    expect(s.children.completeness).toBe("complete");
    expect(projectLifecycle(s)).toBe("Unknown");
  });
  it("bounds command correlation without wedging a long-lived binding", () => {
    let s = ready();
    const ids = Array.from({ length: 256 }, () => newCommandId());
    for (const commandId of ids) s = step(s, { type: "commandPrepared", commandId, payloadHash: commandId, kind: "send" });
    const overflow = newCommandId();
    s = step(s, { type: "commandPrepared", commandId: overflow, payloadHash: "overflow", kind: "send" });
    expect(s.commands).toHaveLength(256);
    expect(s.commands.some((command) => command.commandId === ids[0])).toBe(false);
    expect(s.commands.some((command) => command.commandId === overflow)).toBe(true);
    const failed = ids[17]!;
    s = step(s, { type: "commandReceipt", commandId: failed, payloadHash: failed, admission: "failed" });
    const replacement = newCommandId();
    s = step(s, { type: "commandPrepared", commandId: replacement, payloadHash: "replacement", kind: "send" });
    expect(s.commands).toHaveLength(256);
    expect(s.commands.some((command) => command.commandId === failed)).toBe(false);
    expect(s.commands.some((command) => command.commandId === replacement)).toBe(true);

    const displayed = s.commands[0]!;
    s = step(s, { type: "commandReceipt", commandId: displayed.commandId, payloadHash: displayed.payloadHash,
      admission: "accepted", messageId: "displayed-message" });
    s = step(s, { type: "messageDisplayed", owner: "root", messageId: "displayed-message" });
    const next = newCommandId();
    s = step(s, { type: "commandPrepared", commandId: next, payloadHash: "after-display", kind: "send" });
    expect(s.commands.some((entry) => entry.commandId === displayed.commandId)).toBe(false);
    expect(s.commands.some((entry) => entry.commandId === next)).toBe(true);
  });
  it("enumerates 4096 schedules preserving no spontaneous certainty, completion or consumption", () => {
    const facts: LifecycleFact[] = [
      { type: "rootModelIdle" }, { type: "rootIdle", aborted: false },
      { type: "tasksInvalidated" }, { type: "tasksObserved", revision: 0, items: [] },
      { type: "queueInvalidated" }, { type: "queueObserved", revision: 0, items: [], unidentifiedSteering: 0, inFlightSteering: 0 },
      { type: "compaction", phase: "observedComplete" }, { type: "gap" },
    ];
    for (let schedule = 0; schedule < 4096; schedule++) {
      let { s, commandId } = command();
      s = step(s, { type: "commandReceipt", commandId, payloadHash: "same-payload", admission: "outcomeUnknown" });
      let code = schedule;
      for (let i = 0; i < 4; i++, code = Math.floor(code / facts.length)) {
        const old = JSON.stringify(s);
        const next = step(s, facts[code % facts.length]!);
        expect(JSON.stringify(s)).toBe(old);
        s = next;
        expect(lifecycleStateSchema.safeParse(s).success).toBe(true);
        expect(s.commands[0]).toMatchObject({ admission: "outcomeUnknown", consumed: false, settled: false, displayed: false });
        expect(projectLifecycle(s)).not.toBe("Finished");
      }
    }
  });
});
