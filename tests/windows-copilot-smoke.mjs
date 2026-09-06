import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { IrohEndpoint } from "@arduano/p2prpc-core/advanced";
import { assertPrivateFileSync, ensurePrivateDirectorySync } from "@arduano/agent-multiplex-storage-sqlite";
import { newRuntimeNodeId, newRuntimeNodeBootId, newSessionId } from "@arduano/agent-multiplex-protocol";
import { AllowedPathPolicy, RuntimeImages, RuntimeNodeStore, readConfinedImage } from "@arduano/agent-multiplex-runtime-node-core";
import { CopilotAdapter } from "@arduano/agent-multiplex-adapter-copilot";

assert.equal(process.platform, "win32", "this qualification requires native Windows");
assert.equal(process.arch, "x64", "the pinned Iroh artifact supports Windows x64");
assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), "", "qualification requires an exact clean source tree");
const require = createRequire(import.meta.url);
const root = mkdtempSync(join(tmpdir(), "multiplex-windows-smoke-"));
const checks = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC2cAAAAASUVORK5CYII=", "base64");
let store, images, adapter, endpoint;
try {
  const state = join(root, "private [literal] ' $name ; state");
  ensurePrivateDirectorySync(state);
  ensurePrivateDirectorySync(state);
  const unsafe = join(root, "inherited");
  mkdirSync(unsafe);
  assert.throws(() => ensurePrivateDirectorySync(unsafe), /Windows private state/);
  const file = join(state, "private.json");
  writeFileSync(file, "fixture");
  assertPrivateFileSync(file);
  const junction = join(root, "junction");
  symlinkSync(state, junction, "junction");
  assert.throws(() => ensurePrivateDirectorySync(junction), /Windows private state/);
  const aclChange = spawnSync(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", String.raw`
      $ErrorActionPreference = 'Stop'
      try {
        $acl = [System.IO.File]::GetAccessControl($env:AGENT_MULTIPLEX_SMOKE_FILE)
        $sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'Read', 'Allow')))
        [System.IO.File]::SetAccessControl($env:AGENT_MULTIPLEX_SMOKE_FILE, $acl)
      } catch { exit 1 }
    `], { env: { ...process.env, AGENT_MULTIPLEX_SMOKE_FILE: file }, encoding: "utf8", windowsHide: true });
  assert.equal(aclChange.status, 0, "ACL fixture setup failed");
  assert.throws(() => assertPrivateFileSync(file), /Windows private state/);
  rmSync(file);
  checks.push("protected Windows directory creation, literal paths, inherited ACL refusal, file ACL refusal, junction refusal");

  const database = join(state, "runtime.sqlite");
  store = new RuntimeNodeStore(database);
  const childCode = String.raw`
    import { RuntimeNodeStore } from '@arduano/agent-multiplex-runtime-node-core';
    try { const store = new RuntimeNodeStore(process.env.AGENT_MULTIPLEX_SMOKE_DATABASE); store.close(); process.exit(2); }
    catch (error) { process.exit(error.code === 'WRITER_LOCKED' ? 0 : 3); }
  `;
  const locked = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    env: { ...process.env, AGENT_MULTIPLEX_SMOKE_DATABASE: database }, windowsHide: true, timeout: 120_000,
  });
  assert.equal(locked.status, 0, "SQLite writer ownership must reject another process");
  assert.equal(store.diagnostics().integrity.quickCheck[0], "ok");
  const target = { runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId(), sessionId: newSessionId(), bindingRevision: 1 };
  const input = { ...target, imageId: randomUUID(), byteLength: png.length, sha256: createHash("sha256").update(png).digest("hex"), mediaType: "image/png" };
  images = new RuntimeImages(store, target.runtimeNodeId);
  await images.ready();
  await images.begin(input);
  await images.write({ ...input, offset: 0, dataBase64: png.toString("base64") });
  const descriptor = await images.commit(input);
  assertPrivateFileSync(join(`${database}.images`, `${input.imageId}.blob`));
  await images.close(); images = undefined;
  store.close(); store = undefined;
  store = new RuntimeNodeStore(database);
  images = new RuntimeImages(store, target.runtimeNodeId);
  assert.deepEqual(await images.commit(input), descriptor);
  assert.equal((await images.read({ ...input, offset: 0, length: png.length })).dataBase64, png.toString("base64"));
  await assert.rejects(readConfinedImage(join(state, "output.png"), [state]), { code: "UNSUPPORTED" });
  await images.releaseSession(target.sessionId);
  await images.close(); images = undefined;
  store.close(); store = undefined;
  checks.push("SQLite separate-process writer exclusion, integrity, reopen, image upload/checksum/restart/archive, output paths fail closed");

  const policy = new AllowedPathPolicy([state]);
  assert.equal(await policy.validate(state), await import("node:fs/promises").then(({ realpath }) => realpath(state)));
  await assert.rejects(policy.validate(root));
  require("node-pty");
  endpoint = await IrohEndpoint.create(new TextEncoder().encode("multiplex-windows-smoke"), {
    bindAddress: "127.0.0.1:0", relay: { mode: "disabled" }, discovery: { dns: false, mdns: false },
  });
  await endpoint.close(); endpoint = undefined;
  checks.push("Windows workspace paths, node-pty native import, loopback Iroh native startup/shutdown");

  const copilotHome = join(state, "copilot");
  ensurePrivateDirectorySync(copilotHome);
  const env = { ...process.env, COPILOT_HOME: copilotHome, COPILOT_AUTO_UPDATE: "false" };
  for (const key of Object.keys(env)) {
    if (/^(?:LEO_|AGENT_MULTIPLEX_|CODEX_|COPILOT_PROVIDER_)/i.test(key) ||
        /^(?:COPILOT_CLI_PATH|COPILOT_CONNECTION_TOKEN|COPILOT_SDK_AUTH_TOKEN|COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|NODE_AUTH_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|COPILOT_OFFLINE)$/i.test(key)) delete env[key];
  }
  const binary = require.resolve("@github/copilot-win32-x64");
  const client = new CopilotClient({
    mode: "copilot-cli", useLoggedInUser: false, baseDirectory: copilotHome, env, logLevel: "none",
    connection: RuntimeConnection.forStdio({ path: binary }),
  });
  adapter = new CopilotAdapter({ clientFactory: () => client });
  const status = await adapter.describe();
  assert.equal(status.available, true, "Copilot SDK/native startup must succeed");
  assert.equal(status.runtimeVersion, "1.0.81");
  assert.equal((await client.getAuthStatus()).isAuthenticated, false, "smoke must not inherit an authenticated account");
  await adapter.close(); adapter = undefined;
  checks.push("Copilot SDK 1.0.11 / CLI 1.0.81 structured startup, unauthenticated status, graceful shutdown; no sessions or prompts");
} finally {
  await adapter?.close().catch(() => undefined);
  await endpoint?.close().catch(() => undefined);
  await images?.close().catch(() => undefined);
  store?.close();
  rmSync(root, { recursive: true, force: true });
}

const receipt = {
  result: "passed", source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  lockfileSha256: createHash("sha256").update(readFileSync("package-lock.json")).digest("hex"),
  node: process.version, platform: process.platform, arch: process.arch, checks,
  scope: "native Windows x64 startup and private persistence only; corporate authentication, network policy, and model turns require laptop UAT",
  modelCalls: 0, retainedCredentials: false,
};
const receiptDirectory = resolve("receipts", "windows-copilot", new Date().toISOString().replaceAll(":", "-"));
mkdirSync(receiptDirectory, { recursive: true });
const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
writeFileSync(join(receiptDirectory, "receipt.json"), serialized);
writeFileSync(join(receiptDirectory, "SHA256SUMS"), `${createHash("sha256").update(serialized).digest("hex")}  receipt.json\n`);
console.log(JSON.stringify(receipt, null, 2));
