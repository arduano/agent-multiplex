import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlNodeCatalog } from "@arduano/agent-multiplex-control-node-core";
import { expect, it, vi } from "vitest";
import { controlNodeConfigFromEnvironment } from "../apps/control-node/src/config.js";
import { runControlNode } from "../apps/control-node/src/main.js";

const transport = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  createTicket: vi.fn(async () => "fixture-private-locator"),
}));
vi.mock("@arduano/agent-multiplex-transport-p2prpc", async (original) => ({
  ...await original<typeof import("@arduano/agent-multiplex-transport-p2prpc")>(),
  createControlNodeP2PNode: vi.fn(async () => ({ id: "fixture-endpoint", ...transport })),
}));

it("hands private provisioning to the embedding application and cleans up failed callbacks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "multiplex-control-ready-"));
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const config = { ...controlNodeConfigFromEnvironment({
    AGENT_MULTIPLEX_SHARED_SECRET: "x".repeat(32),
    AGENT_MULTIPLEX_CONTROL_NODE_STATE: join(directory, "catalog.sqlite"),
  }), port: 0 };
  try {
    const controller = new AbortController();
    const ready = vi.fn((info: unknown) => {
      expect(info).toMatchObject({ endpointId: "fixture-endpoint", ticket: "fixture-private-locator", httpUrl: expect.stringContaining("127.0.0.1") });
      controller.abort();
    });
    await runControlNode(config, controller.signal, { printTicket: false, onReady: ready });
    expect(ready).toHaveBeenCalledOnce();
    expect(output.mock.calls.flat().join(" ")).not.toContain("fixture-private-locator");
    const before = transport.close.mock.calls.length;
    await expect(runControlNode(config, new AbortController().signal, {
      printTicket: false, onReady: () => { throw new Error("private artifact write failed"); },
    })).rejects.toThrow("private artifact write failed");
    expect(transport.close.mock.calls.length).toBe(before + 1);
    const catalog = new ControlNodeCatalog({ filename: config.statePath, controlNodeName: "reopen" }); catalog.close();
  } finally { output.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
});
