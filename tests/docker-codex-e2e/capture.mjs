#!/usr/bin/env node

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const [url, screenshotPath, consolePath, workerName, sessionTitle, phase] =
  process.argv.slice(2);

if (!url || !screenshotPath || !consolePath || !workerName || !sessionTitle || !phase) {
  throw new Error(
    "usage: capture.mjs <url> <screenshot> <console-log> <worker> <title> <phase>",
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
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
      const workers = [...document.querySelectorAll("#workers .card")];
      const sessions = [...document.querySelectorAll("#sessions .card")];
      return (
        workers.some((card) => {
          const text = card.textContent ?? "";
          return (
            text.includes(expectedWorker) &&
            text.includes("online") &&
            text.includes("codex: ready")
          );
        }) &&
        sessions.some((card) => {
          const text = card.textContent ?? "";
          return (
            text.includes(expectedTitle) &&
            text.includes("active") &&
            text.includes("idle")
          );
        })
      );
    },
    { expectedWorker: workerName, expectedTitle: sessionTitle },
    { timeout: 30_000 },
  );

  const visible = await page.evaluate(({ expectedWorker, expectedTitle }) => {
    const workerCard = [...document.querySelectorAll("#workers .card")].find((card) =>
      (card.textContent ?? "").includes(expectedWorker),
    );
    const sessionCard = [...document.querySelectorAll("#sessions .card")].find((card) =>
      (card.textContent ?? "").includes(expectedTitle),
    );
    return {
      heading: document.querySelector("header")?.textContent?.replace(/\s+/g, " ").trim(),
      workerCard: workerCard?.textContent?.replace(/\s+/g, " ").trim(),
      sessionCard: sessionCard?.textContent?.replace(/\s+/g, " ").trim(),
    };
  }, { expectedWorker: workerName, expectedTitle: sessionTitle });

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
    viewport: { width: 1440, height: 1000 },
    assertions: {
      workerOnlineAndCodexReady: true,
      sessionActiveAndIdle: true,
    },
    visible,
    browserConsoleMessageCount: browserMessages.length,
  }, null, 2));
} finally {
  await browser.close();
}
