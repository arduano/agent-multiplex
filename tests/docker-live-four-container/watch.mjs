#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { access, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";

import { createAccessClient, watchAccess } from "@arduano/agent-multiplex-client";
import { WebSocket as NodeWebSocket } from "ws";

const [httpUrl, rawReceiptDirectory, rawTimeoutMs] = process.argv.slice(2);
if (!httpUrl || !rawReceiptDirectory || !rawTimeoutMs) {
  throw new Error("usage: watch.mjs <gateway-trpc-url> <receipt-dir> <timeout-ms>");
}
const timeoutMs = positiveInteger(rawTimeoutMs, "timeout-ms");
const receiptDirectory = resolve(rawReceiptDirectory);
const tokenFile = process.env.AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE;
if (!tokenFile) {
  throw new Error("AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE is required");
}
const bearerToken = (await readFile(tokenFile, "utf8")).trim();
if (!bearerToken || /\s/.test(bearerToken)) {
  throw new Error("acceptance bearer token is empty or contains whitespace");
}

const paths = {
  events: join(receiptDirectory, "logs", "fleet-events.ndjson"),
  states: join(receiptDirectory, "logs", "watcher-states.ndjson"),
  ready: join(receiptDirectory, "coord", "watcher-ready.json"),
  stop: join(receiptDirectory, "coord", "watcher-stop.json"),
  summary: join(receiptDirectory, "phases", "watcher-summary.json"),
  failure: join(receiptDirectory, "watcher-failure.json"),
};
await Promise.all([
  mkdir(dirname(paths.events), { recursive: true }),
  mkdir(dirname(paths.ready), { recursive: true }),
  mkdir(dirname(paths.summary), { recursive: true }),
]);

const eventOutput = createWriteStream(paths.events, { flags: "w", encoding: "utf8" });
const stateOutput = await open(paths.states, "w");
let itemCount = 0;
let nativeCount = 0;
let nativeGapCount = 0;
let websocketOpenCount = 0;
let websocketCloseCount = 0;
let readyWritten = false;
let readyScheduled = false;
let stoppedBySignal = false;
let acceptEvidenceWrites = true;
let evidenceWriteError;
let evidenceWrites = Promise.resolve();
let watcher;

class TrackedWebSocket extends NodeWebSocket {}

const clientHandle = createAccessClient({
  httpUrl,
  wsUrl: httpUrl.replace(/^http/, "ws"),
  bearerToken,
  WebSocket: TrackedWebSocket,
  onWebSocketOpen: () => {
    websocketOpenCount += 1;
    enqueueEvidence(() =>
      appendState({ source: "websocket", state: "open", count: websocketOpenCount })
    );
  },
  onWebSocketClose: (cause) => {
    websocketCloseCount += 1;
    enqueueEvidence(() =>
      appendState({
        source: "websocket",
        state: "closed",
        count: websocketCloseCount,
        cause: cause ?? null,
      })
    );
  },
});

const stopForSignal = () => {
  stoppedBySignal = true;
  watcher?.stop();
};
process.once("SIGINT", stopForSignal);
process.once("SIGTERM", stopForSignal);

try {
  watcher = watchAccess(clientHandle.client.sessions.watch, {
    sessions: "all",
    includeNative: true,
    initialRetryDelayMs: 100,
    maxRetryDelayMs: 1_000,
    retryJitter: 0,
    maxPendingItems: 8_192,
    onStateChange: (state) => {
      enqueueEvidence(() =>
        appendState({ source: "subscription", ...serializableState(state) })
      );
      if (state.state === "live" && !readyScheduled) {
        readyScheduled = true;
        enqueueEvidence(async () => {
          await writeJson(paths.ready, {
            readyAt: now(),
            state: "live",
            watchesAllSessions: true,
            includesNative: true,
          });
          readyWritten = true;
        });
      }
    },
    onItem: async (item) => {
      itemCount += 1;
      if (item.kind === "native") nativeCount += 1;
      if (item.kind === "nativeGap") nativeGapCount += 1;
      const line = `${JSON.stringify({ receivedAt: now(), ...item })}\n`;
      if (!eventOutput.write(line)) await once(eventOutput, "drain");
    },
  });

  await waitForReady(timeoutMs);
  await waitForStopFile(timeoutMs);
  watcher.stop();
  await watcher.done;
  await closeWriteStream(eventOutput);
  await drainEvidenceWrites();
  await writeJson(paths.summary, {
    passed: true,
    stoppedAt: now(),
    stoppedBySignal,
    itemCount,
    nativeCount,
    nativeGapCount,
    websocketOpenCount,
    websocketCloseCount,
    finalCursor: watcher.cursor ?? null,
  });
} catch (error) {
  watcher?.stop();
  await watcher?.done.catch(() => undefined);
  await closeWriteStream(eventOutput).catch(() => undefined);
  await writeJson(paths.failure, {
    failedAt: now(),
    error: errorText(error),
    itemCount,
    nativeCount,
    nativeGapCount,
  }).catch(() => undefined);
  throw error;
} finally {
  process.removeListener("SIGINT", stopForSignal);
  process.removeListener("SIGTERM", stopForSignal);
  acceptEvidenceWrites = false;
  clientHandle.close();
  await evidenceWrites.catch(() => undefined);
  await stateOutput.close().catch(() => undefined);
}

async function waitForReady(limitMs) {
  const started = Date.now();
  while (!readyWritten) {
    if (evidenceWriteError) throw evidenceWriteError;
    if (watcher?.state.state === "failed") {
      throw new Error(`fleet watcher failed: ${errorText(watcher.state.error)}`);
    }
    if (Date.now() - started > limitMs) {
      throw new Error("timed out waiting for the fleet watcher to become live");
    }
    await delay(50);
  }
}

async function waitForStopFile(limitMs) {
  const started = Date.now();
  while (true) {
    if (evidenceWriteError) throw evidenceWriteError;
    if (stoppedBySignal) return;
    try {
      await access(paths.stop);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (watcher?.state.state === "failed") {
      throw new Error(`fleet watcher failed: ${errorText(watcher.state.error)}`);
    }
    if (Date.now() - started > limitMs) {
      throw new Error("timed out waiting for the browser phase to finish");
    }
    await delay(100);
  }
}

async function appendState(value) {
  await stateOutput.appendFile(`${JSON.stringify({ at: now(), ...value })}\n`, "utf8");
}

function enqueueEvidence(write) {
  if (!acceptEvidenceWrites) return;
  evidenceWrites = evidenceWrites
    .then(write)
    .catch((error) => {
      evidenceWriteError ??= error;
    });
}

async function drainEvidenceWrites() {
  await evidenceWrites;
  if (evidenceWriteError) throw evidenceWriteError;
}

function serializableState(state) {
  if (state.state === "retrying") {
    return { ...state, error: errorText(state.error) };
  }
  if (state.state === "failed") {
    return { ...state, error: errorText(state.error) };
  }
  return state;
}

function closeWriteStream(stream) {
  return new Promise((resolveClose, rejectClose) => {
    stream.once("error", rejectClose);
    stream.end(() => resolveClose());
  });
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

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function now() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
