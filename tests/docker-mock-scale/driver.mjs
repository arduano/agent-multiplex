#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";

import {
  createAccessClient,
  launchRequest,
  sessionCommand,
  watchAccess,
} from "@arduano/agent-multiplex-client";
import { newOperationId } from "@arduano/agent-multiplex-protocol";
import { WebSocket as NodeWebSocket } from "ws";

const argv = process.argv.slice(2);
if (argv.length !== 9) {
  throw new Error(
    "usage: driver.mjs <http-trpc-url> <receipt-dir> <run-id> <runtimeNode-prefix> " +
      "<runtimeNode-count> <sessions-per-runtimeNode> <chunk-count> <timeout-ms> <soak-ms>",
  );
}

const [
  httpUrl,
  rawReceiptDirectory,
  runId,
  runtimeNodePrefix,
  rawRuntimeNodeCount,
  rawSessionsPerRuntimeNode,
  rawChunkCount,
  rawTimeoutMs,
  rawSoakMs,
] = argv;
const receiptDirectory = resolve(rawReceiptDirectory);
const runtimeNodeCount = positiveInteger(rawRuntimeNodeCount, "runtimeNode-count");
const sessionsPerRuntimeNode = positiveInteger(
  rawSessionsPerRuntimeNode,
  "sessions-per-runtimeNode",
);
const chunkCount = positiveInteger(rawChunkCount, "chunk-count");
const timeoutMs = positiveInteger(rawTimeoutMs, "timeout-ms");
const soakMs = positiveInteger(rawSoakMs, "soak-ms");
const totalSessions = runtimeNodeCount * sessionsPerRuntimeNode;
const wsUrl = httpUrl.replace(/^http/, "ws");
const bearerTokenFile = process.env.AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE;
if (!bearerTokenFile) {
  throw new Error("AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE is required");
}
const bearerToken = (await readFile(bearerTokenFile, "utf8")).trim();
if (!bearerToken || /\s/.test(bearerToken)) {
  throw new Error("acceptance bearer token file is empty or contains whitespace");
}

const paths = {
  events: join(receiptDirectory, "logs/fleet-events.ndjson"),
  states: join(receiptDirectory, "logs/client-states.ndjson"),
  metadataRounds: join(receiptDirectory, "logs/metadata-rounds.ndjson"),
  system: join(receiptDirectory, "rpc/system-description.json"),
  sourcesInitial: join(receiptDirectory, "rpc/sources-initial.json"),
  controlNodesInitial: join(receiptDirectory, "rpc/control-nodes-initial.json"),
  runtimeNodesInitial: join(receiptDirectory, "rpc/runtimeNodes-initial.json"),
  runtimeNodesFinal: join(receiptDirectory, "rpc/runtimeNodes-final.json"),
  models: join(receiptDirectory, "rpc/models.json"),
  spawns: join(receiptDirectory, "rpc/spawn-results.json"),
  metadataInitial: join(receiptDirectory, "rpc/metadata-initial.json"),
  metadataConflict: join(receiptDirectory, "rpc/metadata-conflict.json"),
  sends: join(receiptDirectory, "rpc/send-results.json"),
  sessionsBefore: join(receiptDirectory, "rpc/sessions-before-stream.json"),
  sessionsFinal: join(receiptDirectory, "rpc/sessions-final.json"),
  streamAssertions: join(receiptDirectory, "phases/stream-assertions.json"),
  stability: join(receiptDirectory, "phases/stability-samples.json"),
  disconnectRequest: join(receiptDirectory, "coord/disconnect-request.json"),
  disconnectComplete: join(receiptDirectory, "coord/disconnect-complete.json"),
  streamStarted: join(receiptDirectory, "coord/stream-started.json"),
  failure: join(receiptDirectory, "driver-failure.json"),
};

await Promise.all(
  ["logs", "rpc", "phases", "coord"].map((directory) =>
    mkdir(join(receiptDirectory, directory), { recursive: true }),
  ),
);

const stateLog = await open(paths.states, "w");
const metadataLog = await open(paths.metadataRounds, "w");
const eventOutput = createWriteStream(paths.events, {
  flags: "w",
  encoding: "utf8",
});

let websocketOpenCount = 0;
let websocketCloseCount = 0;
let forcedWebsocketReconnectAt;
const trackedSockets = [];

class TrackedWebSocket extends NodeWebSocket {
  constructor(...args) {
    super(...args);
    trackedSockets.push(this);
  }
}

const clientHandle = createAccessClient({
  httpUrl,
  wsUrl,
  bearerToken,
  WebSocket: TrackedWebSocket,
  onWebSocketOpen: () => {
    websocketOpenCount += 1;
    void appendNdjson(stateLog, {
      at: now(),
      source: "websocket",
      state: "open",
      count: websocketOpenCount,
    }).catch(() => undefined);
  },
  onWebSocketClose: (cause) => {
    websocketCloseCount += 1;
    void appendNdjson(stateLog, {
      at: now(),
      source: "websocket",
      state: "closed",
      count: websocketCloseCount,
      cause: cause ?? null,
    }).catch(() => undefined);
  },
});
const client = clientHandle.client;

let watcher;
try {
  const system = await waitFor(
    "the authenticated protocol-v4 gateway access surface",
    timeoutMs,
    async () => {
      const description = await client.system.describe.query();
      return description.protocolVersion === 5 &&
        description.componentKind === "access-gateway" &&
        description.dataAuthority === "none"
        ? description
        : undefined;
    },
  );
  await writeJson(paths.system, system);

  const sourceState = await waitFor(
    "the gateway to select its canonical control-node source",
    timeoutMs,
    async () => {
      const sources = await client.sources.list.query();
      return sources.length === 1 &&
        sources[0].sourceId === "canonical" &&
        sources[0].state === "selected" &&
        sources[0].manifest?.protocolVersion === 5 &&
        sources[0].manifest.coveredControlNodeIds.length === 1
        ? sources
        : undefined;
    },
  );
  await writeJson(paths.sourcesInitial, sourceState);

  const controlNodes = await waitFor(
    "the canonical authority control node",
    timeoutMs,
    async () => {
      const values = await client.controlNodes.list.query();
      return values.length === 1 &&
        values[0].name === "scale-authority" &&
        values[0].presence === "online" &&
        values[0].dataRole.role === "authority" &&
        values[0].protocolVersion === 5
        ? values
        : undefined;
    },
  );
  await writeJson(paths.controlNodesInitial, controlNodes);

  const initialRuntimeNodes = await waitFor(
    "all mock runtimeNodes to register",
    timeoutMs,
    async () => {
      const runtimeNodes = await client.runtimeNodes.list.query();
      const selected = runtimeNodes.filter((runtimeNode) => runtimeNode.name.startsWith(runtimeNodePrefix));
      return selected.length === runtimeNodeCount && selected.every(isReadyMockRuntimeNode)
        ? selected.sort((left, right) => left.name.localeCompare(right.name))
        : undefined;
    },
  );
  await writeJson(paths.runtimeNodesInitial, initialRuntimeNodes);

  const runtimeNodesByName = new Map(initialRuntimeNodes.map((runtimeNode) => [runtimeNode.name, runtimeNode]));
  const expectedRuntimeNodeNames = Array.from(
    { length: runtimeNodeCount },
    (_, index) => `${runtimeNodePrefix}-${twoDigits(index)}`,
  );
  assertDeepEqual(
    initialRuntimeNodes.map((runtimeNode) => runtimeNode.name),
    expectedRuntimeNodeNames,
    "registered runtimeNode names",
  );

  const modelResults = await mapConcurrent(
    initialRuntimeNodes,
    runtimeNodeCount,
    async (runtimeNode) => {
      const profile = await selectDirectWorkspaceProfile(
        client,
        runtimeNode.runtimeNodeId,
        "codex",
      );
      return {
        runtimeNodeId: runtimeNode.runtimeNodeId,
        runtimeNodeName: runtimeNode.name,
        profile,
        models: await client.launchProfiles.models.query({
          runtimeNodeId: runtimeNode.runtimeNodeId,
          profile: launchProfileIdentity(profile),
          harness: "codex",
        }),
      };
    },
  );
  for (const result of modelResults) {
    assert(
      result.models.some((model) => model.harness === "codex" && model.id === "mock-model"),
      `${result.runtimeNodeName} did not advertise codex/mock-model`,
    );
  }
  await writeJson(paths.models, modelResults);
  const profilesByRuntimeNode = new Map(
    modelResults.map((result) => [result.runtimeNodeId, result.profile]),
  );

  const spawnInputs = expectedRuntimeNodeNames.flatMap((runtimeNodeName, runtimeNodeIndex) =>
    Array.from({ length: sessionsPerRuntimeNode }, (_, sessionIndex) => {
      const runtimeNode = requiredMapValue(runtimeNodesByName, runtimeNodeName);
      const profile = requiredMapValue(profilesByRuntimeNode, runtimeNode.runtimeNodeId);
      const title = `Mock scale ${twoDigits(runtimeNodeIndex)}/${twoDigits(sessionIndex)} ${runId}`;
      const request = launchRequest(
        runtimeNode.runtimeNodeId,
        launchProfileIdentity(profile),
        "codex",
        {
          cwd: "/workspace",
          model: "mock-model",
          approvalPolicy: "never",
          sandbox: "read-only",
        },
        {
          "agent.title": title,
          "scale.run_id": runId,
          "scale.runtime_node_index": runtimeNodeIndex,
          "scale.session_index": sessionIndex,
          "scale.source": "spawn",
        },
      );
      return { runtimeNode, runtimeNodeIndex, sessionIndex, title, request };
    }),
  );

  const spawnResults = await mapConcurrent(spawnInputs, 32, async (input) => {
    const startedAt = performance.now();
    const accepted = await client.launches.create.mutate(input.request);
    const launch = await waitForLaunch(client, accepted, timeoutMs);
    return {
      runtimeNodeName: input.runtimeNode.name,
      runtimeNodeIndex: input.runtimeNodeIndex,
      sessionIndex: input.sessionIndex,
      title: input.title,
      latencyMs: elapsed(startedAt),
      accepted,
      launch,
    };
  });
  await writeJson(paths.spawns, spawnResults);
  for (const result of spawnResults) {
    assert(result.launch.state === "succeeded", `launch failed for ${result.title}`);
    assert(typeof result.launch.sessionId === "string", `launch omitted session ID for ${result.title}`);
    assert(
      isObject(result.launch.result) &&
        typeof result.launch.result.vendorSessionId === "string",
      `launch omitted native ID for ${result.title}`,
    );
  }
  assertUnique(
    spawnResults.map((result) => result.launch.launchId),
    "launch IDs",
  );
  assertUnique(
    spawnResults.map((result) => result.launch.sessionId),
    "logical session IDs",
  );
  assertUnique(
    spawnResults.map(
      (result) => `${result.launch.runtimeNodeId}\0${result.launch.result.vendorSessionId}`,
    ),
    "runtimeNode-scoped mock native session IDs",
  );

  const sessionsBefore = await waitFor(
    "100 canonical active mock sessions",
    timeoutMs,
    async () => {
      const sessions = await client.sessions.search.query({
        states: ["running", "stopped"],
        metadata: [{ operator: "equals", key: "scale.run_id", value: runId }],
        limit: 500,
      });
      const selected = sessions.sessions;
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
  await writeJson(paths.sessionsBefore, sessionsBefore);

  const sessionInfo = new Map();
  for (const result of spawnResults) {
    const sessionId = result.launch.sessionId;
    const session = sessionsBefore.find((candidate) => candidate.sessionId === sessionId);
    assert(session, `canonical session ${sessionId} is missing after spawn`);
    assert(session.runtimeNodeId === result.launch.runtimeNodeId, `${sessionId} moved to another runtimeNode`);
    sessionInfo.set(sessionId, {
      ...result,
      session,
      vendorSessionId: result.launch.result.vendorSessionId,
      prompt:
        `scale/${runId}/${twoDigits(result.runtimeNodeIndex)}/${twoDigits(result.sessionIndex)}`,
    });
  }
  assertRuntimeNodeDistribution(sessionsBefore, initialRuntimeNodes, sessionsPerRuntimeNode);
  assertSpawnMetadata(sessionsBefore, sessionInfo, runId);

  const nativeBySession = new Map();
  const nativeGaps = [];
  const deliveredKeys = new Set();
  const duplicateKeys = [];
  const completions = new Set();
  const startedSessions = new Set();
  let totalNativeEvents = 0;
  const deltaCountByRuntimeNode = new Map(
    Array.from({ length: runtimeNodeCount }, (_, index) => [index, 0]),
  );
  let disconnectRequestedAt;
  let reconnectRuntimeNodeIndex;
  let reconnectRuntimeNodeName;

  watcher = watchAccess(client.sessions.watch, {
    sessions: [...sessionInfo.keys()],
    includeNative: true,
    maxPendingItems: 16_384,
    initialRetryDelayMs: 50,
    maxRetryDelayMs: 1_000,
    retryJitter: 0,
    onStateChange: (state) => {
      void appendNdjson(stateLog, {
        at: now(),
        source: "watchAccess",
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
      if (item.nativeType === "turn/started") startedSessions.add(item.sessionId);
      if (item.nativeType === "turn/completed") completions.add(item.sessionId);

      const info = sessionInfo.get(item.sessionId);
      if (info && item.nativeType === "item/agentMessage/delta") {
        deltaCountByRuntimeNode.set(
          info.runtimeNodeIndex,
          (deltaCountByRuntimeNode.get(info.runtimeNodeIndex) ?? 0) + 1,
        );
      }

      // Pick the least-progressed runtime only once every turn has started.
      // A fixed runtime can already have completed its entire delta tail while
      // waiting for the final container's starts, which makes a later network
      // isolation prove nothing about replay.
      if (
        reconnectRuntimeNodeIndex === undefined &&
        startedSessions.size === totalSessions
      ) {
        reconnectRuntimeNodeIndex = [...deltaCountByRuntimeNode.entries()]
          .sort((left, right) => left[1] - right[1] || left[0] - right[0])[0][0];
        reconnectRuntimeNodeName = expectedRuntimeNodeNames[reconnectRuntimeNodeIndex];
      }

      // Faults begin only after all 100 turn/start events crossed the fan-in.
      // That gives us a defensible concurrency assertion and still leaves the
      // configured delta tail in flight to exercise both replay paths.
      if (
        !disconnectRequestedAt &&
        reconnectRuntimeNodeIndex !== undefined &&
        info?.runtimeNodeIndex === reconnectRuntimeNodeIndex &&
        item.nativeType === "item/agentMessage/delta" &&
        (deltaCountByRuntimeNode.get(reconnectRuntimeNodeIndex) ?? 0) >= 3
      ) {
        disconnectRequestedAt = receivedAt;
        await writeJson(paths.disconnectRequest, {
          requestedAt: receivedAt,
          runtimeNodeName: reconnectRuntimeNodeName,
          runtimeNodeIndex: reconnectRuntimeNodeIndex,
          trigger: {
            sessionId: item.sessionId,
            runtimeEpoch: item.runtimeEpoch,
            sequence: item.sequence,
            nativeType: item.nativeType,
            allSessionStartsObserved: startedSessions.size,
            targetRuntimeNodeDeltasObserved:
              deltaCountByRuntimeNode.get(reconnectRuntimeNodeIndex) ?? 0,
          },
        });
      }

      if (!forcedWebsocketReconnectAt && startedSessions.size === totalSessions) {
        const socket = [...trackedSockets]
          .reverse()
          .find((candidate) => candidate.readyState === NodeWebSocket.OPEN);
        assert(socket, "no open WebSocket was available for the forced reconnect");
        forcedWebsocketReconnectAt = receivedAt;
        socket.terminate();
      }
    },
  });
  await waitFor("fleet subscription to become live", timeoutMs, async () =>
    watcher.state.state === "live" ? true : undefined,
  );

  const metadataInitial = await mapConcurrent(
    [...sessionInfo.values()],
    32,
    async (info) => {
      const result = await client.metadata.patch.mutate({
        operationId: newOperationId(),
        sessionId: info.session.sessionId,
        expectedAuthority: info.session.metadataAuthority,
        set: {
          "scale.client_round": 1,
          "scale.client_owner": "scale-driver",
        },
        ifKeyRevision: {
          "scale.client_round": null,
          "scale.client_owner": null,
        },
      });
      return { sessionId: info.session.sessionId, result };
    },
  );
  await writeJson(paths.metadataInitial, metadataInitial);
  for (const entry of metadataInitial) {
    assert(entry.result.status === "accepted", `initial client metadata patch did not commit for ${entry.sessionId}`);
    assert(
      entry.result.canonical.values["scale.client_round"] === 1,
      `initial metadata value was lost for ${entry.sessionId}`,
    );
  }

  const firstSessionId = [...sessionInfo.keys()][0];
  const firstSession = requiredMapValue(sessionInfo, firstSessionId).session;
  const metadataConflict = await client.metadata.patch.mutate({
    operationId: newOperationId(),
    sessionId: firstSessionId,
    expectedAuthority: firstSession.metadataAuthority,
    set: { "scale.client_round": 999 },
    ifKeyRevision: { "scale.client_round": null },
  });
  await writeJson(paths.metadataConflict, metadataConflict);
  assert(metadataConflict.status === "conflicted", "stale metadata CAS unexpectedly succeeded");
  assert(
    metadataConflict.canonical.values["scale.client_round"] === 1,
    "rejected metadata CAS mutated the canonical value",
  );

  await writeJson(paths.streamStarted, {
    at: now(),
    sessionCount: totalSessions,
    expectedNativeEventsPerSession: chunkCount + 4,
  });
  const sendResults = await mapConcurrent(
    [...sessionInfo.values()],
    totalSessions,
    async (info) => {
      const current = await client.sessions.get.query(info.session.sessionId);
      assert(current, `session ${info.session.sessionId} vanished before send`);
      const command = sessionCommand(current, {
        harness: "codex",
        command: { type: "send", input: info.prompt },
      });
      const startedAt = performance.now();
      const result = await client.sessions.execute.mutate(command);
      return {
        sessionId: info.session.sessionId,
        runtimeNodeName: info.runtimeNodeName,
        runtimeNodeIndex: info.runtimeNodeIndex,
        sessionIndex: info.sessionIndex,
        prompt: info.prompt,
        expectedText: mockExpectedText(
          info.vendorSessionId,
          1,
          info.prompt,
          chunkCount,
        ),
        latencyMs: elapsed(startedAt),
        command: result,
      };
    },
  );
  await writeJson(paths.sends, sendResults);
  for (const result of sendResults) {
    assert(result.command.state === "succeeded", `send failed for ${result.sessionId}`);
  }
  assertUnique(sendResults.map((result) => result.command.commandId), "send command IDs");

  await waitFor("all native turns to complete", timeoutMs, async () =>
    completions.size === totalSessions ? true : undefined,
  );
  await waitFor("runtimeNode network reconnect controller", timeoutMs, async () =>
    (await readJsonIfPresent(paths.disconnectComplete)) ?? undefined,
  );
  await waitFor("client WebSocket to reconnect", timeoutMs, async () =>
    websocketOpenCount >= 2 ? true : undefined,
  );

  assert(disconnectRequestedAt, "runtimeNode disconnect was never requested by a native delta");
  assert(reconnectRuntimeNodeIndex !== undefined, "runtimeNode reconnect target was never selected");
  assert(reconnectRuntimeNodeName !== undefined, "runtimeNode reconnect target name was never selected");
  assert(forcedWebsocketReconnectAt, "client WebSocket reconnect was never forced");
  assert(nativeGaps.length === 0, `received ${nativeGaps.length} unexpected native gaps`);
  assert(duplicateKeys.length === 0, `received ${duplicateKeys.length} duplicate native events`);
  assert(watcher.state.state !== "failed", "fleet watch entered the failed state");

  const disconnectProof = await readJson(paths.disconnectComplete);
  assert(disconnectProof.runtimeNodeName === reconnectRuntimeNodeName, "wrong runtimeNode was disconnected");
  assert(disconnectProof.absentDuringDisconnect === true, "runtimeNode remained on the test network");
  assert(disconnectProof.presentAfterReconnect === true, "runtimeNode did not rejoin the test network");

  const streamAssertions = [];
  const uniqueTurns = [];
  const uniqueItems = [];
  for (const send of sendResults) {
    const info = requiredMapValue(sessionInfo, send.sessionId);
    const events = nativeBySession.get(send.sessionId) ?? [];
    const assertion = assertNativeTranscript({
      events,
      session: info.session,
      vendorSessionId: info.vendorSessionId,
      expectedText: send.expectedText,
      chunkCount,
    });
    streamAssertions.push({
      sessionId: send.sessionId,
      runtimeNodeName: send.runtimeNodeName,
      runtimeNodeIndex: send.runtimeNodeIndex,
      sessionIndex: send.sessionIndex,
      ...assertion,
    });
    uniqueTurns.push(`${send.sessionId}\0${assertion.turnId}`);
    uniqueItems.push(`${send.sessionId}\0${assertion.itemId}`);
  }
  assertUnique(uniqueTurns, "session-scoped mock turn IDs");
  assertUnique(uniqueItems, "session-scoped mock item IDs");

  const latestTurnStartedAt = Math.max(
    ...streamAssertions.map((assertion) => Date.parse(assertion.startedAt)),
  );
  const earliestTurnCompletedAt = Math.min(
    ...streamAssertions.map((assertion) => Date.parse(assertion.completedAt)),
  );
  assert(
    latestTurnStartedAt <= earliestTurnCompletedAt,
    "the 100 mock turns did not overlap as one full-fleet concurrent workload",
  );
  const fullFleetOverlapMs = earliestTurnCompletedAt - latestTurnStartedAt;

  const disconnectedAtMs = Date.parse(disconnectProof.disconnectedAt);
  const reconnectedAtMs = Date.parse(disconnectProof.reconnectedAt);
  const reconnectTargetAssertions = streamAssertions.filter(
    (assertion) => assertion.runtimeNodeIndex === reconnectRuntimeNodeIndex,
  );
  const targetEvents = reconnectTargetAssertions.flatMap((assertion) =>
    nativeBySession.get(assertion.sessionId) ?? [],
  );
  assert(
    targetEvents.some((event) => Date.parse(event.receivedAt) <= disconnectedAtMs),
    "no target-runtimeNode event was observed before its network disconnect",
  );
  assert(
    targetEvents.some((event) => Date.parse(event.receivedAt) >= reconnectedAtMs),
    "no target-runtimeNode event was replayed after its network reconnect",
  );
  await writeJson(paths.streamAssertions, {
    passed: true,
    expectedSessionCount: totalSessions,
    nativeEventCount: totalNativeEvents,
      expectedNativeEventCount: totalSessions * (chunkCount + 4),
    nativeGapCount: nativeGaps.length,
      duplicateKeyCount: duplicateKeys.length,
      fullFleetConcurrency: {
        allOneHundredTurnsOverlapped: true,
        latestTurnStartedAt: new Date(latestTurnStartedAt).toISOString(),
        earliestTurnCompletedAt: new Date(earliestTurnCompletedAt).toISOString(),
        overlapMs: fullFleetOverlapMs,
      },
    websocket: {
      forcedAt: forcedWebsocketReconnectAt,
      openCount: websocketOpenCount,
      closeCount: websocketCloseCount,
      reconnected: websocketOpenCount >= 2,
    },
    runtimeNodeNetworkReconnect: {
      runtimeNodeName: reconnectRuntimeNodeName,
      requestedAt: disconnectRequestedAt,
      disconnectedAt: disconnectProof.disconnectedAt,
      reconnectedAt: disconnectProof.reconnectedAt,
      nativeEventsBeforeDisconnect: targetEvents.filter(
        (event) => Date.parse(event.receivedAt) <= disconnectedAtMs,
      ).length,
      nativeEventsAfterReconnect: targetEvents.filter(
        (event) => Date.parse(event.receivedAt) >= reconnectedAtMs,
      ).length,
    },
    sessions: streamAssertions,
  });

  const revisions = new Map(
    metadataInitial.map((entry) => [
      entry.sessionId,
      entry.result.canonical.keyRevisions["scale.client_round"],
    ]),
  );
  for (const round of [2, 3]) {
    const results = await mapConcurrent(
      [...sessionInfo.keys()],
      32,
      async (sessionId) => {
        const expectedRevision = requiredMapValue(revisions, sessionId);
        const session = requiredMapValue(sessionInfo, sessionId).session;
        const result = await client.metadata.patch.mutate({
          operationId: newOperationId(),
          sessionId,
          expectedAuthority: session.metadataAuthority,
          set: { "scale.client_round": round },
          ifKeyRevision: { "scale.client_round": expectedRevision },
        });
        return { sessionId, expectedRevision, result };
      },
    );
    for (const entry of results) {
      assert(entry.result.status === "accepted", `metadata round ${round} did not commit for ${entry.sessionId}`);
      assert(
        entry.result.canonical.values["scale.client_round"] === round,
        `metadata round ${round} did not converge for ${entry.sessionId}`,
      );
      revisions.set(
        entry.sessionId,
        entry.result.canonical.keyRevisions["scale.client_round"],
      );
      await appendNdjson(metadataLog, {
        at: now(),
        round,
        sessionId: entry.sessionId,
        expectedRevision: entry.expectedRevision,
        status: entry.result.status,
        revision: entry.result.canonical.revision,
        keyRevision: entry.result.canonical.keyRevisions["scale.client_round"],
      });
    }
  }

  const stabilitySamples = [];
  const soakStartedAt = Date.now();
  while (Date.now() - soakStartedAt < soakMs) {
    const [runtimeNodes, sessionPage] = await Promise.all([
      client.runtimeNodes.list.query(),
      client.sessions.search.query({
        states: ["running", "stopped"],
        metadata: [{ operator: "equals", key: "scale.run_id", value: runId }],
        limit: 500,
      }),
    ]);
    const selectedRuntimeNodes = runtimeNodes.filter((runtimeNode) => runtimeNode.name.startsWith(runtimeNodePrefix));
    const selectedSessions = sessionPage.sessions;
    const sample = {
      at: now(),
      runtimeNodeCount: selectedRuntimeNodes.length,
      onlineRuntimeNodeCount: selectedRuntimeNodes.filter((runtimeNode) => runtimeNode.presence === "online").length,
      sessionCount: selectedSessions.length,
      activeSessionCount: selectedSessions.filter(
        (session) => session.availability === "active",
      ).length,
      idleSessionCount: selectedSessions.filter(
        (session) => session.runtimeStatus === "idle",
      ).length,
    };
    stabilitySamples.push(sample);
    assert(sample.runtimeNodeCount === runtimeNodeCount, "runtimeNode count changed during soak");
    assert(sample.onlineRuntimeNodeCount === runtimeNodeCount, "a runtimeNode was not online during soak");
    assert(sample.sessionCount === totalSessions, "session count changed during soak");
    assert(sample.activeSessionCount === totalSessions, "a session was not active during soak");
    assert(sample.idleSessionCount === totalSessions, "a session was not idle during soak");
    await delay(Math.min(1_000, Math.max(1, soakMs - (Date.now() - soakStartedAt))));
  }
  await writeJson(paths.stability, stabilitySamples);
  assert(stabilitySamples.length >= 2, "the soak produced fewer than two stability samples");

  const [finalRuntimeNodes, finalSessionPage] = await Promise.all([
    client.runtimeNodes.list.query(),
    client.sessions.search.query({
      states: ["running", "stopped"],
      metadata: [{ operator: "equals", key: "scale.run_id", value: runId }],
      limit: 500,
    }),
  ]);
  const selectedFinalRuntimeNodes = finalRuntimeNodes
    .filter((runtimeNode) => runtimeNode.name.startsWith(runtimeNodePrefix))
    .sort((left, right) => left.name.localeCompare(right.name));
  const selectedFinalSessions = finalSessionPage.sessions;
  await writeJson(paths.runtimeNodesFinal, selectedFinalRuntimeNodes);
  await writeJson(paths.sessionsFinal, selectedFinalSessions);
  assert(selectedFinalRuntimeNodes.length === runtimeNodeCount, "final runtimeNode count is not exact");
  assert(selectedFinalRuntimeNodes.every((runtimeNode) => runtimeNode.presence === "online"), "final runtimeNode presence is not online");
  assert(selectedFinalSessions.length === totalSessions, "final session count is not exact");
  assertRuntimeNodeDistribution(selectedFinalSessions, initialRuntimeNodes, sessionsPerRuntimeNode);
  assertSpawnMetadata(selectedFinalSessions, sessionInfo, runId);
  for (const session of selectedFinalSessions) {
    assert(session.availability === "active", `${session.sessionId} is not active at final check`);
    assert(session.runtimeStatus === "idle", `${session.sessionId} is not idle at final check`);
    assert(
      session.metadata.values["scale.client_round"] === 3,
      `${session.sessionId} lost its final client metadata value`,
    );
    assert(
      session.metadata.values["scale.client_owner"] === "scale-driver",
      `${session.sessionId} lost its client metadata owner`,
    );
  }

  const sendCompletionLatencies = streamAssertions.map((assertion) => assertion.durationMs);
  const summary = {
    passed: true,
    runId,
    topology: {
      controlNodes: controlNodes.length,
      gatewaySources: sourceState.length,
      runtimeNodes: runtimeNodeCount,
      sessionsPerRuntimeNode,
      totalSessions,
    },
    commands: {
      spawnSucceeded: spawnResults.length,
      sendSucceeded: sendResults.length,
      spawnLatencyMs: percentiles(spawnResults.map((result) => result.latencyMs)),
      sendAckLatencyMs: percentiles(sendResults.map((result) => result.latencyMs)),
      sendToNativeCompletionMs: percentiles(sendCompletionLatencies),
    },
    streaming: {
      configuredChunksPerSession: chunkCount,
      expectedEventsPerSession: chunkCount + 4,
      expectedNativeEvents: totalSessions * (chunkCount + 4),
      nativeEvents: totalNativeEvents,
      completedTurns: completions.size,
      nativeGaps: nativeGaps.length,
      duplicateEvents: duplicateKeys.length,
      exactDeltaReassemblies: streamAssertions.length,
      contiguousPerSessionSequences: streamAssertions.length,
      allOneHundredTurnsOverlapped: true,
      fullFleetOverlapMs,
    },
    reconnect: {
      clientWebSocketOpenCount: websocketOpenCount,
      clientWebSocketCloseCount: websocketCloseCount,
      clientCursorReplayDeduplicated: true,
      runtimeNodeDisconnectedMidStream: reconnectRuntimeNodeName,
      runtimeNodeStreamReplayedWithoutGap: true,
    },
    metadata: {
      spawnMetadataVerified: totalSessions,
      clientCasSessions: totalSessions,
      successfulCasRounds: 3,
      staleCasRejectedWithoutMutation: true,
    },
    stability: {
      requestedSoakMs: soakMs,
      samples: stabilitySamples.length,
      allRuntimeNodesOnline: true,
      allSessionsActiveAndIdle: true,
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
  clientHandle.close();
  eventOutput.end();
  await once(eventOutput, "close").catch(() => undefined);
  await stateLog.close().catch(() => undefined);
  await metadataLog.close().catch(() => undefined);
}

function isReadyMockRuntimeNode(runtimeNode) {
  return (
    runtimeNode.presence === "online" &&
    runtimeNode.protocolVersion === 5 &&
    runtimeNode.harnesses.some(
      (entry) =>
        entry.harness === "codex" &&
        entry.available === true &&
        [entry.version, entry.runtimeVersion]
          .filter((value) => typeof value === "string")
          .some((value) => value.toLowerCase().includes("mock") || value === "in-memory"),
    )
  );
}

function assertNativeTranscript({
  events,
  session,
  vendorSessionId,
  expectedText,
  chunkCount,
}) {
  const expectedTypes = [
    "turn/started",
    "item/started",
    ...Array.from({ length: chunkCount }, () => "item/agentMessage/delta"),
    "item/completed",
    "turn/completed",
  ];
  assert(events.length === expectedTypes.length, `${session.sessionId} native event count is ${events.length}, expected ${expectedTypes.length}`);
  assertDeepEqual(
    events.map((event) => event.nativeType),
    expectedTypes,
    `${session.sessionId} native event order`,
  );
  assertDeepEqual(
    events.map((event) => event.sequence),
    Array.from({ length: expectedTypes.length }, (_, index) => index),
    `${session.sessionId} native sequence`,
  );
  assert(events.every((event) => event.runtimeEpoch === session.runtimeEpoch), `${session.sessionId} changed runtime epoch within one turn`);
  assert(events.every((event) => event.harness === "codex"), `${session.sessionId} emitted a non-Codex native event`);

  const turnStarted = events[0].payload.json;
  const itemStarted = events[1].payload.json;
  const deltas = events.slice(2, 2 + chunkCount);
  const itemCompleted = events[2 + chunkCount].payload.json;
  const turnCompleted = events[3 + chunkCount].payload.json;
  assert(isObject(turnStarted), `${session.sessionId} turn/started payload is not an object`);
  assert(isObject(itemStarted), `${session.sessionId} item/started payload is not an object`);
  assert(isObject(itemCompleted), `${session.sessionId} item/completed payload is not an object`);
  assert(isObject(turnCompleted), `${session.sessionId} turn/completed payload is not an object`);
  assert(turnStarted.threadId === vendorSessionId, `${session.sessionId} turn/started has wrong native thread`);
  assert(itemStarted.threadId === vendorSessionId, `${session.sessionId} item/started has wrong native thread`);
  assert(itemCompleted.threadId === vendorSessionId, `${session.sessionId} item/completed has wrong native thread`);
  assert(turnCompleted.threadId === vendorSessionId, `${session.sessionId} turn/completed has wrong native thread`);

  const turnId = turnStarted.turn?.id;
  const itemId = itemStarted.item?.id;
  assert(typeof turnId === "string" && turnId.length > 0, `${session.sessionId} turn ID is missing`);
  assert(typeof itemId === "string" && itemId.length > 0, `${session.sessionId} item ID is missing`);
  assert(turnStarted.turn?.status === "inProgress", `${session.sessionId} did not start in progress`);
  assert(itemStarted.turnId === turnId, `${session.sessionId} item/start turn ID mismatch`);
  assert(itemStarted.item?.type === "agentMessage", `${session.sessionId} item/start type mismatch`);
  assert(itemStarted.item?.text === "", `${session.sessionId} item/start text was not empty`);
  assert(
    deltas.every(
      (event) =>
        isObject(event.payload.json) &&
        event.payload.json.threadId === vendorSessionId &&
        event.payload.json.turnId === turnId &&
        event.payload.json.itemId === itemId &&
        typeof event.payload.json.delta === "string",
    ),
    `${session.sessionId} has malformed delta routing`,
  );
  const reassembled = deltas.map((event) => event.payload.json.delta).join("");
  assert(reassembled === expectedText, `${session.sessionId} delta reassembly is not byte-exact`);
  assert(itemCompleted.turnId === turnId, `${session.sessionId} item/completed turn mismatch`);
  assert(itemCompleted.item?.id === itemId, `${session.sessionId} item/completed ID mismatch`);
  assert(itemCompleted.item?.type === "agentMessage", `${session.sessionId} item/completed type mismatch`);
  assert(itemCompleted.item?.text === expectedText, `${session.sessionId} item/completed text mismatch`);
  assert(turnCompleted.turn?.id === turnId, `${session.sessionId} turn/completed ID mismatch`);
  assert(turnCompleted.turn?.status === "completed", `${session.sessionId} turn did not complete successfully`);
  assert(
    Array.isArray(turnCompleted.turn?.items) &&
      turnCompleted.turn.items.some(
        (item) => item?.id === itemId && item?.text === expectedText,
      ),
    `${session.sessionId} completed turn omitted its exact agent message`,
  );
  // The acceptance deliberately severs the observer WebSocket while turns are
  // running. Replayed events can therefore arrive in a tight burst long after
  // the mock emitted them, so observer receipt time cannot prove concurrency.
  // The deterministic mock stamps each native payload at its source; use that
  // clock for workload overlap and retain receipt timing only as diagnostics.
  const emittedAtMs = events.map((event) => {
    const value = event.payload.json?.emittedAtMs;
    assert(
      Number.isSafeInteger(value) && value > 0,
      `${session.sessionId} native event omitted its mock source timestamp`,
    );
    return value;
  });
  assert(
    emittedAtMs.every((value, index) => index === 0 || value >= emittedAtMs[index - 1]),
    `${session.sessionId} mock source timestamps regressed`,
  );
  const emittedStartedAtMs = emittedAtMs[0];
  const emittedCompletedAtMs = emittedAtMs.at(-1);
  const receivedStartedAtMs = Date.parse(events[0].receivedAt);
  const receivedCompletedAtMs = Date.parse(events.at(-1).receivedAt);
  const durationMs = emittedCompletedAtMs - emittedStartedAtMs;
  return {
    eventCount: events.length,
    runtimeEpoch: events[0].runtimeEpoch,
    turnId,
    itemId,
    deltaCount: deltas.length,
    outputBytes: Buffer.byteLength(reassembled, "utf8"),
    exactReassembly: true,
    contiguousSequence: true,
    startedAt: new Date(emittedStartedAtMs).toISOString(),
    completedAt: new Date(emittedCompletedAtMs).toISOString(),
    durationMs,
    receivedStartedAt: events[0].receivedAt,
    receivedCompletedAt: events.at(-1).receivedAt,
    deliverySpanMs: Math.max(0, receivedCompletedAtMs - receivedStartedAtMs),
  };
}

function assertRuntimeNodeDistribution(sessions, runtimeNodes, expectedPerRuntimeNode) {
  for (const runtimeNode of runtimeNodes) {
    const count = sessions.filter((session) => session.runtimeNodeId === runtimeNode.runtimeNodeId).length;
    assert(count === expectedPerRuntimeNode, `${runtimeNode.name} owns ${count} sessions, expected ${expectedPerRuntimeNode}`);
  }
}

function assertSpawnMetadata(sessions, infoBySession, expectedRunId) {
  for (const session of sessions) {
    const info = requiredMapValue(infoBySession, session.sessionId);
    assert(session.metadata.values["agent.title"] === info.title, `${session.sessionId} lost agent.title`);
    assert(session.metadata.values["scale.run_id"] === expectedRunId, `${session.sessionId} lost scale.run_id`);
    assert(session.metadata.values["scale.runtime_node_index"] === info.runtimeNodeIndex, `${session.sessionId} has wrong runtime-node metadata`);
    assert(session.metadata.values["scale.session_index"] === info.sessionIndex, `${session.sessionId} has wrong session metadata`);
    assert(session.metadata.values["scale.source"] === "spawn", `${session.sessionId} lost scale.source`);
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
  const value = map.get(key);
  assert(value !== undefined, `missing map entry ${String(key)}`);
  return value;
}

function assertUnique(values, description) {
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

async function selectDirectWorkspaceProfile(client, runtimeNodeId, harness) {
  const profiles = await client.launchProfiles.list.query({
    runtimeNodeId,
    providerId: "core.direct",
    harness,
  });
  const matches = profiles.filter(
    (profile) =>
      profile.profileId === "workspace" &&
      profile.harnesses.includes(harness),
  );
  assert(matches.length === 1, `expected one core.direct/workspace profile for ${harness}`);
  const profile = matches[0];
  assert(profile.available, `core.direct/workspace is unavailable: ${profile.unavailableReason ?? "unknown reason"}`);
  return profile;
}

function launchProfileIdentity(profile) {
  return {
    profileId: profile.profileId,
    providerId: profile.providerId,
    contractVersion: profile.contractVersion,
    requestSchemaHash: profile.requestSchemaHash,
  };
}

async function waitForLaunch(client, accepted, maximumMs) {
  if (isTerminalLaunch(accepted)) return accepted;
  return waitFor(`terminal launch ${accepted.launchId}`, maximumMs, async () => {
    const current = await client.launches.get.query(accepted.launchId);
    return current && isTerminalLaunch(current) ? current : undefined;
  });
}

function isTerminalLaunch(record) {
  return record.state === "succeeded" ||
    record.state === "failed" ||
    record.state === "outcomeUnknown";
}

function assertDeepEqual(actual, expected, description) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${description} differs: actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)}`,
  );
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
