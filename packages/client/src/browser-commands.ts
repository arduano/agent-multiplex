import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  canonicalJson,
  newArchiveOperationId,
  newCommandId,
  newLaunchId,
  newSessionId,
  toJsonValue,
  type ArchiveRequest,
  type CommandEnvelope,
  type Harness,
  type HarnessCommand,
  type JsonObject,
  type LaunchProfileIdentity,
  type LaunchRequest,
  type ResumeCommand,
  type RuntimeNodeId,
  type SessionRecord,
  type StopCommand,
} from "@arduano/agent-multiplex-protocol";

/**
 * Browser-safe command digest. It intentionally mirrors the Node helper's
 * JSON normalization and canonical encoding. Prefer the platform Web Crypto
 * implementation, then fall back to audited pure JavaScript for HTTP origins
 * where browsers withhold SubtleCrypto (for example, a tailnet-only UI).
 */
export async function payloadHash(payload: unknown): Promise<string> {
  const value = toJsonValue(JSON.parse(JSON.stringify(payload)) as unknown);
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    return bytesToHex(sha256(bytes));
  }
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Build a generic launch envelope whose digest is Node-compatible. */
export async function launchRequest(
  runtimeNodeId: RuntimeNodeId,
  profile: LaunchProfileIdentity,
  harness: Harness,
  input: JsonObject,
  metadata?: LaunchRequest["metadata"],
): Promise<LaunchRequest> {
  const sessionId = newSessionId();
  const launchId = newLaunchId();
  const body = {
    launchId,
    sessionId,
    runtimeNodeId,
    profile,
    harness,
    input,
    ...(metadata ? { metadata } : {}),
  };
  return { payloadHash: await payloadHash(body), ...body };
}

/** Build a provider-aware resume envelope fenced to a catalog binding. */
export async function resumeCommand(session: SessionRecord): Promise<ResumeCommand> {
  const commandId = newCommandId();
  const body = {
    operation: "resume" as const,
    sessionId: session.sessionId,
    runtimeNodeId: session.runtimeNodeId,
    bindingRevision: session.bindingRevision,
  };
  return { commandId, payloadHash: await payloadHash(body), ...body };
}

export async function stopCommand(session: SessionRecord): Promise<StopCommand> {
  const commandId = newCommandId();
  const body = {
    operation: "stop" as const,
    sessionId: session.sessionId,
    runtimeNodeId: session.runtimeNodeId,
    bindingRevision: session.bindingRevision,
  };
  return { commandId, payloadHash: await payloadHash(body), ...body };
}

export async function archiveRequest(session: SessionRecord): Promise<ArchiveRequest> {
  const archiveOperationId = newArchiveOperationId();
  const body = {
    archiveOperationId,
    sessionId: session.sessionId,
    runtimeNodeId: session.runtimeNodeId,
    bindingRevision: session.bindingRevision,
    expectedAuthority: session.metadataAuthority,
  };
  return { payloadHash: await payloadHash(body), ...body };
}

/** Build an active-session command envelope fenced to its current binding. */
export async function sessionCommand(
  session: SessionRecord,
  request: HarnessCommand,
  images?: CommandEnvelope["images"],
): Promise<CommandEnvelope> {
  const commandId = newCommandId();
  const body = {
    sessionId: session.sessionId,
    runtimeNodeId: session.runtimeNodeId,
    bindingRevision: session.bindingRevision,
    request,
    ...(images?.length ? { images } : {}),
  };
  return { commandId, payloadHash: await payloadHash(body), ...body };
}
