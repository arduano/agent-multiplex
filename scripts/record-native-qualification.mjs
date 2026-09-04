import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  assert,
  readJson,
  releaseNativeMinimumSoakMs,
  releaseNodeVersion,
  repositoryRoot,
} from "./release-config.mjs";
import { isCanonicalUtcTimestamp } from "./canonical-utc-timestamp.mjs";
import { browserErrorSummaryPassed } from "./native-browser-evidence.mjs";
import {
  githubCommitStatusResponseMatchesRequest,
} from "./github-commit-status.mjs";
import { nativeStreamSummaryPassed } from "./native-stream-evidence.mjs";

const repository = "arduano/agent-multiplex";
const repositoryOwner = "arduano";
const statusContext = "Agent Multiplex / Native four-container qualification";
const receiptRoot = resolve(
  repositoryRoot,
  "receipts/protocol-v4-live-four-container",
);
const maximumReceiptBytes = 256 * 1024 * 1024;

const requiredEvidenceFiles = Object.freeze([
  "README.md",
  "checks.json",
  "cleanup.json",
  "codex-auth-proof.json",
  "codex-process-proof.json",
  "container-lifecycle.json",
  "copilot-auth-proof.json",
  "copilot-process-proof.json",
  "manifest.json",
  "provider-proof.json",
  "provider-relay-proof.json",
  "resource-summary.json",
  "security-scan.json",
  "summary.json",
  "terminal-ephemerality.json",
  "topology.json",
  "transport-liveness.json",
  "logs/access-gateway.log",
  "logs/browser-driver.log",
  "logs/codex-runtime-node.log",
  "logs/control-node.log",
  "logs/copilot-runtime-node.log",
  "logs/fleet-events.ndjson",
  "logs/verifier.log",
  "logs/watcher.log",
  "phases/browser-ui.json",
  "phases/codex-controls.json",
  "phases/stream-assertions.json",
  "phases/terminal-normalized-surfaces.json",
  "phases/watcher-summary.json",
  "rpc/auth-boundary.json",
  "rpc/control-nodes.json",
  "rpc/harness-catalog.json",
  "rpc/launches.json",
  "rpc/native-history-codex.json",
  "rpc/native-history-copilot.json",
  "rpc/runtime-nodes.json",
  "rpc/sessions.json",
  "rpc/sources.json",
  "rpc/system.json",
  "rpc/terminal-codex-after-exit.json",
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
  "screenshots/12-post-soak-codex-chat.png",
  "screenshots/13-post-soak-copilot-chat.png",
  "screenshots/layout-acceptance-1720x1180.png",
  "screenshots/layout-compact-1024x768.png",
  "screenshots/layout-desktop-1440x900.png",
  "screenshots/layout-phone-landscape-844x390.png",
  "screenshots/layout-phone-portrait-390x844.png",
  "screenshots/layout-tablet-768x1024.png",
]);

const checkAssertionKeys = Object.freeze({
  topology: [
    "gatewayHasZeroAuthority",
    "exactlyOneSelectedControlSource",
    "exactlyOneCanonicalAuthority",
    "exactlyTwoOnlineRuntimeNodes",
    "harnessIsolation",
    "exactDirectLaunchProfiles",
    "codexStableTerminalCapability",
    "copilotExperimentalTerminalDisabled",
    "exactlyTwoUiSessions",
    "bothSessionsOpenAndActivelyBound",
    "soleMetadataAuthority",
  ],
  metadata: [
    "codexUiPatchCommitted",
    "copilotUiPatchCommitted",
    "launchInitializationAndUiCasOperationsAccepted",
    "noMetadataConflictOrUnknown",
  ],
  streams: [
    "noDuplicateNativeSequenceWithinSegment",
    "everyNativeEpochStartsAtZeroAndIsContiguous",
    "replayedNativeEventsIdentical",
    "codexCompletedExactMarker",
    "codexDeltaStreamReassembledExactly",
    "codexTurnCompletedAfterMessage",
    "copilotCompletedExactMarker",
    "copilotDeltaStreamReassembledExactly",
    "copilotIdleAfterMessage",
    "noNativeGap",
  ],
  codexControls: [
    "sessionRuntimeEpochPresent",
    "modelCommandSucceeded",
    "modelSettingsUpdatedNatively",
    "planModeCommandsSucceeded",
    "planModeSettingsUpdatedNatively",
    "planPromptCommandSucceeded",
    "exactlyOnePlanUserInput",
    "planInteractionPendingAndResolved",
    "planResolutionAcknowledgedNatively",
    "planTypedAnswerCompletedExactly",
    "interruptCommandsSucceeded",
    "interruptCommandWasVisibleAndRunning",
    "interruptLifecycleCompleted",
    "interruptStoppedOutputEarly",
    "interruptForbiddenCompletionAbsent",
  ],
  commands: [
    "exactlyTwoLaunchOperations",
    "bothLaunchesSucceeded",
    "bothPromptCommandsSucceeded",
    "codexModelCommandSucceeded",
    "codexPlanModeCommandsSucceeded",
    "codexPlanPromptCommandSucceeded",
    "codexInterruptCommandsSucceeded",
    "codexStructuredPostTerminalCommandSucceeded",
    "noFailedOrAmbiguousCommand",
  ],
  nativeHistory: [
    "codexHistoryReadNatively",
    "copilotHistoryReadNatively",
    "noPendingInteractions",
  ],
  browser: [
    "passed",
    "twoUiSpawns",
    "twoUiMetadataEdits",
    "twoUiPrompts",
    "twoVisibleReplies",
    "codexControlsPassed",
    "codexModelPersistedAfterReload",
    "reloadHydratedNativeHistory",
    "urlTokenAutoConnectedAfterReload",
    "noBrowserErrors",
    "responsiveMatrixPassed",
    "noResponsiveOverflowOrClipping",
    "noSeriousOrCriticalAccessibilityViolations",
    "responsiveSheetsAccessible",
    "terminalReceiptContract",
    "codexTerminalTwoViewerLifecycle",
    "codexTerminalExitedWithoutStoppingStructuredChat",
    "copilotTerminalOptInStateVisible",
  ],
  postSoak: [
    "requestConsistent",
    "elapsed",
    "selectedSourceStayedAvailable",
    "bothRuntimesStayedOnline",
    "bothSessionsStayedProjected",
    "freshCodexCommandSucceeded",
    "freshCopilotCommandSucceeded",
    "freshCodexReplyCompleted",
    "freshCopilotReplyCompleted",
    "freshCodexReplyDeltasReassembledExactly",
    "freshCopilotReplyDeltasReassembledExactly",
  ],
  watcher: ["completed", "sawNativeEvents", "noNativeGap"],
  models: [
    "requestedCodexModelAdvertisedForDirectProfile",
    "secondCodexModelAdvertisedForDirectProfile",
    "secondCodexModelAdvertisedForInteractiveControl",
    "requestedCopilotByokModelAdvertisedForDirectProfile",
    "requestedCopilotByokModelAdvertisedForInteractiveControl",
  ],
  terminalEphemerality: [
    "privateCanaryDigestMatchesBrowserReceipt",
    "absentFromNativeHistoryResponses",
    "absentFromFleetEventJournal",
    "absentFromFleetSnapshots",
    "absentFromMetadataDocuments",
    "absentFromNormalizedControlRecords",
    "absentFromTerminalDescriptor",
  ],
  terminalStorage: [
    "browserCanaryMatchedPrivateMarker",
    "rawCanaryAbsentFromEveryDurableSurface",
    "encodedCanaryAbsentFromEveryDurableSurface",
    "everyApplicationSqliteStoreScanned",
    "nativeHistoryResponsesScanned",
    "gatewayFleetJournalScanned",
    "allApplicationLogsScanned",
    "browserEvidenceContainsOnlyCanaryDigest",
  ],
});

const requiredBrowserAssertions = Object.freeze([
  "browserAuthenticatedToGateway",
  "bothRuntimesVisibleAndOnline",
  "bothSessionsSpawnedThroughUi",
  "bothMetadataDocumentsEditedThroughUi",
  "bothPromptsSentThroughUi",
  "bothAssistantMarkersVisibleInChat",
  "codexModelSwitchedThroughUi",
  "codexPlanModeSetThroughUi",
  "codexPlanQuestionAnsweredThroughUi",
  "codexPlanTypedAnswerVisibleInChat",
  "codexReturnedToDefaultModeThroughUi",
  "codexActiveTurnInterruptedThroughUi",
  "codexLongCommandStoppedEarly",
  "codexModelPersistedAfterReload",
  "codexChatWasDefaultBeforeTerminal",
  "codexTerminalOpenedThroughUi",
  "codexTerminalUsedStockRemoteTui",
  "codexTerminalHadTwoReadOnlyViewers",
  "codexTerminalKeyboardLeaseAcquired",
  "codexTerminalRawDraftStreamedToBothViewers",
  "codexTerminalRawDraftClearedWithoutSubmission",
  "codexTerminalSemanticPromptCompleted",
  "codexTerminalResizePropagated",
  "codexTerminalRuntimeStylesNonceBound",
  "codexTerminalTerminatedThroughConfirmation",
  "codexStructuredChatWorkedAfterTerminalExit",
  "copilotTerminalDisabledByDefault",
  "urlTokenAutoConnectedAfterReload",
  "browserReloadHydratedBothNativeHistories",
  "postReloadBothHistoryStatusesLoaded",
]);

const exactContainerRoles = Object.freeze([
  "canonical durable metadata authority",
  "zero-authority authenticated gateway + web UI",
  "Codex-only runtime node + real codex app-server",
  "Copilot-only runtime node + real Copilot BYOK runtime",
]);

const { receiptArgument, checkOnly } = parseArguments(process.argv.slice(2));
const sourceCommit = qualifySourceCheckout();
const receiptDirectory = resolveReceiptDirectory(receiptArgument);
const receiptSnapshot = captureReceiptSnapshot(receiptDirectory);
const receipt = validateReceipt(receiptSnapshot, receiptDirectory, sourceCommit);
const statusDescription =
  `PASS ${receipt.runId} sha256:${receiptSnapshot.inventorySha256}`;
assert(statusDescription.length <= 140, "native qualification status description is too long");

if (checkOnly) {
  console.log(
    `Native four-container receipt ${receipt.runId} is valid for ${sourceCommit} ` +
      `(inventory ${receiptSnapshot.inventorySha256}).`,
  );
  process.exit(0);
}

const viewer = parseGhObject(ghApi(["user"]), "authenticated GitHub user");
const repositoryMetadata = parseGhObject(
  ghApi([`repos/${repository}`]),
  "GitHub repository",
);
assert(
  viewer.login === repositoryOwner &&
    Number.isSafeInteger(viewer.id) &&
    viewer.id === repositoryMetadata.owner?.id,
  `GitHub status must be recorded by repository owner ${repositoryOwner}; ` +
    `gh is authenticated as ${viewer.login ?? "nobody"}`,
);

// Recapture the complete receipt and require the same canonical inventory that
// supplied every semantic value above. Recomputing an independently replaced
// inventory is not sufficient: its exact bytes must remain pinned.
const finalSnapshot = captureReceiptSnapshot(receiptDirectory);
assert(
  finalSnapshot.inventory === receiptSnapshot.inventory &&
    finalSnapshot.inventorySha256 === receiptSnapshot.inventorySha256,
  "receipt inventory changed while recording native qualification",
);
revalidateSourceCheckout(sourceCommit);

const recordedStatus = parseGhObject(ghApi(
  [
    "--method",
    "POST",
    `repos/${repository}/statuses/${sourceCommit}`,
    "--raw-field",
    "state=success",
    "--raw-field",
    `context=${statusContext}`,
    "--raw-field",
    `description=${statusDescription}`,
    "--raw-field",
    `target_url=https://github.com/${repository}/commit/${sourceCommit}`,
  ],
), "recorded GitHub commit status");
assert(
  githubCommitStatusResponseMatchesRequest(recordedStatus, {
    repository,
    sourceCommit,
    state: "success",
    context: statusContext,
    description: statusDescription,
    targetUrl: `https://github.com/${repository}/commit/${sourceCommit}`,
    creatorId: viewer.id,
  }),
  "GitHub returned a different native qualification status than requested",
);

console.log(
  `Recorded '${statusContext}'=success for ${sourceCommit} from receipt ${receipt.runId} ` +
    `(inventory ${receiptSnapshot.inventorySha256}).`,
);

function parseArguments(arguments_) {
  let receipt;
  let check = false;
  for (const argument of arguments_) {
    if (argument === "--check-only") {
      assert(!check, "--check-only may be specified only once");
      check = true;
      continue;
    }
    assert(!argument.startsWith("-"), `unknown option ${argument}`);
    assert(receipt === undefined, "exactly one receipt directory is required");
    receipt = argument;
  }
  assert(
    typeof receipt === "string" && receipt.length > 0,
    "usage: npm run release:native-status -- [--check-only] receipts/protocol-v4-live-four-container/<run-id>",
  );
  return { receiptArgument: receipt, checkOnly: check };
}

function qualifySourceCheckout() {
  assert(
    git(["rev-parse", "--show-toplevel"]) === repositoryRoot,
    "release qualification must run from this repository checkout",
  );
  assert(
    git(["symbolic-ref", "--quiet", "HEAD"]) === "refs/heads/main",
    "native qualification status may be recorded only from main",
  );
  assert(
    git(["status", "--porcelain=v1", "--untracked-files=all"]) === "",
    "native qualification status requires a clean worktree",
  );

  execFileSync("git", ["fetch", "--no-tags", "origin", "main"], {
    cwd: repositoryRoot,
    stdio: "ignore",
  });

  const head = git(["rev-parse", "--verify", "HEAD^{commit}"]);
  const originMain = git([
    "rev-parse",
    "--verify",
    "refs/remotes/origin/main^{commit}",
  ]);
  assert(/^[0-9a-f]{40}$/.test(head), "HEAD is not a full Git commit ID");
  assert(
    head === originMain,
    `local main ${head} is not exact origin/main ${originMain}`,
  );
  assert(
    git(["status", "--porcelain=v1", "--untracked-files=all"]) === "",
    "the worktree changed while qualifying source",
  );
  return head;
}

function revalidateSourceCheckout(expectedCommit) {
  assert(
    git(["rev-parse", "--verify", "HEAD^{commit}"]) === expectedCommit &&
      git([
        "rev-parse",
        "--verify",
        "refs/remotes/origin/main^{commit}",
      ]) === expectedCommit,
    "main moved while recording native qualification",
  );
  assert(
    git(["status", "--porcelain=v1", "--untracked-files=all"]) === "",
    "the worktree changed while recording native qualification",
  );
}

function resolveReceiptDirectory(argument) {
  const requested = resolve(repositoryRoot, argument);
  assert(
    dirname(requested) === receiptRoot,
    `receipt must be a direct child of ${relative(repositoryRoot, receiptRoot)}`,
  );
  assert(existsSync(receiptRoot), "live receipt root does not exist");
  assert(existsSync(requested), `receipt does not exist: ${argument}`);
  assert(
    realpathSync(dirname(requested)) === realpathSync(receiptRoot),
    "receipt parent resolves outside the live receipt root",
  );
  const receiptStat = lstatSync(requested);
  assert(
    receiptStat.isDirectory() && !receiptStat.isSymbolicLink(),
    "receipt must be a real directory, not a symbolic link",
  );
  assert(
    realpathSync(requested) === requested,
    "receipt directory resolves through a symbolic link",
  );
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(basename(requested)),
    "receipt run ID must start alphanumeric and contain at most 48 supported characters",
  );
  return requested;
}

function validateReceipt(snapshot, directory, expectedCommit) {
  for (const filename of requiredEvidenceFiles) {
    assert(snapshot.files.has(filename), `passing receipt omits ${filename}`);
  }
  for (const forbidden of [
    "FAILED.txt",
    "browser-failure.json",
    "verification-failure.json",
    "handoff.json",
    "cleanup-retained.sh",
    "cleanup-retained-result.json",
  ]) {
    assert(!snapshot.files.has(forbidden), `passing receipt contains ${forbidden}`);
  }

  const manifest = readReceiptObject(snapshot, "manifest.json");
  const checks = readReceiptObject(snapshot, "checks.json");
  const summary = readReceiptObject(snapshot, "summary.json");
  const cleanup = readReceiptObject(snapshot, "cleanup.json");
  const security = readReceiptObject(snapshot, "security-scan.json");
  const topology = readReceiptObject(snapshot, "topology.json");
  const terminal = readReceiptObject(snapshot, "terminal-ephemerality.json");
  const transport = readReceiptObject(snapshot, "transport-liveness.json");
  const provider = readReceiptObject(snapshot, "provider-proof.json");
  const providerRelay = readReceiptObject(snapshot, "provider-relay-proof.json");
  const codexAuth = readReceiptObject(snapshot, "codex-auth-proof.json");
  const copilotAuth = readReceiptObject(snapshot, "copilot-auth-proof.json");
  const lockfile = readJson("package-lock.json");
  const p2prpc = lockfile.packages?.["node_modules/@arduano/p2prpc-core"];
  const codexVersion = readJson("packages/adapter-codex/package.json")
    .dependencies?.["@openai/codex"];
  const copilotManifest = readJson("packages/adapter-copilot/package.json");
  const copilotVersion = copilotManifest.dependencies?.["@github/copilot"];
  const copilotSdkVersion = copilotManifest.dependencies?.["@github/copilot-sdk"];
  assertLockedVersion(lockfile, "@openai/codex", codexVersion);
  assertLockedVersion(lockfile, "@github/copilot", copilotVersion);
  assertLockedVersion(lockfile, "@github/copilot-sdk", copilotSdkVersion);
  assert(
    p2prpc?.version === "0.2.1" &&
      typeof p2prpc.integrity === "string" &&
      p2prpc.integrity.startsWith("sha512-"),
    "source lockfile does not contain the qualified p2prpc 0.2.1 dependency",
  );

  assertExactKeys(manifest, [
    "runId",
    "status",
    "sourceCommit",
    "startedAt",
    "completedAt",
    "topology",
    "versions",
    "models",
    "livenessSoak",
    "imageId",
    "resourcesRetained",
    "credentialMaterialRecorded",
    "evidence",
  ], "manifest");
  assert(manifest.runId === basename(directory), "manifest runId differs from directory");
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(manifest.runId),
    "manifest runId is not safe for a commit-status receipt identity",
  );
  assert(manifest.status === "passed", "manifest status is not passed");
  assert(
    manifest.sourceCommit === expectedCommit,
    "receipt sourceCommit differs from exact main HEAD",
  );
  assertValidTimestamp(manifest.startedAt, "manifest startedAt");
  assertValidTimestamp(manifest.completedAt, "manifest completedAt");
  assert(
    Date.parse(manifest.completedAt) >= Date.parse(manifest.startedAt),
    "receipt completion predates its start",
  );
  assertExactObject(
    manifest.topology,
    {
      applicationContainers: 4,
      canonicalAuthorities: 1,
      runtimeNodes: 2,
      accessGateways: 1,
      onlyGatewayPublished: true,
    },
    "manifest topology",
  );
  assertExactKeys(manifest.versions, [
    "dockerServer",
    "nodeInImage",
    "codexRuntime",
    "copilotCli",
    "copilotRuntime",
    "multiplexProtocol",
    "p2prpcVersion",
    "p2prpcIntegrity",
  ], "manifest versions");
  assert(
    /^\d+\.\d+\.\d+$/.test(manifest.versions.dockerServer) &&
      manifest.versions.nodeInImage === `v${releaseNodeVersion}`,
    `receipt image must use Node v${releaseNodeVersion} and identify Docker`,
  );
  assert(manifest.versions.multiplexProtocol === 4, "receipt did not qualify protocol v4");
  assert(
    manifest.versions.p2prpcVersion === p2prpc.version &&
      manifest.versions.p2prpcIntegrity === p2prpc.integrity,
    "receipt p2prpc identity differs from the exact source lockfile",
  );
  assert(
    manifest.versions.codexRuntime === `codex-cli ${codexVersion}` &&
      manifest.versions.copilotCli === `GitHub Copilot CLI ${copilotVersion}.` &&
      typeof manifest.versions.copilotRuntime === "string" &&
      manifest.versions.copilotRuntime !== "" &&
      manifest.versions.copilotRuntime !== "unavailable",
    "receipt native runtime versions differ from the exact adapter dependencies",
  );
  assertExactKeys(manifest.models, ["codexInitial", "codexSwitched", "copilot"], "models");
  assert(
    [manifest.models.codexInitial, manifest.models.codexSwitched, manifest.models.copilot]
      .every((model) => typeof model === "string" && model.length > 0) &&
      manifest.models.codexInitial !== manifest.models.codexSwitched,
    "receipt does not identify the two Codex models and Copilot model",
  );
  assert(
    Number.isSafeInteger(manifest.livenessSoak?.requestedMs) &&
      manifest.livenessSoak.requestedMs >= releaseNativeMinimumSoakMs &&
      manifest.livenessSoak.performed === true,
    `release qualification requires a completed native soak of at least ${releaseNativeMinimumSoakMs}ms`,
  );
  assert(
    typeof manifest.imageId === "string" && /^sha256:[0-9a-f]{64}$/.test(manifest.imageId),
    "manifest imageId is invalid",
  );
  assert(manifest.resourcesRetained === false, "receipt retained live resources");
  assert(
    manifest.credentialMaterialRecorded === false,
    "manifest reports retained credential material",
  );
  assertExactObject(
    manifest.evidence,
    {
      checks: "checks.json",
      summary: "summary.json",
      topology: "topology.json",
      transportLiveness: "transport-liveness.json",
      terminalEphemerality: "terminal-ephemerality.json",
      logs: "logs/",
      rpc: "rpc/",
      phases: "phases/",
      screenshots: "screenshots/",
      checksums: "SHA256SUMS",
    },
    "manifest evidence map",
  );

  validateChecks(checks, summary);
  const topologyByRole = validateTopology(topology, manifest);
  validateLifecycleAndCleanup(snapshot, topology, topologyByRole, cleanup);
  validateSecurityEvidence(
    snapshot,
    security,
    terminal,
    transport,
    provider,
    providerRelay,
    codexAuth,
    copilotAuth,
    manifest,
  );
  validatePhaseEvidence(snapshot, checks, summary, manifest);
  validateRpcEvidence(
    snapshot,
    summary,
    manifest,
    topology,
    codexVersion,
    copilotVersion,
    copilotSdkVersion,
  );
  scanForHighConfidenceSecrets(snapshot);
  return { runId: manifest.runId };
}

function validateChecks(checks, summary) {
  assertExactKeys(
    checks,
    ["passed", ...Object.keys(checkAssertionKeys), "counts"],
    "checks",
  );
  assert(checks.passed === true, "acceptance checks did not pass");
  for (const [group, keys] of Object.entries(checkAssertionKeys)) {
    assertExactTrueKeys(checks[group], keys, `checks.${group}`);
  }
  const countKeys = [
    "accessItems",
    "nativeEvents",
    "terminalCommands",
    "launchOperations",
    "metadataOperations",
    "planInteractionEvents",
    "sessions",
  ];
  assertExactKeys(checks.counts, countKeys, "checks.counts");
  assert(
    Object.values(checks.counts).every(Number.isSafeInteger) &&
      checks.counts.accessItems >= checks.counts.nativeEvents &&
      checks.counts.nativeEvents > 0 &&
      checks.counts.terminalCommands >= 9 &&
      checks.counts.launchOperations === 2 &&
      checks.counts.metadataOperations === 4 &&
      checks.counts.planInteractionEvents === 2 &&
      checks.counts.sessions === 2,
    "acceptance counts do not prove the required mixed-harness interaction",
  );
  assert(summary.passed === true, "receipt summary did not pass");
  assertValidTimestamp(summary.verifiedAt, "summary verifiedAt");
  assert(
    /^[0-9a-f-]{36}$/.test(summary.sessionIds?.codex ?? "") &&
      /^[0-9a-f-]{36}$/.test(summary.sessionIds?.copilot ?? "") &&
      summary.sessionIds.codex !== summary.sessionIds.copilot,
    "summary does not identify two distinct native sessions",
  );
  assertExactObject(summary.counts, checks.counts, "summary/check counts");
  assert(summary.checks === "checks.json", "summary points at another checks file");
}

function validateTopology(topology, manifest) {
  assert(
    topology.applicationContainerCount === 4 &&
      topology.sharedImageId === manifest.imageId &&
      topology.network?.driver === "bridge" &&
      topology.network?.containerCount === 4 &&
      typeof topology.network.name === "string" &&
      topology.authority?.sqliteBacked === true &&
      topology.transport?.protocol === "p2prpc v1 over Iroh" &&
      topology.transport?.ticketRecorded === false &&
      topology.ingress?.onlyPublishedApplicationPort === "gateway HTTP/WebSocket" &&
      topology.ingress?.browserAndVerifierUseGatewayOnly === true &&
      topology.browserRunsOnDockerHost === true &&
      topology.acceptancePlumbing?.applicationContainer === false &&
      topology.acceptancePlumbing?.publicIngress === false &&
      topology.acceptancePlumbing?.endpointRecorded === false,
    "topology evidence differs from the isolated four-container contract",
  );
  assert(Array.isArray(topology.containers) && topology.containers.length === 4, "topology must list four containers");
  const byRole = new Map();
  const ids = new Set();
  const names = new Set();
  for (const container of topology.containers) {
    assert(
      typeof container?.id === "string" && /^[0-9a-f]{64}$/.test(container.id) &&
        typeof container.name === "string" && container.name.length > 0 &&
        exactContainerRoles.includes(container.role),
      "topology contains an invalid container identity or role",
    );
    ids.add(container.id);
    names.add(container.name);
    assert(!byRole.has(container.role), `topology repeats role ${container.role}`);
    byRole.set(container.role, container);
  }
  assert(ids.size === 4 && names.size === 4, "topology container identities are not unique");
  assert(
    exactContainerRoles.every((role) => byRole.has(role)),
    "topology does not contain the four exclusive application roles",
  );
  const rolePrefixes = [
    [exactContainerRoles[0], "multiplex-live-control-"],
    [exactContainerRoles[1], "multiplex-live-gateway-"],
    [exactContainerRoles[2], "multiplex-live-codex-"],
    [exactContainerRoles[3], "multiplex-live-copilot-"],
  ];
  const controlName = byRole.get(exactContainerRoles[0]).name;
  const suffix = controlName.slice("multiplex-live-control-".length);
  assert(
    /^[a-z0-9]+$/.test(suffix) &&
      rolePrefixes.every(([role, prefix]) => byRole.get(role).name === `${prefix}${suffix}`) &&
      topology.network.name === `multiplex-live-four-${suffix}`,
    "topology resource names do not share one isolated run suffix",
  );
  for (const role of [exactContainerRoles[0], exactContainerRoles[2], exactContainerRoles[3]]) {
    assertExactKeys(
      byRole.get(role),
      ["name", "id", "role", "publishedPorts"],
      `${role} topology record`,
    );
    assertExactObject(byRole.get(role).publishedPorts, [], `${role} published ports`);
  }
  const gateway = byRole.get(exactContainerRoles[1]);
  assertExactKeys(
    gateway,
    ["name", "id", "role", "publishedDashboard"],
    "gateway topology record",
  );
  const dashboard = gateway.publishedDashboard;
  assertLocalDashboardUrl(dashboard);
  return byRole;
}

function validateLifecycleAndCleanup(snapshot, topology, topologyByRole, cleanup) {
  const lifecycle = readReceiptArray(snapshot, "container-lifecycle.json");
  assert(lifecycle.length === 4, "container lifecycle must contain four records");
  const lifecycleByName = new Map(lifecycle.map((entry) => [entry?.name, entry]));
  assert(lifecycleByName.size === 4, "container lifecycle names are not unique");
  for (const container of topology.containers) {
    const entry = lifecycleByName.get(container.name);
    assert(
      entry?.id === container.id &&
        entry.image === topology.sharedImageId &&
        entry.running === true &&
        entry.oomKilled === false &&
        entry.exitCode === 0 &&
        entry.restartCount === 0,
      `container lifecycle proof failed for ${container.name}`,
    );
    assertValidTimestamp(entry.startedAt, `${container.name} startedAt`);
  }

  assert(
    cleanup.cleanupCompleted === true &&
      cleanup.exactContainerTargetsRemoved === true &&
      cleanup.isolatedNetworkRemoved === true &&
      cleanup.imageRemoved === true &&
      cleanup.providerReachabilityRelayStopped === true &&
      cleanup.resourceStateObservationCertain === true &&
      cleanup.runtimeDirectoryPreservedForRecovery === false &&
      cleanup.recoverable === false &&
      cleanup.materialUserDataRemoved === false,
    "receipt cleanup is incomplete or ambiguous",
  );
  assert(
    Array.isArray(cleanup.targets?.containers) &&
      sameStringSet(cleanup.targets.containers, topology.containers.map(({ name }) => name)) &&
      cleanup.targets.network === topology.network.name &&
      cleanup.targets.image ===
        `agent-multiplex-live-four:${topology.network.name.slice("multiplex-live-four-".length)}` &&
      ["stopped", "not-found"].includes(cleanup.providerReachabilityRelayState),
    "cleanup targets differ from the qualified topology",
  );

  const codexProcesses = readReceiptObject(snapshot, "codex-process-proof.json");
  const copilotProcesses = readReceiptObject(snapshot, "copilot-process-proof.json");
  assert(
    Array.isArray(codexProcesses.processes) &&
      codexProcesses.processes.some((entry) => entry?.role === "codex app-server") &&
      Array.isArray(codexProcesses.managedTuiProcesses) &&
      codexProcesses.managedTuiProcesses.length === 0,
    "Codex app-server or terminated managed-TUI process proof is missing",
  );
  assert(
    Array.isArray(copilotProcesses.processes) &&
      copilotProcesses.processes.some((entry) => entry?.role === "Copilot runtime"),
    "Copilot runtime process proof is missing",
  );

  const resources = readReceiptObject(snapshot, "resource-summary.json");
  assert(
    resources.sampleTimes >= 1 &&
      Array.isArray(resources.containers) &&
      resources.containers.length === 4 &&
      sameStringSet(resources.containers.map(({ name }) => name), [...lifecycleByName.keys()]) &&
      resources.containers.every((entry) => entry.sampleCount >= 1 && entry.maxPids >= 1),
    "resource sampling did not cover the exact four containers",
  );

  assert(topologyByRole.size === 4, "topology role map is incomplete");
}

function validateSecurityEvidence(
  snapshot,
  security,
  terminal,
  transport,
  provider,
  providerRelay,
  codexAuth,
  copilotAuth,
  manifest,
) {
  assertExactObject(
    security,
    {
      passed: true,
      rawSecrets: false,
      providerEndpoint: false,
      p2pTicket: false,
      ticketShape: false,
    },
    "security scan",
  );
  assert(
    terminal.passed === true &&
      /^[0-9a-f]{64}$/.test(terminal.canary?.sha256 ?? "") &&
      Number.isSafeInteger(terminal.canary?.utf8Bytes) &&
      terminal.canary.utf8Bytes > 0 &&
      terminal.canary.submittedToHarness === false &&
      terminal.canary.rawValueRecorded === false,
    "terminal ephemerality proof did not pass",
  );
  assertExactTrueKeys(
    terminal.assertions,
    checkAssertionKeys.terminalStorage,
    "terminal assertions",
  );
  const expectedSurfaces = [
    "canonical-authority-sqlite",
    "zero-authority-gateway-sqlite",
    "codex-runtime-sqlite",
    "copilot-runtime-sqlite",
    "native-history-api-responses",
    "gateway-fleet-event-journal",
    "sanitized-application-logs",
    "sanitized-browser-evidence",
  ];
  assert(
    Array.isArray(terminal.surfaces) &&
      sameStringSet(terminal.surfaces.map(({ name }) => name), expectedSurfaces) &&
      terminal.surfaces.every((surface) =>
        Number.isSafeInteger(surface.filesChecked) &&
        surface.filesChecked > 0 &&
        surface.rawMatches === 0 &&
        surface.encodedMatches === 0 &&
        Array.isArray(surface.files) &&
        surface.files.length === surface.filesChecked &&
        surface.files.every((file) =>
          file.rawMarkerPresent === false && file.base64TerminalFramePresent === false
        )
      ),
    "terminal ephemerality scan did not cover every required surface",
  );
  assert(
    transport.passed === true &&
      transport.nativeHandleExpiryObserved === false &&
      transport.configuredSoakMs === manifest.livenessSoak.requestedMs &&
      typeof transport.truncatedTransportFrameObserved === "boolean",
    "transport liveness proof did not pass",
  );

  assert(
    provider.credentialsRecorded === false &&
      provider.codex?.provider === "codex-lb" &&
      provider.codex.endpointRecorded === false &&
      provider.copilot?.providerType === "openai" &&
      provider.copilot.wireApi === "responses" &&
      provider.copilot.transport === "http" &&
      provider.copilot.endpointRecorded === false &&
      provider.reachabilityRelay?.endpointRecorded === false &&
      provider.reachabilityRelay.storesOrLogsHeaders === false,
    "provider proof reports the wrong BYOK boundary or retained sensitive material",
  );
  assert(
    providerRelay.containerized === false &&
      providerRelay.serviceManager === "systemd --user" &&
      providerRelay.survivesAcceptanceRunnerExit === true &&
      providerRelay.bindScope === "isolated per-run Docker bridge only" &&
      providerRelay.publiclyPublished === false &&
      ["http:", "https:"].includes(providerRelay.upstreamProtocol) &&
      providerRelay.readsCredentialFiles === false &&
      providerRelay.storesOrLogsHeaders === false &&
      providerRelay.endpointRecorded === false,
    "provider reachability relay proof is incomplete",
  );

  assert(
    codexAuth.secretValuesRecorded === false &&
      codexAuth.authJsonCopied === false &&
      codexAuth.fullHostCodexHomeMounted === false &&
      isPlainObject(codexAuth.files) &&
      sameStringSet(Object.keys(codexAuth.files), ["config.toml", "codex-lb-api-key"]) &&
      Object.values(codexAuth.files).every((file) =>
        file?.present === true && file.mode === "600" && file.uid === 1000 && file.gid === 100
      ),
    "Codex auth isolation proof did not pass",
  );
  assert(
    copilotAuth.secretValuesRecorded === false &&
      copilotAuth.destination === "/run/secrets/codex-lb-api-key" &&
      copilotAuth.mountType === "bind" &&
      copilotAuth.readOnly === true &&
      copilotAuth.isolatedCopilotHome === true &&
      copilotAuth.apiKeyCopiedIntoImage === false &&
      copilotAuth.fullCodexHomeMounted === false,
    "Copilot auth isolation proof did not pass",
  );

  const authBoundary = readReceiptObject(snapshot, "rpc/auth-boundary.json");
  assert(
    authBoundary.unauthenticatedStatus === 401 &&
      authBoundary.unauthenticatedRejected === true &&
      Number.isSafeInteger(authBoundary.authenticatedStatus) &&
      authBoundary.authenticatedStatus >= 200 &&
      authBoundary.authenticatedStatus < 300 &&
      authBoundary.authenticatedAccepted === true &&
      authBoundary.bearerTokenRecorded === false,
    "gateway bearer-authentication boundary proof did not pass",
  );
}

function validatePhaseEvidence(snapshot, checks, summary, manifest) {
  const browser = readReceiptObject(snapshot, "phases/browser-ui.json");
  const controls = readReceiptObject(snapshot, "phases/codex-controls.json");
  const streams = readReceiptObject(snapshot, "phases/stream-assertions.json");
  const normalized = readReceiptObject(
    snapshot,
    "phases/terminal-normalized-surfaces.json",
  );
  const watcher = readReceiptObject(snapshot, "phases/watcher-summary.json");

  assert(
    browser.passed === true &&
      browser.runId === manifest.runId &&
      browser.credentialMaterialRecorded === false,
    "browser phase did not pass for this receipt",
  );
  assertValidTimestamp(browser.completedAt, "browser phase completedAt");
  for (const key of requiredBrowserAssertions) {
    assert(browser.assertions?.[key] === true, `browser assertion ${key} did not pass`);
  }
  assert(
    Number.isSafeInteger(browser.assertions.postReloadNativeHistoryCalls) &&
      browser.assertions.postReloadNativeHistoryCalls >= 2 &&
      browserErrorSummaryPassed(browser.assertions) &&
      browser.assertions.failedSameOriginRequests === 0 &&
      browser.assertions.responsiveViewportsChecked === 6 &&
      browser.assertions.responsiveDocumentOverflows === 0 &&
      browser.assertions.responsiveClippedEssentials === 0 &&
      browser.assertions.seriousOrCriticalAccessibilityViolations === 0 &&
      browser.assertions.postSoakLivenessTested === manifest.livenessSoak.performed &&
      browser.soak?.requestedMs === manifest.livenessSoak.requestedMs &&
      browser.soak.performed === manifest.livenessSoak.performed,
    "browser phase counts or soak identity are inconsistent",
  );
  assertExactObject(controls.assertions, checks.codexControls, "Codex control assertions");
  assertExactObject(streams.assertions, checks.streams, "native stream assertions");
  assert(
    nativeStreamSummaryPassed(streams, checks.counts.nativeEvents),
    "native stream phase is incomplete or inconsistent",
  );
  assert(
    normalized.passed === true &&
      normalized.markerRawValueRecorded === false &&
      /^[0-9a-f]{64}$/.test(normalized.markerSha256 ?? "") &&
      isDeepStrictEqual(normalized.assertions, checks.terminalEphemerality),
    "normalized terminal-surface phase did not pass",
  );
  assert(
    watcher.passed === true &&
      watcher.itemCount === checks.counts.accessItems &&
      watcher.nativeCount === checks.counts.nativeEvents &&
      watcher.nativeGapCount === 0 &&
      Number.isSafeInteger(watcher.websocketOpenCount) &&
      watcher.websocketOpenCount >= 1,
    "independent gateway watcher proof did not pass",
  );
  assert(
    isPlainObject(summary.markers) &&
      sameStringSet(Object.keys(summary.markers), [
        "codex",
        "copilot",
        "plan",
        "interruptVisibleTick",
        "terminalSemantic",
        "structuredAfterTerminal",
      ]) &&
      Object.values(summary.markers).every((marker) =>
      typeof marker === "string" && marker.length > 0
      ),
    "summary omits one or more native interaction markers",
  );
}

function validateRpcEvidence(
  snapshot,
  summary,
  manifest,
  topology,
  codexVersion,
  copilotVersion,
  copilotSdkVersion,
) {
  const system = readReceiptObject(snapshot, "rpc/system.json");
  const controls = readReceiptArray(snapshot, "rpc/control-nodes.json");
  const sources = readReceiptArray(snapshot, "rpc/sources.json");
  const runtimes = readReceiptArray(snapshot, "rpc/runtime-nodes.json");
  const harnesses = readReceiptArray(snapshot, "rpc/harness-catalog.json");
  const sessions = readReceiptArray(snapshot, "rpc/sessions.json");
  const launches = readReceiptObject(snapshot, "rpc/launches.json").launches;
  const codexHistory = readReceiptObject(snapshot, "rpc/native-history-codex.json");
  const copilotHistory = readReceiptObject(snapshot, "rpc/native-history-copilot.json");
  const terminal = readReceiptObject(snapshot, "rpc/terminal-codex-after-exit.json");

  assert(
    system.application === "agent-multiplex" &&
      system.protocolVersion === 4 &&
      system.componentKind === "access-gateway" &&
      system.dataAuthority === "none",
    "gateway system description violates the zero-authority protocol-v4 boundary",
  );
  assert(
    controls.length === 1 &&
      controls[0]?.presence === "online" &&
      controls[0].protocolVersion === 4 &&
      controls[0].dataRole?.role === "authority" &&
      controls[0].controlNodeId === topology.authority.controlNodeId,
    "control-node RPC evidence does not identify one online authority",
  );
  assert(
    sources.length === 1 &&
      sources[0]?.state === "selected" &&
      sources[0].manifest?.protocolVersion === 4 &&
      sources[0].manifest.sourceControlNodeId === controls[0].controlNodeId,
    "gateway source RPC evidence does not select the canonical authority",
  );
  assert(
    runtimes.length === 2 &&
      new Set(runtimes.map(({ runtimeNodeId }) => runtimeNodeId)).size === 2 &&
      runtimes.every((runtime) =>
        runtime.presence === "online" &&
        runtime.reachability === "reachable" &&
        runtime.protocolVersion === 4 &&
        runtime.ownerControlNodeId === controls[0].controlNodeId
      ) &&
      sameStringSet(
        runtimes.flatMap((runtime) => runtime.harnesses?.map(({ harness }) => harness) ?? []),
        ["codex", "copilot"],
      ),
    "runtime RPC evidence does not identify isolated online Codex and Copilot runtimes",
  );

  const harnessByName = new Map(harnesses.map((entry) => [entry?.harness, entry]));
  assert(
    harnesses.length === 2 &&
      harnessByName.size === 2 &&
      harnessByName.get("codex")?.version === codexVersion &&
      harnessByName.get("codex")?.runtimeVersion === codexVersion &&
      harnessByName.get("copilot")?.version === copilotSdkVersion &&
      harnessByName.get("copilot")?.runtimeVersion === manifest.versions.copilotRuntime &&
      manifest.versions.copilotCli === `GitHub Copilot CLI ${copilotVersion}.`,
    "harness catalog differs from the pinned native adapter boundary",
  );

  assert(
    sessions.length === 2 &&
      sameStringSet(sessions.map(({ harness }) => harness), ["codex", "copilot"]) &&
      sessions.every((session) =>
        session.catalogState === "open" &&
        session.availability === "active" &&
        session.runtimeStatus === "idle" &&
        typeof session.runtimeEpoch === "string" &&
        session.runtimeEpoch.length > 0 &&
        typeof session.vendorSessionId === "string" &&
        session.vendorSessionId.length > 0
      ) &&
      sameStringSet(
        sessions.map(({ sessionId }) => sessionId),
        [summary.sessionIds.codex, summary.sessionIds.copilot],
      ),
    "session RPC evidence does not identify two open active native sessions",
  );
  assert(
    Array.isArray(launches) &&
      launches.length === 2 &&
      launches.every((launch) => launch.state === "succeeded") &&
      sameStringSet(
        launches.map(({ sessionId }) => sessionId),
        sessions.map(({ sessionId }) => sessionId),
      ),
    "launch RPC evidence does not identify two successful launches",
  );
  const sessionByHarness = new Map(sessions.map((session) => [session.harness, session]));
  assert(
    codexHistory.complete === true &&
      codexHistory.harness === "codex" &&
      codexHistory.vendorSessionId === sessionByHarness.get("codex").vendorSessionId &&
      copilotHistory.complete === true &&
      copilotHistory.harness === "copilot" &&
      copilotHistory.vendorSessionId === sessionByHarness.get("copilot").vendorSessionId,
    "native-history RPC evidence does not match the two sessions",
  );
  assert(
    terminal.sessionId === summary.sessionIds.codex &&
      terminal.backend === "codex-remote" &&
      terminal.sharing === "session" &&
      terminal.state === "exited" &&
      terminal.lease === null &&
      terminal.capabilities?.restart === true,
    "post-exit Codex terminal descriptor is inconsistent",
  );
}

function assertLockedVersion(lockfile, packageName, expectedVersion) {
  const entry = lockfile.packages?.[`node_modules/${packageName}`];
  assert(
    /^\d+\.\d+\.\d+$/.test(expectedVersion ?? "") &&
      entry?.version === expectedVersion &&
      typeof entry.integrity === "string" &&
      entry.integrity.startsWith("sha512-"),
    `source lockfile does not contain exact ${packageName}@${expectedVersion ?? "unknown"}`,
  );
}

function captureReceiptSnapshot(directory) {
  const paths = collectRegularFiles(directory).sort();
  assert(paths.includes("SHA256SUMS"), "receipt omits SHA256SUMS");
  const files = new Map();
  let totalBytes = 0;
  for (const path of paths) {
    const contents = readFileSync(resolve(directory, ...path.split("/")));
    totalBytes += contents.byteLength;
    assert(totalBytes <= maximumReceiptBytes, "receipt exceeds the validation size bound");
    files.set(path, contents);
  }
  const rows = paths
    .filter((path) => path !== "SHA256SUMS")
    .map((path) => `${sha256Buffer(files.get(path))}  ./${path}`);
  const expected = `${rows.join("\n")}\n`;
  const inventoryBytes = files.get("SHA256SUMS");
  const inventory = inventoryBytes.toString("utf8");
  assert(
    inventory === expected,
    "SHA256SUMS is incomplete, non-canonical, or differs from receipt bytes",
  );
  return {
    files,
    inventory,
    inventorySha256: sha256Buffer(inventoryBytes),
  };
}

function collectRegularFiles(directory, prefix = "") {
  const output = [];
  const entries = readdirSync(resolve(directory, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    assert(
      /^[A-Za-z0-9._/-]+$/.test(path),
      `receipt contains an unsafe evidence path: ${path}`,
    );
    const absolute = resolve(directory, ...path.split("/"));
    const stat = lstatSync(absolute);
    assert(!stat.isSymbolicLink(), `receipt contains symbolic link ${path}`);
    if (stat.isDirectory()) output.push(...collectRegularFiles(directory, path));
    else {
      assert(stat.isFile(), `receipt contains non-regular evidence ${path}`);
      output.push(path);
    }
  }
  return output;
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readReceiptValue(snapshot, filename) {
  const bytes = snapshot.files.get(filename);
  assert(bytes !== undefined, `receipt omits ${filename}`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${filename} is not valid JSON`, { cause: error });
  }
}

function readReceiptObject(snapshot, filename) {
  const value = readReceiptValue(snapshot, filename);
  assert(isPlainObject(value), `${filename} must contain a JSON object`);
  return value;
}

function readReceiptArray(snapshot, filename) {
  const value = readReceiptValue(snapshot, filename);
  assert(Array.isArray(value), `${filename} must contain a JSON array`);
  return value;
}

function assertExactKeys(actual, expected, label) {
  assert(
    isPlainObject(actual) && sameStringSet(Object.keys(actual), expected),
    `${label} fields differ from the required release qualification contract`,
  );
}

function assertExactTrueKeys(actual, expected, label) {
  assertExactKeys(actual, expected, label);
  for (const key of expected) {
    assert(actual[key] === true, `${label}.${key} is not true`);
  }
}

function assertExactObject(actual, expected, label) {
  assert(
    isDeepStrictEqual(actual, expected),
    `${label} differs from the required release qualification contract`,
  );
}

function assertValidTimestamp(value, label) {
  assert(
    isCanonicalUtcTimestamp(value),
    `${label} is not a canonical UTC timestamp`,
  );
}

function assertLocalDashboardUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    assert(false, "gateway dashboard evidence is not a URL");
  }
  assert(
    url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      /^[1-9]\d{0,4}$/.test(url.port) &&
      Number(url.port) <= 65_535 &&
      url.pathname === "/" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "",
    "gateway dashboard was not the sole credential-free loopback publication",
  );
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (!left.every((value) => typeof value === "string")) return false;
  if (!right.every((value) => typeof value === "string")) return false;
  if (new Set(left).size !== left.length || new Set(right).size !== right.length) return false;
  return isDeepStrictEqual([...left].sort(), [...right].sort());
}

function scanForHighConfidenceSecrets(snapshot) {
  const patterns = [
    ["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/],
    ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/],
    ["npm token", /\bnpm_[A-Za-z0-9]{20,}\b/],
    ["OpenAI-style secret", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
    ["raw p2prpc ticket", /\bp2prpc3\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{80,}\b/],
    ["URL access token", /[?&](?:access_?token|token)=[A-Za-z0-9._~-]{20,}/i],
  ];
  const findings = [];
  for (const [path, bytes] of snapshot.files) {
    // These patterns are ASCII and remain visible under latin1 even in binary
    // screenshot metadata, so no evidence type is exempt from the final scan.
    const contents = bytes.toString("latin1");
    for (const [label, pattern] of patterns) {
      if (pattern.test(contents)) findings.push(`${path}: ${label}`);
    }
  }
  assert(
    findings.length === 0,
    `possible credential material remains in receipt:\n${findings.join("\n")}`,
  );
}

function parseGhObject(serialized, label) {
  let value;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`${label} response is not valid JSON`, { cause: error });
  }
  assert(isPlainObject(value), `${label} response is not an object`);
  return value;
}

function git(arguments_) {
  return execFileSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

function ghApi(arguments_, options = {}) {
  return execFileSync("gh", ["api", "--hostname", "github.com", ...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8",
    ...options,
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
