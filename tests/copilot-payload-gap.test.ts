import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_PAYLOAD_MAX_BYTES, emptyMetadataSnapshot, jsonWireByteUpperBound,
  nativeGapDiagnosticSchema, nativePayloadValidationFailure, newCommandId, newRuntimeEpoch, newRuntimeNodeBootId,
  newRuntimeNodeId, newSessionId, type AdapterScopeId, type JsonValue,
} from "@arduano/agent-multiplex-protocol";
import { copilotImageCodec } from "../packages/adapter-copilot/src/images.js";
import { RuntimeNodeService, RuntimeNodeStore, type AdapterEvent, type AdapterSession, type AgentAdapter, type NativeGapLogDiagnostic } from "../packages/runtime-node-core/src/index.js";

type NativeEvent = Extract<AdapterEvent, { kind: "native" }>;
const releases: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0)) await release(); });
const sizes = [1_297_380, 1_721_340];
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

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "copilot-payload-gap-"));
  const store = new RuntimeNodeStore(join(directory, "runtime.sqlite"));
  const target = { sessionId: newSessionId(), runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId(), bindingRevision: 1 };
  const scope = "copilot:synthetic-gap" as AdapterScopeId;
  const timestamp = new Date().toISOString();
  let emit!: (event: AdapterEvent) => void;
  const gaps: NativeGapLogDiagnostic[] = [];
  const execute = vi.fn(async () => null);
  const session: AdapterSession = {
    harness: "copilot", adapterScopeId: scope, vendorSessionId: "synthetic-native-session",
    cwd: directory, runtimeEpoch: newRuntimeEpoch(), status: () => "idle", execute,
    subscribe: (listener) => { emit = listener; return () => undefined; }, stop: async () => undefined,
    readNativeHistory: async () => ({ harness: "copilot", vendorSessionId: "synthetic-native-session", payload: [] }),
    readNativeState: async (request) => ({ harness: "copilot", vendorSessionId: "synthetic-native-session", view: request.view,
      payload: request.view === "tasks" ? { tasks: [] } : { items: [], steeringMessages: [], inFlightSteeringCount: 0 } }),
  };
  const adapter: AgentAdapter = {
    harness: "copilot", adapterScopeId: scope, imageCodec: copilotImageCodec,
    describe: async () => ({ harness: "copilot", adapterScopeId: scope, available: true, capabilities: [] }),
    listModels: async () => [], listSessions: async () => [], spawn: async () => session, resume: async () => session, close: async () => undefined,
  };
  store.putSession({ sessionId: target.sessionId, runtimeNodeId: target.runtimeNodeId, bindingRevision: target.bindingRevision,
    harness: "copilot", adapterScopeId: scope, vendorSessionId: session.vendorSessionId,
    cwd: directory, runtimeEpoch: null, availability: "resumable", runtimeStatus: "stopped", launchProvenance: null,
    metadata: emptyMetadataSnapshot(), createdAt: timestamp, updatedAt: timestamp, lastSeenAt: timestamp, lastActivityAt: timestamp });
  const service = new RuntimeNodeService({ store, runtimeNodeId: target.runtimeNodeId, runtimeNodeBootId: target.runtimeNodeBootId,
    adapters: [adapter], allowedRoots: [directory], name: "synthetic payload diagnosis", onNativeGapDiagnostic: (diagnostic) => gaps.push(diagnostic) });
  releases.push(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, service, target, session, execute, gaps, emit: (event: AdapterEvent) => emit(event) };
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
    const durableDiagnostic = { ...f.gaps[0]! };
    delete durableDiagnostic.payloadFailure;
    expect(stored.lastGap).toEqual(durableDiagnostic);
    expect(nativeGapDiagnosticSchema.parse(stored.lastGap)).toEqual(durableDiagnostic);
    expect(nativeGapDiagnosticSchema.safeParse(f.gaps[0]).success).toBe(false);
    expect(stored.interactions.completeness).toBe("partial");
    const serialized = JSON.stringify(f.gaps);
    for (const secret of [privateType, privateId, privatePath, f.target.sessionId, f.session.vendorSessionId]) expect(serialized).not.toContain(secret);
    expect(serialized.length).toBeLessThan(512);
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
