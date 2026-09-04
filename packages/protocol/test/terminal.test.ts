import { describe, expect, it } from "vitest";

import {
  TERMINAL_MAX_FRAME_BYTES,
  newRuntimeNodeId,
  newSessionId,
  newTerminalClientId,
  newTerminalId,
  newTerminalLeaseRequestId,
  terminalAttachInputSchema,
  terminalInputSchema,
  terminalLeaseAcquireInputSchema,
  terminalTerminateInputSchema,
} from "../src/index.js";

function target() {
  return {
    sessionId: newSessionId(),
    runtimeNodeId: newRuntimeNodeId(),
    bindingRevision: 1,
  };
}

describe("managed terminal protocol", () => {
  it("fences attach cursors to the exact terminal", () => {
    const terminalId = newTerminalId();
    expect(terminalAttachInputSchema.safeParse({
      ...target(),
      terminalId,
      cursor: { terminalId, sequence: 12 },
    }).success).toBe(true);
    expect(terminalAttachInputSchema.safeParse({
      ...target(),
      terminalId,
      cursor: { terminalId: newTerminalId(), sequence: 12 },
    }).success).toBe(false);
  });

  it("requires canonical, bounded UTF-8 terminal writes", () => {
    const base = {
      ...target(),
      terminalId: newTerminalId(),
      terminalClientId: newTerminalClientId(),
      credential: {
        terminalLeaseId: crypto.randomUUID(),
        token: "x".repeat(32),
      },
      inputSequence: 0,
      kind: "write" as const,
    };
    expect(terminalInputSchema.safeParse({
      ...base,
      dataBase64: Buffer.alloc(TERMINAL_MAX_FRAME_BYTES).toString("base64"),
    }).success).toBe(true);
    expect(terminalInputSchema.safeParse({
      ...base,
      dataBase64: Buffer.alloc(TERMINAL_MAX_FRAME_BYTES + 1).toString("base64"),
    }).success).toBe(false);
    expect(terminalInputSchema.safeParse({ ...base, dataBase64: "not base64" }).success)
      .toBe(false);
    expect(terminalInputSchema.safeParse({ ...base, dataBase64: "AB==" }).success)
      .toBe(false);
    expect(terminalInputSchema.safeParse({ ...base, dataBase64: "AAB=" }).success)
      .toBe(false);
    expect(terminalInputSchema.safeParse({
      ...base,
      dataBase64: Buffer.from([0xf0, 0x9f]).toString("base64"),
    }).success).toBe(false);
    expect(terminalInputSchema.safeParse({
      ...base,
      dataBase64: Buffer.from("😀", "utf8").toString("base64"),
    }).success).toBe(true);
  });

  it("does not decode malformed or oversized terminal writes", () => {
    const originalAtob = globalThis.atob;
    let decodeCalls = 0;
    globalThis.atob = (value) => {
      decodeCalls += 1;
      return originalAtob(value);
    };
    const base = {
      ...target(),
      terminalId: newTerminalId(),
      terminalClientId: newTerminalClientId(),
      credential: {
        terminalLeaseId: crypto.randomUUID(),
        token: "x".repeat(32),
      },
      inputSequence: 0,
      kind: "write" as const,
    };
    try {
      expect(terminalInputSchema.safeParse({ ...base, dataBase64: "not base64" }).success)
        .toBe(false);
      expect(terminalInputSchema.safeParse({
        ...base,
        dataBase64: Buffer.alloc(TERMINAL_MAX_FRAME_BYTES + 1).toString("base64"),
      }).success).toBe(false);
      expect(decodeCalls).toBe(0);
    } finally {
      globalThis.atob = originalAtob;
    }
  });

  it("requires termination's explicit CAS to match terminalId", () => {
    const terminalId = newTerminalId();
    const base = {
      ...target(),
      terminalId,
      terminalClientId: newTerminalClientId(),
    };
    expect(terminalTerminateInputSchema.safeParse({
      ...base,
      expectedTerminalId: terminalId,
    }).success).toBe(true);
    expect(terminalTerminateInputSchema.safeParse({
      ...base,
      expectedTerminalId: newTerminalId(),
    }).success).toBe(false);
  });

  it("requires a caller-stable lease acquisition request identity", () => {
    const input = {
      ...target(),
      terminalId: newTerminalId(),
      terminalClientId: newTerminalClientId(),
      requestId: newTerminalLeaseRequestId(),
    };
    expect(terminalLeaseAcquireInputSchema.safeParse(input).success).toBe(true);
    const { requestId: _requestId, ...missingRequestId } = input;
    void _requestId;
    expect(terminalLeaseAcquireInputSchema.safeParse(missingRequestId).success)
      .toBe(false);
  });
});
