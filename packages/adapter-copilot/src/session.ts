import type { AdapterNativeHistoryResult, AdapterNativeStateResult } from "@arduano/agent-multiplex-runtime-node-core";
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
  copilotCommandSchema,
  copilotPermissionsSettingsSchema,
  jsonWireByteUpperBound,
  type AdapterScopeId,
  type CopilotPermissionsSettings,
  type HarnessCommand,
  type HarnessSessionSettings,
  type JsonObject,
  type JsonValue,
  type NativeHistoryRequest,
  type NativeStateRequest,
  type RuntimeEpoch,
  type SessionRuntimeStatus,
} from "@arduano/agent-multiplex-protocol";

import { copilotJson, jsonRecord, requiredString } from "./json.js";
import { taskId, taskSnapshot } from "./tasks.js";
import { compactionResult } from "./compaction.js";
import { copilotHistoryEventBytes, copilotImageLeaves } from "./images.js";
import { readPrimaryHistory, type CopilotEventLogReadRequest } from "./primary-history.js";
import { COPILOT_READ_TIMEOUT_MS, CopilotReadBusyError, CopilotReadRequests } from "./reads.js";

const HISTORY_CURSOR_PREFIX = "copilot:event-index:";
const REVERSE_HISTORY_CURSOR_PREFIX = "copilot:event-before:";

export interface CopilotSessionRpc {
  mode: {
    get?(): Promise<unknown>;
    set(input: { mode: "interactive" | "plan" | "autopilot" }): Promise<void>;
  };
  model?: {
    getCurrent(): Promise<unknown>;
  };
  history?: {
    compact(input: { trigger: "manual" }): Promise<unknown>;
  };
  queue?: {
    pendingItems(): Promise<unknown>;
    sendNow(input: { id: string }): Promise<unknown>;
  };
  tasks?: {
    list(): Promise<unknown>;
    refresh(): Promise<unknown>;
    getProgress(input: { id: string }): Promise<unknown>;
    getCurrentPromotable(): Promise<unknown>;
    promoteToBackground(input: { id: string }): Promise<unknown>;
    cancel(input: { id: string }): Promise<unknown>;
  };
  metadata?: {
    activity(): Promise<unknown>;
  };
  eventLog?: {
    read(input: CopilotEventLogReadRequest): Promise<unknown>;
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
  #model: string | undefined;
  #modelRevision = 0;
  #modelChangeRevision = 0;
  #modelChanged: (() => void) | undefined;
  #mode: string | undefined;
  #modeRevision = 0;
  #modeChangeRevision = 0;
  #modeChanged: (() => void) | undefined;
  #closed = false;
  #status: SessionRuntimeStatus = "idle";
  #activityRevision = 0;

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
    const child = eventOwner(event) !== undefined;
    if (event.type === "permission.requested") { this.permissionRequested(event); return; }
    if (event.type === "permission.completed" && !this.permissionCompleted(event)) return;
    // Descendant events remain in native history, but cannot change the root's
    // settings or runtime status through a shared SDK stream.
    if (child) return;
    if (event.type === "session.permissions_changed") {
      const data: Record<string, unknown> = isObject(event.data) ? event.data : {};
      this.observePermissions({ mode: data.mode });
    }
    if (event.type === "session.model_change") {
      this.observeModel(isObject(event.data) ? event.data.newModel : undefined);
    }
    if (event.type === "session.mode_changed") {
      this.observeMode(isObject(event.data) ? event.data.newMode : undefined);
    }
    const status = event.type === "session.resume"
      ? event.data.sessionWasActive === true || event.data.continuePendingWork === true ? "running" : "idle"
      : statusForNativeEvent(event.type);
    if (status) this.setStatus((status === "running" || status === "idle") && this.waitingForInput() ? "waitingForInput" : status);
  }

  public attachModel(initialModel: string | undefined, onChanged: () => void): void {
    if (this.#modelRevision === 0) this.#model = initialModel;
    this.#modelChanged = onChanged;
  }
  public get modelRevision(): number { return this.#modelRevision; }
  public get modelChangeRevision(): number { return this.#modelChangeRevision; }
  public model(): string | undefined { return this.#model; }
  public observeModel(value: unknown, expectedChangeRevision?: number): void {
    if (this.#closed || expectedChangeRevision !== undefined && expectedChangeRevision !== this.#modelChangeRevision) return;
    this.#modelChangeRevision += 1;
    this.updateModel(value);
  }
  public observeModelRead(value: unknown, expectedRevision: number): void {
    if (this.#closed || expectedRevision !== this.#modelRevision) return;
    // Reads fence older reads, but cannot supersede a mutation acknowledged
    // afterward. Only native changes and acknowledgements fence that reply.
    this.updateModel(value);
  }
  private updateModel(value: unknown): void {
    this.#model = typeof value === "string" && value.length > 0 ? value : undefined;
    this.#modelRevision += 1;
    this.#modelChanged?.();
  }

  public attachMode(initialMode: string | undefined, onChanged: () => void): void {
    if (this.#modeRevision === 0) this.#mode = initialMode;
    this.#modeChanged = onChanged;
  }
  public get modeRevision(): number { return this.#modeRevision; }
  public get modeChangeRevision(): number { return this.#modeChangeRevision; }
  public mode(): string | undefined { return this.#mode; }
  public observeMode(value: unknown, expectedChangeRevision?: number): void {
    if (this.#closed || expectedChangeRevision !== undefined && expectedChangeRevision !== this.#modeChangeRevision) return;
    this.#modeChangeRevision += 1;
    this.updateMode(value);
  }
  public observeModeRead(value: unknown, expectedRevision: number): void {
    if (this.#closed || expectedRevision !== this.#modeRevision) return;
    this.updateMode(value);
  }
  private updateMode(value: unknown): void {
    this.#mode = value === "interactive" || value === "plan" || value === "autopilot" ? value : undefined;
    this.#modeRevision += 1;
    this.#modeChanged?.();
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
    if (this.#closed) return;
    this.#activityRevision += 1;
    if (this.#status === status) return;
    this.#status = status;
    this.emit({ kind: "status", status });
  }

  public get activityRevision(): number { return this.#activityRevision; }
  public beginMessage(): void {
    this.setStatus(this.waitingForInput() ? "waitingForInput" : "running");
  }
  public uncertainMutation(expectedRevision: number): void {
    if (expectedRevision !== this.#activityRevision) return;
    this.setStatus(this.waitingForInput() ? "waitingForInput" : "unknown");
  }
  public observeActivity(value: unknown, expectedRevision: number): void {
    if (this.#closed || expectedRevision !== this.#activityRevision) return;
    if (!isObject(value) || typeof value.hasActiveWork !== "boolean") { this.activityUnavailable(expectedRevision); return; }
    this.setStatus(this.waitingForInput() ? "waitingForInput" : value.hasActiveWork ? "running" : "idle");
  }

  public activityUnavailable(expectedRevision: number): void {
    if (this.#closed || expectedRevision !== this.#activityRevision || this.waitingForInput()) return;
    if (this.#status === "running" || this.#status === "idle") this.setStatus("unknown");
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
    this.#modelChanged = undefined;
    this.#permissionRpc = undefined;
    this.#listeners.clear();
    this.#buffer.splice(0);
  }

  private permissionRequested(event: Extract<SessionEvent, { type: "permission.requested" }>): void {
    const { requestId, permissionRequest, resolvedByHook } = event.data;
    if (resolvedByHook || typeof requestId !== "string" || !requestId || !permissionRequest || typeof permissionRequest !== "object") return;
    const owner = eventOwner(event);
    const nativeRequestId = permissionIdentity(requestId, owner);
    if (this.#permissions.has(nativeRequestId) || this.#completedPermissions.has(nativeRequestId)) return;
    const pending: PendingPermission = { requestId, nativeRequestId, child: owner !== undefined, resolving: false, completed: false };
    this.#permissions.set(nativeRequestId, pending);
    if (!pending.child) this.setStatus("waitingForInput");
    this.emit({ kind: "interaction", requestType: "permission", nativeRequestId, ephemeral: false,
      payload: copilotJson({ permissionRequest, requestId, ...(owner === undefined ? {} : { agentId: owner }) }),
      resolve: async (response) => {
        if (this.#closed || pending.completed || this.#permissions.get(nativeRequestId) !== pending) throw new Error("Copilot permission request is no longer pending");
        if (pending.resolving) throw new Error("Copilot permission request is already resolving");
        const rpc = this.#permissionRpc;
        if (typeof rpc?.handlePendingPermissionRequest !== "function") throw new Error("Copilot does not support native permission decisions");
        const decision = permissionResponse(response);
        if (decision.kind === "no-result") throw new TypeError("A permission decision is required");
        pending.resolving = true;
        const activityRevision = this.#activityRevision;
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
        if (!pending.child && activityRevision === this.#activityRevision) this.setStatus(this.waitingForInput() ? "waitingForInput" : "running");
      },
    });
  }

  private permissionCompleted(event: Extract<SessionEvent, { type: "permission.completed" }>): boolean {
    const requestId = event.data.requestId;
    if (typeof requestId !== "string" || !requestId) return false;
    const nativeRequestId = permissionIdentity(requestId, eventOwner(event));
    this.rememberCompletedPermission(nativeRequestId);
    const pending = this.#permissions.get(nativeRequestId);
    if (!pending) return false;
    pending.completed = true;
    // A controller's successful decision has its own durable resolution. Let
    // its acknowledgement finish; an external decision retires the prompt now.
    if (!pending.resolving) this.retirePermission(pending);
    return true;
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
  readonly #reads: CopilotReadRequests;
  #settings: HarnessSessionSettings;
  #stopped = false;

  public constructor(options: {
    adapterScopeId: AdapterScopeId;
    cwd: string | null;
    runtimeEpoch: RuntimeEpoch;
    native: CopilotNativeSession;
    bridge: CopilotSessionBridge;
    settings: HarnessSessionSettings;
    reads?: CopilotReadRequests;
    onStopped(): void;
  }) {
    this.adapterScopeId = options.adapterScopeId;
    this.cwd = options.cwd;
    this.runtimeEpoch = options.runtimeEpoch;
    this.#native = options.native;
    this.#bridge = options.bridge;
    this.#settings = options.settings;
    this.#onStopped = options.onStopped;
    this.#reads = options.reads ?? new CopilotReadRequests();
    this.vendorSessionId = options.native.sessionId;
    this.#bridge.attachModel(options.settings.model, () => this.#bridge.settings(this.settings()));
    this.#bridge.attachMode(options.settings.mode, () => this.#bridge.settings(this.settings()));
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
    const model = this.#bridge.model();
    const mode = this.#bridge.mode();
    const settings = { ...this.#settings };
    delete settings.copilotPermissions;
    delete settings.model;
    delete settings.mode;
    return { ...settings, ...(model === undefined ? {} : { model }), ...(mode === undefined ? {} : { mode }), ...(copilotPermissions === undefined ? {} : { copilotPermissions }) };
  }

  /** Read the native selection on every attachment, including a resume with no
   * model argument. An absent modelId is unknown, not an inferred auto/default. */
  public async readModel(): Promise<void> {
    const read = this.#native.rpc.model?.getCurrent;
    if (typeof read !== "function") return;
    const generation = this.#bridge.modelRevision;
    try {
      const result = await this.read("model", String(generation), () => read.call(this.#native.rpc.model));
      this.#bridge.observeModelRead(isObject(result) ? result.modelId : undefined, generation);
    } catch (error) {
      if (!(error instanceof CopilotReadBusyError)) this.#bridge.observeModelRead(undefined, generation);
    }
  }

  /** Plan approval can change native mode without a Multiplex setMode command. */
  public async readMode(): Promise<void> {
    const read = this.#native.rpc.mode.get;
    if (typeof read !== "function") return;
    const revision = this.#bridge.modeRevision;
    try {
      const result = await this.read("mode", String(revision), () => read.call(this.#native.rpc.mode));
      this.#bridge.observeModeRead(result, revision);
    } catch (error) {
      if (!(error instanceof CopilotReadBusyError)) this.#bridge.observeModeRead(undefined, revision);
    }
  }

  /** Resume may join live work without replaying its earlier turn-start event. */
  public async readActivity(): Promise<void> {
    const metadata = this.#native.rpc.metadata;
    if (typeof metadata?.activity !== "function") return;
    const revision = this.#bridge.activityRevision;
    try {
      const result = await this.read("activity", String(revision), () => metadata.activity());
      this.#bridge.observeActivity(result, revision);
    } catch (error) {
      // Lack of a response proves neither progress nor completion. A newer
      // native event or pending interaction still wins this observation fence.
      if (!(error instanceof CopilotReadBusyError)) this.#bridge.activityUnavailable(revision);
    }
  }

  /** Permission state is native-owned. Read it on each fresh SDK attachment;
   * absence/unknown versions remain unknown and never default to enabled. */
  public async readPermissions(): Promise<void> {
    const read = this.#native.rpc.permissions?.getMode;
    if (typeof read !== "function") return;
    const generation = this.#bridge.permissionRevision;
    try {
      const result = await this.read("permissions", String(generation), () => read.call(this.#native.rpc.permissions));
      this.#bridge.observePermissions(result, generation);
    } catch (error) {
      if (!(error instanceof CopilotReadBusyError)) this.#bridge.observePermissions(undefined, generation);
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
        this.#bridge.beginMessage();
        const messageId = await this.mutation("enqueue Copilot prompt", async () =>
          acknowledgedMessageId(await this.#native.send(options)),
        );
        return { messageId };
      }
      case "steer": {
        const options = messageOptions(command.prompt, command.native, "immediate");
        this.#bridge.beginMessage();
        const messageId = await this.mutation("steer Copilot session", async () =>
          acknowledgedMessageId(await this.#native.send(options)),
        );
        return { messageId };
      }
      case "interrupt":
        await this.mutation("interrupt Copilot session", () => this.#native.abort());
        return undefined;
      case "compact": {
        copilotCommandSchema.parse(command);
        const history = this.#native.rpc.history;
        if (typeof history?.compact !== "function") throw new Error("Copilot native context compaction is unavailable");
        return this.mutation("compact Copilot context", async () => {
          const result = await history.compact({ trigger: "manual" });
          this.assertActive();
          // A native success:false is an acknowledged outcome, never a reason
          // to replay the request or send a synthetic /compact user message.
          return compactionResult(result);
        });
      }
      case "steerQueuedMessage": {
        const queue = this.#native.rpc.queue;
        if (typeof queue?.sendNow !== "function") throw new Error("Copilot queued-message steering is unavailable");
        return this.mutation("steer queued Copilot message", async () => {
          const result = await queue.sendNow({ id: command.id });
          if (!isObject(result) || typeof result.steered !== "boolean") throw new TypeError("Unrecognized Copilot queued-message steering acknowledgement");
          // Native sendNow owns the atomic queue-to-steering transition. False
          // leaves the native item queued; never remove and resend its text.
          return { steered: result.steered };
        });
      }
      case "promoteTaskToBackground":
      case "cancelTask": {
        const tasks = this.#native.rpc.tasks;
        const action = command.type === "cancelTask" ? tasks?.cancel : tasks?.promoteToBackground;
        if (typeof action !== "function") throw new Error("Copilot native task control is unavailable");
        const field = command.type === "cancelTask" ? "cancelled" : "promoted";
        const validatedId = taskId(command.id);
        return this.mutation(`${command.type} Copilot task`, async () => {
          const result = await action.call(tasks, { id: validatedId });
          if (!isObject(result) || typeof result[field] !== "boolean") throw new TypeError("Unrecognized Copilot task acknowledgement");
          // False is a definite native refusal/no-op. Never fall back to another
          // task, a process ID, a shell command, or replay of its prompt.
          return { [field]: result[field] };
        });
      }
      case "setModel": {
        const generation = this.#bridge.modelChangeRevision;
        try {
          await this.mutation("change Copilot model", () => this.#native.setModel(command.model));
        } catch (error) {
          this.#bridge.observeModel(undefined, generation);
          throw error;
        }
        this.#bridge.observeModel(command.model, generation);
        return { model: command.model };
      }
      case "setMode": {
        const revision = this.#bridge.modeChangeRevision;
        try {
          await this.mutation("change Copilot mode", () =>
            this.#native.rpc.mode.set({ mode: command.mode }),
          );
        } catch (error) {
          this.#bridge.observeMode(undefined, revision);
          throw error;
        }
        this.#bridge.observeMode(command.mode, revision);
        return { mode: command.mode };
      }
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
    if (request.native?.view === "primary") {
      const eventLog = this.#native.rpc.eventLog;
      if (typeof eventLog?.read !== "function") throw new Error("Copilot primary history is unavailable on this native session");
      const deadlineAt = Date.now() + COPILOT_READ_TIMEOUT_MS;
      return readPrimaryHistory(this.vendorSessionId, request, async input => {
        const result = await this.read("primaryHistory", JSON.stringify(input), () => eventLog.read(input), deadlineAt);
        this.assertActive();
        return result;
      });
    }
    if (request.native?.view !== undefined) throw new TypeError("Unsupported Copilot native history view");

    // getEvents() is Copilot's supported history API. The adapter only pages the
    // returned opaque events; it never opens or interprets Copilot's session store.
    const events = await this.read("history", "", () => this.#native.getEvents());
    this.assertActive();
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

  public async readNativeState(request: NativeStateRequest): Promise<AdapterNativeStateResult> {
    this.assertActive();
    if (request.harness !== "copilot") throw new TypeError("Unsupported Copilot native state view");
    if (request.view !== "pendingMessages") {
      const tasks = this.#native.rpc.tasks;
      let value: unknown;
      switch (request.view) {
        case "tasks": {
          if (typeof tasks?.list !== "function" || typeof tasks.refresh !== "function") throw new Error("Copilot task observation is unavailable");
          const deadlineAt = Date.now() + COPILOT_READ_TIMEOUT_MS;
          value = await this.read("tasks", "", async () => {
            await tasks.refresh();
            this.assertActive();
            if (Date.now() >= deadlineAt) throw new Error("Copilot task observation timed out before listing refreshed tasks");
            return tasks.list();
          }, deadlineAt);
          break;
        }
        case "taskProgress":
          if (typeof tasks?.getProgress !== "function") throw new Error("Copilot task progress is unavailable");
          taskId(request.id);
          value = await this.read("taskProgress", request.id, () => tasks.getProgress({ id: request.id }));
          break;
        case "currentPromotableTask":
          if (typeof tasks?.getCurrentPromotable !== "function") throw new Error("Copilot promotable task observation is unavailable");
          value = await this.read("currentPromotableTask", "", () => tasks.getCurrentPromotable());
          break;
        default: throw new TypeError("Unsupported Copilot native state view");
      }
      this.assertActive();
      return { harness: "copilot", vendorSessionId: this.vendorSessionId, payload: taskSnapshot(request.view, value) };
    }
    const queue = this.#native.rpc.queue;
    if (typeof queue?.pendingItems !== "function") throw new Error("Copilot pending queue observation is unavailable");
    const value = await this.read("pendingMessages", "", () => queue.pendingItems());
    this.assertActive();
    if (!isObject(value) || !Array.isArray(value.items) || !Array.isArray(value.steeringMessages) ||
      value.items.some(item => !isObject(item) || typeof item.id !== "string" || !item.id || typeof item.kind !== "string" ||
        typeof item.displayText !== "string" || typeof item.agentMode !== "string" || item.messageId !== undefined && typeof item.messageId !== "string") ||
      value.steeringMessages.some(item => typeof item !== "string") || value.inFlightSteeringCount !== undefined &&
        (!Number.isInteger(value.inFlightSteeringCount) || (value.inFlightSteeringCount as number) < 0 || (value.inFlightSteeringCount as number) > value.steeringMessages.length)) {
      throw new TypeError("Unrecognized Copilot pending queue snapshot");
    }
    if (value.items.length + value.steeringMessages.length > 1_000 || jsonWireByteUpperBound(value) + 256 > NATIVE_PAYLOAD_MAX_BYTES) {
      throw new Error("Copilot pending queue exceeds the bounded native state envelope");
    }
    return { harness: "copilot", vendorSessionId: this.vendorSessionId, payload: copilotJson(value) };
  }

  private read<T>(method: string, identity: string, action: () => Promise<T>, deadlineAt?: number): Promise<T> {
    this.assertActive();
    return this.#reads.read(`${this.vendorSessionId}:${this.runtimeEpoch}:${method}`, identity, action, deadlineAt);
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
    const activityRevision = this.#bridge.activityRevision;
    try {
      return await operation();
    } catch (cause) {
      // A lost acknowledgement makes this command uncertain; it cannot undo
      // newer native evidence that the session is working, waiting, or idle.
      this.#bridge.uncertainMutation(activityRevision);
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
      return "idle";
    case "assistant.idle":
      // The main loop paused, but attached shell commands or background agents
      // may still be running; only session.idle ends the whole session's work.
      return undefined;
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
/** Older native events keep child provenance in data. parentId is the event
 * chain, so it must never be interpreted as ownership. */
function eventOwner(event: SessionEvent): string | undefined {
  const data: Record<string, unknown> = isObject(event.data) ? event.data : {};
  return [event.agentId, data.agentId, data.parentToolCallId].find((value): value is string => typeof value === "string" && value.length > 0);
}
function acknowledgedMessageId(value: unknown): string {
  if (typeof value !== "string" || !value) throw new TypeError("Copilot send returned no acknowledged message identity");
  return value;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
