import type { ResumeSessionConfig, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { AdapterOutcomeUnknownError, type AdapterEvent } from "@arduano/agent-multiplex-runtime-node-core";
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
  const native = (sessionId: string): CopilotNativeSession => ({ sessionId, rpc, setModel,
    send: async () => "message", abort: async () => {}, getEvents: async () => [], disconnect: async () => {},
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
  return { adapter, session, getCurrent, setModel, rpc, emit, received, configuration: () => configuration };
}

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
