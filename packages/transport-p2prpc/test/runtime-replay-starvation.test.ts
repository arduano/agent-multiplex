import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adapterScopeIdSchema, newArchiveOperationId, newCommandId, newLaunchId,
  newRuntimeEpoch, newRuntimeNodeBootId, newRuntimeNodeId, newSessionId, packNativePayload,
  type HarnessCommand, type HarnessResumeOptions, type HarnessSpawnOptions,
  type NativeHistoryRequest, type RuntimeNodeEventCursor, type RuntimeNodeEventItem,
  type RuntimeNodeSessionRecord,
} from "@arduano/agent-multiplex-protocol";
import { ControlNodeCatalog, ControlNodeService } from "../../control-node-core/src/index.js";
import {
  RuntimeNodeService, RuntimeNodeStore, type AdapterEvent, type AdapterSession, type AgentAdapter,
} from "../../runtime-node-core/src/index.js";
import { P2PRuntimeNodeConnection, RuntimeNodeEventPump } from "../src/runtime-node-bridge.js";
import { afterEach, describe, expect, it, vi } from "vitest";

class SyntheticSession implements AdapterSession {
  readonly harness = "codex" as const;
  readonly adapterScopeId = adapterScopeIdSchema.parse("replay-starvation");
  readonly runtimeEpoch = newRuntimeEpoch();
  readonly listeners = new Set<(event: AdapterEvent) => void>();
  readonly history: Array<{ text: string }> = [];
  stopped = false;
  constructor(readonly vendorSessionId: string, readonly cwd: string) {}
  status() { return this.stopped ? "stopped" as const : "idle" as const; }
  subscribe(listener: (event: AdapterEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  reply(text: string) {
    this.history.push({ text });
    for (const listener of this.listeners) listener({ kind: "native", nativeType: "item/completed", payload: { text }, ephemeral: false });
  }
  execute(_command: HarnessCommand) { return Promise.resolve(undefined); }
  readNativeHistory(_request: NativeHistoryRequest) {
    return Promise.resolve({ harness: this.harness, vendorSessionId: this.vendorSessionId, payload: [...this.history], complete: true });
  }
  stop() {
    this.stopped = true;
    for (const listener of this.listeners) listener({ kind: "status", status: "stopped" });
    return Promise.resolve();
  }
}

class SyntheticAdapter implements AgentAdapter {
  readonly harness = "codex" as const;
  readonly adapterScopeId = adapterScopeIdSchema.parse("replay-starvation");
  readonly sessions = new Map<string, SyntheticSession>();
  private nextSession = 1;
  describe() { return Promise.resolve({ harness: this.harness, adapterScopeId: this.adapterScopeId, available: true, capabilities: [] }); }
  listModels() { return Promise.resolve([]); }
  listSessions() {
    return Promise.resolve([...this.sessions.values()].map(session => ({ harness: this.harness,
      adapterScopeId: this.adapterScopeId, vendorSessionId: session.vendorSessionId, cwd: session.cwd,
      availability: session.stopped ? "resumable" as const : "active" as const,
      runtimeStatus: session.status(), runtimeEpoch: session.stopped ? null : session.runtimeEpoch })));
  }
  spawn(options: HarnessSpawnOptions) {
    const session = new SyntheticSession(`synthetic-${this.nextSession++}`, options.cwd);
    this.sessions.set(session.vendorSessionId, session);
    return Promise.resolve(session);
  }
  resume(options: HarnessResumeOptions) {
    const session = new SyntheticSession(options.vendorSessionId, options.cwd!);
    this.sessions.set(session.vendorSessionId, session);
    return Promise.resolve(session);
  }
  releaseSession(session: RuntimeNodeSessionRecord) { this.sessions.delete(session.vendorSessionId); return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "multiplex-replay-starvation-"));
  const store = new RuntimeNodeStore(":memory:");
  const runtimeNodeId = newRuntimeNodeId();
  const runtimeNodeBootId = newRuntimeNodeBootId();
  const adapter = new SyntheticAdapter();
  const runtime = new RuntimeNodeService({ store, runtimeNodeId, runtimeNodeBootId, name: "synthetic", allowedRoots: [cwd], adapters: [adapter] });
  const catalog = new ControlNodeCatalog({ filename: join(cwd, "control.sqlite") });
  const control = new ControlNodeService({ catalog });
  const context = { endpointId: "synthetic-runtime-endpoint", authenticatedRuntimeNodeId: runtimeNodeId };
  control.registerRuntimeNode(await runtime.describe(), context);
  const fence = { runtimeNodeId, runtimeNodeBootId };
  const subscriptions: Array<{ cursor: RuntimeNodeEventCursor; controller: AbortController }> = [];
  const attempted: RuntimeNodeEventItem[] = [];
  const delivered: RuntimeNodeEventItem[] = [];
  const rejected: RuntimeNodeEventItem[] = [];
  const errors: unknown[] = [];
  const connection = new P2PRuntimeNodeConnection(runtimeNodeId, runtimeNodeBootId, context.endpointId, {
    identity: { id: context.endpointId }, principal: { id: context.endpointId },
    rpc: { events: { subscribe: { subscribe: (input: { cursor: RuntimeNodeEventCursor }, callbacks: {
      onStarted?(): void; onData(item: RuntimeNodeEventItem): void; onError(error: unknown): void;
    }) => {
      const controller = new AbortController();
      subscriptions.push({ cursor: structuredClone(input.cursor), controller });
      callbacks.onStarted?.();
      void (async () => {
        try {
          for await (const item of runtime.events(input.cursor, controller.signal)) {
            if (controller.signal.aborted) break;
            callbacks.onData(item);
          }
        } catch (error) { if (!controller.signal.aborted) callbacks.onError(error); }
      })();
      return { unsubscribe() { controller.abort(); } };
    } } } },
  } as never, context.endpointId);
  const pump = new RuntimeNodeEventPump({ connection, retryDelayMs: () => 1, onError: error => { errors.push(error); },
    onItem: item => {
      attempted.push(item);
      const result = control.publishRuntimeEvent({ ...fence, event: item }, context);
      if (result.accepted) delivered.push(item);
      else rejected.push(item);
      return result.accepted;
    } });
  cleanups.push(async () => {
    pump.stop();
    for (const subscription of subscriptions) subscription.controller.abort();
    await runtime.close(); control.close(); catalog.close(); store.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  async function launch() {
    const profile = runtime.launchProfiles()[0]!;
    const sessionId = newSessionId();
    const launchId = newLaunchId();
    runtime.createLaunch({ launchId, sessionId, runtimeNodeId, payloadHash: "synthetic-replay-launch", harness: "codex",
      profile: { providerId: profile.providerId, profileId: profile.profileId, contractVersion: profile.contractVersion, requestSchemaHash: profile.requestSchemaHash }, input: { cwd } });
    await vi.waitFor(() => expect(runtime.getLaunch(launchId)?.state).toBe("succeeded"));
    const record = store.getSession(sessionId)!;
    control.publishRuntimeEvent({ ...fence, event: { kind: "control", change: { type: "session.upsert", session: record } } }, context);
    runtime.applyCanonicalSessions([catalog.getSession(sessionId)!]);
    return { sessionId, session: adapter.sessions.get(record.vendorSessionId)! };
  }
  return { runtime, store, adapter, control, catalog, context, fence, pump, subscriptions, attempted, delivered, rejected, errors, launch };
}

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
    const foreignFence = { runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId() };
    const foreignContext = { endpointId: "foreign-runtime-endpoint", authenticatedRuntimeNodeId: foreignFence.runtimeNodeId };
    f.control.registerRuntimeNode({ ...await f.runtime.describe(), ...foreignFence }, foreignContext);
    expect(() => f.control.publishRuntimeEvent({ ...foreignFence, event }, foreignContext)).toThrowError(expect.objectContaining({ code: "FENCED" }));
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
