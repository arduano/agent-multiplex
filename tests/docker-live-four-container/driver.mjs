#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { AxeBuilder } from "@axe-core/playwright";

import { assessBrowserErrors } from "./browser-error-assessment.mjs";

const argv = process.argv.slice(2);
if (argv.length !== 10) {
  throw new Error(
    "usage: driver.mjs <gateway-url> <receipt-dir> <run-id> " +
      "<codex-runtime-name> <copilot-runtime-name> <codex-model> " +
      "<codex-second-model> <copilot-model> <timeout-ms> <soak-ms>",
  );
}
const [
  gatewayUrl,
  rawReceiptDirectory,
  runId,
  codexRuntimeName,
  copilotRuntimeName,
  codexModel,
  codexSecondModel,
  copilotModel,
  rawTimeoutMs,
  rawSoakMs,
] = argv;
const timeoutMs = positiveInteger(rawTimeoutMs, "timeout-ms");
const soakMs = nonNegativeInteger(rawSoakMs, "soak-ms");
const receiptDirectory = resolve(rawReceiptDirectory);
const tokenFile = process.env.AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE;
if (!tokenFile) {
  throw new Error("AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE is required");
}
const bearerToken = (await readFile(tokenFile, "utf8")).trim();
if (!bearerToken || /\s/.test(bearerToken)) {
  throw new Error("acceptance bearer token is empty or contains whitespace");
}
const terminalMarkerFile = process.env.AGENT_MULTIPLEX_ACCEPTANCE_TERMINAL_MARKER_FILE;
if (!terminalMarkerFile) {
  throw new Error("AGENT_MULTIPLEX_ACCEPTANCE_TERMINAL_MARKER_FILE is required");
}

const nonce = randomMarker();
const markers = Object.freeze({
  codex:
    `LIVE_CODEX_${nonce}_ALPHA_BRAVO_CHARLIE_DELTA_ECHO_FOXTROT_GOLF_HOTEL`,
  copilot:
    `LIVE_COPILOT_${nonce}_INDIA_JULIET_KILO_LIMA_MIKE_NOVEMBER_OSCAR_PAPA`,
  planAnswer: `typed-answer-${nonce.toLowerCase()}`,
  planFinal: `PLAN_ANSWER_${nonce}:typed-answer-${nonce.toLowerCase()}`,
  interruptPrefix: `LIVE_INTERRUPT_${nonce}`,
  interruptFinished: `LIVE_INTERRUPT_FINISHED_${nonce}`,
  terminalEphemeral: `PTY_ONLY_${nonce}_NOT_SUBMITTED`,
  terminalSemanticReply: `TUI_REPLY_${nonce}`,
  postTerminalStructured:
    `LIVE_AFTER_TUI_${nonce}_STRUCTURED_CHANNEL_STILL_AVAILABLE`,
  postSoakCodex: `LIVE_POST_SOAK_CODEX_${nonce}_QUEBEC_ROMEO_SIERRA_TANGO`,
  postSoakCopilot: `LIVE_POST_SOAK_COPILOT_${nonce}_UNIFORM_VICTOR_WHISKEY_XRAY`,
});
const initialTitles = Object.freeze({
  codex: `Live Codex ${runId}`,
  copilot: `Live Copilot ${runId}`,
});
const finalTitles = Object.freeze({
  codex: `${initialTitles.codex} · metadata saved`,
  copilot: `${initialTitles.copilot} · metadata saved`,
});
const directLaunchProfile = Object.freeze({
  providerId: "core.direct",
  profileId: "workspace",
  displayLabel: "core.direct / workspace",
});
const prompts = Object.freeze({
  codex: `Reply with exactly ${markers.codex} and nothing else.`,
  copilot: `Reply with exactly ${markers.copilot} and nothing else.`,
  plan:
    "This is an interactive transport receipt. In Plan mode, call " +
    "request_user_input exactly once before replying. Use question id " +
    "receipt_choice, header Receipt, question 'Choose the receipt value', " +
    "isOther true, and exactly two options Alpha and Beta. After receiving " +
    `the typed answer, reply with exactly PLAN_ANSWER_${nonce}:<typed answer> ` +
    "and nothing else.",
  interrupt:
    "Execute exactly this shell command and wait for it to finish: " +
    `for i in $(seq 1 120); do printf '${markers.interruptPrefix}_%03d\\n' "$i"; ` +
    `sleep 1; done After it finishes, reply with exactly ${markers.interruptFinished}.`,
  terminalSemantic:
    "Concatenate these two strings and reply with only the result: " +
    `\"TUI_REPLY_\" and \"${nonce}\". Do not use tools.`,
  postTerminalStructured:
    `Reply with exactly ${markers.postTerminalStructured} and nothing else.`,
  postSoakCodex: `Reply with exactly ${markers.postSoakCodex} and nothing else.`,
  postSoakCopilot: `Reply with exactly ${markers.postSoakCopilot} and nothing else.`,
});
await writeFile(terminalMarkerFile, markers.terminalEphemeral, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
const paths = {
  result: join(receiptDirectory, "phases", "browser-ui.json"),
  actionLog: join(receiptDirectory, "logs", "browser-actions.ndjson"),
  console: join(receiptDirectory, "logs", "browser-console.txt"),
  failure: join(receiptDirectory, "browser-failure.json"),
  topologyScreenshot: join(receiptDirectory, "screenshots", "01-live-topology.png"),
  codexScreenshot: join(receiptDirectory, "screenshots", "02-codex-chat-metadata.png"),
  copilotScreenshot: join(receiptDirectory, "screenshots", "03-copilot-chat-metadata.png"),
  planScreenshot: join(receiptDirectory, "screenshots", "04-codex-plan-question.png"),
  interruptScreenshot: join(receiptDirectory, "screenshots", "05-codex-command-running.png"),
  terminalScreenshot: join(receiptDirectory, "screenshots", "06-codex-native-terminal.png"),
  terminalObserverScreenshot: join(
    receiptDirectory,
    "screenshots",
    "07-codex-terminal-read-only-observer.png",
  ),
  terminalExitedScreenshot: join(
    receiptDirectory,
    "screenshots",
    "08-codex-terminal-terminated.png",
  ),
  postTerminalChatScreenshot: join(
    receiptDirectory,
    "screenshots",
    "09-codex-chat-after-terminal.png",
  ),
  copilotTerminalScreenshot: join(
    receiptDirectory,
    "screenshots",
    "10-copilot-terminal-disabled.png",
  ),
  reloadScreenshot: join(receiptDirectory, "screenshots", "11-reloaded-native-history.png"),
  postSoakCodexScreenshot: join(
    receiptDirectory,
    "screenshots",
    "12-post-soak-codex-chat.png",
  ),
  postSoakCopilotScreenshot: join(
    receiptDirectory,
    "screenshots",
    "13-post-soak-copilot-chat.png",
  ),
  fleetEvents: join(receiptDirectory, "logs", "fleet-events.ndjson"),
};
const responsiveViewports = Object.freeze([
  { name: "acceptance", width: 1720, height: 1180, mode: "desktop" },
  { name: "desktop", width: 1440, height: 900, mode: "desktop" },
  { name: "compact", width: 1024, height: 768, mode: "compact" },
  { name: "tablet", width: 768, height: 1024, mode: "compact" },
  { name: "phone-portrait", width: 390, height: 844, mode: "mobile" },
  { name: "phone-landscape", width: 844, height: 390, mode: "mobile" },
]);
await Promise.all(
  Object.values(paths).map((filename) => mkdir(dirname(filename), { recursive: true })),
);

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

const browserMessages = [];
const browserErrors = [];
const failedRequests = [];
const accessCalls = [];
const browser = await chromium.launch({ headless: true, executablePath: chromeExecutable });
let context;
let page;
let observerPage;

try {
  context = await browser.newContext({
    viewport: { width: 1720, height: 1180 },
  });
  page = await context.newPage();
  registerPageDiagnostics(page, "operator");

  await action("open and authenticate the gateway UI", async () => {
    await page.goto(gatewayUrl, { waitUntil: "networkidle", timeout: 30_000 });
    await page.getByTestId("auth-token").fill(bearerToken);
    await page.getByTestId("connect-button").click();
    await page.getByTestId("global-status").filter({ hasText: "connected" }).waitFor({
      timeout: 30_000,
    });
  });

  await action("observe both harness-specific runtime nodes", async () => {
    await page.waitForFunction(
      ({ codexName, copilotName }) => {
        const cards = [...document.querySelectorAll('[data-testid="runtime-node-card"]')];
        const codex = cards.find((card) => (card.textContent ?? "").includes(codexName));
        const copilot = cards.find((card) => (card.textContent ?? "").includes(copilotName));
        return cards.length === 2 &&
          (codex?.textContent ?? "").includes("online") &&
          (codex?.textContent ?? "").includes("codex") &&
          (copilot?.textContent ?? "").includes("online") &&
          (copilot?.textContent ?? "").includes("copilot");
      },
      { codexName: codexRuntimeName, copilotName: copilotRuntimeName },
      { timeout: timeoutMs },
    );
  });
  await page.screenshot({ path: paths.topologyScreenshot, fullPage: true });

  const codexSessionId = await spawnThroughUi({
    harness: "codex",
    runtimeName: codexRuntimeName,
    model: codexModel,
    title: initialTitles.codex,
  });
  const copilotSessionId = await spawnThroughUi({
    harness: "copilot",
    runtimeName: copilotRuntimeName,
    model: copilotModel,
    title: initialTitles.copilot,
  });
  assert(codexSessionId !== copilotSessionId, "the two UI spawns returned one logical session ID");

  await editMetadataThroughUi({
    harness: "codex",
    sessionId: codexSessionId,
    finalTitle: finalTitles.codex,
  });
  await sendThroughUi({
    harness: "codex",
    sessionId: codexSessionId,
    prompt: prompts.codex,
    marker: markers.codex,
  });
  await page.screenshot({ path: paths.codexScreenshot, fullPage: true });

  await editMetadataThroughUi({
    harness: "copilot",
    sessionId: copilotSessionId,
    finalTitle: finalTitles.copilot,
  });
  await sendThroughUi({
    harness: "copilot",
    sessionId: copilotSessionId,
    prompt: prompts.copilot,
    marker: markers.copilot,
  });
  await page.screenshot({ path: paths.copilotScreenshot, fullPage: true });

  const codexControls = await exerciseCodexControls(codexSessionId);
  const codexTerminal = await exerciseCodexTerminal(codexSessionId);
  const copilotTerminal = await verifyCopilotTerminalDisabled(copilotSessionId);

  const historyCallsBeforeReload = accessCalls.filter(isNativeHistoryCall).length;
  await action("reload and rehydrate both chats from native history", async () => {
    await page.reload({ waitUntil: "networkidle", timeout: 30_000 });
    await page.getByTestId("global-status").filter({ hasText: "connected" }).waitFor({
      timeout: 30_000,
    });
    assert(
      new URLSearchParams(new URL(page.url()).hash.slice(1)).get("token") === bearerToken,
      "prototype token fragment was not retained across reload",
    );
    await selectSession(codexSessionId);
    await page.getByTestId("history-status").filter({ hasText: "loaded" }).waitFor({
      timeout: timeoutMs,
    });
    await waitForChatMessage("assistant", markers.codex, timeoutMs);
    await waitForChatMessage("assistant", markers.planFinal, timeoutMs);
    await waitForChatMessage("assistant", markers.postTerminalStructured, timeoutMs);
    await openAgentSettings("model-select");
    await waitFor("persisted Codex model after reload", timeoutMs, async () =>
      await page.getByTestId("model-select").inputValue() === codexSecondModel
    );
    const appliedSettings = (await page.getByTestId("applied-settings-summary").textContent())
      ?.replace(/\s+/g, " ").trim() ?? "";
    assert(
      !appliedSettings.includes("Model unavailable"),
      `reloaded Codex applied settings lost the model: ${appliedSettings}`,
    );
    codexControls.model.persistedAfterReload = true;
    await page.keyboard.press("Escape");
    await selectSession(copilotSessionId);
    await page.getByTestId("history-status").filter({ hasText: "loaded" }).waitFor({
      timeout: timeoutMs,
    });
    await waitForChatMessage("assistant", markers.copilot, timeoutMs);
    await waitFor(
      "two post-reload native-history calls",
      timeoutMs,
      () => accessCalls.filter(isNativeHistoryCall).length >= historyCallsBeforeReload + 2,
    );
  });
  await page.screenshot({ path: paths.reloadScreenshot, fullPage: true });

  const responsive = await action("verify responsive layout and accessibility", async () =>
    verifyResponsiveUi(copilotSessionId));
  await page.setViewportSize({ width: 1720, height: 1180 });

  let soak = {
    requestedMs: soakMs,
    performed: false,
    startedAt: null,
    completedAt: null,
    elapsedMs: 0,
    replies: null,
    sourceSelected: null,
    bothRuntimesOnline: null,
    bothSessionsRetained: null,
    bothRepliesStreamed: null,
  };
  if (soakMs > 0) {
    const soakStartedAt = now();
    const soakStartedMs = Date.now();
    await action(`hold the live topology for ${soakMs}ms`, async () => {
      await delay(soakMs);
    });
    const elapsedMs = Date.now() - soakStartedMs;

    await action("verify topology and stream both harnesses after the soak", async () => {
      await page.getByTestId("global-status").filter({ hasText: "connected" }).waitFor({
        timeout: 30_000,
      });
      await page.waitForFunction(
        ({ codexName, copilotName, codexId, copilotId }) => {
          const sources = [...document.querySelectorAll('[data-testid="source-card"]')];
          const runtimes = [...document.querySelectorAll('[data-testid="runtime-node-card"]')];
          const sessions = [...document.querySelectorAll('[data-testid="session-card"]')];
          const codex = runtimes.find((card) => (card.textContent ?? "").includes(codexName));
          const copilot = runtimes.find((card) => (card.textContent ?? "").includes(copilotName));
          const sessionIds = new Set(sessions.map((card) => card.getAttribute("data-session-id")));
          return sources.length === 1 &&
            sources[0]?.getAttribute("data-source-state") === "selected" &&
            runtimes.length === 2 &&
            (codex?.textContent ?? "").includes("online") &&
            (codex?.textContent ?? "").includes("reachable") &&
            (copilot?.textContent ?? "").includes("online") &&
            (copilot?.textContent ?? "").includes("reachable") &&
            sessions.length === 2 &&
            sessionIds.has(codexId) &&
            sessionIds.has(copilotId);
        },
        {
          codexName: codexRuntimeName,
          copilotName: copilotRuntimeName,
          codexId: codexSessionId,
          copilotId: copilotSessionId,
        },
        { timeout: timeoutMs },
      );
      await sendThroughUi({
        harness: "codex",
        sessionId: codexSessionId,
        prompt: prompts.postSoakCodex,
        marker: markers.postSoakCodex,
      });
      await page.screenshot({ path: paths.postSoakCodexScreenshot, fullPage: true });
      await sendThroughUi({
        harness: "copilot",
        sessionId: copilotSessionId,
        prompt: prompts.postSoakCopilot,
        marker: markers.postSoakCopilot,
      });
    });
    await page.screenshot({ path: paths.postSoakCopilotScreenshot, fullPage: true });
    soak = {
      requestedMs: soakMs,
      performed: true,
      startedAt: soakStartedAt,
      completedAt: now(),
      elapsedMs,
      replies: {
        codex: {
          prompt: prompts.postSoakCodex,
          marker: markers.postSoakCodex,
          streamed: true,
        },
        copilot: {
          prompt: prompts.postSoakCopilot,
          marker: markers.postSoakCopilot,
          streamed: true,
        },
      },
      sourceSelected: true,
      bothRuntimesOnline: true,
      bothSessionsRetained: true,
      bothRepliesStreamed: true,
    };
  }

  const visible = await page.evaluate(() => {
    const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? null;
    return {
      globalStatus: normalize(document.querySelector('[data-testid="global-status"]')?.textContent),
      runtimeNodeCards: [...document.querySelectorAll('[data-testid="runtime-node-card"]')]
        .map((element) => normalize(element.textContent)),
      sessionCards: [...document.querySelectorAll('[data-testid="session-card"]')]
        .map((element) => ({
          sessionId: element.getAttribute("data-session-id"),
          harness: element.getAttribute("data-harness"),
          text: normalize(element.textContent),
        })),
      selectedSessionId: normalize(
        document.querySelector('[data-testid="selected-session-id"]')?.textContent,
      ),
      streamStatus: normalize(document.querySelector('[data-testid="stream-status"]')?.textContent),
      historyStatus: normalize(document.querySelector('[data-testid="history-status"]')?.textContent),
      chatMessages: [...document.querySelectorAll('[data-testid="chat-message"]')]
        .slice(-12)
        .map((element) => ({
          role: element.getAttribute("data-role"),
          text: normalize(element.textContent),
        })),
      metadataStatus: normalize(
        document.querySelector('[data-testid="metadata-status"]')?.textContent,
      ),
    };
  });

  const browserErrorAssessment = assessBrowserErrors(browserErrors, accessCalls);

  const result = {
    passed: true,
    runId,
    completedAt: now(),
    viewport: { width: 1720, height: 1180 },
    topology: {
      codexRuntimeName,
      copilotRuntimeName,
      exactRuntimeNodeCards: 2,
    },
    sessions: {
      codex: {
        sessionId: codexSessionId,
        initialTitle: initialTitles.codex,
        finalTitle: finalTitles.codex,
        launchProfile: directLaunchProfile,
        launchInput: {
          cwd: "/workspace/project",
          model: codexModel,
          effort: "medium",
        },
        model: codexModel,
        secondModel: codexSecondModel,
        prompt: prompts.codex,
        marker: markers.codex,
        controls: codexControls,
        terminal: codexTerminal,
      },
      copilot: {
        sessionId: copilotSessionId,
        initialTitle: initialTitles.copilot,
        finalTitle: finalTitles.copilot,
        launchProfile: directLaunchProfile,
        launchInput: {
          cwd: "/workspace/project",
          model: copilotModel,
          reasoningEffort: "medium",
          mode: "interactive",
        },
        model: copilotModel,
        prompt: prompts.copilot,
        marker: markers.copilot,
        terminal: copilotTerminal,
      },
    },
    soak,
    responsive,
    assertions: {
      browserAuthenticatedToGateway: true,
      bothRuntimesVisibleAndOnline: true,
      bothSessionsSpawnedThroughUi: true,
      bothMetadataDocumentsEditedThroughUi: true,
      bothPromptsSentThroughUi: true,
      bothAssistantMarkersVisibleInChat: true,
      codexModelSwitchedThroughUi: true,
      codexPlanModeSetThroughUi: true,
      codexPlanQuestionAnsweredThroughUi: true,
      codexPlanTypedAnswerVisibleInChat: true,
      codexReturnedToDefaultModeThroughUi: true,
      codexActiveTurnInterruptedThroughUi: true,
      codexLongCommandStoppedEarly: codexControls.interrupt.maximumObservedTick < 120,
      codexModelPersistedAfterReload:
        codexControls.model.persistedAfterReload === true,
      codexChatWasDefaultBeforeTerminal: codexTerminal.chatDefaultBeforeOpen,
      codexTerminalOpenedThroughUi: codexTerminal.openedThroughUi,
      codexTerminalUsedStockRemoteTui: codexTerminal.backend === "codex-remote",
      codexTerminalHadTwoReadOnlyViewers:
        codexTerminal.secondObserver.attachedReadOnly === true &&
        codexTerminal.secondObserver.initialStateConverged === true,
      codexTerminalKeyboardLeaseAcquired:
        codexTerminal.keyboard.singleWriterObserved === true &&
        codexTerminal.keyboard.renewalObserved === true,
      codexTerminalRawDraftStreamedToBothViewers:
        codexTerminal.ephemeralDraft.visibleToOperator === true &&
        codexTerminal.ephemeralDraft.visibleToObserver === true,
      codexTerminalRawDraftClearedWithoutSubmission:
        codexTerminal.ephemeralDraft.clearedBeforeSubmit === true,
      codexTerminalSemanticPromptCompleted:
        codexTerminal.semanticPrompt.replyVisibleToOperator === true &&
        codexTerminal.semanticPrompt.replyVisibleToObserver === true,
      codexTerminalResizePropagated:
        codexTerminal.resize.operatorChanged === true &&
        codexTerminal.resize.observerConverged === true,
      codexTerminalTerminatedThroughConfirmation:
        codexTerminal.termination.confirmed === true &&
        codexTerminal.termination.exited === true,
      codexStructuredChatWorkedAfterTerminalExit:
        codexTerminal.structuredAfterTermination.replyVisible === true,
      copilotTerminalDisabledByDefault:
        copilotTerminal.capabilityAdvertised === false &&
        copilotTerminal.warningVisible === true &&
        copilotTerminal.openActionAbsent === true,
      urlTokenAutoConnectedAfterReload: true,
      browserReloadHydratedBothNativeHistories: true,
      postReloadBothHistoryStatusesLoaded: true,
      postReloadNativeHistoryCalls: accessCalls.filter(isNativeHistoryCall).length -
        historyCallsBeforeReload,
      postSoakLivenessTested: soak.performed,
      postSoakSourceSelected: soak.sourceSelected,
      postSoakBothRuntimesOnline: soak.bothRuntimesOnline,
      postSoakBothSessionsRetained: soak.bothSessionsRetained,
      postSoakBothRepliesStreamed: soak.bothRepliesStreamed,
      browserConsoleErrors: browserErrors.length,
      recoveredTransientNativeHistoryErrors:
        browserErrorAssessment.recoveredTransientNativeHistoryErrors,
      unexpectedBrowserErrors: browserErrorAssessment.unexpectedBrowserErrors.length,
      unrecoveredTransientNativeHistoryCalls:
        browserErrorAssessment.unrecoveredTransientNativeHistoryCalls.length,
      failedSameOriginRequests: failedRequests.length,
      responsiveViewportsChecked: responsive.length,
      responsiveDocumentOverflows: responsive.filter((entry) => entry.documentOverflow).length,
      responsiveClippedEssentials: responsive.flatMap((entry) => entry.clippedEssentials).length,
      seriousOrCriticalAccessibilityViolations: responsive.flatMap((entry) =>
        entry.accessibilityViolations
      ).length,
    },
    browserErrorAssessment,
    accessCalls,
    screenshots: [
      "screenshots/01-live-topology.png",
      "screenshots/02-codex-chat-metadata.png",
      "screenshots/03-copilot-chat-metadata.png",
      "screenshots/04-codex-plan-question.png",
      "screenshots/05-codex-command-running.png",
      "screenshots/06-codex-native-terminal.png",
      "screenshots/07-codex-terminal-read-only-observer.png",
      "screenshots/08-codex-terminal-terminated.png",
      "screenshots/09-codex-chat-after-terminal.png",
      "screenshots/10-copilot-terminal-disabled.png",
      "screenshots/11-reloaded-native-history.png",
      ...(soak.performed
        ? [
          "screenshots/12-post-soak-codex-chat.png",
          "screenshots/13-post-soak-copilot-chat.png",
        ]
        : []),
      ...responsive.map((entry) => entry.screenshot),
    ],
    visible,
    credentialMaterialRecorded: false,
  };
  assert(
    browserErrorAssessment.unexpectedBrowserErrors.length === 0,
    `browser emitted unexpected errors: ${browserErrorAssessment.unexpectedBrowserErrors.join("; ")}`,
  );
  assert(
    browserErrorAssessment.unrecoveredTransientNativeHistoryCalls.length === 0,
    "a transient native-history response did not recover within the bounded retry window",
  );
  assert(
    failedRequests.length === 0,
    `same-origin browser requests failed: ${failedRequests.join("; ")}`,
  );
  await writeJson(paths.result, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const failure = {
    failedAt: now(),
    error: errorText(error),
    accessCalls,
    browserErrors,
    failedRequests,
    credentialMaterialRecorded: false,
  };
  await writeJson(paths.failure, failure).catch(() => undefined);
  if (page) {
    await page.screenshot({
      path: join(receiptDirectory, "screenshots", "FAILED-browser-state.png"),
      fullPage: true,
    }).catch(() => undefined);
  }
  if (observerPage) {
    await observerPage.bringToFront().catch(() => undefined);
    await observerPage.screenshot({
      path: join(receiptDirectory, "screenshots", "FAILED-browser-observer-state.png"),
      fullPage: true,
    }).catch(() => undefined);
  }
  throw error;
} finally {
  await appendFile(
    paths.console,
    `${browserMessages.length > 0 ? browserMessages.join("\n") : "no browser console messages"}\n`,
    "utf8",
  ).catch(() => undefined);
  await observerPage?.close().catch(() => undefined);
  await context?.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}

async function spawnThroughUi({ harness, runtimeName, model, title }) {
  return action(`spawn ${harness} through the UI`, async () => {
    await page.getByTestId("spawn-button").click();
    const dialog = page.getByTestId("spawn-dialog");
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    const runtimeSelect = page.getByTestId("spawn-runtime-select");
    await setControl(runtimeSelect, runtimeName, timeoutMs, true);
    const selectedRuntimeName = (await runtimeSelect.locator("option:checked").textContent())
      ?.replace(/\s+/g, " ").trim();
    assert(
      selectedRuntimeName === runtimeName,
      `${harness} launch selected unexpected runtime ${selectedRuntimeName ?? "<none>"}`,
    );
    const harnessSelect = page.getByTestId("spawn-harness-select");
    await setControl(harnessSelect, harness, timeoutMs, false);
    assert(
      await harnessSelect.inputValue() === harness,
      `${harness} launch did not retain its harness selection`,
    );
    // A v4 launch is fenced by a runtime-advertised profile. Wait for that
    // asynchronous discovery before selecting a profile-specific model or
    // submitting, and select the exact reference profile rather than relying
    // on provider registration or sort order.
    const profile = page.getByTestId("spawn-profile-select");
    await waitFor("direct workspace launch profile", timeoutMs, async () => {
      if (!await profile.isEnabled()) return false;
      return profile.locator("option").evaluateAll(
        (options, label) => options.some((option) => option.textContent?.trim() === label),
        directLaunchProfile.displayLabel,
      );
    });
    await setControl(profile, directLaunchProfile.displayLabel, timeoutMs, false);
    const selectedProfileLabel = (await profile.locator("option:checked").textContent())
      ?.replace(/\s+/g, " ").trim();
    assert(
      selectedProfileLabel === directLaunchProfile.displayLabel,
      `${harness} launch selected unexpected profile ${selectedProfileLabel ?? "<none>"}`,
    );
    await page.getByTestId("spawn-cwd-input").fill("/workspace/project");
    await setControl(page.getByTestId("spawn-model-select"), model, timeoutMs, false);
    await setControl(page.getByTestId("spawn-mode-select"), "default", timeoutMs, false);
    await setControl(page.getByTestId("spawn-effort-select"), "medium", timeoutMs, false);
    assert(
      await page.getByTestId("spawn-model-select").inputValue() === model,
      `${harness} launch did not retain requested model ${model}`,
    );
    await page.getByTestId("spawn-title-input").fill(title);
    await page.getByTestId("spawn-submit").click();

    const card = page.getByTestId("session-card").filter({ hasText: title });
    await card.waitFor({ state: "visible", timeout: timeoutMs });
    await card.click();
    const sessionId = (await page.getByTestId("selected-session-id").textContent())?.trim();
    assert(sessionId, `${harness} UI spawn did not expose a selected session ID`);
    const status = await optionalText(page.getByTestId("spawn-status"));
    assert(!/(?:failed|error|outcome.?unknown)/i.test(status ?? ""), `${harness} spawn status: ${status}`);
    return sessionId;
  });
}

async function editMetadataThroughUi({ harness, sessionId, finalTitle }) {
  return action(`edit ${harness} metadata through the UI`, async () => {
    await selectSession(sessionId);
    await page.getByTestId("metadata-editor").waitFor({ state: "visible", timeout: 15_000 });
    const editor = page.getByTestId("metadata-json");
    await editor.waitFor({ state: "visible", timeout: 15_000 });
    const current = await waitForJsonEditor(editor, timeoutMs);
    const next = {
      ...current,
      "agent.title": finalTitle,
      "receipt.live": {
        runId,
        harness,
        source: "browser-ui",
      },
    };
    await editor.fill(JSON.stringify(next, null, 2));
    await page.getByTestId("metadata-save").click();
    await page.getByTestId("session-card").filter({ hasText: finalTitle }).waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    await waitFor("metadata editor to reflect its committed value", timeoutMs, async () => {
      try {
        const value = JSON.parse(await editor.inputValue());
        return value["agent.title"] === finalTitle &&
          value["receipt.live"]?.runId === runId &&
          value["receipt.live"]?.harness === harness;
      } catch {
        return false;
      }
    });
    const status = await optionalText(page.getByTestId("metadata-status"));
    assert(!/(?:failed|error|conflict|outcome.?unknown)/i.test(status ?? ""), `${harness} metadata status: ${status}`);
  });
}

async function sendThroughUi({ harness, sessionId, prompt, marker }) {
  return action(`send and render ${harness} chat`, async () => {
    await selectSession(sessionId);
    await page.getByTestId("stream-status").filter({ hasText: "live" }).waitFor({
      timeout: 30_000,
    });
    const composer = page.getByTestId("prompt-input");
    await composer.fill(prompt);
    await page.getByTestId("send-button").click();
    await waitForChatMessage("user", prompt, timeoutMs);
    await waitForChatMessage("assistant", marker, timeoutMs);
    await page.getByTestId("history-status").filter({ hasText: "loaded" }).waitFor({
      timeout: 30_000,
    });
  });
}

async function exerciseCodexTerminal(sessionId) {
  return action("exercise the managed Codex terminal through two web clients", async () => {
    await selectSession(sessionId);
    const chatTab = page.getByTestId("session-chat-tab");
    assert(
      await chatTab.getAttribute("data-state") === "active",
      "Chat was not the default Codex workspace before opening the terminal",
    );
    assert(
      !await page.getByTestId("terminal-panel").isVisible().catch(() => false),
      "terminal panel was visible before the operator selected it",
    );

    await page.getByTestId("session-terminal-tab").click();
    const openButton = page.getByTestId("terminal-open-button");
    await openButton.waitFor({ state: "visible", timeout: 30_000 });
    await openButton.click();
    await page.getByTestId("terminal-toolbar").filter({ hasText: "Native Codex TUI" }).waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    await page.getByTestId("terminal-stream-status").filter({ hasText: "Stream live" }).waitFor({
      timeout: timeoutMs,
    });
    const operatorTextarea = terminalTextarea(page);
    await operatorTextarea.waitFor({ state: "attached", timeout: 30_000 });
    await waitFor("stock Codex TUI to render its first screen", 30_000, async () =>
      (await terminalScreenText(page)).replace(/\u00a0/g, " ").trim().length > 10
    );

    observerPage = await context.newPage();
    registerPageDiagnostics(observerPage, "read-only-observer");
    await observerPage.goto(gatewayUrl, { waitUntil: "networkidle", timeout: 30_000 });
    await observerPage.getByTestId("auth-token").fill(bearerToken);
    await observerPage.getByTestId("connect-button").click();
    await observerPage.getByTestId("global-status").filter({ hasText: "connected" }).waitFor({
      timeout: 30_000,
    });
    await selectSessionOn(observerPage, sessionId);
    assert(
      await observerPage.getByTestId("session-chat-tab").getAttribute("data-state") === "active",
      "Chat was not the second viewer's default workspace",
    );
    await observerPage.getByTestId("session-terminal-tab").click();
    await observerPage.getByTestId("terminal-toolbar").filter({ hasText: "Native Codex TUI" })
      .waitFor({ state: "visible", timeout: timeoutMs });
    await observerPage.getByTestId("terminal-stream-status").filter({ hasText: "Stream live" })
      .waitFor({ timeout: timeoutMs });
    assert(
      (await observerPage.getByTestId("terminal-stream-status").textContent())?.includes("Read only"),
      "second terminal viewer was not read-only before lease acquisition",
    );
    await waitFor("late terminal viewer to reconstruct the exact initial state", 30_000, async () => {
      const [operatorScreen, observerScreen] = await Promise.all([
        terminalScreenText(page),
        terminalScreenText(observerPage),
      ]);
      return operatorScreen.length > 10 && observerScreen === operatorScreen;
    });

    const leaseAccessCheckpoint = accessCalls.length;
    await page.getByTestId("terminal-take-keyboard").click();
    await page.getByTestId("terminal-release-keyboard").waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await page.getByTestId("terminal-stream-status").filter({ hasText: "Keyboard active" }).waitFor({
      timeout: 30_000,
    });
    await observerPage.getByTestId("terminal-take-keyboard").filter({ hasText: "Take over" })
      .waitFor({ state: "visible", timeout: 30_000 });
    await observerPage.getByTestId("terminal-stream-status")
      .filter({ hasText: "another viewer holds the keyboard" })
      .waitFor({ timeout: 30_000 });
    await waitFor("renewed Codex terminal keyboard lease", 20_000, () =>
      accessCalls.slice(leaseAccessCheckpoint).some((call) =>
        call.client === "operator" && call.path.includes("terminals.lease.renew") &&
        call.status >= 200 && call.status < 300
      )
    );
    await page.getByTestId("terminal-stream-status").filter({ hasText: "Keyboard active" }).waitFor({
      timeout: 15_000,
    });

    await operatorTextarea.focus();
    const canaryInputCheckpoint = terminalInputCallCount();
    // Playwright's insertText dispatches only an InputEvent, which xterm does
    // not interpret as terminal input. Exercise xterm's real paste event so
    // this remains one ordered terminal frame, just like an operator paste.
    await pasteTerminalText(operatorTextarea, markers.terminalEphemeral);
    await Promise.all([
      waitForTerminalText(page, markers.terminalEphemeral, true, timeoutMs),
      waitForTerminalText(observerPage, markers.terminalEphemeral, true, timeoutMs),
    ]);
    assert(
      terminalInputCallCount() - canaryInputCheckpoint === 1,
      "terminal canary was not transported as one auditable input frame",
    );

    // The draft is a raw PTY-only canary. Delete every ASCII cell before Enter
    // so the harness never receives it as semantic session input.
    for (let index = 0; index < markers.terminalEphemeral.length; index += 1) {
      await page.keyboard.press("Backspace");
    }
    await Promise.all([
      waitForTerminalText(page, markers.terminalEphemeral, false, 15_000),
      waitForTerminalText(observerPage, markers.terminalEphemeral, false, 15_000),
    ]);

    await pasteTerminalText(operatorTextarea, prompts.terminalSemantic);
    await page.keyboard.press("Enter");
    await Promise.all([
      waitForTerminalText(page, markers.terminalSemanticReply, true, timeoutMs),
      waitForTerminalText(observerPage, markers.terminalSemanticReply, true, timeoutMs),
    ]);

    const initialDimensions = await readTerminalDimensions(page);
    // Stay inside the desktop composition while exercising the live PTY
    // resize. Crossing a responsive-shell boundary intentionally remounts the
    // workspace and releases its exclusive keyboard lease; responsive layouts
    // are verified independently after the terminal is stopped.
    await page.setViewportSize({ width: 1400, height: 820 });
    const resizedDimensions = await waitForTerminalDimensions(
      page,
      (candidate) => !sameDimensions(candidate, initialDimensions),
      30_000,
    );
    const observerDimensions = await waitForTerminalDimensions(
      observerPage,
      (candidate) => sameDimensions(candidate, resizedDimensions),
      30_000,
    );
    await page.setViewportSize({ width: 1720, height: 1180 });
    const restoredDimensions = await waitForTerminalDimensions(
      page,
      (candidate) => !sameDimensions(candidate, resizedDimensions),
      30_000,
    );
    await waitForTerminalDimensions(
      observerPage,
      (candidate) => sameDimensions(candidate, restoredDimensions),
      30_000,
    );
    await page.screenshot({ path: paths.terminalScreenshot, fullPage: true });
    await observerPage.screenshot({ path: paths.terminalObserverScreenshot, fullPage: true });

    await page.getByTestId("terminal-terminate-button").click();
    const confirmation = page.getByTestId("terminal-confirm-dialog");
    await confirmation.waitFor({ state: "visible", timeout: 15_000 });
    assert(
      (await confirmation.textContent())?.includes("structured chat stays available"),
      "Codex terminal termination did not explain the structured-chat boundary",
    );
    await confirmation.getByRole("button", { name: "Terminate", exact: true }).click();
    await page.getByTestId("terminal-restart-button").waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await observerPage.getByTestId("terminal-restart-button").waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await page.getByTestId("terminal-toolbar").filter({ hasText: "exited" }).waitFor({
      timeout: 30_000,
    });
    await observerPage.getByTestId("terminal-toolbar").filter({ hasText: "exited" }).waitFor({
      timeout: 30_000,
    });
    await page.screenshot({ path: paths.terminalExitedScreenshot, fullPage: true });
    await observerPage.close();
    observerPage = undefined;

    await page.getByTestId("session-chat-tab").click();
    await page.getByTestId("prompt-input").waitFor({ state: "visible", timeout: 15_000 });
    await sendThroughUi({
      harness: "codex",
      sessionId,
      prompt: prompts.postTerminalStructured,
      marker: markers.postTerminalStructured,
    });
    await page.screenshot({ path: paths.postTerminalChatScreenshot, fullPage: true });

    return {
      chatDefaultBeforeOpen: true,
      openedThroughUi: true,
      backend: "codex-remote",
      sharing: "session",
      secondObserver: {
        client: "independent gateway web client",
        attachedReadOnly: true,
        initialStateConverged: true,
        observedLeaseHeldElsewhere: true,
        observedExit: true,
      },
      keyboard: {
        acquiredThroughUi: true,
        singleWriterObserved: true,
        renewalObserved: true,
        renewableLeaseCredentialRecorded: false,
      },
      ephemeralDraft: {
        sha256: sha256Hex(markers.terminalEphemeral),
        utf8Bytes: Buffer.byteLength(markers.terminalEphemeral, "utf8"),
        visibleToOperator: true,
        visibleToObserver: true,
        transportedAsOneInputFrame: true,
        clearedBeforeSubmit: true,
        valueRecordedInTextReceipt: false,
      },
      semanticPrompt: {
        prompt: prompts.terminalSemantic,
        reply: markers.terminalSemanticReply,
        replyVisibleToOperator: true,
        replyVisibleToObserver: true,
      },
      resize: {
        initial: initialDimensions,
        resized: resizedDimensions,
        observer: observerDimensions,
        restored: restoredDimensions,
        operatorChanged: true,
        observerConverged: true,
      },
      termination: {
        confirmationVisible: true,
        confirmed: true,
        exited: true,
        secondObserverSawExit: true,
      },
      structuredAfterTermination: {
        prompt: prompts.postTerminalStructured,
        marker: markers.postTerminalStructured,
        replyVisible: true,
        sharedAppServerStillUsable: true,
      },
    };
  });
}

async function verifyCopilotTerminalDisabled(sessionId) {
  return action("show the disabled-by-default Copilot terminal state", async () => {
    await selectSession(sessionId);
    assert(
      await page.getByTestId("session-chat-tab").getAttribute("data-state") === "active",
      "Chat was not the default Copilot workspace",
    );
    await page.getByTestId("session-terminal-tab").click();
    const warning = page.getByTestId("copilot-terminal-warning");
    await warning.waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText("Experimental Copilot TUI is off", { exact: true }).waitFor({
      state: "visible",
      timeout: 30_000,
    });
    assert(
      (await warning.textContent())?.includes("explicitly enabled"),
      "Copilot warning did not describe its opt-in experimental status",
    );
    assert(
      await page.getByTestId("terminal-open-button").count() === 0,
      "disabled Copilot terminal unexpectedly exposed an open action",
    );
    await page.screenshot({ path: paths.copilotTerminalScreenshot, fullPage: true });
    await page.getByTestId("session-chat-tab").click();
    return {
      capabilityAdvertised: false,
      warningVisible: true,
      disabledTitleVisible: true,
      openActionAbsent: true,
      structuredChatRemainedAvailable: true,
    };
  });
}

function terminalTextarea(targetPage) {
  return targetPage.getByTestId("terminal-viewport").locator("textarea.xterm-helper-textarea");
}

async function pasteTerminalText(textarea, value) {
  await textarea.evaluate((element, text) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", text);
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, value);
}

async function terminalScreenText(targetPage) {
  const tree = targetPage.getByTestId("terminal-viewport").locator(".xterm-accessibility-tree");
  if (await tree.count() === 0) return "";
  return await tree.first().textContent() ?? "";
}

async function waitForTerminalText(targetPage, text, present, limitMs) {
  await waitFor(
    `${present ? "visible" : "cleared"} terminal text digest ${sha256Hex(text).slice(0, 12)}`,
    Math.min(limitMs, 90_000),
    async () => (await terminalScreenText(targetPage)).includes(text) === present,
  );
}

async function readTerminalDimensions(targetPage) {
  const encoded = (await targetPage.getByTestId("terminal-dimensions").textContent())?.trim();
  assert(encoded, "terminal panel did not expose its dimensions");
  const [columns, rows] = encoded.split("×").map(Number);
  assert(
    Number.isSafeInteger(columns) && Number.isSafeInteger(rows),
    `terminal exposed invalid dimensions ${encoded}`,
  );
  return { columns, rows };
}

async function waitForTerminalDimensions(targetPage, predicate, limitMs) {
  let dimensions;
  await waitFor("terminal dimensions to propagate", limitMs, async () => {
    dimensions = await readTerminalDimensions(targetPage);
    return predicate(dimensions);
  });
  return dimensions;
}

function sameDimensions(left, right) {
  return left.columns === right.columns && left.rows === right.rows;
}

function terminalInputCallCount() {
  return accessCalls.filter((call) =>
    call.client === "operator" && call.path.includes("terminals.input") &&
    call.status >= 200 && call.status < 300
  ).length;
}

async function exerciseCodexControls(sessionId) {
  await selectSession(sessionId);
  await page.getByTestId("stream-status").filter({ hasText: "live" }).waitFor({
    timeout: 30_000,
  });

  const model = await action("switch the live Codex model through the UI", async () => {
    const checkpoint = (await readFleetEvents()).length;
    await openAgentSettings("model-select");
    await setControl(page.getByTestId("model-select"), codexSecondModel, timeoutMs, false);
    await page.getByTestId("model-button").click();
    const command = await waitForCommand(
      "successful Codex model command",
      checkpoint,
      (request) => request?.harness === "codex" &&
        request.command?.type === "setModel" &&
        request.command.model === codexSecondModel,
    );
    const settings = await waitForFleetEvent(
      "native Codex model settings update",
      checkpoint,
      (event) => event.kind === "native" &&
        event.sessionId === sessionId &&
        event.nativeType === "thread/settings/updated" &&
        event.payload?.threadSettings?.model === codexSecondModel,
    );
    await assertActionStatusClean("model switch");
    return {
      requested: codexSecondModel,
      commandId: command.change.command.commandId,
      settingsSequence: settings.sequence,
    };
  });

  const plan = await action("answer a blocking Codex Plan question through the UI", async () => {
    const modeCheckpoint = (await readFleetEvents()).length;
    await openAgentSettings("mode-select");
    await setControl(page.getByTestId("mode-select"), "plan", timeoutMs, false);
    await page.getByTestId("mode-button").click();
    const modeCommand = await waitForCommand(
      "successful Codex Plan-mode command",
      modeCheckpoint,
      (request) => request?.harness === "codex" &&
        request.command?.type === "setMode" &&
        request.command.mode === "plan",
    );
    const modeSettings = await waitForFleetEvent(
      "native Codex Plan-mode settings update",
      modeCheckpoint,
      (event) => event.kind === "native" &&
        event.sessionId === sessionId &&
        event.nativeType === "thread/settings/updated" &&
        event.payload?.threadSettings?.collaborationMode?.mode === "plan",
    );
    await assertActionStatusClean("Plan-mode switch");

    const promptCheckpoint = (await readFleetEvents()).length;
    await page.getByTestId("prompt-input").fill(prompts.plan);
    await page.getByTestId("send-button").click();
    await waitForChatMessage("user", prompts.plan, timeoutMs);
    const sendCommand = await waitForCommand(
      "successful Codex Plan prompt command",
      promptCheckpoint,
      (request) => codexSendMatches(request, prompts.plan),
    );
    const pendingEvent = await waitForFleetEvent(
      "one canonical Codex request_user_input interaction",
      promptCheckpoint,
      (event) => isExpectedPlanInteraction(event, sessionId, "pending"),
    );
    const pending = pendingEvent.change.interaction;
    const question = page.locator(
      '[data-testid="interaction-answer"][data-question-id="receipt_choice"]',
    );
    await question.waitFor({ state: "visible", timeout: timeoutMs });
    const card = page.locator(
      `[data-testid="interaction-card"][data-interaction-id="${cssEscape(pending.interactionId)}"]`,
    );
    await card.filter({ hasText: "Choose the receipt value" }).waitFor({
      state: "visible",
      timeout: 15_000,
    });
    assert(
      await page.getByTestId("interaction-card").count() === 1,
      "Plan prompt exposed more than one simultaneous interaction card",
    );

    const response = JSON.stringify({
      answers: { receipt_choice: { answers: [markers.planAnswer] } },
    });
    await question.selectOption("__agent_multiplex_other_answer__");
    await card.getByTestId("interaction-other-answer").fill(markers.planAnswer);
    await page.screenshot({ path: paths.planScreenshot, fullPage: true });
    await card.getByTestId("answer-button").click();
    const resolvedEvent = await waitForFleetEvent(
      "resolved Codex Plan interaction",
      promptCheckpoint,
      (event) => event.kind === "control" &&
        event.change?.type === "interaction.changed" &&
        event.change.interaction?.interactionId === pending.interactionId &&
        event.change.interaction.state === "resolved" &&
        deepEqual(event.change.interaction.resolution, JSON.parse(response)),
    );
    await card.waitFor({ state: "detached", timeout: 30_000 });
    const resolvedNative = await waitForFleetEvent(
      "native Codex server-request resolution",
      promptCheckpoint,
      (event) => event.kind === "native" &&
        event.sessionId === sessionId &&
        event.nativeType === "serverRequest/resolved" &&
        String(event.payload?.requestId) === pending.nativeRequestId,
    );
    const finalMessage = await waitForFleetEvent(
      "typed Plan answer in the exact final Codex message",
      promptCheckpoint,
      (event) => event.kind === "native" &&
        event.sessionId === sessionId &&
        event.nativeType === "item/completed" &&
        event.payload?.turnId === pending.payload?.params?.turnId &&
        event.payload?.item?.type === "agentMessage" &&
        event.payload.item.text === markers.planFinal,
    );
    const completed = await waitForFleetEvent(
      "completed Codex Plan turn",
      promptCheckpoint,
      (event) => event.kind === "native" &&
        event.sessionId === sessionId &&
        event.nativeType === "turn/completed" &&
        event.payload?.turn?.id === pending.payload?.params?.turnId &&
        event.payload?.turn?.status === "completed",
    );
    await waitForChatMessage("assistant", markers.planFinal, timeoutMs);

    const defaultCheckpoint = (await readFleetEvents()).length;
    await openAgentSettings("mode-select");
    await setControl(page.getByTestId("mode-select"), "default", timeoutMs, false);
    await page.getByTestId("mode-button").click();
    const defaultCommand = await waitForCommand(
      "successful Codex default-mode command",
      defaultCheckpoint,
      (request) => request?.harness === "codex" &&
        request.command?.type === "setMode" &&
        request.command.mode === "default",
    );
    const defaultSettings = await waitForFleetEvent(
      "native Codex default-mode settings update",
      defaultCheckpoint,
      (event) => event.kind === "native" &&
        event.sessionId === sessionId &&
        event.nativeType === "thread/settings/updated" &&
        event.payload?.threadSettings?.collaborationMode?.mode === "default",
    );
    await assertActionStatusClean("return to default mode");
    return {
      modeCommandId: modeCommand.change.command.commandId,
      modeSettingsSequence: modeSettings.sequence,
      prompt: prompts.plan,
      sendCommandId: sendCommand.change.command.commandId,
      turnId: pending.payload.params.turnId,
      interactionId: pending.interactionId,
      nativeRequestId: pending.nativeRequestId,
      answer: markers.planAnswer,
      finalMarker: markers.planFinal,
      resolutionMethod: "structured-other-ui",
      pendingObserved: true,
      resolvedObserved: resolvedEvent.change.interaction.state === "resolved",
      resolvedNativeSequence: resolvedNative.sequence,
      finalMessageSequence: finalMessage.sequence,
      completedSequence: completed.sequence,
      defaultCommandId: defaultCommand.change.command.commandId,
      defaultSettingsSequence: defaultSettings.sequence,
    };
  });

  const interrupt = await action("interrupt a visible Codex shell command through the UI", async () => {
    const checkpoint = (await readFleetEvents()).length;
    await page.getByTestId("prompt-input").fill(prompts.interrupt);
    await page.getByTestId("send-button").click();
    await waitForChatMessage("user", prompts.interrupt, timeoutMs);
    const sendCommand = await waitForCommand(
      "successful long-running Codex prompt command",
      checkpoint,
      (request) => codexSendMatches(request, prompts.interrupt),
    );
    const secondTick = `${markers.interruptPrefix}_002`;
    const commandStarted = await waitForFleetEvent(
      "running Codex command item",
      checkpoint,
      (event) => event.kind === "native" &&
        event.sessionId === sessionId &&
        event.nativeType === "item/started" &&
        event.payload?.item?.type === "commandExecution" &&
        event.payload?.item?.status === "inProgress",
    );
    const turnId = commandStarted.payload?.turnId;
    const itemId = commandStarted.payload?.item?.id;
    assert(typeof turnId === "string" && turnId, "long command item omitted its turn ID");
    assert(typeof itemId === "string" && itemId, "long command item omitted its item ID");
    await waitFor("second live Codex command tick", timeoutMs, async () => {
      const events = await readFleetEvents();
      return events.slice(checkpoint)
        .filter((event) => event.kind === "native" &&
          event.sessionId === sessionId &&
          event.nativeType === "item/commandExecution/outputDelta" &&
          event.payload?.turnId === turnId &&
          event.payload?.itemId === itemId)
        .map((event) => typeof event.payload?.delta === "string" ? event.payload.delta : "")
        .join("")
        .includes(secondTick);
    });
    await page.locator('[data-testid="chat-message"][data-role="tool"]')
      .filter({ hasText: secondTick })
      .last()
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.screenshot({ path: paths.interruptScreenshot, fullPage: true });

    const interruptCheckpoint = (await readFleetEvents()).length;
    const interruptButton = page.getByTestId("interrupt-button");
    await interruptButton.waitFor({ state: "visible", timeout: 15_000 });
    await waitFor("enabled interrupt button", 15_000, () => interruptButton.isEnabled());
    await interruptButton.click();
    const interruptCommand = await waitForCommand(
      "successful Codex interrupt command",
      interruptCheckpoint,
      (request) => request?.harness === "codex" &&
        request.command?.type === "interrupt" &&
        (request.command.turnId === undefined || request.command.turnId === turnId),
    );
    const interrupted = await waitForFleetEvent(
      "interrupted Codex turn completion",
      interruptCheckpoint,
      (event) => event.kind === "native" &&
        event.sessionId === sessionId &&
        event.nativeType === "turn/completed" &&
        event.payload?.turn?.id === turnId &&
        event.payload?.turn?.status === "interrupted",
    );
    const commandCompleted = await waitForFleetEvent(
      "terminal Codex command item after interrupt",
      interruptCheckpoint,
      (event) => event.kind === "native" &&
        event.sessionId === sessionId &&
        event.nativeType === "item/completed" &&
        event.payload?.turnId === turnId &&
        event.payload?.item?.id === itemId &&
        event.payload?.item?.type === "commandExecution" &&
        event.payload?.item?.status !== "inProgress",
    );
    await waitForStableInterruptOutput(sessionId, turnId, markers.interruptPrefix, timeoutMs);
    const allEvents = await readFleetEvents();
    const turnEvents = allEvents.filter((event) =>
      event.kind === "native" &&
      event.sessionId === sessionId &&
      (event.payload?.turnId === turnId || event.payload?.turn?.id === turnId),
    );
    const outputText = turnEvents
      .filter((event) => event.nativeType === "item/commandExecution/outputDelta")
      .map((event) => event.payload?.delta ?? "")
      .join("");
    const ticks = [...outputText.matchAll(
      new RegExp(`${escapeRegExp(markers.interruptPrefix)}_(\\d{3})`, "g"),
    )].map((match) => Number(match[1]));
    const maximumObservedTick = ticks.length > 0 ? Math.max(...ticks) : 0;
    assert(maximumObservedTick >= 2, "interrupt occurred before two visible command ticks");
    assert(
      maximumObservedTick < 30,
      `interrupted command continued unexpectedly through tick ${maximumObservedTick}`,
    );
    assert(
      !turnEvents.some((event) => deepContainsExact(event.payload, markers.interruptFinished)),
      "Codex emitted the forbidden post-command completion marker after interrupt",
    );
    await assertActionStatusClean("interrupt");
    return {
      prompt: prompts.interrupt,
      sendCommandId: sendCommand.change.command.commandId,
      turnId,
      itemId,
      visibleTick: secondTick,
      maximumObservedTick,
      forbiddenMarker: markers.interruptFinished,
      interruptCommandId: interruptCommand.change.command.commandId,
      interruptedSequence: interrupted.sequence,
      commandCompletedSequence: commandCompleted.sequence,
      outputStabilized: true,
    };
  });

  return { model, plan, interrupt };
}

async function waitForCommand(description, checkpoint, matchesRequest) {
  return waitForFleetEvent(description, checkpoint, (event) => {
    if (event.kind !== "control" || event.change?.type !== "command.changed") return false;
    const record = event.change.command;
    return record.state === "succeeded" && matchesRequest(record.request?.request);
  });
}

async function waitForFleetEvent(description, checkpoint, predicate) {
  let match;
  await waitFor(description, timeoutMs, async () => {
    const events = await readFleetEvents();
    match = events.slice(checkpoint).find(predicate);
    return match !== undefined;
  });
  return match;
}

async function readFleetEvents() {
  let text;
  try {
    text = await readFile(paths.fleetEvents, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const lines = text.split("\n");
  const events = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (cause) {
      // The watcher flushes one NDJSON line at a time, but a concurrent host
      // read can still catch its final line before the terminating newline.
      if (index === lines.length - 1) break;
      throw new Error(`fleet event line ${index + 1} is invalid JSON`, { cause });
    }
  }
  return events;
}

function isExpectedPlanInteraction(event, sessionId, state) {
  if (
    event.kind !== "control" ||
    event.change?.type !== "interaction.changed" ||
    event.change.interaction?.sessionId !== sessionId ||
    event.change.interaction?.harness !== "codex" ||
    event.change.interaction?.requestType !== "userInput" ||
    event.change.interaction?.state !== state
  ) return false;
  const payload = event.change.interaction.payload;
  const questions = payload?.params?.questions;
  if (
    payload?.method !== "item/tool/requestUserInput" ||
    typeof payload.params?.turnId !== "string" ||
    !Array.isArray(questions) ||
    questions.length !== 1
  ) return false;
  const question = questions[0];
  return question?.id === "receipt_choice" &&
    question?.header === "Receipt" &&
    question?.question === "Choose the receipt value" &&
    question?.isOther === true &&
    Array.isArray(question?.options) &&
    question.options.length === 2 &&
    // Codex may preserve the requested label verbatim or annotate the
    // recommended option using the native UI convention.
    ["Alpha", "Alpha (Recommended)"].includes(question.options[0]?.label) &&
    question.options[1]?.label === "Beta";
}

function codexSendMatches(request, prompt) {
  return request?.harness === "codex" &&
    request.command?.type === "send" &&
    request.command.input === prompt;
}

async function assertActionStatusClean(description) {
  const status = page.getByTestId("action-status");
  await status.waitFor({ state: "visible", timeout: 15_000 });
  await waitFor(`${description} UI action receipt`, 15_000, async () => {
    const value = (await status.textContent())?.replace(/\s+/g, " ").trim() ?? "";
    if (/(?:failed|error|conflict|outcome.?unknown)/i.test(value)) {
      throw new Error(`${description} UI action status: ${value}`);
    }
    return value !== "" && value !== "Dispatching command once…";
  });
}

async function waitForStableInterruptOutput(sessionId, turnId, prefix, limitMs) {
  const deadline = Date.now() + Math.min(limitMs, 30_000);
  let previous = null;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const events = await readFleetEvents();
    const output = events
      .filter((event) => event.kind === "native" &&
        event.sessionId === sessionId &&
        event.nativeType === "item/commandExecution/outputDelta" &&
        event.payload?.turnId === turnId)
      .map((event) => event.payload?.delta ?? "")
      .join("");
    const ticks = [...output.matchAll(new RegExp(`${escapeRegExp(prefix)}_(\\d{3})`, "g"))]
      .map((match) => Number(match[1]));
    const maximum = ticks.length > 0 ? Math.max(...ticks) : null;
    if (maximum !== null && maximum === previous) stableSamples += 1;
    else stableSamples = 0;
    previous = maximum;
    if (stableSamples >= 3) return;
    await delay(1_000);
  }
  throw new Error("interrupted command output did not stabilize within 30 seconds");
}

async function openAgentSettings(controlTestId) {
  const control = page.getByTestId(controlTestId);
  if (await control.isVisible().catch(() => false)) return;
  const trigger = page.getByTestId("agent-settings-button");
  await trigger.waitFor({ state: "visible", timeout: 15_000 });
  await trigger.click();
  await control.waitFor({ state: "visible", timeout: 15_000 });
}

async function verifyResponsiveUi(sessionId) {
  await selectSession(sessionId);
  const results = [];

  for (const viewport of responsiveViewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await delay(180);

    const prompt = page.getByTestId("prompt-input");
    const send = page.getByTestId("send-button");
    await prompt.waitFor({ state: "visible", timeout: 15_000 });
    await send.waitFor({ state: "visible", timeout: 15_000 });

    let navigationSheetAccessible = null;
    let inspectorSheetAccessible = null;
    let sheetFocusRestored = null;

    if (viewport.mode === "mobile") {
      const navigationTrigger = page.getByTestId("agents-sheet-button");
      await navigationTrigger.waitFor({ state: "visible", timeout: 15_000 });
      await navigationTrigger.click();
      await page.locator(
        `[data-testid="session-card"][data-session-id="${cssEscape(sessionId)}"]`,
      ).waitFor({ state: "visible", timeout: 15_000 });
      navigationSheetAccessible = true;
      await page.getByRole("button", { name: "Close agents pane", exact: true }).click();
      await navigationTrigger.waitFor({ state: "visible", timeout: 15_000 });
      await waitFor(`${viewport.name} navigation sheet focus restoration`, 2_000, () =>
        navigationTrigger.evaluate((element) => document.activeElement === element)
      );
      sheetFocusRestored = true;
    } else {
      await page.locator(
        `[data-testid="session-card"][data-session-id="${cssEscape(sessionId)}"]`,
      ).waitFor({ state: "visible", timeout: 15_000 });
    }

    if (viewport.mode === "desktop") {
      await page.getByTestId("metadata-editor").waitFor({ state: "visible", timeout: 15_000 });
    } else {
      const inspectorTrigger = page.getByTestId("inspector-sheet-button");
      await inspectorTrigger.waitFor({ state: "visible", timeout: 15_000 });
      await inspectorTrigger.click();
      await page.getByTestId("metadata-editor").waitFor({ state: "visible", timeout: 15_000 });
      inspectorSheetAccessible = true;
      await page.getByRole("button", { name: "Close inspector pane", exact: true }).click();
      await inspectorTrigger.waitFor({ state: "visible", timeout: 15_000 });
      await waitFor(`${viewport.name} inspector sheet focus restoration`, 2_000, () =>
        inspectorTrigger.evaluate((element) => document.activeElement === element)
      );
      const inspectorFocusRestored = true;
      sheetFocusRestored = sheetFocusRestored === null
        ? inspectorFocusRestored
        : sheetFocusRestored && inspectorFocusRestored;
      assert(inspectorFocusRestored, `${viewport.name} inspector sheet did not restore focus`);
    }

    const layout = await page.evaluate(() => {
      const root = document.documentElement;
      const body = document.body;
      const selectors = [
        '[data-testid="prompt-input"]',
        '[data-testid="send-button"]',
        '[data-testid="agent-settings-button"]',
      ];
      const clippedEssentials = selectors.flatMap((selector) =>
        [...document.querySelectorAll(selector)].flatMap((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const visible = style.display !== "none" && style.visibility !== "hidden" &&
            rect.width > 0 && rect.height > 0;
          if (!visible) return [];
          const clipped = rect.left < -1 || rect.top < -1 ||
            rect.right > window.innerWidth + 1 || rect.bottom > window.innerHeight + 1;
          return clipped ? [selector] : [];
        })
      );
      return {
        documentOverflow: root.scrollWidth > root.clientWidth + 1 ||
          body.scrollWidth > body.clientWidth + 1,
        rootWidth: root.clientWidth,
        rootScrollWidth: root.scrollWidth,
        bodyWidth: body.clientWidth,
        bodyScrollWidth: body.scrollWidth,
        clippedEssentials,
      };
    });
    assert(!layout.documentOverflow, `${viewport.name} has horizontal document overflow`);
    assert(
      layout.clippedEssentials.length === 0,
      `${viewport.name} clips essential controls: ${layout.clippedEssentials.join(", ")}`,
    );

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
      `${viewport.name} has serious/critical accessibility violations: ${accessibilityViolations
        .map((violation) => violation.id).join(", ")}`,
    );

    const screenshot = `screenshots/layout-${viewport.name}-${viewport.width}x${viewport.height}.png`;
    await page.screenshot({ path: join(receiptDirectory, screenshot), fullPage: true });
    results.push({
      ...viewport,
      ...layout,
      navigationSheetAccessible,
      inspectorSheetAccessible,
      sheetFocusRestored,
      accessibilityViolations,
      screenshot,
    });
  }

  return results;
}

async function selectSession(sessionId) {
  return selectSessionOn(page, sessionId);
}

async function selectSessionOn(targetPage, sessionId) {
  const card = targetPage.locator(
    `[data-testid="session-card"][data-session-id="${cssEscape(sessionId)}"]`,
  );
  await card.waitFor({ state: "visible", timeout: timeoutMs });
  await card.click();
  await targetPage.getByTestId("selected-session-id").filter({ hasText: sessionId }).waitFor({
    timeout: 15_000,
  });
}

function registerPageDiagnostics(targetPage, label) {
  targetPage.on("console", (message) => {
    const line = `${label} console.${message.type()}: ${message.text()}`;
    browserMessages.push(line);
    if (message.type() === "error") browserErrors.push(line);
  });
  targetPage.on("pageerror", (error) => {
    const line = `${label} pageerror: ${error.message}`;
    browserMessages.push(line);
    browserErrors.push(line);
  });
  targetPage.on("requestfailed", (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.origin !== new URL(gatewayUrl).origin) return;
    const line = `${label} ${request.method()} ${requestUrl.pathname}: ${request.failure()?.errorText ?? "failed"}`;
    failedRequests.push(line);
    browserMessages.push(`requestfailed: ${line}`);
  });
  targetPage.on("response", (response) => {
    const responseUrl = new URL(response.url());
    if (responseUrl.origin !== new URL(gatewayUrl).origin) return;
    if (!responseUrl.pathname.startsWith("/trpc/")) return;
    accessCalls.push({
      at: now(),
      client: label,
      method: response.request().method(),
      path: responseUrl.pathname,
      status: response.status(),
    });
  });
}

async function waitForChatMessage(role, text, limitMs) {
  await page.locator(`[data-testid="chat-message"][data-role="${role}"]`)
    .filter({ hasText: text })
    .last()
    // A projected chat message should appear promptly once the associated
    // command has reached the browser. Keep this UI assertion bounded even
    // when the wider live-harness timeout is intentionally several minutes.
    .waitFor({ state: "visible", timeout: Math.min(limitMs, 30_000) });
}

async function setControl(locator, wanted, limitMs, matchText) {
  await locator.waitFor({ state: "visible", timeout: 15_000 });
  await waitFor(`option ${wanted}`, limitMs, async () => {
    return locator.evaluate((element, input) => {
      if (element instanceof HTMLSelectElement) {
        return [...element.options].some((option) =>
          input.matchText
            ? option.textContent?.includes(input.wanted) || option.value === input.wanted
            : option.value === input.wanted || option.textContent?.trim() === input.wanted,
        );
      }
      return element instanceof HTMLInputElement;
    }, { wanted, matchText });
  });
  const tagName = await locator.evaluate((element) => element.tagName.toLowerCase());
  if (tagName !== "select") {
    await locator.fill(wanted);
    return;
  }
  const value = await locator.evaluate((element, input) => {
    const select = /** @type {HTMLSelectElement} */ (element);
    const option = [...select.options].find((candidate) =>
      input.matchText
        ? candidate.textContent?.includes(input.wanted) || candidate.value === input.wanted
        : candidate.value === input.wanted || candidate.textContent?.trim() === input.wanted,
    );
    return option?.value;
  }, { wanted, matchText });
  assert(value !== undefined, `control has no selectable option for ${wanted}`);
  await locator.selectOption(value);
}

async function waitForJsonEditor(editor, limitMs) {
  let parsed;
  await waitFor("metadata JSON editor", limitMs, async () => {
    try {
      const value = JSON.parse(await editor.inputValue());
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
      parsed = value;
      return true;
    } catch {
      return false;
    }
  });
  return parsed;
}

async function optionalText(locator) {
  try {
    if ((await locator.count()) === 0) return null;
    return (await locator.first().textContent())?.replace(/\s+/g, " ").trim() ?? null;
  } catch {
    return null;
  }
}

async function action(label, operation) {
  const startedAt = now();
  try {
    const result = await operation();
    await appendFile(paths.actionLog, `${JSON.stringify({ label, startedAt, completedAt: now(), status: "passed" })}\n`, "utf8");
    return result;
  } catch (error) {
    await appendFile(paths.actionLog, `${JSON.stringify({ label, startedAt, completedAt: now(), status: "failed", error: errorText(error) })}\n`, "utf8").catch(() => undefined);
    throw error;
  }
}

async function waitFor(description, limitMs, operation) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started <= limitMs) {
    try {
      if (await operation()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `timed out waiting for ${description}${lastError ? `: ${errorText(lastError)}` : ""}`,
  );
}

function isNativeHistoryCall(call) {
  return call.path.includes("sessions.readNativeHistory") &&
    call.status >= 200 && call.status < 300;
}

function cssEscape(value) {
  return value.replace(/(["\\])/g, "\\$1");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deepContainsExact(value, expected) {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => deepContainsExact(item, expected));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => deepContainsExact(item, expected));
  }
  return false;
}

function deepEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function randomMarker() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function positiveInteger(value, description) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${description} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value, description) {
  const parsed = Number(value);
  if (!/^\d+$/.test(value ?? "") || !Number.isSafeInteger(parsed)) {
    throw new Error(`${description} must be a non-negative integer`);
  }
  return parsed;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function now() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function writeJson(filename, value) {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
