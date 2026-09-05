import type { AdapterNativeHistoryResult } from "@arduano/agent-multiplex-runtime-node-core";
import {
  adapterScopeIdSchema,
  newRuntimeEpoch,
  NATIVE_PAYLOAD_MAX_BYTES,
  toJsonValue,
  type AdapterScopeId,
  type HarnessCatalogEntry,
  type HarnessCommand,
  type HarnessResumeOptions,
  type HarnessSessionSettings,
  type HarnessSpawnOptions,
  type JsonValue,
  type NativeHistoryRequest,
  type NativeInventoryItem,
  type NativeModel,
  type RuntimeEpoch,
  type SessionRuntimeStatus,
} from "@arduano/agent-multiplex-protocol";
import {
  AdapterOutcomeUnknownError,
  type AdapterEvent,
  type AdapterSession,
  type AgentAdapter,
} from "@arduano/agent-multiplex-runtime-node-core";

import type { Model } from "./generated/v2/Model.js";
import type { ModelListResponse } from "./generated/v2/ModelListResponse.js";
import type { Thread } from "./generated/v2/Thread.js";
import { codexImageCodec, codexHistoryPageBytes, codexImageLeaves } from "./images.js";
import type { ThreadBackgroundTerminal } from "./generated/v2/ThreadBackgroundTerminal.js";
import type { ThreadBackgroundTerminalsListResponse } from "./generated/v2/ThreadBackgroundTerminalsListResponse.js";
import type { ThreadListResponse } from "./generated/v2/ThreadListResponse.js";
import type { ThreadReadResponse } from "./generated/v2/ThreadReadResponse.js";
import type { ThreadItemsListResponse } from "./generated/v2/ThreadItemsListResponse.js";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse.js";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.js";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.js";
import type { TurnSteerResponse } from "./generated/v2/TurnSteerResponse.js";
import type { UserInput } from "./generated/v2/UserInput.js";
import {
  CodexRpcClient,
  type CodexNotification,
  type CodexRpcClientOptions,
  type CodexServerRequest,
} from "./rpc.js";

const CODEX_VERSION = "0.152.0";

const json = (value: unknown): JsonValue =>
  toJsonValue(JSON.parse(JSON.stringify(value)) as unknown);

const threadIdFrom = (params: JsonValue): string | undefined => {
  if (!params || Array.isArray(params) || typeof params !== "object") return undefined;
  const direct = params.threadId;
  if (typeof direct === "string") return direct;
  const thread = params.thread;
  if (thread && !Array.isArray(thread) && typeof thread === "object" && typeof thread.id === "string") {
    return thread.id;
  }
  return undefined;
};

const statusOf = (thread: Thread): SessionRuntimeStatus => {
  switch (thread.status.type) {
    case "notLoaded":
      return "stopped";
    case "idle":
      return "idle";
    case "systemError":
      return "error";
    case "active":
      return "running";
  }
};

const isEphemeral = (method: string): boolean =>
  method.endsWith("/delta") ||
  method.endsWith("/outputDelta") ||
  method.includes("/progress") ||
  method.includes("tokenUsage");

const interactionType = (
  method: string,
): "approval" | "permission" | "userInput" | "elicitation" | "other" => {
  if (method.includes("permissions")) return "permission";
  if (method.includes("requestUserInput")) return "userInput";
  if (method.includes("elicitation")) return "elicitation";
  if (method.includes("Approval") || method.includes("approval")) return "approval";
  return "other";
};

const inputsFrom = (input: string | JsonValue[]): UserInput[] => {
  if (typeof input === "string") return [{ type: "text", text: input, text_elements: [] }];
  return input as UserInput[];
};

const recordOf = (value: unknown): Record<string, JsonValue> | undefined =>
  value !== null && !Array.isArray(value) && typeof value === "object"
    ? value as Record<string, JsonValue>
    : undefined;

const validateInteractionResponse = (method: string, response: JsonValue): void => {
  const record = recordOf(response);
  if (!record) throw new TypeError(`${method} response must be a JSON object`);
  if (method === "item/tool/requestUserInput") {
    const answers = recordOf(record.answers);
    if (!answers) throw new TypeError("requestUserInput response requires an answers object");
    for (const [questionId, raw] of Object.entries(answers)) {
      const answer = recordOf(raw);
      if (
        !questionId ||
        !answer ||
        !Array.isArray(answer.answers) ||
        !answer.answers.every((value) => typeof value === "string")
      ) {
        throw new TypeError(
          "requestUserInput answers must map question ids to { answers: string[] }",
        );
      }
    }
    return;
  }
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "execCommandApproval" ||
    method === "applyPatchApproval"
  ) {
    if (record.decision === undefined) {
      throw new TypeError(`${method} response requires a decision`);
    }
  }
};

interface SessionState {
  thread: Thread;
  runtimeEpoch: RuntimeEpoch;
  currentTurnId: string | undefined;
  model: string;
  effort: string | null;
  collaborationMode: JsonValue | null;
  status: SessionRuntimeStatus;
  listeners: Set<(event: AdapterEvent) => void>;
}

interface InitialThreadSettings {
  model: string;
  effort: string | null;
}

type EarlyCodexItem =
  | { kind: "notification"; notification: CodexNotification }
  | {
      kind: "request";
      request: CodexServerRequest;
      timeout?: ReturnType<typeof setTimeout>;
    };

const EARLY_THREAD_LIMIT = 64;
const EARLY_ITEM_LIMIT = 512;
const EARLY_REQUEST_TIMEOUT_MS = 30_000;

export interface CodexAdapterOptions extends CodexRpcClientOptions {
  adapterScopeId?: string;
  rpcClient?: CodexRpcClient;
  /** Bundle-owned native runtime cleanup, used by createCodexRuntime. */
  closeRuntime?: () => Promise<void>;
}

export class CodexAdapter implements AgentAdapter {
  public readonly imageCodec = codexImageCodec;
  public readonly harness = "codex" as const;
  public readonly adapterScopeId: AdapterScopeId;
  readonly #rpc: CodexRpcClient;
  readonly #sessions = new Map<string, CodexSession>();
  /** Native descendant thread id -> attached logical root thread id. */
  readonly #childOwners = new Map<string, string>();
  readonly #early = new Map<string, EarlyCodexItem[]>();
  readonly #unsubscribeNotification: () => void;
  readonly #unsubscribeRequest: () => void;
  readonly #unsubscribeExit: () => void;
  readonly #closeRuntime: (() => Promise<void>) | undefined;

  public constructor(options: CodexAdapterOptions = {}) {
    this.adapterScopeId = adapterScopeIdSchema.parse(options.adapterScopeId ?? "codex:default");
    this.#rpc = options.rpcClient ?? new CodexRpcClient(options);
    this.#closeRuntime = options.closeRuntime;
    this.#unsubscribeNotification = this.#rpc.onNotification((event) => this.#onNotification(event));
    this.#unsubscribeRequest = this.#rpc.onServerRequest((event) => this.#onServerRequest(event));
    this.#unsubscribeExit = this.#rpc.onExit((error) => {
      for (const session of this.#sessions.values()) session.runtimeExited(error);
      this.#sessions.clear();
      this.#childOwners.clear();
    });
  }

  public async describe(): Promise<HarnessCatalogEntry> {
    try {
      await this.#rpc.start();
      return {
        harness: "codex",
        adapterScopeId: this.adapterScopeId,
        available: true,
        version: CODEX_VERSION,
        runtimeVersion: CODEX_VERSION,
        capabilities: [
          { name: "thread.start", version: "v2", experimental: false },
          { name: "thread.resume", version: "v2", experimental: false },
          { name: "thread.loaded.list", version: "v2", experimental: false },
          { name: "thread.read-native-history", version: "v2", experimental: false },
          { name: "turn.steer", version: "v2", experimental: false },
          { name: "turn.interrupt", version: "v2", experimental: false },
          { name: "turn.settings.update", version: "v2", experimental: true },
          { name: "models.list", version: "v2", experimental: false },
          { name: "models.switch", version: "v2", experimental: false },
          { name: "reasoning-effort.switch", version: "v2", experimental: false },
          { name: "collaboration-mode", version: "v2", experimental: true },
          { name: "interactive-requests", version: "v2", experimental: false },
          { name: "turn.plan-stream", version: "v2", experimental: false },
          { name: "command.visibility", version: "v2", experimental: false },
          { name: "subagent.visibility", version: "v2", experimental: false },
          { name: "subagent.descendant-stream", version: "v2", experimental: false },
          { name: "background-terminals", version: "v2", experimental: true },
        ],
      };
    } catch (error) {
      return {
        harness: "codex",
        adapterScopeId: this.adapterScopeId,
        available: false,
        version: CODEX_VERSION,
        capabilities: [],
        unavailableReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public async listModels(): Promise<NativeModel[]> {
    const models: Model[] = [];
    let cursor: string | null = null;
    do {
      const page: ModelListResponse = await this.#rpc.request<ModelListResponse>("model/list", {
        cursor,
        limit: 100,
        includeHidden: true,
      });
      models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return models.map((model) => ({
      harness: "codex",
      id: model.model,
      name: model.displayName,
      description: model.description,
      native: json(model),
    }));
  }

  public async listSessions(): Promise<NativeInventoryItem[]> {
    const threads: Thread[] = [];
    let cursor: string | null = null;
    do {
      const page: ThreadListResponse = await this.#rpc.request<ThreadListResponse>("thread/list", {
        cursor,
        limit: 100,
        archived: false,
        useStateDbOnly: true,
      });
      threads.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return threads.map((thread) => {
      const attached = this.#sessions.get(thread.id);
      const harnessSettings = attached?.settings();
      return {
        harness: "codex",
        adapterScopeId: this.adapterScopeId,
        vendorSessionId: thread.id,
        cwd: thread.cwd,
        // Codex keeps an unsubscribed thread loaded for an inactivity grace
        // period. `thread/loaded/list` therefore describes app-server memory,
        // not whether this adapter still owns an interactive handle. Only a
        // locally attached CodexSession is commandable through Multiplex.
        availability: attached ? "active" : "resumable",
        runtimeStatus: attached?.status() ?? "stopped",
        runtimeEpoch: attached?.runtimeEpoch ?? null,
        ...(harnessSettings === undefined ? {} : { harnessSettings }),
        nativeSummary: json(thread),
        lastActivityAt: new Date(thread.updatedAt * 1_000).toISOString(),
      };
    });
  }

  public async spawn(options: HarnessSpawnOptions): Promise<AdapterSession> {
    if (options.harness !== "codex") throw new Error("CodexAdapter received non-Codex options");
    const native = options.native ?? {};
    const response = await this.#rpc.request<ThreadStartResponse>("thread/start", {
      ...native,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      ...(options.personality ? { personality: options.personality } : {}),
    });
    // Register before applying follow-up settings so notifications and reverse
    // requests emitted in that interval have an owner and are buffered until
    // RuntimeNodeService installs its logical-session subscriber.
    const session = this.#register(response.thread, {
      model: response.model,
      effort: response.reasoningEffort,
    });
    if (options.effort !== undefined || options.collaborationMode !== undefined) {
      try {
        await this.#rpc.request("thread/settings/update", {
          threadId: response.thread.id,
          ...(options.effort !== undefined ? { effort: options.effort } : {}),
          ...(options.collaborationMode !== undefined
            ? { collaborationMode: options.collaborationMode }
            : {}),
        });
        // The settings notification is asynchronous relative to the RPC
        // acknowledgement. Commit the acknowledged settings locally before
        // returning so an immediate command cannot rebuild collaboration-mode
        // settings from the thread/start defaults.
        session.updateInitialSettings({
          model: response.model,
          effort: options.effort ?? response.reasoningEffort,
        });
        if (options.collaborationMode !== undefined) {
          session.updateInitialCollaborationMode(options.collaborationMode);
        }
      } catch (cause) {
        throw new AdapterOutcomeUnknownError(
          `Codex thread ${response.thread.id} was created but its requested settings were not acknowledged`,
          { cause },
        );
      }
    }
    return session;
  }

  public async resume(options: HarnessResumeOptions): Promise<AdapterSession> {
    if (options.harness !== "codex") throw new Error("CodexAdapter received non-Codex options");
    const existing = this.#sessions.get(options.vendorSessionId);
    if (existing) return existing;
    const native = options.native ?? {};
    const response = await this.#rpc.request<ThreadResumeResponse>("thread/resume", {
      ...native,
      threadId: options.vendorSessionId,
      excludeTurns: true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      ...(options.personality ? { personality: options.personality } : {}),
    });
    const session = this.#register(response.thread, {
      model: response.model,
      effort: response.reasoningEffort,
    });
    if (options.effort !== undefined || options.collaborationMode !== undefined) {
      try {
        await this.#rpc.request("thread/settings/update", {
          threadId: response.thread.id,
          ...(options.effort !== undefined ? { effort: options.effort } : {}),
          ...(options.collaborationMode !== undefined
            ? { collaborationMode: options.collaborationMode }
            : {}),
        });
        session.updateInitialSettings({
          model: response.model,
          effort: options.effort ?? response.reasoningEffort,
        });
        if (options.collaborationMode !== undefined) {
          session.updateInitialCollaborationMode(options.collaborationMode);
        }
      } catch (cause) {
        throw new AdapterOutcomeUnknownError(
          `Codex thread ${response.thread.id} was resumed but its requested settings were not acknowledged`,
          { cause },
        );
      }
    }
    return session;
  }

  public async close(): Promise<void> {
    this.#unsubscribeNotification();
    this.#unsubscribeRequest();
    this.#unsubscribeExit();
    for (const session of this.#sessions.values()) session.closed();
    this.#sessions.clear();
    this.#childOwners.clear();
    this.#rejectEarly("Codex adapter closed before a session binding was attached");
    await this.#rpc.close();
    await this.#closeRuntime?.();
  }

  #register(thread: Thread, settings?: InitialThreadSettings): CodexSession {
    const existing = this.#sessions.get(thread.id);
    if (existing) {
      if (settings) existing.updateInitialSettings(settings);
      this.#drainEarly(thread.id, existing);
      return existing;
    }
    const session = new CodexSession(this.#rpc, this.adapterScopeId, thread, settings, () => {
      this.#sessions.delete(thread.id);
      for (const [childId, ownerId] of this.#childOwners) {
        if (ownerId === thread.id) this.#childOwners.delete(childId);
      }
    });
    this.#sessions.set(thread.id, session);
    this.#drainEarly(thread.id, session);
    return session;
  }

  #onNotification(notification: CodexNotification): void {
    const threadId = threadIdFrom(notification.params);
    if (!threadId) return;
    if (notification.method === "thread/started") {
      const params = recordOf(notification.params);
      const thread = recordOf(params?.thread);
      const parentThreadId = thread?.parentThreadId;
      if (typeof parentThreadId === "string") {
        const ownerId = this.#sessions.has(parentThreadId)
          ? parentThreadId
          : this.#childOwners.get(parentThreadId);
        if (ownerId) this.#childOwners.set(threadId, ownerId);
      }
    }
    const params = recordOf(notification.params);
    const item = recordOf(params?.item);
    const ownerIdForThread = this.#sessions.has(threadId)
      ? threadId
      : this.#childOwners.get(threadId);
    if (ownerIdForThread && item) {
      const descendants = new Set<string>();
      if (item.type === "subAgentActivity" && typeof item.agentThreadId === "string") {
        descendants.add(item.agentThreadId);
      }
      if (item.type === "collabAgentToolCall" && Array.isArray(item.receiverThreadIds)) {
        for (const childId of item.receiverThreadIds) {
          if (typeof childId === "string") descendants.add(childId);
        }
      }
      const owner = this.#sessions.get(ownerIdForThread);
      for (const childId of descendants) {
        this.#childOwners.set(childId, ownerIdForThread);
        // Some Codex versions announce descendants with subAgentActivity
        // rather than thread/started. Replay anything that arrived just ahead
        // of the activity item into the root logical Multiplex stream.
        if (owner) this.#drainEarly(childId, owner);
      }
    }
    const ownerId = this.#childOwners.get(threadId);
    const session = this.#sessions.get(threadId) ?? (ownerId ? this.#sessions.get(ownerId) : undefined);
    if (session) session.notification(notification);
    else this.#bufferEarly(threadId, { kind: "notification", notification });
    if (
      notification.method === "thread/closed" ||
      notification.method === "thread/deleted"
    ) {
      this.#childOwners.delete(threadId);
    }
  }

  #onServerRequest(request: CodexServerRequest): void {
    const threadId = threadIdFrom(request.params);
    const ownerId = threadId ? this.#childOwners.get(threadId) : undefined;
    const session = threadId
      ? this.#sessions.get(threadId) ?? (ownerId ? this.#sessions.get(ownerId) : undefined)
      : undefined;
    if (!session) {
      if (threadId) {
        const item: EarlyCodexItem = { kind: "request", request };
        item.timeout = setTimeout(() => {
          if (!this.#removeEarly(threadId, item)) return;
          request.reject(-32000, "No Agent Multiplex binding attached before the request timeout");
        }, EARLY_REQUEST_TIMEOUT_MS);
        item.timeout.unref();
        this.#bufferEarly(threadId, item);
      } else {
        request.reject(-32000, "No active Agent Multiplex binding owns this Codex request");
      }
      return;
    }
    session.serverRequest(request);
  }

  #bufferEarly(threadId: string, item: EarlyCodexItem): void {
    let queue = this.#early.get(threadId);
    if (!queue) {
      if (this.#early.size >= EARLY_THREAD_LIMIT) {
        const oldestThread = this.#early.keys().next().value as string | undefined;
        if (oldestThread) this.#discardEarlyThread(oldestThread, "early-event buffer was full");
      }
      queue = [];
      this.#early.set(threadId, queue);
    }
    if (queue.length >= EARLY_ITEM_LIMIT) {
      const oldest = queue.shift();
      if (oldest) this.#disposeEarly(oldest, "early-event buffer was full");
    }
    queue.push(item);
  }

  #drainEarly(threadId: string, session: CodexSession): void {
    const queue = this.#early.get(threadId);
    if (!queue) return;
    this.#early.delete(threadId);
    for (const item of queue) {
      if (item.kind === "notification") session.notification(item.notification);
      else {
        if (item.timeout) clearTimeout(item.timeout);
        session.serverRequest(item.request);
      }
    }
  }

  #removeEarly(threadId: string, wanted: EarlyCodexItem): boolean {
    const queue = this.#early.get(threadId);
    if (!queue) return false;
    const index = queue.indexOf(wanted);
    if (index < 0) return false;
    queue.splice(index, 1);
    if (queue.length === 0) this.#early.delete(threadId);
    return true;
  }

  #discardEarlyThread(threadId: string, reason: string): void {
    const queue = this.#early.get(threadId);
    if (!queue) return;
    this.#early.delete(threadId);
    for (const item of queue) this.#disposeEarly(item, reason);
  }

  #disposeEarly(item: EarlyCodexItem, reason: string): void {
    if (item.kind !== "request") return;
    if (item.timeout) clearTimeout(item.timeout);
    item.request.reject(-32000, `No Agent Multiplex binding owns this Codex request: ${reason}`);
  }

  #rejectEarly(reason: string): void {
    for (const threadId of [...this.#early.keys()]) {
      this.#discardEarlyThread(threadId, reason);
    }
  }
}

class CodexSession implements AdapterSession {
  public readonly harness = "codex" as const;
  public readonly runtimeEpoch = newRuntimeEpoch();
  readonly #rpc: CodexRpcClient;
  readonly #state: SessionState;
  readonly #onStop: () => void;
  readonly #buffer: AdapterEvent[] = [];
  readonly #pendingRequests = new Map<
    string,
    { blocking: boolean; expiresAt?: string; turnId?: string }
  >();
  /** Root command items keyed by turn, used to stop only interrupted-turn terminals. */
  readonly #commandItemsByTurn = new Map<string, Set<string>>();
  /** Count of turn/start requests sent but not yet acknowledged. */
  #turnStartsInFlight = 0;
  /** Root turns whose completion arrived before their turn/start continuation. */
  readonly #completedTurnIds = new Set<string>();

  public constructor(
    rpc: CodexRpcClient,
    public readonly adapterScopeId: AdapterScopeId,
    thread: Thread,
    settings: InitialThreadSettings | undefined,
    onStop: () => void,
  ) {
    this.#rpc = rpc;
    this.#state = {
      thread,
      runtimeEpoch: this.runtimeEpoch,
      currentTurnId: undefined,
      model: settings?.model ?? "",
      effort: settings?.effort ?? null,
      collaborationMode: null,
      status: statusOf(thread),
      listeners: new Set(),
    };
    this.#onStop = onStop;
  }

  public get vendorSessionId(): string {
    return this.#state.thread.id;
  }

  public get cwd(): string | null {
    return this.#state.thread.cwd;
  }

  public updateInitialSettings(settings: InitialThreadSettings): void {
    this.#state.model = settings.model;
    this.#state.effort = settings.effort;
  }

  /** Commits a collaboration mode acknowledged during spawn/resume setup. */
  public updateInitialCollaborationMode(collaborationMode: JsonValue): void {
    this.#state.collaborationMode = collaborationMode;
  }

  public status(): SessionRuntimeStatus {
    return this.#state.status;
  }

  public settings(): HarnessSessionSettings {
    const collaborationMode = recordOf(this.#state.collaborationMode);
    const mode = typeof collaborationMode?.mode === "string"
      ? collaborationMode.mode
      : typeof this.#state.collaborationMode === "string"
        ? this.#state.collaborationMode
        : undefined;
    return {
      ...(this.#state.model ? { model: this.#state.model } : {}),
      effort: this.#state.effort,
      ...(mode ? { mode } : {}),
    };
  }

  public subscribe(listener: (event: AdapterEvent) => void): () => void {
    this.#state.listeners.add(listener);
    if (this.#buffer.length > 0) {
      const buffered = this.#buffer.splice(0);
      for (const event of buffered) listener(event);
    }
    return () => this.#state.listeners.delete(listener);
  }

  public async execute(envelope: HarnessCommand): Promise<JsonValue | undefined> {
    if (envelope.harness !== "codex") throw new Error("command harness does not match Codex");
    const command = envelope.command;
    switch (command.type) {
      case "send": {
        const native = command.native ?? {};
        this.#turnStartsInFlight += 1;
        let response: TurnStartResponse;
        try {
          response = await this.#rpc.request<TurnStartResponse>("turn/start", {
            ...native,
            threadId: this.vendorSessionId,
            input: inputsFrom(command.input),
          });
        } finally {
          this.#turnStartsInFlight -= 1;
        }
        const completedBeforeAck = this.#completedTurnIds.delete(response.turn.id);
        if (!completedBeforeAck) this.#state.currentTurnId = response.turn.id;
        // A blocking reverse request can also arrive in the same stdout batch
        // as the response, so derive status from all state observed so far.
        this.#restoreStatusAfterInput();
        return json(response);
      }
      case "steer": {
        const expectedTurnId = command.expectedTurnId ?? this.#state.currentTurnId;
        if (!expectedTurnId) throw new Error("Codex turn/steer requires an active turn id");
        const native = command.native ?? {};
        const response = await this.#rpc.request<TurnSteerResponse>("turn/steer", {
          ...native,
          threadId: this.vendorSessionId,
          input: inputsFrom(command.input),
          expectedTurnId,
        });
        return json(response);
      }
      case "interrupt": {
        const turnId = command.turnId ?? this.#state.currentTurnId;
        if (!turnId) throw new Error("Codex turn/interrupt requires an active turn id");
        const commandItemIds = new Set(this.#commandItemsByTurn.get(turnId) ?? []);
        const response = await this.#rpc.request("turn/interrupt", {
          threadId: this.vendorSessionId,
          turnId,
        });
        if (commandItemIds.size > 0) {
          try {
            await this.#terminateTrackedTerminals(commandItemIds);
          } catch (cause) {
            throw new AdapterOutcomeUnknownError(
              `Codex turn ${turnId} was interrupted but its command-terminal cleanup was not acknowledged`,
              { cause },
            );
          }
        }
        return json(response);
      }
      case "setModel": {
        const collaborationMode = this.#patchedCollaborationMode({ model: command.model });
        const response = await this.#rpc.request("thread/settings/update", {
          threadId: this.vendorSessionId,
          model: command.model,
          ...(collaborationMode !== undefined ? { collaborationMode } : {}),
        });
        this.#state.model = command.model;
        if (collaborationMode !== undefined) this.#state.collaborationMode = collaborationMode;
        this.#emitSettings();
        return json(response);
      }
      case "setEffort": {
        const collaborationMode = this.#patchedCollaborationMode({ effort: command.effort });
        const response = await this.#rpc.request("thread/settings/update", {
          threadId: this.vendorSessionId,
          effort: command.effort,
          ...(collaborationMode !== undefined ? { collaborationMode } : {}),
        });
        this.#state.effort = command.effort;
        if (collaborationMode !== undefined) this.#state.collaborationMode = collaborationMode;
        this.#emitSettings();
        return json(response);
      }
      case "setMode": {
        const collaborationMode = this.#collaborationMode(command.mode);
        const response = await this.#rpc.request("thread/settings/update", {
          threadId: this.vendorSessionId,
          collaborationMode,
        });
        this.#state.collaborationMode = collaborationMode;
        this.#emitSettings();
        return json(response);
      }
      case "updateTurnSettings": {
        const turnId = command.turnId ?? this.#state.currentTurnId;
        if (!turnId) throw new Error("Codex turn/settings/update requires an active turn id");
        return json(await this.#rpc.request("turn/settings/update", {
          threadId: this.vendorSessionId,
          turnId,
          ...(command.model ? { model: command.model } : {}),
          ...(command.effort ? { effort: command.effort } : {}),
          ...(command.summary ? { summary: command.summary } : {}),
          ...(command.serviceTier !== undefined
            ? { serviceTier: command.serviceTier }
            : {}),
        }));
      }
      case "listBackgroundTerminals": {
        const data: JsonValue[] = [];
        let cursor: string | null = null;
        do {
          const response: {
            data: JsonValue[];
            nextCursor: string | null;
          } = await this.#rpc.request("thread/backgroundTerminals/list", {
            threadId: this.vendorSessionId,
            cursor,
            limit: command.limit,
          });
          data.push(...response.data);
          cursor = response.nextCursor;
        } while (cursor && data.length < command.limit);
        return { data: data.slice(0, command.limit), nextCursor: cursor };
      }
      case "terminateBackgroundTerminal":
        return json(await this.#rpc.request("thread/backgroundTerminals/terminate", {
          threadId: this.vendorSessionId,
          processId: command.processId,
        }));
      case "cleanBackgroundTerminals":
        return json(await this.#rpc.request("thread/backgroundTerminals/clean", {
          threadId: this.vendorSessionId,
        }));
    }
  }

  public async readNativeHistory(request: NativeHistoryRequest): Promise<AdapterNativeHistoryResult> {
    if (request.harness !== "codex") throw new Error("history request harness mismatch");
    if (request.includeTurns) {
      let limit = Math.min(request.limit ?? 100, 100);
      let response: ThreadItemsListResponse;
      for (;;) {
        response = await this.#rpc.request<ThreadItemsListResponse>("thread/items/list", {
          ...(request.native ?? {}),
          threadId: this.vendorSessionId,
          limit,
          sortDirection: "asc",
          cursor: request.cursor ?? null,
          turnId: null,
        });
        const page = json(response);
        if (codexHistoryPageBytes(page) <= NATIVE_PAYLOAD_MAX_BYTES && codexImageLeaves(page).length <= 256) break;
        if (limit === 1) throw new Error("One native Codex history item exceeds the bounded wire envelope");
        // Re-read the same native cursor with a smaller page; never invent a
        // cursor or silently discard native items after the server advanced it.
        limit = Math.max(1, Math.floor(limit / 2));
      }
      return {
        harness: "codex", vendorSessionId: this.vendorSessionId, payload: json(response),
        complete: response.nextCursor === null,
        ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
      };
    }
    const response = await this.#rpc.request<ThreadReadResponse>("thread/read", {
      ...(request.native ?? {}),
      threadId: this.vendorSessionId,
      includeTurns: request.includeTurns,
    });
    return {
      harness: "codex",
      vendorSessionId: this.vendorSessionId,
      payload: json(response),
      complete: true,
    };
  }

  public async stop(): Promise<void> {
    try {
      await this.#rpc.request("thread/unsubscribe", { threadId: this.vendorSessionId });
    } finally {
      this.#setStatus("stopped");
      this.#onStop();
    }
  }

  public notification(notification: CodexNotification): void {
    const params = notification.params;
    const isRootThread = threadIdFrom(params) === this.vendorSessionId;
    if (isRootThread) this.#trackCommandItem(notification);
    if (
      isRootThread &&
      notification.method === "turn/started" &&
      params &&
      !Array.isArray(params) &&
      typeof params === "object" &&
      params.turn &&
      !Array.isArray(params.turn) &&
      typeof params.turn === "object" &&
      typeof params.turn.id === "string"
    ) {
      this.#state.currentTurnId = params.turn.id;
      this.#setStatus("running");
    } else if (notification.method === "turn/completed") {
      const completedTurnId =
        params &&
        !Array.isArray(params) &&
        typeof params === "object" &&
        params.turn &&
        !Array.isArray(params.turn) &&
        typeof params.turn === "object" &&
        typeof params.turn.id === "string"
          ? params.turn.id
          : this.#state.currentTurnId;
      if (completedTurnId) this.#settleTurnRequests(completedTurnId);
      if (isRootThread) {
        if (completedTurnId && this.#turnStartsInFlight > 0) {
          this.#rememberCompletedTurn(completedTurnId);
        }
        this.#state.currentTurnId = undefined;
        this.#restoreStatusAfterInput();
      }
    } else if (
      isRootThread &&
      notification.method === "thread/status/changed" &&
      params &&
      !Array.isArray(params) &&
      typeof params === "object" &&
      params.status &&
      !Array.isArray(params.status) &&
      typeof params.status === "object"
    ) {
      const type = params.status.type;
      if (type === "idle") this.#setStatus("idle");
      else if (type === "active") this.#setStatus("running");
      else if (type === "systemError") this.#setStatus("error");
      // A native thread/resume may emit `notLoaded` immediately before its
      // loaded/idle transition. Treating that transient notification as a
      // terminal Multiplex status can synchronously retire the freshly
      // attached RuntimeNodeService binding when buffered events are replayed.
      // Explicit unsubscribe and app-server exit already own the two real
      // terminal paths for a CodexSession, so keep forwarding this native
      // notification without changing local attachment ownership.
    } else if (
      isRootThread &&
      notification.method === "thread/settings/updated" &&
      params &&
      !Array.isArray(params) &&
      typeof params === "object" &&
      params.threadSettings &&
      !Array.isArray(params.threadSettings) &&
      typeof params.threadSettings === "object"
    ) {
      const settings = params.threadSettings;
      if (typeof settings.model === "string") this.#state.model = settings.model;
      if (typeof settings.effort === "string" || settings.effort === null) {
        this.#state.effort = settings.effort;
      }
      if (settings.collaborationMode !== undefined) {
        this.#state.collaborationMode = settings.collaborationMode;
      }
      this.#emitSettings();
    } else if (
      notification.method === "serverRequest/resolved" &&
      params &&
      !Array.isArray(params) &&
      typeof params === "object" &&
      (typeof params.requestId === "string" || typeof params.requestId === "number")
    ) {
      const nativeRequestId = String(params.requestId);
      const pending = this.#pendingRequests.get(nativeRequestId);
      if (pending) this.#pendingRequests.delete(nativeRequestId);
      if (pending) {
      this.#emit({
        kind: "interactionSettled",
          nativeRequestId,
          state:
            pending.expiresAt && Date.parse(pending.expiresAt) <= Date.now()
              ? "expired"
              : "stale",
      });
      }
      this.#restoreStatusAfterInput();
    }
    this.#emit({
      kind: "native",
      nativeType: notification.method,
      payload: notification.params,
      ephemeral: isEphemeral(notification.method),
    });
  }

  public serverRequest(request: CodexServerRequest): void {
    const params = recordOf(request.params);
    const blocking = params?.isBlocking !== false;
    const autoResolutionMs = params?.autoResolutionMs;
    const expiresAt =
      typeof autoResolutionMs === "number" &&
      Number.isFinite(autoResolutionMs) &&
      autoResolutionMs >= 0
        ? new Date(Date.now() + autoResolutionMs).toISOString()
        : undefined;
    const nativeRequestId = String(request.id);
    const turnId = typeof params?.turnId === "string" ? params.turnId : undefined;
    this.#pendingRequests.set(nativeRequestId, {
      blocking,
      ...(expiresAt ? { expiresAt } : {}),
      ...(turnId ? { turnId } : {}),
    });
    if (blocking) this.#setStatus("waitingForInput");
    this.#emit({
      kind: "interaction",
      nativeRequestId,
      requestType: interactionType(request.method),
      payload: { method: request.method, params: request.params },
      ephemeral: false,
      ...(expiresAt ? { expiresAt } : {}),
      resolve: async (response) => {
        validateInteractionResponse(request.method, response);
        this.#pendingRequests.delete(nativeRequestId);
        request.respond(response);
        this.#restoreStatusAfterInput();
      },
    });
  }

  public runtimeExited(error: Error): void {
    this.#setStatus("error");
    this.#emit({
      kind: "native",
      nativeType: "agent-multiplex/runtime-exited",
      payload: { message: error.message },
      ephemeral: false,
    });
    // A CodexSession is bound to one app-server process epoch. Once that
    // process exits, restarting CodexRpcClient creates a new process in which
    // this thread has not been resumed, so retaining the old handle would
    // falsely keep the logical session active and leave reverse requests
    // answerable against a dead transport. Publish the diagnostic first, then
    // make ownership terminal so RuntimeNodeService detaches the handle and stales
    // its pending interactions. A later explicit resume gets a fresh runtime
    // epoch and native subscription.
    this.#setStatus("stopped");
    this.#onStop();
  }

  public closed(): void {
    this.#pendingRequests.clear();
    this.#setStatus("stopped");
  }

  #collaborationMode(mode: JsonValue): JsonValue {
    if (mode !== "plan" && mode !== "default") return mode;
    if (!this.#state.model) {
      throw new Error("Codex collaboration mode alias requires a known session model");
    }
    return {
      mode,
      settings: {
        model: this.#state.model,
        reasoning_effort:
          mode === "plan" ? this.#state.effort ?? "medium" : this.#state.effort,
        developer_instructions: null,
      },
    };
  }

  #patchedCollaborationMode(
    patch: { model?: string; effort?: string },
  ): JsonValue | undefined {
    const collaborationMode = recordOf(this.#state.collaborationMode);
    const settings = recordOf(collaborationMode?.settings);
    if (!collaborationMode || !settings) return undefined;
    return {
      ...collaborationMode,
      settings: {
        ...settings,
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.effort !== undefined
          ? { reasoning_effort: patch.effort }
          : {}),
      },
    };
  }

  #restoreStatusAfterInput(): void {
    if ([...this.#pendingRequests.values()].some((request) => request.blocking)) {
      this.#setStatus("waitingForInput");
      return;
    }
    this.#setStatus(this.#state.currentTurnId ? "running" : "idle");
  }

  #settleTurnRequests(turnId: string): void {
    for (const [nativeRequestId, pending] of this.#pendingRequests) {
      if (pending.turnId !== turnId) continue;
      this.#pendingRequests.delete(nativeRequestId);
      this.#emit({ kind: "interactionSettled", nativeRequestId, state: "stale" });
    }
  }

  #trackCommandItem(notification: CodexNotification): void {
    if (notification.method !== "item/started" && notification.method !== "item/completed") {
      return;
    }
    const params = recordOf(notification.params);
    const item = recordOf(params?.item);
    const turnId = params?.turnId;
    const itemId = item?.id;
    if (
      typeof turnId !== "string" ||
      typeof itemId !== "string" ||
      item?.type !== "commandExecution"
    ) {
      return;
    }
    if (notification.method === "item/started") {
      const items = this.#commandItemsByTurn.get(turnId) ?? new Set<string>();
      items.add(itemId);
      this.#commandItemsByTurn.set(turnId, items);
      return;
    }
    const items = this.#commandItemsByTurn.get(turnId);
    if (!items) return;
    items.delete(itemId);
    if (items.size === 0) this.#commandItemsByTurn.delete(turnId);
  }

  async #listBackgroundTerminals(): Promise<ThreadBackgroundTerminal[]> {
    const terminals: ThreadBackgroundTerminal[] = [];
    let cursor: string | null = null;
    do {
      const response: ThreadBackgroundTerminalsListResponse =
        await this.#rpc.request<ThreadBackgroundTerminalsListResponse>(
        "thread/backgroundTerminals/list",
        { threadId: this.vendorSessionId, cursor, limit: 100 },
      );
      terminals.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);
    return terminals;
  }

  async #terminateTrackedTerminals(commandItemIds: ReadonlySet<string>): Promise<void> {
    const matching = (await this.#listBackgroundTerminals()).filter((terminal) =>
      commandItemIds.has(terminal.itemId)
    );
    for (const terminal of matching) {
      await this.#rpc.request("thread/backgroundTerminals/terminate", {
        threadId: this.vendorSessionId,
        processId: terminal.processId,
      });
    }
    const remaining = (await this.#listBackgroundTerminals()).filter((terminal) =>
      commandItemIds.has(terminal.itemId)
    );
    if (remaining.length > 0) {
      throw new Error(
        `Codex still reports ${remaining.length} background terminal(s) for the interrupted turn`,
      );
    }
  }

  #rememberCompletedTurn(turnId: string): void {
    // Normally turn/start has already resumed and will never consult this
    // marker. Keep a small bound because notification-first delivery is rare,
    // while native turn ids are unique and sessions may be long-lived.
    this.#completedTurnIds.delete(turnId);
    this.#completedTurnIds.add(turnId);
    if (this.#completedTurnIds.size <= 64) return;
    const oldest = this.#completedTurnIds.values().next().value as string | undefined;
    if (oldest) this.#completedTurnIds.delete(oldest);
  }

  #setStatus(status: SessionRuntimeStatus): void {
    if (this.#state.status === status) return;
    this.#state.status = status;
    this.#emit({ kind: "status", status });
  }

  #emitSettings(): void {
    this.#emit({ kind: "settings", settings: this.settings() });
  }

  #emit(event: AdapterEvent): void {
    if (this.#state.listeners.size === 0) {
      this.#buffer.push(event);
      return;
    }
    for (const listener of this.#state.listeners) listener(event);
  }
}
