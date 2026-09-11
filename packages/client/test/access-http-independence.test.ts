import type { AddressInfo } from "node:net";
import { createServer } from "node:http";

import { initTRPC, TRPCError } from "@trpc/server";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import {
  accessContract,
  newCommandId,
  newRuntimeNodeId,
  newSessionId,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";

import { createAccessClient, type AccessClientOptions } from "../src/client.js";

const sessionId = newSessionId();
const tasksInput = { sessionId, request: { harness: "copilot", view: "tasks" } } as const;
const historyInput = { sessionId, request: { harness: "copilot", limit: 100 } } as const;
const description = {
  protocolVersion: 5,
  componentKind: "access-gateway",
  dataAuthority: "none",
  instanceId: "independent-http-test",
  capabilities: [],
} as const;
const nativeResult = {
  harness: "copilot",
  vendorSessionId: "disposable-native-session",
  payload: { encoding: "native-json-images-v1", json: [], images: [] },
} as const;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function fixture(auth: Pick<AccessClientOptions, "headers" | "bearerToken"> = {}) {
  const tasks = gate(), history = gate();
  const tasksStarted = gate(), historyStarted = gate();
  const requests: Array<{ url: string; authorization: string | undefined; client: string | undefined; method: string | undefined }> = [];
  const mutations: unknown[] = [];
  const t = initTRPC.create();
  // Real HTTP and tRPC framing; native operations deliberately remain pending
  // until the test releases them, even if their HTTP caller disconnects.
  const router = t.router({
    system: t.router({ describe: t.procedure.query(() => description) }),
    sessions: t.router({
      readNativeState: t.procedure.input(accessContract.sessions.readNativeState.input).query(async () => {
        tasksStarted.release();
        await tasks.promise;
        return nativeResult;
      }),
      readNativeHistory: t.procedure.input(accessContract.sessions.readNativeHistory.input).query(async () => {
        historyStarted.release();
        await history.promise;
        return nativeResult;
      }),
      stop: t.procedure.input(accessContract.sessions.stop.input).mutation(({ input }) => {
        mutations.push(input);
        // An error response must not make the transport replay a mutation.
        throw new TRPCError({ code: "TIMEOUT", message: "disposable response failure" });
      }),
    }),
  });
  const handler = createHTTPHandler({ router });
  const server = createServer((req, res) => {
    requests.push({
      url: req.url ?? "",
      authorization: req.headers.authorization,
      client: typeof req.headers["x-test-client"] === "string" ? req.headers["x-test-client"] : undefined,
      method: req.method,
    });
    handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const handle = createAccessClient({ httpUrl: `http://127.0.0.1:${port}`, ...auth });
  return {
    client: handle.client,
    tasks, history, tasksStarted, historyStarted, requests, mutations,
    async close() {
      tasks.release();
      history.release();
      handle.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}

describe("access client independent HTTP operations", () => {
  it.each(["tasks", "history"] as const)("returns health while a %s read from the same tick is still pending", async (view) => {
    const f = await fixture();
    const abort = new AbortController();
    let settled = false;
    try {
      const slow = view === "tasks"
        ? f.client.sessions.readNativeState.query(tasksInput, { signal: abort.signal })
        : f.client.sessions.readNativeHistory.query(historyInput, { signal: abort.signal });
      void slow.finally(() => { settled = true; }).catch(() => undefined);
      const fast = f.client.system.describe.query(undefined, { signal: AbortSignal.timeout(1_500) });

      await expect(fast).resolves.toEqual(description);
      await f[view === "tasks" ? "tasksStarted" : "historyStarted"].promise;
      expect(settled).toBe(false);
      expect(f.requests).toHaveLength(2);
      expect(f.requests.every(({ url }) => !url.includes("batch=") && !url.includes(","))).toBe(true);

      f[view].release();
      await expect(slow).resolves.toEqual(nativeResult);
    } finally {
      abort.abort();
      await f.close();
    }
  });

  it("cancels one native read without delaying or cancelling another", async () => {
    const f = await fixture();
    const abort = new AbortController();
    try {
      const cancelled = f.client.sessions.readNativeState.query(tasksInput, { signal: abort.signal });
      const rejection = expect(cancelled).rejects.toThrow();
      const retained = f.client.sessions.readNativeHistory.query(historyInput, { signal: AbortSignal.timeout(1_500) });
      await Promise.all([f.tasksStarted.promise, f.historyStarted.promise]);

      abort.abort();
      await rejection;
      // Leave the cancelled native task unresolved at the server. It cannot
      // hold up the other response through an HTTP batch.
      f.history.release();
      await expect(retained).resolves.toEqual(nativeResult);
      expect(f.requests).toHaveLength(2);
    } finally {
      abort.abort();
      await f.close();
    }
  });

  it.each(["bearer", "custom"] as const)("preserves per-request %s authentication and dispatches a failed mutation once", async (kind) => {
    let revision = 0;
    const f = await fixture(kind === "bearer"
      ? { bearerToken: async () => `disposable-token-${++revision}` }
      : { headers: async () => ({ authorization: `Bearer disposable-token-${++revision}`, "x-test-client": "custom" }) });
    try {
      await Promise.all([f.client.system.describe.query(), f.client.system.describe.query()]);
      const command = {
        operation: "stop" as const,
        commandId: newCommandId(),
        payloadHash: "disposable-payload-hash",
        sessionId,
        runtimeNodeId: newRuntimeNodeId(),
        bindingRevision: 1,
      };
      await expect(f.client.sessions.stop.mutate(command)).rejects.toThrow("disposable response failure");
      expect(f.mutations).toEqual([command]);
      expect(f.requests).toHaveLength(3);
      expect(f.requests.map(({ authorization }) => authorization).sort()).toEqual([
        "Bearer disposable-token-1", "Bearer disposable-token-2", "Bearer disposable-token-3",
      ]);
      expect(f.requests.map(({ client }) => client)).toEqual(Array(3).fill(kind === "custom" ? "custom" : undefined));
      expect(f.requests.map(({ method }) => method)).toEqual(["GET", "GET", "POST"]);
      expect(f.requests.every(({ url }) => !url.includes("token") && !url.includes("batch="))).toBe(true);
    } finally {
      await f.close();
    }
  });
});
