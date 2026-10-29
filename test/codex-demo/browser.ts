import { command, option, run, string } from "cmd-ts";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild-wasm";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { configureProcessSignalHandling } from "@momics/iroh-http-node";
import { openCodexBrowserFixture } from "./browser-fixture.js";
import type {} from "./browser-entry.js";

await run(
  command({
    name: "codex-demo-browser",
    description: "One bounded model-free Chromium/WS/local-Iroh Codex composition case.",
    args: {
      out: option({ long: "out", type: string }),
      browser: option({ long: "browser", type: string }),
    },
    async handler({ out, browser }) {
      const output = resolve(out),
        assets = join(output, "assets");
      await mkdir(assets, { recursive: true, mode: 0o700 });
      const started = Date.now();
      const limits = {
        totalMs: 90000,
        irohEndpoints: 2,
        listeners: 1,
        browsers: 1,
        contexts: 1,
        pages: 2,
        scriptedSessions: 2,
        sends: 4,
        nativeAgents: 0,
        modelPOSTs: 0,
      };
      const admission = {
        started: new Date(started).toISOString(),
        limits,
        transport: "loopback WS + real direct local Iroh; relay disabled",
        sourceOnlyNative: true,
      };
      await writeFile(join(output, "admission.json"), JSON.stringify(admission, null, 2));
      let fixture: Awaited<ReturnType<typeof openCodexBrowserFixture>> | undefined;
      let ownedBrowser: Browser | undefined, context: BrowserContext | undefined;
      const pages: Page[] = [],
        browserErrors: string[] = [],
        closedViews: unknown[] = [];
      let stage = "bundle",
        failure: unknown,
        cleanup: unknown;
      const guardian = setTimeout(() => {
        process.stderr.write(
          JSON.stringify({
            status: "FAILED",
            stage,
            cleanup: "UNCONFIRMED",
            elapsedMs: Date.now() - started,
          }) + "\n",
        );
        process.exit(1);
      }, limits.totalMs);
      try {
        await build({
          entryPoints: [fileURLToPath(new URL("./browser-entry.ts", import.meta.url))],
          outfile: join(assets, "app.js"),
          bundle: true,
          format: "esm",
          platform: "browser",
          target: "chrome120",
          logLevel: "silent",
        });
        await writeFile(
          join(assets, "index.html"),
          '<!doctype html><html><body><main id="app"></main><script type="module" src="/app.js"></script></body></html>',
        );
        configureProcessSignalHandling("application");
        stage = "fixture";
        fixture = await openCodexBrowserFixture(assets);
        stage = "chromium";
        ownedBrowser = await chromium.launch({
          executablePath: browser,
          headless: true,
          timeout: 10000,
          args: ["--no-sandbox"],
        });
        context = await ownedBrowser.newContext();
        for (let index = 0; index < 2; index++) {
          const page: Page = await context.newPage();
          pages.push(page);
          page.on("pageerror", (error: Error) => browserErrors.push(error.message));
          page.setDefaultTimeout(12000);
          await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
          await page.waitForFunction(
            () => document.body.dataset.ready || document.body.dataset.error,
          );
          assert.equal(await page.evaluate(() => document.body.dataset.error), undefined);
        }
        const first = pages[0]!,
          second = pages[1]!;
        stage = "custom-routes";
        assert.deepEqual(await first.evaluate(() => window.codexDemo.summary()), {
          label: "Browser Gateway inventory",
          availableWorkspaces: 2,
        });
        assert.equal(
          (await first.evaluate(() => window.codexDemo.inspect(0))).workspace?.ownership,
          "borrowed",
        );
        stage = "native-send-stream";
        assert.equal(
          (await first.evaluate(() => window.codexDemo.send(0, "browser-send-1"))).state,
          "succeeded",
        );
        await first
          .getByTestId("transcript")
          .getByText("Browser reply 1", { exact: true })
          .waitFor();
        await second
          .getByTestId("transcript")
          .getByText("Browser reply 1", { exact: true })
          .waitFor();
        stage = "session-switch-remount";
        await first.evaluate(() => window.codexDemo.switch(1));
        assert.equal(
          (await first.evaluate(() => window.codexDemo.send(1, "browser-send-2"))).state,
          "succeeded",
        );
        await first
          .getByTestId("transcript")
          .getByText("Browser reply 2", { exact: true })
          .waitFor();
        await first.evaluate(() => window.codexDemo.switch(0));
        await first
          .getByTestId("transcript")
          .getByText("Browser reply 1", { exact: true })
          .waitFor();
        await first.evaluate(() => window.codexDemo.remount());
        await first
          .getByTestId("transcript")
          .getByText("Browser reply 1", { exact: true })
          .waitFor();
        assert.equal((await first.evaluate(() => window.codexDemo.snapshot(0))).entry.pinned, true);
        stage = "independent-viewer-close";
        const firstClosed = await first.evaluate(() => window.codexDemo.close());
        closedViews.push(firstClosed);
        assert.equal(firstClosed.peer.closed, true);
        await first.close();
        assert.equal(await fixture.physicalAlive(), "borrowed-peer-alive");
        assert.equal(
          (await second.evaluate(() => window.codexDemo.send(0, "browser-send-3"))).state,
          "succeeded",
        );
        await second
          .getByTestId("transcript")
          .getByText("Browser reply 3", { exact: true })
          .waitFor();
        assert.equal(fixture.counts().sends, 3);
        assert.equal(
          fixture.counts().historyReads,
          0,
          "Fresh created sessions stream without a native history read",
        );
        assert.deepEqual(browserErrors, []);
        await second.screenshot({ path: join(output, "conversation.png") });
        stage = "cleanup";
      } catch (error) {
        failure = error;
      } finally {
        const errors: unknown[] = [];
        for (const page of pages) {
          if (page.isClosed()) continue;
          try {
            closedViews.push(await page.evaluate(() => window.codexDemo?.close()));
          } catch (error) {
            errors.push(error);
          }
        }
        for (const close of [
          () => context?.close(),
          () => ownedBrowser?.close(),
          () => fixture?.close(),
        ]) {
          try {
            const proof = await close();
            if (proof) cleanup = proof;
          } catch (error) {
            errors.push(error);
          }
        }
        clearTimeout(guardian);
        if (errors.length)
          failure = new AggregateError(
            [...(failure ? [failure] : []), ...errors],
            "Case or cleanup failed",
          );
      }
      const receipt = {
        ...admission,
        status: failure ? "FAILED" : "PASS",
        stage,
        elapsedMs: Date.now() - started,
        counts: fixture?.counts(),
        closedViews,
        cleanup,
        error:
          failure instanceof Error
            ? { name: failure.name, message: failure.message, stack: failure.stack }
            : failure,
        browserErrors,
      };
      await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
      process.stdout.write(JSON.stringify(receipt) + "\n");
      if (failure) throw failure;
    },
  }),
  process.argv.slice(2),
);
