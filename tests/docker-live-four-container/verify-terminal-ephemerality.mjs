#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

const [
  rawReceiptDirectory,
  rawMarkerFile,
  rawAuthorityState,
  rawGatewayState,
  rawCodexRuntimeState,
  rawCopilotRuntimeState,
] = process.argv.slice(2);
if (
  !rawReceiptDirectory || !rawMarkerFile || !rawAuthorityState || !rawGatewayState ||
  !rawCodexRuntimeState || !rawCopilotRuntimeState
) {
  throw new Error(
    "usage: verify-terminal-ephemerality.mjs " +
      "<receipt-dir> <marker-file> <authority-state-dir> <gateway-state-dir> " +
      "<codex-runtime-state-dir> <copilot-runtime-state-dir>",
  );
}

const receiptDirectory = resolve(rawReceiptDirectory);
const marker = await readFile(resolve(rawMarkerFile), "utf8");
if (!marker || /[\r\n]/.test(marker)) {
  throw new Error("terminal ephemerality marker must be non-empty, single-line text");
}
const markerBytes = Buffer.from(marker, "utf8");
const markerSha256 = sha256Hex(markerBytes);
const browser = JSON.parse(await readFile(
  join(receiptDirectory, "phases", "browser-ui.json"),
  "utf8",
));
const browserCanary = browser.sessions?.codex?.terminal?.ephemeralDraft;
if (
  browserCanary?.sha256 !== markerSha256 ||
  browserCanary?.utf8Bytes !== markerBytes.byteLength ||
  browserCanary?.clearedBeforeSubmit !== true ||
  browserCanary?.valueRecordedInTextReceipt !== false
) {
  throw new Error("browser terminal canary receipt does not match the private marker file");
}

const surfaces = [
  {
    name: "canonical-authority-sqlite",
    files: await sqliteFiles(resolve(rawAuthorityState)),
    displayRoot: resolve(rawAuthorityState),
  },
  {
    name: "zero-authority-gateway-sqlite",
    files: await sqliteFiles(resolve(rawGatewayState)),
    displayRoot: resolve(rawGatewayState),
  },
  {
    name: "codex-runtime-sqlite",
    files: await sqliteFiles(resolve(rawCodexRuntimeState)),
    displayRoot: resolve(rawCodexRuntimeState),
  },
  {
    name: "copilot-runtime-sqlite",
    files: await sqliteFiles(resolve(rawCopilotRuntimeState)),
    displayRoot: resolve(rawCopilotRuntimeState),
  },
  {
    name: "native-history-api-responses",
    files: [
      join(receiptDirectory, "rpc", "native-history-codex.json"),
      join(receiptDirectory, "rpc", "native-history-copilot.json"),
    ],
    displayRoot: receiptDirectory,
  },
  {
    name: "gateway-fleet-event-journal",
    files: [join(receiptDirectory, "logs", "fleet-events.ndjson")],
    displayRoot: receiptDirectory,
  },
  {
    name: "sanitized-application-logs",
    files: [
      join(receiptDirectory, "logs", "control-node.log"),
      join(receiptDirectory, "logs", "access-gateway.log"),
      join(receiptDirectory, "logs", "codex-runtime-node.log"),
      join(receiptDirectory, "logs", "copilot-runtime-node.log"),
    ],
    displayRoot: receiptDirectory,
  },
  {
    name: "sanitized-browser-evidence",
    files: [
      join(receiptDirectory, "logs", "browser-actions.ndjson"),
      join(receiptDirectory, "logs", "browser-console.txt"),
      join(receiptDirectory, "logs", "browser-driver.log"),
      join(receiptDirectory, "phases", "browser-ui.json"),
    ],
    displayRoot: receiptDirectory,
  },
];

const results = [];
for (const surface of surfaces) {
  if (surface.files.length === 0) {
    throw new Error(`${surface.name} did not expose any files to scan`);
  }
  const files = [];
  let totalBytes = 0;
  let rawMatches = 0;
  let encodedMatches = 0;
  for (const filename of surface.files) {
    const content = await readFile(filename);
    const matches = findMarker(content, markerBytes);
    totalBytes += content.byteLength;
    rawMatches += matches.raw ? 1 : 0;
    encodedMatches += matches.base64 ? 1 : 0;
    files.push({
      file: relative(surface.displayRoot, filename).replaceAll("\\", "/") || basename(filename),
      bytes: content.byteLength,
      rawMarkerPresent: matches.raw,
      base64TerminalFramePresent: matches.base64,
    });
  }
  results.push({
    name: surface.name,
    filesChecked: files.length,
    totalBytes,
    rawMatches,
    encodedMatches,
    files,
  });
}

const assertions = {
  browserCanaryMatchedPrivateMarker: true,
  rawCanaryAbsentFromEveryDurableSurface:
    results.every((surface) => surface.rawMatches === 0),
  encodedCanaryAbsentFromEveryDurableSurface:
    results.every((surface) => surface.encodedMatches === 0),
  everyApplicationSqliteStoreScanned:
    results.filter((surface) => surface.name.endsWith("-sqlite"))
      .length === 4 &&
    results.filter((surface) => surface.name.endsWith("-sqlite"))
      .every((surface) => surface.filesChecked >= 1),
  nativeHistoryResponsesScanned:
    results.find((surface) => surface.name === "native-history-api-responses")
      ?.filesChecked === 2,
  gatewayFleetJournalScanned:
    results.find((surface) => surface.name === "gateway-fleet-event-journal")
      ?.filesChecked === 1,
  allApplicationLogsScanned:
    results.find((surface) => surface.name === "sanitized-application-logs")
      ?.filesChecked === 4,
  browserEvidenceContainsOnlyCanaryDigest:
    results.find((surface) => surface.name === "sanitized-browser-evidence")
      ?.filesChecked === 4,
};
const proof = {
  passed: Object.values(assertions).every((value) => value === true),
  checkedAt: new Date().toISOString(),
  invariant:
    "raw terminal frames are runtime-memory-only and never enter metadata, " +
    "fleet journals, application logs, or harness-native history",
  canary: {
    sha256: markerSha256,
    utf8Bytes: markerBytes.byteLength,
    submittedToHarness: false,
    rawValueRecorded: false,
  },
  encodingsChecked: ["raw UTF-8", "canonical base64 terminal-frame candidates"],
  surfaces: results,
  assertions,
};
await writeFile(
  join(receiptDirectory, "terminal-ephemerality.json"),
  `${JSON.stringify(proof, null, 2)}\n`,
  "utf8",
);
if (!proof.passed) {
  const failed = results
    .filter((surface) => surface.rawMatches > 0 || surface.encodedMatches > 0)
    .map((surface) => surface.name)
    .join(", ");
  throw new Error(`terminal canary reached forbidden durable surfaces: ${failed}`);
}
process.stdout.write(`${JSON.stringify({
  passed: true,
  markerSha256,
  markerRawValueRecorded: false,
  surfaces: results.map((surface) => ({
    name: surface.name,
    filesChecked: surface.filesChecked,
    totalBytes: surface.totalBytes,
  })),
}, null, 2)}\n`);

async function sqliteFiles(root) {
  const files = await regularFiles(root);
  return files.filter((filename) => /\.sqlite(?:-(?:wal|shm))?$/.test(basename(filename))).sort();
}

async function regularFiles(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const filename = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await regularFiles(filename));
    else if (entry.isFile() || entry.isSymbolicLink() && (await stat(filename)).isFile()) {
      output.push(filename);
    }
  }
  return output;
}

function findMarker(content, rawMarker) {
  if (content.includes(rawMarker)) return { raw: true, base64: false };
  const text = content.toString("latin1");
  const directBase64 = rawMarker.toString("base64");
  if (text.includes(directBase64)) return { raw: false, base64: true };

  // Terminal frames are canonical base64 JSON strings. Decode every plausible
  // token as well, so a marker embedded in a larger ANSI output frame is found
  // regardless of its three-byte alignment within that frame.
  const candidates = text.match(/(?:[A-Za-z0-9+/]{4}){8,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/g) ?? [];
  for (const candidate of candidates) {
    try {
      if (Buffer.from(candidate, "base64").includes(rawMarker)) {
        return { raw: false, base64: true };
      }
    } catch {
      // A permissive regex may encounter unrelated text. It is not a frame.
    }
  }
  return { raw: false, base64: false };
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}
