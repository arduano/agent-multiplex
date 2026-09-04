#!/usr/bin/env node

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const [url, screenshotPath, consolePath, workerName, sessionTitle, expectedText = ""] =
  process.argv.slice(2);
if (!url || !screenshotPath || !consolePath || !workerName || !sessionTitle) {
  throw new Error(
    "usage: capture.mjs <url> <screenshot> <console-log> <worker> <title> [expected-text]",
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
    browserMessages.push(`console.${message.type()}: ${message.text()}`);
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    browserMessages.push(`pageerror: ${error.message}`);
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
        workerText.includes("copilot ready") &&
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
  if (expectedText) {
    await page.waitForFunction(
      (needle) => (document.body.textContent ?? "").includes(needle),
      expectedText,
      { timeout: 60_000 },
    );
  }

  const visible = await page.evaluate(
    ({ expectedWorker, expectedTitle, expected }) => {
      const normalized = (value) => value?.replace(/\s+/g, " ").trim() ?? null;
      const workerCard = [...document.querySelectorAll('[data-testid="worker-card"]')]
        .find((element) => (element.textContent ?? "").includes(expectedWorker));
      const sessionCard = [...document.querySelectorAll('[data-testid="session-card"]')]
        .find((element) => (element.textContent ?? "").includes(expectedTitle));
      return {
        heading: normalized(document.querySelector("header")?.textContent),
        workerCard: normalized(workerCard?.textContent),
        sessionCard: normalized(sessionCard?.textContent),
        selectedSession: normalized(
          document.querySelector('[data-testid="session-console"]')?.textContent,
        ),
        streamStatus: normalized(document.querySelector('[data-testid="stream-status"]')?.textContent),
        expectedTextVisible: expected
          ? (document.body.textContent ?? "").includes(expected)
          : null,
        recentEvents: [...document.querySelectorAll('[data-testid="native-event"]')]
          .slice(0, 16)
          .map((element) => ({
            nativeType: element.getAttribute("data-native-type"),
            text: normalized(element.textContent),
          })),
      };
    },
    { expectedWorker: workerName, expectedTitle: sessionTitle, expected: expectedText },
  );

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
    viewport: { width: 1600, height: 1200 },
    assertions: {
      workerOnlineAndCopilotReady: true,
      sessionActive: true,
      streamLive: true,
      expectedTextVisible: expectedText ? true : null,
    },
    visible,
    browserConsoleMessageCount: browserMessages.length,
  }, null, 2));
} finally {
  await browser.close();
}
