import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionError, sameRun, scopeKey, type Json, type NativeStart, type NativeOpening, type OpeningCapsule, type OpeningRef, type OpeningStopProof, type ReaderCustodyPort, type RunRef, type SessionScope } from "../../v8-session/src/contracts/types.js";
import { canonical, copy } from "../../v8-session/src/contracts/validation.js";
import type { RuntimeHalt, RuntimeIdentity } from "../../v8-runtime/src/contracts.js";
import { requireThat } from "../../v8-runtime/src/validation.js";
import type { CopilotScope, Scope } from "../../v8-history/src/contracts/types.js";
import type { NativeMediaHandler } from "../../v8-history/src/contracts/media.js";
import { sameScope } from "../../v8-history/src/contracts/identity.js";
import { createCopilotHistoryPort, type CopilotActiveHistoryRequest, type CopilotPersistedHistoryRequest } from "../../v8-history/src/native/copilot/history.js";
import type { AcquisitionPort, AcquisitionRequest } from "../../v8-history/src/acquisition/types.js";
import { CopilotController, type CopilotControllerOptions, type CopilotSession, type CopilotSessionConfig } from "./controller.js";
import type { HostHistory, TrustedContainment } from "../../v8-host/src/contracts.js";
import { LinuxContainerOwner, inspectLinuxOpening, type DockerCommands } from "../../v8-host/src/native/linux.js";
import type { NativeAllocation, NativeAllocationBackend } from "../../v8-host/src/native/allocation.js";
import { retireReader } from "../../v8-host/src/native/reader.js";
import { copilotMcpTransports } from "../../v8-mcp/src/native.js";

export const COPILOT_SDK_VERSION = "1.0.19";
export const COPILOT_CLI_VERSION = "1.0.95";
/** Must match the pinned SDK's generated argv; the launcher checks it again. */
export const COPILOT_CLI_ARGS = Object.freeze(["--headless", "--no-auto-update", "--log-level", "error", "--stdio", "--no-auto-login"]);
export type CopilotBeforeToolInput = Readonly<{ sessionId: string; toolName: string; toolArgs: unknown }>;
export type CopilotBeforeToolResult = Readonly<{ deny: string }> | null | undefined;
/** Trusted backend capability, never JSON configuration or an approval bypass. */
export type CopilotBeforeTool = (input: CopilotBeforeToolInput, invocation: Readonly<{ sessionId: string }>) => CopilotBeforeToolResult | Promise<CopilotBeforeToolResult>;
type NativeToolDecision = Readonly<{ permissionDecision: "deny"; permissionDecisionReason: string }>;
type CopilotModelCapabilities = Readonly<{ supports: Readonly<{ vision: boolean }> }>;
export type CopilotRuntimeSessionConfig = Omit<CopilotSessionConfig, "onControlLost"> & CopilotRuntimeOptions["sessionOptions"] & Readonly<{ modelCapabilities?: CopilotModelCapabilities; hooks?: Readonly<{ onPreToolUse(input: unknown, invocation: unknown): Promise<NativeToolDecision | undefined> }> }>;

type NativeSession = CopilotSession & Readonly<{ on(listener: (event: unknown) => void): () => void; rpc: CopilotSession["rpc"] & Readonly<{
  eventLog: Readonly<{ read(request: CopilotActiveHistoryRequest): Promise<unknown> }>;
  permissions: CopilotSession["rpc"]["permissions"] & Readonly<{ pendingRequests(): Promise<unknown> }>;
  tools: Readonly<{ listPendingRequests(): Promise<unknown> }>;
  metadata: Readonly<{ activity(): Promise<unknown> }>;
}> }>;
/** Narrow SDK seam, also used by offline tests. No automatic start is exposed. */
export interface CopilotRuntimeClient {
  start(): Promise<void>;
  getStatus(): Promise<Readonly<{ version: string; protocolVersion: number }>>;
  forceStop(): Promise<void>;
  createSession(config: CopilotRuntimeSessionConfig): Promise<NativeSession>;
  resumeSession(id: string, config: CopilotRuntimeSessionConfig & Readonly<{ continuePendingWork: true; allowTranscriptRecovery: false }>): Promise<NativeSession>;
  readonly rpc: Readonly<{ sessions: Readonly<{ readPersistedEvents(request: CopilotPersistedHistoryRequest): Promise<unknown> }> }>;
}
export type CopilotRuntimeOptions = Readonly<{
  scope: SessionScope;
  /** Private per-logical-session native state; never an existing user's home. */
  nativeHome: string; cwd: string; launchDirectory: string;
  cliBinary: string; cliPackageRoot: string; docker?: string;
  allocation?: NativeAllocationBackend;
  /** Explicit trusted host tool environment; managed home variables stay fixed. */
  environment?: Readonly<Record<string, string>>;
  model: CopilotControllerOptions["model"]; provider: CopilotControllerOptions["provider"];
  catalog: CopilotControllerOptions["catalog"]; newSessionId?: () => string;
  /** Trusted declaration for this configured model, not discovered capability
   * or proof that a native/provider request actually included an image. */
  modelCapabilities?: CopilotModelCapabilities;
  /** Trusted static feature configuration. Ownership/auth/callbacks stay fixed. */
  sessionOptions?: Readonly<{ availableTools?: readonly string[]; excludedTools?: readonly string[]; mcpServers?: Readonly<Record<string, Json>>; mcpOAuthTokenStorage?: "persistent" | "in-memory"; enableConfigDiscovery?: boolean; enableManagedSettings?: boolean; customAgents?: readonly Json[]; skillDirectories?: readonly string[]; systemMessage?: Json }>;
  /** Null/undefined preserves native permission behavior. Denial is the only
   * override; exceptions/invalid results become explicit native denials. */
  beforeTool?: CopilotBeforeTool;
  /** Absolute resource lifetime, including held reads; never a viewer timeout. */
  readerLifetimeMs?: number;
}>;
export type CopilotRuntimeDependencies = Readonly<{
  commands?: DockerCommands;
  client?: (input: Readonly<{ launcher: string; home: string; cwd: string; environment: Record<string, string> }>) => CopilotRuntimeClient;
}>;
export type CopilotHistoryReader = Readonly<{ port: AcquisitionPort<CopilotScope>; close(): Promise<void> }>;
export type CopilotRuntimeDiagnostic = Readonly<{
  stage: "sdk.start" | "status.get" | "session.create" | "session.resume" | "resume.boundary" | "certificate" | "session.model.getCurrent" | "session.model.switchTo" | "session.permissions.setMode" | "session.permissions.getMode" | "session.permissions.setRequired" | "session.mode.set" | "session.mode.get" | "session.permissions.pendingRequests" | "session.tools.listPendingRequests" | "session.metadata.activity" | "session.eventLog.read" | "sessions.readPersistedEvents";
  owner: "agent" | "reader"; state: "pending" | "fulfilled" | "failed";
  /** Fixed allowlisted field names only; never response values, IDs or bodies. */
  fields: readonly string[]; nativeCode?: number;
}>;
export type CopilotRuntime = Readonly<{
  controller: CopilotController; history: HostHistory;
  readonly nativeInputRoots: readonly string[];
  diagnostics(): readonly CopilotRuntimeDiagnostic[];
  /** Explicit backend acquisition. Never invoked by mount/reconnect/port.read. */
  prepareHistoryReader(run: RunRef, scope: CopilotScope): Promise<CopilotHistoryReader>;
  /** Exact owned shutdown for backend retirement, not a UI observation cleanup. */
  close(): Promise<void>;
}>;
type Allocation = { owner: NativeAllocation; input: NativeStart; opening?: NativeOpening; client?: CopilotRuntimeClient; session?: NativeSession; run?: RunRef; claimed: boolean; halted: boolean; resumeBoundary?: boolean | undefined; retirement?: Promise<void> };
type Reader = { run: RunRef; scope: CopilotScope; ready: Promise<CopilotHistoryReader>; close(): Promise<void>; port?: AcquisitionPort<CopilotScope>; makePort?: (scope: CopilotScope, media?: NativeMediaHandler) => AcquisitionPort<CopilotScope>; retired: boolean };
function emptyItems(value: unknown): boolean { return !!value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items) && (value as { items: unknown[] }).items.length === 0; }
function inactive(value: unknown): boolean { return !!value && typeof value === "object" && (value as { hasActiveWork?: unknown }).hasActiveWork === false && (value as { abortable?: unknown }).abortable === false; }
function modelCapabilities(options: CopilotRuntimeOptions): CopilotModelCapabilities | undefined {
  const option = Object.getOwnPropertyDescriptor(options, "modelCapabilities");
  requireThat(option ? "value" in option : !("modelCapabilities" in options), "Invalid trusted Copilot model capabilities");
  if (option?.value === undefined) return undefined;
  const field = (input: unknown, key: string): unknown => {
    requireThat(input !== null && typeof input === "object" && !Array.isArray(input), "Invalid trusted Copilot model capabilities");
    const prototype = Object.getPrototypeOf(input), keys = Reflect.ownKeys(input);
    requireThat((prototype === Object.prototype || prototype === null) && keys.length === 1 && keys[0] === key, "Invalid trusted Copilot model capabilities");
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    requireThat(descriptor && "value" in descriptor, "Invalid trusted Copilot model capabilities");
    return descriptor.value;
  };
  const vision = field(field(option.value, "supports"), "vision");
  requireThat(typeof vision === "boolean", "Invalid trusted Copilot model capabilities");
  return Object.freeze({ supports: Object.freeze({ vision }) });
}

function environment(home: string, container: boolean, tools: Readonly<Record<string, string>>): Record<string, string> {
  return { PATH: container ? "/usr/local/bin:/usr/bin:/bin" : "/usr/bin:/bin", SHELL: "/bin/bash", LANG: "C.UTF-8", TMPDIR: container ? "/tmp" : home, ...tools,
    HOME: home, COPILOT_HOME: home, XDG_CONFIG_HOME: join(home, "xdg-config"), XDG_CACHE_HOME: join(home, "xdg-cache"), XDG_DATA_HOME: join(home, "xdg-data") };
}
async function checkVersions(options: CopilotRuntimeOptions): Promise<void> {
  const sdkRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@github/copilot-sdk"))));
  const [sdk, cli] = await Promise.all([readFile(join(sdkRoot, "package.json"), "utf8"), readFile(join(options.cliPackageRoot, "package.json"), "utf8")]);
  const sdkMeta = JSON.parse(sdk) as Record<string, unknown>, cliMeta = JSON.parse(cli) as Record<string, unknown>;
  requireThat(sdkMeta.name === "@github/copilot-sdk" && sdkMeta.version === COPILOT_SDK_VERSION && sdkMeta.copilotCliVersion === COPILOT_CLI_VERSION, "Copilot SDK pin differs");
  requireThat(cliMeta.name === "@github/copilot-linux-x64" && cliMeta.version === COPILOT_CLI_VERSION, "Copilot CLI pin differs");
}
type ClientInput = Readonly<{ launcher: string; home: string; cwd: string; environment: Record<string, string> }>;
type SdkModule = Readonly<{
  CopilotClient: new (options: Readonly<{ connection: unknown; mode: "copilot-cli"; workingDirectory: string; baseDirectory: string; useLoggedInUser: false; logLevel: "error" }>) => CopilotRuntimeClient;
  RuntimeConnection: Readonly<{ forStdio(input: Readonly<{ path: string; env: Record<string, string> }>): unknown }>;
}>;
async function sdkFactory(): Promise<(input: ClientInput) => CopilotRuntimeClient> {
  // SDK .19's published declarations conflict with current strict TS MapIterator
  // and its own lifecycle metadata. Isolate that external boundary rather than
  // weakening this package's compiler or copying a broad adapter.
  const source = import.meta.resolve("@github/copilot-sdk"), sdk = await import(source) as unknown as SdkModule;
  requireThat(typeof sdk.CopilotClient === "function" && typeof sdk.RuntimeConnection?.forStdio === "function");
  return input => new sdk.CopilotClient({ connection: sdk.RuntimeConnection.forStdio({ path: input.launcher, env: input.environment }), mode: "copilot-cli", workingDirectory: input.cwd, baseDirectory: input.home, useLoggedInUser: false, logLevel: "error" });
}

/** Dedicated owned CLI per logical session. Construction verifies pins only;
 * only an explicit native opening or explicit history-reader preparation starts it. */
export async function createCopilotRuntime(options: CopilotRuntimeOptions, dependencies: CopilotRuntimeDependencies = {}): Promise<CopilotRuntime> {
  const capabilities = modelCapabilities(options);
  const tools = copy(options.environment ?? {});
  for (const [key, value] of Object.entries(tools)) requireThat(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === "string" && !/[\r\n\0]/.test(value));
  for (const path of [options.nativeHome, options.cwd, options.launchDirectory, options.cliBinary, options.cliPackageRoot]) requireThat(isAbsolute(path));
  const beforeTool = options.beforeTool; requireThat(beforeTool === undefined || typeof beforeTool === "function");
  const staticOptions = options.sessionOptions ?? {};
  requireThat(Object.keys(staticOptions).every(key => ["availableTools", "excludedTools", "mcpServers", "mcpOAuthTokenStorage", "enableConfigDiscovery", "enableManagedSettings", "customAgents", "skillDirectories", "systemMessage"].includes(key)), "Unsupported static Copilot session option");
  requireThat(staticOptions.mcpOAuthTokenStorage === undefined || staticOptions.mcpOAuthTokenStorage === "persistent" || staticOptions.mcpOAuthTokenStorage === "in-memory", "Invalid static MCP token storage");
  canonical(staticOptions, 2 * 1024 * 1024); const sessionOptions = copy(staticOptions);
  const mcpTransports = copilotMcpTransports(sessionOptions.mcpServers ?? {});
  const namespace = copy(options.scope), lifetime = options.readerLifetimeMs ?? 240_000;
  requireThat(Number.isSafeInteger(lifetime) && lifetime > 0 && lifetime <= 300_000);
  await checkVersions(options);
  const makeClient = dependencies.client ?? await sdkFactory();
  let allocation: Allocation | undefined, reader: Reader | undefined, preparingNative = false;
  let readerEpoch = 0;
  let closed = false, closing: Promise<void> | undefined;
  const diagnostics: { value: CopilotRuntimeDiagnostic }[] = [];
  const fieldsPresent = (value: unknown, fields: readonly string[]): readonly string[] => fields.filter(field => !!value && typeof value === "object" && Object.hasOwn(value, field));
  const diagnostic = (value: CopilotRuntimeDiagnostic) => { const entry = { value: copy(value) }; diagnostics.push(entry); if (diagnostics.length > 32) diagnostics.shift(); return entry; };
  const inspectCall = async <T>(stage: CopilotRuntimeDiagnostic["stage"], owner: CopilotRuntimeDiagnostic["owner"], work: () => Promise<T>, fields: readonly string[] = []): Promise<T> => {
    const entry = diagnostic({ stage, owner, state: "pending", fields: [] });
    try { const value = await work(); entry.value = copy({ stage, owner, state: "fulfilled", fields: fieldsPresent(value, fields) }); return value; }
    catch (error) { const code = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code")?.value as unknown : undefined; entry.value = copy({ stage, owner, state: "failed", fields: [], ...(Number.isSafeInteger(code) ? { nativeCode: code as number } : {}) }); throw error; }
  };
  const listeners = new Set<(halt: RuntimeHalt) => void>();
  const assertOpen = (): void => { if (closed) throw new SessionError("CLOSED"); };
  const scope = (value: CopilotScope): void => { requireThat(value.kind === "copilot" && value.origin.connection === namespace.connection && value.origin.principal === namespace.principal && value.origin.host === namespace.host); };
  const container = (reference: string, kind: "agent" | "reader"): NativeAllocation => {
    const input = { directory: options.launchDirectory, binary: options.cliBinary, packageRoot: options.cliPackageRoot, home: options.nativeHome, cwd: kind === "reader" ? options.launchDirectory : options.cwd, args: COPILOT_CLI_ARGS, environment: environment(options.nativeHome, !options.allocation, tools), reference, kind };
    return options.allocation ? options.allocation.allocate(input) : new LinuxContainerOwner({ ...input, ...(options.docker === undefined ? {} : { docker: options.docker }) }, dependencies.commands);
  };
  const client = (launcher: string, cwd = options.cwd) => makeClient({ launcher, home: options.nativeHome, cwd, environment: environment(options.nativeHome, false, tools) });
  const proof = (current: Allocation): RuntimeHalt => {
    requireThat(current.run && current.owner.identity);
    const identity: RuntimeIdentity = { ...current.owner.identity, run: current.run };
    return { identity, proof: { run: current.run, state: "stopped", scope: "nativeTree", noAutomaticContinuation: true }, boundary: { kind: "dedicated", containmentRetired: true } };
  };
  const retire = (current: Allocation): Promise<void> => current.retirement ??= (async () => {
    await current.owner.stop(); current.halted = true;
    await current.client?.forceStop().catch(() => undefined);
    if (current.run) { const halted = proof(current); for (const listener of [...listeners]) { try { listener(halted); } catch { /* A consumer cannot suppress owned halt proof. */ } } }
  })();
  const closeReader = async (): Promise<void> => { await reader?.close(); };
  const containment: TrustedContainment = {
    placement: "dedicated", capabilities: { fullStop: true, createAndWait: true, reopen: true },
    ...(options.allocation?.parentCustody ? { parentCustody: options.allocation.parentCustody } : {}),
    prepareOpening: async input => {
      assertOpen(); requireThat(scopeKey(input.scope) === scopeKey(namespace) && input.placement === "dedicated" && !preparingNative && (!allocation || allocation.halted));
      preparingNative = true;
      try {
        await closeReader(); reader = undefined; assertOpen();
        const ref = { scope: namespace, generation: input.generation, operationId: input.operationId };
        const current: Allocation = { owner: container(canonical(ref), "agent"), input: copy(input), claimed: false, halted: false }; allocation = current;
        const opening = await current.owner.opening(ref); assertOpen();
        const custody: NativeOpening = Object.freeze({ opening: opening.opening, identity: opening.identity, stop: async (): Promise<OpeningStopProof> => { await retire(current); return { opening: opening.opening, identity: opening.identity, state: "stopped", scope: "nativeTree", noAutomaticContinuation: true, acquisitionSealed: true }; } });
        current.opening = custody; return custody;
      } finally { preparingNative = false; }
    },
    inspectOpening: (capsule: OpeningCapsule) => { requireThat(scopeKey(capsule.opening.scope) === scopeKey(namespace)); return options.allocation ? options.allocation.inspectOpening(capsule) : inspectLinuxOpening(capsule, options, dependencies.commands); },
    identity: run => { requireThat(allocation?.run && sameRun(allocation.run, run) && allocation.owner.identity); return { ...allocation.owner.identity, run }; },
    observeOpening: (input, run) => inspectCall("certificate", "agent", async () => {
      const current = allocation;
      const active = (): void => requireThat(allocation === current && current?.run && sameRun(current.run, run) && !current.halted && !current.owner.sealed && current.input.generation === input.generation && current.resumeBoundary !== false);
      active(); requireThat(current);
      if (input.nativeSession === null) {
        let activity: "idle" | undefined;
        try {
          const observed = await inspectCall("session.metadata.activity", "agent", () => current.session!.rpc.metadata.activity(), ["hasActiveWork", "abortable"]);
          active(); if (inactive(observed)) activity = "idle";
        } catch { active(); }
        return { kind: "created", run, noAutomaticContinuation: true, callbacksComplete: true, continuous: true, ...(activity === undefined ? {} : { activity }) };
      }
      // Reopening permits continued saved work. The observed native boundary
      // plus exact pending inventories establish callback completeness; missing
      // evidence preserves a partial baseline rather than a passive claim.
      requireThat(current?.resumeBoundary !== false, "Native reopening belongs to another owner");
      let complete = false, activity: "idle" | undefined;
      try {
        const [permissions, tools, observedActivity] = await Promise.all([
          inspectCall("session.permissions.pendingRequests", "agent", () => current.session!.rpc.permissions.pendingRequests(), ["items"]),
          inspectCall("session.tools.listPendingRequests", "agent", () => current.session!.rpc.tools.listPendingRequests(), ["items"]),
          inspectCall("session.metadata.activity", "agent", () => current.session!.rpc.metadata.activity(), ["hasActiveWork", "abortable"]),
        ]);
        active();
        if (inactive(observedActivity)) activity = "idle";
        complete = current.resumeBoundary === true && emptyItems(permissions) && emptyItems(tools) && activity === "idle";
      } catch { active(); }
      return { kind: "reopened", run, callbacksComplete: complete, continuous: true, ...(activity === undefined ? {} : { activity }) };
    }, ["kind", "callbacksComplete", "continuous", "activity"]),
    inspect: async run => {
      const current = allocation; if (!current?.run || !sameRun(current.run, run)) return null;
      if (current.halted) return proof(current);
      return await current.owner.inspect() === "running" ? "owned" : null;
    },
    stopTree: async identity => { const current = allocation; requireThat(current?.run && sameRun(current.run, identity.run) && current.owner.identity && canonical({ ...current.owner.identity, run: current.run }) === canonical(identity)); await retire(current); return proof(current); },
    onHalt: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const launch = async (config: CopilotSessionConfig, resume: boolean): Promise<NativeSession> => {
    assertOpen(); const current = allocation; requireThat(current?.opening && !current.claimed && !current.halted); current.claimed = true;
    current.owner.assertLaunchable(); const prepared = await current.owner.prepare(); current.owner.assertLaunchable(); assertOpen();
    const native = client(prepared.launcher); current.client = native;
    try {
      await inspectCall("sdk.start", "agent", () => native.start()); current.owner.assertLaunchable(); assertOpen();
      const status = await inspectCall("status.get", "agent", () => native.getStatus(), ["version", "protocolVersion"]); current.owner.assertLaunchable(); assertOpen(); requireThat(status.version === COPILOT_CLI_VERSION && Number.isSafeInteger(status.protocolVersion) && status.protocolVersion > 0, "Copilot executable pin differs");
      const { onControlLost, ...nativeConfig } = config;
      const fixed: CopilotRuntimeSessionConfig = { ...sessionOptions, ...nativeConfig, ...(capabilities === undefined ? {} : { modelCapabilities: capabilities }), ...(beforeTool ? { hooks: { onPreToolUse: async (input: unknown, invocation: unknown): Promise<NativeToolDecision | undefined> => {
        const deny = (): NativeToolDecision => ({ permissionDecision: "deny", permissionDecisionReason: "Multiplex trusted pre-tool validation failed or its native owner was retired." });
        const active = (): void => requireThat(!closed && allocation === current && !current.halted && !current.owner.sealed);
        try {
          active();
          requireThat(input && typeof input === "object" && !Array.isArray(input) && invocation && typeof invocation === "object" && !Array.isArray(invocation));
          const fields = Object.getOwnPropertyDescriptors(input), call = Object.getOwnPropertyDescriptor(invocation, "sessionId");
          requireThat(fields.sessionId && "value" in fields.sessionId && fields.toolName && "value" in fields.toolName && (!fields.toolArgs || "value" in fields.toolArgs) && call && "value" in call);
          const sessionId: unknown = fields.sessionId.value, toolName: unknown = fields.toolName.value, toolArgs: unknown = fields.toolArgs?.value;
          requireThat(typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 256 && typeof toolName === "string" && toolName.length > 0 && toolName.length <= 256 && call.value === config.sessionId);
          if (toolArgs !== undefined) canonical(toolArgs, 65536);
          const result: unknown = await beforeTool(copy({ sessionId, toolName, toolArgs }), Object.freeze({ sessionId: config.sessionId }));
          active(); if (result === null || result === undefined) return undefined;
          requireThat(typeof result === "object" && !Array.isArray(result) && Reflect.ownKeys(result).length === 1);
          const reason = Object.getOwnPropertyDescriptor(result, "deny"); requireThat(reason && "value" in reason && typeof reason.value === "string" && reason.value.trim().length > 0 && new TextEncoder().encode(reason.value).length <= 1024);
          return { permissionDecision: "deny", permissionDecisionReason: reason.value };
        } catch { return deny(); }
      } } } : {}), onEvent: (event: Parameters<CopilotSessionConfig["onEvent"]>[0]) => {
        if (resume && allocation === current && !current.halted && !current.owner.sealed && event.type === "session.resume" && event.agentId === undefined) {
          const data = event.data;
          current.resumeBoundary = data.alreadyInUse === true ? false : current.resumeBoundary === false ? false : data.continuePendingWork === true ? true : undefined;
          diagnostic({ stage: "resume.boundary", owner: "agent", state: current.resumeBoundary ? "fulfilled" : "failed", fields: fieldsPresent(data, ["continuePendingWork", "sessionWasActive", "alreadyInUse"]) });
        }
        config.onEvent(event);
      } };
      const session = resume ? await inspectCall("session.resume", "agent", () => native.resumeSession(config.sessionId, { ...fixed, continuePendingWork: true, allowTranscriptRecovery: false }), ["sessionId"]) : await inspectCall("session.create", "agent", () => native.createSession(fixed), ["sessionId"]);
      current.owner.assertLaunchable(); assertOpen(); requireThat(session.sessionId === config.sessionId);
      requireThat(!resume || current.resumeBoundary !== false, "Native reopening boundary is unavailable or belongs to another owner");
      const run: RunRef = { scope: namespace, generation: current.input.generation, nativeSession: session.sessionId };
      current.run = run;
      const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
        try { return await work(); }
        catch (error) {
          // SDK .19's public registration is a local readiness check. Ordinary
          // RPC errors leave it available; transport retirement makes it throw.
          let unsubscribe: (() => void) | undefined, unavailable = false;
          try { unsubscribe = session.on(() => {}); } catch { unavailable = true; }
          try { unsubscribe?.(); } catch { /* Cleanup cannot replace the original RPC error. */ }
          if (unavailable && !closed && allocation === current && !current.halted && !current.owner.sealed && current.run && sameRun(current.run, run)) {
            try { onControlLost(); } catch { /* Consumer cannot replace original RPC failure. */ }
          }
          throw error;
        }
      };
      const exposed: NativeSession = { sessionId: session.sessionId, on: listener => session.on(listener), send: input => guarded(() => session.send(input)), abort: () => guarded(() => session.abort()), rpc: {
        ...(session.rpc.sendMessages ? { sendMessages: (input: Readonly<{ messages: readonly []; mode: "immediate" }>) => guarded(() => session.rpc.sendMessages!(input)) } : {}),
        model: { getCurrent: () => guarded(() => inspectCall("session.model.getCurrent", "agent", () => session.rpc.model.getCurrent(), ["modelId", "providerId", "reasoningEffort"])), switchTo: input => guarded(() => inspectCall("session.model.switchTo", "agent", () => session.rpc.model.switchTo(input), ["modelId", "modelState", "status", "deferred", "confirmation", "persistenceError"])) },
        permissions: { ...(session.rpc.permissions.getMode ? { getMode: () => guarded(() => inspectCall("session.permissions.getMode", "agent", () => session.rpc.permissions.getMode!(), ["mode"])) } : {}), setMode: input => guarded(() => inspectCall("session.permissions.setMode", "agent", () => session.rpc.permissions.setMode(input), ["success", "mode"])), setRequired: input => guarded(() => inspectCall("session.permissions.setRequired", "agent", () => session.rpc.permissions.setRequired(input), ["success"])), handlePendingPermissionRequest: input => guarded(() => session.rpc.permissions.handlePendingPermissionRequest(input)), pendingRequests: () => guarded(() => session.rpc.permissions.pendingRequests()) },
        mode: { ...(session.rpc.mode.get ? { get: () => guarded(() => inspectCall("session.mode.get", "agent", () => session.rpc.mode.get!(), ["mode"])) } : {}), set: input => guarded(() => inspectCall("session.mode.set", "agent", () => session.rpc.mode.set(input), ["modeApplied", "modelChanged", "confirmation", "deferImplementation"])) },
        ...(session.rpc.queue ? { queue: { pendingItems: () => guarded(() => session.rpc.queue!.pendingItems()), sendNow: (input: Readonly<{ id: string }>) => guarded(() => session.rpc.queue!.sendNow(input)) } } : {}),
        ...(session.rpc.history ? { history: { compact: (input: Readonly<{ trigger: "manual" }>) => guarded(() => session.rpc.history!.compact(input)) } } : {}),
        ...(session.rpc.tasks ? { tasks: { refresh: () => guarded(() => session.rpc.tasks!.refresh()), list: () => guarded(() => session.rpc.tasks!.list()), getProgress: (input: Readonly<{ id: string }>) => guarded(() => session.rpc.tasks!.getProgress(input)), getCurrentPromotable: () => guarded(() => session.rpc.tasks!.getCurrentPromotable()), cancel: (input: Readonly<{ id: string }>) => guarded(() => session.rpc.tasks!.cancel(input)), promoteToBackground: (input: Readonly<{ id: string }>) => guarded(() => session.rpc.tasks!.promoteToBackground(input)) } } : {}),
        mcp: { listConfigured: () => guarded(() => session.rpc.mcp.listConfigured()),
          ...(session.rpc.mcp.restartServer ? { restartServer: (input: Readonly<{ serverName: string }>) => guarded(() => session.rpc.mcp.restartServer!(input)) } : {}),
          ...(session.rpc.mcp.oauth?.login ? { oauth: { login: (input: Readonly<{ serverName: string; forceReauth?: boolean }>) => guarded(() => session.rpc.mcp.oauth!.login(input)) } } : {}),
        },
        eventLog: { read: request => guarded(() => session.rpc.eventLog.read(request)) },
        tools: { listPendingRequests: () => guarded(() => session.rpc.tools.listPendingRequests()) },
        metadata: { activity: () => guarded(() => session.rpc.metadata.activity()) },
      } };
      current.session = exposed; return exposed;
    } catch (error) { await retire(current); throw error; }
  };
  const controller = new CopilotController({ transport: { createSession: config => launch(config, false), resumeSession: (id, config) => { requireThat(id === config.sessionId); return launch(config, true); } }, containment, cwd: options.cwd, model: options.model, provider: options.provider, catalog: options.catalog, mcpTransports, ...(staticOptions.mcpOAuthTokenStorage === undefined ? {} : { mcpOAuthTokenStorage: staticOptions.mcpOAuthTokenStorage }), ...(options.newSessionId === undefined ? {} : { newSessionId: options.newSessionId }) });
  const history: HostHistory = { port(run: RunRef, attached: Scope, media?: NativeMediaHandler): AcquisitionPort {
    assertOpen(); requireThat(attached.kind === "copilot" && scopeKey(run.scope) === scopeKey(namespace) && attached.origin.nativeSession === run.nativeSession); scope(attached);
    const current = allocation;
    if ((!current || current.halted) && reader?.port && !reader.retired && sameRun(reader.run, run)) return !media && sameScope(reader.scope, attached) ? reader.port : reader.makePort!(attached, media);
    if (!current || current.halted || current.owner.sealed) return { scope: attached, mode: "active", context: `copilot-inactive:${readerEpoch}`, read: async () => { throw new SessionError("FENCED"); } };
    requireThat(current.run && sameRun(current.run, run) && current.owner.identity && current.session);
    return createCopilotHistoryPort({ scope: attached, mode: "active", context: `copilot-active:${current.owner.identity.attachment}`, ...(media ? { media } : {}), read: async request => { assertOpen(); requireThat("includeEphemeral" in request && allocation === current && !current.halted && !current.owner.sealed); const value = await inspectCall("session.eventLog.read", "agent", () => current.session!.rpc.eventLog.read(request), ["events", "cursor", "hasMore", "cursorStatus"]); assertOpen(); requireThat(allocation === current && !current.halted && !current.owner.sealed); return value; } });
  }, async prepare(run, attached, custody) { requireThat(attached.kind === "copilot" && attached.origin.nativeSession === run.nativeSession); await prepareHistoryReader(run, attached, custody); }, async release(custody) { await closeReader(); await retireReader(custody, capsule => options.allocation ? options.allocation.inspectOpening(capsule, "reader") : inspectLinuxOpening(capsule, options.docker ? { docker: options.docker } : {}, dependencies.commands, "reader")); } };
  const prepareHistoryReader = (runInput: RunRef, attachedInput: CopilotScope, custody?: ReaderCustodyPort): Promise<CopilotHistoryReader> => {
    const run = copy(runInput), attached = copy(attachedInput);
    assertOpen(); scope(attached); requireThat(scopeKey(run.scope) === scopeKey(namespace) && attached.origin.nativeSession === run.nativeSession && Number.isSafeInteger(run.generation) && run.generation > 0);
    requireThat(!preparingNative && (!allocation || allocation.halted), "Persisted reader requires retired agent containment");
    if (allocation?.run) requireThat(sameRun(run, allocation.run));
    if (reader && !reader.retired) {
      requireThat(sameRun(reader.run, run), "One exact root history run at a time"); const held = reader;
      return sameScope(held.scope, attached) ? held.ready : held.ready.then(value => ({ port: held.makePort!(attached), close: value.close }));
    }
    const token = randomUUID(), opening: OpeningRef = { scope: run.scope, generation: run.generation, operationId: `reader-${token}` }, owner = container(canonical(opening), "reader"); let native: CopilotRuntimeClient | undefined, sealed = false, retiring: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let lease!: Reader;
    const close = (): Promise<void> => {
      if (retiring) return retiring; sealed = true; if (timer) clearTimeout(timer);
      retiring = (async () => { const identity = await owner.stop(); await native?.forceStop().catch(() => undefined); await custody?.released({ opening, identity, state: "stopped", scope: "nativeTree", noAutomaticContinuation: true, acquisitionSealed: true }); })().then(() => { lease.retired = true; readerEpoch++; }); return retiring;
    };
    const ready = (async (): Promise<CopilotHistoryReader> => {
      try {
        await retireReader(custody, capsule => options.allocation ? options.allocation.inspectOpening(capsule, "reader") : inspectLinuxOpening(capsule, options.docker ? { docker: options.docker } : {}, dependencies.commands, "reader"));
        await custody?.begin(run, opening);
        const captured = await owner.opening(opening); await custody?.owned(run, { opening: captured.opening, identity: captured.identity });
        const prepared = await owner.prepare(); assertOpen(); owner.assertLaunchable();
        timer = setTimeout(() => { void close().catch(() => undefined); }, lifetime); timer.unref();
        // The retained custody directory survives release of the agent workspace.
        native = client(prepared.launcher, options.launchDirectory); await inspectCall("sdk.start", "reader", () => native!.start()); assertOpen(); owner.assertLaunchable();
        const status = await inspectCall("status.get", "reader", () => native!.getStatus(), ["version", "protocolVersion"]); requireThat(status.version === COPILOT_CLI_VERSION && Number.isSafeInteger(status.protocolVersion) && status.protocolVersion > 0); assertOpen(); owner.assertLaunchable();
        lease.makePort = (target, media) => {
          scope(target); requireThat(target.origin.nativeSession === run.nativeSession && !sealed);
          const decoded = createCopilotHistoryPort({ scope: target, mode: "persisted", context: `copilot-persisted:${token}`, ...(media ? { media } : {}), read: async request => {
            assertOpen(); requireThat("sessionId" in request && !sealed);
            const value = await inspectCall("sessions.readPersistedEvents", "reader", () => native!.rpc.sessions.readPersistedEvents(request), ["events", "cursor", "hasMore", "cursorStatus"]);
            // Fence before decoding/capturing any returned image bytes, not
            // merely before publishing the eventual transcript page.
            assertOpen(); requireThat(!sealed && reader === lease && !lease.retired); return value;
          } });
          let reading = false;
          return Object.freeze({ scope: decoded.scope, mode: decoded.mode, context: decoded.context!, read: async (request: AcquisitionRequest<CopilotScope>, assertCurrent?: () => void) => {
            assertOpen(); requireThat(!sealed); if (reading) throw new SessionError("BUSY"); reading = true;
            try { const result = await decoded.read(request, assertCurrent); if (sealed || closed) { await close(); throw new SessionError("FENCED"); } if (result.status !== "ok") await close(); return result; }
            catch (error) { await close(); throw error; }
            finally { reading = false; }
          } });
        };
        const port = lease.makePort(attached);
        const value = Object.freeze({ port: Object.freeze(port), close }); lease.port = value.port;
        return value;
      } catch (error) { await close(); throw error; }
    })();
    lease = { run, scope: attached, ready, close, retired: false }; reader = lease; return ready;
  };
  return Object.freeze({ controller, nativeInputRoots: Object.freeze([options.cwd]), history, prepareHistoryReader, diagnostics: () => copy(diagnostics.map(entry => entry.value)), close: () => {
    if (closing) return closing; closed = true;
    closing = (async () => { const outcomes = await Promise.allSettled([closeReader(), allocation ? retire(allocation) : Promise.resolve()]); const failure = outcomes.find(result => result.status === "rejected"); if (failure?.status === "rejected") throw failure.reason; })(); return closing;
  } });
}
