import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adapterScopeIdSchema, newCommandId, newLaunchId, newRuntimeEpoch,
  newRuntimeNodeBootId, newRuntimeNodeId, newSessionId,
  type Harness, type HarnessCommand, type JsonValue, type NativeHistoryRequest, type NativeStateRequest,
} from "@arduano/agent-multiplex-protocol";
import {
  RuntimeNodeService, RuntimeNodeStore, CopilotAttachmentDriver,
  type AdapterNativeHistoryResult, type AdapterNativeStateResult, type AdapterSession, type AgentAdapter,
} from "../src/index.js";

class Session implements AdapterSession {
  readonly adapterScopeId = adapterScopeIdSchema.parse("command-admission-fixture");
  readonly runtimeEpoch = newRuntimeEpoch();
  readonly vendorSessionId = "native-admission-fixture";
  readonly stopped = false;
  readonly copilotObservationDriver: CopilotAttachmentDriver | undefined;
  execute = vi.fn(async (_request: HarnessCommand): Promise<JsonValue> => ({ acknowledged: true }));
  read = vi.fn(async (_request: NativeHistoryRequest): Promise<AdapterNativeHistoryResult> => ({
    harness: this.harness, vendorSessionId: this.vendorSessionId, payload: [], complete: true,
  }));
  state = vi.fn(async (request: NativeStateRequest): Promise<AdapterNativeStateResult> => ({
    harness: this.harness, vendorSessionId: this.vendorSessionId,
    payload: request.view === "tasks" ? { tasks: [] } : request.view === "pendingMessages" ? { items: [], steeringMessages: [], inFlightSteeringCount: 0 } : { agents: [] },
  }));
  stop = vi.fn(async () => undefined);
  constructor(readonly harness: Harness, readonly cwd: string) { this.copilotObservationDriver = harness === "copilot" ? new CopilotAttachmentDriver() : undefined; }
  status() { return "idle" as const; }
  subscribe() { return () => undefined; }
  readNativeHistory(request: NativeHistoryRequest) { return this.read(request); }
  async readNativeState(request: NativeStateRequest) {
    const driver = this.copilotObservationDriver;
    const view = request.view === "agents" ? "agents" : request.view === "pendingMessages" ? "pendingMessages" : "tasks";
    const ticket = driver?.capture(view);
    const result = await this.state(request);
    return ticket && driver ? driver.certify(ticket, { ...result }) : result;
  }
}

const cleanups: Array<() => Promise<void>> = [];
const releaseGates: Array<() => void> = [];
afterEach(async () => {
  for (const release of releaseGates.splice(0)) release();
  for (const close of cleanups.splice(0)) await close();
});
async function fixture(harness: Harness = "codex") {
  const cwd = mkdtempSync(join(tmpdir(), "multiplex-command-admission-"));
  const store = new RuntimeNodeStore(":memory:");
  const runtimeNodeId = newRuntimeNodeId();
  const sessions: Session[] = [];
  const attach = () => { const session = new Session(harness, cwd); sessions.push(session); return Promise.resolve(session); };
  const adapter: AgentAdapter = {
    harness, adapterScopeId: adapterScopeIdSchema.parse("command-admission-fixture"),
    describe: async () => ({ harness, adapterScopeId: adapter.adapterScopeId, available: true, capabilities: [] }),
    listModels: async () => [], listSessions: async () => [],
    spawn: vi.fn(attach), resume: vi.fn(attach), close: async () => undefined,
  };
  const service = new RuntimeNodeService({ store, adapters: [adapter], runtimeNodeId, runtimeNodeBootId: newRuntimeNodeBootId(),
    name: "command admission fixture", allowedRoots: [cwd] });
  cleanups.push(async () => { await service.close(); store.close(); rmSync(cwd, { recursive: true, force: true }); });
  const profile = service.launchProfiles()[0]!;
  const launch = { launchId: newLaunchId(), sessionId: newSessionId(), runtimeNodeId, payloadHash: "admission-fixture-launch",
    profile: { providerId: profile.providerId, profileId: profile.profileId, contractVersion: profile.contractVersion, requestSchemaHash: profile.requestSchemaHash },
    harness, input: { cwd } };
  service.createLaunch(launch);
  await vi.waitFor(() => expect(service.getLaunch(launch.launchId)?.state).toBe("succeeded"));
  const lifecycle = (operation: "stop" | "resume") => ({ operation, commandId: newCommandId(), payloadHash: `admission-fixture-${operation}`,
    sessionId: launch.sessionId, runtimeNodeId, bindingRevision: 1 });
  const history = (activeOnly = false) => service.readNativeHistory(launch.sessionId, { harness, includeTurns: true, limit: 5,
    ...(activeOnly ? { native: { activeBindingOnly: true } } : {}) });
  return { service, store, adapter, sessions, launch, lifecycle, history, cwd };
}

function gate<T>() {
  let release!: (value: T) => void;
  return { result: new Promise<T>(yes => { release = yes; }), release: (value: T) => release(value) };
}

describe("durable command admission before the session lock", () => {
  it.each(["codex", "copilot"] as const)("journals queued %s Resume and Stop while temporary history owns the lock, without duplicate dispatch", async harness => {
    const f = await fixture(harness);
    await f.service.stop(f.lifecycle("stop"));
    const pendingHistory = gate<AdapterNativeHistoryResult>();
    releaseGates.push(() => pendingHistory.release({ harness, vendorSessionId: "native-admission-fixture", payload: [], complete: true }));
    let temporary: Session | undefined;
    vi.mocked(f.adapter.resume).mockImplementationOnce(async () => {
      temporary = new Session(harness, f.cwd);
      temporary.read.mockImplementation(() => pendingHistory.result);
      return temporary;
    });
    const history = f.service.inspectNativeHistory(f.launch.sessionId, { harness, includeTurns: true, limit: 5 });
    await vi.waitFor(() => expect(temporary?.read).toHaveBeenCalledOnce());
    const request = f.lifecycle("resume");
    const resumed = f.service.resume(request);
    expect(f.service.getCommand(request.commandId)).toMatchObject({ state: "received", request });
    expect(f.service.observeCommand(request.commandId)).toMatchObject({ continuation: "waitForReceipt", receipt: { state: "received" } });
    expect(await f.service.resume(request)).toMatchObject({ state: "received" });
    await expect(f.service.resume({ ...request, payloadHash: "different-fixture-payload" })).rejects.toMatchObject({ code: "PAYLOAD_MISMATCH" });
    const stopRequest = f.lifecycle("stop");
    const stopped = f.service.stop(stopRequest);
    expect(f.service.getCommand(stopRequest.commandId)).toMatchObject({ state: "received" });
    expect(f.adapter.resume).toHaveBeenCalledOnce();
    pendingHistory.release({ harness, vendorSessionId: temporary!.vendorSessionId, payload: [], complete: true });
    await history;
    expect(await resumed).toMatchObject({ state: "succeeded" });
    expect(await stopped).toMatchObject({ state: "succeeded" });
    expect(f.adapter.resume).toHaveBeenCalledTimes(2);
    expect(temporary!.stop).toHaveBeenCalledOnce();
    expect(f.sessions.at(-1)!.stop).toHaveBeenCalledOnce();
    expect(await f.service.resume(request)).toMatchObject({ state: "succeeded" });
    expect(f.adapter.resume).toHaveBeenCalledTimes(2);
  });

  it("journals a queued native command before an active history lock, then dispatches it once", async () => {
    const f = await fixture();
    const historyGate = gate<AdapterNativeHistoryResult>();
    releaseGates.push(() => historyGate.release({ harness: "codex", vendorSessionId: "native-admission-fixture", payload: [], complete: true }));
    const session = f.sessions[0]!;
    session.read.mockImplementation(() => historyGate.result);
    const history = f.history();
    await vi.waitFor(() => expect(session.read).toHaveBeenCalledOnce());
    const request = { commandId: newCommandId(), payloadHash: "admission-fixture-command", sessionId: f.launch.sessionId,
      runtimeNodeId: f.launch.runtimeNodeId, bindingRevision: 1,
      request: { harness: "codex" as const, command: { type: "interrupt" as const } } };
    const executing = f.service.execute(request);
    expect(f.service.getCommand(request.commandId)).toMatchObject({ state: "received" });
    expect(await f.service.execute(request)).toMatchObject({ state: "received" });
    expect(session.execute).not.toHaveBeenCalled();
    historyGate.release({ harness: "codex", vendorSessionId: session.vendorSessionId, payload: [], complete: true });
    await history;
    expect(await executing).toMatchObject({ state: "succeeded" });
    expect(session.execute).toHaveBeenCalledOnce();
  });

  it("retains queued admissions as unknown after a fixture store restart, never replaying", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "multiplex-command-restart-"));
    const path = join(cwd, "runtime.sqlite");
    const store = new RuntimeNodeStore(path);
    const record = { commandId: newCommandId(), payloadHash: "queued-before-restart", sessionId: newSessionId(), runtimeNodeId: newRuntimeNodeId(),
      state: "received" as const, request: { operation: "resume" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    store.putCommand(record); store.close();
    const reopened = new RuntimeNodeStore(path);
    try {
      const { updatedAt: _updatedAt, ...identity } = record;
      expect(reopened.getCommand(record.commandId)).toMatchObject({ ...identity, state: "outcomeUnknown", error: { stage: "recovery", certainty: "outcomeUnknown" } });
    }
    finally { reopened.close(); rmSync(cwd, { recursive: true, force: true }); }
  });
});

describe("active-binding-only history capability", () => {
  it.each(["codex", "copilot"] as const)("advertises the %s guard and strips it before native history", async harness => {
    const f = await fixture(harness);
    expect((await f.service.catalog())[0]?.capabilities).toContainEqual({ name: "history.active-binding", version: "v1", experimental: false });
    await f.history(true);
    expect(f.sessions[0]!.read).toHaveBeenCalledWith(expect.objectContaining({ native: {} }));
    expect(f.adapter.resume).not.toHaveBeenCalled();
  });

  it.each(["codex", "copilot"] as const)("refuses a stopped %s binding without a temporary SDK attachment", async harness => {
    const f = await fixture(harness);
    await f.service.stop(f.lifecycle("stop"));
    await expect(f.history(true)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.adapter.resume).not.toHaveBeenCalled();
  });

  it("fails promptly behind an unresolved Stop and rechecks the stopped binding afterward", async () => {
    const f = await fixture(); const stopGate = gate<void>();
    releaseGates.push(() => stopGate.release());
    f.sessions[0]!.stop.mockImplementationOnce(() => stopGate.result);
    const stopRequest = f.lifecycle("stop"); const stopping = f.service.stop(stopRequest);
    await vi.waitFor(() => expect(f.sessions[0]!.stop).toHaveBeenCalledOnce());
    await expect(f.history(true)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.sessions[0]!.read).not.toHaveBeenCalled();
    stopGate.release(); await stopping;
    await expect(f.history(true)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.adapter.resume).not.toHaveBeenCalled();
  });
});

describe("native agent registry binding fence", () => {
  it("keeps the read on an active managed binding and rejects a different native identity", async () => {
    const f = await fixture("copilot"); const session = f.sessions[0]!;
    session.state.mockImplementation(async () => ({ harness: "copilot", vendorSessionId: "another-native-session", payload: { agents: [] } }));
    await expect(f.service.readNativeState(f.launch.sessionId, { harness: "copilot", view: "agents" })).rejects.toMatchObject({ code: "FENCED" });
    expect(f.adapter.resume).not.toHaveBeenCalled();
  });

  it("rejects a different harness reply and never temporarily attaches a stopped binding", async () => {
    const f = await fixture("copilot"); const session = f.sessions[0]!;
    session.state.mockImplementation(async () => ({ harness: "codex", vendorSessionId: session.vendorSessionId, payload: { agents: [] } }));
    await expect(f.service.readNativeState(f.launch.sessionId, { harness: "copilot", view: "agents" })).rejects.toMatchObject({ code: "FENCED" });
    await f.service.stop(f.lifecycle("stop")); session.state.mockClear();
    await expect(f.service.readNativeState(f.launch.sessionId, { harness: "copilot", view: "agents" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(session.state).not.toHaveBeenCalled(); expect(f.adapter.resume).not.toHaveBeenCalled();
  });
});
