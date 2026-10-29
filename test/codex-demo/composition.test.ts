import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { activateHost } from "../../src/host/index.js";
import { OriginalJournal } from "../../src/storage/index.js";
import { Gateway, gatewayHttpHandler, gatewayRouter } from "../../src/gateway/node.js";
import type { HostTarget, Viewer } from "../../src/gateway/contracts.js";
import {
  codexDemoGatewayContract,
  type CodexDemoHostRouter,
} from "../../src/reference/codex/index.js";
import {
  createCodexDemoDefinition,
  codexDemoGatewayRouter,
} from "../../src/reference/codex/node.js";
import { fixture, selection } from "../codex/fixtures.js";
import { nativeHandler, nativeModels, nativeTurn } from "../codex/native-fixtures.js";

test("actual Codex adapter, one lifecycle journal and independent typed Gateway customization compose over authenticated HTTP", async (t) => {
  let wireFixture: Awaited<ReturnType<typeof fixture>> | undefined;
  const directory = await mkdtemp(join(tmpdir(), "multiplex-codex-demo-"));
  const journal = new OriginalJournal({ filename: join(directory, "originals.sqlite") });
  const definition = await createCodexDemoDefinition({
    journal,
    selection,
    adapter: async (observe) => {
      wireFixture = await fixture({ observe }, nativeHandler);
      return wireFixture.adapter;
    },
  });
  const f = wireFixture!;
  const route = { authority: "root", host: "demo", owner: "demo-owner", routeEpoch: "epoch" };
  const viewer: Viewer = {
    connection: "viewer",
    principal: "owner",
    actions: ["read", "control"],
    hosts: [route.host],
  };
  const token = "disposable-scripted-demo";
  const host = await activateHost(definition, {
    route,
    authenticate: ({ proof }) =>
      proof === token
        ? {
            identity: {
              connection: viewer.connection,
              principal: viewer.principal,
              actions: viewer.actions,
            },
            route,
          }
        : null,
  });
  const gateway = new Gateway<null>({ authorizePeer: () => true });
  gateway.registerHost({ route, manifest: host.manifest, transport: null });
  const target: HostTarget = {
    route,
    expected: {
      contractId: host.manifest.contractId,
      contractVersion: host.manifest.contractVersion,
      compositionId: host.manifest.compositionId,
    },
  };
  let inventoryReads = 0;
  const custom = codexDemoGatewayRouter({
    async summary({ viewer: permitted, target: selected }) {
      assert.equal(permitted.principal, viewer.principal);
      assert.equal(selected.route.host, route.host);
      inventoryReads++;
      return { label: "Local Codex workspace", availableWorkspaces: 3 };
    },
  });
  const gatewayApi = gatewayRouter(gateway, definition.gateway!, custom);
  const gatewayHttp = gatewayHttpHandler(
    gateway,
    {
      async authenticate(request) {
        return request.headers.get("authorization") === token ? viewer : null;
      },
    },
    gatewayApi,
  );
  const gatewayClient = createTRPCClient<typeof gatewayApi>({
    links: [
      httpBatchLink({
        url: "http://demo.invalid/trpc?target=" + encodeURIComponent(JSON.stringify(target)),
        headers: { authorization: token },
        fetch: (input, init) =>
          gatewayHttp(new Request(input, { ...init, signal: init?.signal ?? null })),
      }),
    ],
  });
  const nativeHttp = (request: Request) =>
    fetchRequestHandler({
      endpoint: "/host",
      req: request,
      router: host.router,
      createContext: () =>
        host.context({ expected: host.manifest, proof: request.headers.get("authorization") }),
    });
  const client = createTRPCClient<CodexDemoHostRouter>({
    links: [
      httpBatchLink({
        url: "http://demo.invalid/host",
        headers: { authorization: token },
        fetch: (input, init) =>
          nativeHttp(new Request(input, { ...init, signal: init?.signal ?? null })),
      }),
    ],
  });
  t.after(async () => {
    const results = await Promise.allSettled([
      gateway.close(),
      (async () => {
        for (const state of host.sessions.list({
          identity: {
            connection: viewer.connection,
            principal: viewer.principal,
            actions: viewer.actions,
          },
        })) {
          if (state.phase !== "stopped" && state.phase !== "archived")
            assert.equal(
              (await host.sessions.stop(state.scope, "cleanup-stop", state.generation)).state,
              "succeeded",
            );
        }
        await host.close();
      })(),
    ]);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Demo cleanup was not proved",
      );
    journal.close();
    assert(f.wires.every((wire) => wire.closed));
    assert([...f.owners.values()].every((owner) => owner.stopped));
    await rm(f.directory, { recursive: true });
    await rm(directory, { recursive: true });
  });
  assert.equal(f.allocations.length, 0, "Constructing and activating the composition is inert");
  assert.deepEqual(host.manifest.gateway, codexDemoGatewayContract);
  assert.deepEqual(await gatewayClient.custom.summary.query(), {
    label: "Local Codex workspace",
    availableWorkspaces: 3,
  });
  assert.equal(inventoryReads, 1);
  const unauthorized = await gatewayHttp(
    new Request(
      "http://demo.invalid/trpc/custom.summary?target=" +
        encodeURIComponent(JSON.stringify(target)),
    ),
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(inventoryReads, 1);
  const created = await client.lifecycle.create.mutate({
    session: "one",
    id: "create-one",
    workspace: { cwd: f.directory },
  });
  assert.equal(created.state, "succeeded");
  const state = await client.lifecycle.state.query({ session: "one" });
  assert.equal(state.phase, "running");
  if (state.phase !== "running") throw new Error("Expected owned running fixture");
  const run = state.run;
  assert.deepEqual(await client.extensions.workspace.inspect.query({ session: "one" }), {
    session: "one",
    generation: 1,
    workspace: { cwd: f.directory, ownership: "borrowed" },
  });
  assert.deepEqual(await client.native.model.list.query({ run, params: {} }), nativeModels);
  const params = {
    threadId: run.nativeSession,
    input: [{ type: "text" as const, text: "Scripted native input", text_elements: [] }],
  };
  const first = await client.native.turn.start.mutate({ originalId: "native-send", run, params });
  assert.equal(first.state, "succeeded");
  if (first.state !== "succeeded") throw new Error("Expected native response receipt");
  assert.equal(first.result.turn.itemsView, "full");
  const duplicate = await client.native.turn.start.mutate({
    originalId: "native-send",
    run,
    params,
  });
  assert.deepEqual(duplicate, first);
  assert.equal(f.wires[0]!.requests.filter((request) => request.method === "turn/start").length, 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    (await client.lifecycle.state.query({ session: "one" })).activity,
    "working",
    "Factory installed the one lifecycle observer",
  );
  f.wires[0]!.emit({
    method: "turn/completed",
    params: { threadId: run.nativeSession, turn: nativeTurn(first.result.turn.id, "completed") },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await client.lifecycle.state.query({ session: "one" })).activity, "idle");
  if (false as boolean) {
    // @ts-expect-error The actual Codex Host has no Copilot controls.
    await client.native.mode.set.mutate({ mode: "autopilot" });
    // @ts-expect-error Gateway-local custom routes are not native Host routes.
    await client.custom.summary.query();
    // @ts-expect-error The actual custom Gateway result is inferred.
    const wrong: number = (await gatewayClient.custom.summary.query()).label;
    void wrong;
  }
});
