import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixtureService, fixtureCliPath, readFixtureLog } from './fixture-server.mjs';

async function deadline(work, ms = 10000) { let timer; try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture qualification deadline')), ms); })]); } finally { clearTimeout(timer); } }
async function exactChildGone(identity) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const stat = await readFile(`/proc/${identity.pid}/stat`, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat || stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] !== identity.start) return true;
    await new Promise(done => setTimeout(done, 20));
  }
  return false;
}

/** Independent published MCP SDK oracle. Root alone invokes the finite qualification. */
export async function qualifyFixtures(ctx) {
  assert.equal(typeof ctx.sdkRoot, 'string'); assert.equal(typeof ctx.workspace, 'string'); await mkdir(ctx.workspace, { recursive: true, mode: 0o700 });
  const load = path => import(pathToFileURL(join(ctx.sdkRoot, 'dist/esm', path)).href);
  const metadata = JSON.parse(await readFile(join(ctx.sdkRoot, 'package.json'), 'utf8')); assert.equal(metadata.version, '1.26.0'); assert.equal(metadata.name, '@modelcontextprotocol/sdk');
  const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }, { ElicitRequestSchema, ToolListChangedNotificationSchema }] = await Promise.all([load('client/index.js'), load('client/stdio.js'), load('client/streamableHttp.js'), load('types.js')]);
  const service = await createFixtureService({ logPath: join(ctx.workspace, 'direct-http.jsonl') });
  let stdioTransport, stdioClient, httpClient, httpTransport, cleanupPromise;
  const logPath = join(ctx.workspace, 'direct-stdio.jsonl');
  const cleanup = () => cleanupPromise ??= (async () => {
    // Every resource is attempted even when an earlier close fails or exercise never returned its client.
    const outcomes = await Promise.allSettled([
      () => httpTransport?.terminateSession(), () => httpClient?.close(), () => stdioClient?.close(),
      () => httpTransport?.close(), () => stdioTransport?.close(), () => service.close(),
    ].map(close => deadline(Promise.resolve().then(close))));
    if (outcomes.slice(3).some(result => result.status === 'rejected')) throw new Error('Owned fixture transport cleanup failed');
  })();
  ctx.registerNativeCleanup?.(cleanup);
  const result = { status: 'pending', independentClient: { package: metadata.name, version: metadata.version }, transports: {}, cleanup: {}, nativeOrModelCalls: 0 };
  async function exercise(transport, label) {
    const client = new Client({ name: `multiplex-v8-direct-${label}`, version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
    let notifications = 0, elicitation = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notifications++; });
    client.setRequestHandler(ElicitRequestSchema, request => {
      assert.equal(request.params.message, 'Confirm the owned V8 MCP fixture'); assert.equal(request.params.requestedSchema?.type, 'object');
      assert.deepEqual(request.params.requestedSchema.required, ['confirmation']); elicitation++;
      return { action: 'accept', content: { confirmation: 'V8_MCP_CONFIRMED' } };
    });
    await deadline(client.connect(transport));
    const initial = await deadline(client.listTools()); assert.deepEqual(initial.tools.map(tool => tool.name), ['echo', 'fail', 'wait', 'change_tools', 'elicit']);
    const echo = await deadline(client.callTool({ name: 'echo', arguments: { text: label } })); assert.equal(echo.isError ?? false, false); assert.equal(echo.content[0].text, `V8_MCP_ECHO:${label}`);
    const error = await deadline(client.callTool({ name: 'fail', arguments: {} })); assert.equal(error.isError, true); assert.equal(error.content[0].text, 'V8_MCP_EXPECTED_ERROR');
    const waited = await deadline(client.callTool({ name: 'wait', arguments: { ms: 25 } })); assert.equal(waited.content[0].text, 'V8_MCP_WAIT:25');
    await assert.rejects(deadline(client.callTool({ name: 'wait', arguments: { ms: 501 } })));
    const changed = await deadline(client.callTool({ name: 'change_tools', arguments: {} })); assert.equal(changed.content[0].text, 'V8_MCP_GENERATION:2');
    const after = await deadline(client.listTools()); assert.equal(after.tools.length, 6); assert.equal(after.tools.at(-1).name, 'extra'); assert.equal(notifications, 1);
    const extra = await deadline(client.callTool({ name: 'extra', arguments: {} })); assert.equal(extra.content[0].text, 'V8_MCP_EXTRA:2');
    const form = await deadline(client.callTool({ name: 'elicit', arguments: {} })); assert.equal(form.isError ?? false, false); assert.equal(form.content[0].text, 'V8_MCP_ELICIT:accept:V8_MCP_CONFIRMED'); assert.equal(elicitation, 1);
    result.transports[label] = { initialized: true, listTools: initial.tools.length, errorPreserved: true, boundedDelay: true, invalidArgumentRefused: true, notification: notifications, changedTools: after.tools.length, elicitation, echo: true };
    return client;
  }
  try {
    stdioTransport = new StdioClientTransport({ command: process.execPath, args: [fixtureCliPath, '--stdio', '--log', logPath], cwd: ctx.workspace, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: ctx.workspace }, stderr: 'pipe' });
    stdioClient = await exercise(stdioTransport, 'stdio');
    httpTransport = new StreamableHTTPClientTransport(new URL(service.url)); httpClient = await exercise(httpTransport, 'http');
    const started = (await readFixtureLog(logPath)).find(event => event.event === 'start'); assert.ok(started?.pid && started.start);
    await cleanup(); assert.equal(await exactChildGone(started), true);
    const events = await readFixtureLog(logPath); assert.ok(events.some(event => event.event === 'stop'));
    result.cleanup = { stdioExited: true, stdioStopObserved: true, httpClosed: true }; result.status = 'passed-independent-local-mcp'; return result;
  } finally { await cleanup(); }
}
