import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

// Real DOM geometry and workspace retention only. This is a small fixture renderer:
// no React/virtualization, real transport, product UI, native executable or provider proof.
const here = dirname(fileURLToPath(import.meta.url));
const buildRoot = resolve(here, "../.build");
const html = resolve(here, "browser-harness.html");
const timeout = 5_000;

async function serveFixture() {
  const actualBuildRoot = await realpath(buildRoot);
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" || !request.url) { response.writeHead(405).end(); return; }
      const url = new URL(request.url, "http://127.0.0.1");
      let filename;
      if (url.pathname === "/") filename = html;
      else {
        if (!/^\/src\/[a-zA-Z0-9_./-]+\.js$/.test(url.pathname)) { response.writeHead(404).end(); return; }
        filename = await realpath(resolve(buildRoot, `.${url.pathname}`));
        const local = relative(actualBuildRoot, filename);
        if (local.startsWith(`..${sep}`) || !local.startsWith(`src${sep}`)) { response.writeHead(404).end(); return; }
      }
      const bytes = await readFile(filename);
      if (bytes.length > 1_048_576) { response.writeHead(413).end(); return; }
      response.writeHead(200, {
        "Content-Type": filename === html ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'",
      });
      response.end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

export async function runBrowserQualification() {
  const { server, origin } = await serveFixture();
  let browser, deadline;
  const cases = [], errors = [], external = [];
  try {
    const work = async () => {
    browser = await chromium.launch({ executablePath: "/run/current-system/sw/bin/chromium", headless: true,
      timeout: 15_000, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking"] });
    const open = async viewport => {
      const context = await browser.newContext({ viewport, serviceWorkers: "block" });
      await context.route("**/*", async route => {
        if (new URL(route.request().url()).origin !== origin) { external.push("blocked external request"); await route.abort("blockedbyclient"); }
        else await route.continue();
      });
      const page = await context.newPage(); page.setDefaultTimeout(timeout);
      page.on("pageerror", () => errors.push("browser fixture exception"));
      await page.goto(origin, { waitUntil: "load", timeout });
      await page.waitForFunction(() => window.fixtureReady && window.fixture.sessions.a.client.current, undefined, { timeout });
      await page.evaluate(() => window.fixture.ready());
      return { context, page };
    };
    const { context, page } = await open({ width: 1100, height: 900 });
    try {
      await page.evaluate(() => window.fixture.readAt("a-12", 18));
      const before = await page.evaluate(() => window.fixture.state());
      const older = await page.evaluate(() => window.fixture.prependOlder());
      await page.waitForFunction(expected => Math.abs(window.fixture.state().rowTop - expected) <= 1, before.rowTop, { timeout });
      assert.equal((await page.evaluate(() => window.fixture.state())).anchor.rowId, "a-12");
      cases.push("desktop exact DOM anchor survives prepended private page");

      const growthBefore = await page.evaluate(() => window.fixture.state());
      await page.evaluate(id => window.fixture.growEarlier(id), older);
      await page.waitForFunction(expected => Math.abs(window.fixture.state().rowTop - expected.top) <= 1 && window.fixture.state().scrollTop >= expected.scroll + 170,
        { top: growthBefore.rowTop, scroll: growthBefore.scrollTop }, { timeout });
      const grown = await page.evaluate(() => window.fixture.state());
      assert.ok(grown.scrollTop >= growthBefore.scrollTop + 170);
      cases.push("asynchronous earlier-row ResizeObserver growth preserves actual anchor geometry");

      assert.equal(await page.evaluate(() => window.fixture.holdRestore()), true);
      await page.locator("#viewport").hover();
      await page.mouse.wheel(0, -160);
      await page.waitForFunction(() => window.fixture.state().userGesture > 0, undefined, { timeout });
      await page.evaluate(() => window.fixture.ready());
      const userPosition = await page.evaluate(() => window.fixture.state().scrollTop);
      assert.equal(await page.evaluate(() => window.fixture.applyHeldRestore()), "stale");
      assert.ok(Math.abs((await page.evaluate(() => window.fixture.state().scrollTop)) - userPosition) <= 1);
      cases.push("actual wheel gesture cancels a pending stale DOM restoration");

      const reading = await page.evaluate(() => window.fixture.state());
      const readLive = await page.evaluate(() => window.fixture.publish("a"));
      await page.waitForFunction(id => window.fixture.state().ids.includes(id), readLive, { timeout });
      assert.equal((await page.evaluate(() => window.fixture.state())).intent, "readingHistory");
      assert.ok(Math.abs((await page.evaluate(() => window.fixture.state().scrollTop)) - reading.scrollTop) <= 1);
      await page.locator("#follow").click();
      const followed = await page.evaluate(() => window.fixture.publish("a"));
      await page.waitForFunction(id => window.fixture.state().ids.includes(id) && Math.abs(window.fixture.state().maximum - window.fixture.state().scrollTop) <= 1, followed, { timeout });
      cases.push("read intent resists live-tail jumps and explicit Follow latest resumes following");

      await page.evaluate(() => { window.fixture.readAt("a-12", 18); window.fixture.expand("a-12"); window.fixture.sessions.a.recordOperation("original", { action: "send", text: "fixture original" }); });
      await page.locator("#draft").fill("Draft retained across session switches");
      await page.locator("#pin").click();
      await page.evaluate(() => window.fixture.ready());
      const retained = await page.evaluate(() => window.fixture.state());
      await page.locator("#session-b").click();
      await page.waitForFunction(() => window.fixture.state().selected === "b" && window.fixture.state().ids.includes("b-0"), undefined, { timeout });
      assert.equal(await page.locator("#draft").inputValue(), "");
      assert.equal((await page.evaluate(() => window.fixture.state())).ids.some(id => id.startsWith("older-a-")), false);
      const background = await page.evaluate(() => {
        window.fixture.sessions.a.observeOperation("original", { status: "Host settled" }, true);
        return window.fixture.publish("a", "Pinned unselected background final");
      });
      await page.waitForFunction(id => window.fixture.sessionState("a").ids.includes(id), background, { timeout });
      assert.equal((await page.evaluate(() => window.fixture.sessionState("a"))).mounted, 0);
      await page.locator("#session-a").click();
      await page.waitForFunction(expected => Math.abs(window.fixture.state().rowTop - expected) <= 1, retained.rowTop, { timeout });
      const returned = await page.evaluate(() => window.fixture.state());
      assert.equal(await page.locator("#draft").inputValue(), retained.draft);
      assert.ok(returned.ids.includes(older)); assert.ok(returned.expansions.includes("a-12"));
      assert.equal((await page.evaluate(() => window.fixture.sessionState("a"))).operations[0].settled, true);
      cases.push("A/B/A retains draft, private page, expansion, anchor and original operation observation while a pin observes background frames");

      await page.locator("#session-b").click();
      const disconnected = await page.evaluate(() => { window.fixture.setConnected(false); return window.fixture.publish("a", "Captured with browser feed detached"); });
      await page.evaluate(() => window.fixture.ready());
      assert.equal((await page.evaluate(() => window.fixture.sessionState("a"))).ids.includes(disconnected), false);
      assert.equal((await page.evaluate(() => window.fixture.sessionState("a"))).references, 1);
      await page.evaluate(() => window.fixture.setConnected(true));
      await page.waitForFunction(id => window.fixture.sessionState("a").ids.includes(id), disconnected, { timeout });
      assert.equal((await page.evaluate(() => window.fixture.sessionState("a"))).pinned, true);
      cases.push("detached fixture feed preserves pinned workspace state and converges from retained Host snapshot");
    } finally { await context.close(); }

    const mobile = await open({ width: 390, height: 844 });
    try {
      const long = await mobile.page.evaluate(() => window.fixture.publish("a", "unbroken".repeat(100)));
      await mobile.page.waitForFunction(id => window.fixture.state().ids.includes(id), long, { timeout });
      const layout = await mobile.page.evaluate(() => ({ viewport: window.innerWidth,
        document: document.documentElement.scrollWidth, draft: document.querySelector("#draft").getBoundingClientRect().right,
        controls: [...document.querySelectorAll("button")].every(node => node.getBoundingClientRect().width > 40 && node.getBoundingClientRect().height >= 42) }));
      assert.ok(layout.document <= layout.viewport); assert.ok(layout.draft <= layout.viewport); assert.equal(layout.controls, true);
      cases.push("390px mobile fixture wraps long bodies and keeps controls and draft within the viewport");
      await mobile.page.evaluate(() => window.fixture.readAt("a-12", 11));
      const initial = await mobile.page.evaluate(() => window.fixture.state());
      const older = await mobile.page.evaluate(() => window.fixture.prependOlder());
      await mobile.page.waitForFunction(expected => Math.abs(window.fixture.state().rowTop - expected) <= 1, initial.rowTop, { timeout });
      const beforeGrowth = await mobile.page.evaluate(() => window.fixture.state().scrollTop);
      await mobile.page.evaluate(id => window.fixture.growEarlier(id, 120), older);
      await mobile.page.waitForFunction(expected => Math.abs(window.fixture.state().rowTop - expected.top) <= 1 && window.fixture.state().scrollTop >= expected.scroll + 100,
        { top: initial.rowTop, scroll: beforeGrowth }, { timeout });
      cases.push("mobile wrapped prepend and asynchronous growth preserve the exact DOM anchor");
    } finally { await mobile.context.close(); }
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    return { passed: true, cases, chromium: browser.version() };
    };
    return await Promise.race([work(), new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error("Browser fixture exceeded its 45 second qualification deadline")), 45_000);
    })]);
  } finally {
    clearTimeout(deadline);
    try { if (browser) await browser.close(); }
    finally {
      server.closeAllConnections();
      await new Promise(resolveClose => server.close(resolveClose));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runBrowserQualification().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
    process.stderr.write(`Browser qualification failed: ${error instanceof Error ? error.message : "unknown failure"}\n`); process.exitCode = 1;
  });
}
