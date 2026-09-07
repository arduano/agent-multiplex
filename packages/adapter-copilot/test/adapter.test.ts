import type {
  ModelInfo,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
  SessionMetadata,
} from "@github/copilot-sdk";
import { RuntimeConnection } from "@github/copilot-sdk";
import { runtimeEpochSchema, type RuntimeEpoch } from "@arduano/agent-multiplex-protocol";
import { AdapterOutcomeUnknownError, type AdapterEvent } from "@arduano/agent-multiplex-runtime-node-core";
import { describe, expect, it, vi } from "vitest";

import {
  CopilotAgentAdapter,
  type CopilotAdapterClient,
} from "../src/adapter.js";
import type {
  CopilotNativeSession,
  CopilotSessionRpc,
} from "../src/session.js";

const EPOCH = runtimeEpochSchema.parse("01990f1b-9200-7000-8000-000000000001");

class NativeSession implements CopilotNativeSession {
  public readonly rpc: CopilotSessionRpc = {
    mode: { set: vi.fn(async () => undefined) },
  };
  public readonly sent: unknown[] = [];
  public readonly events: SessionEvent[] = [];
  public disconnected = false;

  public constructor(public readonly sessionId: string) {}

  public async send(options: Parameters<CopilotNativeSession["send"]>[0]): Promise<string> {
    this.sent.push(options);
    return `message-${this.sent.length}`;
  }

  public async abort(): Promise<void> {}
  public readonly setModel = vi.fn(async (_model: string): Promise<void> => undefined);
  public async getEvents(): Promise<SessionEvent[]> { return [...this.events]; }
  public async disconnect(): Promise<void> { this.disconnected = true; }
}

class Client implements CopilotAdapterClient {
  public started = false;
  public readonly created: SessionConfig[] = [];
  public readonly resumed: Array<{ sessionId: string; config: ResumeSessionConfig }> = [];
  public readonly sessions = new Map<string, NativeSession>();
  public metadata: SessionMetadata[] = [];
  public permissionRpc: CopilotSessionRpc["permissions"];

  public async start(): Promise<void> { this.started = true; }
  public async stop(): Promise<Error[]> { return []; }
  public async forceStop(): Promise<void> {}
  public async getStatus() { return { version: "1.0.79", protocolVersion: 7 }; }
  public async listModels(): Promise<ModelInfo[]> {
    return [{
      id: "gpt-5",
      name: "GPT-5",
      capabilities: {
        supports: { vision: true, reasoningEffort: true },
        limits: { max_context_window_tokens: 128_000 },
      },
    }];
  }
  public async listSessions(): Promise<SessionMetadata[]> { return this.metadata; }
  public async createSession(config: SessionConfig): Promise<CopilotNativeSession> {
    this.created.push(config);
    const native = new NativeSession(config.sessionId ?? "generated");
    if (this.permissionRpc) native.rpc.permissions = this.permissionRpc;
    this.sessions.set(native.sessionId, native);
    config.onEvent?.(event("session.start"));
    return native;
  }
  public async resumeSession(
    sessionId: string,
    config: ResumeSessionConfig,
  ): Promise<CopilotNativeSession> {
    this.resumed.push({ sessionId, config });
    const native = new NativeSession(sessionId);
    this.sessions.set(sessionId, native);
    return native;
  }
}

describe("CopilotAgentAdapter", () => {
  it("reports a confirmed missing saved session as a recoverable failure without recreating it", async () => {
    const client = new Client(); const adapter = adapterFor(client);
    const nativeError = Object.assign(new Error(
      "Request session.resume failed with message: Failed to load session events: Session not found: empty-before-restart",
    ), { code: -32603 });
    const resume = vi.spyOn(client, "resumeSession").mockRejectedValue(nativeError);
    const create = vi.spyOn(client, "createSession");
    const failure = await adapter.resume({ harness: "copilot", vendorSessionId: "empty-before-restart", continuePendingWork: false })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect((failure as Error).message).toContain("Stop and archive this entry");
    expect((failure as Error).cause).toBe(nativeError);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    await expect(adapter.listSessions()).resolves.toEqual([]);
    await adapter.close();
  });

  it.each([
    { message: "Request session.resume failed with message: Failed to load session events: Session not found: another-session", code: -32603 },
    { message: "Request session.resume failed with message: Failed to load session events: Session not found: missing", code: -32001 },
    { message: "Request session.resume failed with message: Failed to load session events: Session not found: missing", code: undefined },
    { message: "Connection ended while session was resuming", code: -32603 },
    { message: "Native tool reports Session not found: missing", code: -32603 },
  ])("keeps unproven resume outcomes unknown: %j", async native => {
    const client = new Client(); const adapter = adapterFor(client);
    vi.spyOn(client, "resumeSession").mockRejectedValue(Object.assign(new Error(native.message), { code: native.code }));
    const create = vi.spyOn(client, "createSession");
    await expect(adapter.resume({ harness: "copilot", vendorSessionId: "missing", continuePendingWork: false }))
      .rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect(create).not.toHaveBeenCalled();
    await adapter.close();
  });

  it.each(["spawn", "resume"] as const)("detaches a native handle when %s completes after adapter shutdown", async operation => {
    const client = new Client(); const adapter = adapterFor(client);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const create = client.createSession.bind(client); const resume = client.resumeSession.bind(client);
    client.createSession = async config => { const native = await create(config); await gate; return native; };
    client.resumeSession = async (id, config) => { const native = await resume(id, config); await gate; return native; };
    const result = operation === "spawn"
      ? adapter.spawn({ harness: "copilot", cwd: "/repo", native: { sessionId: "late-attachment" } })
      : adapter.resume({ harness: "copilot", cwd: "/repo", vendorSessionId: "late-attachment", continuePendingWork: false });
    await vi.waitFor(() => expect(client.sessions.has("late-attachment")).toBe(true));
    await adapter.close(); release();
    await expect(result).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect(client.sessions.get("late-attachment")?.disconnected).toBe(true);
  });

  it("does not return a session closed while attachment observations were pending", async () => {
    const client = new Client(); const adapter = adapterFor(client);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const create = client.createSession.bind(client);
    client.createSession = async config => {
      const native = await create(config);
      native.rpc.metadata = { activity: async () => { await gate; return { hasActiveWork: false, abortable: false }; } };
      return native;
    };
    const result = adapter.spawn({ harness: "copilot", cwd: "/repo", native: { sessionId: "late-observation" } });
    await vi.waitFor(() => expect(client.sessions.has("late-observation")).toBe(true));
    await adapter.close(); release();
    await expect(result).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect(client.sessions.get("late-observation")?.disconnected).toBe(true);
  });

  it("honors an explicit structured-runtime executable with the pinned CLI", async () => {
    const client = new Client();
    const adapter = new CopilotAgentAdapter({
      clientOptions: {
        env: { COPILOT_CLI_PATH: "/opt/copilot-structured-runtime" },
      },
      clientFactory: (options) => {
        expect(options.connection).toEqual(RuntimeConnection.forStdio({
          path: "/opt/copilot-structured-runtime",
        }));
        return client;
      },
    });
    await adapter.close();
  });

  it("projects initial settings and emits complete snapshots after acknowledged changes", async () => {
    const client = new Client();
    const adapter = adapterFor(client);
    const session = await adapter.spawn({
      harness: "copilot",
      cwd: "/repo",
      model: "gpt-5",
      reasoningEffort: "high",
      mode: "plan",
      native: { sessionId: "settings-session" },
    });

    expect(session.settings?.()).toEqual({
      model: "gpt-5",
      mode: "plan",
      effort: "high",
    });
    await expect(adapter.listSessions()).resolves.toMatchObject([{
      vendorSessionId: "settings-session",
      availability: "active",
      harnessSettings: {
        model: "gpt-5",
        mode: "plan",
        effort: "high",
      },
    }]);

    const received: AdapterEvent[] = [];
    session.subscribe((item) => received.push(item));
    await session.execute({
      harness: "copilot",
      command: { type: "setModel", model: "gpt-5.4" },
    });
    await session.execute({
      harness: "copilot",
      command: { type: "setMode", mode: "autopilot" },
    });

    expect(client.sessions.get("settings-session")?.setModel)
      .toHaveBeenCalledWith("gpt-5.4");
    expect(client.sessions.get("settings-session")?.rpc.mode.set)
      .toHaveBeenNthCalledWith(1, { mode: "plan" });
    expect(client.sessions.get("settings-session")?.rpc.mode.set)
      .toHaveBeenNthCalledWith(2, { mode: "autopilot" });
    expect(received.filter((item) => item.kind === "settings")).toEqual([
      {
        kind: "settings",
        settings: { model: "gpt-5.4", mode: "plan", effort: "high" },
      },
      {
        kind: "settings",
        settings: { model: "gpt-5.4", mode: "autopilot", effort: "high" },
      },
    ]);
    expect(session.settings?.()).toEqual({
      model: "gpt-5.4",
      mode: "autopilot",
      effort: "high",
    });
    await expect(adapter.listSessions()).resolves.toMatchObject([{
      harnessSettings: {
        model: "gpt-5.4",
        mode: "autopilot",
        effort: "high",
      },
    }]);
    await adapter.close();
  });

  it("initializes settings on resume and exposes them through SDK inventory", async () => {
    const client = new Client();
    client.metadata = [{
      sessionId: "resumed-settings-session",
      startTime: new Date("2026-01-01T00:00:00.000Z"),
      modifiedTime: new Date("2026-01-02T00:00:00.000Z"),
      summary: "Resumed settings session",
      isRemote: false,
      context: { workingDirectory: "/repo" },
    }];
    const adapter = adapterFor(client);
    const session = await adapter.resume({
      harness: "copilot",
      vendorSessionId: "resumed-settings-session",
      cwd: "/repo",
      model: "gpt-5.4",
      reasoningEffort: "xhigh",
      mode: "autopilot",
      continuePendingWork: false,
    });

    expect(session.settings?.()).toEqual({
      model: "gpt-5.4",
      mode: "autopilot",
      effort: "xhigh",
    });
    await expect(adapter.listSessions()).resolves.toMatchObject([{
      vendorSessionId: "resumed-settings-session",
      availability: "active",
      harnessSettings: {
        model: "gpt-5.4",
        mode: "autopilot",
        effort: "xhigh",
      },
    }]);
    await adapter.close();
  });

  it("injects runtime-node-local BYOK configuration and lists only configured models", async () => {
    const client = new Client();
    const adapter = new CopilotAgentAdapter({
      provider: {
        type: "openai",
        baseUrl: "https://provider.example/v1",
        bearerToken: "runtime-node-local-secret",
        wireApi: "responses",
        transport: "http",
      },
      defaultModel: "gpt-5.4",
      providerModels: ["gpt-5.4", "gpt-5.5", "gpt-5.4"],
      clientFactory: (options) => {
        expect(options.useLoggedInUser).toBe(false);
        return client;
      },
    });

    const models = await adapter.listModels();
    expect(client.started).toBe(false);
    expect(models.map(({ id }) => id)).toEqual(["gpt-5.4", "gpt-5.5"]);
    expect(JSON.stringify(models)).not.toContain("runtime-node-local-secret");
    expect(models[0]?.native).toMatchObject({
      capabilities: {
        supports: { vision: true, reasoningEffort: true },
        limits: {
          max_prompt_tokens: 922_000,
          max_context_window_tokens: 1_050_000,
        },
      },
      supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
      transport: "http",
    });
    expect(models[1]?.native).toMatchObject({
      imageSupport: "unknown",
      capabilities: {
        supports: { vision: false, reasoningEffort: false },
        limits: { max_context_window_tokens: 128_000 },
      },
    });

    await adapter.spawn({ harness: "copilot", cwd: "/repo" });
    expect(client.created[0]).toMatchObject({
      model: "gpt-5.4",
      provider: {
        type: "openai",
        baseUrl: "https://provider.example/v1",
        bearerToken: "runtime-node-local-secret",
        wireApi: "responses",
        transport: "http",
      },
    });
    await adapter.resume({
      harness: "copilot",
      vendorSessionId: "persisted-byok-session",
      cwd: "/repo",
    });
    expect(client.resumed[0]).toMatchObject({
      sessionId: "persisted-byok-session",
      config: {
        model: "gpt-5.4",
        provider: {
          type: "openai",
          baseUrl: "https://provider.example/v1",
          bearerToken: "runtime-node-local-secret",
          wireApi: "responses",
          transport: "http",
        },
      },
    });
    await adapter.close();
  });

  it("advertises configured BYOK vision capabilities while preserving conservative unknown models", async () => {
    const client = new Client();
    const capabilities = {
      supports: { vision: true, reasoningEffort: false },
      limits: { max_context_window_tokens: 64_000, vision: { supported_media_types: ["image/png"], max_prompt_images: 3, max_prompt_image_size: 2_000_000 } },
    };
    const adapter = new CopilotAgentAdapter({
      provider: { type: "openai", baseUrl: "https://provider.example/v1", wireApi: "responses" },
      defaultModel: "custom-vision",
      providerModels: ["custom-vision", "custom-unknown"],
      providerModelCapabilities: { "custom-vision": capabilities },
      clientFactory: () => client,
    });
    const models = await adapter.listModels();
    expect(models[0]?.native).toMatchObject({ capabilities, imageSupport: "supported" });
    expect(models[1]?.native).toMatchObject({ imageSupport: "unknown", capabilities: { supports: { vision: false } } });
    await adapter.close();
  });

  it("advertises opt-in primary history without changing full native history", async () => {
    const client = new Client(); const adapter = adapterFor(client);
    const session = await adapter.spawn({ harness: "copilot", cwd: "/workspace" });
    const native = client.sessions.get(session.vendorSessionId)!;
    const primary = { ...event("assistant.message"), id: "primary" };
    const child = { ...event("assistant.message"), id: "child", agentId: "child-agent" };
    native.events.push(primary, child);
    native.rpc.eventLog = { read: vi.fn(async () => ({ events: [primary], cursor: "native-end", hasMore: false, cursorStatus: "ok" })) };
    expect((await adapter.describe()).capabilities).toContainEqual(expect.objectContaining({ name: "history.native.primary", version: "v1" }));
    const getEvents = vi.spyOn(native, "getEvents");
    expect((await session.readNativeHistory({ harness: "copilot", limit: 100, native: { view: "primary", sortDirection: "desc" } })).payload).toEqual([primary]);
    expect(getEvents).not.toHaveBeenCalled();
    expect((await session.readNativeHistory({ harness: "copilot", limit: 100 })).payload).toEqual([primary, child]);
    delete native.rpc.eventLog;
    await expect(session.readNativeHistory({ harness: "copilot", limit: 100, native: { view: "primary" } })).rejects.toThrow("primary history is unavailable");
    expect(getEvents).toHaveBeenCalledOnce();
    await adapter.close();
  });

  it.each(["text", "numbers"] as const)("bounds %s history pages by wire bytes and preserves the exact next event index", async (kind) => {
    const client = new Client();
    const adapter = adapterFor(client);
    const session = await adapter.spawn({ harness: "copilot", cwd: "/workspace" });
    const native = client.sessions.get(session.vendorSessionId)!;
    native.events.push(...[0, 1].map((index) => ({ type: "assistant.message", id: `large-${index}`, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", data: kind === "text" ? { content: "x".repeat(600_000) } : { numbers: Array(45_000).fill(0.1) } } as SessionEvent)));
    const page = await session.readNativeHistory({ harness: "copilot", limit: 100 });
    expect(page.nextCursor).toBe("copilot:event-index:1");
    expect(page.complete).toBe(false);
    expect(page.payload).toHaveLength(1);
    const second = await session.readNativeHistory({ harness: "copilot", limit: 100, cursor: page.nextCursor! });
    expect(second.complete).toBe(true);
    expect(second.payload).toHaveLength(1);
    await adapter.close();
  });

  it("pages newest events first and keeps the older cursor stable as new events arrive", async () => {
    const client = new Client();
    const adapter = adapterFor(client);
    const session = await adapter.spawn({ harness: "copilot", cwd: "/workspace" });
    const native = client.sessions.get(session.vendorSessionId)!;
    native.events.push(...Array.from({ length: 1_100 }, (_, index) => ({ ...event("assistant.message"), id: String(index) })));
    const newest = await session.readNativeHistory({ harness: "copilot", limit: 100, native: { sortDirection: "desc" } });
    expect((newest.payload as Array<{ id: string }>).map(value => value.id)).toEqual(Array.from({ length: 100 }, (_, index) => String(1099 - index)));
    expect(newest.nextCursor).toBe("copilot:event-before:1000");
    native.events.push({ ...event("assistant.message"), id: "new" });
    const older = await session.readNativeHistory({ harness: "copilot", limit: 100, native: { sortDirection: "desc" }, cursor: newest.nextCursor });
    expect((older.payload as Array<{ id: string }>)[0]?.id).toBe("999");
    const first = await session.readNativeHistory({ harness: "copilot", limit: 100, native: { sortDirection: "desc" }, cursor: "copilot:event-before:50" });
    expect(first.complete).toBe(true);
    expect((first.payload as Array<{ id: string }>).at(-1)?.id).toBe("0");
    await expect(session.readNativeHistory({ harness: "copilot", limit: 100, cursor: newest.nextCursor })).rejects.toThrow("Invalid Copilot history cursor");
    await adapter.close();
  });

  it("reports a single oversized event without blocking subsequent older history", async () => {
    const client = new Client(); const adapter = adapterFor(client);
    const session = await adapter.spawn({ harness: "copilot", cwd: "/workspace" });
    const native = client.sessions.get(session.vendorSessionId)!;
    native.events.push({ ...event("assistant.message"), id: "older" }, { ...event("assistant.message"), id: "oversized", data: { content: "x".repeat(2_000_000) } } as SessionEvent);
    const request = { harness: "copilot" as const, limit: 100, native: { sortDirection: "desc", omitOversizedItems: true } };
    const skipped = await session.readNativeHistory(request);
    expect(skipped).toMatchObject({ payload: [], complete: false, nextCursor: "copilot:event-before:1", unavailableItem: { reason: "exceedsWireLimit", nativeItemId: "oversized" } });
    const older = await session.readNativeHistory({ ...request, cursor: skipped.nextCursor });
    expect(older).toMatchObject({ complete: true, payload: [{ id: "older" }] });
    await adapter.close();
  });

  it("preserves early native events, native modes, steering, and SDK history", async () => {
    const client = new Client();
    const adapter = adapterFor(client);
    const session = await adapter.spawn({
      harness: "copilot",
      cwd: "/repo",
      model: "gpt-5",
      mode: "plan",
      native: { sessionId: "copilot-session" },
    });

    const received: AdapterEvent[] = [];
    session.subscribe((item) => received.push(item));
    expect(received.filter((item) => item.kind === "native")).toHaveLength(1);
    expect(client.created[0]?.onEvent).toBeTypeOf("function");
    expect(client.sessions.get("copilot-session")?.rpc.mode.set).toHaveBeenCalledWith({ mode: "plan" });

    await session.execute({
      harness: "copilot",
      command: {
        type: "steer",
        prompt: { prompt: "change direction", attachments: [] },
        mode: "immediate",
      },
    });
    expect(client.sessions.get("copilot-session")?.sent).toEqual([{
      prompt: "change direction",
      attachments: [],
      mode: "immediate",
    }]);

    const native = client.sessions.get("copilot-session");
    native?.events.push(event("session.start"), event("session.idle"));
    const first = await session.readNativeHistory({ harness: "copilot", limit: 1 });
    expect(first.payload).toEqual([event("session.start")]);
    expect(first.complete).toBe(false);
    const second = await session.readNativeHistory({
      harness: "copilot",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.payload).toEqual([event("session.idle")]);
    expect(second.complete).toBe(true);
  });

  it("bridges exact native permission events to resolvable runtime-node interactions", async () => {
    const client = new Client();
    client.permissionRpc = { getMode: async () => ({ mode: "manual" }), setMode: async () => ({ success: true, mode: "allow-all" }),
      handlePendingPermissionRequest: vi.fn(async () => ({ success: true })) };
    const adapter = adapterFor(client);
    const session = await adapter.spawn({ harness: "copilot", cwd: "/repo" });
    const received: AdapterEvent[] = [];
    session.subscribe((item) => received.push(item));

    const callback = client.created[0]?.onPermissionRequest;
    expect(callback).toBeTypeOf("function");
    const permissionRequest = { kind: "read", fileName: "/repo/a.ts", intention: "inspect" } as const;
    expect(callback?.(
      permissionRequest,
      { sessionId: session.vendorSessionId },
    )).toEqual({ kind: "no-result" });
    client.created[0]?.onEvent?.({ ...event("session.start"), type: "permission.requested", data: { requestId: "native-request", permissionRequest } });
    const interaction = received.find((item) => item.kind === "interaction");
    expect(interaction?.kind).toBe("interaction");
    if (interaction?.kind !== "interaction") throw new Error("interaction not emitted");
    await interaction.resolve({ kind: "approve-once", approvedInteractively: true });
    expect(interaction.nativeRequestId).toBe("native-request");
    expect(client.permissionRpc.handlePendingPermissionRequest).toHaveBeenCalledWith({ requestId: "native-request", result: { kind: "approve-once", approvedInteractively: true } });
  });

  it("reports SDK sessions as resumable and active without reading storage", async () => {
    const client = new Client();
    client.metadata = [{
      sessionId: "past",
      startTime: new Date("2026-01-01T00:00:00.000Z"),
      modifiedTime: new Date("2026-01-02T00:00:00.000Z"),
      summary: "Past session",
      isRemote: false,
      context: { workingDirectory: "/past" },
    }];
    const adapter = adapterFor(client);
    await adapter.spawn({
      harness: "copilot",
      cwd: "/active",
      native: { sessionId: "active" },
    });
    const inventory = await adapter.listSessions();
    expect(inventory.map(({ vendorSessionId, availability }) => [vendorSessionId, availability]))
      .toEqual([["past", "resumable"], ["active", "active"]]);
  });
});

function adapterFor(client: Client): CopilotAgentAdapter {
  return new CopilotAgentAdapter({
    adapterScopeId: "test",
    clientFactory: () => client,
    runtimeEpochFactory: () => EPOCH as RuntimeEpoch,
  });
}

function event(type: "session.start" | "session.idle"): SessionEvent {
  return {
    type,
    id: `${type}-id`,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    data: {},
  } as SessionEvent;
}
