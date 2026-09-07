import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newCommandId, newLaunchId, newRuntimeEpoch, newRuntimeNodeBootId, newRuntimeNodeId, newSessionId,
  packNativePayload, type LaunchRequest, type NativeStateRequest,
} from "@arduano/agent-multiplex-protocol";
import {
  AdapterOutcomeUnknownError, RuntimeNodeService, RuntimeNodeStore, createRuntimeNodeRouter,
  type AdapterSession, type AgentAdapter,
} from "@arduano/agent-multiplex-runtime-node-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const request: NativeStateRequest = { harness: "copilot", view: "pendingMessages" };

async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "multiplex-native-state-"));
  const store = new RuntimeNodeStore(":memory:");
  const runtimeNodeId = newRuntimeNodeId(); const runtimeNodeBootId = newRuntimeNodeBootId();
  const payload = { items: [{ id: "queue-id", messageId: "message-id", displayText: "hello", agentMode: "interactive", kind: "message" }], steeringMessages: [] };
  const readNativeState = vi.fn(async () => ({ harness: "copilot" as const, vendorSessionId: "native-state", payload }));
  const readNativeHistory = vi.fn(async () => { throw new Error("history must not run"); });
  const session: AdapterSession = {
    harness: "copilot", adapterScopeId: "native-state-test", vendorSessionId: "native-state", cwd, runtimeEpoch: newRuntimeEpoch(),
    status: () => "idle", subscribe: () => () => {}, execute: vi.fn(async () => ({ steered: true })), readNativeState, readNativeHistory, stop: vi.fn(async () => {}),
  };
  const resume = vi.fn(async () => session);
  const adapter: AgentAdapter = {
    harness: "copilot", adapterScopeId: session.adapterScopeId,
    describe: async () => ({ harness: "copilot", adapterScopeId: session.adapterScopeId, available: true, capabilities: [] }),
    listModels: async () => [], listSessions: async () => [], spawn: async () => session, resume, close: async () => {},
  };
  const service = new RuntimeNodeService({ store, runtimeNodeId, runtimeNodeBootId, name: "state test", adapters: [adapter], allowedRoots: [cwd] });
  cleanup.push(async () => { await service.close(); store.close(); rmSync(cwd, { recursive: true, force: true }); });
  const profile = service.launchProfiles()[0]!;
  const launch: LaunchRequest = { launchId: newLaunchId(), sessionId: newSessionId(), runtimeNodeId, payloadHash: "state-launch-payload",
    profile: { providerId: profile.providerId, profileId: profile.profileId, contractVersion: profile.contractVersion, requestSchemaHash: profile.requestSchemaHash },
    harness: "copilot", input: { cwd } };
  service.createLaunch(launch);
  await vi.waitFor(() => expect(service.getLaunch(launch.launchId)?.state).toBe("succeeded"));
  const caller = createRuntimeNodeRouter(service).createCaller({});
  return { service, store, session, launch, runtimeNodeBootId, readNativeState, readNativeHistory, resume, caller, payload };
}

describe("active-only native session observations", () => {
  it("routes a bounded read through the runtime boot fence with no history, resume or durable command", async () => {
    const f = await fixture(); const before = f.store.getSession(f.launch.sessionId);
    expect(await f.caller.sessions.readNativeState({ sessionId: f.launch.sessionId, runtimeNodeBootId: f.runtimeNodeBootId, request })).toEqual({
      harness: "copilot", vendorSessionId: "native-state", payload: packNativePayload(f.payload),
    });
    expect(f.readNativeState).toHaveBeenCalledExactlyOnceWith(request);
    expect(f.store.getSession(f.launch.sessionId)).toEqual(before);
    expect(f.readNativeHistory).not.toHaveBeenCalled(); expect(f.resume).not.toHaveBeenCalled(); expect(f.session.execute).not.toHaveBeenCalled();
    await expect(f.caller.sessions.readNativeState({ sessionId: f.launch.sessionId, runtimeNodeBootId: newRuntimeNodeBootId(), request })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(f.readNativeState).toHaveBeenCalledOnce();
  });

  it("rejects unknown, wrong-harness and inactive bindings without creating a temporary SDK session", async () => {
    const f = await fixture();
    await expect(f.service.readNativeState(newSessionId(), request)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(f.service.readNativeState(f.launch.sessionId, { ...request, harness: "codex" } as never)).rejects.toMatchObject({ code: "FENCED" });
    await f.service.stop({ operation: "stop", commandId: newCommandId(), payloadHash: "state-test-stop-hash", sessionId: f.launch.sessionId, runtimeNodeId: f.launch.runtimeNodeId, bindingRevision: 1 });
    await expect(f.service.readNativeState(f.launch.sessionId, request)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.resume).not.toHaveBeenCalled(); expect(f.readNativeState).not.toHaveBeenCalled();
  });

  it("rejects response identity mismatches and unsupported adapters", async () => {
    const f = await fixture();
    f.readNativeState.mockResolvedValueOnce({ harness: "copilot", vendorSessionId: "different-native-session", payload: f.payload });
    await expect(f.service.readNativeState(f.launch.sessionId, request)).rejects.toMatchObject({ code: "FENCED" });
    delete f.session.readNativeState;
    await expect(f.service.readNativeState(f.launch.sessionId, request)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(f.resume).not.toHaveBeenCalled();
  });

  it.each([false, true])("deduplicates a queued-message transition with an uncertain reply=%s", async uncertain => {
    const f = await fixture();
    const execute = vi.fn(async () => {
      if (uncertain) throw new AdapterOutcomeUnknownError("native reply lost");
      return { steered: false };
    });
    f.session.execute = execute;
    const command = { commandId: newCommandId(), payloadHash: "atomic-queue-steering-hash", sessionId: f.launch.sessionId,
      runtimeNodeId: f.launch.runtimeNodeId, bindingRevision: 1,
      request: { harness: "copilot", command: { type: "steerQueuedMessage", id: "queue-id" } } } as const;
    const first = await f.service.execute(command);
    expect(first.state).toBe(uncertain ? "outcomeUnknown" : "succeeded");
    if (!uncertain) expect(first.result).toEqual(packNativePayload({ steered: false }));
    expect(await f.service.execute(command)).toEqual(first);
    expect(execute).toHaveBeenCalledExactlyOnceWith(command.request);
    expect(f.readNativeHistory).not.toHaveBeenCalled();
  });
});
