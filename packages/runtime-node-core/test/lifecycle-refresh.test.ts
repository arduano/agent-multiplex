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
  type AdapterEvent,
  type AdapterNativeStateResult,
  type AdapterSession,
  type AgentAdapter,
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
  public readonly vendorSessionId = "native-lifecycle-refresh";
  public readonly runtimeEpoch = newRuntimeEpoch();
  readonly #listeners = new Set<(event: AdapterEvent) => void>();
  #stopped = false;

  public constructor(
    public readonly cwd: string,
    public read: NativeRead,
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
  const service = new RuntimeNodeService({
    store,
    runtimeNodeId,
    runtimeNodeBootId: newRuntimeNodeBootId(),
    name: "lifecycle refresh test",
    allowedRoots: [cwd],
    adapters: [adapter],
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
  return { service, store, session, adapter, launch };
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

  it("requests runtime-only recovery after persistent degraded observation, once per binding", async () => {
    vi.useFakeTimers();
    try {
      const blocked = deferred<AdapterNativeStateResult>();
      const recovery = vi.fn();
      const f = await fixture(async (_session, request) =>
        request.harness === "copilot" && request.view === "tasks" ? blocked.promise : queueResult,
      recovery);
      await vi.advanceTimersByTimeAsync(45_000);
      expect((await lifecycleState(f)).nativeAdmission.state).toBe("degraded");
      await vi.advanceTimersByTimeAsync(110_000);
      expect(recovery).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(recovery).toHaveBeenCalledExactlyOnceWith(f.launch.sessionId);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(recovery).toHaveBeenCalledTimes(1);
      blocked.resolve(tasksResult);
    } finally { vi.useRealTimers(); }
  });

  it("cancels the recovery deadline when fresh observations heal or the binding stops", async () => {
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
