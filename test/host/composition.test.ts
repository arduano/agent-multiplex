import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { initTRPC, type inferRouterInputs, type inferRouterOutputs } from "@trpc/server";
import {
  activateHost,
  defineHost,
  HostActivationError,
  hostProcedure,
  hostRouter,
} from "../../src/host/index.js";
import type {
  HostActivationOptions,
  HostContext,
  HostExtension,
  GatewayContract,
  MaybePromise,
  PublicHostContract,
  UpdateReadiness,
} from "../../src/host/contracts.js";

const route = { authority: "root", host: "work", owner: "owner", routeEpoch: "epoch-1" } as const;
const plugin = (id: string) => ({ id, version: 1, recordVersion: 1 });
const schemas = {
  host: z.object({ label: z.string() }),
  session: z.object({ project: z.string() }),
};
const ready = (): UpdateReadiness => ({ ready: true });
const context = (session?: { id: string; generation: number }): HostContext => ({
  identity: { connection: "connection", principal: "owner", actions: ["read", "control"] },
  route,
  ...(session ? { session } : {}),
});
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(
  options: {
    resourcesReady?: () => MaybePromise<UpdateReadiness>;
    closeLifecycle?: () => Promise<void>;
    extensions?: (sessions: { count: number }) => Record<string, HostExtension>;
    privateLabel?: string;
  } = {},
) {
  const events: string[] = [],
    sessions = { count: 0 };
  const definition = defineHost({
    contract: { id: "test.work", version: 1 },
    harness: {
      identity: plugin("test.codex"),
      nativeKind: "codex" as const,
      capabilities: ["native.codex"],
    },
    lifecycle: () => {
      events.push("factory");
      void options.privateLabel;
      return {
        identity: plugin("test.lifecycle"),
        requires: ["native.codex"],
        createInput: z.object({ cwd: z.string() }),
        public: schemas,
        open: () => {
          events.push("open");
          return {
            sessions,
            router: hostRouter({ count: hostProcedure.query(() => sessions.count) }),
            readiness: options.resourcesReady ?? ready,
            close: async () => {
              events.push("lifecycle.close");
              await options.closeLifecycle?.();
            },
          };
        },
      };
    },
    native: ({ sessions }) =>
      hostRouter({ codexOnly: hostProcedure.mutation(() => ++sessions.count) }),
    extensions: ({ sessions }) => options.extensions?.(sessions) ?? {},
  });
  const activation: HostActivationOptions = {
    route,

    authenticate: (call) => context(call.session),
  };
  return { definition, activation, events, sessions };
}

test("definitions are inert; actual router/DTO inference preserves native and extension distinctions", async () => {
  const value = fixture();
  assert.deepEqual(value.events, []);
  const host = await activateHost(value.definition, value.activation);
  assert.deepEqual(value.events, ["factory", "open"]);
  const caller = host.router.createCaller(
    await host.context({ expected: host.manifest, proof: null }),
  );
  assert.equal(await caller.native.codexOnly(), 1);
  assert.equal(await caller.lifecycle.count(), 1);
  assert.equal((await caller.system.manifest()).nativeKind, "codex");
  assert.deepEqual(await caller.system.readiness(), { ready: true });
  await host.close();
  await host.close();
  assert.equal(value.events.filter((event) => event === "lifecycle.close").length, 1);
});

test("a future native family needs no global union change; its custom types remain inferred", async () => {
  const gateway = initTRPC.context<{ hostId: string }>().create();
  const customGateway = gateway.router({
    allocate: gateway.procedure
      .input(z.object({ diskGiB: z.number() }))
      .mutation(({ ctx, input }) => ({ host: ctx.hostId, diskGiB: input.diskGiB })),
  });
  const gatewayContract: GatewayContract<typeof customGateway> = {
    id: "test.vm-gateway",
    version: 2,
  };
  const definition = defineHost({
    contract: { id: "test.claude", version: 1 },
    harness: {
      identity: plugin("test.claude"),
      nativeKind: "claude" as const,
      capabilities: [],
    },
    gateway: gatewayContract,
    lifecycle: () => ({
      identity: plugin("test.lifecycle"),
      createInput: z.object({ workspace: z.number() }),
      public: schemas,
      open: () => ({
        sessions: { project: "compiler" },
        router: hostRouter({}),
        readiness: ready,
        close() {},
      }),
    }),
    native: () =>
      hostRouter({
        claudeOnly: hostProcedure
          .input(z.object({ thinking: z.boolean() }))
          .mutation(({ input }) => input.thinking),
      }),
    extensions: ({ sessions }) => ({
      project: {
        identity: plugin("test.project"),
        public: { host: z.object({ total: z.number() }), session: z.object({ slug: z.string() }) },
        router: hostRouter({ name: hostProcedure.query(() => sessions.project) }),
        readiness: ready,
        close() {},
      },
    }),
  });
  type Public = PublicHostContract<typeof definition>;
  const gatewayInput: inferRouterInputs<Public["gatewayRouter"]>["allocate"] = { diskGiB: 32 };
  const gatewayOutput: inferRouterOutputs<Public["gatewayRouter"]>["allocate"] = {
    host: "work",
    diskGiB: 32,
  };
  const input: Public["createInput"] = { workspace: 1 };
  const kind: Public["nativeKind"] = "claude";
  const custom: Public["extensions"]["project"]["sessionData"] = { slug: "compiler" };
  assert.deepEqual([input.workspace, kind, custom.slug], [1, "claude", "compiler"]);
  assert.equal(gatewayInput.diskGiB, gatewayOutput.diskGiB);
  assert.deepEqual(
    await customGateway.createCaller({ hostId: "work" }).allocate(gatewayInput),
    gatewayOutput,
  );
  const host = await activateHost(definition, {
    route,

    authenticate: () => context(),
  });
  const caller = host.router.createCaller(
    await host.context({ expected: host.manifest, proof: null }),
  );
  assert.equal(await caller.native.claudeOnly({ thinking: true }), true);
  assert.equal(await caller.extensions.project.name(), "compiler");
  assert.deepEqual(host.manifest.gateway, { id: "test.vm-gateway", version: 2 });
  assert.equal(
    "gateway" in host.router._def.record,
    false,
    "Gateway handlers never run on the Host",
  );
  if (false as boolean) {
    // @ts-expect-error Codex native commands do not exist on a Claude Host.
    await caller.native.codexOnly();
    // @ts-expect-error An unknown extension cannot be asserted through the client.
    await caller.extensions.vm.allocate();
    // @ts-expect-error The concrete adapter validates its actual input shape.
    await caller.native.claudeOnly({ thinking: "yes" });
    const badGatewayInput: inferRouterInputs<Public["gatewayRouter"]>["allocate"] = {
      // @ts-expect-error The associated Gateway router retains its own actual input schema.
      diskGiB: "32",
    };
    void badGatewayInput;
  }
  await host.close();
});

test("authenticated exact route, contract and session generation fence before procedure effects", async () => {
  const value = fixture();
  let authenticated = 0,
    selected = context({ id: "session", generation: 3 });
  const host = await activateHost(value.definition, {
    ...value.activation,
    authenticate: () => {
      authenticated++;
      return selected;
    },
  });
  await assert.rejects(
    host.context({ expected: { ...host.manifest, compositionId: "other" }, proof: null }),
    /contract mismatch/,
  );
  assert.equal(authenticated, 0);
  const call = { expected: host.manifest, proof: null, session: { id: "session", generation: 3 } };
  for (const field of ["authority", "host", "owner", "routeEpoch"] as const) {
    selected = { ...context(call.session), route: { ...route, [field]: "other" } };
    await assert.rejects(host.context(call), /scope denied/);
  }
  selected = context({ id: "session", generation: 2 });
  await assert.rejects(host.context(call), /Session scope denied/);
  selected = context(call.session);
  await assert.rejects(
    host.context({ expected: host.manifest, proof: null }),
    /Session scope denied/,
  );
  await assert.rejects(
    host.context({ ...call, session: { id: "session", generation: 0 } }),
    /Invalid session scope/,
  );
  selected = {
    ...context(call.session),
    identity: { connection: "connection", principal: "owner", actions: ["read"] },
  };
  const caller = host.router.createCaller(await host.context(call));
  assert.equal(await caller.lifecycle.count(), 0);
  await assert.rejects(caller.native.codexOnly(), /Host action denied/);
  assert.equal(value.sessions.count, 0);
  await host.close();
});

test("close seals saved contexts and in-flight authentication; readiness refusal permits later exact close", async () => {
  const value = fixture();
  const authentication = deferred<HostContext>();
  let delay = false;
  const host = await activateHost(value.definition, {
    ...value.activation,
    authenticate: () => (delay ? authentication.promise : context()),
  });
  const saved = await host.context({ expected: host.manifest, proof: null });
  delay = true;
  const pending = host.context({ expected: host.manifest, proof: null });
  await host.close();
  authentication.resolve(context());
  await assert.rejects(pending, /Host is not active/);
  await assert.rejects(
    host.router.createCaller(saved).native.codexOnly(),
    /Host admission is closed/,
  );
  assert.equal(value.sessions.count, 0);

  let settled = false;
  const second = fixture({
    resourcesReady: () =>
      settled ? ready() : { ready: false, reasons: ["native lifetime retained"] },
  });
  const active = await activateHost(second.definition, second.activation);
  await assert.rejects(active.close(), /unsettled work/);
  assert.equal(second.events.includes("lifecycle.close"), false);
  assert.deepEqual(await active.readiness(), {
    ready: false,
    reasons: ["native lifetime retained"],
  });
  settled = true;
  await active.close();
});

test("admitted procedure and readiness races cannot close their owner", async () => {
  const effect = deferred<number>(),
    entered = deferred<void>();
  let closes = 0;
  const definition = defineHost({
    contract: { id: "test.slow", version: 1 },
    harness: { identity: plugin("test.scripted"), nativeKind: "scripted", capabilities: [] },
    lifecycle: () => ({
      identity: plugin("test.lifecycle"),
      createInput: z.object({}),
      public: schemas,
      open: () => ({
        sessions: {},
        router: hostRouter({
          work: hostProcedure.mutation(() => {
            entered.resolve();
            return effect.promise;
          }),
        }),
        readiness: ready,
        close() {
          closes++;
        },
      }),
    }),
  });
  const host = await activateHost(definition, {
    route,

    authenticate: () => context(),
  });
  const caller = host.router.createCaller(
    await host.context({ expected: host.manifest, proof: null }),
  );
  const work = caller.lifecycle.work();
  await entered.promise;
  assert.equal((await host.readiness()).ready, false);
  await assert.rejects(host.close(), /procedures are admitted/);
  assert.equal(closes, 0);
  effect.resolve(42);
  assert.equal(await work, 42);
  await host.close();
  assert.equal(closes, 1);
});

test("readiness cannot return an old idle observation after new admission, even with empty refusal reasons", async () => {
  const observation = deferred<UpdateReadiness>(),
    entered = deferred<void>();
  let delayed = true,
    refused = true;
  const value = fixture({
    resourcesReady: () => {
      if (delayed) {
        entered.resolve();
        return observation.promise;
      }
      return refused ? { ready: false, reasons: [] } : ready();
    },
  });
  const host = await activateHost(value.definition, value.activation);
  const pending = host.readiness();
  await entered.promise;
  const authenticated = await host.context({ expected: host.manifest, proof: null });
  const release = authenticated.admit!({ path: "lifecycle.work", type: "mutation" });
  observation.resolve({ ready: true });
  assert.equal((await pending).ready, false);
  release();
  delayed = false;
  assert.deepEqual(await host.readiness(), { ready: false, reasons: [] });
  await assert.rejects(host.close(), /unsettled work/);
  assert.equal(value.events.includes("lifecycle.close"), false);
  refused = false;
  await host.close();
});

test("all returned extension owners transfer before validation, including later aliases", async () => {
  const events: string[] = [];
  const extension = (id: string): HostExtension => ({
    identity: plugin(id),
    public: schemas,
    router: hostRouter({}),
    readiness: ready,
    close() {
      events.push(id);
    },
  });
  const first = extension("first"),
    second = extension("second");
  const value = fixture({ extensions: () => ({ system: first, later: second, alias: second }) });
  await assert.rejects(activateHost(value.definition, value.activation), /Reserved extension name/);
  assert.deepEqual(events, ["second", "first"]);
  assert.equal(value.events.at(-1), "lifecycle.close");
});

test("failed activation retains exact lifecycle recovery; unrelated definitions cannot adopt it", async () => {
  let settled = false;
  const value = fixture({
    resourcesReady: () => (settled ? ready() : { ready: false, reasons: ["native retained"] }),
    extensions: () => ({
      system: {
        identity: plugin("reserved"),
        public: schemas,
        router: hostRouter({}),
        readiness: ready,
        close() {},
      },
    }),
  });
  let failure: HostActivationError | undefined;
  try {
    await activateHost(value.definition, value.activation);
  } catch (error) {
    assert(error instanceof HostActivationError);
    failure = error;
  }
  assert(failure);
  const recovery = failure.recoveryFor(value.definition);
  assert(recovery);
  assert.equal(recovery.sessions, value.sessions);
  assert.equal(recovery.extensions.size, 1);
  assert.equal(failure.recoveryFor(fixture().definition), null);
  assert.equal(value.events.includes("lifecycle.close"), false);
  settled = true;
  await recovery.close();
  assert.equal(recovery.extensions.size, 0);
  assert.equal(value.events.at(-1), "lifecycle.close");
});

test("cleanup failure preserves dependencies and is not automatically replayed", async () => {
  let attempts = 0;
  const value = fixture({
    extensions: () => ({
      feature: {
        identity: plugin("feature"),
        public: schemas,
        router: hostRouter({}),
        readiness: ready,
        close() {
          attempts++;
          throw new Error("partial release");
        },
      },
    }),
  });
  const host = await activateHost(value.definition, value.activation);
  await assert.rejects(host.close(), /partial release/);
  await assert.rejects(host.close(), /partial release/);
  assert.equal(attempts, 1);
  assert.equal(value.events.includes("lifecycle.close"), false);
  assert.equal((await host.readiness()).ready, false);
});

test("public manifest ignores private configuration; incompatible records refuse before native open", async () => {
  const first = fixture({ privateLabel: "secret-one" }),
    second = fixture({ privateLabel: "secret-two" });
  const a = await activateHost(first.definition, {
    ...first.activation,
  });
  const b = await activateHost(second.definition, {
    ...second.activation,
  });
  assert.deepEqual(a.manifest, b.manifest);
  assert(!JSON.stringify(a.manifest).includes("secret"));
  await a.close();
  await b.close();
  const incompatible = fixture();
  await assert.rejects(
    activateHost(incompatible.definition, {
      ...incompatible.activation,
      records: [{ kind: "harness", identity: { ...plugin("test.codex"), recordVersion: 2 } }],
    }),
    /incompatible/,
  );
  assert.deepEqual(incompatible.events, ["factory"]);
});
