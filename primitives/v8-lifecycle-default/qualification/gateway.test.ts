import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { callTRPCProcedure } from "@trpc/server";
import { defaultLifecycle } from "../src/plugin.js";
import { lifecycleCreationHost } from "../src/catalog.js";
import { existingDirectoryWorkspace } from "../src/workspace.js";
import { lifecycleSessionRoute } from "../src/gateway.js";
import { scriptedHost, deferred, until } from "../../v8-host/qualification/fixture.js";
import type { HostContext } from "../../v8-plugins/src/contracts.js";
import type { GatewayTarget } from "../../v8-gateway/src/contracts/types.js";
import type { Receipt, SessionScope } from "../../v8-session/src/contracts/types.js";
import type { Frame } from "../../v8-history/src/contracts/types.js";
import { createHostFacade } from "../../v8-gateway/src/node/host-facade.js";

const route = { authority: "catalog", host: "host", owner: "host-owner", routeEpoch: "route-1" };
const scope: SessionScope = { connection: "connection", principal: "principal", host: "host", session: "first" };
const caller: HostContext = { route, identity: { connection: scope.connection, principal: scope.principal, actions: ["read", "control"] } };
const target = (session = scope.session): GatewayTarget => ({ ...route, connection: scope.connection, principal: scope.principal, session });
const policy = { kind: "codex", provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } } as const;
const temporary = () => mkdtemp(join(tmpdir(), "v8-lifecycle-gateway-"));

test("Host facade cancellation releases a quiet lifecycle history iterator without closing the route or native session", async () => {
  const directory = await temporary(), driver = scriptedHost("codex", { cwd: directory });
  const harness = { kind: "harness" as const, nativeKind: "codex" as const, protocol: driver.controller.protocol,
    identity: { id: "scripted.codex", version: 1, recordVersion: 1 }, capabilities: [], async create() { return { controller: driver.controller }; } };
  const lifecycle = defaultLifecycle({ directory: join(directory, "host"), workspace: existingDirectoryWorkspace(), policy, harness });
  const runtime = await lifecycle.open({ route, storage: null }), routed = lifecycleSessionRoute({ sessions: runtime.sessions, target: target(), controlCatalog: () => driver.controller.catalog() });
  const facade = createHostFacade({ target: { ...route, connection: scope.connection, principal: scope.principal },
    manifest: { contractId: "quiet-history", contractVersion: 1, compositionId: "quiet-history", harness: harness.identity, lifecycle: lifecycle.identity, extensions: {} },
    actions: ["read"], creation: lifecycleCreationHost({ target: { host: scope.host, owner: route.owner, kind: "codex", placement: "dedicated" }, sessions: runtime.sessions, workspace: () => ({ cwd: directory }) }),
    listSessions: () => runtime.sessions.list(caller).map(value => value.id), watchSessions: emit => runtime.sessions.subscribeHost(values => emit(values.map(value => value.id)), caller),
    session: id => { assert.equal(id, scope.session); return routed; } });
  const abort = new AbortController(), attaching = deferred<void>(), attached = deferred<void>();
  let stream: AsyncIterator<Frame> | undefined, quiet: Promise<IteratorResult<Frame>> | undefined;
  let lateStream: AsyncIterableIterator<Frame> | undefined, lateNext: Promise<IteratorResult<Frame>> | undefined, lateReturn: Promise<IteratorResult<Frame>> | undefined;
  try {
    await runtime.sessions.create(scope, "create", { cwd: directory });
    await until(async () => (await runtime.sessions.original(scope, "create"))?.state === "acknowledged");
    const host = await runtime.sessions.agent(scope), binding = (await routed.binding())!;
    const source = await callTRPCProcedure({ router: facade.router, path: "multiplex.historyWatch", type: "subscription", ctx: caller,
      getRawInput: async () => ({ session: scope.session, scope: binding.history }), signal: abort.signal, batchIndex: 0 });
    stream = (source as AsyncIterable<Frame>)[Symbol.asyncIterator]();
    assert.equal((await stream.next()).value?.kind, "snapshot"); quiet = stream.next(); await setImmediate();
    assert.equal(host.history.owner(binding.history).subscriberCount, 1);
    abort.abort(); await setImmediate();
    assert.equal(host.history.owner(binding.history).subscriberCount, 0, "Cancellation must reach the actual HistorySubscription before generator return can finish");
    assert.deepEqual(await quiet, { done: true, value: undefined }); assert.deepEqual(await stream.return?.(), { done: true, value: undefined });
    assert.equal((await routed.session.snapshot(scope)).phase, "running");
    const view = runtime.sessions.view.bind(runtime.sessions), watch = host.history.watch.bind(host.history); let newSubscriptions = 0;
    runtime.sessions.view = async (...args) => { attaching.resolve(); await attached.promise; return view(...args); };
    host.history.watch = (...args) => { newSubscriptions++; return watch(...args); };
    lateStream = routed.history.watch(binding.history); lateNext = lateStream.next(); await attaching.promise;
    lateReturn = lateStream.return!(); routed.close(); attached.resolve();
    assert.deepEqual(await lateNext, { done: true, value: undefined }); assert.deepEqual(await lateReturn, { done: true, value: undefined });
    assert.equal(newSubscriptions, 0, "A retired route must not acquire a Hub subscription after held attachment settles");
    assert.equal(driver.counts.stops + driver.counts.resumes + driver.counts.sends + driver.counts.bodyReads, 0);
    await runtime.sessions.submit({ scope, id: "cleanup-stop", generation: 1, command: { type: "stop" } }); await until(() => runtime.readiness().ready);
    await runtime.close();
  } finally { attached.resolve(); abort.abort(); routed.close(); await stream?.return?.(); await quiet; await lateStream?.return?.(); await lateNext; await lateReturn; await facade.close(); await runtime.sessions.terminate(); await rm(directory, { recursive: true, force: true }); }
});

test("dynamic Codex/Copilot routes preserve originals, retained history and peer sessions across observer disposal", async () => {
  for (const kind of ["codex", "copilot"] as const) {
    const directory = await temporary(), drivers: ReturnType<typeof scriptedHost>[] = [], prototype = scriptedHost(kind, { cwd: directory });
    const runtime = await defaultLifecycle({ directory: join(directory, "host"), workspace: existingDirectoryWorkspace(),
      policy: kind === "codex" ? policy : { kind, provider: "copilot-only", permissions: "manual" },
      harness: { kind: "harness", nativeKind: kind, protocol: prototype.controller.protocol, identity: { id: `scripted.${kind}`, version: 1, recordVersion: 1 }, capabilities: [],
        async create() { const driver = scriptedHost(kind, { cwd: directory }); drivers.push(driver); return { controller: driver.controller }; } } }).open({ route, storage: null });
    const routes = ["first", "second"].map(id => lifecycleSessionRoute({ sessions: runtime.sessions, target: target(id), controlCatalog: () => prototype.controller.catalog() }));
    const observer = lifecycleSessionRoute({ sessions: runtime.sessions, target: target(), controlCatalog: () => prototype.controller.catalog() });
    try {
      let firstViews = 0, secondViews = 0;
      routes[0]!.session.subscribe(scope, () => { firstViews++; });
      routes[1]!.session.subscribe({ ...scope, session: "second" }, () => { secondViews++; });
      const receipts: Receipt[] = []; routes[0]!.session.subscribeReceipt!(scope, "create-first", value => receipts.push(value));
      assert.equal(drivers.length, 0);
      for (const id of ["first", "second"]) {
        await runtime.sessions.create({ ...scope, session: id }, `create-${id}`, { cwd: directory });
        await until(async () => (await runtime.sessions.original({ ...scope, session: id }, `create-${id}`))?.state === "acknowledged", 20000);
      }
      await until(() => firstViews > 0 && secondViews > 0 && receipts.some(value => value.state === "acknowledged"));
      assert.equal(drivers.length, 2); assert.deepEqual(drivers.map(driver => driver.counts.opens), [1, 1]);
      const binding = await routes[0]!.binding!(); assert.ok(binding); assert.equal(routes[0]!.authorizeHistory(binding.history), true);
      // A different Gateway may obtain this binding. Snapshot/authorization on
      // this route must consult the same lifecycle owner, not a route cache.
      await observer.session.snapshot(scope);
      assert.equal(observer.authorizeHistory(binding.history), true); assert.equal(observer.files!.scope()!.session, binding.run.nativeSession);
      const stream = observer.history.watch(binding.history);
      assert.equal((await stream.next()).value!.kind, "snapshot");
      await routes[0]!.session.submit({ scope, id: "send-original", generation: 1, command: { type: "send", text: "retained first response" } });
      await until(async () => (await routes[0]!.session.receipt(scope, "send-original"))?.state === "acknowledged");
      assert.equal(drivers[0]!.counts.sends, 1); assert.equal(drivers[0]!.counts.bodyReads, 0); assert.equal(drivers[0]!.counts.discovery, 0);
      const original = await routes[0]!.session.receipt(scope, "send-original"); assert.equal(original!.id, "send-original");
      routes[0]!.close(); observer.close(); await stream.return?.(); const firstBefore = firstViews;
      assert.equal(drivers[0]!.counts.stops, 0); assert.equal((await runtime.sessions.view(scope)).native!.phase, "running");
      await assert.rejects(async () => routes[1]!.session.snapshot(scope), { code: "FENCED" });
      await routes[1]!.session.submit({ scope: { ...scope, session: "second" }, id: "second-send", generation: 1, command: { type: "send", text: "peer still works" } });
      await until(() => drivers[1]!.counts.sends === 1);
      assert.equal(firstViews, firstBefore); assert.equal(drivers[1]!.counts.stops, 0);
      for (const id of ["first", "second"]) await runtime.sessions.submit({ scope: { ...scope, session: id }, id: `stop-${id}`, generation: 1, command: { type: "stop" } });
      await until(() => runtime.readiness().ready); routes[1]!.close(); await runtime.close();
    } finally { observer.close(); for (const value of routes) value.close(); await runtime.sessions.terminate(); prototype.controller.dispose(); await rm(directory, { recursive: true, force: true }); }
  }
});

test("pre-Create absence is UNAVAILABLE while every foreign logical/native scope remains FENCED before factory acquisition", async () => {
  const directory = await temporary(), driver = scriptedHost("codex", { cwd: directory }); let factories = 0;
  const runtime = await defaultLifecycle({ directory: join(directory, "host"), workspace: existingDirectoryWorkspace(), policy,
    harness: { kind: "harness", nativeKind: "codex", protocol: driver.controller.protocol, identity: { id: "scripted.codex", version: 1, recordVersion: 1 }, capabilities: [], async create() { factories++; return { controller: driver.controller }; } } }).open({ route, storage: null });
  const routed = lifecycleSessionRoute({ sessions: runtime.sessions, target: target(), controlCatalog: () => driver.controller.catalog() });
  const foreign = { ...scope, session: "another-session" }, run = { scope: foreign, generation: 1, nativeSession: "foreign-native" };
  const history = { kind: "codex" as const, origin: { connection: "another-connection", principal: scope.principal, host: scope.host, nativeSession: "foreign-native", attachment: "foreign-attachment" }, threadId: "foreign-native" };
  try {
    for (const read of [() => routed.session.snapshot(scope), () => routed.session.receipt(scope, "not-created"), () => routed.binding!()]) await assert.rejects(async () => read(), { code: "UNAVAILABLE" });
    for (const call of [
      () => routed.session.snapshot(foreign), () => routed.session.receipt(foreign, "foreign"),
      () => routed.session.submit({ scope: foreign, id: "foreign", generation: 1, command: { type: "stop" } }),
      () => routed.session.read!(run, { type: "codex.goal" }), () => routed.interactions!.snapshot(foreign),
      () => routed.mcp!.snapshot(run), () => routed.mcp!.refresh(run),
      () => routed.history.watch(history).next(), () => routed.history.authorize!(history),
      () => routed.history.recover!(history), () => routed.history.older!(history, "cursor"),
      () => routed.files!.port.call("usage", { scope: { ...scope, principal: "foreign" } }),
    ]) await assert.rejects(async () => call(), { code: "FENCED" });
    assert.throws(() => routed.session.subscribe(foreign, () => {}), { code: "FENCED" });
    assert.throws(() => routed.session.subscribeReceipt!(foreign, "foreign", () => {}), { code: "FENCED" });
    assert.throws(() => routed.interactions!.subscribe(foreign, () => {}), { code: "FENCED" });
    assert.throws(() => routed.mcp!.subscribe(run, () => {}), { code: "FENCED" });
    assert.equal(factories, 0); assert.equal(driver.counts.opens, 0); await runtime.close();
  } finally { routed.close(); await runtime.sessions.terminate(); await rm(directory, { recursive: true, force: true }); }
});

test("cancelled observation leases release late registration after a held factory without stopping the admitted native owner", async () => {
  const directory = await temporary(), driver = scriptedHost("codex", { cwd: directory }), entered = deferred<void>(), release = deferred<void>();
  const runtime = await defaultLifecycle({ directory: join(directory, "host"), workspace: existingDirectoryWorkspace(), policy, observationMs: 20,
    harness: { kind: "harness", nativeKind: "codex", protocol: driver.controller.protocol, identity: { id: "scripted.codex", version: 1, recordVersion: 1 }, capabilities: [], async create() { entered.resolve(); await release.promise; return { controller: driver.controller }; } } }).open({ route, storage: null });
  const routed = lifecycleSessionRoute({ sessions: runtime.sessions, target: target(), controlCatalog: () => driver.controller.catalog() });
  let pendingLeases = 0, releases = 0, callbacks = 0;
  const watch = runtime.sessions.watch.bind(runtime.sessions);
  runtime.sessions.watch = async (...args) => { pendingLeases++; const detach = await watch(...args); return () => { pendingLeases--; releases++; detach(); }; };
  try {
    const create = runtime.sessions.create(scope, "held-create", { cwd: directory }); await entered.promise;
    const run = { scope, generation: 1, nativeSession: "scripted-codex-native" };
    const stops = [routed.session.subscribe(scope, () => { callbacks++; }), routed.session.subscribeReceipt!(scope, "held-create", () => { callbacks++; }),
      routed.interactions!.subscribe(scope, () => { callbacks++; }), routed.mcp!.subscribe(run, () => { callbacks++; })];
    assert.equal(pendingLeases, 4); for (const stop of stops) stop(); routed.close();
    release.resolve(); await create; await until(() => pendingLeases === 0 && releases === 4);
    await until(async () => (await runtime.sessions.original(scope, "held-create"))?.state === "acknowledged");
    assert.equal(callbacks, 0); assert.equal(driver.counts.opens, 1); assert.equal(driver.counts.stops, 0);
    await runtime.sessions.submit({ scope, id: "explicit-stop", generation: 1, command: { type: "stop" } }); await until(() => runtime.readiness().ready); await runtime.close();
  } finally { release.resolve(); routed.close(); await runtime.sessions.terminate(); await rm(directory, { recursive: true, force: true }); }
});

test("committed Host list/watch discovery is account-filtered and cold reopen does not construct native runtimes", async () => {
  const directory = await temporary(), drivers: ReturnType<typeof scriptedHost>[] = [], prototype = scriptedHost("codex", { cwd: directory });
  const options = { directory: join(directory, "host"), workspace: existingDirectoryWorkspace(), policy,
    harness: { kind: "harness" as const, nativeKind: "codex" as const, protocol: prototype.controller.protocol, identity: { id: "scripted.codex", version: 1, recordVersion: 1 }, capabilities: [], async create() { const driver = scriptedHost("codex", { cwd: directory }); drivers.push(driver); return { controller: driver.controller }; } } };
  let runtime = await defaultLifecycle(options).open({ route, storage: null });
  try {
    const observations: string[][] = [], stop = runtime.sessions.subscribeHost(values => observations.push(values.map(value => value.id)), caller);
    assert.equal(observations.length, 1); assert.equal(observations[0]!.length, 0);
    for (const [principal, id] of [[scope.principal, "first"], ["other-principal", "other-session"]]) {
      const own = { ...scope, principal: principal!, session: id! };
      await runtime.sessions.create(own, `create-${id}`, { cwd: directory });
      await until(async () => (await runtime.sessions.original(own, `create-${id}`))?.state === "acknowledged", 20000);
      await runtime.sessions.submit({ scope: own, id: `stop-${id}`, generation: 1, command: { type: "stop" } });
    }
    assert.ok(observations.some(ids => ids.includes("first"))); assert.equal(observations.some(ids => ids.includes("other-session")), false);
    assert.equal(runtime.sessions.list().length, 2); assert.deepEqual(runtime.sessions.list(caller).map(value => value.id), ["first"]);
    assert.throws(() => runtime.sessions.list({ ...caller, route: { ...route, owner: "foreign-owner" } }), { code: "FENCED" });
    stop(); await until(() => runtime.readiness().ready); await runtime.close();
    const count = drivers.length; runtime = await defaultLifecycle(options).open({ route, storage: null });
    const cold: string[] = [], detach = runtime.sessions.subscribeHost(values => cold.push(...values.map(value => value.phase)), caller);
    assert.deepEqual(cold, ["unobserved"]); assert.equal(runtime.sessions.list(caller)[0]!.native, null);
    assert.deepEqual((await runtime.router.createCaller(caller).list()).map(value => value.id), ["first"]);
    assert.equal(drivers.length, count); assert.equal(drivers.reduce((sum, driver) => sum + driver.counts.opens, 0), 2); detach();
    // Inspection is explicit and reuses stopped native custody; no Create/Resume.
    for (const principal of [scope.principal, "other-principal"]) await runtime.sessions.view({ ...scope, principal, session: principal === scope.principal ? "first" : "other-session" });
    await runtime.close();
  } finally { await runtime.sessions.terminate(); prototype.controller.dispose(); await rm(directory, { recursive: true, force: true }); }
});
