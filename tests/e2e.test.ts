import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionCommand, spawnCommand } from "@agent-multiplex/client";
import {
  HostCatalog,
  HostService,
  type WorkerConnection,
} from "@agent-multiplex/host-core";
import {
  newOperationId,
  newRuntimeEpoch,
  newWorkerBootId,
  newWorkerId,
  type AdapterScopeId,
  type HarnessCatalogEntry,
  type HarnessCommand,
  type HarnessResumeOptions,
  type HarnessSpawnOptions,
  type JsonValue,
  type NativeHistoryRequest,
  type NativeHistoryResult,
  type NativeInventoryItem,
  type NativeModel,
  type RuntimeEpoch,
  type SessionRuntimeStatus,
  type WorkerRegistration,
} from "@agent-multiplex/protocol";
import {
  WorkerService,
  WorkerStore,
  type AdapterEvent,
  type AdapterSession,
  type AgentAdapter,
} from "@agent-multiplex/worker-core";
import { describe, expect, it } from "vitest";

describe("in-process fleet flow", () => {
  it("bridges lifecycle, events, metadata in both directions, commands, and native history", async () => {
    const allowedRoot = mkdtempSync(join(tmpdir(), "agent-multiplex-e2e-"));
    const cwd = join(allowedRoot, "repo");
    mkdirSync(cwd);
    const workerId = newWorkerId();
    const workerBootId = newWorkerBootId();
    const adapter = new MiniAdapter();
    const workerStore = new WorkerStore(":memory:");
    const worker = new WorkerService({
      store: workerStore,
      workerId,
      workerBootId,
      name: "e2e worker",
      allowedRoots: [allowedRoot],
      adapters: [adapter],
    });
    const descriptor = await worker.describe();
    const registration: WorkerRegistration = descriptor;
    const connection: WorkerConnection = {
      workerId,
      workerBootId,
      refreshInventory: () => worker.refreshInventory(),
      listModels: (harness) => worker.models(harness),
      spawn: (command) => worker.spawn(command),
      resume: (command) => worker.resume(command),
      execute: (command) => worker.execute(command),
      readNativeHistory: (sessionId, request) =>
        worker.readNativeHistory(sessionId, request),
      resolveInteraction: (input) => worker.resolveInteraction(input),
      getCommand: async (commandId) => worker.getCommand(commandId),
    };
    const catalog = new HostCatalog({ filename: ":memory:" });
    const host = new HostService({ catalog, instanceId: "e2e-host" });
    host.registerWorker(registration, {
      authenticatedWorkerId: workerId,
      workerConnection: connection,
    });

    const spawn = spawnCommand(
      workerId,
      { harness: "codex", cwd },
      { "agent.title": "fleet test" },
    );
    await expect(host.spawn(spawn)).resolves.toMatchObject({ state: "succeeded" });
    const session = host.getSession(spawn.sessionId);
    expect(session).toMatchObject({
      harness: "codex",
      availability: "active",
      runtimeStatus: "idle",
    });
    if (!session) throw new Error("spawned session was not reconciled");

    const workerEvents = worker
      .events({ native: {} })
      [Symbol.asyncIterator]();
    const nextWorkerEvent = workerEvents.next();
    const hostEvents = host
      .watchSessions({
        sessions: [session.sessionId],
        includeNative: true,
        cursor: { ...catalog.feedCheckpoint(), native: {} },
      })
      [Symbol.asyncIterator]();
    const nextHostEvent = hostEvents.next();

    const command = sessionCommand(session, {
      harness: "codex",
      command: { type: "send", input: "multiplex this" },
    });
    await expect(host.execute(command)).resolves.toMatchObject({ state: "succeeded" });
    const workerEvent = await nextWorkerEvent;
    expect(workerEvent.value).toMatchObject({
      kind: "native",
      sessionId: session.sessionId,
      nativeType: "mini/agent-message",
    });
    if (!workerEvent.value) throw new Error("worker event stream ended");
    expect(
      host.publishWorkerEvent(workerEvent.value, { authenticatedWorkerId: workerId }),
    ).toEqual({ accepted: true });
    let hostEvent = await nextHostEvent;
    while (!hostEvent.done && hostEvent.value.kind !== "native") {
      hostEvent = await hostEvents.next();
    }
    expect(hostEvent).toMatchObject({
      value: {
        kind: "native",
        sessionId: session.sessionId,
        payload: { text: "multiplex this" },
      },
    });

    const workerPatch = {
      operationId: newOperationId(),
      sessionId: session.sessionId,
      set: { "worker.checkout": "ready" },
    };
    worker.enqueueMetadata(workerPatch);
    const pushed = host.pushMetadataOutbox(workerId, worker.metadataOutbox(), {
      authenticatedWorkerId: workerId,
    });
    worker.settleMetadataOutbox(pushed);
    expect(worker.metadataOutbox()).toEqual([]);
    expect(host.getMetadata(session.sessionId).values["worker.checkout"]).toBe("ready");

    host.patchMetadata({
      operationId: newOperationId(),
      sessionId: session.sessionId,
      set: { "dashboard.priority": 3 },
    });
    worker.applyCanonicalSessions(host.listSessions({ workerId }));
    expect(
      workerStore.getSession(session.sessionId)?.metadata.values["dashboard.priority"],
    ).toBe(3);

    await expect(
      host.readNativeHistory(session.sessionId, {
        harness: "codex",
        includeTurns: true,
      }),
    ).resolves.toMatchObject({
      harness: "codex",
      payload: { prompts: ["multiplex this"], provider: "mini-native-api" },
    });

    await workerEvents.return?.();
    await hostEvents.return?.();
    await worker.close();
    host.close();
    catalog.close();
    workerStore.close();
  });
});

class MiniAdapter implements AgentAdapter {
  readonly harness = "codex" as const;
  readonly adapterScopeId = "mini:codex" as AdapterScopeId;
  readonly sessions = new Map<string, MiniSession>();

  async describe(): Promise<HarnessCatalogEntry> {
    return {
      harness: "codex",
      adapterScopeId: this.adapterScopeId,
      available: true,
      capabilities: [{ name: "native-history" }],
    };
  }

  async listModels(): Promise<NativeModel[]> {
    return [{ harness: "codex", id: "mini-model" }];
  }

  async listSessions(): Promise<NativeInventoryItem[]> {
    return [...this.sessions.values()].map((session) => ({
      harness: "codex",
      adapterScopeId: this.adapterScopeId,
      vendorSessionId: session.vendorSessionId,
      cwd: session.cwd,
      availability: "active",
      runtimeStatus: session.status(),
      runtimeEpoch: session.runtimeEpoch,
      lastActivityAt: new Date().toISOString(),
    }));
  }

  async spawn(options: HarnessSpawnOptions): Promise<AdapterSession> {
    if (options.harness !== "codex") throw new Error("unexpected harness");
    const session = new MiniSession("mini-session", options.cwd, this.adapterScopeId);
    this.sessions.set(session.vendorSessionId, session);
    return session;
  }

  async resume(options: HarnessResumeOptions): Promise<AdapterSession> {
    if (options.harness !== "codex") throw new Error("unexpected harness");
    return (
      this.sessions.get(options.vendorSessionId) ??
      new MiniSession(options.vendorSessionId, options.cwd ?? null, this.adapterScopeId)
    );
  }

  async close(): Promise<void> {}
}

class MiniSession implements AdapterSession {
  readonly harness = "codex" as const;
  readonly runtimeEpoch: RuntimeEpoch = newRuntimeEpoch();
  readonly #listeners = new Set<(event: AdapterEvent) => void>();
  readonly #prompts: string[] = [];
  #status: SessionRuntimeStatus = "idle";

  constructor(
    readonly vendorSessionId: string,
    readonly cwd: string | null,
    readonly adapterScopeId: AdapterScopeId,
  ) {}

  status(): SessionRuntimeStatus {
    return this.#status;
  }

  subscribe(listener: (event: AdapterEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async execute(request: HarnessCommand): Promise<JsonValue> {
    if (request.harness !== "codex" || request.command.type !== "send") {
      return { accepted: true };
    }
    const prompt = String(request.command.input);
    this.#prompts.push(prompt);
    for (const listener of this.#listeners) {
      listener({
        kind: "native",
        nativeType: "mini/agent-message",
        payload: { text: prompt },
        ephemeral: false,
      });
    }
    return { accepted: true };
  }

  async readNativeHistory(request: NativeHistoryRequest): Promise<NativeHistoryResult> {
    if (request.harness !== "codex") throw new Error("unexpected harness");
    return {
      harness: "codex",
      vendorSessionId: this.vendorSessionId,
      payload: { provider: "mini-native-api", prompts: this.#prompts },
      complete: true,
    };
  }

  async stop(): Promise<void> {
    this.#status = "stopped";
  }
}
