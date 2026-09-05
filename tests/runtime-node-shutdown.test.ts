import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emptyMetadataSnapshot,
  newArchiveOperationId,
  newAuthorityEpochId,
  newCommandId,
  newControlNodeId,
  newLaunchId,
  newRealmId,
  newRuntimeEpoch,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  newTerminalClientId,
  type AdapterScopeId,
  type HarnessCatalogEntry,
  packNativePayload,
  type NativeInventoryItem,
  type NativeModel,
} from "@arduano/agent-multiplex-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runtimeBackendForAdapter, type AdapterEvent, type AdapterNativeHistoryResult } from "../packages/runtime-node-core/src/adapter.js";
import { DirectWorkspaceLaunchProvider } from "../packages/runtime-node-core/src/launch-provider.js";
import { RuntimeNodeService } from "../packages/runtime-node-core/src/service.js";
import { RuntimeNodeStore } from "../packages/runtime-node-core/src/store.js";
import { TerminalBroker, type TerminalProvider } from "../packages/runtime-node-core/src/terminal.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

describe("runtime node shutdown", () => {
  it("drains an admitted resume before closing its newly installed handle and fences new work", async () => {
    const fixture = createFixture();
    const { service, adapter, session, resume, launch } = fixture;
    const started = deferred();
    const gate = deferred();
    adapter.resume.mockImplementation(async () => {
      started.resolve();
      await gate.promise;
      return session;
    });
    const result = service.resume(resume);
    await started.promise;
    const closing = service.close();
    expect(service.close()).toBe(closing);
    await expect(service.resume(resume)).rejects.toMatchObject({ code: "FENCED" });
    await expect(service.readNativeHistory(resume.sessionId, { harness: "codex", request: {} }))
      .rejects.toMatchObject({ code: "FENCED" });
    await expect(service.models("codex")).rejects.toMatchObject({ code: "FENCED" });
    expect(() => service.createLaunch(launch)).toThrow(expect.objectContaining({ code: "FENCED" }));
    expect(() => service.archive(fixture.archive)).toThrow(expect.objectContaining({ code: "FENCED" }));
    expect(adapter.close).not.toHaveBeenCalled();
    expect(session.stop).not.toHaveBeenCalled();

    gate.resolve();
    await expect(result).resolves.toMatchObject({ state: "succeeded" });
    await closing;
    expect(session.stop).toHaveBeenCalledOnce();
    expect(adapter.close).toHaveBeenCalledOnce();
    expect(session.stop.mock.invocationCallOrder[0]).toBeLessThan(adapter.close.mock.invocationCallOrder[0]!);
  });

  it("drains temporary native history and its delayed stop before closing backends", async () => {
    const { service, adapter, session, resume } = createFixture();
    const started = deferred();
    const historyGate = deferred();
    const stopStarted = deferred();
    const stopGate = deferred();
    session.readNativeHistory.mockImplementation(async () => {
      started.resolve();
      await historyGate.promise;
      return historyResult();
    });
    session.stop.mockImplementation(async () => {
      stopStarted.resolve();
      await stopGate.promise;
    });
    const history = service.readNativeHistory(resume.sessionId, { harness: "codex", request: {} });
    await started.promise;
    const closing = service.close();
    expect(adapter.close).not.toHaveBeenCalled();
    historyGate.resolve();
    await stopStarted.promise;
    expect(adapter.close).not.toHaveBeenCalled();
    stopGate.resolve();
    await expect(history).resolves.toEqual({ ...historyResult(), payload: packNativePayload(historyResult().payload) });
    await closing;
    expect(session.stop).toHaveBeenCalledOnce();
    expect(adapter.close).toHaveBeenCalledOnce();
  });

  it.each(["catalog", "models", "profile", "inventory"] as const)(
    "waits for sibling %s requests after an early backend failure",
    async (operation) => {
      const second = createAdapter("second");
      const { service, adapter, provider } = createFixture([second]);
      const started = deferred();
      const gate = deferred();
      const failure = new Error("first backend failed");
      if (operation === "catalog") {
        adapter.describe.mockRejectedValue(failure);
        second.describe.mockImplementation(async () => {
          started.resolve();
          await gate.promise;
          return catalogEntry(second.adapterScopeId);
        });
      } else if (operation === "inventory") {
        adapter.listSessions.mockRejectedValue(failure);
        second.listSessions.mockImplementation(async () => {
          started.resolve();
          await gate.promise;
          return [];
        });
      } else {
        adapter.listModels.mockRejectedValue(failure);
        second.listModels.mockImplementation(async () => {
          started.resolve();
          await gate.promise;
          return [];
        });
      }
      const work = operation === "catalog" ? service.describe()
        : operation === "models" ? service.models("codex")
          : operation === "profile" ? service.launchProfileModels(provider.descriptor, "codex")
            : service.refreshInventory();
      const observed = work.catch((error: unknown) => error);
      await started.promise;
      const closing = service.close();
      await Promise.resolve();
      expect(adapter.close).not.toHaveBeenCalled();
      expect(second.close).not.toHaveBeenCalled();
      gate.resolve();
      if (operation === "inventory") {
        await expect(observed).resolves.toMatchObject({ complete: false });
      } else {
        await expect(observed).resolves.toBe(failure);
      }
      await closing;
      expect(second.close).toHaveBeenCalledOnce();
    },
  );

  it("waits for native interaction resolution before unsubscribing the session", async () => {
    const { service, session, resume, adapter, unsubscribe } = createFixture();
    await service.resume(resume);
    const started = deferred();
    const gate = deferred();
    session.subscribe.mock.calls[0]![0]({
      kind: "interaction", requestType: "approval", payload: {}, ephemeral: false,
      resolve: async () => { started.resolve(); await gate.promise; },
    });
    const interaction = service.listInteractions()[0]!;
    const resolution = service.resolveInteraction({
      interactionId: interaction.interactionId,
      sessionId: resume.sessionId,
      harness: "codex",
      response: { approved: true },
    });
    await started.promise;
    const closing = service.close();
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(adapter.close).not.toHaveBeenCalled();
    gate.resolve();
    await expect(resolution).resolves.toMatchObject({ state: "resolved" });
    await closing;
  });

  it.each(["launch", "archive"] as const)("drains admitted %s work before closing providers", async (operation) => {
    const { service, adapter, session, launch, archive, provider } = createFixture();
    const started = deferred();
    const gate = deferred();
    if (operation === "launch") {
      adapter.spawn.mockImplementation(async () => {
        started.resolve();
        await gate.promise;
        return { ...session, vendorSessionId: "native-launched-during-shutdown" };
      });
      service.createLaunch(launch);
    } else {
      adapter.releaseSession.mockImplementation(async () => {
        started.resolve();
        await gate.promise;
      });
      service.archive(archive);
    }
    await started.promise;
    const closing = service.close();
    expect(adapter.close).not.toHaveBeenCalled();
    expect(provider.close).not.toHaveBeenCalled();
    gate.resolve();
    await closing;
    expect(operation === "launch" ? service.getLaunch(launch.launchId) : service.getArchive(archive.archiveOperationId))
      .toMatchObject({ state: "succeeded" });
    expect(provider.close).toHaveBeenCalledOnce();
  });

  it("attempts every cleanup and waits for a slow backend despite other shutdown failures", async () => {
    const second = createAdapter("second");
    const { service, adapter, session, resume, provider, unsubscribe } = createFixture([second]);
    await service.resume(resume);
    unsubscribe.mockImplementation(() => { throw new Error("unsubscribe failed"); });
    session.stop.mockRejectedValue(new Error("session stop failed"));
    adapter.close.mockImplementation(() => { throw new Error("adapter close failed"); });
    provider.close.mockRejectedValue(new Error("provider close failed"));
    const started = deferred();
    const gate = deferred();
    second.close.mockImplementation(async () => {
      started.resolve();
      await gate.promise;
    });
    const closing = service.close();
    const failure = closing.catch((error: unknown) => error);
    await started.promise;
    expect(service.close()).toBe(closing);
    expect(session.stop).toHaveBeenCalledOnce();
    expect(provider.close).not.toHaveBeenCalled();
    gate.resolve();
    const error = await failure;
    expect(error).toBeInstanceOf(AggregateError);
    expect(allErrors(error)).toEqual(expect.arrayContaining([
      "unsubscribe failed", "session stop failed", "adapter close failed", "provider close failed",
    ]));
    expect(provider.close).toHaveBeenCalledOnce();
    await expect(service.close()).rejects.toBe(error);
    expect(second.close).toHaveBeenCalledOnce();
  });

  it("attempts terminal cleanup and waits for every provider when disposal or kill throws", async () => {
    const started = deferred();
    const gate = deferred();
    const exitDisposer = vi.fn();
    const process = {
      startupOutputComplete: true,
      onData: () => () => { throw new Error("terminal unsubscribe failed"); },
      onExit: () => exitDisposer,
      write: () => {}, resize: () => {},
      kill: vi.fn(() => { throw new Error("terminal kill failed"); }),
    };
    const first = {
      harness: "codex", adapterScopeId: "shutdown:terminal-one" as AdapterScopeId,
      backend: "mock", sharing: "session",
      capabilities: { write: true, resize: true, terminate: true, restart: true, foregroundSwitch: false },
      open: async () => process,
      close: vi.fn((): Promise<void> => { throw new Error("terminal provider failed"); }),
    } satisfies TerminalProvider;
    const second = {
      ...first, adapterScopeId: "shutdown:terminal-two" as AdapterScopeId,
      close: vi.fn(async () => { started.resolve(); await gate.promise; }),
    };
    const broker = new TerminalBroker({ runtimeNodeBootId: newRuntimeNodeBootId(), providers: [first, second] });
    const target = { sessionId: newSessionId(), runtimeNodeId: newRuntimeNodeId(), bindingRevision: 1 };
    await broker.open({
      target, harness: "codex", adapterScopeId: first.adapterScopeId,
      vendorSessionId: "terminal-shutdown", cwd: "/tmp",
    }, { ...target, terminalClientId: newTerminalClientId() });
    const closing = broker.close();
    const failure = closing.catch((error: unknown) => error);
    expect(broker.close()).toBe(closing);
    await started.promise;
    expect(exitDisposer).toHaveBeenCalledOnce();
    expect(process.kill).toHaveBeenCalledOnce();
    gate.resolve();
    expect(allErrors(await failure)).toEqual(expect.arrayContaining([
      "terminal unsubscribe failed", "terminal kill failed", "terminal provider failed",
    ]));
    expect(second.close).toHaveBeenCalledOnce();
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function catalogEntry(adapterScopeId: AdapterScopeId): HarnessCatalogEntry {
  return { harness: "codex", adapterScopeId, available: true, capabilities: [] };
}

function createAdapter(scope: string) {
  const adapterScopeId = `shutdown:${scope}` as AdapterScopeId;
  return {
    harness: "codex" as const,
    adapterScopeId,
    describe: vi.fn(async () => catalogEntry(adapterScopeId)),
    listModels: vi.fn(async (): Promise<NativeModel[]> => []),
    listSessions: vi.fn(async (): Promise<NativeInventoryItem[]> => []),
    spawn: vi.fn(async () => createSession(adapterScopeId, "/tmp").session),
    resume: vi.fn(async () => createSession(adapterScopeId, "/tmp").session),
    releaseSession: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

function historyResult(): AdapterNativeHistoryResult {
  return { harness: "codex", vendorSessionId: "native-shutdown", payload: [], complete: true };
}

function createSession(adapterScopeId: AdapterScopeId, cwd: string) {
  const unsubscribe = vi.fn(() => {});
  const session = {
    harness: "codex" as const,
    adapterScopeId,
    vendorSessionId: "native-shutdown",
    cwd,
    runtimeEpoch: newRuntimeEpoch(),
    status: () => "idle" as const,
    subscribe: vi.fn((_listener: (event: AdapterEvent) => void) => unsubscribe),
    execute: vi.fn(async () => undefined),
    readNativeHistory: vi.fn(async () => historyResult()),
    stop: vi.fn(async () => {}),
  };
  return { session, unsubscribe };
}

function createFixture(additionalAdapters: ReturnType<typeof createAdapter>[] = []) {
  const root = mkdtempSync(join(tmpdir(), "agent-multiplex-shutdown-"));
  const store = new RuntimeNodeStore(":memory:");
  const adapter = createAdapter("first");
  const { session, unsubscribe } = createSession(adapter.adapterScopeId, root);
  adapter.resume.mockResolvedValue(session);
  adapter.spawn.mockResolvedValue(session);
  const backends = [adapter, ...additionalAdapters].map((adapter) => runtimeBackendForAdapter(adapter));
  const provider = Object.assign(new DirectWorkspaceLaunchProvider({ backends }), {
    close: vi.fn(async () => {}),
  });
  const runtimeNodeId = newRuntimeNodeId();
  const service = new RuntimeNodeService({
    store, runtimeNodeId, runtimeNodeBootId: newRuntimeNodeBootId(), name: "shutdown runtime",
    allowedRoots: [root], backends, launchProviders: [provider], includeDirectWorkspaceProvider: false,
  });
  cleanup.push(async () => {
    await service.close().catch(() => {});
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const sessionId = newSessionId();
  const timestamp = new Date().toISOString();
  const metadataAuthority = { realmId: newRealmId(), controlNodeId: newControlNodeId(), epochId: newAuthorityEpochId() };
  store.putSession({
    sessionId, runtimeNodeId, harness: "codex", adapterScopeId: adapter.adapterScopeId,
    vendorSessionId: session.vendorSessionId, bindingRevision: 1, runtimeEpoch: null,
    cwd: root, availability: "resumable", runtimeStatus: "stopped", launchProvenance: null,
    metadata: emptyMetadataSnapshot(), metadataAuthority,
    createdAt: timestamp, updatedAt: timestamp, lastSeenAt: timestamp,
  });
  return {
    service, adapter, session, provider, unsubscribe,
    resume: { operation: "resume" as const, commandId: newCommandId(), payloadHash: "shutdown-resume-payload", sessionId, runtimeNodeId, bindingRevision: 1 },
    launch: { launchId: newLaunchId(), payloadHash: "shutdown-launch-payload", sessionId: newSessionId(), runtimeNodeId, harness: "codex" as const, profile: provider.descriptor, input: { cwd: root } },
    archive: { archiveOperationId: newArchiveOperationId(), payloadHash: "shutdown-archive", sessionId, runtimeNodeId, bindingRevision: 1, expectedAuthority: metadataAuthority },
  };
}

function allErrors(error: unknown): string[] {
  return error instanceof AggregateError ? error.errors.flatMap(allErrors)
    : error instanceof Error ? [error.message] : [String(error)];
}
