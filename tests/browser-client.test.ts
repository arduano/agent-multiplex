import { afterEach, describe, expect, it, vi } from "vitest";

import {
  payloadHash as nodePayloadHash,
} from "@arduano/agent-multiplex-client";
import {
  archiveRequest,
  launchRequest,
  payloadHash,
  resumeCommand,
  sessionCommand,
  stopCommand,
} from "@arduano/agent-multiplex-client/browser";
import {
  archiveRequestSchema,
  commandEnvelopeSchema,
  emptyMetadataSnapshot,
  launchRequestSchema,
  newAuthorityEpochId,
  newControlNodeId,
  newRealmId,
  newRuntimeNodeId,
  newSessionId,
  resumeCommandSchema,
  sessionRecordSchema,
  stopCommandSchema,
  type RuntimeNodeId,
  type SessionId,
} from "@arduano/agent-multiplex-protocol";

const launchProfile = {
  profileId: "workspace",
  providerId: "core.direct",
  contractVersion: 1,
  requestSchemaHash: "a".repeat(64),
};

function stoppedSession(runtimeNodeId: RuntimeNodeId, sessionId: SessionId) {
  return sessionRecordSchema.parse({
    sessionId,
    runtimeNodeId,
    harness: "copilot",
    adapterScopeId: "copilot:test",
    vendorSessionId: "native-session",
    bindingRevision: 3,
    runtimeEpoch: null,
    cwd: "/workspace/project",
    availability: "resumable",
    runtimeStatus: "stopped",
    metadata: emptyMetadataSnapshot(),
    metadataAuthority: {
      realmId: newRealmId(),
      controlNodeId: newControlNodeId(),
      epochId: newAuthorityEpochId(),
    },
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    lastSeenAt: null,
  });
}

describe("browser command builders", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hashes canonical JSON with exact Node helper parity", async () => {
    const payload = {
      z: [true, null, { beta: "two", alpha: 1 }],
      a: { nested: "value", number: 42.5 },
    };

    await expect(payloadHash(payload)).resolves.toBe(nodePayloadHash(payload));
  });

  it("hashes with exact Node parity when an HTTP origin has no SubtleCrypto", async () => {
    const platformCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: platformCrypto.getRandomValues.bind(platformCrypto),
    });
    const payload = {
      unicode: "tailnet 🚀",
      nested: { z: null, a: [3, 2, 1] },
    };

    expect(globalThis.crypto.subtle).toBeUndefined();
    await expect(payloadHash(payload)).resolves.toBe(nodePayloadHash(payload));
  });

  it("builds a valid launch request without SubtleCrypto", async () => {
    const platformCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: platformCrypto.getRandomValues.bind(platformCrypto),
    });
    const runtimeNodeId = newRuntimeNodeId();
    const request = await launchRequest(
      runtimeNodeId,
      launchProfile,
      "codex",
      { cwd: "/workspace/project" },
      { "agent.title": "Tailnet HTTP session" },
    );

    expect(launchRequestSchema.parse(request)).toEqual(request);
    expect(request.payloadHash).toBe(nodePayloadHash({
      launchId: request.launchId,
      sessionId: request.sessionId,
      runtimeNodeId,
      profile: launchProfile,
      harness: "codex",
      input: request.input,
      metadata: request.metadata,
    }));
  });

  it("builds a valid launch request with the canonical Node payload hash", async () => {
    const runtimeNodeId = newRuntimeNodeId();
    const request = await launchRequest(
      runtimeNodeId,
      launchProfile,
      "codex",
      {
        cwd: "/workspace/project",
        model: "gpt-5.6-sol",
        effort: "high",
      },
      { "agent.title": "Browser session", "ui.pinned": true },
    );

    expect(launchRequestSchema.parse(request)).toEqual(request);
    expect(request.payloadHash).toBe(nodePayloadHash({
      launchId: request.launchId,
      sessionId: request.sessionId,
      runtimeNodeId,
      profile: launchProfile,
      harness: "codex",
      input: request.input,
      metadata: request.metadata,
    }));
  });

  it("builds provider-routed resume, stop, and archive envelopes from a binding", async () => {
    const runtimeNodeId = newRuntimeNodeId();
    const sessionId = newSessionId();
    const session = stoppedSession(runtimeNodeId, sessionId);
    const command = await resumeCommand(session);

    expect(resumeCommandSchema.parse(command)).toEqual(command);
    expect(command.sessionId).toBe(sessionId);
    expect(command.payloadHash).toBe(nodePayloadHash({
      operation: "resume",
      sessionId,
      runtimeNodeId,
      bindingRevision: session.bindingRevision,
    }));

    const stop = await stopCommand(session);
    expect(stopCommandSchema.parse(stop)).toEqual(stop);
    expect(stop.payloadHash).toBe(nodePayloadHash({
      operation: "stop",
      sessionId,
      runtimeNodeId,
      bindingRevision: session.bindingRevision,
    }));

    const archive = await archiveRequest(session);
    expect(archiveRequestSchema.parse(archive)).toEqual(archive);
    expect(archive.payloadHash).toBe(nodePayloadHash({
      archiveOperationId: archive.archiveOperationId,
      sessionId,
      runtimeNodeId,
      bindingRevision: session.bindingRevision,
      expectedAuthority: session.metadataAuthority,
    }));
  });

  it("builds a binding-fenced active-session command", async () => {
    const runtimeNodeId = newRuntimeNodeId();
    const session = stoppedSession(runtimeNodeId, newSessionId());
    const request = {
      harness: "copilot" as const,
      command: { type: "send" as const, prompt: "Hello", mode: "enqueue" as const },
    };
    const command = await sessionCommand(session, request);

    expect(commandEnvelopeSchema.parse(command)).toEqual(command);
    expect(command.bindingRevision).toBe(3);
    expect(command.payloadHash).toBe(nodePayloadHash({
      sessionId: session.sessionId,
      runtimeNodeId,
      bindingRevision: 3,
      request,
    }));
  });
});
