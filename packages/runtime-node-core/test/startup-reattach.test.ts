import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adapterScopeIdSchema,
  emptyMetadataSnapshot,
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
  type RuntimeNodeSessionRecord,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeNodeService,
  RuntimeNodeStore,
  AdapterOutcomeUnknownError,
  AdapterResumeFailureError,
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
  returnedVendorSessionId: string | undefined;
  failResumeForVendorSessionId: string | undefined;
  spawnVendorSessionIds: string[] = [];
  resumeHook: ((options: HarnessResumeOptions) => Promise<AdapterSession>) | undefined;
  constructor(readonly cwd: string) {}
  describe(): Promise<HarnessCatalogEntry> {
    return Promise.resolve({ harness: "copilot", adapterScopeId: this.adapterScopeId, available: true, capabilities: [] });
  }
  listModels(): Promise<NativeModel[]> { return Promise.resolve([]); }
  listSessions(): Promise<NativeInventoryItem[]> { return Promise.resolve([]); }
  spawn(_options: HarnessSpawnOptions): Promise<AdapterSession> {
    const session = new CopilotSession(this.cwd, this.spawnVendorSessionIds.shift());
    this.handles.push(session);
    return Promise.resolve(session);
  }
  resume(options: HarnessResumeOptions): Promise<AdapterSession> {
    this.resumes.push(options);
    if (this.resumeHook) return this.resumeHook(options);
    if (options.vendorSessionId === this.failResumeForVendorSessionId) {
      return Promise.reject(new Error("injected native resume failure"));
    }
    const session = new CopilotSession(this.cwd, this.returnedVendorSessionId ?? options.vendorSessionId);
    this.handles.push(session);
    return Promise.resolve(session);
  }
  async close(): Promise<void> {
    await Promise.all(this.handles.map((session) => session.stop()));
  }
}

function retainedFixture(count = 3, filename = ":memory:") {
  const root = mkdtempSync(join(tmpdir(), "multiplex-copilot-startup-containment-"));
  const store = new RuntimeNodeStore(filename);
  const runtimeNodeId = newRuntimeNodeId();
  const adapter = new CopilotAdapter(root);
  const ids = Array.from({ length: count }, () => newSessionId()).sort();
  const timestamp = new Date().toISOString();
  const originals: RuntimeNodeSessionRecord[] = ids.map((sessionId, index) => ({
    sessionId, runtimeNodeId, harness: "copilot", adapterScopeId: adapter.adapterScopeId,
    vendorSessionId: `native-${index}`, bindingRevision: index + 4, runtimeEpoch: newRuntimeEpoch(),
    cwd: root, availability: "active", runtimeStatus: "idle", launchProvenance: null,
    metadata: emptyMetadataSnapshot(), createdAt: timestamp, updatedAt: timestamp,
    lastSeenAt: timestamp, lastActivityAt: timestamp,
  }));
  store.putSessions(originals);
  const service = new RuntimeNodeService({ store, adapters: [adapter], runtimeNodeId,
    runtimeNodeBootId: newRuntimeNodeBootId(), name: "retained fixture", allowedRoots: [root] });
  const stop = (index: number) => ({ operation: "stop" as const, commandId: newCommandId(),
    payloadHash: `startup-stop-${index}`, sessionId: ids[index]!, runtimeNodeId,
    bindingRevision: originals[index]!.bindingRevision });
  const close = async () => { await service.close(); store.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, store, runtimeNodeId, adapter, ids, originals, service, stop, close };
}

describe("per-binding Copilot startup containment", () => {
  it.each([0, 1])("recovers healthy siblings when retained binding %i refuses native history", async failedIndex => {
    const f = retainedFixture();
    f.adapter.failResumeForVendorSessionId = f.originals[failedIndex]!.vendorSessionId;
    try {
      const summary = await f.service.reattachPersistedCopilotSessions();
      expect(summary).toMatchObject({ reattached: 2, cancelled: 0, failures: [{ reason: "resumeFailed", action: "stopOrRetryResume" }] });
      expect(f.service.startupCopilotRecoveryFailures()).toEqual(summary.failures);
      expect(f.adapter.resumes.map(request => request.vendorSessionId)).toEqual(f.originals.map(record => record.vendorSessionId));
      expect(f.adapter.resumes.every(request => request.continuePendingWork === false)).toBe(true);
      for (const [index, original] of f.originals.entries()) {
        expect(f.store.getSession(original.sessionId)).toMatchObject({
          sessionId: original.sessionId, vendorSessionId: original.vendorSessionId,
          bindingRevision: original.bindingRevision, adapterScopeId: original.adapterScopeId,
          availability: index === failedIndex ? "resumable" : "active",
          runtimeStatus: index === failedIndex ? "error" : "idle",
        });
      }
      expect(await f.service.describe()).toMatchObject({ runtimeNodeId: f.runtimeNodeId });
    } finally { await f.close(); }
  });

  it("cancels startup intent durably when Stop races a pending native attachment", async () => {
    const f = retainedFixture(1);
    let release!: (handle: AdapterSession) => void;
    f.adapter.resumeHook = () => new Promise<AdapterSession>(resolve => { release = resolve; });
    const recovery = f.service.reattachPersistedCopilotSessions();
    try {
      await vi.waitFor(() => expect(f.adapter.resumes).toHaveLength(1));
      const request = f.stop(0);
      const stopping = f.service.stop(request);
      expect(f.store.getCommand(request.commandId)).toMatchObject({ state: "received" });
      expect(f.store.prepareStartupBindings().pendingCopilot).toHaveLength(0);
      const handle = new CopilotSession(f.root, f.originals[0]!.vendorSessionId);
      release(handle);
      await recovery;
      expect(await stopping).toMatchObject({ state: "succeeded" });
      expect(handle.status()).toBe("stopped");
      expect(f.store.getSession(f.ids[0]!)).toMatchObject({ availability: "resumable", runtimeStatus: "stopped", runtimeEpoch: null });
      expect(f.store.prepareStartupBindings().pendingCopilot).toHaveLength(0);
    } finally {
      release?.(new CopilotSession(f.root, f.originals[0]!.vendorSessionId));
      await recovery.catch(() => undefined);
      await f.close();
    }
  });

  it("does not reattach an already resumable binding after an explicit Stop and interrupted boot", async () => {
    const f = retainedFixture(1);
    try {
      expect(await f.service.stop(f.stop(0))).toMatchObject({ state: "succeeded" });
      await f.service.close();
      const adapter = new CopilotAdapter(f.root);
      const next = new RuntimeNodeService({ store: f.store, adapters: [adapter], runtimeNodeId: f.runtimeNodeId,
        runtimeNodeBootId: newRuntimeNodeBootId(), name: "interrupted recovery", allowedRoots: [f.root] });
      try {
        await next.reattachPersistedCopilotSessions();
        expect(adapter.resumes).toHaveLength(0);
        expect(f.store.getSession(f.ids[0]!)).toMatchObject({ availability: "resumable", runtimeStatus: "stopped" });
      } finally { await next.close(); }
    } finally { await f.close(); }
  });

  it("contains uncertain attachment ownership without retry or weakening a healthy sibling", async () => {
    const f = retainedFixture(2);
    f.adapter.resumeHook = async request => {
      if (request.vendorSessionId === f.originals[0]!.vendorSessionId) throw new AdapterOutcomeUnknownError("native attachment may still complete");
      return new CopilotSession(f.root, request.vendorSessionId);
    };
    try {
      await expect(f.service.reattachPersistedCopilotSessions()).resolves.toBeDefined();
      await f.service.reattachPersistedCopilotSessions();
      expect(f.adapter.resumes).toHaveLength(2);
      expect(f.store.getSession(f.ids[0]!)).toMatchObject({ availability: "resumable", runtimeStatus: "unknown", runtimeEpoch: null });
      expect(f.store.getSession(f.ids[1]!)).toMatchObject({ availability: "active", runtimeStatus: "idle" });
      expect(await f.service.stop(f.stop(0))).toMatchObject({ state: "outcomeUnknown", error: { certainty: "outcomeUnknown" } });
      expect(f.store.getStartupCopilotIntent(f.ids[0]!)).toBeUndefined();
    } finally { await f.close(); }
  });

  it("retains typed missing-history refusal and an actionable private durable receipt", async () => {
    const f = retainedFixture(1);
    f.adapter.resumeHook = async () => { throw new AdapterResumeFailureError("nativeHistoryMissing", "native error stays private", { cause: new Error("SDK load refusal") }); };
    const hook = vi.fn();
    await f.service.close();
    const service = new RuntimeNodeService({ store: f.store, adapters: [f.adapter], runtimeNodeId: f.runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(), name: "private startup diagnostics", allowedRoots: [f.root], onCopilotStartupRecoveryFailure: hook });
    try {
      const summary = await service.reattachPersistedCopilotSessions();
      expect(summary.failures).toMatchObject([{ binding: { sessionId: f.ids[0], vendorSessionId: "native-0", bindingRevision: 4 },
        reason: "nativeHistoryMissing", stage: "nativeResume", action: "stopThenArchive", error: { certainty: "definiteFailure", stage: "recovery" } }]);
      expect(f.store.listStartupCopilotFailures()).toEqual(summary.failures);
      expect(JSON.stringify(summary.failures)).not.toContain("native error stays private");
      expect(JSON.stringify(summary.failures)).not.toContain("SDK load refusal");
      expect(hook).toHaveBeenCalledWith(summary.failures[0], expect.objectContaining({ reason: "nativeHistoryMissing", cause: expect.any(Error) }));
      expect(await service.stop(f.stop(0))).toMatchObject({ state: "succeeded" });
      expect(f.store.getStartupCopilotIntent(f.ids[0]!)).toBeUndefined();
    } finally { await service.close(); await f.close(); }
  });

  it.each(["revision", "runtime"] as const)("does not cancel the startup intent for a stale Stop %s fence", async fence => {
    const f = retainedFixture(1);
    try {
      const request = { ...f.stop(0), ...(fence === "revision" ? { bindingRevision: 99 } : { runtimeNodeId: newRuntimeNodeId() }) };
      expect(await f.service.stop(request)).toMatchObject({ state: "failed", error: { code: "FENCED" } });
      expect(f.store.getStartupCopilotIntent(f.ids[0]!)).toMatchObject({ bindingRevision: 4, vendorSessionId: "native-0" });
      expect(await f.service.reattachPersistedCopilotSessions()).toMatchObject({ reattached: 1, failures: [] });
    } finally { await f.close(); }
  });

  it.each(["revision", "native", "runtime", "scope"] as const)("refuses a changed %s fence before dispatch and preserves the newer binding", async changed => {
    const f = retainedFixture(2);
    try {
      const replacement = { ...f.store.getSession(f.ids[0]!)!,
        ...(changed === "revision" ? { bindingRevision: 44 } : changed === "native" ? { vendorSessionId: "replacement-native" }
          : changed === "runtime" ? { runtimeNodeId: newRuntimeNodeId() } : { adapterScopeId: adapterScopeIdSchema.parse("replacement-scope") }) };
      f.store.putSession(replacement);
      expect(await f.service.reattachPersistedCopilotSessions()).toMatchObject({ reattached: 1, cancelled: 1, failures: [] });
      expect(f.adapter.resumes.map(request => request.vendorSessionId)).toEqual(["native-1"]);
      expect(f.store.getSession(f.ids[0]!)).toEqual(replacement);
    } finally { await f.close(); }
  });

  it("detaches only the old returned handle when its durable binding changed during resume", async () => {
    const f = retainedFixture(1);
    let release!: (handle: AdapterSession) => void;
    f.adapter.resumeHook = () => new Promise<AdapterSession>(resolve => { release = resolve; });
    const recovery = f.service.reattachPersistedCopilotSessions();
    try {
      await vi.waitFor(() => expect(f.adapter.resumes).toHaveLength(1));
      const replacement = { ...f.store.getSession(f.ids[0]!)!, bindingRevision: 99, vendorSessionId: "new-owner-native" };
      f.store.putSession(replacement);
      const old = new CopilotSession(f.root, "native-0");
      release(old);
      expect(await recovery).toMatchObject({ reattached: 0, cancelled: 1 });
      expect(old.status()).toBe("stopped");
      expect(f.store.getSession(f.ids[0]!)).toEqual(replacement);
    } finally { release?.(new CopilotSession(f.root, "native-0")); await recovery; await f.close(); }
  });

  it("never stops a healthy sibling when a faulty adapter returns its occupied native ID", async () => {
    const f = retainedFixture(2);
    const sibling = new CopilotSession(f.root, "native-0");
    f.adapter.resumeHook = async () => sibling;
    try {
      expect(await f.service.reattachPersistedCopilotSessions()).toMatchObject({ reattached: 1, failures: [{ reason: "ownershipUncertain", action: "reconcileNativeOwner" }] });
      expect(sibling.status()).toBe("idle");
      expect(f.store.getSession(f.ids[0]!)).toMatchObject({ availability: "active", runtimeEpoch: sibling.runtimeEpoch });
      expect(f.store.getSession(f.ids[1]!)).toMatchObject({ availability: "resumable", runtimeStatus: "unknown", vendorSessionId: "native-1" });
    } finally { await f.close(); }
  });

  it("keeps late cancelled-handle cleanup uncertain and reports Stop unknown while recovering a sibling", async () => {
    const f = retainedFixture(2);
    let release!: (handle: AdapterSession) => void;
    f.adapter.resumeHook = request => request.vendorSessionId === "native-0"
      ? new Promise<AdapterSession>(resolve => { release = resolve; }) : Promise.resolve(new CopilotSession(f.root, request.vendorSessionId));
    const recovery = f.service.reattachPersistedCopilotSessions();
    try {
      await vi.waitFor(() => expect(f.adapter.resumes).toHaveLength(1));
      const stop = f.service.stop(f.stop(0));
      const uncertain = new CopilotSession(f.root, "native-0");
      uncertain.stop = async () => { throw new AdapterOutcomeUnknownError("disconnect remains pending"); };
      release(uncertain);
      expect(await recovery).toMatchObject({ reattached: 1, cancelled: 1, failures: [{ stage: "commitBinding", error: { certainty: "outcomeUnknown" } }] });
      expect(await stop).toMatchObject({ state: "outcomeUnknown" });
      expect(f.store.getStartupCopilotIntent(f.ids[0]!)).toBeUndefined();
      expect(f.store.getSession(f.ids[1]!)).toMatchObject({ availability: "active", runtimeStatus: "idle" });
    } finally { release?.(new CopilotSession(f.root, "native-0")); await recovery; await f.close(); }
  });

  it.each([false, true])("survives interruption after atomic Stop admission (prior active=%s) without replaying startup", async priorActive => {
    const root = mkdtempSync(join(tmpdir(), "multiplex-copilot-stop-interrupted-"));
    const filename = join(root, "runtime.sqlite");
    const f = retainedFixture(1, filename);
    try {
      const request = f.stop(0), timestamp = new Date().toISOString();
      if (priorActive) f.store.putSession(f.originals[0]!);
      f.store.admitStopCommand({ commandId: request.commandId, payloadHash: request.payloadHash,
        sessionId: request.sessionId, runtimeNodeId: request.runtimeNodeId, state: "received", request,
        createdAt: timestamp, updatedAt: timestamp }, request);
      await f.service.close();
      f.store.close();
      const reopened = new RuntimeNodeStore(filename);
      const adapter = new CopilotAdapter(f.root);
      const service = new RuntimeNodeService({ store: reopened, adapters: [adapter], runtimeNodeId: f.runtimeNodeId,
        runtimeNodeBootId: newRuntimeNodeBootId(), name: "interrupted Stop", allowedRoots: [f.root] });
      try {
        expect(reopened.getCommand(request.commandId)).toMatchObject({ state: "outcomeUnknown", error: { stage: "recovery" } });
        await service.reattachPersistedCopilotSessions();
        expect(adapter.resumes).toHaveLength(0);
        expect(reopened.getStartupCopilotIntent(request.sessionId)).toBeUndefined();
      } finally { await service.close(); reopened.close(); }
    } finally { await f.service.close(); rmSync(f.root, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
  });

  it("an explicit Resume supersedes an older Stop but cannot erase a later Stop admitted during attachment", async () => {
    const f = retainedFixture(1);
    let release!: (handle: AdapterSession) => void;
    try {
      expect(await f.service.stop(f.stop(0))).toMatchObject({ state: "succeeded" });
      const resume = { ...f.stop(0), operation: "resume" as const, payloadHash: "explicit-resume-after-stop" };
      f.adapter.resumeHook = () => new Promise<AdapterSession>(resolve => { release = resolve; });
      const resuming = f.service.resume(resume);
      await vi.waitFor(() => expect(f.adapter.resumes).toHaveLength(1));
      const newerStop = f.stop(0);
      const stopping = f.service.stop(newerStop);
      release(new CopilotSession(f.root, "native-0"));
      expect(await resuming).toMatchObject({ state: "succeeded" });
      expect(await stopping).toMatchObject({ state: "succeeded" });
      expect(f.store.startupCopilotStopCommandId(f.originals[0]!)).toBe(newerStop.commandId);
      expect(f.store.prepareStartupBindings().pendingCopilot).toHaveLength(0);
      f.adapter.resumeHook = undefined;
      expect(await f.service.resume({ ...resume, commandId: newCommandId(), payloadHash: "explicit-new-resume-after-later-stop" })).toMatchObject({ state: "succeeded" });
      expect(f.store.startupCopilotStopCommandId(f.originals[0]!)).toBeUndefined();
      expect(f.store.prepareStartupBindings().pendingCopilot).toHaveLength(1);
    } finally { release?.(new CopilotSession(f.root, "native-0")); await f.close(); }
  });

  it("retains the original private failure receipt and exact retry intent across a real fixture-store reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiplex-copilot-startup-failure-reopen-"));
    const filename = join(root, "runtime.sqlite");
    const f = retainedFixture(2, filename);
    f.adapter.failResumeForVendorSessionId = "native-0";
    try {
      const original = (await f.service.reattachPersistedCopilotSessions()).failures;
      expect(original).toHaveLength(1);
      await f.service.close();
      f.store.close();
      const reopened = new RuntimeNodeStore(filename);
      const adapter = new CopilotAdapter(f.root);
      const service = new RuntimeNodeService({ store: reopened, adapters: [adapter], runtimeNodeId: f.runtimeNodeId,
        runtimeNodeBootId: newRuntimeNodeBootId(), name: "retained failure", allowedRoots: [f.root] });
      try {
        expect(service.startupCopilotRecoveryFailures()).toEqual(original);
        expect(reopened.getStartupCopilotIntent(f.ids[0]!)).toEqual(f.originals[0]);
        expect(adapter.resumes).toHaveLength(0);
        expect(await service.reattachPersistedCopilotSessions()).toMatchObject({ reattached: 2, failures: [] });
        expect(reopened.listStartupCopilotFailures()).toHaveLength(0);
        expect(adapter.resumes.every(request => request.continuePendingWork === false)).toBe(true);
      } finally { await service.close(); reopened.close(); }
    } finally { await f.service.close(); rmSync(f.root, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
  });
});

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
      await vi.waitFor(() => expect(first.getLaunch(launch.launchId)?.state).toBe("succeeded"), { timeout: 10_000 });
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
      await vi.waitFor(() => expect(first.getLaunch(launch.launchId)?.state).toBe("succeeded"), { timeout: 10_000 });
      await first.close();
      adapter.returnedVendorSessionId = "wrong-native-session";
      const second = new RuntimeNodeService({ store, adapters: [adapter], runtimeNodeId,
        runtimeNodeBootId: newRuntimeNodeBootId(), name: "second", allowedRoots: [root] });
      try {
      await expect(second.reattachPersistedCopilotSessions()).resolves.toMatchObject({
        reattached: 0, failures: [{ reason: "handleRejected", error: { code: "FENCED", certainty: "definiteFailure" } }],
      });
        expect(adapter.handles.at(-1)?.status()).toBe("stopped");
        expect(store.getSession(launch.sessionId)?.availability).toBe("resumable");
      } finally { await second.close(); }
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains exact reattachment intent through two interrupted boots and partial recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiplex-copilot-reattach-retry-"));
    const filename = join(root, "runtime.sqlite");
    const runtimeNodeId = newRuntimeNodeId();
    const firstStore = new RuntimeNodeStore(filename);
    const originalAdapter = new CopilotAdapter(root);
    originalAdapter.spawnVendorSessionIds = ["native-a", "native-b"];
    const first = new RuntimeNodeService({ store: firstStore, adapters: [originalAdapter], runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(), name: "first", allowedRoots: [root] });
    const ids = [newSessionId(), newSessionId()].sort();
    try {
      const profile = first.launchProfiles()[0]!;
      for (const sessionId of ids) {
        const launch: LaunchRequest = { launchId: newLaunchId(), sessionId, runtimeNodeId,
          payloadHash: `startup-reattach-${sessionId}`, profile: { providerId: profile.providerId,
            profileId: profile.profileId, contractVersion: profile.contractVersion,
            requestSchemaHash: profile.requestSchemaHash }, harness: "copilot", input: { cwd: root } };
        first.createLaunch(launch);
        await vi.waitFor(() => expect(first.getLaunch(launch.launchId)?.state).toBe("succeeded"), { timeout: 10_000 });
      }
    } finally { await first.close(); firstStore.close(); }

    const secondStore = new RuntimeNodeStore(filename);
    const second = new RuntimeNodeService({ store: secondStore, adapters: [new CopilotAdapter(root)], runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(), name: "second", allowedRoots: [root] });
    try {
      for (const sessionId of ids) expect(secondStore.getSession(sessionId)).toMatchObject({ availability: "resumable", runtimeEpoch: null });
      // Simulate a process loss after durable normalization but before resume.
    } finally { await second.close(); secondStore.close(); }

    const thirdStore = new RuntimeNodeStore(filename);
    const thirdAdapter = new CopilotAdapter(root);
    thirdAdapter.failResumeForVendorSessionId = "native-b";
    const third = new RuntimeNodeService({ store: thirdStore, adapters: [thirdAdapter], runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(), name: "third", allowedRoots: [root] });
    try {
      await expect(third.reattachPersistedCopilotSessions()).resolves.toMatchObject({ reattached: 1, failures: [{ reason: "resumeFailed" }] });
      expect(thirdAdapter.resumes).toHaveLength(2);
      expect(thirdStore.listSessions().filter((record) => record.availability === "active")).toHaveLength(1);
    } finally { await third.close(); thirdStore.close(); }

    const fourthStore = new RuntimeNodeStore(filename);
    const fourthAdapter = new CopilotAdapter(root);
    const fourth = new RuntimeNodeService({ store: fourthStore, adapters: [fourthAdapter], runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(), name: "fourth", allowedRoots: [root] });
    try {
      await fourth.reattachPersistedCopilotSessions();
      expect(fourthAdapter.resumes.map((item) => item.vendorSessionId).sort()).toEqual(["native-a", "native-b"]);
      expect(fourthAdapter.resumes.every((item) => item.continuePendingWork === false)).toBe(true);
      for (const sessionId of ids) expect(fourthStore.getSession(sessionId)?.availability).toBe("active");
    } finally {
      await fourth.close(); fourthStore.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
