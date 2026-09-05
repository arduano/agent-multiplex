import type { AdapterNativeHistoryResult } from "@arduano/agent-multiplex-runtime-node-core";
import type {
  ElicitationResult,
  ExitPlanModeResult,
  MessageOptions,
  PermissionRequestResult,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import {
  type AdapterEvent,
  AdapterOutcomeUnknownError,
  type AdapterSession,
} from "@arduano/agent-multiplex-runtime-node-core";
import {
  NATIVE_PAYLOAD_MAX_BYTES,
  type AdapterScopeId,
  type HarnessCommand,
  type HarnessSessionSettings,
  type JsonObject,
  type JsonValue,
  type NativeHistoryRequest,
  type RuntimeEpoch,
  type SessionRuntimeStatus,
} from "@arduano/agent-multiplex-protocol";

import { copilotJson, jsonRecord, requiredString } from "./json.js";
import { copilotHistoryEventBytes, copilotImageLeaves } from "./images.js";

const HISTORY_CURSOR_PREFIX = "copilot:event-index:";

export interface CopilotSessionRpc {
  mode: {
    set(input: { mode: "interactive" | "plan" | "autopilot" }): Promise<void>;
  };
}

type CopilotUserInputResponse = Awaited<
  ReturnType<NonNullable<SessionConfig["onUserInputRequest"]>>
>;

/** The SDK subset used by a live adapter session. Exported for test hosts. */
export interface CopilotNativeSession {
  readonly sessionId: string;
  readonly rpc: CopilotSessionRpc;
  send(options: MessageOptions): Promise<string>;
  abort(): Promise<void>;
  setModel(model: string): Promise<void>;
  getEvents(): Promise<SessionEvent[]>;
  disconnect(): Promise<void>;
}

interface PendingBridgeInteraction {
  settled: boolean;
  cancelValue: JsonValue;
  settle(value: JsonValue): void;
}

/**
 * Buffers startup events until RuntimeNodeService installs its subscriber. It also
 * turns SDK reverse callbacks into resolvable runtime-node interactions without
 * inventing a second transcript representation.
 */
export class CopilotSessionBridge {
  readonly #listeners = new Set<(event: AdapterEvent) => void>();
  readonly #buffer: AdapterEvent[] = [];
  readonly #pending = new Set<PendingBridgeInteraction>();
  #closed = false;
  #status: SessionRuntimeStatus = "idle";

  public status(): SessionRuntimeStatus {
    return this.#status;
  }

  public subscribe(listener: (event: AdapterEvent) => void): () => void {
    if (this.#closed) return () => undefined;
    this.#listeners.add(listener);
    if (this.#buffer.length > 0) {
      const buffered = this.#buffer.splice(0);
      for (const event of buffered) listener(event);
    }
    return () => this.#listeners.delete(listener);
  }

  public nativeEvent(event: SessionEvent): void {
    this.emit({
      kind: "native",
      nativeType: event.type,
      payload: copilotJson(event),
      ephemeral: event.ephemeral === true,
    });
    const status = statusForNativeEvent(event.type);
    if (status) this.setStatus(status);
  }

  public setStatus(status: SessionRuntimeStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.emit({ kind: "status", status });
  }

  public settings(settings: HarnessSessionSettings): void {
    this.emit({ kind: "settings", settings });
  }

  public interaction(
    requestType: "permission" | "userInput" | "elicitation" | "exitPlan",
    payload: unknown,
    options: {
      ephemeral: boolean;
      cancelValue: JsonValue;
      parseResponse(response: JsonValue): JsonValue;
    },
  ): Promise<JsonValue> {
    if (this.#closed) return Promise.resolve(options.cancelValue);
    this.setStatus("waitingForInput");
    return new Promise<JsonValue>((settle) => {
      const pending: PendingBridgeInteraction = {
        settled: false,
        cancelValue: options.cancelValue,
        settle,
      };
      this.#pending.add(pending);
      this.emit({
        kind: "interaction",
        requestType,
        payload: copilotJson(payload),
        ephemeral: options.ephemeral,
        resolve: async (response) => {
          if (pending.settled) throw new Error("Copilot interaction was already resolved");
          const parsed = options.parseResponse(response);
          pending.settled = true;
          this.#pending.delete(pending);
          settle(parsed);
          this.setStatus("running");
        },
      });
    });
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending) {
      if (!pending.settled) {
        pending.settled = true;
        pending.settle(pending.cancelValue);
      }
    }
    this.#pending.clear();
    this.#listeners.clear();
    this.#buffer.splice(0);
  }

  private emit(event: AdapterEvent): void {
    if (this.#closed) return;
    if (this.#listeners.size === 0) {
      this.#buffer.push(event);
      return;
    }
    for (const listener of this.#listeners) listener(event);
  }
}

export class CopilotAdapterSession implements AdapterSession {
  public readonly harness = "copilot" as const;
  readonly #native: CopilotNativeSession;
  readonly #bridge: CopilotSessionBridge;
  readonly #onStopped: () => void;
  #settings: HarnessSessionSettings;
  #stopped = false;

  public constructor(options: {
    adapterScopeId: AdapterScopeId;
    cwd: string | null;
    runtimeEpoch: RuntimeEpoch;
    native: CopilotNativeSession;
    bridge: CopilotSessionBridge;
    settings: HarnessSessionSettings;
    onStopped(): void;
  }) {
    this.adapterScopeId = options.adapterScopeId;
    this.cwd = options.cwd;
    this.runtimeEpoch = options.runtimeEpoch;
    this.#native = options.native;
    this.#bridge = options.bridge;
    this.#settings = options.settings;
    this.#onStopped = options.onStopped;
    this.vendorSessionId = options.native.sessionId;
  }

  public readonly adapterScopeId: AdapterScopeId;
  public readonly vendorSessionId: string;
  public readonly cwd: string | null;
  public readonly runtimeEpoch: RuntimeEpoch;

  public status(): SessionRuntimeStatus {
    return this.#bridge.status();
  }

  public settings(): HarnessSessionSettings {
    return { ...this.#settings };
  }

  public subscribe(listener: (event: AdapterEvent) => void): () => void {
    return this.#bridge.subscribe(listener);
  }

  public async execute(request: HarnessCommand): Promise<JsonValue | undefined> {
    this.assertActive();
    if (request.harness !== "copilot") {
      throw new TypeError(`Copilot adapter cannot execute ${request.harness} commands`);
    }
    const command = request.command;
    switch (command.type) {
      case "send": {
        const options = messageOptions(command.prompt, command.native, "enqueue");
        this.#bridge.setStatus("running");
        const messageId = await this.mutation("enqueue Copilot prompt", () =>
          this.#native.send(options),
        );
        return { messageId };
      }
      case "steer": {
        const options = messageOptions(command.prompt, command.native, "immediate");
        this.#bridge.setStatus("running");
        const messageId = await this.mutation("steer Copilot session", () =>
          this.#native.send(options),
        );
        return { messageId };
      }
      case "interrupt":
        await this.mutation("interrupt Copilot session", () => this.#native.abort());
        return undefined;
      case "setModel":
        await this.mutation("change Copilot model", () => this.#native.setModel(command.model));
        this.#settings = { ...this.#settings, model: command.model };
        this.#bridge.settings(this.settings());
        return { model: command.model };
      case "setMode":
        await this.mutation("change Copilot mode", () =>
          this.#native.rpc.mode.set({ mode: command.mode }),
        );
        this.#settings = { ...this.#settings, mode: command.mode };
        this.#bridge.settings(this.settings());
        return { mode: command.mode };
    }
  }

  public async readNativeHistory(request: NativeHistoryRequest): Promise<AdapterNativeHistoryResult> {
    this.assertActive();
    if (request.harness !== "copilot") {
      throw new TypeError(`Copilot session cannot read ${request.harness} history`);
    }

    // getEvents() is Copilot's supported history API. The adapter only pages the
    // returned opaque events; it never opens or interprets Copilot's session store.
    const events = await this.#native.getEvents();
    const start = decodeHistoryCursor(request.cursor);
    const requestedEnd = Math.min(start + request.limit, events.length);
    let end = start;
    let bytes = 128;
    let images = 0;
    while (end < requestedEnd) {
      const event = copilotJson(events[end]);
      const itemBytes = copilotHistoryEventBytes(event, end - start);
      const itemImages = copilotImageLeaves(event).length;
      if (bytes + itemBytes > NATIVE_PAYLOAD_MAX_BYTES || images + itemImages > 256) {
        if (end === start) throw new Error("One native Copilot history event exceeds the bounded wire envelope");
        break;
      }
      bytes += itemBytes;
      images += itemImages;
      end += 1;
    }
    const payload = copilotJson(events.slice(start, end));
    const complete = end >= events.length;
    return {
      harness: "copilot",
      vendorSessionId: this.vendorSessionId,
      payload,
      ...(complete ? {} : { nextCursor: `${HISTORY_CURSOR_PREFIX}${end}` }),
      complete,
    };
  }

  public async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#bridge.setStatus("stopped");
    this.#bridge.close();
    this.#onStopped();
    try {
      await this.#native.disconnect();
    } catch (cause) {
      throw new AdapterOutcomeUnknownError(
        `Copilot session ${this.vendorSessionId} may not have disconnected cleanly`,
        { cause },
      );
    }
  }

  private assertActive(): void {
    if (this.#stopped) throw new Error(`Copilot session ${this.vendorSessionId} is stopped`);
  }

  private async mutation<T>(description: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (cause) {
      this.#bridge.setStatus("unknown");
      throw new AdapterOutcomeUnknownError(
        `${description} failed after dispatch; native outcome is unknown`,
        { cause },
      );
    }
  }
}

export function permissionResponse(value: JsonValue): PermissionRequestResult {
  const response = jsonRecord(value, "Copilot permission response");
  requiredString(response, "kind", "Copilot permission response");
  return response as PermissionRequestResult;
}

export function userInputResponse(value: JsonValue): CopilotUserInputResponse {
  const response = jsonRecord(value, "Copilot user-input response");
  const answer = response.answer;
  const wasFreeform = response.wasFreeform;
  if (typeof answer !== "string") {
    throw new TypeError("Copilot user-input response.answer must be a string");
  }
  if (typeof wasFreeform !== "boolean") {
    throw new TypeError("Copilot user-input response.wasFreeform must be a boolean");
  }
  return { answer, wasFreeform };
}

export function elicitationResponse(value: JsonValue): ElicitationResult {
  const response = jsonRecord(value, "Copilot elicitation response");
  const action = response.action;
  if (action !== "accept" && action !== "decline" && action !== "cancel") {
    throw new TypeError(
      "Copilot elicitation response.action must be accept, decline, or cancel",
    );
  }
  const content = response.content;
  if (content !== undefined && (content === null || Array.isArray(content) || typeof content !== "object")) {
    throw new TypeError("Copilot elicitation response.content must be an object");
  }
  return {
    action,
    ...(content === undefined
      ? {}
      : { content: content as NonNullable<ElicitationResult["content"]> }),
  };
}

export function exitPlanResponse(value: JsonValue): ExitPlanModeResult {
  const response = jsonRecord(value, "Copilot exit-plan response");
  if (typeof response.approved !== "boolean") {
    throw new TypeError("Copilot exit-plan response.approved must be a boolean");
  }
  const selectedAction = response.selectedAction;
  const feedback = response.feedback;
  if (selectedAction !== undefined && typeof selectedAction !== "string") {
    throw new TypeError("Copilot exit-plan response.selectedAction must be a string");
  }
  if (feedback !== undefined && typeof feedback !== "string") {
    throw new TypeError("Copilot exit-plan response.feedback must be a string");
  }
  return {
    approved: response.approved,
    ...(selectedAction === undefined ? {} : { selectedAction }),
    ...(feedback === undefined ? {} : { feedback }),
  };
}

function messageOptions(
  prompt: string | JsonObject,
  native: JsonObject | undefined,
  mode: "enqueue" | "immediate",
): MessageOptions {
  const promptOptions: Record<string, JsonValue> = typeof prompt === "string" ? {} : prompt;
  const promptText = typeof prompt === "string"
    ? prompt
    : requiredString(promptOptions, "prompt", "Copilot native prompt");
  // The discriminated command owns delivery mode. Everything else remains an
  // opaque, JSON-compatible native MessageOptions field.
  return {
    ...promptOptions,
    ...native,
    prompt: promptText,
    mode,
  } as unknown as MessageOptions;
}

function decodeHistoryCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!cursor.startsWith(HISTORY_CURSOR_PREFIX)) {
    throw new TypeError("Invalid Copilot history cursor");
  }
  const value = cursor.slice(HISTORY_CURSOR_PREFIX.length);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError("Invalid Copilot history cursor");
  }
  const index = Number(value);
  if (!Number.isSafeInteger(index)) throw new TypeError("Invalid Copilot history cursor");
  return index;
}

function statusForNativeEvent(nativeType: string): SessionRuntimeStatus | undefined {
  switch (nativeType) {
    case "session.start":
    case "session.resume":
    case "session.idle":
    case "assistant.idle":
      return "idle";
    case "user.message":
    case "assistant.turn_start":
      return "running";
    case "permission.requested":
    case "user_input.requested":
    case "elicitation.requested":
    case "exit_plan_mode.requested":
      return "waitingForInput";
    case "permission.completed":
    case "user_input.completed":
    case "elicitation.completed":
    case "exit_plan_mode.completed":
      return "running";
    case "session.error":
      return "error";
    case "session.shutdown":
      return "stopped";
    default:
      return undefined;
  }
}
