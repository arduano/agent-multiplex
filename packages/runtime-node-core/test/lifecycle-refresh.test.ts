import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adapterScopeIdSchema,
  newCommandId,
  newLaunchId,
  newRuntimeEpoch,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  NATIVE_PAYLOAD_MAX_BYTES,
  type HarnessCatalogEntry,
  type HarnessCommand,
  type HarnessResumeOptions,
  type HarnessSpawnOptions,
  type JsonValue,
  type LaunchRequest,
  type LifecycleState,
  type NativeHistoryRequest,
  type NativeHistoryResult,
  type NativeInventoryItem,
  type NativeModel,
  type NativeStateRequest,
} from "@arduano/agent-multiplex-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeNodeService,
  RuntimeNodeStore,
  RuntimeLifecycleJournal,
  AdapterOutcomeUnknownError,
  AdapterNativeStateValidationError,
  AdapterNativeStateReadError,
  type AdapterEvent,
  type AdapterNativeStateResult,
  type AdapterSession,
  type AgentAdapter,
  type CopilotIncidentTraceRecord,
} from "../src/index.js";

type NativeRead = (request: NativeStateRequest) => Promise<AdapterNativeStateResult>;
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class RefreshSession implements AdapterSession {
  public readonly harness = "copilot" as const;
  public readonly adapterScopeId = adapterScopeIdSchema.parse("lifecycle-refresh-test");
  public readonly runtimeEpoch = newRuntimeEpoch();
  readonly #listeners = new Set<(event: AdapterEvent) => void>();
  #stopped = false;

  public constructor(
    public readonly cwd: string,
    public read: NativeRead,
    public readonly vendorSessionId = "native-lifecycle-refresh",
  ) {}

  public status() { return this.#stopped ? "stopped" as const : "idle" as const; }
  public subscribe(listener: (event: AdapterEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  public emit(event: AdapterEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
  public execute(_command: HarnessCommand): Promise<JsonValue | undefined> {
    return Promise.resolve(undefined);
  }
  public readNativeState(request: NativeStateRequest): Promise<AdapterNativeStateResult> {
    return this.read(request);
  }
  public readNativeHistory(_request: NativeHistoryRequest): Promise<NativeHistoryResult> {
    return Promise.reject(new Error("lifecycle refresh must not read history"));
  }
  public stop(): Promise<void> {
    this.#stopped = true;
    return Promise.resolve();
  }
}

class RefreshAdapter implements AgentAdapter {
  public readonly harness = "copilot" as const;
  public readonly adapterScopeId;

  public constructor(public readonly session: RefreshSession) {
    this.adapterScopeId = session.adapterScopeId;
  }

  public describe(): Promise<HarnessCatalogEntry> {
    return Promise.resolve({ harness: "copilot", adapterScopeId: this.adapterScopeId, available: true, capabilities: [] });
  }
  public listModels(): Promise<NativeModel[]> { return Promise.resolve([]); }
  public listSessions(): Promise<NativeInventoryItem[]> { return Promise.resolve([]); }
  public spawn(_options: HarnessSpawnOptions): Promise<AdapterSession> { return Promise.resolve(this.session); }
  public resume(_options: HarnessResumeOptions): Promise<AdapterSession> {
    return Promise.reject(new Error("lifecycle refresh must not resume"));
  }
  public close(): Promise<void> { return Promise.resolve(); }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(
  read: (session: RefreshSession, request: NativeStateRequest) => Promise<AdapterNativeStateResult>,
  onRecoveryRequired?: (sessionId: string) => void,
  expectCloseFailure = false,
) {
  const cwd = mkdtempSync(join(tmpdir(), "multiplex-lifecycle-refresh-"));
  const store = new RuntimeNodeStore(":memory:");
  const runtimeNodeId = newRuntimeNodeId();
  let session!: RefreshSession;
  session = new RefreshSession(cwd, request => read(session, request));
  const adapter = new RefreshAdapter(session);
  const traces: CopilotIncidentTraceRecord[] = [];
  const service = new RuntimeNodeService({
    store,
    runtimeNodeId,
    runtimeNodeBootId: newRuntimeNodeBootId(),
    name: "lifecycle refresh test",
    allowedRoots: [cwd],
    adapters: [adapter],
    onCopilotIncidentTrace: trace => { traces.push(trace); },
    ...(onRecoveryRequired ? { onCopilotObservationRecoveryRequired: onRecoveryRequired } : {}),
  });
  cleanup.push(async () => {
    if (expectCloseFailure) await service.close().catch(() => undefined);
    else await service.close();
    store.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  const profile = service.launchProfiles()[0]!;
  const launch: LaunchRequest = {
    launchId: newLaunchId(),
    sessionId: newSessionId(),
    runtimeNodeId,
    payloadHash: "lifecycle-refresh-launch",
    profile: {
      providerId: profile.providerId,
      profileId: profile.profileId,
      contractVersion: profile.contractVersion,
      requestSchemaHash: profile.requestSchemaHash,
    },
    harness: "copilot",
    input: { cwd },
  };
  service.createLaunch(launch);
  await vi.waitFor(() => expect(service.getLaunch(launch.launchId)?.state).toBe("succeeded"));
  return { service, store, session, adapter, launch, traces };
}

async function lifecycleState(
  value: Awaited<ReturnType<typeof fixture>>,
): Promise<LifecycleState> {
  const projection = await value.service.readLifecycle(value.launch.sessionId);
  return new RuntimeLifecycleJournal(value.store).read(projection.fence);
}

const tasksResult = {
  harness: "copilot" as const,
  vendorSessionId: "native-lifecycle-refresh",
  payload: { tasks: [{ id: "task-1", type: "agent", status: "running" }] },
};
const queueResult = {
  harness: "copilot" as const,
  vendorSessionId: "native-lifecycle-refresh",
  payload: { items: [{ id: "queue-1", messageId: "message-1" }], steeringMessages: [], inFlightSteeringCount: 0 },
};

describe("server-owned Copilot lifecycle refresh", () => {
  it("turns old unconfirmed Copilot admissions into warnings without clearing their delivery evidence", async () => {
    const f = await fixture(async (_session, request) => request.harness === "copilot" && request.view === "tasks" ? tasksResult : queueResult);
    await vi.waitFor(async () => expect((await lifecycleState(f)).queue.observation.state).toBe("observed"));
    f.session.emit({ kind: "lifecycle", fact: { type: "interactionsHydrated", items: [], complete: true } });
    f.session.execute = async () => ({ messageId: "not-in-native-queue" });
    const commandId = newCommandId();
    const receipt = await f.service.execute({ commandId, payloadHash: "copilot-old-admission", sessionId: f.launch.sessionId,
      runtimeNodeId: f.launch.runtimeNodeId, bindingRevision: 1,
      request: { harness: "copilot", command: { type: "send", prompt: "Fixture old admission", mode: "enqueue" } } });
    expect(receipt.state).toBe("succeeded");
    expect((await f.service.catalog())[0]?.capabilities).toContainEqual({ name: "messages.deliveryWarnings", version: "v1", experimental: false });
    const oldAt = new Date(Date.now() - 180_000).toISOString(), original = { ...receipt, createdAt: oldAt, updatedAt: oldAt };
    f.store.putCommand(original);
    const read = () => f.service.readNativeState(f.launch.sessionId, { harness: "copilot", view: "messageDeliveries" });
    const observation = f.service.observeCommand(commandId), first = await read();
    expect(first.payload.json).toMatchObject({ items: [], warnings: [{ commandId, state: "accepted", reason: "deliveryUnconfirmed", messageId: "not-in-native-queue" }] });
    expect((await read()).payload.json).toEqual(first.payload.json);
    expect(f.service.observeCommand(commandId)).toEqual(observation);
    expect(observation).toMatchObject({ receipt: original, continuation: "observeDelivery" });
    f.session.emit({ kind: "lifecycle", fact: { type: "messageDisplayed", messageId: "not-in-native-queue", owner: "root" } });
    expect((await read()).payload.json).toMatchObject({ items: [], warnings: [{ state: "displayed", reason: "consumptionUnconfirmed" }] });
    f.session.emit({ kind: "lifecycle", fact: { type: "messageConsumed", messageId: "not-in-native-queue", owner: "root" } });
    expect((await read()).payload.json).toMatchObject({ items: [], warnings: [] });
    expect(f.service.getCommand(commandId)).toEqual(original);
  });

  it("shows exact queued messages from the Host and never attributes anonymous steering text", async () => {
    const f = await fixture(async (_session, request) => request.harness === "copilot" && request.view === "tasks" ? tasksResult : queueResult);
    await vi.waitFor(async () => expect((await lifecycleState(f)).queue.observation.state).toBe("observed"));
    f.session.emit({ kind: "lifecycle", fact: { type: "interactionsHydrated", items: [], complete: true } });
    f.session.emit({ kind: "lifecycle", fact: { type: "rootStarted", cycleId: "cycle-1" } });
    f.session.execute = async () => ({ messageId: "message-1" });
    const commandId = newCommandId();
    const receipt = await f.service.execute({ commandId, payloadHash: "copilot-queue-hash", sessionId: f.launch.sessionId,
      runtimeNodeId: f.launch.runtimeNodeId, bindingRevision: 1,
      request: { harness: "copilot", command: { type: "steer", prompt: "Steer pending", mode: "immediate" } } });
    expect(receipt.state).toBe("succeeded");
    const read = () => f.service.readNativeState(f.launch.sessionId, { harness: "copilot", view: "messageDeliveries" });
    expect((await read()).payload.json).toMatchObject({ items: [{ commandId, state: "queued", messageId: "message-1" }], queueObservation: "observed" });
    f.session.emit({ kind: "lifecycle", fact: { type: "messageConsumed", messageId: "unrelated-message", owner: "root" } });
    expect((await read()).payload.json).toMatchObject({ items: [{ commandId, state: "queued" }] });
    f.session.emit({ kind: "lifecycle", fact: { type: "messageConsumed", messageId: "message-1", owner: "root" } });
    expect((await read()).payload.json).toMatchObject({ items: [] });
  });

  it("does not turn root idle into Ready while a fresh task snapshot is running", async () => {
    const f = await fixture(async (_session, request) => request.harness === "copilot" && request.view === "tasks" ? tasksResult : queueResult);
    await vi.waitFor(async () => expect((await lifecycleState(f)).tasks.observation.state).toBe("observed"));
    f.session.emit({ kind: "lifecycle", fact: { type: "rootIdle", aborted: false } });
    await vi.waitFor(async () => expect((await f.service.readLifecycle(f.launch.sessionId)).view.status).toBe("waitingForBackground"));
  });

  it("keeps a recovered unattributed permission online but unverified", async () => {
    const f = await fixture(async (_session, request) => request.harness === "copilot" && request.view === "tasks"
      ? { ...tasksResult, payload: { tasks: [] } }
      : { ...queueResult, payload: { items: [], steeringMessages: [], inFlightSteeringCount: 0 } });
    await vi.waitFor(async () => {
      const state = await lifecycleState(f);
      expect(state.tasks.observation.state).toBe("observed");
      expect(state.queue.observation.state).toBe("observed");
    });
    f.session.emit({ kind: "lifecycle", fact: { type: "rootIdle", aborted: false } });
    f.session.emit({ kind: "interaction", nativeRequestId: "recovered-permission", lifecycleOwner: "unattributed",
      requestType: "permission", payload: { kind: "read" }, ephemeral: false, resolve: async () => undefined });
    await vi.waitFor(async () => {
      const state = await lifecycleState(f);
      expect(state.interactions.items).toEqual([expect.objectContaining({ owner: "unattributed", kind: "permission" })]);
      expect((await f.service.readLifecycle(f.launch.sessionId)).view.status).toBe("unknown");
    });
  });

  it.each([
    { label: "send", command: { type: "send", prompt: "blocked send", mode: "enqueue" } },
    { label: "compact", command: { type: "compact" } },
    { label: "steer", command: { type: "steer", prompt: "blocked steer", mode: "immediate" } },
    { label: "queued steer", command: { type: "steerQueuedMessage", id: "blocked-queued-steer" } },
    { label: "settings", command: { type: "setMode", mode: "interactive" } },
  ] as const)("rejects direct $label while interaction hydration is partial", async ({ label, command }) => {
    const f = await fixture(async (_session, request) => request.harness === "copilot" && request.view === "tasks"
      ? { ...tasksResult, payload: { tasks: [] } }
      : { ...queueResult, payload: { items: [], steeringMessages: [], inFlightSteeringCount: 0 } });
    const execute = vi.spyOn(f.session, "execute");
    const result = await f.service.execute({
      commandId: newCommandId(),
      payloadHash: `partial-hydration-${label}`,
      sessionId: f.launch.sessionId,
      runtimeNodeId: f.launch.runtimeNodeId,
      bindingRevision: 1,
      request: { harness: "copilot", command },
    });
    expect(result).toMatchObject({ state: "failed", error: { code: "UNAVAILABLE", certainty: "definiteFailure" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { label: "send", command: { type: "send", prompt: "blocked send", mode: "enqueue" } },
    { label: "compact", command: { type: "compact" } },
    { label: "steer", command: { type: "steer", prompt: "blocked steer", mode: "immediate" } },
    { label: "queued steer", command: { type: "steerQueuedMessage", id: "blocked-queued-steer" } },
    { label: "settings", command: { type: "setMode", mode: "interactive" } },
  ] as const)("rejects direct $label while a root callback is waiting", async ({ label, command }) => {
    const f = await fixture(async (_session, request) => request.harness === "copilot" && request.view === "tasks"
      ? { ...tasksResult, payload: { tasks: [] } }
      : { ...queueResult, payload: { items: [], steeringMessages: [], inFlightSteeringCount: 0 } });
    f.session.emit({ kind: "lifecycle", fact: { type: "interactionsHydrated", items: [], complete: true } });
    f.session.emit({ kind: "lifecycle", fact: { type: "rootStarted", cycleId: "waiting-cycle" } });
    f.session.emit({ kind: "interaction", nativeRequestId: "waiting-input", lifecycleOwner: "root",
      requestType: "userInput", payload: { question: "answer me" }, ephemeral: false, resolve: async () => undefined });
    await vi.waitFor(async () => expect((await f.service.readLifecycle(f.launch.sessionId)).view.actions.send)
      .toEqual({ available: false, reason: "waitingForInput" }));
    const execute = vi.spyOn(f.session, "execute");
    const result = await f.service.execute({
      commandId: newCommandId(),
      payloadHash: `waiting-callback-${label}`,
      sessionId: f.launch.sessionId,
      runtimeNodeId: f.launch.runtimeNodeId,
      bindingRevision: 1,
      request: { harness: "copilot", command },
    });
    expect(result).toMatchObject({ state: "failed", error: { code: "UNAVAILABLE" } });
    expect(execute).not.toHaveBeenCalled();
    const pending = f.service.listInteractions(f.launch.sessionId)[0]!;
    await expect(f.service.resolveInteraction({ interactionId: pending.interactionId,
      sessionId: f.launch.sessionId, harness: "copilot", response: { answer: "recovery remains available" } }))
      .resolves.toMatchObject({ state: "resolved" });
  });

  it("preserves exact task-control and stop escapes while interaction hydration is partial", async () => {
    const f = await fixture(async (_session, request) => request.harness === "copilot" && request.view === "tasks"
      ? { ...tasksResult, payload: { tasks: [] } }
      : { ...queueResult, payload: { items: [], steeringMessages: [], inFlightSteeringCount: 0 } });
    const execute = vi.spyOn(f.session, "execute");
    for (const [label, command] of [
      ["cancel", { type: "cancelTask", id: "exact-task" }],
      ["promote", { type: "promoteTaskToBackground", id: "exact-task" }],
    ] as const) {
      await expect(f.service.execute({ commandId: newCommandId(), payloadHash: `partial-task-${label}`,
        sessionId: f.launch.sessionId, runtimeNodeId: f.launch.runtimeNodeId, bindingRevision: 1,
        request: { harness: "copilot", command } }))
        .resolves.toMatchObject({ state: "succeeded" });
    }
    expect(execute).toHaveBeenCalledTimes(2);
    await expect(f.service.stop({ operation: "stop", commandId: newCommandId(), payloadHash: "stop-partial-task-escape",
      sessionId: f.launch.sessionId, runtimeNodeId: f.launch.runtimeNodeId, bindingRevision: 1 }))
      .resolves.toMatchObject({ state: "succeeded" });
  });

  it.each([
    { label: "send", command: { type: "send", prompt: "blocked send", mode: "enqueue" } },
    { label: "steer", command: { type: "steer", prompt: "blocked steer", mode: "immediate" } },
    { label: "settings", command: { type: "setMode", mode: "interactive" } },
  ] as const)("rejects direct $label after an event gap while preserving stop", async ({ label, command }) => {
    const f = await fixture(async (_session, request) => request.harness === "copilot" && request.view === "tasks"
      ? { ...tasksResult, payload: { tasks: [] } }
      : { ...queueResult, payload: { items: [], steeringMessages: [], inFlightSteeringCount: 0 } });
    f.session.emit({ kind: "lifecycle", fact: { type: "interactionsHydrated", items: [], complete: true } });
    f.session.emit({ kind: "lifecycle", fact: { type: "gap" } });
    await vi.waitFor(async () => expect((await f.service.readLifecycle(f.launch.sessionId)).view.actions.send)
      .toEqual({ available: false, reason: "interactionStateUnknown" }));
    const execute = vi.spyOn(f.session, "execute");
    const result = await f.service.execute({ commandId: newCommandId(), payloadHash: `event-gap-${label}`,
      sessionId: f.launch.sessionId, runtimeNodeId: f.launch.runtimeNodeId, bindingRevision: 1,
      request: { harness: "copilot", command } });
    expect(result).toMatchObject({ state: "failed", error: { code: "UNAVAILABLE" } });
    expect(execute).not.toHaveBeenCalled();
    await expect(f.service.stop({ operation: "stop", commandId: newCommandId(), payloadHash: `stop-after-gap-${label}`,
      sessionId: f.launch.sessionId, runtimeNodeId: f.launch.runtimeNodeId, bindingRevision: 1 }))
      .resolves.toMatchObject({ state: "succeeded" });
  });

  it("retries failed observations with bounded backoff until success without another invalidation", async () => {
    let taskReads = 0;
    const f = await fixture(async (_session, request) => {
      if (request.harness === "copilot" && request.view === "tasks") {
        taskReads += 1;
        if (taskReads <= 2) throw new Error(`transient task read ${taskReads}`);
        return tasksResult;
      }
      return queueResult;
    });

    await vi.waitFor(async () => {
      expect((await lifecycleState(f)).tasks.observation).toEqual({
        state: "observed",
        failures: 0,
        stalled: false,
      });
    }, { timeout: 3_000 });
    expect(taskReads).toBe(3);
    expect(f.traces).toContainEqual(expect.objectContaining({ kind: "observation", view: "tasks", outcome: "failed", failureReason: "nativeReadFailed" }));
    expect(JSON.stringify(f.traces)).not.toContain("transient task read");
  });

  it("treats malformed successful observations as failures and retries them", async () => {
    let taskReads = 0;
    const f = await fixture(async (_session, request) => {
      if (request.harness === "copilot" && request.view === "tasks") {
        taskReads += 1;
        return taskReads === 1
          ? { ...tasksResult, payload: {} }
          : tasksResult;
      }
      return queueResult;
    });

    await vi.waitFor(async () => {
      expect((await lifecycleState(f)).tasks.observation.state).toBe("observed");
    }, { timeout: 2_000 });
    expect(taskReads).toBe(2);
    expect(f.traces).toContainEqual(expect.objectContaining({ kind: "observation", view: "tasks", outcome: "failed", failureReason: "projectionMalformed" }));
  });

  it("allowlists a validation error reason again at the emitted trace boundary", async () => {
    const error = new AdapterNativeStateValidationError("snapshotMalformed");
    Object.assign(error, { reason: "private-reason-sentinel" });
    const f = await fixture(async (_session, request) => {
      if (request.harness === "copilot" && request.view === "tasks") throw error;
      return queueResult;
    });
    await vi.waitFor(() => expect(f.traces).toContainEqual(expect.objectContaining({
      kind: "observation", view: "tasks", outcome: "failed", failureReason: "nativeReadFailed",
    })));
    expect(JSON.stringify(f.traces)).not.toContain("private-reason-sentinel");
  });

  it.each(["nativeReadBusy", "nativeOwnerRetired", "nativeReadUnavailable"] as const)("distinguishes %s from snapshot admission without retaining exception text", async reason => {
    let reads = 0;
    const f = await fixture(async (_session, request) => {
      if (request.harness !== "copilot" || request.view !== "tasks") return queueResult;
      if (++reads === 1) throw new AdapterNativeStateReadError(reason, "private-read-error-sentinel");
      return tasksResult;
    });
    await vi.waitFor(async () => expect((await lifecycleState(f)).tasks.observation.state).toBe("observed"));
    expect(f.traces).toContainEqual(expect.objectContaining({ kind: "observation", view: "tasks", outcome: "failed", failureReason: reason }));
    expect(JSON.stringify(f.traces)).not.toContain("private-read-error-sentinel");
  });

  it("allowlists a typed read reason again at the emitted trace boundary", async () => {
    const error = new AdapterNativeStateReadError("nativeReadBusy", "private-read-error-sentinel");
    Object.assign(error, { reason: "private-read-reason-sentinel" });
    const f = await fixture(async (_session, request) => {
      if (request.harness === "copilot" && request.view === "tasks") throw error;
      return queueResult;
    });
    await vi.waitFor(() => expect(f.traces).toContainEqual(expect.objectContaining({
      kind: "observation", view: "tasks", outcome: "failed", failureReason: "nativeReadFailed",
    })));
    expect(JSON.stringify(f.traces)).not.toContain("private-read-reason-sentinel");
  });

  it.each([
    { view: "tasks", reason: "snapshotTooLarge", payload: { tasks: [], extra: "x".repeat(NATIVE_PAYLOAD_MAX_BYTES) } },
    { view: "tasks", reason: "snapshotWireInvalid", payload: { tasks: [], extra: undefined } },
    { view: "pendingMessages", reason: "snapshotTooLarge", payload: { items: [], steeringMessages: [], extra: "x".repeat(NATIVE_PAYLOAD_MAX_BYTES) } },
  ] as const)("admits the complete $view envelope before writing observed lifecycle evidence ($reason)", async ({ view, reason, payload }) => {
    const f = await fixture(async (_session, request) => request.harness === "copilot" && request.view === view
      ? { harness: "copilot", vendorSessionId: "native-lifecycle-refresh", payload: payload as unknown as JsonValue }
      : request.harness === "copilot" && request.view === "tasks" ? tasksResult : queueResult);
    await vi.waitFor(async () => {
      const state = await lifecycleState(f), observation = view === "tasks" ? state.tasks.observation : state.queue.observation;
      expect(observation.state).toBe("retrying");
      expect(observation.failures).toBeGreaterThan(0);
      expect(f.traces).toContainEqual(expect.objectContaining({ kind: "observation", view, outcome: "failed", failureReason: reason }));
    });
    const observationFact = view === "tasks" ? "tasksObserved" : "queueObserved";
    expect(f.traces.some(trace => trace.kind === "transition" && trace.factType === observationFact)).toBe(false);
  });

  it.each([
    new AdapterNativeStateValidationError("snapshotMalformed"),
    new AdapterNativeStateValidationError("snapshotTooLarge"),
    new AdapterNativeStateValidationError("snapshotWireInvalid"),
    new AdapterNativeStateReadError("snapshotInvalidated", "snapshot invalidated fixture"),
    new AdapterNativeStateReadError("nativeReadTimedOut", "retained lane timed out fixture"),
  ])("contains persistent $reason while children, a peer and exact pending input remain owned", async error => {
    vi.useFakeTimers();
    try {
      let failing = false, queueReads = 0, taskReads = 0;
      const recovery = vi.fn();
      const f = await fixture(async (_session, request) => {
        if (request.harness === "copilot" && request.view === "tasks") {
          taskReads += 1;
          if (failing) throw error;
          return tasksResult;
        }
        queueReads += 1; return queueResult;
      }, recovery);
      await vi.waitFor(async () => expect((await lifecycleState(f)).queue.observation.state).toBe("observed"));
      const peer = new RefreshSession(f.session.cwd, async request => ({
        ...(request.harness === "copilot" && request.view === "tasks" ? tasksResult : queueResult),
        vendorSessionId: "native-peer-refresh",
      }), "native-peer-refresh");
      f.adapter.spawn = async () => peer;
      const peerLaunch = { ...f.launch, launchId: newLaunchId(), sessionId: newSessionId(), payloadHash: "peer-fixture-launch" };
      f.service.createLaunch(peerLaunch);
      await vi.waitFor(() => expect(f.service.getLaunch(peerLaunch.launchId)?.state).toBe("succeeded"));
      const childItems = [{ id: "agent:child-a", state: "running" as const }, { id: "agent:child-b", state: "running" as const }];
      f.session.emit({ kind: "lifecycle", fact: { type: "childrenHydrated", items: childItems, complete: true } });
      f.session.emit({ kind: "lifecycle", fact: { type: "interactionsHydrated", items: [], complete: true } });
      f.session.emit({ kind: "lifecycle", fact: { type: "rootStarted", cycleId: "owner-cycle" } });
      f.session.emit({ kind: "interaction", lifecycleOwner: "root", nativeRequestId: "exact-question",
        requestType: "userInput", payload: { question: "fixture question" }, ephemeral: false, resolve: async () => undefined });
      peer.emit({ kind: "lifecycle", fact: { type: "interactionsHydrated", items: [], complete: true } });
      peer.emit({ kind: "lifecycle", fact: { type: "rootStarted", cycleId: "peer-cycle" } });
      await vi.waitFor(() => expect(f.service.listInteractions(f.launch.sessionId)).toHaveLength(1));
      const pending = f.service.listInteractions(f.launch.sessionId)[0]!;
      const ownerRecord = f.store.getSession(f.launch.sessionId)!;
      const peerRecord = f.store.getSession(peerLaunch.sessionId)!;
      const peerBefore = await f.service.readLifecycle(peerLaunch.sessionId);
      const stop = vi.spyOn(f.session, "stop"), peerStop = vi.spyOn(peer, "stop"), close = vi.spyOn(f.adapter, "close");
      failing = true;
      f.session.emit({ kind: "lifecycle", fact: { type: "tasksInvalidated" } });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(recovery).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled(); expect(peerStop).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
      const state = await lifecycleState(f);
      expect(state.nativeAdmission.state).toBe("degraded");
      expect(state.tasks.observation).toMatchObject({ state: "retrying", stalled: true });
      expect(state.children.items).toEqual(childItems);
      expect(f.service.listInteractions(f.launch.sessionId)).toEqual([pending]);
      expect(state.root).toMatchObject({ phase: "working", cycle: "owner-cycle", outcome: "none" });
      expect(f.store.getSession(f.launch.sessionId)).toMatchObject({ bindingRevision: ownerRecord.bindingRevision, runtimeEpoch: ownerRecord.runtimeEpoch, availability: "active" });
      expect(f.store.getSession(peerLaunch.sessionId)).toMatchObject({ bindingRevision: peerRecord.bindingRevision, runtimeEpoch: peerRecord.runtimeEpoch, availability: "active" });
      expect((await f.service.readLifecycle(peerLaunch.sessionId)).view).toMatchObject({ status: peerBefore.view.status, health: peerBefore.view.health, actions: peerBefore.view.actions });
      // Failed task retries still permit periodic queue observation; retries are bounded.
      expect(queueReads).toBeGreaterThan(2); expect(taskReads).toBeLessThan(30);
      expect(f.traces).toContainEqual(expect.objectContaining({ kind: "observation", view: "tasks", outcome: "failed", failureReason: error.reason }));
      expect(f.traces).toContainEqual(expect.objectContaining({ kind: "observation", view: "tasks", outcome: "stalled", failureReason: error.reason }));
      expect(f.traces.filter(trace => trace.kind === "recovery" && trace.outcome === "manualRecoveryRequired")).toHaveLength(1);
      failing = false;
      await vi.advanceTimersByTimeAsync(30_000);
      const healed = await lifecycleState(f);
      expect(healed.nativeAdmission.state).toBe("open");
      expect(healed.tasks.observation.state).toBe("observed");
      expect(healed.children.items).toEqual(childItems);
      expect(f.service.listInteractions(f.launch.sessionId)).toEqual([pending]);
      expect((await f.service.readLifecycle(f.launch.sessionId)).view.actions.send).toEqual({ available: false, reason: "waitingForInput" });
      await expect(f.service.resolveInteraction({ interactionId: pending.interactionId, sessionId: f.launch.sessionId,
        harness: "copilot", response: { answer: "fixture answer" } })).resolves.toMatchObject({ state: "resolved" });
    } finally { vi.useRealTimers(); }
  });

  it("runs at most one task or queue observation for a binding", async () => {
    let block: Deferred<void> | undefined;
    let activeReads = 0;
    let maximumReads = 0;
    let blockMode = false;
    const f = await fixture(async (_session, request) => {
      if (blockMode) {
        activeReads += 1;
        maximumReads = Math.max(maximumReads, activeReads);
        try {
          if (block) await block.promise;
        } finally {
          activeReads -= 1;
        }
      }
      return request.harness === "copilot" && request.view === "tasks" ? tasksResult : queueResult;
    });
    await vi.waitFor(async () => {
      const state = await lifecycleState(f);
      expect(state.tasks.observation.state).toBe("observed");
      expect(state.queue.observation.state).toBe("observed");
    });

    block = deferred<void>();
    blockMode = true;
    f.session.emit({ kind: "lifecycle", fact: { type: "tasksInvalidated" } });
    f.session.emit({ kind: "lifecycle", fact: { type: "queueInvalidated" } });
    await vi.waitFor(() => expect(activeReads).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(maximumReads).toBe(1);
    block.resolve();
    block = undefined;
    await vi.waitFor(async () => {
      const state = await lifecycleState(f);
      expect(state.tasks.observation.state).toBe("observed");
      expect(state.queue.observation.state).toBe("observed");
    });
    expect(maximumReads).toBe(1);
  });

  it("hydrates both views on activation and follows a refresh-time invalidation once", async () => {
    const reads: NativeStateRequest[] = [];
    let taskReads = 0;
    const f = await fixture(async (session, request) => {
      reads.push(request);
      if (request.harness === "copilot" && request.view === "tasks") {
        taskReads += 1;
        if (taskReads === 1) session.emit({ kind: "lifecycle", fact: { type: "tasksInvalidated" } });
        return tasksResult;
      }
      return queueResult;
    });
    await vi.waitFor(async () => {
      const state = (await lifecycleState(f));
      expect(state.tasks).toMatchObject({ revision: 1, observation: { state: "observed" }, items: [{ id: "task-1" }] });
      expect(state.queue).toMatchObject({ revision: 0, observation: { state: "observed" }, items: [{ id: "queue-1", messageId: "message-1" }] });
    });
    expect(reads.filter(request => request.harness === "copilot" && request.view === "tasks")).toHaveLength(2);
    expect(reads.filter(request => request.harness === "copilot" && request.view === "pendingMessages")).toHaveLength(1);
  });

  it("coalesces invalidation bursts per view and fences the stale revision", async () => {
    let pendingTask: Deferred<AdapterNativeStateResult> | undefined;
    const reads: NativeStateRequest[] = [];
    const f = await fixture(async (_session, request) => {
      reads.push(request);
      if (request.harness === "copilot" && request.view === "tasks") {
        if (pendingTask) return pendingTask.promise;
        return tasksResult;
      }
      return queueResult;
    });
    await vi.waitFor(async () => {
      const state = (await lifecycleState(f));
      expect(state.tasks.observation.state).toBe("observed");
      expect(state.queue.observation.state).toBe("observed");
    });
    const taskReadsBefore = reads.filter(request => request.harness === "copilot" && request.view === "tasks").length;
    const queueReadsBefore = reads.filter(request => request.harness === "copilot" && request.view === "pendingMessages").length;

    pendingTask = deferred<AdapterNativeStateResult>();
    f.session.emit({ kind: "lifecycle", fact: { type: "tasksInvalidated" } });
    await vi.waitFor(() => expect(reads.filter(request => request.harness === "copilot" && request.view === "tasks")).toHaveLength(taskReadsBefore + 1));
    f.session.emit({ kind: "lifecycle", fact: { type: "tasksInvalidated" } });
    f.session.emit({ kind: "lifecycle", fact: { type: "tasksInvalidated" } });
    const first = pendingTask;
    pendingTask = undefined;
    first.resolve(tasksResult);

    await vi.waitFor(async () => {
      const state = (await lifecycleState(f));
      expect(state.tasks).toMatchObject({ revision: 3, observation: { state: "observed" } });
    });
    expect(reads.filter(request => request.harness === "copilot" && request.view === "tasks")).toHaveLength(taskReadsBefore + 2);
    expect(reads.filter(request => request.harness === "copilot" && request.view === "pendingMessages")).toHaveLength(queueReadsBefore);
  });

  it("refreshes both snapshot dimensions after a lifecycle gap", async () => {
    const reads: NativeStateRequest[] = [];
    const f = await fixture(async (_session, request) => {
      reads.push(request);
      return request.harness === "copilot" && request.view === "tasks" ? tasksResult : queueResult;
    });
    await vi.waitFor(async () => {
      const state = (await lifecycleState(f));
      expect(state.tasks.observation.state).toBe("observed");
      expect(state.queue.observation.state).toBe("observed");
    });
    const taskReadsBefore = reads.filter(request => request.harness === "copilot" && request.view === "tasks").length;
    const queueReadsBefore = reads.filter(request => request.harness === "copilot" && request.view === "pendingMessages").length;

    f.session.emit({ kind: "lifecycle", fact: { type: "gap" } });

    await vi.waitFor(async () => {
      const state = (await lifecycleState(f));
      expect(state).toMatchObject({
        continuity: "gap",
        tasks: { revision: 1, observation: { state: "observed" } },
        queue: { revision: 1, observation: { state: "observed" } },
      });
    });
    expect(reads.filter(request => request.harness === "copilot" && request.view === "tasks")).toHaveLength(taskReadsBefore + 1);
    expect(reads.filter(request => request.harness === "copilot" && request.view === "pendingMessages")).toHaveLength(queueReadsBefore + 1);
  });

  it("follows a coalesced invalidation once when it fences a failed read", async () => {
    let pendingTask: Deferred<AdapterNativeStateResult> | undefined;
    const reads: NativeStateRequest[] = [];
    const f = await fixture(async (_session, request) => {
      reads.push(request);
      if (request.harness === "copilot" && request.view === "tasks") {
        if (pendingTask) return pendingTask.promise;
        return tasksResult;
      }
      return queueResult;
    });
    await vi.waitFor(async () => {
      const state = (await lifecycleState(f));
      expect(state.tasks.observation.state).toBe("observed");
      expect(state.queue.observation.state).toBe("observed");
    });
    const taskReadsBefore = reads.filter(request => request.harness === "copilot" && request.view === "tasks").length;

    pendingTask = deferred<AdapterNativeStateResult>();
    f.session.emit({ kind: "lifecycle", fact: { type: "tasksInvalidated" } });
    await vi.waitFor(() => expect(reads.filter(request => request.harness === "copilot" && request.view === "tasks")).toHaveLength(taskReadsBefore + 1));
    f.session.emit({ kind: "lifecycle", fact: { type: "tasksInvalidated" } });
    pendingTask.reject(new Error("native observation failed"));
    pendingTask = undefined;
    await vi.waitFor(async () => {
      const state = (await lifecycleState(f));
      expect(state.tasks).toMatchObject({ revision: 2, observation: { state: "observed" } });
    });
    expect(reads.filter(request => request.harness === "copilot" && request.view === "tasks")).toHaveLength(taskReadsBefore + 2);
    const stale = f.traces.find(trace => trace.kind === "observation" && trace.view === "tasks" && trace.outcome === "staleRevision" && trace.revision === 1);
    expect(stale).toBeDefined();
    expect(stale).not.toHaveProperty("failureReason");
    expect(stale).not.toHaveProperty("validationIssues");
  });

  it("keeps caller-initiated native reads observationally pure", async () => {
    let queue: AdapterNativeStateResult = queueResult;
    const f = await fixture(async (_session, request) => request.harness === "copilot" && request.view === "tasks" ? tasksResult : queue);
    await vi.waitFor(async () => {
      const state = (await lifecycleState(f));
      expect(state.tasks.observation.state).toBe("observed");
      expect(state.queue.observation.state).toBe("observed");
    });
    const before = await f.service.readLifecycle(f.launch.sessionId);
    queue = { ...queueResult, payload: { items: [{ id: "caller-only-queue" }], steeringMessages: ["caller-only"] } };

    await expect(f.service.readNativeState(f.launch.sessionId, { harness: "copilot", view: "pendingMessages" }))
      .resolves.toMatchObject({ harness: "copilot", vendorSessionId: "native-lifecycle-refresh" });

    expect(await f.service.readLifecycle(f.launch.sessionId)).toEqual(before);
  });

  it("removes the active lifecycle projection before the first inactive durable write", async () => {
    const f = await fixture(async (_session, request) => request.harness === "copilot" && request.view === "tasks" ? tasksResult : queueResult);
    await vi.waitFor(async () => expect((await lifecycleState(f)).queue.observation.state).toBe("observed"));
    const writes = vi.spyOn(f.store, "putSession");

    await f.service.stop({
      operation: "stop",
      commandId: newCommandId(),
      payloadHash: "lifecycle-refresh-stop",
      sessionId: f.launch.sessionId,
      runtimeNodeId: f.launch.runtimeNodeId,
      bindingRevision: 1,
    });

    const inactive = writes.mock.calls.map(([record]) => record).filter(record => record.availability === "resumable");
    expect(inactive.length).toBeGreaterThan(0);
    expect(inactive.every(record => record.lifecycle === undefined)).toBe(true);
  });

  it("retires an unresolved read so mutations and stop are never serialized behind it", async () => {
    let blocked: Deferred<AdapterNativeStateResult> | undefined;
    const f = await fixture(async (_session, request) => {
      if (request.harness === "copilot" && request.view === "tasks" && blocked) return blocked.promise;
      return request.harness === "copilot" && request.view === "tasks" ? tasksResult : queueResult;
    });
    await vi.waitFor(async () => expect((await lifecycleState(f)).tasks.observation.state).toBe("observed"));
    f.session.emit({ kind: "lifecycle", fact: { type: "interactionsHydrated", items: [], complete: true } });
    blocked = deferred<AdapterNativeStateResult>();
    f.session.emit({ kind: "lifecycle", fact: { type: "tasksInvalidated" } });
    await vi.waitFor(async () => expect((await lifecycleState(f)).tasks.observation.state).toBe("pending"));

    const command = await f.service.execute({
      commandId: newCommandId(),
      payloadHash: "mutation-during-observation",
      sessionId: f.launch.sessionId,
      runtimeNodeId: f.launch.runtimeNodeId,
      bindingRevision: 1,
      request: { harness: "copilot", command: { type: "setMode", mode: "interactive" } },
    });
    expect(command.state).toBe("succeeded");
    const stop = f.service.stop({
      operation: "stop",
      commandId: newCommandId(),
      payloadHash: "stop-during-observation",
      sessionId: f.launch.sessionId,
      runtimeNodeId: f.launch.runtimeNodeId,
      bindingRevision: 1,
    });
    await expect(Promise.race([
      stop,
      new Promise((_, reject) => setTimeout(() => reject(new Error("stop waited for native observation")), 500)),
    ])).resolves.toMatchObject({ state: "succeeded" });

    blocked.resolve(tasksResult);
    await new Promise(resolve => setTimeout(resolve, 20));
    const stopped = f.store.getSession(f.launch.sessionId);
    expect(stopped).toMatchObject({ availability: "resumable", runtimeStatus: "stopped" });
    expect(stopped?.lifecycle).toBeUndefined();
  });

  it("marks a 45-second occupied observation degraded, freezes mutations, and still permits stop", async () => {
    vi.useFakeTimers();
    try {
      const blocked = deferred<AdapterNativeStateResult>();
      let taskReadStarted = false;
      const f = await fixture(async (_session, request) => {
        if (request.harness === "copilot" && request.view === "tasks") {
          taskReadStarted = true;
          return blocked.promise;
        }
        return queueResult;
      });
      await vi.waitFor(() => expect(taskReadStarted).toBe(true));
      await vi.advanceTimersByTimeAsync(45_000);
      const projection = await f.service.readLifecycle(f.launch.sessionId);
      expect(projection.view.health.state).toBe("degraded");
      expect(projection.view.actions.send).toEqual({ available: false, reason: "nativeObservationDegraded" });
      expect(projection.view.actions.stop).toEqual({ available: true, reason: "available" });

      const command = await f.service.execute({
        commandId: newCommandId(),
        payloadHash: "mutation-after-stall",
        sessionId: f.launch.sessionId,
        runtimeNodeId: f.launch.runtimeNodeId,
        bindingRevision: 1,
        request: { harness: "copilot", command: { type: "setMode", mode: "interactive" } },
      });
      expect(command).toMatchObject({ state: "failed", error: { code: "UNAVAILABLE", certainty: "definiteFailure" } });

      await expect(f.service.stop({
        operation: "stop",
        commandId: newCommandId(),
        payloadHash: "stop-after-stall",
        sessionId: f.launch.sessionId,
        runtimeNodeId: f.launch.runtimeNodeId,
        bindingRevision: 1,
      })).resolves.toMatchObject({ state: "succeeded" });
      blocked.resolve(tasksResult);
      await f.service.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps admission and the public actions degraded when a stale revision owns the stuck SDK lane", async () => {
    vi.useFakeTimers();
    try {
      let blocked: Deferred<AdapterNativeStateResult> | undefined;
      const f = await fixture(async (_session, request) => {
        if (request.harness === "copilot" && request.view === "tasks") return blocked?.promise ?? tasksResult;
        return queueResult;
      });
      await vi.waitFor(async () => {
        const state = await lifecycleState(f);
        expect(state.tasks.observation.state).toBe("observed");
        expect(state.queue.observation.state).toBe("observed");
      });
      f.session.emit({ kind: "lifecycle", fact: { type: "interactionsHydrated", items: [], complete: true } });
      blocked = deferred<AdapterNativeStateResult>();
      f.session.emit({ kind: "lifecycle", fact: { type: "tasksInvalidated" } });
      await vi.waitFor(async () => expect((await lifecycleState(f)).tasks.revision).toBe(1));
      f.session.emit({ kind: "lifecycle", fact: { type: "tasksInvalidated" } });
      await vi.waitFor(async () => expect((await lifecycleState(f)).tasks.revision).toBe(2));
      await vi.advanceTimersByTimeAsync(45_000);
      const stalled = await f.service.readLifecycle(f.launch.sessionId);
      expect(stalled.view.health.state).toBe("degraded");
      expect(stalled.view.actions.send).toEqual({ available: false, reason: "nativeObservationDegraded" });
      expect((await lifecycleState(f)).tasks.observation.state).toBe("pending");
      const command = await f.service.execute({ commandId: newCommandId(), payloadHash: "stale-read-admission",
        sessionId: f.launch.sessionId, runtimeNodeId: f.launch.runtimeNodeId, bindingRevision: 1,
        request: { harness: "copilot", command: { type: "setMode", mode: "interactive" } } });
      expect(command).toMatchObject({ state: "failed", error: { code: "UNAVAILABLE" } });
      const first = blocked;
      blocked = undefined;
      first.resolve(tasksResult);
      await vi.waitFor(async () => expect((await f.service.readLifecycle(f.launch.sessionId)).view.health.state).not.toBe("degraded"));
      expect((await f.service.readLifecycle(f.launch.sessionId)).view.actions.send.available).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("keeps a genuinely occupied observation degraded without restarting its shared owner", async () => {
    vi.useFakeTimers();
    try {
      const blocked = deferred<AdapterNativeStateResult>();
      const recovery = vi.fn();
      const f = await fixture(async (_session, request) =>
        request.harness === "copilot" && request.view === "tasks" ? blocked.promise : queueResult,
      recovery);
      const stop = vi.spyOn(f.session, "stop"), close = vi.spyOn(f.adapter, "close");
      await vi.advanceTimersByTimeAsync(45_000);
      expect((await lifecycleState(f)).nativeAdmission.state).toBe("degraded");
      await vi.advanceTimersByTimeAsync(240_000);
      expect(recovery).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
      expect(f.traces.filter(trace => trace.kind === "recovery" && trace.outcome === "manualRecoveryRequired")).toHaveLength(1);
      expect(f.traces.some(trace => trace.kind === "observation" && trace.outcome === "stalled" && trace.deadlineAgeMs >= 45_000)).toBe(true);
      expect(f.traces.some(trace => trace.kind === "recovery" && (trace.outcome === "scheduled" || trace.outcome === "requested"))).toBe(false);
      blocked.resolve(tasksResult);
    } finally { vi.useRealTimers(); }
  });

  it("keeps the no-success deadline across timed-out native-lane retries and periodic refresh", async () => {
    vi.useFakeTimers();
    try {
      let taskReads = 0;
      let firstTaskReadAt: number | undefined;
      const recovery = vi.fn();
      const f = await fixture(async (_session, request) => {
        if (request.harness !== "copilot" || request.view !== "tasks") return queueResult;
        taskReads += 1;
        if (taskReads === 1) {
          firstTaskReadAt = Date.now();
          return new Promise<AdapterNativeStateResult>((_resolve, reject) => {
            setTimeout(() => reject(new Error("native read timed out; lane remains occupied")), 15_000);
          });
        }
        throw new Error("native read lane is still occupied");
      }, recovery);

      expect(firstTaskReadAt).toBeDefined();
      await vi.advanceTimersByTimeAsync(firstTaskReadAt! + 44_999 - Date.now());
      expect(taskReads).toBeGreaterThan(1);
      expect((await lifecycleState(f)).nativeAdmission.state).toBe("open");
      await vi.advanceTimersByTimeAsync(1);
      expect((await lifecycleState(f)).nativeAdmission.state).toBe("degraded");

      // The minute refresh cannot reset the no-success deadline or replace
      // the shared owner merely because this read lane remains occupied.
      await vi.advanceTimersByTimeAsync(119_999);
      expect(recovery).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(recovery).not.toHaveBeenCalled();

      await expect(f.service.stop({ operation: "stop", commandId: newCommandId(), payloadHash: "stop-occupied-read-lane",
        sessionId: f.launch.sessionId, runtimeNodeId: f.launch.runtimeNodeId, bindingRevision: 1 }))
        .resolves.toMatchObject({ state: "succeeded" });
    } finally { vi.useRealTimers(); }
  });

  it("heals degraded admission from fresh observations and retires late reads on explicit stop", async () => {
    vi.useFakeTimers();
    try {
      let blocked: Deferred<AdapterNativeStateResult> | undefined;
      const recovery = vi.fn();
      const f = await fixture(async (_session, request) =>
        request.harness === "copilot" && request.view === "tasks" ? blocked?.promise ?? tasksResult : queueResult,
      recovery);
      await vi.waitFor(async () => expect((await lifecycleState(f)).tasks.observation.state).toBe("observed"));
      blocked = deferred<AdapterNativeStateResult>();
      f.session.emit({ kind: "lifecycle", fact: { type: "tasksInvalidated" } });
      await vi.advanceTimersByTimeAsync(45_000);
      expect((await lifecycleState(f)).nativeAdmission.state).toBe("degraded");
      blocked.resolve(tasksResult);
      blocked = undefined;
      await vi.waitFor(async () => expect((await lifecycleState(f)).nativeAdmission.state).toBe("open"));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(recovery).not.toHaveBeenCalled();
      expect(f.traces.some(trace => trace.kind === "recovery" && trace.outcome === "recovered")).toBe(true);
      expect(f.traces.some(trace => trace.kind === "recovery" && trace.outcome === "requested")).toBe(false);

      blocked = deferred<AdapterNativeStateResult>();
      f.session.emit({ kind: "lifecycle", fact: { type: "tasksInvalidated" } });
      await vi.advanceTimersByTimeAsync(45_000);
      await f.service.stop({ operation: "stop", commandId: newCommandId(), payloadHash: "cancel-recovery-on-stop",
        sessionId: f.launch.sessionId, runtimeNodeId: f.launch.runtimeNodeId, bindingRevision: 1 });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(recovery).not.toHaveBeenCalled();
      blocked.resolve(tasksResult);
    } finally { vi.useRealTimers(); }
  });

  it("refreshes both native views every minute without a UI poller", async () => {
    vi.useFakeTimers();
    try {
      const reads: NativeStateRequest[] = [];
      const f = await fixture(async (_session, request) => {
        reads.push(request);
        return request.harness === "copilot" && request.view === "tasks" ? tasksResult : queueResult;
      });
      await vi.waitFor(async () => expect((await lifecycleState(f)).queue.observation.state).toBe("observed"));
      const initial = reads.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reads.length).toBe(initial + 2);
    } finally { vi.useRealTimers(); }
  });

  it("allows supervisor retry after a Copilot disconnect timeout only when backend closure succeeds", async () => {
    const f = await fixture(async (_session, request) => request.harness === "copilot" && request.view === "tasks" ? tasksResult : queueResult);
    vi.spyOn(f.session, "stop").mockRejectedValue(new AdapterOutcomeUnknownError("native disconnect was not acknowledged"));
    const adapterClose = vi.spyOn(f.adapter, "close");
    await expect(f.service.close()).resolves.toBeUndefined();
    expect(adapterClose).toHaveBeenCalledOnce();
  });

  it("fails closed when the Copilot owner could not be terminated", async () => {
    const f = await fixture(async (_session, request) => request.harness === "copilot" && request.view === "tasks" ? tasksResult : queueResult, undefined, true);
    vi.spyOn(f.session, "stop").mockRejectedValue(new AdapterOutcomeUnknownError("native disconnect was not acknowledged"));
    vi.spyOn(f.adapter, "close").mockRejectedValue(new Error("native termination unproved"));
    await expect(f.service.close()).rejects.toThrow("runtime node cleanup failed");
  });

  it("closes with an unresolved SDK observation and ignores its late reply", async () => {
    let blocked: Deferred<AdapterNativeStateResult> | undefined;
    const f = await fixture(async (_session, request) => {
      if (request.harness === "copilot" && request.view === "tasks" && blocked) return blocked.promise;
      return request.harness === "copilot" && request.view === "tasks" ? tasksResult : queueResult;
    });
    await vi.waitFor(async () => expect((await lifecycleState(f)).tasks.observation.state).toBe("observed"));
    blocked = deferred<AdapterNativeStateResult>();
    f.session.emit({ kind: "lifecycle", fact: { type: "tasksInvalidated" } });
    await vi.waitFor(async () => expect((await lifecycleState(f)).tasks.observation.state).toBe("pending"));
    const beforeClose = f.store.getSession(f.launch.sessionId)?.lifecycle;
    await expect(Promise.race([
      f.service.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close waited for native observation")), 500)),
    ])).resolves.toBeUndefined();
    blocked.resolve(tasksResult);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.store.getSession(f.launch.sessionId)?.lifecycle).toEqual(beforeClose);
  });
});

describe("runtime lifecycle identity projection", () => {
  it("keeps agent and tool-call interaction owner domains distinct", async () => {
    const f = await fixture(async (_session, request) => request.harness === "copilot" && request.view === "tasks" ? tasksResult : queueResult);
    const interaction = {
      kind: "interaction" as const,
      requestType: "userInput" as const,
      ephemeral: false,
      resolve: async () => {},
    };
    f.session.emit({ ...interaction, nativeRequestId: "agent-request", payload: { agentId: "same-native-id" } });
    f.session.emit({ ...interaction, nativeRequestId: "tool-request", payload: { parentToolCallId: "same-native-id" } });

    await vi.waitFor(async () => {
      const owners = (await lifecycleState(f)).interactions.items.map(item => item.owner).sort();
      expect(owners).toEqual(["agent:same-native-id", "tool:same-native-id"]);
    });
  });
});
