/**
 * Pinned native Copilot image-event regression without external model calls.
 * Run: node --import tsx scripts/qualify-copilot-offline-images.mjs
 * Requires the existing workspace build for package dependencies. The adapter
 * and codec are imported from current source. Only scrubbed evidence is saved.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CopilotAgentAdapter } from "../packages/adapter-copilot/src/adapter.ts";
import { copilotImageCodec } from "../packages/adapter-copilot/src/images.ts";
import { nativeImagePointerValue, nativePayloadSchema } from "@arduano/agent-multiplex-protocol";

const repository = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const imageBytes = Buffer.from(png, "base64");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const model = "offline-image-fixture";
const startedAt = new Date().toISOString();
const receipt = join(repository, "receipts", "copilot-offline-images", startedAt.replaceAll(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8));
let stage = "source-boundary";
let result;
let failure;
const sourceBefore = await sourceBoundary();
try {
  stage = "native-round-trip";
  result = await qualify();
  stage = "source-stability";
  assert.deepEqual(await sourceBoundary(), sourceBefore, "qualified source/dependency files changed during the run");
} catch {
  // Native error text can include endpoint URLs, prompts, and configuration.
  // Persist only the stage; raw failures are deliberately not a release receipt.
  failure = { stage, message: "Offline image qualification failed" };
}
await mkdir(receipt, { recursive: true, mode: 0o700 });
const sourceText = JSON.stringify(sourceBefore, null, 2) + "\n";
await writeFile(join(receipt, "source-inventory.json"), sourceText, { mode: 0o600 });
const manifest = {
  schemaVersion: 1,
  status: failure ? "failed" : "passed",
  scope: "native Copilot SDK/CLI with loopback completion fixture and current adapter image codec",
  startedAt,
  completedAt: new Date().toISOString(),
  head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
  sourceInventorySha256: hash(sourceText),
  node: process.version,
  sdkVersion: JSON.parse(await readFile(join(repository, "node_modules/@github/copilot-sdk/package.json"), "utf8")).version,
  cliPackageVersion: JSON.parse(await readFile(join(repository, "node_modules/@github/copilot/package.json"), "utf8")).version,
  externalModelCalls: 0,
  syntheticProviderCredentialsOnly: true,
  retainedNativePayloads: false,
  retainedAuthHomes: false,
  retainedEndpoints: false,
  ...(result ? { checks: result } : {}),
  ...(failure ? { failure } : {}),
};
const manifestText = JSON.stringify(manifest, null, 2) + "\n";
await writeFile(join(receipt, "manifest.json"), manifestText, { mode: 0o600 });
await writeFile(join(receipt, "SHA256SUMS"), `${hash(manifestText)}  manifest.json\n${hash(sourceText)}  source-inventory.json\n`, { mode: 0o600 });
console.log(JSON.stringify({ status: manifest.status, receipt: relative(repository, receipt), ...(failure ? { failureStage: failure.stage } : { checks: result }) }));
if (failure) process.exitCode = 1;

async function qualify() {
  const directory = await mkdtemp(join(tmpdir(), "multiplex-copilot-offline-images-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const rawEvents = [];
  let completionRequests = 0;
  let requestHadOriginalImage = false;
  let providerFailure = false;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        assert.ok(Buffer.byteLength(body) <= 2 * 1_024 * 1_024, "unexpected provider request size");
      }
      const input = JSON.parse(body);
      assert.equal(input.model, model);
      completionRequests += 1;
      assert.equal(completionRequests, 1, "native runtime unexpectedly requested another completion");
      requestHadOriginalImage = body.includes(png);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const choice of [
        { index: 0, delta: { role: "assistant", content: "Offline image fixture completed." }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: "stop" },
      ]) response.write("data: " + JSON.stringify({ id: "offline-response", object: "chat.completion.chunk", created: 1, model, choices: [choice] }) + "\n\n");
      response.end("data: [DONE]\n\n");
    } catch {
      providerFailure = true;
      response.writeHead(400);
      response.end("Invalid offline fixture request");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const nativeEnvironment = {
    PATH: process.env.PATH,
    TMPDIR: directory,
    COPILOT_DISABLE_KEYTAR: "1",
    COPILOT_TELEMETRY_DISABLED: "1",
    COPILOT_OTEL_ENABLED: "false",
  };
  const adapter = new CopilotAgentAdapter({
    defaultModel: model,
    providerModels: [model],
    provider: { type: "openai", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "offline-fixture-not-a-credential", wireApi: "completions" },
    providerModelCapabilities: { [model]: { supports: { vision: true, reasoningEffort: false }, limits: { max_context_window_tokens: 10_000 } } },
    clientOptions: { baseDirectory: join(directory, "native-state"), workingDirectory: workspace, logLevel: "none", useLoggedInUser: false, env: nativeEnvironment },
  });
  try {
    stage = "native-description";
    const description = await adapter.describe();
    assert.equal(description.available, true, "pinned native runtime unavailable");
    stage = "native-version";
    assert.equal(JSON.parse(await readFile(join(repository, "node_modules/@github/copilot/package.json"), "utf8")).version, "1.0.81");
    assert.equal(JSON.parse(await readFile(join(repository, "node_modules/@github/copilot-sdk/package.json"), "utf8")).version, "1.0.13");
    stage = "native-spawn";
    const session = await adapter.spawn({ harness: "copilot", cwd: workspace, model });
    session.subscribe((event) => { if (event.kind === "native") rawEvents.push(event); });
    stage = "native-send";
    await session.execute({ harness: "copilot", command: { type: "send", mode: "enqueue", prompt: { prompt: "Complete the offline fixture.", attachments: [{ type: "blob", data: png, mimeType: "image/png" }] } } });
    const deadline = Date.now() + 20_000;
    while (!rawEvents.some((event) => event.nativeType === "session.idle") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    stage = "native-idle";
    assert.ok(rawEvents.some((event) => event.nativeType === "session.idle"), "native turn did not reach idle");
    stage = "completion-provider";
    assert.equal(providerFailure, false);
    assert.equal(completionRequests, 1);
    assert.equal(requestHadOriginalImage, true, "native provider did not receive the fixture image");

    const retained = new Map();
    const descriptor = { imageId: randomUUID(), sessionId: randomUUID(), runtimeNodeId: randomUUID(), bindingRevision: 1, sha256: hash(imageBytes), byteLength: imageBytes.length, mediaType: "image/png" };
    const sink = {
      storeBase64: async ({ dataBase64, mediaType }) => {
        const bytes = Buffer.from(dataBase64, "base64");
        assert.equal(mediaType, "image/png");
        assert.deepEqual(bytes, imageBytes);
        retained.set(descriptor.imageId, bytes);
        return descriptor;
      },
      snapshotPath: async () => { throw new Error("Unexpected path image in inline fixture"); },
    };
    stage = "externalize-events";
    const eventSummary = [];
    for (const event of rawEvents) {
      const encodedBefore = JSON.stringify(event.payload);
      const envelope = nativePayloadSchema.parse(await copilotImageCodec.externalize(event.payload, sink));
      assert.equal(JSON.stringify(envelope).includes(png), false, "native image bytes escaped codec externalization");
      for (const slot of envelope.images) {
        assert.equal("unavailable" in slot.image, false, "codec marked fixture image unavailable");
        assert.equal(nativeImagePointerValue(envelope.json, slot.pointer), null);
        assert.equal(slot.image.sha256, hash(imageBytes));
      }
      eventSummary.push({ type: event.nativeType, originalImagePresent: encodedBefore.includes(png), imagePointers: envelope.images.map(({ pointer }) => pointer) });
    }
    stage = "snapshot-regression";
    const snapshots = eventSummary.filter((event) => event.type === "model.messages_snapshot" && event.originalImagePresent);
    assert.ok(snapshots.length > 0, "native runtime did not reproduce the original snapshot leak");
    assert.ok(snapshots.every((event) => event.imagePointers.some((pointer) => /^\/data\/messages\/[0-9]+\/content\/[0-9]+\/image_url\/url$/.test(pointer))));
    assert.ok(eventSummary.some((event) => event.type === "user.message" && event.originalImagePresent));
    stage = "native-history";
    const history = await session.readNativeHistory({ harness: "copilot", limit: 100 });
    const historyEnvelope = await copilotImageCodec.externalize(history.payload, sink);
    assert.equal(JSON.stringify(historyEnvelope).includes(png), false);
    assert.ok(historyEnvelope.images.length > 0);
    stage = "native-resume";
    await session.stop();
    const resumed = await adapter.resume({ harness: "copilot", vendorSessionId: session.vendorSessionId, cwd: workspace, model, continuePendingWork: false });
    stage = "resumed-history";
    const resumedHistory = await resumed.readNativeHistory({ harness: "copilot", limit: 100 });
    const resumedEnvelope = await copilotImageCodec.externalize(resumedHistory.payload, sink);
    assert.equal(JSON.stringify(resumedEnvelope).includes(png), false);
    assert.ok(resumedEnvelope.images.length > 0);
    assert.equal(completionRequests, 1, "history/resume unexpectedly dispatched a completion");
    assert.deepEqual(retained.get(descriptor.imageId), imageBytes);
    return { reportedRuntimeVersion: description.runtimeVersion, completionRequests, providerReceivedOriginalImage: true, nativeEventCount: rawEvents.length, originalSnapshotLeakReproduced: true, snapshotEventsExternalized: snapshots.length, rawImageBytesInWireEnvelopes: 0, historyImages: historyEnvelope.images.length, resumedHistoryImages: resumedEnvelope.images.length, storedImageSha256: hash(imageBytes), eventSummary };
  } finally {
    try { await adapter.close(); }
    finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function sourceBoundary() {
  const paths = new Set(["package-lock.json", "package.json", "scripts/qualify-copilot-offline-images.mjs"]);
  for (const name of ["protocol", "runtime-node-core", "storage-sqlite", "adapter-copilot"]) {
    paths.add(`packages/${name}/package.json`);
    await walk(join(repository, "packages", name, "src"), paths);
    await walk(join(repository, "packages", name, "dist"), paths);
  }
  for (const name of ["copilot-sdk", "copilot"]) {
    await walk(join(repository, "node_modules/@github", name), paths);
  }
  paths.add(relative(repository, require.resolve(`@github/copilot-${process.platform}-${process.arch}`)));
  const inventory = {};
  for (const path of [...paths].sort()) inventory[path] = hash(await readFile(join(repository, path)));
  return inventory;
}

async function walk(directory, paths) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, paths);
    else if (entry.isFile()) paths.add(relative(repository, path));
  }
}
