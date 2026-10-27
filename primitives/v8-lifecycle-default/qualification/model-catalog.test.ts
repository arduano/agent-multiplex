import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultLifecycle, type HostModelCatalog, type NativeHarnessDefinition } from '../src/plugin.js';
import { existingDirectoryWorkspace } from '../src/workspace.js';
import { codexProtocol } from '../../v8-harness-codex/src/protocol.js';
import { deferred } from '../../v8-host/qualification/fixture.js';
import type { HostActivationContext, HostContext } from '../../v8-plugins/src/contracts.js';
import type { Catalog } from '../../v8-session/src/contracts/types.js';

test('Host model reads stay passive until requested and retain unsettled metadata custody through explicit retirement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v8-host-model-catalog-'));
  const context: HostActivationContext = { route: { authority: 'root', host: 'host', owner: 'owner', routeEpoch: 'epoch' }, storage: null };
  const caller: HostContext = { route: context.route, identity: { connection: 'connection', principal: 'principal', actions: ['read'] } };
  const policy = { kind: 'codex', provider: 'copilot-only', access: { approval: 'on-request', sandbox: 'danger-full-access' } } as const;
  const catalog: Catalog = { available: true, choices: [{ model: 'native-model', efforts: ['low', 'high'] }] };
  const entered = deferred<void>(), heldRead = deferred<Catalog>();
  const counts = { factories: 0, reads: 0, retires: 0, closes: 0, sessions: 0 };
  let unsettled = false, rejectRetire = true;
  const owner: HostModelCatalog = {
    async read() {
      counts.reads++;
      if (counts.reads === 1) { entered.resolve(); return heldRead.promise; }
      if (counts.reads === 2) { unsettled = true; throw Error('MODEL_READ_CLEANUP_UNCONFIRMED'); }
      return catalog;
    },
    async retire() { counts.retires++; if (unsettled && rejectRetire) throw Error('MODEL_RETIRE_UNCONFIRMED'); unsettled = false; },
    readiness: () => unsettled ? { ready: false, reasons: ['helper-unsettled'] } : { ready: true },
    async close() { assert.equal(unsettled, false); counts.closes++; },
  };
  const harness: NativeHarnessDefinition<'codex'> = {
    kind: 'harness', nativeKind: 'codex', protocol: codexProtocol,
    identity: { id: 'scripted.host-model-catalog', version: 1, recordVersion: 1 }, capabilities: [],
    modelCatalog(value) { counts.factories++; assert.equal(value.directory, join(directory, 'host', 'model-catalog')); return owner; },
    async create() { counts.sessions++; throw Error('MODEL_QUERY_MUST_NOT_CREATE_SESSION'); },
  };
  const options = { directory: join(directory, 'host'), harness, workspace: existingDirectoryWorkspace(), policy };
  const open = () => defaultLifecycle(options).open(context);
  let runtime: Awaited<ReturnType<typeof open>> | undefined;
  let absent: typeof runtime;
  let pending: Promise<Catalog> | undefined;
  try {
    runtime = await open();
    const api = runtime.router.createCaller(caller);
    assert.deepEqual(await api.list(), []); assert.deepEqual(runtime.sessions.list(), []);
    assert.equal((await api.host()).sessionCount, 0); assert.equal(runtime.readiness().ready, true);
    const denied = runtime.router.createCaller({ ...caller, identity: { ...caller.identity, actions: [] } });
    const stale = runtime.router.createCaller({ ...caller, route: { ...caller.route, routeEpoch: 'old-epoch' } });
    await assert.rejects(denied.modelCatalog(), { code: 'FORBIDDEN' }); await assert.rejects(stale.modelCatalog(), /FENCED/);
    assert.deepEqual(counts, { factories: 0, reads: 0, retires: 0, closes: 0, sessions: 0 });

    pending = api.modelCatalog();
    await Promise.race([entered.promise, pending.then(() => { throw Error('EXPECTED_HELD_MODEL_READ'); })]);
    assert.equal(counts.factories, 1); assert.equal(counts.reads, 1);
    const held = runtime.readiness(); assert.equal(held.ready, false);
    if (!held.ready) assert.ok(held.reasons.includes('lifecycle-work-unsettled'));
    await assert.rejects(runtime.close(), { code: 'BUSY' }); assert.equal(counts.closes, 0);
    heldRead.resolve(catalog); assert.deepEqual(await pending, catalog); pending = undefined;
    assert.equal(runtime.readiness().ready, true);

    await assert.rejects(api.modelCatalog(), /MODEL_READ_CLEANUP_UNCONFIRMED/);
    const retained = runtime.readiness(); assert.equal(retained.ready, false);
    if (!retained.ready) assert.ok(retained.reasons.includes('model-catalog:helper-unsettled'));
    await assert.rejects(runtime.sessions.retireModelCatalog(), /MODEL_RETIRE_UNCONFIRMED/);
    assert.equal(runtime.readiness().ready, false);
    await assert.rejects(runtime.close(), { code: 'BUSY' }); assert.equal(counts.closes, 0);
    rejectRetire = false; await runtime.sessions.retireModelCatalog();
    assert.equal(runtime.readiness().ready, true);
    assert.deepEqual(await api.modelCatalog(), catalog);
    assert.equal(counts.factories, 1, 'Retirement preserves the same reusable Host metadata owner');
    await runtime.sessions.sealAdmissions();
    await assert.rejects(api.modelCatalog(), /CLOSED/); assert.equal(counts.reads, 3);
    await runtime.close(); await runtime.close();
    assert.equal(counts.closes, 1); assert.equal(counts.sessions, 0);

    const { modelCatalog: _modelCatalog, ...withoutModels } = harness;
    absent = await defaultLifecycle({ ...options, directory: join(directory, 'absent'), harness: withoutModels }).open(context);
    assert.deepEqual(await absent.router.createCaller(caller).modelCatalog(), { available: false, choices: [] });
    assert.deepEqual(absent.sessions.list(), []); assert.equal(absent.readiness().ready, true);
    await absent.close(); assert.equal(counts.factories, 1); assert.equal(counts.closes, 1); assert.equal(counts.sessions, 0);
  } finally {
    heldRead.resolve(catalog); await pending?.catch(() => {}); rejectRetire = false;
    for (const value of [runtime, absent]) if (value) {
      await value.sessions.retireModelCatalog().catch(() => {});
      try { await value.close(); } catch { await value.sessions.terminate(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
