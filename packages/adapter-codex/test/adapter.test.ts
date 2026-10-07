import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAdapter } from "../src/adapter.js";
import { CodexRpcClient } from "../src/rpc.js";
import {
  newCommandId,
  newLaunchId,
  newSessionId,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  type HarnessSpawnOptions,
  type JsonValue,
  type LaunchRecord,
  type RuntimeNodeEventItem,
} from "@arduano/agent-multiplex-protocol";
import {
  AdapterOutcomeUnknownError,
  RuntimeNodeService,
  RuntimeNodeStore,
  type AdapterEvent,
} from "@arduano/agent-multiplex-runtime-node-core";
import { describe, expect, it, vi } from "vitest";

describe("CodexAdapter", () => {
  it("attempts both RPC and shared-owner cleanup and retains their shared failure", async () => {
    const rpc = new CodexRpcClient();
    const rpcFailure = new Error("RPC cleanup failed");
    const runtimeFailure = new Error("runtime cleanup failed");
    const rpcClose = vi.spyOn(rpc, "close").mockRejectedValue(rpcFailure);
    const closeRuntime = vi.fn((): Promise<void> => { throw runtimeFailure; });
    const adapter = new CodexAdapter({ rpcClient: rpc, closeRuntime });
    const closing = adapter.close();
    expect(adapter.close()).toBe(closing);
    await expect(closing).rejects.toMatchObject({ errors: [rpcFailure, runtimeFailure] });
    expect(rpcClose).toHaveBeenCalledTimes(1);
    expect(closeRuntime).toHaveBeenCalledTimes(1);
  });

  it("reports a missing app-server executable without an unhandled rejection", async () => {
    const adapter = new CodexAdapter({
      binary: `definitely-missing-codex-${process.pid}`,
    });
    await expect(adapter.describe()).resolves.toMatchObject({
      harness: "codex",
      available: false,
      unavailableReason: expect.any(String),
    });
    // Let both child-process error/exit callbacks settle; Vitest fails the test
    // if either path leaks an unhandled rejected request promise.
    await new Promise((resolve) => setImmediate(resolve));
    await adapter.close();
  });

  it("uses the native handshake, streaming, reverse interaction, and paginated history APIs", async () => {
    const adapter = new CodexAdapter({
      spawnProcess: () => spawnFakeCodex(false),
    });
    await expect(adapter.describe()).resolves.toMatchObject({
      harness: "codex",
      available: true,
      runtimeVersion: "0.158.0",
      capabilities: expect.arrayContaining([
        { name: "turn.settings.update", version: "v2", experimental: true },
        { name: "background-terminals", version: "v2", experimental: true },
      ]),
    });

    const session = await adapter.spawn({
      harness: "codex",
      cwd: "/work/project",
      model: "fake-model",
    });
    const events: AdapterEvent[] = [];
    session.subscribe((event) => events.push(event));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "native",
        nativeType: "thread/status/changed",
      }),
      expect.objectContaining({
        kind: "interaction",
        nativeRequestId: "899",
        requestType: "approval",
      }),
    ]));
    const startupInteraction = events.find(
      (event) => event.kind === "interaction" && event.nativeRequestId === "899",
    );
    if (startupInteraction?.kind !== "interaction") {
      throw new Error("expected buffered startup interaction");
    }
    await startupInteraction.resolve({ decision: "accept" });

    await expect(
      session.execute({
        harness: "codex",
        command: { type: "setEffort", effort: "high" },
      }),
    ).resolves.toMatchObject({ received: { effort: "high" } });

    await expect(
      session.execute({
        harness: "codex",
        command: { type: "setModel", model: "second-model" },
      }),
    ).resolves.toMatchObject({ received: { model: "second-model" } });

    await expect(
      session.execute({
        harness: "codex",
        command: { type: "setMode", mode: "plan" },
      }),
    ).resolves.toMatchObject({
      received: {
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "second-model",
            reasoning_effort: "high",
            developer_instructions: null,
          },
        },
      },
    });

    await expect(
      session.execute({
        harness: "codex",
        command: { type: "setModel", model: "third-model" },
      }),
    ).resolves.toMatchObject({
      received: {
        model: "third-model",
        collaborationMode: {
          mode: "plan",
          settings: { model: "third-model", reasoning_effort: "high" },
        },
      },
    });

    await expect(
      session.execute({
        harness: "codex",
        command: { type: "setEffort", effort: "ultra" },
      }),
    ).resolves.toMatchObject({
      received: {
        effort: "ultra",
        collaborationMode: {
          mode: "plan",
          settings: { model: "third-model", reasoning_effort: "ultra" },
        },
      },
    });

    await expect(
      session.execute({
        harness: "codex",
        command: { type: "send", input: "hello from test" },
      }),
    ).resolves.toMatchObject({ turn: { id: "turn-1" } });

    await expect(
      session.execute({
        harness: "codex",
        command: { type: "updateTurnSettings", effort: "xhigh" },
      }),
    ).resolves.toMatchObject({ received: { turnId: "turn-1", effort: "xhigh" } });

    await expect(
      session.execute({
        harness: "codex",
        command: { type: "listBackgroundTerminals", limit: 10 },
      }),
    ).resolves.toMatchObject({
      data: [{ processId: "process-1", command: "sleep 30" }],
      nextCursor: null,
    });

    await expect(
      session.execute({
        harness: "codex",
        command: { type: "terminateBackgroundTerminal", processId: "process-1" },
      }),
    ).resolves.toEqual({ terminated: true });

    await expect(
      session.execute({
        harness: "codex",
        command: { type: "cleanBackgroundTerminals" },
      }),
    ).resolves.toEqual({});

    const interaction = await eventually(() =>
      events.find(
        (event) => event.kind === "interaction" && event.nativeRequestId === "900",
      ),
    );
    expect(interaction).toMatchObject({
      kind: "interaction",
      nativeRequestId: "900",
      requestType: "userInput",
    });
    if (interaction.kind !== "interaction") throw new Error("expected interaction");
    await interaction.resolve({ answers: { question: { answers: ["yes"] } } });
    await eventually(() =>
      events.find(
        (event) =>
          event.kind === "native" &&
          event.nativeType === "fake/interaction-resolved",
      ),
    );

    await expect(
      session.readNativeHistory({
        harness: "codex",
        includeTurns: true,
        // Opaque extension fields must never override the bound session or
        // the typed history contract.
        native: { threadId: "another-thread", includeTurns: false },
      }),
    ).resolves.toMatchObject({
      harness: "codex",
      vendorSessionId: "thread-1",
      complete: true,
      payload: {
        data: [{ turnId: "turn-1", item: { type: "agentMessage" } }],
        nextCursor: null,
      },
      conversation: {
        version: "v1", view: "primary", coverage: { kind: "unknown" },
        items: [{
          itemId: 'codex:["thread-1","turn-1","history-1"]', threadId: "thread-1",
          pointer: "/data/0/item", revision: { kind: "incomparable" },
          position: { kind: "unknown" }, completion: "unverified", persistence: "native",
        }],
      },
    });
    expect(
      events.some(
        (event) =>
          event.kind === "native" && event.nativeType === "item/agentMessage/delta",
      ),
    ).toBe(true);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "native",
        nativeType: "item/started",
        payload: expect.objectContaining({ threadId: "child-thread-1" }),
        conversation: expect.objectContaining({ view: "child", items: expect.arrayContaining([
          expect.objectContaining({ threadId: "child-thread-1", completion: "open" }),
        ]) }),
      }),
    ]));

    await adapter.close();
  });

  it("uses spawn-time settings for an immediate Plan-mode switch", async () => {
    const adapter = new CodexAdapter({
      spawnProcess: () => spawnFakeCodex(false),
    });
    const session = await adapter.spawn({
      harness: "codex",
      cwd: "/work/project",
      effort: "high",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "fake-model",
          reasoning_effort: "high",
          developer_instructions: null,
        },
      },
    });

    await expect(
      session.execute({
        harness: "codex",
        command: { type: "setMode", mode: "plan" },
      }),
    ).resolves.toMatchObject({
      received: {
        collaborationMode: {
          mode: "plan",
          settings: { reasoning_effort: "high" },
        },
      },
    });

    await expect(
      session.execute({
        harness: "codex",
        command: { type: "setModel", model: "second-model" },
      }),
    ).resolves.toMatchObject({
      received: {
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "second-model",
            reasoning_effort: "high",
          },
        },
      },
    });

    await adapter.close();
  });

  it("does not resurrect a turn that completes before turn/start resolves", async () => {
    const adapter = new CodexAdapter({
      spawnProcess: () => spawnFakeCodex(false, "/work/project", false, true),
    });
    const session = await adapter.spawn({ harness: "codex", cwd: "/work/project" });
    const events: AdapterEvent[] = [];
    session.subscribe((event) => events.push(event));
    const startup = events.find(
      (event) => event.kind === "interaction" && event.nativeRequestId === "899",
    );
    if (startup?.kind !== "interaction") throw new Error("expected startup approval");
    await startup.resolve({ decision: "accept" });

    await expect(
      session.execute({
        harness: "codex",
        command: { type: "send", input: "finish synchronously" },
      }),
    ).resolves.toMatchObject({ turn: { id: "turn-1" } });
    await eventually(() =>
      events.find(
        (event) => event.kind === "native" && event.nativeType === "turn/completed",
      ),
    );

    expect(session.status()).toBe("idle");
    await adapter.close();
  });

  it("marks a dispatched native call outcome unknown when app-server exits before replying", async () => {
    const adapter = new CodexAdapter({
      spawnProcess: () => spawnFakeCodex(true),
    });
    const session = await adapter.spawn({ harness: "codex", cwd: "/work/project" });
    await expect(
      session.execute({
        harness: "codex",
        command: { type: "send", input: "ambiguous prompt" },
      }),
    ).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    await adapter.close();
  });

  it("classifies an unsubscribed but still loaded Codex thread as resumable", async () => {
    const adapter = new CodexAdapter({
      spawnProcess: () => spawnFakeCodex(false),
    });
    const session = await adapter.spawn({
      harness: "codex",
      cwd: "/work/project",
    });

    await expect(adapter.listSessions()).resolves.toEqual([
      expect.objectContaining({
        vendorSessionId: "thread-1",
        availability: "active",
        runtimeStatus: "waitingForInput",
        runtimeEpoch: session.runtimeEpoch,
      }),
    ]);

    await session.stop();

    await expect(adapter.listSessions()).resolves.toEqual([
      expect.objectContaining({
        vendorSessionId: "thread-1",
        availability: "resumable",
        runtimeStatus: "stopped",
        runtimeEpoch: null,
      }),
    ]);
    await adapter.close();
  });

  it("retires a native-cleared question after interrupt", async () => {
    const adapter = new CodexAdapter({ spawnProcess: () => spawnFakeCodex(false) });
    const session = await adapter.spawn({ harness: "codex", cwd: "/work/project" });
    const events: AdapterEvent[] = [];
    session.subscribe((event) => events.push(event));
    const startup = events.find(
      (event) => event.kind === "interaction" && event.nativeRequestId === "899",
    );
    if (startup?.kind !== "interaction") throw new Error("expected startup approval");
    await startup.resolve({ decision: "accept" });
    await session.execute({ harness: "codex", command: { type: "send", input: "ask" } });
    await eventually(() => events.find(
      (event) => event.kind === "interaction" && event.nativeRequestId === "900",
    ));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "native",
        nativeType: "item/started",
        payload: expect.objectContaining({
          turnId: "turn-1",
          item: expect.objectContaining({
            id: "terminal-item-1",
            type: "commandExecution",
          }),
        }),
      }),
    ]));
    await session.execute({ harness: "codex", command: { type: "interrupt" } });
    await expect(session.execute({
      harness: "codex",
      command: { type: "listBackgroundTerminals", limit: 10 },
    })).resolves.toMatchObject({ data: [] });
    await expect(eventually(() => events.find(
      (event) => event.kind === "interactionSettled" && event.nativeRequestId === "900",
    ))).resolves.toMatchObject({ state: "stale" });
    await expect(eventually(() => events.find(
      (event) => event.kind === "native" && event.nativeType === "fake/terminal-terminated",
    ))).resolves.toMatchObject({
      payload: expect.objectContaining({ itemId: "terminal-item-1" }),
    });
    await adapter.close();
  });

  it("keeps a resumed binding commandable across Codex's transient notLoaded status", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-codex-resume-"));
    const adapter = new CodexAdapter({
      spawnProcess: () => spawnFakeCodex(false, root, true),
    });
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "Codex resume status test runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });
    const sessionId = newSessionId();
    try {
      await expect(launchSession(service, {
        launchId: newLaunchId(),
        payloadHash: "codex-resume-status-spawn",
        sessionId,
        runtimeNodeId,
        request: { harness: "codex", cwd: root },
      })).resolves.toMatchObject({ state: "succeeded" });
      const attached = await adapter.resume({
        harness: "codex",
        vendorSessionId: "thread-1",
        cwd: root,
      });
      await attached.stop();
      await expect(service.resume({
        operation: "resume",
        commandId: newCommandId(),
        payloadHash: "codex-resume-status-resume",
        sessionId,
        runtimeNodeId,
        bindingRevision: 1,
      })).resolves.toMatchObject({ state: "succeeded" });

      await expect(service.execute({
        commandId: newCommandId(),
        payloadHash: "codex-resume-status-send",
        sessionId,
        runtimeNodeId,
        bindingRevision: 1,
        request: {
          harness: "codex",
          command: { type: "send", input: "still attached" },
        },
      })).resolves.toMatchObject({ state: "succeeded" });
    } finally {
      await service.close();
      store.close();
    }
  });

  it("closes Runtime despite an admitted native history read that never responds", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-codex-hung-read-"));
    const adapter = new CodexAdapter({ spawnProcess: () => spawnFakeCodex(false, root, false, false, true) });
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const service = new RuntimeNodeService({
      store, runtimeNodeId, runtimeNodeBootId: newRuntimeNodeBootId(), name: "hung-read runtime",
      allowedRoots: [root], adapters: [adapter],
    });
    const sessionId = newSessionId();
    const reading: AdapterEvent[] = [];
    try {
      await expect(launchSession(service, {
        launchId: newLaunchId(), payloadHash: "codex-hung-read-spawn", sessionId, runtimeNodeId,
        request: { harness: "codex", cwd: root },
      })).resolves.toMatchObject({ state: "succeeded" });
      const session = await adapter.resume({ harness: "codex", vendorSessionId: "thread-1", cwd: root });
      session.subscribe((event) => reading.push(event));
      const history = service.readNativeHistory(sessionId, { harness: "codex", includeTurns: false });
      const rejected = expect(history).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
      await eventually(() => reading.find((event) => event.kind === "native" && event.nativeType === "fake/history-request-started"));
      const closing = service.close();
      expect(service.close()).toBe(closing);
      await Promise.all([closing, rejected]);
    } finally {
      await service.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases runtime-node ownership and stales interactions when app-server exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-multiplex-codex-exit-"));
    let processEpoch = 0;
    const adapter = new CodexAdapter({
      spawnProcess: () => spawnFakeCodex(processEpoch++ === 0, root),
    });
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "Codex exit test runtime node",
      allowedRoots: [root],
      adapters: [adapter],
    });
    const sessionId = newSessionId();
    const observers: Array<AsyncIterator<RuntimeNodeEventItem>> = [];
    try {
      await expect(launchSession(service, {
        launchId: newLaunchId(),
        payloadHash: "codex-exit-spawn",
        sessionId,
        runtimeNodeId,
        request: { harness: "codex", cwd: root },
      })).resolves.toMatchObject({ state: "succeeded" });
      await eventually(() => service.listInteractions(sessionId).length === 1 || undefined);
      const originalEpoch = store.getSession(sessionId)?.runtimeEpoch;
      expect(originalEpoch).toEqual(expect.any(String));
      const interaction = service.listInteractions(sessionId)[0]!;
      // Subscribe before the process exits: terminal diagnostics stay in an
      // existing live queue even though the stopped epoch's ring is retired.
      const live = service.events({ native: {} })[Symbol.asyncIterator]();
      observers.push(live);

      await expect(service.execute({
        commandId: newCommandId(),
        payloadHash: "codex-exit-send",
        sessionId,
        runtimeNodeId,
        bindingRevision: 1,
        request: {
          harness: "codex",
          command: { type: "send", input: "exit before replying" },
        },
      })).resolves.toMatchObject({ state: "outcomeUnknown" });
      expect(store.getSession(sessionId)?.runtimeStatus).toBe("stopped");
      expect(service.listInteractions(sessionId)).toEqual([]);

      const liveItems: RuntimeNodeEventItem[] = [];
      while (true) {
        const item = await live.next();
        if (item.done) throw new Error("live Codex observer closed before stale interaction");
        liveItems.push(item.value);
        if (item.value.kind === "control" &&
            item.value.change.type === "interaction.changed" &&
            item.value.change.interaction.interactionId === interaction.interactionId &&
            item.value.change.interaction.state === "stale") break;
      }
      const diagnosticIndex = liveItems.findIndex((item) =>
        item.kind === "native" && item.nativeType === "agent-multiplex/runtime-exited");
      const stoppedIndex = liveItems.findIndex((item) =>
        item.kind === "control" && item.change.type === "session.upsert" &&
        item.change.session.runtimeStatus === "stopped");
      expect(diagnosticIndex).toBeGreaterThanOrEqual(0);
      expect(stoppedIndex).toBeGreaterThan(diagnosticIndex);
      expect(liveItems.length - 1).toBeGreaterThan(stoppedIndex);
      expect(liveItems[diagnosticIndex]).toMatchObject({
        kind: "native",
        sessionId,
        runtimeEpoch: originalEpoch,
        nativeType: "agent-multiplex/runtime-exited",
      });
      expect(liveItems[stoppedIndex]).toMatchObject({
        kind: "control",
        change: {
          type: "session.upsert",
          session: { sessionId, availability: "resumable", runtimeEpoch: null },
        },
      });
      expect(liveItems.at(-1)).toMatchObject({
        kind: "control",
        change: {
          type: "interaction.changed",
          interaction: {
            interactionId: interaction.interactionId,
            sessionId,
            runtimeEpoch: originalEpoch,
            state: "stale",
          },
        },
      });

      const cold = service.events({ native: {} })[Symbol.asyncIterator]();
      observers.push(cold);
      await expect(cold.next()).resolves.toMatchObject({
        value: {
          kind: "control",
          change: {
            type: "session.upsert",
            session: {
              sessionId,
              vendorSessionId: "thread-1",
              bindingRevision: 1,
              availability: "resumable",
              runtimeStatus: "stopped",
              runtimeEpoch: null,
            },
          },
        },
        done: false,
      });
      await expect(cold.next()).resolves.toMatchObject({
        value: {
          kind: "control",
          change: {
            type: "interaction.changed",
            interaction: {
              interactionId: interaction.interactionId,
              sessionId,
              runtimeEpoch: originalEpoch,
              state: "stale",
            },
          },
        },
        done: false,
      });
      // Resume supplies the next live control item. Any retired native replay
      // would arrive before it and fail this assertion without a timed wait.
      const afterColdReplay = cold.next();

      await expect(service.resume({
        operation: "resume",
        commandId: newCommandId(),
        payloadHash: "codex-exit-resume",
        sessionId,
        runtimeNodeId,
        bindingRevision: 1,
      })).resolves.toMatchObject({ state: "succeeded" });
      const resumedEpoch = store.getSession(sessionId)?.runtimeEpoch;
      expect(resumedEpoch).toEqual(expect.any(String));
      expect(resumedEpoch).not.toBe(originalEpoch);
      await expect(afterColdReplay).resolves.toMatchObject({
        value: {
          kind: "control",
          change: {
            type: "session.upsert",
            session: {
              sessionId,
              vendorSessionId: "thread-1",
              bindingRevision: 1,
              availability: "active",
              runtimeStatus: "idle",
              runtimeEpoch: resumedEpoch,
            },
          },
        },
        done: false,
      });
      await expect(service.execute({
        commandId: newCommandId(),
        payloadHash: "codex-exit-resumed-send",
        sessionId,
        runtimeNodeId,
        bindingRevision: 1,
        request: {
          harness: "codex",
          command: { type: "send", input: "new process epoch" },
        },
      })).resolves.toMatchObject({ state: "succeeded" });
      while (true) {
        const item = await cold.next();
        if (item.done) throw new Error("resumed Codex observer closed before native delivery");
        if (item.value.kind !== "native") continue;
        expect(item.value).toMatchObject({
          sessionId,
          runtimeEpoch: resumedEpoch,
          sequence: 0,
          nativeType: "turn/started",
        });
        break;
      }
    } finally {
      await Promise.all(observers.map((observer) => observer.return?.()));
      try {
        await service.close();
      } finally {
        store.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

function spawnFakeCodex(
  exitOnTurn: boolean,
  cwd = "/work/project",
  transientNotLoadedOnResume = false,
  completeBeforeTurnStartResolves = false,
  hangHistory = false,
) {
  const source = String.raw`
const readline = require("node:readline");
const exitOnTurn = ${JSON.stringify(exitOnTurn)};
const cwd = ${JSON.stringify(cwd)};
const transientNotLoadedOnResume = ${JSON.stringify(transientNotLoadedOnResume)};
const completeBeforeTurnStartResolves = ${JSON.stringify(completeBeforeTurnStartResolves)};
const hangHistory = ${JSON.stringify(hangHistory)};
let terminalRunning = false;
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const sendMany = (values) => process.stdout.write(
  values.map((value) => JSON.stringify(value)).join("\n") + "\n",
);
const turn = {
  id: "turn-1", items: [], itemsView: { type: "full" }, status: { type: "inProgress" },
  error: null, startedAt: 1, completedAt: null, durationMs: null,
};
const thread = (turns = []) => ({
  id: "thread-1", extra: null, sessionId: "session-1", forkedFromId: null,
  parentThreadId: null, preview: "hello from test", ephemeral: false, section: null,
  sectionEnteredAt: null, projectId: null, historyMode: "full", modelProvider: "openai",
  createdAt: 1, updatedAt: 2, recencyAt: 2, status: { type: "idle" }, path: null,
  cwd, cliVersion: "0.158.0", source: "appServer", canAcceptDirectInput: true,
  threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: "fake", turns,
});
const childThread = () => ({
  ...thread(), id: "child-thread-1", sessionId: "session-1", parentThreadId: "thread-1",
  preview: "child from test", source: { subAgent: "agentControl" }, name: "fake child",
});
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method && (message.id === 899 || message.id === 900)) {
    send({ method: "fake/interaction-resolved", params: { threadId: "thread-1", result: message.result } });
    return;
  }
  switch (message.method) {
    case "initialize": send({ id: message.id, result: { userAgent: "fake" } }); break;
    case "initialized": break;
    case "thread/start":
      send({ method: "thread/status/changed", params: {
        threadId: "thread-1", status: { type: "active", activeFlags: [] },
      }});
      send({ id: 899, method: "item/commandExecution/requestApproval", params: {
        threadId: "thread-1", turnId: "startup", command: "pwd",
      }});
      send({ id: message.id, result: {
        thread: thread(), model: "fake-model", modelProvider: "openai", serviceTier: null,
        cwd, runtimeWorkspaceRoots: [cwd], instructionSources: [],
        approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" },
        activePermissionProfile: null, reasoningEffort: null, multiAgentMode: "explicitRequestOnly",
      }});
      break;
    case "thread/resume":
      if (transientNotLoadedOnResume) send({ method: "thread/status/changed", params: {
        threadId: "thread-1", status: { type: "notLoaded" },
      }});
      send({ id: message.id, result: {
        thread: thread(), model: "fake-model", modelProvider: "openai", serviceTier: null,
        cwd, runtimeWorkspaceRoots: [cwd], instructionSources: [],
        approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" },
        activePermissionProfile: null, reasoningEffort: null, multiAgentMode: "explicitRequestOnly",
      }});
      if (transientNotLoadedOnResume) send({ method: "thread/status/changed", params: {
        threadId: "thread-1", status: { type: "idle" },
      }});
      break;
    case "turn/start":
      if (exitOnTurn) { process.exit(47); break; }
      if (completeBeforeTurnStartResolves) {
        sendMany([
          { id: message.id, result: { turn } },
          { method: "turn/started", params: { threadId: "thread-1", turn } },
          { method: "turn/completed", params: {
            threadId: "thread-1", turn: { ...turn, status: "completed", completedAt: 2 },
          }},
        ]);
        break;
      }
      send({ id: message.id, result: { turn } });
      send({ method: "turn/started", params: { threadId: "thread-1", turn } });
      terminalRunning = true;
      send({ method: "item/started", params: {
        threadId: "thread-1", turnId: "turn-1", startedAtMs: 2,
        item: {
          type: "commandExecution", id: "terminal-item-1", pluginId: null,
          scriptPath: null, command: "sleep 30", cwd, processId: "process-1",
          source: "unifiedExecStartup", status: "inProgress", commandActions: [],
          aggregatedOutput: null, exitCode: null, durationMs: null,
        },
      }});
      send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "hello" } });
      send({ method: "item/started", params: {
        threadId: "thread-1", turnId: "turn-1", startedAtMs: 3,
        item: {
          type: "subAgentActivity", id: "subagent-start-1", kind: "started",
          agentThreadId: "child-thread-1", agentPath: "/root/fake-child",
        },
      }});
      send({ method: "item/started", params: {
        threadId: "child-thread-1", turnId: "child-turn-1", startedAtMs: 3,
        item: {
          type: "agentMessage", id: "child-item-1", text: "", phase: null,
          memoryCitation: null, delivery: null,
        },
      }});
      send({ id: 900, method: "item/tool/requestUserInput", params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "question-item-1",
        questions: [], isBlocking: true, autoResolutionMs: null,
      }});
      break;
    case "thread/read":
      if (hangHistory) {
        send({ method: "fake/history-request-started", params: { threadId: message.params.threadId } });
        break;
      }
      send({ id: message.id, result: {
      thread: { ...thread([turn]), id: message.params.threadId },
      includeTurns: message.params.includeTurns,
    }}); break;
    case "thread/items/list": send({ id: message.id, result: {
      data: [{ turnId: "turn-1", item: { type: "agentMessage", id: "history-1", text: "Native reply", phase: "final_answer" } }],
      nextCursor: null, backwardsCursor: null,
    }}); break;
    case "thread/list": send({ id: message.id, result: {
      data: [thread()], nextCursor: null,
    }}); break;
    case "thread/loaded/list": send({ id: message.id, result: {
      data: ["thread-1"], nextCursor: null,
    }}); break;
    case "thread/settings/update":
      send({ id: message.id, result: { received: message.params } });
      break;
    case "turn/settings/update":
      send({ id: message.id, result: { received: message.params } });
      break;
    case "thread/backgroundTerminals/list":
      send({ id: message.id, result: {
        data: terminalRunning ? [{
          itemId: "terminal-item-1", processId: "process-1", command: "sleep 30",
          cwd, osPid: 1234, cpuPercent: 0, rssKb: 1024,
        }] : [],
        nextCursor: null,
      }});
      break;
    case "thread/backgroundTerminals/terminate": {
      const terminated = terminalRunning && message.params.processId === "process-1";
      terminalRunning = false;
      send({ id: message.id, result: { terminated } });
      if (terminated) {
        send({ method: "item/completed", params: {
          threadId: "thread-1", turnId: "turn-1", completedAtMs: 5,
          item: {
            type: "commandExecution", id: "terminal-item-1", pluginId: null,
            scriptPath: null, command: "sleep 30", cwd, processId: "process-1",
            source: "unifiedExecStartup", status: "failed", commandActions: [],
            aggregatedOutput: "", exitCode: 1, durationMs: 3,
          },
        }});
        send({ method: "fake/terminal-terminated", params: {
          threadId: "thread-1", itemId: "terminal-item-1",
        }});
      }
      break;
    }
    case "thread/backgroundTerminals/clean":
      terminalRunning = false;
      send({ id: message.id, result: {} });
      break;
    case "turn/interrupt":
      send({ id: message.id, result: {} });
      send({ method: "serverRequest/resolved", params: {
        threadId: "thread-1", requestId: 900,
      }});
      send({ method: "turn/completed", params: {
        threadId: "thread-1", turn: { ...turn, status: "interrupted", completedAt: 4 },
      }});
      break;
    case "thread/unsubscribe": send({ id: message.id, result: {} }); break;
    default: send({ id: message.id, result: {} });
  }
});
`;
  return spawn(process.execPath, ["-e", source], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function eventually<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for fake Codex event");
}

async function launchSession(
  service: RuntimeNodeService,
  input: {
    launchId: ReturnType<typeof newLaunchId>;
    payloadHash: string;
    sessionId: ReturnType<typeof newSessionId>;
    runtimeNodeId: ReturnType<typeof newRuntimeNodeId>;
    request: HarnessSpawnOptions;
    metadata?: Readonly<Record<string, JsonValue>>;
  },
): Promise<LaunchRecord> {
  const profile = service.listLaunchProfiles().find((candidate) =>
    candidate.available && candidate.harnesses.includes(input.request.harness));
  if (!profile) throw new Error(`no launch profile for ${input.request.harness}`);
  const { harness, ...providerInput } = input.request;
  service.createLaunch({
    launchId: input.launchId,
    payloadHash: input.payloadHash,
    sessionId: input.sessionId,
    runtimeNodeId: input.runtimeNodeId,
    profile: {
      profileId: profile.profileId,
      providerId: profile.providerId,
      contractVersion: profile.contractVersion,
      requestSchemaHash: profile.requestSchemaHash,
    },
    harness,
    input: providerInput,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  });
  return eventually(() => {
    const record = service.getLaunch(input.launchId);
    return record !== null && ["succeeded", "failed", "outcomeUnknown"].includes(record.state)
      ? record
      : undefined;
  });
}
