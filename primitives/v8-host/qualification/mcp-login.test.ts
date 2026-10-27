import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openHost } from '../../v8-lifecycle-default/src/assembly.js';
import type { HostContext } from '../../v8-plugins/src/contracts.js';
import { codexHarnessRouter } from '../../v8-harness-codex/src/router.js';
import { copilotHarnessRouter } from '../../v8-harness-copilot/src/router.js';
import { codexMcpConfig } from '../../v8-harness-codex/src/mcp-config.js';
import { LoginLinks, loginLimits } from '../../v8-mcp/src/login.js';
import { GatewayCoordinator } from '../../v8-gateway/src/gateway/coordinator.js';
import { createGatewayHttpHandler } from '../../v8-gateway/src/http/server.js';
import { HttpGatewayTransport } from '../../v8-gateway/src/client/http.js';
import { defaultLifecycle } from '../../v8-lifecycle-default/src/plugin.js';
import { lifecycleSessionRoute } from '../../v8-lifecycle-default/src/gateway.js';
import { existingDirectoryWorkspace } from '../../v8-lifecycle-default/src/workspace.js';
import type { Harness, RunRef, SessionScope } from '../../v8-session/src/contracts/types.js';
import { deferred, scriptedHost, until } from './fixture.js';

const scope: SessionScope = { connection: 'login-fixture', principal: 'owner', host: 'host', session: 'logical' };
const url = 'https://oauth-fixture.invalid/authorize?state=PRIVATE_TRANSIENT_MARKER';
const target = { ...scope, authority: 'catalog', owner: 'durable-owner', routeEpoch: 'route-1' };
const context: HostContext = { identity: { connection: scope.connection, principal: scope.principal, actions: ['read', 'control'] }, route: { authority: target.authority, host: scope.host, owner: target.owner, routeEpoch: target.routeEpoch }, session: { id: scope.session, generation: 1 } };

async function fixture(kind: Harness, persistent = false) {
  const directory = await mkdtemp(join(tmpdir(), 'v8-mcp-login-'));
  const driver = scriptedHost(kind, { cwd: directory, mcpTransports: { remote: 'http', local: 'stdio' }, ...(persistent ? { mcpOAuthTokenStorage: 'persistent' as const } : {}) });
  const host = await openHost({ scope, directory, cwd: directory, controller: driver.controller, observationMs: 60000, policy: kind === 'codex' ? { kind, provider: 'copilot-only', access: { approval: 'on-request', sandbox: 'danger-full-access' } } : { kind, provider: 'copilot-only', permissions: 'manual' } });
  const sessions = { session: async () => host.session };
  const codex = codexHarnessRouter({ sessions }).createCaller(context), copilot = copilotHarnessRouter({ sessions }).createCaller(context);
  const login = (id: string, serverName = 'remote', forceReauth?: boolean) => kind === 'codex' ? codex.submit({ id, generation: 1, command: { type: 'codex.mcp.login', serverName } }) : copilot.submit({ id, generation: 1, command: { type: 'copilot.mcp.login', serverName, ...(forceReauth === undefined ? {} : { forceReauth }) } });
  await host.session.submit({ scope, id: 'create', generation: 0, command: { type: 'create' } });
  const binding = (await host.binding())!;
  return { driver, host, directory, binding, login, codex, copilot,
    link: (originalId: string) => (kind === 'codex' ? codex : copilot).loginLink({ generation: 1, nativeSession: binding.run.nativeSession, originalId }),
    async close() { const snapshot = await host.session.snapshot(scope); if (snapshot.phase !== 'stopped') await host.session.submit({ scope, id: 'cleanup-stop', generation: snapshot.generation, command: { type: 'stop' } }); await until(() => host.updateReadiness().ready); await host.terminate(); await rm(directory, { recursive: true, force: true }); } };
}
async function privateBytes(directory: string): Promise<Buffer[]> {
  const result: Buffer[] = [];
  for (const value of await readdir(directory, { withFileTypes: true })) if (value.isDirectory()) result.push(...await privateBytes(join(directory, value.name))); else if (value.isFile()) result.push(await readFile(join(directory, value.name)));
  return result;
}
async function composedFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'v8-mcp-login-composed-'));
  const driver = scriptedHost('codex', { cwd: directory, mcpTransports: { remote: 'http' } });
  const runtime = await defaultLifecycle({ directory: join(directory, 'host'), observationMs: 60000, workspace: existingDirectoryWorkspace(), policy: { kind: 'codex', provider: 'copilot-only', access: { approval: 'on-request', sandbox: 'danger-full-access' } },
    harness: { kind: 'harness', nativeKind: 'codex', protocol: driver.controller.protocol, identity: { id: 'scripted.codex', version: 1, recordVersion: 1 }, capabilities: [], async create() { return { controller: driver.controller }; } },
  }).open({ route: context.route, storage: null });
  await runtime.sessions.create(scope, 'create', { cwd: directory });
  await until(async () => (await runtime.sessions.original(scope, 'create'))?.state === 'acknowledged', 20000);
  const route = lifecycleSessionRoute({ sessions: runtime.sessions, target, controlCatalog: () => driver.controller.catalog() });
  const host = await runtime.sessions.agent(scope), binding = (await route.binding!())!;
  const codex = codexHarnessRouter({ sessions: runtime.sessions }).createCaller(context);
  return { driver, host, binding, route, codex, login: (id: string) => codex.submit({ id, generation: 1, command: { type: 'codex.mcp.login', serverName: 'remote' } }),
    async close() { await route.session.submit({ scope, id: 'cleanup-stop', generation: 1, command: { type: 'stop' } }); await until(() => runtime.readiness().ready); route.close(); await runtime.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('actual SessionHost originals + both typed routers: lost reply/two viewers never repeat login or persist its URL', async () => {
  for (const kind of ['codex', 'copilot'] as const) {
    const f = await fixture(kind), entered = deferred<void>(), release = deferred<void>(); let calls = 0;
    f.driver.login = async () => { calls++; entered.resolve(); await release.promise; return { authorizationUrl: url, ...(kind === 'codex' ? { loginId: 'native-login' } : {}) }; };
    try {
      const first = f.login('original-login'); await entered.promise;
      const second = f.login('original-login'); assert.equal(calls, 1);
      release.resolve(); assert.notEqual((await second).state, 'refused'); await assert.rejects(first.then(() => { throw Error('Scripted reply loss after actual commit'); }));
      const receipt = await f.host.session.receipt(scope, 'original-login'); assert.equal(receipt?.state, 'acknowledged'); assert.deepEqual(receipt?.outcome, { status: 'acknowledged', detail: { login: 'initiated' } });
      for (let viewer = 0; viewer < 2; viewer++) { const link = await f.link('original-login'); assert.equal(link.state, 'available'); if (link.state === 'available') assert.equal(link.authorizationUrl, url); }
      assert.equal((await f.login('local-refusal', 'local')).state, 'refused'); assert.equal((await f.login('new-intent-while-owned', 'remote', true)).state, 'refused'); assert.equal(calls, 1);
      const visible = JSON.stringify([await f.host.session.snapshot(scope), await f.host.mcp.snapshot(f.binding.run), f.host.history.snapshot(f.binding.history), receipt]);
      assert.doesNotMatch(visible, /PRIVATE_TRANSIENT_MARKER|authorizationUrl/);
      for (const bytes of await privateBytes(f.directory)) assert.equal(bytes.includes(Buffer.from('PRIVATE_TRANSIENT_MARKER')), false, 'Private original/history stores must not retain authorization URL');
      assert.equal(f.driver.counts.opens, 1); assert.equal(f.driver.counts.sends, 0); assert.equal(f.driver.counts.discovery, 0);
    } finally { release.resolve(); await f.close(); }
  }
});

test('exact native correlation, unknown manual flow and Stop fence: old/child results cannot publish or infer authentication', async () => {
  const codex = await fixture('codex');
  try {
    codex.driver.login = async () => { codex.driver.notify('mcpServer/oauthLogin/completed', { threadId: codex.binding.run.nativeSession, name: 'remote', loginId: 'early-id', success: true, error: url }); return { authorizationUrl: url, loginId: 'early-id' }; };
    assert.equal((await codex.login('early')).state, 'acknowledged'); assert.deepEqual(await codex.link('early'), { state: 'unavailable', reason: 'notRetained', status: 'succeeded' });
    codex.driver.login = async () => ({ authorizationUrl: url, loginId: 'next-id' }); await codex.login('next');
    for (const fields of [{ threadId: 'child', loginId: 'next-id' }, { threadId: codex.binding.run.nativeSession, loginId: 'old-id' }]) codex.driver.notify('mcpServer/oauthLogin/completed', { ...fields, name: 'remote', success: true });
    assert.equal((await codex.link('next')).state, 'available');
    codex.driver.notify('mcpServer/oauthLogin/completed', { threadId: codex.binding.run.nativeSession, name: 'remote', loginId: 'next-id', success: false });
    assert.equal((await codex.link('next')).status, 'failed');
    assert.doesNotMatch(JSON.stringify(codex.host.history.snapshot(codex.binding.history)), /PRIVATE_TRANSIENT_MARKER/);
  } finally { await codex.close(); }
  const copilot = await fixture('copilot');
  try {
    copilot.driver.login = async () => ({}); await copilot.login('reused'); assert.equal((await copilot.link('reused')).status, 'reused');
    copilot.driver.login = async () => ({ authorizationUrl: url }); await copilot.login('browser'); copilot.driver.event('session.mcp_server_status_changed', { serverName: 'remote', status: 'connected' });
    assert.equal((await copilot.link('browser')).status, 'initiated');
    await copilot.host.session.submit({ scope, id: 'stop', generation: 1, command: { type: 'stop' } });
    await assert.rejects(copilot.link('browser')); assert.deepEqual(await copilot.host.session.receipt(scope, 'browser'), await copilot.copilot.original({ id: 'browser' }));
  } finally { await copilot.close(); }
  const late = await fixture('codex'), entered = deferred<void>(), release = deferred<void>();
  late.driver.login = async () => { entered.resolve(); await release.promise; return { authorizationUrl: url, loginId: 'late' }; };
  try {
    const pending = late.login('late'); await entered.promise; await late.host.session.submit({ scope, id: 'stop', generation: 1, command: { type: 'stop' } }); release.resolve(); await pending;
    await assert.rejects(late.link('late')); assert.equal(late.driver.counts.stops, 1);
  } finally { release.resolve(); await late.close(); }
  const persistent = await fixture('copilot', true); let unsafe = 0; persistent.driver.login = async () => { unsafe++; return {}; };
  try { assert.equal((await persistent.login('unsupported-persistent')).state, 'refused'); assert.equal(unsafe, 0); } finally { await persistent.close(); }
});

test('passive Gateway HTTP/router authorization and bounded display expiry do not dispatch/cancel/replay login', async () => {
  const f = await composedFixture(); f.driver.login = async () => ({ authorizationUrl: url, loginId: 'native-login' });
  const coordinator = new GatewayCoordinator();
  const identity = { connection: scope.connection, principal: scope.principal, authorities: ['catalog'], actions: ['read', 'control'] as const };
  coordinator.register(f.route);
  try {
    await f.login('login');
    const readOnly = { ...identity, actions: ['read'] as const };
    assert.throws(() => coordinator.mcpLoginLink(readOnly, target, f.binding.run, 'login'), { code: 'FORBIDDEN' });
    assert.throws(() => coordinator.mcpLoginLink({ ...identity, principal: 'another' }, target, f.binding.run, 'login'));
    await assert.rejects(f.codex.loginLink({ generation: 2, nativeSession: f.binding.run.nativeSession, originalId: 'login' }));
    const readCaller = codexHarnessRouter({ sessions: { session: async () => f.host.session } }).createCaller({ ...context, identity: { ...context.identity, actions: ['read'] } });
    await assert.rejects(readCaller.loginLink({ generation: 1, nativeSession: f.binding.run.nativeSession, originalId: 'login' }), { code: 'FORBIDDEN' });
    const handler = createGatewayHttpHandler(coordinator, async () => identity);
    const transport = new HttpGatewayTransport({ url: 'http://in-process.invalid/v8', authorization: 'scripted-only', fetch: async (_request, init) => {
      assert.equal(init?.cache, 'no-store'); const finished = deferred<Response>();
      const req = Object.assign(Readable.from([Buffer.from(String(init?.body))]), { method: 'POST', url: '/v8', headers: { 'content-type': 'application/json' } }) as IncomingMessage;
      const headers: Record<string, string> = {}; let statusCode = 0;
      const reply = new EventEmitter();
      const res = Object.assign(reply, { destroyed: false, writableEnded: false, writeHead(status: number, values: Record<string, string>) { statusCode = status; Object.assign(headers, values); }, end(body: string) { this.writableEnded = true; reply.emit('close'); finished.resolve(new Response(body, { status: statusCode, headers })); }, destroy() { finished.reject(Error('Unexpected response destruction')); } }) as unknown as ServerResponse;
      handler(req, res); const response = await finished.promise; assert.equal(response.headers.get('cache-control'), 'no-store'); return response;
    } });
    try { const link = await transport.mcpLoginLink(target, f.binding.run, 'login'); assert.equal(link.state, 'available'); if (link.state === 'available') assert.equal(link.authorizationUrl, url); }
    finally { transport.close(); handler.close(); }
    let now = 10; const links = new LoginLinks(() => now); links.reset(f.binding.run); const slot = links.begin(f.binding.run, 'original', 'remote'); links.ready(slot, url);
    now += loginLimits.displayMs; assert.deepEqual(links.lookup(f.binding.run, 'original'), { state: 'unavailable', reason: 'displayExpired', status: 'initiated' }); assert.throws(() => links.begin(f.binding.run, 'another', 'remote'), { code: 'BUSY' });
    links.retire(); links.ready(slot, url); assert.equal(links.lookup(f.binding.run, 'original').state, 'unavailable');
    const config = codexMcpConfig({ remote: { type: 'http', url: 'https://mcp-fixture.invalid/mcp' }, local: { command: '/fixture/local', args: [] } });
    assert.equal(config.hasHttp, true); assert.match(config.text, /\[mcp_servers.remote\]\nurl = "https:\/\/mcp-fixture.invalid\/mcp"/); assert.deepEqual({ ...config.transports }, { remote: 'http', local: 'stdio' });
    assert.equal(f.driver.requests.filter(request => request.method === 'mcpServer/oauth/login').length, 1);
  } finally { coordinator.close(); await f.close(); }
});
