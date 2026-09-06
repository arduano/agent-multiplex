// Native permission RPC qualification without credentials or model prompts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CopilotAdapter } from "@arduano/agent-multiplex-adapter-copilot";
import { RuntimeConnection } from "@github/copilot-sdk";

const root = resolve(import.meta.dirname, "..");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const scratch = await mkdtemp(join(tmpdir(), "multiplex-permissions-"));
const checks = [];
let providerRequests = 0;
const provider = createServer((_request, response) => { providerRequests++; response.writeHead(503).end(); });
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
let adapter;
let session;
try {
  const copilotHome = join(scratch, "copilot");
  await mkdir(copilotHome, { mode: 0o700 });
  const env = { ...process.env, COPILOT_HOME: copilotHome, COPILOT_AUTO_UPDATE: "false" };
  for (const key of Object.keys(env)) {
    if (/^(?:LEO_|AGENT_MULTIPLEX_|CODEX_|COPILOT_PROVIDER_)/i.test(key) ||
        /^(?:COPILOT_CLI_PATH|COPILOT_CONNECTION_TOKEN|COPILOT_SDK_AUTH_TOKEN|COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|NODE_AUTH_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|COPILOT_OFFLINE)$/i.test(key)) delete env[key];
  }
  adapter = new CopilotAdapter({
    clientOptions: { baseDirectory: copilotHome, env, useLoggedInUser: false, logLevel: "none", connection: RuntimeConnection.forStdio({ path: createRequire(import.meta.url).resolve(`@github/copilot-${process.platform}-${process.arch}`) }) },
    provider: { type: "openai", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, wireApi: "completions" },
    defaultModel: "disposable-no-model",
  });
  const description = await adapter.describe();
  assert.equal(description.available, true);
  assert.ok(description.capabilities.some(entry => entry.name === "permissions.mode" && entry.version === "v1"));
  session = await adapter.spawn({ harness: "copilot", cwd: scratch, mode: "interactive" });
  assert.deepEqual(session.settings().copilotPermissions, { mode: "manual" });
  checks.push("fresh native session reports approvals enabled by default");
  for (const enabled of [true, false, true]) {
    const result = await session.execute({ harness: "copilot", command: { type: "setPermissionMode", mode: enabled ? "allow-all" : "manual" } });
    assert.deepEqual(result, { success: true, mode: enabled ? "allow-all" : "manual" });
    assert.deepEqual(session.settings().copilotPermissions, { mode: enabled ? "allow-all" : "manual" });
    assert.equal(session.settings().mode, "interactive");
  }
  checks.push("native allow-all toggles tools/paths/URLs without changing interaction mode");
  // Empty native conversations cannot be resumed until Copilot persists a turn.
  // Check per-session isolation without manufacturing history or sending a prompt.
  const other = await adapter.spawn({ harness: "copilot", cwd: scratch });
  try { assert.deepEqual(other.settings().copilotPermissions, { mode: "manual" }); }
  finally { await other.stop(); }
  checks.push("enabling YOLO leaves a second session on normal approvals");
  await session.execute({ harness: "copilot", command: { type: "setPermissionMode", mode: "manual" } });
  assert.equal(session.settings().copilotPermissions.mode, "manual");
  await session.stop(); session = undefined;
  await adapter.close(); adapter = undefined;
  assert.equal(providerRequests, 0, "Permission RPCs must not call the model provider");
  checks.push("no prompts, provider requests, personal auth or existing sessions used");
} finally {
  await session?.stop().catch(() => undefined);
  await adapter?.close().catch(() => undefined);
  await new Promise(resolve => provider.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
const files = ["package.json", "package-lock.json", "packages/adapter-copilot/src/adapter.ts", "packages/adapter-copilot/src/session.ts", "packages/protocol/src/command.ts", "packages/protocol/src/session.ts", "tests/copilot-permissions-smoke.mjs"];
const sourceHashes = Object.fromEntries(await Promise.all(files.map(async file => [file, sha256(await readFile(join(root, file)))])));
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0;
const receipt = { result: "passed", source, dirty, sourceHashes, node: process.version, platform: process.platform, arch: process.arch,
  native: { sdk: "1.0.13", cli: "1.0.81" }, modelCalls: 0, providerRequests, retainedCredentials: false, checks,
  scope: "Native permission RPC only; corporate managed policy, persisted-session resume and in-flight model permission requests require separate qualification." };
const output = join(root, "receipts/copilot-permissions", new Date().toISOString().replaceAll(":", "-"));
await mkdir(output, { recursive: true });
const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
await writeFile(join(output, "receipt.json"), serialized);
await writeFile(join(output, "SHA256SUMS"), `${sha256(serialized)}  receipt.json\n`);
console.log(JSON.stringify({ result: receipt.result, output, checks, modelCalls: 0 }));
