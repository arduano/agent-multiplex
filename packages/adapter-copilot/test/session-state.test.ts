import type { ResumeSessionConfig, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { AdapterOutcomeUnknownError, type AdapterEvent } from "@arduano/agent-multiplex-runtime-node-core";
import { copilotCommandSchema, nativeStateRequestSchema, NATIVE_PAYLOAD_MAX_BYTES } from "@arduano/agent-multiplex-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopilotAgentAdapter, type CopilotAdapterClient } from "../src/adapter.js";
import { CopilotAdapterSession, type CopilotNativeSession, type CopilotSessionRpc } from "../src/session.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });

function event(type: string, data: unknown = {}, agentId?: string): SessionEvent {
  return { type, data, id: "native-event", timestamp: "2026-09-07T00:00:00.000Z", parentId: null,
    ...(agentId === undefined ? {} : { agentId }) } as SessionEvent;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(options: {
  initialModel?: string;
  beforeAttach?: (rpc: CopilotSessionRpc, emit: (event: SessionEvent) => void) => void;
} = {}) {
  let configuration: SessionConfig | ResumeSessionConfig;
  const getCurrent = vi.fn(async (): Promise<unknown> => ({ modelId: "native-selected" }));
  const setModel = vi.fn(async (_model: string): Promise<void> => {});
  const rpc: CopilotSessionRpc = { model: { getCurrent }, mode: { set: async () => {} }, permissions: {
    getMode: async () => ({ mode: "manual" }), setMode: async () => ({ success: true, mode: "manual" }),
    handlePendingPermissionRequest: async () => ({ success: true }),
  } };
  const send = vi.fn(async () => "message");
  const getEvents = vi.fn(async (): Promise<SessionEvent[]> => []);
  const native = (sessionId: string): CopilotNativeSession => ({ sessionId, rpc, setModel,
    send, abort: async () => {}, getEvents, disconnect: async () => {},
  });
  const client: CopilotAdapterClient = {
    start: async () => {}, stop: async () => [], forceStop: async () => {},
    getStatus: async () => ({ version: "1.0.81", protocolVersion: 7 }),
    listModels: async () => [], listSessions: async () => [],
    createSession: async config => {
      configuration = config;
      options.beforeAttach?.(rpc, item => config.onEvent?.(item));
      return native(config.sessionId!);
    },
    resumeSession: async (id, config) => { configuration = config; return native(id); },
  };
  const adapter = new CopilotAgentAdapter({ clientFactory: () => client });
  cleanup.push(() => adapter.close());
  const session = await adapter.spawn({ harness: "copilot", cwd: "/repo", mode: "plan", model: options.initialModel,
    native: { sessionId: "state-session" } }) as CopilotAdapterSession;
  const received: AdapterEvent[] = [];
  session.subscribe(item => received.push(item));
  const emit = (type: string, data?: unknown, agentId?: string) => configuration.onEvent?.(event(type, data, agentId));
  return { adapter, session, getCurrent, setModel, send, getEvents, rpc, emit, received, configuration: () => configuration };
}

describe("Copilot native pending queue", () => {
  const request = { harness: "copilot", view: "pendingMessages" } as const;
  const command = { harness: "copilot", command: { type: "steerQueuedMessage", id: "queue-item" } } as const;
  const snapshot = { items: [{ id: "queue-item", messageId: "message-id", kind: "message", displayText: "Same prompt", agentMode: "interactive" },
    { id: "model-change", kind: "command", displayText: "/model native-model", agentMode: "plan" }],
    steeringMessages: ["already consumed", "waiting steer"], inFlightSteeringCount: 1 };

  it("advertises native observations and atomic queue steering with strict request shapes", async () => {
    const f = await fixture(); const capabilities = (await f.adapter.describe()).capabilities;
    expect(capabilities).toContainEqual(expect.objectContaining({ name: "queue.pending", version: "v1" }));
    expect(capabilities).toContainEqual(expect.objectContaining({ name: "queue.sendNow", version: "v1" }));
    expect(nativeStateRequestSchema.parse(request)).toEqual(request);
    expect(nativeStateRequestSchema.safeParse({ ...request, view: "arbitraryRpc" }).success).toBe(false);
    expect(copilotCommandSchema.parse(command.command)).toEqual(command.command);
    expect(copilotCommandSchema.safeParse({ ...command.command, id: "" }).success).toBe(false);
    expect(copilotCommandSchema.safeParse({ ...command.command, prompt: "replacement" }).success).toBe(false);
  });

  it("reads an unchanged native snapshot and IDs without scanning history or sending messages", async () => {
    const f = await fixture(); const pendingItems = vi.fn(async () => snapshot);
    f.rpc.queue = { pendingItems, sendNow: vi.fn(async () => ({ steered: true })) };
    expect(await f.session.readNativeState(request)).toEqual({ harness: "copilot", vendorSessionId: f.session.vendorSessionId, payload: snapshot });
    expect(pendingItems).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled(); expect(f.getEvents).not.toHaveBeenCalled();
    expect(f.rpc.queue.sendNow).not.toHaveBeenCalled();
    f.emit("pending_messages.modified");
    expect(f.received).toContainEqual(expect.objectContaining({ kind: "native", nativeType: "pending_messages.modified" }));
  });

  it.each([true, false])("uses the atomic native transition and preserves its steered=%s acknowledgement", async steered => {
    const f = await fixture(); const sendNow = vi.fn(async () => ({ steered }));
    f.rpc.queue = { pendingItems: vi.fn(async () => snapshot), sendNow };
    expect(await f.session.execute(command)).toEqual({ steered });
    expect(sendNow).toHaveBeenCalledExactlyOnceWith({ id: "queue-item" });
    expect(f.send).not.toHaveBeenCalled(); expect(f.getEvents).not.toHaveBeenCalled();
    expect(f.rpc.queue.pendingItems).not.toHaveBeenCalled();
  });

  it("reports missing APIs as unavailable without dispatching", async () => {
    const f = await fixture();
    await expect(f.session.readNativeState(request)).rejects.toThrow("unavailable");
    await expect(f.session.execute(command)).rejects.toThrow("unavailable");
    expect(f.session.status()).not.toBe("unknown"); expect(f.send).not.toHaveBeenCalled();
  });

  it.each([undefined, { success: true }, { steered: "yes" }])("keeps malformed mutation acknowledgements outcome unknown (%j)", async result => {
    const f = await fixture(); const sendNow = vi.fn(async () => result);
    f.rpc.queue = { pendingItems: async () => snapshot, sendNow };
    await expect(f.session.execute(command)).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect(sendNow).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });

  it("does not retry a lost native transition reply", async () => {
    const f = await fixture(); const sendNow = vi.fn(async () => { throw new Error("reply lost"); });
    f.rpc.queue = { pendingItems: async () => snapshot, sendNow };
    await expect(f.session.execute(command)).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect(sendNow).toHaveBeenCalledOnce();
  });

  it.each([{}, { items: [], steeringMessages: [null] }, { ...snapshot, inFlightSteeringCount: 3 },
    { ...snapshot, items: [{ id: "invalid" }] }])("rejects malformed snapshots without representing them as an empty queue", async value => {
    const f = await fixture(); f.rpc.queue = { pendingItems: async () => value, sendNow: async () => ({ steered: true }) };
    await expect(f.session.readNativeState(request)).rejects.toThrow("Unrecognized");
  });

  it("fails explicitly for oversized queues instead of truncating or scanning history", async () => {
    const f = await fixture(); f.rpc.queue = { pendingItems: async () => ({ items: [], steeringMessages: ["a".repeat(NATIVE_PAYLOAD_MAX_BYTES)] }), sendNow: async () => ({ steered: true }) };
    await expect(f.session.readNativeState(request)).rejects.toThrow("bounded");
    f.rpc.queue.pendingItems = async () => ({ items: [], steeringMessages: Array(1_001).fill("a") });
    await expect(f.session.readNativeState(request)).rejects.toThrow("bounded");
    expect(f.getEvents).not.toHaveBeenCalled();
  });

  it("rejects reads when an attachment closes during the native reply", async () => {
    const f = await fixture(); const pending = deferred<unknown>();
    f.rpc.queue = { pendingItems: async () => pending.promise, sendNow: async () => ({ steered: true }) };
    const read = f.session.readNativeState(request);
    await f.session.stop(); pending.resolve(snapshot);
    await expect(read).rejects.toThrow("stopped");
  });
});

describe("Copilot native model observations", () => {
  it("reads the authoritative model on create and resume without reapplying a model", async () => {
    const f = await fixture({ initialModel: "requested-model" });
    expect(f.session.settings()).toMatchObject({ model: "native-selected", mode: "plan", copilotPermissions: { mode: "manual" } });
    expect(f.getCurrent).toHaveBeenCalledTimes(1);
    f.getCurrent.mockResolvedValueOnce({ modelId: "previously-selected" });
    const resumed = await f.adapter.resume({ harness: "copilot", vendorSessionId: "state-session", cwd: "/repo", continuePendingWork: false });
    expect(resumed.settings?.()?.model).toBe("previously-selected");
    expect(f.getCurrent).toHaveBeenCalledTimes(2);
    expect(f.setModel).not.toHaveBeenCalled();
    expect(await f.adapter.listSessions()).toMatchObject([{ harnessSettings: { model: "previously-selected" } }]);
  });

  it.each(["auto", "gpt-5.6-luna", "provider/model-id"])("preserves the native modelId %s exactly", async modelId => {
    const f = await fixture({ beforeAttach: rpc => { rpc.model!.getCurrent = async () => ({ modelId }); } });
    expect(f.session.settings().model).toBe(modelId);
  });

  it.each([{}, { modelId: "" }, { modelId: null }, { modelId: 42 }, { model: "wrong-shape" }, null])(
    "does not infer a default or retain an obsolete selection from unknown native state %j", async result => {
      const f = await fixture({ initialModel: "requested-model", beforeAttach: rpc => { rpc.model!.getCurrent = async () => result; } });
      expect(f.session.settings().model).toBeUndefined();
    },
  );

  it("treats failed reads as unknown and tolerates an unavailable optional native API", async () => {
    const failed = await fixture({ beforeAttach: rpc => { rpc.model!.getCurrent = async () => { throw new Error("unavailable"); }; } });
    expect(failed.session.settings().model).toBeUndefined();
    const missing = await fixture({ beforeAttach: rpc => { delete rpc.model; } });
    expect(missing.session.settings().model).toBeUndefined();
    expect(missing.setModel).not.toHaveBeenCalled();
  });

  it("observes root model changes and preserves native descendant events without adopting their models", async () => {
    const f = await fixture();
    f.emit("session.model_change", { previousModel: "native-selected", newModel: "auto" });
    f.emit("session.model_change", { newModel: "child-model" }, "child");
    expect(f.session.settings().model).toBe("auto");
    expect(f.received.filter(item => item.kind === "settings").at(-1)).toMatchObject({ settings: { model: "auto", mode: "plan", copilotPermissions: { mode: "manual" } } });
    expect(f.received.filter(item => item.kind === "native" && item.nativeType === "session.model_change")).toHaveLength(2);
  });

  it("keeps root model events emitted before attachment", async () => {
    const f = await fixture({ initialModel: "requested-model", beforeAttach: (rpc, emit) => {
      delete rpc.model;
      emit(event("session.model_change", { newModel: "early-model" }));
    } });
    expect(f.session.settings().model).toBe("early-model");
  });

  it("fences a delayed attach read behind a newer native event", async () => {
    const f = await fixture({ beforeAttach: (rpc, emit) => {
      rpc.model!.getCurrent = async () => {
        emit(event("session.model_change", { newModel: "event-model" }));
        return { modelId: "old-model" };
      };
    } });
    expect(f.session.settings().model).toBe("event-model");
  });

  it("fences a delayed model read behind an acknowledged model selection", async () => {
    const f = await fixture(); const response = deferred<unknown>();
    f.getCurrent.mockReturnValueOnce(response.promise);
    const read = f.session.readModel();
    await f.session.execute({ harness: "copilot", command: { type: "setModel", model: "selected-later" } });
    response.resolve({ modelId: "read-earlier" }); await read;
    expect(f.session.settings().model).toBe("selected-later");
  });

  it("lets a model acknowledgement supersede an intervening read, while newer native events win", async () => {
    const f = await fixture(); const response = deferred<void>();
    f.setModel.mockReturnValueOnce(response.promise);
    const command = f.session.execute({ harness: "copilot", command: { type: "setModel", model: "selected-later" } });
    await f.session.readModel();
    response.resolve(); await command;
    expect(f.session.settings().model).toBe("selected-later");

    const laterResponse = deferred<void>(); f.setModel.mockReturnValueOnce(laterResponse.promise);
    const laterCommand = f.session.execute({ harness: "copilot", command: { type: "setModel", model: "acknowledged-model" } });
    f.emit("session.model_change", { newModel: "newer-native-model" });
    laterResponse.resolve(); await laterCommand;
    expect(f.session.settings().model).toBe("newer-native-model");
  });

  it("clears an uncertain model mutation without overwriting a newer native event", async () => {
    const f = await fixture();
    f.setModel.mockRejectedValueOnce(new Error("lost reply"));
    await expect(f.session.execute({ harness: "copilot", command: { type: "setModel", model: "uncertain" } })).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect(f.session.settings().model).toBeUndefined();
    f.setModel.mockImplementationOnce(async () => {
      f.emit("session.model_change", { newModel: "acknowledged-natively" });
      throw new Error("lost reply after event");
    });
    await expect(f.session.execute({ harness: "copilot", command: { type: "setModel", model: "uncertain" } })).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect(f.session.settings().model).toBe("acknowledged-natively");
  });

  it("ignores model replies and notifications after the attachment closes", async () => {
    const f = await fixture(); const response = deferred<unknown>();
    f.getCurrent.mockReturnValueOnce(response.promise);
    const read = f.session.readModel();
    await f.session.stop();
    f.emit("session.model_change", { newModel: "late-event" });
    response.resolve({ modelId: "late-read" }); await read;
    expect(f.session.settings().model).toBe("native-selected");
  });
});

describe("Copilot whole-session working status", () => {
  it.each(["send", "steer"] as const)("keeps a pending question visible through an acknowledged or uncertain %s", async type => {
    const f = await fixture();
    const answer = f.configuration().onUserInputRequest?.({ question: "Pick one" }, { sessionId: f.session.vendorSessionId });
    const command = type === "send" ? { type, prompt: "next task", mode: "enqueue" as const }
      : { type, prompt: "change focus", mode: "immediate" as const };
    await f.session.execute({ harness: "copilot", command });
    expect(f.session.status()).toBe("waitingForInput");
    f.send.mockRejectedValueOnce(new Error("reply lost"));
    await expect(f.session.execute({ harness: "copilot", command })).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect(f.session.status()).toBe("waitingForInput");
    await f.session.stop(); await answer;
  });

  it("does not revive finished work when an already settled permission completes again", async () => {
    const f = await fixture();
    f.emit("permission.requested", { requestId: "permission", permissionRequest: { kind: "read", fileName: "/repo" } });
    f.emit("permission.completed", { requestId: "permission", result: { kind: "approved" } });
    f.emit("session.idle");
    f.emit("permission.completed", { requestId: "permission", result: { kind: "approved" } });
    f.emit("permission.completed", { requestId: "another-client", result: { kind: "approved" } });
    expect(f.session.status()).toBe("idle");
  });

  it.each([{ sessionWasActive: true }, { continuePendingWork: true }])("keeps native resumed work active (%j)", async data => {
    const f = await fixture(); f.emit("session.resume", data);
    expect(f.session.status()).toBe("running");
    f.emit("session.idle"); expect(f.session.status()).toBe("idle");
  });

  it("reads native activity on attachment/resume without scanning transcript or changing work", async () => {
    const activity = vi.fn(async () => ({ abortable: true, hasActiveWork: true }));
    const f = await fixture({ beforeAttach: rpc => { rpc.metadata = { activity }; } });
    expect(f.session.status()).toBe("running");
    const resumed = await f.adapter.resume({ harness: "copilot", vendorSessionId: f.session.vendorSessionId, continuePendingWork: true });
    expect(resumed.status()).toBe("running"); expect(activity).toHaveBeenCalledTimes(2);
    expect(f.send).not.toHaveBeenCalled(); expect(f.getEvents).not.toHaveBeenCalled();
  });

  it("fences a delayed activity read behind newer native lifecycle and interactions", async () => {
    const f = await fixture(); const first = deferred<unknown>();
    f.rpc.metadata = { activity: async () => first.promise };
    const read = f.session.readActivity();
    f.emit("assistant.turn_start", { turnId: "native-turn" });
    first.resolve({ hasActiveWork: false, abortable: false }); await read;
    expect(f.session.status()).toBe("running");
    const second = deferred<unknown>(); f.rpc.metadata.activity = async () => second.promise;
    const nextRead = f.session.readActivity();
    f.emit("permission.requested", { requestId: "waiting", permissionRequest: { kind: "read", fileName: "/repo" } });
    second.resolve({ hasActiveWork: false, abortable: false }); await nextRead;
    expect(f.session.status()).toBe("waitingForInput");
  });

  it("does not declare idle after unavailable or malformed activity reads", async () => {
    const f = await fixture(); f.emit("assistant.turn_start", { turnId: "turn" });
    f.rpc.metadata = { activity: async () => { throw new Error("unsupported"); } };
    await f.session.readActivity(); expect(f.session.status()).toBe("running");
    f.rpc.metadata.activity = async () => ({ processing: false });
    await f.session.readActivity(); expect(f.session.status()).toBe("running");
  });

  it("keeps a stopped handle stopped when a dispatched send fails afterward", async () => {
    const f = await fixture(); const response = deferred<string>();
    f.send.mockImplementationOnce(async () => { await response.promise; throw new Error("late reply lost"); });
    const sending = f.session.execute({ harness: "copilot", command: { type: "send", prompt: "test", mode: "enqueue" } });
    await f.session.stop(); response.resolve("release");
    await expect(sending).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect(f.session.status()).toBe("stopped");
  });

  it("does not acknowledge a send without its native logical message ID", async () => {
    const f = await fixture(); f.send.mockResolvedValueOnce("");
    await expect(f.session.execute({ harness: "copilot", command: { type: "send", prompt: "test", mode: "enqueue" } })).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect(f.send).toHaveBeenCalledOnce();
  });

  it("keeps working while an attached shell command outlives the assistant loop", async () => {
    const f = await fixture();
    f.emit("assistant.turn_start", { turnId: "turn" });
    f.emit("tool.execution_start", { toolCallId: "shell", toolName: "powershell", arguments: { command: "Get-Process", mode: "async" } });
    f.emit("assistant.idle");
    expect(f.session.status()).toBe("running");
    f.emit("tool.execution_complete", { toolCallId: "shell", success: true });
    expect(f.session.status()).toBe("running");
    f.emit("session.idle");
    expect(f.session.status()).toBe("idle");
  });

  it("keeps working for background agents and ignores their idle and error statuses", async () => {
    const f = await fixture();
    f.emit("assistant.turn_start", { turnId: "turn" });
    f.emit("subagent.started", { toolCallId: "task", agentName: "Explore" });
    f.emit("assistant.idle");
    for (const type of ["assistant.turn_start", "assistant.idle", "session.idle", "session.error"]) {
      f.emit(type, {}, "child");
      expect(f.session.status()).toBe("running");
    }
    f.emit("subagent.completed", { toolCallId: "task" });
    f.emit("session.idle");
    expect(f.session.status()).toBe("idle");
  });

  it("keeps pending permissions visible through idle notifications until their exact completion", async () => {
    const f = await fixture();
    f.emit("permission.requested", { requestId: "permission", permissionRequest: { kind: "shell", intention: "run a command" } });
    f.emit("assistant.idle");
    expect(f.session.status()).toBe("waitingForInput");
    f.emit("session.idle");
    expect(f.session.status()).toBe("waitingForInput");
    f.emit("permission.completed", { requestId: "other", result: { kind: "approved" } });
    expect(f.session.status()).toBe("waitingForInput");
    f.emit("permission.completed", { requestId: "permission", result: { kind: "approved" } });
    f.emit("session.idle");
    expect(f.session.status()).toBe("idle");
  });

  it("does not mark a waiting question done when the main loop pauses", async () => {
    const f = await fixture();
    const answer = f.configuration().onUserInputRequest?.({ question: "Pick a target" }, { sessionId: f.session.vendorSessionId });
    f.emit("assistant.idle");
    f.emit("session.idle");
    expect(f.session.status()).toBe("waitingForInput");
    const interaction = f.received.find(item => item.kind === "interaction" && item.requestType === "userInput");
    if (interaction?.kind !== "interaction") throw new Error("Expected question interaction");
    await interaction.resolve({ answer: "target", wasFreeform: true });
    await expect(answer).resolves.toEqual({ answer: "target", wasFreeform: true });
    f.emit("session.idle");
    expect(f.session.status()).toBe("idle");
  });
});
