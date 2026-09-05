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
  type HarnessCommand,
  type Harness,
  type JsonObject,
  type LaunchProfileIdentity,
  type LaunchRequest,
  type ResumeCommand,
  type SessionRecord,
  type StopCommand,
  type RuntimeNodeId,
} from "@arduano/agent-multiplex-protocol";

export function payloadHash(payload: unknown): string {
  const value = toJsonValue(JSON.parse(JSON.stringify(payload)) as unknown);
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value))));
}

/** Build one generic launch request for an explicitly selected runtime/profile. */
export function launchRequest(
  runtimeNodeId: RuntimeNodeId,
  profile: LaunchProfileIdentity,
  harness: Harness,
  input: JsonObject,
  metadata?: LaunchRequest["metadata"],
): LaunchRequest {
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
  return { payloadHash: payloadHash(body), ...body };
}

export function resumeCommand(
  session: SessionRecord,
): ResumeCommand {
  const commandId = newCommandId();
  const body = {
    operation: "resume" as const,
    sessionId: session.sessionId,
    runtimeNodeId: session.runtimeNodeId,
    bindingRevision: session.bindingRevision,
  };
  return { commandId, payloadHash: payloadHash(body), ...body };
}

export function stopCommand(session: SessionRecord): StopCommand {
  const commandId = newCommandId();
  const body = {
    operation: "stop" as const,
    sessionId: session.sessionId,
    runtimeNodeId: session.runtimeNodeId,
    bindingRevision: session.bindingRevision,
  };
  return { commandId, payloadHash: payloadHash(body), ...body };
}

export function archiveRequest(session: SessionRecord): ArchiveRequest {
  const archiveOperationId = newArchiveOperationId();
  const body = {
    archiveOperationId,
    sessionId: session.sessionId,
    runtimeNodeId: session.runtimeNodeId,
    bindingRevision: session.bindingRevision,
    expectedAuthority: session.metadataAuthority,
  };
  return { payloadHash: payloadHash(body), ...body };
}

export function sessionCommand(session: SessionRecord, request: HarnessCommand, images?: CommandEnvelope["images"]) {
  const commandId = newCommandId();
  const body = {
    sessionId: session.sessionId,
    runtimeNodeId: session.runtimeNodeId,
    bindingRevision: session.bindingRevision,
    request,
    ...(images?.length ? { images } : {}),
  };
  return { commandId, payloadHash: payloadHash(body), ...body };
}
