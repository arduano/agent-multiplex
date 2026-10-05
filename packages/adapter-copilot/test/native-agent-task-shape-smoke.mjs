// Pinned native task shapes without a real model: the provider is a loopback
// 503 fixture. Run after build with node --import tsx <this file>.
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
import { taskSnapshot } from "../src/tasks.ts";

const root = resolve(import.meta.dirname, "../../..");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const sourcePaths = ["package.json", "package-lock.json", "packages/adapter-copilot/src/adapter.ts",
  "packages/adapter-copilot/src/session.ts", "packages/adapter-copilot/src/tasks.ts",
  "packages/adapter-copilot/src/reads.ts", "packages/adapter-copilot/test/native-agent-task-shape-smoke.mjs"];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, sha(await readFile(join(root, path)))])));
const before = await sourceHashes();
const require = createRequire(import.meta.url);
const sdkVersion = JSON.parse(await readFile(join(root, "node_modules/@github/copilot-sdk/package.json"), "utf8")).version;
const cliVersion = JSON.parse(await readFile(join(require.resolve(`@github/copilot-${process.platform}-${process.arch}`), "../package.json"), "utf8")).version;
assert.equal(sdkVersion, "1.0.14"); assert.equal(cliVersion, "1.0.88");
// NixOS may use an immutable, interpreter-patched copy of the same pinned CLI.
const cliPath = process.env.AGENT_MULTIPLEX_TEST_COPILOT_CLI ?? require.resolve(`@github/copilot-${process.platform}-${process.arch}`);
assert.equal(JSON.parse(await readFile(join(cliPath, "../package.json"), "utf8")).version, cliVersion);
const cliSha256 = sha(await readFile(cliPath));
const scratch = await mkdtemp(join(tmpdir(), "multiplex-native-agent-shape-"));
const sockets = new Set(), timers = new Set();
let providerRequests = 0, native, adapter, session;
const provider = createServer((_request, response) => {
  providerRequests++;
  const timer = setTimeout(() => { timers.delete(timer); response.writeHead(503).end(); }, 10_000);
  timers.add(timer);
});
provider.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
const checks = [];
try {
  const home = join(scratch, "copilot"); await mkdir(home, { mode: 0o700 });
  const env = { ...process.env, COPILOT_HOME: home, COPILOT_AUTO_UPDATE: "false" };
  for (const key of Object.keys(env)) if (/^(?:LEO_|AGENT_MULTIPLEX_|CODEX_|COPILOT_PROVIDER_)/i.test(key) ||
    /^(?:COPILOT_CLI_PATH|COPILOT_CONNECTION_TOKEN|COPILOT_SDK_AUTH_TOKEN|COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|NODE_AUTH_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|COPILOT_OFFLINE)$/i.test(key)) delete env[key];
  adapter = new CopilotAgentAdapter({
    clientOptions: { baseDirectory: home, env, useLoggedInUser: false, logLevel: "none", connection: RuntimeConnection.forStdio({ path: cliPath }) },
    provider: { type: "openai", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, wireApi: "completions" },
    defaultModel: "disposable-no-model",
    clientFactory: options => {
      const client = new CopilotClient(options), create = client.createSession.bind(client);
      client.createSession = async config => { native = await create(config); return native; };
      return client;
    },
  });
  assert.equal((await adapter.describe()).available, true);
  session = await adapter.spawn({ harness: "copilot", cwd: scratch });
  await session.execute({ harness: "copilot", command: { type: "setPermissionMode", mode: "allow-all" } });
  await native.rpc.tools.initializeAndValidate();
  assert((await native.rpc.tools.getCurrentMetadata()).tools.some(tool => tool.name === "task"));
  const calls = ["one", "two"].map(name => {
    const call = native.rpc.tools.execute({ name: "task", toolCallId: `synthetic-${name}-call`, arguments: {
      agent_type: "general-purpose", name: `synthetic-${name}`, description: "Synthetic task shape qualification",
      prompt: "Synthetic loopback-only task. No actual model is present.", model: "disposable-no-model", mode: "background",
    } });
    call.catch(() => {}); return call;
  });
  let snapshot;
  for (let attempt = 0; attempt < 50; attempt++) {
    const value = await native.rpc.tasks.list();
    if (value.tasks?.filter(task => task.type === "agent" && task.status === "running").length === 2) { snapshot = value; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(snapshot, "Two active synthetic native agent tasks were not observed");
  assert.deepEqual(taskSnapshot("tasks", snapshot), snapshot);
  for (const task of snapshot.tasks) {
    assert.equal(task.type, "agent"); assert.equal(task.executionMode, "background");
    assert.equal(task.resolvedModel, "disposable-no-model"); assert.equal(task.canPromoteToBackground, false);
    // Direct native tool execution is fixture-only. The production adapter
    // exposes bounded task reads/control, never arbitrary tools.execute.
    assert.equal((await native.rpc.tasks.cancel({ id: task.id })).cancelled, true);
  }
  await Promise.all(calls);
  checks.push("Two simultaneous pinned native agent task snapshots pass unchanged strict wire/schema admission");
  checks.push("Exact native task cancellation is acknowledged without a root prompt or external model");
  assert.deepEqual(await sourceHashes(), before);
} finally {
  await session?.stop().catch(() => undefined); await adapter?.close().catch(() => undefined);
  for (const timer of timers) clearTimeout(timer);
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => provider.close(resolve)); await rm(scratch, { recursive: true, force: true });
}
const receipt = { result: "passed", source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceHashes: before, node: process.version, platform: process.platform, arch: process.arch,
  native: { sdk: sdkVersion, cli: cliVersion, cliSha256 }, modelCalls: 0, syntheticProviderRequests: providerRequests, checks,
  scope: "Disposable loopback-only native agent task shapes. Neither reproduction of the lost owner snapshot nor live Luna acceptance." };
const output = join(root, "receipts/copilot-native-agent-shape", new Date().toISOString().replaceAll(":", "-"));
await mkdir(output, { recursive: true, mode: 0o700 });
const serialized = JSON.stringify(receipt, null, 2) + "\n";
await writeFile(join(output, "receipt.json"), serialized, { mode: 0o600 });
await writeFile(join(output, "SHA256SUMS"), `${sha(serialized)}  receipt.json\n`, { mode: 0o600 });
console.log(JSON.stringify({ result: "passed", output, checks, modelCalls: 0, syntheticProviderRequests: providerRequests }));
