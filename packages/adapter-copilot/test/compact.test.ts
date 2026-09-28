import { AdapterOutcomeUnknownError, type AdapterEvent } from "@arduano/agent-multiplex-runtime-node-core";
import { copilotCommandSchema, NATIVE_PAYLOAD_MAX_BYTES } from "@arduano/agent-multiplex-protocol";
import type { SessionEvent } from "@github/copilot-sdk";
import { describe, expect, it, vi } from "vitest";
import { CopilotAdapterSession, CopilotSessionBridge, type CopilotSessionRpc } from "../src/session.js";

const command = { harness: "copilot", command: { type: "compact" } } as const;
const success = { success: true, tokensRemoved: 10_000, messagesRemoved: 40, summaryContent: "Retained native context",
  contextWindow: { tokenLimit: 128_000, currentTokens: 20_000, messagesLength: 12, systemTokens: 1_000 }, extra: { native: true } };
function fixture(result: unknown = success) {
  const compact = vi.fn(async (): Promise<unknown> => result), send = vi.fn(async () => "never"), getEvents = vi.fn(async () => []);
  const rpc: CopilotSessionRpc = { mode: { set: async () => {} }, history: { compact } };
  const bridge = new CopilotSessionBridge();
  const session = new CopilotAdapterSession({ adapterScopeId: "compact-test", cwd: "/disposable", runtimeEpoch: "compact-epoch",
    native: { sessionId: "compact-session", rpc, send, abort: async () => {}, setModel: async () => {}, getEvents, disconnect: async () => {} },
    bridge, settings: {}, onStopped: () => {} });
  const events: AdapterEvent[] = []; session.subscribe(event => events.push(event));
  return { session, compact, send, getEvents, rpc, bridge, events };
}

describe("Copilot native compaction", () => {
  it("preserves native result fields and attributes the explicit manual action without messages or history reads", async () => {
    const f = fixture(); expect(await f.session.execute(command)).toEqual(success);
    expect(f.compact).toHaveBeenCalledExactlyOnceWith({ trigger: "manual" });
    expect(f.send).not.toHaveBeenCalled(); expect(f.getEvents).not.toHaveBeenCalled();
    expect(f.session.status()).toBe("idle");
  });

  it("retains a definite false/no-op result instead of claiming success or retrying", async () => {
    const result = { success: false, tokensRemoved: 0, messagesRemoved: 0 };
    const f = fixture(result); expect(await f.session.execute(command)).toEqual(result);
    expect(f.compact).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, {}, [], { success: true }, { ...success, success: "true" },
    { ...success, tokensRemoved: NaN }, { ...success, contextWindow: {} }, { ...success, summaryContent: "x".repeat(NATIVE_PAYLOAD_MAX_BYTES) },
  ])("makes malformed or oversized acknowledgements unknown", async value => {
    const f = fixture(); f.compact.mockResolvedValueOnce(value);
    await expect(f.session.execute(command)).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect(f.compact).toHaveBeenCalledOnce();
  });

  it("preserves transport uncertainty without retry or inferred completion", async () => {
    const f = fixture(); f.compact.mockRejectedValueOnce(new Error("connection lost after dispatch"));
    await expect(f.session.execute(command)).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect(f.compact).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });

  it("rejects unavailable native support and retired bindings without dispatch", async () => {
    const f = fixture(); f.rpc.history = undefined;
    const absent = await f.session.execute(command).catch(error => error);
    expect(absent).not.toBeInstanceOf(AdapterOutcomeUnknownError); expect(absent.message).toContain("unavailable");
    await f.session.stop(); await expect(f.session.execute(command)).rejects.toThrow("stopped");
    expect(f.compact).not.toHaveBeenCalled();
  });

  it("fences late native acknowledgement after binding retirement", async () => {
    const f = fixture(); let release!: (value: unknown) => void;
    f.compact.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.session.execute(command); await f.session.stop(); release(success);
    await expect(pending).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect(f.compact).toHaveBeenCalledOnce();
  });

  it("forwards native progress without overriding whole-session activity", async () => {
    const f = fixture();
    f.bridge.nativeEvent({ id: "started", type: "assistant.turn_start", timestamp: "2026-09-09T00:00:00Z", data: {} } as SessionEvent);
    f.bridge.nativeEvent({ id: "compact", type: "session.compaction_complete", timestamp: "2026-09-09T00:00:01Z", data: success } as unknown as SessionEvent);
    expect(f.session.status()).toBe("running");
    expect(f.events.some(event => event.kind === "native" && event.nativeType === "session.compaction_complete")).toBe(true);
  });

  it("rejects arguments and alternate native targeting before dispatch", async () => {
    const f = fixture();
    for (const extra of [{ sessionId: "other" }, { customInstructions: "summarize" }, { trigger: "model_switch" }]) {
      const invalid = { type: "compact", ...extra } as const;
      expect(copilotCommandSchema.safeParse(invalid).success).toBe(false);
      await expect(f.session.execute({ harness: "copilot", command: invalid })).rejects.toThrow();
    }
    expect(f.compact).not.toHaveBeenCalled();
  });
});
