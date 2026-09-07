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
  copilotPermissionsSettingsSchema,
  type AdapterScopeId,
  type CopilotPermissionsSettings,
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
const REVERSE_HISTORY_CURSOR_PREFIX = "copilot:event-before:";

export interface CopilotSessionRpc {
  mode: {
    set(input: { mode: "interactive" | "plan" | "autopilot" }): Promise<void>;
  };
  permissions?: {
    getMode(): Promise<unknown>;
    setMode(input: { mode: "manual" | "allow-all" }): Promise<unknown>;
    handlePendingPermissionRequest(input: { requestId: string; result: Exclude<PermissionRequestResult, { kind: "no-result" }> }): Promise<unknown>;
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

interface PendingPermission {
  readonly requestId: string;
  readonly nativeRequestId: string;
  readonly child: boolean;
  resolving: boolean;
  completed: boolean;
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
  readonly #permissions = new Map<string, PendingPermission>();
  readonly #completedPermissions = new Set<string>();
  #permissionRpc: CopilotSessionRpc["permissions"];
  #permissionMode: CopilotPermissionsSettings | undefined;
  #permissionRevision = 0;
  #permissionsChanged: (() => void) | undefined;
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
    if (this.#closed) return;
    this.emit({
      kind: "native",
      nativeType: event.type,
      payload: copilotJson(event),
      ephemeral: event.ephemeral === true,
    });
    const child = event.agentId !== undefined;
    if (event.type === "permission.requested") { this.permissionRequested(event); return; }
    if (event.type === "permission.completed") this.permissionCompleted(event);
    // Descendant events remain in native history, but cannot change the root's
    // permission setting or runtime status through a shared SDK stream.
    if (child) return;
    if (event.type === "session.permissions_changed") {
      const data: Record<string, unknown> = isObject(event.data) ? event.data : {};
      this.observePermissions({ mode: data.mode });
    }
    const status = statusForNativeEvent(event.type);
    if (status) this.setStatus(status === "running" && this.waitingForInput() ? "waitingForInput" : status);
  }

  public attachPermissions(rpc: CopilotSessionRpc["permissions"], onChanged: () => void): void {
    this.#permissionRpc = rpc;
    this.#permissionsChanged = onChanged;
  }
  public get permissionRevision(): number { return this.#permissionRevision; }
  public permissionMode(): CopilotPermissionsSettings | undefined { return this.#permissionMode ? { ...this.#permissionMode } : undefined; }
  public observePermissions(value: unknown, expectedRevision?: number): void {
    if (this.#closed || expectedRevision !== undefined && expectedRevision !== this.#permissionRevision) return;
    const parsed = copilotPermissionsSettingsSchema.safeParse(value);
    this.#permissionMode = parsed.success ? parsed.data : undefined;
    this.#permissionRevision += 1;
    this.#permissionsChanged?.();
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
          if (this.#closed || pending.settled) throw new Error("Copilot interaction was already resolved");
          const parsed = options.parseResponse(response);
          pending.settled = true;
          this.#pending.delete(pending);
          settle(parsed);
          this.setStatus(this.waitingForInput() ? "waitingForInput" : "running");
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
    this.#permissions.clear();
    this.#completedPermissions.clear();
    this.#permissionsChanged = undefined;
    this.#permissionRpc = undefined;
    this.#listeners.clear();
    this.#buffer.splice(0);
  }

  private permissionRequested(event: Extract<SessionEvent, { type: "permission.requested" }>): void {
    const { requestId, permissionRequest, resolvedByHook } = event.data;
    if (resolvedByHook || typeof requestId !== "string" || !requestId || !permissionRequest || typeof permissionRequest !== "object") return;
    const nativeRequestId = permissionIdentity(requestId, event.agentId);
    if (this.#permissions.has(nativeRequestId) || this.#completedPermissions.has(nativeRequestId)) return;
    const pending: PendingPermission = { requestId, nativeRequestId, child: event.agentId !== undefined, resolving: false, completed: false };
    this.#permissions.set(nativeRequestId, pending);
    if (!pending.child) this.setStatus("waitingForInput");
    this.emit({ kind: "interaction", requestType: "permission", nativeRequestId, ephemeral: false,
      payload: copilotJson({ permissionRequest, requestId, ...(event.agentId === undefined ? {} : { agentId: event.agentId }) }),
      resolve: async (response) => {
        if (this.#closed || pending.completed || this.#permissions.get(nativeRequestId) !== pending) throw new Error("Copilot permission request is no longer pending");
        if (pending.resolving) throw new Error("Copilot permission request is already resolving");
        const rpc = this.#permissionRpc;
        if (typeof rpc?.handlePendingPermissionRequest !== "function") throw new Error("Copilot does not support native permission decisions");
        const decision = permissionResponse(response);
        if (decision.kind === "no-result") throw new TypeError("A permission decision is required");
        pending.resolving = true;
        let result: unknown;
        try {
          result = await rpc.handlePendingPermissionRequest({ requestId, result: decision });
        } catch (cause) {
          pending.resolving = false;
          if (pending.completed) this.retirePermission(pending);
          throw new AdapterOutcomeUnknownError("Copilot permission decision was dispatched but not acknowledged", { cause });
        }
        pending.resolving = false;
        if (!isObject(result) || typeof result.success !== "boolean") {
          if (pending.completed) this.retirePermission(pending);
          throw new AdapterOutcomeUnknownError("Copilot permission decision returned an unrecognized result");
        }
        if (!result.success) {
          this.retirePermission(pending);
          throw new Error("Copilot permission request was already resolved");
        }
        this.#permissions.delete(nativeRequestId);
        this.rememberCompletedPermission(nativeRequestId);
        if (!pending.child) this.setStatus(this.waitingForInput() ? "waitingForInput" : "running");
      },
    });
  }

  private permissionCompleted(event: Extract<SessionEvent, { type: "permission.completed" }>): void {
    const requestId = event.data.requestId;
    if (typeof requestId !== "string" || !requestId) return;
    const nativeRequestId = permissionIdentity(requestId, event.agentId);
    this.rememberCompletedPermission(nativeRequestId);
    const pending = this.#permissions.get(nativeRequestId);
    if (!pending) return;
    pending.completed = true;
    // A controller's successful decision has its own durable resolution. Let
    // its acknowledgement finish; an external decision retires the prompt now.
    if (!pending.resolving) this.retirePermission(pending);
  }
  private retirePermission(pending: PendingPermission): void {
    if (this.#permissions.get(pending.nativeRequestId) !== pending) return;
    this.#permissions.delete(pending.nativeRequestId);
    this.rememberCompletedPermission(pending.nativeRequestId);
    this.emit({ kind: "interactionSettled", nativeRequestId: pending.nativeRequestId, state: "stale" });
  }
  private rememberCompletedPermission(nativeRequestId: string): void {
    this.#completedPermissions.add(nativeRequestId);
    while (this.#completedPermissions.size > 1_024) this.#completedPermissions.delete(this.#completedPermissions.values().next().value!);
  }
  private waitingForInput(): boolean {
    return this.#pending.size > 0 || [...this.#permissions.values()].some(pending => !pending.child && !pending.completed);
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
    this.#bridge.attachPermissions(this.#native.rpc.permissions, () => this.#bridge.settings(this.settings()));
  }

  public readonly adapterScopeId: AdapterScopeId;
  public readonly vendorSessionId: string;
  public readonly cwd: string | null;
  public readonly runtimeEpoch: RuntimeEpoch;

  public status(): SessionRuntimeStatus {
    return this.#bridge.status();
  }

  public settings(): HarnessSessionSettings {
    const copilotPermissions = this.#bridge.permissionMode();
    const settings = { ...this.#settings };
    delete settings.copilotPermissions;
    return { ...settings, ...(copilotPermissions === undefined ? {} : { copilotPermissions }) };
  }

  /** Permission state is native-owned. Read it on each fresh SDK attachment;
   * absence/unknown versions remain unknown and never default to enabled. */
  public async readPermissions(): Promise<void> {
    const read = this.#native.rpc.permissions?.getMode;
    if (typeof read !== "function") return;
    const generation = this.#bridge.permissionRevision;
    try {
      const result = await read.call(this.#native.rpc.permissions);
      this.#bridge.observePermissions(result, generation);
    } catch {
      this.#bridge.observePermissions(undefined, generation);
    }
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
      case "setPermissionMode": {
        const permissions = this.#native.rpc.permissions;
        if (typeof permissions?.setMode !== "function" || typeof permissions.getMode !== "function") throw new Error("Copilot allow-all permissions are unavailable on this native session");
        const generation = this.#bridge.permissionRevision;
        let result: CopilotPermissionsSettings & { success: boolean };
        try {
          result = await this.mutation("change Copilot allow-all permissions", async () => {
            const value = await permissions.setMode({ mode: command.mode });
            if (!isObject(value) || typeof value.success !== "boolean") throw new TypeError("Unrecognized Copilot allow-all result");
            const state = copilotPermissionsSettingsSchema.parse(value);
            return { success: value.success, ...state };
          });
        } catch (error) {
          this.#bridge.observePermissions(undefined, generation);
          throw error;
        }
        // A newer native notification wins over a delayed RPC reply. The return
        // value still records the authoritative outcome of this exact operation.
        this.#bridge.observePermissions(result, generation);
        if (!result.success || result.mode !== command.mode) throw new Error("Copilot did not apply the requested allow-all permission mode");
        return copilotJson(result);
      }
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
    const sortDirection = request.native?.sortDirection ?? "asc";
    if (sortDirection !== "asc" && sortDirection !== "desc") throw new TypeError("Invalid Copilot history sort direction");
    const descending = sortDirection === "desc";
    const boundary = request.cursor === undefined ? descending ? events.length : 0
      : decodeHistoryCursor(request.cursor, descending ? REVERSE_HISTORY_CURSOR_PREFIX : HISTORY_CURSOR_PREFIX);
    if (boundary > events.length) throw new TypeError("Copilot history cursor exceeds the current history");
    const payload: JsonValue[] = [];
    let position = boundary;
    let bytes = 128;
    let images = 0;
    while (payload.length < request.limit && (descending ? position > 0 : position < events.length)) {
      const event = copilotJson(events[descending ? position - 1 : position]);
      const itemBytes = copilotHistoryEventBytes(event, payload.length);
      const itemImages = copilotImageLeaves(event).length;
      if (bytes + itemBytes > NATIVE_PAYLOAD_MAX_BYTES || images + itemImages > 256) {
        if (!payload.length) {
          if (request.native?.omitOversizedItems !== true) throw new Error("One native Copilot history event exceeds the bounded wire envelope");
          const omitted = jsonRecord(event, "Copilot history event");
          position += descending ? -1 : 1;
          const complete = descending ? position === 0 : position >= events.length;
          return {
            harness: "copilot", vendorSessionId: this.vendorSessionId, payload: [], complete, sortDirection,
            ...(complete ? {} : { nextCursor: `${descending ? REVERSE_HISTORY_CURSOR_PREFIX : HISTORY_CURSOR_PREFIX}${position}` }),
            unavailableItem: { reason: "exceedsWireLimit",
              ...(typeof omitted?.id === "string" && omitted.id.length <= 1_024 ? { nativeItemId: omitted.id } : {}),
              ...(typeof omitted?.type === "string" && omitted.type.length <= 256 ? { nativeType: omitted.type } : {}),
            },
          };
        }
        break;
      }
      bytes += itemBytes;
      images += itemImages;
      payload.push(event);
      position += descending ? -1 : 1;
    }
    const complete = descending ? position === 0 : position >= events.length;
    return {
      harness: "copilot",
      vendorSessionId: this.vendorSessionId,
      payload, sortDirection,
      ...(complete ? {} : { nextCursor: `${descending ? REVERSE_HISTORY_CURSOR_PREFIX : HISTORY_CURSOR_PREFIX}${position}` }),
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

function decodeHistoryCursor(cursor: string, prefix = HISTORY_CURSOR_PREFIX): number {
  if (!cursor.startsWith(prefix)) {
    throw new TypeError("Invalid Copilot history cursor");
  }
  const value = cursor.slice(prefix.length);
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

function permissionIdentity(requestId: string, agentId: string | undefined): string {
  return agentId === undefined ? requestId : `copilot:child:${JSON.stringify([agentId, requestId])}`;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
