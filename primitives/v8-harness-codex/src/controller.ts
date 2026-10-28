import { codexProtocol, codexDefaults } from "./protocol.js";
import { codexHistory } from "./history.js";
import { SessionError, sameRun, type McpLoginLink, type NativeRead, type NativeReadResult, type Catalog, type CodexAccess, type CodexEncodedInput, type CodexSelection, type Json, type NativeRun, type NativeStart, type NativeSendCommand, type RunRef } from "../../v8-session/src/contracts/types.js";
import { canonical, copy } from "../../v8-session/src/contracts/validation.js";
import { createCodexInvocation } from "./invocation.js";
import { nativeReadResult } from "../../v8-harness-defaults/src/state.js";
import { SelectionOwner } from "../../v8-harness-defaults/src/selection.js";
import { requireThat } from "../../v8-runtime/src/validation.js";
import { codexMcpReadPort } from "../../v8-mcp/src/native.js";
import type { McpTransports } from "../../v8-mcp/src/contracts.js";
import { LoginLinks, type LoginAttempt } from "../../v8-mcp/src/login.js";
import type { Delivery } from "../../v8-interactions/src/contracts.js";
import type { CodexMethod } from "../../v8-interactions/src/native.js";
import type { TrustedContainment } from "../../v8-host/src/contracts.js";
import { Controller } from "../../v8-host/src/controller.js";
import { codexThreadMetadata, identity as nativeId, type CodexThreadMetadata } from "../../v8-history/src/native/codex/lineage.js";
import { prepareCodexImage } from "../../v8-files/src/native/images.js";
import { projectCodexMediaNotification } from "../../v8-host/src/native-media.js";
import { CodexAttention } from "./attention.js";
import { codexOpeningAccess } from './access.js';

import type { CodexOpenParams, CodexRequests, CodexInvocationRpc } from "./request-contract.js";
export type { CodexOpenParams, CodexNativeInput, CodexRequests } from "./request-contract.js";
export type CodexNotification = Readonly<{ method: string; params?: unknown }>;
/** Original transport capability. settled must refer to THIS reverse request's
 * native resolution, not a mutable map lookup by a reused vendor ID. */
export type CodexReverseRequest = Readonly<{
  id: string | number; method: CodexMethod; params: unknown; token: object;
  respond(value: Json): Promise<Delivery>; settled: Promise<void>;
}>;
export interface CodexTransport {
  request<M extends keyof CodexRequests>(method: M, params: CodexRequests[M]): Promise<unknown>;
  onNotification(listener: (message: CodexNotification) => void): () => void;
  onRequest(listener: (request: CodexReverseRequest) => void): () => void;
  onDisconnect?(listener: () => void): () => void;
}
export interface CodexControllerOptions {
  transport: CodexTransport; containment: TrustedContainment; cwd: string; model: string;
  /** Private static provider choice; never a client/native JSON escape hatch. */
  provider: Readonly<{ id: string; copilotOnly: boolean }>;
  catalog: () => Promise<Catalog>;
  developerInstructions?: string;
  encodeSandbox?: (access: CodexAccess) => Json;
  /** Trusted static configuration; concrete runtime uses per-session file store. */
  mcpTransports?: McpTransports;
}
function record(value: unknown): Record<string, unknown> { requireThat(value && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
const methods: readonly CodexMethod[] = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request"];
type LiveNode = { parent: string | null; context?: string; closed: boolean };
type LiveProof = Readonly<{ type: "metadata"; value: CodexThreadMetadata }> | Readonly<{ type: "activity"; parent: string; child: string }>;

export class CodexController extends Controller {
  readonly historyFacet = codexHistory;
  readonly protocol = codexProtocol;
  readonly #options: CodexControllerOptions; readonly #lineage = new Map<string, LiveNode>(); readonly #blocked = new Set<string>(); readonly #proofs: LiveProof[] = [];
  readonly #waiting: CodexReverseRequest[] = []; readonly #attention = new CodexAttention(); #selection: SelectionOwner<"codex"> | undefined;
  readonly #login = new LoginLinks();
  constructor(options: CodexControllerOptions) {
    super("codex", options.containment, options.catalog, ["send", "answer", "codex.continue", "codex.defaults", "codex.turn", "codex.interrupt", "codex.queue.add", "codex.steer", "codex.compact", "codex.goal.set", "codex.goal.clear", "codex.terminal.terminate", "codex.terminals.clean", "codex.mcp.reload", ...(Object.values(options.mcpTransports ?? {}).includes('http') ? ['codex.mcp.login' as const] : [])], ["codex.goal", "codex.terminals"]); this.#options = options;
    this.cleanups.push(options.transport.onNotification(message => {
      try {
        if (message.method === 'mcpServer/oauthLogin/completed') {
          const params = record(message.params);
          // Raw native auth errors/URLs must never reach history capture.
          this.stageObservation({ method: message.method, params: { name: params.name, threadId: params.threadId, loginId: params.loginId, success: params.success } }, frozen => this.#notification(frozen as CodexNotification, false)); return;
        }
        const projection = projectCodexMediaNotification(message);
        if (projection) this.stageMedia(message, projection, frozen => this.#notification(frozen as CodexNotification, false));
        else this.stageObservation(message, frozen => this.#notification(frozen as CodexNotification));
      } catch { this.observationLost(); }
    }));
    this.cleanups.push(options.transport.onRequest(request => {
      const token = request.token, respond = request.respond.bind(request), settled = request.settled;
      this.stage({ id: request.id, method: request.method, params: request.params }, frozen => {
        const data = frozen as Pick<CodexReverseRequest, "id" | "method" | "params">; this.#request({ ...data, token, respond, settled });
      });
    }));
    if (options.transport.onDisconnect) this.cleanups.push(options.transport.onDisconnect(() => this.controllerLost()));
  }
  async openNative(input: NativeStart) {
    requireThat(input.policy.kind === "codex" && (input.policy.provider !== "copilot-only" || this.#options.provider.copilotOnly));
    const selected = codexDefaults(input.policy, input.selection); requireThat(selected.kind === "codex" && selected.access);
    const model = selected.collaboration?.model ?? selected.model ?? this.#options.model, access = selected.access;
    const shared: CodexOpenParams = { model, modelProvider: this.#options.provider.id, cwd: this.#options.cwd, ...codexOpeningAccess(access), ...(this.#options.developerInstructions ? { developerInstructions: this.#options.developerInstructions } : {}) };
    const result = record(input.nativeSession === null
      ? await this.#options.transport.request("thread/start", { ...shared, ephemeral: false })
      : await this.#options.transport.request("thread/resume", { ...shared, threadId: input.nativeSession, excludeTurns: true }));
    const thread = record(result.thread); requireThat(typeof thread.id === "string" && thread.id.length > 0 && (input.nativeSession === null || thread.id === input.nativeSession));
    const run: RunRef = { scope: input.scope, generation: input.generation, nativeSession: thread.id };
    this.#login.reset(run);
    this.#selection = new SelectionOwner("codex", run, { kind: "codex" });
    this.#lineage.clear(); this.#blocked.clear(); this.#proofs.splice(0); this.#lineage.set(thread.id, { parent: null, closed: false }); this.#waiting.splice(0); this.#attention.reset();
    const rpc: CodexInvocationRpc = (method, params) => {
      this.assertActive(run); return this.#options.transport.request(method, params);
    };
    const compiledInvoke: NativeRun["invoke"] = createCodexInvocation({ run, rpc, reloadMcp: () => { this.assertActive(run); this.mcpChanged(run); return this.#options.transport.request("config/mcpServer/reload", undefined); }, encodeInputs: async (input: NativeSendCommand<"codex">["nativeInputs"]): Promise<readonly CodexEncodedInput[]> => {
      requireThat(input.kind === "codex");
      const scope = { connection: run.scope.connection, principal: run.scope.principal, host: run.scope.host, session: run.nativeSession };
      return Promise.all(input.items.map(async (item): Promise<CodexEncodedInput> => item.type === "image" ? prepareCodexImage({ harness: "codex", scope, artifact: item.artifact, bytes: item.bytes }) : item.type === "localImage" ? { type: "localImage", path: item.path } : { type: "mention", name: item.name, path: item.path }));
    }, currentSelection: () => this.#selection!.snapshot().selection, ...(this.#options.encodeSandbox ? { encodeSandbox: this.#options.encodeSandbox } : {}) });
    const invoke: NativeRun["invoke"] = command => {
      if (command.type === 'codex.mcp.login') return this.#loginNative(run, command);
      return compiledInvoke(command);
    };

    return { run, selection: { kind: "codex" as const }, invoke, mcp: codexMcpReadPort(this.#options.transport, "session-originals"), initialize: async (active: () => void) => {
      active();
      requireThat(result.model === model && result.modelProvider === this.#options.provider.id && result.approvalPolicy === access.approval);
      const sandbox = record(result.sandbox), activeProfile = result.activePermissionProfile == null ? undefined : record(result.activePermissionProfile);
      if (access.profile !== undefined) requireThat(activeProfile?.id === access.profile, "Native permission profile differs");
      else requireThat(sandbox.type === ({ "danger-full-access": "dangerFullAccess", "workspace-write": "workspaceWrite", "read-only": "readOnly" } as const)[access.sandbox]);
      // Native profile provenance wins over its legacy sandbox approximation.
      // Requested settings and native acknowledgements never manufacture it.
      const observedAccess = activeProfile ? { approval: result.approvalPolicy, profile: activeProfile.id } : { approval: result.approvalPolicy, sandbox: access.sandbox };
      const mode = result.collaborationMode == null ? undefined : record(result.collaborationMode), settings = mode ? record(mode.settings) : undefined;
      const observed = codexProtocol.selection({ kind: "codex", model, access: observedAccess, ...(typeof result.reasoningEffort === "string" || result.reasoningEffort === null ? { effort: result.reasoningEffort } : {}),
        ...(mode && settings ? { collaboration: { mode: mode.mode, model: settings.model, effort: settings.reasoning_effort,
          ...(settings.developer_instructions === undefined ? {} : { instructions: settings.developer_instructions }) } } : {}) }) as CodexSelection;
      // Buffered native settings may already be newer than thread/start's
      // response. Validate the response without rolling those facts back.
      if (this.#selection!.snapshot().revision === 0) this.#selection!.observe(observed);
      if (input.nativeSession === null && (selected.collaboration !== undefined || selected.effort !== undefined)) {
        // Native creation has no initial effort/collaboration fields. Apply the
        // closed settings RPC only after durable native-ID custody. A fresh
        // effort-only selection deliberately chooses built-in default mode.
        const collaboration = selected.collaboration ?? { mode: "default" as const, model, effort: selected.effort!, instructions: null };
        const settings = { threadId: run.nativeSession,
          ...(selected.effort === undefined ? {} : { effort: selected.effort }),
          collaborationMode: { mode: collaboration.mode, settings: { model: collaboration.model, reasoning_effort: collaboration.effort, developer_instructions: collaboration.instructions ?? null } } };
        const acknowledgement = record(await this.#options.transport.request("thread/settings/update", settings)); active();
        requireThat(Object.keys(acknowledgement).length === 0, "Invalid Codex initial settings acknowledgement");
      }
      // An ACK establishes submission, not observed selection. A native
      // settings notification received during the substep is authoritative.
      return this.#selection!.snapshot().selection;
    } };
  }
  async #loginNative(run: RunRef, command: Extract<import('../../v8-session/src/contracts/types.js').NativeControlCommand, { type: 'codex.mcp.login' }>) {
    this.assertActive(run);
    if (!('originalId' in command)) return { status: 'refused' as const, detail: { reason: 'originalIdentityRequired' } };
    if (this.#options.mcpTransports?.[command.serverName] !== 'http') return { status: 'refused' as const, detail: { reason: 'unsupportedMcpServer' } };
    let attempt: LoginAttempt;
    try { attempt = this.#login.begin(run, command.originalId, command.serverName); }
    catch (error) { if (error instanceof SessionError && (error.code === 'BUSY' || error.code === 'FULL')) return { status: 'refused' as const, detail: { reason: 'loginAlreadyOwned' } }; throw error; }
    try {
      const result = record(await this.#options.transport.request('mcpServer/oauth/login', { name: command.serverName, threadId: run.nativeSession, timeoutSecs: 120 }));
      this.assertActive(run); requireThat(typeof result.loginId === 'string' && typeof result.authorizationUrl === 'string');
      this.#login.ready(attempt, result.authorizationUrl, result.loginId);
      return { status: 'acknowledged' as const, detail: { login: 'initiated' } };
    } catch { this.#login.unknown(attempt); throw new SessionError('IO'); }
  }
  async mcpLoginLink(run: RunRef, originalId: string): Promise<McpLoginLink> { this.assertActive(run); return this.#login.lookup(run, originalId); }
  protected override retireTransient(): void { this.#login.retire(); }
  protected override async readNative(run: RunRef, request: NativeRead): Promise<NativeReadResult> {
    if (request.type === "codex.terminals") return nativeReadResult(run, request, await this.#options.transport.request("thread/backgroundTerminals/list", { threadId: run.nativeSession, cursor: request.cursor ?? null, limit: request.limit ?? 100 }));
    if (request.type !== "codex.goal") throw new SessionError("UNSUPPORTED");
    return nativeReadResult(run, request, await this.#options.transport.request("thread/goal/get", { threadId: run.nativeSession }));
  }
  #notification(message: CodexNotification, capture = true): void {
    try {
      const binding = this.current(); if (!binding) return;
      const params = message.params === undefined ? {} : record(message.params), root = params.threadId === binding.run.nativeSession;
      if (message.method === 'mcpServer/oauthLogin/completed') {
        if (root && typeof params.name === 'string' && typeof params.loginId === 'string' && typeof params.success === 'boolean') this.#login.complete(binding.run, params.name, params.loginId, params.success);
        if (root) this.mcpChanged(binding.run); return;
      }
      if ((root || params.threadId === null) && ["mcpServer/startupStatus/updated", "mcpServer/oauthLogin/completed"].includes(message.method)) this.mcpChanged(binding.run);
      const selection = this.#selection?.codexEvent(message); if (selection) this.native(selection);
      if (root && ["thread/goal/updated", "thread/goal/cleared", "thread/compacted"].includes(message.method)) this.native({ type: "nativeState", run: binding.run });
      const item = params.item && typeof params.item === "object" ? record(params.item) : null;
      if (message.method === "thread/started") this.#remember({ type: "metadata", value: codexThreadMetadata(params.thread) });
      if (["item/started", "item/completed"].includes(message.method) && item?.type === "subAgentActivity" && item.kind === "started") {
        const parent = nativeId(params.threadId), child = nativeId(item.agentThreadId);
        requireThat(parent && child && nativeId(params.turnId) && nativeId(item.id) && typeof item.agentPath === "string" && new TextEncoder().encode(item.agentPath).length <= 65536);
        this.#remember({ type: "activity", parent, child });
      }
      if (message.method === "thread/closed" && typeof params.threadId === "string") { const node = this.#lineage.get(params.threadId); if (node) node.closed = true; this.#pruneClosed(); }
      if (root) this.#projectAttention(this.#attention.observe(message.method, params));
    } catch { this.observationLost(); }
    finally { if (capture) this.capture(message); }
  }
  protected override observationGap(): void { this.#projectAttention(this.#attention.invalidate()); }
  #projectAttention(value: ReturnType<CodexAttention["observe"]>): void {
    const run = this.current()?.run; if (!run) return;
    if (value.attention) this.native({ type: "attention", run, attention: value.attention });
    if (value.activity) this.native({ type: "activity", run, activity: value.activity });
  }
  #owned(id: string): boolean { const node = this.#lineage.get(id); return !!node && !node.closed && !this.#blocked.has(id); }
  #pruneClosed(): void {
    const run = this.current()?.run;
    const pending = new Set(run ? this.interactions(run).current().items.map(item => item.prompt.owner.nativeAgent) : []);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, node] of this.#lineage) {
        // Retained callbacks and descendant chains keep their exact node. This
        // retires only live-routing capacity, never captured history or an answer.
        if (node.parent === null || !node.closed || pending.has(id) || [...this.#lineage.values()].some(child => child.parent === id)) continue;
        this.#lineage.delete(id); changed = true;
      }
    }
  }
  #context(value: CodexThreadMetadata): boolean {
    if (!value.parent) return false;
    const allowed = new Set([value.id]), seen = new Set<string>(); let id: string | null = value.parent;
    while (id !== null) { const node = this.#lineage.get(id); if (!node || seen.has(id) || seen.size >= 32) return false; seen.add(id); allowed.add(id); if (node.context) allowed.add(node.context); id = node.parent; }
    return allowed.has(value.context);
  }
  #quarantine(id: string): void {
    const affected = new Set([id]); let changed = true;
    while (changed) { changed = false; for (const [child, node] of this.#lineage) if (node.parent && affected.has(node.parent) && !affected.has(child)) { affected.add(child); changed = true; } }
    for (const child of affected) if (this.#lineage.get(child)?.parent !== null) { this.#lineage.delete(child); this.#blocked.add(child); }
    this.observationLost();
    const run = this.current()?.run;
    if (run && this.interactions(run).current().items.some(item => affected.has(item.prompt.owner.nativeAgent))) this.gap();
  }
  #apply(proof: LiveProof): boolean {
    const child = proof.type === "metadata" ? proof.value.id : proof.child, previous = this.#lineage.get(child);
    let existing = previous;
    if (this.#blocked.has(child)) return true;
    if (proof.type === "metadata" && existing?.parent === null) { existing.context = proof.value.context; return true; }
    const parent = proof.type === "metadata" ? proof.value.parent : proof.parent;
    if (proof.type === "metadata" && existing && (existing.parent !== parent || existing.context !== undefined && existing.context !== proof.value.context)) { this.#quarantine(child); return true; }
    if (!parent || !this.#owned(parent)) return false;
    if (parent === child || existing?.parent === null) { this.observationLost(); return true; }
    if (existing && (existing.parent !== parent || proof.type === "metadata" && existing.context !== undefined && existing.context !== proof.value.context)) { this.#quarantine(child); return true; }
    if (proof.type === "metadata" && !this.#context(proof.value)) { if (existing) this.#quarantine(child); else this.observationLost(); return true; }
    if (existing?.closed) {
      // Do not substitute a new ancestor underneath an existing descendant.
      if ([...this.#lineage.values()].some(node => node.parent === child)) { this.observationLost(); return true; }
      existing = undefined;
    }
    requireThat(previous || this.#lineage.size + this.#blocked.size < 32, "Bounded live native ancestry is full");
    const node = existing ?? { parent, closed: false }; if (proof.type === "metadata") node.context = proof.value.context; this.#lineage.set(child, node); return true;
  }
  #remember(proof: LiveProof): void {
    // A retained proof awaiting its parent has lost no observation. Overflow
    // and contradictory proof still reach the existing strict loss boundary.
    if (!this.#apply(proof)) { requireThat(this.#proofs.length < 8); this.#proofs.push(proof); }
    let changed = true;
    while (changed) { changed = false; for (let index = 0; index < this.#proofs.length;) { if (this.#apply(this.#proofs[index]!)) { this.#proofs.splice(index, 1); changed = true; } else index++; } }
    for (let index = 0; index < this.#waiting.length;) { if (this.#owned(String(record(this.#waiting[index]!.params).threadId))) this.#request(this.#waiting.splice(index, 1)[0]!); else index++; }
  }
  #request(request: CodexReverseRequest): void {
    try {
      requireThat(methods.includes(request.method) && (typeof request.id === "string" || Number.isSafeInteger(request.id)) && request.token && typeof request.token === "object");
      const binding = this.current(); requireThat(binding); const params = record(request.params); canonical(params, 65536);
      const agent = nativeId(params.threadId); requireThat(agent);
      if (!this.#owned(agent)) { requireThat(!this.#lineage.get(agent)?.closed && !this.#blocked.has(agent) && this.#waiting.length < 8); this.#waiting.push(request); this.gap(); return; }
      const node = this.#lineage.get(agent)!;
      const owner = this.interactions(binding.run), prompt = owner.registerCodex({ token: request.token, requestId: JSON.stringify(request.id), owner: { nativeAgent: agent, relation: agent === binding.run.nativeSession ? "root" : "child" }, method: request.method, params, respond: value => { requireThat(this.current() && sameRun(this.current()!.run, binding.run) && this.#lineage.get(agent) === node && this.#owned(agent), "Original native callback ancestry is no longer owned"); return request.respond(value); } });
      void request.settled.then(() => {
        owner.completed(prompt.id, binding.run);
        if (this.current() && sameRun(this.current()!.run, binding.run)) this.#pruneClosed();
      }, () => owner.gap()).catch(() => owner.gap());
    } catch { this.gap(); }
  }
}
export const createCodexController = (options: CodexControllerOptions): CodexController => new CodexController(options);
