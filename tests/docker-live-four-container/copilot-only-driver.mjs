#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";

import {
  createAccessClient,
  launchRequest,
  resumeCommand,
  sessionCommand,
  stopCommand,
  watchAccess,
} from "@arduano/agent-multiplex-client";
import { WebSocket as NodeWebSocket } from "ws";

const [httpUrl, rawReceiptDirectory, runId, runtimeName, rawTimeoutMs] = process.argv.slice(2);
if (!httpUrl || !rawReceiptDirectory || !runId || !runtimeName || !rawTimeoutMs) {
  throw new Error(
    "usage: copilot-only-driver.mjs <gateway-trpc-url> <receipt-dir> <run-id> " +
      "<runtime-name> <timeout-ms>",
  );
}
const timeoutMs = positiveInteger(rawTimeoutMs, "timeout-ms");
const receiptDirectory = resolve(rawReceiptDirectory);
const tokenFile = process.env.AGENT_MULTIPLEX_COPILOT_ONLY_BEARER_TOKEN_FILE;
if (!tokenFile) throw new Error("AGENT_MULTIPLEX_COPILOT_ONLY_BEARER_TOKEN_FILE is required");
const bearerToken = (await readFile(tokenFile, "utf8")).trim();
if (!bearerToken || /\s/.test(bearerToken)) throw new Error("bearer token is invalid");

const model = "gpt-6-luna";
const nonce = runId.replace(/[^A-Za-z0-9]/g, "").slice(-24).toUpperCase();
const marker = `COPILOT_ONLY_V6_${nonce}_NATIVE_REPLY`;
const prompt =
  `In Plan mode, make a one-step plan whose entire plan text is exactly ${marker}. ` +
  "Call exit_plan_mode exactly once and recommend exit_only. Do not ask questions or " +
  `execute the plan. After approval, reply with exactly ${marker} and nothing else.`;
const paths = {
  events: join(receiptDirectory, "logs/native-events.ndjson"),
  exitPlanPending: join(receiptDirectory, "rpc/exit-plan-pending.json"),
  exitPlanResolved: join(receiptDirectory, "rpc/exit-plan-resolved.json"),
  result: join(receiptDirectory, "result.json"),
  failure: join(receiptDirectory, "failure.json"),
};
await Promise.all(Object.values(paths).map((path) => mkdir(dirname(path), { recursive: true })));

const handle = createAccessClient({
  httpUrl,
  wsUrl: httpUrl.replace(/^http/, "ws"),
  bearerToken,
  WebSocket: NodeWebSocket,
});
const eventOutput = createWriteStream(paths.events, { flags: "wx", encoding: "utf8" });
const nativeEvents = [];
const nativeGaps = [];
let watcher;
let promptDispatchCount = 0;
let sessionId;

try {
  const system = await handle.client.system.describe.query();
  assert(system.protocolVersion === 6, `expected protocol 6, received ${system.protocolVersion}`);
  assert(system.componentKind === "access-gateway", "endpoint is not an access gateway");
  assert(system.dataAuthority === "none", "gateway unexpectedly owns authority data");

  const runtime = await waitFor("one isolated Copilot runtime", timeoutMs, async () => {
    const runtimes = await handle.client.runtimeNodes.list.query();
    const selected = runtimes.filter((item) => item.name === runtimeName);
    if (runtimes.length !== 1 || selected.length !== 1) return undefined;
    const item = selected[0];
    return item.presence === "online" && item.reachability === "reachable" &&
      item.harnesses.length === 1 && item.harnesses[0]?.harness === "copilot" &&
      item.harnesses[0]?.available === true ? item : undefined;
  });

  const profiles = await handle.client.launchProfiles.list.query({
    runtimeNodeId: runtime.runtimeNodeId,
    providerId: "core.direct",
    harness: "copilot",
  });
  const matchingProfiles = profiles.filter((item) =>
    item.providerId === "core.direct" && item.profileId === "workspace" &&
    item.harnesses.includes("copilot")
  );
  assert(matchingProfiles.length === 1, "runtime did not advertise exactly one core.direct/workspace profile");
  const profile = matchingProfiles[0];
  assert(profile.available, `core.direct/workspace is unavailable: ${profile.unavailableReason ?? "unknown"}`);
  const profileIdentity = {
    providerId: profile.providerId,
    profileId: profile.profileId,
    contractVersion: profile.contractVersion,
    requestSchemaHash: profile.requestSchemaHash,
  };
  const models = await handle.client.launchProfiles.models.query({
    runtimeNodeId: runtime.runtimeNodeId,
    profile: profileIdentity,
    harness: "copilot",
  });
  const advertisedModel = models.find((item) => item.id === model);
  assert(advertisedModel?.harness === "copilot", `${model} was not advertised for Copilot`);
  assert(advertisedModel.native?.byok === true, `${model} was not advertised as BYOK`);
  assert(advertisedModel.native?.wireApi === "responses", "provider wire API is not responses");
  assert(advertisedModel.native?.transport === "http", "provider transport is not HTTP");

  const request = launchRequest(
    runtime.runtimeNodeId,
    profileIdentity,
    "copilot",
    {
      cwd: "/workspace/project",
      model,
      mode: "plan",
      native: {
        enableConfigDiscovery: false,
        tools: [],
        availableTools: ["exit_plan_mode"],
        excludedTools: ["mcp:*", "custom:*"],
        toolSearch: { enabled: false },
        requestCanvasRenderer: false,
        requestExtensions: false,
      },
    },
    {
      "agent.title": `Copilot-only protocol-v6 ${runId}`,
      "acceptance.run_id": runId,
      "acceptance.synthetic_prompt_limit": 1,
      "acceptance.model": model,
    },
  );
  sessionId = request.sessionId;
  const acceptedLaunch = await handle.client.launches.create.mutate(request);
  const terminalLaunch = ["succeeded", "failed", "outcomeUnknown"].includes(acceptedLaunch.state)
    ? acceptedLaunch
    : await waitFor("terminal launch", timeoutMs, async () => {
      const value = await handle.client.launches.get.query(acceptedLaunch.launchId);
      return value && ["succeeded", "failed", "outcomeUnknown"].includes(value.state)
        ? value
        : undefined;
    });
  assert(terminalLaunch.state === "succeeded", `launch ended in ${terminalLaunch.state}`);
  const created = await waitFor("fresh idle session", timeoutMs, async () => {
    const value = await handle.client.sessions.get.query(sessionId);
    return value?.availability === "active" && value.runtimeStatus === "idle" ? value : undefined;
  });

  watcher = watchAccess(handle.client.sessions.watch, {
    sessions: [sessionId],
    includeNative: true,
    initialRetryDelayMs: 50,
    maxRetryDelayMs: 1_000,
    retryJitter: 0,
    onItem: async (item) => {
      if (!eventOutput.write(`${JSON.stringify({ receivedAt: now(), ...item })}\n`)) {
        await once(eventOutput, "drain");
      }
      if (item.kind === "native") nativeEvents.push(item);
      if (item.kind === "nativeGap") nativeGaps.push(item);
    },
  });
  await waitFor("live native stream", timeoutMs, async () =>
    watcher.state.state === "live" ? true : undefined
  );

  // This is the harness's only model-bearing command. Static validation also
  // checks that this source contains exactly one sessions.execute mutation.
  promptDispatchCount += 1;
  assert(promptDispatchCount === 1, "synthetic prompt budget exceeded before dispatch");
  const send = await handle.client.sessions.execute.mutate(sessionCommand(created, {
    harness: "copilot",
    command: { type: "send", prompt, mode: "enqueue" },
  }));
  assert(send.state === "succeeded", `send ended in ${send.state}`);

  const turnCheckpoint = await waitFor(
    "a gateway-visible exitPlan request or the exact completed native reply",
    timeoutMs,
    async () => {
      const pending = await handle.client.interactions.list.query({
        sessionId,
        pendingOnly: true,
      });
      const exitPlan = pending.find((interaction) =>
        interaction.harness === "copilot" && interaction.requestType === "exitPlan"
      );
      if (exitPlan) return { kind: "exitPlan", pending, interaction: exitPlan };
      const streamed = exactReplyAndIdle(nativeEvents, sessionId, marker);
      return streamed ? { kind: "completedWithoutExitPlan", pending, streamed } : undefined;
    },
  );

  let exitPlanProof;
  let streamed;
  if (turnCheckpoint.kind === "exitPlan") {
    const interaction = turnCheckpoint.interaction;
    const request = interaction.payload?.json?.request;
    assert(interaction.state === "pending", "gateway exitPlan record was not pending");
    assert(
      Array.isArray(request?.actions) && request.actions.includes("exit_only"),
      "gateway exitPlan record omitted exit_only",
    );
    assert(typeof request?.summary === "string" && request.summary.trim(),
      "gateway exitPlan record omitted its native summary");
    assert(typeof request?.planContent === "string",
      "gateway exitPlan record omitted its native plan-content field");
    await writeJson(paths.exitPlanPending, turnCheckpoint.pending);
    const requested = await waitFor("matching native exit_plan_mode.requested", timeoutMs, async () =>
      nativeEvents.find((event) =>
        event.sessionId === sessionId && event.nativeType === "exit_plan_mode.requested" &&
        typeof event.payload?.json?.data?.requestId === "string" &&
        event.payload?.json?.data?.summary === request.summary &&
        event.payload?.json?.data?.planContent === request.planContent
      )
    );
    // The SDK callback intentionally omits requestId. Correlate one bounded
    // pending approval by session and identical native summary/content (the
    // CLI may emit an empty planContent), then fence completion with the exact
    // requestId from the native requested event.
    assert(!interaction.nativeRequestId || interaction.nativeRequestId === requested.payload.json.data.requestId,
      "gateway interaction disagrees with the native plan request identity");
    const resolved = await handle.client.interactions.resolve.mutate({
      interactionId: interaction.interactionId,
      sessionId: interaction.sessionId,
      harness: interaction.harness,
      response: { approved: true, selectedAction: "exit_only" },
    });
    assert(resolved.state === "resolved", `exitPlan resolution ended in ${resolved.state}`);
    assert(resolved.resolution?.json?.approved === true, "exitPlan resolution lost approved=true");
    assert(
      resolved.resolution?.json?.selectedAction === "exit_only",
      "exitPlan resolution lost selectedAction=exit_only",
    );
    await writeJson(paths.exitPlanResolved, resolved);
    const completed = await waitFor("matching native exit_plan_mode.completed", timeoutMs, async () =>
      nativeEvents.find((event) =>
        event.sessionId === sessionId && event.nativeType === "exit_plan_mode.completed" &&
        event.payload?.json?.data?.requestId === requested.payload.json.data.requestId &&
        event.payload?.json?.data?.approved === true &&
        event.payload?.json?.data?.selectedAction === "exit_only"
      )
    );
    streamed = await waitFor("exact native reply followed by root idle", timeoutMs, async () =>
      exactReplyAndIdle(nativeEvents, sessionId, marker)
    );
    exitPlanProof = {
      observed: true,
      listedPendingBeforeResolution: true,
      interactionId: interaction.interactionId,
      nativeRequestId: requested.payload.json.data.requestId,
      nativeRequestedSequence: requested.sequence,
      resolvedExactly: true,
      nativeCompletedSequence: completed.sequence,
      planContentBytes: Buffer.byteLength(request.planContent),
    };
  } else {
    streamed = turnCheckpoint.streamed;
    await writeJson(paths.exitPlanPending, turnCheckpoint.pending);
    exitPlanProof = {
      observed: false,
      listedPendingBeforeResolution: false,
      reason: "The single authorized model turn completed without a native exitPlan callback; no retry was sent.",
    };
  }
  assert(nativeGaps.length === 0, `native stream reported ${nativeGaps.length} gap(s)`);

  const historyBeforeStop = await handle.client.sessions.readNativeHistory.query({
    sessionId,
    request: { harness: "copilot", limit: 500 },
  });
  assert(containsExactAssistant(historyBeforeStop, marker), "native history omitted exact reply");
  assert(containsNativeType(historyBeforeStop, "session.idle"), "native history omitted root idle");

  const stop = await handle.client.sessions.stop.mutate(stopCommand(
    requiredSession(await handle.client.sessions.get.query(sessionId), "before stop"),
  ));
  assert(stop.state === "succeeded", `stop ended in ${stop.state}`);
  const stopped = await waitFor("resumable stopped session", timeoutMs, async () => {
    const value = await handle.client.sessions.get.query(sessionId);
    return value?.availability === "resumable" && value.runtimeStatus === "stopped"
      ? value
      : undefined;
  });

  const resume = await handle.client.sessions.resume.mutate(resumeCommand(stopped));
  assert(resume.state === "succeeded", `resume ended in ${resume.state}`);
  const resumed = await waitFor("resumed idle session", timeoutMs, async () => {
    const value = await handle.client.sessions.get.query(sessionId);
    return value?.availability === "active" && value.runtimeStatus === "idle" &&
      value.runtimeEpoch && value.runtimeEpoch !== created.runtimeEpoch ? value : undefined;
  });
  const historyAfterResume = await handle.client.sessions.readNativeHistory.query({
    sessionId,
    request: { harness: "copilot", limit: 500 },
  });
  assert(containsExactAssistant(historyAfterResume, marker), "resumed native history lost exact reply");

  const finalStop = await handle.client.sessions.stop.mutate(stopCommand(resumed));
  assert(finalStop.state === "succeeded", `final stop ended in ${finalStop.state}`);
  await waitFor("final stopped session", timeoutMs, async () => {
    const value = await handle.client.sessions.get.query(sessionId);
    return value?.availability === "resumable" && value.runtimeStatus === "stopped" ? value : undefined;
  });

  const pendingInteractions = await handle.client.interactions.list.query({ pendingOnly: true });
  assert(pendingInteractions.length === 0, "unexpected pending interactions remain");
  assert(promptDispatchCount === 1, "synthetic prompt budget was not exactly one");

  const result = {
    passed: true,
    protocolVersion: 6,
    topology: { controlNodes: 1, gateways: 1, runtimeNodes: 1, harnesses: ["copilot"] },
    runtimeName,
    sessionId,
    model,
    promptDispatchCount,
    checks: {
      freshCreateIdle: true,
      exactNativeAssistantReply: streamed.reply.nativeType === "assistant.message",
      rootNativeIdleAfterReply: streamed.idle.nativeType === "session.idle",
      exitPlanObserved: exitPlanProof.observed,
      exitPlanListedPendingBeforeResolution: exitPlanProof.listedPendingBeforeResolution,
      exitPlanResolvedExactly: exitPlanProof.observed ? exitPlanProof.resolvedExactly : null,
      nativeHistoryBeforeStop: true,
      stopBecameResumable: true,
      resumeCreatedNewRuntimeEpoch: true,
      nativeHistoryAfterResume: true,
      finalStopBecameResumable: true,
      noPendingInteractions: true,
      nativeGapCount: nativeGaps.length,
    },
    exitPlan: exitPlanProof,
    interactionLimitation:
      "The gateway probe is opportunistic within the one authorized model turn. It records a real pending exitPlan before exact resolution when the model emits the native callback; it never fabricates or retries that callback.",
    credentialMaterialRecorded: false,
    providerEndpointRecorded: false,
    completedAt: now(),
  };
  await writeJson(paths.result, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  await writeJson(paths.failure, {
    failedAt: now(),
    error: errorText(error),
    sessionId: sessionId ?? null,
    promptDispatchCount,
    credentialMaterialRecorded: false,
    providerEndpointRecorded: false,
  }).catch(() => undefined);
  throw error;
} finally {
  watcher?.stop();
  await watcher?.done.catch(() => undefined);
  await new Promise((resolveStream) => eventOutput.end(resolveStream));
  handle.close();
}

function exactReplyAndIdle(events, expectedSessionId, expectedContent) {
  const reply = events.find((event) =>
    event.sessionId === expectedSessionId && event.nativeType === "assistant.message" &&
    event.payload?.json?.data?.content === expectedContent
  );
  if (!reply) return undefined;
  const idle = events.find((event) =>
    event.sessionId === expectedSessionId && event.nativeType === "session.idle" &&
    event.sequence > reply.sequence
  );
  return idle ? { reply, idle } : undefined;
}
function containsExactAssistant(history, expected) {
  return JSON.stringify(history).includes(`\"content\":\"${expected}\"`) ||
    collectObjects(history).some((item) =>
      item?.type === "assistant.message" && item?.data?.content === expected
    );
}
function containsNativeType(history, type) {
  return collectObjects(history).some((item) => item?.type === type);
}
function collectObjects(value, output = []) {
  if (!value || typeof value !== "object") return output;
  output.push(value);
  for (const child of Object.values(value)) collectObjects(child, output);
  return output;
}
function requiredSession(value, phase) {
  assert(value, `session vanished ${phase}`);
  return value;
}
async function waitFor(description, limitMs, inspect) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started <= limitMs) {
    try {
      const value = await inspect();
      if (value !== undefined && value !== false) return value;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${errorText(lastError)}` : ""}`);
}
function positiveInteger(value, label) {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function now() {
  return new Date().toISOString();
}
function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
