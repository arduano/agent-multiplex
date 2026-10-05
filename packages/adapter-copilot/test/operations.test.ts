import { describe, expect, it, vi } from "vitest";
import { AdapterOutcomeUnknownError } from "@arduano/agent-multiplex-runtime-node-core";
import { CopilotNativeOperations, COPILOT_NATIVE_OPERATION_TIMEOUT_MS, COPILOT_STARTUP_TIMEOUT_MS } from "../src/operations.js";

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void;
  return { result: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve: (value: T) => resolve(value), reject: (cause: unknown) => reject(cause) }; }

describe("noncancellable native operation ownership", () => {
  it("uses a separate startup deadline while mutation deadlines and uncertain lanes remain unchanged", async () => {
    vi.useFakeTimers();
    try {
      const operations = new CopilotNativeOperations(); const start = deferred<void>(); const mutation = deferred<void>();
      let startupFinished = false;
      const startup = operations.start(() => start.result).catch(error => { startupFinished = true; return error; });
      const caller = operations.run("session", "command", () => mutation.result);
      const unknown = expect(caller).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
      await vi.advanceTimersByTimeAsync(COPILOT_NATIVE_OPERATION_TIMEOUT_MS); await unknown;
      expect(startupFinished).toBe(false);
      expect(operations.pending("session")).toBe(true);
      await vi.advanceTimersByTimeAsync(COPILOT_STARTUP_TIMEOUT_MS - COPILOT_NATIVE_OPERATION_TIMEOUT_MS);
      expect(await startup).toBeInstanceOf(AdapterOutcomeUnknownError);
      expect(operations.pending("adapter:startup")).toBe(true);
      await expect(operations.start(async () => undefined)).rejects.toMatchObject({ code: "CONFLICT" });
      start.resolve(); mutation.resolve(); await operations.drain("adapter:startup"); await operations.drain("session");
      expect(operations.pending("session")).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("retains a timed-out lane while allowing independent sessions and exact late settlement", async () => {
    vi.useFakeTimers();
    try {
      const operations = new CopilotNativeOperations(); const native = deferred<string>(); const action = vi.fn(() => native.result);
      const outcomes: string[] = [];
      const caller = operations.run("session-a", "command", action, outcome => outcomes.push(outcome));
      const unknown = expect(caller).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
      await vi.advanceTimersByTimeAsync(COPILOT_NATIVE_OPERATION_TIMEOUT_MS); await unknown;
      expect(operations.pending("session-a")).toBe(true);
      await expect(operations.run("session-a", "command", action)).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await operations.run("session-b", "command", async () => "independent")).toBe("independent");
      let drained = false; void operations.drain("session-a").then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(0); expect(drained).toBe(false);
      native.resolve("late-acknowledged"); await operations.drain("session-a");
      expect(drained).toBe(true); expect(operations.pending("session-a")).toBe(false);
      expect(outcomes).toEqual(["dispatched", "timedOut", "lateAcknowledged"]);
      await unknown;
      expect(await operations.run("session-a", "command", async () => "new")).toBe("new");
      expect(action).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("retires pending caller waits on close while retaining native completion ownership", async () => {
    const operations = new CopilotNativeOperations(); const native = deferred<string>();
    const caller = operations.run("session", "command", () => native.result);
    const unknown = expect(caller).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    await Promise.resolve(); operations.close(); await unknown;
    expect(operations.pending("session")).toBe(true);
    await expect(operations.run("other", "command", async () => "unreachable")).rejects.toMatchObject({ code: "FENCED" });
    native.reject(new Error("late failed acknowledgement")); await operations.drain("session");
    expect(operations.pending("session")).toBe(false); await unknown;
  });

  it("does not dispatch an operation admitted after the shutdown fence", async () => {
    const operations = new CopilotNativeOperations(); const action = vi.fn(async () => "should not run");
    operations.close(); const caller = operations.run("session", "command", action);
    await expect(caller).rejects.toMatchObject({ code: "FENCED" }); await operations.drain("session");
    expect(action).not.toHaveBeenCalled();
  });

  it("fences native dispatch when diagnostic embedding closes the owner reentrantly", async () => {
    const operations = new CopilotNativeOperations(); const action = vi.fn(async () => "should not run");
    const caller = operations.run("session", "command", action, outcome => { if (outcome === "dispatched") operations.close(); });
    await expect(caller).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    await operations.drain("session"); expect(action).not.toHaveBeenCalled();
  });

  it("bounds retained mutation lanes across session churn without dispatching overflow", async () => {
    const operations = new CopilotNativeOperations(); const native = deferred<string>();
    const callers = Array.from({ length: 256 }, (_, i) => operations.run(`session-${i}`, "command", () => native.result).catch(error => error));
    const overflow = vi.fn(async () => "overflow");
    await expect(operations.run("session-overflow", "command", overflow)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(overflow).not.toHaveBeenCalled(); operations.close(); native.resolve("late"); await Promise.all(callers);
  });
});
