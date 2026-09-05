import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeNodeService, RuntimeNodeStore } from "@arduano/agent-multiplex-runtime-node-core";
import { expect, it, vi } from "vitest";

import { configFromEnvironment, runRuntimeNode } from "../apps/runtime-node/src/main.js";

it("releases the runtime SQLite writer lock even when service shutdown fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-multiplex-runtime-app-shutdown-"));
  const failure = new Error("service cleanup failed");
  // Fail before opening transport: this exercises the app's real store ownership
  // without native processes, peers, or a listening network endpoint.
  const describe = vi.spyOn(RuntimeNodeService.prototype, "describe")
    .mockRejectedValue(new Error("startup discovery failed"));
  const close = vi.spyOn(RuntimeNodeService.prototype, "close").mockRejectedValue(failure);
  try {
    const config = configFromEnvironment({
      AGENT_MULTIPLEX_SHARED_SECRET: "x".repeat(32),
      AGENT_MULTIPLEX_CONTROL_NODE_ENDPOINT_ID: "test-control-node-endpoint",
      AGENT_MULTIPLEX_CONTROL_NODE_TICKET: "test-control-node-ticket",
      AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS: JSON.stringify([directory]),
      AGENT_MULTIPLEX_RUNTIME_NODE_STATE_DIR: directory,
      AGENT_MULTIPLEX_RUNTIME_NODE_ADAPTER_MODE: "mock",
      AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES: "codex",
    });
    await expect(runRuntimeNode(config, new AbortController().signal)).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
    const reopened = new RuntimeNodeStore(join(directory, "runtime-node.sqlite"));
    reopened.close();
  } finally {
    describe.mockRestore();
    close.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
