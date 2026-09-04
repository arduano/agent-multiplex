import { describe, expect, it } from "vitest";

import {
  TERMINAL_MAX_FRAME_BYTES,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  newTerminalClientId,
  newTerminalId,
  newTerminalLeaseRequestId,
  terminalAttachInputSchema,
  terminalInputSchema,
  terminalLeaseAcquireInputSchema,
  terminalStreamItemSchema,
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

  it("distinguishes exact opening-state replay from synthesized resets", () => {
    const terminalId = newTerminalId();
    const terminalTarget = target();
    const openedAt = "2026-09-04T00:00:00.000Z";
    const terminal = {
      ...terminalTarget,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      terminalId,
      backend: "codex-remote" as const,
      sharing: "session" as const,
      foregroundSessionId: null,
      state: "running" as const,
      dimensions: { columns: 120, rows: 40 },
      sequence: 7,
      lease: null,
      capabilities: {
        write: true,
        resize: true,
        terminate: true,
        restart: true,
        foregroundSwitch: false,
      },
      openedAt,
      updatedAt: openedAt,
      exit: null,
    };

    expect(terminalStreamItemSchema.safeParse({
      kind: "replayStart",
      cursor: { terminalId, sequence: 0 },
      initialDimensions: { columns: 80, rows: 24 },
      terminal,
    }).success).toBe(true);
    expect(terminalStreamItemSchema.safeParse({
      kind: "replayStart",
      cursor: { terminalId, sequence: 1 },
      initialDimensions: { columns: 80, rows: 24 },
      terminal,
    }).success).toBe(false);
    expect(terminalStreamItemSchema.safeParse({
      kind: "replayEnd",
      cursor: { terminalId, sequence: 7 },
      terminal,
    }).success).toBe(true);
    expect(terminalStreamItemSchema.safeParse({
      kind: "reset",
      reason: "cursorExpired",
      fidelity: "synthesized",
      cursor: { terminalId, sequence: 7 },
      screenBase64: "",
      terminal,
    }).success).toBe(true);
  });

  it.each(["replayStart", "replayEnd", "reset", "changed"] as const)(
    "couples a %s descriptor to its cursor terminal",
    (kind) => {
      const terminalId = newTerminalId();
      const otherTerminalId = newTerminalId();
      const openedAt = "2026-09-04T00:00:00.000Z";
      const terminal = {
        ...target(),
        runtimeNodeBootId: newRuntimeNodeBootId(),
        terminalId: otherTerminalId,
        backend: "mock" as const,
        sharing: "session" as const,
        foregroundSessionId: null,
        state: "running" as const,
        dimensions: { columns: 80, rows: 24 },
        sequence: 7,
        lease: null,
        capabilities: {
          write: true,
          resize: true,
          terminate: true,
          restart: true,
          foregroundSwitch: false,
        },
        openedAt,
        updatedAt: openedAt,
        exit: null,
      };
      const common = {
        kind,
        cursor: { terminalId, sequence: kind === "replayStart" ? 0 : 7 },
        terminal,
      };
      const value = kind === "replayStart"
        ? { ...common, initialDimensions: { columns: 80, rows: 24 } }
        : kind === "reset"
          ? {
              ...common,
              reason: "initial" as const,
              fidelity: "synthesized" as const,
              screenBase64: "",
            }
          : common;

      expect(terminalStreamItemSchema.safeParse(value).success).toBe(false);
    },
  );

  it.each(["replayEnd", "reset", "changed"] as const)(
    "couples a %s descriptor sequence to its cursor",
    (kind) => {
      const terminalId = newTerminalId();
      const openedAt = "2026-09-04T00:00:00.000Z";
      const terminal = {
        ...target(),
        runtimeNodeBootId: newRuntimeNodeBootId(),
        terminalId,
        backend: "mock" as const,
        sharing: "session" as const,
        foregroundSessionId: null,
        state: "running" as const,
        dimensions: { columns: 80, rows: 24 },
        sequence: 8,
        lease: null,
        capabilities: {
          write: true,
          resize: true,
          terminate: true,
          restart: true,
          foregroundSwitch: false,
        },
        openedAt,
        updatedAt: openedAt,
        exit: null,
      };
      const common = {
        kind,
        cursor: { terminalId, sequence: 7 },
        terminal,
      };
      const value = kind === "reset"
        ? {
            ...common,
            reason: "cursorExpired" as const,
            fidelity: "synthesized" as const,
            screenBase64: "",
          }
        : common;

      expect(terminalStreamItemSchema.safeParse(value).success).toBe(false);
    },
  );

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
