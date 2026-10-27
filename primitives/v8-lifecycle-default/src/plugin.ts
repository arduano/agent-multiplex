import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { HarnessDefinition, HostActivationContext, HostContext, PluginIdentity, UpdateReadiness } from "../../v8-plugins/src/contracts.js";
import { hostProcedure, hostRouter, originalId } from "../../v8-plugins/src/router.js";
import type { HostController, HostHistory, HostModelCatalog } from "../../v8-host/src/contracts.js";
import { SessionError, scopeKey, type Catalog, type CopilotUsage, type SessionAttention, type Harness, type ManagedPolicy, type Receipt, type Selection, type SelectionFor, type SessionScope, type SessionSnapshot, type Submit } from "../../v8-session/src/contracts/types.js";
import { canonical, copy, id, scope as validateScope } from "../../v8-session/src/contracts/validation.js";
import { validateCatalog } from "../../v8-session/src/native/validation.js";
import type { NativeProtocol } from "../../v8-session/src/contracts/native-protocol.js";
import { AgentHost, type HostOptions } from "./assembly.js";
import { CreationRegistry, type CreationRecord } from "./registry.js";
import type { WorkspaceAllocation, WorkspaceRefusal, WorkspaceStrategy } from "./workspace.js";
import type { SessionHost } from "./session/index.js";
import type { ArchivedHistoryContext, SavedSessionFacts } from "./session/receipt-reader.js";

export const defaultLifecycleIdentity = { id: "multiplex.default-lifecycle", version: 1, recordVersion: 1 } as const;
export type { HostModelCatalog } from "../../v8-host/src/contracts.js";
export interface NativeHarnessDefinition<K extends Harness = Harness> extends HarnessDefinition {
  readonly nativeKind: K;
  readonly protocol: NativeProtocol;
  /** Inert factory; reading metadata never creates or resumes a conversation. */
  modelCatalog?(context: { directory: string }): HostModelCatalog;
  create(context: { scope: SessionScope; directory: string; cwd: string; modelCatalog?: () => Promise<Catalog> }): Promise<{ controller: HostController; history?: HostHistory; nativeInputRoots?: readonly string[]; close?: () => Promise<void> }>;
}
export interface DefaultLifecycleOptions<Input extends z.ZodType, Data extends z.ZodType, K extends Harness = Harness> {
  harness: NativeHarnessDefinition<K>; workspace: WorkspaceStrategy<Input, Data>;
  directory: string; policy: ManagedPolicy; observationMs?: number; maxSessions?: number;
  files?: HostOptions["files"];
}
const sessionId = z.string().min(1).max(256);
const scopeInput = z.object({ session: sessionId }).strict();
const receiptSchema = z.custom<Receipt>(value => !!value && typeof value === "object");
const noAllocation = (value: unknown): value is WorkspaceRefusal => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 2 &&
  Object.hasOwn(value, "state") && Object.hasOwn(value, "noAllocation") && (value as { state: unknown }).state === "refused" && (value as { noAllocation: unknown }).noAllocation === true;
type View<Data> = { id: string; originalId: string; phase: "preparing" | "stopping" | "stopped" | "native" | "unobserved"; workspace: { state: CreationRecord["workspace"]; allocation?: WorkspaceAllocation<Data> }; native: SessionSnapshot | null; usage?: CopilotUsage; attention?: SessionAttention; archive?: { id: string; state: "pending" | "complete" } };

/** One explicit Host lifecycle plugin. The kernel only mounts its router. The
 * registry owns pre-native creation/workspace custody; SessionHost owns native
 * dispatch/results. The two phases share one original ID and public receipt. */
export class DefaultLifecycleSessions<Input extends z.ZodType, Data extends z.ZodType> {
  readonly #options: DefaultLifecycleOptions<Input, Data>;
  readonly #context: HostActivationContext;
  readonly #registry: CreationRegistry;
  readonly #records = new Map<string, CreationRecord>();
  readonly #committed = new Map<string, CreationRecord>();
  readonly #hosts = new Map<string, Promise<AgentHost>>();
  readonly #opened = new Map<string, AgentHost>();
  readonly #runtimes = new Map<string, ReturnType<NativeHarnessDefinition["create"]>>();
  readonly #snapshots = new Map<string, SessionSnapshot>();
  /** Cold projection only; the exact-owned journal remains the fact owner. */
  readonly #retainedFacts = new Map<string, SavedSessionFacts>();
  readonly #listeners = new Map<string, Set<(view: View<z.output<Data>>) => void>>();
  readonly #hostListeners = new Set<{ context: HostContext | undefined; listener: (views: View<z.output<Data>>[]) => void }>();
  readonly #actual = new Set<Promise<unknown>>();
  readonly #creations = new Map<string, { hash: string; promise: Promise<Receipt>; admission: Promise<void> }>();
  readonly #detach: (() => void)[] = [];
  #modelCatalog: HostModelCatalog | undefined;
  #closing = false; #closed = false; #closeFailure: unknown; #admissionSealed = false;
  private constructor(options: DefaultLifecycleOptions<Input, Data>, context: HostActivationContext, registry: CreationRegistry) { this.#options = options; this.#context = context; this.#registry = registry; }
  static async open<I extends z.ZodType, D extends z.ZodType>(options: DefaultLifecycleOptions<I, D>, context: HostActivationContext): Promise<DefaultLifecycleSessions<I, D>> {
    if (!isAbsolute(options.directory)) throw new SessionError("INVALID");
    const registry = await CreationRegistry.open(options.directory, { lifecycle: defaultLifecycleIdentity, harness: options.harness.identity, workspace: options.workspace.identity }, options.maxSessions ?? 128, { host: context.route.host, owner: context.route.owner });
    const owner = new DefaultLifecycleSessions(options, context, registry);
    try { for (const record of await registry.call<CreationRecord[]>("list", {})) { if (record.scope.host !== context.route.host) throw new SessionError("FENCED"); owner.#records.set(scopeKey(record.scope), record); owner.#committed.set(scopeKey(record.scope), structuredClone(record));
      if (record.nativeAttempted) {
        const facts = await registry.call<SavedSessionFacts | null>("native.facts", { key: scopeKey(record.scope) });
        if (facts) owner.#retainedFacts.set(scopeKey(record.scope), facts);
      }
    } return owner; }
    catch (error) { await registry.terminate(); throw error; }
  }
  #originalKey(scope: SessionScope, original: string): string { return canonical([scope.connection, scope.principal, scope.host, original]); }
  #directory(scope: SessionScope): string { return join(this.#options.directory, "sessions", createHash("sha256").update(scopeKey(scope)).digest("hex")); }
  #active(): void { if (this.#closed || this.#closing) throw new SessionError("CLOSED"); }
  #scope(scope: SessionScope): void { this.#active(); validateScope(scope); if (scope.host !== this.#context.route.host) throw new SessionError("FENCED"); }
  scope(context: HostContext, session: string): SessionScope {
    this.#active(); id(session);
    if (context.route.host !== this.#context.route.host || context.route.owner !== this.#context.route.owner || context.route.authority !== this.#context.route.authority || context.route.routeEpoch !== this.#context.route.routeEpoch || context.session && context.session.id !== session) throw new SessionError("FENCED");
    const scope = { connection: context.identity.connection, principal: context.identity.principal, host: context.route.host, session }; validateScope(scope); return scope;
  }
  #own<T>(work: Promise<T>): Promise<T> { this.#actual.add(work); void work.finally(() => this.#actual.delete(work)).catch(() => {}); return work; }
  /** Explicit Host query and session preflight reuse the same metadata owner. */
  modelCatalog(context?: HostContext): Promise<Catalog> {
    this.#active();
    if (this.#admissionSealed) throw new SessionError("CLOSED");
    if (context && (!context.identity.actions.includes("read") || context.session ||
      context.route.host !== this.#context.route.host || context.route.owner !== this.#context.route.owner ||
      context.route.authority !== this.#context.route.authority || context.route.routeEpoch !== this.#context.route.routeEpoch)) throw new SessionError("FENCED");
    if (!this.#options.harness.modelCatalog) return Promise.resolve({ available: false, choices: [] });
    this.#modelCatalog ??= this.#options.harness.modelCatalog({ directory: join(this.#options.directory, "model-catalog") });
    return this.#own(this.#modelCatalog.read().then(value => { this.#active(); return validateCatalog(value); }));
  }
  /** Reusable StopAll boundary, also available after a failed metadata read. */
  async retireModelCatalog(): Promise<void> {
    this.#active();
    if (this.#modelCatalog) await this.#own(this.#modelCatalog.retire());
  }
  #record(scope: SessionScope): CreationRecord { this.#scope(scope); const record = this.#records.get(scopeKey(scope)); if (!record) throw new SessionError("FENCED"); return record; }
  async #save(record: CreationRecord): Promise<void> { const committed = structuredClone(record); await this.#registry.call("put", { record: committed }); this.#committed.set(scopeKey(record.scope), committed); this.#publish(committed); }
  #view(record: CreationRecord): View<z.output<Data>> {
    record = this.#committed.get(scopeKey(record.scope)) ?? record;
    const native = this.#snapshots.get(scopeKey(record.scope)) ?? null;
    // Live facts already belong to native. Duplicating those objects in the
    // DTO would also violate the pinned Peer codec's tree contract.
    const facts = native ? undefined : this.#retainedFacts.get(scopeKey(record.scope));
    const phase = record.retired ? "stopped" : native ? "native" : record.stopped ? "stopping" : record.nativeAttempted ? "unobserved" : "preparing";
    const archive = native?.archive ?? (record.archive ? { id: record.archive.id, state: record.archive.state === "acknowledged" ? "complete" as const : "pending" as const } : undefined);
    return copy({ id: record.scope.session, originalId: record.id, phase, workspace: { state: record.workspace, ...(record.allocation ? { allocation: record.allocation as WorkspaceAllocation<z.output<Data>> } : {}) }, native, ...facts, ...(archive ? { archive } : {}) });
  }
  #publish(record: CreationRecord): void {
    for (const listener of this.#listeners.get(scopeKey(record.scope)) ?? []) try { listener(this.#view(record)); } catch { /* View cannot own execution. */ }
    for (const { listener, context } of this.#hostListeners) try { listener(this.list(context)); } catch { /* View cannot own execution. */ }
  }
  hostData(context?: HostContext): { sessionCount: number; workspaceStrategy: string } { this.#active(); return { sessionCount: [...this.#records.values()].filter(record => !context || record.scope.connection === context.identity.connection && record.scope.principal === context.identity.principal).length, workspaceStrategy: this.#options.workspace.identity.id }; }
  /** Committed discovery only. Cold native custody stays unobserved until an
   * explicit session observation; listing never constructs an adapter. */
  list(context?: HostContext): View<z.output<Data>>[] {
    this.#active();
    if (context && (context.route.host !== this.#context.route.host || context.route.owner !== this.#context.route.owner || context.route.authority !== this.#context.route.authority || context.route.routeEpoch !== this.#context.route.routeEpoch)) throw new SessionError("FENCED");
    return [...this.#committed.values()].filter(record => !context || record.scope.connection === context.identity.connection && record.scope.principal === context.identity.principal && (!context.session || record.scope.session === context.session.id)).map(record => this.#view(record));
  }
  subscribeHost(listener: (views: View<z.output<Data>>[]) => void, context?: HostContext): () => void {
    const initial = this.list(context);
    if (this.#hostListeners.size >= 128) throw new SessionError("FULL");
    const entry = { listener, context }; this.#hostListeners.add(entry);
    try { listener(initial); } catch (error) { this.#hostListeners.delete(entry); throw error; }
    return () => { this.#hostListeners.delete(entry); };
  }
  async view(scope: SessionScope): Promise<View<z.output<Data>>> { const record = this.#record(scope); if (record.nativeAttempted) await this.agent(scope); return this.#view(record); }
  /** Existing owner reference only; no construction, attachment or native read. */
  attached(scope: SessionScope): AgentHost | undefined { this.#scope(scope); return this.#opened.get(scopeKey(scope)); }
  async watch(scope: SessionScope, listener: (view: View<z.output<Data>>) => void): Promise<() => void> {
    this.#scope(scope); const record = this.#records.get(scopeKey(scope)); let listeners = this.#listeners.get(scopeKey(scope));
    if (!listeners) { listeners = new Set(); this.#listeners.set(scopeKey(scope), listeners); }
    if (listeners.size >= 128) throw new SessionError("FULL"); listeners.add(listener);
    try { if (record?.nativeAttempted) await this.agent(scope); this.#active(); if (record) listener(this.#view(record)); }
    catch (error) { listeners.delete(listener); throw error; }
    return () => { listeners!.delete(listener); if (!listeners!.size) this.#listeners.delete(scopeKey(scope)); };
  }
  agent(scope: SessionScope): Promise<AgentHost> {
    const record = this.#record(scope), key = scopeKey(scope), prior = this.#hosts.get(key); if (prior) return prior;
    if (!record.nativeAttempted || !record.allocation) throw new SessionError("FENCED");
    const pending = this.#own((async () => {
      const archived = await this.#registry.call<ArchivedHistoryContext | null>("native.archiveContext", { key }); this.#active();
      if (!archived) {
        if (record.workspace !== "available") throw new SessionError("FENCED");
        const state = await this.#options.workspace.inspect(record.allocation as WorkspaceAllocation<z.output<Data>>); this.#active();
        if (state !== "available") throw new SessionError("FENCED");
      }
      const directory = this.#directory(scope);
      // Retained session/native-home metadata survives workspace release. An
      // archived reader needs an existing launch directory, never a provisioned
      // or fabricated workspace. The FileHost retains its original path policy.
      let construction = this.#runtimes.get(key); if (!construction) { construction = this.#options.harness.create({ scope: copy(scope), cwd: archived ? directory : record.allocation!.cwd, directory,
        ...(this.#options.harness.modelCatalog ? { modelCatalog: () => this.modelCatalog() } : {}) }); this.#runtimes.set(key, construction); }
      const runtime = await construction; this.#active();
      const identity = { lifecycle: { id: defaultLifecycleIdentity.id, recordVersion: defaultLifecycleIdentity.recordVersion }, harness: { id: this.#options.harness.identity.id, recordVersion: this.#options.harness.identity.recordVersion }, workspace: { id: this.#options.workspace.identity.id, recordVersion: this.#options.workspace.identity.recordVersion } };
      const host = await AgentHost.open({ scope, directory, cwd: record.allocation!.cwd, controller: runtime.controller, policy: this.#options.policy, identity,
        archive: { ready: async () => record.allocation!.ownership === "borrowed" || !!this.#options.workspace.release, release: () => this.#releaseWorkspace(record) },
        ...(runtime.history ? { history: runtime.history } : {}), ...(runtime.nativeInputRoots ? { nativeInputRoots: runtime.nativeInputRoots } : {}),
        ...(this.#options.files ? { files: this.#options.files } : {}), ...(this.#options.observationMs ? { observationMs: this.#options.observationMs } : {}) });
      const snapshot = await host.session.snapshot(scope);
      if (archived && (snapshot.phase !== "stopped" || snapshot.nativeSession !== archived.nativeSession || snapshot.generation !== archived.generation || snapshot.archive?.state !== "complete" || snapshot.archive.id !== archived.archiveId)) { await host.close(); throw new SessionError("FENCED"); }
      this.#opened.set(key, host); this.#snapshots.set(key, snapshot); this.#retainedFacts.delete(key);
      this.#detach.push(host.session.subscribe(scope, snapshot => { this.#snapshots.set(key, snapshot); this.#publish(record); }));
      this.#detach.push(host.session.subscribeReceipt(scope, record.id, () => this.#publish(record))); return host;
    })());
    this.#hosts.set(key, pending); void pending.catch(() => { if (this.#hosts.get(key) === pending) this.#hosts.delete(key); }); return pending;
  }
  async session(scope: SessionScope): Promise<Pick<SessionHost, "snapshot" | "submit" | "receipt" | "read" | "mcpLoginLink" | "subscribeReceipt" | "subscribe">> {
    const native = (await this.agent(scope)).session;
    // Native adapter routers pass through this same original owner, including
    // the pre-native Create reservation; exposing the raw writer would bypass it.
    return { snapshot: native.snapshot.bind(native), submit: request => this.submit(request), receipt: (scope, original) => this.original(scope, original), read: native.read.bind(native), mcpLoginLink: native.mcpLoginLink.bind(native), subscribeReceipt: native.subscribeReceipt.bind(native), subscribe: native.subscribe.bind(native) };
  }
  #validateAllocation(value: WorkspaceAllocation<z.output<Data>>): WorkspaceAllocation<z.output<Data>> {
    if (!value || !isAbsolute(value.cwd) || typeof value.id !== "string" || !value.id || value.id.length > 256 || !["borrowed", "owned"].includes(value.ownership)) throw new SessionError("INVALID");
    return { id: value.id, cwd: value.cwd, ownership: value.ownership, data: this.#options.workspace.publicData.parse(value.data) };
  }
  async #releaseWorkspace(record: CreationRecord): Promise<void> {
    if (!record.allocation || record.allocation.ownership === "borrowed" || record.workspace === "released") return;
    if (!this.#options.workspace.release || await this.#options.workspace.release(record.allocation as WorkspaceAllocation<z.output<Data>>) !== "released") throw new SessionError("BUSY", "Workspace release remains unconfirmed");
    record.workspace = "released"; await this.#save(record);
  }
  #beginCreation(scope: SessionScope, original: string, input: z.output<Input>, selection?: Selection) {
    this.#scope(scope); id(original); const fixedInput = this.#options.workspace.createInput.parse(input);
    const fixedSelection = selection === undefined ? undefined : this.#options.harness.protocol.selection(selection);
    const hash = canonical({ scope, original, input: fixedInput, selection: fixedSelection ?? null }, 32768);
    const key = this.#originalKey(scope, original);
    const prior = this.#creations.get(key); if (prior) { if (prior.hash !== hash) throw new SessionError("CONFLICT"); return prior; }
    if (this.#admissionSealed) throw new SessionError("CLOSED");
    let admitted!: () => void; const admissionReady = new Promise<void>(resolve => { admitted = resolve; });
    const work = this.#own((async () => {
      const admission = await this.#registry.call<{ fresh: boolean; record: CreationRecord }>("admit", { record: { scope, id: original, input: fixedInput, ...(fixedSelection ? { selection: fixedSelection } : {}), workspace: "unallocated", nativeAttempted: false, stopped: false, retired: false } });
      this.#active(); let record = this.#records.get(scopeKey(scope)); if (!record) { record = admission.record; this.#records.set(scopeKey(scope), record); this.#committed.set(scopeKey(scope), structuredClone(record)); this.#publish(record); }
      admitted();
      if (!admission.fresh) return this.original(scope, original).then(value => { if (!value) throw new SessionError("FENCED"); return value; });
      return this.#prepare(record);
    })());
    const creation = { hash, promise: work, admission: admissionReady };
    this.#creations.set(key, creation); void work.finally(() => { if (this.#creations.get(key)?.promise === work) this.#creations.delete(key); }).catch(() => {});
    return creation;
  }
  /** Existing registry admission is the inventory barrier. It never waits for
   * workspace allocation, native construction, initialization or a model turn. */
  async createAdmitted(scope: SessionScope, original: string, input: z.output<Input>, selection?: Selection): Promise<void> {
    const creation = this.#beginCreation(scope, original, input, selection);
    await Promise.race([creation.admission, creation.promise.then(() => {})]);
  }
  /** Process/activation boundary only. Stop does not invoke this. Delayed
   * authenticated callers cannot add inventory after this admission barrier. */
  async sealAdmissions(): Promise<void> {
    this.#active(); this.#admissionSealed = true;
    await Promise.allSettled([...this.#creations.values()].map(creation => Promise.race([creation.admission, creation.promise.then(() => {})])));
  }
  async create(scope: SessionScope, original: string, input: z.output<Input>, selection?: Selection): Promise<Receipt> {
    const creation = this.#beginCreation(scope, original, input, selection);
    await Promise.race([creation.admission, creation.promise.then(() => {})]);
    return this.#wait(creation.promise, scope, original);
  }
  async #prepare(record: CreationRecord): Promise<Receipt> {
    if (record.stopped) return this.#retireBeforeNative(record);
    record.workspace = "pending"; await this.#save(record);
    if (record.stopped) { record.workspace = "unallocated"; return this.#retireBeforeNative(record); }
    // Durable intent precedes exactly one allocator call. No abort signal is an
    // allocation cancellation proof; the owner retains this actual promise.
    try {
      const allocation = await this.#options.workspace.allocate({ id: record.id, scope: copy(record.scope), input: copy(record.input) as z.output<Input> });
      if (noAllocation(allocation)) { record.workspace = "unallocated"; record.workspaceRefused = true; return await this.#retireBeforeNative(record); }
      record.allocation = this.#validateAllocation(allocation); record.workspace = "available"; await this.#save(record);
    } catch { record.workspace = "unknown"; await this.#save(record); return (await this.original(record.scope, record.id))!; }
    if (record.stopped) return this.#retireBeforeNative(record);
    return this.#start(record);
  }
  async #start(record: CreationRecord): Promise<Receipt> {
    if (record.stopped) return this.#retireBeforeNative(record);
    record.nativeAttempted = true; await this.#save(record);
    const host = await this.agent(record.scope);
    if (record.stopped) { const receipt = await host.session.submit({ scope: record.scope, id: record.stop!.id, generation: (await host.session.snapshot(record.scope)).generation, command: { type: "stop" } }); record.stop = receipt; await this.#save(record); return this.#retireBeforeNative(record); }
    return host.session.submit({ scope: record.scope, id: record.id, generation: 0, command: { type: "create", ...(record.selection ? { selection: record.selection } : {}) } });
  }
  async #retireBeforeNative(record: CreationRecord): Promise<Receipt> {
    record.retired = true;
    if (record.stop) record.stop = { ...record.stop, state: "acknowledged", outcome: { status: "acknowledged" } };
    await this.#save(record); return { scope: record.scope, id: record.id, generation: 0, type: "create", state: "refused", reason: record.workspaceRefused ? "workspaceRefused" : "retiredBeforeNative", outcome: { status: "refused" } };
  }
  async #nativeOriginal(record: CreationRecord, original: string): Promise<Receipt | null> {
    const opened = this.#opened.get(scopeKey(record.scope));
    if (opened) return opened.session.receipt(record.scope, original);
    if (this.#hosts.has(scopeKey(record.scope))) return null; // A held constructor/inspection is not a receipt barrier.
    return this.#registry.call("native.original", { key: scopeKey(record.scope), id: original });
  }
  async original(scope: SessionScope, original: string): Promise<Receipt | null> {
    this.#record(scope); const record = this.#committed.get(scopeKey(scope))!; id(original);
    if (record.archive?.id === original) return copy(record.archive);
    if (record.stop?.id === original) return record.nativeAttempted ? (await this.#nativeOriginal(record, original)) ?? copy(record.stop) : copy(record.stop);
    if (record.id !== original) return record.nativeAttempted ? this.#nativeOriginal(record, original) : null;
    if (record.retired) return { scope, id: original, generation: 0, type: "create", state: "refused", reason: record.workspaceRefused ? "workspaceRefused" : "retiredBeforeNative", outcome: { status: "refused" } };
    if (record.nativeAttempted) return (await this.#nativeOriginal(record, original)) ?? { scope, id: original, generation: 0, type: "create", state: "outcomeUnknown", reason: "nativeAdmissionUnobserved" };
    return { scope, id: original, generation: 0, type: "create", state: record.workspace === "unknown" ? "outcomeUnknown" : "admitted", ...(record.workspace === "unknown" ? { reason: "workspaceOutcomeUnknown" } : {}) };
  }
  /** Positive journal/registry proof only; never constructs an adapter or native reader. */
  async archived(scope: SessionScope, original: string, generation: number): Promise<boolean> {
    this.#record(scope); id(original); if (!Number.isSafeInteger(generation) || generation < 0) throw new SessionError("INVALID");
    const record = this.#committed.get(scopeKey(scope))!;
    if (record.archive?.id === original) return record.archive.generation === generation && record.archive.state === "acknowledged";
    if (!record.nativeAttempted) return false;
    return this.#registry.call("native.archive", { key: scopeKey(scope), id: original, generation });
  }
  /** Trusted owner-selected Stop. Fence fresh preparation before waiting for a
   * constructor; cold custody needs explicit inspection to select generation. */
  async stop(scope: SessionScope, original: string): Promise<Receipt> {
    const record = this.#record(scope); id(original);
    let generation = this.#snapshots.get(scopeKey(scope))?.generation;
    if (generation === undefined) {
      generation = !record.nativeAttempted || this.#creations.has(this.#originalKey(scope, record.id))
        ? 0 : (await (await this.agent(scope)).session.snapshot(scope)).generation;
    }
    return this.submit({ scope, id: original, generation, command: { type: "stop" } });
  }
  async submit(request: Submit): Promise<Receipt> {
    const record = this.#record(request.scope); id(request.id);
    request = copy({ ...request, command: this.#options.harness.protocol.command(request.command) });
    if (!Number.isSafeInteger(request.generation) || request.generation < 0) throw new SessionError("INVALID");
    if (request.id === record.id) throw new SessionError("CONFLICT");
    if (request.command.type === "create") throw new SessionError("INVALID", "Use lifecycle.create with a workspace input");
    if (this.#admissionSealed && request.command.type !== "stop") throw new SessionError("CLOSED");
    if (record.archive) {
      if (record.archive.id === request.id && request.command.type === "archive" && request.generation === record.archive.generation) return copy(record.archive);
      throw new SessionError(record.archive.id === request.id ? "CONFLICT" : "FENCED");
    }
    if (!record.nativeAttempted && request.command.type === "archive") {
      if (request.generation !== 0 || record.stop?.id === request.id) throw new SessionError("CONFLICT");
      // Only positive pre-native retirement permits this single irreversible
      // slot. Pending/unknown allocation and an active Create are not absence.
      if (!record.retired || !["unallocated", "available", "released"].includes(record.workspace) || this.#creations.has(this.#originalKey(record.scope, record.id)) || record.allocation?.ownership === "owned" && !this.#options.workspace.release) throw new SessionError("BUSY");
      record.archive = { scope: request.scope, id: request.id, generation: 0, type: "archive", state: "dispatched" };
      const actual = this.#own((async () => {
        await this.#save(record);
        try { await this.#releaseWorkspace(record); record.archive = { ...record.archive!, state: "acknowledged", outcome: { status: "acknowledged" } }; }
        catch { record.archive = { ...record.archive!, state: "outcomeUnknown", reason: "archiveUnconfirmed" }; }
        await this.#save(record); return copy(record.archive!);
      })());
      return this.#wait(actual, request.scope, request.id);
    }
    if (!record.nativeAttempted) {
      if (request.command.type !== "stop") throw new SessionError("FENCED");
      if (request.generation !== 0) throw new SessionError("FENCED");
      if (record.stop && record.stop.id !== request.id) throw new SessionError("BUSY");
      record.stopped = true; record.stop ??= { scope: request.scope, id: request.id, generation: 0, type: "stop", state: "admitted" };
      await this.#save(record);
      if (record.workspace === "unallocated" || record.workspace === "available") await this.#retireBeforeNative(record);
      const pending = this.#creations.get(this.#originalKey(record.scope, record.id)); if (pending) return this.#wait(pending.promise.then(async () => (await this.original(request.scope, request.id))!), request.scope, request.id);
      return copy(record.stop);
    }
    let preparationStop = false;
    if (request.command.type === "stop" && request.generation === 0 && (this.#snapshots.get(scopeKey(request.scope))?.generation ?? 0) === 0) {
      if (record.stop && record.stop.id !== request.id) throw new SessionError("BUSY");
      record.stopped = true; record.stop ??= { scope: request.scope, id: request.id, generation: 0, type: "stop", state: "admitted" }; await this.#save(record); preparationStop = true;
    }
    const actual = this.#own((async () => {
      const session = (await this.agent(request.scope)).session; this.#active();
      if (this.#admissionSealed && request.command.type !== "stop") throw new SessionError("CLOSED");
      const receipt = await session.submit(request);
      if (request.command.type === "archive" && receipt.state === "acknowledged") { record.archive = receipt; await this.#save(record); }
      return receipt;
    })());
    return preparationStop ? this.#wait(actual, request.scope, request.id) : actual;
  }
  async reconcile(scope: SessionScope): Promise<View<z.output<Data>>> {
    const record = this.#record(scope);
    await this.#own((async () => {
      if (record.workspace === "pending" && this.#creations.has(this.#originalKey(record.scope, record.id))) return;
      if (["pending", "unknown"].includes(record.workspace) && !record.nativeAttempted) {
        const result = await this.#options.workspace.original({ id: record.id, scope: copy(scope), input: copy(record.input) as z.output<Input> });
        if (noAllocation(result)) { record.workspace = "unallocated"; record.workspaceRefused = true; await this.#retireBeforeNative(record); }
        if (result.state === "available") { record.allocation = this.#validateAllocation(result.allocation); record.workspace = "available"; await this.#save(record); if (record.stopped) await this.#retireBeforeNative(record); else await this.#start(record); }
      }
      if (record.nativeAttempted) await this.agent(scope);
    })());
    return this.#view(record);
  }
  async #wait(actual: Promise<Receipt>, scope: SessionScope, original: string): Promise<Receipt> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([actual, new Promise<Receipt>((resolve, reject) => { timer = setTimeout(() => { void this.original(scope, original).then(value => { if (!value) throw new SessionError("IO"); return value; }).then(resolve, reject); }, this.#options.observationMs ?? 1000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  readiness(): UpdateReadiness {
    const reasons: string[] = [];
    if (this.#closed) return { ready: false, reasons: ["closed"] };
    if (this.#actual.size || this.#registry.pending) reasons.push("lifecycle-work-unsettled");
    if (this.#modelCatalog) {
      const models = this.#modelCatalog.readiness();
      if (!models.ready) reasons.push(...models.reasons.map(reason => `model-catalog:${reason}`));
    }
    for (const [key, record] of this.#records) {
      if (["pending", "unknown"].includes(record.workspace)) reasons.push(`workspace-unsettled:${record.scope.session}`);
      const native = this.#snapshots.get(key);
      const opened = this.#opened.get(key); if (opened && !opened.updateReadiness().ready) reasons.push(`session-work-unsettled:${record.scope.session}`);
      if (record.nativeAttempted && (!native || native.phase !== "stopped")) reasons.push(`native-ownership-unsettled:${record.scope.session}`);
    }
    return reasons.length ? { ready: false, reasons } : { ready: true };
  }
  async close(): Promise<void> {
    if (this.#closeFailure) throw this.#closeFailure;
    if (this.#closed) return; if (this.#closing) throw new SessionError("BUSY");
    this.#closing = true;
    try {
      if (!this.readiness().ready) throw new SessionError("BUSY", "Stop and prove all native/allocation ownership before update");
      const hosts = await Promise.all([...this.#hosts.values()]);
      if (hosts.some(host => !host.updateReadiness().ready) || this.#actual.size || this.#registry.pending) throw new SessionError("BUSY");
      // Admission is terminal before the first irreversible child close. A
      // partial cleanup failure cannot reopen a half-closed lifecycle owner.
      this.#closed = true; this.#listeners.clear(); this.#hostListeners.clear();
      const failures: unknown[] = [];
      try { await this.#modelCatalog?.close(); } catch (error) { failures.push(error); }
      for (const host of hosts) try { await host.close(); } catch (error) { failures.push(error); }
      const resources = await Promise.allSettled([...this.#runtimes.values()]);
      for (const resource of resources) {
        if (resource.status === "rejected") { failures.push(resource.reason); continue; }
        try { await resource.value.close?.(); resource.value.controller.dispose(); } catch (error) { failures.push(error); }
      }
      for (const detach of this.#detach) detach();
      try { await this.#registry.close(); } catch (error) { failures.push(error); }
      if (failures.length) { this.#closeFailure = new AggregateError(failures, "Lifecycle plugin cleanup remains unproved"); throw this.#closeFailure; }
    } finally { this.#closing = false; }
  }
  /** Disposable test writer loss. This does not Stop native execution. */
  async terminate(): Promise<void> { this.#closed = true; const hosts = await Promise.allSettled([...this.#hosts.values()]); await Promise.allSettled(hosts.flatMap(value => value.status === "fulfilled" ? [value.value.terminate()] : [])); for (const detach of this.#detach) detach(); await this.#registry.terminate(); this.#listeners.clear(); this.#hostListeners.clear(); }
}

/** Session views are current snapshots, so one replaceable pending value is
 * sufficient. A slow client cannot accumulate an unbounded callback queue. */
async function* latestSnapshots<T>(subscribe: (listener: (value: T) => void) => Promise<() => void>, signal: AbortSignal): AsyncGenerator<T> {
  let pending: { value: T } | undefined, wake: (() => void) | undefined, detach: (() => void) | undefined;
  const stop = () => wake?.(); signal.addEventListener("abort", stop, { once: true });
  try {
    detach = await subscribe(value => { pending = { value }; wake?.(); });
    while (!signal.aborted) {
      if (pending) { const next = pending; pending = undefined; yield next.value; }
      else await new Promise<void>(resolve => { wake = resolve; if (signal.aborted || pending) resolve(); });
    }
  } finally { signal.removeEventListener("abort", stop); detach?.(); }
}

function scopedView<T extends { native: { generation: number } | null }>(context: HostContext, value: T): T {
  if (context.session && value.native?.generation !== context.session.generation) throw new SessionError("FENCED");
  return value;
}
async function* scopedSnapshots<T extends { native: { generation: number } | null }>(context: HostContext, source: AsyncIterable<T>): AsyncGenerator<T> {
  for await (const value of source) yield scopedView(context, value);
}

export function defaultLifecycle<Input extends z.ZodType, Data extends z.ZodType, K extends Harness>(options: DefaultLifecycleOptions<Input, Data, K>) {
  if (options.policy.kind !== options.harness.nativeKind) throw new SessionError("FENCED");
  const configured = { ...options, policy: options.harness.protocol.policy(options.policy) };
  const createInput = z.object({ session: sessionId, workspace: options.workspace.createInput, selection: z.custom<SelectionFor<K>>().optional() }).strict();
  const nativeSchema = z.custom<Omit<SessionSnapshot, "kind" | "selection"> & { kind: K; selection: SelectionFor<K> }>(value => !!value && typeof value === "object" && (value as SessionSnapshot).kind === options.harness.nativeKind);
  const allocation = z.object({ id: z.string(), cwd: z.string(), ownership: z.enum(["borrowed", "owned"]), data: options.workspace.publicData });
  const sessionData = z.object({ id: z.string(), originalId: z.string(), phase: z.enum(["preparing", "stopping", "stopped", "native", "unobserved"]), workspace: z.object({ state: z.enum(["unallocated", "pending", "unknown", "available", "released"]), allocation: allocation.optional() }), native: nativeSchema.nullable(), usage: z.custom<CopilotUsage>().optional(), attention: z.custom<SessionAttention>().optional(), archive: z.object({ id: z.string(), state: z.enum(["pending", "complete"]) }).optional() });
  // Resolvers validate/project through sessionData before returning. An output
  // annotation preserves transformed schema output without asking tRPC to parse it twice.
  const sessionOutput = z.custom<z.output<typeof sessionData>>();
  const hostData = z.object({ sessionCount: z.number().int().nonnegative(), workspaceStrategy: z.string() });
  return {
    kind: "lifecycle" as const, identity: defaultLifecycleIdentity, capabilities: ["session.create", "session.resume", "session.stop", "session.archive", "session.original", "workspace.inspect"] as const,
    createInput, public: { host: hostData, session: sessionData },
    async open(context: HostActivationContext) {
      const sessions = await DefaultLifecycleSessions.open(configured, context);
      const router = hostRouter({
        create: hostProcedure.input(z.object({ id: originalId, input: createInput }).strict()).output(receiptSchema).mutation(({ ctx, input }) => sessions.create(sessions.scope(ctx, input.input.session), input.id, (input.input as { workspace: z.output<Input> }).workspace, input.input.selection)),
        submit: hostProcedure.input(z.object({ session: sessionId, id: originalId, generation: z.number().int().nonnegative(), command: z.discriminatedUnion("type", [z.object({ type: z.literal("stop") }).strict(), z.object({ type: z.literal("resume") }).strict(), z.object({ type: z.literal("archive") }).strict()]) }).strict()).output(receiptSchema)
          .mutation(({ ctx, input }) => { if (ctx.session && ctx.session.generation !== input.generation) throw new SessionError("FENCED"); return sessions.submit({ id: input.id, generation: input.generation, command: input.command, scope: sessions.scope(ctx, input.session) }); }),
        original: hostProcedure.input(z.object({ session: sessionId, id: originalId }).strict()).output(receiptSchema.nullable()).query(({ ctx, input }) => sessions.original(sessions.scope(ctx, input.session), input.id)),
        archiveProof: hostProcedure.input(z.object({ session: sessionId, id: originalId, generation: z.number().int().nonnegative() }).strict()).output(z.boolean()).query(({ ctx, input }) => { if (ctx.session && ctx.session.generation !== input.generation) throw new SessionError("FENCED"); return sessions.archived(sessions.scope(ctx, input.session), input.id, input.generation); }),
        snapshot: hostProcedure.input(scopeInput).output(sessionOutput).query(async ({ ctx, input }) => scopedView(ctx, sessionData.parse(await sessions.view(sessions.scope(ctx, input.session))))),
        host: hostProcedure.output(hostData).query(({ ctx }) => sessions.hostData(ctx)),
        modelCatalog: hostProcedure.query(({ ctx }) => sessions.modelCatalog(ctx)),
        list: hostProcedure.query(({ ctx }) => sessions.list(ctx).map(value => scopedView(ctx, sessionData.parse(value)))),
        watchHost: hostProcedure.subscription(async function* ({ ctx, signal }) {
          const values = latestSnapshots<View<z.output<Data>>[]>(listener => Promise.resolve(sessions.subscribeHost(listener, ctx)), signal ?? new AbortController().signal);
          for await (const snapshot of values) yield snapshot.map(value => scopedView(ctx, sessionData.parse(value)));
        }),
        reconcile: hostProcedure.input(scopeInput).output(sessionOutput).mutation(async ({ ctx, input }) => { const scope = sessions.scope(ctx, input.session); scopedView(ctx, await sessions.view(scope)); return scopedView(ctx, sessionData.parse(await sessions.reconcile(scope))); }),
        watch: hostProcedure.input(scopeInput).subscription(({ ctx, input, signal }) => scopedSnapshots(ctx, latestSnapshots<z.output<typeof sessionData>>(
          listener => sessions.watch(sessions.scope(ctx, input.session), value => listener(sessionData.parse(value))), signal ?? new AbortController().signal))),
      });
      return { sessions, router, readiness: () => sessions.readiness(), close: () => sessions.close() };
    },
  };
}
