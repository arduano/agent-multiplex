import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adapterScopeIdSchema,
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
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeNodeService,
  RuntimeNodeStore,
  type AdapterEvent,
  type AdapterNativeStateResult,
  type AdapterSession,
  type AgentAdapter,
} from "../src/index.js";

class CopilotSession implements AdapterSession {
  readonly harness = "copilot" as const;
  readonly adapterScopeId = adapterScopeIdSchema.parse("startup-reattach-test");
  readonly vendorSessionId: string;
  readonly runtimeEpoch = newRuntimeEpoch();
  readonly #listeners = new Set<(event: AdapterEvent) => void>();
  #stopped = false;

  constructor(readonly cwd: string, vendorSessionId = "native-startup-reattach") {
    this.vendorSessionId = vendorSessionId;
  }
  status() { return this.#stopped ? "stopped" as const : "idle" as const; }
  subscribe(listener: (event: AdapterEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  execute(_command: HarnessCommand): Promise<JsonValue | undefined> { return Promise.resolve(undefined); }
  readNativeHistory(_request: NativeHistoryRequest): Promise<NativeHistoryResult> {
    return Promise.resolve({ harness: "copilot", vendorSessionId: this.vendorSessionId, payload: [], complete: true });
  }
  readNativeState(request: NativeStateRequest): Promise<AdapterNativeStateResult> {
    return Promise.resolve({
      harness: "copilot",
      vendorSessionId: this.vendorSessionId,
      payload: request.harness === "copilot" && request.view === "tasks"
        ? { tasks: [] }
        : { items: [], steeringMessages: [], inFlightSteeringCount: 0 },
    });
  }
  stop(): Promise<void> {
    this.#stopped = true;
    return Promise.resolve();
  }
}

class CopilotAdapter implements AgentAdapter {
  readonly harness = "copilot" as const;
  readonly adapterScopeId = adapterScopeIdSchema.parse("startup-reattach-test");
  readonly resumes: HarnessResumeOptions[] = [];
  readonly handles: CopilotSession[] = [];
  returnedVendorSessionId = "native-startup-reattach";
  constructor(readonly cwd: string) {}
  describe(): Promise<HarnessCatalogEntry> {
    return Promise.resolve({ harness: "copilot", adapterScopeId: this.adapterScopeId, available: true, capabilities: [] });
  }
  listModels(): Promise<NativeModel[]> { return Promise.resolve([]); }
  listSessions(): Promise<NativeInventoryItem[]> { return Promise.resolve([]); }
  spawn(_options: HarnessSpawnOptions): Promise<AdapterSession> {
    const session = new CopilotSession(this.cwd);
    this.handles.push(session);
    return Promise.resolve(session);
  }
  resume(options: HarnessResumeOptions): Promise<AdapterSession> {
    this.resumes.push(options);
    const session = new CopilotSession(this.cwd, this.returnedVendorSessionId);
    this.handles.push(session);
    return Promise.resolve(session);
  }
  async close(): Promise<void> {
    await Promise.all(this.handles.map((session) => session.stop()));
  }
}

describe("trusted Copilot startup reattachment", () => {
  it("reinstalls the exact active binding once without replaying pending native work", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiplex-copilot-reattach-"));
    const filename = join(root, "runtime.sqlite");
    const runtimeNodeId = newRuntimeNodeId();
    const sessionId = newSessionId();
    const firstStore = new RuntimeNodeStore(filename);
    const first = new RuntimeNodeService({
      store: firstStore, adapters: [new CopilotAdapter(root)], runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(), name: "first", allowedRoots: [root],
    });
    try {
      const profile = first.launchProfiles()[0]!;
      const launch: LaunchRequest = {
        launchId: newLaunchId(), sessionId, runtimeNodeId, payloadHash: "startup-reattach-launch",
        profile: { providerId: profile.providerId, profileId: profile.profileId,
          contractVersion: profile.contractVersion, requestSchemaHash: profile.requestSchemaHash },
        harness: "copilot", input: { cwd: root },
      };
      first.createLaunch(launch);
      await vi.waitFor(() => expect(first.getLaunch(launch.launchId)?.state).toBe("succeeded"));
      expect(firstStore.getSession(sessionId)?.availability).toBe("active");
    } finally {
      await first.close();
      firstStore.close();
    }

    const secondStore = new RuntimeNodeStore(filename);
    const adapter = new CopilotAdapter(root);
    const second = new RuntimeNodeService({
      store: secondStore, adapters: [adapter], runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(), name: "second", allowedRoots: [root],
    });
    try {
      expect(secondStore.getSession(sessionId)).toMatchObject({ availability: "resumable", runtimeEpoch: null });
      await Promise.all([second.reattachPersistedCopilotSessions(), second.reattachPersistedCopilotSessions()]);
      expect(adapter.resumes).toHaveLength(1);
      expect(adapter.resumes[0]).toMatchObject({ harness: "copilot", continuePendingWork: false,
        vendorSessionId: "native-startup-reattach" });
      expect(secondStore.getSession(sessionId)).toMatchObject({ availability: "active",
        vendorSessionId: "native-startup-reattach", bindingRevision: 1 });
      expect(secondStore.getSession(sessionId)?.runtimeEpoch).toBe(adapter.handles[0]?.runtimeEpoch);
    } finally {
      await second.close();
      secondStore.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a mismatched native handle and stops it before the runtime can register", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiplex-copilot-reattach-fence-"));
    const store = new RuntimeNodeStore(":memory:");
    const adapter = new CopilotAdapter(root);
    const runtimeNodeId = newRuntimeNodeId();
    const first = new RuntimeNodeService({ store, adapters: [adapter], runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(), name: "first", allowedRoots: [root] });
    try {
      const profile = first.launchProfiles()[0]!;
      const launch: LaunchRequest = { launchId: newLaunchId(), sessionId: newSessionId(), runtimeNodeId,
        payloadHash: "startup-reattach-fence", profile: { providerId: profile.providerId,
          profileId: profile.profileId, contractVersion: profile.contractVersion,
          requestSchemaHash: profile.requestSchemaHash }, harness: "copilot", input: { cwd: root } };
      first.createLaunch(launch);
      await vi.waitFor(() => expect(first.getLaunch(launch.launchId)?.state).toBe("succeeded"));
      await first.close();
      adapter.returnedVendorSessionId = "wrong-native-session";
      const second = new RuntimeNodeService({ store, adapters: [adapter], runtimeNodeId,
        runtimeNodeBootId: newRuntimeNodeBootId(), name: "second", allowedRoots: [root] });
      try {
        await expect(second.reattachPersistedCopilotSessions()).rejects.toMatchObject({ code: "FENCED" });
        expect(adapter.handles.at(-1)?.status()).toBe("stopped");
        expect(store.getSession(launch.sessionId)?.availability).toBe("resumable");
      } finally { await second.close(); }
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
