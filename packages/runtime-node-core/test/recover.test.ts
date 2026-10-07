import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adapterScopeIdSchema, newCommandId, newLaunchId, newRuntimeEpoch,
  newRuntimeNodeBootId, newRuntimeNodeId, newSessionId,
  type HarnessCommand, type JsonValue, type NativeHistoryRequest, type NativeStateRequest,
  type RecoverCommand, type SessionRuntimeStatus,
  packNativePayload,
} from "@arduano/agent-multiplex-protocol";
import {
  AdapterOutcomeUnknownError, CopilotAttachmentDriver, createRuntimeNodeRouter, DirectWorkspaceLaunchProvider, runtimeBackendForAdapter, RuntimeNodeService, RuntimeNodeStore,
  type AdapterEvent, type AdapterSession, type AgentAdapter, type NativeImageCodec,
} from "../src/index.js";

class RecoverySession implements AdapterSession {
  readonly harness = "copilot" as const;
  readonly adapterScopeId = adapterScopeIdSchema.parse("recover-fixture");
  readonly vendorSessionId = "native-recover-fixture";
  readonly runtimeEpoch = newRuntimeEpoch();
  readonly copilotObservationDriver = new CopilotAttachmentDriver();
  readonly listeners = new Set<(event: AdapterEvent) => void>();
  nativeStatus: SessionRuntimeStatus = "idle";
  stop = vi.fn(async () => { this.nativeStatus = "stopped"; });
  constructor(readonly cwd: string) {}
  status() { return this.nativeStatus; }
  subscribe(listener: (event: AdapterEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: AdapterEvent) { for (const listener of [...this.listeners]) listener(event); }
  async execute(_request: HarnessCommand): Promise<JsonValue> { throw new Error("Recovery must never send a prompt"); }
  async readNativeHistory(_request: NativeHistoryRequest) { throw new Error("Recovery must not infer state from history"); }
  async readNativeState(request: NativeStateRequest) {
    const view = request.view === "agents" ? "agents" : request.view === "pendingMessages" ? "pendingMessages" : "tasks";
    const ticket = this.copilotObservationDriver.capture(view);
    return this.copilotObservationDriver.certify(ticket, { harness: this.harness, vendorSessionId: this.vendorSessionId,
      payload: request.view === "tasks" ? { tasks: [] } : request.view === "pendingMessages"
        ? { items: [], steeringMessages: [], inFlightSteeringCount: 0 } : { agents: [] } });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const cleanups: Array<() => Promise<void>> = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const close of cleanups.splice(0)) await close();
});

async function fixture(options: { externalize?: NativeImageCodec["externalize"] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "multiplex-recover-"));
  const store = new RuntimeNodeStore(":memory:");
  const runtimeNodeId = newRuntimeNodeId();
  const first = new RecoverySession(cwd), handles = [first];
  const adapter: AgentAdapter = {
    harness: "copilot", adapterScopeId: first.adapterScopeId,
    ...(options.externalize ? { imageCodec: { externalize: options.externalize } } : {}),
    describe: async () => ({ harness: "copilot", adapterScopeId: first.adapterScopeId, available: true, capabilities: [] }),
    listModels: async () => [], listSessions: async () => [], spawn: vi.fn(async () => first),
    resume: vi.fn(async () => { const next = new RecoverySession(cwd); handles.push(next); return next; }),
    close: async () => undefined,
  };
  const backend = runtimeBackendForAdapter(adapter), provider = new DirectWorkspaceLaunchProvider({ backends: [backend] });
  const service = new RuntimeNodeService({ store, backends: [backend], launchProviders: [provider], includeDirectWorkspaceProvider: false, runtimeNodeId,
    runtimeNodeBootId: newRuntimeNodeBootId(), name: "Recover fixture", allowedRoots: [cwd] });
  cleanups.push(async () => { await service.close(); store.close(); rmSync(cwd, { recursive: true, force: true }); });
  const profile = service.launchProfiles()[0]!;
  const launch = { launchId: newLaunchId(), sessionId: newSessionId(), runtimeNodeId, payloadHash: "recover-fixture-launch",
    profile: { providerId: profile.providerId, profileId: profile.profileId, contractVersion: profile.contractVersion, requestSchemaHash: profile.requestSchemaHash },
    harness: "copilot" as const, input: { cwd } };
  service.createLaunch(launch);
  await vi.waitFor(() => expect(service.getLaunch(launch.launchId)?.state).toBe("succeeded"));
  const request: RecoverCommand = { operation: "recover", commandId: newCommandId(), payloadHash: "recover-fixture-operation",
    sessionId: launch.sessionId, runtimeNodeId, bindingRevision: 1, expectedRuntimeEpoch: first.runtimeEpoch };
  // The fixture represents an idle handle with incomplete native interaction
  // hydration. Recovery must preserve that uncertainty on the new handle.
  await vi.waitFor(async () => expect((await service.readLifecycle(launch.sessionId)).view.actions.send.reason).toBe("interactionStateUnknown"));
  await vi.waitFor(() => expect(store.getLifecycle(launch.sessionId)).toMatchObject({ tasks: { observation: { state: "observed" } }, queue: { observation: { state: "observed" } } }));
  return { cwd, store, service, adapter, provider, first, handles, launch, request };
}

describe("Host-owned durable native recovery", () => {
  it("owns both phases under one original ID and preserves genuine uncertainty", async () => {
    const f = await fixture();
    const stopping = deferred<void>(); releases.push(() => stopping.resolve());
    f.first.stop.mockImplementationOnce(() => stopping.promise);
    const pending = f.service.recover(f.request);
    await vi.waitFor(() => expect(f.first.stop).toHaveBeenCalledOnce());
    expect(f.service.getCommand(f.request.commandId)).toMatchObject({ state: "started", request: f.request, result: { json: { operation: "recover", phase: "stopping" } } });
    expect(await f.service.recover(f.request)).toMatchObject({ state: "started", result: { json: { phase: "stopping" } } });
    expect(f.adapter.resume).not.toHaveBeenCalled();
    stopping.resolve();
    const receipt = await pending;
    expect(receipt).toMatchObject({ state: "succeeded", result: { json: { operation: "recover", phase: "complete", vendorSessionId: f.first.vendorSessionId } } });
    expect(f.adapter.resume).toHaveBeenCalledOnce();
    expect(f.handles[1]!.runtimeEpoch).not.toBe(f.first.runtimeEpoch);
    expect((await f.service.readLifecycle(f.launch.sessionId)).view.actions.send).toEqual({ available: false, reason: "interactionStateUnknown" });
    expect(await f.service.recover(f.request)).toEqual(receipt);
    expect(f.first.stop).toHaveBeenCalledOnce();
    expect(f.adapter.resume).toHaveBeenCalledOnce();
  });

  it.each([false, true])("retains a failed Stop phase and never dispatches Resume (unknown=%s)", async unknown => {
    const f = await fixture();
    f.first.stop.mockRejectedValueOnce(unknown ? new AdapterOutcomeUnknownError("native disconnect is unproved") : new Error("native disconnect refused"));
    const receipt = await f.service.recover(f.request);
    expect(receipt).toMatchObject({ state: unknown ? "outcomeUnknown" : "failed", result: { json: { phase: "stopping" } } });
    expect(await f.service.recover(f.request)).toEqual(receipt);
    expect(f.adapter.resume).not.toHaveBeenCalled();
    expect(f.first.stop).toHaveBeenCalledOnce();
  });

  it.each([false, true])("retains a failed Resume phase without replay (unknown=%s)", async unknown => {
    const f = await fixture();
    vi.mocked(f.adapter.resume).mockRejectedValueOnce(unknown ? new AdapterOutcomeUnknownError("native attachment is unproved") : new Error("native attach refused"));
    const receipt = await f.service.recover(f.request);
    expect(receipt).toMatchObject({ state: unknown ? "outcomeUnknown" : "failed", result: { json: { phase: "resuming" } } });
    expect(f.store.getSession(f.launch.sessionId)).toMatchObject({ availability: "resumable", runtimeStatus: "stopped", runtimeEpoch: null });
    expect(await f.service.recover(f.request)).toEqual(receipt);
    expect(f.adapter.resume).toHaveBeenCalledOnce();
  });

  it("refuses changed epochs and newly working native owners before Stop", async () => {
    const f = await fixture();
    expect(await f.service.recover({ ...f.request, expectedRuntimeEpoch: newRuntimeEpoch() })).toMatchObject({ state: "failed", error: { code: "FENCED" } });
    f.first.nativeStatus = "running";
    expect(await f.service.recover({ ...f.request, commandId: newCommandId(), payloadHash: "working-recovery" })).toMatchObject({ state: "failed", error: { code: "CONFLICT" } });
    expect(f.first.stop).not.toHaveBeenCalled();
    expect(f.adapter.resume).not.toHaveBeenCalled();
  });

  it.each(["waiting", "background", "healthy"] as const)("refuses a newly %s attachment while its native handle is idle", async state => {
    const f = await fixture();
    f.first.emit({ kind: "lifecycle", fact: { type: "interactionsHydrated", complete: true,
      items: state === "waiting" ? [{ id: "native-question", owner: "root", kind: "userInput" }] : [] } });
    if (state === "healthy") {
      f.first.emit({ kind: "lifecycle", fact: { type: "childrenHydrated", items: [], complete: true } });
      f.first.emit({ kind: "lifecycle", fact: { type: "sessionActivityObserved", active: false } });
      await vi.waitFor(async () => expect((await f.service.readLifecycle(f.launch.sessionId)).view.health.state).toBe("healthy"));
    } else if (state === "background") {
      const revision = f.store.getLifecycle(f.launch.sessionId)!.tasks.revision;
      f.first.emit({ kind: "lifecycle", fact: { type: "tasksObserved", revision, items: [{ id: "running-native-task", kind: "agent", status: "running" }] } });
      await vi.waitFor(async () => expect((await f.service.readLifecycle(f.launch.sessionId)).view.status).toBe("waitingForBackground"));
    } else {
      await vi.waitFor(async () => expect((await f.service.readLifecycle(f.launch.sessionId)).view.status).toBe("waitingForInput"));
    }
    expect(await f.service.recover(f.request)).toMatchObject({ state: "failed", error: { code: "CONFLICT" } });
    expect(f.first.stop).not.toHaveBeenCalled();
    expect(f.adapter.resume).not.toHaveBeenCalled();
  });

  it("drains already admitted native work before deciding whether recovery may Stop", async () => {
    const extraction = deferred<void>(), entered = vi.fn();
    releases.push(() => extraction.resolve());
    const f = await fixture({ externalize: async payload => { entered(); await extraction.promise; return packNativePayload(payload); } });
    f.first.emit({ kind: "native", nativeType: "assistant.message", payload: { content: "queued envelope" }, ephemeral: false });
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    f.first.emit({ kind: "lifecycle", fact: { type: "rootStarted", cycleId: "new-native-turn" } });
    const recovering = f.service.recover(f.request);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.first.stop).not.toHaveBeenCalled();
    extraction.resolve();
    expect(await recovering).toMatchObject({ state: "failed", error: { code: "CONFLICT" } });
    expect(f.first.stop).not.toHaveBeenCalled();
    expect(f.adapter.resume).not.toHaveBeenCalled();
  });

  it("checks the transport boot fence before admitting a recovery or explicit inspection", async () => {
    const f = await fixture(), caller = createRuntimeNodeRouter(f.service).createCaller({});
    const runtimeNodeBootId = newRuntimeNodeBootId();
    await expect(caller.sessions.recover({ runtimeNodeBootId, command: f.request })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.sessions.inspectNativeHistory({ runtimeNodeBootId, sessionId: f.launch.sessionId,
      request: { harness: "copilot", includeTurns: true, limit: 10 } })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(f.service.getCommand(f.request.commandId)).toBeNull();
    expect(f.first.stop).not.toHaveBeenCalled();
    expect(f.adapter.resume).not.toHaveBeenCalled();
  });

  it("fences native Resume if shutdown begins during provider preparation", async () => {
    const f = await fixture(), preparation = deferred<void>();
    releases.push(() => preparation.resolve());
    const original = f.provider.prepareResume.bind(f.provider);
    const prepare = vi.spyOn(f.provider, "prepareResume").mockImplementationOnce(async context => {
      await preparation.promise; return original(context);
    });
    const recovering = f.service.recover(f.request);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    const closing = f.service.close(); preparation.resolve();
    expect(await recovering).toMatchObject({ state: "failed", error: { code: "FENCED" }, result: { json: { phase: "resuming" } } });
    await closing;
    expect(f.first.stop).toHaveBeenCalledOnce();
    expect(f.adapter.resume).not.toHaveBeenCalled();
  });

  it("does not erase a later admitted Stop while native Resume is pending", async () => {
    const f = await fixture();
    const resuming = deferred<RecoverySession>(), replacement = new RecoverySession(f.cwd);
    releases.push(() => resuming.resolve(replacement));
    vi.mocked(f.adapter.resume).mockImplementationOnce(() => resuming.promise);
    const pending = f.service.recover(f.request);
    await vi.waitFor(() => expect(f.adapter.resume).toHaveBeenCalledOnce());
    const stop = { operation: "stop" as const, commandId: newCommandId(), payloadHash: "later-stop", sessionId: f.launch.sessionId,
      runtimeNodeId: f.launch.runtimeNodeId, bindingRevision: 1 };
    const stopped = f.service.stop(stop);
    expect(f.store.startupCopilotStopCommandId(f.store.getSession(f.launch.sessionId)!)).toBe(stop.commandId);
    resuming.resolve(replacement);
    expect(await pending).toMatchObject({ state: "succeeded" });
    expect(await stopped).toMatchObject({ state: "succeeded" });
    expect(replacement.stop).toHaveBeenCalledOnce();
    expect(f.store.startupCopilotStopCommandId(f.store.getSession(f.launch.sessionId)!)).toBe(stop.commandId);
    expect(f.store.getSession(f.launch.sessionId)).toMatchObject({ availability: "resumable", runtimeStatus: "stopped" });
  });

  it("retains its last persisted phase across process replacement without redispatch", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "multiplex-recover-restart-")), path = join(cwd, "runtime.sqlite");
    const store = new RuntimeNodeStore(path), runtimeNodeId = newRuntimeNodeId();
    const request: RecoverCommand = { operation: "recover", commandId: newCommandId(), payloadHash: "interrupted-recover",
      sessionId: newSessionId(), runtimeNodeId, bindingRevision: 1, expectedRuntimeEpoch: newRuntimeEpoch() };
    const timestamp = new Date().toISOString();
    store.putCommand({ commandId: request.commandId, payloadHash: request.payloadHash, sessionId: request.sessionId, runtimeNodeId,
      request, state: "started", createdAt: timestamp, updatedAt: timestamp,
      result: { encoding: "native-json-images-v1", images: [], json: { operation: "recover", phase: "resuming" } } });
    store.close();
    const reopened = new RuntimeNodeStore(path);
    const service = new RuntimeNodeService({ store: reopened, adapters: [], runtimeNodeId, runtimeNodeBootId: newRuntimeNodeBootId(), name: "Replaced recover fixture", allowedRoots: [cwd] });
    try {
      const receipt = await service.recover(request);
      expect(receipt).toMatchObject({ request, state: "outcomeUnknown", result: { json: { phase: "resuming" } }, error: { stage: "recovery", certainty: "outcomeUnknown" } });
      expect(await service.recover(request)).toEqual(receipt);
      expect(reopened.listSessions()).toEqual([]);
    } finally { await service.close(); reopened.close(); rmSync(cwd, { recursive: true, force: true }); }
  });
});
