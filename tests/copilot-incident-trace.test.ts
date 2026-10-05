import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NATIVE_PAYLOAD_MAX_BYTES, emptyMetadataSnapshot, initialLifecycle, newCommandId, newRuntimeEpoch, newRuntimeNodeBootId,
  newRuntimeNodeId, newSessionId } from "@arduano/agent-multiplex-protocol";
import { CopilotIncidentTracer, RuntimeNodeService, RuntimeNodeStore, copilotIncidentStateSummary,
  type AdapterEvent, type AdapterSession, type AgentAdapter, type CopilotIncidentTraceHook,
  type CopilotIncidentTraceRecord } from "../packages/runtime-node-core/src/index.js";
import { CopilotAdapterSession, CopilotSessionBridge } from "../packages/adapter-copilot/src/session.js";
import type { SessionEvent } from "@github/copilot-sdk";
import { copilotImageCodec } from "../packages/adapter-copilot/src/images.js";
import { copilotOptionalNativeTelemetry } from "../packages/adapter-copilot/src/native-event-policy.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(hook?: CopilotIncidentTraceHook) {
  const directory = mkdtempSync(join(tmpdir(), "copilot-incident-trace-"));
  const store = new RuntimeNodeStore(":memory:");
  const runtimeNodeId = newRuntimeNodeId();
  const runtimeNodeBootId = newRuntimeNodeBootId();
  const traces: CopilotIncidentTraceRecord[] = [];
  const sessions: Array<{ session: AdapterSession; listeners: Array<(event: AdapterEvent) => void> }> = [];
  const adapter: AgentAdapter = {
    harness: "copilot", adapterScopeId: "incident-trace", imageCodec: copilotImageCodec, optionalNativeTelemetry: copilotOptionalNativeTelemetry,
    describe: async () => ({ harness: "copilot", adapterScopeId: "incident-trace", available: true, capabilities: [] }),
    listModels: async () => [], listSessions: async () => [], spawn: async () => { throw new Error("unused"); },
    resume: async options => {
      const listeners: Array<(event: AdapterEvent) => void> = [];
      const session: AdapterSession = {
        harness: "copilot", adapterScopeId: "incident-trace", vendorSessionId: options.vendorSessionId,
        runtimeEpoch: newRuntimeEpoch(), cwd: directory, incidentTraceAttachmentId: sessions.length + 41,
        status: () => "idle", subscribe: listener => { listeners.push(listener); return () => undefined; },
        execute: vi.fn(async () => null), stop: async () => undefined,
        readNativeHistory: async () => ({ harness: "copilot", vendorSessionId: options.vendorSessionId, payload: [] }),
        readNativeState: async request => ({ harness: "copilot", vendorSessionId: options.vendorSessionId,
          payload: request.view === "tasks" ? { tasks: [] } : { items: [], steeringMessages: [], inFlightSteeringCount: 0 } }),
      };
      sessions.push({ session, listeners });
      return session;
    }, close: async () => undefined,
  };
  const service = new RuntimeNodeService({ store, runtimeNodeId, runtimeNodeBootId, name: "incident fixture", allowedRoots: [directory],
    adapters: [adapter], onCopilotIncidentTrace: hook ?? (record => { traces.push(record); }) });
  cleanups.push(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const add = async () => {
    const sessionId = newSessionId();
    const timestamp = new Date().toISOString();
    const target = { sessionId, runtimeNodeId, runtimeNodeBootId, bindingRevision: 1 };
    store.putSession({ sessionId, runtimeNodeId, bindingRevision: 1, harness: "copilot", adapterScopeId: "incident-trace",
      vendorSessionId: `synthetic-native-${sessionId}`, cwd: directory, runtimeEpoch: null, availability: "resumable", runtimeStatus: "stopped",
      launchProvenance: null, metadata: emptyMetadataSnapshot(), createdAt: timestamp, updatedAt: timestamp, lastSeenAt: timestamp, lastActivityAt: timestamp });
    await service.resume({ operation: "resume", commandId: newCommandId(), payloadHash: "fixture-resume", ...target });
    const active = sessions.at(-1)!;
    const emit = (event: AdapterEvent) => active.listeners.forEach(listener => listener(event));
    emit({ kind: "lifecycle", fact: { type: "interactionsHydrated", items: [], complete: true } });
    await vi.waitFor(() => expect(store.getLifecycle(sessionId)?.queue.observation.state).toBe("observed"));
    return { target, ...active, emit };
  };
  return { service, store, traces, add, sessions };
}

describe("private Copilot incident tracing", () => {
  it("correlates SDK ingress, gap and meaningful reducer transition in exact order without changing the durable schema", async () => {
    const f = await fixture(); const s = await f.add();
    const event: AdapterEvent = { kind: "native", nativeType: "unsupported-private-native-type", ephemeral: true,
      payload: { privateToken: "synthetic-provider-secret", data: "x".repeat(1_100_000) } };
    Object.defineProperty(event, "diagnosticNativeEventOrdinal", { value: 7 });
    s.emit(event);
    // The later callback arrives before asynchronous extraction rejects the
    // source. Its metadata must not replace the incident's preceding context.
    s.emit({ kind: "lifecycle", fact: { type: "rootStarted", cycleId: "synthetic-later-cycle" } });
    await vi.waitFor(() => expect(f.traces.some(trace => trace.kind === "gap")).toBe(true));
    const gap = f.traces.find(trace => trace.kind === "gap")!;
    expect(gap).toMatchObject({ sdkAttachmentId: 41, kind: "gap", nativeEventOrdinal: 7,
      decisionReason: "unknownNativeEvent", lifecycleImpact: "invalidated",
      state: { interactionCompleteness: "partial", sendAvailable: false, sendReason: "interactionStateUnknown" } });
    const transition = f.traces.find(trace => trace.kind === "transition" && trace.factType === "gap")!;
    expect(transition).toMatchObject({ nativeEventOrdinal: 7, diagnosticId: gap.kind === "gap" ? gap.diagnosticId : "unused",
      before: { continuity: "continuous", interactionCompleteness: "complete", sendAvailable: true },
      after: { continuity: "gap", interactionCompleteness: "partial", sendAvailable: false } });
    const ingress = f.traces.find(trace => trace.kind === "ingress" && trace.event.nativeEventOrdinal === 7)!;
    expect(ingress.traceSequence).toBeLessThan(transition.traceSequence);
    expect(transition.traceSequence).toBeLessThan(gap.traceSequence);
    expect(gap.recent.at(-1)).toMatchObject({ eventKind: "native", nativeEventType: "unknown", nativeEventOrdinal: 7 });
    expect(f.store.getLifecycle(s.target.sessionId)?.lastGap).not.toHaveProperty("decisionReason");
    expect(JSON.stringify(f.traces)).not.toContain("synthetic-provider-secret");
    expect(JSON.stringify(f.traces)).not.toContain(s.target.sessionId);
    expect(JSON.stringify(f.traces)).not.toContain("unsupported-private-native-type");
    s.emit({ kind: "lifecycle", fact: { type: "rootIdle", aborted: false } });
    expect((await f.service.readLifecycle(s.target.sessionId)).view.actions.send.reason).toBe("interactionStateUnknown");
  });

  it("captures callback occurrence rather than object identity for repeated queued event objects", async () => {
    const f = await fixture(); const s = await f.add();
    const event: AdapterEvent = { kind: "native", nativeType: "unsupported-private-native-type", ephemeral: true, payload: { data: "x".repeat(1_100_000) } };
    s.emit(event); s.emit(event);
    await vi.waitFor(() => expect(f.traces.filter(trace => trace.kind === "gap")).toHaveLength(2));
    const gaps = f.traces.filter(trace => trace.kind === "gap");
    const ordinals = gaps.map(trace => trace.kind === "gap" ? trace.ingressOrdinal! : 0);
    expect(ordinals[1]).toBe(ordinals[0]! + 1);
    expect(gaps[0]!.recent.at(-1)?.ingressOrdinal).toBe(ordinals[0]);
    expect(gaps[1]!.recent.at(-1)?.ingressOrdinal).toBe(ordinals[1]);
  });

  it("retains the exact invalidating cause after recent ingress rotates and optional telemetry is omitted", async () => {
    const f = await fixture(); const s = await f.add();
    s.emit({ kind: "native", nativeType: "user_input.requested", ephemeral: true,
      payload: { type: "user_input.requested", data: { requestId: "private-request", content: "x".repeat(1_100_000) } } });
    await vi.waitFor(() => expect(f.traces.some(trace => trace.kind === "gap")).toBe(true));
    const first = f.traces.find(trace => trace.kind === "gap")!;
    expect(first).toMatchObject({ lastInvalidatingGap: {
      diagnostic: { diagnosticId: first.kind === "gap" ? first.diagnosticId : "unused", code: "imageExtraction", errorClass: "schema" },
      nativeEventType: "user_input.requested", nativeEphemeral: true, payloadFailure: "wireEnvelope",
      decisionReason: "requiredNativeEvent", wireLimitBytes: NATIVE_PAYLOAD_MAX_BYTES,
    } });
    const cause = first.lastInvalidatingGap;
    for (let i = 0; i < 20; i++) s.emit({ kind: "native", nativeType: "assistant.message_delta", ephemeral: true, payload: {} });
    s.emit({ kind: "native", nativeType: "model.messages_snapshot", ephemeral: true,
      payload: { type: "model.messages_snapshot", ephemeral: true, data: { kind: "messages_snapshot", messages: ["x".repeat(1_100_000)] } } });
    await vi.waitFor(() => expect(f.traces.filter(trace => trace.kind === "gap")).toHaveLength(2));
    s.emit({ kind: "lifecycle", fact: { type: "rootIdle", aborted: false } });
    await vi.waitFor(() => expect(f.traces.some(trace => trace.kind === "transition" && trace.factType === "rootIdle")).toBe(true));
    const last = f.traces.at(-1)!;
    expect(last.lastInvalidatingGap).toEqual(cause);
    expect(Object.isFrozen(last.lastInvalidatingGap)).toBe(true);
    expect(last.recent.every(ingress => ingress.nativeEventType !== "user_input.requested")).toBe(true);
    expect((await f.service.readLifecycle(s.target.sessionId)).view.actions.send).toEqual({ available: false, reason: "interactionStateUnknown" });
    expect(JSON.stringify(f.traces)).not.toContain("private-request");
  });

  it("reports the persisted previous binding gap at recovery without applying it to replacement evidence", async () => {
    const f = await fixture(); const old = await f.add();
    old.emit({ kind: "native", nativeType: "unrecognized-private-type", ephemeral: true, payload: { content: "x".repeat(1_100_000) } });
    await vi.waitFor(() => expect(f.traces.some(trace => trace.kind === "gap")).toBe(true));
    const previousGap = f.store.getLifecycle(old.target.sessionId)!.lastGap!;
    await f.service.stop({ operation: "stop", commandId: newCommandId(), payloadHash: "cause-stop", ...old.target });
    await f.service.resume({ operation: "resume", commandId: newCommandId(), payloadHash: "cause-resume", ...old.target });
    await vi.waitFor(() => expect(f.traces.filter(trace => trace.kind === "binding" && trace.outcome === "activated")).toHaveLength(2));
    const activated = f.traces.filter(trace => trace.kind === "binding" && trace.outcome === "activated");
    expect(activated[1]).toMatchObject({ previousBindingGap: previousGap });
    expect(f.store.getLifecycle(old.target.sessionId)!.lastGap).toBeUndefined();
    expect(f.store.getLifecycle(old.target.sessionId)!.interactions.completeness).toBe("partial");
    expect(activated[1]).not.toHaveProperty("lastInvalidatingGap");
  });

  it("ignores a failed diagnostic-only persisted read during activation", async () => {
    const f = await fixture(); const old = await f.add();
    await f.service.stop({ operation: "stop", commandId: newCommandId(), payloadHash: "diagnostic-stop", ...old.target });
    vi.spyOn(f.store, "getLifecycle").mockImplementationOnce(() => { throw new Error("private-diagnostic-read-failure"); });
    await expect(f.service.resume({ operation: "resume", commandId: newCommandId(), payloadHash: "diagnostic-resume", ...old.target }))
      .resolves.toMatchObject({ state: "succeeded" });
    await vi.waitFor(() => expect(f.traces.filter(trace => trace.kind === "binding" && trace.outcome === "activated")).toHaveLength(2));
    expect(f.traces.filter(trace => trace.kind === "binding" && trace.outcome === "activated")[1]).not.toHaveProperty("previousBindingGap");
    expect(JSON.stringify(f.traces)).not.toContain("private-diagnostic-read-failure");
  });

  it.each(["runtimeNodeId", "bindingRevision"] as const)("does not attribute a previous gap from a mismatched %s", async field => {
    const f = await fixture(); const old = await f.add();
    old.emit({ kind: "native", nativeType: "unsupported", ephemeral: true, payload: { content: "x".repeat(1_100_000) } });
    await vi.waitFor(() => expect(f.traces.some(trace => trace.kind === "gap")).toBe(true));
    await f.service.stop({ operation: "stop", commandId: newCommandId(), payloadHash: "fenced-diagnostic-stop", ...old.target });
    const previous = f.store.getLifecycle(old.target.sessionId)!;
    const fence = field === "runtimeNodeId" ? { ...previous.fence, runtimeNodeId: newRuntimeNodeId() }
      : { ...previous.fence, bindingRevision: previous.fence.bindingRevision + 1 };
    f.store.putLifecycle({ ...previous, fence });
    await f.service.resume({ operation: "resume", commandId: newCommandId(), payloadHash: "fenced-diagnostic-resume", ...old.target });
    await vi.waitFor(() => expect(f.traces.filter(trace => trace.kind === "binding" && trace.outcome === "activated")).toHaveLength(2));
    expect(f.traces.filter(trace => trace.kind === "binding" && trace.outcome === "activated")[1]).not.toHaveProperty("previousBindingGap");
  });

  it("omits malformed gap context without throwing or retaining extra diagnostic data", async () => {
    const records: CopilotIncidentTraceRecord[] = [];
    const tracer = new CopilotIncidentTracer(record => { records.push(record); });
    const binding = tracer.binding("synthetic-invalid-diagnostic");
    expect(() => tracer.record(binding, { kind: "gap", diagnosticId: "synthetic-invalid", code: "eventHandling",
      lifecycleImpact: "invalidated", decisionReason: "notWireEnvelope",
      diagnostic: { privateValue: "private-diagnostic-sentinel" } as never })).not.toThrow();
    await tick();
    expect(records[0]).not.toHaveProperty("diagnostic");
    expect(records[0]).not.toHaveProperty("lastInvalidatingGap");
    expect(JSON.stringify(records)).not.toContain("private-diagnostic-sentinel");
  });

  it("keeps interleaved sessions separate, uses recent16 and carries an adapter event's original correlation through payload drain", async () => {
    const f = await fixture(); const a = await f.add(); const b = await f.add();
    for (let i = 0; i < 20; i++) {
      a.emit({ kind: "native", nativeType: "assistant.message_delta", ephemeral: true, payload: { content: `a-${i}` } });
      b.emit({ kind: "native", nativeType: "assistant.reasoning_delta", ephemeral: true, payload: { content: `b-${i}` } });
    }
    a.emit({ kind: "lifecycle", fact: { type: "rootStarted", cycleId: "synthetic-a-cycle" } });
    b.emit({ kind: "lifecycle", fact: { type: "rootStarted", cycleId: "synthetic-b-cycle" } });
    await vi.waitFor(() => expect(f.traces.filter(trace => trace.kind === "transition" && trace.factType === "rootStarted")).toHaveLength(2));
    expect(f.traces.some(trace => trace.kind === "ingress" && trace.event.nativeEventType === "assistant.reasoning_delta")).toBe(false);
    const aRecords = f.traces.filter(trace => trace.sdkAttachmentId === 41);
    const bRecords = f.traces.filter(trace => trace.sdkAttachmentId === 42);
    expect(new Set(aRecords.map(trace => trace.sessionTraceId)).size).toBe(1);
    expect(new Set(bRecords.map(trace => trace.sessionTraceId)).size).toBe(1);
    expect(aRecords[0]!.sessionTraceId).not.toBe(bRecords[0]!.sessionTraceId);
    const recent = aRecords.at(-1)!.recent;
    expect(recent).toHaveLength(16);
    expect(recent.slice(0, -1).every(event => event.nativeEventType === "assistant.message_delta")).toBe(true);
    expect(recent.at(-1)).toMatchObject({ eventKind: "lifecycle", factType: "rootStarted" });
    expect(recent.map(event => event.ingressOrdinal)).toEqual(Array.from({ length: 16 }, (_, index) => recent[0]!.ingressOrdinal + index));
  });

  it("records a late observation and event on the retired attachment without advancing its replacement", async () => {
    const f = await fixture(); const old = await f.add();
    let release!: (result: Awaited<ReturnType<NonNullable<AdapterSession["readNativeState"]>>>) => void;
    old.session.readNativeState = request => request.view === "tasks" ? new Promise(resolve => { release = resolve; })
      : Promise.resolve({ harness: "copilot", vendorSessionId: old.session.vendorSessionId, payload: { items: [], steeringMessages: [] } });
    old.emit({ kind: "lifecycle", fact: { type: "tasksInvalidated" } });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await f.service.stop({ operation: "stop", commandId: newCommandId(), payloadHash: "fixture-stop", ...old.target });
    await f.service.resume({ operation: "resume", commandId: newCommandId(), payloadHash: "fixture-resume-new", ...old.target });
    await vi.waitFor(() => expect(f.store.getLifecycle(old.target.sessionId)?.queue.observation.state).toBe("observed"));
    const replacement = f.store.getLifecycle(old.target.sessionId)!;
    old.emit({ kind: "lifecycle", fact: { type: "rootFailed" } });
    release({ harness: "copilot", vendorSessionId: old.session.vendorSessionId, payload: { tasks: [] } });
    await vi.waitFor(() => expect(f.traces.some(trace => trace.kind === "observation" && trace.outcome === "retiredBinding")).toBe(true));
    expect(f.store.getLifecycle(old.target.sessionId)).toEqual(replacement);
    const stale = f.traces.find(trace => trace.kind === "observation" && trace.outcome === "retiredBinding")!;
    expect(stale.sdkAttachmentId).toBe(41);
    expect(f.traces.some(trace => trace.kind === "ingress" && trace.outcome === "retiredBinding" && trace.sdkAttachmentId === 41)).toBe(true);
    const activated = f.traces.filter(trace => trace.kind === "binding" && trace.outcome === "activated");
    expect(activated[0]!.sessionTraceId).toBe(activated[1]!.sessionTraceId);
    expect(activated[0]!.bindingTraceId).not.toBe(activated[1]!.bindingTraceId);
  });

  it.each(["throws", "rejects", "never settles"])("a sink that %s cannot block native admission or stop", async mode => {
    const hook = vi.fn((_record: CopilotIncidentTraceRecord) => {
      if (mode === "throws") throw new Error("fixture-log-failed");
      if (mode === "rejects") return Promise.reject(new Error("fixture-log-failed"));
      return new Promise<void>(() => undefined);
    });
    const f = await fixture(hook); const s = await f.add();
    s.emit({ kind: "lifecycle", fact: { type: "rootStarted", cycleId: "synthetic-native-cycle" } });
    expect((await f.service.readLifecycle(s.target.sessionId)).view.status).toBe("working");
    await expect(f.service.stop({ operation: "stop", commandId: newCommandId(), payloadHash: "fixture-stop", ...s.target })).resolves.toMatchObject({ state: "succeeded" });
    await tick();
    expect(hook).toHaveBeenCalled();
    if (mode === "never settles") expect(hook).toHaveBeenCalledTimes(1);
  });

  it("bounds a hung hook queue, reports suppression, and reserves admission for incidents", async () => {
    const received: CopilotIncidentTraceRecord[] = [];
    let release!: () => void;
    const tracer = new CopilotIncidentTracer(record => {
      received.push(record);
      if (received.length === 1) return new Promise<void>(resolve => { release = resolve; });
    });
    const binding = tracer.binding("synthetic-session", 4);
    tracer.record(binding, { kind: "binding", outcome: "activated" });
    await tick();
    for (let i = 0; i < 300; i++) {
      const event = tracer.ingress(binding, { kind: "native", nativeType: "assistant.message_delta", ephemeral: true, payload: {} });
      tracer.record(binding, { kind: "ingress", event, outcome: "received" });
    }
    tracer.record(binding, { kind: "gap", diagnosticId: "synthetic-diagnostic", code: "queueOverflow", decisionReason: "notWireEnvelope", lifecycleImpact: "invalidated" });
    expect(received).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(received.some(record => record.kind === "gap")).toBe(true));
    expect(received).toHaveLength(129);
    expect(received[1]!.suppressedRecords).toBe(173);
    expect(received.at(-1)!.recent).toHaveLength(16);
  });

  it("preserves critical gap evidence through a burst of ordinary transitions", async () => {
    const received: CopilotIncidentTraceRecord[] = [];
    const tracer = new CopilotIncidentTracer(record => { received.push(record); });
    const binding = tracer.binding("synthetic-priority-session");
    tracer.record(binding, { kind: "gap", diagnosticId: "synthetic-priority-gap", code: "queueOverflow",
      decisionReason: "notWireEnvelope", lifecycleImpact: "invalidated" });
    for (let i = 0; i < 1_000; i++) tracer.record(binding, { kind: "transition", factType: "rootStarted", outcome: "applied" });
    await vi.waitFor(() => expect(received).toHaveLength(128));
    expect(received[0]).toMatchObject({ kind: "gap", diagnosticId: "synthetic-priority-gap", suppressedRecords: 873 });
  });

  it("refuses ordinary records when the bounded queue contains only critical evidence", async () => {
    const received: CopilotIncidentTraceRecord[] = [];
    const tracer = new CopilotIncidentTracer(record => { received.push(record); });
    const binding = tracer.binding("synthetic-critical-session");
    for (let i = 0; i < 128; i++) tracer.record(binding, { kind: "observation", view: "tasks", outcome: "failed",
      generation: 1, failures: i + 1, deadlineAgeMs: i });
    tracer.record(binding, { kind: "transition", factType: "rootStarted", outcome: "applied" });
    tracer.record(binding, { kind: "recovery", outcome: "scheduled", generation: 1 });
    await vi.waitFor(() => expect(received).toHaveLength(128));
    expect(received.some(record => record.kind === "transition")).toBe(false);
    expect(received.filter(record => record.kind === "observation")).toHaveLength(127);
    expect(received.at(-1)).toMatchObject({ kind: "recovery", outcome: "scheduled" });
    expect(received[0]!.suppressedRecords).toBe(2);
  });

  it("isolates a throwing then getter and continues dispatching the next record", async () => {
    const received: CopilotIncidentTraceRecord[] = [];
    const tracer = new CopilotIncidentTracer(record => {
      received.push(record);
      if (received.length === 1) return Object.defineProperty({}, "then", { get: () => { throw new Error("fixture-then-getter"); } }) as Promise<void>;
    });
    const binding = tracer.binding("synthetic-session");
    tracer.record(binding, { kind: "binding", outcome: "activated" });
    tracer.record(binding, { kind: "binding", outcome: "retired" });
    await tick();
    expect(received.map(record => record.kind === "binding" ? record.outcome : "other")).toEqual(["activated", "retired"]);
  });

  it("reports a refused old-revision observation while the fresh observation owns certainty", async () => {
    const f = await fixture(); const s = await f.add();
    let release!: (result: Awaited<ReturnType<NonNullable<AdapterSession["readNativeState"]>>>) => void;
    let reads = 0;
    s.session.readNativeState = async request => {
      if (request.view === "tasks") {
        reads += 1;
        if (reads === 1) return new Promise(resolve => { release = resolve; });
        return { harness: "copilot", vendorSessionId: s.session.vendorSessionId, payload: { tasks: [] } };
      }
      return { harness: "copilot", vendorSessionId: s.session.vendorSessionId, payload: { items: [], steeringMessages: [] } };
    };
    s.emit({ kind: "lifecycle", fact: { type: "tasksInvalidated" } });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    s.emit({ kind: "lifecycle", fact: { type: "tasksInvalidated" } });
    release({ harness: "copilot", vendorSessionId: s.session.vendorSessionId, payload: { tasks: [{ id: "synthetic-stale-task", type: "shell", status: "running" }] } });
    await vi.waitFor(() => expect(f.traces.find(trace => trace.kind === "observation" && trace.outcome === "staleRevision"))
      .toMatchObject({ revision: 1, currentRevision: 2 }));
    await vi.waitFor(() => expect(f.store.getLifecycle(s.target.sessionId)?.tasks.observation.state).toBe("observed"));
    expect(f.store.getLifecycle(s.target.sessionId)?.tasks).toMatchObject({ revision: 2, items: [] });
  });

  it("the bridge shares one native ordinal with facts without changing serialized envelopes", () => {
    const bridge = new CopilotSessionBridge(); const events: AdapterEvent[] = [];
    bridge.subscribe(event => events.push(event));
    bridge.nativeEvent({ type: "assistant.turn_start", id: "synthetic-event", data: {}, ephemeral: false } as SessionEvent);
    expect(events.find(event => event.kind === "native")?.diagnosticNativeEventOrdinal).toBe(1);
    expect(events.find(event => event.kind === "lifecycle")?.diagnosticNativeEventOrdinal).toBe(1);
    expect(JSON.stringify(events)).not.toContain("diagnosticNativeEventOrdinal");
    bridge.nativeEvent({ type: "assistant.turn_end", id: "synthetic-end", data: {}, ephemeral: false } as SessionEvent);
    expect(events.filter(event => event.kind === "native").map(event => event.diagnosticNativeEventOrdinal)).toEqual([1, 2]);
  });

  it("carries the embedding SDK attachment ordinal into the runtime adapter handle", () => {
    const session = new CopilotAdapterSession({ adapterScopeId: "incident-trace", cwd: null, runtimeEpoch: newRuntimeEpoch(),
      bridge: new CopilotSessionBridge(), settings: {}, onStopped: () => undefined,
      native: { sessionId: "synthetic-sdk-session", incidentTraceAttachmentId: 41, rpc: { mode: { set: async () => undefined } },
        send: async () => "synthetic-message", abort: async () => undefined, setModel: async () => undefined,
        getEvents: async () => [], disconnect: async () => undefined } });
    expect(session.incidentTraceAttachmentId).toBe(41);
  });

  it("state summaries keep genuine waiting and unattributed uncertainty distinct", () => {
    const state = initialLifecycle({ sessionId: newSessionId(), runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId(), bindingRevision: 1, runtimeEpoch: newRuntimeEpoch() });
    expect(copilotIncidentStateSummary(state)).toMatchObject({ interactionCompleteness: "partial", sendReason: "interactionStateUnknown" });
    const pending = { ...state, interactions: { completeness: "complete" as const, items: [{ id: "synthetic-pending", kind: "userInput" as const, owner: "root" as const }] } };
    expect(copilotIncidentStateSummary(pending)).toMatchObject({ pendingInteractions: 1, rootPendingInteractions: 1, sendReason: "waitingForInput" });
  });
});
