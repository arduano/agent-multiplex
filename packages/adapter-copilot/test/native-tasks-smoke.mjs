// Native task API qualification; disposable built-in sleeps only, no prompts/models.
// Run after building dependencies: node --import tsx packages/adapter-copilot/test/native-tasks-smoke.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { CopilotAgentAdapter } from "../src/adapter.ts";

const root = resolve(import.meta.dirname, "../../..");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const sources = ["package.json", "package-lock.json", "packages/protocol/src/command.ts", "packages/protocol/src/harness.ts",
  "packages/adapter-copilot/src/adapter.ts", "packages/adapter-copilot/src/session.ts", "packages/adapter-copilot/src/tasks.ts",
  "packages/adapter-copilot/src/reads.ts", "packages/adapter-copilot/test/native-tasks-smoke.mjs"];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, digest(await readFile(join(root, file)))])));
const before = await sourceHashes();
const scratch = await mkdtemp(join(tmpdir(), "multiplex-native-tasks-"));
const checks = []; let providerRequests = 0, taskEvents = 0, native, adapter, session;
const provider = createServer((_request, response) => { providerRequests++; response.writeHead(503).end(); });
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
try {
  const home = join(scratch, "copilot"); await mkdir(home, { mode: 0o700 });
  const env = { ...process.env, COPILOT_HOME: home, COPILOT_AUTO_UPDATE: "false" };
  for (const key of Object.keys(env)) if (/^(?:LEO_|AGENT_MULTIPLEX_|CODEX_|COPILOT_PROVIDER_)/i.test(key) ||
    /^(?:COPILOT_CLI_PATH|COPILOT_CONNECTION_TOKEN|COPILOT_SDK_AUTH_TOKEN|COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|NODE_AUTH_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|COPILOT_OFFLINE)$/i.test(key)) delete env[key];
  adapter = new CopilotAgentAdapter({
    clientOptions: { baseDirectory: home, env, useLoggedInUser: false, logLevel: "none",
      connection: RuntimeConnection.forStdio({ path: createRequire(import.meta.url).resolve(`@github/copilot-${process.platform}-${process.arch}`) }) },
    provider: { type: "openai", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, wireApi: "completions" },
    defaultModel: "disposable-no-model",
    clientFactory: options => {
      const client = new CopilotClient(options), create = client.createSession.bind(client);
      client.createSession = async config => { native = await create(config); return native; };
      return client;
    },
  });
  const description = await adapter.describe(); assert.equal(description.available, true);
  for (const name of ["tasks.list", "tasks.progress", "tasks.promoteToBackground", "tasks.cancel"])
    assert.ok(description.capabilities.some(c => c.name === name && c.version === "v1"));
  session = await adapter.spawn({ harness: "copilot", cwd: scratch });
  session.subscribe(event => { if (event.kind === "native" && event.nativeType === "session.background_tasks_changed") taskEvents++; });
  const read = async (view, extra = {}) => (await session.readNativeState({ harness: "copilot", view, ...extra })).payload;
  const command = (type, id) => session.execute({ harness: "copilot", command: { type, id } });
  assert.deepEqual(await read("tasks"), { tasks: [] });
  assert.deepEqual(await read("currentPromotableTask"), {});
  assert.deepEqual(await read("taskProgress", { id: "absent-fixture" }), { progress: null });
  assert.deepEqual(await command("cancelTask", "absent-fixture"), { cancelled: false });
  assert.deepEqual(await command("promoteTaskToBackground", "absent-fixture"), { promoted: false });
  checks.push("empty native observations and exact absent-ID controls preserve explicit no-op results");
  await session.execute({ harness: "copilot", command: { type: "setPermissionMode", mode: "allow-all" } });
  await native.rpc.tools.initializeAndValidate();
  for (const promote of [true, false]) {
    const id = promote ? "disposable-promote" : "disposable-cancel";
    // Native tool execution creates the fixture only. Production controls expose
    // task APIs, never this arbitrary tool/shell surface.
    const tool = native.rpc.tools.execute({ name: "bash", toolCallId: id + "-call", arguments: {
      command: "sleep 30", description: "Disposable task control qualification", mode: "sync", initial_wait: 60, shellId: id,
    } });
    tool.catch(() => {});
    let task;
    for (let i = 0; i < 50; i++) {
      task = (await read("tasks")).tasks.find(task => task.id === id && task.canPromoteToBackground === true);
      if (task) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(task, "sync shell must appear with its native exact ID");
    assert.equal(task.type, "shell"); assert.equal(task.executionMode, "sync"); assert.equal(task.status, "running");
    assert.equal((await read("taskProgress", { id })).progress.type, "shell");
    if (promote) {
      assert.deepEqual(await command("promoteTaskToBackground", id), { promoted: true });
      const after = (await read("tasks")).tasks.find(task => task.id === id);
      assert.equal(after.executionMode, "background"); assert.equal(after.canPromoteToBackground, false);
      assert.equal((await tool).resultType, "success");
      assert.deepEqual(await command("promoteTaskToBackground", id), { promoted: false });
    }
    assert.deepEqual(await command("cancelTask", id), { cancelled: true });
    await tool;
    // Native refresh may report a reaped shell as completed after acknowledging
    // cancellation. Preserve that terminal observation instead of rewriting it.
    assert.ok(["cancelled", "completed"].includes((await read("tasks")).tasks.find(task => task.id === id).status));
    assert.deepEqual(await command("cancelTask", id), { cancelled: false });
    checks.push(promote ? "sync shell promotion releases native waiter and preserves background task identity; exact task cancellation succeeds" : "exact task cancellation works while the shell remains synchronously awaited");
  }
  assert.ok(taskEvents > 0, "native changes should emit invalidation events");
  checks.push("native task-change events pass through the adapter");
  assert.equal(providerRequests, 0); assert.deepEqual(await sourceHashes(), before);
} finally {
  await session?.stop().catch(() => undefined); await adapter?.close().catch(() => undefined);
  await new Promise(resolve => provider.close(resolve)); await rm(scratch, { recursive: true, force: true });
}
const receipt = { result: "passed", source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceHashes: before, node: process.version, platform: process.platform, arch: process.arch, native: { sdk: "1.0.13", cli: "1.0.81" },
  modelCalls: 0, providerRequests, checks, retainedAuthHomes: false, retainedNativePayloads: false,
  scope: "Disposable Linux sync shell task API verification. Native model-driven agent/client tasks and corporate Windows behavior remain separate UAT." };
const output = join(root, "receipts/copilot-native-tasks", new Date().toISOString().replaceAll(":", "-"));
await mkdir(output, { recursive: true, mode: 0o700 }); const serialized = JSON.stringify(receipt, null, 2) + "\n";
await writeFile(join(output, "receipt.json"), serialized, { mode: 0o600 });
await writeFile(join(output, "SHA256SUMS"), `${digest(serialized)}  receipt.json\n`, { mode: 0o600 });
console.log(JSON.stringify({ result: "passed", output, checks, modelCalls: 0 }));
