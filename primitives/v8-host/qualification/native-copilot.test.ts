import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCopilotRuntime, type CopilotBeforeTool, type CopilotBeforeToolInput, type CopilotBeforeToolResult, type CopilotRuntimeClient, type CopilotRuntimeOptions, type CopilotRuntimeSessionConfig, type CopilotRuntime } from "../../v8-harness-copilot/src/runtime.js";
import { LINUX_IMAGE, type DockerCommands } from "../src/native/linux.js";
import type { CopilotSessionConfig } from "../../v8-harness-copilot/src/controller.js";
import { SessionError, type NativeOpening, type NativeStart, type RunRef, type SessionScope } from "../../v8-session/src/contracts/types.js";
import type { CopilotScope } from "../../v8-history/src/contracts/types.js";
import type { RuntimeEvent } from "../../v8-runtime/src/contracts.js";
import { rowMedia, type NativeMediaHandler } from "../../v8-history/src/contracts/media.js";
import { deferred, until } from "./fixture.js";
import { openHost } from "../../v8-lifecycle-default/src/assembly.js";
import { compileCopilotContributions, copilotAgents } from "../../v8-harness-copilot/src/contributions.js";

const scope: SessionScope = { connection: "offline-native", principal: "owner", host: "copilot-host", session: "logical" };
const start = (generation = 1, nativeSession: string | null = null): NativeStart => ({ scope, generation, nativeSession, placement: "dedicated", operationId: `open-${generation}`, policy: { kind: "copilot", provider: "copilot-only", permissions: "manual" } });
const attached = (nativeSession = "native-session"): CopilotScope => ({ kind: "copilot", origin: { connection: scope.connection, principal: scope.principal, host: scope.host, nativeSession, attachment: "host-observation-1" }, agentId: null });
const readerRun: RunRef = { scope, generation: 1, nativeSession: "native-session" };
const page = (text: string, hasMore = false) => ({ events: [{ id: `event-${text}`, type: "user.message", data: { messageId: `message-${text}`, content: text } }], hasMore, cursor: hasMore ? "native-next" : "", cursorStatus: "ok" });

/** An offline control-boundary fake. It launches no Docker/SDK/native process. */
class Docker implements DockerCommands {
  readonly calls: readonly string[][] = []; readonly containers = new Map<string, { labels: Record<string, string>; running: boolean }>();
  serial = 0; removalGate: Promise<void> | undefined;
  async exec(args: readonly string[]): Promise<string> {
    (this.calls as string[][]).push([...args]);
    if (args[0] === "create") {
      const id = (++this.serial).toString(16).padStart(64, "0"), labels: Record<string, string> = {};
      for (let i = 0; i < args.length; i++) if (args[i] === "--label") { const [key, value] = args[++i]!.split("="); labels[key!] = value!; }
      this.containers.set(id, { labels, running: false }); return id;
    }
    if (args[0] === "container" && args[1] === "ls") { const id = args.find(value => value.startsWith("id="))!.slice(3); return this.containers.has(id) ? `${id}\n` : ""; }
    if (args[0] === "container" && args[1] === "inspect") { const id = args[2]!, value = this.containers.get(id)!; return JSON.stringify([{ Id: id, Config: { Image: LINUX_IMAGE, Labels: value.labels }, State: { Running: value.running } }]); }
    if (args[0] === "rm") { await this.removalGate; this.containers.delete(args.at(-1)!); return ""; }
    throw Error("Unexpected offline Docker command");
  }
}
class Sdk {
  readonly configs: { resume: boolean; config: CopilotRuntimeSessionConfig & { continuePendingWork?: true; allowTranscriptRecovery?: false } }[] = [];
  readonly reads: { persisted: boolean; request: unknown }[] = [];
  readonly actions: { method: string; input: unknown }[] = [];
  readonly settings: { method: string; input: unknown }[] = [];
  nativeProviderId: string | undefined = "copilot-only";
  switchModel: ((input: Readonly<{ modelId: string; providerId?: string; reasoningEffort?: string | null }>) => Promise<unknown>) | undefined;
  modelState: Readonly<Record<string, unknown>> | undefined;
  permissionMode: "manual" | "assisted" | "allow-all" = "manual"; sessionMode: "interactive" | "plan" | "autopilot" = "interactive";
  settingsReads = true;
  mcpServers: unknown = { servers: [] }; mcpConfiguredGate: Promise<void> | undefined; mcpRestartGate: Promise<void> | undefined;
  retainReadOnStop = false;
  starts = 0; statuses = 0; forced = 0; activityReads = 0; version = "1.0.95";
  resumeEvent: { continuePendingWork?: boolean; sessionWasActive?: boolean; alreadyInUse?: boolean } | undefined = { continuePendingWork: true, sessionWasActive: false };
  pendingPermissions: unknown = { items: [] }; pendingTools: unknown = { items: [] }; activity: unknown = { hasActiveWork: false, abortable: false };
  modelError: unknown; sendError: unknown; sendGate: Promise<string> | undefined;
  disconnected = false; registrations = 0; unregistrations = 0;
  activityGate: Promise<unknown> | undefined;
  startGate: Promise<void> | undefined; readGate: ReturnType<typeof deferred<unknown>> | undefined;
  persisted: unknown = page("persisted"); active: unknown = page("active");
  readonly client: (input: Readonly<{ launcher: string; home: string; cwd: string; environment: Record<string, string> }>) => CopilotRuntimeClient;
  constructor(readonly docker: Docker) {
    this.client = input => {
      assert.equal(input.environment.HOME, input.home); assert.equal(input.environment.GITHUB_TOKEN, undefined); assert.equal(input.environment.OPENAI_API_KEY, undefined);
      const id = [...docker.containers.keys()].at(-1)!;
      const session = (config: CopilotRuntimeSessionConfig): Awaited<ReturnType<CopilotRuntimeClient["createSession"]>> => ({ sessionId: config.sessionId,
        on: () => { if (this.disconnected) throw new Error("public SDK registration unavailable"); this.registrations++; return () => { this.unregistrations++; }; },
        send: async () => { if (this.sendGate) return this.sendGate; if (this.sendError) throw this.sendError; return "original-message"; }, abort: async () => ({}), rpc: {
          model: { getCurrent: async () => { if (this.modelError) throw this.modelError; return { modelId: config.model, ...(this.nativeProviderId === undefined ? {} : { providerId: this.nativeProviderId }), ...this.modelState }; }, switchTo: async input => { this.settings.push({ method: "model.switchTo", input }); return this.switchModel ? this.switchModel(input) : {}; } }, mode: { ...(this.settingsReads ? { get: async () => ({ mode: this.sessionMode }) } : {}), set: async input => { this.settings.push({ method: "mode.set", input }); return { modeApplied: true, modelChanged: false }; } },
          permissions: { ...(this.settingsReads ? { getMode: async () => ({ mode: this.permissionMode }) } : {}), setMode: async input => { this.settings.push({ method: "permissions.setMode", input }); return { success: true, mode: input.mode }; }, setRequired: async input => { this.settings.push({ method: "permissions.setRequired", input }); return { success: true }; }, handlePendingPermissionRequest: async () => ({ success: true }), pendingRequests: async () => this.pendingPermissions },
          queue: { pendingItems: async () => { this.actions.push({ method: "queue.pendingItems", input: {} }); return { items: [], steeringMessages: [] }; }, sendNow: async input => { this.actions.push({ method: "queue.sendNow", input }); return { steered: false }; } },
          history: { compact: async input => { this.actions.push({ method: "history.compact", input }); return { success: false, tokensRemoved: 0, messagesRemoved: 0 }; } },
          tasks: { refresh: async () => { this.actions.push({ method: "tasks.refresh", input: {} }); return {}; }, list: async () => { this.actions.push({ method: "tasks.list", input: {} }); return { tasks: [] }; }, getProgress: async input => { this.actions.push({ method: "tasks.getProgress", input }); return { progress: null }; }, getCurrentPromotable: async () => { this.actions.push({ method: "tasks.getCurrentPromotable", input: {} }); return {}; }, cancel: async input => { this.actions.push({ method: "tasks.cancel", input }); return { cancelled: false }; }, promoteToBackground: async input => { this.actions.push({ method: "tasks.promoteToBackground", input }); return { promoted: true }; } },
          mcp: { listConfigured: async () => { this.actions.push({ method: "mcp.listConfigured", input: {} }); await this.mcpConfiguredGate; return this.mcpServers; }, restartServer: async input => { this.actions.push({ method: "mcp.restartServer", input }); await this.mcpRestartGate; } }, eventLog: { read: async request => { this.reads.push({ persisted: false, request }); return this.active; } },
          tools: { listPendingRequests: async () => this.pendingTools }, metadata: { activity: async () => { this.activityReads++; return this.activityGate ?? this.activity; } },
        } });
      return {
        start: async () => { this.starts++; docker.containers.get(id)!.running = true; await this.startGate; },
        getStatus: async () => { this.statuses++; return { version: this.version, protocolVersion: 1 }; },
        forceStop: async () => { this.forced++; if (!this.retainReadOnStop) this.readGate?.reject(new SessionError("IO")); },
        createSession: async config => { this.configs.push({ resume: false, config }); return session(config); },
        resumeSession: async (_id, config) => { this.configs.push({ resume: true, config }); if (this.resumeEvent) config.onEvent({ id: "native-resume-event", type: "session.resume", data: this.resumeEvent }); return session(config); },
        rpc: { sessions: { readPersistedEvents: async request => { this.reads.push({ persisted: true, request }); return this.readGate?.promise ?? this.persisted; } } },
      };
    };
  }
}
async function fixture(overrides: Partial<CopilotRuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "v8-copilot-driver-")), packageRoot = join(directory, "cli"), binary = join(packageRoot, "copilot");
  await mkdir(packageRoot); await writeFile(binary, "offline fixture\n"); await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@github/copilot-linux-x64", version: "1.0.95" }));
  const docker = new Docker(), sdk = new Sdk(docker);
  const options: CopilotRuntimeOptions = { scope, nativeHome: join(directory, "home"), cwd: join(directory, "work"), launchDirectory: join(directory, "launch"), cliPackageRoot: packageRoot, cliBinary: binary, model: "gpt-6-luna", provider: { id: "copilot-only", copilotOnly: true, config: { type: "openai", baseUrl: "http://offline.invalid", apiKey: "dummy" } }, catalog: async () => ({ available: true, choices: [{ model: "gpt-6-luna", providerId: "copilot-only", efforts: [] }] }), newSessionId: () => "native-session", ...overrides };
  let runtime: CopilotRuntime | undefined;
  return { docker, sdk, options, async open() { return runtime = await createCopilotRuntime(options, { commands: docker, client: sdk.client }); }, async cleanup() { await runtime?.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("Copilot factory is inert, custody precedes SDK start, active history never activates, and explicit Resume has a new exact owner", async () => {
  const f = await fixture({ sessionOptions: { availableTools: [], excludedTools: [], mcpOAuthTokenStorage: "persistent" } }); const runtime = await f.open(); let custody: NativeOpening | undefined;
  try {
    assert.equal(f.docker.calls.length, 0); assert.equal(f.sdk.starts, 0); assert.deepEqual(runtime.diagnostics(), []);
    const owned = await runtime.controller.open(start(), () => {}, undefined, async value => { custody = value; assert.equal(f.sdk.starts, 0); assert.equal(f.docker.containers.size, 1); });
    assert.ok(custody); assert.equal(f.sdk.starts, 1); assert.equal(f.sdk.statuses, 1); assert.equal(f.sdk.configs.length, 1); assert.equal(f.sdk.configs[0]!.config.provider.baseUrl, "http://offline.invalid");
    assert.deepEqual(f.sdk.configs[0]!.config.availableTools, []); assert.deepEqual(f.sdk.configs[0]!.config.excludedTools, []); assert.equal(f.sdk.configs[0]!.config.mcpOAuthTokenStorage, "persistent");
    assert.equal(Object.hasOwn(f.sdk.configs[0]!.config, "modelCapabilities"), false);
    assert.equal(f.sdk.configs[0]!.config.hooks, undefined, "No trusted callback means no extra Multiplex pre-tool policy");
    const port = runtime.history.port(owned.identity.run, attached()); assert.equal(port.context, runtime.history.port(owned.identity.run, attached()).context); const batch = await port.read({ scope: attached(), cursor: null, count: 1 });
    assert.equal(batch.records[0]!.body.kind, "complete"); assert.deepEqual(f.sdk.reads[0]!.request, { max: 1, direction: "backward", includeEphemeral: false, agentScope: "primary" }); assert.equal(f.sdk.starts, 1);
    await owned.stopTree(); assert.equal(f.docker.containers.size, 0); assert.equal(f.sdk.forced, 1);
    const inactive = runtime.history.port(owned.identity.run, attached()); assert.notEqual(inactive.context, port.context); await assert.rejects(inactive.read({ scope: attached(), cursor: null, count: 1 }));
    await assert.rejects(port.read({ scope: attached(), cursor: null, count: 1 })); assert.equal(f.sdk.reads.length, 1);
    const resumed = await runtime.controller.open(start(2, "native-session"), () => {});
    assert.notEqual(runtime.history.port(resumed.identity.run, attached()).context, port.context);
    assert.notEqual(resumed.identity.containment, owned.identity.containment); assert.equal(f.sdk.configs[1]!.resume, true); assert.equal(f.sdk.configs[1]!.config.continuePendingWork, true); assert.equal(f.sdk.configs[1]!.config.allowTranscriptRecovery, false); assert.equal(resumed.native.interactionsComplete, true, "Exact cold Resume event plus native empty lists/activity can establish a new baseline");
    assert.deepEqual(f.sdk.configs[1]!.config.availableTools, []); assert.deepEqual(f.sdk.configs[1]!.config.excludedTools, []); assert.equal(f.sdk.configs[1]!.config.mcpOAuthTokenStorage, "persistent");
    assert.equal(Object.hasOwn(f.sdk.configs[1]!.config, "modelCapabilities"), false);
    await resumed.stopTree(); assert.equal(f.docker.containers.size, 0);
    const recorded = JSON.stringify(runtime.diagnostics()); assert.ok(recorded.includes('"stage":"resume.boundary"')); assert.ok(recorded.includes('"fields":["modelId","providerId"]')); assert.ok(!recorded.includes("http://offline.invalid")); assert.ok(!recorded.includes("native-session")); assert.ok(runtime.diagnostics().length <= 32);
  } finally { await f.cleanup(); }
});

test("Copilot contribution model/effort reach actual runtime Create unchanged without inventing inherited selections", async () => {
  const agents = [
    { name: "explicit", prompt: "One exact task.", model: "offline-child-model", reasoningEffort: "max" as const, tools: [] },
    { name: "inherited", prompt: "Use native inheritance.", tools: null },
  ];
  const startup = compileCopilotContributions([copilotAgents({ id: "native-agents", agents })]);
  const f = await fixture({ sessionOptions: startup.sessionOptions }), runtime = await f.open();
  try {
    assert.equal(f.sdk.starts, 0); assert.equal(f.sdk.configs.length, 0);
    const owned = await runtime.controller.open(start(), () => {});
    assert.equal(f.sdk.configs.length, 1); assert.equal(f.sdk.configs[0]!.resume, false);
    const config = f.sdk.configs[0]!.config;
    assert.deepEqual(config.customAgents, agents); assert.equal(config.model, "gpt-6-luna");
    assert.equal(Object.hasOwn(config, "reasoningEffort"), false, "A child's effort is not a root model selection");
    assert.equal(Object.hasOwn(config.customAgents![1]!, "model"), false);
    assert.equal(Object.hasOwn(config.customAgents![1]!, "reasoningEffort"), false);
    assert.deepEqual(config.allowedModels, ["gpt-6-luna"]); assert.deepEqual(config.provider, f.options.provider.config);
    assert.equal(f.sdk.reads.length, 0); assert.equal(f.sdk.actions.length, 0);
    await owned.stopTree(); assert.equal(f.docker.containers.size, 0);
  } finally { await f.cleanup(); }
});

test("singular Copilot BYOK translates an authorized route without inventing a native catalog provider", async () => {
  const f = await fixture({ catalog: async () => ({ available: true, choices: [{ model: "gpt-6-luna", providerId: "copilot-only", efforts: ["low"] }] }) });
  f.sdk.nativeProviderId = undefined; // Exact observed .95 getCurrent shape.
  f.sdk.switchModel = async input => {
    // SDK .19 requires a providerId from its native registered model list.
    // This singular-provider session has no such route-named registration.
    assert.equal(Object.hasOwn(input, "providerId"), false, "Unregistered native provider rejected");
    return { modelId: input.modelId, modelState: { modelId: input.modelId, reasoningEffort: input.reasoningEffort } };
  };
  const runtime = await f.open(), host = await openHost({ scope, directory: join(f.options.launchDirectory, "host"), cwd: f.options.cwd, controller: runtime.controller, policy: start().policy });
  try {
    await host.session.submit({ scope, id: "create-single-route", generation: 0, command: { type: "create" } });
    await until(async () => (await host.session.receipt(scope, "create-single-route"))?.state === "acknowledged");
    assert.equal((await host.session.snapshot(scope)).activity, "idle", "Fresh native inactive metadata establishes idle even when Create emits no idle event");
    assert.equal(f.sdk.activityReads, 1); assert.equal(f.sdk.reads.length, 0, "Opening activity never reads chat history");
    const config = f.sdk.configs[0]!.config;
    assert.deepEqual(config.provider, f.options.provider.config); assert.equal(Object.hasOwn(config, "providers"), false); assert.equal(Object.hasOwn(config, "models"), false);
    const original = { scope, id: "model-on-authorized-route", generation: 1, command: { type: "copilot.model" as const, model: "gpt-6-luna", providerId: "copilot-only", effort: "low" } };
    await host.session.submit(original);
    await until(async () => (await host.session.receipt(scope, original.id))?.state === "acknowledged");
    assert.equal((await host.session.receipt(scope, original.id))!.outcome!.status, "applied");
    assert.deepEqual(f.sdk.settings.filter(value => value.method === "model.switchTo"), [{ method: "model.switchTo", input: { modelId: "gpt-6-luna", reasoningEffort: "low" } }]);
    assert.equal((await host.session.snapshot(scope)).selection.effort, undefined, "Native result settles original, never fabricates current selection");
    for (const [index, native] of [{}, { providerId: "native-opaque-default" }].entries()) {
      config.onEvent({ id: `native-model-${index}`, type: "session.model_change", data: { newModel: "gpt-6-luna", reasoningEffort: "low", ...native } });
      assert.deepEqual((await host.session.snapshot(scope)).selection, { kind: "copilot", model: "gpt-6-luna", providerId: "copilot-only", effort: "low", permissions: "manual" });
    }
    await host.session.submit({ ...original, id: "foreign-route", command: { ...original.command, providerId: "foreign" } });
    await until(async () => (await host.session.receipt(scope, "foreign-route"))?.state === "refused");
    assert.equal(f.sdk.settings.filter(value => value.method === "model.switchTo").length, 1);
    assert.deepEqual(config.provider, f.options.provider.config); assert.equal(f.sdk.configs.length, 1);
    const diagnostic = runtime.diagnostics().filter(value => value.stage === "session.model.switchTo");
    assert.deepEqual(diagnostic, [{ stage: "session.model.switchTo", owner: "agent", state: "fulfilled", fields: ["modelId", "modelState"] }]);
    assert.equal(JSON.stringify(diagnostic).includes("copilot-only"), false);
    await host.session.submit({ scope, id: "stop-single-route", generation: 1, command: { type: "stop" } });
    await until(async () => (await host.session.receipt(scope, "stop-single-route"))?.state === "acknowledged");
    assert.equal(f.docker.containers.size, 0);
  } finally { await runtime.close(); await host.terminate(); await f.cleanup(); }
});

test("Copilot retained null effort and assisted permissions are Resume observations, while fresh unsupported choices still refuse", async () => {
  const f = await fixture(), runtime = await f.open();
  const host = await openHost({ scope, directory: join(f.options.launchDirectory, "host"), cwd: f.options.cwd, controller: runtime.controller, policy: start().policy });
  const submit = async (id: string, generation: number, type: "create" | "stop" | "resume") => {
    const original = { scope, id, generation, command: { type } }; await host.session.submit(original);
    await until(async () => (await host.session.receipt(scope, id))?.state === "acknowledged");
  };
  try {
    for (const selection of [{ kind: "copilot", effort: null }, { kind: "copilot", permissions: "assisted" }] as const)
      await assert.rejects(runtime.controller.openNative({ ...start(), selection }), error => error instanceof SessionError && error.code === "UNSUPPORTED");
    assert.equal(f.sdk.configs.length, 0); assert.equal(f.docker.calls.length, 0);
    await submit("create-selection", 0, "create");
    const config = f.sdk.configs[0]!.config;
    config.onEvent({ id: "observed-model", type: "session.model_change", data: { newModel: "gpt-6-luna-selected", providerId: "copilot-only", reasoningEffort: null } });
    config.onEvent({ id: "observed-permissions", type: "session.permissions_changed", data: { mode: "assisted" } });
    config.onEvent({ id: "observed-mode", type: "session.mode_changed", data: { newMode: "plan" } });
    const retained = { kind: "copilot", model: "gpt-6-luna-selected", providerId: "copilot-only", effort: null, permissions: "assisted", mode: "plan" };
    assert.deepEqual((await host.session.snapshot(scope)).selection, retained);
    await submit("stop-selection", 1, "stop"); assert.deepEqual((await host.session.snapshot(scope)).selection, retained);
    f.sdk.modelState = { reasoningEffort: null }; f.sdk.permissionMode = "assisted"; f.sdk.sessionMode = "interactive";
    const before = f.sdk.settings.length;
    await submit("resume-selection", 1, "resume");
    assert.equal(f.sdk.configs[1]!.resume, true); assert.equal(f.sdk.configs[1]!.config.model, retained.model);
    assert.equal(Object.hasOwn(f.sdk.configs[1]!.config, "reasoningEffort"), false, "Retained null does not become a writable clear request");
    assert.deepEqual((await host.session.snapshot(scope)).selection, { ...retained, mode: "interactive" });
    assert.deepEqual(f.sdk.settings.slice(before), [{ method: "permissions.setRequired", input: { required: true } }], "Resume does not replace native assisted permissions or replay stale plan mode");
    assert.equal(f.sdk.reads.length, 0); await submit("stop-resumed-selection", 2, "stop");
    f.sdk.settingsReads = false;
    await submit("resume-without-settings-proof", 2, "resume");
    const unknown = (await host.session.snapshot(scope)).selection;
    assert.deepEqual(unknown, { kind: "copilot", model: retained.model, providerId: retained.providerId, effort: null });
    assert.equal(Object.hasOwn(unknown, "permissions"), false); assert.equal(Object.hasOwn(unknown, "mode"), false);
    await submit("stop-without-settings-proof", 3, "stop");
  } finally { await runtime.close(); await host.terminate(); await f.cleanup(); }
});

test("Copilot MCP reconnect is one original across two viewers; a held reply stays uncertain and Stop fences restart after configuration observation", async () => {
  const f = await fixture({ sessionOptions: { mcpServers: { remote: { type: "http", url: "https://private.invalid/mcp" } }, mcpOAuthTokenStorage: "persistent" } });
  f.sdk.mcpServers = { servers: [{ name: "remote", enabled: true, live: { status: "connected" } }] };
  const runtime = await f.open(), host = await openHost({ scope, directory: join(f.options.launchDirectory, "host"), cwd: f.options.cwd, controller: runtime.controller, policy: start().policy, observationMs: 40 });
  const restart = deferred<void>(), configured = deferred<void>();
  const ack = async (id: string, generation: number, command: import("../../v8-session/src/contracts/types.js").SessionCommand) => {
    await host.session.submit({ scope, id, generation, command }); await until(async () => (await host.session.receipt(scope, id))?.state === "acknowledged");
  };
  try {
    await ack("create-mcp", 0, { type: "create" }); const run = (await host.binding())!.run;
    const observed = await host.mcp.refresh(run); assert.equal(observed.management, "session-originals"); assert.equal(observed.freshness, "current");
    f.sdk.mcpRestartGate = restart.promise;
    const original = { scope, id: "one-reconnect", generation: 1, command: { type: "copilot.mcp.reconnect" as const, serverName: "remote" } };
    const [a, b] = await Promise.all([host.session.submit(original), host.session.submit(original)]);
    assert.equal(a.state, "outcomeUnknown"); assert.deepEqual(a, b); await host.session.submit(original); await host.session.receipt(scope, original.id);
    assert.deepEqual(f.sdk.actions.filter(call => call.method.startsWith("mcp.")).map(call => call.method), ["mcp.listConfigured", "mcp.listConfigured", "mcp.restartServer"]);
    assert.equal((await host.mcp.snapshot(run)).freshness, "stale");
    restart.resolve(); await until(async () => (await host.session.receipt(scope, original.id))?.state === "acknowledged");
    assert.deepEqual((await host.session.receipt(scope, original.id))!.outcome, { status: "acknowledged" }); assert.equal((await host.mcp.snapshot(run)).freshness, "stale");
    assert.equal(f.sdk.actions.filter(call => call.method === "mcp.listConfigured").length, 2, "Neither ACK nor original lookup discovers automatically");
    f.sdk.mcpConfiguredGate = configured.promise;
    const retiring = { scope, id: "reconnect-before-stop", generation: 1, command: { type: "copilot.mcp.reconnect" as const, serverName: "remote" } };
    assert.equal((await host.session.submit(retiring)).state, "outcomeUnknown");
    await ack("stop-mcp", 1, { type: "stop" }); configured.resolve();
    await until(() => host.session.updateReadiness().ready);
    assert.equal(f.sdk.actions.filter(call => call.method === "mcp.restartServer").length, 1, "Stop during configuration observation prevents a later server start");
    assert.equal((await host.session.receipt(scope, retiring.id))!.state, "outcomeUnknown");
    assert.equal(f.docker.containers.size, 0); assert.equal((await host.session.snapshot(scope)).phase, "stopped");
  } finally { restart.resolve(); configured.resolve(); await runtime.close(); await host.terminate(); await f.cleanup(); }
});

test("Copilot rejected calls report public SDK readiness loss, preserve original error and retain exact Stop custody", async () => {
  const f = await fixture(), runtime = await f.open(), events: RuntimeEvent[] = [];
  try {
    const owned = await runtime.controller.open(start(), event => events.push(event));
    const failure = new Error("Disconnected transport wording can also be an ordinary application error"); f.sdk.sendError = failure;
    await assert.rejects(owned.native.invoke({ type: "send", text: "ordinary failure" }), error => error === failure);
    assert.equal(f.sdk.registrations, 1); assert.equal(f.sdk.unregistrations, 1);
    assert.equal(events.filter(event => event.type === "observation").length, 0);
    f.sdk.disconnected = true;
    await assert.rejects(owned.native.invoke({ type: "send", text: "lost established connection" }), error => error === failure);
    const losses = events.filter(event => event.type === "observation");
    assert.equal(losses.length, 1);
    assert.ok(losses[0]?.type === "observation" && losses[0].observation.controller === "lost" && losses[0].observation.transport === "lost");
    assert.equal(f.sdk.configs.length, 1); assert.equal(f.sdk.starts, 1); assert.equal(f.docker.containers.size, 1, "disconnect is not a halt");
    await assert.rejects(owned.native.invoke({ type: "send", text: "ordinary work blocked after loss" }));
    await owned.stopTree(); assert.equal(f.docker.containers.size, 0); assert.equal(f.sdk.forced, 1);
    assert.equal(Object.hasOwn(f.sdk.configs[0]!.config, "onControlLost"), false, "adapter observation callback is not SDK configuration");
  } finally { await f.cleanup(); }
});

test("a rejected old-allocation Copilot call cannot mark an explicit replacement run disconnected", async () => {
  const f = await fixture(), runtime = await f.open(), gate = deferred<string>(), events: RuntimeEvent[] = [];
  try {
    const old = await runtime.controller.open(start(), event => events.push(event)); f.sdk.sendGate = gate.promise;
    const pending = old.native.invoke({ type: "send", text: "admitted before exact Stop" }), rejected = assert.rejects(pending);
    await old.stopTree(); f.sdk.sendGate = undefined;
    const resumed = await runtime.controller.open(start(2, "native-session"), event => events.push(event));
    const before = events.length; f.sdk.disconnected = true; gate.reject(new Error("late retired connection failure")); await rejected;
    assert.equal(events.length, before); assert.equal(f.sdk.configs.length, 2); assert.equal(resumed.identity.run.generation, 2);
    await resumed.stopTree(); assert.equal(f.docker.containers.size, 0);
  } finally { gate.reject(new Error("cleanup")); await f.cleanup(); }
});

test("trusted Copilot vision declaration is a frozen captured value on actual factory Create and Resume bundles", async () => {
  for (const vision of [true, false]) {
    const caller = { supports: { vision } }, f = await fixture({ modelCapabilities: caller });
    const opening = f.open(); caller.supports.vision = !vision; const runtime = await opening;
    try {
      const created = await runtime.controller.open(start(), () => {});
      const first = f.sdk.configs[0]!.config.modelCapabilities;
      assert.deepEqual(first, { supports: { vision } }); assert.notEqual(first, caller); assert.notEqual(first!.supports, caller.supports);
      assert.equal(Object.isFrozen(first), true); assert.equal(Object.isFrozen(first!.supports), true);
      assert.equal(Reflect.set(first!.supports, "vision", !vision), false);
      await created.stopTree(); caller.supports = { vision: !vision };
      const resumed = await runtime.controller.open(start(2, "native-session"), () => {});
      assert.equal(f.sdk.configs[1]!.resume, true);
      assert.deepEqual(f.sdk.configs[1]!.config.modelCapabilities, { supports: { vision } });
      assert.equal(f.sdk.configs[1]!.config.continuePendingWork, true); assert.equal(f.sdk.configs[1]!.config.allowTranscriptRecovery, false);
      assert.deepEqual(f.sdk.configs[1]!.config.provider, f.sdk.configs[0]!.config.provider);
      await resumed.stopTree(); assert.equal(f.docker.containers.size, 0);
    } finally { await f.cleanup(); }
  }
});

test("invalid trusted Copilot vision declarations refuse before allocation without evaluating accessors", async () => {
  let evaluated = 0;
  const accessor = () => { evaluated++; return true; };
  const invalid: unknown[] = [null, [], {}, { supports: {} }, { supports: { vision: 1 } }, { supports: { vision: true, reasoningEffort: true } },
    { supports: { vision: true }, limits: {} }, { supports: { vision: true }, [Symbol("extra")]: true },
    { supports: { vision: true, [Symbol("extra")]: true } }, Object.create({ supports: { vision: true } }),
    Object.defineProperty({}, "supports", { get: accessor }), { supports: Object.defineProperty({}, "vision", { get: accessor }) },
    Object.defineProperty({ supports: { vision: true } }, "extra", { value: false })];
  for (const value of invalid) {
    const f = await fixture({ modelCapabilities: value as NonNullable<CopilotRuntimeOptions["modelCapabilities"]> });
    try { await assert.rejects(f.open()); assert.equal(f.docker.calls.length, 0); assert.equal(f.sdk.starts, 0); assert.equal(f.sdk.statuses, 0); assert.equal(f.sdk.configs.length, 0); }
    finally { await f.cleanup(); }
  }
  const f = await fixture(); Object.defineProperty(f.options, "modelCapabilities", { get: accessor });
  try { await assert.rejects(f.open()); assert.equal(f.docker.calls.length, 0); assert.equal(f.sdk.starts, 0); }
  finally { await f.cleanup(); }
  assert.equal(evaluated, 0);
});

test("trusted Copilot pre-tool capability preserves native defaults, denies invalid/throwing results, and fences held or stale owner callbacks", async () => {
  let result: unknown = null, failure = false, calls = 0, observed: CopilotBeforeToolInput | undefined;
  const policy: CopilotBeforeTool = input => { calls++; observed = input; if (failure) throw Error("private-policy-body"); return result as CopilotBeforeToolResult; };
  const f = await fixture({ beforeTool: policy }), runtime = await f.open();
  try {
    const held = await runtime.controller.open(start(), () => {}), hook = f.sdk.configs[0]!.config.hooks!.onPreToolUse;
    const input = { sessionId: "native-session", toolName: "task", toolArgs: { agent_type: "one-child" } }, invocation = { sessionId: "native-session" };
    assert.equal(await hook(input, invocation), undefined); assert.equal(observed?.toolName, "task"); assert.equal(Object.isFrozen(observed?.toolArgs), true);
    result = undefined; assert.equal(await hook(input, invocation), undefined);
    result = { deny: "One native child permit has already been consumed." }; assert.deepEqual(await hook(input, invocation), { permissionDecision: "deny", permissionDecisionReason: "One native child permit has already been consumed." });
    for (const invalid of [{ permissionDecision: "allow" }, { deny: "reason", modifiedArgs: {} }, { deny: "" }, { deny: "x".repeat(1025) }, 42]) { result = invalid; assert.equal((await hook(input, invocation))?.permissionDecision, "deny"); }
    failure = true; const refused = await hook(input, invocation); assert.equal(refused?.permissionDecision, "deny"); assert.equal(JSON.stringify(refused).includes("private-policy-body"), false); failure = false;
    const previous = calls; assert.equal((await hook(input, { sessionId: "foreign-session" }))?.permissionDecision, "deny"); assert.equal((await hook({ ...input, toolArgs: { bytes: new Uint8Array([1]) } }, invocation))?.permissionDecision, "deny"); assert.equal(calls, previous, "Invalid native scope/JSON does not invoke trusted policy");
    const gate = deferred<CopilotBeforeToolResult>(); result = gate.promise;
    const pending = hook(input, invocation); await held.stopTree(); gate.resolve(null); assert.equal((await pending)?.permissionDecision, "deny", "A late pass cannot cross exact Stop");
    result = null; const resumed = await runtime.controller.open(start(2, "native-session"), () => {}); assert.equal((await hook(input, invocation))?.permissionDecision, "deny", "Old SDK closure cannot consume a replacement run's permit");
    assert.equal(await f.sdk.configs[1]!.config.hooks!.onPreToolUse(input, invocation), undefined); await resumed.stopTree();
  } finally { await f.cleanup(); }
  const injected = await fixture({ sessionOptions: { hooks: { onPreToolUse: () => ({ permissionDecision: "allow" }) } } as unknown as NonNullable<CopilotRuntimeOptions["sessionOptions"]> });
  try { await assert.rejects(injected.open()); assert.equal(injected.sdk.starts, 0); assert.equal(injected.docker.calls.length, 0); } finally { await injected.cleanup(); }
});

test("Stop during a held SDK startup seals exact acquisition before any session ID/Create, and executable mismatch cannot Create", async () => {
  const f = await fixture(), gate = deferred<void>(); f.sdk.startGate = gate.promise; const runtime = await f.open(); let custody!: NativeOpening;
  try {
    const opening = runtime.controller.open(start(), () => {}, undefined, async value => { custody = value; }), rejected = assert.rejects(opening, { code: "IO" });
    await until(() => f.sdk.starts === 1); const stopped = await custody.stop(); assert.equal(stopped.acquisitionSealed, true); assert.equal(f.docker.containers.size, 0);
    gate.resolve(); await rejected; assert.equal(f.sdk.configs.length, 0); assert.equal(f.sdk.statuses, 0);
  } finally { gate.resolve(); await f.cleanup(); }
  const bad = await fixture(); bad.sdk.version = "1.0.94"; const other = await bad.open();
  try { await assert.rejects(other.controller.open(start(), () => {}), { code: "IO" }); assert.equal(bad.sdk.configs.length, 0); assert.equal(bad.docker.containers.size, 0); }
  finally { await bad.cleanup(); }
  const error = await fixture(); error.sdk.modelError = Object.assign(new Error("private/native/path/request-body"), { code: -32603, data: { privateBody: "must not be projected" } }); const observed = await error.open();
  try { await assert.rejects(observed.controller.open(start(), () => {}), { code: "IO" }); const diagnostic = observed.diagnostics().find(value => value.stage === "session.model.getCurrent"); assert.deepEqual(diagnostic, { stage: "session.model.getCurrent", owner: "agent", state: "failed", fields: [], nativeCode: -32603 }); assert.ok(!JSON.stringify(observed.diagnostics()).includes("private")); }
  finally { await error.cleanup(); }
});

test("Reopening ACK permits saved continuation; callback completeness needs actual boundary and exact empty inventories", async () => {
  const missing = await fixture(); missing.sdk.resumeEvent = undefined; const unknown = await missing.open();
  try { const opened = await unknown.controller.open(start(1, "native-session"), () => {}); assert.equal(opened.native.interactionsComplete, false); await opened.stopTree(); }
  finally { await missing.cleanup(); }
  const partial = await fixture(); partial.sdk.pendingPermissions = { items: [{ requestId: "old-unhydrated" }] }; const retained = await partial.open();
  try { const native = await retained.controller.open(start(1, "native-session"), () => {}); assert.equal(native.native.interactionsComplete, false); await native.stopTree(); }
  finally { await partial.cleanup(); }
  const live = await fixture(); live.sdk.resumeEvent = { continuePendingWork: true, sessionWasActive: true }; const refused = await live.open();
  try { const opened = await refused.controller.open(start(1, "native-session"), () => {}); assert.equal(opened.identity.run.nativeSession, "native-session"); assert.equal(live.sdk.actions.length, 0, "reopening never chains a context turn"); await opened.stopTree(); }
  finally { await live.cleanup(); }
});

test("cold Resume and fresh Create use native inactive metadata without an idle callback, while a newer native activity event wins", async () => {
  const f = await fixture(), runtime = await f.open(), events: RuntimeEvent[] = [];
  const activities = () => events.flatMap(event => event.type === "native" && event.event.type === "activity" ? [{ run: event.event.run, activity: event.event.activity }] : []);
  const gate = deferred<unknown>();
  try {
    // The fixture emits only the genuine-shaped Resume boundary, no idle event.
    const resumed = await runtime.controller.open(start(1, "native-session"), event => events.push(event));
    assert.deepEqual(activities(), [{ run: resumed.identity.run, activity: "idle" }]);
    assert.equal(resumed.native.interactionsComplete, true); assert.equal(f.sdk.activityReads, 1); assert.equal(f.sdk.reads.length, 0);
    await resumed.stopTree(); events.length = 0;
    f.sdk.activityGate = gate.promise;
    const opening = runtime.controller.open(start(2), event => events.push(event));
    await until(() => f.sdk.activityReads === 2);
    f.sdk.configs.at(-1)!.config.onEvent({ id: "new-native-work", type: "assistant.turn_start", data: { turnId: "active-turn" } });
    gate.resolve({ hasActiveWork: false, abortable: false });
    const active = await opening;
    assert.deepEqual(activities(), [{ run: active.identity.run, activity: "working" }], "A held native metadata response cannot overwrite a newer native activity event");
    assert.equal(f.sdk.activityReads, 2); assert.equal(f.sdk.reads.length, 0);
    await active.stopTree();
  } finally { gate.resolve({ hasActiveWork: false, abortable: false }); await f.cleanup(); }
});

test("explicit persisted reader is sessionless, continuation-bound, shared through end pages, and never restarts on a stale read", async () => {
  const f = await fixture(), readerCwds: string[] = [];
  let ownedRuntime: CopilotRuntime | undefined;
  try {
    await mkdir(f.options.cwd); await rm(f.options.cwd, { recursive: true });
    const runtime = await createCopilotRuntime(f.options, { commands: f.docker, client: input => {
      readerCwds.push(input.cwd); assert.equal(input.cwd, f.options.launchDirectory); return f.sdk.client(input);
    } });
    ownedRuntime = runtime;
    const run: RunRef = { scope, generation: 1, nativeSession: "native-session" };
    const inactive = runtime.history.port(run, attached());
    assert.match(inactive.context!, /^copilot-inactive:/);
    await assert.rejects(inactive.read({ scope: attached(), cursor: null, count: 1 }), /FENCED/);
    assert.equal(f.sdk.starts, 0, "Inspecting the inactive descriptor cannot allocate a reader");
    const first = runtime.prepareHistoryReader(run, attached()), second = runtime.prepareHistoryReader(run, attached()); assert.equal(first, second); const reader = await first;
    await assert.rejects(stat(f.options.cwd), { code: "ENOENT" });
    assert.equal(runtime.history.port(run, attached()), reader.port); assert.equal(f.sdk.starts, 1); assert.equal(f.sdk.configs.length, 0);
    f.sdk.persisted = page("first", true); const a = await reader.port.read({ scope: attached(), cursor: null, count: 5 }); assert.equal(a.hasMore, true); assert.equal(f.docker.containers.size, 1);
    f.sdk.persisted = page("last"); const b = await reader.port.read({ scope: attached(), cursor: a.nextCursor, count: 5 }); assert.equal(b.hasMore, false); assert.equal(f.docker.containers.size, 1, "An end page does not retire the shared root-run reader");
    await reader.close(); assert.equal(f.docker.containers.size, 0); assert.equal(f.sdk.forced, 1);
    assert.notEqual(runtime.history.port(run, attached()).context, reader.port.context, "Retirement exposes an inactive descriptor; a subsequent explicit recovery has a new context");
    assert.deepEqual(f.sdk.reads.map(value => value.request), [{ sessionId: "native-session", max: 1, direction: "backward" }, { sessionId: "native-session", cursor: "native-next", max: 1, direction: "backward" }]);
    await assert.rejects(reader.port.read({ scope: attached(), cursor: null, count: 1 })); assert.equal(f.sdk.starts, 1); assert.equal(f.sdk.configs.length, 0);
    assert.throws(() => runtime.prepareHistoryReader(run, { ...attached(), origin: { ...attached().origin, principal: "other" } })); assert.equal(f.sdk.starts, 1);
    const replacement = await runtime.prepareHistoryReader(run, attached()); assert.notEqual(replacement.port.context, reader.port.context); await replacement.close(); assert.equal(f.sdk.starts, 2);
    await assert.rejects(stat(f.options.cwd), { code: "ENOENT" });
    assert.deepEqual(readerCwds, [f.options.launchDirectory, f.options.launchDirectory]);
  } finally { await ownedRuntime?.close(); await f.cleanup(); }
});

test("stopped Copilot parent recovery discovers exact-session nested children without leaking their bodies or converting legacy tool IDs", async () => {
  const f = await fixture(), runtime = await f.open();
  const host = await openHost({ scope, directory: join(f.options.launchDirectory, "host"), cwd: f.options.cwd, controller: runtime.controller, history: runtime.history, policy: start().policy });
  const submit = async (id: string, generation: number, type: "create" | "stop") => {
    await host.session.submit({ scope, id, generation, command: { type } });
    await until(async () => (await host.session.receipt(scope, id))?.state === "acknowledged");
  };
  try {
    await submit("create-history-tree", 0, "create");
    const root = (await host.binding())!.history as CopilotScope;
    f.sdk.configs[0]!.config.onEvent({ id: "real-native-child", type: "subagent.started", agentId: "observed-child", data: { toolCallId: "spawn-child" } });
    const child: CopilotScope = { kind: "copilot", origin: root.origin, agentId: "observed-child" };
    assert.ok(host.history.scopes().some(value => value.kind === "copilot" && value.agentId === child.agentId));
    host.history.emit(root, [{ type: "gap", gap: { id: "missing-root", kind: "nativeGap" } }]);
    host.history.emit(child, [{ type: "gap", gap: { id: "missing-child", kind: "nativeGap" } }]);
    await submit("stop-history-tree", 1, "stop");
    const watch = host.history.watch(root); await watch.next(); await watch.return();
    assert.equal(f.sdk.starts, 1); assert.equal(f.sdk.reads.length, 0);
    await assert.rejects(host.history.authorize({ kind: "copilot", origin: root.origin, agentId: "unproved-child" }));
    assert.equal(f.sdk.starts, 1, "Unproved cold child cannot cause reader acquisition");
    const cold: CopilotScope = { kind: "copilot", origin: root.origin, agentId: "cold-nested-child" };
    const nativePages = [
      { events: [{ id: "cold-native-child", type: "subagent.started", agentId: cold.agentId, data: { toolCallId: "cold-task", parentId: "unobserved-parent-task" } }], hasMore: true, cursor: "cold-older-1", cursorStatus: "ok" },
      { events: [{ id: "legacy-only", type: "user.message", data: { messageId: "legacy-message", parentToolCallId: "legacy-is-not-an-agent", content: "private legacy child body" } }], hasMore: true, cursor: "cold-older-2", cursorStatus: "ok" },
      page("root-history"),
    ];
    Object.defineProperty(f.sdk, "persisted", { configurable: true, get: () => { assert.ok(nativePages.length); return nativePages.shift(); } });
    assert.deepEqual(await host.history.recover(root), { state: "value", value: { status: "ready" } });
    assert.ok(host.history.scopes().some(value => value.kind === "copilot" && value.agentId === cold.agentId));
    assert.equal(host.history.scopes().some(value => value.kind === "copilot" && value.agentId === "legacy-is-not-an-agent"), false);
    assert.equal(host.history.snapshot(cold).rows.length, 0, "Discovery cannot fetch a child body or grant live ownership");
    Object.defineProperty(f.sdk, "persisted", { configurable: true, writable: true, value: { events: [{ id: "child-message", type: "user.message", agentId: cold.agentId, data: { messageId: "child-message", content: "child-history" } }], hasMore: false, cursor: "", cursorStatus: "ok" } });
    assert.deepEqual(await host.history.recover(cold), { state: "value", value: { status: "ready" } });
    assert.equal((await host.session.readers.read()).state, "owned", "the shared reader has one durable capsule before it serves either scope");
    assert.equal(f.sdk.starts, 2); assert.equal(f.sdk.configs.length, 1); assert.equal(f.docker.containers.size, 1);
    assert.equal(f.sdk.reads.length, 4); assert.equal(f.sdk.reads.every(value => value.persisted), true);
    assert.equal(host.history.snapshot(root).rows.some(row => row.body.kind === "complete" && row.body.text === "root-history"), true);
    assert.equal(host.history.snapshot(cold).rows.some(row => row.body.kind === "complete" && row.body.text === "child-history"), true);
    assert.equal(host.history.snapshot(root).rows.some(row => row.body.kind === "complete" && row.body.text === "private legacy child body"), false);
    const run = (await host.binding())!.run;
    assert.throws(() => runtime.prepareHistoryReader({ ...run, generation: run.generation + 1 }, child));
    assert.equal((await host.session.snapshot(scope)).phase, "stopped");
    await runtime.history.release!(); assert.equal(f.docker.containers.size, 0); assert.deepEqual(await host.session.readers.read(), { state: "none" });
  } finally { await runtime.close(); await host.terminate(); await f.cleanup(); }
});

test("Copilot active and stopped runtime history forwards exact image bytes to the existing media owner", async () => {
  const f = await fixture(), runtime = await f.open();
  const encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", png = Uint8Array.from(Buffer.from(encoded, "base64"));
  const native = { events: [{ id: "image-event", type: "user.message", data: { messageId: "image-message", content: "original image", attachments: [{ type: "blob", mimeType: "image/png", data: encoded }] } }], hasMore: false, cursor: "", cursorStatus: "ok" };
  let captures = 0;
  const media: NativeMediaHandler = value => { assert.deepEqual(value.bytes, png); assert.equal(value.scope.kind, "copilot"); assert.equal(value.scope.origin.nativeSession, "native-session"); assert.equal(value.occurrence.kind, "image"); captures++; return { state: "available", artifactId: "owned-artifact" }; };
  try {
    const owner = await runtime.controller.open(start(), () => {}), run = owner.identity.run, target = attached();
    f.sdk.active = native;
    const active = await runtime.history.port(run, target, media).read({ scope: target, cursor: null, count: 1 });
    assert.equal(rowMedia(active.records[0]!).some(item => item.artifactId === "owned-artifact" && item.state === "available"), true);
    await owner.stopTree(); await runtime.prepareHistoryReader(run, target); f.sdk.persisted = native;
    const stopped = await runtime.history.port(run, target, media).read({ scope: target, cursor: null, count: 1 });
    assert.equal(rowMedia(stopped.records[0]!).some(item => item.artifactId === "owned-artifact" && item.state === "available"), true);
    assert.equal(captures, 2); assert.equal(JSON.stringify([active, stopped]).includes(encoded), false);
    assert.equal(f.sdk.configs.length, 1); assert.equal(f.sdk.reads.length, 2);
    f.sdk.retainReadOnStop = true; f.sdk.readGate = deferred<unknown>();
    const late = runtime.history.port(run, target, media).read({ scope: target, cursor: null, count: 1 }), rejected = assert.rejects(late);
    await until(() => f.sdk.reads.length === 3); await runtime.history.release!(); f.sdk.readGate.resolve(native);
    await rejected; assert.equal(captures, 2, "Retired reader bytes cannot reach media capture before the late page is fenced");
  } finally { await f.cleanup(); }
});

test("a reader's absolute expiry cannot release a held read until its exact container halt is proven", async () => {
  const f = await fixture({ readerLifetimeMs: 20 }), removal = deferred<void>(); f.sdk.readGate = deferred<unknown>(); f.docker.removalGate = removal.promise; const runtime = await f.open();
  try {
    const reader = await runtime.prepareHistoryReader(readerRun, attached()); let settled = false;
    const reading = reader.port.read({ scope: attached(), cursor: null, count: 1 }).finally(() => { settled = true; }), rejected = assert.rejects(reading);
    await until(() => f.docker.calls.some(args => args[0] === "rm")); assert.equal(settled, false); assert.equal(f.sdk.forced, 0); assert.equal(f.docker.containers.size, 1);
    removal.resolve(); await rejected; assert.equal(f.docker.containers.size, 0); assert.equal(f.sdk.forced, 1); assert.equal(f.sdk.configs.length, 0);
  } finally { removal.resolve(); f.sdk.readGate.reject(new SessionError("IO")); await f.cleanup(); }
});

test("persisted decode failure and backend retirement close owned resources without exposing late private history", async () => {
  const f = await fixture(); const runtime = await f.open();
  try {
    const reader = await runtime.prepareHistoryReader(readerRun, attached()); f.sdk.persisted = { events: "invalid" }; await assert.rejects(reader.port.read({ scope: attached(), cursor: null, count: 1 })); assert.equal(f.docker.containers.size, 0);
    const next = await runtime.prepareHistoryReader(readerRun, attached()); f.sdk.readGate = deferred<unknown>();
    const reading = next.port.read({ scope: attached(), cursor: null, count: 1 }), rejected = assert.rejects(reading);
    await until(() => f.sdk.reads.length === 2); await runtime.close(); await rejected; assert.equal(f.docker.containers.size, 0);
    assert.throws(() => runtime.prepareHistoryReader(readerRun, attached()), { code: "CLOSED" }); assert.equal(f.sdk.configs.length, 0);
  } finally { await f.cleanup(); }
});


test("Copilot actual runtime SDK guard exposes concrete native queue/history/task RPCs with exact IDs and no synthetic Send", async () => {
  const f = await fixture();
  try {
    const runtime = await f.open(), owned = await runtime.controller.open(start(), () => {}), run = owned.native.run;
    assert.deepEqual((await owned.native.invoke({ type: "copilot.queue.promote", id: "exact-queued" })).detail, { id: "exact-queued", steered: false });
    assert.deepEqual((await owned.native.invoke({ type: "copilot.task.cancel", id: "exact-task" })).detail, { id: "exact-task", cancelled: false });
    await owned.native.invoke({ type: "copilot.task.promote", id: "exact-task" }); await owned.native.invoke({ type: "copilot.compact" });
    for (const request of [{ type: "copilot.queue" }, { type: "copilot.tasks" }, { type: "copilot.task.progress", id: "exact-task" }, { type: "copilot.task.promotable" }] as const) await runtime.controller.read(run, request);
    assert.deepEqual(f.sdk.actions.map(call => call.method), ["queue.sendNow", "tasks.cancel", "tasks.promoteToBackground", "history.compact", "queue.pendingItems", "tasks.refresh", "tasks.list", "tasks.getProgress", "tasks.getCurrentPromotable"]);
    assert.deepEqual(f.sdk.actions[0]?.input, { id: "exact-queued" }); assert.deepEqual(f.sdk.actions[1]?.input, { id: "exact-task" }); assert.deepEqual(f.sdk.actions[3]?.input, { trigger: "manual" });
    await owned.stopTree(); await assert.rejects(runtime.controller.read(run, { type: "copilot.queue" }));
  } finally { await f.cleanup(); }
});
