import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultLifecycle } from "../src/plugin.js";
import { existingDirectoryWorkspace } from "../src/workspace.js";
import { scriptedHost, deferred, until } from "../../v8-host/qualification/fixture.js";

test("owner-selected Stop fences a held constructor before inspection and preserves cold stopped custody without native replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v8-owner-stop-")), entered = deferred<void>(), release = deferred<void>();
  const route = { authority: "catalog", host: "host", owner: "host-owner", routeEpoch: "route-1" };
  const scope = { connection: "connection", principal: "principal", host: route.host, session: "session" };
  const driver = scriptedHost("codex", { cwd: directory }), nativeDriver = scriptedHost("codex", { cwd: directory }); let factories = 0;
  const options = { directory: join(directory, "host"), workspace: existingDirectoryWorkspace(), observationMs: 20,
    policy: { kind: "codex" as const, provider: "copilot-only" as const, access: { approval: "on-request" as const, sandbox: "danger-full-access" as const } },
    harness: { kind: "harness" as const, nativeKind: "codex" as const, protocol: driver.controller.protocol, identity: { id: "scripted.codex", version: 1, recordVersion: 1 }, capabilities: [],
      async create(context: { scope: typeof scope }) { factories++; if (context.scope.session === scope.session) { entered.resolve(); await release.promise; } return { controller: context.scope.session === scope.session ? driver.controller : nativeDriver.controller }; } } };
  let runtime = await defaultLifecycle(options).open({ route, storage: null });
  try {
    const create = runtime.sessions.create(scope, "create-original", { cwd: directory }); await entered.promise;
    const stopping = runtime.sessions.stop(scope, "stop-original");
    // Committed list/original reads do not wait for the held constructor.
    await until(() => runtime.sessions.list()[0]?.phase === "stopping");
    assert.equal((await runtime.sessions.original(scope, "stop-original"))!.state, "admitted");
    assert.equal((await stopping).state, "admitted");
    assert.equal(runtime.readiness().ready, false); assert.equal(driver.counts.opens, 0); assert.equal(driver.counts.resumes, 0);
    release.resolve(); await create; await until(() => runtime.readiness().ready, 20000);
    assert.equal((await runtime.sessions.original(scope, "create-original"))!.state, "refused");
    assert.equal((await runtime.sessions.original(scope, "stop-original"))!.state, "acknowledged");
    assert.equal(driver.counts.opens, 0); assert.equal(driver.counts.resumes, 0); assert.equal(driver.counts.sends, 0);
    const nativeScope = { ...scope, session: "native-session" };
    await runtime.sessions.create(nativeScope, "native-create-original", { cwd: directory });
    await until(async () => (await runtime.sessions.original(nativeScope, "native-create-original"))?.state === "acknowledged", 20000);
    await runtime.sessions.stop(nativeScope, "native-stop-original"); await until(() => runtime.readiness().ready, 20000);
    assert.equal(nativeDriver.counts.opens, 1); assert.equal(nativeDriver.counts.stops, 1);
    await runtime.close();
    runtime = await defaultLifecycle(options).open({ route: { ...route, routeEpoch: "route-2" }, storage: null });
    const before = factories; assert.equal(runtime.sessions.list()[0]!.native, null); assert.equal(factories, before);
    // Generation0 retirement retains its one immutable preparation Stop. A
    // native-created stopped session requires the observed generation1 instead.
    await runtime.sessions.stop(scope, "stop-original");
    await runtime.sessions.stop(nativeScope, "cold-native-stop-original"); await until(() => runtime.readiness().ready, 20000);
    assert.equal((await runtime.sessions.original(scope, "stop-original"))!.state, "acknowledged");
    assert.equal((await runtime.sessions.original(nativeScope, "cold-native-stop-original"))!.generation, 1);
    assert.equal((await runtime.sessions.original(nativeScope, "cold-native-stop-original"))!.state, "acknowledged");
    assert.equal((await runtime.sessions.view(scope)).native!.phase, "stopped");
    assert.equal(driver.counts.opens, 0); assert.equal(driver.counts.resumes, 0); assert.equal(driver.counts.sends, 0);
    assert.equal(nativeDriver.counts.opens, 1); assert.equal(nativeDriver.counts.stops, 1); assert.equal(nativeDriver.counts.resumes, 0); assert.equal(nativeDriver.counts.sends, 0);
    await runtime.close();
  } finally { release.resolve(); await runtime.sessions.terminate(); await rm(directory, { recursive: true, force: true }); }
});
