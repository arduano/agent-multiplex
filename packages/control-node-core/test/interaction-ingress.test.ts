import {
  adapterScopeIdSchema, emptyMetadataSnapshot, newInteractionId, newRuntimeEpoch,
  newRuntimeNodeBootId, newRuntimeNodeId, newSessionId, packNativePayload,
  type InteractionRecord, type RuntimeNodeRegistration, type RuntimeNodeSessionRecord,
} from "@arduano/agent-multiplex-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ControlNodeCatalog, ControlNodeService } from "../src/index.js";

const timestamp = "2037-04-05T06:07:08.000Z";
const fixtures: Array<{ service: ControlNodeService; catalog: ControlNodeCatalog }> = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.service.close();
    fixture.catalog.close();
  }
});

function fixture() {
  const catalog = new ControlNodeCatalog({ filename: ":memory:", now: () => new Date(timestamp) });
  const service = new ControlNodeService({ catalog });
  fixtures.push({ service, catalog });
  const runtime: RuntimeNodeRegistration = {
    runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId(),
    name: "interaction-ingress", allowedRoots: ["/synthetic"], protocolVersion: 6,
    harnesses: [{ harness: "codex", adapterScopeId: adapterScopeIdSchema.parse("interaction-ingress"),
      available: true, capabilities: [] }], launchProfiles: [],
  };
  const context = { endpointId: "synthetic-ingress-endpoint", authenticatedRuntimeNodeId: runtime.runtimeNodeId };
  service.registerRuntimeNode(runtime, context);
  const fence = { runtimeNodeId: runtime.runtimeNodeId, runtimeNodeBootId: runtime.runtimeNodeBootId };
  const session: RuntimeNodeSessionRecord = {
    sessionId: newSessionId(), runtimeNodeId: runtime.runtimeNodeId, harness: "codex",
    adapterScopeId: runtime.harnesses[0]!.adapterScopeId, vendorSessionId: "synthetic-native-session",
    bindingRevision: 1, runtimeEpoch: newRuntimeEpoch(), cwd: "/synthetic",
    availability: "active", runtimeStatus: "idle", metadata: emptyMetadataSnapshot(),
    createdAt: timestamp, updatedAt: timestamp, lastSeenAt: timestamp,
  };
  const upsert = (record: RuntimeNodeSessionRecord) => service.publishRuntimeEvent({ ...fence,
    event: { kind: "control", change: { type: "session.upsert", session: record } } }, context);
  upsert(session);
  const pending: InteractionRecord = {
    interactionId: newInteractionId(), sessionId: session.sessionId, harness: session.harness,
    runtimeEpoch: session.runtimeEpoch!, nativeRequestId: "synthetic-permission", requestType: "permission",
    payload: packNativePayload({ command: "synthetic" }), ephemeral: false, state: "pending",
    createdAt: timestamp, expiresAt: null, resolvedAt: null,
  };
  const publish = (interaction: InteractionRecord) => service.publishRuntimeEvent({ ...fence,
    event: { kind: "control", change: { type: "interaction.changed", interaction } } }, context);
  const retire = (epoch: "null" | "replacement") => upsert({ ...session,
    runtimeEpoch: epoch === "null" ? null : newRuntimeEpoch(),
    availability: epoch === "null" ? "resumable" : "active",
    runtimeStatus: epoch === "null" ? "stopped" : "idle",
  });
  return { catalog, service, runtime, context, fence, session, pending, publish, retire };
}

describe("authenticated terminal interaction replay", () => {
  it.each((["stale", "resolved", "expired"] as const).flatMap(state =>
    (["null", "replacement"] as const).flatMap(epoch =>
      [false, true].map(recorded => ({ state, epoch, recorded })))))(
    "consumes $state replay after $epoch epoch, previously recorded=$recorded, without catalog/feed writes",
    ({ state, epoch, recorded }) => {
      const f = fixture();
      if (recorded) f.publish(f.pending);
      f.retire(epoch);
      const replay: InteractionRecord = { ...f.pending, state, resolvedAt: timestamp,
        ...(state === "resolved" ? { resolution: packNativePayload({ approved: true }) } : {}) };
      const before = f.catalog.accessSnapshot();
      const beforeInteraction = f.catalog.getInteraction(replay.interactionId);
      const cursor = f.catalog.controlCursor();
      expect(f.publish(replay)).toEqual({ accepted: true });
      expect(f.publish(replay)).toEqual({ accepted: true });
      expect(f.catalog.accessSnapshot()).toEqual(before);
      expect(f.catalog.getInteraction(replay.interactionId)).toEqual(beforeInteraction);
      expect(f.catalog.controlCursor()).toBe(cursor);
      expect(f.catalog.controlEventsAfter(cursor)).toEqual([]);
    },
  );

  it.each(["null", "replacement"] as const)("keeps pending mismatches and direct catalog publication fenced after %s epoch", epoch => {
    const f = fixture();
    f.publish(f.pending);
    f.retire(epoch);
    const before = f.catalog.accessSnapshot();
    const cursor = f.catalog.controlCursor();
    expect(() => f.publish(f.pending)).toThrowError(expect.objectContaining({ code: "FENCED" }));
    for (const state of ["stale", "resolved", "expired"] as const) {
      const terminal = { ...f.pending, state, resolvedAt: timestamp };
      expect(() => f.catalog.publishInteraction(terminal)).toThrowError(expect.objectContaining({ code: "FENCED" }));
      expect(() => f.service.publishInteraction({ ...f.fence, interaction: terminal }, f.context))
        .toThrowError(expect.objectContaining({ code: "FENCED" }));
    }
    expect(f.catalog.accessSnapshot()).toEqual(before);
    expect(f.catalog.controlCursor()).toBe(cursor);
  });

  it.each(["stale", "resolved", "expired"] as const)("checks authentication, boot, owner and harness before consuming obsolete %s replay", state => {
    const f = fixture();
    f.retire("null");
    const terminal = { ...f.pending, state, resolvedAt: timestamp };
    const event = { kind: "control" as const, change: { type: "interaction.changed" as const, interaction: terminal } };
    const foreign = { runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId() };
    const foreignContext = { endpointId: "synthetic-foreign-endpoint", authenticatedRuntimeNodeId: foreign.runtimeNodeId };
    f.service.registerRuntimeNode({ ...f.runtime, ...foreign }, foreignContext);
    const before = f.catalog.accessSnapshot();
    const cursor = f.catalog.controlCursor();
    expect(() => f.service.publishRuntimeEvent({ ...f.fence, event }, {}))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(() => f.service.publishRuntimeEvent({ ...f.fence, event }, { ...f.context, endpointId: "unenrolled-endpoint" }))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(() => f.service.publishRuntimeEvent({ ...f.fence, event }, { ...f.context, authenticatedRuntimeNodeId: foreign.runtimeNodeId }))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(() => f.service.publishRuntimeEvent({ ...f.fence, runtimeNodeBootId: newRuntimeNodeBootId(), event }, f.context))
      .toThrowError(expect.objectContaining({ code: "FENCED" }));
    expect(() => f.service.publishRuntimeEvent({ ...foreign, event }, foreignContext))
      .toThrowError(expect.objectContaining({ code: "FENCED" }));
    expect(() => f.publish({ ...terminal, harness: "copilot" }))
      .toThrowError(expect.objectContaining({ code: "FENCED" }));
    expect(f.catalog.accessSnapshot()).toEqual(before);
    expect(f.catalog.controlCursor()).toBe(cursor);
  });

  it.each(["pending", "stale", "resolved", "expired"] as const)("negatively acknowledges unknown-session %s records", state => {
    const f = fixture();
    const before = f.catalog.accessSnapshot();
    const cursor = f.catalog.controlCursor();
    expect(f.publish({ ...f.pending, sessionId: newSessionId(), state })).toEqual({ accepted: false });
    expect(f.catalog.accessSnapshot()).toEqual(before);
    expect(f.catalog.controlCursor()).toBe(cursor);
  });

  it("publishes current-epoch interactions and preserves terminal resolution conflicts", () => {
    const f = fixture();
    expect(f.publish(f.pending)).toEqual({ accepted: true });
    const resolved: InteractionRecord = { ...f.pending, state: "resolved", resolvedAt: timestamp,
      resolution: packNativePayload({ approved: true }) };
    expect(f.publish(resolved)).toEqual({ accepted: true });
    const cursor = f.catalog.controlCursor();
    expect(f.publish(resolved)).toEqual({ accepted: true });
    expect(f.publish(f.pending)).toEqual({ accepted: true });
    expect(f.catalog.getInteraction(resolved.interactionId)).toEqual(resolved);
    expect(f.catalog.controlCursor()).toBe(cursor);
    expect(() => f.publish({ ...resolved, resolution: packNativePayload({ approved: false }) }))
      .toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    expect(() => f.publish({ ...resolved, harness: "copilot" }))
      .toThrowError(expect.objectContaining({ code: "FENCED" }));
    expect(f.catalog.getInteraction(resolved.interactionId)).toEqual(resolved);
    expect(f.catalog.controlCursor()).toBe(cursor);
  });
});
