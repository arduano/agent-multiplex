#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { createAccessClient } from "@arduano/agent-multiplex-client";

const [httpUrl, rawReceiptDirectory, rawTimeoutMs] = process.argv.slice(2);
if (!httpUrl || !rawReceiptDirectory || !rawTimeoutMs) {
  throw new Error("usage: verify.mjs <gateway-trpc-url> <receipt-dir> <timeout-ms>");
}
const receiptDirectory = resolve(rawReceiptDirectory);
const timeoutMs = positiveInteger(rawTimeoutMs, "timeout-ms");
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
const terminalMarker = await readFile(terminalMarkerFile, "utf8");
if (!terminalMarker || /[\r\n]/.test(terminalMarker)) {
  throw new Error("terminal ephemerality marker must be non-empty, single-line text");
}
const expectedDirectWorkspaceProfile = Object.freeze({
  providerId: "core.direct",
  profileId: "workspace",
  contractVersion: 1,
  requestSchemaHash: "110c0ee7047b5fa714d317b2500a3b6052c90761a8adc40b8c642f87a26579f7",
  implementationVersion: "1.0.0",
});

const paths = {
  browser: join(receiptDirectory, "phases", "browser-ui.json"),
  events: join(receiptDirectory, "logs", "fleet-events.ndjson"),
  watcher: join(receiptDirectory, "phases", "watcher-summary.json"),
  system: join(receiptDirectory, "rpc", "system.json"),
  sources: join(receiptDirectory, "rpc", "sources.json"),
  controlNodes: join(receiptDirectory, "rpc", "control-nodes.json"),
  runtimeNodes: join(receiptDirectory, "rpc", "runtime-nodes.json"),
  catalog: join(receiptDirectory, "rpc", "harness-catalog.json"),
  modelsCodex: join(receiptDirectory, "rpc", "models-codex.json"),
  modelsCopilot: join(receiptDirectory, "rpc", "models-copilot.json"),
  launchProfilesCodex: join(receiptDirectory, "rpc", "launch-profiles-codex.json"),
  launchProfilesCopilot: join(receiptDirectory, "rpc", "launch-profiles-copilot.json"),
  launchModelsCodex: join(receiptDirectory, "rpc", "launch-models-codex.json"),
  launchModelsCopilot: join(receiptDirectory, "rpc", "launch-models-copilot.json"),
  launches: join(receiptDirectory, "rpc", "launches.json"),
  sessions: join(receiptDirectory, "rpc", "sessions.json"),
  metadataCodex: join(receiptDirectory, "rpc", "metadata-codex.json"),
  metadataCopilot: join(receiptDirectory, "rpc", "metadata-copilot.json"),
  historyCodex: join(receiptDirectory, "rpc", "native-history-codex.json"),
  historyCopilot: join(receiptDirectory, "rpc", "native-history-copilot.json"),
  terminalCodex: join(receiptDirectory, "rpc", "terminal-codex-after-exit.json"),
  interactions: join(receiptDirectory, "rpc", "interactions-pending.json"),
  interactionsAll: join(receiptDirectory, "rpc", "interactions-all.json"),
  interactionEvents: join(receiptDirectory, "rpc", "interactions-from-stream.json"),
  commands: join(receiptDirectory, "rpc", "commands-from-stream.json"),
  metadataOperations: join(receiptDirectory, "rpc", "metadata-operations-from-stream.json"),
  stream: join(receiptDirectory, "phases", "stream-assertions.json"),
  codexControls: join(receiptDirectory, "phases", "codex-controls.json"),
  terminalNormalized: join(receiptDirectory, "phases", "terminal-normalized-surfaces.json"),
  checks: join(receiptDirectory, "checks.json"),
  failure: join(receiptDirectory, "verification-failure.json"),
};
await Promise.all(
  Object.values(paths).map((filename) => mkdir(dirname(filename), { recursive: true })),
);

const browser = JSON.parse(await readFile(paths.browser, "utf8"));
const watcher = JSON.parse(await readFile(paths.watcher, "utf8"));
const events = (await readFile(paths.events, "utf8"))
  .split("\n")
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (cause) {
      throw new Error(`fleet event line ${index + 1} is invalid JSON`, { cause });
    }
  });
const logicalEvents = withoutNativeReplays(events);
const codexPlan = browser.sessions?.codex;
const copilotPlan = browser.sessions?.copilot;
assert(codexPlan?.sessionId && copilotPlan?.sessionId, "browser receipt omitted session IDs");
assert(
  codexPlan?.secondModel && codexPlan?.controls?.model &&
    codexPlan?.controls?.plan && codexPlan?.controls?.interrupt &&
    codexPlan?.terminal?.ephemeralDraft?.sha256 &&
    copilotPlan?.terminal,
  "browser receipt omitted the Codex controls or terminal proof",
);

const handle = createAccessClient({ httpUrl, bearerToken });
const client = handle.client;
try {
  const system = await client.system.describe.query();
  const sources = await client.sources.list.query();
  const controlNodes = await client.controlNodes.list.query();
  const runtimeNodes = await client.runtimeNodes.list.query();
  const catalog = await client.harness.catalog.query();
  const codexRuntime = runtimeNodes.find((node) => node.name === browser.topology.codexRuntimeName);
  const copilotRuntime = runtimeNodes.find((node) => node.name === browser.topology.copilotRuntimeName);
  assert(codexRuntime, "Codex runtime node is absent from the final projection");
  assert(copilotRuntime, "Copilot runtime node is absent from the final projection");
  const codexProfile = directWorkspaceProfile(codexRuntime, "codex");
  const copilotProfile = directWorkspaceProfile(copilotRuntime, "copilot");

  const [modelsCodex, modelsCopilot, launchProfilesCodex, launchProfilesCopilot,
    launchModelsCodex, launchModelsCopilot, launchPage, sessionPage, metadataCodex,
    metadataCopilot, historyCodex, historyCopilot, interactions, interactionsAll] = await Promise.all([
    client.harness.models.query({ runtimeNodeId: codexRuntime.runtimeNodeId, harness: "codex" }),
    client.harness.models.query({ runtimeNodeId: copilotRuntime.runtimeNodeId, harness: "copilot" }),
    client.launchProfiles.list.query({
      runtimeNodeId: codexRuntime.runtimeNodeId,
      providerId: codexProfile.providerId,
      harness: "codex",
    }),
    client.launchProfiles.list.query({
      runtimeNodeId: copilotRuntime.runtimeNodeId,
      providerId: copilotProfile.providerId,
      harness: "copilot",
    }),
    client.launchProfiles.models.query({
      runtimeNodeId: codexRuntime.runtimeNodeId,
      profile: profileIdentity(codexProfile),
      harness: "codex",
    }),
    client.launchProfiles.models.query({
      runtimeNodeId: copilotRuntime.runtimeNodeId,
      profile: profileIdentity(copilotProfile),
      harness: "copilot",
    }),
    client.launches.list.query({ limit: 500 }),
    client.sessions.search.query({ states: ["running", "stopped"], limit: 500 }),
    client.metadata.get.query(codexPlan.sessionId),
    client.metadata.get.query(copilotPlan.sessionId),
    client.sessions.readNativeHistory.query({
      sessionId: codexPlan.sessionId,
      request: { harness: "codex", includeTurns: true },
    }),
    client.sessions.readNativeHistory.query({
      sessionId: copilotPlan.sessionId,
      request: { harness: "copilot", limit: 100 },
    }),
    client.interactions.list.query({ pendingOnly: true }),
    client.interactions.list.query({ pendingOnly: false }),
  ]);
  const launches = launchPage.launches;
  const sessions = sessionPage.sessions;

  await Promise.all([
    writeJson(paths.system, system),
    writeJson(paths.sources, sources),
    writeJson(paths.controlNodes, controlNodes),
    writeJson(paths.runtimeNodes, runtimeNodes),
    writeJson(paths.catalog, catalog),
    writeJson(paths.modelsCodex, modelsCodex),
    writeJson(paths.modelsCopilot, modelsCopilot),
    writeJson(paths.launchProfilesCodex, launchProfilesCodex),
    writeJson(paths.launchProfilesCopilot, launchProfilesCopilot),
    writeJson(paths.launchModelsCodex, launchModelsCodex),
    writeJson(paths.launchModelsCopilot, launchModelsCopilot),
    writeJson(paths.launches, launchPage),
    writeJson(paths.sessions, sessions),
    writeJson(paths.metadataCodex, metadataCodex),
    writeJson(paths.metadataCopilot, metadataCopilot),
    writeJson(paths.historyCodex, historyCodex),
    writeJson(paths.historyCopilot, historyCopilot),
    writeJson(paths.interactions, interactions),
    writeJson(paths.interactionsAll, interactionsAll),
  ]);

  const commandRecords = terminalRecords(events, "command.changed", "command", "commandId");
  const metadataOperations = terminalRecords(
    events,
    "metadata.operation",
    "operation",
    "operationId",
  );
  const interactionEvents = events.filter((event) =>
    event.kind === "control" && event.change?.type === "interaction.changed"
  );
  await writeJson(paths.commands, commandRecords);
  await writeJson(paths.metadataOperations, metadataOperations);
  await writeJson(paths.interactionEvents, interactionEvents);

  const codexSession = sessions.find((session) => session.sessionId === codexPlan.sessionId);
  const copilotSession = sessions.find((session) => session.sessionId === copilotPlan.sessionId);
  assert(codexSession?.harness === "codex", "Codex UI session has the wrong harness");
  assert(copilotSession?.harness === "copilot", "Copilot UI session has the wrong harness");
  const terminalCodex = await client.terminals.get.query({
    sessionId: codexSession.sessionId,
    runtimeNodeId: codexSession.runtimeNodeId,
    bindingRevision: codexSession.bindingRevision,
  });
  await writeJson(paths.terminalCodex, terminalCodex);

  const authority = controlNodes[0];
  const topologyChecks = {
    gatewayHasZeroAuthority:
      system.protocolVersion === 4 &&
      system.componentKind === "access-gateway" &&
      system.dataAuthority === "none",
    exactlyOneSelectedControlSource:
      sources.length === 1 &&
      sources[0]?.state === "selected" &&
      sources[0]?.manifest?.coveredControlNodeIds.length === 1,
    exactlyOneCanonicalAuthority:
      controlNodes.length === 1 &&
      authority?.presence === "online" &&
      authority?.dataRole.role === "authority" &&
      authority?.protocolVersion === 4,
    exactlyTwoOnlineRuntimeNodes:
      runtimeNodes.length === 2 &&
      runtimeNodes.every((node) =>
        node.presence === "online" &&
        node.reachability === "reachable" &&
        node.ownerControlNodeId === authority?.controlNodeId &&
        node.allowedRoots.includes("/workspace/project"),
      ),
    harnessIsolation:
      codexRuntime.harnesses.length === 1 &&
      codexRuntime.harnesses[0]?.harness === "codex" &&
      codexRuntime.harnesses[0]?.available === true &&
      copilotRuntime.harnesses.length === 1 &&
      copilotRuntime.harnesses[0]?.harness === "copilot" &&
      copilotRuntime.harnesses[0]?.available === true,
    exactDirectLaunchProfiles:
      launchProfilesCodex.length === 1 &&
      sameProfileDescriptor(launchProfilesCodex[0], codexProfile) &&
      launchProfilesCopilot.length === 1 &&
      sameProfileDescriptor(launchProfilesCopilot[0], copilotProfile),
    codexStableTerminalCapability:
      codexRuntime.harnesses[0]?.capabilities.some((capability) =>
        capability.name === "terminal.side-channel" &&
        capability.version === "v1" &&
        capability.experimental === false
      ) === true,
    copilotExperimentalTerminalDisabled:
      copilotRuntime.harnesses[0]?.capabilities.every((capability) =>
        capability.name !== "terminal.side-channel"
      ) === true,
    exactlyTwoUiSessions:
      sessions.length === 2 &&
      codexSession?.runtimeNodeId === codexRuntime.runtimeNodeId &&
      copilotSession?.runtimeNodeId === copilotRuntime.runtimeNodeId,
    bothSessionsOpenAndActivelyBound:
      codexSession?.catalogState === "open" &&
      codexSession.archivedAt === null &&
      codexSession.availability === "active" &&
      copilotSession?.catalogState === "open" &&
      copilotSession.archivedAt === null &&
      copilotSession.availability === "active",
    soleMetadataAuthority:
      codexSession?.metadataAuthority.controlNodeId === authority?.controlNodeId &&
      copilotSession?.metadataAuthority.controlNodeId === authority?.controlNodeId,
  };

  const metadataChecks = {
    codexUiPatchCommitted:
      metadataCodex.values["agent.title"] === codexPlan.finalTitle &&
      metadataCodex.values["receipt.live"]?.runId === browser.runId &&
      metadataCodex.values["receipt.live"]?.harness === "codex" &&
      metadataCodex.values["receipt.live"]?.source === "browser-ui" &&
      metadataCodex.revision >= 2 &&
      metadataCodex.keyRevisions["agent.title"] >= 2 &&
      metadataCodex.keyRevisions["receipt.live"] >= 2,
    copilotUiPatchCommitted:
      metadataCopilot.values["agent.title"] === copilotPlan.finalTitle &&
      metadataCopilot.values["receipt.live"]?.runId === browser.runId &&
      metadataCopilot.values["receipt.live"]?.harness === "copilot" &&
      metadataCopilot.values["receipt.live"]?.source === "browser-ui" &&
      metadataCopilot.revision >= 2 &&
      metadataCopilot.keyRevisions["agent.title"] >= 2 &&
      metadataCopilot.keyRevisions["receipt.live"] >= 2,
    launchInitializationAndUiCasOperationsAccepted:
      metadataLifecycleSucceeded(metadataOperations, codexPlan, "codex", browser.runId) &&
      metadataLifecycleSucceeded(metadataOperations, copilotPlan, "copilot", browser.runId),
    noMetadataConflictOrUnknown:
      metadataOperations.every((operation) =>
        operation.status !== "conflicted" && operation.status !== "outcomeUnknown",
      ),
  };

  const streamProof = verifyStreams(events, codexPlan, copilotPlan);
  await writeJson(paths.stream, streamProof);
  const controlsProof = verifyCodexControls(
    logicalEvents,
    commandRecords,
    interactionsAll,
    codexPlan,
    codexSession,
  );
  await writeJson(paths.codexControls, controlsProof);
  const commandChecks = {
    exactlyTwoLaunchOperations:
      launches.length === 2 &&
      new Set(launches.map((record) => record.launchId)).size === 2,
    bothLaunchesSucceeded:
      launchSucceeded(launches, codexSession, codexPlan, codexProfile) &&
      launchSucceeded(launches, copilotSession, copilotPlan, copilotProfile),
    bothPromptCommandsSucceeded:
      sendSucceeded(commandRecords, codexSession, codexPlan.prompt) &&
      sendSucceeded(commandRecords, copilotSession, copilotPlan.prompt),
    codexModelCommandSucceeded: controlsProof.assertions.modelCommandSucceeded,
    codexPlanModeCommandsSucceeded: controlsProof.assertions.planModeCommandsSucceeded,
    codexPlanPromptCommandSucceeded: controlsProof.assertions.planPromptCommandSucceeded,
    codexInterruptCommandsSucceeded: controlsProof.assertions.interruptCommandsSucceeded,
    codexStructuredPostTerminalCommandSucceeded:
      sendSucceeded(
        commandRecords,
        codexSession,
        codexPlan.terminal.structuredAfterTermination.prompt,
      ),
    noFailedOrAmbiguousCommand:
      commandRecords.every((record) =>
        record.state !== "failed" && record.state !== "outcomeUnknown",
      ),
  };
  const nativeHistoryChecks = {
    codexHistoryReadNatively:
      historyCodex.harness === "codex" &&
      historyCodex.vendorSessionId === codexSession.vendorSessionId &&
      historyCodex.complete === true &&
      deepContainsExact(historyCodex.payload, codexPlan.marker) &&
      deepContainsExact(historyCodex.payload, codexPlan.controls.plan.finalMarker) &&
      (
        !browser.soak?.performed ||
        deepContainsExact(historyCodex.payload, browser.soak.replies?.codex?.marker)
      ) &&
      codexHistoryCommandContains(historyCodex.payload, codexPlan.controls.interrupt.visibleTick) &&
      deepContainsExact(historyCodex.payload, codexPlan.terminal.semanticPrompt.reply) &&
      deepContainsExact(
        historyCodex.payload,
        codexPlan.terminal.structuredAfterTermination.marker,
      ) &&
      !codexHistoryAgentMessageEquals(
        historyCodex.payload,
        codexPlan.controls.interrupt.forbiddenMarker,
      ),
    copilotHistoryReadNatively:
      historyCopilot.harness === "copilot" &&
      historyCopilot.vendorSessionId === copilotSession.vendorSessionId &&
      deepContainsExact(historyCopilot.payload, copilotPlan.marker) &&
      (
        !browser.soak?.performed ||
        deepContainsExact(historyCopilot.payload, browser.soak.replies?.copilot?.marker)
      ),
    noPendingInteractions: interactions.length === 0,
  };
  const browserChecks = {
    passed: browser.passed === true,
    twoUiSpawns: browser.assertions?.bothSessionsSpawnedThroughUi === true,
    twoUiMetadataEdits: browser.assertions?.bothMetadataDocumentsEditedThroughUi === true,
    twoUiPrompts: browser.assertions?.bothPromptsSentThroughUi === true,
    twoVisibleReplies: browser.assertions?.bothAssistantMarkersVisibleInChat === true,
    codexControlsPassed:
      browser.assertions?.codexModelSwitchedThroughUi === true &&
      browser.assertions?.codexPlanModeSetThroughUi === true &&
      browser.assertions?.codexPlanQuestionAnsweredThroughUi === true &&
      browser.assertions?.codexPlanTypedAnswerVisibleInChat === true &&
      browser.assertions?.codexReturnedToDefaultModeThroughUi === true &&
      browser.assertions?.codexActiveTurnInterruptedThroughUi === true &&
      browser.assertions?.codexLongCommandStoppedEarly === true,
    codexModelPersistedAfterReload:
      browser.assertions?.codexModelPersistedAfterReload === true &&
      codexPlan.controls?.model?.persistedAfterReload === true,
    reloadHydratedNativeHistory:
      browser.assertions?.browserReloadHydratedBothNativeHistories === true &&
      browser.assertions?.postReloadNativeHistoryCalls >= 2,
    urlTokenAutoConnectedAfterReload:
      browser.assertions?.urlTokenAutoConnectedAfterReload === true,
    noBrowserErrors:
      browser.assertions?.unexpectedBrowserErrors === 0 &&
      browser.assertions?.unrecoveredTransientNativeHistoryCalls === 0 &&
      browser.assertions?.failedSameOriginRequests === 0,
    responsiveMatrixPassed:
      browser.assertions?.responsiveViewportsChecked === 6 &&
      Array.isArray(browser.responsive) &&
      browser.responsive.length === 6,
    noResponsiveOverflowOrClipping:
      browser.assertions?.responsiveDocumentOverflows === 0 &&
      browser.assertions?.responsiveClippedEssentials === 0,
    noSeriousOrCriticalAccessibilityViolations:
      browser.assertions?.seriousOrCriticalAccessibilityViolations === 0,
    responsiveSheetsAccessible:
      browser.responsive?.every((entry) =>
        entry.mode === "desktop" ||
        (entry.inspectorSheetAccessible === true && entry.sheetFocusRestored === true)
      ) === true &&
      browser.responsive?.filter((entry) => entry.mode === "mobile").every((entry) =>
        entry.navigationSheetAccessible === true
      ) === true,
    terminalReceiptContract:
      /^[a-f0-9]{64}$/.test(codexPlan.terminal.ephemeralDraft.sha256) &&
      codexPlan.terminal.ephemeralDraft.utf8Bytes > 0 &&
      codexPlan.terminal.ephemeralDraft.transportedAsOneInputFrame === true &&
      codexPlan.terminal.ephemeralDraft.valueRecordedInTextReceipt === false &&
      !JSON.stringify(browser).includes("PTY_ONLY_"),
    codexTerminalTwoViewerLifecycle:
      browser.assertions?.codexChatWasDefaultBeforeTerminal === true &&
      browser.assertions?.codexTerminalOpenedThroughUi === true &&
      browser.assertions?.codexTerminalUsedStockRemoteTui === true &&
      browser.assertions?.codexTerminalHadTwoReadOnlyViewers === true &&
      browser.assertions?.codexTerminalKeyboardLeaseAcquired === true &&
      browser.assertions?.codexTerminalRawDraftStreamedToBothViewers === true &&
      browser.assertions?.codexTerminalRawDraftClearedWithoutSubmission === true &&
      browser.assertions?.codexTerminalSemanticPromptCompleted === true &&
      browser.assertions?.codexTerminalResizePropagated === true &&
      browser.assertions?.codexTerminalRuntimeStylesNonceBound === true &&
      terminalRuntimeStyleProofPassed(codexPlan.terminal.runtimeStyles?.operator) &&
      terminalRuntimeStyleProofPassed(codexPlan.terminal.runtimeStyles?.observer) &&
      browser.assertions?.codexTerminalTerminatedThroughConfirmation === true,
    codexTerminalExitedWithoutStoppingStructuredChat:
      terminalCodex?.backend === "codex-remote" &&
      terminalCodex?.sharing === "session" &&
      terminalCodex?.state === "exited" &&
      terminalCodex?.lease === null &&
      terminalCodex?.capabilities?.restart === true &&
      browser.assertions?.codexStructuredChatWorkedAfterTerminalExit === true,
    copilotTerminalOptInStateVisible:
      browser.assertions?.copilotTerminalDisabledByDefault === true &&
      copilotPlan.terminal.capabilityAdvertised === false &&
      copilotPlan.terminal.warningVisible === true &&
      copilotPlan.terminal.openActionAbsent === true,
  };
  const postSoakChecks = verifyPostSoak(
    logicalEvents,
    commandRecords,
    codexSession,
    copilotSession,
    browser.soak,
    browser.assertions,
  );
  const watcherChecks = {
    completed: watcher.passed === true,
    sawNativeEvents: watcher.nativeCount > 0,
    noNativeGap: watcher.nativeGapCount === 0 &&
      events.every((event) => event.kind !== "nativeGap"),
  };
  const modelChecks = {
    requestedCodexModelAdvertisedForDirectProfile:
      launchModelsCodex.some((model) => model.id === codexPlan.model),
    secondCodexModelAdvertisedForDirectProfile:
      codexPlan.secondModel !== codexPlan.model &&
      launchModelsCodex.some((model) => model.id === codexPlan.secondModel),
    secondCodexModelAdvertisedForInteractiveControl:
      modelsCodex.some((model) => model.id === codexPlan.secondModel),
    requestedCopilotByokModelAdvertisedForDirectProfile: launchModelsCopilot.some((model) =>
      model.id === copilotPlan.model &&
      model.native?.byok === true &&
      model.native?.wireApi === "responses" &&
      model.native?.transport === "http",
    ),
    requestedCopilotByokModelAdvertisedForInteractiveControl: modelsCopilot.some((model) =>
      model.id === copilotPlan.model &&
      model.native?.byok === true &&
      model.native?.wireApi === "responses" &&
      model.native?.transport === "http",
    ),
  };
  const terminalNormalizedChecks = {
    privateCanaryDigestMatchesBrowserReceipt:
      sha256Hex(terminalMarker) === codexPlan.terminal.ephemeralDraft.sha256 &&
      Buffer.byteLength(terminalMarker, "utf8") ===
        codexPlan.terminal.ephemeralDraft.utf8Bytes,
    absentFromNativeHistoryResponses:
      !containsTerminalCanary(historyCodex, terminalMarker) &&
      !containsTerminalCanary(historyCopilot, terminalMarker),
    absentFromFleetEventJournal:
      !containsTerminalCanary(events, terminalMarker),
    absentFromFleetSnapshots:
      !containsTerminalCanary(sources, terminalMarker) &&
      !containsTerminalCanary(controlNodes, terminalMarker) &&
      !containsTerminalCanary(runtimeNodes, terminalMarker) &&
      !containsTerminalCanary(sessions, terminalMarker) &&
      !containsTerminalCanary(catalog, terminalMarker),
    absentFromMetadataDocuments:
      !containsTerminalCanary(metadataCodex, terminalMarker) &&
      !containsTerminalCanary(metadataCopilot, terminalMarker),
    absentFromNormalizedControlRecords:
      !containsTerminalCanary(commandRecords, terminalMarker) &&
      !containsTerminalCanary(metadataOperations, terminalMarker) &&
      !containsTerminalCanary(interactionsAll, terminalMarker),
    absentFromTerminalDescriptor:
      !containsTerminalCanary(terminalCodex, terminalMarker),
  };
  await writeJson(paths.terminalNormalized, {
    passed: allTrue(terminalNormalizedChecks),
    markerSha256: sha256Hex(terminalMarker),
    markerRawValueRecorded: false,
    encodingsChecked: ["raw UTF-8", "canonical base64 terminal-frame candidates"],
    assertions: terminalNormalizedChecks,
  });

  const checks = {
    passed: [
      topologyChecks,
      metadataChecks,
      streamProof.assertions,
      controlsProof.assertions,
      commandChecks,
      nativeHistoryChecks,
      browserChecks,
      postSoakChecks,
      watcherChecks,
      modelChecks,
      terminalNormalizedChecks,
    ].every(allTrue),
    topology: topologyChecks,
    metadata: metadataChecks,
    streams: streamProof.assertions,
    codexControls: controlsProof.assertions,
    commands: commandChecks,
    nativeHistory: nativeHistoryChecks,
    browser: browserChecks,
    postSoak: postSoakChecks,
    watcher: watcherChecks,
    models: modelChecks,
    terminalEphemerality: terminalNormalizedChecks,
    counts: {
      accessItems: events.length,
      nativeEvents: events.filter((event) => event.kind === "native").length,
      terminalCommands: commandRecords.length,
      launchOperations: launches.length,
      metadataOperations: metadataOperations.length,
      planInteractionEvents: interactionEvents.filter((event) =>
        event.change.interaction?.interactionId === codexPlan.controls.plan.interactionId
      ).length,
      sessions: sessions.length,
    },
  };
  await writeJson(paths.checks, checks);
  assert(checks.passed, "one or more final acceptance checks failed");
  process.stdout.write(`${JSON.stringify({
    passed: true,
    verifiedAt: now(),
    sessionIds: { codex: codexPlan.sessionId, copilot: copilotPlan.sessionId },
    markers: {
      codex: codexPlan.marker,
      copilot: copilotPlan.marker,
      plan: codexPlan.controls.plan.finalMarker,
      interruptVisibleTick: codexPlan.controls.interrupt.visibleTick,
      terminalSemantic: codexPlan.terminal.semanticPrompt.reply,
      structuredAfterTerminal: codexPlan.terminal.structuredAfterTermination.marker,
    },
    counts: checks.counts,
    checks: "checks.json",
  }, null, 2)}\n`);
} catch (error) {
  await writeJson(paths.failure, { failedAt: now(), error: errorText(error) }).catch(() => undefined);
  throw error;
} finally {
  handle.close();
}

function verifyPostSoak(
  events,
  commandRecords,
  codexSession,
  copilotSession,
  soak,
  assertions,
) {
  const requested = Number.isSafeInteger(soak?.requestedMs) && soak.requestedMs > 0;
  const codexComplete = requested
    ? [...events].reverse().find((event) =>
      event.kind === "native" &&
      event.sessionId === codexSession.sessionId &&
      event.nativeType === "item/completed" &&
      event.payload?.item?.type === "agentMessage" &&
      event.payload?.item?.text === soak.replies?.codex?.marker,
    )
    : undefined;
  const codexDeltas = codexComplete
    ? events.filter((event) =>
      event.kind === "native" &&
      event.sessionId === codexSession.sessionId &&
      event.runtimeEpoch === codexComplete.runtimeEpoch &&
      event.nativeType === "item/agentMessage/delta" &&
      event.payload?.turnId === codexComplete.payload?.turnId &&
      event.payload?.itemId === codexComplete.payload?.item?.id,
    )
    : [];
  const copilotComplete = requested
    ? [...events].reverse().find((event) =>
      event.kind === "native" &&
      event.sessionId === copilotSession.sessionId &&
      event.nativeType === "assistant.message" &&
      event.payload?.data?.content === soak.replies?.copilot?.marker,
    )
    : undefined;
  const copilotDeltas = copilotComplete
    ? events.filter((event) =>
      event.kind === "native" &&
      event.sessionId === copilotSession.sessionId &&
      event.runtimeEpoch === copilotComplete.runtimeEpoch &&
      event.nativeType === "assistant.message_delta" &&
      event.payload?.data?.messageId === copilotComplete.payload?.data?.messageId,
    )
    : [];

  return {
    requestConsistent:
      requested === (soak?.performed === true) &&
      (
        !requested ||
        (
          soak.replies?.codex?.prompt ===
            `Reply with exactly ${soak.replies?.codex?.marker} and nothing else.` &&
          soak.replies?.copilot?.prompt ===
            `Reply with exactly ${soak.replies?.copilot?.marker} and nothing else.`
        )
      ),
    elapsed:
      !requested ||
      (
        typeof soak.startedAt === "string" &&
        typeof soak.completedAt === "string" &&
        Number.isSafeInteger(soak.elapsedMs) &&
        soak.elapsedMs >= soak.requestedMs
      ),
    selectedSourceStayedAvailable:
      !requested ||
      (
        soak.sourceSelected === true &&
        assertions?.postSoakSourceSelected === true
      ),
    bothRuntimesStayedOnline:
      !requested ||
      (
        soak.bothRuntimesOnline === true &&
        assertions?.postSoakBothRuntimesOnline === true
      ),
    bothSessionsStayedProjected:
      !requested ||
      (
        soak.bothSessionsRetained === true &&
        assertions?.postSoakBothSessionsRetained === true
      ),
    freshCodexCommandSucceeded:
      !requested || sendSucceeded(commandRecords, codexSession, soak.replies?.codex?.prompt),
    freshCopilotCommandSucceeded:
      !requested || sendSucceeded(commandRecords, copilotSession, soak.replies?.copilot?.prompt),
    freshCodexReplyCompleted:
      !requested ||
      (
        assertions?.postSoakLivenessTested === true &&
        assertions?.postSoakBothRepliesStreamed === true &&
        soak.bothRepliesStreamed === true &&
        soak.replies?.codex?.streamed === true &&
        codexComplete !== undefined
      ),
    freshCopilotReplyCompleted:
      !requested ||
      (
        assertions?.postSoakLivenessTested === true &&
        assertions?.postSoakBothRepliesStreamed === true &&
        soak.bothRepliesStreamed === true &&
        soak.replies?.copilot?.streamed === true &&
        copilotComplete !== undefined
      ),
    freshCodexReplyDeltasReassembledExactly:
      !requested ||
      (
        codexDeltas.length >= 1 &&
        codexDeltas.every((event) => event.sequence < codexComplete.sequence) &&
        codexDeltas.map((event) => event.payload.delta).join("") ===
          soak.replies?.codex?.marker
      ),
    freshCopilotReplyDeltasReassembledExactly:
      !requested ||
      (
        copilotDeltas.length >= 1 &&
        copilotDeltas.every((event) => event.sequence < copilotComplete.sequence) &&
        copilotDeltas.map((event) => event.payload?.data?.deltaContent).join("") ===
          soak.replies?.copilot?.marker
      ),
  };
}

function verifyStreams(events, codexPlan, copilotPlan) {
  const segments = [[]];
  for (const event of events) {
    if (event.kind === "streamReset") {
      segments.push([]);
    } else if (event.kind === "native") {
      segments.at(-1).push(event);
    }
  }

  const duplicateKeys = [];
  const noncontiguousGroups = [];
  const segmentDiagnostics = [];
  for (const [segmentIndex, segment] of segments.entries()) {
    const sequenceGroups = new Map();
    for (const event of segment) {
      const key = `${event.sessionId}\0${event.runtimeEpoch}`;
      const group = sequenceGroups.get(key) ?? [];
      if (group.some((candidate) => candidate.sequence === event.sequence)) {
        duplicateKeys.push(`${segmentIndex}\0${key}\0${event.sequence}`);
      }
      group.push(event);
      sequenceGroups.set(key, group);
    }
    for (const [key, group] of sequenceGroups) {
      for (let index = 0; index < group.length; index += 1) {
        if (group[index].sequence !== index) {
          noncontiguousGroups.push({
            segmentIndex,
            key,
            expected: index,
            actual: group[index].sequence,
          });
          break;
        }
      }
    }
    segmentDiagnostics.push({
      segmentIndex,
      nativeEventCount: segment.length,
      sequenceGroupCount: sequenceGroups.size,
    });
  }

  const nativeByIdentity = new Map();
  const replayedKeys = [];
  const crossSegmentReplayKeys = [];
  const conflictingReplayKeys = [];
  for (const [segmentIndex, segment] of segments.entries()) {
    for (const event of segment) {
      const key = `${event.sessionId}\0${event.runtimeEpoch}\0${event.sequence}`;
      const previous = nativeByIdentity.get(key);
      if (previous === undefined) {
        nativeByIdentity.set(key, { event, segmentIndex });
        continue;
      }
      replayedKeys.push(key);
      if (previous.segmentIndex !== segmentIndex) crossSegmentReplayKeys.push(key);
      if (!sameNativeEvent(previous.event, event)) {
        conflictingReplayKeys.push(key);
      }
    }
  }
  const native = [...nativeByIdentity.values()].map(({ event }) => event);

  const codexEvents = native.filter((event) => event.sessionId === codexPlan.sessionId);
  const codexComplete = [...codexEvents].reverse().find((event) =>
    event.nativeType === "item/completed" &&
    event.payload?.item?.type === "agentMessage" &&
    event.payload?.item?.text === codexPlan.marker,
  );
  const codexDeltas = codexComplete
    ? codexEvents.filter((event) =>
      event.nativeType === "item/agentMessage/delta" &&
      event.runtimeEpoch === codexComplete.runtimeEpoch &&
      event.payload?.turnId === codexComplete.payload?.turnId &&
      event.payload?.itemId === codexComplete.payload?.item?.id,
    )
    : [];
  const codexTurnCompleted = codexComplete
    ? codexEvents.some((event) =>
      event.nativeType === "turn/completed" &&
      event.runtimeEpoch === codexComplete.runtimeEpoch &&
      event.payload?.turn?.id === codexComplete.payload?.turnId &&
      event.payload?.turn?.status === "completed" &&
      event.sequence > codexComplete.sequence,
    )
    : false;

  const copilotEvents = native.filter((event) => event.sessionId === copilotPlan.sessionId);
  const copilotComplete = [...copilotEvents].reverse().find((event) =>
    event.nativeType === "assistant.message" &&
    event.payload?.data?.content === copilotPlan.marker,
  );
  const copilotDeltas = copilotComplete
    ? copilotEvents.filter((event) =>
      event.nativeType === "assistant.message_delta" &&
      event.runtimeEpoch === copilotComplete.runtimeEpoch &&
      event.payload?.data?.messageId === copilotComplete.payload?.data?.messageId,
    )
    : [];
  const copilotIdle = copilotComplete
    ? copilotEvents.some((event) =>
      event.nativeType === "session.idle" &&
      event.runtimeEpoch === copilotComplete.runtimeEpoch &&
      event.sequence > copilotComplete.sequence,
    )
    : false;

  return {
    assertions: {
      noDuplicateNativeSequenceWithinSegment: duplicateKeys.length === 0,
      everyNativeEpochStartsAtZeroAndIsContiguous: noncontiguousGroups.length === 0,
      replayedNativeEventsIdentical: conflictingReplayKeys.length === 0,
      codexCompletedExactMarker: codexComplete !== undefined,
      codexDeltaStreamReassembledExactly:
        codexDeltas.length >= 1 &&
        codexDeltas.every((event) => event.sequence < codexComplete.sequence) &&
        codexDeltas.map((event) => event.payload.delta).join("") === codexPlan.marker,
      codexTurnCompletedAfterMessage: codexTurnCompleted,
      copilotCompletedExactMarker: copilotComplete !== undefined,
      copilotDeltaStreamReassembledExactly:
        copilotDeltas.length >= 1 &&
        copilotDeltas.every((event) => event.sequence < copilotComplete.sequence) &&
        copilotDeltas.map((event) => event.payload.data.deltaContent).join("") ===
          copilotPlan.marker,
      copilotIdleAfterMessage: copilotIdle,
      noNativeGap: events.every((event) => event.kind !== "nativeGap"),
    },
    codex: {
      nativeEventCount: codexEvents.length,
      deltaCount: codexDeltas.length,
      finalSequence: codexComplete?.sequence ?? null,
      reconstructed: codexDeltas.map((event) => event.payload.delta).join(""),
    },
    copilot: {
      nativeEventCount: copilotEvents.length,
      deltaCount: copilotDeltas.length,
      finalSequence: copilotComplete?.sequence ?? null,
      reconstructed: copilotDeltas.map((event) => event.payload.data.deltaContent).join(""),
    },
    rawNativeEventCount: segments.reduce((total, segment) => total + segment.length, 0),
    uniqueNativeEventCount: native.length,
    replayCount: replayedKeys.length,
    crossSegmentReplayCount: crossSegmentReplayKeys.length,
    streamResetCount: Math.max(0, segments.length - 1),
    segments: segmentDiagnostics,
    withinSegmentDuplicateKeys: duplicateKeys,
    conflictingReplays: conflictingReplayKeys,
    noncontiguousGroups,
  };
}

function withoutNativeReplays(events) {
  const seen = new Set();
  return events.filter((event) => {
    if (event.kind !== "native") return true;
    const key = `${event.sessionId}\0${event.runtimeEpoch}\0${event.sequence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameNativeEvent(left, right) {
  const { receivedAt: _leftReceivedAt, ...leftNative } = left;
  const { receivedAt: _rightReceivedAt, ...rightNative } = right;
  return sameJson(leftNative, rightNative);
}

function verifyCodexControls(events, commands, interactions, plan, session) {
  const controls = plan.controls;
  const codexEvents = events.filter((event) =>
    event.kind === "native" &&
    event.sessionId === session.sessionId &&
    session.runtimeEpoch != null &&
    event.runtimeEpoch === session.runtimeEpoch
  );
  const commandById = (commandId) => commands.find((record) => record.commandId === commandId);
  const commandMatches = (commandId, predicate) => {
    const record = commandById(commandId);
    return record?.sessionId === session.sessionId &&
      record.state === "succeeded" &&
      predicate(record.request?.request);
  };

  const modelCommandSucceeded = commandMatches(
    controls.model.commandId,
    (request) => request?.harness === "codex" &&
      request.command?.type === "setModel" &&
      request.command.model === plan.secondModel,
  );
  const modelSettings = codexEvents.find((event) =>
    event.nativeType === "thread/settings/updated" &&
    event.payload?.threadSettings?.model === plan.secondModel
  );

  const planModeCommand = commandMatches(
    controls.plan.modeCommandId,
    (request) => request?.harness === "codex" &&
      request.command?.type === "setMode" &&
      request.command.mode === "plan",
  );
  const defaultModeCommand = commandMatches(
    controls.plan.defaultCommandId,
    (request) => request?.harness === "codex" &&
      request.command?.type === "setMode" &&
      request.command.mode === "default",
  );
  const planSettings = codexEvents.find((event) =>
    event.nativeType === "thread/settings/updated" &&
    event.payload?.threadSettings?.model === plan.secondModel &&
    event.payload?.threadSettings?.collaborationMode?.mode === "plan"
  );
  const defaultSettings = codexEvents.find((event) =>
    event.nativeType === "thread/settings/updated" &&
    event.payload?.threadSettings?.collaborationMode?.mode === "default" &&
    (planSettings === undefined || event.sequence > planSettings.sequence)
  );
  const planPromptCommand = commandMatches(
    controls.plan.sendCommandId,
    (request) => codexSendMatches(request, controls.plan.prompt),
  );
  const planSendRecord = commandById(controls.plan.sendCommandId);
  const planCommandTurnId = planSendRecord?.result?.turn?.id;

  const interactionEvents = events.filter((event) =>
    event.kind === "control" &&
    event.change?.type === "interaction.changed" &&
    event.change.interaction?.sessionId === session.sessionId &&
    event.change.interaction?.payload?.params?.turnId === controls.plan.turnId &&
    event.change.interaction?.requestType === "userInput"
  );
  const interactionIds = new Set(
    interactionEvents.map((event) => event.change.interaction.interactionId),
  );
  const pendingInteraction = interactionEvents.find((event) =>
    event.change.interaction?.interactionId === controls.plan.interactionId &&
    event.change.interaction.state === "pending" &&
    expectedPlanQuestion(event.change.interaction)
  )?.change.interaction;
  const expectedResolution = {
    answers: { receipt_choice: { answers: [controls.plan.answer] } },
  };
  const resolvedInteractionEvent = interactionEvents.find((event) =>
    event.change.interaction?.interactionId === controls.plan.interactionId &&
    event.change.interaction.state === "resolved" &&
    sameJson(event.change.interaction.resolution, expectedResolution)
  )?.change.interaction;
  const canonicalInteraction = interactions.find((interaction) =>
    interaction.interactionId === controls.plan.interactionId
  );
  const nativeResolution = codexEvents.find((event) =>
    event.nativeType === "serverRequest/resolved" &&
    String(event.payload?.requestId) === controls.plan.nativeRequestId
  );
  const planFinal = codexEvents.find((event) =>
    event.nativeType === "item/completed" &&
    event.payload?.turnId === controls.plan.turnId &&
    event.payload?.item?.type === "agentMessage" &&
    event.payload?.item?.text === controls.plan.finalMarker
  );
  const planTurnCompleted = codexEvents.find((event) =>
    event.nativeType === "turn/completed" &&
    event.payload?.turn?.id === controls.plan.turnId &&
    event.payload?.turn?.status === "completed"
  );

  const interruptSendSucceeded = commandMatches(
    controls.interrupt.sendCommandId,
    (request) => codexSendMatches(request, controls.interrupt.prompt),
  );
  const interruptSendRecord = commandById(controls.interrupt.sendCommandId);
  const interruptCommandSucceeded = commandMatches(
    controls.interrupt.interruptCommandId,
    (request) => request?.harness === "codex" &&
      request.command?.type === "interrupt" &&
      (request.command.turnId === undefined || request.command.turnId === controls.interrupt.turnId),
  );
  const interruptEvents = codexEvents.filter((event) =>
    event.payload?.turnId === controls.interrupt.turnId ||
    event.payload?.turn?.id === controls.interrupt.turnId
  );
  const commandStarted = interruptEvents.find((event) =>
    event.nativeType === "item/started" &&
    event.payload?.item?.id === controls.interrupt.itemId &&
    event.payload?.item?.type === "commandExecution" &&
    event.payload?.item?.status === "inProgress"
  );
  const commandCompleted = interruptEvents.find((event) =>
    event.nativeType === "item/completed" &&
    event.payload?.item?.id === controls.interrupt.itemId &&
    event.payload?.item?.type === "commandExecution" &&
    event.payload?.item?.status !== "inProgress"
  );
  const interruptedTurn = interruptEvents.find((event) =>
    event.nativeType === "turn/completed" &&
    event.payload?.turn?.status === "interrupted"
  );
  const interruptOutput = interruptEvents
    .filter((event) =>
      event.nativeType === "item/commandExecution/outputDelta" &&
      event.payload?.itemId === controls.interrupt.itemId
    )
    .map((event) => typeof event.payload?.delta === "string" ? event.payload.delta : "")
    .join("");
  const ticks = [...interruptOutput.matchAll(
    new RegExp(`${escapeRegExp(controls.interrupt.visibleTick.replace(/_002$/, ""))}_(\\d{3})`, "g"),
  )].map((match) => Number(match[1]));
  const maximumObservedTick = ticks.length > 0 ? Math.max(...ticks) : 0;
  const forbiddenCompletionAbsent = !codexEvents.some((event) =>
    deepContainsExact(event.payload, controls.interrupt.forbiddenMarker)
  );

  return {
    assertions: {
      sessionRuntimeEpochPresent: session.runtimeEpoch != null,
      modelCommandSucceeded,
      modelSettingsUpdatedNatively:
        modelSettings !== undefined &&
        modelSettings.sequence === controls.model.settingsSequence,
      planModeCommandsSucceeded: planModeCommand && defaultModeCommand,
      planModeSettingsUpdatedNatively:
        planSettings !== undefined &&
        defaultSettings !== undefined &&
        planSettings.sequence === controls.plan.modeSettingsSequence &&
        defaultSettings.sequence === controls.plan.defaultSettingsSequence,
      planPromptCommandSucceeded:
        planPromptCommand && planCommandTurnId === controls.plan.turnId,
      exactlyOnePlanUserInput:
        interactionIds.size === 1 && interactionIds.has(controls.plan.interactionId),
      planInteractionPendingAndResolved:
        pendingInteraction !== undefined &&
        resolvedInteractionEvent !== undefined &&
        canonicalInteraction?.state === "resolved" &&
        sameJson(canonicalInteraction.resolution, expectedResolution),
      planResolutionAcknowledgedNatively:
        nativeResolution !== undefined &&
        nativeResolution.sequence === controls.plan.resolvedNativeSequence,
      planTypedAnswerCompletedExactly:
        planFinal !== undefined &&
        planTurnCompleted !== undefined &&
        planFinal.sequence === controls.plan.finalMessageSequence &&
        planTurnCompleted.sequence === controls.plan.completedSequence &&
        planFinal.sequence < planTurnCompleted.sequence,
      interruptCommandsSucceeded:
        interruptSendSucceeded &&
        interruptSendRecord?.result?.turn?.id === controls.interrupt.turnId &&
        interruptCommandSucceeded,
      interruptCommandWasVisibleAndRunning:
        commandStarted !== undefined &&
        interruptOutput.includes(controls.interrupt.visibleTick),
      interruptLifecycleCompleted:
        interruptedTurn !== undefined &&
        commandCompleted !== undefined &&
        interruptedTurn.sequence === controls.interrupt.interruptedSequence &&
        commandCompleted.sequence === controls.interrupt.commandCompletedSequence,
      interruptStoppedOutputEarly:
        controls.interrupt.outputStabilized === true &&
        maximumObservedTick >= 2 &&
        maximumObservedTick < 30 &&
        maximumObservedTick === controls.interrupt.maximumObservedTick,
      interruptForbiddenCompletionAbsent: forbiddenCompletionAbsent,
    },
    model: {
      requested: plan.secondModel,
      commandId: controls.model.commandId,
      settingsSequence: modelSettings?.sequence ?? null,
    },
    plan: {
      turnId: controls.plan.turnId,
      interactionId: controls.plan.interactionId,
      nativeRequestId: controls.plan.nativeRequestId,
      answer: controls.plan.answer,
      finalMarker: controls.plan.finalMarker,
      logicalInteractionCount: interactionIds.size,
      states: interactionEvents.map((event) => event.change.interaction.state),
      nativeResolutionSequence: nativeResolution?.sequence ?? null,
      finalMessageSequence: planFinal?.sequence ?? null,
      completedSequence: planTurnCompleted?.sequence ?? null,
    },
    interrupt: {
      turnId: controls.interrupt.turnId,
      itemId: controls.interrupt.itemId,
      outputDeltaCount: interruptEvents.filter((event) =>
        event.nativeType === "item/commandExecution/outputDelta"
      ).length,
      maximumObservedTick,
      interruptedSequence: interruptedTurn?.sequence ?? null,
      commandCompletedSequence: commandCompleted?.sequence ?? null,
      forbiddenCompletionAbsent,
    },
  };
}

function terminalRecords(events, changeType, field, idField) {
  const records = new Map();
  for (const event of events) {
    if (event.kind !== "control" || event.change?.type !== changeType) continue;
    const record = event.change[field];
    if (!record?.[idField]) continue;
    const previous = records.get(record[idField]);
    if (!previous || recordRank(record) >= recordRank(previous)) {
      records.set(record[idField], record);
    }
  }
  return [...records.values()].sort((left, right) =>
    String(left.createdAt).localeCompare(String(right.createdAt)),
  );
}

function recordRank(record) {
  const state = {
    received: 0,
    started: 1,
    succeeded: 2,
    failed: 2,
    outcomeUnknown: 2,
    queued: 0,
    accepted: 2,
    conflicted: 2,
  }[record.state ?? record.status] ?? 0;
  return state * 10 ** 15 + (Date.parse(record.updatedAt ?? record.createdAt ?? "") || 0);
}

function launchSucceeded(records, session, plan, advertisedProfile) {
  return records.some((record) =>
    record.sessionId === session.sessionId &&
    record.runtimeNodeId === session.runtimeNodeId &&
    record.state === "succeeded" &&
    record.harness === session.harness &&
    sameProfileIdentity(record.profile, advertisedProfile) &&
    record.implementationVersion === advertisedProfile.implementationVersion &&
    sameJson(record.input, plan.launchInput) &&
    record.metadata?.["agent.title"] === plan.initialTitle &&
    plan.launchProfile?.providerId === advertisedProfile.providerId &&
    plan.launchProfile?.profileId === advertisedProfile.profileId &&
    record.result?.sessionId === session.sessionId &&
    record.result?.adapterScopeId === session.adapterScopeId &&
    record.result?.vendorSessionId === session.vendorSessionId &&
    record.result?.bindingRevision === session.bindingRevision &&
    session.launchProvenance?.launchId === record.launchId &&
    session.launchProvenance?.providerId === advertisedProfile.providerId &&
    session.launchProvenance?.profileId === advertisedProfile.profileId &&
    session.launchProvenance?.contractVersion === advertisedProfile.contractVersion &&
    session.launchProvenance?.requestSchemaHash === advertisedProfile.requestSchemaHash &&
    session.launchProvenance?.implementationVersion === advertisedProfile.implementationVersion &&
    session.launchProvenance?.backendId === record.result?.backendId,
  );
}

function directWorkspaceProfile(runtime, harness) {
  const profiles = runtime.launchProfiles ?? [];
  const matches = profiles.filter((profile) =>
    sameProfileIdentity(profile, expectedDirectWorkspaceProfile) &&
    profile.implementationVersion === expectedDirectWorkspaceProfile.implementationVersion &&
    profile.available === true &&
    sameJson(profile.harnesses, [harness]) &&
    profile.capabilities.some((capability) =>
      capability.name === "workspace.existing-directory" &&
      capability.version === "v1" &&
      capability.experimental === false
    ) &&
    profile.capabilities.some((capability) =>
      capability.name === "isolation.none" &&
      capability.version === "v1" &&
      capability.experimental === false
    )
  );
  assert(
    profiles.length === 1 && matches.length === 1,
    `${harness} runtime did not advertise only the expected core.direct/workspace@1 profile fence`,
  );
  return matches[0];
}

function profileIdentity(profile) {
  return {
    providerId: profile.providerId,
    profileId: profile.profileId,
    contractVersion: profile.contractVersion,
    requestSchemaHash: profile.requestSchemaHash,
  };
}

function sameProfileIdentity(left, right) {
  return left?.providerId === right?.providerId &&
    left?.profileId === right?.profileId &&
    left?.contractVersion === right?.contractVersion &&
    left?.requestSchemaHash === right?.requestSchemaHash;
}

function sameProfileDescriptor(left, right) {
  return sameProfileIdentity(left, right) &&
    left?.implementationVersion === right?.implementationVersion &&
    left?.available === right?.available &&
    sameJson(left?.harnesses, right?.harnesses) &&
    sameJson(left?.capabilities, right?.capabilities);
}

function sendSucceeded(records, session, prompt) {
  return records.some((record) => {
    if (record.sessionId !== session.sessionId || record.state !== "succeeded") return false;
    const request = record.request?.request;
    if (request?.harness !== session.harness || request?.command?.type !== "send") return false;
    return session.harness === "codex"
      ? request.command.input === prompt
      : request.command.prompt === prompt && request.command.mode === "enqueue";
  });
}

function metadataLifecycleSucceeded(operations, plan, harness, runId) {
  const sessionOperations = operations.filter((operation) =>
    operation.sessionId === plan.sessionId && operation.status === "accepted"
  );
  const launchInitialization = sessionOperations.find((operation) =>
    operation.patch?.set?.["agent.title"] === plan.initialTitle &&
    operation.patch?.ifKeyRevision?.["agent.title"] === null
  );
  const uiEdit = sessionOperations.find((operation) =>
    operation.patch?.set?.["agent.title"] === plan.finalTitle &&
    operation.patch?.set?.["receipt.live"]?.runId === runId &&
    operation.patch?.set?.["receipt.live"]?.harness === harness &&
    operation.patch?.set?.["receipt.live"]?.source === "browser-ui" &&
    Number.isSafeInteger(operation.patch?.ifKeyRevision?.["agent.title"]) &&
    operation.patch.ifKeyRevision["agent.title"] >= 1 &&
    operation.patch?.ifKeyRevision?.["receipt.live"] === null
  );
  return launchInitialization !== undefined && uiEdit !== undefined &&
    launchInitialization.operationId !== uiEdit.operationId &&
    launchInitialization.createdAt <= uiEdit.createdAt;
}

function codexSendMatches(request, prompt) {
  return request?.harness === "codex" &&
    request.command?.type === "send" &&
    request.command.input === prompt;
}

function expectedPlanQuestion(interaction) {
  if (
    interaction?.harness !== "codex" ||
    interaction?.requestType !== "userInput" ||
    interaction?.payload?.method !== "item/tool/requestUserInput"
  ) return false;
  const questions = interaction.payload?.params?.questions;
  if (!Array.isArray(questions) || questions.length !== 1) return false;
  const question = questions[0];
  return question?.id === "receipt_choice" &&
    question?.header === "Receipt" &&
    question?.question === "Choose the receipt value" &&
    question?.isOther === true &&
    Array.isArray(question?.options) &&
    question.options.length === 2 &&
    ["Alpha", "Alpha (Recommended)"].includes(question.options[0]?.label) &&
    question.options[1]?.label === "Beta";
}

function sameJson(left, right) {
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

function containsTerminalCanary(value, marker) {
  if (typeof value === "string") {
    if (value.includes(marker)) return true;
    const candidates = value.match(
      /(?:[A-Za-z0-9+/]{4}){8,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/g,
    ) ?? [];
    return candidates.some((candidate) => {
      try {
        return Buffer.from(candidate, "base64").includes(Buffer.from(marker, "utf8"));
      } catch {
        return false;
      }
    });
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsTerminalCanary(item, marker));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => containsTerminalCanary(item, marker));
  }
  return false;
}

function codexHistoryCommandContains(value, expected) {
  if (Array.isArray(value)) {
    return value.some((item) => codexHistoryCommandContains(item, expected));
  }
  if (!value || typeof value !== "object") return false;
  if (
    value.type === "commandExecution" &&
    typeof value.aggregatedOutput === "string" &&
    value.aggregatedOutput.includes(expected)
  ) return true;
  return Object.values(value).some((item) => codexHistoryCommandContains(item, expected));
}

function codexHistoryAgentMessageEquals(value, expected) {
  if (Array.isArray(value)) {
    return value.some((item) => codexHistoryAgentMessageEquals(item, expected));
  }
  if (!value || typeof value !== "object") return false;
  if (value.type === "agentMessage" && value.text === expected) return true;
  return Object.values(value).some((item) => codexHistoryAgentMessageEquals(item, expected));
}

function terminalRuntimeStyleProofPassed(proof) {
  return proof?.styleCount >= 3 &&
    proof.nonceMetadataPresent === true &&
    proof.allNonceMatched === true &&
    proof.allStylesPopulated === true &&
    proof.allStyleSheetsActive === true;
}

function allTrue(record) {
  return Object.values(record).every((value) => value === true);
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function writeJson(filename, value) {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function positiveInteger(value, description) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${description} must be a positive integer`);
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
