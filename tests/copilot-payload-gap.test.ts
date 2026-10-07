import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_PAYLOAD_MAX_BYTES, emptyMetadataSnapshot, jsonWireByteUpperBound,
  nativeGapDiagnosticSchema, nativePayloadValidationFailure, parseNativePayload, newCommandId, newRuntimeEpoch, newRuntimeNodeBootId,
  newRuntimeNodeId, newSessionId, type AdapterScopeId, type JsonValue,
  type RuntimeNodeEventItem,
} from "@arduano/agent-multiplex-protocol";
import { copilotImageCodec } from "../packages/adapter-copilot/src/images.js";
import { copilotOptionalNativeTelemetry } from "../packages/adapter-copilot/src/native-event-policy.js";
import { CopilotAttachmentDriver, RuntimeNodeService, RuntimeNodeStore, type AdapterEvent, type AdapterSession, type AgentAdapter, type NativeGapLogDiagnostic, type NativeImageCodec, type CopilotIncidentTraceRecord } from "../packages/runtime-node-core/src/index.js";

type NativeEvent = Extract<AdapterEvent, { kind: "native" }>;
const releases: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0)) await release(); });
const sizes = [1_297_380, 1_721_340];
const recurrenceSizes = [1_108_461, 2_257_381, 2_062_694];
const privateType = "PRIVATE_NATIVE_EVENT_TYPE";
const privateId = "PRIVATE_NATIVE_EVENT_ID";
const privatePath = "C:/private-owner/workspace/secret.txt";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC2cAAAAASUVORK5CYII=";

function native(payload: JsonValue): NativeEvent {
  return { kind: "native", nativeType: privateType, payload, ephemeral: true };
}
function bytes(event: NativeEvent): number { return Buffer.byteLength(JSON.stringify(event)); }
function textEvent(size: number): NativeEvent {
  const data = { messages: [{ role: "user", content: [{ type: "text", text: privatePath }] }] };
  const event = native({ type: "model.messages_snapshot", id: privateId, data });
  data.messages[0]!.content[0]!.text += "x".repeat(size - bytes(event));
  expect(bytes(event)).toBe(size);
  return event;
}
function imageEvent(size: number): NativeEvent {
  const image = { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } };
  const data = { messages: [{ role: "user", content: [image] }], padding: "" };
  const event = native({ type: "model.messages_snapshot", id: privateId, data });
  const padding = size - bytes(event);
  image.image_url.url = `data:image/png;base64,${Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(Math.floor(padding / 4) * 3)]).toString("base64")}`;
  data.padding = "x".repeat(padding % 4);
  expect(bytes(event)).toBe(size);
  return event;
}

function optionalSnapshot(size: number): NativeEvent {
  const event = textEvent(size);
  event.nativeType = "model.messages_snapshot";
  const payload = event.payload as Record<string, JsonValue>;
  payload.ephemeral = true;
  const data = payload.data as { kind?: string; messages: Array<{ content: Array<{ text: string }> }> };
  data.kind = "messages_snapshot";
  const text = data.messages[0]!.content[0]!;
  text.text += "x".repeat(Math.max(0, size - bytes(event)));
  text.text = text.text.slice(0, text.text.length - (bytes(event) - size));
  expect(bytes(event)).toBe(size);
  return event;
}

function fixture(options: { imageCodec?: NativeImageCodec; nativeEventQueueBytes?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "copilot-payload-gap-"));
  const store = new RuntimeNodeStore(join(directory, "runtime.sqlite"));
  const target = { sessionId: newSessionId(), runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId(), bindingRevision: 1 };
  const scope = "copilot:synthetic-gap" as AdapterScopeId;
  const timestamp = new Date().toISOString();
  let emit!: (event: AdapterEvent) => void;
  const gaps: NativeGapLogDiagnostic[] = [];
  const traces: CopilotIncidentTraceRecord[] = [];
  const execute = vi.fn(async () => null);
  const copilotObservationDriver = new CopilotAttachmentDriver();
  const session: AdapterSession = {
    copilotObservationDriver, harness: "copilot", adapterScopeId: scope, vendorSessionId: "synthetic-native-session",
    cwd: directory, runtimeEpoch: newRuntimeEpoch(), status: () => "idle", execute,
    subscribe: (listener) => { emit = listener; return () => undefined; }, stop: async () => undefined,
    readNativeHistory: async () => ({ harness: "copilot", vendorSessionId: "synthetic-native-session", payload: [] }),
    readNativeState: async (request) => copilotObservationDriver.certify(copilotObservationDriver.capture(request.view === "tasks" ? "tasks" : "pendingMessages"),
      { harness: "copilot", vendorSessionId: "synthetic-native-session", view: request.view,
        payload: request.view === "tasks" ? { tasks: [] } : { items: [], steeringMessages: [], inFlightSteeringCount: 0 } }),
  };
  const adapter: AgentAdapter = {
    harness: "copilot", adapterScopeId: scope, imageCodec: options.imageCodec ?? copilotImageCodec, optionalNativeTelemetry: copilotOptionalNativeTelemetry,
    describe: async () => ({ harness: "copilot", adapterScopeId: scope, available: true, capabilities: [] }),
    listModels: async () => [], listSessions: async () => [], spawn: async () => session, resume: async () => session, close: async () => undefined,
  };
  store.putSession({ sessionId: target.sessionId, runtimeNodeId: target.runtimeNodeId, bindingRevision: target.bindingRevision,
    harness: "copilot", adapterScopeId: scope, vendorSessionId: session.vendorSessionId,
    cwd: directory, runtimeEpoch: null, availability: "resumable", runtimeStatus: "stopped", launchProvenance: null,
    metadata: emptyMetadataSnapshot(), createdAt: timestamp, updatedAt: timestamp, lastSeenAt: timestamp, lastActivityAt: timestamp });
  const service = new RuntimeNodeService({ store, runtimeNodeId: target.runtimeNodeId, runtimeNodeBootId: target.runtimeNodeBootId,
    adapters: [adapter], allowedRoots: [directory], name: "synthetic payload diagnosis", onNativeGapDiagnostic: (diagnostic) => gaps.push(diagnostic),
    onCopilotIncidentTrace: trace => { traces.push(trace); },
    ...(options.nativeEventQueueBytes === undefined ? {} : { nativeEventQueueBytes: options.nativeEventQueueBytes }) });
  releases.push(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, service, target, session, adapter, execute, gaps, traces, emit: (event: AdapterEvent) => {
    if (event.kind === "lifecycle" && event.fact.type === "tasksInvalidated") copilotObservationDriver.invalidate("tasks");
    if (event.kind === "lifecycle" && event.fact.type === "queueInvalidated") copilotObservationDriver.invalidate("pendingMessages");
    emit(event);
  } };
}

describe("synthetic Copilot imageExtraction/schema gap diagnosis", () => {
  it.each(sizes)("reproduces an exact %i-byte admission as wireEnvelope and preserves recovery fencing", async (size) => {
    const f = fixture();
    await f.service.resume({ operation: "resume", commandId: newCommandId(), payloadHash: "synthetic-resume", ...f.target });
    f.emit({ kind: "lifecycle", fact: { type: "interactionsHydrated", items: [], complete: true } });
    f.emit({ kind: "lifecycle", fact: { type: "rootStarted", cycleId: "synthetic-cycle" } });
    const event = textEvent(size);
    f.emit(event);
    await vi.waitFor(() => expect(f.gaps).toHaveLength(1));
    expect(f.gaps[0]).toMatchObject({ code: "imageExtraction", errorClass: "schema", payloadFailure: "wireEnvelope",
      eventKind: "native", eventBytes: size, pendingEventBytes: size, pendingEvents: 1 });
    const stored = f.store.getLifecycle(f.target.sessionId)!;
    expect(stored.continuity).toBe("gap");
    const { payloadFailure: _failure, nativeEventType: _type, nativeEphemeral: _ephemeral,
      wireUpperBoundBytes: _bound, wireLimitBytes: _limit, lifecycleImpact: _impact, ...durableDiagnostic } = f.gaps[0]!;
    expect(stored.lastGap).toEqual(durableDiagnostic);
    expect(nativeGapDiagnosticSchema.parse(stored.lastGap)).toEqual(durableDiagnostic);
    expect(nativeGapDiagnosticSchema.safeParse(f.gaps[0]).success).toBe(false);
    expect(stored.interactions.completeness).toBe("partial");
    const serialized = JSON.stringify(f.gaps);
    for (const secret of [privateType, privateId, privatePath, f.target.sessionId, f.session.vendorSessionId]) expect(serialized).not.toContain(secret);
    expect(serialized.length).toBeLessThan(1_024);
    const rejected = await f.service.execute({ commandId: newCommandId(), payloadHash: "synthetic-blocked-send", ...f.target,
      request: { harness: "copilot", command: { type: "send", prompt: "synthetic never-dispatched", mode: "enqueue" } } });
    expect(rejected).toMatchObject({ state: "failed", error: { code: "UNAVAILABLE", certainty: "definiteFailure" } });
    expect(f.execute).not.toHaveBeenCalled();
    f.emit({ kind: "lifecycle", fact: { type: "rootIdle", aborted: false } });
    await vi.waitFor(() => expect(f.store.getLifecycle(f.target.sessionId)?.root.phase).toBe("idle"));
    expect(f.store.getLifecycle(f.target.sessionId)?.interactions.completeness).toBe("partial");
    expect((await f.service.readLifecycle(f.target.sessionId)).view.health.issues).toContainEqual({
      scope: "lifecycle", code: "incompleteNativeState", diagnosticId: f.gaps[0]!.diagnosticId,
    });
    await expect(f.service.stop({ operation: "stop", commandId: newCommandId(), payloadHash: "synthetic-stop", ...f.target }))
      .resolves.toMatchObject({ state: "succeeded" });
  });

  it.each(sizes)("admits recognized inline image content at the same %i pre-externalization bytes", async (size) => {
    const event = imageEvent(size);
    const sink = { storeBase64: vi.fn(async () => ({ unavailable: true as const, reason: "missing" as const })),
      snapshotPath: vi.fn(async () => ({ unavailable: true as const, reason: "missing" as const })) };
    const envelope = await copilotImageCodec.externalize(event.payload, sink);
    expect(envelope.images).toHaveLength(1);
    expect(jsonWireByteUpperBound(envelope)).toBeLessThan(NATIVE_PAYLOAD_MAX_BYTES);
    expect(sink.storeBase64).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(envelope)).not.toContain("AAAA".repeat(100));
  });

  it("keeps opaque tool output native and classifies its oversize without treating it as an image", async () => {
    const event = native({ type: "tool.execution_complete", id: privateId, data: { result: {
      structuredContent: { type: "image", mimeType: "image/png", data: "x".repeat(1_297_380) },
    } } });
    const sink = { storeBase64: vi.fn(), snapshotPath: vi.fn() };
    let error: unknown;
    try { await copilotImageCodec.externalize(event.payload, sink); }
    catch (caught) { error = caught; }
    expect(nativePayloadValidationFailure(error)).toBe("wireEnvelope");
    expect(sink.storeBase64).not.toHaveBeenCalled();
    expect(sink.snapshotPath).not.toHaveBeenCalled();
  });
});

describe("optional Copilot telemetry and authoritative admission", () => {
  async function idleFixture(options?: Parameters<typeof fixture>[0]) {
    const f = fixture(options);
    await f.service.resume({ operation: "resume", commandId: newCommandId(), payloadHash: "telemetry-resume", ...f.target });
    f.emit({ kind: "lifecycle", fact: { type: "childrenHydrated", items: [], complete: true } });
    f.emit({ kind: "lifecycle", fact: { type: "interactionsHydrated", items: [], complete: true } });
    f.emit({ kind: "lifecycle", fact: { type: "rootStarted", cycleId: "telemetry-cycle" } });
    f.emit({ kind: "lifecycle", fact: { type: "rootIdle", aborted: false } });
    await vi.waitFor(async () => {
      expect((await f.service.readLifecycle(f.target.sessionId)).view.actions.send.available).toBe(true);
      expect(f.store.getLifecycle(f.target.sessionId)?.tasks.observation.state).toBe("observed");
      expect(f.store.getLifecycle(f.target.sessionId)?.queue.observation.state).toBe("observed");
    });
    return f;
  }

  it.each(recurrenceSizes)("omits a confirmed optional %i-byte snapshot without invalidating authoritative interactions", async (size) => {
    const f = await idleFixture();
    const before = f.store.getLifecycle(f.target.sessionId)!;
    const event = optionalSnapshot(size);
    const expectedBound = jsonWireByteUpperBound({ encoding: "native-json-images-v1", json: event.payload, images: [] });
    f.emit(event);
    await vi.waitFor(() => expect(f.gaps).toHaveLength(1));
    await vi.waitFor(() => expect(f.traces.some(trace => trace.kind === "gap" && trace.decisionReason === "optionalTelemetryOmitted")).toBe(true));
    expect(f.traces.find(trace => trace.kind === "gap")).toMatchObject({ lifecycleImpact: "preserved", pendingEvents: 1, pendingEventBytes: size,
      state: { interactionCompleteness: "complete", sendAvailable: true } });
    // These authoritative-state assertions fail on the deployed .24 baseline,
    // independently of the new diagnostic metadata assertions below.
    expect(f.store.getLifecycle(f.target.sessionId)).toEqual(before);
    expect((await f.service.readLifecycle(f.target.sessionId)).view.actions.send.available).toBe(true);
    expect(f.gaps[0]).toMatchObject({ payloadFailure: "wireEnvelope", nativeEventType: "model.messages_snapshot",
      nativeEphemeral: true, wireUpperBoundBytes: expectedBound, wireLimitBytes: NATIVE_PAYLOAD_MAX_BYTES,
      lifecycleImpact: "preserved", eventBytes: size });
    const result = await f.service.execute({ commandId: newCommandId(), payloadHash: "telemetry-send", ...f.target,
      request: { harness: "copilot", command: { type: "send", prompt: "synthetic fake-only send", mode: "enqueue" } } });
    expect(result.state).toBe("succeeded");
    expect(f.execute).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(f.gaps);
    for (const secret of [privateId, privatePath, f.target.sessionId, f.session.vendorSessionId]) expect(serialized).not.toContain(secret);
    expect(serialized.length).toBeLessThan(1_024);
  });

  it.each([
    { label: "unknown ephemeral native type", change: (event: NativeEvent) => { event.nativeType = privateType; }, expectedType: "unknown", ephemeral: true },
    { label: "authoritative ephemeral request", change: (event: NativeEvent) => {
      event.nativeType = "user_input.requested"; (event.payload as Record<string, JsonValue>).type = event.nativeType;
    }, expectedType: "user_input.requested", ephemeral: true },
    { label: "native/payload type disagreement", change: (event: NativeEvent) => { (event.payload as Record<string, JsonValue>).type = "permission.requested"; }, expectedType: "model.messages_snapshot", ephemeral: true },
    { label: "non-ephemeral metadata", change: (event: NativeEvent) => { event.ephemeral = false; }, expectedType: "model.messages_snapshot", ephemeral: false },
    { label: "missing native ephemeral marker", change: (event: NativeEvent) => { delete (event.payload as Record<string, JsonValue>).ephemeral; }, expectedType: "model.messages_snapshot", ephemeral: true },
    { label: "malformed snapshot kind", change: (event: NativeEvent) => { ((event.payload as Record<string, JsonValue>).data as Record<string, JsonValue>).kind = "pending_requests"; }, expectedType: "model.messages_snapshot", ephemeral: true },
    { label: "missing adapter policy", change: (_event: NativeEvent, f: ReturnType<typeof fixture>) => { delete f.adapter.optionalNativeTelemetry; }, expectedType: "model.messages_snapshot", ephemeral: true },
    { label: "failed adapter policy", change: (_event: NativeEvent, f: ReturnType<typeof fixture>) => { f.adapter.optionalNativeTelemetry = () => { throw new Error(privatePath); }; }, expectedType: "model.messages_snapshot", ephemeral: true },
  ])("keeps $label fail closed, including after a later idle", async ({ label, change, expectedType, ephemeral }) => {
    const f = await idleFixture();
    const event = optionalSnapshot(recurrenceSizes[1]!);
    change(event, f);
    f.emit(event);
    await vi.waitFor(() => expect(f.gaps).toHaveLength(1));
    const expectedReason = ({ "unknown ephemeral native type": "unknownNativeEvent", "authoritative ephemeral request": "requiredNativeEvent",
      "native/payload type disagreement": "adapterPolicyRejected", "non-ephemeral metadata": "notExplicitlyEphemeral",
      "missing native ephemeral marker": "adapterPolicyRejected", "malformed snapshot kind": "adapterPolicyRejected",
      "missing adapter policy": "adapterPolicyUnavailable", "failed adapter policy": "adapterPolicyFailed" } as Record<string, string>)[label];
    await vi.waitFor(() => expect(f.traces.find(trace => trace.kind === "gap")).toMatchObject({ decisionReason: expectedReason, lifecycleImpact: "invalidated" }));
    expect(f.gaps[0]).toMatchObject({ payloadFailure: "wireEnvelope", lifecycleImpact: "invalidated",
      nativeEventType: expectedType, nativeEphemeral: ephemeral, wireLimitBytes: NATIVE_PAYLOAD_MAX_BYTES });
    expect(f.store.getLifecycle(f.target.sessionId)?.interactions.completeness).toBe("partial");
    f.emit({ kind: "lifecycle", fact: { type: "rootIdle", aborted: false } });
    await vi.waitFor(() => expect(f.store.getLifecycle(f.target.sessionId)?.root.phase).toBe("idle"));
    expect(f.store.getLifecycle(f.target.sessionId)?.interactions.completeness).toBe("partial");
    expect((await f.service.readLifecycle(f.target.sessionId)).view.actions.send)
      .toEqual({ available: false, reason: "interactionStateUnknown" });
    const result = await f.service.execute({ commandId: newCommandId(), payloadHash: "required-blocked-send", ...f.target,
      request: { harness: "copilot", command: { type: "send", prompt: "synthetic never-dispatched", mode: "enqueue" } } });
    expect(result).toMatchObject({ state: "failed", error: { code: "UNAVAILABLE" } });
    expect(f.execute).not.toHaveBeenCalled();
    for (const secret of [privateType, privateId, privatePath]) expect(JSON.stringify(f.gaps)).not.toContain(secret);
    expect(nativeGapDiagnosticSchema.safeParse(f.store.getLifecycle(f.target.sessionId)?.lastGap).success).toBe(true);
  });

  it("does not let a later optional omission repair an earlier authoritative gap", async () => {
    const f = await idleFixture();
    f.emit(textEvent(recurrenceSizes[0]!));
    await vi.waitFor(() => expect(f.gaps).toHaveLength(1));
    const previousGap = f.store.getLifecycle(f.target.sessionId)!.lastGap;
    f.emit(optionalSnapshot(recurrenceSizes[2]!));
    await vi.waitFor(() => expect(f.gaps).toHaveLength(2));
    expect(f.gaps[1]?.lifecycleImpact).toBe("preserved");
    expect(f.store.getLifecycle(f.target.sessionId)!.lastGap).toEqual(previousGap);
    f.emit({ kind: "lifecycle", fact: { type: "rootIdle", aborted: false } });
    expect((await f.service.readLifecycle(f.target.sessionId)).view.actions.send.available).toBe(false);
    expect(f.store.getLifecycle(f.target.sessionId)?.interactions.completeness).toBe("partial");
  });

  it("preserves a real pending interaction and leaves Send blocked for waitingForInput", async () => {
    const f = await idleFixture();
    f.emit({ kind: "interaction", requestType: "userInput", nativeRequestId: "synthetic-request", ephemeral: true,
      payload: { request: "synthetic question" }, resolve: async () => undefined });
    await vi.waitFor(() => expect(f.service.listInteractions(f.target.sessionId)).toHaveLength(1));
    const before = f.store.getLifecycle(f.target.sessionId)!;
    f.emit(optionalSnapshot(recurrenceSizes[0]!));
    await vi.waitFor(() => expect(f.gaps).toHaveLength(1));
    expect(f.store.getLifecycle(f.target.sessionId)).toEqual(before);
    expect(f.service.listInteractions(f.target.sessionId)).toHaveLength(1);
    expect((await f.service.readLifecycle(f.target.sessionId)).view.actions.send)
      .toEqual({ available: false, reason: "waitingForInput" });
  });

  it("keeps an oversized authoritative reverse request fail closed", async () => {
    const f = await idleFixture();
    f.emit({ kind: "interaction", requestType: "userInput", nativeRequestId: "synthetic-oversized-request", ephemeral: true,
      payload: { question: "x".repeat(recurrenceSizes[0]!) }, resolve: async () => undefined });
    await vi.waitFor(() => expect(f.gaps).toHaveLength(1));
    expect(f.gaps[0]).toMatchObject({ eventKind: "interaction", lifecycleImpact: "invalidated", payloadFailure: "wireEnvelope" });
    expect(f.gaps[0]).not.toHaveProperty("nativeEventType");
    expect(f.gaps[0]).not.toHaveProperty("nativeEphemeral");
    f.emit({ kind: "lifecycle", fact: { type: "rootIdle", aborted: false } });
    expect((await f.service.readLifecycle(f.target.sessionId)).view.actions.send)
      .toEqual({ available: false, reason: "interactionStateUnknown" });
    expect(f.service.listInteractions(f.target.sessionId)).toEqual([]);
  });

  it.each([
    { label: "serialization", code: "eventSerialization", options: {}, mutate: (event: NativeEvent) => {
      (event.payload as Record<string, JsonValue>).nonJson = BigInt(1) as unknown as JsonValue;
    } },
    { label: "non-wire extraction", code: "imageExtraction", options: { imageCodec: {
      externalize: async () => { throw new TypeError(privatePath); },
    } }, mutate: (_event: NativeEvent) => undefined },
    { label: "wire and pointer validation together", code: "imageExtraction", options: { imageCodec: {
      externalize: async (json: JsonValue) => parseNativePayload({ encoding: "native-json-images-v1", json,
        images: [{ pointer: "/missing", representation: "base64", image: { unavailable: true, reason: "missing" } }] }),
    } }, mutate: (_event: NativeEvent) => undefined },
    { label: "queue overflow", code: "queueOverflow", options: { nativeEventQueueBytes: NATIVE_PAYLOAD_MAX_BYTES },
      mutate: (_event: NativeEvent) => undefined },
  ])("does not exempt a confirmed optional snapshot on $label failure", async ({ label, options, mutate, code }) => {
    const f = await idleFixture(options);
    const event = optionalSnapshot(recurrenceSizes[0]!);
    expect(copilotOptionalNativeTelemetry(event)).toBe(true);
    mutate(event);
    f.emit(event);
    await vi.waitFor(() => expect(f.gaps).toHaveLength(1));
    await vi.waitFor(() => expect(f.traces.find(trace => trace.kind === "gap")).toMatchObject({
      decisionReason: label === "wire and pointer validation together" ? "mixedValidationFailure" : "notWireEnvelope", lifecycleImpact: "invalidated" }));
    expect(f.gaps[0]).toMatchObject({ code, nativeEventType: "model.messages_snapshot", lifecycleImpact: "invalidated" });
    expect(f.store.getLifecycle(f.target.sessionId)?.interactions.completeness).toBe("partial");
    f.emit({ kind: "lifecycle", fact: { type: "rootIdle", aborted: false } });
    expect((await f.service.readLifecycle(f.target.sessionId)).view.actions.send)
      .toEqual({ available: false, reason: "interactionStateUnknown" });
    expect(JSON.stringify(f.gaps)).not.toContain(privatePath);
  });

  it("publishes an explicit omission between admitted native items without a sequence hole or lifecycle invalidation", async () => {
    const f = await idleFixture();
    const cancellation = new AbortController();
    const observed: RuntimeNodeEventItem[] = [];
    const stream = (async () => {
      for await (const item of f.service.events({ native: {} }, cancellation.signal)) {
        if (item.kind === "native" || item.kind === "nativeGap") observed.push(item);
      }
    })();
    try {
      f.emit({ kind: "native", nativeType: "assistant.message", ephemeral: false,
        payload: { type: "assistant.message", data: { content: "synthetic-before" } } });
      f.emit(optionalSnapshot(recurrenceSizes[0]!));
      f.emit({ kind: "native", nativeType: "assistant.message", ephemeral: false,
        payload: { type: "assistant.message", data: { content: "synthetic-after" } } });
      await vi.waitFor(() => expect(observed).toHaveLength(3));
      expect(observed.map((item) => item.kind)).toEqual(["native", "nativeGap", "native"]);
      expect(observed.filter((item) => item.kind === "native").map((item) => item.sequence)).toEqual([0, 1]);
      expect(observed[1]).toMatchObject({ kind: "nativeGap", recovery: "readNativeHistory" });
      expect(JSON.stringify(observed)).not.toContain(privatePath);
      expect((await f.service.readLifecycle(f.target.sessionId)).view.actions.send.available).toBe(true);
    } finally { cancellation.abort(); await stream; }
  });
});
