import type { ResumeSessionConfig, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { copilotPermissionsSettingsSchema, copilotCommandSchema, type HarnessCommand } from "@arduano/agent-multiplex-protocol";
import { AdapterOutcomeUnknownError, type AdapterEvent } from "@arduano/agent-multiplex-runtime-node-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopilotAgentAdapter, type CopilotAdapterClient } from "../src/adapter.js";
import type { CopilotNativeSession, CopilotSessionRpc } from "../src/session.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(close.splice(0).map(work => work())); });
const on: HarnessCommand = { harness: "copilot", command: { type: "setPermissionMode", mode: "allow-all" } };
const off: HarnessCommand = { harness: "copilot", command: { type: "setPermissionMode", mode: "manual" } };
const readRequest = { kind: "read", fileName: "/repo/file.ts", intention: "inspect" };
function event(type: string, data: unknown, agentId?: string): SessionEvent {
  return { type, data, id: "native-event", timestamp: "2026-09-06T00:00:00.000Z", parentId: null,
    ...(agentId === undefined ? {} : { agentId }) } as SessionEvent;
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(options: { beforeAttach?: (rpc: CopilotSessionRpc, emit: (event: SessionEvent) => void) => void } = {}) {
  let configuration: SessionConfig | ResumeSessionConfig;
  let state = { mode: "manual" as "manual" | "allow-all" | "assisted" };
  const permissions = {
    getMode: vi.fn(async (): Promise<unknown> => ({ ...state })),
    setMode: vi.fn(async ({ mode }: { mode: "manual" | "allow-all" }): Promise<unknown> => {
      state = { mode }; return { success: true, ...state };
    }),
    handlePendingPermissionRequest: vi.fn(async (_input: unknown): Promise<unknown> => ({ success: true })),
  };
  const rpc: CopilotSessionRpc = { mode: { set: vi.fn(async () => {}) }, permissions };
  const createNative = (sessionId: string): CopilotNativeSession => ({ sessionId, rpc, send: vi.fn(async () => "message"),
    abort: vi.fn(async () => {}), setModel: vi.fn(async () => {}), getEvents: vi.fn(async () => []), disconnect: vi.fn(async () => {}) });
  const client: CopilotAdapterClient = {
    start: async () => {}, stop: async () => [], forceStop: async () => {}, getStatus: async () => ({ version: "1.0.81", protocolVersion: 7 }),
    listModels: async () => [], listSessions: async () => [],
    createSession: async config => {
      configuration = config; options.beforeAttach?.(rpc, item => config.onEvent?.(item));
      return createNative(config.sessionId!);
    },
    resumeSession: async (id, config) => { configuration = config; return createNative(id); },
  };
  const adapter = new CopilotAgentAdapter({ clientFactory: () => client });
  close.push(() => adapter.close());
  const session = await adapter.spawn({ harness: "copilot", cwd: "/repo", mode: "plan", native: { sessionId: "permissions-session" } });
  const received: AdapterEvent[] = [];
  session.subscribe(item => received.push(item));
  const emit = (type: string, data: unknown, agentId?: string) => configuration.onEvent?.(event(type, data, agentId));
  const interaction = (requestId: string) => {
    const found = received.find(item => item.kind === "interaction" && item.nativeRequestId === requestId);
    if (!found || found.kind !== "interaction") throw new Error("Expected native permission interaction");
    return found;
  };
  return { adapter, session, rpc, permissions, received, emit, interaction, configuration: () => configuration };
}

describe("Copilot native allow-all permissions", () => {
  it("exposes an explicit native mode command and preserves observable native assisted mode without offering an assisted setter", () => {
    expect(copilotCommandSchema.parse(on.command)).toEqual({ type: "setPermissionMode", mode: "allow-all" });
    for (const input of [{ type: "setPermissionMode", mode: true }, { type: "setPermissionMode", mode: "assisted" }, { type: "setPermissionMode", mode: "allow-all", extra: true }]) {
      expect(copilotCommandSchema.safeParse(input).success).toBe(false);
    }
    expect(copilotPermissionsSettingsSchema.parse({ mode: "assisted" })).toEqual({ mode: "assisted" });
    expect(copilotPermissionsSettingsSchema.safeParse({ mode: "future-mode" }).success).toBe(false);
  });

  it("reads native state on create/resume, exposes its capability and never sets policy merely by attaching", async () => {
    const f = await fixture();
    expect(f.session.settings?.()).toMatchObject({ mode: "plan", copilotPermissions: { mode: "manual" } });
    expect((await f.adapter.describe()).capabilities).toContainEqual(expect.objectContaining({ name: "permissions.mode" }));
    f.permissions.getMode.mockResolvedValueOnce({ mode: "allow-all" });
    const resumed = await f.adapter.resume({ harness: "copilot", vendorSessionId: f.session.vendorSessionId, cwd: "/repo", continuePendingWork: false });
    expect(resumed.settings?.()?.copilotPermissions).toEqual({ mode: "allow-all" });
    expect(f.permissions.getMode).toHaveBeenCalledTimes(2);
    expect(f.permissions.setMode).not.toHaveBeenCalled();
  });

  it("acknowledges on/off without changing interactive/plan/autopilot mode", async () => {
    const f = await fixture();
    await expect(f.session.execute(on)).resolves.toEqual({ success: true, mode: "allow-all" });
    expect(f.session.settings?.()).toMatchObject({ mode: "plan", copilotPermissions: { mode: "allow-all" } });
    await expect(f.session.execute(off)).resolves.toEqual({ success: true, mode: "manual" });
    expect(f.session.settings?.()?.copilotPermissions).toEqual({ mode: "manual" });
    expect(f.rpc.mode.set).toHaveBeenCalledTimes(1);
    expect(f.permissions.setMode.mock.calls).toEqual([[{ mode: "allow-all" }], [{ mode: "manual" }]]);
  });

  it("reports native refusal as a definite failure while retaining the acknowledged actual state", async () => {
    const f = await fixture();
    f.permissions.setMode.mockResolvedValueOnce({ success: false, mode: "manual" });
    await expect(f.session.execute(on)).rejects.toThrow("did not apply");
    expect(f.session.settings?.()?.copilotPermissions).toEqual({ mode: "manual" });
    expect(f.session.status()).not.toBe("unknown");
  });

  it("never invents a known state after failed reads, unsupported methods or unknown native shapes", async () => {
    const f = await fixture({ beforeAttach: rpc => { rpc.permissions!.getMode = async () => ({ mode: "future-mode" }); } });
    expect(f.session.settings?.()?.copilotPermissions).toBeUndefined();
    f.emit("session.permissions_changed", { mode: "allow-all" });
    f.emit("session.permissions_changed", { mode: "future-mode" });
    expect(f.session.settings?.()?.copilotPermissions).toBeUndefined();
    const missing = await fixture({ beforeAttach: rpc => { delete rpc.permissions; } });
    await expect(missing.session.execute(on)).rejects.toThrow("unavailable");
    expect(missing.permissions.setMode).not.toHaveBeenCalled();
  });

  it("classifies lost or malformed mutation responses as outcome unknown and clears the obsolete setting", async () => {
    const f = await fixture();
    f.permissions.setMode.mockRejectedValueOnce(new Error("lost reply"));
    await expect(f.session.execute(on)).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect(f.session.settings?.()?.copilotPermissions).toBeUndefined();
    f.emit("session.permissions_changed", { mode: "allow-all" });
    f.permissions.setMode.mockResolvedValueOnce({ success: true, mode: "future-mode" });
    await expect(f.session.execute(off)).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect(f.session.settings?.()?.copilotPermissions).toBeUndefined();
  });

  it("uses root native updates and ignores descendant settings and runtime status", async () => {
    const f = await fixture();
    f.emit("session.permissions_changed", { mode: "assisted" });
    f.emit("session.permissions_changed", { mode: "allow-all" }, "child");
    f.emit("session.error", { message: "child error" }, "child");
    expect(f.session.settings?.()?.copilotPermissions).toEqual({ mode: "assisted" });
    expect(f.session.status()).not.toBe("error");
    expect(f.received.some(item => item.kind === "native" && item.nativeType === "session.permissions_changed")).toBe(true);
  });

  it("fences a delayed mutation response behind a newer native setting", async () => {
    const f = await fixture(); const response = deferred<unknown>();
    f.permissions.setMode.mockReturnValueOnce(response.promise);
    const command = f.session.execute(on);
    expect(f.session.settings?.()?.copilotPermissions?.mode).toBe("manual");
    f.emit("session.permissions_changed", { mode: "allow-all" });
    f.emit("session.permissions_changed", { mode: "manual" });
    response.resolve({ success: true, mode: "allow-all" });
    await expect(command).resolves.toMatchObject({ mode: "allow-all" });
    expect(f.session.settings?.()?.copilotPermissions).toEqual({ mode: "manual" });
  });

  it("fences attach reads behind intervening native updates and ignores late events after stop", async () => {
    const f = await fixture({ beforeAttach: (rpc, emit) => {
      rpc.permissions!.getMode = async () => {
        emit(event("session.permissions_changed", { mode: "allow-all" }));
        return { mode: "manual" };
      };
    } });
    expect(f.session.settings?.()?.copilotPermissions).toEqual({ mode: "allow-all" });
    await f.session.stop();
    f.emit("session.permissions_changed", { mode: "manual" });
    expect(f.session.settings?.()?.copilotPermissions).toEqual({ mode: "allow-all" });
  });
});

describe("Copilot exact native permission settlement", () => {
  it("retires only the completed permission, preserving questions, other requests and native identities", async () => {
    const f = await fixture();
    f.emit("permission.requested", { requestId: "permission-a", permissionRequest: readRequest });
    f.emit("permission.requested", { requestId: "permission-b", permissionRequest: readRequest });
    const question = f.configuration().onUserInputRequest?.({ question: "Choose a target" }, { sessionId: f.session.vendorSessionId });
    f.emit("permission.completed", { requestId: "permission-a", result: { kind: "approved" } });
    expect(f.received.filter(item => item.kind === "interactionSettled")).toEqual([{ kind: "interactionSettled", nativeRequestId: "permission-a", state: "stale" }]);
    await expect(f.interaction("permission-a").resolve({ kind: "approve-once" })).rejects.toThrow("no longer pending");
    expect(f.session.status()).toBe("waitingForInput");
    expect(f.permissions.handlePendingPermissionRequest).not.toHaveBeenCalled();
    await f.session.stop(); await expect(question).resolves.toEqual({ answer: "", wasFreeform: true });
  });

  it("does not autoanswer existing prompts when allow-all is enabled without native completion", async () => {
    const f = await fixture();
    f.emit("permission.requested", { requestId: "managed-request", permissionRequest: { ...readRequest, managedApprovalRequired: true } });
    await f.session.execute(on);
    expect(f.received.some(item => item.kind === "interactionSettled")).toBe(false);
    expect(f.permissions.handlePendingPermissionRequest).not.toHaveBeenCalled();
    expect(f.session.status()).toBe("waitingForInput");
  });

  it("retires a pending permission only when the native toggle emits that request's completion", async () => {
    const f = await fixture();
    f.emit("permission.requested", { requestId: "native-settled", permissionRequest: readRequest });
    f.permissions.setMode.mockImplementationOnce(async () => {
      f.emit("permission.completed", { requestId: "native-settled", result: { kind: "approved" } });
      f.emit("session.permissions_changed", { mode: "allow-all" });
      return { success: true, mode: "allow-all" };
    });
    await f.session.execute(on);
    expect(f.received).toContainEqual({ kind: "interactionSettled", nativeRequestId: "native-settled", state: "stale" });
    expect(f.permissions.handlePendingPermissionRequest).not.toHaveBeenCalled();
    f.emit("permission.requested", { requestId: "native-settled", permissionRequest: readRequest });
    expect(f.received.filter(item => item.kind === "interaction")).toHaveLength(1);
    expect(f.session.status()).not.toBe("waitingForInput");
  });

  it("ignores duplicate/hook-resolved events and fences a child completion from the root request", async () => {
    const f = await fixture();
    f.emit("permission.requested", { requestId: "hook", permissionRequest: readRequest, resolvedByHook: true });
    expect(f.session.status()).not.toBe("waitingForInput");
    f.emit("permission.requested", { requestId: "same", permissionRequest: readRequest });
    f.emit("permission.requested", { requestId: "same", permissionRequest: readRequest });
    f.emit("permission.completed", { requestId: "same", result: { kind: "approved" } }, "child");
    expect(f.received.filter(item => item.kind === "interaction")).toHaveLength(1);
    expect(f.received.some(item => item.kind === "interactionSettled")).toBe(false);
    await f.interaction("same").resolve({ kind: "approve-once" });
    expect(f.permissions.handlePendingPermissionRequest).toHaveBeenCalledWith({ requestId: "same", result: { kind: "approve-once" } });
  });

  it("lets an acknowledged local resolution finish when native completion arrives before its RPC reply", async () => {
    const f = await fixture(); const response = deferred<unknown>();
    f.permissions.handlePendingPermissionRequest.mockReturnValueOnce(response.promise);
    f.emit("permission.requested", { requestId: "local", permissionRequest: readRequest });
    const resolution = f.interaction("local").resolve({ kind: "approve-once" });
    f.emit("permission.completed", { requestId: "local", result: { kind: "approved" } });
    response.resolve({ success: true }); await expect(resolution).resolves.toBeUndefined();
    expect(f.received.some(item => item.kind === "interactionSettled")).toBe(false);
  });

  it("retires already resolved requests and reports a lost decision reply without retrying", async () => {
    const f = await fixture();
    f.emit("permission.requested", { requestId: "resolved", permissionRequest: readRequest });
    f.permissions.handlePendingPermissionRequest.mockResolvedValueOnce({ success: false });
    await expect(f.interaction("resolved").resolve({ kind: "approve-once" })).rejects.toThrow("already resolved");
    expect(f.received).toContainEqual({ kind: "interactionSettled", nativeRequestId: "resolved", state: "stale" });
    f.emit("permission.requested", { requestId: "uncertain", permissionRequest: readRequest });
    f.permissions.handlePendingPermissionRequest.mockRejectedValueOnce(new Error("lost reply"));
    await expect(f.interaction("uncertain").resolve({ kind: "approve-once" })).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect(f.permissions.handlePendingPermissionRequest).toHaveBeenCalledTimes(2);
  });
});
