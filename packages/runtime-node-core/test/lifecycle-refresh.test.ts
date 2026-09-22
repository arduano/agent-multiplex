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

async function fixture(read: (session: RefreshSession, request: NativeStateRequest) => Promise<AdapterNativeStateResult>) {
  const cwd = mkdtempSync(join(tmpdir(), "multiplex-lifecycle-refresh-"));
  const store = new RuntimeNodeStore(":memory:");
  const runtimeNodeId = newRuntimeNodeId();
  let session!: RefreshSession;
  session = new RefreshSession(cwd, request => read(session, request));
  const service = new RuntimeNodeService({
    store,
    runtimeNodeId,
    runtimeNodeBootId: newRuntimeNodeBootId(),
    name: "lifecycle refresh test",
    allowedRoots: [cwd],
    adapters: [new RefreshAdapter(session)],
  });
  cleanup.push(async () => {
    await service.close();
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
  return { service, store, session, launch };
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
      const state = (await f.service.readLifecycle(f.launch.sessionId)).state;
      expect(state.tasks).toMatchObject({ revision: 1, freshness: "observed", items: [{ id: "task-1" }] });
      expect(state.queue).toMatchObject({ revision: 0, freshness: "observed", items: [{ id: "queue-1", messageId: "message-1" }] });
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
      const state = (await f.service.readLifecycle(f.launch.sessionId)).state;
      expect(state.tasks.freshness).toBe("observed");
      expect(state.queue.freshness).toBe("observed");
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
      const state = (await f.service.readLifecycle(f.launch.sessionId)).state;
      expect(state.tasks).toMatchObject({ revision: 3, freshness: "observed" });
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
      const state = (await f.service.readLifecycle(f.launch.sessionId)).state;
      expect(state.tasks.freshness).toBe("observed");
      expect(state.queue.freshness).toBe("observed");
    });
    const taskReadsBefore = reads.filter(request => request.harness === "copilot" && request.view === "tasks").length;
    const queueReadsBefore = reads.filter(request => request.harness === "copilot" && request.view === "pendingMessages").length;

    f.session.emit({ kind: "lifecycle", fact: { type: "gap" } });

    await vi.waitFor(async () => {
      const state = (await f.service.readLifecycle(f.launch.sessionId)).state;
      expect(state).toMatchObject({
        continuity: "gap",
        tasks: { revision: 1, freshness: "observed" },
        queue: { revision: 1, freshness: "observed" },
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
      const state = (await f.service.readLifecycle(f.launch.sessionId)).state;
      expect(state.tasks.freshness).toBe("observed");
      expect(state.queue.freshness).toBe("observed");
    });
    const taskReadsBefore = reads.filter(request => request.harness === "copilot" && request.view === "tasks").length;

    pendingTask = deferred<AdapterNativeStateResult>();
    f.session.emit({ kind: "lifecycle", fact: { type: "tasksInvalidated" } });
    await vi.waitFor(() => expect(reads.filter(request => request.harness === "copilot" && request.view === "tasks")).toHaveLength(taskReadsBefore + 1));
    f.session.emit({ kind: "lifecycle", fact: { type: "tasksInvalidated" } });
    pendingTask.reject(new Error("native observation failed"));
    pendingTask = undefined;
    await vi.waitFor(async () => {
      const state = (await f.service.readLifecycle(f.launch.sessionId)).state;
      expect(state.tasks).toMatchObject({ revision: 2, freshness: "observed" });
    });
    expect(reads.filter(request => request.harness === "copilot" && request.view === "tasks")).toHaveLength(taskReadsBefore + 2);
  });

  it("keeps caller-initiated native reads observationally pure", async () => {
    let queue: AdapterNativeStateResult = queueResult;
    const f = await fixture(async (_session, request) => request.harness === "copilot" && request.view === "tasks" ? tasksResult : queue);
    await vi.waitFor(async () => {
      const state = (await f.service.readLifecycle(f.launch.sessionId)).state;
      expect(state.tasks.freshness).toBe("observed");
      expect(state.queue.freshness).toBe("observed");
    });
    const before = await f.service.readLifecycle(f.launch.sessionId);
    queue = { ...queueResult, payload: { items: [{ id: "caller-only-queue" }], steeringMessages: ["caller-only"] } };

    await expect(f.service.readNativeState(f.launch.sessionId, { harness: "copilot", view: "pendingMessages" }))
      .resolves.toMatchObject({ harness: "copilot", vendorSessionId: "native-lifecycle-refresh" });

    expect(await f.service.readLifecycle(f.launch.sessionId)).toEqual(before);
  });

  it("removes the active lifecycle projection before the first inactive durable write", async () => {
    const f = await fixture(async (_session, request) => request.harness === "copilot" && request.view === "tasks" ? tasksResult : queueResult);
    await vi.waitFor(async () => expect((await f.service.readLifecycle(f.launch.sessionId)).state.queue.freshness).toBe("observed"));
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
      const owners = (await f.service.readLifecycle(f.launch.sessionId)).state.interactions.items.map(item => item.owner).sort();
      expect(owners).toEqual(["agent:same-native-id", "tool:same-native-id"]);
    });
  });
});
