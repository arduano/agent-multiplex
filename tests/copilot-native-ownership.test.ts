import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ModelInfo, ResumeSessionConfig, SessionConfig, SessionEvent, SessionMetadata } from "@github/copilot-sdk";
import {
  emptyMetadataSnapshot, newCommandId, newLaunchId, newRuntimeEpoch, newRuntimeNodeBootId, newRuntimeNodeId, newSessionId,
} from "@arduano/agent-multiplex-protocol";
import { CopilotAgentAdapter, type CopilotAdapterClient } from "../packages/adapter-copilot/src/adapter.js";
import type { CopilotNativeSession } from "../packages/adapter-copilot/src/session.js";
import { AdapterOutcomeUnknownError, RuntimeNodeService, RuntimeNodeStore } from "@arduano/agent-multiplex-runtime-node-core";

class Native implements CopilotNativeSession {
  readonly rpc = { mode: { set: async () => {} } };
  readonly disconnect = vi.fn(async () => {});
  constructor(readonly sessionId: string) {}
  async send() { return "unused-no-model-call"; }
  async abort() {}
  async setModel() {}
  async getEvents(): Promise<SessionEvent[]> { return []; }
}

class Client implements CopilotAdapterClient {
  prepareSession?: CopilotAdapterClient["prepareSession"];
  readonly sessions = new Map<string, Native>();
  readonly resumeSession = vi.fn(async (id: string, _config: ResumeSessionConfig) => {
    const native = new Native(id); this.sessions.set(id, native); return native;
  });
  async start() {}
  async stop(): Promise<Error[]> { return []; }
  async forceStop() {}
  async getStatus() { return { version: "fixture", protocolVersion: 7 }; }
  async listModels(): Promise<ModelInfo[]> { return []; }
  async listSessions(): Promise<SessionMetadata[]> { return []; }
  async createSession(config: SessionConfig) {
    const native = new Native(config.sessionId!); this.sessions.set(native.sessionId, native); return native;
  }
}

describe("retained Copilot native ownership through Runtime", () => {
  it("persists the actual adapter preparation refusal as a definite original-ID admission receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiplex-copilot-preparation-"));
    const filename = join(root, "runtime.sqlite");
    const store = new RuntimeNodeStore(filename);
    const client = new Client();
    const adapter = new CopilotAgentAdapter({ clientFactory: () => client });
    const runtimeNodeId = newRuntimeNodeId(), sessionId = newSessionId();
    const timestamp = new Date().toISOString();
    store.putSession({ sessionId, runtimeNodeId, harness: "copilot", adapterScopeId: adapter.adapterScopeId,
      vendorSessionId: "preparation-native", bindingRevision: 4, runtimeEpoch: null, cwd: root,
      availability: "resumable", runtimeStatus: "stopped", launchProvenance: null,
      metadata: emptyMetadataSnapshot(), createdAt: timestamp, updatedAt: timestamp,
      lastSeenAt: timestamp, lastActivityAt: timestamp });
    const prepare = vi.fn(async () => { throw new Error("private configuration refusal"); });
    client.prepareSession = prepare;
    const service = new RuntimeNodeService({ store, adapters: [adapter], runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(), name: "preparation fixture", allowedRoots: [root] });
    const resume = { operation: "resume" as const, commandId: newCommandId(), sessionId, runtimeNodeId,
      bindingRevision: 4, payloadHash: "preparation-resume-fixture" };
    try {
      const receipt = await service.resume(resume);
      expect(receipt).toMatchObject({ state: "failed", error: { stage: "admission", certainty: "definiteFailure" } });
      expect(await service.resume(resume)).toEqual(receipt);
      expect(prepare).toHaveBeenCalledOnce();
      expect(client.resumeSession).not.toHaveBeenCalled();
      expect(store.getSession(sessionId)).toMatchObject({ availability: "resumable", runtimeEpoch: null });
      expect(JSON.stringify(receipt)).not.toContain("private configuration refusal");
      await service.close(); store.close();
      const reopened = new RuntimeNodeStore(filename);
      try { expect(reopened.getCommand(resume.commandId)).toEqual(receipt); }
      finally { reopened.close(); }
    } finally {
      await service.close(); store.close(); rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists actual adapter startup preparation attribution without dispatching native resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiplex-copilot-startup-preparation-"));
    const filename = join(root, "runtime.sqlite"), store = new RuntimeNodeStore(filename);
    const client = new Client();
    const adapter = new CopilotAgentAdapter({ clientFactory: () => client });
    const runtimeNodeId = newRuntimeNodeId(), sessionId = newSessionId();
    const timestamp = new Date().toISOString();
    store.putSession({ sessionId, runtimeNodeId, harness: "copilot", adapterScopeId: adapter.adapterScopeId,
      vendorSessionId: "startup-preparation-native", bindingRevision: 4, runtimeEpoch: newRuntimeEpoch(), cwd: root,
      availability: "active", runtimeStatus: "idle", launchProvenance: null,
      metadata: emptyMetadataSnapshot(), createdAt: timestamp, updatedAt: timestamp,
      lastSeenAt: timestamp, lastActivityAt: timestamp });
    client.prepareSession = vi.fn(async () => { throw new Error("private startup configuration refusal"); });
    const service = new RuntimeNodeService({ store, adapters: [adapter], runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(), name: "startup preparation fixture", allowedRoots: [root] });
    try {
      const summary = await service.reattachPersistedCopilotSessions();
      expect(summary).toMatchObject({ reattached: 0, failures: [{ stage: "prepareResume", reason: "preparationFailed",
        action: "stopOrRetryResume", error: { stage: "recovery", certainty: "definiteFailure" } }] });
      expect(client.resumeSession).not.toHaveBeenCalled();
      expect(store.getSession(sessionId)).toMatchObject({ availability: "resumable", runtimeEpoch: null });
      expect(JSON.stringify(summary)).not.toContain("private startup configuration refusal");
      await service.close(); store.close();
      const reopened = new RuntimeNodeStore(filename);
      try { expect(reopened.listStartupCopilotFailures()).toEqual(summary.failures); }
      finally { reopened.close(); }
    } finally {
      await service.close(); store.close(); rmSync(root, { recursive: true, force: true });
    }
  });

  it("settles stopped-history and queued resume without overlapping an uncertain disconnect", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "multiplex-copilot-ownership-"));
    const store = new RuntimeNodeStore(":memory:");
    const client = new Client();
    const adapter = new CopilotAgentAdapter({ clientFactory: () => client });
    const runtimeNodeId = newRuntimeNodeId();
    const service = new RuntimeNodeService({ store, adapters: [adapter], runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(), name: "ownership fixture", allowedRoots: [root] });
    try {
      const profile = service.launchProfiles()[0]!;
      const launchId = newLaunchId(), sessionId = newSessionId();
      service.createLaunch({ launchId, sessionId, runtimeNodeId, payloadHash: "ownership-launch-fixture",
        profile: { providerId: profile.providerId, profileId: profile.profileId,
          contractVersion: profile.contractVersion, requestSchemaHash: profile.requestSchemaHash },
        harness: "copilot", input: { cwd: root } });
      await vi.waitFor(() => expect(service.getLaunch(launchId)?.state).toBe("succeeded"));
      const before = store.getSession(sessionId)!;
      const native = client.sessions.get(before.vendorSessionId)!;
      let acknowledge!: () => void;
      native.disconnect.mockReturnValue(new Promise<void>(resolve => { acknowledge = resolve; }));
      const stop = { operation: "stop" as const, commandId: newCommandId(), sessionId, runtimeNodeId,
        bindingRevision: before.bindingRevision, payloadHash: "ownership-stop-fixture" };
      const stopping = service.stop(stop);
      await vi.advanceTimersByTimeAsync(10_000);
      const stopReceipt = await stopping;
      expect(stopReceipt).toMatchObject({ state: "outcomeUnknown" });
      expect(store.getSession(sessionId)).toMatchObject({ availability: "resumable", runtimeStatus: "stopped", runtimeEpoch: null });

      const history = service.inspectNativeHistory(sessionId, { harness: "copilot", includeTurns: true, limit: 25 });
      const failedHistory = expect(history).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
      const resume = { operation: "resume" as const, commandId: newCommandId(), sessionId, runtimeNodeId,
        bindingRevision: before.bindingRevision, payloadHash: "ownership-resume-fixture" };
      const resuming = service.resume(resume);
      await failedHistory;
      const failedResume = await resuming;
      expect(failedResume).toMatchObject({ state: "outcomeUnknown" });
      expect(service.observeCommand(resume.commandId)?.receipt).toEqual(failedResume);
      expect(client.resumeSession).not.toHaveBeenCalled();
      expect(native.disconnect).toHaveBeenCalledOnce();
      await expect(adapter.releaseSession(store.getSession(sessionId)!)).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);

      acknowledge(); await vi.advanceTimersByTimeAsync(0);
      await expect(adapter.releaseSession(store.getSession(sessionId)!)).resolves.toBeUndefined();
      const recovered = await service.resume({ ...resume, commandId: newCommandId(), payloadHash: "ownership-resume-after-ack" });
      expect(recovered).toMatchObject({ state: "succeeded" });
      expect(client.resumeSession).toHaveBeenCalledOnce();
      expect(store.getSession(sessionId)).toMatchObject({ vendorSessionId: before.vendorSessionId,
        bindingRevision: before.bindingRevision, cwd: before.cwd, availability: "active" });
      expect(service.observeCommand(stop.commandId)?.receipt).toEqual(stopReceipt);
      expect(service.observeCommand(resume.commandId)?.receipt).toEqual(failedResume);
    } finally {
      await service.close(); store.close(); rmSync(root, { recursive: true, force: true }); vi.useRealTimers();
    }
  });

  it("closes an unresolved temporary SDK resume before waiting on the history lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiplex-copilot-close-"));
    const store = new RuntimeNodeStore(":memory:");
    const client = new Client();
    const adapter = new CopilotAgentAdapter({ clientFactory: () => client });
    const runtimeNodeId = newRuntimeNodeId();
    const service = new RuntimeNodeService({ store, adapters: [adapter], runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(), name: "close fixture", allowedRoots: [root] });
    try {
      const profile = service.launchProfiles()[0]!;
      const launchId = newLaunchId(), sessionId = newSessionId();
      service.createLaunch({ launchId, sessionId, runtimeNodeId, payloadHash: "close-launch-fixture",
        profile: { providerId: profile.providerId, profileId: profile.profileId,
          contractVersion: profile.contractVersion, requestSchemaHash: profile.requestSchemaHash },
        harness: "copilot", input: { cwd: root } });
      await vi.waitFor(() => expect(service.getLaunch(launchId)?.state).toBe("succeeded"));
      await service.stop({ operation: "stop", commandId: newCommandId(), sessionId, runtimeNodeId,
        bindingRevision: 1, payloadHash: "close-stop-fixture" });
      client.resumeSession.mockImplementationOnce(() => new Promise<never>(() => {}));
      const nativeClose = vi.spyOn(client, "stop");
      const history = service.inspectNativeHistory(sessionId, { harness: "copilot", includeTurns: true, limit: 25 });
      const failedHistory = expect(history).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
      await vi.waitFor(() => expect(client.resumeSession).toHaveBeenCalledOnce());
      const closing = service.close();
      expect(service.close()).toBe(closing);
      await closing;
      await failedHistory;
      expect(nativeClose).toHaveBeenCalledOnce();
      await expect(service.readNativeHistory(sessionId, { harness: "copilot", includeTurns: true })).rejects.toMatchObject({ code: "FENCED" });
      await expect(service.inspectNativeHistory(sessionId, { harness: "copilot", includeTurns: true })).rejects.toMatchObject({ code: "FENCED" });
      expect(store.getSession(sessionId)).toMatchObject({ availability: "resumable", runtimeEpoch: null });
    } finally {
      await service.close(); store.close(); rmSync(root, { recursive: true, force: true });
    }
  });
});
