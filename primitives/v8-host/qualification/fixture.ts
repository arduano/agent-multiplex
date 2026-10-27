import type { Catalog, Harness, Json, NativeStart, RunRef } from "../../v8-session/src/contracts/types.js";
import type { RuntimeHalt, RuntimeIdentity } from "../../v8-runtime/src/contracts.js";
import type { TrustedContainment, HostController } from "../src/contracts.js";
import { createCodexController, type CodexNotification, type CodexRequests, type CodexReverseRequest, type CodexTransport } from "../../v8-harness-codex/src/controller.js";
import { createCopilotController, type CopilotEvent, type CopilotSession, type CopilotSessionConfig, type CopilotTransport } from "../../v8-harness-copilot/src/controller.js";
import type { McpTransports } from '../../v8-mcp/src/contracts.js';
type DriverOptions = Readonly<{ cwd: string; model?: string; nativeSession?: string; mcpTransports?: McpTransports; mcpOAuthTokenStorage?: 'persistent' | 'in-memory' }>;

export const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
export const until = async (condition: () => boolean | Promise<boolean>, timeoutMs = 10000): Promise<void> => { const end = Date.now() + timeoutMs; while (!await condition()) { if (Date.now() >= end) throw Error("Scripted Host condition timed out"); await new Promise(done => setTimeout(done, 2)); } };
export type ScriptCounts = { opens: number; resumes: number; sends: number; stops: number; discovery: number; bodyReads: number; replies: number };
export class ScriptedContainment implements TrustedContainment {
  readonly placement = "dedicated" as const; readonly capabilities = { fullStop: true, createAndWait: true, reopen: true };
  readonly inputs: NativeStart[] = []; readonly identities: RuntimeIdentity[] = [];
  readonly #listeners = new Set<(value: RuntimeHalt) => void>();
  stopGate: Promise<RuntimeHalt> | undefined; certificateGate: Promise<void> | undefined; inspectResult: "owned" | RuntimeHalt | null = "owned";
  onStop: (() => void) | undefined; onCertified: (() => void) | undefined;
  prepareOpening?: NonNullable<TrustedContainment["prepareOpening"]>;
  constructor(readonly counts: ScriptCounts) {}
  identity(run: RunRef): RuntimeIdentity { const identity = { run, attachment: `scripted-attachment-${run.generation}`, process: "scripted-owned-process", containment: "scripted-owned-container", placement: this.placement }; this.identities.push(identity); return identity; }
  async observeOpening(input: NativeStart, run: RunRef) { this.inputs.push(input); await this.certificateGate; this.onCertified?.(); return { run, ...(input.nativeSession === null ? { kind: "created" as const, noAutomaticContinuation: true as const } : { kind: "reopened" as const }), callbacksComplete: true, continuous: true }; }
  async inspect(_run: RunRef) { return this.inspectResult; }
  proof(identity = this.identities.at(-1)!): RuntimeHalt { return { identity, proof: { run: identity.run, state: "stopped", scope: "nativeTree", noAutomaticContinuation: true }, boundary: { kind: "dedicated", containmentRetired: true } }; }
  async stopTree(identity: RuntimeIdentity): Promise<RuntimeHalt> { this.counts.stops++; this.onStop?.(); return this.stopGate ?? this.proof(identity); }
  onHalt(listener: (value: RuntimeHalt) => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  halt(): void { const proof = this.proof(); for (const listener of this.#listeners) listener(proof); }
}

/** Synthetic transport/controller fixture only. No SDK/native process, MCP
 * service, provider or model is launched by construction or any method. */
export class ScriptedHostDriver {
  readonly counts: ScriptCounts = { opens: 0, resumes: 0, sends: 0, stops: 0, discovery: 0, bodyReads: 0, replies: 0 };
  readonly containment = new ScriptedContainment(this.counts); readonly controller: HostController;
  readonly requests: { method: string; params: unknown }[] = [];
  holdWork = false; onSend: ((text: string, driver: ScriptedHostDriver) => void) | undefined;
  action: ((method: string, params: unknown) => Promise<unknown>) | undefined;
  login: ((params: unknown) => Promise<unknown>) | undefined;
  readonly queuedItems = [{ id: "scripted-queue", messageId: "scripted-queued-message", kind: "message", displayText: "queued native message", agentMode: "interactive" }];
  readonly tasks = [{ id: "scripted-task", type: "agent", description: "Scripted child", status: "running", startedAt: "now", executionMode: "sync", canPromoteToBackground: true, toolCallId: "scripted-spawn", agentType: "general", model: null }];
  metadataGate: Promise<unknown> | undefined;
  openingGate: Promise<void> | undefined;
  #notifications = new Set<(value: CodexNotification) => void>(); #reverse = new Set<(value: CodexReverseRequest) => void>();
  #config: CopilotSessionConfig | undefined; #serial = 0; #turn = ""; #answer = ""; #text = ""; #root: string; #form = 0; #event = 0;
  constructor(readonly kind: Harness, readonly options: DriverOptions) {
    this.#root = options.nativeSession ?? `scripted-${kind}-native`;
    this.containment.onCertified = () => { if (kind === "copilot") this.event("session.idle", {}); else this.notify("thread/status/changed", { threadId: this.#root, status: { type: "idle" } }); };
    const model = options.model ?? "scripted-model", catalog = async (): Promise<Catalog> => ({ available: true, choices: [{ model, ...(kind === "copilot" ? { providerId: "scripted-provider" } : {}), efforts: ["low"] }] });
    if (kind === "codex") {
      const transport: CodexTransport = { request: async <M extends keyof CodexRequests>(method: M, params: CodexRequests[M]): Promise<unknown> => {
        this.requests.push({ method, params });
        if (method === 'mcpServer/oauth/login') { if (!this.login) throw Error('No scripted login result'); return this.login(params); }
        if (method === "thread/start" || method === "thread/resume") {
          if (method === "thread/start") this.counts.opens++; else this.counts.resumes++;
          await this.openingGate;
          const input = params as CodexRequests["thread/start"];
          return { thread: { id: this.#root }, model: input.model, modelProvider: input.modelProvider, approvalPolicy: input.approvalPolicy, sandbox: { type: input.sandbox === "read-only" ? "readOnly" : input.sandbox === "workspace-write" ? "workspaceWrite" : "dangerFullAccess" } };
        }
        if (method === "turn/start") {
          const input = params as CodexRequests["turn/start"];
          if (input.input.length === 0) {
            if (this.action) return this.action(method, params);
            this.#turn = `scripted-continue-${++this.#serial}`; this.#native("turn/started", { turn: { id: this.#turn, status: "inProgress" } });
            if (!this.holdWork) this.#native("turn/completed", { turn: { id: this.#turn, status: "completed" } });
          } else this.#send((input.input as readonly Readonly<{ text: string }>[])[0]!.text);
          return { turn: { id: this.#turn } };
        }
        if (method === "mcpServerStatus/list") { this.counts.discovery++; return { data: [{ name: "scripted-fixture", runtimeStatus: "connected", authStatus: "unsupported", tools: { example: {} }, toolsError: null }], nextCursor: null }; }
        if (["thread/queue/add", "turn/steer", "thread/compact/start", "thread/goal/get", "thread/goal/set", "thread/goal/clear"].includes(method)) {
          if (this.action) return this.action(method, params);
          if (method === "thread/queue/add") return { queuedSubmission: { id: "scripted-native-queue", clientUserMessageId: (params as CodexRequests["thread/queue/add"]).clientUserMessageId, input: (params as CodexRequests["thread/queue/add"]).input } };
          if (method === "turn/steer") return { turnId: (params as CodexRequests["turn/steer"]).expectedTurnId };
          if (method === "thread/goal/get") return { goal: null };
          if (method === "thread/goal/set") return { goal: { threadId: this.#root, objective: "Scripted goal", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0, ...params } };
          if (method === "thread/goal/clear") return { cleared: false }; return {};
        }
        if (method === "turn/settings/update") return { status: "applied" };
        return {};
      }, onNotification: fn => { this.#notifications.add(fn); return () => { this.#notifications.delete(fn); }; }, onRequest: fn => { this.#reverse.add(fn); return () => { this.#reverse.delete(fn); }; } };
      this.controller = createCodexController({ transport, containment: this.containment, cwd: options.cwd, model, provider: { id: "scripted-provider", copilotOnly: true }, catalog, ...(options.mcpTransports ? { mcpTransports: options.mcpTransports } : {}) });
    } else {
      const create = async (config: CopilotSessionConfig, resume: boolean): Promise<CopilotSession> => {
        this.#config = config; this.#root = config.sessionId; if (resume) this.counts.resumes++; else this.counts.opens++;
        await this.openingGate;
        this.requests.push({ method: resume ? "session.resume" : "session.create", params: config });
        const action = async (method: string, params: unknown, fallback: unknown): Promise<unknown> => { this.requests.push({ method, params }); return this.action ? this.action(method, params) : fallback; };
        return { sessionId: config.sessionId, send: async input => { this.requests.push({ method: "session.send", params: input }); this.#send(input.prompt); return `scripted-message-${this.#serial}`; }, abort: async () => ({}),
          rpc: { model: { getCurrent: async () => { this.requests.push({ method: "model.getCurrent", params: {} }); return this.metadataGate ?? { modelId: config.model, providerId: "scripted-provider", ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }) }; }, switchTo: async input => ({ modelState: { modelId: input.modelId, providerId: input.providerId } }) },
            mode: { set: async () => ({ status: "success", modeApplied: true, modelChanged: false }) },
            permissions: { setMode: async input => { this.requests.push({ method: "permissions.setMode", params: input }); return { success: true, mode: input.mode }; }, setRequired: async () => { this.requests.push({ method: "permissions.setRequired", params: {} }); return { success: true }; }, handlePendingPermissionRequest: async input => { this.requests.push({ method: "permissions.handlePendingPermissionRequest", params: input }); this.counts.replies++; return { success: true }; } },
            queue: { pendingItems: () => action("queue.pendingItems", {}, { items: this.queuedItems, steeringMessages: [], inFlightSteeringCount: 0 }), sendNow: input => action("queue.sendNow", input, { steered: false }) },
            history: { compact: input => action("history.compact", input, { success: true, tokensRemoved: 10, messagesRemoved: 2 }) },
            tasks: { refresh: () => action("tasks.refresh", {}, {}), list: () => action("tasks.list", {}, { tasks: this.tasks }), getProgress: input => action("tasks.getProgress", input, { progress: { type: "agent", recentActivity: [{ message: "working", timestamp: "now" }] } }), getCurrentPromotable: () => action("tasks.getCurrentPromotable", {}, { task: this.tasks[0] }), cancel: input => action("tasks.cancel", input, { cancelled: false }), promoteToBackground: input => action("tasks.promoteToBackground", input, { promoted: true }) },
            mcp: { listConfigured: async () => { this.counts.discovery++; return { servers: [{ name: "scripted-fixture", enabled: true, live: { status: "connected" } }] }; }, oauth: { login: async input => { this.requests.push({ method: 'mcp.oauth.login', params: input }); if (!this.login) throw Error('No scripted login result'); return this.login(input); } } } } };
      };
      const transport: CopilotTransport = { createSession: config => create(config, false), resumeSession: (_id, config) => create(config, true) };
      this.controller = createCopilotController({ transport, containment: this.containment, cwd: options.cwd, model, provider: { id: "scripted-provider", copilotOnly: true, config: { type: "openai", wireApi: "responses", transport: "http", baseUrl: "http://scripted.invalid", apiKey: "scripted-not-a-credential", modelId: model, wireModel: model } }, catalog, newSessionId: () => this.#root, ...(options.mcpTransports ? { mcpTransports: options.mcpTransports } : {}), ...(options.mcpOAuthTokenStorage ? { mcpOAuthTokenStorage: options.mcpOAuthTokenStorage } : {}) });
    }
  }
  notify(method: string, params: unknown): void { for (const listener of this.#notifications) listener({ method, params }); }
  reverse(request: CodexReverseRequest): void { for (const listener of this.#reverse) listener(request); }
  event(type: string, data: Readonly<Record<string, unknown>>, agentId?: string, timestamp?: string): void { this.#config?.onEvent({ ...(timestamp === undefined ? {} : { timestamp }), id: `scripted-event-${++this.#event}`, type, data, ...(agentId === undefined ? {} : { agentId }) }); }
  #native(method: string, params: Readonly<Record<string, unknown>>): void { this.notify(method, { threadId: this.#root, turnId: this.#turn, ...params }); }
  #send(text: string): void {
    this.counts.sends++; this.#serial++; this.#turn = `scripted-turn-${this.#serial}`; this.#answer = `scripted-answer-${this.#serial}`; this.#text = "";
    if (this.kind === "codex") {
      this.#native("turn/started", { turn: { id: this.#turn, status: "inProgress", items: [], itemsView: "notLoaded" } });
      const item = { id: `scripted-user-${this.#serial}`, type: "userMessage", content: [{ type: "text", text }] };
      this.#native("item/started", { item }); this.#native("item/completed", { item }); this.#native("item/started", { item: { id: this.#answer, type: "agentMessage", text: "" } });
    } else { this.event("assistant.turn_start", { turnId: this.#turn }); this.event("user.message", { messageId: `scripted-user-${this.#serial}`, content: text }); this.event("assistant.message_start", { messageId: this.#answer }); }
    if (this.onSend) this.onSend(text, this);
    else { this.emitText(`Scripted response: ${text}`); this.emitTool("scripted terminal output\n"); if (!this.holdWork) this.complete(); }
  }
  emitText(text: string): void { this.#text += text; if (this.kind === "codex") this.#native("item/agentMessage/delta", { itemId: this.#answer, delta: text }); else this.event("assistant.message_delta", { messageId: this.#answer, deltaContent: text }); }
  emitTool(text: string): void {
    const id = `scripted-terminal-${this.#serial}`;
    if (this.kind === "codex") { const item = { type: "commandExecution", id, command: "scripted echo", processId: `scripted-pty-${this.#serial}` }; this.#native("item/started", { item: { ...item, status: "inProgress", aggregatedOutput: null } }); this.#native("item/commandExecution/outputDelta", { itemId: id, delta: text }); this.#native("item/completed", { item: { ...item, status: "completed", aggregatedOutput: text, exitCode: 0 } }); }
    else { this.event("tool.execution_start", { toolCallId: id, toolName: "shell" }); this.event("tool.shell_output", { toolCallId: id, sequence: 0, text, stream: "stdout" }); this.event("tool.execution_complete", { toolCallId: id, success: true, result: { content: text } }); }
  }
  complete(text?: string): void {
    if (text) this.emitText(text);
    if (this.kind === "codex") { this.#native("item/completed", { item: { type: "agentMessage", id: this.#answer, text: this.#text } }); this.#native("turn/completed", { turn: { id: this.#turn, status: "completed", items: [], itemsView: "notLoaded" } }); }
    else { this.event("assistant.message", { messageId: this.#answer, content: this.#text, originatingMessageId: `scripted-user-${this.#serial}` }); this.event("assistant.turn_end", { turnId: this.#turn }); this.event("session.idle", {}); }
  }
  requestForm(): Promise<Json> {
    const requestId = `scripted-form-${++this.#form}`, message = "Scripted MCP confirmation", requestedSchema = { type: "object", properties: { confirmed: { type: "boolean" } }, required: ["confirmed"] };
    if (this.kind === "codex") { const result = deferred<Json>(), settled = deferred<void>();
      const request: CodexReverseRequest = { id: requestId, method: "mcpServer/elicitation/request", token: {}, params: { threadId: this.#root, serverName: "scripted-fixture", mode: "form", message, requestedSchema }, settled: settled.promise,
        respond: async value => { this.counts.replies++; result.resolve(value); settled.resolve(); return { kind: "ack", success: true }; } };
      for (const listener of this.#reverse) listener(request); return result.promise;
    }
    if (!this.#config) return Promise.reject(Error("Scripted session not open"));
    this.event("elicitation.requested", { requestId, mode: "form", message, requestedSchema, elicitationSource: "scripted-fixture" });
    return this.#config.onElicitationRequest({ sessionId: this.#root, mode: "form", message, requestedSchema, elicitationSource: "scripted-fixture" }).then(value => { this.counts.replies++; this.event("elicitation.completed", { requestId, ...value as Record<string, unknown> }); return value; });
  }
}
export const scriptedHost = (kind: Harness, options: DriverOptions): ScriptedHostDriver => new ScriptedHostDriver(kind, options);
