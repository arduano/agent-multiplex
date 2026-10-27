import { copilotProtocol, copilotDefaults } from "./protocol.js";
import { copilotHistory } from "./history.js";
import { SessionError, type NativeRead, type NativeReadResult, type Catalog, type CopilotEncodedAttachment, type CopilotSelection, type Json, type NativeRun, type NativeStart, type NativeSendCommand, type RunRef } from "../../v8-session/src/contracts/types.js";
import { copy, canonical } from "../../v8-session/src/contracts/validation.js";
import { createCopilotInvocation, type CopilotControlRpc } from "./invocation.js";
import { nativeReadResult } from "../../v8-harness-defaults/src/state.js";
import { copilotModelMatches } from "./model.js";
import { SelectionOwner } from "../../v8-harness-defaults/src/selection.js";
import { requireThat } from "../../v8-runtime/src/validation.js";
import { copilotMcpReadPort } from "../../v8-mcp/src/native.js";
import type { McpTransports } from "../../v8-mcp/src/contracts.js";
import type { CopilotMethod } from "../../v8-interactions/src/native.js";
import type { TrustedContainment } from "../../v8-host/src/contracts.js";
import { Controller } from "../../v8-host/src/controller.js";
import { prepareCopilotBlob } from "../../v8-files/src/native/images.js";
import { projectCopilotMediaEvent } from "../../v8-host/src/native-media.js";
import { copilotCheckpoint } from "../../v8-session/src/contracts/usage.js";
import { CopilotAttention } from "./attention.js";
import { LoginLinks, type LoginAttempt } from '../../v8-mcp/src/login.js';
import type { McpLoginLink, NativeControlCommand } from '../../v8-session/src/contracts/types.js';

export type CopilotEvent = Readonly<{ id: string; type: string; timestamp?: string; agentId?: string; data: Readonly<Record<string, unknown>> }>;
export type CopilotInvocation = Readonly<{ sessionId: string }>;
export type CopilotAttachment = CopilotEncodedAttachment;
export type CopilotSession = Readonly<{
  sessionId: string;
  send(input: Readonly<{ prompt: string; mode: "enqueue" | "immediate"; attachments?: readonly CopilotAttachment[] }>): Promise<string>;
  abort(): Promise<unknown>;
  rpc: Pick<CopilotControlRpc, "model" | "mode" | "permissions" | "sendMessages"> & Readonly<{
    model: CopilotControlRpc["model"] & Readonly<{ getCurrent(): Promise<unknown> }>;
    mode: CopilotControlRpc["mode"] & Readonly<{ get?(): Promise<unknown> }>;
    permissions: CopilotControlRpc["permissions"] & Readonly<{ getMode?(): Promise<unknown>; setRequired(input: Readonly<{ required: true }>): Promise<unknown>; handlePendingPermissionRequest(input: Readonly<{ requestId: string; result: Json }>): Promise<Readonly<{ success: boolean }>> }>;
    queue?: Readonly<{ pendingItems(): Promise<unknown>; sendNow(input: Readonly<{ id: string }>): Promise<unknown> }>;
    history?: Readonly<{ compact(input: Readonly<{ trigger: "manual" }>): Promise<unknown> }>;
    tasks?: Readonly<{ refresh(): Promise<unknown>; list(): Promise<unknown>; getProgress(input: Readonly<{ id: string }>): Promise<unknown>; getCurrentPromotable(): Promise<unknown>; cancel(input: Readonly<{ id: string }>): Promise<unknown>; promoteToBackground(input: Readonly<{ id: string }>): Promise<unknown> }>;
    mcp: Readonly<{ listConfigured(): Promise<unknown>; restartServer?(input: Readonly<{ serverName: string }>): Promise<unknown>; oauth?: Readonly<{ login(input: Readonly<{ serverName: string; forceReauth?: boolean }>): Promise<unknown> }> }>;
  }>;
}>;
export type CopilotSessionConfig = Readonly<{
  sessionId: string; model: string; allowedModels: readonly string[]; provider: Readonly<Record<string, Json>>;
  workingDirectory: string; reasoningEffort?: string; streaming: true; includeSubAgentStreamingEvents: true;
  /** Adapter-local observation, removed before forwarding native SDK options. */
  onControlLost(): void;
  onEvent(event: CopilotEvent): void;
  onPermissionRequest(): Readonly<{ kind: "no-result" }>;
  onUserInputRequest(request: unknown, invocation: CopilotInvocation): Promise<Json>;
  onElicitationRequest(context: unknown): Promise<Json>;
  onExitPlanModeRequest(request: unknown, invocation: CopilotInvocation): Promise<Json>;
}>;
export interface CopilotTransport {
  createSession(config: CopilotSessionConfig): Promise<CopilotSession>;
  resumeSession(sessionId: string, config: CopilotSessionConfig): Promise<CopilotSession>;
}
export interface CopilotControllerOptions {
  transport: CopilotTransport; containment: TrustedContainment; cwd: string; model: string;
  /** id names the authorized framework route, not a native catalog provider. */
  provider: Readonly<{ id: string; copilotOnly: boolean; config: Readonly<Record<string, Json>> }>;
  catalog: () => Promise<Catalog>; newSessionId?: () => string;
  /** Private frozen known startup transports; config-discovered names stay unknown. */
  mcpTransports?: McpTransports;
  mcpOAuthTokenStorage?: 'persistent' | 'in-memory';
}
function record(value: unknown): Record<string, unknown> { requireThat(value && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
function payload(method: CopilotMethod, value: unknown): Record<string, unknown> {
  const raw = record(value), optional = method === "elicitation" ? ["mode", "elicitationSource", "url", "requestedSchema"] : method === "userInput" ? ["choices", "allowFreeform"] : method === "exitPlan" ? ["planContent"] : [];
  return Object.fromEntries(Object.entries(raw).filter(([key, value]) => value !== undefined || !optional.includes(key)));
}
export class CopilotController extends Controller {
  readonly historyFacet = copilotHistory;
  readonly protocol = copilotProtocol;
  readonly #options: CopilotControllerOptions; readonly #mcpTransports: McpTransports | undefined; #session: CopilotSession | undefined;
  readonly #children = new Set<string>(); readonly #activeChildren = new Map<string, string>();
  readonly #attention = new CopilotAttention();
  readonly #login = new LoginLinks();
  // One bounded native generation's ID lineage. A raw completion carries no
  // incarnation token, so an ID ever reused cannot settle its replacement.
  readonly #permissions = new Map<string, { capability: string | null; reused: boolean }>();
  #callbacks = 0; #childIdentityUncertain = false; #selection: SelectionOwner<"copilot"> | undefined;
  constructor(options: CopilotControllerOptions) { super("copilot", options.containment, options.catalog, ["send", "answer", "copilot.model", "copilot.mode", "copilot.permissions", "copilot.abort", "copilot.steer", "copilot.queue.promote", "copilot.compact", "copilot.task.cancel", "copilot.task.promote", ...(options.mcpTransports ? ["copilot.mcp.reconnect" as const] : []), ...(options.mcpOAuthTokenStorage !== 'persistent' && Object.values(options.mcpTransports ?? {}).some(value => value !== 'stdio') ? ['copilot.mcp.login' as const] : [])], ["copilot.queue", "copilot.tasks", "copilot.task.progress", "copilot.task.promotable"]); this.#options = options; this.#mcpTransports = options.mcpTransports === undefined ? undefined : copy(options.mcpTransports); }
  async openNative(input: NativeStart) {
    requireThat(input.policy.kind === "copilot" && (input.policy.provider !== "copilot-only" || this.#options.provider.copilotOnly));
    const selection = copilotDefaults(input.policy, input.selection); requireThat(selection.kind === "copilot");
    requireThat(selection.providerId === undefined || selection.providerId === this.#options.provider.id);
    const resumed = input.nativeSession !== null;
    if (!resumed && (selection.effort === null || selection.permissions === "assisted")) throw new SessionError("UNSUPPORTED", "Native creation does not support clearing effort or selecting assisted permissions");
    const model = selection.model ?? this.#options.model, sessionId = input.nativeSession ?? this.#options.newSessionId?.() ?? crypto.randomUUID();
    this.#children.clear(); this.#activeChildren.clear(); this.#permissions.clear(); this.#callbacks = 0; this.#childIdentityUncertain = false; this.#attention.reset();
    const config: CopilotSessionConfig = { sessionId, model, allowedModels: [model], provider: copy(this.#options.provider.config), workingDirectory: this.#options.cwd, ...(typeof selection.effort === "string" ? { reasoningEffort: selection.effort } : {}), streaming: true, includeSubAgentStreamingEvents: true,
      onControlLost: () => { if (this.current()?.run.generation === input.generation) this.controllerLost(); },
      onEvent: event => {
        try {
          const projection = projectCopilotMediaEvent(event), apply = (frozen: unknown) => { if (this.current()?.run.generation === input.generation) this.#event(frozen as CopilotEvent, projection === null); };
          if (projection) {
            if (this.current()?.run.generation !== input.generation) { this.gap(); return; }
            this.stageMedia(event, projection, apply);
          } else this.stage(event, apply);
        } catch { this.gap(); }
      }, onPermissionRequest: () => ({ kind: "no-result" }),
      onUserInputRequest: (request, invocation) => this.#callback("userInput", request, invocation, input.generation),
      onElicitationRequest: context => this.#callback("elicitation", context, { sessionId: String(record(context).sessionId ?? "") }, input.generation),
      onExitPlanModeRequest: (request, invocation) => this.#callback("exitPlan", request, invocation, input.generation) };
    const session = input.nativeSession === null ? await this.#options.transport.createSession(config) : await this.#options.transport.resumeSession(sessionId, config);
    this.#session = session; const run: RunRef = { scope: input.scope, generation: input.generation, nativeSession: session.sessionId };
    this.#login.reset(run);
    this.#selection = new SelectionOwner("copilot", run, { kind: "copilot" });
    const invokeNative = createCopilotInvocation({ rpc: {
      ...(session.rpc.sendMessages ? { sendMessages: fields => { this.assertActive(run); return session.rpc.sendMessages!(fields); } } : {}),
      model: { switchTo: fields => { this.assertActive(run); return session.rpc.model.switchTo(fields); } },
      mode: { set: fields => { this.assertActive(run); return session.rpc.mode.set(fields); } }, permissions: { setMode: fields => { this.assertActive(run); return session.rpc.permissions.setMode(fields); } },
      ...(session.rpc.queue ? { queue: { sendNow: fields => { this.assertActive(run); return session.rpc.queue!.sendNow(fields); } } } : {}),
      ...(session.rpc.history ? { history: { compact: fields => { this.assertActive(run); return session.rpc.history!.compact(fields); } } } : {}),
      ...(session.rpc.tasks ? { tasks: { cancel: fields => { this.assertActive(run); return session.rpc.tasks!.cancel(fields); }, promoteToBackground: fields => { this.assertActive(run); return session.rpc.tasks!.promoteToBackground(fields); } } } : {}),
      ...(session.rpc.mcp.restartServer ? { mcp: {
        listConfigured: () => { this.assertActive(run); return session.rpc.mcp.listConfigured(); },
        restartServer: fields => { this.assertActive(run); this.mcpChanged(run); return session.rpc.mcp.restartServer!(fields); },
      } } : {}),
      send: async fields => { this.assertActive(run); const messageId = await session.send(fields); requireThat(typeof messageId === "string" && messageId.length > 0); return { messageId }; }, abort: () => { this.assertActive(run); return session.abort(); },
    }, ...(this.#mcpTransports ? { mcpTransports: this.#mcpTransports } : {}), encodeInputs: async (input: NativeSendCommand<"copilot">["nativeInputs"]): Promise<readonly CopilotEncodedAttachment[]> => {
      requireThat(input.kind === "copilot");
      const scope = { connection: run.scope.connection, principal: run.scope.principal, host: run.scope.host, session: run.nativeSession };
      return Promise.all(input.items.map(async (item): Promise<CopilotEncodedAttachment> => item.type === "blob" ? { ...await prepareCopilotBlob({ harness: "copilot", scope, artifact: item.artifact, bytes: item.bytes }), displayName: item.artifact.name } : { type: "file", path: item.path, ...(item.displayName === undefined ? {} : { displayName: item.displayName }) }));
    } });
    const invoke: NativeRun["invoke"] = command => {
      if (command.type === 'copilot.mcp.login') return this.#loginNative(run, session, command);
      if (command.type !== "copilot.model") return invokeNative(command);
      if (command.providerId !== undefined && command.providerId !== this.#options.provider.id) throw new SessionError("FENCED");
      // Singular provider makes the whole native session BYOK. Bare model IDs
      // retain that provider; the framework route is not a named native catalog
      // entry. Never register additive providers or inject an invented native ID.
      const { providerId: _route, ...native } = command;
      return invokeNative(native);
    };
    return { run, selection: { kind: "copilot" as const }, invoke, mcp: copilotMcpReadPort(session, this.#mcpTransports, this.#mcpTransports && session.rpc.mcp.restartServer ? "session-originals" : undefined), initialize: async (active: () => void) => {
      active();
      requireThat(session.sessionId === sessionId);
      const current = record(await session.rpc.model.getCurrent()); active();
      // Native opaque provider IDs belong to its catalog, a different namespace
      // from this already bound whole-session provider route. Model/effort must
      // still be actual observations, never an ACK-derived setting.
      requireThat(copilotModelMatches(current, { model, ...(typeof selection.effort === "string" ? { effort: selection.effort } : {}) }));
      let permissions: CopilotSelection["permissions"];
      if (resumed) {
        if (session.rpc.permissions.getMode) {
          const observed = record(await session.rpc.permissions.getMode()); active();
          requireThat(["manual", "assisted", "allow-all"].includes(String(observed.mode))); permissions = observed.mode as CopilotSelection["permissions"];
        }
      } else {
        const mode = selection.permissions === "allow-all" ? "allow-all" : "manual", applied = record(await session.rpc.permissions.setMode({ mode })); active();
        requireThat(applied.success === true && applied.mode === mode); permissions = mode;
      }
      const required = record(await session.rpc.permissions.setRequired({ required: true })); active(); requireThat(required.success === true);
      let observed: CopilotSelection = { kind: "copilot", model, providerId: this.#options.provider.id, ...(typeof current.reasoningEffort === "string" || current.reasoningEffort === null ? { effort: current.reasoningEffort } : {}), ...(permissions === undefined ? {} : { permissions }) };
      if (resumed && session.rpc.mode.get) {
        const mode = record(await session.rpc.mode.get()); active(); requireThat(["interactive", "plan", "autopilot"].includes(String(mode.mode)));
        observed = { ...observed, mode: mode.mode as NonNullable<CopilotSelection["mode"]> };
      } else if (!resumed && selection.mode !== undefined) {
        const applied = record(await session.rpc.mode.set({ mode: selection.mode })); active(); requireThat(applied.modeApplied === true && applied.modelChanged === false && !applied.confirmation && !applied.deferImplementation);
        observed = { ...observed, mode: selection.mode };
      }
      if (this.#selection!.snapshot().revision === 0) this.#selection!.observe(observed);
      return this.#selection!.snapshot().selection;
    } };
  }
  async #loginNative(run: RunRef, session: CopilotSession, command: Extract<NativeControlCommand, { type: 'copilot.mcp.login' }>) {
    this.assertActive(run);
    if (this.#options.mcpOAuthTokenStorage === 'persistent') return { status: 'refused' as const, detail: { reason: 'unsupportedCredentialScope' } };
    if (!('originalId' in command)) return { status: 'refused' as const, detail: { reason: 'originalIdentityRequired' } };
    const transport = this.#mcpTransports?.[command.serverName];
    if ((transport !== 'http' && transport !== 'sse') || !session.rpc.mcp.oauth?.login) return { status: 'refused' as const, detail: { reason: 'unsupportedMcpServer' } };
    let attempt: LoginAttempt;
    try { attempt = this.#login.begin(run, command.originalId, command.serverName); }
    catch (error) { if (error instanceof SessionError && (error.code === 'BUSY' || error.code === 'FULL')) return { status: 'refused' as const, detail: { reason: 'loginAlreadyOwned' } }; throw error; }
    try {
      const result = record(await session.rpc.mcp.oauth.login({ serverName: command.serverName, ...(command.forceReauth === undefined ? {} : { forceReauth: command.forceReauth }) }));
      this.assertActive(run); this.#login.ready(attempt, result.authorizationUrl);
      // A manual flow's generic connected event has no attempt identity.
      return { status: 'acknowledged' as const, detail: { login: result.authorizationUrl === undefined ? 'reused' : 'initiated' } };
    } catch { this.#login.unknown(attempt); throw new SessionError('IO'); }
  }
  async mcpLoginLink(run: RunRef, originalId: string): Promise<McpLoginLink> { this.assertActive(run); return this.#login.lookup(run, originalId); }
  protected override retireTransient(): void { this.#login.retire(); }
  protected override async readNative(run: RunRef, request: NativeRead): Promise<NativeReadResult> {
    const session = this.#session; if (!session) throw new SessionError("FENCED");
    let value: unknown;
    if (request.type === "copilot.queue" && session.rpc.queue) value = await session.rpc.queue.pendingItems();
    else if (request.type === "copilot.tasks" && session.rpc.tasks) {
      // Refresh touches detached-shell metadata only. It neither starts native
      // work nor waits for tasks/continuations to complete.
      await session.rpc.tasks.refresh(); this.assertActive(run); value = await session.rpc.tasks.list();
    } else if (request.type === "copilot.task.progress" && session.rpc.tasks) value = await session.rpc.tasks.getProgress({ id: request.id });
    else if (request.type === "copilot.task.promotable" && session.rpc.tasks) value = await session.rpc.tasks.getCurrentPromotable();
    else throw new SessionError("UNSUPPORTED");
    return nativeReadResult(run, request, value);
  }
  #agent(event: CopilotEvent): string | undefined {
    const envelope = event.agentId, legacy = event.data.agentId;
    const valid = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024;
    if (Object.hasOwn(event, "agentId") && !valid(envelope) || Object.hasOwn(event.data, "agentId") && !valid(legacy) || envelope !== undefined && legacy !== undefined && envelope !== legacy) {
      // Refusing this event must not turn a later session-only SDK closure into
      // apparent root ownership merely because no child was safely admitted.
      this.#childIdentityUncertain = true; throw new SessionError("FENCED", "Native child identity conflicts");
    }
    return envelope ?? (typeof legacy === "string" ? legacy : undefined);
  }
  #owner(event: CopilotEvent): Readonly<{ nativeAgent: string; relation: "root" | "child" }> {
    const run = this.current()!.run, child = this.#agent(event);
    if (typeof child === "string") { requireThat(this.#children.has(child)); return { nativeAgent: child, relation: "child" }; }
    requireThat(!event.data.parentToolCallId); return { nativeAgent: run.nativeSession, relation: "root" };
  }
  #event(event: CopilotEvent, capture = true): void {
    try {
      const binding = this.current(); requireThat(binding); const data = event.data, agent = this.#agent(event);
      if (["subagent.started", "subagent.completed", "subagent.failed"].includes(event.type)) {
        if (typeof agent !== "string" || typeof data.toolCallId !== "string" || data.toolCallId.length === 0 || data.toolCallId.length > 1024) {
          this.#childIdentityUncertain = true; throw new SessionError("FENCED", "Native child task identity is unavailable");
        }
        if (event.type === "subagent.started") {
          requireThat(this.#children.has(agent) || this.#children.size < 31);
          const active = this.#activeChildren.get(agent);
          if (active !== undefined && active !== data.toolCallId) { this.#childIdentityUncertain = true; throw new SessionError("FENCED", "Native child task identity overlaps"); }
          this.#children.add(agent); this.#activeChildren.set(agent, data.toolCallId);
        } else {
          requireThat(this.#children.has(agent));
          // A resumed instance may reuse agentId with a new spawning task.
          // An older terminal cannot retire that newer active instance.
          if (this.#activeChildren.get(agent) === data.toolCallId) this.#activeChildren.delete(agent);
        }
      }
      const root = this.#owner(event).relation === "root";
      if (root && ["session.usage_checkpoint", "session.shutdown"].includes(event.type)) {
        const checkpoint = copilotCheckpoint(data.totalNanoAiu, event.timestamp);
        if (checkpoint) this.native({ type: "copilot.usage", run: binding.run, ...checkpoint });
      }
      if (root && ["session.mcp_servers_loaded", "session.mcp_server_status_changed", "session.mcp_server_needs_reconnect", "mcp.tools.list_changed"].includes(event.type)) this.mcpChanged(binding.run);
      if (root && ["pending_messages.modified", "session.background_tasks_changed", "session.compaction_start", "session.compaction_complete"].includes(event.type)) this.native({ type: "nativeState", run: binding.run });
      const selected = this.#selection?.copilotEvent(root && event.type === "session.model_change" ? { ...event, data: { ...data, providerId: this.#options.provider.id } } : event); if (selected) this.native(selected);
      if (root) this.#projectAttention(this.#attention.observe(event, { active: this.#activeChildren.size, complete: !this.#childIdentityUncertain }));
      if (event.type === "permission.requested" && !data.resolvedByHook) {
        requireThat(typeof data.requestId === "string" && data.permissionRequest && this.#session);
        const owner = this.interactions(binding.run), nativeOwner = this.#owner(event), key = JSON.stringify([nativeOwner.nativeAgent, data.requestId]), session = this.#session;
        requireThat(this.#permissions.size < 128 || this.#permissions.has(key));
        const prompt = owner.registerCopilot({ token: {}, requestId: data.requestId, owner: nativeOwner, method: "permission", payload: data.permissionRequest,
          respond: async value => { const response = await session.rpc.permissions.handlePendingPermissionRequest({ requestId: data.requestId as string, result: value }); requireThat(typeof response.success === "boolean"); return { kind: "ack", success: response.success }; } });
        this.#permissions.set(key, { capability: prompt.id, reused: this.#permissions.has(key) });
      }
      if (event.type === "permission.completed" && typeof data.requestId === "string") {
        const nativeOwner = this.#owner(event), key = JSON.stringify([nativeOwner.nativeAgent, data.requestId]), lineage = this.#permissions.get(key);
        if (lineage?.capability) {
          if (lineage.reused) this.gap();
          else { this.interactions(binding.run).completed(lineage.capability, binding.run); lineage.capability = null; }
        }
      }
      if (capture) this.capture(event);
    } catch { this.gap(); }
  }
  protected override observationGap(): void { this.#projectAttention(this.#attention.invalidate()); }
  #projectAttention(value: ReturnType<CopilotAttention["observe"]>): void {
    const run = this.current()?.run; if (!run) return;
    if (value.attention) this.native({ type: "attention", run, attention: value.attention });
    if (value.activity) this.native({ type: "activity", run, activity: value.activity });
  }
  #callback(method: Exclude<CopilotMethod, "permission">, request: unknown, invocation: CopilotInvocation, generation: number): Promise<Json> {
    let resolve!: (value: Json) => void; const response = new Promise<Json>(done => { resolve = done; });
    try {
      if (this.current() && this.current()!.run.generation > generation) return response;
      requireThat(++this.#callbacks <= 128); const fixed = payload(method, request); canonical(fixed, 65536);
      const sessionId = invocation.sessionId;
      this.stage(fixed, frozen => {
        try {
          const binding = this.current(); if (binding && binding.run.generation !== generation) return;
          requireThat(binding && sessionId === binding.run.nativeSession && this.#activeChildren.size === 0 && !this.#childIdentityUncertain);
          this.interactions(binding.run).registerCopilot({ token: {}, requestId: null, owner: { nativeAgent: binding.run.nativeSession, relation: "root" }, method, payload: frozen,
            respond: async value => { resolve(value); return { kind: "submitted" }; } });
          // Pinned SDK strips native request IDs. Callback return proves only
          // submitted; history/idle/model text cannot invent native settlement.
        } catch { this.gap(); }
      });
    } catch { this.gap(); }
    return response;
  }
}
export const createCopilotController = (options: CopilotControllerOptions): CopilotController => new CopilotController(options);
