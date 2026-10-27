import { isAbsolute, join, posix, win32 } from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { RecordIdentity } from "./session/journal.js";
import { SessionHost } from "./session/index.js";
import { SessionError, sameRun, scopeKey, type Catalog, type ManagedPolicy, type NativeEvent, type NativePort, type RunRef, type SessionScope, type SessionSnapshot } from "../../v8-session/src/contracts/types.js";
import { canonical, copy } from "../../v8-session/src/contracts/validation.js";
import { RuntimeSupervisor } from "../../v8-runtime/src/supervisor.js";
import { requireThat } from "../../v8-runtime/src/validation.js";
import { HistoryHub } from "../../v8-history/src/host/history-owner.js";
import { HistoryAcquisition, type AcquisitionResult } from "../../v8-history/src/acquisition/owner.js";
import type { HistoryObservation, HistoryRecovery, HistoryRecord } from "../../v8-history/src/acquisition/types.js";
import { ReadCoordinator, type ReadHandle, type ReadObservation } from "../../v8-history/src/repair/read-coordinator.js";
import { scopeKey as historyKey } from "../../v8-history/src/contracts/identity.js";
import { PrimitiveError, validateScope } from "../../v8-history/src/contracts/validation.js";
import { rowMedia } from "../../v8-history/src/contracts/media.js";
import { CAPTURE_GAP_ID, type Action, type CapturedScope, type CapturePort, type HistoryPage, type Json, type NativeCodec, type Scope as HistoryScope, type ScopeFacts } from "../../v8-history/src/contracts/types.js";
import { validateScopeFacts } from "../../v8-history/src/contracts/validation.js";
import { FileHost, type FileHostOptions } from "../../v8-files/src/host/index.js";
import { NativeFileCapture, type NativeCapturePort } from "../../v8-files/src/native/capture.js";
import { scopeKey as fileKey, FileError, type FilePort, type FileScope, type FileMethod, type FileInputs, type FileOutputs } from "../../v8-files/src/contracts/types.js";
import type { InteractionPort, InteractionSnapshot } from "../../v8-interactions/src/contracts.js";
import { McpOwner } from "../../v8-mcp/src/owner.js";
import { McpReadPool } from "../../v8-mcp/src/read-pool.js";
import type { McpPort, McpSnapshot } from "../../v8-mcp/src/contracts.js";
import type { HostBinding, HostController, HostHistory, NativeCapture } from "../../v8-host/src/contracts.js";
import { SendPreparation } from "../../v8-host/src/send-preparation.js";
import { defaultLimits as fileLimits } from "../../v8-files/src/contracts/limits.js";
type HistoryReader = { context: string; lease: string; acquisition: HistoryAcquisition };
type HostRecord = { run: RunRef; history: HistoryScope; codec: NativeCodec; acquisitions: Map<string, HistoryReader>; halted: boolean; mcp?: McpOwner; unsubscribe?: () => void;
  initial?: { attachment: string; work: Promise<void> } };

export interface HostOptions {
  scope: SessionScope; directory: string; cwd: string; policy: ManagedPolicy; controller: HostController;
  observationMs?: number;
  identity?: RecordIdentity;
  history?: HostHistory;
  files?: Pick<FileHostOptions, "allowedRoots" | "privateRoots" | "broadPaths" | "limits">;
  /** Explicit same-path roots mounted in the native runtime; absent means unavailable. */
  nativeInputRoots?: readonly string[];
  /** Additional lifecycle-owned resources, such as an explicitly owned workspace. */
  archive?: Readonly<{ ready(): Promise<boolean>; release(): Promise<void> }>;
}
/** One actual durable Host, native ownership seam and bounded observation owners.
 * No effect journal or native registry beyond the existing SessionHost. */
export class AgentHost {
  readonly history = Object.assign(new HistoryHub({ maxRows: 128 }), {
    scopes: (): readonly HistoryScope[] => { this.#active(); return copy([...this.#historyScopes.values()].filter(value => value.generation === this.#record?.run.generation).map(value => value.scope)); },
    authorize: (scope: HistoryScope, observation: HistoryObservation = {}): Promise<ReadObservation<true>> => this.#authorizeHistory(scope, observation),
    recover: (scope: HistoryScope, observation: HistoryObservation = {}, retryToken?: string): Promise<HistoryRecovery> => this.#recover(scope, observation, retryToken),
    older: (scope: HistoryScope, cursor: string, generation?: string, retryToken?: string): Promise<HistoryPage> => this.#older(scope, cursor, generation, retryToken),
  });
  readonly runtime: RuntimeSupervisor; session!: SessionHost;
  get historyRecovery() { return this.#options.history ? Object.freeze({ state: "available" as const }) : Object.freeze({ state: "unavailable" as const, reason: "native-page-reader-unconfigured" }); }
  readonly files: FilePort; readonly interactions: InteractionPort; readonly mcp: McpPort;
  readonly #options: HostOptions; readonly #reads = new McpReadPool(); readonly #media: NativeFileCapture;
  readonly #historyReads = new ReadCoordinator(); #historyObservers = 0;
  readonly #interactionListeners = new Set<(snapshot: InteractionSnapshot) => void>();
  readonly #historyScopes = new Map<string, { scope: HistoryScope; generation: number; gapFact?: string; native?: ScopeFacts }>();
  #record: HostRecord | undefined;
  #fileOwner: { nativeSession: string; promise: Promise<FileHost> } | undefined;
  #sendPreparation: SendPreparation | undefined;
  #snapshot: SessionSnapshot | undefined; #epoch: number | undefined; #closed = false; #closing = false;
  #pending: NativeCapture[] = []; #pendingBytes = 0; #captureOverflow = false;
  #detach: () => void = () => {}; #unsubscribe: () => void = () => {}; #detachMedia: () => void = () => {};
  private constructor(options: HostOptions) {
    requireThat(isAbsolute(options.directory) && isAbsolute(options.cwd));
    this.#options = { ...options, scope: copy(options.scope), policy: copy(options.policy) };
    this.runtime = new RuntimeSupervisor({ scope: options.scope, ownership: options.controller });
    const capturedFiles: NativeCapturePort = { call: async <M extends FileMethod>(method: M, input: FileInputs[M]): Promise<FileOutputs[M]> => {
      this.#operation();
      const current = this.#record; if (!current || fileKey(input.scope) !== fileKey(this.#nativeFileScope(current.run))) throw new FileError("FENCED");
      const owner = await this.#fileHost(current.run.nativeSession);
      if (method === "capture") return owner.call("capture", await this.#capturePath(input as FileInputs["capture"])) as Promise<FileOutputs[M]>;
      return owner.call(method, input);
    }, native: async (method, input, occurrence) => {
      this.#operation(); const current = this.#record;
      if (!current || fileKey(input.scope) !== fileKey(this.#nativeFileScope(current.run))) throw new FileError("FENCED");
      const owner = await this.#fileHost(current.run.nativeSession);
      return method === "capture" ? owner.native("capture", await this.#capturePath(input as FileInputs["capture"]), occurrence) as Promise<FileOutputs[typeof method]>
        : owner.native("begin", input as FileInputs["begin"], occurrence) as Promise<FileOutputs[typeof method]>;
    } };
    this.#media = new NativeFileCapture({ port: capturedFiles, mapScope: scope => {
      requireThat(scope.origin.connection === options.scope.connection && scope.origin.principal === options.scope.principal && scope.origin.host === options.scope.host);
      return { ...options.scope, session: scope.origin.nativeSession };
    } });
    this.#detachMedia = this.#media.subscribe(() => this.#publishMedia());
    this.files = { call: async <M extends FileMethod>(method: M, input: FileInputs[M]): Promise<FileOutputs[M]> => {
      this.#active(); if (method !== "release") this.#operation(); const scope = this.fileScope(); if (!scope || fileKey(input.scope) !== fileKey(scope)) throw new FileError("FENCED");
      const owner = await this.#fileHost(scope.session); if (method !== "release") this.#operation();
      if (method === "capture") return owner.call("capture", await this.#capturePath(input as FileInputs["capture"])) as Promise<FileOutputs[M]>;
      return owner.call(method, input);
    } };
    this.interactions = {
      snapshot: async scope => {
        this.#operation(); this.#scope(scope); const run = this.#currentRun();
        if (options.controller.current()) return options.controller.interactions(run).snapshot(scope);
        const stopped = this.#stopped(run);
        return copy({ scope, run, epoch: stopped.epoch, revision: stopped.revision, baseline: "partial", items: [], issue: "ownershipRetired" });
      },
      subscribe: (scope, listener) => { this.#scope(scope); if (this.#interactionListeners.size >= 128) throw new SessionError("FULL"); this.#interactionListeners.add(listener); return () => { this.#interactionListeners.delete(listener); }; },
    };
    const owner = (run: RunRef): McpOwner | undefined => {
      this.#operation(); const current = this.#record; requireThat(current && sameRun(current.run, run));
      if (!current.mcp) this.#stopped(run);
      return current.mcp;
    };
    this.mcp = {
      snapshot: async run => owner(run)?.snapshot(run) ?? this.#retiredMcp(run),
      subscribe: (run, listener) => {
        const held = owner(run); if (held) return held.subscribe(run, listener);
        listener(this.#retiredMcp(run)); return () => {};
      },
      refresh: (run, observation) => { const held = owner(run); requireThat(held, "Native MCP ownership is retired"); return held.refresh(run, observation); },
    };
  }
  static async open(options: HostOptions): Promise<AgentHost> {
    const assembly = new AgentHost(options), runtime = assembly.runtime;
    assembly.#detach = options.controller.observe(value => assembly.#capture(value));
    const event = (emit: (event: NativeEvent) => void) => (value: NativeEvent): void => {
      if (value.type === "stopped") assembly.#halted(value.run); emit(value);
    };
    const port: NativePort = { kind: runtime.kind, protocol: options.controller.protocol, placement: runtime.placement, capabilities: runtime.capabilities, catalog: () => runtime.catalog(),
      ...(runtime.parentCustody ? { parentCustody: runtime.parentCustody } : {}),
      ...(options.controller.read ? { read: options.controller.read.bind(options.controller) } : {}),
      ...(options.controller.mcpLoginLink ? { mcpLoginLink: options.controller.mcpLoginLink.bind(options.controller) } : {}),
      prepareSend: (request, run, assertCurrent) => { requireThat(assembly.#sendPreparation); return assembly.#sendPreparation.prepare(request, run, assertCurrent); },
      start: async (input, emit, onOwned, onOpening) => { await options.history?.release?.(assembly.session.readers); const native = await runtime.start(input, event(emit), onOwned, onOpening); return { ...native, stop: async () => { const proof = await native.stop(); assembly.#halted(proof.run); return proof; } }; },
      inspectOpening: capsule => runtime.inspectOpening(capsule),
      inspect: async (run, emit) => { const native = await runtime.inspect(run, event(emit)); if (native && "state" in native) assembly.#halted(native.run); return native; } };
    try {
      assembly.session = await SessionHost.open({ directory: join(options.directory, "session"), scope: options.scope, policy: options.policy, port, archive: { ready: () => assembly.#archiveReady(), release: () => assembly.#releaseArchive() }, ...(options.identity ? { identity: options.identity } : {}), ...(options.observationMs === undefined ? {} : { observationMs: options.observationMs }) });
      const initial = await assembly.session.snapshot(options.scope); assembly.#epoch = initial.epoch;
      assembly.#sendPreparation = new SendPreparation({ scope: options.scope, kind: runtime.kind, epoch: initial.epoch, session: assembly.session, files: run => assembly.#fileHost(run.nativeSession), nativeInputRoots: [...(options.nativeInputRoots ?? [])], chunkBytes: options.files?.limits?.chunkBytes ?? fileLimits.chunkBytes });
      assembly.#unsubscribe = assembly.session.subscribe(options.scope, value => {
        assembly.#snapshot = value;
        if (value.archive) assembly.#media.close();
        if (value.nativeSession) {
          const run = { scope: value.scope, generation: value.generation, nativeSession: value.nativeSession };
          const record = assembly.#ensure(run, false);
          if (value.phase === "stopped") assembly.#halted(run);
          else if (value.phase === "running") assembly.#initialHistory(record);
        }
      });
      // Existing native attachment is a cold Host observation, never a fresh
      // transcript certificate. Explicit subsequent Create is the healthy path.
      for (const pending of assembly.#pending.splice(0)) assembly.#capture(pending, true);
      if (!initial.archive && initial.nativeSession && existsSync(join(assembly.#fileDirectory(initial.nativeSession), "files.sqlite"))) void assembly.#sendPreparation.reconcile(assembly.#currentRun()).catch(() => { /* Only future attachment preparation is blocked; urgent controls remain available. */ });
      assembly.#pendingBytes = 0; return assembly;
    } catch (error) { assembly.#detach(); if (assembly.session) await assembly.session.terminate(); throw error; }
  }
  #active(): void { if (this.#closed || this.#closing) throw new SessionError("CLOSED"); }
  #operation(): void { this.#active(); if (this.session?.archiving) throw new SessionError("FENCED", "Session archive admissions are sealed"); }
  #historyOperation(): void { this.#active(); if (!this.session.historyReadable) throw new SessionError("FENCED", "Pending archive history admissions are sealed"); }
  #scope(scope: SessionScope): void { this.#active(); requireThat(scopeKey(scope) === scopeKey(this.#options.scope)); }
  #currentRun(): RunRef { this.#active(); const value = this.#snapshot; requireThat(value?.nativeSession); return { scope: value.scope, generation: value.generation, nativeSession: value.nativeSession }; }
  /** A saved positive halt permits closed observations, never native ownership. */
  #stopped(run: RunRef): SessionSnapshot {
    const value = this.#snapshot, current = this.#record;
    requireThat(value?.phase === "stopped" && current?.halted && sameRun(current.run, run) && value.nativeSession === run.nativeSession && value.generation === run.generation);
    return value;
  }
  #retiredMcp(run: RunRef): McpSnapshot {
    const stopped = this.#stopped(run), common = { run, epoch: stopped.epoch, revision: stopped.revision, freshness: "retired", coverage: "unknown", observedAt: null, management: "unavailable-no-original-command", servers: [], issue: "ownershipRetired" } as const;
    return copy(this.#options.controller.kind === "codex" ? { ...common, kind: "codex", discovery: "thread-scoped-discovery" } : { ...common, kind: "copilot", discovery: "configured-passive" });
  }
  #historyContext(scope: HistoryScope): HostRecord {
    this.#historyOperation(); validateScope(scope); const current = this.#record;
    requireThat(current && scope.kind === current.history.kind && canonical(scope.origin) === canonical(current.history.origin));
    requireThat(this.#historyScopes.get(historyKey(scope))?.generation === current.run.generation);
    return current;
  }
  async #capturePath(input: FileInputs["capture"]): Promise<FileInputs["capture"]> {
    const { historyScope, ...request } = copy(input);
    if (!historyScope) return request;
    let current: HostRecord;
    try { current = this.#historyContext(historyScope); } catch { throw new FileError("FENCED"); }
    const halted = current.halted, stopRequested = this.#snapshot?.stopRequested;
    const active = () => {
      this.#operation();
      if (this.#record !== current || current.halted !== halted || this.#snapshot?.stopRequested !== stopRequested || !sameRun(current.run, this.#currentRun()) || this.#historyScopes.get(historyKey(historyScope))?.generation !== current.run.generation) throw new FileError("FENCED");
    };
    active();
    // Keep root capture identities and absolute paths unchanged. A child never
    // inherits root cwd merely because both share the same immutable file owner.
    if (historyKey(historyScope) === historyKey(current.history) || isAbsolute(request.path)) return request;
    const source = this.#options.history;
    if (!source?.pathContext) throw new FileError("UNSUPPORTED");
    const handle = this.#historyReads.request({ scope: historyScope, reason: "E14", kind: "metadata",
      factId: JSON.stringify(["file-path-context", current.run.generation, current.history.origin.attachment]) }, async () => {
      active(); const context = await source.pathContext!(copy(current.run), copy(historyScope), active); active();
      const paths = context.dialect === "win32" ? win32 : context.dialect === "posix" ? posix : undefined;
      if (!paths || typeof context.cwd !== "string" || context.cwd.length > 4096 || !paths.isAbsolute(context.cwd) || /[\x00-\x1f\x7f]/.test(context.cwd)) throw new FileError("UNSUPPORTED");
      return { cwd: context.cwd, dialect: context.dialect };
    });
    const observed = await handle.settled; active();
    if (observed.state !== "value") throw new FileError(observed.state === "failed" ? "IO" : "FENCED");
    const paths = observed.value.dialect === "win32" ? win32 : posix;
    return { ...request, path: paths.resolve(observed.value.cwd, request.path) };
  }
  async #authorizeHistory(value: HistoryScope, observation: HistoryObservation): Promise<ReadObservation<true>> {
    this.#historyOperation(); const scope = copy(value); validateScope(scope);
    const current = this.#record, source = this.#options.history;
    requireThat(current && scope.kind === current.history.kind && canonical(scope.origin) === canonical(current.history.origin));
    if (this.#historyScopes.get(historyKey(scope))?.generation === current.run.generation) return { state: "value", value: true };
    requireThat(source?.authorize);
    this.#historyObservation(observation);
    const original = source.port(copy(current.run), scope, this.#media.handler);
    const factId = JSON.stringify(["authorize-child", current.run.generation, current.history.origin.attachment, original.context ?? original.mode]);
    const halted = current.halted, stopRequested = this.#snapshot?.stopRequested;
    const active = () => { this.#historyOperation(); requireThat(this.#record === current && sameRun(current.run, this.#currentRun()) && current.halted === halted && this.#snapshot?.stopRequested === stopRequested); };
    const proof = this.#historyReads.request<true>({ scope, reason: "E16", kind: "metadata", factId }, async () => {
      active();
      // This is already the bounded metadata job. Preparing here avoids a
      // nested ReadCoordinator slot while retaining the original proof job.
      if (this.#snapshot?.phase === "stopped") await source.prepare?.(copy(current.run), scope, this.session.readers);
      active(); await source.authorize!(copy(current.run), scope, active); active();
      // Live capture may have opened this same proved child during the read.
      // Reuse its owner; never reset rows or promote read proof into live custody.
      this.history.open(scope, { knownStart: false });
      if (this.#historyScopes.get(historyKey(scope))?.generation !== current.run.generation)
        this.#historyScopes.set(historyKey(scope), { scope, generation: current.run.generation });
      this.#publishScopeInventory(current.run, current.history);
      return true;
    });
    return this.#observeHistory(proof, observation);
  }
  #acquisition(scope: HistoryScope, current: HostRecord): HistoryAcquisition {
    const key = historyKey(scope), prior = current.acquisitions.get(key);
    const source = this.#options.history; if (!source) throw new SessionError("UNSUPPORTED");
    const original = source.port(copy(current.run), copy(scope), this.#media.handler);
    requireThat(original.context === undefined || typeof original.context === "string" && original.context.length > 0 && original.context.length <= 256);
    const lease = original.context ?? `legacy-${original.mode}`, context = this.#readContext(scope, current.run, lease);
    if (prior?.context === context) return prior.acquisition;
    this.history.owner(scope).setReadContext(context);
    let reader!: HistoryReader;
    const active = () => { this.#historyOperation(); requireThat(this.#record === current && current.acquisitions.get(key) === reader && sameRun(current.run, this.#currentRun()) && this.#historyScopes.get(key)?.generation === current.run.generation); };
    const acquisition = new HistoryAcquisition(this.history.owner(scope), { scope: original.scope, mode: original.mode, context,
      read: async (request, assertCurrent) => {
        active(); assertCurrent?.(); const value = await original.read(request, () => { active(); assertCurrent?.(); }); active(); assertCurrent?.();
        if (!value.records.some(row => rowMedia(row).some(media => media.state === "pending"))) return value;
        // Explicit page exceptions retain this same read slot while their finite
        // captured file jobs settle. Observer expiry cannot release actual work.
        await this.#media.drain(); active(); assertCurrent?.();
        return { ...value, records: value.records.map(row => {
          const media = this.#resolvedMedia(scope, row);
          return media.length ? { ...row, native: { ...row.native, media: media as unknown as Json } } : row;
        }) };
      },
    }, this.#historyReads, source.limits, context, scopes => { active(); this.#admitReadScopes(current, scopes); });
    reader = { context, lease, acquisition }; current.acquisitions.set(key, reader); return acquisition;
  }
  #readContext(scope: HistoryScope, run: RunRef, lease: string): string { return createHash("sha256").update(JSON.stringify([historyKey(scope), run.generation, lease, this.history.owner(scope).readBoundary ?? null])).digest("hex"); }
  async #observeHistory<T>(handle: ReadHandle<T>, observation: HistoryObservation): Promise<ReadObservation<T>> {
    const timeout = observation.timeoutMs ?? 8000;
    this.#historyObservers++;
    try { return await handle.wait(timeout, observation.signal); } finally { this.#historyObservers--; }
  }
  #historyObservation(observation: HistoryObservation): void {
    const timeout = observation.timeoutMs ?? 8000;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 30000) throw new SessionError("INVALID");
    if (this.#historyObservers >= 128) throw new SessionError("FULL"); observation.signal?.throwIfAborted();
  }
  async #prepareHistory(scope: HistoryScope, current: HostRecord, observation: HistoryObservation): Promise<ReadObservation<true>> {
    const source = this.#options.history;
    if (!source?.prepare || this.#snapshot?.phase !== "stopped") return { state: "value", value: true };
    const port = source.port(copy(current.run), copy(scope), this.#media.handler);
    if (port.mode === "persisted") return { state: "value", value: true };
    this.#historyObservation(observation);
    const active = () => { this.#historyOperation(); requireThat(this.#record === current && this.#snapshot?.phase === "stopped" && sameRun(current.run, this.#currentRun())); };
    const handle = this.#historyReads.request<true>({ scope, reason: "E28", kind: "metadata",
      factId: JSON.stringify(["prepare-stopped-reader", current.run.generation, port.context ?? port.mode]) }, async () => {
      active(); await source.prepare!(copy(current.run), copy(scope), this.session.readers); active(); return true;
    });
    return this.#observeHistory(handle, observation);
  }
  async #recover(value: HistoryScope, observation: HistoryObservation, retryToken?: string): Promise<HistoryRecovery> {
    const scope = copy(value);
    const admitted = await this.#authorizeHistory(scope, observation);
    if (admitted.state !== "value") return admitted;
    const current = this.#historyContext(scope);
    this.#historyObservation(observation);
    if (!this.#options.history) return { state: "value", value: { status: "unsupported" } };
    const snapshot = this.history.snapshot(scope), gaps = snapshot.coverage.gaps.filter(gap => ["missingPrefix", "missingFinal", "nativeGap"].includes(gap.kind)).map(gap => gap.id).sort();
    if (snapshot.coverage.knownStart && !gaps.length && snapshot.olderEdge.state !== "unknown") return { state: "healed" };
    const prepared = await this.#prepareHistory(scope, current, observation);
    if (prepared.state !== "value") return prepared;
    const handle = this.#baseline(scope, current, "recover", retryToken), reader = current.acquisitions.get(historyKey(scope));
    const observed = await this.#observeHistory(handle, observation);
    this.#active(); if (this.#record !== current || current.acquisitions.get(historyKey(scope)) !== reader) return { state: "retired" };
    return observed.state === "value" ? { state: "value", value: { status: observed.value.status } } : observed;
  }
  #baseline(scope: HistoryScope, current: HostRecord, kind: "initial" | "recover" = "recover", retryToken?: string): ReadHandle<AcquisitionResult> {
    const snapshot = this.history.snapshot(scope), acquisition = this.#acquisition(scope, current);
    // Neither callers nor viewers manufacture a new fact/allowance. Repeated
    // requests retain the same exhausted episode until real capture evidence changes.
    const fact = JSON.stringify(["baseline", current.run.generation, snapshot.generation, this.#historyScopes.get(historyKey(scope))?.gapFact ?? "initial"]);
    return acquisition.baseline(snapshot.coverage.knownStart ? "E06" : "E01", fact, kind, retryToken);
  }
  #initialHistory(current: HostRecord): void {
    const binding = this.#options.controller.current(), owner = this.history.owner(current.history);
    if (!this.#options.history || !binding || !sameRun(binding.run, current.run) || binding.fresh && owner.snapshot().coverage.knownStart || current.initial?.attachment === binding.identity.attachment) return;
    const initial = { attachment: binding.identity.attachment, work: Promise.resolve() }; current.initial = initial;
    const active = () => !this.#closed && !this.#closing && this.#record === current && current.initial === initial && !current.halted
      && this.#snapshot?.phase === "running" && this.#options.controller.current()?.identity.attachment === initial.attachment;
    initial.work = Promise.resolve().then(async () => {
      if (!active()) return;
      // Acquisition owns pending/outcome publication, including after an
      // observer expires. This attachment marker only prevents another start.
      await this.#baseline(current.history, current, "initial").settled;
    }).catch(() => { /* Admission failure owns no native work; an explicit check may try admission later. */ });
  }
  async #older(value: HistoryScope, cursor: string, generation?: string, retryToken?: string): Promise<HistoryPage> {
    const scope = copy(value), current = this.#historyContext(scope), snapshot = this.history.snapshot(scope);
    this.#historyObservation({});
    if (typeof generation !== "string" || generation !== snapshot.generation) throw new SessionError("FENCED");
    const acquisition = this.#acquisition(scope, current), reader = current.acquisitions.get(historyKey(scope))!;
    if (!cursor.startsWith(`${reader.context.length}:${reader.context}:`)) throw new SessionError("FENCED");
    const observed = await this.#observeHistory(acquisition.older({ scope, generation, cursor }, retryToken), {});
    this.#active(); if (this.#record !== current || current.acquisitions.get(historyKey(scope)) !== reader || this.history.snapshot(scope).readContext !== reader.context) throw new SessionError("FENCED");
    if (observed.state === "value" && observed.value.status === "ready") return observed.value.page;
    if (observed.state === "retired" || observed.state === "value" && observed.value.status === "stale") throw new SessionError("FENCED");
    if (observed.state === "failed") throw new SessionError("IO", "History page read failed; native episode was not replayed");
    if (observed.state === "waitingExpired") throw new SessionError("BUSY", "History page read is still owned");
    throw new SessionError(observed.state === "value" && observed.value.status === "unsupported" ? "UNSUPPORTED" : "IO", "History page unavailable; native episode was not replayed");
  }
  #nativeFileScope(run: RunRef): FileScope { return { ...this.#options.scope, session: run.nativeSession }; }
  fileScope(): FileScope | null { this.#active(); return this.#snapshot?.nativeSession ? this.#nativeFileScope(this.#currentRun()) : null; }
  /** Explicit configured choices from the trusted native adapter port. This
   * neither discovers native models nor starts/attaches a native session. */
  async controlCatalog(): Promise<Catalog> { this.#active(); const result = await this.runtime.catalog(); this.#active(); return result; }
  async binding(): Promise<HostBinding | null> { this.#active(); if (!this.#snapshot?.nativeSession) return null; const run = this.#currentRun(); return copy({ run, history: this.#ensure(run, false).history }); }
  #fileHost(nativeSession: string): Promise<FileHost> {
    if (this.#fileOwner) { requireThat(this.#fileOwner.nativeSession === nativeSession); return this.#fileOwner.promise; }
    const options = this.#options;
    const promise = FileHost.open({ ...options.files, directory: this.#fileDirectory(nativeSession), bindings: [{ scope: this.#nativeFileScope({ scope: options.scope, generation: 1, nativeSession }), cwd: options.cwd, dialect: process.platform === "win32" ? "win32" : "posix" }], broadPaths: options.files?.broadPaths ?? true, privateRoots: [options.directory, ...(options.files?.privateRoots ?? [])] });
    this.#fileOwner = { nativeSession, promise }; return promise;
  }
  #fileDirectory(nativeSession: string): string { return join(this.#options.directory, "files", createHash("sha256").update(nativeSession).digest("hex")); }
  #ensure(run: RunRef, fresh: boolean) {
    requireThat(this.#epoch !== undefined && scopeKey(run.scope) === scopeKey(this.#options.scope));
    const prior = this.#record;
    if (prior && sameRun(prior.run, run)) { this.#attachOwners(prior); return prior; }
    if (prior) prior.unsubscribe?.();
    const history = this.#options.controller.historyFacet.scope(run, `host-observation-${this.#epoch}`);
    const capture: CapturePort = { open: (scope, options) => {
      const native = options?.native === undefined ? undefined : copy(validateScopeFacts(options.native));
      this.history.open(scope, options);
      const prior = this.#historyScopes.get(historyKey(scope));
      this.#historyScopes.set(historyKey(scope), { ...(prior?.generation === run.generation ? prior : {}), scope, generation: run.generation,
        ...(native === undefined ? {} : { native }) });
      // The codec opens root first. #record may still be the previous run.
      this.#publishScopeInventory(run, history);
    }, emit: (scope, actions) => {
      const owner = this.history.owner(scope), priorBoundary = owner.readBoundary;
      const gaps = actions.filter(action => action.type === "gap" && ["missingPrefix", "missingFinal", "nativeGap"].includes(action.gap.kind));
      const gapFact = gaps.length ? createHash("sha256").update(canonical(gaps, 1048576)).digest("hex") : undefined;
      this.history.emit(scope, actions);
      if (gapFact) this.#historyScopes.get(historyKey(scope))!.gapFact = gapFact;
      if (owner.readBoundary !== priorBoundary) {
        this.#historyScopes.get(historyKey(scope))!.gapFact = createHash("sha256").update(canonical(["nativeReadBoundary", owner.readBoundary])).digest("hex");
        const current = this.#record, reader = current && sameRun(current.run, run) ? current.acquisitions.get(historyKey(scope)) : undefined;
        if (reader) owner.setReadContext(this.#readContext(scope, run, reader.lease));
      }
    }, reset: (scope, reason) => this.history.reset(scope, reason) };
    const codec = this.#options.controller.historyFacet.codec(history, capture, fresh && !this.#captureOverflow, this.#media.handler);
    const record: HostRecord = { run: copy(run), history, codec, acquisitions: new Map(), halted: false };
    this.#record = record; this.#attachOwners(record); return record;
  }
  #publishScopeInventory(run: RunRef, root: HistoryScope): void {
    const origin = canonical(root.origin);
    const scopes = [...this.#historyScopes.values()].filter(value => value.generation === run.generation && canonical(value.scope.origin) === origin)
      .map(value => ({ scope: value.scope, ...(value.native === undefined ? {} : { native: value.native }) }));
    this.history.owner(root).setScopeInventory({ nativeGeneration: run.generation, entries: scopes });
  }
  #admitReadScopes(current: HostRecord, scopes: readonly CapturedScope[]): void {
    let changed = false;
    for (const { scope } of scopes) {
      const key = historyKey(scope), prior = this.#historyScopes.get(key);
      if (prior?.generation === current.run.generation) continue; // Historical evidence cannot overwrite live capture facts.
      const count = [...this.#historyScopes.values()].filter(value => value.generation === current.run.generation).length;
      if (count === 32) {
        this.history.emit(current.history, [{ type: "gap", gap: { id: "history:child-scope-capacity", kind: "truncated" } }]);
        break;
      }
      try { this.history.open(scope, { knownStart: false }); }
      catch (error) {
        if (!(error instanceof PrimitiveError) || error.code !== "SCOPE_CAPACITY") throw error;
        this.history.emit(current.history, [{ type: "gap", gap: { id: "history:child-scope-capacity", kind: "truncated" } }]);
        break;
      }
      this.#historyScopes.set(key, { scope: copy(scope), generation: current.run.generation }); changed = true;
    }
    if (changed) this.#publishScopeInventory(current.run, current.history);
  }
  #attachOwners(record: { run: RunRef; mcp?: McpOwner; unsubscribe?: () => void }): void {
    if (record.unsubscribe) return;
    try {
      const interactions = this.#options.controller.interactions(record.run);
      record.unsubscribe = interactions.subscribe(record.run.scope, value => { for (const listener of [...this.#interactionListeners]) try { listener(value); } catch { /* viewer isolation */ } });
      record.mcp = new McpOwner({ run: record.run, epoch: this.#epoch!, native: this.#options.controller.nativeMcp(record.run), reads: this.#reads });
    } catch { /* Native owner unknown remains unknown; never resume to construct it. */ }
  }
  #resolvedMedia(scope: HistoryScope, row: Pick<HistoryRecord, "native">) {
    return rowMedia(row).map(occurrence => {
      const resolution = this.#media.lookup(scope, occurrence.id);
      return occurrence.state === "pending" || resolution.state === "available" ? { ...occurrence, ...resolution } : occurrence;
    });
  }
  #publishMedia(): void {
    const current = this.#record; if (this.#closed || !current) return;
    // Scope and resident rows are already bounded by HistoryHub. NativeFileCapture
    // remains the sole pending-job/resolution owner; this only publishes facts.
    for (const { scope, generation } of this.#historyScopes.values()) {
      if (generation !== current.run.generation) continue;
      const actions: Action[] = [];
      for (const row of this.history.snapshot(scope).rows) {
        const original = rowMedia(row); if (!original.length) continue;
        const media = this.#resolvedMedia(scope, row);
        if (canonical(original) !== canonical(media)) actions.push({ type: "media", id: row.id, media });
      }
      if (actions.length) this.history.emit(scope, actions);
    }
  }
  #capture(value: NativeCapture, cold = false): void {
    if (this.#closed || this.session?.archiving) return;
    if (this.#epoch === undefined) {
      try { const size = JSON.stringify(value).length; if (this.#pending.length >= 64 || this.#pendingBytes + size > 65536) this.#captureOverflow = true; else { this.#pending.push(value); this.#pendingBytes += size; } } catch { this.#captureOverflow = true; }
      return;
    }
    if (value.kind === "binding") { this.#ensure(value.binding.run, value.binding.fresh && !cold); return; }
    const current = this.#record; if (!current || !sameRun(current.run, value.run)) return;
    if (value.kind === "mcpChanged") { if (!current.halted) current.mcp?.invalidate(value.run); return; }
    if (value.kind === "historyGap") { this.#captureGap(current); return; }
    try { current.codec.observe(value.value); } catch { this.#captureGap(current); }
  }
  #captureGap(current: HostRecord): void {
    // The transcript owner reports its own failure. It cannot revoke an intact
    // native reverse-request baseline merely because a codec/consumer failed.
    const gap = { id: CAPTURE_GAP_ID, kind: "nativeGap" as const };
    this.history.emit(current.history, [{ type: "gap", gap },
      { type: "activity", activity: { turnId: this.history.snapshot(current.history).activity.turnId, state: "unknown" } }]);
    this.#historyScopes.get(historyKey(current.history))!.gapFact = createHash("sha256").update(canonical(gap)).digest("hex");
  }
  #halted(run: RunRef): void {
    const record = this.#record; if (!record || !sameRun(record.run, run) || record.halted) return;
    record.halted = true;
    record.mcp?.retire();
    record.acquisitions.clear();
    for (const { scope, generation } of this.#historyScopes.values()) if (generation === run.generation) this.history.owner(scope).setReadContext(this.#readContext(scope, run, "retired"));
  }
  updateReadiness(): Readonly<{ ready: boolean; reasons: readonly string[] }> {
    const reasons = [...this.session.updateReadiness().reasons];
    if (this.#historyReads.active || this.#reads.active || this.#media.diagnostics().pending) reasons.push("domain-work-unsettled");
    return { ready: reasons.length === 0, reasons };
  }
  async #archiveReady(): Promise<boolean> {
    if (this.#historyReads.active || this.#reads.active || this.#media.diagnostics().pending) return false;
    const reader = await this.session.readers.read();
    if (reader.state !== "none" && (reader.state !== "owned" || !this.#options.history?.release)) return false;
    if (this.#snapshot?.nativeSession) {
      const run = this.#currentRun();
      if (!await this.#sendPreparation!.archiveReady(run)) return false;
      if ((await (await this.#fileHost(run.nativeSession)).archiveStatus(this.#nativeFileScope(run))).activeReads) return false;
    }
    return !this.#options.archive || await this.#options.archive.ready();
  }
  async #releaseArchive(): Promise<void> {
    this.#media.close(); this.#record?.mcp?.retire();
    // Native capture is already fenced by the durable Archive admission. Keep
    // this same projection/read owner available to explicit passive history;
    // release current observers/cursors, not the retained native conversation.
    for (const { scope } of this.#historyScopes.values()) this.history.owner(scope).disconnect();
    this.#record?.acquisitions.clear();
    await this.#options.history?.release?.(this.session.readers);
    if ((await this.session.readers.read()).state !== "none") throw new SessionError("BUSY", "Reader custody remains unconfirmed");
    if (this.#snapshot?.nativeSession) {
      const run = this.#currentRun(); await this.#sendPreparation!.retire(run);
      await (await this.#fileHost(run.nativeSession)).seal(this.#nativeFileScope(run));
    }
    await this.#options.archive?.release();
  }
  async close(): Promise<void> {
    this.#active(); this.#closing = true;
    try { if (!this.updateReadiness().ready) throw new SessionError("BUSY"); await this.#options.history?.release?.(this.session.readers); await this.session.close(); await this.#dispose(false); }
    finally { if (!this.#closed) this.#closing = false; }
  }
  /** Owned writer loss only; native/controller custody is retained for inspection. */
  async terminate(): Promise<void> { if (this.#closed) return; await this.session.terminate(); await this.#dispose(true); }
  async #dispose(abrupt: boolean): Promise<void> {
    this.#closed = true; this.#detach(); this.#unsubscribe(); this.#detachMedia(); this.#record?.unsubscribe?.(); this.#interactionListeners.clear(); this.#media.close(); await this.#sendPreparation?.close();
    for (const { scope } of this.#historyScopes.values()) this.history.owner(scope).retire();
    if (abrupt) await this.#options.history?.release?.();
    if (abrupt) { if (this.#fileOwner) await (await this.#fileOwner.promise).terminate(); }
    else { await this.#media.drain(); if (this.#fileOwner) await (await this.#fileOwner.promise).close(); }
  }
}
export const openHost = (options: HostOptions): Promise<AgentHost> => AgentHost.open(options);
