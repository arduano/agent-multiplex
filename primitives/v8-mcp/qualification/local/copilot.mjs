import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bounded, ensure, packageRoot, makeRuntime, exactRuntimeGone, forceOwnContainer } from '../../../v8-interactions/qualification/live/copilot-runtime.mjs';
import { readFixtureLog } from './fixture-server.mjs';

const SERVERS = ['v8_stdio', 'v8_http'];
const snapshotCounts = snapshot => {
  const events = snapshot?.events ?? []; return { starts: events.filter(event => event.event === 'start').length, initialize: events.filter(event => event.event === 'initialize').length, call: events.filter(event => event.event === 'tool-call').length };
};
const toolContains = (result, marker) => typeof result === 'string' ? result.includes(marker) : JSON.stringify(result).includes(marker);
async function until(test, ms, code) { const end = Date.now() + ms; while (!await test()) { ensure(Date.now() < end, code); await new Promise(done => setTimeout(done, 20)); } }

/** Root-launched only: one fresh CLI session, direct owned MCP tools, ZERO model Sends. */
export async function qualifyCopilot(ctx) {
  for (const name of ['toolRoot', 'buildRoot', 'nativeHome', 'workspace']) ensure(typeof ctx[name] === 'string' && isAbsolute(ctx[name]), 'MCP_COPILOT_PRIVATE_PATH_REQUIRED');
  ensure(resolve(ctx.nativeHome) !== resolve(ctx.toolRoot) && resolve(ctx.workspace) !== resolve(ctx.toolRoot), 'MCP_COPILOT_PRIVATE_ROOT_REQUIRED');
  const endpoint = new URL(ctx.endpoint); ensure(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1', 'MCP_COPILOT_LOCAL_DENY_PROVIDER_REQUIRED');
  ensure(ctx.model === 'gpt-6-luna' && typeof ctx.admit === 'function' && typeof ctx.registerNativeCleanup === 'function', 'MCP_COPILOT_ROOT_ALLOWANCE_REQUIRED');
  ensure(ctx.fixture && isAbsolute(ctx.fixture.stdioFile) && isAbsolute(ctx.fixture.stdioLog) && typeof ctx.fixture.httpUrl === 'string', 'MCP_COPILOT_OWNED_FIXTURES_REQUIRED');
  ensure(resolve(ctx.fixture.stdioFile).startsWith(resolve(ctx.workspace) + '/'), 'MCP_COPILOT_STDIO_MUST_BE_OWNED_MOUNT');
  const fixtureEndpoint = new URL(ctx.fixture.httpUrl); ensure(fixtureEndpoint.protocol === 'http:' && fixtureEndpoint.hostname === '127.0.0.1', 'MCP_COPILOT_REMOTE_MCP_FORBIDDEN');
  const result = { status: 'pending', kind: 'copilot', pins: { sdk: '1.0.19', cli: '1.0.95' }, cases: {}, counts: { nativeRequests: 0, events: 0, permissions: 0, elicitations: 0, modelEvents: 0, sends: 0 }, cleanup: {} };
  let client, session, runtime, owner, workspace, cleanupPromise, activeTool, run, fatal;
  const eventTypes = new Map();
  const record = (name, value) => ctx.record?.(`copilot:${name}`, value);
  async function rpc(label, work) {
    ensure(!fatal, fatal ?? 'MCP_COPILOT_RETIRED'); ctx.admit('copilot-rpc', label); result.counts.nativeRequests++;
    const value = await bounded(Promise.resolve().then(work), 20000, `MCP_COPILOT_${label.toUpperCase()}_DEADLINE`); ensure(!fatal, fatal ?? 'MCP_COPILOT_UNEXPECTED_EVENT'); return value;
  }
  function onEvent(event) {
    result.counts.events++; if (result.counts.events > 2048) { fatal = 'MCP_COPILOT_EVENT_BOUND'; return; }
    eventTypes.set(event.type, (eventTypes.get(event.type) ?? 0) + 1);
    if (/^(assistant\.(?:turn_start|usage)|model\.call|model_call|sampling\.requested)/.test(event.type)) { result.counts.modelEvents++; fatal = 'MCP_COPILOT_MODEL_ACTIVITY_FORBIDDEN'; }
    if (['mcp.tools.list_changed', 'session.mcp_server_status_changed', 'session.mcp_server_removed', 'session.mcp_server_needs_reconnect'].includes(event.type) && owner) {
      try { owner.invalidate(run); } catch { /* A retired owner never rediscovers native resources. */ }
    }
    record('event', { type: event.type });
  }
  async function permission(request, invocation) {
    ensure(activeTool && invocation.sessionId === run.nativeSession && request.kind === 'mcp' && request.serverName === activeTool.server && (request.toolName === activeTool.raw || request.toolName === activeTool.offered), 'MCP_COPILOT_UNPLANNED_PERMISSION');
    ensure(JSON.stringify(request.args ?? {}) === JSON.stringify(activeTool.args), 'MCP_COPILOT_PERMISSION_ARGUMENT_MISMATCH');
    result.counts.permissions++; ensure(result.counts.permissions <= 12, 'MCP_COPILOT_PERMISSION_BOUND');
    if (request.managedApprovalRequired) { ensure(typeof ctx.respondPermission === 'function', 'MCP_COPILOT_MANAGED_CONFIRMATION_REQUIRES_POPUP'); return ctx.respondPermission(request); }
    // The owner's finite fixture allowance authorizes exactly this harmless current call, once.
    return { kind: 'approve-once' };
  }
  function elicitation(context) {
    ensure(activeTool?.raw === 'elicit' && context.sessionId === run.nativeSession && context.message === 'Confirm the owned V8 MCP fixture' && context.requestedSchema?.type === 'object' && JSON.stringify(context.requestedSchema.required) === '["confirmation"]' && !context.url, 'MCP_COPILOT_UNPLANNED_ELICITATION');
    result.counts.elicitations++; ensure(result.counts.elicitations === 1, 'MCP_COPILOT_ELICITATION_BOUND');
    return { action: 'accept', content: { confirmation: 'V8_MCP_CONFIRMED' } };
  }
  const cleanup = () => cleanupPromise ??= (async () => {
    owner?.retire(); workspace?.close();
    if (session) { try { await bounded(session.disconnect(), 5000, 'MCP_COPILOT_DISCONNECT_DEADLINE'); result.cleanup.sessionDisconnected = true; } catch { result.cleanup.sessionDisconnected = false; } }
    if (client) {
      try { const errors = await bounded(client.stop(), 10000, 'MCP_COPILOT_STOP_DEADLINE'); result.cleanup.sdkStopAcknowledged = Array.isArray(errors) && errors.length === 0; }
      catch { result.cleanup.sdkStopAcknowledged = false; try { await bounded(client.forceStop(), 5000, 'MCP_COPILOT_FORCESTOP_DEADLINE'); } catch { /* Exact owned container cleanup follows. */ } }
      try { await bounded(client.getStatus(), 1000, 'MCP_COPILOT_POSTSTOP_DEADLINE'); result.cleanup.postStopRpcRejected = false; } catch { result.cleanup.postStopRpcRejected = true; }
    }
    if (runtime) { let gone = await exactRuntimeGone(runtime); if (!gone.containerRemoved) { await forceOwnContainer(runtime); gone = await exactRuntimeGone(runtime); } Object.assign(result.cleanup, gone); result.cleanup.runtimeGone = gone.processExited && gone.containerRemoved; }
    ensure(result.cleanup.runtimeGone && result.cleanup.postStopRpcRejected, 'MCP_COPILOT_OWNED_RELEASE_UNCONFIRMED');
  })();
  ctx.registerNativeCleanup(cleanup);
  try {
    const fromApp = createRequire(join(ctx.toolRoot, 'package.json')), sdk = await packageRoot(fromApp.resolve('@github/copilot-sdk'), '@github/copilot-sdk'), cli = fromApp.resolve('@github/copilot-linux-x64'), platform = await packageRoot(cli, '@github/copilot-linux-x64');
    ensure(sdk.metadata.version === '1.0.19' && sdk.metadata.copilotCliVersion === '1.0.95' && platform.metadata.version === '1.0.95', 'MCP_COPILOT_PIN_MISMATCH');
    const core = await import(pathToFileURL(join(ctx.buildRoot, 'primitives/v8-mcp/src/index.js')).href);
    runtime = await makeRuntime(cli, ctx);
    const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(join(sdk.directory, 'dist/index.js')).href);
    const nativeSession = randomUUID(), scope = { connection: 'v8-local-mcp', principal: 'finite-owner', host: 'owned-copilot', session: `logical-${nativeSession}` };
    run = { scope, generation: 1, nativeSession };
    const env = { PATH: process.env.PATH ?? '/run/current-system/sw/bin', LANG: 'C.UTF-8', HOME: ctx.nativeHome, COPILOT_HOME: ctx.nativeHome, TMPDIR: join(ctx.nativeHome, 'tmp'), XDG_CONFIG_HOME: join(ctx.nativeHome, 'xdg-config'), XDG_CACHE_HOME: join(ctx.nativeHome, 'xdg-cache'), XDG_DATA_HOME: join(ctx.nativeHome, 'xdg-data'), NODE_NO_WARNINGS: '1' };
    client = new CopilotClient({ mode: 'copilot-cli', connection: RuntimeConnection.forStdio({ path: runtime.filename, env }), workingDirectory: ctx.workspace, baseDirectory: ctx.nativeHome, useLoggedInUser: false, logLevel: 'none' });
    session = await rpc('fresh-session', () => client.createSession({ sessionId: nativeSession, model: ctx.model, allowedModels: [ctx.model], provider: { type: 'openai', wireApi: 'responses', transport: 'http', baseUrl: ctx.endpoint, apiKey: ctx.key, modelId: ctx.model, wireModel: ctx.model }, workingDirectory: ctx.workspace, configDirectory: ctx.nativeHome,
      mcpServers: { v8_stdio: { type: 'stdio', command: '/usr/local/bin/node', args: [ctx.fixture.stdioFile, '--stdio', '--log', ctx.fixture.stdioLog], tools: ['*'], timeout: 5000 }, v8_http: { type: 'http', url: ctx.fixture.httpUrl, tools: ['*'], timeout: 5000 } },
      streaming: true, availableTools: ['mcp:*'], disabledMcpServers: ['github'], enableConfigDiscovery: false, includedBuiltinAgents: [], customAgentsLocalOnly: true,
      onEvent, onPermissionRequest: permission, onElicitationRequest: elicitation,
      onMcpAuthRequest: () => { fatal = 'MCP_COPILOT_OAUTH_FORBIDDEN'; return { kind: 'cancelled' }; }, onUserInputRequest: () => { fatal = 'MCP_COPILOT_MODEL_QUESTION_FORBIDDEN'; throw new Error(fatal); },
    }));
    await rpc('manual-permission-mode', () => session.rpc.permissions.setMode({ mode: 'manual' }));
    const reads = new core.McpReadPool({ maxActive: 1 }), native = core.copilotMcpReadPort({ rpc: { mcp: { listConfigured: () => rpc('passive-configured-inventory', () => session.rpc.mcp.listConfigured()) } } });
    owner = new core.McpOwner({ run, epoch: 1, native, reads }); workspace = new core.McpWorkspace({ connection: scope.connection, principal: scope.principal, port: owner });
    const beforeBind = result.counts.nativeRequests; await workspace.bind(run, 'copilot'); ensure(result.counts.nativeRequests === beforeBind, 'MCP_COPILOT_BIND_DISCOVERED_NATIVE');
    const fixtureBefore = snapshotCounts(ctx.fixture.snapshot?.());
    const passive = await workspace.refresh(run); ensure(passive.kind === 'copilot' && passive.discovery === 'configured-passive' && passive.servers.some(server => server.name === 'v8_stdio') && passive.servers.some(server => server.name === 'v8_http'), 'MCP_COPILOT_CONFIGURED_INVENTORY_MISSING');
    result.cases.passive = { wrapperCalls: 1, bindingIsReadOnly: true, servers: passive.servers.map(server => ({ name: server.name, runtimeStatus: server.runtimeStatus })), fixtureBefore, fixtureAfter: snapshotCounts(ctx.fixture.snapshot?.()), startupNotAssumed: true };
    await rpc('initialize-native-tools', () => session.rpc.tools.initializeAndValidate());
    for (const serverName of SERVERS) { const listed = await rpc(`list-${serverName}`, () => session.rpc.mcp.listTools({ serverName })); ensure(listed.tools.some(tool => tool.name === 'echo') && listed.tools.some(tool => tool.name === 'elicit'), 'MCP_COPILOT_NATIVE_TOOLS_MISSING'); }
    let metadata = await rpc('offered-tool-metadata', () => session.rpc.tools.getCurrentMetadata());
    const offered = (server, raw) => { ensure(Array.isArray(metadata.tools), 'MCP_COPILOT_METADATA_MISSING'); const candidates = metadata.tools.filter(tool => tool.mcpServerName === server && tool.mcpToolName === raw); ensure(candidates.length === 1, 'MCP_COPILOT_EXACT_OFFER_UNPROVED'); return candidates[0].name; };
    async function call(server, raw, args, marker, expectedError = false) {
      const name = offered(server, raw); ensure(!activeTool, 'MCP_COPILOT_TOOL_ALREADY_ACTIVE'); activeTool = { server, raw, offered: name, args };
      try { const value = await rpc(`fixture-${server}-${raw}`, () => session.rpc.tools.execute({ name, arguments: args, toolCallId: `v8-local-${randomUUID()}` })); ensure(toolContains(value, marker), 'MCP_COPILOT_TOOL_OUTPUT_UNPROVED'); if (!expectedError) ensure(typeof value === 'string' || value.resultType === 'success', 'MCP_COPILOT_TOOL_NATIVE_FAILURE'); return value; }
      finally { activeTool = undefined; }
    }
    await call('v8_stdio', 'echo', { text: 'native-stdio' }, 'V8_MCP_ECHO:native-stdio'); await call('v8_http', 'echo', { text: 'native-http' }, 'V8_MCP_ECHO:native-http');
    const expectedError = await call('v8_stdio', 'fail', {}, 'V8_MCP_EXPECTED_ERROR', true); result.cases.tools = { stdioEcho: true, httpEcho: true, expectedErrorMarker: true, errorNativeResult: typeof expectedError === 'string' ? 'opaque-string' : expectedError.resultType ?? 'unknown' };
    await call('v8_http', 'wait', { ms: 25 }, 'V8_MCP_WAIT:25'); result.cases.delay = { boundedActualToolResult: true };
    const beforeChange = eventTypes.get('mcp.tools.list_changed') ?? 0; await call('v8_http', 'change_tools', {}, 'V8_MCP_GENERATION:2');
    await until(() => (eventTypes.get('mcp.tools.list_changed') ?? 0) > beforeChange, 5000, 'MCP_COPILOT_LIST_CHANGE_EVENT_MISSING');
    ensure(workspace.entry(run).getSnapshot().stale, 'MCP_COPILOT_INVALIDATION_NOT_PROPAGATED'); await workspace.refresh(run);
    const changed = await rpc('changed-native-tools', () => session.rpc.mcp.listTools({ serverName: 'v8_http' })); ensure(changed.tools.some(tool => tool.name === 'extra'), 'MCP_COPILOT_CHANGED_LIST_UNPROVED'); result.cases.change = { nativeEvent: true, retainedStaleThenRefresh: true, extraToolDiscovered: true };
    await call('v8_stdio', 'elicit', {}, 'V8_MCP_ELICIT:accept:V8_MCP_CONFIRMED'); ensure(result.counts.elicitations === 1, 'MCP_COPILOT_REAL_ELICITATION_NOT_OBSERVED'); result.cases.elicitation = { actualMcpRequest: true, exactSdkCallback: true, acceptedToolResult: true, productionPopupQualified: false };
    await rpc('stop-owned-stdio-server', () => session.rpc.mcp.stopServer({ serverName: 'v8_stdio' }));
    const stopped = await rpc('owned-stdio-stopped-check', () => session.rpc.mcp.isServerRunning({ serverName: 'v8_stdio' })); ensure(stopped.running === false, 'MCP_COPILOT_STOP_SERVER_UNPROVED');
    await workspace.refresh(run); result.cases.stop = { nativeRunningFalse: true, passiveReadDoesNotRestart: true };
    ensure((await rpc('passive-did-not-restart-check', () => session.rpc.mcp.isServerRunning({ serverName: 'v8_stdio' }))).running === false, 'MCP_COPILOT_PASSIVE_READ_RESTARTED_SERVER');
    await rpc('restart-owned-stdio-server', () => session.rpc.mcp.restartServer({ serverName: 'v8_stdio' }));
    ensure((await rpc('owned-stdio-restarted-check', () => session.rpc.mcp.isServerRunning({ serverName: 'v8_stdio' }))).running === true, 'MCP_COPILOT_RESTART_UNPROVED');
    metadata = await rpc('restarted-offered-metadata', () => session.rpc.tools.getCurrentMetadata()); await call('v8_stdio', 'echo', { text: 'native-restarted' }, 'V8_MCP_ECHO:native-restarted'); result.cases.restart = { exactOwnedServer: true, nativeRunningTrue: true, actualPostRestartTool: true };
    await workspace.refresh(run); const retained = workspace.entry(run); workspace.setConnected(run, false); workspace.setConnected(run, true); const beforeRead = result.counts.nativeRequests; await workspace.reobserve(run); ensure(result.counts.nativeRequests === beforeRead && retained.getSnapshot().snapshot?.kind === 'copilot', 'MCP_COPILOT_RECONNECT_DISCOVERED_NATIVE');
    result.cases.reconnect = { retainedHostOnly: true, noNativeDiscovery: true };
    ensure(result.counts.sends === 0 && result.counts.modelEvents === 0 && !fatal, 'MCP_COPILOT_MODEL_ACTIVITY_FORBIDDEN');
    await cleanup(); const events = await readFixtureLog(ctx.fixture.stdioLog); result.cleanup.stdioStarts = events.filter(event => event.event === 'start').length; result.cleanup.stdioStops = events.filter(event => event.event === 'stop').length;
    ensure(result.cleanup.stdioStarts >= 2, 'MCP_COPILOT_REAL_RESTART_PROCESS_UNOBSERVED'); result.status = 'passed-native-local-mcp-subset'; record('result', result); return result;
  } finally { await cleanup(); }
}
