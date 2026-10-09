import { EventEmitter } from "node:events";
import type { ResumeSessionConfig, SessionConfig } from "@github/copilot-sdk";
import { AdapterOutcomeUnknownError, NativeOwnerTerminationError } from "@arduano/agent-multiplex-runtime-node-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopilotAgentAdapter, CopilotAttachmentPreparationError, type CopilotAdapterClient } from "../src/adapter.js";
import type { CopilotNativeSession, CopilotOwnershipDiagnostic } from "../src/session.js";
import { resolveCopilotTimeouts, STANDARD_COPILOT_TIMEOUTS, WINDOWS_COPILOT_TIMEOUTS, type CopilotTimeoutPolicy } from "../src/timeouts.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) };
}

function fixture(timeouts: CopilotTimeoutPolicy = WINDOWS_COPILOT_TIMEOUTS) {
  const native: CopilotNativeSession = {
    sessionId: "windows-session", rpc: { mode: { set: vi.fn(async () => undefined) } },
    send: vi.fn(async () => "message-id"), abort: vi.fn(async () => undefined),
    getEvents: vi.fn(async () => []), disconnect: vi.fn(async () => undefined),
  };
  const client: CopilotAdapterClient = {
    start: vi.fn(async () => undefined), stop: vi.fn(async () => []), forceStop: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({ version: "fixture", protocolVersion: 7 })),
    listModels: vi.fn(async () => []), listSessions: vi.fn(async () => []),
    createSession: vi.fn(async () => native), resumeSession: vi.fn(async () => native),
  };
  const diagnostics: CopilotOwnershipDiagnostic[] = [];
  const adapter = new CopilotAgentAdapter({ timeouts, clientFactory: () => client,
    onOwnershipDiagnostic: record => diagnostics.push(record) });
  const resume = () => adapter.resume({ harness: "copilot", vendorSessionId: native.sessionId });
  return { native, client, adapter, diagnostics, resume };
}

describe("explicit Copilot observation policy", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("preserves Linux budgets and snapshots a validated immutable Windows override", () => {
    expect(resolveCopilotTimeouts(undefined, "linux")).toEqual({ startupMs: 60_000, attachmentMs: 15_000,
      operationMs: 15_000, readMs: 15_000, cleanupMs: 10_000 });
    expect(resolveCopilotTimeouts(undefined, "win32")).toEqual(WINDOWS_COPILOT_TIMEOUTS);
    const input = { ...WINDOWS_COPILOT_TIMEOUTS };
    const selected = resolveCopilotTimeouts(input, "linux");
    input.attachmentMs = 1;
    expect(selected.attachmentMs).toBe(120_000);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(STANDARD_COPILOT_TIMEOUTS)).toBe(true);
    for (const value of [0, -1, 0.5, Infinity, NaN, 2_147_483_648]) {
      expect(() => resolveCopilotTimeouts({ ...input, cleanupMs: value })).toThrow(TypeError);
    }
    expect(resolveCopilotTimeouts({ ...input, readMs: 600_000 }).readMs).toBe(600_000);
    expect(() => resolveCopilotTimeouts({ ...input, readMs: 600_001 })).toThrow(TypeError);
    expect(resolveCopilotTimeouts({ ...input, cleanupMs: 2_147_483_647 }).cleanupMs).toBe(2_147_483_647);
    expect(() => resolveCopilotTimeouts({ startupMs: 100 } as CopilotTimeoutPolicy)).toThrow(TypeError);
  });

  it("acknowledges a Windows resume beyond 15 seconds with one SDK call", async () => {
    const f = fixture(), attachment = deferred<CopilotNativeSession>();
    vi.mocked(f.client.resumeSession).mockReturnValue(attachment.promise);
    let finished = false;
    const caller = f.resume().then(session => { finished = true; return session; });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(finished).toBe(false);
    expect(f.client.resumeSession).toHaveBeenCalledOnce();
    attachment.resolve(f.native);
    expect((await caller).vendorSessionId).toBe(f.native.sessionId);
    expect(f.diagnostics).toContainEqual(expect.objectContaining({ stage: "attachment", outcome: "acknowledged",
      elapsedMs: 20_000, deadlineMs: 120_000 }));
    await f.adapter.close();
  });

  it("proves the old 15-second negative control and preserves late-release ownership", async () => {
    const f = fixture(STANDARD_COPILOT_TIMEOUTS), attachment = deferred<CopilotNativeSession>(), detach = deferred<void>();
    vi.mocked(f.client.resumeSession).mockReturnValue(attachment.promise);
    vi.mocked(f.native.disconnect).mockReturnValue(detach.promise);
    const caller = f.resume(), unknown = expect(caller).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    await vi.advanceTimersByTimeAsync(15_000); await unknown;
    await expect(f.resume()).rejects.toMatchObject({ code: "CONFLICT" });
    attachment.resolve(f.native); await vi.advanceTimersByTimeAsync(0);
    expect(f.native.disconnect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(f.resume()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.client.resumeSession).toHaveBeenCalledOnce();
    detach.resolve(); await vi.advanceTimersByTimeAsync(0);
    vi.mocked(f.client.resumeSession).mockResolvedValue(f.native);
    await expect(f.resume()).resolves.toMatchObject({ vendorSessionId: f.native.sessionId });
    await unknown; // The original immutable observation remains unknown.
    await f.adapter.close();
  });

  it("keeps the wider Windows deadline finite without replaying a mutation", async () => {
    const f = fixture(), attachment = deferred<CopilotNativeSession>();
    vi.mocked(f.client.resumeSession).mockReturnValue(attachment.promise);
    const caller = f.resume(), unknown = expect(caller).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    await vi.advanceTimersByTimeAsync(WINDOWS_COPILOT_TIMEOUTS.attachmentMs); await unknown;
    await expect(f.resume()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.client.resumeSession).toHaveBeenCalledOnce();
    attachment.resolve(f.native); await vi.advanceTimersByTimeAsync(0);
    expect(f.native.disconnect).toHaveBeenCalledOnce();
    await f.adapter.close();
  });

  it("uses the same Windows policy for slow startup, reads, mutations and disconnect", async () => {
    const f = fixture(), startup = deferred<void>();
    vi.mocked(f.client.start).mockReturnValue(startup.promise);
    const resumed = f.resume();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.client.start).toHaveBeenCalledOnce(); expect(f.client.resumeSession).not.toHaveBeenCalled();
    startup.resolve(); const session = await resumed;
    const events = deferred<Awaited<ReturnType<CopilotNativeSession["getEvents"]>>>();
    vi.mocked(f.native.getEvents).mockReturnValue(events.promise);
    const history = session.readNativeHistory({ harness: "copilot", limit: 10 });
    const sent = deferred<string>(); vi.mocked(f.native.send).mockReturnValue(sent.promise);
    const send = session.execute({ harness: "copilot", command: { type: "send", prompt: "fixture", mode: "enqueue" } });
    await vi.advanceTimersByTimeAsync(20_000);
    events.resolve([]); sent.resolve("message-id");
    await history; await send;
    const detach = deferred<void>(); vi.mocked(f.native.disconnect).mockReturnValue(detach.promise);
    const stop = session.stop(); await vi.advanceTimersByTimeAsync(30_000);
    expect(f.native.disconnect).toHaveBeenCalledOnce(); detach.resolve(); await stop;
    await f.adapter.close();
  });

  it("allows refreshed task observations beyond the old overall page deadline", async () => {
    const f = fixture(), refreshed = deferred<unknown>();
    const list = vi.fn(async () => ({ tasks: [] }));
    f.native.rpc.tasks = { refresh: vi.fn(() => refreshed.promise), list };
    const session = await f.resume();
    const reading = session.readNativeState!({ harness: "copilot", view: "tasks" });
    await vi.advanceTimersByTimeAsync(20_000);
    refreshed.resolve({});
    expect((await reading).payload).toEqual({ tasks: [] });
    expect(list).toHaveBeenCalledOnce();
    await f.adapter.close();
  });

  it("never certifies Windows shutdown from forceStop without exact child exit", async () => {
    const f = fixture(), child = Object.assign(new EventEmitter(), {
      pid: 123, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    });
    Object.assign(f.client, { isExternalServer: false, cliProcess: child });
    await f.resume();
    vi.mocked(f.native.disconnect).mockReturnValue(new Promise(() => {}));
    const closing = expect(f.adapter.close()).rejects.toBeInstanceOf(NativeOwnerTerminationError);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.client.forceStop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000); await closing;
    child.signalCode = "SIGKILL"; child.emit("exit");
    await expect(f.adapter.close()).rejects.toBeInstanceOf(NativeOwnerTerminationError);
    expect(f.client.forceStop).toHaveBeenCalledOnce();
  });

  it("accepts a slow Windows graceful shutdown only after captured child exit", async () => {
    const f = fixture(), child = Object.assign(new EventEmitter(), {
      pid: 124, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    });
    Object.assign(f.client, { isExternalServer: false, cliProcess: child });
    await f.resume();
    const detach = deferred<void>(); vi.mocked(f.native.disconnect).mockReturnValue(detach.promise);
    const stopped = deferred<Error[]>(); vi.mocked(f.client.stop).mockReturnValue(stopped.promise);
    const closing = f.adapter.close();
    void closing.catch(() => undefined); // Observe the negative control immediately.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(f.client.stop).not.toHaveBeenCalled();
    detach.resolve(); await vi.advanceTimersByTimeAsync(30_000);
    expect(f.client.forceStop).not.toHaveBeenCalled();
    child.exitCode = 0; child.emit("exit"); stopped.resolve([]); await closing;
    expect(f.client.stop).toHaveBeenCalledOnce();
  });
});

describe("pre-dispatch Copilot preparation ownership", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("orders slow preparation before the real SDK boundary without configuration diagnostics", async () => {
    const f = fixture(), ready = deferred<void>();
    f.client.prepareSession = async <T extends SessionConfig | ResumeSessionConfig>(config: T) => {
      await ready.promise;
      return { ...config, mcpServers: { fixture: { type: "local" as const, command: "fixture", args: [], tools: ["*"] } } };
    };
    const resumed = f.resume(); await vi.advanceTimersByTimeAsync(20_000);
    expect(f.client.resumeSession).not.toHaveBeenCalled();
    ready.resolve(); await resumed;
    expect(f.client.resumeSession).toHaveBeenCalledWith(f.native.sessionId, expect.objectContaining({ mcpServers: expect.any(Object) }));
    expect(f.diagnostics.filter(record => record.stage.startsWith("attachment")).map(record => [record.stage, record.outcome]))
      .toEqual([["attachmentPreparation", "dispatched"], ["attachmentPreparation", "acknowledged"],
        ["attachment", "dispatched"], ["attachment", "acknowledged"]]);
    expect(JSON.stringify(f.diagnostics)).not.toContain("mcpServers");
    await f.adapter.close();
  });

  it("retains a timed-out preparation reservation and never dispatches its late result", async () => {
    const f = fixture({ ...WINDOWS_COPILOT_TIMEOUTS, attachmentMs: 100 }), ready = deferred<void>();
    let signal!: AbortSignal;
    f.client.prepareSession = async <T extends SessionConfig | ResumeSessionConfig>(config: T, current: AbortSignal) => {
      signal = current; await ready.promise; return config;
    };
    const refused = expect(f.resume()).rejects.toBeInstanceOf(CopilotAttachmentPreparationError);
    await vi.advanceTimersByTimeAsync(100); await refused;
    expect(signal.aborted).toBe(true);
    await expect(f.resume()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.client.resumeSession).not.toHaveBeenCalled();
    ready.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(f.client.resumeSession).not.toHaveBeenCalled();
    f.client.prepareSession = async config => config;
    await f.resume(); expect(f.client.resumeSession).toHaveBeenCalledOnce();
    await f.adapter.close();
  });

  it("treats a preparation refusal as definite and permits a new clean attempt", async () => {
    const f = fixture(), original = new Error("fixture private admission refusal");
    f.client.prepareSession = async () => { throw original; };
    await expect(f.resume()).rejects.toMatchObject({ name: "CopilotAttachmentPreparationError", cause: original });
    expect(f.client.resumeSession).not.toHaveBeenCalled();
    f.client.prepareSession = async config => config;
    await f.resume(); expect(f.client.resumeSession).toHaveBeenCalledOnce();
    await f.adapter.close();
  });

  it("retires slow create preparation on close before any SDK mutation", async () => {
    const f = fixture(), ready = deferred<void>();
    f.client.prepareSession = async config => { await ready.promise; return config; };
    const refused = expect(f.adapter.spawn({ harness: "copilot", cwd: "/fixture", native: { sessionId: f.native.sessionId } }))
      .rejects.toBeInstanceOf(CopilotAttachmentPreparationError);
    await vi.advanceTimersByTimeAsync(0);
    await f.adapter.close(); await refused;
    ready.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(f.client.createSession).not.toHaveBeenCalled();
  });
});
