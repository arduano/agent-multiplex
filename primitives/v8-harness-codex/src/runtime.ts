import { mkdir, readFile, writeFile, realpath, lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Catalog, NativeStart, OpeningRef, ReaderCustodyPort, RunRef } from "../../v8-session/src/contracts/types.js";
import { canonical, copy } from "../../v8-session/src/contracts/validation.js";
import type { RuntimeHalt, RuntimeIdentity } from "../../v8-runtime/src/contracts.js";
import { requireThat } from "../../v8-runtime/src/validation.js";
import type { CapturedScope, CodexScope, Scope as HistoryScope } from "../../v8-history/src/contracts/types.js";
import type { NativeMediaHandler } from "../../v8-history/src/contracts/media.js";
import type { AcquisitionPort, AcquisitionRequest } from "../../v8-history/src/acquisition/types.js";
import { validateScope as validateHistoryScope } from "../../v8-history/src/contracts/validation.js";
import { codexThreadMetadata, proveCodexLineage } from "../../v8-history/src/native/codex/lineage.js";
import { createCodexTimelineHistoryPort, type CodexTimelinePage } from "../../v8-history/src/native/codex/history.js";
import type { TrustedContainment } from "../../v8-host/src/contracts.js";
import { CodexController, type CodexTransport, type CodexNotification, type CodexReverseRequest } from "./controller.js";
import { CodexStdioRpc, spawnCodexWire, type CodexWireFactory } from "./rpc.js";
import { LinuxContainerOwner, inspectLinuxOpening, type DockerCommands } from "../../v8-host/src/native/linux.js";
import type { NativeAllocation, NativeAllocationBackend } from "../../v8-host/src/native/allocation.js";
import { retireReader } from "../../v8-host/src/native/reader.js";
import { codexMcpConfig, type CodexMcpServer } from "./mcp-config.js";
import { readCodexModels, unavailableCodexModels } from "./models.js";
import type { HostModelCatalog } from "../../v8-host/src/contracts.js";

export type CodexRuntimeOptions = Readonly<{
  directory: string; home: string; cwd: string; binary: string; packageRoot: string;
  model: string; environment: Readonly<Record<string, string>>;
  /** One private explicit route. No ambient login/config import or credit fallback. */
  provider: Readonly<{ id: string; baseUrl: string; environmentKey: string; copilotOnly: boolean }>;
  /** Explicit scripted override. Production defaults to native model/list. */
  catalog?: () => Promise<Catalog>;
  /** Existing Host-lifetime owner used before this session has a live RPC. */
  modelCatalog?: () => Promise<Catalog>;
  modelReadMs?: number;
  /** Trusted installation mapping, not browser-supplied native configuration. */
  developerInstructions?: string;
  mcpServers?: Readonly<Record<string, CodexMcpServer>>;
  multiAgent?: false | Readonly<{ maxThreads: number; maxDepth: number }>;
  docker?: string;
  /** Explicit supported runtime; absent retains the disposable Docker fixture. */
  allocation?: NativeAllocationBackend;
  /** Absolute lifetime of an explicit sessionless stopped-history reader. */
  readerLifetimeMs?: number;
  /** Offline dependency injection; never a second lifecycle controller. */
  commands?: DockerCommands; wire?: CodexWireFactory;
}>;
export type CodexPreparedReader = Readonly<{ port: AcquisitionPort<CodexScope>; close(): Promise<void> }>;
type ReaderOwner = { owner: NativeAllocation; run: RunRef; scope: CodexScope; pending: Promise<CodexPreparedReader>; port?: AcquisitionPort<CodexScope>; makePort?: (scope: CodexScope, media?: NativeMediaHandler) => AcquisitionPort<CodexScope>; authorize?: (scope: CodexScope, assertCurrent: () => void) => Promise<void>; pathContext?: (scope: CodexScope, assertCurrent: () => void) => Promise<unknown> };
type ModelReaderOwner = { owner: NativeAllocation; rpc?: CodexStdioRpc; closing?: Promise<void> };
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const record = (value: unknown): Record<string, unknown> => { requireThat(value && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; };

/** Pinned Codex preserves the managed prefix and appends its own project trust.
 * Accept only that closed metadata format, never another config/policy layer.
 * rust-v0.162.1 core/src/config/edit.rs: SetProjectTrustLevel. */
function sameManagedPolicy(actual: string, expected: string): boolean {
  if (!actual.startsWith(expected) || actual.length - expected.length > 65536) return false;
  const lines = actual.slice(expected.length).split("\n").filter(line => line !== ""), paths = new Set<string>();
  if (lines.length > 256 || lines.length % 2 !== 0) return false;
  for (let index = 0; index < lines.length; index += 2) {
    const header = lines[index]!, trust = lines[index + 1]!;
    if (!header.startsWith("[projects.") || !header.endsWith("]") || !['trust_level = "trusted"', 'trust_level = "untrusted"'].includes(trust)) return false;
    const encoded = header.slice("[projects.".length, -1); let path: unknown;
    try { path = JSON.parse(encoded); } catch { return false; }
    if (typeof path !== "string" || path.length > 4096 || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path) || JSON.stringify(path) !== encoded || paths.has(path)) return false;
    paths.add(path);
  }
  return true;
}

/** Exact rust-v0.162.1 experimental turn/start.collaborationMode shape.
 * Stable-only generated schemas omit it. CodexStdioRpc.initialize explicitly
 * opts into experimentalApi before this concrete transport accepts any turn.
 * Source: app-server-protocol/src/protocol/v2/turn.rs at rust-v0.162.1. */
function collaboration(value: unknown): void {
  const mode = record(value); requireThat(Object.keys(mode).sort().join(",") === "mode,settings" && (mode.mode === "plan" || mode.mode === "default"));
  const fields = record(mode.settings); requireThat(Object.keys(fields).sort().join(",") === "developer_instructions,model,reasoning_effort");
  requireThat(typeof fields.model === "string" && fields.model.length > 0 && fields.model.length <= 256);
  requireThat(fields.reasoning_effort === null || typeof fields.reasoning_effort === "string" && fields.reasoning_effort.length > 0 && fields.reasoning_effort.length <= 256);
  requireThat(fields.developer_instructions === null || typeof fields.developer_instructions === "string" && fields.developer_instructions.length <= 4096);
}

/** Inert factory. Only explicit Controller opening / prepareHistoryReader acquires. */
export function createCodexRuntime(options: CodexRuntimeOptions) {
  const fixed = copy({ ...options, catalog: undefined, modelCatalog: undefined, commands: undefined, wire: undefined, allocation: undefined });
  // JSON copy excludes function/capability fields; preserve them only privately.
  const wire = options.wire ?? spawnCodexWire;
  for (const path of [options.directory, options.home, options.cwd, options.binary, options.packageRoot]) requireThat(isAbsolute(path));
  requireThat(/^[A-Za-z0-9_-]+$/.test(options.provider.id) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(options.provider.environmentKey));
  requireThat(typeof options.model === "string" && options.model.length > 0 && options.model.length < 256);
  const endpoint = new URL(options.provider.baseUrl); requireThat(["http:", "https:"].includes(endpoint.protocol) && !endpoint.username && !endpoint.password && !endpoint.hash);
  requireThat(typeof options.environment[options.provider.environmentKey] === "string", "Explicit private provider credential environment is required");
  const environment = { ...fixed.environment, CODEX_HOME: fixed.home, HOME: fixed.home };
  const mcpConfig = codexMcpConfig(fixed.mcpServers ?? {});
  const notifications = new Set<(message: CodexNotification) => void>(), requests = new Set<(request: CodexReverseRequest) => void>(), disconnects = new Set<() => void>();
  let active: { input: NativeStart; owner: NativeAllocation; rpc?: CodexStdioRpc; initializing?: Promise<CodexStdioRpc>; run?: RunRef; openingStatus?: string | undefined;
    freshStart?: { rpc: CodexStdioRpc; nativeSession: string; status: "idle" | "notLoaded" } } | undefined;
  let reader: ReaderOwner | undefined;
  let readerEpoch = 0;
  const readerLifetime = options.readerLifetimeMs ?? 240_000;
  requireThat(Number.isSafeInteger(readerLifetime) && readerLifetime > 0 && readerLifetime <= 300_000);
  let poisoned = false;
  let lastRpc: CodexStdioRpc | undefined;
  let modelReader: ModelReaderOwner | undefined;
  let modelPending: Promise<Catalog> | undefined, modelsClosed = false;
  let liveModels: { actual: Promise<Catalog>; observed: Promise<Catalog> } | undefined;
  const modelReadMs = options.modelReadMs ?? 15_000;
  requireThat(Number.isSafeInteger(modelReadMs) && modelReadMs > 0 && modelReadMs <= 30_000);

  const configure = async () => {
    await mkdir(fixed.home, { recursive: true, mode: 0o700 }); requireThat(!(await lstat(fixed.home)).isSymbolicLink() && await realpath(fixed.home) === fixed.home);
    const file = join(fixed.home, "config.toml"), route = fixed.provider;
    let text = `model = ${JSON.stringify(fixed.model)}\nmodel_provider = ${JSON.stringify(route.id)}\napproval_policy = "on-request"\nsandbox_mode = "danger-full-access"\n${mcpConfig.hasHttp ? 'mcp_oauth_credentials_store_mode = "file"\n' : ''}[model_providers.${route.id}]\nname = "Managed Multiplex route"\nbase_url = ${JSON.stringify(route.baseUrl)}\nwire_api = "responses"\nenv_key = ${JSON.stringify(route.environmentKey)}\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`;
    if (fixed.multiAgent) { requireThat(Number.isSafeInteger(fixed.multiAgent.maxThreads) && fixed.multiAgent.maxThreads > 0 && fixed.multiAgent.maxThreads <= 8 && Number.isSafeInteger(fixed.multiAgent.maxDepth) && fixed.multiAgent.maxDepth > 0 && fixed.multiAgent.maxDepth <= 2); text += `[features]\nmulti_agent = true\n[agents]\nmax_threads = ${fixed.multiAgent.maxThreads}\nmax_depth = ${fixed.multiAgent.maxDepth}\n`; }
    // Pinned Config::multi_agent_version_for_model prefers model metadata to
    // the legacy Collab flag. V2 override itself precedes agents.enabled.
    else if (fixed.multiAgent === false) text += `[features]\nmulti_agent = false\nmulti_agent_v2 = false\n[agents]\nenabled = false\n`;
    text += mcpConfig.text;
    try { await writeFile(file, text, { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; requireThat(sameManagedPolicy(await readFile(file, "utf8"), text), "Private native policy differs from managed exact policy"); }
  };
  const allocate = (reference: string, kind: "agent" | "reader"): NativeAllocation => {
    const input = { directory: fixed.directory, binary: fixed.binary, packageRoot: fixed.packageRoot, home: fixed.home, cwd: kind === "reader" ? fixed.directory : fixed.cwd, args: ["app-server", "--stdio"], environment, reference, kind };
    return options.allocation ? options.allocation.allocate(input) : new LinuxContainerOwner({ ...input, ...(fixed.docker ? { docker: fixed.docker } : {}) }, options.commands);
  };
  const openRpc = async (owner: NativeAllocation, notification: (message: CodexNotification) => void, request: (request: CodexReverseRequest) => void, onLoss = () => {}, cwd = fixed.cwd, captured?: (rpc: CodexStdioRpc) => void) => {
    const prepared = await owner.prepare(); owner.assertLaunchable();
    const rpc = new CodexStdioRpc(wire({ launcher: prepared.launcher, cwd, environment }), notification, request, onLoss);
    captured?.(rpc);
    lastRpc = rpc;
    try { await rpc.initialize(); owner.assertLaunchable(); return rpc; }
    catch (error) { await rpc.close().catch(() => undefined); throw error; }
  };
  const ensureRpc = (): Promise<CodexStdioRpc> => {
    const held = active; requireThat(held && !poisoned && !held.owner.sealed, "Explicit managed opening is required before native RPC");
    return held.initializing ??= openRpc(held.owner, message => { if (active === held) for (const listener of notifications) listener(message); }, request => { if (active === held) for (const listener of requests) listener(request); }, () => { if (active === held) for (const listener of disconnects) listener(); }).then(rpc => { held.rpc = rpc; return rpc; });
  };
  const retireModels = (held = modelReader, reconcile = false): Promise<void> => {
    if (!held) return Promise.resolve();
    // A failed Stop stays owned. Only an explicit retirement may reconcile
    // exact positive absence; another read never retries a failed mutation.
    if (reconcile && held.closing) held.closing = held.closing.catch(async () => {
      requireThat(held.owner.sealed && held.owner.identity && await held.owner.inspect() === 'gone', 'Model reader cleanup remains unconfirmed');
      await held.rpc?.close();
      if (modelReader === held) modelReader = undefined;
    });
    return held.closing ??= (async () => {
      const results = await Promise.allSettled([held.owner.stop(), held.rpc?.close()]);
      requireThat(results.every(value => value.status === 'fulfilled'), "Model reader cleanup remains unconfirmed");
      if (modelReader === held) modelReader = undefined;
    })();
  };
  const modelCatalog: HostModelCatalog = Object.freeze({
    read(): Promise<Catalog> {
      requireThat(!modelsClosed, "Model catalog is closed");
      if (modelPending) return modelPending;
      requireThat(!modelReader, "Model reader cleanup remains unconfirmed");
      if (options.catalog) return options.catalog();
      const owner = allocate(`model-catalog-${randomUUID()}`, 'reader'), held: ModelReaderOwner = { owner }; modelReader = held;
      modelPending = (async () => {
        let expired = false;
        const timer = setTimeout(() => { expired = true; void retireModels(held).catch(() => {}); }, modelReadMs); timer.unref();
        try {
          // Establish exact allocation custody before any cancellable await.
          // prepare creates the owned gate; no vendor process runs until RPC.
          await owner.prepare();
          await configure(); requireThat(modelReader === held && !modelsClosed && !owner.sealed && !expired);
          const rpc = await openRpc(owner, () => {}, () => {}, () => {}, fixed.directory, rpc => { held.rpc = rpc; });
          const current = () => { requireThat(modelReader === held && !modelsClosed && !owner.sealed && !expired); const observed = rpc.observation(); requireThat(observed.connected && observed.pendingReverse === 0 && !observed.ambiguousReverse && observed.turnStarts === 0 && observed.itemStarts === 0, 'Sessionless model reader received native work'); };
          return await readCodexModels(params => rpc.request('model/list', params), current);
        } catch { return unavailableCodexModels(); }
        finally { clearTimeout(timer); await retireModels(held); }
      })().finally(() => { modelPending = undefined; });
      return modelPending;
    },
    async retire() { await retireModels(modelReader, true); await modelPending?.catch(() => {}); },
    readiness() { return modelReader || modelPending ? { ready: false as const, reasons: ['Native model-reader custody remains owned'] } : { ready: true as const }; },
    async close() { modelsClosed = true; await modelCatalog.retire(); },
  });
  const catalog = (): Promise<Catalog> => {
    if (options.catalog) return options.catalog();
    const held = active;
    if (!held?.rpc || held.owner.sealed || poisoned) return options.modelCatalog ? options.modelCatalog() : modelCatalog.read();
    if (liveModels) return liveModels.observed;
    let expired = false, timer: ReturnType<typeof setTimeout> | undefined;
    const actual = readCodexModels(params => held.rpc!.request('model/list', params), () => requireThat(!expired && active === held && !held.owner.sealed && !poisoned && held.rpc!.observation().connected));
    const observed = Promise.race([actual.catch(unavailableCodexModels), new Promise<Catalog>(resolve => { timer = setTimeout(() => { expired = true; resolve(unavailableCodexModels()); }, modelReadMs); timer.unref(); })]);
    const selected = { actual, observed }; liveModels = selected;
    void actual.finally(() => { clearTimeout(timer); if (liveModels === selected) liveModels = undefined; }).catch(() => {});
    return observed;
  };
  const transport: CodexTransport = {
    async request(method, params) {
      requireThat((method === "config/mcpServer/reload") === (params === undefined), "Native method body differs");
      const fields = params ?? {};
      if (method === "turn/start") requireThat(Object.keys(fields).every(key => ["threadId", "input", "clientUserMessageId", "model", "effort", "approvalPolicy", "sandboxPolicy", "permissions", "collaborationMode"].includes(key)), "Pinned Codex selection encoder is unsupported");
      if (method === "thread/settings/update") requireThat(Object.keys(fields).every(key => ["threadId", "model", "effort", "approvalPolicy", "sandboxPolicy", "permissions", "collaborationMode"].includes(key)), "Pinned Codex thread settings encoder is unsupported");
      if ((method === "turn/start" || method === "thread/settings/update") && "permissions" in fields) requireThat(typeof fields.permissions === 'string' && fields.permissions.length > 0 && fields.permissions.length <= 256 && !/[\x00-\x1f\x7f]/.test(fields.permissions) && !('sandboxPolicy' in fields), 'Native permission profile differs');
      if (method === "turn/settings/update") requireThat(Object.keys(fields).every(key => ["threadId", "turnId", "model", "effort"].includes(key)), "Pinned Codex running-turn settings encoder is unsupported");
      if ((method === "turn/start" || method === "thread/settings/update") && "collaborationMode" in fields) collaboration(fields.collaborationMode);
      const held = active, rpc = await ensureRpc(); requireThat(active === held && held && !held.owner.sealed);
      const result = await rpc.request(method, params);
      if (method === "thread/start" || method === "thread/resume") {
        const thread = record(record(result).thread), id = thread.id; requireThat(typeof id === "string"); held.run = { scope: held.input.scope, generation: held.input.generation, nativeSession: id };
        const status = thread.status && typeof thread.status === "object" ? record(thread.status).type : undefined;
        held.openingStatus = typeof status === "string" ? status : undefined;
        if (method === "thread/start" && held.input.nativeSession === null && (status === "idle" || status === "notLoaded")) held.freshStart = { rpc, nativeSession: id, status };
      }
      return result;
    },
    onNotification(listener) { notifications.add(listener); return () => notifications.delete(listener); },
    onRequest(listener) { requests.add(listener); return () => requests.delete(listener); },
    onDisconnect(listener) { disconnects.add(listener); return () => disconnects.delete(listener); },
  };
  const identity = (run: RunRef): RuntimeIdentity => { const held = active; requireThat(held?.run && same(held.run, run) && held.owner.identity); return { ...held.owner.identity, run: copy(run) }; };
  const stopped = (id: RuntimeIdentity): RuntimeHalt => ({ identity: copy(id), proof: { run: copy(id.run), state: "stopped", scope: "nativeTree", noAutomaticContinuation: true }, boundary: { kind: "dedicated", containmentRetired: true } });
  const containment: TrustedContainment = {
    placement: "dedicated", capabilities: { fullStop: true, createAndWait: true, reopen: true },
    ...(options.allocation?.parentCustody ? { parentCustody: options.allocation.parentCustody } : {}),
    async prepareOpening(input) {
      requireThat(!poisoned && !reader, "Explicit history-reader custody must be retired before agent opening");
      if (active) requireThat(active.owner.sealed && await active.owner.inspect() === "gone", "Previous native containment is not proven retired");
      requireThat(input.policy.kind === "codex" && (input.policy.provider !== "copilot-only" || fixed.provider.copilotOnly));
      const opening: OpeningRef = { scope: input.scope, generation: input.generation, operationId: input.operationId }, owner = allocate(canonical(opening), "agent");
      const held = { input: copy(input), owner }; active = held;
      try { await configure(); return await owner.opening(opening); } catch (error) { poisoned = !owner.identity; throw error; }
    },
    inspectOpening: capsule => options.allocation ? options.allocation.inspectOpening(capsule) : inspectLinuxOpening(capsule, fixed.docker ? { docker: fixed.docker } : {}, options.commands),
    identity,
    async observeOpening(input, run) {
      const held = active; requireThat(held?.run && same(held.run, run) && same(held.input, input) && !held.owner.sealed);
      if (input.nativeSession !== null) {
        const observed = held.rpc!.observation();
        requireThat(observed.connected && !observed.ambiguousReverse, "Native reopening observation is unavailable");
        return { kind: "reopened", run, callbacksComplete: observed.pendingReverse === 0, continuous: true, ...(held.openingStatus === "idle" && observed.turnStarts === 0 && observed.itemStarts === 0 ? { activity: "idle" as const } : {}) };
      }
      // Only fresh thread/start promises quiescence. Explicit reopening may run saved work.
      requireThat(input.nativeSession === null && held.freshStart?.nativeSession === run.nativeSession && held.rpc === held.freshStart.rpc, "Fresh Codex Create evidence is unavailable");
      const observed = held.rpc.observation();
      requireThat(observed.connected && observed.pendingReverse === 0 && !observed.ambiguousReverse && observed.turnStarts === 0 && observed.itemStarts === 0, "Fresh Codex Create is no longer quiescent and continuous");
      return { kind: "created", run, noAutomaticContinuation: true, callbacksComplete: true, continuous: true,
        ...(held.freshStart.status === "idle" ? { activity: "idle" as const } : {}) };
    },
    async inspect(run) { const held = active; if (!held?.run || !same(held.run, run)) return null; const state = await held.owner.inspect(); return state === "gone" ? stopped(identity(run)) : "owned"; },
    async stopTree(id) { const held = active; requireThat(held?.run && same(id, identity(held.run))); await held.owner.stop(); await held.rpc?.close(); return stopped(id); },
  };
  const controller = new CodexController({ transport, containment, cwd: fixed.cwd, model: fixed.model, provider: { id: fixed.provider.id, copilotOnly: fixed.provider.copilotOnly }, catalog, mcpTransports: mcpConfig.transports, ...(fixed.developerInstructions ? { developerInstructions: fixed.developerInstructions } : {}) });
  const authorize = (run: RunRef, scope: CodexScope) => { requireThat(scope.kind === "codex" && scope.origin.nativeSession === run.nativeSession && scope.origin.host === run.scope.host && scope.origin.connection === run.scope.connection && scope.origin.principal === run.scope.principal, "Reader has no foreign native authority"); };
  // This proof is local to one admitted page. It grants no live ownership,
  // mutation or Resume authority, and a later page proves its chain afresh.
  const authorizePage = async (rpc: CodexStdioRpc, run: RunRef, scope: CodexScope, assertCurrent: () => void, cache = new Map<string, unknown>()) => {
    assertCurrent(); if (scope.threadId === run.nativeSession) return;
    const metadata: unknown[] = [], seen = new Set<string>(); let selected: unknown;
    const read = async (threadId: string) => {
      assertCurrent(); let value = cache.get(threadId);
      if (value === undefined) {
        requireThat(cache.size < 32, "Native child metadata proof exceeds page bound");
        value = record(await rpc.request("thread/read", { threadId, includeTurns: false })).thread;
        assertCurrent(); cache.set(threadId, value);
      }
      assertCurrent(); const node = codexThreadMetadata(value); requireThat(node.id === threadId, "Native metadata identity differs");
      metadata.push(value); if (threadId === scope.threadId) selected = value; return node;
    };
    await read(run.nativeSession);
    let threadId = scope.threadId;
    for (let depth = 0; depth < 32; depth++) {
      requireThat(!seen.has(threadId), "Cyclic native child ancestry"); seen.add(threadId);
      const node = await read(threadId); requireThat(node.parent, "Native thread is not a proved descendant");
      if (node.parent === run.nativeSession) {
        proveCodexLineage({ rootThreadId: run.nativeSession, threadId: scope.threadId, metadata }); return selected;
      }
      threadId = node.parent;
    }
    requireThat(false, "Native child ancestry exceeds bound");
  };
  const discoverPage = async (rpc: CodexStdioRpc, run: RunRef, root: CodexScope, threadIds: readonly string[], assertCurrent: () => void): Promise<readonly CapturedScope[]> => {
    const cache = new Map<string, unknown>(), proved: CapturedScope[] = [];
    for (const threadId of threadIds) {
      const scope: CodexScope = { ...copy(root), threadId };
      try { await authorizePage(rpc, run, scope, assertCurrent, cache); assertCurrent(); proved.push({ scope }); }
      catch { assertCurrent(); } // Unavailable/foreign proof cannot discard valid parent bodies.
    }
    return proved;
  };
  const historyPort = (runInput: RunRef, scopeInput: CodexScope, media?: NativeMediaHandler): AcquisitionPort<CodexScope> => {
    const run = copy(runInput), scope = copy(validateHistoryScope(copy(scopeInput))) as CodexScope;
    authorize(run, scope);
    if (reader?.port && same(reader.run, run) && !reader.owner.sealed) return !media && same(reader.scope, scope) ? reader.port : reader.makePort!(scope, media);
    const held = active;
    if (!held || held.owner.sealed) {
      const frozenScope = copy(validateHistoryScope(copy(scope))) as CodexScope;
      return Object.freeze({ scope: frozenScope, mode: "active" as const, context: `codex-inactive:${readerEpoch}`,
        async read(request: AcquisitionRequest<CodexScope>, assertCurrent?: () => void) {
          assertCurrent?.(); requireThat(same(request.scope, frozenScope) && Number.isSafeInteger(request.count) && request.count > 0 && request.count <= 128 && (request.cursor === null || typeof request.cursor === "string" && request.cursor.length > 0 && request.cursor.length <= 4096));
          return { scope: frozenScope, status: "unsupported" as const, records: [], gaps: [], hasMore: false, nextCursor: null };
        } });
    }
    requireThat(held.run && same(held.run, run) && held.owner.identity, "No observed exact native history owner");
    requireThat(held.rpc, "No connected exact native history reader"); const rpc = held.rpc;
    const assertCurrent = () => requireThat(active === held && !held.owner.sealed && same(held.run, run));
    requireThat(held.owner.identity);
    return createCodexTimelineHistoryPort({ scope, context: `${held.owner.identity.attachment}:active:timeline-v1`, ...(media ? { media } : {}), assertCurrent, authorize: async () => { await authorizePage(rpc, run, scope, assertCurrent); },
      discover: (ids, current) => discoverPage(rpc, run, scope, ids, () => { assertCurrent(); current(); }), list: async request => await rpc.request("thread/timeline/list", request) as CodexTimelinePage });
  };
  async function prepareHistoryReader(runInput: RunRef, scopeInput: CodexScope, custody?: ReaderCustodyPort): Promise<CodexPreparedReader> {
    const run = copy(runInput), scope = copy(validateHistoryScope(copy(scopeInput))) as CodexScope;
    authorize(run, scope);
    if (reader) {
      const held = reader;
      if (!held.owner.sealed) {
        requireThat(same(held.run, run), "One exact root history run at a time");
        const prepared = await held.pending;
        return same(held.scope, scope) ? prepared : { port: held.makePort!(scope), close: prepared.close };
      }
      // Sealing starts retirement; only exact completed retirement permits a
      // replacement helper. Observer expiry cannot multiply native readers.
      await held.pending.then(value => value.close());
      if (reader && reader !== held) return prepareHistoryReader(run, scope, custody);
    }
    requireThat(!poisoned, "Native allocation is unknown");
    const opening: OpeningRef = { scope: run.scope, generation: run.generation, operationId: `reader-${randomUUID()}` };
    const owner = allocate(canonical(opening), "reader");
    const state: ReaderOwner = { owner, run: copy(run), scope: copy(scope), pending: Promise.resolve(null as unknown as CodexPreparedReader) }; reader = state;
    state.pending = (async () => {
      let rpc: CodexStdioRpc | undefined, closed = false, acquiring = false, closing: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      const close = () => closing ??= (async () => { closed = true; clearTimeout(timer); const identity = await owner.stop(); await rpc?.close(); await custody?.released({ opening, identity, state: "stopped", scope: "nativeTree", noAutomaticContinuation: true, acquisitionSealed: true }); if (reader === state) { reader = undefined; readerEpoch++; } })();
      try {
        await retireReader(custody, capsule => options.allocation ? options.allocation.inspectOpening(capsule, "reader") : inspectLinuxOpening(capsule, fixed.docker ? { docker: fixed.docker } : {}, options.commands, "reader"));
        if (active) requireThat(active.owner.sealed && await active.owner.inspect() === "gone", "Agent native containment must be proven retired first");
        await configure(); await custody?.begin(run, opening); acquiring = true;
        const captured = await owner.opening(opening); await custody?.owned(run, { opening: captured.opening, identity: captured.identity });
        timer = setTimeout(() => { void close().catch(() => { poisoned = true; }); }, readerLifetime); timer.unref();
        // Auxiliary history has no project work; Archive may have released cwd.
        rpc = await openRpc(owner, () => undefined, () => { /* A sessionless reader must not answer unexpected native callbacks. */ }, () => {}, fixed.directory);
        const assertCurrent = () => requireThat(reader === state && !closed && !owner.sealed);
        const metadata = record(await rpc.request("thread/read", { threadId: run.nativeSession, includeTurns: false })); assertCurrent(); requireThat(record(metadata.thread).id === run.nativeSession);
        let calls = 0;
        requireThat(owner.identity);
        const context = `${owner.identity.attachment}:reader:timeline-v1`;
        state.authorize = async (attached, outer) => { authorize(run, attached); assertCurrent(); outer(); requireThat(rpc); await authorizePage(rpc, run, attached, () => { assertCurrent(); outer(); }); };
        state.pathContext = async (attached, outer) => { authorize(run, attached); assertCurrent(); outer(); requireThat(rpc); return authorizePage(rpc, run, attached, () => { assertCurrent(); outer(); }); };
        state.makePort = (attached, media) => { authorize(run, attached); return createCodexTimelineHistoryPort({ scope: attached, context, ...(media ? { media } : {}), assertCurrent, authorize: () => state.authorize!(attached, () => {}),
          discover: (ids, current) => { requireThat(rpc); return discoverPage(rpc, run, attached, ids, () => { assertCurrent(); current(); }); },
          list: async request => { requireThat(rpc && ++calls <= 32, "Prepared native history-reader read bound exceeded"); return await rpc.request("thread/timeline/list", request) as CodexTimelinePage; } }); };
        const port = state.makePort(scope);
        state.port = port; return { port, close };
      } catch (error) { if (acquiring) await close().catch(() => { poisoned = true; }); else if (reader === state) reader = undefined; throw error; }
    })(); return state.pending;
  }
  async function readControlState(run: RunRef) {
    const held = active; requireThat(held?.run && same(held.run, run) && held.rpc && !held.owner.sealed, "No connected exact native control reader");
    const rpc = held.rpc, result = record(await rpc.request("thread/read", { threadId: run.nativeSession, includeTurns: false }));
    requireThat(active === held && !held.owner.sealed && record(result.thread).id === run.nativeSession);
    const status = record(record(result.thread).status); requireThat(["notLoaded", "idle", "systemError", "active"].includes(String(status.type)));
    return Object.freeze({ status: copy(status), ...rpc.observation() });
  }
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    poisoned = true; modelsClosed = true; const held = active, read = reader;
    // stop() seals synchronously, even while immutable allocation is pending.
    const stops = [held?.owner.stop(), read?.owner.stop(), modelCatalog.retire()].filter(value => value !== undefined);
    closing = (async () => {
      const results = await Promise.allSettled(stops);
      const wires = await Promise.allSettled([held?.rpc?.close(), read ? read.pending.catch(() => undefined).then(prepared => prepared?.close()) : undefined]);
      requireThat([...results, ...wires].every(result => result.status === "fulfilled"), "Owned native cleanup remains unconfirmed");
    })(); return closing;
  }
  return Object.freeze({ controller, modelCatalog, nativeInputRoots: Object.freeze([fixed.cwd]), history: {
    async pathContext(run: RunRef, scope: HistoryScope, outer: () => void) {
      requireThat(scope.kind === "codex"); authorize(run, scope); outer();
      if (scope.threadId === run.nativeSession) return { cwd: fixed.cwd, dialect: process.platform === "win32" ? "win32" as const : "posix" as const };
      const held = active;
      const raw = held && !held.owner.sealed && held.rpc && same(held.run, run)
        ? await authorizePage(held.rpc, run, scope, () => { outer(); requireThat(active === held && !held.owner.sealed && same(held.run, run)); })
        : reader && !reader.owner.sealed && same(reader.run, run) && reader.pathContext
          ? await reader.pathContext(scope, outer) : undefined;
      outer(); const cwd = record(raw).cwd;
      requireThat(typeof cwd === "string" && cwd.length <= 4096 && isAbsolute(cwd) && !/[\x00-\x1f\x7f]/.test(cwd), "Native child cwd unavailable");
      return { cwd, dialect: process.platform === "win32" ? "win32" as const : "posix" as const };
    },
    port: (run: RunRef, scope: HistoryScope, media?: NativeMediaHandler) => { requireThat(scope.kind === "codex"); return historyPort(run, scope, media); },
    async prepare(run: RunRef, scope: HistoryScope, custody?: ReaderCustodyPort) { requireThat(scope.kind === "codex"); await prepareHistoryReader(run, scope, custody); },
    async release(custody?: ReaderCustodyPort) { await reader?.pending.then(value => value.close()); await retireReader(custody, capsule => options.allocation ? options.allocation.inspectOpening(capsule, "reader") : inspectLinuxOpening(capsule, fixed.docker ? { docker: fixed.docker } : {}, options.commands, "reader")); },
    async authorize(runInput: RunRef, scopeInput: HistoryScope, outer: () => void) {
      const run = copy(runInput), scope = copy(validateHistoryScope(copy(scopeInput)));
      requireThat(scope.kind === "codex"); authorize(run, scope); outer();
      if (reader?.authorize && same(reader.run, run) && !reader.owner.sealed) return reader.authorize(scope, outer);
      const held = active; requireThat(held?.run && same(held.run, run) && held.rpc && !held.owner.sealed, "No connected exact native history owner");
      await authorizePage(held.rpc, run, scope, () => { outer(); requireThat(active === held && !held.owner.sealed && same(held.run, run)); });
    }
  }, prepareHistoryReader, readControlState, diagnostics: () => lastRpc?.diagnostics() ?? null, close });
}

/** One inert Host-level metadata owner. Its native home/custody are separate
 * from every conversation; MCP and workspace work are absent from this reader. */
export function createCodexModelCatalog(options: Omit<CodexRuntimeOptions, 'home' | 'cwd' | 'mcpServers' | 'developerInstructions' | 'multiAgent' | 'modelCatalog'>): HostModelCatalog {
  const runtime = createCodexRuntime({ ...options, home: join(options.directory, 'home'), cwd: options.directory, multiAgent: false });
  return Object.freeze({ read: runtime.modelCatalog.read, retire: runtime.modelCatalog.retire, readiness: runtime.modelCatalog.readiness, close: runtime.close });
}
