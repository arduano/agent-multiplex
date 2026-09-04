#!/usr/bin/env node

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const [url, screenshotPath, consolePath, authorityState, branchState, runId] =
  process.argv.slice(2);
if (!url || !screenshotPath || !consolePath || !authorityState || !branchState || !runId) {
  throw new Error(
    "usage: capture.mjs <url> <screenshot> <console-log> " +
      "<authority-state> <branch-state> <run-id>",
  );
}
const tokenFile = process.env.AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE;
if (!tokenFile) throw new Error("AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE is required");
const bearerToken = (await readFile(tokenFile, "utf8")).trim();
const playwrightModule = process.env.AGENT_MULTIPLEX_PLAYWRIGHT_MODULE ??
  "/home/arduano/.bun/install/global/node_modules/playwright/index.mjs";
const chromeExecutable = process.env.AGENT_MULTIPLEX_CHROME_EXECUTABLE ??
  "/home/arduano/.nix-profile/bin/google-chrome";
const moduleSpecifier = playwrightModule.startsWith("/")
  ? pathToFileURL(playwrightModule).href
  : playwrightModule;
const { chromium } = await import(moduleSpecifier);

await mkdir(dirname(screenshotPath), { recursive: true });
await mkdir(dirname(consolePath), { recursive: true });
const messages = [];
const errors = [];
let authenticated = false;
const browser = await chromium.launch({ headless: true, executablePath: chromeExecutable });
try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1100 },
    extraHTTPHeaders: { Authorization: `Bearer ${bearerToken}` },
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    messages.push(`console.${message.type()}: ${message.text()}`);
    if (message.type() === "error" && authenticated) errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    messages.push(`pageerror: ${error.message}`);
    errors.push(error.message);
  });
  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
  await page.locator('[data-testid="auth-token"]').fill(bearerToken);
  authenticated = true;
  await page.locator('[data-testid="connect-button"]').click();
  await page.waitForFunction(
    ({ expectedAuthority, expectedBranch, receiptRunId }) => {
      const cards = [...document.querySelectorAll('[data-testid="source-card"]')];
      const authority = cards.find((card) => card.getAttribute("data-source-id") === "authority");
      const branch = cards.find((card) => card.getAttribute("data-source-id") === "branch");
      const sessions = [...document.querySelectorAll('[data-testid="session-card"]')];
      const authorityText = authority?.textContent ?? "";
      const authorityMatches = expectedAuthority === "not-selected"
        ? !authorityText.includes("selected") ||
          authorityText.includes("unavailable") ||
          authorityText.includes("synchronizing")
        : authorityText.includes(expectedAuthority);
      return cards.length === 2 &&
        authorityMatches &&
        (branch?.textContent ?? "").includes(expectedBranch) &&
        sessions.some((card) => (card.textContent ?? "").includes(receiptRunId));
    },
    {
      expectedAuthority: authorityState,
      expectedBranch: branchState,
      receiptRunId: runId,
    },
    { timeout: 45_000 },
  );
  const visible = await page.evaluate(() => {
    const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? null;
    return {
      heading: normalize(document.querySelector("header")?.textContent),
      sources: [...document.querySelectorAll('[data-testid="source-card"]')].map((card) =>
        normalize(card.textContent),
      ),
      controlNodeCount: document.querySelectorAll('[data-testid="control-node-card"]').length,
      runtimeNodeCount: document.querySelectorAll('[data-testid="runtime-node-card"]').length,
      sessionCount: document.querySelectorAll('[data-testid="session-card"]').length,
    };
  });
  await page.screenshot({ path: screenshotPath, fullPage: false });
  await appendFile(consolePath, `${messages.length ? messages.join("\n") : "no browser console messages"}\n`, "utf8");
  if (errors.length) throw new Error(`dashboard emitted browser errors: ${errors.join("; ")}`);
  console.log(JSON.stringify({
    screenshotPath,
    viewport: { width: 1600, height: 1100 },
    expected: { authorityState, branchState },
    browserConsoleErrors: 0,
    visible,
  }, null, 2));
} finally {
  await browser.close();
}
