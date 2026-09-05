#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";

import {
  createAccessClient,
  launchRequest,
  sessionCommand,
  watchAccess,
  imageTarget,
  uploadImage,
  readImage,
} from "@arduano/agent-multiplex-client";
import { newOperationId } from "@arduano/agent-multiplex-protocol";
import { WebSocket as NodeWebSocket } from "ws";

const [httpUrl, rawReceiptDirectory, runId, runtimeNodeName, rawChunkCount, rawTimeoutMs] =
  process.argv.slice(2);
if (!httpUrl || !rawReceiptDirectory || !runId || !runtimeNodeName) {
  throw new Error(
    "usage: driver.mjs <http-trpc-url> <receipt-dir> <run-id> " +
      "<runtime-node-name> <chunk-count> <timeout-ms>",
  );
}
const chunkCount = positiveInteger(rawChunkCount, "chunk-count");
const timeoutMs = positiveInteger(rawTimeoutMs, "timeout-ms");
const receiptDirectory = resolve(rawReceiptDirectory);
const tokenFile = process.env.AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE;
if (!tokenFile) throw new Error("AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE is required");
const bearerToken = (await readFile(tokenFile, "utf8")).trim();
if (!bearerToken || /\s/.test(bearerToken)) {
  throw new Error("acceptance bearer token is empty or contains whitespace");
}

const paths = {
  events: join(receiptDirectory, "logs/access-events.ndjson"),
  watcher: join(receiptDirectory, "logs/watcher-states.ndjson"),
  system: join(receiptDirectory, "rpc/system.json"),
  initialSources: join(receiptDirectory, "rpc/sources-initial.json"),
  initialControls: join(receiptDirectory, "rpc/control-nodes-initial.json"),
  initialRuntime: join(receiptDirectory, "rpc/runtime-node-initial.json"),
  spawn: join(receiptDirectory, "rpc/spawn.json"),
  baseline: join(receiptDirectory, "phases/baseline.json"),
  imagesBaseline: join(receiptDirectory, "phases/images-baseline.json"),
  imagesFailover: join(receiptDirectory, "phases/images-failover.json"),
  imagesRecovered: join(receiptDirectory, "phases/images-recovered.json"),
  failoverSources: join(receiptDirectory, "rpc/sources-authority-down.json"),
  failoverProjection: join(receiptDirectory, "rpc/projection-authority-down.json"),
  failoverTurn: join(receiptDirectory, "phases/failover-turn.json"),
  queuedMetadata: join(receiptDirectory, "rpc/metadata-queued.json"),
  recoveredSources: join(receiptDirectory, "rpc/sources-recovered.json"),
  recoveredMetadata: join(receiptDirectory, "rpc/metadata-recovered.json"),
  recoveredTurn: join(receiptDirectory, "phases/recovered-turn.json"),
  stopRequest: join(receiptDirectory, "coord/stop-authority-request.json"),
  stopComplete: join(receiptDirectory, "coord/stop-authority-complete.json"),
  startRequest: join(receiptDirectory, "coord/start-authority-request.json"),
  startComplete: join(receiptDirectory, "coord/start-authority-complete.json"),
  failure: join(receiptDirectory, "driver-failure.json"),
};
await Promise.all(
  ["logs", "rpc", "phases", "coord"].map((directory) =>
    mkdir(join(receiptDirectory, directory), { recursive: true }),
  ),
);

const eventOutput = createWriteStream(paths.events, { flags: "w", encoding: "utf8" });
const watcherLog = await open(paths.watcher, "w");
const handle = createAccessClient({
  httpUrl,
  wsUrl: httpUrl.replace(/^http/, "ws"),
  bearerToken,
  WebSocket: NodeWebSocket,
});
const client = handle.client;
const nativeEvents = [];
const streamResets = [];
let watcher;

try {
  const system = await waitFor("protocol-v5 zero-authority gateway", timeoutMs, async () => {
    const value = await client.system.describe.query();
    return value.protocolVersion === 5 &&
      value.componentKind === "access-gateway" &&
      value.dataAuthority === "none"
      ? value
      : undefined;
  });
  await writeJson(paths.system, system);

  const initialSources = await waitFor(
    "ancestor source selection with warm descendant standby",
    timeoutMs,
    async () => {
      const values = await client.sources.list.query();
      const authority = values.find((source) => source.sourceId === "authority");
      const branch = values.find((source) => source.sourceId === "branch");
      return values.length === 2 &&
        authority?.state === "selected" &&
        authority.manifest?.coveredControlNodeIds.length === 2 &&
        branch?.state === "suppressed" &&
        branch.selectedBySourceId === "authority" &&
        branch.manifest?.coveredControlNodeIds.length === 1
        ? values
        : undefined;
    },
  );
  await writeJson(paths.initialSources, initialSources);

  const controls = await waitFor("attached two-control-node tree", timeoutMs, async () => {
    const values = await client.controlNodes.list.query();
    const authority = values.find((node) => node.dataRole.role === "authority");
    const branch = values.find(
      (node) => node.dataRole.role === "branch" && node.dataRole.branch.lifecycle === "attached",
    );
    return values.length === 2 && authority && branch &&
      branch.dataRole.authority.realmId === authority.dataRole.authority.realmId &&
      branch.dataRole.authority.epochId === authority.dataRole.authority.epochId &&
      branch.dataRole.branch.parentControlNodeId === authority.controlNodeId
      ? values
      : undefined;
  });
  await writeJson(paths.initialControls, controls);
  const authorityNode = controls.find((node) => node.dataRole.role === "authority");
  const branchNode = controls.find((node) => node.dataRole.role === "branch");
  assert(authorityNode && branchNode, "tree roles disappeared after validation");

  const runtime = await waitFor("branch-owned runtime node", timeoutMs, async () => {
    const values = await client.runtimeNodes.list.query();
    const value = values.find((node) => node.name === runtimeNodeName);
    return value?.presence === "online" &&
      value.reachability === "reachable" &&
      value.ownerControlNodeId === branchNode.controlNodeId
      ? value
      : undefined;
  });
  await writeJson(paths.initialRuntime, runtime);

  const profile = await selectDirectWorkspaceProfile(
    client,
    runtime.runtimeNodeId,
    "codex",
  );
  const models = await client.launchProfiles.models.query({
    runtimeNodeId: runtime.runtimeNodeId,
    profile: launchProfileIdentity(profile),
    harness: "codex",
  });
  assert(models.some((model) => model.id === "mock-model"), "runtime omitted mock-model");

  const request = launchRequest(
    runtime.runtimeNodeId,
    launchProfileIdentity(profile),
    "codex",
    {
      cwd: "/workspace",
      model: "mock-model",
      approvalPolicy: "never",
      sandbox: "read-only",
    },
    {
      "agent.title": `Protocol v5 tree ${runId}`,
      "acceptance.run_id": runId,
      "acceptance.topology": "control-tree",
    },
  );
  const acceptedLaunch = await client.launches.create.mutate(request);
  const launch = await waitForLaunch(client, acceptedLaunch, timeoutMs);
  assert(launch.state === "succeeded", "launch did not succeed through ancestor source");
  assert(isObject(launch.result) && typeof launch.result.vendorSessionId === "string", "launch omitted native ID");
  await writeJson(paths.spawn, { accepted: acceptedLaunch, terminal: launch });

  const session = await waitFor("canonical spawned session", timeoutMs, async () => {
    const value = await client.sessions.get.query(request.sessionId);
    return value?.availability === "active" &&
      value.runtimeStatus === "idle" &&
      value.metadata.values["acceptance.run_id"] === runId &&
      value.metadataAuthority.controlNodeId === authorityNode.controlNodeId
      ? value
      : undefined;
  });

  watcher = watchAccess(client.sessions.watch, {
    sessions: [session.sessionId],
    includeNative: true,
    initialRetryDelayMs: 50,
    maxRetryDelayMs: 1_000,
    retryJitter: 0,
    onStateChange: (state) => appendNdjson(watcherLog, {
      at: now(),
      ...serializableState(state),
    }).catch(() => undefined),
    onItem: async (item) => {
      if (!eventOutput.write(`${JSON.stringify({ receivedAt: now(), ...item })}\n`)) {
        await once(eventOutput, "drain");
      }
      if (item.kind === "native") nativeEvents.push({ receivedAt: now(), ...item });
      if (item.kind === "streamReset") streamResets.push({ receivedAt: now(), ...item });
    },
  });
  await waitFor("live access stream", timeoutMs, async () =>
    watcher.state.state === "live" ? true : undefined,
  );

  const baseline = await runTurn(client, session.sessionId, "baseline", runId, nativeEvents, chunkCount, timeoutMs);
  await writeJson(paths.baseline, baseline);

  const target = imageTarget(session, runtime);
  const imageBytes = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><!--${"bounded-image-transfer".repeat(20_000)}--><rect width="1" height="1"/></svg>`);
  const uploaded = await uploadImage(client, target, imageBytes, "image/svg+xml");
  assert(Buffer.from(await readImage(client, target, uploaded)).equals(imageBytes), "initial image upload/read bytes changed");
  const sourceKey = `tree/${runId}/native-image`;
  const snapshotImage = await client.images.resolvePath.mutate({ ...target, sourceKey, path: "/workspace/image.svg" });
  const snapshotBytes = Buffer.from(await readImage(client, target, snapshotImage));
  const expectedSnapshot = await readFile(new URL("./image.svg", import.meta.url));
  assert(snapshotBytes.equals(expectedSnapshot), "runtime path snapshot differs from fixture");
  const secondResolution = await client.images.resolvePath.mutate({ ...target, sourceKey, path: "/workspace/image-other.svg" });
  assert(secondResolution.imageId === snapshotImage.imageId && secondResolution.sha256 === snapshotImage.sha256,
    "a resolved native image source key was replaced by another path");
  const limits = await client.images.limits.query(target);
  const pendingImageId = randomUUID();
  const pendingUpload = {
    ...target, imageId: pendingImageId, byteLength: imageBytes.length,
    sha256: createHash("sha256").update(imageBytes).digest("hex"), mediaType: "image/svg+xml",
  };
  await client.images.beginUpload.mutate(pendingUpload);
  const firstChunk = imageBytes.subarray(0, limits.maximumChunkBytes);
  const write = { ...target, imageId: pendingImageId, offset: 0, dataBase64: firstChunk.toString("base64") };
  const progress = await client.images.writeUpload.mutate(write);
  const repeated = await client.images.writeUpload.mutate(write);
  assert(progress.receivedBytes === firstChunk.length && repeated.receivedBytes === progress.receivedBytes,
    "an exact image chunk retry changed upload progress");
  await writeJson(paths.imagesBaseline, {
    uploaded, snapshot: snapshotImage, pendingImageId, receivedBytes: progress.receivedBytes,
    exactUploadRead: true, immutablePathSnapshot: true, exactChunkRetry: true,
  });

  const initialPatch = await client.metadata.patch.mutate({
    operationId: newOperationId(),
    sessionId: session.sessionId,
    expectedAuthority: session.metadataAuthority,
    set: { "acceptance.authority_round": 1 },
    ifKeyRevision: { "acceptance.authority_round": null },
  });
  assert(initialPatch.status === "accepted", "authority metadata patch was not accepted");

  await writeJson(paths.stopRequest, {
    requestedAt: now(),
    authorityControlNodeId: authorityNode.controlNodeId,
    reason: "exercise warm descendant selection without changing data role",
  });
  await waitForFile(paths.stopComplete, timeoutMs);

  const failoverSources = await waitFor("warm branch source selection", timeoutMs, async () => {
    const values = await client.sources.list.query();
    const authority = values.find((source) => source.sourceId === "authority");
    const branch = values.find((source) => source.sourceId === "branch");
    return branch?.state === "selected" && authority?.state !== "selected"
      ? values
      : undefined;
  });
  await writeJson(paths.failoverSources, failoverSources);

  const [failoverControls, failoverRuntimes, failoverSessions] = await Promise.all([
    client.controlNodes.list.query(),
    client.runtimeNodes.list.query(),
    client.sessions.search.query({ states: ["running", "stopped"], limit: 500 }),
  ]);
  assert(failoverControls.length === 1, "descendant projection exposed an ancestor while isolated");
  assert(failoverControls[0]?.controlNodeId === branchNode.controlNodeId, "wrong failover control node");
  assert(failoverControls[0]?.dataRole.role === "branch", "disconnect silently promoted branch");
  assert(failoverRuntimes.some((node) => node.runtimeNodeId === runtime.runtimeNodeId), "runtime missing on failover");
  assert(failoverSessions.sessions.some((value) => value.sessionId === session.sessionId), "session missing on failover");
  await writeJson(paths.failoverProjection, {
    controlNodes: failoverControls,
    runtimeNodes: failoverRuntimes,
    sessions: failoverSessions.sessions,
  });

  const failoverSession = await client.sessions.get.query(session.sessionId);
  assert(failoverSession, "session disappeared after failover");
  const failoverRuntime = failoverRuntimes.find((node) => node.runtimeNodeId === runtime.runtimeNodeId);
  assert(failoverRuntime, "image runtime missing after source failover");
  const failoverTarget = imageTarget(failoverSession, failoverRuntime);
  assert(Buffer.from(await readImage(client, failoverTarget, uploaded)).equals(imageBytes), "committed image changed through warm-source failover");
  const completedUpload = await uploadImage(client, failoverTarget, imageBytes, "image/svg+xml", { imageId: pendingImageId });
  assert(Buffer.from(await readImage(client, failoverTarget, completedUpload)).equals(imageBytes), "resumed image upload changed bytes");
  const failoverSnapshot = await client.images.resolvePath.mutate({ ...failoverTarget, sourceKey, path: "/workspace/image-other.svg" });
  assert(failoverSnapshot.imageId === snapshotImage.imageId, "path snapshot identity changed through failover");
  assert(Buffer.from(await readImage(client, failoverTarget, failoverSnapshot)).equals(expectedSnapshot), "path snapshot bytes changed through failover");
  await writeJson(paths.imagesFailover, {
    completedUpload, snapshot: failoverSnapshot,
    committedImageRead: true, uploadResumedOnBranch: true, immutableSnapshotRead: true,
  });

  const failoverTurn = await runTurn(
    client,
    failoverSession.sessionId,
    "authority-down",
    runId,
    nativeEvents,
    chunkCount,
    timeoutMs,
  );
  await writeJson(paths.failoverTurn, failoverTurn);

  const queuedOperationId = newOperationId();
  const queued = await client.metadata.patch.mutate({
    operationId: queuedOperationId,
    sessionId: failoverSession.sessionId,
    expectedAuthority: failoverSession.metadataAuthority,
    set: { "acceptance.authority_round": 2 },
    ifKeyRevision: {
      "acceptance.authority_round": initialPatch.canonical.keyRevisions["acceptance.authority_round"],
    },
  });
  assert(queued.status === "queued", "attached branch committed metadata while authority was unavailable");
  assert(queued.canonical.values["acceptance.authority_round"] === 1, "queued operation changed canonical metadata");
  await writeJson(paths.queuedMetadata, queued);

  await writeJson(paths.startRequest, {
    requestedAt: now(),
    authorityControlNodeId: authorityNode.controlNodeId,
  });
  await waitForFile(paths.startComplete, timeoutMs);

  const recoveredSources = await waitFor("ancestor source to recover and suppress branch", timeoutMs, async () => {
    const values = await client.sources.list.query();
    const authority = values.find((source) => source.sourceId === "authority");
    const branch = values.find((source) => source.sourceId === "branch");
    return authority?.state === "selected" &&
      authority.manifest?.coveredControlNodeIds.length === 2 &&
      branch?.state === "suppressed" &&
      branch.selectedBySourceId === "authority"
      ? values
      : undefined;
  });
  await writeJson(paths.recoveredSources, recoveredSources);

  const recovered = await waitFor("queued metadata to settle at the sole authority", timeoutMs, async () => {
    const [operation, current] = await Promise.all([
      client.metadata.operations.get.query(queuedOperationId),
      client.sessions.get.query(session.sessionId),
    ]);
    return operation?.status === "accepted" &&
      operation.canonical.values["acceptance.authority_round"] === 2 &&
      current?.metadata.values["acceptance.authority_round"] === 2 &&
      current.metadataAuthority.controlNodeId === authorityNode.controlNodeId
      ? { operation, session: current }
      : undefined;
  });
  await writeJson(paths.recoveredMetadata, recovered);

  const recoveredTurn = await runTurn(
    client,
    recovered.session.sessionId,
    "authority-recovered",
    runId,
    nativeEvents,
    chunkCount,
    timeoutMs,
  );
  await writeJson(paths.recoveredTurn, recoveredTurn);

  const recoveredRuntime = (await client.runtimeNodes.list.query()).find((node) => node.runtimeNodeId === runtime.runtimeNodeId);
  assert(recoveredRuntime, "image runtime missing after ancestor recovery");
  const recoveredTarget = imageTarget(recovered.session, recoveredRuntime);
  assert(Buffer.from(await readImage(client, recoveredTarget, completedUpload)).equals(imageBytes), "resumed upload changed after ancestor recovery");
  const recoveredSnapshot = await client.images.resolvePath.mutate({ ...recoveredTarget, sourceKey, path: "/workspace/image-other.svg" });
  assert(recoveredSnapshot.imageId === snapshotImage.imageId, "snapshot identity changed after ancestor recovery");
  assert(Buffer.from(await readImage(client, recoveredTarget, recoveredSnapshot)).equals(expectedSnapshot), "snapshot bytes changed after ancestor recovery");
  await writeJson(paths.imagesRecovered, {
    uploaded: completedUpload, snapshot: recoveredSnapshot,
    committedImageRead: true, immutableSnapshotRead: true,
  });

  const finalControls = await client.controlNodes.list.query();
  assert(finalControls.length === 2, "recovered ancestor projection is incomplete");
  assert(finalControls.filter((node) => node.dataRole.role === "authority").length === 1, "authority count changed");
  assert(finalControls.filter((node) => node.dataRole.role === "branch").length === 1, "branch count changed");
  assert(streamResets.some((item) => item.reason === "sourceSelectionChanged"), "watcher did not observe source-selection reset");

  console.log(JSON.stringify({
    passed: true,
    runId,
    topology: {
      controlNodes: 2,
      runtimeNodes: 1,
      gatewaySources: 2,
      initialSelected: "authority",
      warmStandby: "branch",
      failoverSelected: "branch",
      recoveredSelected: "authority",
    },
    authority: {
      canonicalControlNodeId: authorityNode.controlNodeId,
      branchControlNodeId: branchNode.controlNodeId,
      noImplicitPromotion: true,
      queuedWhileDisconnected: true,
      settledAfterRecovery: true,
    },
    routing: {
      turnsThroughAncestor: 2,
      turnsThroughWarmBranch: 1,
      exactNativeDeltaReassemblies: 3,
    },
    images: {
      exactUploadRead: true,
      exactChunkRetry: true,
      immutablePathSnapshot: true,
      uploadResumedOnBranch: true,
      preservedThroughAncestorRecovery: true,
    },
    streaming: {
      sourceSelectionResets: streamResets.filter((item) => item.reason === "sourceSelectionChanged").length,
      watcherState: watcher.state.state,
    },
  }, null, 2));
} catch (error) {
  await writeJson(paths.failure, {
    failedAt: now(),
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }).catch(() => undefined);
  throw error;
} finally {
  watcher?.stop();
  handle.close();
  await watcherLog.close().catch(() => undefined);
  eventOutput.end();
  await once(eventOutput, "close").catch(() => undefined);
}

async function runTurn(client, sessionId, phase, runId, events, count, timeout) {
  const session = await client.sessions.get.query(sessionId);
  assert(session, `session missing before ${phase} turn`);
  const prompt = `tree/${runId}/${phase}`;
  const startIndex = events.length;
  const command = await client.sessions.execute.mutate(sessionCommand(session, {
    harness: "codex",
    command: { type: "send", input: prompt },
  }));
  assert(command.state === "succeeded", `${phase} send command did not succeed`);
  const turnEvents = await waitFor(`${phase} native turn`, timeout, async () => {
    const candidates = events.slice(startIndex);
    const completed = candidates.find((event) =>
      event.nativeType === "turn/completed" &&
      JSON.stringify(event.payload.json).includes(prompt),
    );
    if (!completed) return undefined;
    const turnId = completed.payload.json?.turn?.id;
    if (typeof turnId !== "string") return undefined;
    const matching = candidates.filter((event) =>
      event.payload.json?.turnId === turnId || event.payload.json?.turn?.id === turnId,
    );
    return matching.some((event) => event.nativeType === "turn/started") ? matching : undefined;
  });
  const deltas = turnEvents.filter((event) => event.nativeType === "item/agentMessage/delta");
  assert(deltas.length === count, `${phase} emitted ${deltas.length}/${count} deltas`);
  const text = deltas.map((event) => event.payload.json?.delta ?? "").join("");
  const vendorSessionId = session.vendorSessionId;
  const expectedTurn = phase === "baseline" ? 1 : phase === "authority-down" ? 2 : 3;
  const expected = mockExpectedText(vendorSessionId, expectedTurn, prompt, count);
  assert(text === expected, `${phase} native output did not reassemble byte-exactly`);
  return {
    phase,
    prompt,
    command,
    eventCount: turnEvents.length,
    deltaCount: deltas.length,
    exactReassembly: true,
    nativeSequenceFirst: turnEvents[0]?.sequence,
    nativeSequenceLast: turnEvents.at(-1)?.sequence,
  };
}

function mockExpectedText(vendorSessionId, turn, prompt, count) {
  const width = String(count).length;
  return Array.from({ length: count }, (_, index) =>
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

async function waitForLaunch(client, accepted, timeout) {
  if (isTerminalLaunch(accepted)) return accepted;
  return waitFor(`terminal launch ${accepted.launchId}`, timeout, async () => {
    const current = await client.launches.get.query(accepted.launchId);
    return current && isTerminalLaunch(current) ? current : undefined;
  });
}

function isTerminalLaunch(record) {
  return record.state === "succeeded" ||
    record.state === "failed" ||
    record.state === "outcomeUnknown";
}

async function waitFor(description, timeout, operation) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== undefined) return value;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${lastError.message ?? lastError}` : ""}`);
}

async function waitForFile(filename, timeout) {
  return waitFor(filename, timeout, async () => {
    try {
      return JSON.parse(await readFile(filename, "utf8"));
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
      throw error;
    }
  });
}

async function appendNdjson(handle, value) {
  await handle.appendFile(`${JSON.stringify(value)}\n`, "utf8");
}

async function writeJson(filename, value) {
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function serializableState(state) {
  if (state.state !== "retrying" && state.state !== "failed") return state;
  return {
    ...state,
    error: state.error instanceof Error ? state.error.message : String(state.error),
  };
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function now() {
  return new Date().toISOString();
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
