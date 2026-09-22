import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { initTRPC } from "@trpc/server";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { accessContract, newCommandId, newRuntimeNodeId, safeCommandError } from "@arduano/agent-multiplex-protocol";
import { expect, it } from "vitest";
import { createAccessClient } from "../src/client.js";

it("keeps typed command errors and diagnostic identity intact over real access HTTP", async () => {
  const sentinel = "SYNTHETIC_SECRET_SENTINEL_DO_NOT_PERSIST";
  const command = { commandId: newCommandId(), runtimeNodeId: newRuntimeNodeId(), sessionId: null,
    payloadHash: "error-wire-payload", state: "outcomeUnknown" as const, request: {},
    error: safeCommandError(new Error(sentinel), { stage: "dispatch", certainty: "outcomeUnknown" }),
    createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z" };
  const t = initTRPC.create();
  let reads = 0;
  const router = t.router({ commands: t.router({ get: t.procedure
    .input(accessContract.commands.get.input).output(accessContract.commands.get.output)
    .query(() => { reads += 1; return command; }),
  }) });
  const server = createServer(createHTTPHandler({ router }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const handle = createAccessClient({ httpUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  try {
    const received = await handle.client.commands.get.query(command.commandId);
    expect(received).toEqual(command);
    expect(JSON.stringify(received)).not.toContain(sentinel);
    expect(reads).toBe(1);
  } finally {
    handle.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
    });
  }
});
