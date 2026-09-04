#!/usr/bin/env node

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const [
  url,
  screenshotPath,
  consolePath,
  workerPrefix,
  runId,
  rawExpectedWorkers,
  rawExpectedSessions,
  expectedMarker,
] = process.argv.slice(2);

const expectedWorkers = Number(rawExpectedWorkers);
const expectedSessions = Number(rawExpectedSessions);
if (
  !url ||
  !screenshotPath ||
  !consolePath ||
  !workerPrefix ||
  !runId ||
  !expectedMarker ||
  !Number.isSafeInteger(expectedWorkers) ||
  !Number.isSafeInteger(expectedSessions)
) {
  throw new Error(
    "usage: capture.mjs <url> <screenshot> <console-log> <worker-prefix> " +
      "<run-id> <expected-workers> <expected-sessions> <expected-marker>",
  );
}

const playwrightModule =
  process.env.AGENT_MULTIPLEX_PLAYWRIGHT_MODULE ??
  "/home/arduano/.bun/install/global/node_modules/playwright/index.mjs";
const chromeExecutable =
  process.env.AGENT_MULTIPLEX_CHROME_EXECUTABLE ??
  "/home/arduano/.nix-profile/bin/google-chrome";
const moduleSpecifier = playwrightModule.startsWith("/")
  ? pathToFileURL(playwrightModule).href
  : playwrightModule;
const { chromium } = await import(moduleSpecifier);

await mkdir(dirname(screenshotPath), { recursive: true });
await mkdir(dirname(consolePath), { recursive: true });

const browserMessages = [];
const browserErrors = [];
const browser = await chromium.launch({ headless: true, executablePath: chromeExecutable });

try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
  page.on("console", (message) => {
    browserMessages.push(`console.${message.type()}: ${message.text()}`);
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    browserMessages.push(`pageerror: ${error.message}`);
    browserErrors.push(error.message);
  });

  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForFunction(
    ({ prefix, receiptRunId, workerCount, sessionCount }) => {
      const workers = [...document.querySelectorAll('[data-testid="worker-card"]')];
      const sessions = [...document.querySelectorAll('[data-testid="session-card"]')];
      const selectedWorkers = workers.filter((card) =>
        (card.textContent ?? "").includes(prefix),
      );
      const selectedSessions = sessions.filter((card) =>
        (card.textContent ?? "").includes(receiptRunId),
      );
      return (
        workers.length === workerCount &&
        selectedWorkers.length === workerCount &&
        selectedWorkers.every((card) => {
          const text = card.textContent ?? "";
          return text.includes("online") && text.includes("copilot ready");
        }) &&
        sessions.length === sessionCount &&
        selectedSessions.length === sessionCount &&
        selectedSessions.every((card) => {
          const text = card.textContent ?? "";
          return text.includes("active") && text.includes("idle");
        })
      );
    },
    {
      prefix: workerPrefix,
      receiptRunId: runId,
      workerCount: expectedWorkers,
      sessionCount: expectedSessions,
    },
    { timeout: 90_000 },
  );

  const firstSession = page.locator('[data-testid="session-card"]', {
    hasText: `Copilot scale 00/00 ${runId}`,
  });
  await firstSession.click();
  await page.getByTestId("stream-status").filter({ hasText: "live" }).waitFor({
    timeout: 30_000,
  });
  await page.waitForFunction(
    (marker) => (document.body.textContent ?? "").includes(marker),
    expectedMarker,
    { timeout: 60_000 },
  );

  const visible = await page.evaluate(
    ({ prefix, receiptRunId, marker }) => {
      const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? null;
      const allWorkers = [...document.querySelectorAll('[data-testid="worker-card"]')];
      const allSessions = [...document.querySelectorAll('[data-testid="session-card"]')];
      const workers = allWorkers.filter((card) =>
        (card.textContent ?? "").includes(prefix),
      );
      const sessions = allSessions.filter((card) =>
        (card.textContent ?? "").includes(receiptRunId),
      );
      return {
        heading: normalize(document.querySelector("header")?.textContent),
        totalWorkerCardCount: allWorkers.length,
        selectedWorkerCardCount: workers.length,
        onlineCopilotWorkerCardCount: workers.filter((card) => {
          const text = card.textContent ?? "";
          return text.includes("online") && text.includes("copilot ready");
        }).length,
        totalSessionCardCount: allSessions.length,
        selectedSessionCardCount: sessions.length,
        activeIdleSessionCardCount: sessions.filter((card) => {
          const text = card.textContent ?? "";
          return text.includes("active") && text.includes("idle");
        }).length,
        firstWorker: normalize(workers[0]?.textContent),
        lastWorker: normalize(workers.at(-1)?.textContent),
        firstSession: normalize(sessions[0]?.textContent),
        lastSession: normalize(sessions.at(-1)?.textContent),
        selectedConsole: normalize(
          document.querySelector('[data-testid="session-console"]')?.textContent,
        ),
        streamStatus: normalize(
          document.querySelector('[data-testid="stream-status"]')?.textContent,
        ),
        expectedMarkerVisible: (document.body.textContent ?? "").includes(marker),
      };
    },
    { prefix: workerPrefix, receiptRunId: runId, marker: expectedMarker },
  );

  // Expand the normally scrollable inventory for the receipt so all 100
  // session cards are present in pixels as well as in the DOM-count proof.
  await page.addStyleTag({
    content: ".session-list{max-height:none!important;overflow:visible!important}",
  });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await appendFile(
    consolePath,
    `${browserMessages.length > 0 ? browserMessages.join("\n") : "no browser console messages"}\n`,
    "utf8",
  );
  if (browserErrors.length > 0) {
    throw new Error(`dashboard emitted browser errors: ${browserErrors.join("; ")}`);
  }

  console.log(JSON.stringify({
    url,
    screenshotPath,
    viewport: { width: 1800, height: 1200 },
    fullPageScreenshot: true,
    assertions: {
      exactTotalWorkerCards: visible.totalWorkerCardCount === expectedWorkers,
      exactSelectedWorkerCards: visible.selectedWorkerCardCount === expectedWorkers,
      everyWorkerOnlineAndCopilotReady:
        visible.onlineCopilotWorkerCardCount === expectedWorkers,
      exactTotalSessionCards: visible.totalSessionCardCount === expectedSessions,
      exactSelectedSessionCards: visible.selectedSessionCardCount === expectedSessions,
      everySessionActiveAndIdle: visible.activeIdleSessionCardCount === expectedSessions,
      streamLive: visible.streamStatus?.includes("live") === true,
      expectedMarkerVisible: visible.expectedMarkerVisible,
      browserConsoleErrors: browserErrors.length,
    },
    visible,
    browserConsoleMessageCount: browserMessages.length,
  }, null, 2));
} finally {
  await browser.close();
}
