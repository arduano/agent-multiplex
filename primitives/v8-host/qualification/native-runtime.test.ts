import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinuxContainerOwner, LINUX_IMAGE, inspectLinuxOpening, type DockerCommands } from "../src/native/linux.js";
import { openHost } from "../../v8-lifecycle-default/src/assembly.js";
import { createCodexRuntime } from "../../v8-harness-codex/src/runtime.js";
import { CodexStdioRpc, type CodexWire, type CodexWireFactory } from "../../v8-harness-codex/src/rpc.js";
import type { CodexReverseRequest } from "../../v8-harness-codex/src/controller.js";
import type { NativeStart, OpeningRef, Receipt, SessionCommand, Submit } from "../../v8-session/src/contracts/types.js";
import type { CodexScope } from "../../v8-history/src/contracts/types.js";
import { canonical } from "../../v8-session/src/contracts/validation.js";
import { until } from "./fixture.js";
import { SessionJournal } from "../../v8-lifecycle-default/src/session/journal.js";

const scope = { connection: "connection", principal: "principal", host: "host", session: "logical" };
const opening: OpeningRef = { scope, generation: 1, operationId: "create-original" };
const input: NativeStart = { ...opening, placement: "dedicated", nativeSession: null, policy: { kind: "codex", provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } } };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };

/** Observe this exact original through observer expiry, never submit again or
 * confuse a one-second caller budget with actual FULL-synchronous settlement. */
async function committedReceipt(host: Awaited<ReturnType<typeof openHost>>["session"], request: Submit, accept: (receipt: Receipt) => boolean): Promise<Receipt> {
  const committed = deferred<Receipt>();
  const off = host.subscribeReceipt(request.scope, request.id, receipt => {
    if (accept(receipt)) committed.resolve(receipt);
  });
  try {
    const observed = await host.submit(request);
    assert.notEqual(observed.state, "refused");
    return accept(observed) ? observed : await committed.promise;
  } finally { off(); }
}
const acknowledged = (host: Awaited<ReturnType<typeof openHost>>["session"], request: Submit) => committedReceipt(host, request, receipt => receipt.state === "acknowledged");

class Docker implements DockerCommands {
  readonly calls: string[][] = []; readonly containers = new Map<string, Record<string, unknown>>();
  created = deferred<void>(); createGate: Promise<void> | undefined; failCreate = false;
  removalStarted = deferred<void>(); removalGate: Promise<void> | undefined;
  async exec(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    if (args[0] === "create") {
      this.created.resolve(); if (this.createGate) await this.createGate; if (this.failCreate) throw Error("unknown allocation");
      const id = (this.containers.size + 1).toString(16).padStart(64, "a"), labels: Record<string, string> = {};
      args.forEach((value, index) => { if (value === "--label") { const text = args[index + 1]!, at = text.indexOf("="); labels[text.slice(0, at)] = text.slice(at + 1); } });
      this.containers.set(id, { Id: id, Config: { Image: LINUX_IMAGE, Labels: labels }, State: { Running: false } }); return id + "\n";
    }
    if (args[0] === "container" && args[1] === "ls") { const id = args[args.indexOf("--filter") + 1]!.slice(3); return this.containers.has(id) ? id + "\n" : ""; }
    if (args[0] === "container" && args[1] === "inspect") return JSON.stringify([this.containers.get(args[2]!)]);
    if (args[0] === "rm") { this.removalStarted.resolve(); await this.removalGate; this.containers.delete(args[args.length - 1]!); return ""; }
    throw Error("unexpected docker command");
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "v8-native-owner-")), packageRoot = join(root, "package"), home = join(root, "home"), cwd = join(root, "workspace"), directory = join(root, "custody"), binary = join(packageRoot, "codex");
  await mkdir(packageRoot); await writeFile(binary, "offline fixture only");
  const docker = new Docker();
  const options = { directory, binary, packageRoot, home, cwd, args: ["app-server", "--stdio"], environment: { PATH: "/usr/local/bin:/usr/bin:/bin", TEST_KEY: "private" }, reference: canonical(opening), kind: "agent" as const };
  return { root, options, docker, dispose: () => rm(root, { recursive: true, force: true }) };
}

test("Linux exact-CID owner captures stopped immutable allocation, launcher is single use/local, and positive exact absence proves Stop", async () => {
  const f = await fixture(); try {
    const owner = new LinuxContainerOwner(f.options, f.docker); assert.equal(f.docker.calls.length, 0);
    const held = await owner.opening(opening), prepared = await owner.prepare(); assert.equal(await owner.inspect(), "created");
    const launcher = await readFile(prepared.launcher, "utf8"); assert.ok(launcher.startsWith("#!/usr/bin/env node")); assert.match(launcher, /unix:\/\/\/var\/run\/docker.sock/); assert.match(launcher, /launch-claimed/); assert.match(launcher, /process\.argv\.slice\(2\)/);
    assert.equal(f.docker.calls.filter(call => call[0] === "create").length, 1); const create = f.docker.calls[0]!; assert.equal(create.includes("--pull=never"), true);
    assert.equal(create[create.indexOf("--entrypoint") + 1], f.options.binary); assert.deepEqual(create.slice(create.indexOf(LINUX_IMAGE) + 1), ["app-server", "--stdio"]); assert.equal(create.filter(value => value === f.options.binary).length, 1, "native binary is the absolute entrypoint, never a duplicate positional argument to the image wrapper");
    const stopping = held.stop(); const [a, b] = await Promise.all([stopping, held.stop()]); assert.deepEqual(a, b); assert.equal(a.acquisitionSealed, true); assert.equal(owner.sealed, true);
    assert.equal(f.docker.calls.filter(call => call[0] === "rm").length, 1); assert.equal(f.docker.containers.size, 0); assert.throws(() => owner.assertLaunchable());
    assert.deepEqual(await inspectLinuxOpening(held, {}, f.docker), a);
  } finally { await f.dispose(); }
});

test("Stop drains a pending allocation and retires its late exact CID; ambiguous allocation never becomes proof", async () => {
  const f = await fixture(); try {
    const gate = deferred<void>(); f.docker.createGate = gate.promise;
    const owner = new LinuxContainerOwner(f.options, f.docker), preparing = owner.prepare(); void preparing.catch(() => undefined); await f.docker.created.promise;
    const stopping = owner.stop(); gate.resolve(); await assert.rejects(preparing); await stopping;
    assert.equal(f.docker.containers.size, 0); assert.equal(f.docker.calls.filter(call => call[0] === "create").length, 1);
    const broken = new Docker(); broken.failCreate = true; const unknown = new LinuxContainerOwner(f.options, broken); await assert.rejects(unknown.prepare()); await assert.rejects(unknown.stop());
    assert.equal(broken.calls.some(call => call[0] === "rm"), false);
  } finally { await f.dispose(); }
});

class Wire implements CodexWire {
  readonly sent: Record<string, unknown>[] = []; readonly data = new Set<(text: string) => void>(); readonly closed = new Set<() => void>();
  userAgent = "codex/0.162.1 (offline)";
  read: ((params: Record<string, unknown>) => unknown | Promise<unknown>) | undefined;
  list: ((params: Record<string, unknown>) => unknown | Promise<unknown>) | undefined;
  timeline: ((params: Record<string, unknown>) => unknown | Promise<unknown>) | undefined;
  onData(listener: (text: string) => void) { this.data.add(listener); return () => this.data.delete(listener); }
  onClose(listener: () => void) { this.closed.add(listener); return () => this.closed.delete(listener); }
  frame(value: unknown) { for (const listener of this.data) listener(JSON.stringify(value) + "\n"); }
  async write(line: string) { const message = JSON.parse(line) as Record<string, unknown>; this.sent.push(message); if (message.id === undefined || typeof message.method !== "string") return;
    const params = message.params as Record<string, unknown>;
    const result = message.method === "initialize" ? { userAgent: this.userAgent }
      : ["thread/start", "thread/resume"].includes(message.method) ? { thread: { id: "native-thread", status: { type: "idle" } }, model: params.model, modelProvider: "guard", approvalPolicy: params.approvalPolicy, sandbox: { type: "dangerFullAccess" }, reasoningEffort: "low" }
      : message.method === "thread/read" ? this.read ? await this.read(params) : { thread: { id: "native-thread", sessionId: "native-thread" } }
      : message.method === "thread/items/list" ? this.list ? await this.list(params) : { data: [], nextCursor: null, backwardsCursor: null }
      : message.method === "thread/timeline/list" ? this.timeline ? await this.timeline(params) : await (async () => {
        const page = this.list ? await this.list(params) as { data: { turnId: string; item: unknown }[]; nextCursor: string | null } : { data: [], nextCursor: null };
        return { data: [...page.data].reverse().map((entry, position) => ({ type: "item", position, turnId: entry.turnId, item: entry.item })), nextCursor: page.nextCursor, activeRealtimeSessionAtPageStart: null };
      })() : { turn: { id: "turn" } };
    this.frame({ id: message.id, result });
  }
  async close() { for (const listener of this.closed) listener(); }
}

test("Codex production active and cold history select bounded canonical timeline including itemless failures", async () => {
  const f = await fixture(), wires: Wire[] = [], message = "Selected model is at capacity. Please try a different model.";
  const runtime = createCodexRuntime({ ...f.options, model: "gpt-6-luna", provider: { id: "guard", baseUrl: "http://127.0.0.1/v1", environmentKey: "TEST_KEY", copilotOnly: true },
    catalog: async () => ({ available: false, choices: [] }), commands: f.docker, wire: () => {
      const wire = new Wire(); wires.push(wire);
      wire.timeline = params => {
        assert.deepEqual(Object.keys(params).sort(), ["cursor", "limit", "threadId"]);
        assert.equal(params.threadId, "native-thread"); assert.equal(params.limit, 1);
        return { data: params.cursor === null ? [{ type: "turnCompleted", position: 22, turnId: "failed-turn", status: "failed", error: { message, codexErrorInfo: "serverOverloaded" } }]
          : [{ type: "item", position: 21, turnId: "earlier", item: { type: "agentMessage", id: "answer", text: "Earlier complete native answer" } }],
          nextCursor: params.cursor === null ? "previous-timeline-window" : null, activeRealtimeSessionAtPageStart: null };
      }; return wire;
    } });
  try {
    const attachment = await runtime.controller.open(input, () => {}), run = attachment.identity.run;
    const history: CodexScope = { kind: "codex", origin: { connection: scope.connection, principal: scope.principal, host: scope.host, nativeSession: run.nativeSession, attachment: "host-epoch" }, threadId: run.nativeSession };
    const port = runtime.history.port(run, history);
    const failed = await port.read({ scope: history, cursor: null, count: 1 });
    assert.equal(failed.records.length, 1); assert.equal(failed.records[0]!.native.type, "turnError");
    assert.deepEqual(failed.records[0]!.body, { kind: "complete", text: message, evidence: "nativeFullBody" });
    assert.match(port.context!, /:timeline-v1$/);
    const older = await port.read({ scope: history, cursor: failed.nextCursor, count: 1 });
    assert.equal(older.records[0]!.lifecycle, "completed"); assert.equal(older.records[0]!.native.completedAtMs, null);
    await attachment.stopTree();
    const reader = await runtime.prepareHistoryReader(run, history);
    const cold = await reader.port.read({ scope: history, cursor: null, count: 1 });
    assert.deepEqual(cold.records, failed.records); assert.notEqual(reader.port.context, port.context);
    await reader.close(); await assert.rejects(reader.port.read({ scope: history, cursor: null, count: 1 }));
    const methods = wires.flatMap(wire => wire.sent).map(frame => frame.method);
    assert.equal(methods.filter(method => method === "thread/timeline/list").length, 3);
    assert.equal(methods.some(method => ["thread/resume", "thread/items/list", "thread/turns/list", "turn/start", "turn/steer"].includes(String(method))), false);
    assert.equal(f.docker.containers.size, 0);
  } finally { await runtime.close(); await f.dispose(); }
});

test("Codex concrete factory is inert, installs custody before exact .162 open, preserves policy, and explicit cold reader never resumes", async () => {
  const f = await fixture(), wires: Wire[] = []; const wire: CodexWireFactory = () => { const value = new Wire(); wires.push(value); return value; };
  try {
    const runtime = createCodexRuntime({ ...f.options, environment: f.options.environment, model: "gpt-6-luna", provider: { id: "guard", baseUrl: "http://127.0.0.1:12345/v1", environmentKey: "TEST_KEY", copilotOnly: true }, catalog: async () => ({ available: true, choices: [] }), commands: f.docker, wire,
      mcpServers: { fixture: { command: "/usr/local/bin/node", args: [join(f.options.cwd, "mcp.mjs")] }, remote: { type: 'http', url: 'https://mcp-fixture.invalid/mcp' } }, multiAgent: { maxThreads: 2, maxDepth: 1 }, });
    assert.equal(wires.length, 0); assert.equal(f.docker.calls.length, 0); let durableCustody = false;
    const attachment = await runtime.controller.open(input, () => {}, undefined, async owner => { assert.equal(wires.length, 0); assert.equal(owner.opening.operationId, input.operationId); durableCustody = true; });
    assert.equal(durableCustody, true); assert.equal(attachment.identity.containment.length, 64);
    const nativeOpen = wires[0]!.sent.find(message => message.method === "thread/start")!; assert.deepEqual(nativeOpen.params, { model: "gpt-6-luna", modelProvider: "guard", cwd: f.options.cwd, approvalPolicy: "on-request", sandbox: "danger-full-access", ephemeral: false });
    assert.equal(runtime.controller.capabilities.commands.includes("codex.defaults"), true);
    const config = await readFile(join(f.options.home, "config.toml"), "utf8"); assert.match(config, /sandbox_mode = "danger-full-access"/); assert.match(config, /approval_policy = "on-request"/); assert.match(config, /\[mcp_servers.fixture\]/); assert.match(config, /multi_agent = true/);
    assert.match(config, /^mcp_oauth_credentials_store_mode = "file"$/m); assert.ok(config.indexOf('mcp_oauth_credentials_store_mode') < config.indexOf('[model_providers.'));
    assert.match(config, /\[mcp_servers.remote\]\nurl = "https:\/\/mcp-fixture.invalid\/mcp"/); assert.equal(runtime.controller.capabilities.commands.includes('codex.mcp.login'), true);
    const run = attachment.identity.run;
    const history: CodexScope = { kind: "codex", origin: { connection: scope.connection, principal: scope.principal, host: scope.host, nativeSession: run.nativeSession, attachment: "host-epoch" }, threadId: run.nativeSession };
    const activeContext = runtime.history.port(run, history).context; assert.ok(activeContext); assert.equal(runtime.history.port(run, history).context, activeContext);
    await attachment.stopTree();
    const oldCalls = wires[0]!.sent.length, inactive = runtime.history.port(run, history); assert.ok(inactive.context); assert.notEqual(inactive.context, activeContext); assert.equal(runtime.history.port(run, history).context, inactive.context);
    assert.equal((await inactive.read({ scope: history, cursor: null, count: 2 })).status, "unsupported"); assert.equal(wires[0]!.sent.length, oldCalls, "inactive resolution/read cannot reactivate or read native");
    const projectTrust = `\n[projects.${JSON.stringify(f.options.cwd)}]\ntrust_level = "trusted"\n`, creates = f.docker.calls.filter(call => call[0] === "create").length;
    for (const suffix of [projectTrust + '\n[model_providers.guard]\nbase_url = "https://unselected.invalid"\n', projectTrust + projectTrust, projectTrust + 'model = "unselected"\n', '\n[projects."unterminated]\ntrust_level = "trusted"\n']) {
      await writeFile(join(f.options.home, "config.toml"), config + suffix);
      await assert.rejects(runtime.prepareHistoryReader(run, history), /Private native policy differs/);
      assert.equal(f.docker.calls.filter(call => call[0] === "create").length, creates, "malformed metadata and policy overrides fail before any reader allocation");
    }
    await writeFile(join(f.options.home, "config.toml"), config + projectTrust);
    const reader = await runtime.prepareHistoryReader(run, history); assert.equal(wires.length, 2); assert.equal(runtime.history.port(run, history), reader.port);
    assert.equal(await readFile(join(f.options.home, "config.toml"), "utf8"), config + projectTrust, "native trust metadata is retained, not overwritten");
    assert.ok(reader.port.context); assert.notEqual(reader.port.context, activeContext); assert.notEqual(reader.port.context, inactive.context);
    await reader.port.read({ scope: history, cursor: null, count: 2 });
    assert.deepEqual(wires[1]!.sent.filter(message => message.id !== undefined).map(message => message.method), ["initialize", "thread/read", "thread/timeline/list"]);
    await reader.close(); await assert.rejects(reader.port.read({ scope: history, cursor: null, count: 2 }));
    const otherReader = await runtime.prepareHistoryReader(run, history); assert.ok(otherReader.port.context); assert.notEqual(otherReader.port.context, reader.port.context); await otherReader.close();
    const resumed = await runtime.controller.open({ ...input, nativeSession: run.nativeSession, generation: 2, operationId: "resume-new-original" }, () => {});
    const resume = wires[3]!.sent.find(message => message.method === "thread/resume")!; assert.equal((resume.params as { excludeTurns: boolean }).excludeTurns, true); assert.equal("includeTurns" in (resume.params as object), false); assert.notEqual(runtime.history.port(resumed.identity.run, history).context, activeContext); await resumed.stopTree();
  } finally { await f.dispose(); }
});

test("archive retires an exact journalled cold reader after writer loss without creating, resuming, scanning or deleting history", async () => {
  const f = await fixture(), wires: Wire[] = [], hosts: Awaited<ReturnType<typeof openHost>>[] = [], runtimes: ReturnType<typeof createCodexRuntime>[] = [];
  const directory = join(f.root, "host"), retained = join(f.root, "retained-native-history"); await writeFile(retained, "vendor-owned history");
  const runtime = () => {
    const value = createCodexRuntime({ ...f.options, model: "gpt-6-luna", provider: { id: "guard", baseUrl: "http://127.0.0.1/v1", environmentKey: "TEST_KEY", copilotOnly: true }, catalog: async () => ({ available: false, choices: [] }), commands: f.docker,
      wire: input => { assert.equal(input.cwd, wires.length === 0 ? f.options.cwd : f.options.directory); const value = new Wire(); if (wires.length >= 2) value.list = () => ({ data: [{ turnId: 'saved-turn', startedAtMs: 1, completedAtMs: 2, item: { type: 'commandExecution', id: 'archived-tool', command: 'scripted echo', status: 'completed', aggregatedOutput: 'cold archived native tool body', exitCode: 0 } }], nextCursor: null, backwardsCursor: null }); wires.push(value); return value; } }); runtimes.push(value); return value;
  };
  const open = async () => { const native = runtime(); const host = await openHost({ directory, cwd: f.options.cwd, scope, policy: input.policy, controller: native.controller, history: native.history, archive: { ready: async () => true, release: () => rm(f.options.cwd, { recursive: true }) }, observationMs: 60000 }); hosts.push(host); return host; };
  try {
    const first = await open(); await acknowledged(first.session, { scope, id: "create", generation: 0, command: { type: "create" } });
    await acknowledged(first.session, { scope, id: "stop", generation: 1, command: { type: "stop" } }); await until(() => first.updateReadiness().ready);
    await first.terminate();
    // Pinned Codex appends native-owned project trust after thread/start.
    // A cold reader must preserve that metadata without changing managed policy.
    const config = join(f.options.home, "config.toml"), managed = await readFile(config, "utf8");
    await writeFile(config, managed + `\n[projects.${JSON.stringify(f.options.cwd)}]\ntrust_level = "trusted"\n`);
    const cold = await open(), binding = (await cold.binding())!;
    assert.deepEqual(await cold.history.recover(binding.history), { state: "value", value: { status: "ready" } });
    const held = await cold.session.readers.read(); assert.equal(held.state, "owned");
    assert.equal(wires.length, 2); assert.equal(f.docker.containers.size, 1);
    if (held.state !== "owned") throw Error("expected exact saved reader");
    await assert.rejects(inspectLinuxOpening(held.capsule, {}, f.docker), /./, "reader purpose cannot be used as agent custody");
    // Lose only the owned writer. The original helper deliberately remains in
    // its separate runtime, so a new empty reader variable proves nothing.
    await cold.session.terminate();
    const restored = await open(); const before = f.docker.calls.filter(call => call[0] === "create").length;
    await acknowledged(restored.session, { scope, id: "archive", generation: 1, command: { type: "archive" } });
    assert.equal((await restored.session.snapshot(scope)).archive?.state, "complete");
    assert.deepEqual(await restored.session.readers.read(), { state: "none" });
    assert.equal(f.docker.containers.size, 0); assert.equal(f.docker.calls.filter(call => call[0] === "create").length, before);
    assert.equal(wires.length, 2); assert.equal(wires.flatMap(wire => wire.sent).filter(message => message.method === "thread/start").length, 1);
    assert.equal(wires.flatMap(wire => wire.sent).some(message => message.method === "thread/resume"), false);
    assert.equal(await readFile(retained, "utf8"), "vendor-owned history");
    const originalArchive = await restored.session.receipt(scope, 'archive');
    await assert.rejects(stat(f.options.cwd), { code: 'ENOENT' });
    const warmSaved = (await restored.binding())!;
    assert.deepEqual(await restored.history.recover(warmSaved.history), { state: 'value', value: { status: 'ready' } });
    assert.equal((await restored.session.readers.read()).state, 'owned');
    await assert.rejects(stat(f.options.cwd), { code: 'ENOENT' }, 'A warm archived reader must not recreate its released workspace');
    await restored.close();
    const archived = await open(), saved = (await archived.binding())!;
    assert.equal(archived.history.snapshot(saved.history).rows.length, 0, 'A new Host has no in-memory transcript after Archive');
    assert.deepEqual(await archived.history.recover(saved.history), { state: 'value', value: { status: 'ready' } });
    const tool = archived.history.snapshot(saved.history).rows.find(row => row.kind === 'tool')!;
    assert.equal(tool.body.kind, 'complete');
    if (tool.body.kind !== 'complete') throw Error('EXPECTED_ARCHIVED_NATIVE_BODY');
    assert.equal(tool.body.text, 'cold archived native tool body');
    assert.equal((await archived.session.readers.read()).state, 'owned');
    assert.deepEqual(await archived.session.receipt(scope, 'archive'), originalArchive);
    assert.equal(wires.length, 4); assert.equal(wires.flatMap(wire => wire.sent).filter(message => message.method === 'thread/start').length, 1);
    assert.equal(wires.flatMap(wire => wire.sent).some(message => message.method === 'thread/resume' || message.method === 'turn/start'), false);
    await archived.close(); assert.equal(f.docker.containers.size, 0);
    await assert.rejects(stat(f.options.cwd), { code: 'ENOENT' });
    assert.equal(await readFile(retained, 'utf8'), 'vendor-owned history');
  } finally { for (const host of hosts) await host.terminate().catch(() => {}); for (const native of runtimes) await native.close().catch(() => {}); await f.dispose(); }
});

test("Codex actual runtime proves every explicit nested child page and cold reader without granting live/control ownership", async () => {
  const f = await fixture(), wires: Wire[] = [];
  const wire: CodexWireFactory = () => { const value = new Wire(); wires.push(value);
    value.read = params => { const id = String(params.threadId); assert.equal(params.includeTurns, false); return { thread: { id, cwd: join(f.options.cwd, id), sessionId: id === "grandchild" ? "child" : "native-thread", ...(id === "native-thread" ? {} : { parentThreadId: id === "child" ? "native-thread" : "child" }) } }; };
    value.list = params => { assert.ok(params.threadId === "grandchild" || params.threadId === "native-thread"); return { data: [{ turnId: "turn", startedAtMs: 1, completedAtMs: 2, item: { type: "agentMessage", id: params.cursor === null ? "latest" : "oldest", text: params.threadId === "grandchild" ? "child body" : "root body" } }], nextCursor: params.cursor === null ? "older" : null, backwardsCursor: "back" }; }; return value; };
  const runtime = createCodexRuntime({ ...f.options, model: "gpt-6-luna", provider: { id: "guard", baseUrl: "http://127.0.0.1/v1", environmentKey: "TEST_KEY", copilotOnly: true }, catalog: async () => ({ available: false, choices: [] }), commands: f.docker, wire, });
  try {
    const attachment = await runtime.controller.open(input, () => {}), run = attachment.identity.run;
    const child: CodexScope = { kind: "codex", origin: { connection: scope.connection, principal: scope.principal, host: scope.host, nativeSession: run.nativeSession, attachment: "host-epoch" }, threadId: "grandchild" };
    const port = runtime.history.port(run, child); assert.equal(wires[0]!.sent.filter(value => value.method === "thread/read").length, 0, "resolving a port is inert");
    assert.equal((await port.read({ scope: child, cursor: null, count: 2 })).nextCursor, "older");
    await port.read({ scope: child, cursor: "older", count: 2 });
    assert.equal(wires[0]!.sent.filter(value => value.method === "thread/read").length, 6);
    assert.equal(wires[0]!.sent.filter(value => value.method === "thread/timeline/list").length, 2);
    assert.equal(runtime.controller.current()!.run.nativeSession, run.nativeSession);
    assert.deepEqual(await runtime.history.pathContext(run, child, () => {}), { cwd: join(f.options.cwd, "grandchild"), dialect: "posix" });
    wires[0]!.read = params => ({ thread: { id: params.threadId, sessionId: params.threadId === "native-thread" ? "native-thread" : "foreign", ...(params.threadId === "native-thread" ? {} : { parentThreadId: "native-thread" }) } });
    await assert.rejects(port.read({ scope: child, cursor: "older", count: 2 }), /LINEAGE/);
    assert.equal(wires[0]!.sent.filter(value => value.method === "thread/timeline/list").length, 2, "shared context without lineage cannot dispatch a page");
    await attachment.stopTree();
    const root = { ...child, threadId: run.nativeSession }, reader = await runtime.prepareHistoryReader(run, root), childReader = await runtime.prepareHistoryReader(run, child);
    assert.equal(wires.length, 2, "Root and child share the one sessionless RPC/allocation");
    assert.equal(childReader.port.context, reader.port.context);
    await assert.rejects(runtime.prepareHistoryReader({ ...run, generation: run.generation + 1 }, child)); assert.equal(wires.length, 2);
    await runtime.history.authorize(run, child, () => {});
    await reader.port.read({ scope: root, cursor: null, count: 2 }); await childReader.port.read({ scope: child, cursor: null, count: 2 });
    const pages = wires[1]!.sent.filter(value => value.method === "thread/timeline/list").length;
    wires[1]!.read = params => ({ thread: { id: params.threadId, sessionId: params.threadId === "native-thread" ? "native-thread" : "foreign", ...(params.threadId === "native-thread" ? {} : { parentThreadId: "native-thread" }) } });
    await assert.rejects(childReader.port.read({ scope: child, cursor: "older", count: 2 }));
    assert.equal(wires[1]!.sent.filter(value => value.method === "thread/timeline/list").length, pages, "Each child page re-proves genuine ancestry before its body RPC");
    await reader.close(); await assert.rejects(childReader.port.read({ scope: child, cursor: null, count: 2 }));
    assert.equal(wires[1]!.sent.some(value => value.method === "thread/resume" || value.method === "thread/start" || value.method === "turn/start"), false);
    assert.equal(f.docker.containers.size, 0);
  } finally { await runtime.close(); runtime.controller.dispose(); await f.dispose(); }
});

test("stopped Codex parent recovery proves nested children in the same read job and shares one reader without adopting foreign references", async () => {
  const f = await fixture(), wires: Wire[] = [];
  const runtime = createCodexRuntime({ ...f.options, model: "gpt-6-luna", provider: { id: "guard", baseUrl: "http://127.0.0.1/v1", environmentKey: "TEST_KEY", copilotOnly: true },
    catalog: async () => ({ available: false, choices: [] }), commands: f.docker, wire: () => {
      const wire = new Wire(); wires.push(wire);
      wire.read = params => ({ thread: { id: params.threadId, sessionId: "native-thread",
        ...(params.threadId === "cold-child" ? { parentThreadId: "native-thread" } : params.threadId === "nested-child" ? { parentThreadId: "cold-child" } : {}) } });
      wire.list = params => ({ data: [{ turnId: "saved-turn", startedAtMs: 1, completedAtMs: 2, item: { type: "agentMessage", id: `saved-${params.threadId}`, text: `saved ${params.threadId}` } },
        ...(params.threadId === "native-thread" ? [{ turnId: "saved-turn", startedAtMs: 1, completedAtMs: 2, item: { type: "collabAgentToolCall", id: "old-references", status: "completed", senderThreadId: "native-thread", receiverThreadIds: ["cold-child", "nested-child", "unproved-foreign", "cold-child"] } }] : [])], nextCursor: null, backwardsCursor: null });
      return wire;
    } });
  const host = await openHost({ scope, directory: join(f.root, "host"), cwd: f.options.cwd, controller: runtime.controller, history: runtime.history, policy: input.policy });
  try {
    assert.deepEqual(host.history.scopes(), []);
    await acknowledged(host.session, { scope, id: "create-cold-tree", generation: 0, command: { type: "create" } });
    const binding = (await host.binding())!, root = binding.history as CodexScope, child = { ...root, threadId: "cold-child" }, foreign = { ...root, threadId: "unproved-foreign" };
    host.history.emit(root, [{ type: "gap", gap: { id: "cold-tree-gap", kind: "nativeGap" } }]);
    await acknowledged(host.session, { scope, id: "stop-cold-tree", generation: 1, command: { type: "stop" } });
    const watch = host.history.watch(root); await watch.next(); await watch.return();
    assert.deepEqual(host.history.scopes(), [root]); assert.equal(wires.length, 1, "Stopped mount/inventory does not allocate or fetch");
    assert.deepEqual(await host.history.recover(root), { state: "value", value: { status: "ready" } });
    const nested = { ...root, threadId: "nested-child" };
    assert.deepEqual(host.history.scopes(), [root, child, nested]); assert.equal(wires.length, 2);
    assert.equal(host.history.snapshot(child).rows.length, 0, "Discovery reads metadata, never a child body");
    assert.equal(host.history.snapshot(nested).rows.length, 0);
    assert.equal(wires[1]!.sent.filter(message => message.method === "thread/read" && (message.params as { threadId: string }).threadId === "cold-child").length, 1, "Sibling proofs reuse only this page's bounded ancestry cache");
    const recovered = await Promise.all([host.history.recover(child), host.history.recover(nested)]);
    assert.deepEqual(recovered, [{ state: "value", value: { status: "ready" } }, { state: "value", value: { status: "ready" } }]);
    assert.equal(wires.length, 2); assert.equal(f.docker.containers.size, 1);
    assert.equal(host.history.snapshot(root).rows.some(row => row.body.kind === "complete" && row.body.text === "saved native-thread"), true);
    assert.equal(host.history.snapshot(child).rows.some(row => row.body.kind === "complete" && row.body.text === "saved cold-child"), true);
    assert.deepEqual(await host.history.authorize(foreign), { state: "failed", code: "READ_FAILED" });
    assert.deepEqual(host.history.scopes(), [root, child, nested], "Missing native parent proof never enters the inventory");
    assert.ok(host.history.snapshot(root).coverage.gaps.some(gap => gap.kind === "identity"), "Unavailable proof remains visible without discarding parent text");
    assert.equal(wires[1]!.sent.some(message => ["thread/start", "thread/resume", "turn/start"].includes(String(message.method))), false);
    assert.equal((await host.session.snapshot(scope)).phase, "stopped");
  } finally { await runtime.close(); await host.terminate(); await f.dispose(); }
});

test("Stop during inline child discovery fences the held parent page and cannot publish a late scope", async () => {
  const f = await fixture(), entered = deferred<void>(), release = deferred<void>(), wire = new Wire();
  wire.read = async params => {
    if (params.threadId === "late-child") { entered.resolve(); await release.promise; }
    return { thread: { id: params.threadId, sessionId: "native-thread", ...(params.threadId === "late-child" ? { parentThreadId: "native-thread" } : {}) } };
  };
  wire.list = () => ({ data: [{ turnId: "saved-turn", startedAtMs: 1, completedAtMs: 2,
    item: { type: "subAgentActivity", id: "old-child", agentThreadId: "late-child", agentPath: "/root/late-child", kind: "started" } }], nextCursor: null, backwardsCursor: null });
  const runtime = createCodexRuntime({ ...f.options, model: "gpt-6-luna", provider: { id: "guard", baseUrl: "http://127.0.0.1/v1", environmentKey: "TEST_KEY", copilotOnly: true },
    catalog: async () => ({ available: false, choices: [] }), commands: f.docker, wire: () => wire });
  const host = await openHost({ scope, directory: join(f.root, "host"), cwd: f.options.cwd, controller: runtime.controller, history: runtime.history, policy: input.policy });
  try {
    await acknowledged(host.session, { scope, id: "create-inline-proof", generation: 0, command: { type: "create" } });
    const root = (await host.binding())!.history as CodexScope;
    host.history.emit(root, [{ type: "gap", gap: { id: "inline-proof-gap", kind: "nativeGap" } }]);
    const pending = host.history.recover(root); await entered.promise;
    await acknowledged(host.session, { scope, id: "stop-inline-proof", generation: 1, command: { type: "stop" } });
    release.resolve(); const result = await pending;
    assert.notDeepEqual(result, { state: "value", value: { status: "ready" } });
    assert.deepEqual(host.history.scopes(), [root]); assert.equal(host.history.snapshot(root).rows.length, 0);
    assert.equal(f.docker.containers.size, 0); assert.equal(wire.sent.some(value => value.method === "thread/resume" || value.method === "turn/start"), false);
  } finally { release.resolve(); await runtime.close(); await host.terminate(); await f.dispose(); }
});

test("Codex reader expiry retains exact retirement custody before concurrent replacement can acquire another reader", async () => {
  const f = await fixture(), wires: Wire[] = [], heldPage = deferred<unknown>(), removal = deferred<void>();
  f.docker.removalGate = removal.promise;
  const runtime = createCodexRuntime({ ...f.options, model: "gpt-6-luna", provider: { id: "guard", baseUrl: "http://127.0.0.1/v1", environmentKey: "TEST_KEY", copilotOnly: true },
    readerLifetimeMs: 20, catalog: async () => ({ available: false, choices: [] }), commands: f.docker, wire: () => { const wire = new Wire(); wires.push(wire); wire.list = async () => heldPage.promise; return wire; } });
  const run = { scope, generation: 1, nativeSession: "native-thread" }, history: CodexScope = { kind: "codex", origin: { connection: scope.connection, principal: scope.principal, host: scope.host, nativeSession: run.nativeSession, attachment: "stopped-host" }, threadId: run.nativeSession };
  try {
    const reader = await runtime.prepareHistoryReader(run, history);
    const pending = reader.port.read({ scope: history, cursor: null, count: 1 }), rejected = assert.rejects(pending);
    await f.docker.removalStarted.promise;
    const replacement = runtime.prepareHistoryReader(run, history), duplicate = runtime.prepareHistoryReader(run, history);
    assert.equal(wires.length, 1); assert.equal(f.docker.containers.size, 1, "Sealed but unproved retirement still owns the only reader allocation");
    removal.resolve(); await rejected;
    const [a, b] = await Promise.all([replacement, duplicate]); assert.equal(a.port, b.port); assert.equal(wires.length, 2); assert.equal(f.docker.containers.size, 1);
    assert.notEqual(a.port.context, reader.port.context); await a.close();
    assert.equal(wires.every(wire => wire.sent.every(message => !["thread/start", "thread/resume", "turn/start"].includes(String(message.method)))), true);
  } finally { removal.resolve(); heldPage.resolve({ data: [], nextCursor: null, backwardsCursor: null }); await runtime.close(); await f.dispose(); }
});

test("Codex child metadata retained across Stop cannot dispatch or publish a late item page", async () => {
  const f = await fixture(), wire = new Wire(), entered = deferred<void>(), release = deferred<void>();
  const runtime = createCodexRuntime({ ...f.options, model: "gpt-6-luna", provider: { id: "guard", baseUrl: "http://127.0.0.1/v1", environmentKey: "TEST_KEY", copilotOnly: true }, catalog: async () => ({ available: false, choices: [] }), commands: f.docker, wire: () => wire, });
  try {
    const attachment = await runtime.controller.open(input, () => {}), run = attachment.identity.run;
    const child: CodexScope = { kind: "codex", origin: { connection: scope.connection, principal: scope.principal, host: scope.host, nativeSession: run.nativeSession, attachment: "host-epoch" }, threadId: "child" };
    wire.read = async params => { entered.resolve(); await release.promise; return { thread: { id: params.threadId, sessionId: "native-thread", parentThreadId: "native-thread" } }; };
    const pending = runtime.history.port(run, child).read({ scope: child, cursor: null, count: 2 }); void pending.catch(() => {});
    await entered.promise; await attachment.stopTree(); release.resolve(); await assert.rejects(pending);
    assert.equal(wire.sent.some(value => value.method === "thread/timeline/list"), false);
  } finally { release.resolve(); await runtime.close(); runtime.controller.dispose(); await f.dispose(); }
});

test("Codex fresh Create and explicit reopen use actual Host admission without foreign read authority or a chained turn", async () => {
  const f = await fixture(); try {
    const wire = new Wire(), runtime = createCodexRuntime({ ...f.options, model: "gpt-6-luna", provider: { id: "guard", baseUrl: "http://127.0.0.1/v1", environmentKey: "TEST_KEY", copilotOnly: true }, catalog: async () => ({ available: false, choices: [] }), commands: f.docker, wire: () => wire });
    const run = { scope, generation: 1, nativeSession: "native-thread" }, foreign: CodexScope = { kind: "codex", origin: { ...scope, principal: "other", nativeSession: run.nativeSession, attachment: "epoch" }, threadId: run.nativeSession };
    await assert.rejects(runtime.prepareHistoryReader(run, foreign)); assert.equal(f.docker.calls.length, 0);
    const host = await openHost({ scope, directory: join(f.root, "host"), cwd: f.options.cwd, controller: runtime.controller, policy: input.policy });
    try {
      assert.equal(runtime.controller.capabilities.reopen, true); assert.equal(runtime.controller.capabilities.createAndWait, true);
      assert.equal((await acknowledged(host.session, { scope, id: "fresh-original", generation: 0, command: { type: "create" } })).state, "acknowledged");
      const observed = await host.session.snapshot(scope);
      assert.equal(observed.phase, "running"); assert.equal(observed.interactionsComplete, true); assert.equal(observed.activity, "idle");
      assert.equal(wire.sent.filter(value => value.method === "thread/start").length, 1);
      assert.equal(wire.sent.some(value => value.method === "thread/read" || value.method === "turn/start"), false);
      assert.equal((await acknowledged(host.session, { scope, id: "stop-original", generation: 1, command: { type: "stop" } })).state, "acknowledged");
      const reopened = await acknowledged(host.session, { scope, id: "explicit-reopen", generation: 1, command: { type: "resume" } });
      assert.equal(reopened.state, "acknowledged");
      assert.equal(wire.sent.filter(value => value.method === "thread/resume").length, 1); assert.equal(wire.sent.some(value => value.method === "turn/start"), false);
      await acknowledged(host.session, { scope, id: "stop-reopened", generation: 2, command: { type: "stop" } }); assert.equal(f.docker.containers.size, 0);
    } finally { await runtime.close(); await host.terminate(); }
  } finally { await f.dispose(); }
});

test("Codex initial settings follow durable native custody; defaults and running-turn updates retain native truth", async () => {
  const f = await fixture(); let host: Awaited<ReturnType<typeof openHost>> | undefined, nativeOwned = false;
  class SettingsWire extends Wire {
    observeSettings = true;
    settings(params: Record<string, unknown>) {
      const mode = params.collaborationMode as { settings?: { model?: string; reasoning_effort?: string | null } } | undefined;
      this.frame({ method: "thread/settings/updated", params: { threadId: "native-thread", threadSettings: {
        model: params.model ?? mode?.settings?.model ?? "gpt-6-luna", effort: params.effort ?? mode?.settings?.reasoning_effort ?? null,
        ...(mode ? { collaborationMode: mode } : {}),
      } } });
    }
    override async write(line: string) {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.method === "thread/settings/update" || message.method === "turn/settings/update") {
        this.sent.push(message); assert.equal(nativeOwned, true, "Native identity must be durably observed before an initial settings RPC");
        const params = message.params as Record<string, unknown>;
        if (message.method === "thread/settings/update" && this.observeSettings) this.settings(params);
        this.frame({ id: message.id, result: message.method === "thread/settings/update" ? {} : { status: "applied" } }); return;
      }
      return super.write(line);
    }
  }
  const wire = new SettingsWire(), runtime = createCodexRuntime({ ...f.options, model: "gpt-6-luna", provider: { id: "guard", baseUrl: "http://127.0.0.1/v1", environmentKey: "TEST_KEY", copilotOnly: true }, catalog: async () => ({ available: true, choices: [{ model: "gpt-6-luna", efforts: ["low", "high"] }] }), commands: f.docker, wire: () => wire });
  try {
    host = await openHost({ scope, directory: join(f.root, "host"), cwd: f.options.cwd, controller: runtime.controller, policy: input.policy });
    const off = host.session.subscribe(scope, snapshot => { if (snapshot.nativeSession === "native-thread") nativeOwned = true; });
    try {
      const created = await acknowledged(host.session, { scope, id: "initial-settings", generation: 0, command: { type: "create", selection: { kind: "codex", model: "gpt-6-luna", effort: "high" } } });
      assert.equal(created.state, "acknowledged");
      const initial = wire.sent.find(message => message.method === "thread/settings/update")!;
      assert.deepEqual(initial.params, { threadId: "native-thread", effort: "high", collaborationMode: { mode: "default", settings: { model: "gpt-6-luna", reasoning_effort: "high", developer_instructions: null } } });
      let selected = (await host.session.snapshot(scope)).selection; assert.equal(selected.effort, "high");
      assert.equal(selected.kind, "codex"); if (selected.kind === "codex") assert.deepEqual(selected.collaboration, { mode: "default", model: "gpt-6-luna", effort: "high", instructions: null });
      wire.observeSettings = false;
      const changed = await acknowledged(host.session, { scope, id: "defaults-original", generation: 1, command: { type: "codex.defaults", selection: { kind: "codex", effort: "low" } } });
      assert.equal(changed.state, "acknowledged"); assert.equal(changed.outcome?.status, "acknowledged");
      assert.equal((await host.session.snapshot(scope)).selection.effort, "high", "Empty native ACK must not fabricate observed settings");
      const defaults = wire.sent.filter(message => message.method === "thread/settings/update")[1]!;
      assert.deepEqual(defaults.params, { threadId: "native-thread", effort: "low", collaborationMode: { mode: "default", settings: { model: "gpt-6-luna", reasoning_effort: "low", developer_instructions: null } } });
      wire.settings(defaults.params as Record<string, unknown>);
      assert.equal((await host.session.snapshot(scope)).selection.effort, "low");
      const turn = await acknowledged(host.session, { scope, id: "turn-settings-original", generation: 1, command: { type: "codex.turn", turnId: "exact-turn", selection: { kind: "codex", model: "gpt-6-luna", effort: "high" } } });
      assert.equal(turn.state, "acknowledged"); assert.equal(turn.outcome?.status, "applied");
      assert.deepEqual(wire.sent.find(message => message.method === "turn/settings/update")!.params, { threadId: "native-thread", turnId: "exact-turn", model: "gpt-6-luna", effort: "high" });
      assert.equal((await host.session.snapshot(scope)).selection.effort, "low", "A running-turn update cannot overwrite future thread defaults");
      assert.equal(wire.sent.some(message => message.method === "turn/start" || message.method === "thread/resume"), false);
      await acknowledged(host.session, { scope, id: "settings-stop", generation: 1, command: { type: "stop" } });
    } finally { off(); }
  } finally { await runtime.close(); await host?.terminate(); await f.dispose(); }
});

test("Codex settings arriving after ACK during final startup persistence cannot regress to the opening response", async () => {
  const f = await fixture(), committing = deferred<void>(), release = deferred<void>();
  let host: Awaited<ReturnType<typeof openHost>> | undefined, intercepted = false;
  class SettingsAfterAckWire extends Wire {
    override async write(line: string) {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.method === "thread/start" || message.method === "thread/settings/update") {
        this.sent.push(message);
        const params = message.params as Record<string, unknown>;
        this.frame({ id: message.id, result: message.method === "thread/start"
          ? { thread: { id: "native-thread", status: { type: "idle" } }, model: params.model, modelProvider: "guard", approvalPolicy: params.approvalPolicy, sandbox: { type: "dangerFullAccess" }, reasoningEffort: null }
          : {} });
        return;
      }
      return super.write(line);
    }
  }
  const wire = new SettingsAfterAckWire(), originalCall = SessionJournal.prototype.call;
  SessionJournal.prototype.call = async function<T>(method: string, input: unknown): Promise<T> {
    const result = await originalCall.call(this, method, input) as T;
    const snapshot = input && typeof input === "object" && "snapshot" in input ? input.snapshot as { phase?: string; selection?: { effort?: string | null } } : undefined;
    if (!intercepted && method === "state" && snapshot?.phase === "running" && snapshot.selection?.effort === null) {
      intercepted = true; committing.resolve(); await release.promise;
    }
    return result;
  };
  const runtime = createCodexRuntime({ ...f.options, model: "gpt-6-sol", provider: { id: "guard", baseUrl: "http://127.0.0.1/v1", environmentKey: "TEST_KEY", copilotOnly: true }, catalog: async () => ({ available: true, choices: [{ model: "gpt-6-sol", efforts: ["ultra"] }] }), commands: f.docker, wire: () => wire });
  try {
    host = await openHost({ scope, directory: join(f.root, "host"), cwd: f.options.cwd, controller: runtime.controller, policy: input.policy });
    const creating = acknowledged(host.session, { scope, id: "initial-settings-after-ack", generation: 0, command: { type: "create", selection: { kind: "codex", model: "gpt-6-sol", effort: "ultra" } } });
    await committing.promise;
    // Pinned .162.1 acknowledges queued settings before emitting their applied
    // observation. Deliver that actual native shape while the final real
    // SQLite write has completed but its caller has not resumed.
    wire.frame({ method: "thread/settings/updated", params: { threadId: "native-thread", threadSettings: {
      model: "gpt-6-sol", modelProvider: "guard", effort: "ultra", approvalPolicy: "on-request", sandboxPolicy: { type: "dangerFullAccess" }, activePermissionProfile: null,
      collaborationMode: { mode: "default", settings: { model: "gpt-6-sol", reasoning_effort: "ultra", developer_instructions: "Native built-in Default instructions\nPreserve their exact observed text." } },
    } } });
    release.resolve(); await creating;
    const observed = await host.session.snapshot(scope);
    assert.equal(observed.phase, "running"); assert.equal(observed.selection.model, "gpt-6-sol"); assert.equal(observed.selection.effort, "ultra");
    assert.equal(observed.selection.kind, "codex");
    if (observed.selection.kind === "codex") {
      assert.equal(observed.selection.collaboration?.mode, "default");
      assert.deepEqual(observed.selection.access, { approval: "on-request", sandbox: "danger-full-access" });
    }
    assert.equal(wire.sent.filter(value => value.method === "thread/settings/update").length, 1);
    assert.equal(wire.sent.some(value => ["thread/read", "thread/resume", "turn/start"].includes(String(value.method))), false);
    await acknowledged(host.session, { scope, id: "settings-after-ack-stop", generation: 1, command: { type: "stop" } });
  } finally {
    release.resolve(); SessionJournal.prototype.call = originalCall;
    await runtime.close(); await host?.terminate(); await f.dispose();
  }
});

test("Codex Resume retains opening preferences but observes returned native settings without replaying them", async () => {
  const f = await fixture(), entered = deferred<void>(), release = deferred<void>(), wires: Wire[] = [];
  const retained = { kind: "codex", model: "gpt-6-luna-selected", effort: "high", access: input.policy.kind === "codex" ? input.policy.access : undefined,
    collaboration: { mode: "plan", model: "gpt-6-luna-selected", effort: "high", instructions: "retained native instructions" } } as const;
  const returnedMode = { mode: "plan", settings: { model: retained.model, reasoning_effort: "medium", developer_instructions: "current native instructions" } };
  class ResumeWire extends Wire {
    override async write(line: string) {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.method !== "thread/resume") return super.write(line);
      this.sent.push(message); entered.resolve(); await release.promise;
      const params = message.params as Record<string, unknown>;
      this.frame({ id: message.id, result: { thread: { id: "native-thread", status: { type: "idle" } }, model: params.model, modelProvider: "guard", approvalPolicy: params.approvalPolicy,
        sandbox: { type: "dangerFullAccess" }, reasoningEffort: "medium", collaborationMode: returnedMode } });
    }
  }
  const runtime = createCodexRuntime({ ...f.options, model: "runtime-default-must-not-win", provider: { id: "guard", baseUrl: "http://127.0.0.1/v1", environmentKey: "TEST_KEY", copilotOnly: true },
    catalog: async () => ({ available: false, choices: [] }), commands: f.docker, wire: () => { const wire = new ResumeWire(); wires.push(wire); return wire; },
  });
  const host = await openHost({ scope, directory: join(f.root, "host"), cwd: f.options.cwd, controller: runtime.controller, policy: input.policy });
  try {
    await acknowledged(host.session, { scope, id: "create-for-resume", generation: 0, command: { type: "create" } });
    wires[0]!.frame({ method: "thread/settings/updated", params: { threadId: "native-thread", threadSettings: { model: retained.model, effort: retained.effort,
      collaborationMode: { mode: retained.collaboration.mode, settings: { model: retained.collaboration.model, reasoning_effort: retained.collaboration.effort, developer_instructions: retained.collaboration.instructions } } } } });
    assert.deepEqual((await host.session.snapshot(scope)).selection, retained);
    await acknowledged(host.session, { scope, id: "stop-before-resume", generation: 1, command: { type: "stop" } });
    assert.deepEqual((await host.session.snapshot(scope)).selection, retained);
    const resuming = acknowledged(host.session, { scope, id: "resume-retained", generation: 1, command: { type: "resume" } });
    await entered.promise;
    const starting = await host.session.snapshot(scope); assert.equal(starting.phase, "starting"); assert.deepEqual(starting.selection, { kind: "codex" });
    assert.deepEqual(wires[1]!.sent.find(message => message.method === "thread/resume")!.params,
      { model: retained.model, modelProvider: "guard", cwd: f.options.cwd, approvalPolicy: "on-request", sandbox: "danger-full-access", threadId: "native-thread", excludeTurns: true });
    release.resolve(); await resuming;
    assert.deepEqual((await host.session.snapshot(scope)).selection, { ...retained, effort: "medium", collaboration: { ...retained.collaboration, effort: "medium", instructions: "current native instructions" } });
    assert.equal(wires[1]!.sent.some(message => message.method === "thread/settings/update" || message.method === "turn/start"), false);
    await acknowledged(host.session, { scope, id: "stop-after-resume", generation: 2, command: { type: "stop" } });
  } finally { release.resolve(); await runtime.close(); await host.terminate(); await f.dispose(); }
});

test("Codex terminal pages are explicit bounded native reads and mutations retain exact originals without Stop or Send inference", async () => {
  const f = await fixture();
  const terminal = { itemId: "item", processId: "native-process", command: "long-running command", cwd: f.options.cwd, osPid: 123, cpuPercent: 1.5, rssKb: 8192 };
  class TerminalWire extends Wire {
    override async write(line: string) {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.method !== "string" || !message.method.startsWith("thread/backgroundTerminals/")) return super.write(line);
      this.sent.push(message); const params = message.params as Record<string, unknown>;
      const result = message.method.endsWith("/list") ? { data: params.cursor === null ? [{ ...terminal, privateExtra: "must not project" }] : [], nextCursor: params.cursor === null ? "next-page" : null }
        : message.method.endsWith("/terminate") ? { terminated: false, privateExtra: "must not project" } : {};
      this.frame({ id: message.id, result });
    }
  }
  const wire = new TerminalWire(), runtime = createCodexRuntime({ ...f.options, model: "gpt-6-luna", provider: { id: "guard", baseUrl: "http://127.0.0.1/v1", environmentKey: "TEST_KEY", copilotOnly: true },
    catalog: async () => ({ available: false, choices: [] }), commands: f.docker, wire: () => wire });
  const host = await openHost({ scope, directory: join(f.root, "host"), cwd: f.options.cwd, controller: runtime.controller, policy: input.policy });
  try {
    await acknowledged(host.session, { scope, id: "create-terminals", generation: 0, command: { type: "create" } });
    const run = { scope, generation: 1, nativeSession: "native-thread" };
    assert.equal(wire.sent.some(message => String(message.method).startsWith("thread/backgroundTerminals/")), false);
    assert.deepEqual(await host.session.read(run, { type: "codex.terminals", limit: 2 }), { run, type: "codex.terminals", data: [terminal], nextCursor: "next-page" });
    assert.equal(wire.sent.filter(message => message.method === "thread/backgroundTerminals/list").length, 1, "One request reads one page; nextCursor never starts another native call");
    assert.deepEqual(await host.session.read(run, { type: "codex.terminals", cursor: "next-page", limit: 2 }), { run, type: "codex.terminals", data: [], nextCursor: null });
    const original: Submit = { scope, id: "terminate-exact", generation: 1, command: { type: "codex.terminal.terminate", processId: terminal.processId } };
    assert.deepEqual((await acknowledged(host.session, original)).outcome, { status: "applied", detail: { processId: terminal.processId, terminated: false } });
    await host.session.submit(original);
    assert.equal(wire.sent.filter(message => message.method === "thread/backgroundTerminals/terminate").length, 1);
    assert.equal((await acknowledged(host.session, { scope, id: "clean-exact", generation: 1, command: { type: "codex.terminals.clean" } })).outcome?.status, "acknowledged");
    assert.deepEqual(wire.sent.filter(message => String(message.method).startsWith("thread/backgroundTerminals/")).map(message => ({ method: message.method, params: message.params })), [
      { method: "thread/backgroundTerminals/list", params: { threadId: run.nativeSession, cursor: null, limit: 2 } },
      { method: "thread/backgroundTerminals/list", params: { threadId: run.nativeSession, cursor: "next-page", limit: 2 } },
      { method: "thread/backgroundTerminals/terminate", params: { threadId: run.nativeSession, processId: terminal.processId } },
      { method: "thread/backgroundTerminals/clean", params: { threadId: run.nativeSession } },
    ]);
    assert.equal((await host.session.snapshot(scope)).phase, "running");
    assert.equal(wire.sent.some(message => message.method === "turn/start" || message.method === "turn/interrupt"), false);
    await acknowledged(host.session, { scope, id: "stop-terminals", generation: 1, command: { type: "stop" } });
    assert.throws(() => host.session.read(run, { type: "codex.terminals" }));
    assert.equal(wire.sent.filter(message => message.method === "thread/backgroundTerminals/list").length, 2);
  } finally { await runtime.close(); await host.terminate(); await f.dispose(); }
});

test("Codex MCP reload uses one no-body original, invalidates retained inventory and never starts another discovery or turn", async () => {
  const f = await fixture();
  class ReloadWire extends Wire {
    override async write(line: string) {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.method !== "config/mcpServer/reload" && message.method !== "mcpServerStatus/list") return super.write(line);
      this.sent.push(message);
      if (message.method === "config/mcpServer/reload") assert.equal(Object.hasOwn(message, "params"), false);
      this.frame({ id: message.id, result: message.method === "config/mcpServer/reload" ? {} : { data: [{ name: "fixture", runtimeStatus: "connected", authStatus: "unsupported", tools: {}, toolsError: null, httpOrigin: null }], nextCursor: null } });
    }
  }
  const wire = new ReloadWire(), runtime = createCodexRuntime({ ...f.options, model: "gpt-6-luna", provider: { id: "guard", baseUrl: "http://127.0.0.1/v1", environmentKey: "TEST_KEY", copilotOnly: true }, catalog: async () => ({ available: false, choices: [] }), commands: f.docker, wire: () => wire });
  const host = await openHost({ scope, directory: join(f.root, "host"), cwd: f.options.cwd, controller: runtime.controller, policy: input.policy });
  try {
    await acknowledged(host.session, { scope, id: "create-mcp", generation: 0, command: { type: "create" } }); const run = (await host.binding())!.run;
    assert.equal((await host.mcp.refresh(run)).freshness, "current");
    const original: Submit = { scope, id: "reload-original", generation: 1, command: { type: "codex.mcp.reload" } };
    const [a, b] = await Promise.all([acknowledged(host.session, original), acknowledged(host.session, original)]); assert.deepEqual(a, b); assert.deepEqual(a.outcome, { status: "acknowledged", detail: {} });
    await host.session.submit(original); assert.deepEqual(await host.session.receipt(scope, original.id), a);
    assert.equal(wire.sent.filter(message => message.method === "config/mcpServer/reload").length, 1); assert.equal(wire.sent.filter(message => message.method === "mcpServerStatus/list").length, 1);
    assert.equal((await host.mcp.snapshot(run)).freshness, "stale"); assert.equal(wire.sent.some(message => /^(turn\/start|thread\/resume)$/.test(String(message.method))), false);
    await acknowledged(host.session, { scope, id: "stop-mcp", generation: 1, command: { type: "stop" } });
    assert.equal((await host.session.submit({ scope, id: "reload-stopped", generation: 1, command: { type: "codex.mcp.reload" } })).state, "refused");
    assert.equal(wire.sent.filter(message => message.method === "config/mcpServer/reload").length, 1);
  } finally { await runtime.close(); await host.terminate(); await f.dispose(); }
});

test("Codex initial explicit collaboration and selected model use the pinned post-owned settings encoder", async () => {
  const f = await fixture(); let nativeOwned = false;
  const collaboration = { mode: "plan" as const, model: "configured-other-model", effort: "high", instructions: "Requested plan instructions" };
  class InitialWire extends Wire {
    override async write(line: string) {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.method !== "thread/settings/update") return super.write(line);
      this.sent.push(message); assert.equal(nativeOwned, true);
      const params = message.params as Record<string, unknown>;
      this.frame({ method: "thread/settings/updated", params: { threadId: "native-thread", threadSettings: { model: collaboration.model, effort: collaboration.effort, collaborationMode: params.collaborationMode } } });
      this.frame({ id: message.id, result: {} });
    }
  }
  const wire = new InitialWire(), runtime = createCodexRuntime({ ...f.options, model: "gpt-6-luna", provider: { id: "guard", baseUrl: "http://127.0.0.1/v1", environmentKey: "TEST_KEY", copilotOnly: true }, catalog: async () => ({ available: true, choices: [{ model: collaboration.model, efforts: ["high"] }] }), commands: f.docker, wire: () => wire });
  try {
    const owned = await runtime.controller.open({ ...input, selection: { kind: "codex", model: collaboration.model, collaboration } }, () => {}, async () => { nativeOwned = true; });
    assert.equal((wire.sent.find(message => message.method === "thread/start")!.params as { model: string }).model, collaboration.model);
    assert.deepEqual(wire.sent.find(message => message.method === "thread/settings/update")!.params, { threadId: "native-thread", collaborationMode: { mode: collaboration.mode, settings: { model: collaboration.model, reasoning_effort: collaboration.effort, developer_instructions: collaboration.instructions } } });
    assert.equal(owned.native.selection.kind, "codex");
    if (owned.native.selection.kind === "codex") assert.deepEqual(owned.native.selection.collaboration, collaboration);
    assert.equal(wire.sent.some(message => message.method === "turn/start" || message.method === "thread/resume"), false);
    await owned.stopTree();
  } finally { await runtime.close(); await f.dispose(); }
});

test("Codex fresh certificate refuses native work, pending reverse requests or wire loss while preserving exact Stop custody", async () => {
  for (const mode of ["native-work", "pending-request", "wire-loss"] as const) {
    const f = await fixture(); let host: Awaited<ReturnType<typeof openHost>> | undefined;
    class BusyWire extends Wire {
      override async write(line: string) {
        const message = JSON.parse(line) as Record<string, unknown>;
        await super.write(line);
        if (message.method === "thread/start" && mode === "wire-loss") { await this.close(); return; }
        if (message.method === "thread/start") this.frame(mode === "native-work"
          ? { method: "turn/started", params: { threadId: "native-thread", turn: { id: "unexpected-work" } } }
          : { id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "native-thread", turnId: "turn", itemId: "item", command: "printf owned" } });
      }
    }
    const wire = new BusyWire(), runtime = createCodexRuntime({ ...f.options, model: "gpt-6-luna", provider: { id: "guard", baseUrl: "http://127.0.0.1/v1", environmentKey: "TEST_KEY", copilotOnly: true }, catalog: async () => ({ available: false, choices: [] }), commands: f.docker, wire: () => wire });
    try {
      host = await openHost({ scope, directory: join(f.root, "host"), cwd: f.options.cwd, controller: runtime.controller, policy: input.policy });
      const original = await committedReceipt(host.session, { scope, id: "uncertain-fresh", generation: 0, command: { type: "create" } }, receipt => receipt.state === "outcomeUnknown" && receipt.reason === "nativeOutcomeUnknown");
      assert.equal(original.state, "outcomeUnknown");
      const state = await host.session.snapshot(scope); assert.equal(state.phase, "starting"); assert.equal(state.nativeSession, "native-thread"); assert.equal(state.interactionsComplete, false);
      assert.equal(wire.sent.filter(message => message.method === "thread/start").length, 1);
      assert.equal((await acknowledged(host.session, { scope, id: "stop-busy-fresh", generation: 1, command: { type: "stop" } })).state, "acknowledged");
      assert.equal(f.docker.containers.size, 0); assert.equal((await host.session.receipt(scope, "uncertain-fresh"))?.state, "outcomeUnknown");
      assert.equal(wire.sent.some(message => message.method === "turn/start" || message.method === "thread/resume"), false);
    } finally { await runtime.close(); await host?.terminate(); await f.dispose(); }
  }
});

test("Codex disabled multi-agent policy closes model-selected V2 and preserves exact managed home reuse", async () => {
  const f = await fixture(), wires: Wire[] = [];
  const runtime = createCodexRuntime({ ...f.options, model: "gpt-6-luna", provider: { id: "guard", baseUrl: "http://127.0.0.1/v1", environmentKey: "TEST_KEY", copilotOnly: true }, catalog: async () => ({ available: false, choices: [] }), commands: f.docker,
    multiAgent: false, wire: () => { const value = new Wire(); wires.push(value); return value; }, });
  try {
    const attachment = await runtime.controller.open(input, () => {}), run = attachment.identity.run;
    const file = join(f.options.home, "config.toml"), config = await readFile(file, "utf8");
    const disabled = "[features]\nmulti_agent = false\nmulti_agent_v2 = false\n[agents]\nenabled = false\n";
    assert.ok(config.includes(disabled), "legacy feature false alone does not override pinned Luna's model-selected V2");
    assert.match(config, /^approval_policy = "on-request"$/m); assert.match(config, /^sandbox_mode = "danger-full-access"$/m);
    const open = wires[0]!.sent.find(value => value.method === "thread/start")!;
    assert.equal((open.params as Record<string, unknown>).approvalPolicy, "on-request"); assert.equal((open.params as Record<string, unknown>).sandbox, "danger-full-access");
    await attachment.stopTree();
    const history: CodexScope = { kind: "codex", origin: { connection: scope.connection, principal: scope.principal, host: scope.host, nativeSession: run.nativeSession, attachment: "host-epoch" }, threadId: run.nativeSession };
    const retained = config + `\n[projects.${JSON.stringify(f.options.cwd)}]\ntrust_level = "trusted"\n`;
    await writeFile(file, retained);
    const reader = await runtime.prepareHistoryReader(run, history); await reader.close();
    assert.equal(await readFile(file, "utf8"), retained, "same managed policy permits exact native project-trust suffix without rewriting");
    assert.equal(wires[1]!.sent.some(value => value.method === "thread/resume" || value.method === "thread/start"), false);
    const legacy = retained.replace(disabled, "[features]\nmulti_agent = false\n"), creates = f.docker.calls.filter(value => value[0] === "create").length;
    await writeFile(file, legacy);
    await assert.rejects(runtime.prepareHistoryReader(run, history), /Private native policy differs/);
    assert.equal(await readFile(file, "utf8"), legacy, "a previous artifact's managed policy is fenced, never upgraded in place");
    assert.equal(f.docker.calls.filter(value => value[0] === "create").length, creates); assert.equal(wires.length, 2);
  } finally { await runtime.close(); await f.dispose(); }
});

test("real opening capability can retire before native launch; late explicit factory close remains one exact cleanup", async () => {
  const f = await fixture(); let starts = 0;
  try {
    const runtime = createCodexRuntime({ ...f.options, model: "gpt-6-luna", provider: { id: "guard", baseUrl: "http://127.0.0.1/v1", environmentKey: "TEST_KEY", copilotOnly: true }, catalog: async () => ({ available: false, choices: [] }), commands: f.docker,
      multiAgent: false, wire: () => { starts++; return new Wire(); } });
    await assert.rejects(runtime.controller.open(input, () => {}, undefined, async held => { const proof = await held.stop(); assert.equal(proof.acquisitionSealed, true); }));
    assert.equal(starts, 0); assert.equal(runtime.controller.current(), null); assert.equal(f.docker.calls.filter(call => call[0] === "create").length, 1); assert.equal(f.docker.calls.filter(call => call[0] === "rm").length, 1);
    await runtime.close(); await runtime.close(); assert.equal(f.docker.calls.filter(call => call[0] === "rm").length, 1);
  } finally { await f.dispose(); }
});

test("Codex raw reused reverse ID cannot resolve replacement callback; disconnect never auto-answers or restarts", async () => {
  const wire = new Wire(), requests: CodexReverseRequest[] = [], rpc = new CodexStdioRpc(wire, () => {}, request => requests.push(request));
  await rpc.initialize(); wire.frame({ id: 7, method: "item/commandExecution/requestApproval", params: {} }); const original = requests[0]!;
  let settled = false; void original.settled.catch(() => {});
  wire.frame({ id: 7, method: "item/fileChange/requestApproval", params: {} }); const replacement = requests[1]!; void replacement.settled.then(() => { settled = true; }, () => {});
  await assert.rejects(original.respond({ decision: "accept" })); wire.frame({ method: "serverRequest/resolved", params: { requestId: 7 } }); await Promise.resolve(); assert.equal(settled, false);
  assert.equal((await replacement.respond({ decision: "decline" })).kind, "submitted"); await rpc.close();
  assert.throws(() => rpc.request("thread/start", {})); assert.equal(wire.sent.filter(message => message.result !== undefined).length, 1);
});

test("Codex reverse capacity follows outstanding incarnations across sequential requests and positively resolved ID reuse", async () => {
  const wire = new Wire(), requests: CodexReverseRequest[] = [], rpc = new CodexStdioRpc(wire, () => {}, request => requests.push(request));
  try {
    await rpc.initialize();
    for (let id = 1; id <= 300; id++) {
      wire.frame({ id, method: "item/commandExecution/requestApproval", params: {} });
      const request = requests.at(-1)!; assert.equal(request.id, id);
      assert.equal((await request.respond({ decision: "decline" })).kind, "submitted");
      wire.frame({ method: "serverRequest/resolved", params: { requestId: id } });
      await request.settled;
      assert.equal(rpc.observation().pendingReverse, 0); assert.equal(rpc.observation().connected, true);
    }
    const original = requests[0]!;
    wire.frame({ id: 1, method: "item/fileChange/requestApproval", params: {} });
    const reused = requests.at(-1)!; assert.notEqual(reused.token, original.token);
    await assert.rejects(original.respond({ decision: "accept" }));
    assert.equal((await reused.respond({ decision: "decline" })).kind, "submitted");
    wire.frame({ method: "serverRequest/resolved", params: { requestId: 1 } }); await reused.settled;
    assert.deepEqual(rpc.observation(), { connected: true, pendingReverse: 0, ambiguousReverse: false, turnStarts: 0, itemStarts: 0 });
  } finally { await rpc.close(); }
});

test("Codex 64 outstanding reverse slots admit same-ID overlap without resolving its ambiguous replacement", async () => {
  const wire = new Wire(), requests: CodexReverseRequest[] = [], rpc = new CodexStdioRpc(wire, () => {}, request => requests.push(request));
  try {
    await rpc.initialize();
    for (let id = 1; id <= 64; id++) wire.frame({ id, method: "item/commandExecution/requestApproval", params: {} });
    assert.equal(rpc.observation().pendingReverse, 64);
    const old = requests[0]!;
    wire.frame({ id: 1, method: "item/fileChange/requestApproval", params: {} });
    const replacement = requests.at(-1)!; assert.equal(requests.length, 65); assert.notEqual(replacement.token, old.token);
    await assert.rejects(old.settled); await assert.rejects(old.respond({ decision: "accept" }));
    let resolved = false; void replacement.settled.then(() => { resolved = true; }, () => {});
    wire.frame({ method: "serverRequest/resolved", params: { requestId: 1 } }); await Promise.resolve();
    assert.equal(resolved, false); assert.equal(rpc.observation().pendingReverse, 64); assert.equal(rpc.observation().ambiguousReverse, true);
    assert.equal((await replacement.respond({ decision: "decline" })).kind, "submitted");
    for (let id = 2; id <= 64; id++) wire.frame({ method: "serverRequest/resolved", params: { requestId: id } });
    assert.equal(rpc.observation().pendingReverse, 1);
    for (let id = 65; id <= 127; id++) wire.frame({ id, method: "item/commandExecution/requestApproval", params: {} });
    assert.equal(rpc.observation().connected, true); assert.equal(rpc.observation().pendingReverse, 64);
    wire.frame({ id: 128, method: "item/commandExecution/requestApproval", params: {} });
    assert.equal(rpc.observation().connected, false); assert.equal(rpc.diagnostics().rpc.failure, "invalidFrame");
    await assert.rejects(replacement.settled); assert.equal(resolved, false);
  } finally { await rpc.close(); }
});

test("pre-ID Codex diagnostics preserve only bounded version/method/code facts and never native private text", async () => {
  const wire = new Wire(); wire.userAgent = "multiplex_v8/0.0.0 codex/0.162.1 private-provider-and-home";
  const rpc = new CodexStdioRpc(wire, () => {}, () => {}); await assert.rejects(rpc.initialize()); await rpc.close();
  assert.deepEqual(rpc.diagnostics().rpc.initialize, { hasUserAgent: true, versionCandidates: ["0.0.0", "0.162.1"], leadingVersion: "0.0.0" });
  assert.equal(rpc.diagnostics().rpc.failure, "versionMismatch"); assert.equal(JSON.stringify(rpc.diagnostics()).includes("private-provider-and-home"), false);
  class Rejecting extends Wire { override async write(line: string) { const message = JSON.parse(line) as Record<string, unknown>; this.frame({ id: message.id, error: { code: -32602, message: "private-configuration-body" } }); } }
  const rejected = new CodexStdioRpc(new Rejecting(), () => {}, () => {}); await assert.rejects(rejected.initialize());
  assert.deepEqual(rejected.diagnostics().rpc.lastNativeError, { method: "initialize", code: -32602 }); assert.equal(JSON.stringify(rejected.diagnostics()).includes("private-configuration-body"), false); await rejected.close();
});


test("Codex exact .162 experimental plan and named-profile Send reach the same closed native wire", async () => {
  const f = await fixture(), wires: Wire[] = [];
  const runtime = createCodexRuntime({ ...f.options, model: "gpt-6-luna", provider: { id: "guard", baseUrl: "http://127.0.0.1/v1", environmentKey: "TEST_KEY", copilotOnly: true }, catalog: async () => ({ available: true, choices: [{ model: "gpt-6-luna", efforts: ["low"] }] }), commands: f.docker,
    wire: () => { const value = new Wire(); wires.push(value); return value; }, });
  try {
    const attachment = await runtime.controller.open(input, () => {}), wire = wires[0]!;
    const init = wire.sent.find(message => message.method === "initialize")!;
    assert.equal((init.params as { capabilities: { experimentalApi: boolean } }).capabilities.experimentalApi, true);
    const instructions = "Ask the genuine native question and await its answer.";
    const outcome = await attachment.native.invoke({ type: "send", text: "Ask the fixture question", selection: { kind: "codex", collaboration: { mode: "plan", model: "gpt-6-luna", effort: "low", instructions } } });
    assert.equal(outcome.status, "accepted"); assert.deepEqual(outcome.detail, { turnId: "turn" });
    const turns = wire.sent.filter(message => message.method === "turn/start"); assert.equal(turns.length, 1);
    assert.deepEqual(turns[0]!.params, { threadId: "native-thread", input: [{ type: "text", text: "Ask the fixture question", text_elements: [] }], collaborationMode: { mode: "plan", settings: { model: "gpt-6-luna", reasoning_effort: "low", developer_instructions: instructions } } });
    assert.equal((await attachment.native.invoke({ type: "send", text: "named profile input", selection: { kind: "codex", access: { approval: "on-request", profile: "native-selected" } } })).status, 'accepted');
    assert.deepEqual(wire.sent.filter(message => message.method === 'turn/start')[1]!.params, { threadId: 'native-thread', input: [{ type: 'text', text: 'named profile input', text_elements: [] }], approvalPolicy: 'on-request', permissions: 'native-selected' });
  } finally { await runtime.close(); await f.dispose(); }
});


test("Codex opening encodes sandbox or profile exclusively and requires native profile provenance", async () => {
  for (const access of [{ approval: 'on-request', sandbox: 'danger-full-access' }, { approval: 'untrusted', sandbox: 'read-only' }, { approval: 'on-request', sandbox: 'workspace-write' }, { approval: 'on-request', profile: 'native-selected' }] as const) {
    const f = await fixture();
    class AccessWire extends Wire {
      profileOverride: string | undefined;
      override async write(line: string) {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.method === 'thread/start') {
          this.sent.push(message); const fields = message.params as Record<string, unknown>;
          this.frame({ id: message.id, result: { thread: { id: 'native-thread', status: { type: 'idle' } }, model: fields.model, modelProvider: 'guard', approvalPolicy: fields.approvalPolicy,
            sandbox: { type: fields.sandbox === 'read-only' || fields.permissions ? 'readOnly' : fields.sandbox === 'workspace-write' ? 'workspaceWrite' : 'dangerFullAccess' },
            ...(fields.permissions ? { activePermissionProfile: { id: this.profileOverride ?? fields.permissions } } : {}) } }); return;
        }
        return super.write(line);
      }
    }
    const wire = new AccessWire(), runtime = createCodexRuntime({ ...f.options, model: 'gpt-6-luna', provider: { id: 'guard', baseUrl: 'http://127.0.0.1/v1', environmentKey: 'TEST_KEY', copilotOnly: true }, catalog: async () => ({ available: true, choices: [] }), commands: f.docker, wire: () => wire });
    try {
      const attachment = await runtime.controller.open({ ...input, selection: { kind: 'codex', access } }, () => {}), fields = wire.sent.find(message => message.method === 'thread/start')!.params as Record<string, unknown>;
      assert.equal(fields.modelProvider, 'guard'); assert.equal(fields.approvalPolicy, access.approval);
      if ('profile' in access) { assert.equal(fields.permissions, access.profile); assert.equal('sandbox' in fields, false); }
      else { assert.equal(fields.sandbox, access.sandbox); assert.equal('permissions' in fields, false); }
      assert.equal(attachment.native.selection.kind, 'codex'); if (attachment.native.selection.kind === 'codex') assert.deepEqual(attachment.native.selection.access, access);
      if ('profile' in access) {
        await attachment.stopTree(); wire.profileOverride = 'different-native-profile'; let owned = false;
        await assert.rejects(runtime.controller.open({ ...input, generation: 2, operationId: 'profile-mismatch', selection: { kind: 'codex', access } }, () => {}, async () => { owned = true; }), { code: 'IO' });
        assert.equal(wire.sent.filter(message => message.method === 'thread/start').length, 2, 'mismatched native reply was actually received');
        assert.equal(owned, true, 'native identity is owned before validating its selected profile'); assert.equal(runtime.controller.current()?.run.generation, 2, 'mismatch retains exact current Stop capability');
      }
    } finally { await runtime.close(); await f.dispose(); }
  }
});

test("actual Host admits restricted/profile Codex permissions but refuses unproved model patches; native rejection stays unknown", async () => {
  const f = await fixture(); let host: Awaited<ReturnType<typeof openHost>> | undefined;
  class SelectionWire extends Wire {
    rejectTurn = false;
    override async write(line: string) {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.method === 'thread/settings/update') { this.sent.push(message); this.frame({ id: message.id, result: {} }); return; }
      if (message.method === "turn/start" && this.rejectTurn) { this.sent.push(message); this.frame({ id: message.id, error: { code: -32603, message: "owned scripted native failure" } }); return; }
      return super.write(line);
    }
  }
  const wire = new SelectionWire(), runtime = createCodexRuntime({ ...f.options, model: "gpt-6-luna", provider: { id: "guard", baseUrl: "http://127.0.0.1/v1", environmentKey: "TEST_KEY", copilotOnly: true }, catalog: async () => ({ available: true, choices: [{ model: "gpt-6-luna", efforts: ["low"] }] }), commands: f.docker, wire: () => wire, });
  try {
    host = await openHost({ scope, directory: join(f.root, "host"), cwd: f.options.cwd, controller: runtime.controller, nativeInputRoots: runtime.nativeInputRoots, policy: input.policy, observationMs: 5000 });
    let serial = 0;
    const submit = async (command: SessionCommand) => host!.session.submit({ scope, id: `selection-original-${++serial}`, generation: (await host!.session.snapshot(scope)).generation, command });
    assert.equal((await submit({ type: "create" })).state, "acknowledged");
    const selections = [
      { kind: "codex" as const, model: "gpt-6-luna" },
      { kind: "codex" as const, effort: "low" },
    ];
    for (const selection of selections) {
      const receipt = await submit({ type: "send", text: "local refusal", selection });
      assert.equal(receipt.state, "refused"); assert.equal(receipt.outcome?.status, "refused"); assert.deepEqual(receipt.outcome?.detail, { sendDispatched: false, reason: "unsupportedSelection" });
      assert.equal(wire.sent.filter(message => message.method === "turn/start").length, 0); assert.equal((await host.session.receipt(scope, receipt.id))?.state, "refused");
    }
    for (const access of [{ approval: 'on-request', sandbox: 'workspace-write' }, { approval: 'untrusted', sandbox: 'read-only' }, { approval: 'on-request', profile: 'native-selected' }] as const) {
      const applied = await submit({ type: 'codex.defaults', selection: { kind: 'codex', access } }); assert.equal(applied.state, 'acknowledged');
      const fields = wire.sent.filter(message => message.method === 'thread/settings/update').at(-1)!.params as Record<string, unknown>;
      assert.equal(fields.approvalPolicy, access.approval);
      if ('profile' in access) { assert.equal(fields.permissions, access.profile); assert.equal('sandboxPolicy' in fields, false); }
      else assert.deepEqual(fields.sandboxPolicy, access.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false } : { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
    }
    assert.deepEqual((await host.session.snapshot(scope)).selection, { kind: 'codex', model: 'gpt-6-luna', effort: 'low', access: { approval: 'on-request', sandbox: 'danger-full-access' } }, 'settings ACKs do not become observed permission facts');
    const accepted = await submit({ type: "send", text: "supported full access", selection: { kind: "codex", access: { approval: "on-request", sandbox: "danger-full-access" } } });
    assert.equal(accepted.state, "acknowledged"); assert.equal(accepted.outcome?.status, "accepted"); assert.equal(wire.sent.filter(message => message.method === "turn/start").length, 1);
    wire.rejectTurn = true;
    const uncertain = await submit({ type: "send", text: "native rejection remains uncertain" });
    assert.equal(uncertain.state, "outcomeUnknown"); assert.equal(uncertain.reason, "nativeOutcomeUnknown"); assert.equal(wire.sent.filter(message => message.method === "turn/start").length, 2);
    assert.equal((await host.session.receipt(scope, uncertain.id))?.state, "outcomeUnknown"); await submit({ type: "stop" });
  } finally { await runtime.close(); await host?.terminate(); await f.dispose(); }
});

test("actual Codex stdio Steer classifies only exact pinned NotSubmitted branches and preserves all other failures as uncertain without bodies", async () => {
  const { createCodexInvocation } = await import("../../v8-harness-codex/src/invocation.js");
  type RunRef = import("../../v8-session/src/contracts/types.js").RunRef;
  const { NativeInputRefused } = await import("../../v8-session/src/contracts/types.js");
  class SteeringWire extends Wire {
    error: { code: number; message: string } | undefined;
    override async write(line: string) {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.method === "thread/queue/add") { this.sent.push(message); this.frame({ id: message.id, result: { queuedSubmission: { id: "native-queued", clientUserMessageId: (message.params as { clientUserMessageId: string }).clientUserMessageId, input: "private echoed body" } } }); return; }
      if (message.method === "turn/steer") { this.sent.push(message); this.frame({ id: message.id, ...(this.error ? { error: this.error } : { result: { turnId: (message.params as { expectedTurnId: string }).expectedTurnId } }) }); return; }
      return super.write(line);
    }
  }
  const wire = new SteeringWire(), rpc = new CodexStdioRpc(wire, () => {}, () => {}), run: RunRef = { scope, generation: 1, nativeSession: "native-root" };
  try {
    await rpc.initialize(); const invoke = createCodexInvocation({ run, rpc: (method, params) => rpc.request(method, params) });
    for (const [message, reason] of [["no active turn to steer", "noActiveTurn"], ["expected active turn id `original` but found `replacement`", "expectedTurnMismatch"], ["cannot steer a review turn", "activeTurnNotSteerable"], ["cannot steer a compact turn", "activeTurnNotSteerable"]] as const) {
      wire.error = { code: -32600, message }; assert.deepEqual(await invoke({ type: "codex.steer", expectedTurnId: "original", text: "never retarget" }), { status: "refused", detail: { reason } });
    }
    for (const error of [{ code: -32603, message: "no active turn to steer" }, { code: -32600, message: "private unknown native failure" }, { code: -32600, message: "expected active turn id `original` but found `bad\nidentity`" }]) {
      wire.error = error;
      await assert.rejects(invoke({ type: "codex.steer", expectedTurnId: "original", text: "original correction" }), (failure: unknown) => failure instanceof Error && !(failure instanceof NativeInputRefused) && !failure.message.includes("private"));
    }
    wire.error = undefined; assert.deepEqual(await invoke({ type: "codex.steer", expectedTurnId: "original", text: "exact" }), { status: "accepted", detail: { turnId: "original" } });
    assert.deepEqual(await invoke({ type: "codex.queue.add", text: "queued original", clientUserMessageId: "original-queue-id" }), { status: "accepted", detail: { queuedSubmission: { id: "native-queued", clientUserMessageId: "original-queue-id" } } });
    assert.equal(wire.sent.filter(message => message.method === "thread/queue/add").length, 1);
    assert.equal(wire.sent.filter(message => message.method === "turn/steer").length, 8); assert.equal(wire.sent.filter(message => message.method === "turn/start").length, 0);
    assert.ok(!JSON.stringify(rpc.diagnostics()).includes("private"));
  } finally { await rpc.close(); }
});
