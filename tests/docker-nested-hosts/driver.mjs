#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";

import {
  createFleetClient,
  sessionCommand,
  spawnCommand,
  watchFleet,
} from "@arduano/agent-multiplex-client";
import { newOperationId } from "@arduano/agent-multiplex-protocol";
import { WebSocket as NodeWebSocket } from "ws";

const argv = process.argv.slice(2);
if (argv.length !== 12) {
  throw new Error(
    "usage: driver.mjs <primary-gateway-trpc> <secondary-gateway-trpc> " +
      "<root-trpc> <leaf-trpc> <receipt-dir> <run-id> <host-prefix> " +
      "<worker-prefix> <sessions-per-worker> <chunk-count> <timeout-ms> <soak-ms>",
  );
}

const [
  primaryUrl,
  secondaryUrl,
  rootUrl,
  leafUrl,
  rawReceiptDirectory,
  runId,
  hostPrefix,
  workerPrefix,
  rawSessionsPerWorker,
  rawChunkCount,
  rawTimeoutMs,
  rawSoakMs,
] = argv;
const receiptDirectory = resolve(rawReceiptDirectory);
const sessionsPerWorker = positiveInteger(rawSessionsPerWorker, "sessions-per-worker");
const chunkCount = positiveInteger(rawChunkCount, "chunk-count");
const timeoutMs = positiveInteger(rawTimeoutMs, "timeout-ms");
const soakMs = positiveInteger(rawSoakMs, "soak-ms");
const workerCount = 10;
const totalSessions = workerCount * sessionsPerWorker;
const expectedBranchCounts = Object.freeze({ a1: 4, a: 2, b: 4 });

const paths = {
  events: join(receiptDirectory, "logs/fleet-events.ndjson"),
  states: join(receiptDirectory, "logs/client-states.ndjson"),
  hostsInitial: join(receiptDirectory, "rpc/hosts-initial.json"),
  workersInitial: join(receiptDirectory, "rpc/workers-initial.json"),
  observerInitial: join(receiptDirectory, "rpc/observer-parity-initial.json"),
  models: join(receiptDirectory, "rpc/root-to-leaf-models.json"),
  spawns: join(receiptDirectory, "rpc/spawn-results.json"),
  sessionsInitial: join(receiptDirectory, "rpc/sessions-initial.json"),
  sends: join(receiptDirectory, "rpc/send-results.json"),
  streamAssertions: join(receiptDirectory, "phases/stream-assertions.json"),
  settings: join(receiptDirectory, "rpc/root-to-leaf-settings.json"),
  historyInitial: join(receiptDirectory, "rpc/native-history-before-interrupt.json"),
  historyFinal: join(receiptDirectory, "rpc/native-history-after-reconnect.json"),
  metadataRoot: join(receiptDirectory, "rpc/metadata-root-write.json"),
  metadataLeaf: join(receiptDirectory, "rpc/metadata-leaf-outbox.json"),
  interrupt: join(receiptDirectory, "rpc/root-to-leaf-interrupt.json"),
  disconnectedView: join(receiptDirectory, "phases/disconnected-root-view.json"),
  reconnectedView: join(receiptDirectory, "phases/reconnected-root-view.json"),
  postReconnect: join(receiptDirectory, "rpc/post-reconnect-command.json"),
  observerFinal: join(receiptDirectory, "rpc/observer-parity-final.json"),
  sessionsFinal: join(receiptDirectory, "rpc/sessions-final.json"),
  workersFinal: join(receiptDirectory, "rpc/workers-final.json"),
  hostsFinal: join(receiptDirectory, "rpc/hosts-final.json"),
  stability: join(receiptDirectory, "phases/stability-samples.json"),
  disconnectRequest: join(receiptDirectory, "coord/disconnect-request.json"),
  disconnectStarted: join(receiptDirectory, "coord/disconnect-started.json"),
  reconnectRequest: join(receiptDirectory, "coord/reconnect-request.json"),
  reconnectComplete: join(receiptDirectory, "coord/reconnect-complete.json"),
  failure: join(receiptDirectory, "driver-failure.json"),
};

await Promise.all(
  ["logs", "rpc", "phases", "coord"].map((directory) =>
    mkdir(join(receiptDirectory, directory), { recursive: true }),
  ),
);

const stateLog = await open(paths.states, "w");
const eventOutput = createWriteStream(paths.events, { flags: "w", encoding: "utf8" });
let websocketOpenCount = 0;
let websocketCloseCount = 0;

const primaryHandle = fleetHandle(primaryUrl, true);
const secondaryHandle = fleetHandle(secondaryUrl);
const rootHandle = fleetHandle(rootUrl);
const leafHandle = fleetHandle(leafUrl);
const primary = primaryHandle.client;
const secondary = secondaryHandle.client;
const root = rootHandle.client;
const leaf = leafHandle.client;

let watcher;
try {
  const expectedHostNames = [
    `${hostPrefix}-root`,
    `${hostPrefix}-aggregate-a`,
    `${hostPrefix}-leaf-a1`,
    `${hostPrefix}-aggregate-b`,
  ].sort();
  const initialHosts = await waitFor(
    "the exact four-host tree to reach the primary observer",
    timeoutMs,
    async () => {
      const hosts = await primary.hosts.list.query();
      return hosts.length === 4 && hosts.every((host) => host.presence === "online")
        ? hosts.sort(compareName)
        : undefined;
    },
  );
  assertDeepEqual(
    initialHosts.map((host) => host.name).sort(),
    expectedHostNames,
    "host names",
  );
  const topology = assertHostTree(initialHosts, hostPrefix);
  await writeJson(paths.hostsInitial, {
    rootHostId: topology.root.hostId,
    authorityHostId: topology.root.authorityHostId,
    hosts: initialHosts,
    edges: [
      { parentHostId: topology.root.hostId, childHostId: topology.aggregateA.hostId },
      { parentHostId: topology.aggregateA.hostId, childHostId: topology.leafA1.hostId },
      { parentHostId: topology.root.hostId, childHostId: topology.aggregateB.hostId },
    ],
  });

  const expectedWorkers = expectedWorkerNames(workerPrefix);
  const initialWorkers = await waitFor(
    "ten online reachable workers to aggregate at the root",
    timeoutMs,
    async () => {
      const workers = await primary.workers.list.query();
      const selected = workers.filter((worker) => worker.name.startsWith(`${workerPrefix}-`));
      return selected.length === workerCount && selected.every(isReadyMockWorker)
        ? selected.sort(compareName)
        : undefined;
    },
  );
  assertDeepEqual(initialWorkers.map((worker) => worker.name), expectedWorkers, "worker names");
  assertWorkerOwnership(initialWorkers, topology, workerPrefix);
  await writeJson(paths.workersInitial, initialWorkers);

  const initialParity = await waitFor(
    "both p2prpc observers to materialize the same tree",
    timeoutMs,
    async () => observerParity(primary, secondary, runId, 0),
  );
  const [primaryDescription, secondaryDescription] = await Promise.all([
    primary.system.describe.query(),
    secondary.system.describe.query(),
  ]);
  assert(primaryDescription.protocolVersion === 2, "primary observer did not expose protocol v2");
  assertDeepEqual(primaryDescription, secondaryDescription, "observer system descriptions");
  await writeJson(paths.observerInitial, {
    ...initialParity,
    primaryDescription,
    secondaryDescription,
  });

  const leafWorker = required(
    initialWorkers.find((worker) => worker.name === `${workerPrefix}-a1-00`),
    "leaf worker",
  );
  const models = await routed("root-to-leaf model lookup", () =>
    primary.harness.models.query({
      workerId: leafWorker.workerId,
      harness: "codex",
    }),
  );
  assert(
    models.some((model) => model.id === "mock-model" && model.harness === "codex"),
    "root-to-leaf model lookup omitted codex/mock-model",
  );
  await writeJson(paths.models, { worker: leafWorker, models });

  const workerByName = new Map(initialWorkers.map((worker) => [worker.name, worker]));
  const spawnInputs = expectedWorkers.flatMap((workerName) => {
    const worker = requiredMapValue(workerByName, workerName);
    const branch = workerBranch(workerName, workerPrefix);
    return Array.from({ length: sessionsPerWorker }, (_, sessionIndex) => {
      const title = `Nested ${branch}/${twoDigits(sessionIndex)} ${runId}`;
      return {
        branch,
        worker,
        sessionIndex,
        title,
        command: spawnCommand(
          worker.workerId,
          {
            harness: "codex",
            cwd: "/workspace",
            model: "mock-model",
            approvalPolicy: "never",
            sandbox: "read-only",
          },
          {
            "agent.title": title,
            "nested.run_id": runId,
            "nested.branch": branch,
            "nested.worker_name": workerName,
            "nested.session_index": sessionIndex,
            "nested.source": "root-observer-spawn",
          },
        ),
      };
    });
  });

  // Keep control-plane bursts separate from the long-lived aggregate feed and
  // heartbeat lanes. The streamed turns still overlap after their immediate
  // acknowledgements; session count and stream fan-in are the load target.
  const spawnResults = await mapConcurrent(spawnInputs, 4, async (input) => {
    const startedAt = performance.now();
    const command = await routed(`spawn ${input.title}`, () =>
      primary.sessions.spawn.mutate(input.command),
    );
    return {
      branch: input.branch,
      workerName: input.worker.name,
      sessionIndex: input.sessionIndex,
      title: input.title,
      latencyMs: elapsed(startedAt),
      command,
    };
  });
  await writeJson(paths.spawns, spawnResults);
  for (const result of spawnResults) {
    assert(result.command.state === "succeeded", `spawn failed for ${result.title}`);
    assert(typeof result.command.sessionId === "string", `spawn omitted session ID for ${result.title}`);
    assert(
      isObject(result.command.result) && typeof result.command.result.vendorSessionId === "string",
      `spawn omitted native ID for ${result.title}`,
    );
  }
  assertUnique(spawnResults.map((entry) => entry.command.commandId), "spawn command IDs");
  assertUnique(spawnResults.map((entry) => entry.command.sessionId), "logical session IDs");

  const sessionsInitial = await waitFor(
    "100 active sessions to aggregate at the root",
    timeoutMs,
    async () => {
      const sessions = selectRunSessions(await primary.sessions.list.query(), runId);
      return sessions.length === totalSessions && sessions.every(isActiveIdle)
        ? sessions.sort(compareSession)
        : undefined;
    },
  );
  const sessionInfo = new Map();
  for (const spawn of spawnResults) {
    const sessionId = spawn.command.sessionId;
    const session = required(
      sessionsInitial.find((candidate) => candidate.sessionId === sessionId),
      `canonical session ${sessionId}`,
    );
    const vendorSessionId = spawn.command.result.vendorSessionId;
    assert(session.vendorSessionId === vendorSessionId, `${sessionId} changed native ID after spawn`);
    assert(session.workerId === spawn.command.workerId, `${sessionId} moved to another worker`);
    sessionInfo.set(sessionId, {
      ...spawn,
      session,
      vendorSessionId,
      prompt: `nested/${runId}/${spawn.branch}/${twoDigits(spawn.sessionIndex)}`,
    });
  }
  assertSessionDistribution(sessionsInitial, initialWorkers, sessionsPerWorker);
  assertSessionMetadata(sessionsInitial, sessionInfo, runId);
  await writeJson(paths.sessionsInitial, sessionsInitial);

  const leafLocalSessions = await waitFor(
    "40 leaf-local sessions",
    timeoutMs,
    async () => {
      const sessions = selectRunSessions(await leaf.sessions.list.query(), runId);
      return sessions.length === expectedBranchCounts.a1 * sessionsPerWorker ? sessions : undefined;
    },
  );
  assert(
    leafLocalSessions.every((session) => session.metadata.values["nested.branch"] === "a1"),
    "leaf host projected a session outside its subtree",
  );

  const nativeBySession = new Map();
  const nativeGaps = [];
  const duplicateKeys = [];
  const deliveredKeys = new Set();
  const initialCompletions = new Set();
  let totalNativeEvents = 0;
  watcher = watchFleet(primary.sessions.watch, {
    sessions: [...sessionInfo.keys()],
    includeNative: true,
    maxPendingItems: 32_768,
    initialRetryDelayMs: 50,
    maxRetryDelayMs: 1_000,
    retryJitter: 0,
    onStateChange: (state) => {
      void appendNdjson(stateLog, {
        at: now(),
        source: "primary-gateway-watch",
        ...serializableState(state),
      }).catch(() => undefined);
    },
    onItem: async (item) => {
      const receivedAt = now();
      if (!eventOutput.write(`${JSON.stringify({ receivedAt, ...item })}\n`)) {
        await once(eventOutput, "drain");
      }
      if (item.kind === "nativeGap") {
        nativeGaps.push({ receivedAt, ...item });
        return;
      }
      if (item.kind !== "native") return;
      totalNativeEvents += 1;
      const key = `${item.sessionId}\0${item.runtimeEpoch}\0${item.sequence}`;
      if (deliveredKeys.has(key)) duplicateKeys.push(key);
      deliveredKeys.add(key);
      const events = nativeBySession.get(item.sessionId) ?? [];
      events.push({ receivedAt, ...item });
      nativeBySession.set(item.sessionId, events);
      if (item.nativeType === "turn/completed" && events[0]?.nativeType === "turn/started") {
        initialCompletions.add(item.sessionId);
      }
    },
  });
  await waitFor("the gateway fleet subscription to become live", timeoutMs, async () =>
    watcher.state.state === "live" ? true : undefined,
  );

  const sendResults = await mapConcurrent(
    [...sessionInfo.values()],
    workerCount,
    async (info) => {
      const command = sessionCommand(info.session, {
        harness: "codex",
        command: { type: "send", input: info.prompt },
      });
      const startedAt = performance.now();
      const result = await routed(`send ${info.session.sessionId}`, () =>
        primary.sessions.execute.mutate(command),
      );
      return {
        sessionId: info.session.sessionId,
        workerName: info.workerName,
        branch: info.branch,
        sessionIndex: info.sessionIndex,
        prompt: info.prompt,
        expectedText: mockExpectedText(info.vendorSessionId, 1, info.prompt, chunkCount),
        latencyMs: elapsed(startedAt),
        command: result,
      };
    },
  );
  await writeJson(paths.sends, sendResults);
  assert(sendResults.every((entry) => entry.command.state === "succeeded"), "a send command failed");
  await waitFor("all 100 native turns to complete", timeoutMs, async () =>
    initialCompletions.size === totalSessions ? true : undefined,
  );
  assert(nativeGaps.length === 0, `received ${nativeGaps.length} unexpected native gaps`);
  assert(duplicateKeys.length === 0, `received ${duplicateKeys.length} duplicate native events`);

  const streamAssertions = sendResults.map((send) =>
    assertNativeTranscript({
      events: nativeBySession.get(send.sessionId) ?? [],
      session: requiredMapValue(sessionInfo, send.sessionId).session,
      vendorSessionId: requiredMapValue(sessionInfo, send.sessionId).vendorSessionId,
      expectedText: send.expectedText,
      chunkCount,
      workerName: send.workerName,
      branch: send.branch,
    }),
  );
  const concurrency = concurrencyWindow(streamAssertions);
  await writeJson(paths.streamAssertions, {
    passed: true,
    expectedSessions: totalSessions,
    expectedEventsPerSession: chunkCount + 4,
    nativeEventCount: totalNativeEvents,
    nativeGapCount: nativeGaps.length,
    duplicateEventKeyCount: duplicateKeys.length,
    concurrency,
    sessions: streamAssertions,
  });

  const targetInfo = required(
    [...sessionInfo.values()].find(
      (info) => info.workerName === `${workerPrefix}-a1-00` && info.sessionIndex === 0,
    ),
    "target leaf session",
  );
  const targetSession = required(
    await primary.sessions.get.query(targetInfo.session.sessionId),
    "target leaf session after streaming",
  );
  const settingRequests = [
    { type: "setModel", model: "mock-model" },
    { type: "setEffort", effort: "high" },
    { type: "setMode", mode: "plan" },
  ];
  const settingResults = [];
  for (const request of settingRequests) {
    const envelope = sessionCommand(targetSession, {
      harness: "codex",
      command: request,
    });
    const record = await routed(`leaf setting ${request.type}`, () =>
      primary.sessions.execute.mutate(envelope),
    );
    assert(record.state === "succeeded", `leaf setting command ${request.type} failed`);
    const recovered = await routed(`secondary recovery ${request.type}`, () =>
      secondary.commands.get.query(record.commandId),
    );
    assert(recovered?.state === "succeeded", `secondary observer could not recover ${request.type}`);
    settingResults.push({ request, record, recoveredBySecondaryObserver: recovered });
  }
  await waitFor("three leaf settings events", timeoutMs, async () => {
    const settings = (nativeBySession.get(targetSession.sessionId) ?? []).filter(
      (event) => event.nativeType === "thread/settings/updated",
    );
    return settings.length >= 3 ? settings : undefined;
  });
  await writeJson(paths.settings, settingResults);

  const historyRequest = {
    sessionId: targetSession.sessionId,
    request: { harness: "codex" },
  };
  const [historyInitial, leafHistoryInitial] = await Promise.all([
    routed("native history before disconnect", () =>
      primary.sessions.readNativeHistory.query(historyRequest),
    ),
    leaf.sessions.readNativeHistory.query(historyRequest),
  ]);
  assertDeepEqual(
    historyInitial,
    leafHistoryInitial,
    "pre-disconnect routed and leaf-local native history",
  );
  assert(historyInitial.harness === "codex", "leaf native history returned another harness");
  assert(historyInitial.vendorSessionId === targetSession.vendorSessionId, "native history returned another vendor ID");
  assert(historyInitial.complete === true, "mock native history was unexpectedly partial");
  await writeJson(paths.historyInitial, {
    routingAssertions: {
      sessionId: targetSession.sessionId,
      requestedLogicalSessionId: targetSession.sessionId,
      expectedVendorSessionId: targetSession.vendorSessionId,
      returnedVendorSessionId: historyInitial.vendorSessionId,
      harnessPreserved: true,
      routedResultExactlyEqualsLeafLocalResult: true,
      payloadPreservedExactlyAcrossHostLinks: true,
    },
    routedNativeResult: historyInitial,
    leafLocalNativeResult: leafHistoryInitial,
  });

  const rootMetadataPatch = {
    operationId: newOperationId(),
    sessionId: targetSession.sessionId,
    set: {
      "nested.root_write": `root/${runId}`,
      "nested.root_observer": "gateway-primary",
    },
  };
  const rootMetadataOperation = await routed("root metadata write", () =>
    primary.metadata.patch.mutate(rootMetadataPatch),
  );
  assert(rootMetadataOperation.status === "accepted", "root-authority metadata write was not accepted");
  await waitFor("root metadata to replicate down to the leaf", timeoutMs, async () => {
    const metadata = await leaf.metadata.get.query(targetSession.sessionId);
    return metadata.values["nested.root_write"] === `root/${runId}` ? metadata : undefined;
  });
  await writeJson(paths.metadataRoot, rootMetadataOperation);

  const leafOperationId = newOperationId();
  const leafQueuedOperation = await leaf.metadata.patch.mutate({
    operationId: leafOperationId,
    sessionId: targetSession.sessionId,
    set: {
      "nested.leaf_write": `leaf/${runId}`,
      "nested.leaf_outbox": true,
    },
  });
  assert(leafQueuedOperation.status === "queued", "leaf-origin metadata write was not durably queued first");
  assert(leafQueuedOperation.originHostId === topology.leafA1.hostId, "leaf metadata operation has another origin host");
  const convergedMetadata = await waitFor(
    "leaf-origin metadata to converge through the root authority",
    timeoutMs,
    async () => {
      const [rootMetadata, rootOperation, leafOperation] = await Promise.all([
        primary.metadata.get.query(targetSession.sessionId),
        primary.metadata.operations.get.query(leafOperationId),
        leaf.metadata.operations.get.query(leafOperationId),
      ]);
      return rootMetadata.values["nested.leaf_write"] === `leaf/${runId}` &&
        rootOperation?.status === "accepted" &&
        leafOperation?.status === "accepted"
        ? { rootMetadata, rootOperation, leafOperation }
        : undefined;
    },
  );
  await writeJson(paths.metadataLeaf, {
    initialLeafReceipt: leafQueuedOperation,
    converged: convergedMetadata,
    assertions: {
      initiallyDurableAndQueued: true,
      rootAuthorityAccepted: true,
      terminalReceiptReplicatedDownstream: true,
    },
  });

  const beforeInterruptEventCount = (nativeBySession.get(targetSession.sessionId) ?? []).length;
  const interruptPrompt = `interrupt/${runId}`;
  const interruptSetupEnvelope = sessionCommand(targetSession, {
    harness: "codex",
    command: { type: "send", input: interruptPrompt },
  });
  const runningRecord = await routed("leaf interrupt setup send", () =>
    primary.sessions.execute.mutate(interruptSetupEnvelope),
  );
  assert(runningRecord.state === "succeeded", "target leaf send for interrupt failed");
  const runningTurnId = runningRecord.result?.turn?.id;
  assert(typeof runningTurnId === "string", "target leaf send omitted its native turn ID");
  await waitFor("three target deltas before interrupt", timeoutMs, async () => {
    const events = (nativeBySession.get(targetSession.sessionId) ?? []).slice(beforeInterruptEventCount);
    const deltas = events.filter(
      (event) => event.nativeType === "item/agentMessage/delta" && event.payload?.turnId === runningTurnId,
    );
    return deltas.length >= 3 ? deltas : undefined;
  });
  const interruptEnvelope = sessionCommand(targetSession, {
    harness: "codex",
    command: { type: "interrupt", turnId: runningTurnId },
  });
  const interruptRecord = await routed("root-to-leaf interrupt", () =>
    primary.sessions.execute.mutate(interruptEnvelope),
  );
  assert(interruptRecord.state === "succeeded", "root-to-leaf interrupt command failed");
  assert(interruptRecord.result?.interrupted === true, "leaf mock turn did not report interruption");
  const interruptCompleted = await waitFor("interrupted native completion", timeoutMs, async () =>
    (nativeBySession.get(targetSession.sessionId) ?? []).find(
      (event) =>
        event.nativeType === "turn/completed" &&
        event.payload?.turn?.id === runningTurnId &&
        event.payload?.turn?.status === "interrupted",
    ),
  );
  const secondaryInterrupt = await routed("secondary interrupt recovery", () =>
    secondary.commands.get.query(interruptRecord.commandId),
  );
  assert(secondaryInterrupt?.state === "succeeded", "secondary observer could not recover interrupt command");
  await writeJson(paths.interrupt, {
    runningRecord,
    interruptRecord,
    recoveredBySecondaryObserver: secondaryInterrupt,
    nativeCompletion: interruptCompleted,
    assertions: {
      threeDeltasObservedBeforeInterrupt: true,
      interruptedAcrossTwoHostLinks: true,
      nativeCompletionWasInterrupted: true,
    },
  });

  const stableProjection = identityProjection(initialHosts, initialWorkers, sessionsInitial);
  await writeJson(paths.disconnectRequest, {
    requestedAt: now(),
    targetHostName: topology.aggregateA.name,
    targetHostId: topology.aggregateA.hostId,
    attachmentId: topology.aggregateA.attachmentId,
    reason: "prove transport loss changes reachability without topology mutation",
  });
  await waitFor("Docker aggregate-A disconnect controller", timeoutMs, async () =>
    readJsonIfPresent(paths.disconnectStarted),
  );

  const disconnectedView = await waitFor(
    "root to mark aggregate A unreachable while retaining its subtree",
    timeoutMs,
    async () => {
      const [hosts, workers, sessions] = await Promise.all([
        primary.hosts.list.query(),
        primary.workers.list.query(),
        primary.sessions.list.query(),
      ]);
      const aggregateA = hosts.find((host) => host.hostId === topology.aggregateA.hostId);
      const branchOwnerIds = new Set([topology.aggregateA.hostId, topology.leafA1.hostId]);
      const branchWorkers = workers.filter((worker) => branchOwnerIds.has(worker.ownerHostId));
      const selectedSessions = selectRunSessions(sessions, runId);
      return aggregateA?.presence !== "online" &&
        branchWorkers.length === (expectedBranchCounts.a + expectedBranchCounts.a1) &&
        branchWorkers.every((worker) => worker.reachability !== "reachable") &&
        selectedSessions.length === totalSessions
        ? { hosts: hosts.sort(compareName), workers: workers.sort(compareName), sessions: selectedSessions.sort(compareSession) }
        : undefined;
    },
  );
  assertStableIdentity(stableProjection, disconnectedView, "disconnect");
  const disconnectedTree = assertHostTree(disconnectedView.hosts, hostPrefix, false);
  assert(disconnectedTree.aggregateA.attachmentId === topology.aggregateA.attachmentId, "disconnect replaced aggregate-A attachment");
  assert(disconnectedTree.leafA1.attachmentId === topology.leafA1.attachmentId, "disconnect replaced leaf attachment");
  await writeJson(paths.disconnectedView, {
    observedAt: now(),
    assertions: {
      immediateChildNotOnline: true,
      branchWorkersNotReachable: true,
      cachedSessionsRetained: true,
      parentageRetained: true,
      attachmentsRetained: true,
      lineageRetained: true,
      identitiesRetained: true,
      noPromotionOrReparenting: true,
    },
    ...disconnectedView,
  });
  await writeJson(paths.reconnectRequest, {
    requestedAt: now(),
    targetHostName: topology.aggregateA.name,
    targetHostId: topology.aggregateA.hostId,
  });
  await waitFor("Docker aggregate-A reconnect controller", timeoutMs, async () =>
    readJsonIfPresent(paths.reconnectComplete),
  );

  const reconnectedView = await waitFor(
    "the exact nested tree to recover after reconnect",
    timeoutMs,
    async () => {
      const [hosts, workers, sessions] = await Promise.all([
        primary.hosts.list.query(),
        primary.workers.list.query(),
        primary.sessions.list.query(),
      ]);
      const selectedSessions = selectRunSessions(sessions, runId);
      return hosts.length === 4 &&
        hosts.every((host) => host.presence === "online") &&
        workers.length === workerCount &&
        workers.every((worker) => worker.presence === "online" && worker.reachability === "reachable") &&
        selectedSessions.length === totalSessions &&
        selectedSessions.every(isActiveIdle)
        ? { hosts: hosts.sort(compareName), workers: workers.sort(compareName), sessions: selectedSessions.sort(compareSession) }
        : undefined;
    },
  );
  assertStableIdentity(stableProjection, reconnectedView, "reconnect");
  assertHostTree(reconnectedView.hosts, hostPrefix);
  await writeJson(paths.reconnectedView, {
    observedAt: now(),
    assertions: {
      allHostsOnline: true,
      allWorkersOnlineAndReachable: true,
      allSessionsActiveAndIdle: true,
      exactAttachmentsRetained: true,
      exactLineagesRetained: true,
      exactLogicalAndNativeIdsRetained: true,
      routingRestoredWithoutReparenting: true,
    },
    ...reconnectedView,
  });

  const beforePostReconnect = (nativeBySession.get(targetSession.sessionId) ?? []).length;
  const postPrompt = `post-reconnect/${runId}`;
  const postReconnectEnvelope = sessionCommand(targetSession, {
    harness: "codex",
    command: { type: "send", input: postPrompt },
  });
  const postRecord = await routed("post-reconnect root-to-leaf send", () =>
    primary.sessions.execute.mutate(postReconnectEnvelope),
  );
  assert(postRecord.state === "succeeded", "post-reconnect root-to-leaf send failed");
  const postTurnId = postRecord.result?.turn?.id;
  assert(typeof postTurnId === "string", "post-reconnect send omitted its native turn ID");
  const postEvents = await waitFor("post-reconnect leaf native completion", timeoutMs, async () => {
    const events = (nativeBySession.get(targetSession.sessionId) ?? []).slice(beforePostReconnect);
    return events.some(
      (event) =>
        event.nativeType === "turn/completed" &&
        event.payload?.turn?.id === postTurnId &&
        event.payload?.turn?.status === "completed",
    )
      ? events.filter((event) => event.payload?.turnId === postTurnId || event.payload?.turn?.id === postTurnId)
      : undefined;
  });
  assert(
    postEvents.filter((event) => event.nativeType === "item/agentMessage/delta").length === chunkCount,
    "post-reconnect native stream lost deltas",
  );
  await writeJson(paths.postReconnect, {
    command: postRecord,
    nativeEvents: postEvents,
    assertions: { commandSucceeded: true, nativeTurnCompleted: true, exactDeltaCount: true },
  });

  const [historyFinal, leafHistoryFinal] = await Promise.all([
    routed("post-reconnect history through secondary", () =>
      secondary.sessions.readNativeHistory.query(historyRequest),
    ),
    leaf.sessions.readNativeHistory.query(historyRequest),
  ]);
  assertDeepEqual(
    historyFinal,
    leafHistoryFinal,
    "post-reconnect routed and leaf-local native history",
  );
  assert(historyFinal.vendorSessionId === targetSession.vendorSessionId, "post-reconnect history changed native ID");
  assert(historyFinal.complete === true, "post-reconnect native history was partial");
  await writeJson(paths.historyFinal, {
    routingAssertions: {
      observer: "secondary-gateway",
      expectedVendorSessionId: targetSession.vendorSessionId,
      returnedVendorSessionId: historyFinal.vendorSessionId,
      routedResultExactlyEqualsLeafLocalResult: true,
      payloadPreservedExactlyAcrossHostLinks: true,
      routedAfterReconnect: true,
    },
    routedNativeResult: historyFinal,
    leafLocalNativeResult: leafHistoryFinal,
  });

  const stabilitySamples = [];
  const soakStartedAt = Date.now();
  while (Date.now() - soakStartedAt < soakMs) {
    const parity = await waitFor(
      "observer parity during stability soak",
      Math.min(timeoutMs, 5_000),
      async () => observerParity(primary, secondary, runId, totalSessions),
    );
    assert(parity.exact === true, "stability sample did not have exact observer parity");
    stabilitySamples.push({ at: now(), ...parity });
    const remainingMs = soakMs - (Date.now() - soakStartedAt);
    if (remainingMs > 0) await delay(Math.min(1_000, remainingMs));
  }
  assert(stabilitySamples.length >= 2, "stability soak produced fewer than two samples");
  assert(
    stabilitySamples.every(
      (sample) =>
        sample.exact === true &&
        sample.hostCount === 4 &&
        sample.workerCount === workerCount &&
        sample.sessionCount === totalSessions,
    ),
    "a stability sample did not preserve the complete online fleet",
  );
  await writeJson(paths.stability, stabilitySamples);

  const finalParity = await waitFor(
    "final observer parity",
    timeoutMs,
    async () => observerParity(primary, secondary, runId, totalSessions),
  );
  const finalViews = await waitFor(
    "fresh final fleet snapshots from both observers",
    timeoutMs,
    async () => {
      const [[primaryHosts, primaryWorkers, primarySessions], [secondaryHosts, secondaryWorkers, secondarySessions]] =
        await Promise.all([
          Promise.all([
            primary.hosts.list.query(),
            primary.workers.list.query(),
            primary.sessions.list.query(),
          ]),
          Promise.all([
            secondary.hosts.list.query(),
            secondary.workers.list.query(),
            secondary.sessions.list.query(),
          ]),
        ]);
      const primaryView = {
        hosts: primaryHosts.sort(compareName),
        workers: primaryWorkers.sort(compareName),
        sessions: selectRunSessions(primarySessions, runId).sort(compareSession),
      };
      const secondaryView = {
        hosts: secondaryHosts.sort(compareName),
        workers: secondaryWorkers.sort(compareName),
        sessions: selectRunSessions(secondarySessions, runId).sort(compareSession),
      };
      return primaryView.hosts.length === 4 &&
        primaryView.hosts.every((host) => host.presence === "online") &&
        primaryView.workers.length === workerCount &&
        primaryView.workers.every(
          (worker) => worker.presence === "online" && worker.reachability === "reachable",
        ) &&
        primaryView.sessions.length === totalSessions &&
        primaryView.sessions.every(isActiveIdle) &&
        deepEqual(primaryView, secondaryView)
        ? { primary: primaryView, secondary: secondaryView }
        : undefined;
    },
  );
  assertStableIdentity(stableProjection, finalViews.primary, "final snapshot");
  assertHostTree(finalViews.primary.hosts, hostPrefix);
  assertWorkerOwnership(finalViews.primary.workers, topology, workerPrefix);
  await writeJson(paths.observerFinal, {
    ...finalParity,
    queriedFreshAfterSoak: true,
    exactPayloadParity: deepEqual(finalViews.primary, finalViews.secondary),
  });
  await Promise.all([
    writeJson(paths.hostsFinal, finalViews.primary.hosts),
    writeJson(paths.workersFinal, finalViews.primary.workers),
    writeJson(paths.sessionsFinal, finalViews.primary.sessions),
  ]);

  const summary = {
    passed: true,
    runId,
    topology: {
      hosts: 4,
      edges: 3,
      maximumDepth: 2,
      workers: workerCount,
      sessionsPerWorker,
      totalSessions,
      branchWorkerCounts: expectedBranchCounts,
      observerGateways: 2,
    },
    commands: {
      spawnSucceeded: spawnResults.length,
      sendSucceeded: sendResults.length,
      settingsSucceeded: settingResults.length,
      interruptSucceeded: true,
      postReconnectSendSucceeded: true,
      spawnLatencyMs: percentiles(spawnResults.map((entry) => entry.latencyMs)),
      sendAckLatencyMs: percentiles(sendResults.map((entry) => entry.latencyMs)),
    },
    streaming: {
      initialTurnsCompleted: initialCompletions.size,
      configuredChunksPerSession: chunkCount,
      initialNativeEvents: totalSessions * (chunkCount + 4),
      nativeGaps: nativeGaps.length,
      duplicateEventKeys: duplicateKeys.length,
      exactTranscripts: streamAssertions.length,
      peakConcurrentTurns: concurrency.peakConcurrentTurns,
      interruptObserved: true,
      postReconnectStreamObserved: true,
    },
    metadata: {
      rootAuthorityWriteAccepted: true,
      rootWriteReplicatedToLeaf: true,
      leafWriteInitiallyQueued: true,
      leafWriteAcceptedAtRoot: true,
      terminalReceiptReplicatedToLeaf: true,
    },
    nativeHistory: {
      beforeDisconnectRoutedToLeaf: true,
      afterReconnectRoutedToLeaf: true,
      beforeDisconnectMatchesLeafExactly: deepEqual(historyInitial, leafHistoryInitial),
      afterReconnectMatchesLeafExactly: deepEqual(historyFinal, leafHistoryFinal),
      payloadPreservedExactlyAcrossHostLinks:
        deepEqual(historyInitial, leafHistoryInitial) && deepEqual(historyFinal, leafHistoryFinal),
    },
    reconnect: {
      targetHost: topology.aggregateA.name,
      attachmentRetained: true,
      lineageRetained: true,
      parentageRetained: true,
      logicalAndNativeIdsRetained: true,
      noReparentOrPromotion: true,
      routingRecovered: true,
    },
    observers: {
      independentlyEnrolledGateways: 2,
      initialParity: true,
      finalParity: true,
      websocketOpenCount,
      websocketCloseCount,
    },
    stability: {
      requestedSoakMs: soakMs,
      samples: stabilitySamples.length,
      everySampleExact: stabilitySamples.every((sample) => sample.exact === true),
      allHostsOnline: stabilitySamples.every((sample) => sample.hostCount === 4),
      allWorkersOnlineAndReachable: stabilitySamples.every(
        (sample) => sample.workerCount === workerCount,
      ),
      allSessionsActiveAndIdle: stabilitySamples.every(
        (sample) => sample.sessionCount === totalSessions,
      ),
    },
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  await writeJson(paths.failure, {
    at: now(),
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
  }).catch(() => undefined);
  throw error;
} finally {
  watcher?.stop();
  await watcher?.done.catch(() => undefined);
  for (const handle of [primaryHandle, secondaryHandle, rootHandle, leafHandle]) {
    handle.close();
  }
  eventOutput.end();
  await once(eventOutput, "close").catch(() => undefined);
  await stateLog.close().catch(() => undefined);
}

function fleetHandle(httpUrl, tracked = false) {
  const wsUrl = httpUrl.replace(/^http/, "ws").replace(/\/trpc$/, "/trpc");
  return createFleetClient({
    httpUrl,
    wsUrl,
    WebSocket: NodeWebSocket,
    ...(tracked
      ? {
          onWebSocketOpen: () => {
            websocketOpenCount += 1;
            void appendNdjson(stateLog, {
              at: now(),
              source: "primary-gateway-websocket",
              state: "open",
              count: websocketOpenCount,
            }).catch(() => undefined);
          },
          onWebSocketClose: (cause) => {
            websocketCloseCount += 1;
            void appendNdjson(stateLog, {
              at: now(),
              source: "primary-gateway-websocket",
              state: "closed",
              count: websocketCloseCount,
              cause: cause ?? null,
            }).catch(() => undefined);
          },
        }
      : {}),
  });
}

function assertHostTree(hosts, prefix, requireOnline = true) {
  const byName = new Map(hosts.map((host) => [host.name, host]));
  const rootHost = required(byName.get(`${prefix}-root`), "root host");
  const aggregateA = required(byName.get(`${prefix}-aggregate-a`), "aggregate A");
  const leafA1 = required(byName.get(`${prefix}-leaf-a1`), "leaf A1");
  const aggregateB = required(byName.get(`${prefix}-aggregate-b`), "aggregate B");
  assert(rootHost.parentHostId === null, "root host unexpectedly has a parent");
  assert(rootHost.attachmentId === null, "root host unexpectedly has an attachment");
  assert(aggregateA.parentHostId === rootHost.hostId, "aggregate A is not attached to root");
  assert(leafA1.parentHostId === aggregateA.hostId, "leaf A1 is not attached to aggregate A");
  assert(aggregateB.parentHostId === rootHost.hostId, "aggregate B is not attached to root");
  for (const child of [aggregateA, leafA1, aggregateB]) {
    assert(typeof child.attachmentId === "string", `${child.name} has no attachment ID`);
    assert(child.rootHostId === rootHost.hostId, `${child.name} has another root`);
    assert(child.authorityHostId === rootHost.hostId, `${child.name} has another metadata authority`);
    assert(child.authorityEpochId === rootHost.authorityEpochId, `${child.name} has another authority epoch`);
    assert(typeof child.lineageId === "string", `${child.name} has no durable lineage`);
  }
  if (requireOnline) assert(hosts.every((host) => host.presence === "online"), "a host is not online");
  assertUnique(hosts.map((host) => host.hostId), "host IDs");
  assertUnique(hosts.map((host) => host.hostBootId), "host boot IDs");
  assertUnique(hosts.map((host) => host.feedId), "host feed IDs");
  assertUnique(hosts.map((host) => host.endpointId), "host endpoint IDs");
  assertUnique(hosts.map((host) => host.lineageId), "host lineage IDs");
  return { root: rootHost, aggregateA, leafA1, aggregateB };
}

function assertWorkerOwnership(workers, topology, prefix) {
  for (const worker of workers) {
    const branch = workerBranch(worker.name, prefix);
    const expectedOwner = branch === "a1"
      ? topology.leafA1.hostId
      : branch === "a"
        ? topology.aggregateA.hostId
        : topology.aggregateB.hostId;
    assert(worker.ownerHostId === expectedOwner, `${worker.name} has the wrong owner host`);
  }
  for (const [branch, expected] of Object.entries(expectedBranchCounts)) {
    assert(
      workers.filter((worker) => workerBranch(worker.name, prefix) === branch).length === expected,
      `branch ${branch} has the wrong worker count`,
    );
  }
}

async function observerParity(primaryClient, secondaryClient, receiptRunId, expectedSessions) {
  const [[primaryHosts, primaryWorkers, primarySessions], [secondaryHosts, secondaryWorkers, secondarySessions]] =
    await Promise.all([
      Promise.all([
        primaryClient.hosts.list.query(),
        primaryClient.workers.list.query(),
        primaryClient.sessions.list.query(),
      ]),
      Promise.all([
        secondaryClient.hosts.list.query(),
        secondaryClient.workers.list.query(),
        secondaryClient.sessions.list.query(),
      ]),
    ]);
  const left = {
    hosts: primaryHosts.sort(compareName),
    workers: primaryWorkers.sort(compareName),
    sessions: selectRunSessions(primarySessions, receiptRunId).sort(compareSession),
  };
  const right = {
    hosts: secondaryHosts.sort(compareName),
    workers: secondaryWorkers.sort(compareName),
    sessions: selectRunSessions(secondarySessions, receiptRunId).sort(compareSession),
  };
  if (
    left.hosts.length !== 4 ||
    left.workers.length !== workerCount ||
    left.sessions.length !== expectedSessions ||
    left.hosts.some((host) => host.presence !== "online") ||
    left.workers.some((worker) => worker.presence !== "online" || worker.reachability !== "reachable") ||
    left.sessions.some((session) => !isActiveIdle(session)) ||
    JSON.stringify(left) !== JSON.stringify(right)
  ) {
    return undefined;
  }
  return {
    exact: true,
    hostCount: left.hosts.length,
    workerCount: left.workers.length,
    sessionCount: left.sessions.length,
    hostIds: left.hosts.map((host) => host.hostId),
    workerIds: left.workers.map((worker) => worker.workerId),
    sessionIds: left.sessions.map((session) => session.sessionId),
  };
}

function assertNativeTranscript({ events, session, vendorSessionId, expectedText, chunkCount, workerName, branch }) {
  const expectedTypes = [
    "turn/started",
    "item/started",
    ...Array.from({ length: chunkCount }, () => "item/agentMessage/delta"),
    "item/completed",
    "turn/completed",
  ];
  assert(events.length === expectedTypes.length, `${session.sessionId} has ${events.length} initial events`);
  assertDeepEqual(events.map((event) => event.nativeType), expectedTypes, `${session.sessionId} native order`);
  assertDeepEqual(
    events.map((event) => event.sequence),
    Array.from({ length: expectedTypes.length }, (_, index) => index),
    `${session.sessionId} native sequence`,
  );
  assert(events.every((event) => event.runtimeEpoch === session.runtimeEpoch), `${session.sessionId} changed runtime epoch`);
  const turnStarted = events[0].payload;
  const itemStarted = events[1].payload;
  const deltas = events.slice(2, 2 + chunkCount);
  const itemCompleted = events[2 + chunkCount].payload;
  const turnCompleted = events[3 + chunkCount].payload;
  assert(turnStarted?.threadId === vendorSessionId, `${session.sessionId} started on another native thread`);
  assert(itemStarted?.threadId === vendorSessionId, `${session.sessionId} item started on another native thread`);
  const turnId = turnStarted?.turn?.id;
  const itemId = itemStarted?.item?.id;
  assert(typeof turnId === "string", `${session.sessionId} omitted turn ID`);
  assert(typeof itemId === "string", `${session.sessionId} omitted item ID`);
  const emittedAtMs = events.map((event) => event.payload?.emittedAtMs);
  assert(
    emittedAtMs.every((value) => Number.isSafeInteger(value) && value >= 0),
    `${session.sessionId} omitted deterministic mock emission timestamps`,
  );
  assert(
    emittedAtMs.every((value, index) => index === 0 || value >= emittedAtMs[index - 1]),
    `${session.sessionId} mock emission timestamps moved backwards`,
  );
  assert(
    deltas.every(
      (event) =>
        event.payload?.threadId === vendorSessionId &&
        event.payload?.turnId === turnId &&
        event.payload?.itemId === itemId &&
        typeof event.payload?.delta === "string",
    ),
    `${session.sessionId} has malformed native delta routing`,
  );
  const reassembled = deltas.map((event) => event.payload.delta).join("");
  assert(reassembled === expectedText, `${session.sessionId} native deltas did not reassemble exactly`);
  assert(itemCompleted?.item?.text === expectedText, `${session.sessionId} item completion changed output`);
  assert(turnCompleted?.turn?.status === "completed", `${session.sessionId} did not complete`);
  return {
    sessionId: session.sessionId,
    workerName,
    branch,
    vendorSessionId,
    runtimeEpoch: session.runtimeEpoch,
    turnId,
    itemId,
    eventCount: events.length,
    deltaCount: deltas.length,
    outputBytes: Buffer.byteLength(reassembled, "utf8"),
    exactReassembly: true,
    contiguousSequence: true,
    startedAt: events[0].receivedAt,
    completedAt: events.at(-1).receivedAt,
    emittedStartedAt: new Date(emittedAtMs[0]).toISOString(),
    emittedCompletedAt: new Date(emittedAtMs.at(-1)).toISOString(),
  };
}

function concurrencyWindow(assertions) {
  const points = assertions.flatMap((entry) => [
    { at: Date.parse(entry.emittedStartedAt), delta: 1 },
    { at: Date.parse(entry.emittedCompletedAt), delta: -1 },
  ]).sort((left, right) => left.at - right.at || right.delta - left.delta);
  let current = 0;
  let peak = 0;
  for (const point of points) {
    current += point.delta;
    peak = Math.max(peak, current);
  }
  assert(peak >= Math.min(80, totalSessions), `only ${peak}/${totalSessions} turns overlapped`);
  return {
    peakConcurrentTurns: peak,
    minimumAcceptedPeak: Math.min(80, totalSessions),
    basis: "mock-native-payload-emittedAtMs",
    earliestStart: new Date(
      Math.min(...assertions.map((entry) => Date.parse(entry.emittedStartedAt))),
    ).toISOString(),
    latestCompletion: new Date(
      Math.max(...assertions.map((entry) => Date.parse(entry.emittedCompletedAt))),
    ).toISOString(),
    earliestObserverReceipt: new Date(
      Math.min(...assertions.map((entry) => Date.parse(entry.startedAt))),
    ).toISOString(),
    latestObserverReceipt: new Date(
      Math.max(...assertions.map((entry) => Date.parse(entry.completedAt))),
    ).toISOString(),
  };
}

function identityProjection(hosts, workers, sessions) {
  return {
    hosts: hosts.map((host) => ({
      name: host.name,
      hostId: host.hostId,
      hostBootId: host.hostBootId,
      feedId: host.feedId,
      endpointId: host.endpointId,
      parentHostId: host.parentHostId,
      rootHostId: host.rootHostId,
      attachmentId: host.attachmentId,
      lineageId: host.lineageId,
      authorityHostId: host.authorityHostId,
      authorityEpochId: host.authorityEpochId,
    })).sort(compareName),
    workers: workers.map((worker) => ({
      name: worker.name,
      workerId: worker.workerId,
      workerBootId: worker.workerBootId,
      ownerHostId: worker.ownerHostId,
      endpointId: worker.endpointId,
    })).sort(compareName),
    sessions: sessions.map((session) => ({
      sessionId: session.sessionId,
      workerId: session.workerId,
      harness: session.harness,
      adapterScopeId: session.adapterScopeId,
      vendorSessionId: session.vendorSessionId,
      bindingRevision: session.bindingRevision,
      runtimeEpoch: session.runtimeEpoch,
      cwd: session.cwd,
      metadataAuthority: session.metadataAuthority,
    })).sort(compareSession),
  };
}

function assertStableIdentity(expected, current, phase) {
  const actual = identityProjection(current.hosts, current.workers, current.sessions);
  assertDeepEqual(actual, expected, `${phase} stable identity projection`);
}

function expectedWorkerNames(prefix) {
  return [
    ...Array.from({ length: expectedBranchCounts.a1 }, (_, index) => `${prefix}-a1-${twoDigits(index)}`),
    ...Array.from({ length: expectedBranchCounts.a }, (_, index) => `${prefix}-a-${twoDigits(index)}`),
    ...Array.from({ length: expectedBranchCounts.b }, (_, index) => `${prefix}-b-${twoDigits(index)}`),
  ].sort();
}

function workerBranch(name, prefix) {
  if (name.startsWith(`${prefix}-a1-`)) return "a1";
  if (name.startsWith(`${prefix}-a-`)) return "a";
  if (name.startsWith(`${prefix}-b-`)) return "b";
  throw new Error(`worker ${name} is outside the expected branches`);
}

function isReadyMockWorker(worker) {
  return worker.presence === "online" &&
    worker.reachability === "reachable" &&
    worker.protocolVersion === 2 &&
    worker.harnesses.some(
      (entry) =>
        entry.harness === "codex" &&
        entry.available === true &&
        [entry.version, entry.runtimeVersion]
          .filter((value) => typeof value === "string")
          .some((value) => value.toLowerCase().includes("mock") || value === "in-memory"),
    );
}

function isActiveIdle(session) {
  return session.availability === "active" &&
    session.runtimeStatus === "idle" &&
    session.runtimeEpoch !== null;
}

function selectRunSessions(sessions, receiptRunId) {
  return sessions.filter((session) => session.metadata.values["nested.run_id"] === receiptRunId);
}

function assertSessionDistribution(sessions, workers, expectedPerWorker) {
  for (const worker of workers) {
    const count = sessions.filter((session) => session.workerId === worker.workerId).length;
    assert(count === expectedPerWorker, `${worker.name} owns ${count}/${expectedPerWorker} sessions`);
  }
}

function assertSessionMetadata(sessions, infoBySession, expectedRunId) {
  for (const session of sessions) {
    const info = requiredMapValue(infoBySession, session.sessionId);
    assert(session.metadata.values["agent.title"] === info.title, `${session.sessionId} lost agent.title`);
    assert(session.metadata.values["nested.run_id"] === expectedRunId, `${session.sessionId} lost nested.run_id`);
    assert(session.metadata.values["nested.branch"] === info.branch, `${session.sessionId} has wrong branch`);
    assert(session.metadata.values["nested.worker_name"] === info.workerName, `${session.sessionId} has wrong worker name`);
    assert(session.metadata.values["nested.session_index"] === info.sessionIndex, `${session.sessionId} has wrong session index`);
    assert(session.metadata.values["nested.source"] === "root-observer-spawn", `${session.sessionId} lost source`);
  }
}

async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) return;
        results[index] = await mapper(values[index], index);
      }
    }),
  );
  return results;
}

async function waitFor(description, maximumMs, operation) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < maximumMs) {
    try {
      const result = await operation();
      if (result !== undefined && result !== false) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `timed out waiting for ${description}` +
      (lastError instanceof Error ? `; last error: ${lastError.message}` : ""),
  );
}

async function routed(description, operation) {
  const startedAt = Date.now();
  let attempt = 0;
  let lastError;
  let outcomeUnknownCommandId;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await operation();
      if (!isOutcomeUnknownCommand(result)) {
        if (
          outcomeUnknownCommandId !== undefined &&
          isObject(result) &&
          typeof result.commandId === "string" &&
          result.commandId !== outcomeUnknownCommandId
        ) {
          throw new Error(
            `idempotent recovery for ${description} changed command ID from ` +
              `${outcomeUnknownCommandId} to ${result.commandId}`,
          );
        }
        return result;
      }
      if (
        outcomeUnknownCommandId !== undefined &&
        outcomeUnknownCommandId !== result.commandId
      ) {
        throw new Error(
          `idempotent recovery for ${description} changed command ID from ` +
            `${outcomeUnknownCommandId} to ${result.commandId}`,
        );
      }
      outcomeUnknownCommandId = result.commandId;
      lastError = new Error(
        `command ${result.commandId} is outcomeUnknown; recovering the same idempotent envelope`,
      );
      attempt += 1;
      await appendNdjson(stateLog, {
        at: now(),
        source: "routed-control",
        state: "recovering-outcome-unknown",
        description,
        attempt,
        commandId: result.commandId,
      });
      await delay(Math.min(1_000, 100 + attempt * 50));
    } catch (error) {
      if (!isTransientRouteError(error)) throw error;
      lastError = error;
      attempt += 1;
      await appendNdjson(stateLog, {
        at: now(),
        source: "routed-control",
        state: "retrying",
        description,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      await delay(Math.min(1_000, 100 + attempt * 50));
    }
  }
  throw new Error(
    `timed out retrying ${description}` +
      (lastError instanceof Error ? `; last error: ${lastError.message}` : ""),
  );
}

function isOutcomeUnknownCommand(value) {
  return isObject(value) &&
    value.state === "outcomeUnknown" &&
    typeof value.commandId === "string" &&
    typeof value.payloadHash === "string";
}

function isTransientRouteError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const data = error && typeof error === "object" ? error.data : undefined;
  return data?.code === "SERVICE_UNAVAILABLE" ||
    data?.code === "BAD_GATEWAY" ||
    data?.code === "GATEWAY_TIMEOUT" ||
    /not connected|connection.*closed|peer is closed|capacity is unavailable|rpc ended|internal server error/i.test(message);
}

function percentiles(values) {
  assert(values.length > 0, "cannot calculate percentiles for an empty sample");
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return {
    count: sorted.length,
    min: round(sorted[0]),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1)),
  };
}

function serializableState(state) {
  if (state.state !== "retrying" && state.state !== "failed") return state;
  return {
    ...state,
    error: state.error instanceof Error ? state.error.message : String(state.error),
  };
}

async function appendNdjson(handle, value) {
  await handle.appendFile(`${JSON.stringify(value)}\n`, "utf8");
}

async function writeJson(filename, value) {
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function readJsonIfPresent(filename) {
  try {
    return await readJson(filename);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function requiredMapValue(map, key) {
  return required(map.get(key), `map entry ${String(key)}`);
}

function required(value, description) {
  assert(value !== undefined && value !== null, `missing ${description}`);
  return value;
}

function assertUnique(values, description) {
  assert(values.every((value) => value !== undefined), `${description} contain undefined`);
  const unique = new Set(values);
  assert(unique.size === values.length, `${description} are not unique (${unique.size}/${values.length})`);
}

function mockExpectedText(vendorSessionId, turn, prompt, count) {
  const width = String(count).length;
  return Array.from(
    { length: count },
    (_, index) =>
      `MOCK_DELTA|session=${vendorSessionId}|turn=${turn}|tick=${String(index + 1).padStart(width, "0")}|prompt=${prompt}\n`,
  ).join("");
}

function assertDeepEqual(actual, expected, description) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${description} differs: actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)}`,
  );
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function compareName(left, right) {
  return left.name.localeCompare(right.name);
}

function compareSession(left, right) {
  return left.sessionId.localeCompare(right.sessionId);
}

function twoDigits(value) {
  return String(value).padStart(2, "0");
}

function elapsed(startedAt) {
  return round(performance.now() - startedAt);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function now() {
  return new Date().toISOString();
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
