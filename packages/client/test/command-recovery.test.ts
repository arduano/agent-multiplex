import {
  newCommandId,
  newRuntimeNodeId,
  newSessionId,
  toJsonValue,
  type CommandEnvelope,
  type CommandRecord,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it, vi } from "vitest";

import { assertCommandReceipt, readCommandReceipt } from "../src/command-recovery.js";

const envelope: CommandEnvelope = {
  commandId: newCommandId(),
  sessionId: newSessionId(),
  runtimeNodeId: newRuntimeNodeId(),
  bindingRevision: 2,
  payloadHash: "c".repeat(64),
  request: { harness: "copilot", command: { type: "send", prompt: "fixture" } },
};
const receipt: CommandRecord = {
  commandId: envelope.commandId,
  sessionId: envelope.sessionId,
  runtimeNodeId: envelope.runtimeNodeId,
  payloadHash: envelope.payloadHash,
  request: toJsonValue(envelope),
  state: "outcomeUnknown",
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:00.000Z",
};

describe("read-only command recovery", () => {
  it("looks up the exact identity once without dispatch, including missing and unknown results", async () => {
    const query = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(receipt);
    const mutate = vi.fn();
    const client = { commands: { get: { query } }, sessions: { execute: { mutate } } };
    await expect(readCommandReceipt(client, envelope)).resolves.toBeNull();
    await expect(readCommandReceipt(client, envelope)).resolves.toEqual(receipt);
    expect(query.mock.calls).toEqual([[envelope.commandId], [envelope.commandId]]);
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each([
    { commandId: newCommandId() },
    { sessionId: newSessionId() },
    { runtimeNodeId: newRuntimeNodeId() },
    { payloadHash: "d".repeat(64) },
    { request: toJsonValue({ ...envelope, bindingRevision: 1 }) },
    { request: toJsonValue({ ...envelope, request: { harness: "copilot", command: { type: "send", prompt: "other" } } }) },
  ])("rejects a mismatched immutable receipt without revealing payloads: %j", (changed) => {
    expect(() => assertCommandReceipt(envelope, { ...receipt, ...changed }))
      .toThrow("The command receipt does not match the original command");
  });

  it("accepts a later terminal receipt with identical immutable identity", async () => {
    const terminal = { ...receipt, state: "succeeded" as const, updatedAt: "2026-09-22T00:00:01.000Z" };
    await expect(readCommandReceipt({ commands: { get: { query: async () => terminal } } }, envelope))
      .resolves.toEqual(terminal);
  });
});
