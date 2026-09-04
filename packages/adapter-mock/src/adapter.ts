import {
  adapterScopeIdSchema,
  newRuntimeEpoch,
  type AdapterScopeId,
  type HarnessCatalogEntry,
  type HarnessCommand,
  type HarnessResumeOptions,
  type HarnessSessionSettings,
  type HarnessSpawnOptions,
  type JsonValue,
  type NativeHistoryRequest,
  type NativeHistoryResult,
  type NativeInventoryItem,
  type NativeModel,
  type RuntimeEpoch,
  type SessionRuntimeStatus,
} from "@arduano/agent-multiplex-protocol";
import type {
  AdapterEvent,
  AdapterSession,
  AgentAdapter,
} from "@arduano/agent-multiplex-runtime-node-core";

export interface MockAgentAdapterOptions {
  readonly adapterScopeId?: string | AdapterScopeId;
  readonly streamIntervalMs?: number;
  readonly chunkCount?: number;
  readonly runtimeEpochFactory?: () => RuntimeEpoch;
}

interface MockTurn {
  readonly id: string;
  readonly itemId: string;
  readonly prompt: string;
  readonly response: string;
  status: "inProgress" | "completed" | "interrupted";
}

interface MockRecord {
  readonly vendorSessionId: string;
  readonly cwd: string;
  readonly turns: MockTurn[];
  model: string;
  effort: string;
  mode: JsonValue;
  active: MockAgentSession | undefined;
  lastActivityAt: string;
}

const now = (): string => new Date().toISOString();

/**
 * Deterministic in-memory Codex-shaped adapter for transport and fleet testing.
 * It never launches a process or calls a model provider.
 */
export class MockAgentAdapter implements AgentAdapter {
  public readonly harness = "codex" as const;
  public readonly adapterScopeId: AdapterScopeId;
  readonly #records = new Map<string, MockRecord>();
  readonly #streamIntervalMs: number;
  readonly #chunkCount: number;
  readonly #runtimeEpochFactory: () => RuntimeEpoch;
  #nextSession = 1;
  #closed = false;

  public constructor(options: MockAgentAdapterOptions = {}) {
    this.adapterScopeId = adapterScopeIdSchema.parse(
      options.adapterScopeId ?? "mock:codex",
    );
    this.#streamIntervalMs = nonnegativeInteger(
      options.streamIntervalMs ?? 5,
      "streamIntervalMs",
    );
    this.#chunkCount = positiveInteger(options.chunkCount ?? 8, "chunkCount");
    this.#runtimeEpochFactory = options.runtimeEpochFactory ?? newRuntimeEpoch;
  }

  public async describe(): Promise<HarnessCatalogEntry> {
    return {
      harness: this.harness,
      adapterScopeId: this.adapterScopeId,
      available: !this.#closed,
      version: "mock-v1",
      runtimeVersion: "in-memory",
      capabilities: [
        { name: "thread.start", version: "mock-v1", experimental: false },
        { name: "thread.resume", version: "mock-v1", experimental: false },
        { name: "thread.read-native-history", version: "mock-v1", experimental: false },
        { name: "native-stream", version: "mock-v1", experimental: false },
        { name: "turn.interrupt", version: "mock-v1", experimental: false },
        { name: "models.list", version: "mock-v1", experimental: false },
        { name: "models.switch", version: "mock-v1", experimental: false },
        { name: "reasoning-effort.switch", version: "mock-v1", experimental: false },
        { name: "collaboration-mode", version: "mock-v1", experimental: false },
      ],
      ...(!this.#closed ? {} : { unavailableReason: "mock adapter is closed" }),
    };
  }

  public async listModels(): Promise<NativeModel[]> {
    return [
      {
        harness: this.harness,
        id: "mock-model",
        name: "Mock Model",
        description: "Deterministic local streaming model used for load tests",
        native: {
          mock: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "medium" },
            { reasoningEffort: "high" },
          ],
        },
      },
    ];
  }

  public async listSessions(): Promise<NativeInventoryItem[]> {
    return [...this.#records.values()].map((record) => ({
      harness: this.harness,
      adapterScopeId: this.adapterScopeId,
      vendorSessionId: record.vendorSessionId,
      cwd: record.cwd,
      availability: record.active ? "active" : "resumable",
      runtimeStatus: record.active?.status() ?? "stopped",
      runtimeEpoch: record.active?.runtimeEpoch ?? null,
      harnessSettings: settingsFromRecord(record),
      nativeSummary: {
        mock: true,
        model: record.model,
        effort: record.effort,
        turnCount: record.turns.length,
      },
      lastActivityAt: record.lastActivityAt,
    }));
  }

  public async spawn(options: HarnessSpawnOptions): Promise<AdapterSession> {
    this.#assertOpen();
    if (options.harness !== "codex") throw new Error("mock adapter only supports codex");
    const vendorSessionId = `mock-${String(this.#nextSession++).padStart(6, "0")}`;
    const record: MockRecord = {
      vendorSessionId,
      cwd: options.cwd,
      turns: [],
      model: options.model ?? "mock-model",
      effort: options.effort ?? "medium",
      mode: options.collaborationMode ?? "default",
      active: undefined,
      lastActivityAt: now(),
    };
    this.#records.set(vendorSessionId, record);
    return this.#activate(record);
  }

  public async resume(options: HarnessResumeOptions): Promise<AdapterSession> {
    this.#assertOpen();
    if (options.harness !== "codex") throw new Error("mock adapter only supports codex");
    const record = this.#records.get(options.vendorSessionId);
    if (!record) throw new Error(`unknown mock session ${options.vendorSessionId}`);
    if (record.active) throw new Error(`mock session ${options.vendorSessionId} is active`);
    if (options.cwd !== undefined && options.cwd !== record.cwd) {
      throw new Error(`mock session ${options.vendorSessionId} belongs to ${record.cwd}`);
    }
    if (options.model !== undefined) record.model = options.model;
    if (options.effort !== undefined) record.effort = options.effort;
    if (options.collaborationMode !== undefined) record.mode = options.collaborationMode;
    return this.#activate(record);
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all(
      [...this.#records.values()].map(async (record) => record.active?.stop()),
    );
  }

  #activate(record: MockRecord): MockAgentSession {
    const session = new MockAgentSession({
      record,
      adapterScopeId: this.adapterScopeId,
      streamIntervalMs: this.#streamIntervalMs,
      chunkCount: this.#chunkCount,
      runtimeEpoch: this.#runtimeEpochFactory(),
      onStop: () => {
        if (record.active === session) record.active = undefined;
      },
    });
    record.active = session;
    record.lastActivityAt = now();
    return session;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("mock adapter is closed");
  }
}

interface MockAgentSessionOptions {
  readonly record: MockRecord;
  readonly adapterScopeId: AdapterScopeId;
  readonly streamIntervalMs: number;
  readonly chunkCount: number;
  readonly runtimeEpoch: RuntimeEpoch;
  readonly onStop: () => void;
}

class MockAgentSession implements AdapterSession {
  public readonly harness = "codex" as const;
  public readonly adapterScopeId: AdapterScopeId;
  public readonly vendorSessionId: string;
  public readonly cwd: string;
  public readonly runtimeEpoch: RuntimeEpoch;
  readonly #record: MockRecord;
  readonly #streamIntervalMs: number;
  readonly #chunkCount: number;
  readonly #onStop: () => void;
  readonly #listeners = new Set<(event: AdapterEvent) => void>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #status: SessionRuntimeStatus = "idle";
  #activeTurn: MockTurn | undefined;
  #stopped = false;

  public constructor(options: MockAgentSessionOptions) {
    this.#record = options.record;
    this.adapterScopeId = options.adapterScopeId;
    this.vendorSessionId = options.record.vendorSessionId;
    this.cwd = options.record.cwd;
    this.runtimeEpoch = options.runtimeEpoch;
    this.#streamIntervalMs = options.streamIntervalMs;
    this.#chunkCount = options.chunkCount;
    this.#onStop = options.onStop;
  }

  public status(): SessionRuntimeStatus {
    return this.#status;
  }

  public settings(): HarnessSessionSettings {
    return settingsFromRecord(this.#record);
  }

  public subscribe(listener: (event: AdapterEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async execute(request: HarnessCommand): Promise<JsonValue | undefined> {
    if (request.harness !== "codex") throw new Error("mock session only accepts codex commands");
    const command = request.command;
    switch (command.type) {
      case "send":
        return this.#send(inputText(command.input));
      case "steer":
        return { mock: true, accepted: false, reason: "no steerable mock turn" };
      case "interrupt":
        return this.#interrupt(command.turnId);
      case "setModel":
        this.#record.model = command.model;
        this.#emitSettings();
        return { mock: true, model: command.model };
      case "setEffort":
        this.#record.effort = command.effort;
        this.#emitSettings();
        return { mock: true, effort: command.effort };
      case "setMode":
        this.#record.mode = command.mode;
        this.#emitSettings();
        return { mock: true, mode: command.mode };
      case "updateTurnSettings":
        if (command.model !== undefined) this.#record.model = command.model;
        if (command.effort !== undefined) this.#record.effort = command.effort;
        this.#emitSettings();
        return { mock: true, accepted: true };
      case "listBackgroundTerminals":
        return [];
      case "terminateBackgroundTerminal":
        return { mock: true, processId: command.processId, terminated: false };
      case "cleanBackgroundTerminals":
        return { mock: true, cleaned: 0 };
    }
  }

  public async readNativeHistory(
    request: NativeHistoryRequest,
  ): Promise<NativeHistoryResult> {
    if (request.harness !== "codex") throw new Error("mock history is Codex-shaped");
    return {
      harness: this.harness,
      vendorSessionId: this.vendorSessionId,
      payload: {
        mock: true,
        thread: {
          id: this.vendorSessionId,
          turns: this.#record.turns.map((turn) => ({
            id: turn.id,
            status: turn.status,
            items: [{
              type: "agentMessage",
              id: turn.itemId,
              text: turn.response,
              phase: "final_answer",
            }],
          })),
        },
      },
      complete: true,
    };
  }

  public async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#activeTurn) this.#completeInterrupted(this.#activeTurn);
    this.#clearTimers();
    this.#setStatus("stopped");
    this.#listeners.clear();
    this.#onStop();
  }

  #send(prompt: string): JsonValue {
    if (this.#stopped) throw new Error("mock session is stopped");
    if (this.#activeTurn) throw new Error("mock session already has a running turn");
    const ordinal = this.#record.turns.length + 1;
    const id = `mock-turn-${String(ordinal).padStart(6, "0")}`;
    const itemId = `mock-item-${String(ordinal).padStart(6, "0")}`;
    const chunks = mockChunks(
      this.vendorSessionId,
      ordinal,
      prompt,
      this.#chunkCount,
    );
    const response = chunks.join("");
    const turn: MockTurn = {
      id,
      itemId,
      prompt,
      response,
      status: "inProgress",
    };
    this.#record.turns.push(turn);
    this.#record.lastActivityAt = now();
    this.#activeTurn = turn;
    this.#setStatus("running");
    this.#emitNative("turn/started", {
      mock: true,
      threadId: this.vendorSessionId,
      turn: { id, status: "inProgress", items: [] },
    });
    this.#emitNative("item/started", {
      mock: true,
      threadId: this.vendorSessionId,
      turnId: id,
      item: {
        type: "agentMessage",
        id: itemId,
        text: "",
        phase: "final_answer",
      },
    });
    chunks.forEach((delta, index) => {
      this.#schedule(() => {
        if (this.#activeTurn !== turn || turn.status !== "inProgress") return;
        this.#emitNative("item/agentMessage/delta", {
          mock: true,
          threadId: this.vendorSessionId,
          turnId: id,
          itemId,
          delta,
        });
        if (index === chunks.length - 1) this.#complete(turn);
      }, this.#streamIntervalMs * (index + 1));
    });
    return { mock: true, accepted: true, turn: { id, status: "inProgress" } };
  }

  #interrupt(expectedTurnId: string | undefined): JsonValue {
    const turn = this.#activeTurn;
    if (!turn || (expectedTurnId !== undefined && expectedTurnId !== turn.id)) {
      return { mock: true, interrupted: false };
    }
    this.#completeInterrupted(turn);
    return { mock: true, interrupted: true, turnId: turn.id };
  }

  #complete(turn: MockTurn): void {
    if (this.#activeTurn !== turn || turn.status !== "inProgress") return;
    turn.status = "completed";
    this.#emitNative("item/completed", {
      mock: true,
      threadId: this.vendorSessionId,
      turnId: turn.id,
      item: {
        type: "agentMessage",
        id: turn.itemId,
        text: turn.response,
        phase: "final_answer",
      },
    });
    this.#emitNative("turn/completed", {
      mock: true,
      threadId: this.vendorSessionId,
      turn: {
        id: turn.id,
        status: "completed",
        items: [{
          type: "agentMessage",
          id: turn.itemId,
          text: turn.response,
          phase: "final_answer",
        }],
      },
    });
    this.#activeTurn = undefined;
    this.#record.lastActivityAt = now();
    this.#setStatus("idle");
  }

  #completeInterrupted(turn: MockTurn): void {
    if (turn.status !== "inProgress") return;
    this.#clearTimers();
    turn.status = "interrupted";
    this.#emitNative("turn/completed", {
      mock: true,
      threadId: this.vendorSessionId,
      turn: { id: turn.id, status: "interrupted", items: [] },
    });
    this.#activeTurn = undefined;
    this.#record.lastActivityAt = now();
    this.#setStatus(this.#stopped ? "stopped" : "idle");
  }

  #emitSettings(): void {
    this.#record.lastActivityAt = now();
    this.#emitNative("thread/settings/updated", {
      mock: true,
      threadId: this.vendorSessionId,
      threadSettings: {
        cwd: this.cwd,
        model: this.#record.model,
        effort: this.#record.effort,
        collaborationMode: this.#record.mode,
      },
    });
    this.#emit({ kind: "settings", settings: this.settings() });
  }

  #setStatus(status: SessionRuntimeStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#emit({ kind: "status", status });
  }

  #emitNative(nativeType: string, payload: JsonValue): void {
    const timedPayload =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? { ...payload, emittedAtMs: Date.now() }
        : payload;
    this.#emit({ kind: "native", nativeType, payload: timedPayload, ephemeral: false });
  }

  #emit(event: AdapterEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #schedule(callback: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      callback();
    }, delayMs);
    timer.unref();
    this.#timers.add(timer);
  }

  #clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }
}

function inputText(input: string | JsonValue[]): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

function settingsFromRecord(record: MockRecord): HarnessSessionSettings {
  return {
    model: record.model,
    mode: modeName(record.mode),
    effort: record.effort,
  };
}

function modeName(mode: JsonValue): string {
  if (typeof mode === "string" && mode.length > 0) return mode;
  if (
    typeof mode === "object" &&
    mode !== null &&
    !Array.isArray(mode) &&
    typeof mode.mode === "string" &&
    mode.mode.length > 0
  ) {
    return mode.mode;
  }
  return "default";
}

function mockChunks(
  vendorSessionId: string,
  turn: number,
  prompt: string,
  count: number,
): string[] {
  const width = String(count).length;
  return Array.from({ length: count }, (_, index) =>
    `MOCK_DELTA|session=${vendorSessionId}|turn=${turn}|tick=${String(index + 1).padStart(width, "0")}|prompt=${prompt}\n`,
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative integer`);
  }
  return value;
}
