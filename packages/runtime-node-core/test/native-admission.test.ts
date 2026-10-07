import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adapterScopeIdSchema, emptyMetadataSnapshot, newCommandId, newLaunchId,
  newRuntimeEpoch, newRuntimeNodeBootId, newRuntimeNodeId, newSessionId,
  type HarnessCommand, type JsonValue, type NativeHistoryRequest, type NativeStateRequest,
  type RuntimeNodeSessionRecord,
} from "@arduano/agent-multiplex-protocol";
import {
  CopilotAttachmentDriver, DirectWorkspaceLaunchProvider, runtimeBackendForAdapter, RuntimeNodeService, RuntimeNodeStore,
  type AdapterEvent, type AdapterSession, type AgentAdapter,
} from "../src/index.js";

class AdmissionSession implements AdapterSession {
  readonly harness = "copilot" as const;
  readonly adapterScopeId = adapterScopeIdSchema.parse("native-admission-fixture");
  readonly runtimeEpoch = newRuntimeEpoch();
  readonly copilotObservationDriver?: CopilotAttachmentDriver;
  stopped = false;
  stop = vi.fn(async () => { this.stopped = true; });
  subscribe = vi.fn((_listener: (event: AdapterEvent) => void) => () => {});
  constructor(readonly cwd: string, readonly vendorSessionId = "native-admission",
    driver: CopilotAttachmentDriver | null = new CopilotAttachmentDriver()) {
    if (driver) this.copilotObservationDriver = driver;
  }
  status() { return this.stopped ? "stopped" as const : "idle" as const; }
  async execute(_request: HarnessCommand): Promise<JsonValue> { throw new Error("No model calls allowed"); }
  async readNativeHistory(_request: NativeHistoryRequest) {
    return { harness: this.harness, vendorSessionId: this.vendorSessionId, payload: [], complete: true };
  }
  async readNativeState(request: NativeStateRequest) {
    const view = request.view === "tasks" ? "tasks" : "pendingMessages";
    const driver = this.copilotObservationDriver!;
    return driver.certify(driver.capture(view), { harness: this.harness, vendorSessionId: this.vendorSessionId,
      payload: view === "tasks" ? { tasks: [] } : { items: [], steeringMessages: [], inFlightSteeringCount: 0 } });
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function fixture(options: { startup?: boolean; seed?: boolean; cwd?: string; handle?: AdmissionSession } = {}) {
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "multiplex-native-admission-"));
  const store = new RuntimeNodeStore(":memory:");
  const runtimeNodeId = newRuntimeNodeId(), sessionId = newSessionId();
  const handle = options.handle ?? new AdmissionSession(cwd);
  const adapter: AgentAdapter = {
    harness: "copilot", adapterScopeId: handle.adapterScopeId,
    describe: async () => ({ harness: "copilot", adapterScopeId: handle.adapterScopeId, available: true, capabilities: [] }),
    listModels: async () => [], listSessions: async () => [],
    spawn: vi.fn(async () => handle), resume: vi.fn(async () => handle), close: async () => {},
  };
  const timestamp = new Date().toISOString();
  const original: RuntimeNodeSessionRecord = {
    sessionId, runtimeNodeId, harness: "copilot", adapterScopeId: handle.adapterScopeId,
    vendorSessionId: handle.vendorSessionId, bindingRevision: 1,
    runtimeEpoch: options.startup ? newRuntimeEpoch() : null, cwd,
    availability: options.startup ? "active" : "resumable", runtimeStatus: options.startup ? "idle" : "stopped",
    launchProvenance: null, metadata: emptyMetadataSnapshot(), createdAt: timestamp, updatedAt: timestamp,
    lastSeenAt: timestamp, lastActivityAt: timestamp,
  };
  if (options.seed !== false) store.putSession(original);
  const backend = runtimeBackendForAdapter(adapter), provider = new DirectWorkspaceLaunchProvider({ backends: [backend] });
  const compensate = vi.spyOn(provider, "compensate");
  const service = new RuntimeNodeService({ store, backends: [backend], launchProviders: [provider],
    includeDirectWorkspaceProvider: false, runtimeNodeId,
    runtimeNodeBootId: newRuntimeNodeBootId(), name: "Native admission fixture", allowedRoots: [cwd] });
  cleanups.push(async () => { await service.close(); store.close(); if (!options.cwd) rmSync(cwd, { recursive: true, force: true }); });
  const command = { commandId: newCommandId(), payloadHash: "native-admission-resume", sessionId, runtimeNodeId, bindingRevision: 1 };
  const resume = () => service.resume({ ...command, operation: "resume" });
  const inspect = () => service.inspectNativeHistory(sessionId, { harness: "copilot", includeTurns: true, limit: 10 });
  const launch = async () => {
    const profile = service.launchProfiles()[0]!;
    const request = { launchId: newLaunchId(), sessionId, runtimeNodeId, payloadHash: "native-admission-launch",
      profile: { providerId: profile.providerId, profileId: profile.profileId, contractVersion: profile.contractVersion,
        requestSchemaHash: profile.requestSchemaHash }, harness: "copilot" as const, input: { cwd } };
    service.createLaunch(request);
    await vi.waitFor(() => expect(["succeeded", "failed", "outcomeUnknown"]).toContain(service.getLaunch(request.launchId)?.state));
    return service.getLaunch(request.launchId)!;
  };
  return { cwd, store, runtimeNodeId, sessionId, handle, adapter, original, service, command, resume, inspect, launch, compensate };
}

type Operation = "startup" | "resume" | "recover" | "inspect" | "spawn";
async function refusalFixture(operation: Operation, kind: "missing" | "retired", stopFails = false) {
  const f = fixture({ startup: operation === "startup", seed: operation !== "spawn" });
  if (operation === "recover") {
    expect(await f.resume()).toMatchObject({ state: "succeeded" });
    await vi.waitFor(() => expect(f.store.getLifecycle(f.sessionId)).toMatchObject({
      tasks: { observation: { state: "observed" } }, queue: { observation: { state: "observed" } },
    }));
  }
  const driver = kind === "missing" ? null : new CopilotAttachmentDriver();
  driver?.retire();
  const returned = new AdmissionSession(f.cwd, f.handle.vendorSessionId, driver);
  if (stopFails) returned.stop.mockRejectedValue(new Error("Stop acknowledgement missing"));
  vi.mocked(f.adapter.resume).mockResolvedValue(returned);
  vi.mocked(f.adapter.spawn).mockResolvedValue(returned);
  const command = operation === "recover" ? { ...f.command, commandId: newCommandId(), payloadHash: "native-admission-recover" } : f.command;
  const act = () => operation === "startup" ? f.service.reattachPersistedCopilotSessions()
    : operation === "resume" ? f.resume()
    : operation === "inspect" ? f.inspect()
    : operation === "spawn" ? f.launch()
    : f.service.recover({ ...command, operation: "recover", expectedRuntimeEpoch: f.handle.runtimeEpoch });
  return { ...f, command, returned, act };
}

describe("native attachment prerequisites before durable admission", () => {
  it.each(["startup", "resume", "recover", "inspect", "spawn"] as const)("refuses a missing driver during %s, releases the handle and never creates a phantom activation", async operation => {
    const f = await refusalFixture(operation, "missing");
    if (operation === "inspect") await expect(f.act()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    else if (operation === "startup") expect(await f.act()).toMatchObject({ reattached: 0,
      failures: [{ stage: "validateHandle", reason: "handleRejected", error: { code: "UNSUPPORTED", certainty: "definiteFailure" } }] });
    else expect(await f.act()).toMatchObject({ state: "failed" });
    expect(f.returned.stop).toHaveBeenCalledOnce();
    expect(f.returned.subscribe).not.toHaveBeenCalled();
    expect(f.store.getSession(f.sessionId)?.availability).not.toBe("active");
    expect(f.store.getSession(f.sessionId)?.runtimeEpoch ?? null).toBeNull();
    if (operation === "spawn") {
      expect(f.compensate).toHaveBeenCalledOnce();
      expect(f.returned.stop.mock.invocationCallOrder[0]).toBeLessThan(f.compensate.mock.invocationCallOrder[0]!);
    }
    await expect(f.service.readLifecycle(f.sessionId)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it.each(["startup", "resume", "recover", "inspect", "spawn"] as const)("refuses a retired driver before %s activation", async operation => {
    const f = await refusalFixture(operation, "retired");
    if (operation === "inspect") await expect(f.act()).rejects.toThrow("retired");
    else if (operation === "startup") expect(await f.act()).toMatchObject({ reattached: 0, failures: [{ reason: "handleRejected" }] });
    else expect(await f.act()).toMatchObject({ state: "failed" });
    expect(f.returned.stop).toHaveBeenCalledOnce();
    expect(f.returned.subscribe).not.toHaveBeenCalled();
    expect(f.store.getSession(f.sessionId)?.availability).not.toBe("active");
  });

  it.each(["startup", "resume", "recover", "inspect", "spawn"] as const)("preserves uncertain refused-handle cleanup in the original %s receipt", async operation => {
    const f = await refusalFixture(operation, "missing", true);
    if (operation === "inspect") await expect(f.act()).rejects.toMatchObject({ name: "AdapterOutcomeUnknownError" });
    else if (operation === "startup") expect(await f.act()).toMatchObject({ reattached: 0,
      failures: [{ reason: "ownershipUncertain", action: "reconcileNativeOwner", error: { certainty: "outcomeUnknown" } }] });
    else expect(await f.act()).toMatchObject({ state: "outcomeUnknown" });
    expect(f.returned.stop).toHaveBeenCalledOnce();
    expect(f.store.getSession(f.sessionId)?.availability).not.toBe("active");
    if (operation === "spawn") expect(f.compensate).not.toHaveBeenCalled();
    if (operation === "resume" || operation === "recover") {
      const receipt = f.service.getCommand(f.command.commandId);
      expect(await f.act()).toEqual(receipt);
      expect(f.returned.stop).toHaveBeenCalledOnce();
      expect(f.adapter.resume).toHaveBeenCalledTimes(operation === "recover" ? 2 : 1);
    }
  });

  it.each(["same handle", "shared driver"] as const)("cannot steal or stop another Runtime's %s", async reuse => {
    const first = fixture();
    expect(await first.resume()).toMatchObject({ state: "succeeded" });
    const handle = reuse === "same handle" ? first.handle :
      new AdmissionSession(first.cwd, first.handle.vendorSessionId, first.handle.copilotObservationDriver!);
    const second = fixture({ cwd: first.cwd, handle });
    expect(await second.resume()).toMatchObject({ state: "outcomeUnknown" });
    expect(handle.stop).not.toHaveBeenCalled();
    expect(first.handle.stop).not.toHaveBeenCalled();
    expect(first.store.getSession(first.sessionId)?.availability).toBe("active");
    expect(second.store.getSession(second.sessionId)).toMatchObject({ availability: "resumable", runtimeEpoch: null });
    expect(first.handle.copilotObservationDriver!.capture("tasks")).toBeDefined();
  });

  it("rejects a duplicate driver already claimed by a pending admission before any observer exists", async () => {
    const f = fixture(), otherOwner = {};
    f.handle.copilotObservationDriver!.claimRuntime(otherOwner);
    expect(await f.resume()).toMatchObject({ state: "outcomeUnknown" });
    expect(f.handle.stop).not.toHaveBeenCalled();
    expect(f.handle.copilotObservationDriver!.claimedByAnother(otherOwner)).toBe(false);
    expect(f.store.getSession(f.sessionId)?.availability).toBe("resumable");
  });

  it("atomically admits only one of two concurrent Runtime claims for the same returned handle", async () => {
    const first = fixture();
    const second = fixture({ cwd: first.cwd, handle: first.handle });
    const receipts = await Promise.all([first.resume(), second.resume()]);
    expect(receipts.map(receipt => receipt.state).sort()).toEqual(["outcomeUnknown", "succeeded"]);
    expect([first, second].filter(f => f.store.getSession(f.sessionId)?.availability === "active")).toHaveLength(1);
    expect(first.handle.stop).not.toHaveBeenCalled();
    expect(first.handle.subscribe).toHaveBeenCalledOnce();
  });

  it("retires an explicit temporary inspection only after its acknowledged Stop", async () => {
    const f = fixture();
    expect(await f.inspect()).toMatchObject({ complete: true });
    expect(f.handle.stop).toHaveBeenCalledOnce();
    expect(() => f.handle.copilotObservationDriver!.capture("tasks")).toThrow("retired");
    expect(f.store.getSession(f.sessionId)).toMatchObject({ availability: "resumable", runtimeEpoch: null });
    expect(f.handle.subscribe).not.toHaveBeenCalled();
  });

  it("retains a temporary inspection claim while Stop ownership is uncertain", async () => {
    const f = fixture();
    f.handle.stop.mockRejectedValue(new Error("Stop acknowledgement missing"));
    await expect(f.inspect()).rejects.toMatchObject({ name: "AdapterOutcomeUnknownError" });
    expect(f.handle.copilotObservationDriver!.capture("tasks")).toBeDefined();
    expect(await f.resume()).toMatchObject({ state: "outcomeUnknown" });
    expect(f.handle.stop).toHaveBeenCalledOnce();
    expect(f.store.getSession(f.sessionId)?.availability).toBe("resumable");
  });
});
