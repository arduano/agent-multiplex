import { describe, expect, it } from "vitest";

import {
  newControlNodeId,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  newTerminalClientId,
  newTerminalId,
  newTerminalLeaseId,
  terminalDescriptorSchema,
  type RuntimeNodeDescriptor,
  type TerminalDescriptor,
} from "@arduano/agent-multiplex-protocol";
import {
  mergeTerminalLease,
  reconcileTerminalDescriptor,
  reduceTerminalReplayView,
  shouldQueryTerminal,
  terminalSideChannelCapability,
} from "../apps/web/src/client/terminal-state.js";

describe("web terminal state", () => {
  it("does not let a late query snapshot regress a streamed descriptor", () => {
    const terminalId = newTerminalId();
    const streamed = descriptor({ terminalId, sequence: 9, state: "exited" });
    const staleQuery = descriptor({ terminalId, sequence: 4, state: "running" });

    expect(reconcileTerminalDescriptor(staleQuery, streamed)).toBe(streamed);
  });

  it("does not let an older terminal query replace a newly opened stream", () => {
    const oldQuery = descriptor({
      terminalId: newTerminalId(),
      sequence: 20,
      openedAt: "2026-09-04T00:00:00.000Z",
    });
    const newStream = descriptor({
      terminalId: newTerminalId(),
      sequence: 0,
      openedAt: "2026-09-04T00:01:00.000Z",
    });

    expect(reconcileTerminalDescriptor(oldQuery, newStream)).toBe(newStream);
    expect(reconcileTerminalDescriptor(newStream, oldQuery)).toBe(newStream);
  });

  it("merges a lease without regressing lifecycle or output fields", () => {
    const current = descriptor({ sequence: 14, state: "exited" });
    const lease = {
      terminalLeaseId: newTerminalLeaseId(),
      terminalClientId: newTerminalClientId(),
      expiresAt: "2026-09-04T00:02:00.000Z",
    };
    const merged = mergeTerminalLease(current, current.terminalId, lease);

    expect(merged).toEqual({ ...current, lease });
    expect(merged).toMatchObject({ sequence: 14, state: "exited", exit: current.exit });
    expect(mergeTerminalLease(current, newTerminalId(), lease)).toBe(current);
  });

  it("waits for capability discovery and never queries unsupported runtimes", () => {
    expect(shouldQueryTerminal(true, undefined)).toBe(false);
    expect(shouldQueryTerminal(true, null)).toBe(false);
    expect(shouldQueryTerminal(false, { experimental: false })).toBe(false);
    expect(shouldQueryTerminal(true, { experimental: false })).toBe(true);

    expect(terminalSideChannelCapability(undefined, "codex")).toBeUndefined();
    expect(terminalSideChannelCapability(runtime([]), "codex")).toBeNull();
    expect(terminalSideChannelCapability(runtime([
      { name: "terminal.side-channel", version: "v1", experimental: true },
    ]), "codex")).toEqual({ experimental: true });
  });

  it("keeps opening dimensions until an exact replay applies ordered resizes", () => {
    const terminalId = newTerminalId();
    const current = descriptor({
      terminalId,
      sequence: 3,
      dimensions: { columns: 120, rows: 40 },
    });
    const opening = { columns: 80, rows: 24 };
    let view = {
      ready: true,
      dimensions: current.dimensions,
      terminal: null as TerminalDescriptor | null,
    };

    view = reduceTerminalReplayView(view, {
      kind: "replayStart",
      cursor: { terminalId, sequence: 0 },
      initialDimensions: opening,
      terminal: current,
    });
    expect(view).toEqual({ ready: false, dimensions: opening, terminal: null });

    view = reduceTerminalReplayView(view, {
      kind: "output",
      cursor: { terminalId, sequence: 1 },
      dataBase64: "eA==",
    });
    expect(view.dimensions).toEqual(opening);
    expect(view.terminal).toBeNull();

    view = reduceTerminalReplayView(view, {
      kind: "resize",
      cursor: { terminalId, sequence: 2 },
      dimensions: { columns: 100, rows: 30 },
    });
    expect(view).toMatchObject({
      ready: false,
      dimensions: { columns: 100, rows: 30 },
      terminal: null,
    });

    view = reduceTerminalReplayView(view, {
      kind: "replayEnd",
      cursor: { terminalId, sequence: 3 },
      terminal: current,
    });
    expect(view).toEqual({
      ready: true,
      dimensions: current.dimensions,
      terminal: current,
    });
  });
});

function descriptor(overrides: Partial<TerminalDescriptor> = {}): TerminalDescriptor {
  const openedAt = overrides.openedAt ?? "2026-09-04T00:00:00.000Z";
  return terminalDescriptorSchema.parse({
    sessionId: newSessionId(),
    runtimeNodeId: newRuntimeNodeId(),
    bindingRevision: 1,
    runtimeNodeBootId: newRuntimeNodeBootId(),
    terminalId: newTerminalId(),
    backend: "codex-remote",
    sharing: "session",
    foregroundSessionId: null,
    state: "running",
    dimensions: { columns: 100, rows: 30 },
    sequence: 1,
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
    exit: overrides.state === "exited"
      ? { exitCode: 0, signal: null }
      : null,
    ...overrides,
  });
}

function runtime(
  capabilities: RuntimeNodeDescriptor["harnesses"][number]["capabilities"],
): RuntimeNodeDescriptor {
  return {
    runtimeNodeId: newRuntimeNodeId(),
    runtimeNodeBootId: newRuntimeNodeBootId(),
    ownerControlNodeId: newControlNodeId(),
    name: "terminal-test-runtime",
    presence: "online",
    reachability: "reachable",
    connectedAt: "2026-09-04T00:00:00.000Z",
    lastHeartbeatAt: "2026-09-04T00:00:00.000Z",
    allowedRoots: ["/workspace"],
    harnesses: [{
      harness: "codex",
      adapterScopeId: "codex:test",
      available: true,
      capabilities,
    }],
    launchProfiles: [],
    protocolVersion: 4,
  };
}
