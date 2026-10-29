import assert from "node:assert/strict";
import {
  createTRPCClient,
  httpBatchStreamLink,
  httpSubscriptionLink,
  splitLink,
} from "@trpc/client";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OriginalJournal } from "../../src/storage/index.js";
import { Catalog } from "../../src/catalog/node.js";
import { catalogEndpoint, type CatalogRouter } from "../../src/catalog-remote/node.js";
import { createCatalogClient } from "../../src/catalog-remote/client.js";
import { RetainedCatalog } from "../../src/catalog-remote/index.js";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { TRPCError } from "@trpc/server";
import { serve } from "../../src/reference/node.js";
import { authenticatedEventSource } from "../transport/eventsource.js";
import { ObservationSupervisor } from "../../src/transport/index.js";
import type { Viewer } from "../../src/gateway/index.js";
const until = async (check: () => boolean, maximumMs = 2000) => {
  const end = Date.now() + maximumMs;
  while (!check()) {
    if (Date.now() > end) throw Error("Catalog observation did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
test(
  "real Root Catalog through its explicit HTTP endpoint and typed client retains scoped observations without replay",
  { timeout: 60000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "multiplex-remote-catalog-")),
      journal = new OriginalJournal({ filename: join(directory, "root.sqlite") });
    let creates = 0,
      archiveReads = 0,
      lose = true;
    const catalog = new Catalog({
      authority: "root",
      journal,
      host: () => ({
        async create(request) {
          creates++;
          return {
            state: "created",
            binding: { scope: request.scope, generation: 1, nativeSession: "native" },
          };
        },
        async read() {
          throw Error("terminal original needs no Host read");
        },
        async readArchive(_scope, id, generation) {
          archiveReads++;
          assert.equal(id, "host-archive");
          assert.equal(generation, 1);
          return true;
        },
      }),
    });
    const route = {
        authority: "root",
        host: "root-service",
        owner: "root-owner",
        routeEpoch: "epoch",
      },
      identity = { id: "root.catalog", version: 1, recordVersion: 1 };
    const manifest = {
      contractId: "root.catalog",
      contractVersion: 1,
      compositionId: "root.catalog:1",
      nativeKind: "catalog-service",
      harness: identity,
      lifecycle: identity,
      extensions: {},
    };
    const endpoint = catalogEndpoint({
      catalog,
      route,
      manifest,
      authenticate: (viewer) => ({
        connection: viewer.connection,
        principal: viewer.principal,
        actions: viewer.actions,
        hosts: ["host"],
      }),
      authorizeCreate: (_actor, host, target) => {
        if (target.owner === "private-failure") throw Error("private catalog diagnostic");
        return host === "host" && target.owner === "host-owner";
      },
    });
    const viewer: Viewer = {
      connection: "connection",
      principal: "owner",
      actions: ["read", "control"],
      hosts: [route.host],
    };
    let online = true;
    const expected = {
      contractId: manifest.contractId,
      contractVersion: manifest.contractVersion,
      compositionId: manifest.compositionId,
    };
    const server = await serve({
      async handler(request) {
        return fetchRequestHandler({
          endpoint: "/trpc",
          req: request,
          router: endpoint.router,
          allowMethodOverride: true,
          async createContext() {
            if (!online) throw new TRPCError({ code: "SERVICE_UNAVAILABLE" });
            const authorization = request.headers.get("authorization");
            if (authorization !== "owner" && authorization !== "other")
              throw new TRPCError({ code: "UNAUTHORIZED" });
            return endpoint.peer.context(
              authorization === "owner"
                ? viewer
                : { ...viewer, principal: "other", actions: ["read"] },
              { route, expected },
            );
          },
        });
      },
    });
    const rpcUrl = new URL("/trpc", server.url).href;
    const client = createCatalogClient(
      createTRPCClient<CatalogRouter>({
        links: [
          splitLink({
            condition: (operation) => operation.type === "subscription",
            true: httpSubscriptionLink({
              url: rpcUrl,
              EventSource: authenticatedEventSource(() => ({ authorization: "owner" })),
            }),
            false: httpBatchStreamLink({
              url: rpcUrl,
              maxItems: 1,
              methodOverride: "POST",
              headers: () => ({ authorization: "owner" }),
              fetch: async (input, init) => {
                const response = await fetch(input, { ...init, signal: init?.signal ?? null });
                if (
                  lose &&
                  new URL(String(input)).pathname === "/trpc/create" &&
                  init?.method === "POST"
                ) {
                  lose = false;
                  await response.arrayBuffer();
                  throw Error("original reply lost after effect");
                }
                return response;
              },
            }),
          }),
        ],
      }),
    );
    const observations = new ObservationSupervisor({ retryMinMs: 10, retryMaxMs: 20 }),
      retained = new RetainedCatalog({
        key: "owner-root",
        identity: { connection: viewer.connection, principal: viewer.principal, authority: "root" },
        feed: client.feed,
        observations,
      });
    try {
      retained.commit();
      await until(() => retained.getSnapshot().freshness === "current");
      const create = {
        host: "host",
        session: "session",
        id: "create",
        target: {
          owner: "host-owner",
          nativeKind: "future",
          contractId: "host.contract",
          contractVersion: 1,
        },
        name: "Conversation",
        workspace: null,
        selection: null,
      };
      await assert.rejects(client.remote.create.mutate(create));
      assert.equal(creates, 1);
      assert.equal(
        (await client.remote.original.query({ host: "host", session: "session", id: "create" }))
          ?.state,
        "succeeded",
      );
      const current = (await client.remote.get.query({ host: "host", session: "session" }))!;
      assert.equal(
        (
          await client.remote.patch.mutate({
            host: "host",
            session: "session",
            id: "rename",
            revision: current.revision,
            patch: { name: "Renamed" },
          })
        ).state,
        "succeeded",
      );
      assert.equal(
        (
          await client.remote.patch.mutate({
            host: "host",
            session: "session",
            id: "stale",
            revision: current.revision,
            patch: { name: "Wrong" },
          })
        ).state,
        "refused",
      );
      await until(() => retained.getSnapshot().listing?.rows[0]?.name === "Renamed");
      online = false;
      server.server.closeAllConnections();
      await until(() => retained.getSnapshot().freshness === "stale");
      assert.equal(retained.getSnapshot().listing?.rows[0]?.name, "Renamed");
      online = true;
      // The pinned standard EventSource waits 3000ms before reconnecting.
      await until(() => retained.getSnapshot().freshness === "current", 5000);
      assert.equal(creates, 1);
      assert.equal(
        (
          await client.remote.publishArchive.mutate({
            host: "host",
            session: "session",
            id: "publish",
            hostOriginalId: "host-archive",
            generation: 1,
          })
        ).state,
        "succeeded",
      );
      assert.equal(archiveReads, 1);
      const other = createCatalogClient(
        createTRPCClient<CatalogRouter>({
          links: [
            splitLink({
              condition: (operation) => operation.type === "subscription",
              true: httpSubscriptionLink({
                url: rpcUrl,
                EventSource: authenticatedEventSource(() => ({ authorization: "other" })),
              }),
              false: httpBatchStreamLink({
                url: rpcUrl,
                maxItems: 1,
                methodOverride: "POST",
                headers: () => ({ authorization: "other" }),
              }),
            }),
          ],
        }),
      );
      assert.deepEqual((await other.remote.list.query({})).rows, []);
      await assert.rejects(
        other.remote.create.mutate({ ...create, id: "denied", session: "denied" }),
      );
      await assert.rejects(
        endpoint.peer.context(viewer, {
          route,
          expected,
          session: { id: "session", generation: 1 },
        }),
      );
      await assert.rejects(
        client.remote.create.mutate({
          ...create,
          id: "private-error",
          target: { ...create.target, owner: "private-failure" },
        }),
        (error: unknown) =>
          error instanceof Error &&
          error.message === "INTERNAL_SERVER_ERROR" &&
          !error.message.includes("diagnostic"),
      );
      assert.equal(creates, 1);
    } finally {
      await retained.close();
      await observations.close();

      await endpoint.close();
      catalog.close();
      journal.close();
      server.server.closeAllConnections();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("actual catalog endpoint close releases quiet observers and retains an admitted Create", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multiplex-catalog-close-")),
    journal = new OriginalJournal({ filename: join(directory, "root.sqlite") });
  let complete!: () => void,
    creates = 0;
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const catalog = new Catalog({
    authority: "root",
    journal,
    host: () => ({
      async create(request) {
        creates++;
        await gate;
        return {
          state: "created",
          binding: { scope: request.scope, generation: 1, nativeSession: "native" },
        };
      },
      async read() {
        throw Error("No replay or fallback read");
      },
      async readArchive() {
        return false;
      },
    }),
  });
  const route = {
      authority: "root",
      host: "root-service",
      owner: "root-owner",
      routeEpoch: "epoch",
    },
    identity = { id: "catalog", version: 1, recordVersion: 1 },
    manifest = {
      contractId: "catalog",
      contractVersion: 1,
      compositionId: "catalog:1",
      nativeKind: "catalog-service",
      harness: identity,
      lifecycle: identity,
      extensions: {},
    },
    target = {
      route,
      expected: {
        contractId: manifest.contractId,
        contractVersion: manifest.contractVersion,
        compositionId: manifest.compositionId,
      },
    },
    viewer: Viewer = {
      connection: "connection",
      principal: "owner",
      actions: ["read", "control"],
      hosts: [route.host],
    };
  const endpoint = catalogEndpoint({
    catalog,
    route,
    manifest,
    authenticate: (actor) => ({ ...actor, hosts: ["host"] }),
    authorizeCreate: () => true,
  });
  try {
    const actor = await endpoint.peer.context(viewer, target),
      cancelled = endpoint.router.createCaller(actor, { signal: AbortSignal.abort() }),
      request = {
        host: "host",
        session: "session",
        id: "create",
        name: "Conversation",
        target: {
          owner: "host-owner",
          nativeKind: "future",
          contractId: "host.contract",
          contractVersion: 1,
        },
        workspace: null,
        selection: null,
      };
    await assert.rejects(cancelled.create({ ...request, id: "cancelled" }), {
      code: "CLIENT_CLOSED_REQUEST",
    });
    assert.equal(creates, 0, "An already aborted request never reaches Catalog admission");
    assert.equal(
      catalog.original(
        { connection: "connection", principal: "owner", host: "host", session: "session" },
        "cancelled",
      ),
      null,
    );
    const caller = endpoint.router.createCaller(actor),
      watch = (await caller.watch({}))[Symbol.asyncIterator]();
    await watch.next();
    const pending = caller.create(request);
    await until(() => creates === 1);
    await watch.next(); // Reserved creation was observed before the quiet wait.
    const held = watch.next();
    let closed = false;
    const closing = endpoint.close().then(() => {
      closed = true;
    });
    assert.equal((await held).done, true);
    assert.equal(closed, false, "Close cannot forget the admitted Host creation");
    await assert.rejects(endpoint.peer.context(viewer, target), { code: "UNAVAILABLE" });
    await assert.rejects(caller.list({}), { code: "SERVICE_UNAVAILABLE" });
    complete();
    assert.equal((await pending).state, "succeeded");
    await closing;
    assert.equal(creates, 1);
    assert.equal(
      catalog.original(
        { connection: "connection", principal: "owner", host: "host", session: "session" },
        "create",
      )?.state,
      "succeeded",
    );
  } finally {
    complete();
    await endpoint.close();
    catalog.close();
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retained catalog fences foreign namespaces and redacts on disposal without opening or mutating a session", async () => {
  let receive: (value: import("../../src/catalog-remote/index.js").CatalogListing) => void = () => {
      throw Error("not connected");
    },
    releases = 0,
    opens = 0;
  const owner = new RetainedCatalog({
    key: "scope",
    identity: { connection: "connection", principal: "owner", authority: "root" },
    feed: {
      watch() {
        throw Error("inert construction must not open");
      },
    },
    observations: {
      connect(input) {
        opens++;
        receive = (value) => input.receive(value as unknown as Parameters<typeof input.receive>[0]);
        return () => {
          releases++;
        };
      },
    },
  });
  assert.equal(opens, 0);
  owner.commit();
  assert.equal(opens, 1);
  const empty = {
    authority: "root",
    coverage: "snapshot" as const,
    rows: [],
    total: 0,
    matching: 0,
    nextOffset: null,
    unobservedPinned: [],
  };
  receive(empty);
  assert.equal(owner.getSnapshot().freshness, "current");
  assert.throws(() => receive!({ ...empty, authority: "foreign" }), /Invalid catalog snapshot/);
  assert.equal(owner.getSnapshot().listing?.authority, "root");
  await owner.close();
  assert.equal(owner.getSnapshot().listing, null);
  receive(empty);
  assert.equal(owner.getSnapshot().listing, null);
  assert.equal(releases, 1);
});
function publicTypeCounterexample(client: ReturnType<typeof createCatalogClient>) {
  // @ts-expect-error A catalog RPC authority exposes no native Stop operation.
  void client.remote.stop;
}
void publicTypeCounterexample;
