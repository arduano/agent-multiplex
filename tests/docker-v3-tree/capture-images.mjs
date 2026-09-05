#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { AxeBuilder } from "@axe-core/playwright";
import { createAccessClient, imageTarget, readImage, uploadImage, sessionCommand } from "@arduano/agent-multiplex-client";
import { png, svg, hostileSvg } from "../image-fixtures.mjs";

const [url, receipt] = process.argv.slice(2);
const token = (await readFile(process.env.AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE, "utf8")).trim();
const handle = createAccessClient({ httpUrl: new URL("trpc", url).toString(), bearerToken: token });
const client = handle.client;
let browser;
const findings = { passed: false, viewports: [], externalRequests: [], errors: [], checks: [] };
function assert(value, message) { if (!value) throw new Error(message); }
async function poll(callback, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await callback(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error("Image acceptance condition timed out");
}
try {
  const session = (await client.sessions.search.query({ states: ["running"], limit: 10 })).sessions.find((value) => value.availability === "active");
  assert(session, "No active tree session");
  const runtime = (await client.runtimeNodes.list.query()).find((value) => value.runtimeNodeId === session.runtimeNodeId);
  const target = imageTarget(session, runtime);
  const retained = await uploadImage(client, target, png, "image/png");
  assert(Buffer.from(await readImage(client, target, retained)).equals(png), "Image transfer checksum mismatch");
  const resolved = await client.images.resolvePath.mutate({ ...target, sourceKey: "image-acceptance:path", path: "images/shapes.svg" });
  assert(Buffer.from(await readImage(client, target, resolved)).toString() === svg, "Relative SVG snapshot mismatch");
  await client.images.resolvePath.mutate({ ...target, sourceKey: "image-acceptance:escape", path: "/etc/passwd" }).then(() => { throw new Error("Workspace escape was accepted"); }, () => {});
  findings.checks.push("routed-upload-download", "relative-path-snapshot", "workspace-escape-denied");
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "multiplex-cli-images-"));
  try {
    const file = join(fixtureDirectory, "pixel.png");
    await writeFile(file, png);
    const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../apps/cli/dist/main.js", import.meta.url)), "--json", "send", session.sessionId, "--image", file], {
      env: { ...process.env, AGENT_MULTIPLEX_AUTH_TOKEN: token, AGENT_MULTIPLEX_HTTP_URL: new URL("trpc", url).toString() }, timeout: 30_000,
    });
    assert(JSON.parse(result.stdout).state === "succeeded", "CLI image-only send failed");
    await poll(async () => (await client.sessions.get.query(session.sessionId))?.runtimeStatus === "idle");
    findings.checks.push("cli-image-only-send");
  } finally { await rm(fixtureDirectory, { recursive: true, force: true }); }
  const prompt = "Image acceptance\n![Generated shapes](images/shapes.svg)\n![Inert SVG](images/inert.svg)\n![External image](https://image-fixture.invalid/remote.png)";
  const command = sessionCommand(session, { harness: "codex", command: { type: "send", input: prompt } });
  assert((await client.sessions.execute.mutate(command)).state === "succeeded", "Markdown fixture send failed");
  await poll(async () => (await client.sessions.get.query(session.sessionId))?.runtimeStatus === "idle");
  browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_MULTIPLEX_CHROME_EXECUTABLE ?? "/home/arduano/.nix-profile/bin/google-chrome" });
  const context = await browser.newContext({ viewport: { width: 1720, height: 1180 }, extraHTTPHeaders: { Authorization: `Bearer ${token}` }, reducedMotion: "reduce" });
  await context.route("https://image-fixture.invalid/**", async (route) => { findings.externalRequests.push(route.request().url()); await route.abort(); });
  const page = await context.newPage();
  page.on("pageerror", (error) => findings.errors.push(error.message));
  await page.goto(url);
  await page.getByTestId("auth-token").fill(token);
  await page.getByTestId("connect-button").click();
  await page.locator(`[data-testid="session-card"][data-session-id="${session.sessionId}"]`).click();
  await page.getByTestId("history-status").filter({ hasText: "loaded" }).waitFor();
  const preview = page.getByRole("button", { name: "Open Generated shapes", exact: true }).first();
  await preview.scrollIntoViewIfNeeded();
  await preview.waitFor();
  const originalTrigger = await preview.elementHandle();
  await preview.click();
  const viewer = page.getByRole("dialog");
  await viewer.waitFor();
  assert(await viewer.locator("img").evaluate((image) => image.complete && image.naturalWidth > 0), "Image viewer failed to decode SVG");
  const refreshPrompt = "Image viewer remains open during transcript refresh";
  const refreshCommand = sessionCommand(session, { harness: "codex", command: { type: "send", input: refreshPrompt } });
  assert((await client.sessions.execute.mutate(refreshCommand)).state === "succeeded", "Viewer refresh fixture failed");
  await poll(async () => (await page.getByTestId("native-events").textContent()).includes(refreshPrompt));
  await poll(async () => (await client.sessions.get.query(session.sessionId))?.runtimeStatus === "idle");
  assert(await originalTrigger.evaluate((element) => element.isConnected), "Transcript refresh replaced the image trigger");
  assert(await viewer.isVisible(), "Transcript refresh closed the image viewer");
  findings.checks.push("image-viewer-survives-native-stream");
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "hidden" });
  try {
    await poll(() => originalTrigger.evaluate((element) => element === document.activeElement));
  } catch {
    const focus = await originalTrigger.evaluate((element) => ({
      originalConnected: element.isConnected,
      originalLabel: element.getAttribute("aria-label"),
      focusedTag: document.activeElement?.tagName,
      focusedLabel: document.activeElement?.getAttribute("aria-label"),
      originalHidden: Boolean(element.closest('[inert], [aria-hidden="true"]')),
    }));
    await page.screenshot({ path: join(receipt, "screenshots", "image-focus-failure.png") });
    throw new Error(`Image viewer focus restoration failed: ${JSON.stringify(focus)}`);
  }
  assert(await page.getByRole("link", { name: "External image", exact: true }).count() > 0, "External image is not a link");
  assert(await page.locator('img[src^="http"]').count() === 0, "Remote image source reached the DOM");
  findings.checks.push("markdown-preview", "svg-inert-viewer", "dialog-focus-restored", "external-image-link");
  await page.getByTestId("image-file-input").setInputFiles([{ name: "shapes.svg", mimeType: "image/svg+xml", buffer: Buffer.from(svg) }, { name: "inert.svg", mimeType: "image/svg+xml", buffer: Buffer.from(hostileSvg) }]);
  await page.locator('img[alt="shapes.png"]').waitFor();
  await page.locator('img[alt="inert.png"]').waitFor();
  assert(await page.locator('img[alt="shapes.png"]').evaluate((image) => image.complete && image.naturalWidth === 480), "SVG draft was not converted to PNG");
  findings.checks.push("svg-draft-converted-to-png");
  for (const [width, height] of [[1720, 1180], [1440, 900], [1024, 768], [768, 1024], [390, 844], [844, 390]]) {
    await page.setViewportSize({ width, height });
    await page.getByTestId("prompt-input").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(receipt, "screenshots", `images-${width}x${height}.png`) });
    const layout = await page.evaluate(() => {
      const composer = document.querySelector('[data-testid="prompt-input"]').getBoundingClientRect();
      const transcript = document.querySelector('[data-testid="chat-transcript"]').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth + 1, composerVisible: composer.top >= 0 && composer.bottom <= innerHeight + 1, transcriptHeight: transcript.height };
    });
    assert(!layout.overflow && layout.composerVisible, `Image composer layout failed at ${width}x${height}`);
    if (height < 500) assert(layout.transcriptHeight >= 120, "Landscape transcript is below 120px");
    const accessibility = await new AxeBuilder({ page }).analyze();
    const violations = accessibility.violations.filter((item) => ["serious", "critical"].includes(item.impact));
    assert(violations.length === 0, `Image view accessibility: ${violations.map((item) => item.id).join(", ")}`);
    findings.viewports.push({ width, height, ...layout, seriousOrCriticalViolations: violations.length });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("send-button").click();
  await page.getByTestId("action-status").filter({ hasText: "Message sent" }).waitFor({ timeout: 30_000 });
  assert(await page.locator('img[alt="shapes.png"]').count() === 0, "Acknowledged image draft was not cleared");
  findings.checks.push("image-only-upload-and-send");
  await poll(async () => (await client.sessions.get.query(session.sessionId))?.runtimeStatus === "idle");
  await page.reload();
  await page.getByTestId("history-status").filter({ hasText: "loaded" }).waitFor();
  const sentMessage = page.locator('[data-testid="chat-message"][data-role="user"]').last();
  await sentMessage.scrollIntoViewIfNeeded();
  const sentImages = sentMessage.locator('[data-testid="transcript-image"] img');
  await poll(async () => await sentImages.count() === 2);
  await poll(() => sentImages.evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0)));
  findings.checks.push("native-image-history-after-reload");
  assert(findings.externalRequests.length === 0, "SVG or Markdown fetched an external resource");
  assert(await page.evaluate(() => window.imageFixtureExecuted === undefined), "SVG script executed");
  assert(findings.errors.length === 0, `Browser errors: ${findings.errors.join(", ")}`);
  findings.passed = true;
  console.log(JSON.stringify(findings, null, 2));
} finally { await browser?.close(); handle.close(); }
