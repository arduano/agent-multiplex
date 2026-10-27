import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defaultLifecycle } from "../src/plugin.js";
import { lifecycleSessionRoute } from "../src/gateway.js";
import { existingDirectoryWorkspace, type WorkspaceStrategy } from "../src/workspace.js";
import { scriptedHost, deferred, until } from "../../v8-host/qualification/fixture.js";
import type { HostActivationContext, HostContext } from "../../v8-plugins/src/contracts.js";
import type { OpeningCapsule, ReaderCustodyPort, SessionScope } from "../../v8-session/src/contracts/types.js";

const route = { authority: "root", host: "host", owner: "host-owner", routeEpoch: "route-1" };
const context: HostActivationContext = { route, storage: null };
const scope: SessionScope = { connection: "connection", principal: "principal", host: "host", session: "session" };
const caller: HostContext = { route, identity: { connection: scope.connection, principal: scope.principal, actions: ["read", "control"] } };
const policy = { kind: "codex", provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } } as const;
async function temporary() { return mkdtemp(join(tmpdir(), "v8-lifecycle-plugin-")); }

test("completed native Archive cold-pages unseen history after owned workspace release without registry publication or agent acquisition", async () => {
  const directory = await temporary(), cwd = join(directory, "owned-workspace"); await mkdir(cwd);
  const createInput = z.object({}), publicData = z.object({});
  const counts = { allocated: 0, inspected: 0, released: 0, readers: 0, readerStops: 0, pages: 0 };
  const releaseGate = deferred<void>(), releaseStarted = deferred<void>(), drivers: ReturnType<typeof scriptedHost>[] = [], contexts: { directory: string; cwd: string }[] = [];
  const workspace: WorkspaceStrategy<typeof createInput, typeof publicData> = {
    identity: { id: "scripted.archive-workspace", version: 1, recordVersion: 1 }, createInput, publicData,
    async allocate() { counts.allocated++; return { id: "owned-original", cwd, ownership: "owned", data: {} }; },
    async original() { throw Error("ARCHIVE_MUST_NOT_RECOVER_WORKSPACE"); },
    async inspect() { counts.inspected++; return "available"; },
    async release() { counts.released++; releaseStarted.resolve(); await releaseGate.promise; await rm(cwd, { recursive: true }); return "released"; },
  };
  const harness = { kind: "harness" as const, nativeKind: "codex" as const, protocol: scriptedHost("codex", { cwd }).controller.protocol,
    identity: { id: "scripted.archive-history", version: 1, recordVersion: 1 }, capabilities: [],
    async create(context: { directory: string; cwd: string }) {
      contexts.push(context); const driver = scriptedHost("codex", { cwd: context.cwd }); drivers.push(driver);
      let reader: { capsule: OpeningCapsule; custody: ReaderCustodyPort } | undefined;
      return { controller: driver.controller, history: {
        async prepare(run: Parameters<ReaderCustodyPort['begin']>[0], _attached: unknown, custody: ReaderCustodyPort) {
          if (reader) return;
          const opening = { scope: run.scope, generation: run.generation, operationId: `reader-${counts.readers + 1}` };
          await custody.begin(run, opening);
          const capsule = { opening, identity: { attachment: opening.operationId, process: 'scripted-reader-process', containment: 'scripted-reader-containment', placement: 'dedicated' as const } };
          await custody.owned(run, capsule); reader = { capsule, custody }; counts.readers++;
        },
        async release() { if (reader) { const held = reader; await held.custody.released({ ...held.capsule, state: 'stopped', scope: 'nativeTree', noAutomaticContinuation: true, acquisitionSealed: true }); reader = undefined; counts.readerStops++; } },
        port: (_run: unknown, attached: import('../../v8-history/src/contracts/types.js').Scope) => ({ scope: attached, mode: reader ? 'persisted' as const : 'active' as const, context: reader ? `exact-${reader.capsule.opening.operationId}` : 'unprepared',
          async read(request: import('../../v8-history/src/acquisition/types.js').AcquisitionRequest) {
            assert(reader, 'Only the journal-owned sessionless reader can read'); counts.pages++;
            return { scope: attached, status: 'ok' as const, records: [{ id: request.cursor === null ? 'newest' : 'unseen-tool', kind: request.cursor === null ? 'assistant' as const : 'tool' as const, lifecycle: 'completed' as const,
              body: { kind: 'complete' as const, text: request.cursor === null ? 'retained newest text' : 'previously unseen archived tool body', evidence: 'nativeFullBody' as const }, native: {} }], gaps: [], hasMore: request.cursor === null, nextCursor: request.cursor === null ? 'older-native' : null };
          } }),
      } };
    },
  };
  const options = { directory: join(directory, 'host'), harness, workspace, policy, observationMs: 5000 };
  let runtime = await defaultLifecycle(options).open(context), mounted: ReturnType<typeof lifecycleSessionRoute> | undefined;
  try {
    await runtime.sessions.create(scope, 'create', {});
    await until(async () => (await runtime.sessions.original(scope, 'create'))?.state === 'acknowledged');
    const warm = await runtime.sessions.agent(scope), originalBinding = (await warm.binding())!;
    await runtime.sessions.submit({ scope, id: 'stop', generation: 1, command: { type: 'stop' } }); await until(() => runtime.readiness().ready);
    const originals = [await runtime.sessions.original(scope, 'create'), await runtime.sessions.original(scope, 'stop')];
    const watch = warm.history.watch(originalBinding.history); await watch.next();
    // Stop exactly after native completion: the Host journal owns Archive,
    // while the normal lifecycle's subsequent registry publication is absent.
    const archiving = warm.session.submit({ scope, id: 'archive', generation: 1, command: { type: 'archive' } });
    await releaseStarted.promise;
    assert.equal((await warm.session.snapshot(scope)).archive?.state, 'pending');
    await assert.rejects(warm.history.recover(originalBinding.history), { code: 'FENCED' });
    await assert.rejects(warm.session.readers.begin(originalBinding.run, { scope, generation: 1, operationId: 'reader-during-archive' }), { code: 'FENCED' });
    assert.equal(counts.readers, 0);
    releaseGate.resolve(); assert.equal((await archiving).state, 'acknowledged');
    assert.deepEqual(await watch.next(), { done: true, value: undefined });
    const archive = await runtime.sessions.original(scope, 'archive'); assert.equal(archive?.state, 'acknowledged');
    await assert.rejects(warm.session.readers.begin({ ...originalBinding.run, generation: 2 }, { scope, generation: 2, operationId: 'wrong-archived-generation' }), { code: 'FENCED' });
    assert.deepEqual(await warm.history.recover(originalBinding.history), { state: 'healed' }, 'A healthy retained capture does not acquire a reader just because it is archived');
    assert.equal(warm.history.snapshot(originalBinding.history).rows.some(row => row.id === 'unseen-tool'), false);
    await runtime.close();
    const before = { ...counts };
    runtime = await defaultLifecycle(options).open(context);
    assert.equal(runtime.sessions.list()[0]!.workspace.state, 'released');
    assert.equal(runtime.sessions.list()[0]!.archive, undefined, 'The native journal proof does not depend on registry Archive publication');
    assert.equal(contexts.length, 1, 'Cold inventory does not construct a runtime or reader');
    assert.equal(await runtime.sessions.archived(scope, 'archive', 1), true);
    mounted = lifecycleSessionRoute({ sessions: runtime.sessions, target: { connection: scope.connection, principal: scope.principal, ...route, session: scope.session }, controlCatalog: async () => ({ available: false, choices: [] }) });
    const binding = (await mounted.binding!())!, cold = await runtime.sessions.agent(scope);
    assert.equal(cold.history.snapshot(binding.history).rows.length, 0);
    assert.equal(contexts[1]!.directory, contexts[0]!.directory, 'Retained native home directory is unchanged');
    assert.equal(contexts[1]!.cwd, contexts[1]!.directory, 'Passive launch uses retained session metadata directory, never the released workspace');
    assert.deepEqual(await mounted.history.recover!(binding.history), { state: 'value', value: { status: 'ready' } });
    const snapshot = cold.history.snapshot(binding.history); assert.equal(snapshot.olderEdge.state, 'available');
    if (snapshot.olderEdge.state !== 'available') throw Error('EXPECTED_NATIVE_CONTINUATION');
    const older = await mounted.history.older!(binding.history, snapshot.olderEdge.cursor, snapshot.generation);
    const tool = older.rows[0]!.body; assert.equal(tool.kind, 'complete');
    if (tool.kind !== 'complete') throw Error('EXPECTED_NATIVE_TOOL_BODY');
    assert.equal(tool.text, 'previously unseen archived tool body');
    assert.equal((await cold.session.readers.read()).state, 'owned');
    assert.equal(counts.readers, before.readers + 1); assert.equal(counts.pages, before.pages + 2);
    assert.deepEqual([await runtime.sessions.original(scope, 'create'), await runtime.sessions.original(scope, 'stop')], originals);
    assert.deepEqual(await runtime.sessions.original(scope, 'archive'), archive);
    for (const command of [{ type: 'resume' as const }, { type: 'send' as const, text: 'must stay sealed' }]) {
      const refused = await runtime.sessions.submit({ scope, id: `forbidden-${command.type}`, generation: 1, command });
      assert.equal(refused.state, 'refused'); assert.equal(refused.reason, 'archived');
    }
    await assert.rejects(cold.files.call('capture', { scope: cold.fileScope()!, sourceKey: 'archived', path: cwd }), { code: 'FENCED' });
    assert.equal(counts.allocated, before.allocated); assert.equal(counts.inspected, before.inspected); assert.equal(counts.released, before.released);
    assert.equal(drivers[1]!.counts.opens + drivers[1]!.counts.resumes + drivers[1]!.counts.sends, 0);
    mounted.close(); await runtime.close();
    assert.equal(counts.readerStops, counts.readers, 'Close proves release of the same exact reader capsule');
  } finally { releaseGate.resolve(); mounted?.close(); await runtime.sessions.terminate(); await rm(directory, { recursive: true, force: true }); }
});

test("default lifecycle owns both harnesses, borrowed workspace, exact originals and stopped compatible reopen", async () => {
  for (const kind of ["codex", "copilot"] as const) {
    const directory = await temporary(), driver = scriptedHost(kind, { cwd: directory }); let factories = 0, resourceCloses = 0, disposals = 0;
    const dispose = driver.controller.dispose.bind(driver.controller); driver.controller.dispose = () => { disposals++; dispose(); };
    const harness = { kind: "harness" as const, nativeKind: kind, protocol: driver.controller.protocol, identity: { id: `scripted.${kind}`, version: 1, recordVersion: 1 }, capabilities: ["lifecycle.full-stop"], async create() { factories++; return { controller: factories === 1 ? driver.controller : scriptedHost(kind, { cwd: directory }).controller, async close() { resourceCloses++; } }; } };
    const options = { directory: join(directory, "host"), harness, workspace: existingDirectoryWorkspace(), policy: kind === "codex" ? policy : { kind, provider: "copilot-only" as const, permissions: "manual" as const }, observationMs: 5000 };
    let runtime = await defaultLifecycle(options).open(context);
    try {
      const api = runtime.router.createCaller(caller);
      await api.create({ id: "create-original", input: { session: scope.session, workspace: { cwd: directory } } });
      await until(async () => (await api.original({ session: scope.session, id: "create-original" }))?.state === "acknowledged", 20000);
      assert.equal((await api.create({ id: "create-original", input: { session: scope.session, workspace: { cwd: directory } } })).state, "acknowledged");
      assert.equal(driver.counts.opens, 1); assert.equal(factories, 1); assert.equal(runtime.readiness().ready, false);
      const first = await api.snapshot({ session: scope.session }); assert.equal(first.workspace.allocation!.ownership, "borrowed"); assert.equal(first.native!.phase, "running");
      const native = first.native!.nativeSession;
      let generation = 1;
      if (kind === "codex") {
        const scoped = runtime.router.createCaller({ ...caller, session: { id: scope.session, generation: 1 } });
        const iterator = (await scoped.watch({ session: scope.session }))[Symbol.asyncIterator]();
        assert.equal((await iterator.next()).value!.native!.generation, 1);
        await api.submit({ session: scope.session, id: "stop-for-scope", generation: 1, command: { type: "stop" } });
        await until(async () => (await api.snapshot({ session: scope.session })).native!.phase === "stopped");
        await api.submit({ session: scope.session, id: "resume-for-scope", generation: 1, command: { type: "resume" } });
        await until(async () => { const view = await api.snapshot({ session: scope.session }); return view.native!.generation === 2 && view.native!.phase === "running"; });
        await assert.rejects(scoped.snapshot({ session: scope.session }), /FENCED/);
        await assert.rejects(scoped.reconcile({ session: scope.session }), /FENCED/);
        await assert.rejects(iterator.next(), /FENCED/); generation = 2;
      }
      await api.submit({ session: scope.session, id: "stop-original", generation, command: { type: "stop" } });
      await until(() => runtime.readiness().ready);
      assert.equal((await api.submit({ session: scope.session, id: "archive-original", generation, command: { type: "archive" } })).state, "acknowledged");
      assert.equal(await api.archiveProof({ session: scope.session, id: "archive-original", generation }), true);
      await until(() => runtime.readiness().ready); await runtime.close();
      assert.equal(resourceCloses, 1); assert.equal(disposals, 1);
      assert.equal((await stat(directory)).isDirectory(), true);
      runtime = await defaultLifecycle(options).open(context);
      const factoriesBeforeRead = factories;
      assert.equal((await runtime.sessions.original(scope, "create-original"))!.state, "acknowledged"); assert.equal(factories, factoriesBeforeRead);
      assert.equal(await runtime.sessions.archived(scope, "archive-original", generation), true); assert.equal(factories, factoriesBeforeRead);
      const observed = await runtime.router.createCaller(caller).snapshot({ session: scope.session });
      assert.equal(observed.native!.nativeSession, native); assert.equal(observed.native!.phase, "stopped");
      assert.equal(driver.counts.opens, 1); assert.equal(driver.counts.resumes, kind === "codex" ? 1 : 0);
      assert.equal((await runtime.sessions.original(scope, "create-original"))!.state, "acknowledged");
      await runtime.close();
    } finally { await runtime.sessions.terminate(); await rm(directory, { recursive: true, force: true }); }
  }
});

test("pure borrowed workspace refusal settles without native work, while an owned allocator exception retains unknown custody", async () => {
  const directory = await temporary(), allowed = join(directory, "allowed"); await mkdir(allowed);
  const driver = scriptedHost("codex", { cwd: directory }); let factories = 0;
  const harness = { kind: "harness" as const, nativeKind: "codex" as const, protocol: driver.controller.protocol, identity: { id: "scripted.codex", version: 1, recordVersion: 1 }, capabilities: [], async create() { factories++; return { controller: driver.controller }; } };
  try {
    for (const [name, cwd] of [["missing", join(allowed, "missing")], ["outside", directory]] as const) {
      const strategy = existingDirectoryWorkspace({ allowedRoots: [allowed] }); let allocations = 0;
      const workspace = { ...strategy, allocate: async (request: Parameters<typeof strategy.allocate>[0]) => { allocations++; return strategy.allocate(request); } };
      const target = { ...scope, session: name }, options = { directory: join(directory, name), harness, workspace, policy };
      let runtime = await defaultLifecycle(options).open(context);
      try {
        await runtime.sessions.create(target, "create-refused", { cwd });
        await until(async () => (await runtime.sessions.original(target, "create-refused"))?.state === "refused");
        assert.equal((await runtime.sessions.original(target, "create-refused"))!.reason, "workspaceRefused");
        assert.equal((await runtime.sessions.view(target)).phase, "stopped");
        assert.equal((await runtime.sessions.view(target)).workspace.state, "unallocated");
        await until(() => runtime.readiness().ready);
        assert.equal((await runtime.sessions.submit({ scope: target, id: "stop-refused", generation: 0, command: { type: "stop" } })).state, "acknowledged");
        assert.equal((await runtime.sessions.submit({ scope: target, id: "archive-refused", generation: 0, command: { type: "archive" } })).state, "acknowledged");
        assert.equal(await runtime.sessions.archived(target, "archive-refused", 0), true);
        await runtime.close(); runtime = await defaultLifecycle(options).open(context);
        assert.equal((await runtime.sessions.create(target, "create-refused", { cwd })).state, "refused");
        assert.equal((await runtime.sessions.original(target, "stop-refused"))!.state, "acknowledged");
        assert.equal((await runtime.sessions.original(target, "archive-refused"))!.state, "acknowledged"); assert.equal(await runtime.sessions.archived(target, "archive-refused", 0), true);
        assert.equal(runtime.readiness().ready, true); assert.equal(allocations, 1);
        assert.deepEqual(await strategy.original({ id: "same-pure-original", scope: target, input: { cwd } }), { state: "refused", noAllocation: true });
        await runtime.close();
      } finally { await runtime.sessions.terminate(); }
    }
    const createInput = z.object({ label: z.string() }), publicData = z.object({ version: z.number() }); let ownedAllocations = 0;
    const workspace: WorkspaceStrategy<typeof createInput, typeof publicData> = {
      identity: { id: "scripted.unknown-owned", version: 1, recordVersion: 1 }, createInput, publicData,
      async allocate() { ownedAllocations++; throw new Error("Reply lost after possible resource mutation"); }, async original() { return { state: "unknown" }; }, async inspect() { return "unknown"; },
    };
    const target = { ...scope, session: "owned-unknown" }, runtime = await defaultLifecycle({ directory: join(directory, "owned-unknown"), harness, workspace, policy }).open(context);
    try {
      assert.equal((await runtime.sessions.create(target, "create-unknown", { label: "owned" })).state, "outcomeUnknown");
      assert.equal((await runtime.sessions.submit({ scope: target, id: "stop-unknown", generation: 0, command: { type: "stop" } })).state, "admitted");
      await runtime.sessions.reconcile(target);
      assert.equal((await runtime.sessions.original(target, "create-unknown"))!.state, "outcomeUnknown");
      assert.equal((await runtime.sessions.original(target, "stop-unknown"))!.state, "admitted");
      assert.equal(runtime.readiness().ready, false); assert.equal(ownedAllocations, 1);
      await assert.rejects(runtime.sessions.submit({ scope: target, id: "archive-unknown", generation: 0, command: { type: "archive" } }), { code: "BUSY" });
      await assert.rejects(runtime.close(), /Stop and prove/);
    } finally { await runtime.sessions.terminate(); }
    assert.equal(factories, 0); assert.equal(driver.counts.opens, 0); assert.equal(driver.counts.resumes, 0); assert.equal(driver.counts.stops, 0);
  } finally { driver.controller.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("Stop during an actual held allocation retains custody, blocks update and never launches the late workspace", async () => {
  const directory = await temporary(), entered = deferred<void>(), result = deferred<{ id: string; cwd: string; ownership: "owned"; data: { revision: number } }>(); let allocations = 0, factories = 0, releases = 0;
  const input = z.object({ label: z.string() }), data = z.object({ revision: z.number() });
  const workspace: WorkspaceStrategy<typeof input, typeof data> = {
    identity: { id: "scripted.workspace", version: 1, recordVersion: 1 }, createInput: input, publicData: data,
    async allocate() { allocations++; entered.resolve(); return result.promise; }, async original() { return { state: "unknown" }; }, async inspect() { return "available"; }, async release() { releases++; return "released"; },
  };
  const driver = scriptedHost("codex", { cwd: directory });
  const plugin = defaultLifecycle({ directory: join(directory, "host"), policy, workspace, observationMs: 20, harness: { kind: "harness", nativeKind: "codex" as const, protocol: driver.controller.protocol, identity: { id: "scripted.codex", version: 1, recordVersion: 1 }, capabilities: [], async create() { factories++; return { controller: driver.controller }; } } });
  const runtime = await plugin.open(context);
  try {
    const create = runtime.sessions.create(scope, "create-held", { label: "owned workspace" }); await entered.promise;
    await assert.rejects(runtime.sessions.submit({ scope, id: "create-held", generation: 0, command: { type: "stop" } }), /CONFLICT/);
    const stop = runtime.sessions.submit({ scope, id: "stop-held", generation: 0, command: { type: "stop" } });
    await until(async () => (await runtime.sessions.view(scope)).phase === "stopping");
    assert.equal(runtime.readiness().ready, false); await assert.rejects(runtime.close(), /Stop and prove/);
    assert.equal((await create).state, "admitted"); assert.equal((await stop).state, "admitted");
    result.resolve({ id: "allocation-stable", cwd: directory, ownership: "owned", data: { revision: 7 } });
    await until(() => runtime.readiness().ready);
    assert.equal((await runtime.sessions.view(scope)).phase, "stopped");
    assert.equal((await runtime.sessions.original(scope, "create-held"))!.state, "refused");
    assert.equal((await runtime.sessions.original(scope, "stop-held"))!.state, "acknowledged");
    assert.equal(allocations, 1); assert.equal(factories, 0); assert.equal(driver.counts.opens, 0); assert.equal(releases, 0);
    await runtime.close();
  } finally { result.resolve({ id: "allocation-stable", cwd: directory, ownership: "owned", data: { revision: 7 } }); await runtime.sessions.terminate(); await rm(directory, { recursive: true, force: true }); }
});

test("lost allocator result uses original lookup after reopen, preserves custom data, and never reallocates", async () => {
  const directory = await temporary(); let allocations = 0, originals = 0, factories = 0;
  const input = z.object({ label: z.string() }), data = z.object({ revision: z.number() });
  const workspace: WorkspaceStrategy<typeof input, typeof data> = {
    identity: { id: "scripted.workspace", version: 1, recordVersion: 1 }, createInput: input, publicData: data,
    async allocate() { allocations++; throw Error("Reply lost after effect"); },
    async original(request) { originals++; assert.equal(request.input.label, "retained input"); return { state: "available", allocation: { id: request.id, cwd: directory, ownership: "owned", data: { revision: 19 } } }; },
    async inspect() { return "available"; },
  };
  const driver = scriptedHost("codex", { cwd: directory });
  const options = { directory: join(directory, "host"), workspace, policy, observationMs: 1000, harness: { kind: "harness" as const, nativeKind: "codex" as const, protocol: driver.controller.protocol, identity: { id: "scripted.codex", version: 1, recordVersion: 1 }, capabilities: [], async create() { factories++; return { controller: driver.controller }; } } };
  let runtime = await defaultLifecycle(options).open(context);
  try {
    assert.equal((await runtime.sessions.create(scope, "create-lost", { label: "retained input" })).state, "outcomeUnknown");
    assert.equal(runtime.readiness().ready, false); assert.equal(factories, 0); await runtime.sessions.terminate();
    runtime = await defaultLifecycle(options).open(context);
    assert.equal((await runtime.sessions.original(scope, "create-lost"))!.state, "outcomeUnknown"); assert.equal(originals, 0);
    await runtime.sessions.submit({ scope, id: "stop-lost", generation: 0, command: { type: "stop" } });
    assert.equal((await runtime.sessions.reconcile(scope)).workspace.allocation!.data.revision, 19);
    assert.equal((await runtime.sessions.original(scope, "stop-lost"))!.state, "acknowledged");
    assert.equal(allocations, 1); assert.equal(originals, 1); assert.equal(factories, 0); assert.equal(driver.counts.opens, 0);
    await runtime.close();
  } finally { await runtime.sessions.terminate(); await rm(directory, { recursive: true, force: true }); }
});

test("record identity mismatch refuses before allocation or native factory, including stopped durable originals", async () => {
  const directory = await temporary(), workspace = existingDirectoryWorkspace(); let factories = 0;
  const driver = scriptedHost("codex", { cwd: directory });
  const harness = { kind: "harness" as const, nativeKind: "codex" as const, protocol: driver.controller.protocol, identity: { id: "scripted.codex", version: 1, recordVersion: 1 }, capabilities: [], async create() { factories++; return { controller: driver.controller }; } };
  const options = { directory: join(directory, "host"), policy, workspace, harness };
  const runtime = await defaultLifecycle(options).open(context);
  try {
    await runtime.sessions.create(scope, "create-one", { cwd: directory }); await until(async () => (await runtime.sessions.original(scope, "create-one"))?.state === "acknowledged", 20000); await runtime.sessions.submit({ scope, id: "stop-one", generation: 1, command: { type: "stop" } }); await until(() => runtime.readiness().ready); await runtime.close();
    await assert.rejects(defaultLifecycle({ ...options, workspace: { ...workspace, identity: { ...workspace.identity, recordVersion: 2 } } }).open(context), /FENCED/);
    await assert.rejects(defaultLifecycle(options).open({ ...context, route: { ...route, host: "another-host" } }), /FENCED/);
    await assert.rejects(defaultLifecycle(options).open({ ...context, route: { ...route, owner: "another-owner" } }), /FENCED/);
    assert.equal(factories, 1);
  } finally { await runtime.sessions.terminate(); await rm(directory, { recursive: true, force: true }); }
});


test("Stop while harness construction is held preserves both originals and update cleanup releases the old adapter", async () => {
  const directory = await temporary(), driver = scriptedHost("codex", { cwd: directory }), entered = deferred<void>(), release = deferred<void>();
  let resourcesClosed = 0, disposals = 0; const dispose = driver.controller.dispose.bind(driver.controller);
  driver.controller.dispose = () => { disposals++; dispose(); };
  const options = { directory: join(directory, "host"), workspace: existingDirectoryWorkspace(), policy, observationMs: 20,
    harness: { kind: "harness" as const, nativeKind: "codex" as const, protocol: driver.controller.protocol, identity: { id: "scripted.codex", version: 1, recordVersion: 1 }, capabilities: [],
      async create() { entered.resolve(); await release.promise; return { controller: driver.controller, async close() { resourcesClosed++; throw Error("scripted cleanup failure"); } }; } } };
  const runtime = await defaultLifecycle(options).open(context);
  try {
    const create = runtime.sessions.create(scope, "create-held-factory", { cwd: directory }); await entered.promise;
    assert.equal((await runtime.sessions.original(scope, "create-held-factory"))!.state, "outcomeUnknown");
    await create; // Its first deadline may have observed workspace preparation before the factory hold.
    assert.equal((await runtime.sessions.create(scope, "create-held-factory", { cwd: directory })).state, "outcomeUnknown");
    const stop = runtime.sessions.submit({ scope, id: "stop-held-factory", generation: 0, command: { type: "stop" } });
    assert.equal((await stop).state, "admitted"); assert.equal(runtime.readiness().ready, false);
    await assert.rejects(runtime.sessions.submit({ scope, id: "second-factory-stop", generation: 0, command: { type: "stop" } }), /BUSY/);
    release.resolve(); await until(() => runtime.readiness().ready, 20000);
    assert.equal((await runtime.sessions.original(scope, "create-held-factory"))!.state, "refused");
    assert.equal((await runtime.sessions.original(scope, "stop-held-factory"))!.state, "acknowledged");
    assert.equal(driver.counts.opens, 0);
    await assert.rejects(runtime.close(), /cleanup remains unproved/);
    await assert.rejects(runtime.close(), /cleanup remains unproved/);
    await assert.rejects(runtime.sessions.submit({ scope, id: "after-partial-close", generation: 0, command: { type: "stop" } }), /CLOSED/);
    assert.equal(resourcesClosed, 1); assert.equal(disposals, 0);
  } finally { release.resolve(); await runtime.sessions.terminate(); dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("creation original namespace isolates principals and still rejects changing the target within one namespace", async () => {
  const directory = await temporary(), drivers: ReturnType<typeof scriptedHost>[] = [];
  const prototype = scriptedHost("codex", { cwd: directory });
  const options = { directory: join(directory, "host"), workspace: existingDirectoryWorkspace(), policy, observationMs: 30000,
    harness: { kind: "harness" as const, nativeKind: "codex" as const, protocol: prototype.controller.protocol, identity: { id: "scripted.codex", version: 1, recordVersion: 1 }, capabilities: [],
      async create() { const driver = scriptedHost("codex", { cwd: directory }); drivers.push(driver); return { controller: driver.controller }; } } };
  const runtime = await defaultLifecycle(options).open(context);
  try {
    for (const principal of ["principal", "another-principal"]) {
      const own = { ...scope, principal };
      await runtime.sessions.create(own, "shared-original-id", { cwd: directory });
      await until(async () => (await runtime.sessions.original(own, "shared-original-id"))?.state === "acknowledged", 20000);
      await runtime.sessions.submit({ scope: own, id: "shared-stop-id", generation: 1, command: { type: "stop" } });
    }
    await assert.rejects(runtime.sessions.create({ ...scope, session: "changed-target" }, "shared-original-id", { cwd: directory }), /CONFLICT/);
    assert.equal(runtime.sessions.hostData(caller).sessionCount, 1); assert.equal(drivers.length, 2); await until(() => runtime.readiness().ready); await runtime.close();
  } finally { await runtime.sessions.terminate(); prototype.controller.dispose(); await rm(directory, { recursive: true, force: true }); }
});
