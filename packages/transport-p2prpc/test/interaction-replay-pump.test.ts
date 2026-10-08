import {
  newCommandId,
  type InteractionRecord, type RuntimeNodeEventCursor, type RuntimeNodeEventItem,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it, vi } from "vitest";
import type { AdapterEvent } from "../../runtime-node-core/src/index.js";
import { P2PRuntimeNodeConnection, RuntimeNodeEventPump } from "../src/runtime-node-bridge.js";
import { replayFixture } from "./runtime-replay-fixture.js";

describe("Control consumes legacy terminal interaction replay through the runtime pump", () => {
  it.each((["codex", "copilot"] as const).flatMap(harness =>
    (["nativeStopped", "stopped", "resumed"] as const).map(retirement => ({ harness, retirement }))))(
    "keeps unrelated $harness replay/live delivery flowing after $retirement and reconnect",
    async ({ harness, retirement }) => {
      const f = await replayFixture({ harness });
      const retired = await f.launch();
      const healthy = await f.launch();
      const recorded: RuntimeNodeEventItem[] = [];
      const recording = new AbortController();
      const recorder = (async () => {
        for await (const item of f.runtime.events({ native: {} }, recording.signal)) recorded.push(item);
      })();
      const controllers: AbortController[] = [];
      const streams: Promise<void>[] = [];
      let pump: RuntimeNodeEventPump | undefined;
      try {
        let resolutionCalls = 0;
        const emit = (event: AdapterEvent) => {
          for (const listener of retired.session.listeners) listener(event);
        };
        for (const nativeRequestId of ["resolved-permission", "expired-permission", "stopped-permission"]) {
          emit({ kind: "interaction", nativeRequestId, requestType: "permission", payload: { nativeRequestId },
            ephemeral: false, resolve: async () => { resolutionCalls++; } });
        }
        await vi.waitFor(() => expect(f.runtime.listInteractions(retired.sessionId)).toHaveLength(3));
        const pending = f.runtime.listInteractions(retired.sessionId);
        const resolvedPermission = pending.find(item => item.nativeRequestId === "resolved-permission")!;
        const resolution = { interactionId: resolvedPermission.interactionId, sessionId: retired.sessionId,
          harness, response: { approved: true } };
        const resolved = await f.runtime.resolveInteraction(resolution);
        expect(await f.runtime.resolveInteraction(resolution)).toEqual(resolved);
        expect(resolutionCalls).toBe(1);
        emit({ kind: "interactionSettled", nativeRequestId: "expired-permission", state: "expired" });
        await vi.waitFor(() => {
          expect(f.runtime.listInteractions(retired.sessionId)).toHaveLength(1);
          expect(recorded.some(item => item.kind === "control" && item.change.type === "interaction.changed" &&
            item.change.interaction.state === "expired")).toBe(true);
        });
        // Simulate a Control which already admitted the pending and terminal
        // receipts before losing the runtime subscription.
        for (const interaction of pending) {
          f.control.publishRuntimeEvent({ ...f.fence, event: { kind: "control",
            change: { type: "interaction.changed", interaction } } }, f.context);
        }
        f.control.publishRuntimeEvent({ ...f.fence, event: { kind: "control",
          change: { type: "interaction.changed", interaction: resolved } } }, f.context);
        const expiredEvent = recorded.find(item => item.kind === "control" &&
          item.change.type === "interaction.changed" && item.change.interaction.state === "expired")!;
        f.control.publishRuntimeEvent({ ...f.fence, event: expiredEvent }, f.context);

        const stopId = newCommandId();
        const resumeId = newCommandId();
        if (retirement === "nativeStopped") await retired.session.stop();
        else expect((await f.runtime.stop({ operation: "stop", commandId: stopId, payloadHash: "synthetic-interaction-stop",
          sessionId: retired.sessionId, runtimeNodeId: f.fence.runtimeNodeId, bindingRevision: 1 })).state).toBe("succeeded");
        await vi.waitFor(() => {
          expect(f.store.getSession(retired.sessionId)?.runtimeEpoch).toBeNull();
          expect(recorded.some(item => item.kind === "control" && item.change.type === "interaction.changed" &&
            item.change.interaction.nativeRequestId === "stopped-permission" && item.change.interaction.state === "stale")).toBe(true);
        });
        const stoppedUpsert = recorded.findIndex(item => item.kind === "control" && item.change.type === "session.upsert" &&
          item.change.session.sessionId === retired.sessionId && item.change.session.runtimeEpoch === null);
        const staleChange = recorded.findIndex(item => item.kind === "control" && item.change.type === "interaction.changed" &&
          item.change.interaction.nativeRequestId === "stopped-permission" && item.change.interaction.state === "stale");
        if (retirement === "nativeStopped") {
          expect(stoppedUpsert).toBeGreaterThanOrEqual(0);
          expect(staleChange).toBeGreaterThan(stoppedUpsert);
        }
        f.control.publishRuntimeEvent({ ...f.fence, event: { kind: "control", change: {
          type: "session.upsert", session: f.store.getSession(retired.sessionId)! } } }, f.context);
        if (retirement === "resumed") {
          expect((await f.runtime.resume({ operation: "resume", commandId: resumeId, payloadHash: "synthetic-interaction-resume",
            sessionId: retired.sessionId, runtimeNodeId: f.fence.runtimeNodeId, bindingRevision: 1 })).state).toBe("succeeded");
          f.control.publishRuntimeEvent({ ...f.fence, event: { kind: "control", change: {
            type: "session.upsert", session: f.store.getSession(retired.sessionId)! } } }, f.context);
          expect(f.catalog.getSession(retired.sessionId)?.runtimeEpoch).not.toBe(resolved.runtimeEpoch);
          expect(f.catalog.getSession(retired.sessionId)?.runtimeEpoch).not.toBeNull();
        }
        const terminals: InteractionRecord[] = recorded.flatMap(item => item.kind === "control" &&
          item.change.type === "interaction.changed" && item.change.interaction.state !== "pending"
          ? [item.change.interaction] : []);
        expect(terminals.map(item => item.state).sort()).toEqual(["expired", "resolved", "stale"]);
        expect(terminals.every(item => item.runtimeEpoch === resolved.runtimeEpoch)).toBe(true);
        const terminalIds = new Set(terminals.map(item => item.interactionId));
        const catalogReceipts = terminals.map(item => f.catalog.getInteraction(item.interactionId));
        const runtimeReceipts = { stop: f.runtime.getCommand(stopId), resume: f.runtime.getCommand(resumeId),
          launches: f.store.listLaunchEntries(), archives: f.store.listArchiveEntries() };
        expect(await f.runtime.resolveInteraction(resolution)).toEqual(resolved);
        await expect(f.runtime.resolveInteraction({ ...resolution, response: { approved: false } }))
          .rejects.toMatchObject({ code: "CONFLICT" });
        expect(resolutionCalls).toBe(1);

        const subscriptions: Array<{ cursor: RuntimeNodeEventCursor; disconnect(): void }> = [];
        const attempts: RuntimeNodeEventItem[] = [];
        const delivered: RuntimeNodeEventItem[] = [];
        const errors: unknown[] = [];
        const transportLoss = new Error("synthetic transport loss");
        const connection = new P2PRuntimeNodeConnection(f.fence.runtimeNodeId, f.fence.runtimeNodeBootId, f.context.endpointId, {
          identity: { id: f.context.endpointId }, principal: { id: f.context.endpointId },
          rpc: { events: { subscribe: { subscribe: (input: { cursor: RuntimeNodeEventCursor }, callbacks: {
            onStarted?(): void; onData(item: RuntimeNodeEventItem): void; onError(error: unknown): void;
          }) => {
            const controller = new AbortController();
            controllers.push(controller);
            subscriptions.push({ cursor: structuredClone(input.cursor), disconnect() { callbacks.onError(transportLoss); } });
            callbacks.onStarted?.();
            streams.push((async () => {
              try {
                let initialBindings = f.store.listSessions().length;
                for await (const item of f.runtime.events(input.cursor, controller.signal)) {
                  if (controller.signal.aborted) break;
                  // Recreate the legacy producer contract even when Runtime's
                  // own reconnect filter excludes these obsolete terminals.
                  if (item.kind === "control" && item.change.type === "interaction.changed" &&
                    terminalIds.has(item.change.interaction.interactionId)) continue;
                  callbacks.onData(item);
                  if (initialBindings > 0 && item.kind === "control" && item.change.type === "session.upsert" && --initialBindings === 0) {
                    for (const interaction of terminals) callbacks.onData({ kind: "control", change: { type: "interaction.changed", interaction } });
                  }
                }
              } catch (error) { if (!controller.signal.aborted) callbacks.onError(error); }
            })());
            return { unsubscribe() { controller.abort(); } };
          } } } },
        } as never, f.context.endpointId);
        pump = new RuntimeNodeEventPump({ connection, retryDelayMs: () => 1, onError: error => { errors.push(error); },
          onItem: item => {
            attempts.push(item);
            const obsoleteTerminal = item.kind === "control" && item.change.type === "interaction.changed" &&
              terminalIds.has(item.change.interaction.interactionId);
            const before = obsoleteTerminal ? f.catalog.accessSnapshot() : undefined;
            const cursor = f.catalog.controlCursor();
            const accepted = f.control.publishRuntimeEvent({ ...f.fence, event: item }, f.context).accepted;
            if (obsoleteTerminal) {
              expect(accepted).toBe(true);
              // Capture/generation times describe these reads. Every stored
              // catalog value and replay barrier must stay exact.
              expect(f.catalog.accessSnapshot()).toEqual({ ...before, capturedAt: expect.any(String),
                source: { ...before!.source, manifest: { ...before!.source.manifest, generatedAt: expect.any(String) } } });
              expect(f.catalog.controlCursor()).toBe(cursor);
              expect(f.catalog.controlEventsAfter(cursor)).toEqual([]);
            }
            if (accepted) delivered.push(item);
            return accepted;
          } });
        const publication = vi.spyOn(f.control.events, "publishRuntimeItem");
        healthy.session.reply("healthy replay before pump");
        await vi.waitFor(() => expect(recorded.some(item => item.kind === "native" &&
          item.sessionId === healthy.sessionId && item.sequence === 0)).toBe(true));
        recording.abort();
        await recorder;
        pump.start();
        const nativeDelivered = () => delivered.filter(item => item.kind === "native" && item.sessionId === healthy.sessionId);
        await vi.waitFor(() => expect(nativeDelivered(), JSON.stringify({ subscriptions: subscriptions.length,
          errors: errors.slice(0, 3).map(error => ({ code: (error as { code?: string }).code, message: (error as Error).message })) })).toHaveLength(1));
        healthy.session.reply("healthy live after obsolete terminal replay");
        await vi.waitFor(() => expect(nativeDelivered()).toHaveLength(2));
        expect(subscriptions).toHaveLength(1);
        expect(errors).toEqual([]);
        const beforeReconnectCursor = pump.cursor;
        subscriptions[0]!.disconnect();
        await vi.waitFor(() => expect(subscriptions).toHaveLength(2));
        await vi.waitFor(() => expect(attempts.filter(item => item.kind === "control" &&
          item.change.type === "interaction.changed" && terminalIds.has(item.change.interaction.interactionId))).toHaveLength(6));
        expect(subscriptions[1]!.cursor).toEqual(beforeReconnectCursor);
        healthy.session.reply("healthy live after reconnect");
        await vi.waitFor(() => expect(nativeDelivered()).toHaveLength(3));
        expect(nativeDelivered().map(item => item.kind === "native" && item.sequence)).toEqual([0, 1, 2]);
        expect(publication.mock.calls.map(([item]) => item)).toEqual(nativeDelivered());
        expect(pump.cursor).toEqual({ native: { [healthy.sessionId]: { runtimeEpoch: healthy.session.runtimeEpoch, sequence: 2 } } });
        expect(subscriptions).toHaveLength(2);
        expect(errors).toEqual([transportLoss]);
        expect(terminals.map(item => f.catalog.getInteraction(item.interactionId))).toEqual(catalogReceipts);
        expect({ stop: f.runtime.getCommand(stopId), resume: f.runtime.getCommand(resumeId),
          launches: f.store.listLaunchEntries(), archives: f.store.listArchiveEntries() }).toEqual(runtimeReceipts);
        expect(await f.runtime.resolveInteraction(resolution)).toEqual(resolved);
        expect(resolutionCalls).toBe(1);
        expect((await f.runtime.readNativeHistory(healthy.sessionId, { harness, limit: 20 })).payload.json).toEqual([
          { text: "healthy replay before pump" }, { text: "healthy live after obsolete terminal replay" },
          { text: "healthy live after reconnect" },
        ]);
      } finally {
        pump?.stop();
        recording.abort();
        for (const controller of controllers) controller.abort();
        await Promise.all([recorder, ...streams]);
      }
    },
  );
});
