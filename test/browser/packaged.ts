import { command, option, optional, run, string, type Type } from "cmd-ts";
import type { Browser, BrowserContext, BrowserServer, Page } from "playwright-core";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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

const cliCommand = command({
  name: "packaged-browser",
  description: "Bounded production reference UI smoke.",
  args: {
    input: option({ long: "cli", type: pathType }),
    tooling: optionalPath("tooling"),
    browserOption: optionalPath("browser"),
  },
  handler: async ({ input, tooling, browserOption }) => {
    const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
    const cli = await realpath(resolve(input));
    assert.equal(cli.endsWith("/dist/reference/cli.js"), true);
    const require = createRequire(
      tooling ? join(resolve(tooling), "package.json") : import.meta.url,
    );
    assert.equal(require("playwright-core/package.json").version, "1.56.1");
    const { chromium } = require("playwright-core") as typeof import("playwright-core");
    const browserPath =
      browserOption ?? process.env.MULTIPLEX_BROWSER ?? "/run/current-system/sw/bin/chromium";
    const output = await mkdtemp(join(root, ".build/packaged-browser-"));
    const temporary = join(output, "tmp");
    await mkdir(temporary, { mode: 0o700 });
    const limits = {
      workMs: 90000,
      cleanupMs: 30000,
      requests: 100,
      browsers: 1,
      pages: 1,
      scriptedAgents: 2,
      nativeAgents: 0,
      modelCalls: 0,
    };
    const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
    const artifact = resolve(cli, "../.."),
      paths = [
        cli,
        join(artifact, "reference/web/index.html"),
        join(artifact, "reference/web/app.js"),
        join(artifact, "reference/web/app.css"),
      ];
    const seal = async () =>
      Object.fromEntries(
        await Promise.all(
          paths.map(async (path) => [relative(artifact, path), sha(await readFile(path))]),
        ),
      );
    const before = await seal();
    await writeFile(
      join(output, "admission.json"),
      JSON.stringify(
        {
          started: new Date().toISOString(),
          limits,
          cli,
          browser: browserPath,
          inputs: before,
          command: [process.execPath, cli, "demo", "--port", "0"],
        },
        null,
        2,
      ),
    );
    let processOwner!: ChildProcessByStdio<null, Readable, Readable>,
      server!: BrowserServer,
      browser!: Browser,
      context!: BrowserContext,
      page!: Page;
    let address: string | undefined,
      failure: string | undefined,
      requests = 0,
      stderr = "",
      stdout = "";
    let processIdentity!: Awaited<ReturnType<typeof identity>>;
    let browserIdentity!: Awaited<ReturnType<typeof identity>>;
    let sigtermSent = false;
    const cases: { name: string; status: "passed" }[] = [],
      errors: string[] = [],
      blocked: { method: string; protocol: string }[] = [];
    const cleanup = {
      page: false,
      context: false,
      browser: false,
      browserProcess: false,
      cli: false,
      cliGroup: false,
      temporaryState: false,
    };
    async function identity(pid: number | undefined) {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8"),
          fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
        return { pid, group: Number(fields[2]), birth: fields[19] };
      } catch {
        return null;
      }
    }
    async function members(group: number) {
      const result = [];
      for (const value of await readdir("/proc"))
        if (/^\d+$/.test(value)) {
          const current = await identity(Number(value));
          if (current?.group === group) result.push(current.pid);
        }
      return result;
    }
    async function bounded<T>(action: () => T | Promise<T>, ms: number, code: string): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.resolve().then(action),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error(code)), ms);
            timer.unref();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    async function until(read: () => unknown | Promise<unknown>, label: string, ms = 10000) {
      const end = Date.now() + ms;
      do {
        if (await read()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < end);
      throw Error(`Timed out: ${label}`);
    }
    async function check(name: string, run: () => Promise<void>) {
      await run();
      cases.push({ name, status: "passed" });
    }
    async function http(path: string) {
      if (++requests > limits.requests) throw Error("REQUEST_LIMIT");
      const response = await fetch(new URL(path, address), { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      return new Uint8Array(await response.arrayBuffer());
    }
    async function work() {
      processOwner = spawn(process.execPath, [cli, "demo", "--port", "0"], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "", TMPDIR: temporary },
      });
      const exited = new Promise((resolve, reject) => {
        processOwner.once("error", reject);
        processOwner.once("exit", (code, signal) =>
          reject(Error(`CLI_EXIT_BEFORE_READY:${code}:${signal}`)),
        );
      });
      processOwner.stdout.on("data", (bytes) => {
        stdout = (stdout + bytes.toString()).slice(-65536);
      });
      processOwner.stderr.on("data", (bytes) => {
        stderr = (stderr + bytes.toString()).slice(-16384);
      });
      processIdentity = await identity(processOwner.pid);
      assert.ok(processIdentity && processIdentity.group === processOwner.pid);
      await writeFile(join(output, "process.json"), JSON.stringify(processIdentity));
      await Promise.race([
        until(
          () => {
            const match = stdout.match(
              /^Model-free disposable reference UI: (http:\/\/127\.0\.0\.1:\d+)$/m,
            );
            address = match?.[1];
            return address;
          },
          "CLI listener",
          20000,
        ),
        exited,
      ]);
      await check("built CLI serves exact production HTML, CSS and JavaScript", async () => {
        for (const [path, file] of [
          ["/", "index.html"],
          ["/app.js", "app.js"],
          ["/app.css", "app.css"],
        ] as const)
          assert.equal(
            sha(await http(path)),
            sha(await readFile(join(artifact, "reference/web", file))),
          );
      });
      server = await chromium.launchServer({
        executablePath: browserPath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking"],
      });
      browserIdentity = await identity(server.process().pid);
      browser = await chromium.connect(server.wsEndpoint());
      context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (++requests > limits.requests || url.origin !== address) {
          blocked.push({ method: request.method(), protocol: url.protocol });
          await route.abort();
        } else await route.continue();
      });
      page = await context.newPage();
      page.on("pageerror", (error) => errors.push(String(error).slice(0, 500)));
      await page.goto(address!);
      await check(
        "production boot shows actual history and a decoded scoped image without test globals",
        async () => {
          await page.getByText("Connected", { exact: true }).waitFor();
          await page.locator("[data-history-row]").first().waitFor();
          const image = page.locator("img.mpx-thumbnail").first();
          await image.waitFor();
          await until(
            () =>
              image.evaluate(
                (value) =>
                  value instanceof HTMLImageElement && value.complete && value.naturalWidth > 0,
              ),
            "scoped image decode",
          );
          assert.equal(await page.evaluate(() => "__reference" in window), false);
          assert.equal(
            await page
              .getByRole("navigation", { name: "Conversations" })
              .getByRole("button")
              .count(),
            2,
          );
          await page.screenshot({ path: join(output, "desktop.png") });
        },
      );
      await check(
        "typed control applies through the built router and switching preserves local draft",
        async () => {
          const model = page.locator(".mpx-reference-inline [data-control=model] [role=combobox]");
          await model.click();
          await page.getByRole("option", { name: "scripted-large", exact: true }).click();
          await until(
            async () => (await model.getAttribute("data-value")) === "scripted-large",
            "applied typed control",
          );
          const draft = page.getByRole("textbox", { name: "Message", exact: true });
          await draft.fill("Built artifact retained local draft");
          const navigation = page.getByRole("navigation", { name: "Conversations" });
          await navigation.getByRole("button", { name: /^Second conversation/ }).click();
          await page.getByRole("heading", { name: "Second conversation", exact: true }).waitFor();
          await draft.fill("Independent second draft");
          await navigation.getByRole("button", { name: /^Reference conversation/ }).click();
          await page
            .getByRole("heading", { name: "Reference conversation", exact: true })
            .waitFor();
          assert.equal(await draft.inputValue(), "Built artifact retained local draft");
        },
      );
      await check("390px production settings and conversation remain contained", async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Agent settings", exact: true });
        await dialog.waitFor();
        const bounds = await dialog.boundingBox();
        assert.ok(
          bounds &&
            bounds.x >= 0 &&
            bounds.y >= 0 &&
            bounds.x + bounds.width <= 390 &&
            bounds.y + bounds.height <= 844,
        );
        await page.screenshot({ path: join(output, "mobile.png") });
        await page.keyboard.press("Escape");
      });
    }
    try {
      await bounded(work, limits.workMs, "WORK_DEADLINE");
    } catch (error) {
      failure = String(error instanceof Error ? (error.stack ?? error.message) : error);
      try {
        if (page && !page.isClosed()) {
          await page.screenshot({ path: join(output, "failure.png") });
          await writeFile(join(output, "failure-body.txt"), await page.locator("body").innerText());
        }
      } catch {}
    } finally {
      try {
        await bounded(async () => page?.close(), 5000, "PAGE_CLEANUP");
        cleanup.page = true;
      } catch {}
      try {
        await bounded(async () => context?.close(), 5000, "CONTEXT_CLEANUP");
        cleanup.context = true;
      } catch {}
      try {
        await bounded(async () => browser?.close(), 5000, "BROWSER_CLEANUP");
        cleanup.browser = true;
      } catch {}
      try {
        await bounded(
          async () => {
            if (!server) return;
            const child = server.process();
            await server.close();
            if (child.exitCode === null && child.signalCode === null)
              await new Promise<void>((resolve) => child.once("exit", () => resolve()));
            if (browserIdentity && browserIdentity.group === browserIdentity.pid) {
              const group = browserIdentity.group;
              await until(
                async () => (await members(group)).length === 0,
                "owned browser group retirement",
                2000,
              );
            }
          },
          5000,
          "BROWSER_PROCESS_CLEANUP",
        );
        cleanup.browserProcess = true;
      } catch (error) {
        failure ??= String(error);
      }
      try {
        await bounded(
          async () => {
            if (!processOwner) return;
            if (processOwner.exitCode === null && processOwner.signalCode === null) {
              assert.deepEqual(await identity(processOwner.pid), processIdentity);
              const closed = new Promise<void>((resolve) =>
                processOwner.once("exit", () => resolve()),
              );
              assert.equal(processOwner.kill("SIGTERM"), true);
              sigtermSent = true;
              await closed;
            }
            assert.equal(sigtermSent, true);
            assert.equal(processOwner.exitCode, 0);
          },
          8000,
          "CLI_CLEANUP",
        );
        cleanup.cli = true;
      } catch (error) {
        failure ??= String(error);
        if (processOwner && (await identity(processOwner.pid))?.birth === processIdentity?.birth) {
          const closed = new Promise<void>((resolve) => processOwner.once("exit", () => resolve()));
          processOwner.kill("SIGKILL");
          await bounded(() => closed, 2000, "FORCED_CLI_RETIREMENT").catch(() => {});
        }
      }
      cleanup.cliGroup = processIdentity
        ? (await members(processIdentity.group)).length === 0
        : !processOwner;
      cleanup.temporaryState = (await readdir(temporary)).length === 0;
    }
    const after = await seal(),
      inputsUnchanged = JSON.stringify(before) === JSON.stringify(after);
    if (!inputsUnchanged) failure ??= "BUILT_INPUTS_CHANGED";
    if (errors.length || blocked.length) failure ??= "BROWSER_ERRORS_OR_UNEXPECTED_REQUESTS";
    if (!Object.values(cleanup).every(Boolean)) failure ??= "CLEANUP_NOT_PROVED";
    const result = {
      status: failure ? "failed" : "passed",
      limits,
      cli,
      inputs: before,
      inputsUnchanged,
      cases,
      requests,
      errors,
      blocked,
      cleanup,
      processIdentity,
      browserIdentity,
      sigtermSent,
      scriptedAgents: 2,
      nativeAgents: 0,
      modelCalls: 0,
      stderr,
      failure,
    };
    await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
    console.log(
      JSON.stringify({
        status: result.status,
        cases: cases.length,
        requests,
        cleanup,
        output,
        failure,
      }),
    );
    if (failure) process.exitCode = 1;
  },
});
await run(cliCommand, process.argv.slice(2));
