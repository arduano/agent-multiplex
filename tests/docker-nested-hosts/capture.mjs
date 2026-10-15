#!/usr/bin/env node

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const [
  url,
  screenshotPath,
  consolePath,
  hostPrefix,
  workerPrefix,
  runId,
  rawHosts,
  rawWorkers,
  rawSessions,
] = process.argv.slice(2);
const expectedHosts = Number(rawHosts);
const expectedWorkers = Number(rawWorkers);
const expectedSessions = Number(rawSessions);
if (
  !url ||
  !screenshotPath ||
  !consolePath ||
  !hostPrefix ||
  !workerPrefix ||
  !runId ||
  !Number.isSafeInteger(expectedHosts) ||
  !Number.isSafeInteger(expectedWorkers) ||
  !Number.isSafeInteger(expectedSessions)
) {
  throw new Error(
    "usage: capture.mjs <url> <screenshot> <console-log> <host-prefix> " +
      "<worker-prefix> <run-id> <expected-hosts> <expected-workers> <expected-sessions>",
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

await Promise.all([
  mkdir(dirname(screenshotPath), { recursive: true }),
  mkdir(dirname(consolePath), { recursive: true }),
]);

const messages = [];
const errors = [];
const browser = await chromium.launch({
  headless: true,
  executablePath: chromeExecutable,
});

try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
  page.on("console", (message) => {
    messages.push(`console.${message.type()}: ${message.text()}`);
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    messages.push(`pageerror: ${error.message}`);
    errors.push(error.message);
  });

  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForFunction(
    ({ hosts, workers, sessions, expectedHostPrefix, expectedWorkerPrefix, receiptRunId }) => {
      const hostCards = [...document.querySelectorAll('[data-testid="host-card"]')];
      const workerCards = [...document.querySelectorAll('[data-testid="worker-card"]')];
      const sessionCards = [...document.querySelectorAll('[data-testid="session-card"]')];
      const exactText = (selector, value) =>
        (document.querySelector(selector)?.textContent ?? "").trim() === value;
      return (
        exactText('[data-testid="global-status"]', "connected") &&
        exactText('[data-testid="stream-status"]', "live") &&
        hostCards.length === hosts &&
        hostCards.filter((card) => (card.textContent ?? "").includes(expectedHostPrefix)).length === hosts &&
        hostCards.every((card) => card.querySelector(":scope > p > .tag.online")?.textContent?.trim() === "online") &&
        workerCards.length === workers &&
        workerCards.filter((card) => (card.textContent ?? "").includes(expectedWorkerPrefix)).length === workers &&
        workerCards.every(
          (card) =>
            card.querySelector(":scope > p > .tag.online")?.textContent?.trim() === "online" &&
            card.querySelector(":scope > p > .tag.reachable")?.textContent?.trim() === "reachable",
        ) &&
        sessionCards.length === sessions &&
        sessionCards.filter((card) => (card.textContent ?? "").includes(receiptRunId)).length === sessions &&
        sessionCards.every(
          (card) =>
            card.querySelector(":scope > .tag.active")?.textContent?.trim() === "active" &&
            card.querySelector(":scope > .tag.idle")?.textContent?.trim() === "idle",
        )
      );
    },
    {
      hosts: expectedHosts,
      workers: expectedWorkers,
      sessions: expectedSessions,
      expectedHostPrefix: hostPrefix,
      expectedWorkerPrefix: workerPrefix,
      receiptRunId: runId,
    },
    { timeout: 60_000 },
  );

  const visible = await page.evaluate(({ expectedHostPrefix, expectedWorkerPrefix, receiptRunId }) => {
    const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? null;
    const exactStatus = (card, status, selector = ":scope > .tag") =>
      card.querySelector(`${selector}.${status}`)?.textContent?.trim() === status;
    const hosts = [...document.querySelectorAll('[data-testid="host-card"]')].filter(
      (card) => (card.textContent ?? "").includes(expectedHostPrefix),
    );
    const workers = [...document.querySelectorAll('[data-testid="worker-card"]')].filter(
      (card) => (card.textContent ?? "").includes(expectedWorkerPrefix),
    );
    const sessions = [...document.querySelectorAll('[data-testid="session-card"]')].filter(
      (card) => (card.textContent ?? "").includes(receiptRunId),
    );
    return {
      heading: normalize(document.querySelector("header")?.textContent),
      globalStatus: normalize(document.querySelector('[data-testid="global-status"]')?.textContent),
      hostCardCount: hosts.length,
      onlineHostCardCount: hosts.filter((card) => exactStatus(card, "online", ":scope > p > .tag")).length,
      workerCardCount: workers.length,
      onlineReachableWorkerCardCount: workers.filter(
        (card) =>
          exactStatus(card, "online", ":scope > p > .tag") &&
          exactStatus(card, "reachable", ":scope > p > .tag"),
      ).length,
      sessionCardCount: sessions.length,
      activeIdleSessionCardCount: sessions.filter(
        (card) => exactStatus(card, "active") && exactStatus(card, "idle"),
      ).length,
      firstHost: normalize(hosts[0]?.textContent),
      lastHost: normalize(hosts.at(-1)?.textContent),
      firstWorker: normalize(workers[0]?.textContent),
      lastWorker: normalize(workers.at(-1)?.textContent),
      firstSession: normalize(sessions[0]?.textContent),
      lastSession: normalize(sessions.at(-1)?.textContent),
      streamStatus: normalize(document.querySelector('[data-testid="stream-status"]')?.textContent),
    };
  }, { expectedHostPrefix: hostPrefix, expectedWorkerPrefix: workerPrefix, receiptRunId: runId });

  await page.screenshot({ path: screenshotPath, fullPage: false });
  await appendFile(
    consolePath,
    `${messages.length > 0 ? messages.join("\n") : "no browser console messages"}\n`,
    "utf8",
  );
  if (errors.length > 0) {
    throw new Error(`dashboard emitted browser errors: ${errors.join("; ")}`);
  }
  process.stdout.write(`${JSON.stringify({
    url,
    screenshotPath,
    viewport: { width: 1800, height: 1200 },
    assertions: {
      exactHostCards: true,
      everyHostOnline: true,
      exactWorkerCards: true,
      everyWorkerOnlineAndReachable: true,
      exactSessionCards: true,
      everySessionActiveAndIdle: true,
      globalStatusConnected: visible.globalStatus === "connected",
      selectedSessionStreamLive: visible.streamStatus === "live",
      browserConsoleErrors: 0,
    },
    visible,
  }, null, 2)}\n`);
} finally {
  await browser.close();
}
