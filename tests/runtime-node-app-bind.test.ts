import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgentAdapter } from "@arduano/agent-multiplex-adapter-mock";
import { createMultiplexP2PNode } from "@arduano/agent-multiplex-transport-p2prpc";
import { expect, it, vi } from "vitest";
import { configFromEnvironment, runRuntimeNode } from "../apps/runtime-node/src/main.js";

vi.mock("@arduano/agent-multiplex-transport-p2prpc", async importOriginal => ({
  ...await importOriginal<object>(),
  createMultiplexP2PNode: vi.fn(async () => { throw new Error("fixture stops at transport creation"); }),
}));

it("passes an explicit runtime listener to native transport without changing trust or relay policy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "multiplex-runtime-bind-"));
  const config = configFromEnvironment({
    AGENT_MULTIPLEX_SHARED_SECRET: "x".repeat(32),
    AGENT_MULTIPLEX_CONTROL_NODE_ENDPOINT_ID: "fixture-endpoint", AGENT_MULTIPLEX_CONTROL_NODE_TICKET: "fixture-ticket",
    AGENT_MULTIPLEX_RUNTIME_NODE_STATE_DIR: directory,
    AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS: JSON.stringify([directory]),
    AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES: "codex",
    AGENT_MULTIPLEX_RUNTIME_NODE_P2P_BIND: "127.0.0.1:0",
  });
  try {
    await expect(runRuntimeNode(config, new AbortController().signal, {
      createComponents: () => ({ adapters: [new MockAgentAdapter()], terminalProviders: [] }),
    })).rejects.toThrow("fixture stops at transport creation");
    const options = vi.mocked(createMultiplexP2PNode).mock.calls[0]![0];
    expect(options.iroh).toMatchObject({ bindAddress: "127.0.0.1:0", relay: { mode: "default" } });
    expect(options.preAuthorizePeer?.({ id: "fixture-endpoint" } as never)).toBe(true);
    expect(options.preAuthorizePeer?.({ id: "another-endpoint" } as never)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
