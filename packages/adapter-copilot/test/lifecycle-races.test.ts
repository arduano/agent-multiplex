import type { SessionEvent } from "@github/copilot-sdk";
import { AdapterOutcomeUnknownError, type AdapterEvent } from "@arduano/agent-multiplex-runtime-node-core";
import { describe, expect, it, vi } from "vitest";
import { CopilotAdapterSession, CopilotSessionBridge } from "../src/session.js";

function fixture() {
  let reject!: (error: Error) => void;
  const reply = new Promise<string>((_, no) => { reject = no; });
  const send = vi.fn(() => reply);
  const bridge = new CopilotSessionBridge();
  const session = new CopilotAdapterSession({
    adapterScopeId: "race-fixture", cwd: "/disposable", runtimeEpoch: "race-epoch",
    native: { sessionId: "race-session", rpc: { mode: { set: async () => {} } },
      send, abort: async () => {}, setModel: async () => {}, getEvents: async () => [], disconnect: async () => {} },
    bridge, settings: {}, onStopped: () => {},
  });
  const emit = (type: string, data: object = {}) => bridge.nativeEvent({
    id: type, type, data, timestamp: "2026-09-07T00:00:00.000Z", parentId: null,
  } as SessionEvent);
  return { session, bridge, send, reject, emit };
}

describe("Copilot command and event ordering", () => {
  it.each(["agentId", "parentToolCallId"])("fences legacy %s child lifecycle and settings", key => {
    const f = fixture();
    f.emit("assistant.turn_start", { turnId: "0" });
    f.emit("session.model_change", { newModel: "root-model" });
    f.emit("session.error", { [key]: "child", message: "Child failed" });
    f.emit("session.idle", { [key]: "child" });
    f.emit("user_input.requested", { [key]: "child" });
    f.emit("session.model_change", { [key]: "child", newModel: "child-model" });
    expect(f.session.status()).toBe("running");
    expect(f.session.settings().model).toBe("root-model");
    f.bridge.close();
  });

  it.each([undefined, "agentId", "parentToolCallId"])("does not revive idle when a permission reply arrives after completion (%s)", ownerKey => {
    const f = fixture();
    let acknowledge!: (value: unknown) => void;
    const reply = new Promise<unknown>(resolve => { acknowledge = resolve; });
    f.bridge.attachPermissions({ getMode: async () => ({ mode: "manual" }), setMode: async () => ({}),
      handlePendingPermissionRequest: () => reply }, () => {});
    const events: AdapterEvent[] = [];
    f.bridge.subscribe(event => events.push(event));
    f.emit("assistant.turn_start", { turnId: "0" });
    const provenance = ownerKey ? { [ownerKey]: "child" } : {};
    f.emit("permission.requested", { requestId: "permission", permissionRequest: { kind: "shell" }, ...provenance });
    expect(f.session.status()).toBe(ownerKey ? "running" : "waitingForInput");
    const request = events.find((event): event is Extract<AdapterEvent, { kind: "interaction" }> => event.kind === "interaction")!;
    expect(request).toBeDefined();
    const resolved = request.resolve({ kind: "approved" });
    f.emit("permission.completed", { requestId: "permission", ...provenance });
    f.emit("session.idle");
    acknowledge({ success: true });
    return resolved.then(() => {
      expect(f.session.status()).toBe("idle");
      f.emit("permission.completed", { requestId: "permission", ...provenance });
      expect(f.session.status()).toBe("idle");
      f.bridge.close();
    });
  });

  it.each([
    ["assistant.turn_start", { turnId: "0" }, "running"],
    ["session.idle", {}, "idle"],
    ["session.error", { message: "Native failure" }, "error"],
  ] as const)("retains newer %s when the send acknowledgement is lost", async (type, data, status) => {
    const f = fixture();
    const command = f.session.execute({ harness: "copilot", command: { type: "send", prompt: "A disposable message" } });
    const result = expect(command).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    f.emit(type, data);
    f.reject(new Error("Disconnected before acknowledgement"));
    await result;
    expect(f.session.status()).toBe(status);
    expect(f.send).toHaveBeenCalledOnce();
    f.bridge.close();
  });

  it("reports unknown activity without later native evidence and never retries", async () => {
    const f = fixture();
    const command = f.session.execute({ harness: "copilot", command: { type: "steer", prompt: "A disposable steer" } });
    const result = expect(command).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    f.reject(new Error("Acknowledgement lost"));
    await result;
    expect(f.session.status()).toBe("unknown");
    expect(f.send).toHaveBeenCalledOnce();
    f.bridge.close();
  });
});
