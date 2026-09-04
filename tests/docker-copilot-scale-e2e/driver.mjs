#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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
    "usage: driver.mjs <http-trpc-url> <receipt-dir> <run-id> <worker-prefix> " +
      "<worker-count> <sessions-per-worker> <model> <reasoning-effort> " +
      "<stage-width> <stage-delay-ms> <burst-width> <timeout-ms>",
  );
}

const [
  httpUrl,
  rawReceiptDirectory,
  runId,
  workerPrefix,
  rawWorkerCount,
  rawSessionsPerWorker,
  model,
  reasoningEffort,
  rawStageWidth,
  rawStageDelayMs,
  rawBurstWidth,
  rawTimeoutMs,
] = argv;

const receiptDirectory = resolve(rawReceiptDirectory);
const workerCount = positiveInteger(rawWorkerCount, "worker-count");
const sessionsPerWorker = positiveInteger(rawSessionsPerWorker, "sessions-per-worker");
const stageWidth = positiveInteger(rawStageWidth, "stage-width");
const stageDelayMs = nonnegativeInteger(rawStageDelayMs, "stage-delay-ms");
const burstWidth = positiveInteger(rawBurstWidth, "burst-width");
const timeoutMs = positiveInteger(rawTimeoutMs, "timeout-ms");
const totalSessions = workerCount * sessionsPerWorker;
const wsUrl = httpUrl.replace(/^http/, "ws");
const nativeHistoryPageLimit = 10;

assert(workerCount === 10, "the real scale topology requires exactly 10 workers");
assert(sessionsPerWorker === 10, "the real scale topology requires exactly 10 sessions per worker");
assert(stageWidth <= workerCount, "stage width cannot exceed the 10-worker wave size");
assert(burstWidth <= totalSessions, "burst width cannot exceed the 100-session fleet size");
assert(model.length > 0, "model must not be empty");
assert(reasoningEffort.length > 0, "reasoning effort must not be empty");

const paths = {
  events: join(receiptDirectory, "logs/fleet-events.ndjson"),
  states: join(receiptDirectory, "logs/fleet-watch-states.ndjson"),
  workersInitial: join(receiptDirectory, "rpc/workers-initial.json"),
  workersFinal: join(receiptDirectory, "rpc/workers-final.json"),
  models: join(receiptDirectory, "rpc/models.json"),
  spawns: join(receiptDirectory, "rpc/spawn-results.json"),
  metadata: join(receiptDirectory, "rpc/metadata-results.json"),
  sessionsActive: join(receiptDirectory, "rpc/sessions-active.json"),
  sends: join(receiptDirectory, "rpc/send-results.json"),
  burstSends: join(receiptDirectory, "rpc/burst-send-results.json"),
  history: join(receiptDirectory, "rpc/native-history.json"),
  stops: join(receiptDirectory, "rpc/stop-results.json"),
  refresh: join(receiptDirectory, "rpc/refresh-results.json"),
  sessionsStopped: join(receiptDirectory, "rpc/sessions-stopped.json"),
  streamAssertions: join(receiptDirectory, "phases/stream-assertions.json"),
  burstAssertions: join(receiptDirectory, "phases/burst-stream-assertions.json"),
  historyAssertions: join(receiptDirectory, "phases/history-assertions.json"),
  stability: join(receiptDirectory, "phases/stability-samples.json"),
  dashboardReady: join(receiptDirectory, "coord/dashboard-ready.json"),
  dashboardCaptured: join(receiptDirectory, "coord/dashboard-captured.json"),
  disconnectRequest: join(receiptDirectory, "coord/disconnect-request.json"),
  disconnectComplete: join(receiptDirectory, "coord/disconnect-complete.json"),
  failure: join(receiptDirectory, "driver-failure.json"),
};

await Promise.all(
  ["logs", "rpc", "phases", "coord"].map((directory) =>
    mkdir(join(receiptDirectory, directory), { recursive: true }),
  ),
);

const stateLog = await open(paths.states, "w");
const eventOutput = createWriteStream(paths.events, { flags: "w", encoding: "utf8" });
const clientHandle = createFleetClient({ httpUrl, wsUrl, WebSocket: NodeWebSocket });
const client = clientHandle.client;
const nativeBySession = new Map();
const nativeGaps = [];
const nativeSessionErrors = [];
const deliveredKeys = new Set();
const duplicateKeys = [];
let totalNativeEvents = 0;
let watcher;
let burstActive = false;
let burstDispatchComplete = false;
let disconnectRequestedAt;
let reconnectWorkerIndex;
let reconnectWorkerName;
let atomicWriteSequence = 0;

try {
  const initialWorkers = await waitFor(
    "all real Copilot workers to register",
    timeoutMs,
    async () => {
      const workers = await client.workers.list.query();
      const selected = workers
        .filter((worker) => worker.name.startsWith(workerPrefix))
        .sort((left, right) => left.name.localeCompare(right.name));
      return selected.length === workerCount && selected.every(isReadyCopilotWorker)
        ? selected
        : undefined;
    },
  );
  await writeJson(paths.workersInitial, initialWorkers);

  const expectedWorkerNames = Array.from(
    { length: workerCount },
    (_, index) => `${workerPrefix}-${twoDigits(index)}`,
  );
  assertDeepEqual(
    initialWorkers.map((worker) => worker.name),
    expectedWorkerNames,
    "registered worker names",
  );
  const workersByName = new Map(initialWorkers.map((worker) => [worker.name, worker]));

  const modelResults = await mapConcurrent(initialWorkers, workerCount, async (worker) => ({
    workerId: worker.workerId,
    workerName: worker.name,
    models: await client.harness.models.query({
      workerId: worker.workerId,
      harness: "copilot",
    }),
  }));
  for (const result of modelResults) {
    const advertised = result.models.find((candidate) => candidate.id === model);
    assert(advertised, `${result.workerName} did not advertise ${model}`);
    assert(advertised.harness === "copilot", `${result.workerName} advertised the wrong harness`);
    assert(advertised.native?.byok === true, `${result.workerName} did not mark ${model} as BYOK`);
    assert(
      advertised.native?.wireApi === "responses",
      `${result.workerName} did not advertise the Responses wire API`,
    );
    assert(
      advertised.native?.transport === "http",
      `${result.workerName} did not advertise the HTTP provider transport`,
    );
  }
  await writeJson(paths.models, modelResults);

  const spawnInputs = expectedWorkerNames.flatMap((workerName, workerIndex) =>
    Array.from({ length: sessionsPerWorker }, (_, sessionIndex) => {
      const worker = requiredMapValue(workersByName, workerName);
      const title = `Copilot scale ${twoDigits(workerIndex)}/${twoDigits(sessionIndex)} ${runId}`;
      const marker = markerFor(runId, workerIndex, sessionIndex);
      const prompt = `Reply with exactly ${marker} and nothing else. Do not use Markdown.`;
      const command = spawnCommand(
        worker.workerId,
        {
          harness: "copilot",
          cwd: "/workspace",
          model,
          reasoningEffort,
          mode: "interactive",
          native: {
            enableConfigDiscovery: false,
            tools: [],
            availableTools: [],
            excludedTools: ["builtin:*", "mcp:*", "custom:*"],
            toolSearch: { enabled: false },
            requestCanvasRenderer: false,
            requestExtensions: false,
          },
        },
        {
          "agent.title": title,
          "scale.run_id": runId,
          "scale.worker_index": workerIndex,
          "scale.session_index": sessionIndex,
          "scale.harness": "copilot",
        },
      );
      return { worker, workerIndex, sessionIndex, title, marker, prompt, command };
    }),
  );

  const spawnResults = [];
  for (let wave = 0; wave < sessionsPerWorker; wave += 1) {
    const waveInputs = spawnInputs.filter((input) => input.sessionIndex === wave);
    const results = await mapConcurrent(waveInputs, stageWidth, async (input) => {
      const startedAt = performance.now();
      const command = await client.sessions.spawn.mutate(input.command);
      return {
        workerName: input.worker.name,
        workerIndex: input.workerIndex,
        sessionIndex: input.sessionIndex,
        wave,
        title: input.title,
        marker: input.marker,
        prompt: input.prompt,
        latencyMs: elapsed(startedAt),
        command,
      };
    });
    spawnResults.push(...results);
    if (wave + 1 < sessionsPerWorker && stageDelayMs > 0) await delay(stageDelayMs);
  }
  await writeJson(paths.spawns, spawnResults);
  for (const result of spawnResults) {
    assert(result.command.state === "succeeded", `spawn failed for ${result.title}`);
    assert(typeof result.command.sessionId === "string", `spawn omitted session ID for ${result.title}`);
    assert(
      isObject(result.command.result) && typeof result.command.result.vendorSessionId === "string",
      `spawn omitted native ID for ${result.title}`,
    );
  }
  assertUnique(spawnResults.map((result) => result.command.commandId), "spawn command IDs");
  assertUnique(spawnResults.map((result) => result.command.sessionId), "logical session IDs");
  assertUnique(
    spawnResults.map(
      (result) => `${result.command.workerId}\0${result.command.result.vendorSessionId}`,
    ),
    "worker-scoped Copilot session IDs",
  );

  const sessionsActive = await waitFor(
    "100 canonical active Copilot sessions",
    timeoutMs,
    async () => {
      const sessions = await client.sessions.list.query();
      const selected = sessions.filter(
        (session) => session.metadata.values["scale.run_id"] === runId,
      );
      return selected.length === totalSessions &&
        selected.every(
          (session) =>
            session.availability === "active" &&
            session.runtimeStatus === "idle" &&
            session.runtimeEpoch !== null,
        )
        ? selected
        : undefined;
    },
  );
  await writeJson(paths.sessionsActive, sessionsActive);
  assertWorkerDistribution(sessionsActive, initialWorkers, sessionsPerWorker);

  const infoBySession = new Map();
  for (const result of spawnResults) {
    const session = sessionsActive.find(
      (candidate) => candidate.sessionId === result.command.sessionId,
    );
    assert(session, `canonical session ${result.command.sessionId} is missing after spawn`);
    assert(session.workerId === result.command.workerId, `${session.sessionId} moved workers`);
    infoBySession.set(session.sessionId, {
      ...result,
      session,
      vendorSessionId: result.command.result.vendorSessionId,
    });
  }
  assertSpawnMetadata(sessionsActive, infoBySession, runId, false);

  watcher = watchFleet(client.sessions.watch, {
    sessions: [...infoBySession.keys()],
    includeNative: true,
    maxPendingItems: 131_072,
    initialRetryDelayMs: 100,
    maxRetryDelayMs: 2_000,
    retryJitter: 0,
    onStateChange: (state) => {
      void appendNdjson(stateLog, {
        at: now(),
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
      if (item.nativeType === "session.error") {
        nativeSessionErrors.push({ receivedAt, ...item });
      }
      const key = `${item.sessionId}\0${item.runtimeEpoch}\0${item.sequence}`;
      if (deliveredKeys.has(key)) duplicateKeys.push(key);
      deliveredKeys.add(key);
      const events = nativeBySession.get(item.sessionId) ?? [];
      events.push({ receivedAt, ...item });
      nativeBySession.set(item.sessionId, events);
      const info = infoBySession.get(item.sessionId);
      if (
        burstActive &&
        burstDispatchComplete &&
        !disconnectRequestedAt &&
        info !== undefined &&
        item.nativeType === "assistant.message_delta"
      ) {
        disconnectRequestedAt = receivedAt;
        reconnectWorkerIndex = info.workerIndex;
        reconnectWorkerName = info.workerName;
        await writeJson(paths.disconnectRequest, {
          requestedAt: receivedAt,
          workerName: reconnectWorkerName,
          workerIndex: reconnectWorkerIndex,
          trigger: {
            sessionId: item.sessionId,
            runtimeEpoch: item.runtimeEpoch,
            sequence: item.sequence,
            nativeType: item.nativeType,
            allBurstSendAcknowledgementsReceived: true,
          },
        });
      }
    },
  });
  await waitFor("fleet subscription to become live", timeoutMs, async () =>
    watcher.state.state === "live" ? true : undefined,
  );
  await waitFor("all session.start events to replay", timeoutMs, async () =>
    [...infoBySession.keys()].every((sessionId) =>
      (nativeBySession.get(sessionId) ?? []).some(
        (event) => event.nativeType === "session.start",
      ),
    )
      ? true
      : undefined,
  );

  const metadataResults = [];
  for (let wave = 0; wave < sessionsPerWorker; wave += 1) {
    const waveInfos = [...infoBySession.values()].filter(
      (info) => info.sessionIndex === wave,
    );
    metadataResults.push(
      ...(await mapConcurrent(waveInfos, stageWidth, async (info) => {
        const result = await client.metadata.patch.mutate({
          operationId: newOperationId(),
          sessionId: info.session.sessionId,
          set: {
            "scale.client_verified": true,
            "scale.client_owner": "copilot-scale-driver",
          },
          ifKeyRevision: {
            "scale.client_verified": null,
            "scale.client_owner": null,
          },
        });
        return { sessionId: info.session.sessionId, result };
      })),
    );
  }
  await writeJson(paths.metadata, metadataResults);
  for (const entry of metadataResults) {
    assert(entry.result.accepted, `metadata patch conflicted for ${entry.sessionId}`);
    assert(
      entry.result.snapshot.values["scale.client_verified"] === true,
      `metadata did not converge for ${entry.sessionId}`,
    );
  }

  const sendResults = [];
  for (let wave = 0; wave < sessionsPerWorker; wave += 1) {
    const waveInfos = [...infoBySession.values()].filter(
      (info) => info.sessionIndex === wave,
    );
    const waveStartedAt = now();
    const results = await mapConcurrent(waveInfos, stageWidth, async (info) => {
      const current = await client.sessions.get.query(info.session.sessionId);
      assert(current, `session ${info.session.sessionId} vanished before send`);
      const command = sessionCommand(current, {
        harness: "copilot",
        command: { type: "send", prompt: info.prompt, mode: "enqueue" },
      });
      const startedAt = performance.now();
      const result = await client.sessions.execute.mutate(command);
      return {
        sessionId: info.session.sessionId,
        workerName: info.workerName,
        workerIndex: info.workerIndex,
        sessionIndex: info.sessionIndex,
        wave,
        waveStartedAt,
        marker: info.marker,
        prompt: info.prompt,
        latencyMs: elapsed(startedAt),
        command: result,
      };
    });
    sendResults.push(...results);
    for (const result of results) {
      assert(result.command.state === "succeeded", `send failed for ${result.sessionId}`);
    }
    if (wave + 1 < sessionsPerWorker && stageDelayMs > 0) await delay(stageDelayMs);
  }
  await writeJson(paths.sends, sendResults);
  assertUnique(sendResults.map((result) => result.command.commandId), "send command IDs");

  await waitFor("all 100 exact Copilot responses and terminal idle events", timeoutMs, async () => {
    throwIfNativeSessionError(nativeSessionErrors);
    for (const info of infoBySession.values()) {
      const events = nativeBySession.get(info.session.sessionId) ?? [];
      const final = events.find(
        (event) =>
          event.nativeType === "assistant.message" &&
          event.payload?.data?.content === info.marker,
      );
      if (!final) return undefined;
      if (
        !events.some(
          (event) => event.nativeType === "session.idle" && event.sequence > final.sequence,
        )
      ) {
        return undefined;
      }
    }
    return true;
  });

  assert(nativeGaps.length === 0, `received ${nativeGaps.length} unexpected native gaps`);
  assert(duplicateKeys.length === 0, `received ${duplicateKeys.length} duplicate native events`);
  assert(watcher.state.state !== "failed", "fleet watch entered the failed state");

  const streamAssertions = [];
  for (const send of sendResults) {
    const info = requiredMapValue(infoBySession, send.sessionId);
    streamAssertions.push({
      sessionId: send.sessionId,
      workerName: send.workerName,
      workerIndex: send.workerIndex,
      sessionIndex: send.sessionIndex,
      wave: send.wave,
      ...assertNativeTurn({
        events: nativeBySession.get(send.sessionId) ?? [],
        session: info.session,
        vendorSessionId: info.vendorSessionId,
        prompt: send.prompt,
        marker: send.marker,
        model,
      }),
    });
  }
  await writeJson(paths.streamAssertions, {
    passed: true,
    sessionCount: streamAssertions.length,
    nativeEventCount: totalNativeEvents,
    nativeGapCount: nativeGaps.length,
    duplicateDeliveryCount: duplicateKeys.length,
    stagedConcurrency: {
      waves: sessionsPerWorker,
      maximumOperationsPerWave: stageWidth,
      configuredDelayMs: stageDelayMs,
      fullFleetConcurrencyClaimed: false,
    },
    sessions: streamAssertions,
  });

  for (const info of infoBySession.values()) {
    info.burstMarker = burstMarkerFor(runId, info.workerIndex, info.sessionIndex);
    info.burstPrompt =
      `Reply with exactly ${info.burstMarker} and nothing else. Do not use Markdown.`;
  }
  const burstInputs = await mapConcurrent(
    [...infoBySession.values()],
    burstWidth,
    async (info) => {
      const session = await client.sessions.get.query(info.session.sessionId);
      assert(session, `session ${info.session.sessionId} vanished before the burst`);
      return { info, session };
    },
  );
  const burstDispatchedAt = now();
  let unresolvedExecuteMutations = 0;
  let observedMaximumUnresolvedExecuteMutations = 0;
  burstActive = true;
  const burstSendResults = await mapConcurrent(
    burstInputs,
    burstWidth,
    async ({ info, session }) => {
      const command = sessionCommand(session, {
        harness: "copilot",
        command: { type: "send", prompt: info.burstPrompt, mode: "enqueue" },
      });
      const dispatchedAt = now();
      const startedAt = performance.now();
      unresolvedExecuteMutations += 1;
      observedMaximumUnresolvedExecuteMutations = Math.max(
        observedMaximumUnresolvedExecuteMutations,
        unresolvedExecuteMutations,
      );
      let result;
      let settledAt;
      try {
        result = await client.sessions.execute.mutate(command);
      } finally {
        settledAt = now();
        unresolvedExecuteMutations -= 1;
      }
      return {
        sessionId: info.session.sessionId,
        workerName: info.workerName,
        workerIndex: info.workerIndex,
        sessionIndex: info.sessionIndex,
        marker: info.burstMarker,
        prompt: info.burstPrompt,
        dispatchedAt,
        settledAt,
        latencyMs: elapsed(startedAt),
        command: result,
      };
    },
  );
  assert(unresolvedExecuteMutations === 0, "burst execute mutation counter did not settle at zero");
  assert(
    observedMaximumUnresolvedExecuteMutations <= burstWidth,
    "burst exceeded its configured client RPC concurrency",
  );
  if (burstWidth === 100) {
    assert(
      observedMaximumUnresolvedExecuteMutations === 100,
      `only ${observedMaximumUnresolvedExecuteMutations}/100 execute mutations overlapped`,
    );
  }
  await writeJson(paths.burstSends, burstSendResults);
  for (const result of burstSendResults) {
    assert(result.command.state === "succeeded", `burst send failed for ${result.sessionId}`);
  }
  assertUnique(
    burstSendResults.map((result) => result.command.commandId),
    "burst send command IDs",
  );
  burstDispatchComplete = true;
  if (!disconnectRequestedAt) {
    const activeTarget = [...infoBySession.values()]
      .flatMap((info) => {
        const events = nativeBySession.get(info.session.sessionId) ?? [];
        const user = events.find(
          (event) =>
            event.nativeType === "user.message" &&
            event.payload?.data?.content === info.burstPrompt,
        );
        if (!user) return [];
        const turnEvents = events.filter((event) => event.sequence >= user.sequence);
        const idle = turnEvents.find((event) => event.nativeType === "session.idle");
        return idle ? [] : turnEvents.map((event) => ({ event, info }));
      })
      .sort(
        (left, right) =>
          Date.parse(right.event.receivedAt) - Date.parse(left.event.receivedAt),
      )[0];
    if (activeTarget) {
      disconnectRequestedAt = now();
      reconnectWorkerIndex = activeTarget.info.workerIndex;
      reconnectWorkerName = activeTarget.info.workerName;
      await writeJson(paths.disconnectRequest, {
        requestedAt: disconnectRequestedAt,
        workerName: reconnectWorkerName,
        workerIndex: reconnectWorkerIndex,
        trigger: {
          sessionId: activeTarget.event.sessionId,
          runtimeEpoch: activeTarget.event.runtimeEpoch,
          sequence: activeTarget.event.sequence,
          nativeType: activeTarget.event.nativeType,
          allBurstSendAcknowledgementsReceived: true,
        },
      });
    }
  }

  await waitFor("burst worker-disconnect request", timeoutMs, async () =>
    (await readJsonIfPresent(paths.disconnectRequest)) ?? undefined,
  );
  await waitFor("all 100 full-fleet burst responses", timeoutMs, async () => {
    throwIfNativeSessionError(nativeSessionErrors);
    for (const info of infoBySession.values()) {
      const events = nativeBySession.get(info.session.sessionId) ?? [];
      const final = events.find(
        (event) =>
          event.nativeType === "assistant.message" &&
          event.payload?.data?.content === info.burstMarker,
      );
      if (!final) return undefined;
      if (
        !events.some(
          (event) => event.nativeType === "session.idle" && event.sequence > final.sequence,
        )
      ) {
        return undefined;
      }
    }
    return true;
  });
  const disconnectProof = await waitFor(
    "worker network reconnect controller",
    timeoutMs,
    async () => (await readJsonIfPresent(paths.disconnectComplete)) ?? undefined,
  );
  burstActive = false;
  assert(disconnectRequestedAt, "worker disconnect was not requested during the burst");
  assert(
    Number.isSafeInteger(reconnectWorkerIndex) && reconnectWorkerIndex >= 0,
    "worker disconnect index was not selected",
  );
  assert(
    typeof reconnectWorkerName === "string" && reconnectWorkerName.length > 0,
    "worker disconnect name was not selected",
  );
  assert(disconnectProof.workerName === reconnectWorkerName, "wrong worker was disconnected");
  assert(disconnectProof.workerIndex === reconnectWorkerIndex, "wrong worker index was disconnected");
  assert(disconnectProof.containerStayedRunning === true, "isolated worker did not stay running");
  assert(disconnectProof.absentDuringDisconnect === true, "worker remained on the test network");
  assert(disconnectProof.presentAfterReconnect === true, "worker did not rejoin the test network");
  assert(nativeGaps.length === 0, `received ${nativeGaps.length} native gaps after reconnect`);
  assert(
    duplicateKeys.length === 0,
    `received ${duplicateKeys.length} application-visible duplicate native events`,
  );

  const burstAssertions = [];
  for (const send of burstSendResults) {
    const info = requiredMapValue(infoBySession, send.sessionId);
    burstAssertions.push({
      sessionId: send.sessionId,
      workerName: send.workerName,
      workerIndex: send.workerIndex,
      sessionIndex: send.sessionIndex,
      ...assertNativeTurn({
        events: nativeBySession.get(send.sessionId) ?? [],
        session: info.session,
        vendorSessionId: info.vendorSessionId,
        prompt: send.prompt,
        marker: send.marker,
        model,
      }),
    });
  }
  const disconnectedAtMs = Date.parse(disconnectProof.disconnectedAt);
  const reconnectedAtMs = Date.parse(disconnectProof.reconnectedAt);
  const targetBurstEvents = burstAssertions
    .filter((entry) => entry.workerIndex === reconnectWorkerIndex)
    .flatMap((entry) => {
      const info = requiredMapValue(infoBySession, entry.sessionId);
      const user = (nativeBySession.get(entry.sessionId) ?? []).find(
        (event) =>
          event.nativeType === "user.message" &&
          event.payload?.data?.content === info.burstPrompt,
      );
      return (nativeBySession.get(entry.sessionId) ?? []).filter(
        (event) => user && event.sequence >= user.sequence,
      );
    });
  assert(
    targetBurstEvents.some((event) => Date.parse(event.receivedAt) <= disconnectedAtMs),
    "no target-worker burst event was observed before network isolation",
  );
  assert(
    targetBurstEvents.some((event) => Date.parse(event.receivedAt) >= reconnectedAtMs),
    "no target-worker burst event was received after network reconnection",
  );
  await writeJson(paths.burstAssertions, {
    passed: true,
    dispatchedAt: burstDispatchedAt,
    sessionCount: burstAssertions.length,
    maximumConcurrentSendRequests: observedMaximumUnresolvedExecuteMutations,
    allOneHundredTurnsOverlappedClaimed: false,
    clientRpcConcurrency: {
      configuredMaximum: burstWidth,
      observedMaximumUnresolvedExecuteMutations,
      allOneHundredExecuteMutationsOverlapped:
        burstWidth === 100 && observedMaximumUnresolvedExecuteMutations === 100,
    },
    providerInferenceConcurrency: {
      measured: false,
      allOneHundredTurnsOverlappedClaimed: false,
    },
    nativeGapCount: nativeGaps.length,
    applicationDuplicateDeliveryCount: duplicateKeys.length,
    workerNetworkReconnect: {
      workerName: reconnectWorkerName,
      requestedAt: disconnectRequestedAt,
      disconnectedAt: disconnectProof.disconnectedAt,
      reconnectedAt: disconnectProof.reconnectedAt,
      targetEventsBeforeDisconnect: targetBurstEvents.filter(
        (event) => Date.parse(event.receivedAt) <= disconnectedAtMs,
      ).length,
      targetEventsAfterReconnect: targetBurstEvents.filter(
        (event) => Date.parse(event.receivedAt) >= reconnectedAtMs,
      ).length,
      applicationStreamRecoveredWithoutGapOrDuplicate: true,
    },
    sessions: burstAssertions,
  });

  const historyResults = await mapConcurrent(
    [...infoBySession.values()],
    stageWidth,
    async (info) => {
      const history = await readAllCopilotNativeHistory(
        client,
        info,
        nativeHistoryPageLimit,
      );
      return {
        sessionId: info.session.sessionId,
        workerName: info.workerName,
        workerIndex: info.workerIndex,
        sessionIndex: info.sessionIndex,
        ...history,
      };
    },
  );
  await writeJson(paths.history, historyResults);
  const historyAssertions = historyResults.map((entry) => {
    const info = requiredMapValue(infoBySession, entry.sessionId);
    return {
      sessionId: entry.sessionId,
      workerName: entry.workerName,
      pageCount: entry.pages.length,
      pageHarnessesValidated: true,
      nativeSessionIdentitiesValidated: true,
      arrayPayloadsValidated: true,
      cursorProgressionValidated: true,
      terminalCompletenessValidated: true,
      ...assertNativeHistory(entry.result, info, model),
    };
  });
  await writeJson(paths.historyAssertions, {
    passed: true,
    source: "CopilotSession.getEvents() through sessions.readNativeHistory",
    sessionCount: historyAssertions.length,
    pageLimit: nativeHistoryPageLimit,
    pageCount: historyAssertions.reduce((total, entry) => total + entry.pageCount, 0),
    sessions: historyAssertions,
  });

  const stabilitySamples = [];
  for (let sampleIndex = 0; sampleIndex < 3; sampleIndex += 1) {
    const [workers, sessions] = await Promise.all([
      client.workers.list.query(),
      client.sessions.list.query(),
    ]);
    const selectedWorkers = workers.filter((worker) => worker.name.startsWith(workerPrefix));
    const selectedSessions = sessions.filter(
      (session) => session.metadata.values["scale.run_id"] === runId,
    );
    const sample = {
      at: now(),
      workerCount: selectedWorkers.length,
      onlineWorkerCount: selectedWorkers.filter((worker) => worker.presence === "online").length,
      sessionCount: selectedSessions.length,
      activeSessionCount: selectedSessions.filter(
        (session) => session.availability === "active",
      ).length,
      idleSessionCount: selectedSessions.filter(
        (session) => session.runtimeStatus === "idle",
      ).length,
    };
    stabilitySamples.push(sample);
    assert(sample.workerCount === workerCount, "worker count changed during stability sampling");
    assert(sample.onlineWorkerCount === workerCount, "a worker was offline during stability sampling");
    assert(sample.sessionCount === totalSessions, "session count changed during stability sampling");
    assert(sample.activeSessionCount === totalSessions, "a session was not active during stability sampling");
    assert(sample.idleSessionCount === totalSessions, "a session was not idle during stability sampling");
    if (sampleIndex < 2) await delay(1_000);
  }
  await writeJson(paths.stability, stabilitySamples);

  await writeJson(paths.dashboardReady, {
    at: now(),
    workers: workerCount,
    activeIdleSessions: totalSessions,
    marker: burstMarkerFor(runId, 0, 0),
  });
  await waitFor("Playwright dashboard capture", timeoutMs, async () =>
    (await readJsonIfPresent(paths.dashboardCaptured)) ?? undefined,
  );

  const stopResults = [];
  for (let wave = 0; wave < sessionsPerWorker; wave += 1) {
    const waveInfos = [...infoBySession.values()].filter(
      (info) => info.sessionIndex === wave,
    );
    stopResults.push(
      ...(await mapConcurrent(waveInfos, stageWidth, async (info) => {
        const current = await client.sessions.get.query(info.session.sessionId);
        assert(current, `session ${info.session.sessionId} vanished before stop`);
        const result = await client.sessions.execute.mutate(
          sessionCommand(current, {
            harness: "copilot",
            command: { type: "stop" },
          }),
        );
        return { sessionId: info.session.sessionId, result };
      })),
    );
  }
  await writeJson(paths.stops, stopResults);
  for (const entry of stopResults) {
    assert(entry.result.state === "succeeded", `stop failed for ${entry.sessionId}`);
  }

  const refreshResults = await mapConcurrent(initialWorkers, workerCount, async (worker) => ({
    workerId: worker.workerId,
    workerName: worker.name,
    snapshot: await client.sessions.refresh.mutate({ workerId: worker.workerId }),
  }));
  await writeJson(paths.refresh, refreshResults);

  const stoppedSessions = await waitFor(
    "100 resumable/stopped Copilot sessions",
    timeoutMs,
    async () => {
      const sessions = await client.sessions.list.query();
      const selected = sessions.filter(
        (session) => session.metadata.values["scale.run_id"] === runId,
      );
      return selected.length === totalSessions &&
        selected.every(
          (session) =>
            session.availability === "resumable" &&
            session.runtimeStatus === "stopped" &&
            session.runtimeEpoch === null,
        )
        ? selected
        : undefined;
    },
  );
  await writeJson(paths.sessionsStopped, stoppedSessions);
  assertWorkerDistribution(stoppedSessions, initialWorkers, sessionsPerWorker);
  assertSpawnMetadata(stoppedSessions, infoBySession, runId, true);

  const finalWorkers = (await client.workers.list.query())
    .filter((worker) => worker.name.startsWith(workerPrefix))
    .sort((left, right) => left.name.localeCompare(right.name));
  await writeJson(paths.workersFinal, finalWorkers);
  assert(finalWorkers.length === workerCount, "final worker count is not exact");
  assert(finalWorkers.every((worker) => worker.presence === "online"), "a final worker is offline");

  const summary = {
    passed: true,
    runId,
    topology: { workers: workerCount, sessionsPerWorker, totalSessions },
    runtime: {
      harness: "copilot",
      model,
      reasoningEffort,
      oneSdkManagedRuntimePerWorker: true,
      separateRuntimeProcessPerSessionClaimed: false,
    },
    commands: {
      spawnSucceeded: spawnResults.length,
      sendSucceeded: sendResults.length,
      burstSendSucceeded: burstSendResults.length,
      stopSucceeded: stopResults.length,
      spawnLatencyMs: percentiles(spawnResults.map((result) => result.latencyMs)),
      sendAckLatencyMs: percentiles(sendResults.map((result) => result.latencyMs)),
      burstSendAckLatencyMs: percentiles(
        burstSendResults.map((result) => result.latencyMs),
      ),
    },
    streaming: {
      sessionsValidated: streamAssertions.length,
      exactDeltaReassemblies: streamAssertions.filter((entry) => entry.exactReassembly).length,
      exactFinalMessages: streamAssertions.filter((entry) => entry.exactFinalMessage).length,
      lifecycleOrderValidated: streamAssertions.filter((entry) => entry.lifecycleOrder).length,
      contiguousPerSessionSequences: streamAssertions.filter(
        (entry) => entry.contiguousSequence,
      ).length,
      nativeEvents: totalNativeEvents,
      nativeGaps: nativeGaps.length,
      applicationDuplicateDeliveries: duplicateKeys.length,
    },
    burst: {
      maximumConcurrentSendRequests: observedMaximumUnresolvedExecuteMutations,
      sessionsValidated: burstAssertions.length,
      exactDeltaReassemblies: burstAssertions.filter((entry) => entry.exactReassembly).length,
      exactFinalMessages: burstAssertions.filter((entry) => entry.exactFinalMessage).length,
      lifecycleOrderValidated: burstAssertions.filter((entry) => entry.lifecycleOrder).length,
      allOneHundredTurnsOverlappedClaimed: false,
      clientRpcConcurrency: {
        configuredMaximum: burstWidth,
        observedMaximumUnresolvedExecuteMutations,
        allOneHundredExecuteMutationsOverlapped:
          burstWidth === 100 && observedMaximumUnresolvedExecuteMutations === 100,
      },
      providerInferenceConcurrency: {
        measured: false,
        allOneHundredTurnsOverlappedClaimed: false,
      },
      workerNetworkIsolation: {
        workerName: reconnectWorkerName,
        containerStayedRunning: disconnectProof.containerStayedRunning,
        rejoinedNetwork: disconnectProof.presentAfterReconnect,
        applicationStreamRecoveredWithoutGapOrDuplicate: true,
      },
    },
    history: {
      source: "CopilotSession.getEvents()",
      sessionsValidated: historyAssertions.length,
      pagesValidated: historyAssertions.reduce((total, entry) => total + entry.pageCount, 0),
      newInferenceRequests: 0,
    },
    metadata: { spawnMetadataVerified: totalSessions, clientPatchesAccepted: metadataResults.length },
    scheduling: {
      spawnWaves: sessionsPerWorker,
      sendWaves: sessionsPerWorker,
      maximumOperationsPerWave: stageWidth,
      delayBetweenWavesMs: stageDelayMs,
      burstMaximumConcurrentSendRequests: burstWidth,
      oneHundredConcurrentSendRequestsAtDefaultBurstWidth: burstWidth === 100,
      allProviderTurnsOverlappedClaimed: false,
    },
    finalInventory: { resumableStoppedSessions: stoppedSessions.length },
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
  if (clientHandle.wsClient) await clientHandle.wsClient.close();
  else clientHandle.close();
  eventOutput.end();
  await once(eventOutput, "close").catch(() => undefined);
  await stateLog.close().catch(() => undefined);
}

function isReadyCopilotWorker(worker) {
  return (
    worker.presence === "online" &&
    worker.protocolVersion === 2 &&
    worker.harnesses.some(
      (entry) => entry.harness === "copilot" && entry.available === true,
    )
  );
}

function assertNativeTurn({ events, session, vendorSessionId, prompt, marker, model }) {
  assert(events.length > 0, `${session.sessionId} has no native events`);
  assert(
    events.every((event) => event.harness === "copilot"),
    `${session.sessionId} emitted a non-Copilot event`,
  );
  assert(
    events.every((event) => event.runtimeEpoch === session.runtimeEpoch),
    `${session.sessionId} changed runtime epoch`,
  );
  const sequences = events.map((event) => event.sequence);
  assert(sequences[0] === 0, `${session.sessionId} native sequence does not start at zero`);
  assertDeepEqual(
    sequences,
    Array.from({ length: sequences.length }, (_, index) => index),
    `${session.sessionId} native sequence`,
  );

  const starts = events.filter((event) => event.nativeType === "session.start");
  assert(starts.length === 1, `${session.sessionId} has ${starts.length} session.start events`);
  assert(starts[0].payload?.data?.sessionId === vendorSessionId, `${session.sessionId} has wrong native session ID`);
  assert(starts[0].payload?.data?.selectedModel === model, `${session.sessionId} started with the wrong model`);

  const userMessages = events.filter(
    (event) => event.nativeType === "user.message" && event.payload?.data?.content === prompt,
  );
  assert(userMessages.length === 1, `${session.sessionId} does not have one exact user message`);
  const user = userMessages[0];
  const afterUser = events.filter((event) => event.sequence > user.sequence);
  assert(
    !afterUser.some((event) => event.nativeType === "session.error"),
    `${session.sessionId} emitted session.error`,
  );
  assert(
    !afterUser.some((event) => event.nativeType.startsWith("tool.")),
    `${session.sessionId} invoked a tool despite the empty tool set`,
  );

  const turnStarts = rootEvents(afterUser, "assistant.turn_start");
  const finals = rootEvents(afterUser, "assistant.message").filter(
    (event) => event.payload?.data?.content === marker,
  );
  const turnEnds = rootEvents(afterUser, "assistant.turn_end");
  assert(turnStarts.length === 1, `${session.sessionId} has ${turnStarts.length} root turn starts`);
  assert(finals.length === 1, `${session.sessionId} has ${finals.length} exact final messages`);
  assert(turnEnds.length === 1, `${session.sessionId} has ${turnEnds.length} root turn ends`);
  const turnStart = turnStarts[0];
  const final = finals[0];
  const turnEnd = turnEnds[0];
  const turnId = turnStart.payload?.data?.turnId;
  const messageId = final.payload?.data?.messageId;
  assert(typeof turnId === "string" && turnId.length > 0, `${session.sessionId} turn ID is missing`);
  assert(typeof messageId === "string" && messageId.length > 0, `${session.sessionId} message ID is missing`);
  assert(final.payload?.data?.turnId === turnId, `${session.sessionId} final message turn ID differs`);
  assert(turnEnd.payload?.data?.turnId === turnId, `${session.sessionId} turn end ID differs`);
  assert(final.payload?.data?.model === model, `${session.sessionId} final message used the wrong model`);

  const messageStarts = rootEvents(afterUser, "assistant.message_start").filter(
    (event) => event.payload?.data?.messageId === messageId,
  );
  const deltas = rootEvents(afterUser, "assistant.message_delta").filter(
    (event) => event.payload?.data?.messageId === messageId,
  );
  assert(messageStarts.length === 1, `${session.sessionId} does not have one message start`);
  assert(deltas.length >= 1, `${session.sessionId} did not stream an assistant delta`);
  assert(
    deltas.every(
      (event) =>
        event.ephemeral === true && typeof event.payload?.data?.deltaContent === "string",
    ),
    `${session.sessionId} has malformed assistant deltas`,
  );
  const reassembled = deltas.map((event) => event.payload.data.deltaContent).join("");
  assert(reassembled === marker, `${session.sessionId} delta reconstruction is not exact`);

  const idles = afterUser.filter((event) => event.nativeType === "session.idle");
  assert(idles.length === 1, `${session.sessionId} has ${idles.length} terminal idle events`);
  const idle = idles[0];
  assert(idle.payload?.data?.aborted !== true, `${session.sessionId} ended aborted`);
  const lifecycleSequence = [
    user.sequence,
    turnStart.sequence,
    messageStarts[0].sequence,
    deltas[0].sequence,
    deltas.at(-1).sequence,
    final.sequence,
    turnEnd.sequence,
    idle.sequence,
  ];
  assert(
    lifecycleSequence.every((value, index) => index === 0 || value > lifecycleSequence[index - 1]),
    `${session.sessionId} lifecycle is out of order`,
  );

  return {
    eventCount: events.length,
    runtimeEpoch: session.runtimeEpoch,
    turnId,
    messageId,
    deltaCount: deltas.length,
    outputBytes: Buffer.byteLength(reassembled, "utf8"),
    exactReassembly: true,
    exactFinalMessage: true,
    lifecycleOrder: true,
    contiguousSequence: true,
    startedAt: turnStart.receivedAt,
    completedAt: idle.receivedAt,
    durationMs: Math.max(0, Date.parse(idle.receivedAt) - Date.parse(turnStart.receivedAt)),
  };
}

function assertNativeHistory(result, info, expectedModel) {
  assert(result.harness === "copilot", `${info.session.sessionId} history has wrong harness`);
  assert(
    result.vendorSessionId === info.vendorSessionId,
    `${info.session.sessionId} history has wrong native session ID`,
  );
  assert(result.complete === true, `${info.session.sessionId} history was not complete`);
  assert(Array.isArray(result.payload), `${info.session.sessionId} history payload is not an array`);
  const events = result.payload;
  const start = events.find((event) => event?.type === "session.start");
  const user = events.find(
    (event) => event?.type === "user.message" && event?.data?.content === info.prompt,
  );
  const final = events.find(
    (event) => event?.type === "assistant.message" && event?.data?.content === info.marker,
  );
  const turnStart = events.find(
    (event) => event?.type === "assistant.turn_start" && event?.data?.turnId === final?.data?.turnId,
  );
  const turnEnd = events.find(
    (event) => event?.type === "assistant.turn_end" && event?.data?.turnId === final?.data?.turnId,
  );
  const burstUser = events.find(
    (event) => event?.type === "user.message" && event?.data?.content === info.burstPrompt,
  );
  const burstFinal = events.find(
    (event) => event?.type === "assistant.message" && event?.data?.content === info.burstMarker,
  );
  const burstTurnStart = events.find(
    (event) =>
      event?.type === "assistant.turn_start" &&
      event?.data?.turnId === burstFinal?.data?.turnId,
  );
  const burstTurnEnd = events.find(
    (event) =>
      event?.type === "assistant.turn_end" &&
      event?.data?.turnId === burstFinal?.data?.turnId,
  );
  assert(start?.data?.sessionId === info.vendorSessionId, `${info.session.sessionId} history start is missing`);
  assert(start?.data?.selectedModel === expectedModel, `${info.session.sessionId} history model differs`);
  assert(user, `${info.session.sessionId} exact history user message is missing`);
  assert(final, `${info.session.sessionId} exact history assistant message is missing`);
  assert(final.data.model === expectedModel, `${info.session.sessionId} history final model differs`);
  assert(turnStart && turnEnd, `${info.session.sessionId} history turn lifecycle is incomplete`);
  assert(burstUser, `${info.session.sessionId} exact burst history user message is missing`);
  assert(burstFinal, `${info.session.sessionId} exact burst history assistant message is missing`);
  assert(
    burstFinal.data.model === expectedModel,
    `${info.session.sessionId} burst history final model differs`,
  );
  assert(
    burstTurnStart && burstTurnEnd,
    `${info.session.sessionId} burst history turn lifecycle is incomplete`,
  );
  return {
    eventCount: events.length,
    exactBaselineUserMessage: true,
    exactBaselineAssistantMessage: true,
    matchingBaselineTurnLifecycle: true,
    exactBurstUserMessage: true,
    exactBurstAssistantMessage: true,
    matchingBurstTurnLifecycle: true,
  };
}

async function readAllCopilotNativeHistory(client, info, limit) {
  const pages = [];
  const seenCursors = new Set();
  let cursor;

  for (;;) {
    const request = {
      harness: "copilot",
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    };
    const result = await client.sessions.readNativeHistory.query({
      sessionId: info.session.sessionId,
      request,
    });
    const pageDescription = `${info.session.sessionId} history page ${pages.length}`;
    assert(result.harness === "copilot", `${pageDescription} has wrong harness`);
    assert(
      result.vendorSessionId === info.vendorSessionId,
      `${pageDescription} has wrong native session ID`,
    );
    assert(Array.isArray(result.payload), `${pageDescription} payload is not an array`);
    assert(
      typeof result.complete === "boolean",
      `${pageDescription} does not declare completeness`,
    );
    pages.push({
      pageIndex: pages.length,
      request,
      result,
    });

    if (result.complete) {
      assert(
        result.nextCursor === undefined,
        `${pageDescription} is terminal but includes a next cursor`,
      );
      break;
    }

    const nextCursor = result.nextCursor;
    assert(
      typeof nextCursor === "string" && nextCursor.length > 0,
      `${pageDescription} is incomplete but has no next cursor`,
    );
    assert(nextCursor !== cursor, `${pageDescription} did not advance its cursor`);
    assert(!seenCursors.has(nextCursor), `${pageDescription} repeated cursor ${nextCursor}`);
    seenCursors.add(nextCursor);
    cursor = nextCursor;
    assert(pages.length < 10_000, `${info.session.sessionId} history exceeded 10,000 pages`);
  }

  const terminal = pages.at(-1)?.result;
  assert(terminal?.complete === true, `${info.session.sessionId} history did not terminate`);
  return {
    pages,
    result: {
      harness: terminal.harness,
      vendorSessionId: terminal.vendorSessionId,
      payload: pages.flatMap((page) => page.result.payload),
      complete: true,
    },
  };
}

function rootEvents(events, type) {
  return events.filter(
    (event) => event.nativeType === type && event.payload?.agentId === undefined,
  );
}

function assertWorkerDistribution(sessions, workers, expectedPerWorker) {
  for (const worker of workers) {
    const count = sessions.filter((session) => session.workerId === worker.workerId).length;
    assert(count === expectedPerWorker, `${worker.name} owns ${count} sessions, expected ${expectedPerWorker}`);
  }
}

function assertSpawnMetadata(sessions, infoBySession, expectedRunId, expectClientMetadata) {
  for (const session of sessions) {
    const info = requiredMapValue(infoBySession, session.sessionId);
    assert(session.metadata.values["agent.title"] === info.title, `${session.sessionId} lost agent.title`);
    assert(session.metadata.values["scale.run_id"] === expectedRunId, `${session.sessionId} lost scale.run_id`);
    assert(session.metadata.values["scale.worker_index"] === info.workerIndex, `${session.sessionId} has wrong worker metadata`);
    assert(session.metadata.values["scale.session_index"] === info.sessionIndex, `${session.sessionId} has wrong session metadata`);
    assert(session.metadata.values["scale.harness"] === "copilot", `${session.sessionId} lost harness metadata`);
    if (expectClientMetadata) {
      assert(session.metadata.values["scale.client_verified"] === true, `${session.sessionId} lost client metadata`);
      assert(
        session.metadata.values["scale.client_owner"] === "copilot-scale-driver",
        `${session.sessionId} lost client metadata owner`,
      );
    }
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
      if (error && typeof error === "object" && error.fatalWait === true) throw error;
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `timed out waiting for ${description}` +
      (lastError instanceof Error ? `; last error: ${lastError.message}` : ""),
  );
}

function throwIfNativeSessionError(errors) {
  if (errors.length === 0) return;
  const latest = errors.at(-1);
  const error = new Error(
    `Copilot emitted session.error for ${latest.sessionId}; inspect the sanitized worker log`,
  );
  error.fatalWait = true;
  throw error;
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
  const directory = dirname(filename);
  await mkdir(directory, { recursive: true });
  const temporaryFilename = join(
    directory,
    `.${basename(filename)}.${process.pid}.${Date.now()}.${atomicWriteSequence++}.tmp`,
  );
  try {
    await writeFile(temporaryFilename, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryFilename, filename);
  } catch (error) {
    await unlink(temporaryFilename).catch(() => undefined);
    throw error;
  }
}

async function readJsonIfPresent(filename) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function requiredMapValue(map, key) {
  const value = map.get(key);
  assert(value !== undefined, `missing map entry ${String(key)}`);
  return value;
}

function assertUnique(values, description) {
  const unique = new Set(values);
  assert(unique.size === values.length, `${description} are not unique (${unique.size}/${values.length})`);
}

function assertDeepEqual(actual, expected, description) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${description} differs: actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)}`,
  );
}

function markerFor(value, workerIndex, sessionIndex) {
  const normalized = value.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  return `AMX_${normalized}_W${twoDigits(workerIndex)}_S${twoDigits(sessionIndex)}`;
}

function burstMarkerFor(value, workerIndex, sessionIndex) {
  // Keep this long enough to produce a real streamed response, but avoid a
  // highly repetitive 500-byte copy task: under a 100-way provider burst some
  // models legitimately compress or truncate repeated text despite an exact
  // reply instruction, which tests imitation rather than fleet transport.
  return `${markerFor(value, workerIndex, sessionIndex)}_BURST_ALPHA_BRAVO_CHARLIE_END`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonnegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
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
