#!/usr/bin/env node

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { AxeBuilder } from "@axe-core/playwright";

const [url, screenshotPath, consolePath, runtimeNodePrefix, runId, rawRuntimeNodes, rawSessions] =
  process.argv.slice(2);
const expectedRuntimeNodes = Number(rawRuntimeNodes);
const expectedSessions = Number(rawSessions);
if (
  !url ||
  !screenshotPath ||
  !consolePath ||
  !runtimeNodePrefix ||
  !runId ||
  !Number.isSafeInteger(expectedRuntimeNodes) ||
  !Number.isSafeInteger(expectedSessions)
) {
  throw new Error(
    "usage: capture.mjs <url> <screenshot> <console-log> <runtime-node-prefix> " +
      "<run-id> <expected-runtime-nodes> <expected-sessions>",
  );
}
const bearerTokenFile = process.env.AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE;
if (!bearerTokenFile) {
  throw new Error("AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE is required");
}
const bearerToken = (await readFile(bearerTokenFile, "utf8")).trim();
if (!bearerToken || /\s/.test(bearerToken)) {
  throw new Error("acceptance bearer token file is empty or contains whitespace");
}

const playwrightModule =
  process.env.AGENT_MULTIPLEX_PLAYWRIGHT_MODULE ??
  "playwright-core";
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
  // The zero-build dashboard performs its first refresh immediately. Supply
  // read authorization at the browser-context boundary so those bootstrap
  // requests do not create expected-but-noisy 401 console errors before the
  // token field can be populated for subsequent HTTP and WebSocket calls.
  const context = await browser.newContext({
    viewport: { width: 1800, height: 1200 },
    extraHTTPHeaders: { authorization: `Bearer ${bearerToken}` },
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    browserMessages.push(`console.${message.type()}: ${message.text()}`);
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    browserMessages.push(`pageerror: ${error.message}`);
    browserErrors.push(error.message);
  });

  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
  await page.locator('[data-testid="auth-token"]').fill(bearerToken);
  await page.locator('[data-testid="connect-button"]').click();
  await page.waitForFunction(
    ({ prefix, receiptRunId, runtimeNodeCount, sessionCount }) => {
      const runtimeNodes = [...document.querySelectorAll('[data-testid="runtime-node-card"]')];
      const sessions = [...document.querySelectorAll('[data-testid="session-card"]')];
      return (
        runtimeNodes.filter((card) => (card.textContent ?? "").includes(prefix)).length ===
          runtimeNodeCount &&
        runtimeNodes.every((card) => (card.textContent ?? "").includes("online")) &&
        sessions.filter((card) => (card.textContent ?? "").includes(receiptRunId)).length ===
          sessionCount &&
        sessions.every((card) => {
          const text = card.textContent ?? "";
          return text.includes("active") && text.includes("idle");
        })
      );
    },
    {
      prefix: runtimeNodePrefix,
      receiptRunId: runId,
      runtimeNodeCount: expectedRuntimeNodes,
      sessionCount: expectedSessions,
    },
    { timeout: 45_000 },
  );

  const sessionList = page.getByTestId("session-list");
  const fleetList = page.getByTestId("fleet-list");
  await sessionList.waitFor({ state: "visible", timeout: 15_000 });
  await fleetList.waitFor({ state: "visible", timeout: 15_000 });

  const navigationBefore = await navigationMetrics(page);
  assert(navigationBefore.session.verticalOverflow, "100 sessions did not overflow their own list");
  assert(navigationBefore.fleet.verticalOverflow, "10 runtimes did not overflow their own fleet list");
  assert(navigationBefore.fleet.fullyInViewport, "the pinned Fleet region is outside the viewport");
  assert(!navigationBefore.session.horizontalOverflow, "the session list has horizontal overflow");
  assert(!navigationBefore.fleet.horizontalOverflow, "the Fleet list has horizontal overflow");
  const sessionRowHeights = await page.getByTestId("session-card").evaluateAll((rows) =>
    [...new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height)))],
  );
  assert(
    sessionRowHeights.length === 1 && sessionRowHeights[0] === 72,
    `session rows are not a stable 72px: ${sessionRowHeights.join(", ")}`,
  );

  const independentScrolling = await page.evaluate(() => {
    const sessions = document.querySelector('[data-testid="session-list"]');
    const fleet = document.querySelector('[data-testid="fleet-list"]');
    if (!(sessions instanceof HTMLElement) || !(fleet instanceof HTMLElement)) return null;
    sessions.scrollTop = sessions.scrollHeight;
    const sessionScrollTop = sessions.scrollTop;
    const fleetTopBefore = fleet.getBoundingClientRect().top;
    fleet.scrollTop = fleet.scrollHeight;
    return {
      sessionScrollTop,
      sessionScrollTopAfterFleetScroll: sessions.scrollTop,
      fleetScrollTop: fleet.scrollTop,
      fleetTopBefore,
      fleetTopAfter: fleet.getBoundingClientRect().top,
    };
  });
  assert(independentScrolling, "navigation scroll regions are missing");
  assert(independentScrolling.sessionScrollTop > 0, "the session list did not scroll");
  assert(independentScrolling.fleetScrollTop > 0, "the Fleet list did not scroll");
  assert(
    independentScrolling.sessionScrollTopAfterFleetScroll === independentScrolling.sessionScrollTop,
    "scrolling Fleet moved the session list",
  );
  assert(
    Math.abs(independentScrolling.fleetTopAfter - independentScrolling.fleetTopBefore) < 1,
    "the pinned Fleet region moved with the session list",
  );

  const expectedLastTitle = `Mock scale 09/09 ${runId}`;
  const searchStartedAt = performance.now();
  await page.getByLabel("Search agents", { exact: true }).fill(expectedLastTitle);
  await page.waitForFunction(
    (title) => {
      const cards = [...document.querySelectorAll('[data-testid="session-card"]')];
      return cards.length === 1 && (cards[0]?.textContent ?? "").includes(title);
    },
    expectedLastTitle,
    { timeout: 5_000 },
  );
  const searchLatencyMs = Math.round((performance.now() - searchStartedAt) * 100) / 100;
  const matchingCard = page.getByTestId("session-card").filter({ hasText: expectedLastTitle });
  const selectedSessionId = await matchingCard.getAttribute("data-session-id");
  assert(selectedSessionId, "the filtered session omitted its logical session ID");
  const selectionStartedAt = performance.now();
  await matchingCard.click();
  await page.getByTestId("selected-session-id").filter({ hasText: selectedSessionId }).waitFor({
    state: "visible",
    timeout: 5_000,
  });
  const selectionLatencyMs = Math.round((performance.now() - selectionStartedAt) * 100) / 100;
  assert(searchLatencyMs < 1_000, `session search took ${searchLatencyMs}ms`);
  assert(selectionLatencyMs < 1_000, `session selection took ${selectionLatencyMs}ms`);
  assert((await fleetList.boundingBox()) !== null, "Fleet disappeared while filtering sessions");
  assert(await page.getByTestId("prompt-input").isVisible(), "conversation became unavailable while navigating the fleet");

  await page.getByLabel("Search agents", { exact: true }).fill("");
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-testid="session-card"]').length === count,
    expectedSessions,
    { timeout: 5_000 },
  );
  await page.evaluate(() => {
    const sessions = document.querySelector('[data-testid="session-list"]');
    const fleet = document.querySelector('[data-testid="fleet-list"]');
    if (sessions instanceof HTMLElement) sessions.scrollTop = 0;
    if (fleet instanceof HTMLElement) fleet.scrollTop = 0;
  });

  const navigationAfter = await navigationMetrics(page);
  const documentOverflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 ||
    document.body.scrollWidth > document.body.clientWidth + 1
  );
  assert(!documentOverflow, "the 100-session dashboard has document-level horizontal overflow");

  const axe = await new AxeBuilder({ page }).analyze();
  const accessibilityViolations = axe.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.length,
    }));
  assert(
    accessibilityViolations.length === 0,
    `dashboard has serious/critical accessibility violations: ${accessibilityViolations
      .map((violation) => violation.id).join(", ")}`,
  );

  const visible = await page.evaluate(({ prefix, receiptRunId }) => {
    const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? null;
    const runtimeNodes = [...document.querySelectorAll('[data-testid="runtime-node-card"]')].filter(
      (card) => (card.textContent ?? "").includes(prefix),
    );
    const sessions = [...document.querySelectorAll('[data-testid="session-card"]')].filter(
      (card) => (card.textContent ?? "").includes(receiptRunId),
    );
    return {
      heading: normalize(document.querySelector("header")?.textContent),
      runtimeNodeCardCount: runtimeNodes.length,
      onlineRuntimeNodeCardCount: runtimeNodes.filter((card) =>
        (card.textContent ?? "").includes("online"),
      ).length,
      sessionCardCount: sessions.length,
      activeIdleSessionCardCount: sessions.filter((card) => {
        const text = card.textContent ?? "";
        return text.includes("active") && text.includes("idle");
      }).length,
      firstRuntimeNode: normalize(runtimeNodes[0]?.textContent),
      lastRuntimeNode: normalize(runtimeNodes.at(-1)?.textContent),
      firstSession: normalize(sessions[0]?.textContent),
      lastSession: normalize(sessions.at(-1)?.textContent),
      streamStatus: normalize(document.querySelector('[data-testid="stream-status"]')?.textContent),
    };
  }, { prefix: runtimeNodePrefix, receiptRunId: runId });

  await page.screenshot({ path: screenshotPath, fullPage: false });
  await appendFile(
    consolePath,
    `${browserMessages.length > 0 ? browserMessages.join("\n") : "no browser console messages"}\n`,
    "utf8",
  );
  if (browserErrors.length > 0) {
    throw new Error(`dashboard emitted browser errors: ${browserErrors.join("; ")}`);
  }
  console.log(
    JSON.stringify(
      {
        url,
        screenshotPath,
        viewport: { width: 1800, height: 1200 },
        assertions: {
          exactRuntimeNodeCards: true,
          everyRuntimeNodeOnline: true,
          exactSessionCards: true,
          everySessionActiveAndIdle: true,
          browserConsoleErrors: 0,
          fleetPinnedAndReachable: true,
          sessionAndFleetScrollIndependently: true,
          searchNarrowsToOneSession: true,
          selectionRemainsInteractive: true,
          stableSessionRowHeight: true,
          conversationRemainsAvailable: true,
          searchAndSelectionRespondWithinOneSecond: true,
          noDocumentOverflow: true,
          noSeriousOrCriticalAccessibilityViolations: true,
        },
        navigation: {
          before: navigationBefore,
          after: navigationAfter,
          independentScrolling,
          sessionRowHeights,
        },
        interactionLatencyMs: {
          search: searchLatencyMs,
          selection: selectionLatencyMs,
        },
        accessibilityViolations,
        visible,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}

async function navigationMetrics(page) {
  return page.evaluate(() => {
    const measure = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        verticalOverflow: element.scrollHeight > element.clientHeight + 1,
        horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
        fullyInViewport: rect.top >= -1 && rect.bottom <= window.innerHeight + 1 &&
          rect.left >= -1 && rect.right <= window.innerWidth + 1,
      };
    };
    return {
      session: measure('[data-testid="session-list"]'),
      fleet: measure('[data-testid="fleet-list"]'),
    };
  }).then((result) => {
    assert(result.session, "session list metrics are unavailable");
    assert(result.fleet, "Fleet list metrics are unavailable");
    return result;
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
