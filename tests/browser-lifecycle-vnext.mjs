import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { AxeBuilder } from "@axe-core/playwright";
import { createServer } from "vite";

// Isolated rendered reference-console acceptance. No gateway, SDK, auth home,
// provider, native process, or model request is involved.
const receiptDir = resolve(process.argv[2] ?? `receipts/lifecycle-browser-${Date.now()}`);
await mkdir(receiptDir, { recursive: true });
const server = await createServer({
  configFile: resolve("apps/web/vite.config.ts"),
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "lifecycle-fixture",
    configureServer(vite) {
      vite.middlewares.use("/__lifecycle_fixture", async (_request, response) => {
        const html = await vite.transformIndexHtml("/__lifecycle_fixture", `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Lifecycle console fixture</title></head><body><div id="root"></div><script type="module" src="/@fs/${resolve("tests/fixtures/lifecycle-console.tsx")}"></script></body></html>`);
        response.setHeader("content-type", "text/html");
        response.end(html);
      });
    },
  }],
});
await server.listen();
const address = server.httpServer.address();
const browser = await chromium.launch({
  executablePath: process.env.AGENT_MULTIPLEX_CHROME_EXECUTABLE ?? "/home/arduano/.nix-profile/bin/google-chrome",
  headless: true,
});
const artifacts = [];
const checks = [];
const startedAt = new Date().toISOString();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let dispatches = 0;
  let receiptReads = 0;
  let saved;
  await page.route("**/trpc/*", async (route) => {
    const procedure = new URL(route.request().url()).pathname.slice("/trpc/".length);
    let data;
    if (procedure === "harness.models" || procedure === "interactions.list") data = [];
    else if (procedure === "sessions.readNativeHistory") data = {
      harness: "copilot", vendorSessionId: "fixture-native-session", complete: true,
      payload: { encoding: "native-json-images-v1", images: [], json: [
        { id: "old-message", type: "user.message", timestamp: "2026-09-22T00:00:00.000Z", data: { content: "repeat fixture text" } },
      ] },
    };
    else if (procedure === "sessions.execute") {
      dispatches += 1;
      saved = route.request().postDataJSON();
      data = {
        commandId: saved.commandId, payloadHash: saved.payloadHash,
        sessionId: saved.sessionId, runtimeNodeId: saved.runtimeNodeId,
        request: saved, state: dispatches === 1 ? "outcomeUnknown" : "succeeded",
        createdAt: "2026-09-22T00:00:01.000Z", updatedAt: "2026-09-22T00:00:01.000Z",
      };
    } else if (procedure === "commands.get") {
      receiptReads += 1;
      assert.equal(route.request().method(), "GET");
      data = receiptReads === 1 ? null : {
        commandId: saved.commandId, payloadHash: saved.payloadHash,
        sessionId: saved.sessionId, runtimeNodeId: saved.runtimeNodeId,
        request: saved, state: "succeeded",
        createdAt: "2026-09-22T00:00:01.000Z", updatedAt: "2026-09-22T00:00:02.000Z",
      };
    } else if (procedure === "sessions.watch") {
      await route.fulfill({ status: 405, contentType: "application/json", body: JSON.stringify({ error: { message: "Fixture has no live stream", code: -32005, data: { code: "METHOD_NOT_SUPPORTED", httpStatus: 405 } } }) });
      return;
    } else throw new Error(`Unexpected fixture procedure: ${procedure}`);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { data } }) });
  });
  await page.goto(`http://127.0.0.1:${address.port}/__lifecycle_fixture`);
  await page.getByTestId("history-status").filter({ hasText: "loaded" }).waitFor().catch(async (error) => { console.error(await page.locator("body").innerText(), pageErrors); throw error; });
  await page.getByTestId("prompt-input").fill("repeat fixture text");
  await page.getByTestId("send-button").click();
  await page.getByTestId("action-status").filter({ hasText: "Outcome unknown" }).waitFor();
  assert.equal(await page.locator('[data-role="user"]').count(), 1, "Only native history renders as a user message");
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "repeat fixture text");
  await page.getByTestId("reconcile-command").click();
  await page.getByTestId("action-status").filter({ hasText: "No receipt is available" }).waitFor();
  assert.equal(dispatches, 1);
  assert.equal(receiptReads, 1);
  checks.push("Unknown result retains exact draft; missing original receipt does not redispatch or settle");

  for (const [width, height] of [[1720, 1180], [1440, 900], [1024, 768], [768, 1024], [390, 844], [844, 390]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      transcriptHeight: document.querySelector('[data-testid="chat-transcript"]')?.getBoundingClientRect().height,
      composerBottom: document.querySelector('[data-testid="prompt-input"]')?.getBoundingClientRect().bottom,
    }));
    assert.equal(layout.overflow, false, `${width}x${height} horizontal overflow`);
    assert.ok(layout.composerBottom <= height + 1, `${width}x${height} composer remains visible: ${JSON.stringify(layout)}`);
    assert.ok(layout.transcriptHeight >= 120, `${width}x${height} transcript remains readable`);
    const result = await new AxeBuilder({ page }).analyze();
    const serious = result.violations.filter(({ impact }) => impact === "serious" || impact === "critical");
    assert.deepEqual(serious.map(({ id }) => id), [], `${width}x${height} accessibility`);
    const file = `console-${width}x${height}.png`;
    await page.screenshot({ path: resolve(receiptDir, file) });
    artifacts.push(file);
    checks.push({ viewport: `${width}x${height}`, ...layout, seriousAccessibilityViolations: 0 });
  }
  await page.getByTestId("reconcile-command").click();
  await page.getByTestId("action-status").filter({ hasText: "Command receipt recovered" }).waitFor();
  assert.equal(dispatches, 1);
  assert.equal(receiptReads, 2);
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "");
  assert.equal(await page.locator('[data-role="user"]').count(), 1);
  checks.push("Matching terminal receipt settles only the exact draft and adds no fabricated native echo");

  await page.getByTestId("prompt-input").fill("repeat fixture text");
  await page.getByTestId("send-button").click();
  await page.getByTestId("action-status").filter({ hasText: "Message accepted" }).waitFor();
  assert.equal(dispatches, 2);
  assert.equal(await page.locator('[data-role="user"]').count(), 1);
  checks.push("Send acknowledgment says accepted and does not display or consume an inferred native message");
  assert.deepEqual(pageErrors, []);
  await writeFile(resolve(receiptDir, "summary.json"), JSON.stringify({
    success: true, startedAt, finishedAt: new Date().toISOString(),
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceDiffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD"])).digest("hex"),
    workingTreeStatus: execFileSync("git", ["status", "--short"], { encoding: "utf8" }).trim().split("\n").filter(Boolean),
    packageLockSha256: createHash("sha256").update(await readFile("package-lock.json")).digest("hex"),
    scope: "Reference console deterministic fixtures; no native SDK, no model, no transport qualification",
    checks, dispatches, receiptReads, pageErrors,
  }, null, 2) + "\n");
  artifacts.push("summary.json");
  const sums = await Promise.all(artifacts.map(async (file) => `${createHash("sha256").update(await readFile(resolve(receiptDir, file))).digest("hex")}  ${file}`));
  await writeFile(resolve(receiptDir, "SHA256SUMS"), sums.join("\n") + "\n");
  process.stdout.write(`${receiptDir}\n`);
} finally {
  await browser.close();
  await server.close();
}
