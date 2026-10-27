// Standalone genuine MCP server. Test-only Node builtins; safe to copy into an owned native workspace.
import { createServer } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixtureCliPath = fileURLToPath(import.meta.url);
export const FIXTURE_CONFIRMATION = 'V8_MCP_CONFIRMED';
const MAX_MESSAGES = 512, MAX_BYTES = 65536;
const failure = (code, message) => Object.assign(new Error(message), { code });
const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });
const schema = properties => ({ type: 'object', properties, additionalProperties: false });
const definitions = [
  { name: 'echo', description: 'Echo a short owned fixture string', inputSchema: { ...schema({ text: { type: 'string', maxLength: 256 } }), required: ['text'] } },
  { name: 'fail', description: 'Return an intentional bounded tool error', inputSchema: schema({}) },
  { name: 'wait', description: 'Wait at most 500 milliseconds', inputSchema: { ...schema({ ms: { type: 'integer', minimum: 0, maximum: 500 } }), required: ['ms'] } },
  { name: 'change_tools', description: 'Publish a tool-list change for the owned fixture', inputSchema: schema({}) },
  { name: 'elicit', description: 'Request a harmless fixture confirmation form', inputSchema: schema({}) },
];
function logger(path) {
  let count = 0;
  return event => { if (count++ >= 2048) throw failure(-32000, 'Fixture log bound exceeded'); if (path) appendFileSync(path, JSON.stringify({ at: Date.now(), ...event }) + '\n', { mode: 0o600 }); };
}
function processIdentity() {
  try { const stat = readFileSync('/proc/self/stat', 'utf8'); return { pid: process.pid, ppid: process.ppid, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] }; }
  catch { return { pid: process.pid, ppid: process.ppid, start: null }; }
}

/** One initialized MCP protocol session, with bounded requests and server-to-client forms. */
function protocol({ record, transport, callbackTimeoutMs = 5000 }) {
  if (!Number.isSafeInteger(callbackTimeoutMs) || callbackTimeoutMs < 5000 || callbackTimeoutMs > 20000) throw new Error('Fixture callback timeout bound');
  let initialized = false, ready = false, closed = false, generation = 1, nextRequest = 0, messages = 0, capabilities = {};
  const pending = new Map(), timers = new Set();
  const counts = { initialize: 0, initialized: 0, list: 0, call: 0, notifications: 0, elicitation: 0 };
  const log = event => record({ transport, ...event });
  const delay = ms => new Promise((accept, reject) => {
    const timer = setTimeout(() => { timers.delete(timer); accept(); }, ms); timers.add(timer); pending.set(timer, { reject });
  }).finally(() => { for (const [key] of pending) if (typeof key === 'object' && !timers.has(key)) pending.delete(key); });
  const requestClient = (method, params, emit) => new Promise((accept, reject) => {
    if (pending.size >= 8) return reject(failure(-32000, 'Fixture callback capacity'));
    const id = `fixture-server-${++nextRequest}`;
    const timer = setTimeout(() => { pending.delete(id); reject(failure(-32000, 'Fixture callback deadline')); }, callbackTimeoutMs);
    pending.set(id, { accept, reject, timer }); emit({ jsonrpc: '2.0', id, method, params });
  });
  async function dispatch(method, params, emit) {
    if (method === 'initialize') {
      if (initialized) throw failure(-32600, 'Already initialized'); initialized = true; capabilities = params?.capabilities ?? {}; counts.initialize++;
      const supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
      const version = supported.includes(params?.protocolVersion) ? params.protocolVersion : '2025-06-18';
      log({ event: 'initialize', protocolVersion: version, elicitationSupported: Boolean(capabilities.elicitation) });
      return { protocolVersion: version, serverInfo: { name: 'multiplex-v8-local-fixture', version: '1.0.0' }, capabilities: { tools: { listChanged: true } } };
    }
    if (!initialized) throw failure(-32000, 'Not initialized');
    if (method === 'ping') return {};
    if (!ready) throw failure(-32000, 'Initialized notification required');
    if (method === 'tools/list') { counts.list++; log({ event: 'tools-list', generation }); return { tools: [...definitions, ...(generation > 1 ? [{ name: 'extra', description: 'Tool exposed after a list change', inputSchema: schema({}) }] : [])] }; }
    if (method === 'resources/list') return { resources: [] };
    if (method === 'resources/templates/list') return { resourceTemplates: [] };
    if (method === 'prompts/list') return { prompts: [] };
    if (method !== 'tools/call') throw failure(-32601, 'Method not found');
    const name = params?.name, args = params?.arguments ?? {}; counts.call++; log({ event: 'tool-call', name });
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw failure(-32602, 'Invalid fixture arguments');
    const keys = Object.keys(args);
    if (name === 'echo') { if (keys.length !== 1 || typeof args.text !== 'string' || args.text.length > 256) throw failure(-32602, 'Invalid echo'); return text(`V8_MCP_ECHO:${args.text}`); }
    if (name === 'wait') { if (keys.length !== 1 || !Number.isInteger(args.ms) || args.ms < 0 || args.ms > 500) throw failure(-32602, 'Invalid wait'); await delay(args.ms); return text(`V8_MCP_WAIT:${args.ms}`); }
    if (keys.length) throw failure(-32602, 'No arguments accepted');
    if (name === 'fail') return text('V8_MCP_EXPECTED_ERROR', true);
    if (name === 'extra' && generation > 1) return text(`V8_MCP_EXTRA:${generation}`);
    if (name === 'change_tools') {
      generation++; counts.notifications++; log({ event: 'tools-changed', generation }); emit({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); return text(`V8_MCP_GENERATION:${generation}`);
    }
    if (name === 'elicit') {
      if (!capabilities.elicitation) return text('V8_MCP_ELICIT_UNSUPPORTED', true);
      counts.elicitation++; log({ event: 'elicitation-requested' });
      const answer = await requestClient('elicitation/create', { message: 'Confirm the owned V8 MCP fixture', requestedSchema: { type: 'object', properties: { confirmation: { type: 'string', title: 'Fixture confirmation' } }, required: ['confirmation'] } }, emit);
      log({ event: 'elicitation-completed', action: answer?.action });
      return text(`V8_MCP_ELICIT:${answer?.action}:${answer?.content?.confirmation ?? ''}`);
    }
    throw failure(-32602, 'Unknown fixture tool');
  }
  return {
    snapshot: () => ({ ...counts, generation, initialized, ready, closed, pending: pending.size }),
    close() { if (closed) return; closed = true; for (const timer of timers) clearTimeout(timer); timers.clear(); for (const item of pending.values()) { if (item.timer) clearTimeout(item.timer); item.reject(failure(-32000, 'Fixture closed')); } pending.clear(); log({ event: 'connection-closed' }); },
    async receive(message, emit) {
      if (closed) throw failure(-32000, 'Fixture closed');
      if (++messages > MAX_MESSAGES || JSON.stringify(message).length > MAX_BYTES) throw failure(-32000, 'Fixture message bound');
      if (!message || message.jsonrpc !== '2.0' || Array.isArray(message)) throw failure(-32600, 'Invalid JSON-RPC');
      if (!message.method && Object.hasOwn(message, 'id')) {
        const item = pending.get(message.id); if (!item) throw failure(-32600, 'Unknown callback response'); pending.delete(message.id); clearTimeout(item.timer);
        if (message.error) item.reject(failure(-32000, 'Client callback failed')); else item.accept(message.result); return;
      }
      if (!Object.hasOwn(message, 'id')) {
        if (message.method === 'notifications/initialized') { if (!initialized) throw failure(-32600, 'Initialization order'); ready = true; counts.initialized++; log({ event: 'initialized' }); }
        return;
      }
      try { const result = await dispatch(message.method, message.params, emit); emit({ jsonrpc: '2.0', id: message.id, result }); }
      catch (error) { emit({ jsonrpc: '2.0', id: message.id, error: { code: Number.isInteger(error.code) ? error.code : -32603, message: error.message ?? 'Fixture failure' } }); }
    },
  };
}

export async function readFixtureLog(path) {
  let raw; try { raw = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (raw.length > 512 * 1024) throw new Error('Fixture log exceeds bound');
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/** Genuine bounded Streamable HTTP endpoint; each POST response owns its SSE messages. */
export async function createFixtureService({ logPath, callbackTimeoutMs = 5000 } = {}) {
  const events = [], sessions = new Map(), responses = new Set(), sockets = new Set(), write = logger(logPath);
  const record = event => { if (events.length >= 2048) throw new Error('Fixture event bound'); events.push(event); write(event); };
  record({ event: 'start', transport: 'http', ...processIdentity() });
  const server = createServer(async (request, response) => {
    responses.add(response); response.once('close', () => responses.delete(response));
    try {
      if (request.url !== '/mcp') { response.writeHead(404).end(); return; }
      const address = server.address(), expected = `http://127.0.0.1:${address.port}`;
      if (request.headers.origin && request.headers.origin !== expected) { response.writeHead(403).end(); return; }
      if (request.method === 'GET') { response.writeHead(405, { Allow: 'POST, DELETE' }).end(); return; }
      const id = request.headers['mcp-session-id'];
      if (request.method === 'DELETE') { const owned = sessions.get(id); if (!owned) { response.writeHead(404).end(); return; } owned.close(); sessions.delete(id); response.writeHead(200).end(); return; }
      if (request.method !== 'POST' || !String(request.headers['content-type'] ?? '').includes('application/json')) { response.writeHead(400).end(); return; }
      const version = request.headers['mcp-protocol-version']; if (version && !['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(version)) { response.writeHead(400).end(); return; }
      let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > MAX_BYTES) throw failure(-32600, 'HTTP body bound'); }
      const message = JSON.parse(raw); let connection = sessions.get(id), sessionId = id;
      if (message.method === 'initialize' && !id) { if (sessions.size >= 16) throw failure(-32000, 'HTTP connection bound'); sessionId = randomUUID(); connection = protocol({ record, transport: 'http', callbackTimeoutMs }); sessions.set(sessionId, connection); }
      if (!connection) { response.writeHead(id ? 404 : 400).end(); return; }
      const isRequest = typeof message.method === 'string' && Object.hasOwn(message, 'id');
      if (!isRequest) { await connection.receive(message, () => { throw new Error('Unexpected response to notification'); }); response.writeHead(202).end(); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Mcp-Session-Id': sessionId });
      await connection.receive(message, value => { if (!response.destroyed) response.write(`event: message\ndata: ${JSON.stringify(value)}\n\n`); }); response.end();
    } catch { if (!response.headersSent) response.writeHead(400); response.end(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  let closing;
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, snapshot: () => ({ events: structuredClone(events), connections: [...sessions.values()].map(value => value.snapshot()) }),
    close() { if (closing) return closing; closing = (async () => { for (const session of sessions.values()) session.close(); sessions.clear(); for (const response of responses) response.destroy(); for (const socket of sockets) socket.destroy(); await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept())); record({ event: 'stop', transport: 'http' }); })(); return closing; } };
}

async function stdio(logPath, callbackTimeoutMs = 5000) {
  const record = logger(logPath), connection = protocol({ record, transport: 'stdio', callbackTimeoutMs }); let buffer = '', ended = false;
  record({ event: 'start', transport: 'stdio', ...processIdentity() });
  const close = () => { if (ended) return; ended = true; connection.close(); record({ event: 'stop', transport: 'stdio' }); process.stdin.destroy(); };
  process.once('SIGTERM', close); process.once('SIGINT', close); process.stdin.once('end', close); process.stdin.once('error', close);
  process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => {
    buffer += chunk; if (buffer.length > MAX_BYTES) { close(); return; }
    let newline; while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue;
      let message; try { message = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue; }
      void connection.receive(message, value => process.stdout.write(JSON.stringify(value) + '\n')).catch(() => close());
    }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fixtureCliPath) {
  const args = process.argv.slice(2), logIndex = args.indexOf('--log');
  if (!args.includes('--stdio') || logIndex < 0 || !args[logIndex + 1]) throw new Error('Owned fixture requires --stdio --log path');
  const timeoutIndex = args.indexOf('--callback-timeout-ms');
  await stdio(args[logIndex + 1], timeoutIndex < 0 ? 5000 : Number(args[timeoutIndex + 1]));
}
