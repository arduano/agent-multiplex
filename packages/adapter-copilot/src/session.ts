import { copilotConversationEvidence } from "./conversation.js";
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
  AdapterNativeStateReadError,
  CopilotAttachmentDriver,
  type CopilotSnapshotTicket,
  AdapterNativeStateValidationError,
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
import { agentsSnapshot } from "./agents.js";
import { compactionResult } from "./compaction.js";
import { copilotHistoryEventBytes, copilotImageLeaves } from "./images.js";
import { readPrimaryHistory, readSubagentHistory, type CopilotEventLogReadRequest } from "./primary-history.js";
import { COPILOT_READ_TIMEOUT_MS, CopilotReadBusyError, CopilotReadRequests } from "./reads.js";
import { CopilotNativeOperations } from "./operations.js";
import { copilotHistoryDeliveryFacts, copilotLifecycleFacts } from "./lifecycle.js";

export const COPILOT_SESSION_DISCONNECT_TIMEOUT_MS = 10_000;

const HISTORY_CURSOR_PREFIX = "copilot:event-index:";
const REVERSE_HISTORY_CURSOR_PREFIX = "copilot:event-before:";

export interface CopilotSessionRpc {
  mode: {
    get?(): Promise<unknown>;
    set(input: { mode: "interactive" | "plan" | "autopilot" }): Promise<void>;
  };
  model?: {
    getCurrent(): Promise<unknown>;
    setReasoningEffort?(input: { reasoningEffort: string }): Promise<unknown>;
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
  agent?: {
    list(input: { includeBuiltInAgents: false; includePrompt: false }): Promise<unknown>;
  };
  metadata?: {
    activity(): Promise<unknown>;
  };
  eventLog?: {
    read(input: CopilotEventLogReadRequest): Promise<unknown>;
  };
  permissions?: {
    getMode(): Promise<unknown>;
    pendingRequests?(): Promise<unknown>;
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
  /** Optional process-local correlation supplied by an embedding SDK wrapper. */
  readonly incidentTraceAttachmentId?: number;
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
  uncertain: boolean;
}

/**
 * Buffers startup events until RuntimeNodeService installs its subscriber. It also
 * turns SDK reverse callbacks into resolvable runtime-node interactions without
 * inventing a second transcript representation.
 */
export class CopilotSessionBridge {
  constructor(private readonly vendorSessionId?: string) {}
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
  #effort: string | undefined;
  #effortRevision = 0;
  #effortChangeRevision = 0;
  #effortChanged: (() => void) | undefined;
  #mode: string | undefined;
  #modeRevision = 0;
  #modeChangeRevision = 0;
  #modeChanged: (() => void) | undefined;
  #closed = false;
  #status: SessionRuntimeStatus = "idle";
  public readonly observationDriver = new CopilotAttachmentDriver();
  #awaitingResumeBoundary = false;
  #resumePositiveEvidenceObserved = false;
  #permissionMutation: ((lane: string, action: () => Promise<unknown>) => Promise<unknown>) | undefined;

  public attachPermissionMutation(run: (lane: string, action: () => Promise<unknown>) => Promise<unknown>): void {
    this.#permissionMutation = run;
  }

  /** Fresh creation observes every interaction callback from the beginning.
   * Resume cannot prove that ephemeral requests were not pruned upstream. */
  public interactionHydration(complete: boolean): void {
    // The same attachment boundary governs child callbacks: a fresh handle has
    // observed them from its beginning, while resume cannot prove that no
    // earlier child remains active. Both baselines are buffered before startup
    // callbacks by the adapter.
    this.emit({ kind: "lifecycle", fact: { type: "childrenHydrated", items: [], complete } });
    this.emit({ kind: "lifecycle", fact: { type: "interactionsHydrated", items: [], complete } });
    this.#awaitingResumeBoundary = !complete;
    this.#resumePositiveEvidenceObserved = false;
  }

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
    this.observationDriver.ingress(() => this.dispatchNativeEvent(event));
  }

  private dispatchNativeEvent(event: SessionEvent): void {
    if (event.type === "session.custom_agents_updated" && eventOwner(event) === undefined) this.observationDriver.invalidate("agents");
    if (event.type === "session.background_tasks_changed") this.observationDriver.invalidate("tasks");
    if (event.type === "pending_messages.modified") this.observationDriver.invalidate("pendingMessages");
    if (this.#awaitingResumeBoundary && (
      event.type === "permission.requested" || event.type === "user_input.requested" ||
      event.type === "elicitation.requested" || event.type === "exit_plan_mode.requested"
    )) this.#resumePositiveEvidenceObserved = true;
    this.emit({
      kind: "native",
      nativeType: event.type,
      ...(this.vendorSessionId ? { conversation: copilotConversationEvidence(copilotJson(event), this.vendorSessionId) } : {}),
      payload: copilotJson(event),
      ephemeral: event.ephemeral === true,
    });
    const lifecycleFacts = copilotLifecycleFacts(event.type, event);
    if (this.#awaitingResumeBoundary && lifecycleFacts.length > 0) {
      // Even a root idle/failure or task/queue change belongs to newer native
      // evidence. The resume certificate must not replace its observed state.
      this.#resumePositiveEvidenceObserved = true;
    }
    for (const fact of lifecycleFacts) this.emit({ kind: "lifecycle", fact });
    const resumeStatus = this.certifyColdResume(event);
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
      const data: Record<string, unknown> = isObject(event.data) ? event.data : {};
      // A model switch can reset the applied effort. Missing native data is
      // unknown, not proof that the old model's effort is still selected.
      this.observeModelSelection(data.newModel, data.reasoningEffort);
    }
    if (event.type === "session.mode_changed") {
      this.observeMode(isObject(event.data) ? event.data.newMode : undefined);
    }
    const status = event.type === "session.resume"
      ? resumeStatus
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

  /** Model and effort form one native selection snapshot. Publish them in one
   * settings event so a new model is never briefly paired with stale effort. */
  public observeModelSelection(
    model: unknown,
    effort: unknown,
    expectedModelChangeRevision?: number,
    expectedEffortChangeRevision?: number,
  ): void {
    if (this.#closed) return;
    let changed = false;
    if (expectedModelChangeRevision === undefined || expectedModelChangeRevision === this.#modelChangeRevision) {
      this.#modelChangeRevision += 1;
      this.#model = typeof model === "string" && model.length > 0 ? model : undefined;
      this.#modelRevision += 1;
      changed = true;
    }
    if (expectedEffortChangeRevision === undefined || expectedEffortChangeRevision === this.#effortChangeRevision) {
      this.#effortChangeRevision += 1;
      this.#effort = typeof effort === "string" && effort.length > 0 ? effort : undefined;
      this.#effortRevision += 1;
      changed = true;
    }
    if (changed) (this.#modelChanged ?? this.#effortChanged)?.();
  }
  public observeModelSelectionRead(model: unknown, effort: unknown, expectedModelRevision: number, expectedEffortRevision: number): void {
    if (this.#closed) return;
    let changed = false;
    if (expectedModelRevision === this.#modelRevision) {
      this.#model = typeof model === "string" && model.length > 0 ? model : undefined;
      this.#modelRevision += 1;
      changed = true;
    }
    if (expectedEffortRevision === this.#effortRevision) {
      this.#effort = typeof effort === "string" && effort.length > 0 ? effort : undefined;
      this.#effortRevision += 1;
      changed = true;
    }
    if (changed) (this.#modelChanged ?? this.#effortChanged)?.();
  }

  public attachEffort(initialEffort: string | undefined, onChanged: () => void): void {
    if (this.#effortRevision === 0) this.#effort = initialEffort;
    this.#effortChanged = onChanged;
  }
  public get effortRevision(): number { return this.#effortRevision; }
  public get effortChangeRevision(): number { return this.#effortChangeRevision; }
  public effort(): string | undefined { return this.#effort; }
  public observeEffort(value: unknown, expectedChangeRevision?: number): void {
    if (this.#closed || expectedChangeRevision !== undefined && expectedChangeRevision !== this.#effortChangeRevision) return;
    this.#effortChangeRevision += 1;
    this.updateEffort(value);
  }
  public observeEffortRead(value: unknown, expectedRevision: number): void {
    if (this.#closed || expectedRevision !== this.#effortRevision) return;
    this.updateEffort(value);
  }
  private updateEffort(value: unknown): void {
    this.#effort = typeof value === "string" && value.length > 0 ? value : undefined;
    this.#effortRevision += 1;
    this.#effortChanged?.();
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

  /** Import only the permission kind that the pinned native RPC can enumerate.
   * Other callback kinds remain deliberately unverified after resume. */
  public hydratePendingPermissions(value: unknown): void {
    if (!isObject(value) || !Array.isArray(value.items) || value.items.length > 256 ||
        jsonWireByteUpperBound(value) + 256 > NATIVE_PAYLOAD_MAX_BYTES) {
      throw new TypeError("Unrecognized Copilot pending-permission snapshot");
    }
    const items = value.items.map((item) => {
      if (!isObject(item) || typeof item.requestId !== "string" || item.requestId.length === 0 || item.requestId.length > 4_096 || !isObject(item.request)) {
        throw new TypeError("Unrecognized Copilot pending-permission snapshot");
      }
      copilotJson(item.request);
      return { requestId: item.requestId, request: item.request };
    });
    for (const item of items) {
      // The session-scoped RPC does not expose child ownership. Preserve that
      // uncertainty instead of fabricating root ownership. Concurrent
      // completion or callback replay wins through the exact-ID guards.
      this.registerPermission(item.requestId, item.request, false, undefined, true);
    }
  }

  public setStatus(status: SessionRuntimeStatus): void {
    if (this.#closed) return;
    if (this.#awaitingResumeBoundary &&
        (status === "running" || status === "waitingForInput" || status === "error" || status === "stopped")) {
      this.#resumePositiveEvidenceObserved = true;
    }
    this.observationDriver.invalidate("activity");
    if (this.#status === status) return;
    this.#status = status;
    this.emit({ kind: "status", status });
  }

  public get activityRevision(): number { return this.observationDriver.version("activity"); }
  public beginMessage(): void {
    this.setStatus(this.waitingForInput() ? "waitingForInput" : "running");
  }
  public uncertainMutation(expectedRevision: number): void {
    if (expectedRevision !== this.observationDriver.version("activity")) return;
    this.setStatus(this.waitingForInput() ? "waitingForInput" : "unknown");
  }
  public observeActivity(value: unknown, expectedRevision: number): void {
    if (this.#closed || expectedRevision !== this.observationDriver.version("activity")) return;
    if (!isObject(value) || typeof value.hasActiveWork !== "boolean") { this.activityUnavailable(expectedRevision); return; }
    this.setStatus(this.waitingForInput() ? "waitingForInput" : value.hasActiveWork ? "running" : "idle");
    this.emit({ kind: "lifecycle", fact: { type: "sessionActivityObserved", active: value.hasActiveWork } });
  }

  public activityUnavailable(expectedRevision: number): void {
    if (this.#closed || expectedRevision !== this.observationDriver.version("activity")) return;
    this.emit({ kind: "lifecycle", fact: { type: "sessionActivityUnavailable" } });
    if (!this.waitingForInput() && (this.#status === "running" || this.#status === "idle")) this.setStatus("unknown");
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
    if (this.#awaitingResumeBoundary) this.#resumePositiveEvidenceObserved = true;
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
    this.observationDriver.retire();
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

  private certifyColdResume(event: SessionEvent): SessionRuntimeStatus | undefined {
    if (event.type !== "session.resume" || eventOwner(event) !== undefined) return;
    if (!this.#awaitingResumeBoundary) {
      // A live/fresh handle can also observe another client's active resume.
      // Preserve that positive native status without granting another empty
      // baseline or allowing a false/ambiguous replay to reset existing work.
      // Earlier races prohibit only the consumed cold-resume certificate; they
      // cannot suppress newer positive activity for the lifetime of the handle.
      return event.data.continuePendingWork === true || event.data.sessionWasActive === true ? "running" : undefined;
    }
    // Consume exactly the first resume boundary for this bridge. A replayed or
    // duplicated event must never upgrade an earlier ambiguous boundary.
    this.#awaitingResumeBoundary = false;
    // The session-scoped bridge and runtime epoch fence this certificate to the
    // exact attachment. If native work, active aggregate observation, a command
    // or callback raced ahead, keep hydration partial and preserve that evidence.
    if (this.#resumePositiveEvidenceObserved || this.#pending.size > 0 || this.#permissions.size > 0) return;
    // The pinned native contract certifies a cold, non-continuing resume only
    // when both booleans are explicitly false. Omission is deliberately not
    // treated as a default: older/ambiguous producers remain fail-closed.
    if (event.data.continuePendingWork !== false || event.data.sessionWasActive !== false) {
      return event.data.continuePendingWork === true || event.data.sessionWasActive === true ? "running" : undefined;
    }
    this.emit({ kind: "lifecycle", fact: { type: "childrenHydrated", items: [], complete: true } });
    this.emit({ kind: "lifecycle", fact: { type: "interactionsHydrated", items: [], complete: true } });
    this.emit({ kind: "lifecycle", fact: { type: "coldResumeQuiescent" } });
    return "idle";
  }

  private permissionRequested(event: Extract<SessionEvent, { type: "permission.requested" }>): void {
    const { requestId, permissionRequest, resolvedByHook } = event.data;
    if (resolvedByHook || typeof requestId !== "string" || !requestId || !permissionRequest || typeof permissionRequest !== "object") return;
    if (this.#awaitingResumeBoundary) this.#resumePositiveEvidenceObserved = true;
    const owner = eventOwner(event);
    this.registerPermission(requestId, permissionRequest, owner !== undefined, owner);
  }
  private registerPermission(requestId: string, permissionRequest: object, child: boolean, owner?: string, unattributed = false): void {
    const nativeRequestId = permissionIdentity(requestId, owner);
    if (this.#permissions.has(nativeRequestId) || this.#completedPermissions.has(nativeRequestId)) return;
    const pending: PendingPermission = { requestId, nativeRequestId, child, resolving: false, completed: false, uncertain: false };
    this.#permissions.set(nativeRequestId, pending);
    if (!pending.child) this.setStatus("waitingForInput");
    this.emit({ kind: "interaction", requestType: "permission", nativeRequestId, ephemeral: false,
      ...(unattributed ? { lifecycleOwner: "unattributed" as const } : {}),
      payload: copilotJson({ permissionRequest, requestId, ...(owner === undefined ? {} : { agentId: owner }) }),
      resolve: async (response) => {
        if (this.#closed || pending.completed || this.#permissions.get(nativeRequestId) !== pending) throw new Error("Copilot permission request is no longer pending");
        if (pending.uncertain) throw new AdapterOutcomeUnknownError("Copilot permission decision remains unacknowledged; wait for native completion or recover the Host before review");
        if (pending.resolving) throw new Error("Copilot permission request is already resolving");
        const rpc = this.#permissionRpc;
        if (typeof rpc?.handlePendingPermissionRequest !== "function") throw new Error("Copilot does not support native permission decisions");
        const decision = permissionResponse(response);
        if (decision.kind === "no-result") throw new TypeError("A permission decision is required");
        pending.resolving = true;
        const activityRevision = this.observationDriver.version("activity");
        let result: unknown;
        try {
          const action = () => rpc.handlePendingPermissionRequest({ requestId, result: decision });
          result = await (this.#permissionMutation ? this.#permissionMutation(nativeRequestId, action) : action());
        } catch (cause) {
          pending.resolving = false;
          pending.uncertain = this.#permissionMutation ? cause instanceof AdapterOutcomeUnknownError : true;
          if (pending.completed) this.retirePermission(pending);
          if (!(cause instanceof AdapterOutcomeUnknownError) && this.#permissionMutation) throw cause;
          throw new AdapterOutcomeUnknownError("Copilot permission decision was dispatched but not acknowledged", { cause });
        }
        pending.resolving = false;
        if (!isObject(result) || typeof result.success !== "boolean") {
          pending.uncertain = true;
          if (pending.completed) this.retirePermission(pending);
          throw new AdapterOutcomeUnknownError("Copilot permission decision returned an unrecognized result");
        }
        if (!result.success) {
          this.retirePermission(pending);
          throw new Error("Copilot permission request was already resolved");
        }
        this.#permissions.delete(nativeRequestId);
        this.rememberCompletedPermission(nativeRequestId);
        if (!pending.child && activityRevision === this.observationDriver.version("activity")) this.setStatus(this.waitingForInput() ? "waitingForInput" : "running");
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
    const ordinal = this.observationDriver.currentNativeEventOrdinal;
    if (ordinal !== undefined) {
      // Queue byte admission continues measuring the exact preexisting envelope.
      Object.defineProperty(event, "diagnosticNativeEventOrdinal", { value: ordinal });
    }
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
  readonly #operations: CopilotNativeOperations;
  readonly #ownershipDiagnostic: ((record: CopilotOwnershipDiagnostic) => void) | undefined;
  #settings: HarnessSessionSettings;
  #stopped = false;
  #released = false;
  #stopPromise: Promise<void> | undefined;

  public constructor(options: {
    adapterScopeId: AdapterScopeId;
    cwd: string | null;
    runtimeEpoch: RuntimeEpoch;
    native: CopilotNativeSession;
    bridge: CopilotSessionBridge;
    settings: HarnessSessionSettings;
    reads?: CopilotReadRequests;
    operations?: CopilotNativeOperations;
    onOwnershipDiagnostic?(record: CopilotOwnershipDiagnostic): void;
    onStopped(): void;
  }) {
    this.adapterScopeId = options.adapterScopeId;
    this.cwd = options.cwd;
    this.runtimeEpoch = options.runtimeEpoch;
    this.#native = options.native;
    this.#bridge = options.bridge;
    this.copilotObservationDriver = options.bridge.observationDriver;
    this.#settings = options.settings;
    this.#onStopped = options.onStopped;
    this.#reads = options.reads ?? new CopilotReadRequests();
    this.#operations = options.operations ?? new CopilotNativeOperations();
    this.#ownershipDiagnostic = options.onOwnershipDiagnostic;
    this.vendorSessionId = options.native.sessionId;
    const ordinal = options.native.incidentTraceAttachmentId;
    if (typeof ordinal === "number" && Number.isSafeInteger(ordinal) && ordinal > 0) this.incidentTraceAttachmentId = ordinal;
    this.#bridge.attachModel(options.settings.model, () => this.#bridge.settings(this.settings()));
    this.#bridge.attachEffort(options.settings.effort ?? undefined, () => this.#bridge.settings(this.settings()));
    this.#bridge.attachMode(options.settings.mode, () => this.#bridge.settings(this.settings()));
    this.#bridge.attachPermissions(this.#native.rpc.permissions, () => this.#bridge.settings(this.settings()));
    this.#bridge.attachPermissionMutation((lane, action) => this.#operations.run(this.operationGroup(), `permission:${lane}`, action,
      outcome => this.ownershipDiagnostic(outcome, "mutation")));
  }

  public readonly adapterScopeId: AdapterScopeId;
  public readonly vendorSessionId: string;
  public readonly cwd: string | null;
  public readonly runtimeEpoch: RuntimeEpoch;
  public readonly incidentTraceAttachmentId?: number;
  public readonly copilotObservationDriver: CopilotAttachmentDriver;

  public status(): SessionRuntimeStatus {
    return this.#bridge.status();
  }

  public settings(): HarnessSessionSettings {
    const copilotPermissions = this.#bridge.permissionMode();
    const model = this.#bridge.model();
    const effort = this.#bridge.effort();
    const mode = this.#bridge.mode();
    const settings = { ...this.#settings };
    delete settings.copilotPermissions;
    delete settings.model;
    delete settings.effort;
    delete settings.mode;
    return { ...settings, ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }), ...(mode === undefined ? {} : { mode }), ...(copilotPermissions === undefined ? {} : { copilotPermissions }) };
  }

  /** Read the native selection on every attachment, including a resume with no
   * model argument. An absent modelId is unknown, not an inferred auto/default. */
  public async readModel(): Promise<void> {
    const read = this.#native.rpc.model?.getCurrent;
    if (typeof read !== "function") return;
    const generation = this.#bridge.modelRevision;
    const effortGeneration = this.#bridge.effortRevision;
    try {
      const result = await this.read("model", String(generation), () => read.call(this.#native.rpc.model));
      this.#bridge.observeModelSelectionRead(isObject(result) ? result.modelId : undefined,
        isObject(result) ? result.reasoningEffort : undefined, generation, effortGeneration);
    } catch (error) {
      if (!(error instanceof CopilotReadBusyError)) {
        this.#bridge.observeModelSelectionRead(undefined, undefined, generation, effortGeneration);
      }
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
      // A younger busy lane has not made an observation about this revision.
      // Once its original deadline expires, repeated polling cannot silently
      // preserve healthy Working forever. Retain the lane until native
      // settlement, but expose bounded uncertainty for the current revision.
      if (!(error instanceof CopilotReadBusyError) || error.stalled) this.#bridge.activityUnavailable(revision);
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

  /** Resume-only reconciliation for the one ephemeral interaction kind the
   * pinned CLI can enumerate. Failure leaves interaction hydration partial. */
  public async readPendingPermissions(): Promise<void> {
    const read = this.#native.rpc.permissions?.pendingRequests;
    if (typeof read !== "function") return;
    try {
      const result = await this.read("pendingPermissions", "", () => read.call(this.#native.rpc.permissions));
      this.#bridge.hydratePendingPermissions(result);
    } catch {
      // An absent, failed, stale or malformed snapshot cannot prove emptiness.
      // The resume baseline remains partial and live positive callbacks still win.
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
        this.#operations.assertAvailable(this.operationGroup(), "command");
        this.#bridge.beginMessage();
        const messageId = await this.mutation("enqueue Copilot prompt", async () => acknowledgedMessageId(await this.#native.send(options)));
        return { messageId };
      }
      case "steer": {
        const options = messageOptions(command.prompt, command.native, "immediate");
        this.#operations.assertAvailable(this.operationGroup(), "command");
        this.#bridge.beginMessage();
        const messageId = await this.mutation("steer Copilot session", async () => acknowledgedMessageId(await this.#native.send(options)));
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
        const effortGeneration = this.#bridge.effortChangeRevision;
        try {
          await this.mutation("change Copilot model", () => this.#native.setModel(command.model));
        } catch (error) {
          if (!(error instanceof AdapterOutcomeUnknownError)) throw error;
          // A failed RPC can leave the native result uncertain. Neither the
          // previous model nor its effort is a confirmed current selection.
          this.#bridge.observeModelSelection(undefined, undefined, generation, effortGeneration);
          throw error;
        }
        // Native model changes can reset effort. If no event supplied the new
        // value, withhold the old model's effort until a native read confirms it.
        this.#bridge.observeModelSelection(command.model, undefined, generation, effortGeneration);
        return { model: command.model };
      }
      case "setEffort": {
        const set = this.#native.rpc.model?.setReasoningEffort;
        if (typeof set !== "function") throw new Error("Copilot reasoning selection is unavailable on this native session");
        const generation = this.#bridge.effortChangeRevision;
        let applied: unknown;
        try {
          applied = await this.mutation("change Copilot reasoning effort", () => set.call(this.#native.rpc.model, { reasoningEffort: command.effort }));
        } catch (error) {
          if (!(error instanceof AdapterOutcomeUnknownError)) throw error;
          this.#bridge.observeEffort(undefined, generation);
          throw error;
        }
        if (!isObject(applied) || applied.reasoningEffort !== command.effort) {
          this.#bridge.observeEffort(undefined, generation);
          throw new TypeError("Copilot did not confirm the requested reasoning effort");
        }
        this.#bridge.observeEffort(applied.reasoningEffort, generation);
        return { effort: applied.reasoningEffort };
      }
      case "setMode": {
        const revision = this.#bridge.modeChangeRevision;
        try {
          await this.mutation("change Copilot mode", () =>
            this.#native.rpc.mode.set({ mode: command.mode }),
          );
        } catch (error) {
          if (!(error instanceof AdapterOutcomeUnknownError)) throw error;
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
          if (!(error instanceof AdapterOutcomeUnknownError)) throw error;
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
    if (request.native?.view === "primary" || request.native?.view === "subagent") {
      const eventLog = this.#native.rpc.eventLog;
      if (typeof eventLog?.read !== "function") throw new Error(`Copilot ${request.native.view === "primary" ? "primary" : "subagent"} history is unavailable on this native session`);
      const deadlineAt = Date.now() + COPILOT_READ_TIMEOUT_MS;
      const readScoped = request.native.view === "subagent" ? readSubagentHistory : readPrimaryHistory;
      const result = await readScoped(this.vendorSessionId, request, async input => {
        const lane = input.agentIds ? `subagentHistory:${input.agentIds[0]}` : "primaryHistory";
        const result = await this.read(lane, JSON.stringify(input), () => eventLog.read(input), deadlineAt);
        this.assertActive();
        return result;
      });
      return { ...result, conversation: copilotConversationEvidence(result.payload, this.vendorSessionId, {
        history: true, ...(result.sortDirection ? { sortDirection: result.sortDirection } : {}), view: request.native.view === "primary" ? "primary" : "child",
      }) };
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
    const messageDeliveryFacts = copilotHistoryDeliveryFacts(payload);
    return {
      harness: "copilot",
      vendorSessionId: this.vendorSessionId,
      payload, sortDirection,
      conversation: copilotConversationEvidence(payload, this.vendorSessionId, { history: true, sortDirection, view: "all" }),
      ...(complete ? {} : { nextCursor: `${descending ? REVERSE_HISTORY_CURSOR_PREFIX : HISTORY_CURSOR_PREFIX}${position}` }),
      complete,
      ...(messageDeliveryFacts.length ? { messageDeliveryFacts } : {}),
    };
  }

  public async readNativeState(request: NativeStateRequest): Promise<AdapterNativeStateResult> {
    this.assertActive();
    if (request.harness !== "copilot") throw new TypeError("Unsupported Copilot native state view");
    if (request.view === "agents") {
      const agent = this.#native.rpc.agent;
      if (typeof agent?.list !== "function") throw new AdapterNativeStateReadError("nativeReadUnavailable", "Copilot agent registry observation is unavailable");
      const ticket = this.copilotObservationDriver.capture("agents");
      try {
        const value = await this.read("agents", String(ticket.version), () => agent.list({ includeBuiltInAgents: false, includePrompt: false }));
        this.assertActive();
        return this.copilotObservationDriver.certify(ticket,
          { harness: "copilot", vendorSessionId: this.vendorSessionId, payload: agentsSnapshot(value) });
      } catch (error) { this.copilotObservationDriver.rethrow(ticket, error); }
    }
    if (request.view !== "pendingMessages") {
      const tasks = this.#native.rpc.tasks;
      let value: unknown;
      let ticket: CopilotSnapshotTicket | undefined;
      switch (request.view) {
        case "tasks": {
          if (typeof tasks?.list !== "function" || typeof tasks.refresh !== "function") throw new AdapterNativeStateReadError("nativeReadUnavailable", "Copilot task observation is unavailable");
          const deadlineAt = Date.now() + COPILOT_READ_TIMEOUT_MS;
          const observation = await this.read("tasks", String(this.copilotObservationDriver.version("tasks")), async () => {
            await tasks.refresh();
            this.assertActive();
            if (Date.now() >= deadlineAt) throw new AdapterNativeStateReadError("nativeReadTimedOut", "Copilot task observation timed out before listing refreshed tasks");
            const captured = this.copilotObservationDriver.capture("tasks");
            try { return { ticket: captured, payload: await tasks.list() }; }
            catch (error) { this.copilotObservationDriver.rethrow(captured, error); }
          }, deadlineAt);
          ticket = observation.ticket;
          value = observation.payload;
          break;
        }
        case "taskProgress":
          if (typeof tasks?.getProgress !== "function") throw new AdapterNativeStateReadError("nativeReadUnavailable", "Copilot task progress is unavailable");
          taskId(request.id);
          value = await this.read("taskProgress", request.id, () => tasks.getProgress({ id: request.id }));
          break;
        case "currentPromotableTask":
          if (typeof tasks?.getCurrentPromotable !== "function") throw new AdapterNativeStateReadError("nativeReadUnavailable", "Copilot promotable task observation is unavailable");
          value = await this.read("currentPromotableTask", "", () => tasks.getCurrentPromotable());
          break;
        default: throw new TypeError("Unsupported Copilot native state view");
      }
      this.assertActive();
      try {
        const result = { harness: "copilot" as const, vendorSessionId: this.vendorSessionId, payload: taskSnapshot(request.view, value) };
        return ticket ? this.copilotObservationDriver.certify(ticket, result) : result;
      } catch (error) {
        if (ticket) this.copilotObservationDriver.rethrow(ticket, error);
        throw error;
      }
    }
    const queue = this.#native.rpc.queue;
    if (typeof queue?.pendingItems !== "function") throw new AdapterNativeStateReadError("nativeReadUnavailable", "Copilot pending queue observation is unavailable");
    const ticket = this.copilotObservationDriver.capture("pendingMessages");
    try {
      const value = await this.read("pendingMessages", String(ticket.version), () => queue.pendingItems());
      this.assertActive();
      if (!isObject(value) || !Array.isArray(value.items) || !Array.isArray(value.steeringMessages) ||
        value.items.some(item => !isObject(item) || typeof item.id !== "string" || !item.id || typeof item.kind !== "string" ||
          typeof item.displayText !== "string" || typeof item.agentMode !== "string" || item.messageId !== undefined && typeof item.messageId !== "string") ||
        value.steeringMessages.some(item => typeof item !== "string") || value.inFlightSteeringCount !== undefined &&
          (!Number.isInteger(value.inFlightSteeringCount) || (value.inFlightSteeringCount as number) < 0 || (value.inFlightSteeringCount as number) > value.steeringMessages.length)) {
        throw new AdapterNativeStateValidationError("snapshotMalformed");
      }
      let wireBytes: number;
      try { wireBytes = jsonWireByteUpperBound(value); }
      catch { throw new AdapterNativeStateValidationError("snapshotWireInvalid"); }
      if (value.items.length + value.steeringMessages.length > 1_000 || wireBytes + 256 > NATIVE_PAYLOAD_MAX_BYTES) {
        throw new AdapterNativeStateValidationError("snapshotTooLarge");
      }
      return this.copilotObservationDriver.certify(ticket,
        { harness: "copilot", vendorSessionId: this.vendorSessionId, payload: copilotJson(value) });
    } catch (error) { this.copilotObservationDriver.rethrow(ticket, error); }
  }

  private read<T>(method: string, identity: string, action: () => Promise<T>, deadlineAt?: number): Promise<T> {
    this.assertActive();
    return this.#reads.read(`${this.vendorSessionId}:${this.runtimeEpoch}:${method}`, identity, action, deadlineAt);
  }

  public stop(): Promise<void> {
    if (this.#released) return Promise.resolve();
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopped = true;
    this.#bridge.setStatus("stopped");
    this.#bridge.close();
    this.ownershipDiagnostic("dispatched");
    this.#stopPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (cause: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ownershipDiagnostic(cause instanceof Error && cause.message.startsWith("Copilot native disconnect timed out") ? "timedOut" : "unacknowledged");
        reject(new AdapterOutcomeUnknownError(
          `Copilot session ${this.vendorSessionId} may not have disconnected cleanly`, { cause },
        ));
      };
      const timer = setTimeout(() => fail(new Error("Copilot native disconnect timed out; native ownership remains pending")), COPILOT_SESSION_DISCONNECT_TIMEOUT_MS);
      timer.unref?.();
      // Caller deadlines do not cancel disconnect or release native ownership.
      // A late acknowledgement releases the fence without rewriting the first
      // unknown receipt. Repeated Stop cannot create another disconnect request.
      void Promise.resolve().then(() => this.#native.disconnect()).then(async () => {
        // Disconnect does not cancel an admitted SDK mutation. Retain this
        // exact native-ID owner until both requests have settled; shutdown
        // can instead prove whole-CLI termination before retrying.
        await this.#operations.drain(this.operationGroup());
        this.#released = true;
        this.#onStopped();
        this.ownershipDiagnostic(settled ? "lateAcknowledged" : "acknowledged");
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      }, fail);
    });
    return this.#stopPromise;
  }

  private ownershipDiagnostic(outcome: CopilotOwnershipDiagnostic["outcome"], stage: "detach" | "mutation" = "detach"): void {
    try { this.#ownershipDiagnostic?.({ vendorSessionId: this.vendorSessionId, runtimeEpoch: this.runtimeEpoch,
      ...(this.incidentTraceAttachmentId === undefined ? {} : { attachmentId: this.incidentTraceAttachmentId }), stage, outcome }); }
    catch { /* A private diagnostic sink cannot alter native ownership. */ }
  }

  private assertActive(): void {
    if (this.#stopped) throw new AdapterNativeStateReadError("nativeOwnerRetired", `Copilot session ${this.vendorSessionId} is stopped`);
  }

  private async mutation<T>(description: string, operation: () => Promise<T>): Promise<T> {
    const activityRevision = this.#bridge.activityRevision;
    try {
      return await this.#operations.run(this.operationGroup(), "command", operation, outcome => this.ownershipDiagnostic(outcome, "mutation"));
    } catch (cause) {
      if (!(cause instanceof AdapterOutcomeUnknownError)) throw cause;
      // A lost acknowledgement makes this command uncertain; it cannot undo
      // newer native evidence that the session is working, waiting, or idle.
      this.#bridge.uncertainMutation(activityRevision);
      throw new AdapterOutcomeUnknownError(
        `${description} failed after dispatch; native outcome is unknown`,
        { cause },
      );
    }
  }

  private operationGroup(): string { return JSON.stringify([this.vendorSessionId, this.runtimeEpoch]); }
}

/** Private process-local ownership stage trace. Never native payload or config. */
export interface CopilotOwnershipDiagnostic {
  vendorSessionId?: string;
  runtimeEpoch?: RuntimeEpoch;
  attachmentId?: number;
  stage: "startup" | "attachment" | "attachmentMode" | "mutation" | "detach" | "shutdown";
  outcome: "dispatched" | "acknowledged" | "lateAcknowledged" | "timedOut" | "unacknowledged" | "retired" | "closed";
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
