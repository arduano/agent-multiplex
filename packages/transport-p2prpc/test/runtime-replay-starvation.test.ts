import {
  newArchiveOperationId, newCommandId, newRuntimeEpoch, newRuntimeNodeBootId,
  newRuntimeNodeId, newSessionId, packNativePayload,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it, vi } from "vitest";
import { replayFixture as fixture } from "./runtime-replay-fixture.js";

describe("runtime replay preserves unrelated native delivery after lifecycle retirement", () => {
  it.each(["stopped", "archived", "resumed", "nativeStopped"] as const)("does not let a %s session's old ring block another active session", async retirement => {
    const f = await fixture();
    const retired = await f.launch();
    retired.session.reply("old reply");
    if (retirement === "nativeStopped") await retired.session.stop();
    else expect((await f.runtime.stop({ operation: "stop", commandId: newCommandId(), payloadHash: "synthetic-replay-stop", sessionId: retired.sessionId,
      runtimeNodeId: f.fence.runtimeNodeId, bindingRevision: 1 })).state).toBe("succeeded");
    const stopped = f.store.getSession(retired.sessionId)!;
    f.control.publishRuntimeEvent({ ...f.fence, event: { kind: "control", change: { type: "session.upsert", session: stopped } } }, f.context);
    if (retirement === "archived") {
      const archiveOperationId = newArchiveOperationId();
      f.runtime.archive({ archiveOperationId, payloadHash: "synthetic-replay-archive", sessionId: retired.sessionId,
        runtimeNodeId: f.fence.runtimeNodeId, bindingRevision: 1, expectedAuthority: f.catalog.authority() });
      await vi.waitFor(() => expect(f.runtime.getArchive(archiveOperationId)?.state).toBe("succeeded"));
      f.catalog.recordArchive(f.runtime.getArchive(archiveOperationId)!);
      expect(f.catalog.getSession(retired.sessionId)?.catalogState).toBe("archived");
    } else if (retirement === "resumed") {
      expect((await f.runtime.resume({ operation: "resume", commandId: newCommandId(), payloadHash: "synthetic-replay-resume", sessionId: retired.sessionId,
        runtimeNodeId: f.fence.runtimeNodeId, bindingRevision: 1 })).state).toBe("succeeded");
      f.control.publishRuntimeEvent({ ...f.fence, event: { kind: "control", change: { type: "session.upsert", session: f.store.getSession(retired.sessionId)! } } }, f.context);
    }
    const healthy = await f.launch();
    healthy.session.reply("new reply remains in native history");
    // Presence and history are independent of the reverse event pump.
    expect(f.control.heartbeatRuntimeNode(f.fence, f.context)).toMatchObject({ accepted: true });
    expect((await f.runtime.readNativeHistory(healthy.sessionId, { harness: "codex", limit: 20 })).payload.json).toEqual([{ text: "new reply remains in native history" }]);
    f.pump.start();
    await vi.waitFor(() => expect(f.delivered.some(item => item.kind === "native" && item.sessionId === healthy.sessionId),
      JSON.stringify({ retirement, subscriptions: f.subscriptions.length, negativeAcknowledgments: f.rejected.length,
        errorCodes: f.errors.map(error => (error as { code?: string }).code),
        retiredNativeAttempts: f.attempted.filter(item => item.kind === "native" && item.sessionId === retired.sessionId).length,
        healthyNativeAttempts: f.attempted.filter(item => item.kind === "native" && item.sessionId === healthy.sessionId).length,
      })).toBe(true), { timeout: 300, interval: 10 });
    expect(f.subscriptions).toHaveLength(1);
    expect(f.errors).toEqual([]);
    expect(f.delivered.filter(item => item.kind === "native" && item.sessionId === retired.sessionId)).toEqual([]);
    if (retirement === "resumed") {
      const replacement = f.adapter.sessions.get(retired.session.vendorSessionId)!;
      replacement.reply("fresh replacement epoch reply");
      await vi.waitFor(() => expect(f.delivered.find(item => item.kind === "native" && item.sessionId === retired.sessionId)).toMatchObject({
        runtimeEpoch: replacement.runtimeEpoch, sequence: 0,
      }));
    }
  });

  it("consumes only the authenticated owner's terminal archived replay without publishing or resurrecting it", async () => {
    const f = await fixture();
    const retired = await f.launch();
    const record = f.store.getSession(retired.sessionId)!;
    await f.runtime.stop({ operation: "stop", commandId: newCommandId(), payloadHash: "synthetic-replay-stop", sessionId: retired.sessionId,
      runtimeNodeId: f.fence.runtimeNodeId, bindingRevision: 1 });
    f.control.publishRuntimeEvent({ ...f.fence, event: { kind: "control", change: { type: "session.upsert", session: f.store.getSession(retired.sessionId)! } } }, f.context);
    const archiveOperationId = newArchiveOperationId();
    f.runtime.archive({ archiveOperationId, payloadHash: "synthetic-replay-archive", sessionId: retired.sessionId,
      runtimeNodeId: f.fence.runtimeNodeId, bindingRevision: 1, expectedAuthority: f.catalog.authority() });
    await vi.waitFor(() => expect(f.runtime.getArchive(archiveOperationId)?.state).toBe("succeeded"));
    f.catalog.recordArchive(f.runtime.getArchive(archiveOperationId)!);
    const event = { kind: "native" as const, sessionId: retired.sessionId, harness: "codex" as const,
      runtimeEpoch: record.runtimeEpoch!, sequence: 0, nativeType: "item/completed", payload: packNativePayload({ text: "retired bytes" }), ephemeral: false };
    const publication = vi.spyOn(f.control.events, "publishRuntimeItem");
    expect(f.control.publishRuntimeEvent({ ...f.fence, event }, f.context)).toEqual({ accepted: true });
    expect(f.control.publishRuntimeEvent({ ...f.fence, event: { kind: "nativeGap", sessionId: retired.sessionId, reason: "retired ring", recovery: "readNativeHistory" } }, f.context)).toEqual({ accepted: true });
    expect(publication).not.toHaveBeenCalled();
    expect(f.catalog.getSession(retired.sessionId)?.catalogState).toBe("archived");
    expect(f.store.getSession(retired.sessionId)).toBeUndefined();
    expect(() => f.control.publishRuntimeEvent({ ...f.fence, event: { ...event, harness: "copilot" } }, f.context)).toThrowError(expect.objectContaining({ code: "FENCED" }));
    expect(() => f.control.publishRuntimeEvent({ ...f.fence, runtimeNodeBootId: newRuntimeNodeBootId(), event }, f.context)).toThrowError(expect.objectContaining({ code: "FENCED" }));
    expect(() => f.control.publishRuntimeEvent({ ...f.fence, event }, { ...f.context, endpointId: "unregistered-endpoint" })).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    const foreignFence = { runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId() };
    const foreignContext = { endpointId: "foreign-runtime-endpoint", authenticatedRuntimeNodeId: foreignFence.runtimeNodeId };
    f.control.registerRuntimeNode({ ...await f.runtime.describe(), ...foreignFence }, foreignContext);
    expect(() => f.control.publishRuntimeEvent({ ...foreignFence, event }, foreignContext)).toThrowError(expect.objectContaining({ code: "FENCED" }));
    expect(() => f.control.publishRuntimeEvent({ ...foreignFence, event: { kind: "nativeGap", sessionId: retired.sessionId, reason: "foreign ring", recovery: "readNativeHistory" } }, foreignContext)).toThrowError(expect.objectContaining({ code: "FENCED" }));
  });

  it.each(["stopped", "archived"] as const)("recovers unrelated delivery when %s retirement races an already captured native item", async retirement => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let paused = false;
    const f = await fixture({ beforeForward: item => {
      if (item.kind !== "native" || paused) return Promise.resolve();
      paused = true;
      return gate;
    } });
    const retired = await f.launch();
    retired.session.reply("captured old reply");
    f.pump.start();
    await vi.waitFor(() => expect(paused).toBe(true));
    await f.runtime.stop({ operation: "stop", commandId: newCommandId(), payloadHash: "synthetic-inflight-stop", sessionId: retired.sessionId,
      runtimeNodeId: f.fence.runtimeNodeId, bindingRevision: 1 });
    f.control.publishRuntimeEvent({ ...f.fence, event: { kind: "control", change: { type: "session.upsert", session: f.store.getSession(retired.sessionId)! } } }, f.context);
    if (retirement === "archived") {
      const archiveOperationId = newArchiveOperationId();
      f.runtime.archive({ archiveOperationId, payloadHash: "synthetic-inflight-archive", sessionId: retired.sessionId,
        runtimeNodeId: f.fence.runtimeNodeId, bindingRevision: 1, expectedAuthority: f.catalog.authority() });
      await vi.waitFor(() => expect(f.runtime.getArchive(archiveOperationId)?.state).toBe("succeeded"));
      f.catalog.recordArchive(f.runtime.getArchive(archiveOperationId)!);
    }
    const healthy = await f.launch();
    healthy.session.reply("unrelated reply during in-flight retirement");
    const publication = vi.spyOn(f.control.events, "publishRuntimeItem");
    release();
    await vi.waitFor(() => expect(f.delivered.filter(item => item.kind === "native" && item.sessionId === healthy.sessionId)).toHaveLength(1));
    expect(publication.mock.calls.some(([item]) => item.kind === "native" && item.sessionId === retired.sessionId)).toBe(false);
    if (retirement === "archived") {
      // The terminal native item is consumed. An older queued nonterminal
      // archive receipt still correctly conflicts with the externally settled
      // terminal receipt, causes one reconnect, then disappears from replay.
      expect(f.subscriptions).toHaveLength(2);
      expect(f.errors).toEqual([expect.objectContaining({ code: "CONFLICT", message: "archive operation already has a different terminal outcome" })]);
      expect(f.rejected).toEqual([]);
      expect(f.delivered.filter(item => item.kind === "native" && item.sessionId === retired.sessionId)).toHaveLength(1);
    } else {
      expect(f.subscriptions).toHaveLength(2);
      expect(f.errors).toEqual([expect.objectContaining({ code: "FENCED" })]);
    }
  });

  it("keeps unknown-session delivery transient and stale open-epoch delivery fenced", async () => {
    const f = await fixture();
    const active = await f.launch();
    const event = { kind: "native" as const, sessionId: newSessionId(), harness: "codex" as const,
      runtimeEpoch: newRuntimeEpoch(), sequence: 0, nativeType: "item/completed", payload: packNativePayload({}), ephemeral: false };
    expect(f.control.publishRuntimeEvent({ ...f.fence, event }, f.context)).toEqual({ accepted: false });
    expect(() => f.control.publishRuntimeEvent({ ...f.fence, event: { ...event, sessionId: active.sessionId } }, f.context)).toThrowError(expect.objectContaining({ code: "FENCED" }));
  });
});
