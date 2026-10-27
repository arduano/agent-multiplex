import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexModelCatalog, createCodexRuntime } from '../src/runtime.js';
import { readCodexModels } from '../src/models.js';
import type { CodexWire } from '../src/rpc.js';
import type { NativeAllocation, NativeAllocationBackend, NativeAllocationOptions } from '../../v8-host/src/native/allocation.js';
import type { NativeStart, OpeningIdentity, OpeningRef } from '../../v8-session/src/contracts/types.js';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const row = (model: string, efforts = ['low', 'native-new-effort'], hidden = false) => ({ model, hidden, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: 'Native label' })) });
class Allocation implements NativeAllocation {
  identity: OpeningIdentity | null = null; sealed = false; gone = false; stops = 0; inspections = 0; failStop = false;
  async prepare() { this.identity ??= { attachment: 'owned', process: 'owned-process', containment: 'owned-group', placement: 'dedicated' }; assert.equal(this.sealed, false); return { launcher: '/scripted/launcher', identity: this.identity }; }
  async opening(opening: OpeningRef) { const { identity } = await this.prepare(); return { opening, identity, stop: async () => ({ opening, identity: await this.stop(), state: 'stopped' as const, scope: 'nativeTree' as const, noAutomaticContinuation: true as const, acquisitionSealed: true as const }) }; }
  assertLaunchable() { assert.equal(this.sealed, false); assert.ok(this.identity); }
  async inspect() { this.inspections++; return this.gone ? 'gone' as const : 'running' as const; }
  async stop() { this.stops++; this.sealed = true; assert.ok(this.identity); if (this.failStop) throw Error('scripted unconfirmed Stop'); this.gone = true; return this.identity; }
}
class Wire implements CodexWire {
  readonly sent: { id?: number; method: string; params?: Record<string, unknown> }[] = [];
  readonly data = new Set<(line: string) => void>(); readonly ended = new Set<() => void>(); closed = false;
  list: (params: Record<string, unknown>) => unknown | Promise<unknown> = () => ({ data: [row('native-model')], nextCursor: null });
  onData(listener: (line: string) => void) { this.data.add(listener); return () => this.data.delete(listener); }
  onClose(listener: () => void) { this.ended.add(listener); return () => this.ended.delete(listener); }
  async write(line: string) {
    const message = JSON.parse(line) as (typeof this.sent)[number]; this.sent.push(message); if (message.id === undefined) return;
    const params = message.params ?? {};
    const result = message.method === 'initialize' ? { userAgent: 'codex/0.162.1 (scripted)' }
      : message.method === 'model/list' ? await this.list(params)
      : message.method === 'thread/start' ? { thread: { id: 'native-thread', status: { type: 'idle' } }, model: params.model, modelProvider: 'route', approvalPolicy: 'on-request', sandbox: { type: 'dangerFullAccess' }, reasoningEffort: 'low' }
      : assert.fail(`Unexpected scripted method ${message.method}`);
    if (!this.closed) for (const listener of this.data) listener(JSON.stringify({ id: message.id, result }) + '\n');
  }
  async close() { this.closed = true; for (const listener of this.ended) listener(); }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'v8-codex-models-'));
  const allocations: Allocation[] = [], inputs: NativeAllocationOptions[] = [], wires: Wire[] = [];
  let setup = (_wire: Wire) => {}, failStop = false;
  const allocation: NativeAllocationBackend = { allocate: input => { inputs.push(input); const value = new Allocation(); value.failStop = failStop; allocations.push(value); return value; }, inspectOpening: async () => null };
  const options = { directory, binary: '/scripted/codex', packageRoot: '/scripted', model: 'configured-default', environment: { PRIVATE_KEY: 'private-test-value' }, provider: { id: 'route', baseUrl: 'http://127.0.0.1:1/v1', environmentKey: 'PRIVATE_KEY', copilotOnly: true }, allocation,
    wire: () => { const wire = new Wire(); setup(wire); wires.push(wire); return wire; } };
  return { options, allocations, inputs, wires, setup: (value: typeof setup) => { setup = value; }, failStop: () => { failStop = true; }, dispose: () => rm(directory, { recursive: true, force: true }) };
}

test('Host model owner coalesces real-codec pagination, preserves native values, retires before return and is reusable without a conversation', async () => {
  const f = await fixture(); const gate = deferred<void>();
  f.setup(wire => { wire.list = async params => { await gate.promise; return params.cursor === null ? { data: [{ ...row('native-model'), displayName: 'Native model label', description: 'Native description', defaultReasoningEffort: 'low', inputModalities: ['text', 'image'], privateProvider: 'PRIVATE_NOT_PUBLIC' }, row('hidden-model', [], true)], nextCursor: 'opaque-next' } : { data: [row('another-model', [])], nextCursor: null }; }; });
  const catalog = createCodexModelCatalog(f.options);
  try {
    assert.equal(f.allocations.length, 0); const first = catalog.read(), second = catalog.read(); assert.equal(first, second); assert.equal(catalog.readiness().ready, false); gate.resolve();
    assert.deepEqual(await first, { available: true, choices: [{ model: 'native-model', efforts: ['low', 'native-new-effort'], displayName: 'Native model label', description: 'Native description', defaultEffort: 'low', inputModalities: ['text', 'image'] }, { model: 'another-model', efforts: [] }] });
    assert.equal(f.allocations.length, 1); assert.equal(f.allocations[0]!.gone, true); assert.equal(f.wires[0]!.closed, true); assert.equal(catalog.readiness().ready, true);
    assert.deepEqual(f.wires[0]!.sent.map(message => message.method), ['initialize', 'initialized', 'model/list', 'model/list']);
    assert.deepEqual(f.wires[0]!.sent.filter(message => message.method === 'model/list').map(message => message.params), [{ cursor: null, limit: 64, includeHidden: false }, { cursor: 'opaque-next', limit: 64, includeHidden: false }]);
    const policy = await readFile(join(f.options.directory, 'home/config.toml'), 'utf8'); assert.match(policy, /approval_policy = "on-request"/); assert.match(policy, /sandbox_mode = "danger-full-access"/); assert.match(policy, /model_provider = "route"/); assert.equal(policy.includes('private-test-value'), false);
    assert.equal(f.inputs[0]!.kind, 'reader'); assert.equal(f.inputs[0]!.cwd, f.options.directory);
    await catalog.retire(); await catalog.read(); assert.equal(f.allocations.length, 2); await catalog.close(); assert.throws(() => catalog.read());
  } finally { await catalog.close(); await f.dispose(); }
});

test('native model decoder rejects partial, ambiguous, cyclic and oversized choices instead of inventing a fallback', async () => {
  for (const result of [
    { data: [row('same'), row('same', ['different'])], nextCursor: null },
    { data: [row('same', ['low', 'low'])], nextCursor: null },
    { data: [{ ...row('bad'), hidden: undefined }], nextCursor: null },
    { data: [row('partial')], nextCursor: undefined },
    { data: [{ ...row('bad-label'), displayName: 10 }], nextCursor: null },
    { data: [{ ...row('bad-description'), description: 'x'.repeat(4097) }], nextCursor: null },
    { data: [{ ...row('bad-effort'), defaultReasoningEffort: null }], nextCursor: null },
    { data: [{ ...row('bad-modality'), inputModalities: ['text', 'video'] }], nextCursor: null },
    { data: [{ ...row('duplicate-modality'), inputModalities: ['image', 'image'] }], nextCursor: null },
  ]) await assert.rejects(readCodexModels(async () => result));
  let calls = 0; await assert.rejects(readCodexModels(async () => { calls++; return { data: [], nextCursor: 'repeated' }; })); assert.equal(calls, 2);
  calls = 0; await assert.rejects(readCodexModels(async () => ({ data: [], nextCursor: `cursor-${++calls}` }))); assert.equal(calls, 8);
  calls = 0; await assert.rejects(readCodexModels(async () => { const start = calls++ * 64; return { data: Array.from({ length: 64 }, (_, index) => row(`model-${start + index}`)), nextCursor: String(calls) }; })); assert.equal(calls, 3, 'visible choices respect the shared 128-choice contract');
});

test('failed helper Stop retains exact custody until explicit retirement observes sealed exact absence; reads never retry Stop', async () => {
  const f = await fixture(); f.failStop(); const catalog = createCodexModelCatalog(f.options);
  try {
    await assert.rejects(catalog.read(), /cleanup remains unconfirmed/); assert.equal(catalog.readiness().ready, false);
    assert.throws(() => catalog.read(), /cleanup remains unconfirmed/); assert.equal(f.allocations.length, 1); assert.equal(f.allocations[0]!.stops, 1);
    await assert.rejects(catalog.retire(), /cleanup remains unconfirmed/); assert.equal(f.allocations[0]!.stops, 1); assert.equal(catalog.readiness().ready, false);
    f.allocations[0]!.gone = true; await catalog.retire(); assert.equal(catalog.readiness().ready, true); assert.equal(f.allocations[0]!.stops, 1); assert.equal(f.wires[0]!.closed, true);
  } finally { f.allocations.forEach(value => { value.gone = true; }); await catalog.close(); await f.dispose(); }
});

test('helper timeout retires only its metadata allocation; active RPC metadata timeout never stops an agent or starts another reader', async () => {
  const f = await fixture(); const held = deferred<unknown>(); f.setup(wire => { wire.list = () => held.promise; });
  const metadata = createCodexModelCatalog({ ...f.options, modelReadMs: 10 });
  // Keep the test event loop alive while the production observer timer is unref'ed.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    assert.deepEqual(await metadata.read(), { available: false, choices: [] }); assert.equal(f.allocations[0]!.gone, true); assert.equal(metadata.readiness().ready, true);
    held.resolve({ data: [row('too-late')], nextCursor: null }); await metadata.close();
    const activeReply = deferred<unknown>(); f.setup(wire => { wire.list = () => activeReply.promise; }); let hostReads = 0;
    const runtime = createCodexRuntime({ ...f.options, directory: join(f.options.directory, 'session'), home: join(f.options.directory, 'session/home'), cwd: f.options.directory, modelReadMs: 10, modelCatalog: async () => { hostReads++; return { available: false, choices: [] }; } });
    try {
      await runtime.controller.catalog(); assert.equal(hostReads, 1); assert.equal(f.allocations.length, 1);
      const input: NativeStart = { scope: { connection: 'connection', principal: 'principal', host: 'host', session: 'logical' }, generation: 1, operationId: 'original-create', nativeSession: null, placement: 'dedicated', policy: { kind: 'codex', provider: 'copilot-only', access: { approval: 'on-request', sandbox: 'danger-full-access' } } };
      await runtime.controller.open(input, () => {}); const agent = f.allocations[1]!;
      const first = runtime.controller.catalog(); assert.deepEqual(await first, { available: false, choices: [] }); assert.equal(agent.stops, 0); assert.equal(f.allocations.length, 2); assert.equal(hostReads, 1);
      await runtime.controller.catalog(); assert.equal(f.wires[1]!.sent.filter(value => value.method === 'model/list').length, 1, 'timed-out actual RPC stays coalesced until native settles');
      activeReply.resolve({ data: [row('late-active')], nextCursor: 'must-not-follow' }); await new Promise(resolve => setImmediate(resolve)); assert.equal(agent.stops, 0); assert.equal(f.wires[1]!.sent.filter(value => value.method === 'model/list').length, 1);
    } finally { await runtime.close(); }
  } finally { clearInterval(keepAlive); await metadata.close(); await f.dispose(); }
});
