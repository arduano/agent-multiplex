import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgentAdapter } from "@arduano/agent-multiplex-adapter-mock";
import { DirectWorkspaceLaunchProvider, RuntimeNodeService, RuntimeNodeStore, runtimeBackendForAdapter } from "@arduano/agent-multiplex-runtime-node-core";
import { expect, it, vi } from "vitest";
import { configFromEnvironment, runRuntimeNode } from "../apps/runtime-node/src/main.js";

it("uses injected providers and retains daemon-owned shutdown and SQLite cleanup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "multiplex-runtime-components-"));
  const adapter = new MockAgentAdapter();
  const close = vi.spyOn(adapter, "close");
  const config = configFromEnvironment({
    AGENT_MULTIPLEX_SHARED_SECRET: "x".repeat(32),
    AGENT_MULTIPLEX_CONTROL_NODE_ENDPOINT_ID: "fixture-endpoint", AGENT_MULTIPLEX_CONTROL_NODE_TICKET: "fixture-ticket",
    AGENT_MULTIPLEX_RUNTIME_NODE_STATE_DIR: directory,
    AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS: JSON.stringify([directory]),
    AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES: "codex",
  });
  const describe = vi.spyOn(RuntimeNodeService.prototype, "describe").mockImplementation(async function (this: RuntimeNodeService) {
    expect(this.launchProfiles().map((profile) => profile.profileId)).toEqual(["custom"]);
    throw new Error("fixture stops before transport startup");
  });
  try {
    await expect(runRuntimeNode(config, new AbortController().signal, { createComponents: (canonical) => {
      expect(canonical.allowedRoots).toEqual([directory]);
      return { adapters: [adapter], terminalProviders: [], includeDirectWorkspaceProvider: false,
        launchProviders: [new DirectWorkspaceLaunchProvider({ backends: [runtimeBackendForAdapter(adapter)], profileId: "custom" })] };
    } })).rejects.toThrow("fixture stops");
    expect(close).toHaveBeenCalledOnce();
    const store = new RuntimeNodeStore(join(directory, "runtime-node.sqlite")); store.close();
    await expect(runRuntimeNode(config, new AbortController().signal, { createComponents: () => { throw new Error("factory failed"); } })).rejects.toThrow("factory failed");
    const reopened = new RuntimeNodeStore(join(directory, "runtime-node.sqlite")); reopened.close();
    const invalidAdapter = new MockAgentAdapter();
    const invalidClose = vi.spyOn(invalidAdapter, "close");
    const duplicate = new DirectWorkspaceLaunchProvider({ backends: [runtimeBackendForAdapter(invalidAdapter)] });
    await expect(runRuntimeNode(config, new AbortController().signal, { createComponents: () => ({
      adapters: [invalidAdapter], terminalProviders: [], launchProviders: [duplicate, duplicate], includeDirectWorkspaceProvider: false,
    }) })).rejects.toThrow("duplicate launch profile");
    expect(invalidClose).toHaveBeenCalledOnce();
    const afterInvalid = new RuntimeNodeStore(join(directory, "runtime-node.sqlite")); afterInvalid.close();
  } finally { describe.mockRestore(); close.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
});
