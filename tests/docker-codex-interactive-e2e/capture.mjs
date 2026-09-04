#!/usr/bin/env node

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const [url, screenshotPath, consolePath, workerName, sessionTitle, phase, expected, responseJson] =
  process.argv.slice(2);
const expectedWaitMs = Number.parseInt(
  process.env.AGENT_MULTIPLEX_CAPTURE_WAIT_MS ?? "30000",
  10,
);
if (!Number.isFinite(expectedWaitMs) || expectedWaitMs < 1_000) {
  throw new Error("AGENT_MULTIPLEX_CAPTURE_WAIT_MS must be at least 1000");
}

if (!url || !screenshotPath || !consolePath || !workerName || !sessionTitle || !phase) {
  throw new Error(
    "usage: capture.mjs <url> <screenshot> <console-log> <worker> <title> <phase> [expected-text]",
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
const browser = await chromium.launch({
  headless: true,
  executablePath: chromeExecutable,
});

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  page.on("console", (message) => {
    browserMessages.push(`[${phase}] console.${message.type()}: ${message.text()}`);
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    browserMessages.push(`[${phase}] pageerror: ${error.message}`);
    browserErrors.push(error.message);
  });

  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForFunction(
    ({ expectedWorker, expectedTitle }) => {
      const workerText = document.querySelector("#workers")?.textContent ?? "";
      const sessionText = document.querySelector("#sessions")?.textContent ?? "";
      return (
        workerText.includes(expectedWorker) &&
        workerText.includes("online") &&
        workerText.includes("codex ready") &&
        sessionText.includes(expectedTitle) &&
        sessionText.includes("active")
      );
    },
    { expectedWorker: workerName, expectedTitle: sessionTitle },
    { timeout: 30_000 },
  );

  const card = page.locator('[data-testid="session-card"]', { hasText: sessionTitle });
  await card.click();
  await page.getByTestId("stream-status").filter({ hasText: "live" }).waitFor({
    timeout: 30_000,
  });

  if (expected) {
    await page.waitForFunction(
      (needle) => (document.body.textContent ?? "").includes(needle),
      expected,
      { timeout: expectedWaitMs },
    );
  }
  if (phase === "subagent-completed") {
    await page.waitForFunction(
      () => {
        return [...document.querySelectorAll(
          '[data-item-type="subAgentActivity"] .event-summary',
        )].some((element) => /^completed(?:\s|·|$)/.test((element.textContent ?? "").trim()));
      },
      undefined,
      { timeout: expectedWaitMs },
    );
  }
  if (responseJson) {
    const response = page.getByTestId("interaction-response").first();
    // The raw native-response editor intentionally lives in a collapsed
    // <details>. Set its value and open the disclosure atomically so the
    // five-second dashboard refresh cannot race Playwright's actionability
    // checks and detach the textarea between click/fill attempts.
    await response.evaluate((element, value) => {
      const details = element.closest("details");
      if (details) details.open = true;
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }, responseJson);
    await page.waitForFunction(
      (needle) => {
        const input = document.querySelector('[data-testid="interaction-response"]');
        return input instanceof HTMLTextAreaElement && input.value.includes(needle);
      },
      responseJson,
      { timeout: 10_000 },
    );
  }

  const visible = await page.evaluate(({ expectedWorker, expectedTitle, expectedText, expectedPhase }) => {
    const normalized = (value) => value?.replace(/\s+/g, " ").trim() ?? null;
    const workerCard = [...document.querySelectorAll('[data-testid="worker-card"]')]
      .find((element) => (element.textContent ?? "").includes(expectedWorker));
    const sessionCard = [...document.querySelectorAll('[data-testid="session-card"]')]
      .find((element) => (element.textContent ?? "").includes(expectedTitle));
    const pending = document.querySelector('[data-testid="interaction-card"]');
    const events = [...document.querySelectorAll('[data-testid="native-event"]')]
      .slice(0, 12)
      .map((element) => normalized(element.textContent));
    return {
      heading: normalized(document.querySelector("header")?.textContent),
      workerCard: normalized(workerCard?.textContent),
      sessionCard: normalized(sessionCard?.textContent),
      selectedSession: normalized(document.querySelector('[data-testid="session-console"]')?.textContent),
      pendingInteraction: normalized(pending?.textContent),
      pendingResponse: document.querySelector('[data-testid="interaction-response"]')?.value ?? null,
      subagentCompletedVisible: expectedPhase === "subagent-completed"
        ? [...document.querySelectorAll(
          '[data-item-type="subAgentActivity"] .event-summary',
        )].some((element) => /^completed(?:\s|·|$)/.test((element.textContent ?? "").trim()))
        : null,
      eventCounts: {
        commandExecution: normalized(document.querySelector('[data-testid="count-commandExecution"]')?.textContent),
        collabAgentToolCall: normalized(document.querySelector('[data-testid="count-collabAgentToolCall"]')?.textContent),
        subAgentActivity: normalized(document.querySelector('[data-testid="count-subAgentActivity"]')?.textContent),
      },
      recentEvents: events,
      expectedTextVisible: expectedText ? (document.body.textContent ?? "").includes(expectedText) : null,
    };
  }, {
    expectedWorker: workerName,
    expectedTitle: sessionTitle,
    expectedText: expected ?? null,
    expectedPhase: phase,
  });

  await page.screenshot({ path: screenshotPath, fullPage: true });
  await appendFile(
    consolePath,
    `${browserMessages.length > 0 ? browserMessages.join("\n") : `[${phase}] no browser console messages`}\n`,
    "utf8",
  );
  if (browserErrors.length > 0) {
    throw new Error(`dashboard emitted browser errors: ${browserErrors.join("; ")}`);
  }

  console.log(JSON.stringify({
    phase,
    url,
    screenshotPath,
    viewport: { width: 1600, height: 1200 },
    assertions: {
      workerOnlineAndCodexReady: true,
      sessionActive: true,
      streamLive: true,
      expectedTextVisible: expected ? true : null,
    },
    visible,
    browserConsoleMessageCount: browserMessages.length,
  }, null, 2));
} finally {
  await browser.close();
}
