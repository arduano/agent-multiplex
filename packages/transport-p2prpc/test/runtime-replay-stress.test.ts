import { newArchiveOperationId, newCommandId, newRuntimeEpoch, newRuntimeNodeBootId, packNativePayload } from "@arduano/agent-multiplex-protocol";
import { describe, expect, it, vi } from "vitest";
import { replayFixture } from "./runtime-replay-fixture.js";
import { replayTreeFixture } from "./runtime-replay-tree-fixture.js";

describe("bounded shared native replay stress", () => {
  it.each(["codex", "copilot"] as const)("delivers every active %s root/child item once across mixed retirement and three reconnects", async harness => {
    const reconnectSequences = new Set([3, 11, 27]);
    let chosenSession: string | undefined;
    const injectedFailures: Error[] = [];
    const f = await replayFixture({ harness, beforeForward: async item => {
      if (item.kind === "native" && item.sessionId === chosenSession && reconnectSequences.delete(item.sequence)) {
        const error = new Error("synthetic reverse-feed connection loss"); injectedFailures.push(error); throw error;
      }
    } });
    const active: Array<Awaited<ReturnType<typeof f.launch>>> = [];
    const retiredIds: string[] = [];
    for (let i = 0; i < 18; i++) {
      const binding = await f.launch();
      binding.session.reply(`synthetic initial ${i}`);
      if (i % 3 === 0) { active.push(binding); continue; }
      retiredIds.push(binding.sessionId);
      expect((await f.runtime.stop({ operation: "stop", commandId: newCommandId(), payloadHash: `stress-stop-${i}`, sessionId: binding.sessionId,
        runtimeNodeId: f.fence.runtimeNodeId, bindingRevision: 1 })).state).toBe("succeeded");
      f.control.publishRuntimeEvent({ ...f.fence, event: { kind: "control", change: { type: "session.upsert", session: f.store.getSession(binding.sessionId)! } } }, f.context);
      if (i % 3 === 1) {
        const archiveOperationId = newArchiveOperationId();
        f.runtime.archive({ archiveOperationId, payloadHash: `stress-archive-${i}`, sessionId: binding.sessionId,
          runtimeNodeId: f.fence.runtimeNodeId, bindingRevision: 1, expectedAuthority: f.catalog.authority() });
        await vi.waitFor(() => expect(f.runtime.getArchive(archiveOperationId)?.state).toBe("succeeded"));
        f.catalog.recordArchive(f.runtime.getArchive(archiveOperationId)!);
      }
    }
    chosenSession = active[0]!.sessionId;
    const tree = await replayTreeFixture(f);
    f.pump.start();
    await vi.waitFor(() => expect(f.delivered.filter(item => item.kind === "native")).toHaveLength(active.length));
    // Interleave child lifecycle/content with parent output. Native ownership is
    // retained inside the original logical session; no child catalog is invented.
    for (let sequence = 1; sequence <= 40; sequence++) {
      for (let i = 0; i < active.length; i++) {
        const binding = active[i]!;
        if (sequence % 5 === 0) {
          for (const listener of binding.session.listeners) listener({ kind: "native", nativeType: "subagent.completed", ephemeral: false,
            payload: { type: "subagent.completed", data: { agentId: `synthetic-child-${i}`, content: `synthetic child output ${sequence}` } } });
        } else binding.session.reply(`synthetic parent ${sequence}`);
      }
      // Keep this a mild bounded stress test, below the production ring/mailbox
      // limits, and wait for each burst to finish after any reconnect.
      await vi.waitFor(() => expect(f.delivered.filter(item => item.kind === "native")).toHaveLength(active.length * (sequence + 1)), { timeout: 2_000 });
      await vi.waitFor(() => expect(tree.gatewayItems.filter(item => item.kind === "native")).toHaveLength(active.length * (sequence + 1)), { timeout: 2_000 });
      if (sequence % 10 === 0 && sequence < 40) {
        await tree.service.attachChildConnection(tree.connection);
        await tree.gateway.refreshSource(tree.sourceId);
      }
    }
    expect(injectedFailures).toHaveLength(3); expect(f.errors).toEqual(injectedFailures);
    expect(f.subscriptions).toHaveLength(4); expect(f.rejected).toEqual([]);
    for (const binding of active) {
      const native = f.delivered.filter(item => item.kind === "native" && item.sessionId === binding.sessionId);
      expect(native.map(item => item.kind === "native" && item.sequence)).toEqual(Array.from({ length: 41 }, (_, i) => i));
      expect(native.every(item => item.kind === "native" && item.runtimeEpoch === binding.session.runtimeEpoch && item.harness === harness)).toBe(true);
      expect(native.filter(item => item.kind === "native" && item.nativeType === "subagent.completed")).toHaveLength(8);
      expect(f.pump.cursor.native[binding.sessionId]).toEqual({ runtimeEpoch: binding.session.runtimeEpoch, sequence: 40 });
      const history = await f.runtime.readNativeHistory(binding.sessionId, { harness, limit: 100 });
      expect((history.payload.json as unknown[]).length).toBe(33);
    }
    expect(f.delivered.filter(item => item.kind === "native" && retiredIds.includes(item.sessionId))).toEqual([]);
    expect(tree.errors).toEqual([]);
    expect(tree.rootItems.filter(item => item.kind === "native")).toHaveLength(246);
    expect(tree.gatewayItems.filter(item => item.kind === "native")).toHaveLength(246);
    for (const item of tree.gatewayItems) if (item.kind === "native") {
      expect(item.provenance).toEqual({ originControlNodeId: f.catalog.localControlNode().controlNodeId, authority: tree.catalog.authority() });
    }
    expect(f.control.heartbeatRuntimeNode(f.fence, f.context)).toMatchObject({ accepted: true });
  }, 60_000);

  it.each(["codex", "copilot"] as const)("does not cross a replacement %s epoch or runtime boot with child bytes", async harness => {
    const f = await replayFixture({ harness });
    const binding = await f.launch();
    const retired = binding.session;
    retired.reply("synthetic old epoch");
    await f.runtime.stop({ operation: "stop", commandId: newCommandId(), payloadHash: "stress-epoch-stop", sessionId: binding.sessionId,
      runtimeNodeId: f.fence.runtimeNodeId, bindingRevision: 1 });
    f.control.publishRuntimeEvent({ ...f.fence, event: { kind: "control", change: { type: "session.upsert", session: f.store.getSession(binding.sessionId)! } } }, f.context);
    await f.runtime.resume({ operation: "resume", commandId: newCommandId(), payloadHash: "stress-epoch-resume", sessionId: binding.sessionId,
      runtimeNodeId: f.fence.runtimeNodeId, bindingRevision: 1 });
    const replacement = f.adapter.sessions.get(retired.vendorSessionId)!;
    f.control.publishRuntimeEvent({ ...f.fence, event: { kind: "control", change: { type: "session.upsert", session: f.store.getSession(binding.sessionId)! } } }, f.context);
    // Saved listener callbacks cannot accidentally revive a retired epoch.
    expect(retired.listeners.size).toBe(0);
    const staleChild = { kind: "native" as const, sessionId: binding.sessionId, harness,
      runtimeEpoch: retired.runtimeEpoch, sequence: 99, nativeType: "subagent.completed",
      payload: packNativePayload({ data: { agentId: "synthetic-old-child" } }), ephemeral: false };
    expect(() => f.control.publishRuntimeEvent({ ...f.fence, event: staleChild }, f.context)).toThrowError(expect.objectContaining({ code: "FENCED" }));
    f.pump.start(); replacement.reply("synthetic new epoch");
    await vi.waitFor(() => expect(f.delivered.filter(item => item.kind === "native")).toHaveLength(1));
    expect(f.delivered.find(item => item.kind === "native")).toMatchObject({ runtimeEpoch: replacement.runtimeEpoch, sequence: 0 });
    f.pump.stop();
    const newBoot = newRuntimeNodeBootId();
    f.control.registerRuntimeNode({ ...await f.runtime.describe(), runtimeNodeBootId: newBoot }, f.context);
    expect(() => f.control.publishRuntimeEvent({ ...f.fence, event: { ...staleChild, runtimeEpoch: replacement.runtimeEpoch } }, f.context)).toThrowError(expect.objectContaining({ code: "FENCED" }));
    expect(() => f.control.publishRuntimeEvent({ ...f.fence, runtimeNodeBootId: newBoot,
      event: { ...staleChild, runtimeEpoch: newRuntimeEpoch() } }, f.context)).toThrowError(expect.objectContaining({ code: "FENCED" }));
    // Registration of a new runtime boot invalidates the old active epoch.
    // Fresh authenticated inventory must establish the binding before bytes
    // from even the newly registered boot may be admitted.
    expect(() => f.control.publishRuntimeEvent({ ...f.fence, runtimeNodeBootId: newBoot,
      event: { ...staleChild, runtimeEpoch: replacement.runtimeEpoch } }, f.context)).toThrowError(expect.objectContaining({ code: "FENCED" }));
    f.control.reconcile({ ...f.fence, runtimeNodeBootId: newBoot, snapshot: await f.runtime.refreshInventory() }, f.context);
    expect(f.control.publishRuntimeEvent({ ...f.fence, runtimeNodeBootId: newBoot,
      event: { ...staleChild, runtimeEpoch: replacement.runtimeEpoch, sequence: 1 } }, f.context)).toEqual({ accepted: true });
    expect(f.control.heartbeatRuntimeNode({ ...f.fence, runtimeNodeBootId: newBoot }, f.context)).toMatchObject({ accepted: true });
    expect(f.errors).toEqual([]);
  });
});
