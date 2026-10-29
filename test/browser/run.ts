import { command, flag, option, optional, run, string, type Type } from "cmd-ts";
import type { Browser, BrowserContext, BrowserServer, Locator, Page } from "playwright-core";
import type { SessionScope } from "../../src/protocol/index.js";
import type { startReference } from "../../src/reference/node.js";
import type {} from "./globals.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pathType: Type<string, string> = {
  ...string,
  async from(value) {
    if (value.trim().length === 0) throw Error("An explicit nonempty path is required");
    return value;
  },
};
function optionalPath(long: string) {
  const parser = option({ long, type: optional(pathType) });
  return {
    ...parser,
    async parse(context: Parameters<typeof parser.parse>[0]): ReturnType<typeof parser.parse> {
      // cmd-ts treats a present valueless optional option as absent. Only actual
      // absence may choose a default/tooling fallback in these qualifiers.
      const missing = context.nodes.find(
        (node) =>
          node.type === "longOption" &&
          node.key === long &&
          !node.value &&
          !context.visitedNodes.has(node),
      );
      if (missing) {
        context.visitedNodes.add(missing);
        return {
          _tag: "error",
          error: {
            errors: [{ nodes: [missing], message: "An explicit nonempty path is required" }],
          },
        };
      }
      return parser.parse(context);
    },
  };
}

const cli = command({
  name: "browser-acceptance",
  description: "Bounded scripted public reference browser qualification.",
  args: {
    fixturePath: option({ long: "fixture", type: pathType }),
    tooling: optionalPath("tooling"),
    browserOption: optionalPath("browser"),
    outputOption: optionalPath("out"),
    prior: optionalPath("prior"),
    recoveryOnly: flag({ long: "recovery-only" }),
    remainingOnly: flag({ long: "remaining-only" }),
  },
  handler: async ({
    fixturePath,
    tooling,
    browserOption,
    outputOption,
    prior,
    recoveryOnly,
    remainingOnly,
  }) => {
    const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
    const require = createRequire(
      tooling ? join(resolve(tooling), "package.json") : join(root, "package.json"),
    );
    const { chromium } = require("playwright-core") as typeof import("playwright-core");
    const { build } = require("esbuild-wasm") as typeof import("esbuild-wasm");
    assert.equal(require("playwright-core/package.json").version, "1.56.1");
    assert.equal(require("esbuild-wasm/package.json").version, "0.25.11");
    assert.equal(require("mermaid/package.json").version, "12.0.0");
    const browserPath =
      browserOption ?? process.env.MULTIPLEX_BROWSER ?? "/run/current-system/sw/bin/chromium";
    const modulePath = fixturePath;
    const output = outputOption
      ? resolve(outputOption)
      : await mkdtemp(join(root, ".build/browser-acceptance-"));
    await mkdir(output, { recursive: true, mode: 0o700 });
    const assets = join(output, "assets");
    await mkdir(assets, { mode: 0o700 });
    const limits = {
      workMs: 120000,
      cleanupMs: 30000,
      contexts: 1,
      pages: 2,
      browserRequests: 500,
      modelCalls: 0,
      nativeAgents: 0,
    };
    await writeFile(
      join(output, "admission.json"),
      JSON.stringify(
        {
          started: new Date().toISOString(),
          limits,
          fixture: resolve(modulePath),
          browser: browserPath,
          bundler: { name: "esbuild-wasm", version: "0.25.11" },
          scriptedOnly: true,
          remainingOnly,
          recoveryOnly,
          priorEvidence: prior ?? null,
        },
        null,
        2,
      ),
    );
    const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
    const inputPaths = new Set([
      fileURLToPath(import.meta.url),
      join(root, "src/chat/styles.css"),
      join(root, "src/reference/ui/styles.css"),
    ]);
    async function seal() {
      const files: Record<string, string> = {};
      for (const path of [...inputPaths].sort())
        files[relative(root, path)] = hash(await readFile(path));
      return files;
    }
    async function nodeGraph(path: string) {
      path = resolve(path);
      if (inputPaths.has(path)) return;
      inputPaths.add(path);
      const text = await readFile(path, "utf8");
      for (const match of text.matchAll(
        /\b(?:from\s*|import\s*\(\s*|import\s*)["'](\.[^"']+)["']/g,
      )) {
        const next = resolve(path, "..", match[1]!);
        if (next.endsWith(".js")) await nodeGraph(next);
      }
    }
    let source: Record<string, string> = {};
    const cases: { name: string; status: "passed" }[] = [],
      errors: string[] = [],
      blocked: { method: string; protocol: string; host: string }[] = [],
      scrollSamples: Awaited<ReturnType<typeof geometry>>[] = [];
    let requests = 0,
      outageRequests = 0,
      networkUnavailable = false;
    let fixture!: Awaited<ReturnType<typeof startReference>>,
      server!: BrowserServer,
      browser!: Browser,
      context!: BrowserContext,
      primary!: Page;
    let secondary: Page | undefined;
    const cleanup = {
      pages: false,
      context: false,
      browser: false,
      browserProcess: false,
      reference: false,
      assets: false,
    };
    let browserIdentity: { pid: number | undefined } | undefined;
    let failure: string | undefined;
    async function until<T>(read: () => T | Promise<T>, label: string, ms = 10000) {
      const end = Date.now() + ms;
      let last;
      do {
        last = await read();
        if (last) return last;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < end);
      throw Error(`Timed out: ${label}`);
    }
    let caseNumber = 0;
    async function check(name: string, run: () => Promise<void>) {
      caseNumber++;
      if (
        (recoveryOnly && caseNumber !== 14) ||
        (remainingOnly && caseNumber <= 8 && caseNumber !== 5)
      )
        return;
      await run();
      cases.push({ name, status: "passed" });
      await writeFile(join(output, "progress.json"), JSON.stringify({ cases, requests }));
    }
    const viewport = (page: Page) => page.locator(".mpx-reference-main .mpx-transcript");
    async function geometry(page: Page) {
      return viewport(page).evaluate((element) => {
        const rect = element.getBoundingClientRect(),
          top = rect.top + element.clientTop;
        const row = [...element.querySelectorAll("[data-history-row]")].find(
          (row) => row.getBoundingClientRect().bottom > top,
        );
        return {
          top: element.scrollTop,
          max: element.scrollHeight - element.clientHeight,
          height: element.scrollHeight,
          client: element.clientHeight,
          row: row?.getAttribute("data-history-row"),
          offset: row ? row.getBoundingClientRect().top - top : null,
        };
      });
    }
    async function stable(page: Page) {
      await viewport(page).evaluate(async (element) => {
        let previous = element.scrollTop,
          height = element.scrollHeight,
          count = 0;
        for (let frames = 0; frames < 180; frames++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          count =
            Math.abs(previous - element.scrollTop) < 0.25 && height === element.scrollHeight
              ? count + 1
              : 0;
          previous = element.scrollTop;
          height = element.scrollHeight;
          if (count >= 6) return;
        }
        throw Error("Scroll did not settle");
      });
    }
    async function tail(page: Page) {
      await viewport(page).focus();
      await page.keyboard.press("Control+End");
      await until(async () => {
        const value = await geometry(page);
        if (
          scrollSamples.length < 128 &&
          JSON.stringify(scrollSamples.at(-1)) !== JSON.stringify(value)
        )
          scrollSamples.push(value);
        return Math.abs(value.max - value.top) < 1;
      }, "positive tail");
      await stable(page);
    }
    async function middle(page: Page) {
      await tail(page);
      const bounds = await viewport(page).boundingBox();
      assert.ok(bounds, "Transcript has physical bounds");
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.wheel(0, -550);
      await until(async () => {
        const value = await geometry(page);
        return value.max - value.top > 100 && value.top > 100;
      }, "positive upward gesture");
      await stable(page);
      return geometry(page);
    }
    async function choose(page: Page, locator: Locator, value: string) {
      const touch = page.viewportSize()!.width < 680;
      if (touch) await locator.tap();
      else await locator.click();
      const target = page.locator(`[role="option"][data-value=${JSON.stringify(value)}]`);
      if (touch) await target.tap();
      else await target.click();
      await until(
        async () => (await page.locator("[role=listbox]").count()) === 0,
        "select closed",
      );
    }
    async function switchTo(page: Page, id: string, label: string) {
      if (await page.locator(".mpx-reference-mobile-nav").isVisible())
        await choose(page, page.locator(".mpx-reference-mobile-nav [role=combobox]"), id);
      else
        await page
          .getByRole("navigation", { name: "Conversations" })
          .getByRole("button", { name: new RegExp(`^${label}`) })
          .click();
      await until(
        async () =>
          (await page.locator(".mpx-reference-main .mpx-chat-header h2").textContent()) === label,
        "selected conversation",
      );
      await stable(page);
    }
    async function screenshot(page: Page, name: string) {
      await page.screenshot({ path: join(output, `${name}.png`), fullPage: false });
    }

    function selection(scope: SessionScope, key: string): unknown {
      const value = fixture.sessions.state(scope).selection;
      assert.ok(
        value !== null && typeof value === "object" && !Array.isArray(value),
        "Native selection is a record",
      );
      return (value as Readonly<Record<string, unknown>>)[key];
    }
    async function work() {
      const bundled = await build({
        absWorkingDir: root,
        entryPoints: ["test/browser/entry.ts"],
        bundle: true,
        platform: "browser",
        format: "esm",
        jsx: "automatic",
        target: "es2023",
        outfile: join(assets, "app.js"),
        metafile: true,
        alias: {
          mermaid: resolve(require.resolve("mermaid/package.json"), "../dist/mermaid.esm.min.mjs"),
        },
        define: { "process.env.NODE_ENV": '"production"' },
        logLevel: "silent",
      });
      const nodeImports = Object.values(bundled.metafile.outputs)
        .flatMap((output) => output.imports)
        .filter((value) => value.path.startsWith("node:"));
      assert.deepEqual(nodeImports, []);
      await writeFile(join(output, "bundle.json"), JSON.stringify(bundled.metafile));
      for (const input of Object.keys(bundled.metafile.inputs))
        inputPaths.add(resolve(root, input));
      await nodeGraph(resolve(modulePath));
      source = await seal();
      await writeFile(
        join(assets, "index.html"),
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;width:100%;margin:0;overflow:hidden}</style></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>',
      );
      // CSS is a declared consumer asset, never an implicit runtime import.
      await writeFile(
        join(assets, "app.css"),
        `${await readFile(join(root, "src/chat/styles.css"), "utf8")}\n${await readFile(join(root, "src/reference/ui/styles.css"), "utf8")}`,
      );
      const { startReference } = (await import(
        pathToFileURL(resolve(modulePath)).href
      )) as typeof import("../../src/reference/node.js");
      fixture = await startReference({
        directory: join(output, "framework"),
        assetDirectory: assets,
      });
      const first = fixture.bootstrap.scopes[0]!.scope;
      server = await chromium.launchServer({
        executablePath: browserPath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking"],
      });
      browserIdentity = { pid: server.process().pid };
      await writeFile(join(output, "browser-process.json"), JSON.stringify(browserIdentity));
      browser = await chromium.connect(server.wsEndpoint());
      context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        hasTouch: true,
      });
      await context.routeWebSocket("**/*", (route) => {
        const url = new URL(route.url());
        const expected = new URL(fixture.url);
        expected.protocol = expected.protocol === "https:" ? "wss:" : "ws:";
        requests++;
        if (
          requests > limits.browserRequests ||
          url.origin !== expected.origin ||
          url.pathname !== "/host"
        ) {
          blocked.push({ method: "UPGRADE", protocol: url.protocol, host: url.hostname });
          route.close({ code: 1008, reason: "Outside owned fixture" });
        } else if (networkUnavailable) {
          outageRequests++;
          route.close({ code: 1013, reason: "Owned network interruption" });
        } else route.connectToServer();
      });
      await context.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        requests++;
        const internalPdf =
          (url.protocol === "chrome-extension:" &&
            url.hostname === "mhjfbmdgcfjbbpaeojofohoefgiehjai") ||
          (url.protocol === "chrome:" && url.hostname === "resources");
        if (requests > limits.browserRequests || (url.origin !== fixture.url && !internalPdf)) {
          blocked.push({ method: request.method(), protocol: url.protocol, host: url.hostname });
          await route.abort();
          return;
        }
        if (networkUnavailable && url.origin === fixture.url) {
          outageRequests++;
          await route.abort("internetdisconnected");
          return;
        }
        await route.continue();
      });
      context.on("page", (page) =>
        page.on("pageerror", (error) => errors.push(String(error).slice(0, 500))),
      );
      primary = await context.newPage();
      await primary.goto(`${fixture.url}/?viewer=primary`);
      await primary.waitForFunction(() => window.__reference?.ready);
      if (remainingOnly || recoveryOnly) {
        await primary.getByText("Connected", { exact: true }).waitFor();
        await primary.locator("[data-history-row]").first().waitFor();
        await tail(primary);
        await primary
          .getByRole("textbox", { name: "Message", exact: true })
          .fill("Retained local draft");
        await primary.getByRole("button", { name: "Pin", exact: true }).click();
      }
      await check(
        "actual HTTP/tRPC retained conversation, initial history and genuine scoped assets",
        async () => {
          await primary.getByText("Connected", { exact: true }).waitFor();
          await primary.locator("[data-history-row]").first().waitFor();
          await tail(primary);
          const image = primary.locator("img.mpx-thumbnail").first();
          await image.waitFor();
          await until(
            () =>
              image.evaluate(
                (image) =>
                  image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
              ),
            "actual captured image decoded",
          );
          await screenshot(primary, "desktop-initial");
        },
      );
      await check(
        "same-position PageDown cannot leave a manual latch blocking exact height-change restoration",
        async () => {
          await tail(primary);
          await primary.keyboard.press("PageDown");
          await stable(primary);
          const before = await geometry(primary);
          // A consumer/font/layout change is real DOM geometry, without pretending
          // an immutable completed native body can be rewritten by this fixture.
          await primary
            .locator("[data-history-row]")
            .first()
            .evaluate((element) => {
              if (!(element instanceof HTMLElement)) throw Error("EXPECTED_ELEMENT");
              element.style.paddingBlockEnd = "180px";
            });
          await until(
            async () => (await geometry(primary)).height > before.height + 100,
            "positive upstream height change",
          );
          await stable(primary);
          const after = await geometry(primary);
          assert.ok(after.offset !== null && before.offset !== null, "Physical anchor exists");
          assert.equal(after.row, before.row);
          assert.ok(Math.abs(after.offset - before.offset) <= 1);
          assert.ok(after.top > before.top + 100);
        },
      );
      await check("actual image viewer focal zoom and nested scoped focus return", async () => {
        const trigger = primary.getByRole("button", { name: "Open Reference.png", exact: true });
        await trigger.click();
        const dialog = primary.getByRole("dialog", { name: "Reference.png", exact: true });
        await dialog.waitFor();
        const image = dialog.locator(".mpx-image-viewer img");
        await until(
          () =>
            image.evaluate(
              (element) =>
                element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
            ),
          "viewer image decoded",
        );
        const point = () =>
          dialog.locator(".mpx-image-viewer").evaluate((element) => {
            const img = element.querySelector("img");
            if (!img) throw Error("MISSING_IMAGE");
            return {
              x: (element.scrollLeft + element.clientWidth / 2) / img.getBoundingClientRect().width,
              y:
                (element.scrollTop + element.clientHeight / 2) / img.getBoundingClientRect().height,
            };
          });
        const before = await point();
        await dialog.getByRole("button", { name: "Zoom in", exact: true }).click();
        await until(
          async () => (await dialog.getByLabel("Image zoom").textContent()) === "150%",
          "zoom committed",
        );
        await dialog.evaluate(async () => {
          await new Promise<void>((done) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => done());
            });
          });
        });
        const after = await point();
        assert.ok(Math.abs(before.x - after.x) <= 0.01 && Math.abs(before.y - after.y) <= 0.01);
        await screenshot(primary, "image-viewer");
        await primary.keyboard.press("Escape");
        await until(
          () => trigger.evaluate((element) => document.activeElement === element),
          "closed image viewer returns focus to its trigger",
        );
      });
      await check(
        "actual scoped HTML is opaque/inert and text preview preserves supplied source",
        async () => {
          await primary.getByRole("button", { name: "Open Reference.html", exact: true }).click();
          const dialog = primary.getByRole("dialog", { name: "Reference.html", exact: true });
          await dialog.waitFor();
          assert.equal(await dialog.locator("iframe").getAttribute("sandbox"), "");
          await dialog
            .frameLocator("iframe")
            .getByText("Sandboxed reference preview", { exact: true })
            .waitFor();
          assert.equal(await primary.evaluate(() => window.__multiplex_pwned), undefined);
          await screenshot(primary, "html-preview");
          await primary.keyboard.press("Escape");
          await primary.getByRole("button", { name: "Open Reference.txt", exact: true }).click();
          await primary.getByText("Reference text file preview.", { exact: true }).waitFor();
          await primary.keyboard.press("Escape");
        },
      );
      await check("real PDF lease bytes reach a browser PDF frame and download", async () => {
        await primary.getByRole("button", { name: "Open Reference.pdf", exact: true }).click();
        const dialog = primary.getByRole("dialog", { name: "Reference.pdf", exact: true });
        await dialog.locator("iframe").waitFor();
        assert.match((await dialog.locator("iframe").getAttribute("src")) ?? "", /^blob:/);
        assert.match(
          (await dialog
            .getByRole("link", { name: "Download PDF", exact: true })
            .getAttribute("href")) ?? "",
          /^blob:/,
        );
        await screenshot(primary, "pdf-preview");
        await primary.keyboard.press("Escape");
      });
      await check(
        "actual pinned Mermaid strict rendering produces a releasable image and expanded viewer",
        async () => {
          await primary.getByRole("button", { name: "Show diagram", exact: true }).click();
          const diagram = primary.getByRole("button", { name: "Diagram", exact: true });
          await diagram.waitFor();
          const img = diagram.locator("img");
          await until(
            () =>
              img.evaluate(
                (element) =>
                  element instanceof HTMLImageElement &&
                  element.complete &&
                  element.naturalWidth > 0,
              ),
            "actual Mermaid SVG image",
          );
          const svg = await img.evaluate(async (element) => {
            if (!(element instanceof HTMLImageElement)) throw Error("EXPECTED_IMAGE");
            return (await fetch(element.src)).text();
          });
          assert.match(svg, /Host/);
          assert.match(svg, /Gateway/);
          await diagram.click();
          await primary.getByRole("dialog", { name: "Diagram", exact: true }).waitFor();
          await screenshot(primary, "diagram-preview");
          await primary.keyboard.press("Escape");
        },
      );
      await check(
        "binary uploaded file roundtrips through one durable Send while earlier reading follows the final tail",
        async () => {
          await middle(primary);
          const uploadText = "Uploaded through the actual browser and Iroh bridge.\n".repeat(3200);
          await primary.locator('input[type="file"]').setInputFiles({
            name: "Bridge upload.txt",
            mimeType: "text/plain",
            buffer: Buffer.from(uploadText),
          });
          await primary
            .getByRole("button", { name: "Remove Bridge upload.txt", exact: true })
            .waitFor();
          await primary
            .getByRole("textbox", { name: "Message", exact: true })
            .fill(
              Array.from({ length: 12 }, (_, i) => `Line ${i + 1} retained composer`).join("\n"),
            );
          await primary.getByRole("button", { name: "Send", exact: true }).click();
          await until(() => fixture.scripted.counts().sends === 1, "one scripted Send");
          await until(
            async () =>
              ((await primary.locator("[data-history-row]").last().textContent()) ?? "").includes(
                "Scripted response",
              ),
            "assistant completion",
          );
          await until(async () => {
            const value = await geometry(primary);
            return Math.abs(value.max - value.top) < 1;
          }, "actual final tail");
          await stable(primary);
          assert.equal(
            await primary.getByRole("textbox", { name: "Message", exact: true }).inputValue(),
            "",
          );
          await screenshot(primary, "send-tail");
          await primary
            .getByRole("button", { name: "Open Bridge upload.txt", exact: true })
            .click();
          const uploaded = primary.getByRole("dialog", { name: "Bridge upload.txt", exact: true });
          const download = uploaded.getByRole("link", {
            name: "Download Bridge upload.txt",
            exact: true,
          });
          await until(
            async () => ((await download.getAttribute("href")) ?? "").startsWith("blob:"),
            "uploaded file has a scoped binary download",
          );
          const returned = await download.evaluate(async (element) => {
            if (!(element instanceof HTMLAnchorElement)) throw Error("Expected download link");
            return (await fetch(element.href)).text();
          });
          assert.equal(
            returned,
            uploadText,
            "Exact uploaded bytes return through the binary bridge",
          );
          await primary.keyboard.press("Escape");
        },
      );
      await check(
        "new agent output never steals manual history reading; A/B/A retains measured anchor and draft",
        async () => {
          await middle(primary);
          await primary
            .getByRole("textbox", { name: "Message", exact: true })
            .fill("Retained local draft");
          await primary.getByRole("button", { name: "Pin", exact: true }).click();
          await stable(primary);
          const anchor = await geometry(primary);
          fixture.scripted.append(first, "New scripted assistant output while reading earlier.");
          await stable(primary);
          const after = await geometry(primary);
          assert.ok(after.offset !== null && anchor.offset !== null, "Physical anchor exists");
          assert.equal(after.row, anchor.row);
          assert.ok(Math.abs(after.offset - anchor.offset) <= 1);
          await switchTo(primary, "second", "Second conversation");
          await switchTo(primary, "first", "Reference conversation");
          const returned = await geometry(primary);
          assert.ok(returned.offset !== null, "Restored physical anchor exists");
          assert.equal(returned.row, anchor.row);
          assert.ok(Math.abs(returned.offset - anchor.offset) <= 1);
          assert.equal(
            await primary.getByRole("textbox", { name: "Message", exact: true }).inputValue(),
            "Retained local draft",
          );
          await screenshot(primary, "reading-retained");
        },
      );
      await check(
        "explicit older page preserves physical row anchor and exposes the retained earlier range",
        async () => {
          await viewport(primary).focus();
          await primary.keyboard.press("Control+Home");
          await until(async () => (await geometry(primary)).top < 1, "actual top");
          await stable(primary);
          const before = await geometry(primary);
          await primary.getByRole("button", { name: "Load earlier history", exact: true }).click();
          await primary
            .getByText("Beginning of available history", { exact: true })
            .waitFor({ state: "attached" });
          await stable(primary);
          const found = await viewport(primary).evaluate((element, id) => {
            const row = [...element.querySelectorAll("[data-history-row]")].find(
              (row) => row.getAttribute("data-history-row") === id,
            );
            return row
              ? row.getBoundingClientRect().top -
                  element.getBoundingClientRect().top -
                  element.clientTop
              : null;
          }, before.row);
          assert.ok(found !== null && before.offset !== null, "Prepended physical anchor exists");
          assert.ok(Math.abs(found - before.offset) <= 1);
          assert.ok(await primary.locator('[data-history-row="seed:0"]').count());
        },
      );
      await check(
        "typed model/mode/reasoning slots use themed Select, empty-native fallback never dispatches",
        async () => {
          const model = primary.locator(
            ".mpx-reference-inline [data-control=model] [role=combobox]",
          );
          await choose(primary, model, "scripted-large");
          await until(() => selection(first, "model") === "scripted-large", "actual applied model");
          await until(
            async () => (await model.getAttribute("data-value")) === "scripted-large",
            "observed model reaches the rendered control",
          );
          const reason = primary.locator(
            ".mpx-reference-inline [data-control=effort] [role=combobox]",
          );
          await reason.click();
          await primary.keyboard.press("Escape");
          assert.equal(await primary.locator("[role=listbox]").count(), 0);
          assert.ok(await reason.evaluate((element) => document.activeElement === element));
        },
      );
      await check(
        "actual native callback question plus per-question extra info returns through retained original exactly once",
        async () => {
          fixture.scripted.question(first);
          await primary
            .getByText("Which approach should this scripted agent use?", { exact: true })
            .waitFor();
          await primary.getByRole("radio", { name: /Simple/ }).check();
          await primary
            .getByRole("textbox", { name: "Extra information (optional)", exact: true })
            .fill("Specific additional evidence");
          await primary.getByRole("button", { name: "Send answers", exact: true }).click();
          await until(
            () => fixture.scripted.counts().answers === 1,
            "one actual capability answer",
          );
          await until(
            async () =>
              (await primary.getByRole("button", { name: "Send answers", exact: true }).count()) ===
              0,
            "positive native confirmation",
          );
        },
      );
      await check(
        "mobile scoped settings Select and popup bounds, focus return and containment",
        async () => {
          await primary.setViewportSize({ width: 390, height: 844 });
          await primary.getByRole("button", { name: "Settings", exact: true }).click();
          const dialog = primary.getByRole("dialog", { name: "Agent settings" });
          await dialog.waitFor();
          const bounds = await dialog.boundingBox();
          assert.ok(bounds, "Dialog has physical bounds");
          assert.ok(
            bounds.x >= 0 &&
              bounds.x + bounds.width <= 390 &&
              bounds.y >= 0 &&
              bounds.y + bounds.height <= 844,
          );
          const mode = dialog.locator("[data-control=mode] [role=combobox]");
          await choose(primary, mode, "plan");
          await until(() => selection(first, "mode") === "plan", "actual plan mode");
          await primary.keyboard.press("Escape");
          await until(async () => (await dialog.count()) === 0, "settings closed");
          assert.ok(
            await primary
              .getByRole("button", { name: "Settings", exact: true })
              .evaluate((element) => document.activeElement === element),
          );
          assert.equal(
            await primary.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
          );
          await screenshot(primary, "mobile");
        },
      );
      await check(
        "explicit completed plan action is one consumer Send rather than a prose heuristic",
        async () => {
          const sendsBefore = fixture.scripted.counts().sends;
          const slot = fixture.scripted.slots.get(
            JSON.stringify([first.connection, first.principal, first.host, first.session]),
          );
          assert.ok(slot, "Exact scripted session exists");
          slot.window.update({
            rows: [
              {
                id: "browser-plan",
                kind: "assistant",
                lifecycle: "completed",
                body: {
                  kind: "complete",
                  text: "Implement this scripted native plan.",
                  evidence: "native",
                },
                native: { type: "plan" },
              },
            ],
          });
          await primary.getByRole("button", { name: "Implement plan", exact: true }).click();
          await until(
            () => fixture.scripted.counts().sends === sendsBefore + 1,
            "one explicit plan Send",
          );
          await until(() => fixture.sessions.state(first).activity === "idle", "plan Send settled");
        },
      );
      await check(
        "second viewer close and browser offline/reconnect preserve first viewer, draft, pin and effect counts",
        async () => {
          secondary = await context.newPage();
          await secondary.goto(`${fixture.url}/?viewer=secondary&theme=dark`);
          await secondary.waitForFunction(() => window.__reference?.ready);
          await secondary.getByText("Connected", { exact: true }).waitFor();
          await secondary.evaluate(() => window.__reference.close());
          await secondary.close();
          secondary = undefined;
          fixture.scripted.append(first, "First viewer remains active after second viewer closes.");
          await primary
            .getByText("First viewer remains active after second viewer closes.", { exact: true })
            .waitFor();
          const before = fixture.scripted.counts();
          networkUnavailable = true;
          await context.setOffline(true);
          fixture.disconnectViewers();
          assert.equal(
            await primary.evaluate(() =>
              fetch("/bootstrap").then(
                () => false,
                () => true,
              ),
            ),
            true,
          );
          await primary.getByText("Connecting…", { exact: true }).waitFor({ timeout: 12000 });
          assert.equal(
            await primary.getByRole("textbox", { name: "Message", exact: true }).inputValue(),
            "Retained local draft",
          );
          fixture.scripted.append(first, "Scripted event captured while this browser is offline.");
          await context.setOffline(false);
          networkUnavailable = false;
          await primary.getByText("Connected", { exact: true }).waitFor({ timeout: 12000 });
          await primary
            .getByText("Scripted event captured while this browser is offline.", { exact: true })
            .waitFor();
          assert.deepEqual(fixture.scripted.counts(), before);
          assert.ok(outageRequests > 0);
          const snapshots = await primary.evaluate(() => window.__reference.snapshots());
          assert.equal(snapshots[0]!.snapshot.pinned, true);
          await screenshot(primary, "reconnected-mobile");
        },
      );
    }
    const timer = new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(Error("BROWSER_WORK_DEADLINE")), limits.workMs);
      timeout.unref();
    });
    try {
      await Promise.race([work(), timer]);
    } catch (error) {
      failure = String(error instanceof Error ? (error.stack ?? error.message) : error);
      if (primary && !primary.isClosed()) {
        try {
          await screenshot(primary, "failure");
          const physical = await geometry(primary);
          const clamp = await viewport(primary).evaluate(async (element) => {
            element.scrollTop = element.scrollHeight;
            const immediate = element.scrollTop;
            await new Promise<void>((done) => {
              requestAnimationFrame(() => {
                requestAnimationFrame(() => done());
              });
            });
            return {
              immediate,
              after: element.scrollTop,
              max: element.scrollHeight - element.clientHeight,
            };
          });
          await writeFile(
            join(output, "failure-state.json"),
            JSON.stringify(
              {
                physical,
                clamp,
                scrollSamples,
                ...(await primary.evaluate(() => ({
                  body: document.body.innerText,
                  snapshots: window.__reference?.snapshots?.(),
                }))),
              },
              null,
              2,
            ),
          );
        } catch {}
      }
    } finally {
      const bounded = async (action: () => Promise<unknown>) => {
        await Promise.race([
          action(),
          new Promise((_, reject) => {
            const timer = setTimeout(() => reject(Error("CLEANUP_DEADLINE")), 5000);
            timer.unref();
          }),
        ]);
      };
      try {
        if (context) {
          assert.equal(context.serviceWorkers().length, 0);
          await context.setOffline(false);
          for (const page of context.pages()) {
            try {
              await page.evaluate(() => window.__reference?.close());
            } catch {}
          }
        }
        await bounded(async () => {
          if (context) for (const page of context.pages()) await page.close();
        });
        cleanup.pages = true;
      } catch {}
      try {
        await bounded(async () => context?.close());
        cleanup.context = true;
      } catch {}
      try {
        await bounded(async () => browser?.close());
        cleanup.browser = true;
      } catch {}
      try {
        await bounded(async () => {
          if (!server) return;
          const child = server.process();
          await server.close();
          if (child.exitCode === null && child.signalCode === null)
            await new Promise<void>((resolve) => child.once("exit", () => resolve()));
        });
        cleanup.browserProcess = true;
      } catch {}
      try {
        if (fixture) {
          cleanup.assets = fixture.assets.readiness().ready;
          await bounded(() => fixture.close());
        }
        cleanup.reference = true;
      } catch (error) {
        failure ??= String(error);
      }
    }
    const after = await seal(),
      sourceUnchanged = JSON.stringify(source) === JSON.stringify(after);
    if (!sourceUnchanged) failure ??= "Source changed during qualification";
    if (blocked.length || errors.length) failure ??= "Browser errors or blocked requests";
    if (!Object.values(cleanup).every(Boolean)) failure ??= "Owned cleanup not proved";
    const result = {
      status: failure ? "failed" : "passed",
      cases,
      remainingOnly,
      recoveryOnly,
      priorEvidence: prior ?? null,
      limits,
      requests,
      outageRequests,
      blocked,
      errors,
      cleanup,
      browserIdentity,
      sourceUnchanged,
      source,
      scrollSamples,
      scripted: fixture?.scripted.counts(),
      failure,
    };
    await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
    console.log(
      JSON.stringify({ status: result.status, cases: cases.length, cleanup, output, failure }),
    );
    if (failure) process.exitCode = 1;
  },
});
await run(cli, process.argv.slice(2));
