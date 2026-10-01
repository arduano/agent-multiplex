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
import { afterEach, expect, vi } from "vitest";

class SyntheticSession implements AdapterSession {
  readonly adapterScopeId = adapterScopeIdSchema.parse("replay-starvation");
  readonly runtimeEpoch = newRuntimeEpoch();
  readonly listeners = new Set<(event: AdapterEvent) => void>();
  readonly history: Array<{ text: string }> = [];
  stopped = false;
  constructor(readonly vendorSessionId: string, readonly cwd: string, readonly harness: "codex" | "copilot" = "codex") {}
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
  readonly adapterScopeId = adapterScopeIdSchema.parse("replay-starvation");
  readonly sessions = new Map<string, SyntheticSession>();
  private nextSession = 1;
  constructor(readonly harness: "codex" | "copilot" = "codex") {}
  describe() { return Promise.resolve({ harness: this.harness, adapterScopeId: this.adapterScopeId, available: true, capabilities: [] }); }
  listModels() { return Promise.resolve([]); }
  listSessions() {
    return Promise.resolve([...this.sessions.values()].map(session => ({ harness: this.harness,
      adapterScopeId: this.adapterScopeId, vendorSessionId: session.vendorSessionId, cwd: session.cwd,
      availability: session.stopped ? "resumable" as const : "active" as const,
      runtimeStatus: session.status(), runtimeEpoch: session.stopped ? null : session.runtimeEpoch,
      lastActivityAt: "2026-10-02T00:00:00.000Z" })));
  }
  spawn(options: HarnessSpawnOptions) {
    const session = new SyntheticSession(`synthetic-${this.nextSession++}`, options.cwd, this.harness);
    this.sessions.set(session.vendorSessionId, session);
    return Promise.resolve(session);
  }
  resume(options: HarnessResumeOptions) {
    const session = new SyntheticSession(options.vendorSessionId, options.cwd!, this.harness);
    this.sessions.set(session.vendorSessionId, session);
    return Promise.resolve(session);
  }
  releaseSession(session: RuntimeNodeSessionRecord) { this.sessions.delete(session.vendorSessionId); return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

const cleanups: Array<() => Promise<void>> = [];
export function addReplayCleanup(cleanup: () => Promise<void>): void { cleanups.push(cleanup); }
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

export async function replayFixture(options: {
  beforeForward?: (item: RuntimeNodeEventItem) => Promise<void>;
  harness?: "codex" | "copilot";
} = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "multiplex-replay-starvation-"));
  const store = new RuntimeNodeStore(":memory:");
  const runtimeNodeId = newRuntimeNodeId();
  const runtimeNodeBootId = newRuntimeNodeBootId();
  const adapter = new SyntheticAdapter(options.harness);
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
      const forward = () => {
        const result = control.publishRuntimeEvent({ ...fence, event: item }, context);
        if (result.accepted) delivered.push(item);
        else rejected.push(item);
        return result.accepted;
      };
      return options.beforeForward ? options.beforeForward(item).then(forward) : forward();
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
    runtime.createLaunch({ launchId, sessionId, runtimeNodeId, payloadHash: "synthetic-replay-launch", harness: adapter.harness,
      profile: { providerId: profile.providerId, profileId: profile.profileId, contractVersion: profile.contractVersion, requestSchemaHash: profile.requestSchemaHash }, input: { cwd } });
    await vi.waitFor(() => expect(runtime.getLaunch(launchId)?.state).toBe("succeeded"));
    const record = store.getSession(sessionId)!;
    control.publishRuntimeEvent({ ...fence, event: { kind: "control", change: { type: "session.upsert", session: record } } }, context);
    runtime.applyCanonicalSessions([catalog.getSession(sessionId)!]);
    return { sessionId, session: adapter.sessions.get(record.vendorSessionId)! };
  }
  return { runtime, store, adapter, control, catalog, context, fence, pump, subscriptions, attempted, delivered, rejected, errors, launch };
}
