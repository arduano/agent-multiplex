import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@github/copilot-sdk";
import {
  adapterScopeIdSchema, newLaunchId, newRuntimeEpoch, newRuntimeNodeBootId, newRuntimeNodeId, newSessionId,
  NATIVE_PAYLOAD_MAX_BYTES, packNativePayload, type JsonValue, type LaunchRequest,
} from "@arduano/agent-multiplex-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CopilotAttachmentDriver, RuntimeLifecycleJournal, RuntimeNodeService, RuntimeNodeStore,
  type AdapterEvent, type AgentAdapter, type CopilotIncidentTraceRecord,
} from "../src/index.js";
import { CopilotAdapterSession, CopilotSessionBridge, type CopilotSessionRpc } from "../../adapter-copilot/src/session.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
function event(type: string, data: object = {}): SessionEvent {
  return { type, data, id: type, timestamp: "2026-10-08T00:00:00.000Z", parentId: null } as SessionEvent;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe("exact Copilot attachment observation ownership", () => {
  it("allows two slow Windows views to share the read lane without premature degradation", async () => {
    vi.useFakeTimers();
    const driver = new CopilotSessionBridge("windows-budget", 60_000).observationDriver;
    const tasks = deferred<object>();
    const queue = deferred<object>();
    const failed = vi.fn();
    const recovered = vi.fn();
    const read = vi.fn((view: "tasks" | "pendingMessages") => {
      const ticket = driver.capture(view);
      return (view === "tasks" ? tasks : queue).promise.then(value => driver.certify(ticket, value));
    });
    try {
      driver.observe({ active: () => true, revision: () => 0, read, trace: () => {}, failed, recovered });
      driver.request("tasks"); driver.request("pendingMessages");
      await vi.advanceTimersByTimeAsync(50_000);
      expect(failed).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledOnce();
      tasks.resolve({}); await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledWith("pendingMessages");
      await vi.advanceTimersByTimeAsync(50_000);
      expect(failed).not.toHaveBeenCalled();
      queue.resolve({}); await vi.advanceTimersByTimeAsync(0);
      expect(recovered.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally { driver.retire(); vi.useRealTimers(); }
  });

  it.each([[15_000, 45_000], [60_000, 180_000]])(
    "keeps the read-budget %i no-success watchdog bounded at %i despite periodic requests", async (readTimeoutMs, noSuccessMs) => {
      vi.useFakeTimers();
      const driver = new CopilotAttachmentDriver({ readTimeoutMs });
      const failed = vi.fn();
      try {
        driver.observe({ active: () => true, revision: () => 0, read: () => new Promise<object>(() => {}),
          trace: () => {}, failed, recovered: () => {} });
        driver.request("tasks");
        await vi.advanceTimersByTimeAsync(noSuccessMs - 1);
        driver.request("tasks");
        expect(failed).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(failed).toHaveBeenCalledTimes(1);
        expect(failed).toHaveBeenCalledWith(expect.objectContaining({ view: "tasks", stalled: true }));
        driver.retire();
        await vi.advanceTimersByTimeAsync(noSuccessMs);
        expect(failed).toHaveBeenCalledTimes(1);
      } finally { driver.retire(); vi.useRealTimers(); }
    });

  it("rejects forged, copied, cross-attachment and gap-invalidated snapshot evidence", () => {
    const driver = new CopilotAttachmentDriver();
    const other = new CopilotAttachmentDriver();
    const ticket = driver.capture("tasks");
    const result = driver.certify(ticket, { tasks: [] });
    expect(driver.accept("tasks", result)).toBe(ticket);
    expect(Object.keys(result)).toEqual(["tasks"]);
    expect(JSON.stringify(result)).toBe('{"tasks":[]}');
    expect(() => driver.accept("tasks", { ...result })).toThrow("exact attachment evidence");
    expect(() => other.accept("tasks", result)).toThrow("exact attachment evidence");
    expect(() => driver.certify({ ...ticket }, {})).toThrow("invalidated");
    expect(() => driver.accept("agents", result)).toThrow("exact attachment evidence");
    driver.gap();
    expect(() => driver.accept("tasks", result)).toThrow("invalidated");
    driver.retire();
    expect(() => driver.certify(ticket, {})).toThrow("retired");
  });

  it("keeps one native envelope and its lifecycle facts together under reentrant SDK callbacks", () => {
    const bridge = new CopilotSessionBridge();
    const received: AdapterEvent[] = [];
    bridge.subscribe(item => {
      received.push(item);
      if (item.kind === "native" && item.nativeType === "assistant.turn_start") bridge.nativeEvent(event("session.idle"));
    });
    bridge.nativeEvent(event("assistant.turn_start", { turnId: "root-turn" }));
    const ordered = received.filter(item => item.kind === "native" || item.kind === "lifecycle");
    expect(ordered.map(item => item.kind === "native" ? item.nativeType : item.kind === "lifecycle" ? item.fact.type : "")).toEqual([
      "assistant.turn_start", "rootStarted", "session.idle", "rootIdle",
    ]);
    expect(ordered.map(item => item.diagnosticNativeEventOrdinal)).toEqual([1, 1, 2, 2]);
    expect(received.at(-1)).toMatchObject({ kind: "status", status: "idle" });
    bridge.close();
  });

  it("retires queued reentrant ingress without executing or certifying it", () => {
    const driver = new CopilotAttachmentDriver();
    const late = vi.fn();
    driver.ingress(() => { driver.ingress(late); driver.retire(); });
    driver.ingress(late);
    expect(late).not.toHaveBeenCalled();
    expect(driver.currentNativeEventOrdinal).toBeUndefined();
  });

  it("retains an invalidation admitted reentrantly by the Runtime recovery hook", async () => {
    const driver = new CopilotAttachmentDriver();
    const reads: string[] = [];
    let invalidated = false;
    driver.observe({
      active: () => true,
      revision: view => driver.version(view),
      read: async view => { reads.push(view); return driver.certify(driver.capture(view), {}); },
      trace: () => {}, failed: () => { throw new Error("Fixture observation must succeed"); },
      recovered: () => {
        if (!invalidated) {
          invalidated = true;
          driver.invalidate("tasks");
          driver.request("tasks");
        }
      },
    });
    driver.request("tasks");
    driver.request("pendingMessages");
    await vi.waitFor(() => expect(reads.filter(view => view === "tasks")).toHaveLength(2));
    expect(reads.filter(view => view === "pendingMessages")).toHaveLength(1);
    driver.retire();
  });
});

async function installed(options: {
  refresh?(bridge: CopilotSessionBridge): Promise<void>;
  list?(bridge: CopilotSessionBridge): Promise<unknown>;
  completeInteractions?: boolean;
  externalize?(payload: JsonValue): Promise<ReturnType<typeof packNativePayload>>;
  nativeEventQueueLimit?: number;
} = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "multiplex-attachment-driver-"));
  const store = new RuntimeNodeStore(":memory:");
  const bridge = new CopilotSessionBridge();
  bridge.interactionHydration(options.completeInteractions ?? true);
  const refresh = vi.fn(async () => {
    bridge.nativeEvent(event("session.background_tasks_changed"));
    await options.refresh?.(bridge);
  });
  const list = vi.fn(async () => options.list ? options.list(bridge) : { tasks: [] });
  const rpc: CopilotSessionRpc = { mode: { set: async () => {} }, tasks: { refresh, list },
    queue: { pendingItems: async () => ({ items: [], steeringMessages: [] }), sendNow: async () => ({ steered: false }) } };
  const session = new CopilotAdapterSession({ adapterScopeId: adapterScopeIdSchema.parse("attachment-driver-test"),
    cwd, runtimeEpoch: newRuntimeEpoch(), bridge, settings: {}, onStopped: () => {},
    native: { sessionId: "native-attachment-driver", rpc, send: async () => { throw new Error("No model calls allowed"); },
      abort: async () => {}, setModel: async () => {}, getEvents: async () => [], disconnect: async () => {} } });
  const adapter: AgentAdapter = { harness: "copilot", adapterScopeId: session.adapterScopeId,
    ...(options.externalize ? { imageCodec: { externalize: options.externalize } } : {}),
    describe: async () => ({ harness: "copilot", adapterScopeId: session.adapterScopeId, available: true, capabilities: [] }),
    listModels: async () => [], listSessions: async () => [], spawn: async () => session,
    resume: async () => { throw new Error("No replacement attachment allowed"); }, close: () => session.stop() };
  const runtimeNodeId = newRuntimeNodeId();
  const traces: CopilotIncidentTraceRecord[] = [];
  const service = new RuntimeNodeService({ store, runtimeNodeId, runtimeNodeBootId: newRuntimeNodeBootId(),
    name: "attachment driver fixture", adapters: [adapter], allowedRoots: [cwd],
    ...(options.nativeEventQueueLimit ? { nativeEventQueueLimit: options.nativeEventQueueLimit } : {}),
    onCopilotIncidentTrace: trace => { traces.push(trace); } });
  cleanups.push(async () => { await service.close(); store.close(); rmSync(cwd, { recursive: true, force: true }); });
  const profile = service.launchProfiles()[0]!;
  const launch: LaunchRequest = { launchId: newLaunchId(), sessionId: newSessionId(), runtimeNodeId, payloadHash: "attachment-driver-fixture",
    profile: { providerId: profile.providerId, profileId: profile.profileId, contractVersion: profile.contractVersion, requestSchemaHash: profile.requestSchemaHash },
    harness: "copilot", input: { cwd } };
  service.createLaunch(launch);
  await vi.waitFor(() => expect(service.getLaunch(launch.launchId)?.state).toBe("succeeded"));
  const state = async () => new RuntimeLifecycleJournal(store).read((await service.readLifecycle(launch.sessionId)).fence);
  return { service, store, launch, session, bridge, state, refresh, list, traces };
}

describe("real Copilot bridge and Runtime driver integration", () => {
  it("accepts one refreshed task list after its refresh emits native invalidation", async () => {
    const f = await installed();
    await vi.waitFor(async () => expect(await f.state()).toMatchObject({
      tasks: { revision: 1, observation: { state: "observed" } }, queue: { observation: { state: "observed" } },
    }));
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.list).toHaveBeenCalledOnce();
    expect(f.traces.filter(trace => trace.kind === "observation" && trace.view === "tasks" && trace.outcome === "accepted")).toMatchObject([
      { revision: 1, currentRevision: 1 },
    ]);
    expect(f.traces.some(trace => trace.kind === "observation" && trace.outcome === "staleRevision")).toBe(false);
  });

  it("fences a list invalidated after capture and follows it once", async () => {
    let reads = 0;
    const f = await installed({ list: async bridge => {
      if (++reads === 1) bridge.nativeEvent(event("session.background_tasks_changed"));
      return { tasks: [] };
    } });
    await vi.waitFor(async () => expect(await f.state()).toMatchObject({
      tasks: { revision: 3, observation: { state: "observed" } }, queue: { observation: { state: "observed" } },
    }));
    expect(f.list).toHaveBeenCalledTimes(2);
    expect(f.traces.some(trace => trace.kind === "observation" && trace.outcome === "staleRevision")).toBe(true);
  });

  it("reports a malformed post-refresh snapshot as current failure rather than ignoring it as stale", async () => {
    let reads = 0;
    const f = await installed({ list: async () => ++reads === 1 ? { tasks: [{}] } : { tasks: [] } });
    await vi.waitFor(async () => expect((await f.state()).tasks.observation.state).toBe("observed"));
    expect(f.list).toHaveBeenCalledTimes(2);
    expect(f.traces).toContainEqual(expect.objectContaining({ kind: "observation", view: "tasks", outcome: "failed",
      revision: 1, currentRevision: 1, failureReason: "snapshotMalformed" }));
    expect(f.traces.some(trace => trace.kind === "observation" && trace.outcome === "staleRevision")).toBe(false);
  });

  it.each(["payload admission", "queue overflow"] as const)("invalidates an in-flight list on Runtime %s gap and preserves interaction uncertainty", async cause => {
    const first = deferred<unknown>();
    const extracted = deferred<void>();
    let reads = 0;
    const f = await installed({ completeInteractions: false, list: async () => ++reads === 1 ? first.promise : { tasks: [] },
      ...(cause === "queue overflow" ? { nativeEventQueueLimit: 4, externalize: async (payload: JsonValue) => {
        if (payload && typeof payload === "object" && !Array.isArray(payload) && payload.type === "assistant.message") await extracted.promise;
        return packNativePayload(payload);
      } } : {}) });
    cleanups.unshift(async () => { extracted.resolve(); first.resolve({ tasks: [] }); });
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
    if (cause === "queue overflow") {
      for (let index = 0; index < 5; index += 1) f.bridge.nativeEvent(event("assistant.message", { content: `queued payload ${index}` }));
    } else f.bridge.nativeEvent(event("assistant.message", { content: "x".repeat(NATIVE_PAYLOAD_MAX_BYTES + 256) }));
    // readLifecycle deliberately drains admitted payload extraction. Inspect
    // the durable gap first while that exact extraction is still held.
    await vi.waitFor(() => expect(f.store.getLifecycle(f.launch.sessionId)?.lastGap?.code).toBe(cause === "queue overflow" ? "queueOverflow" : "eventHandling"));
    extracted.resolve();
    first.resolve({ tasks: [] });
    await vi.waitFor(async () => expect(await f.state()).toMatchObject({
      continuity: "gap", tasks: { observation: { state: "observed" } }, queue: { observation: { state: "observed" } },
      interactions: { completeness: "partial" },
    }));
    expect(f.list).toHaveBeenCalledTimes(2);
    expect(f.traces.some(trace => trace.kind === "observation" && trace.outcome === "staleRevision")).toBe(true);
    expect((await f.service.readLifecycle(f.launch.sessionId)).view.actions.send.available).toBe(false);
  });
});
