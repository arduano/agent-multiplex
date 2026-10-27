/** Finite negative TLS gate over new owned loopback relays and actual published
 * Iroh endpoints. No trust bypass, deployed relay, agent or model is involved. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { get } from 'node:https';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initTRPC } from '@trpc/server';
import { createSharedSecretSecurity } from '@arduano/p2prpc-core';
import { startRelays } from './relays.mjs';

const lane = fileURLToPath(new URL('../..', import.meta.url));
const pause = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));

async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function httpsRequest(url, ca) {
  return new Promise((resolveRequest, reject) => {
    // The CA is scoped to this single request. Native Iroh and process/system
    // trust remain untouched; agent:false closes this probe's exact connection.
    const request = get(url, { agent: false, rejectUnauthorized: true,
      ...(ca === undefined ? {} : { ca }), signal: AbortSignal.timeout(2000) }, response => {
      response.resume();
      response.once('error', reject);
      response.once('end', () => resolveRequest(response.statusCode));
    });
    request.once('error', reject);
  });
}

async function runOwnedProbe({ directory }) {
  if (typeof directory !== 'string' || !directory || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('TLS qualification requires an owned directory and unchanged strict TLS');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await readdir(directory)).length) throw new Error('TLS qualification requires an empty owned directory');
  const [{ normalizeRelayPaths }, { openRelayNetwork }] = await Promise.all([
    import(pathToFileURL(resolve(lane, '.build/primitives/v8-gateway/src/node/relay-config.js')).href),
    import(pathToFileURL(resolve(lane, '.build/primitives/v8-gateway/src/node/relay-network.js')).href),
  ]);
  let relays, network, result, failure;
  const cleanup = { endpoints: false, relays: false };
  try {
    relays = await startRelays({ directory }); // Default TLS, no HTTP adapter.
    for (const relay of [relays.a, relays.b]) {
      assert.equal(relay.mode, 'tls');
      const status = await httpsRequest(relay.url, await readFile(relay.caPath));
      assert.ok(Number.isInteger(status) && status >= 100 && status < 600,
        'The owned HTTPS listener must respond when its fresh certificate is explicitly trusted');
      await assert.rejects(httpsRequest(relay.url), error =>
        ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
          'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error.code));
    }
    const t = initTRPC.create();
    const router = t.router({ inspect: t.procedure.query(() => 'no agent activated') });
    network = await bounded(openRelayNetwork({
      paths: normalizeRelayPaths([
        { id: 'a', relayUrl: relays.a.url, authToken: relays.a.authToken },
        { id: 'b', relayUrl: relays.b.url, authToken: relays.b.authToken },
      ]),
      node: { router, protocol: { applicationId: 'multiplex-owned-tls-refusal', contractVersion: '1' },
        createContext: context => context,
        security: createSharedSecretSecurity(randomBytes(32), { authorize: () => true }),
        limits: { shutdownTimeoutMs: 3000 },
      },
    }), 10_000, 'Owned production endpoint startup exceeded its qualification budget');
    const unavailable = { a: 0, b: 0 }, started = Date.now();
    do {
      for (const id of ['a', 'b']) {
        await assert.rejects(bounded(network.path(id).route(), 2000,
          'Owned route read exceeded its qualification budget'), { code: 'UNAVAILABLE' });
        unavailable[id]++;
      }
      await pause(250);
    } while (Date.now() - started < 3000);
    const stats = await relays.stats();
    assert.equal(stats.a.accepts, 0);
    assert.equal(stats.b.accepts, 0);
    result = {
      passed: true, productionFactory: 'published-default',
      relayVersion: relays.version, relayBinarySha256: relays.executableHash,
      tls: { mode: 'https', scopedCaRequestsSucceeded: 2, defaultNodeTrustRejected: 2,
        nativeTrustUnchanged: true, nativeHomeUnavailable: unavailable,
        observationMilliseconds: Date.now() - started, relayAccepts: { a: 0, b: 0 } },
      endpoints: 2, nativeAgentCalls: 0, modelCalls: 0,
      scope: 'Finite refusal of fresh untrusted loopback certificates; no positive public-TLS, deployed relay or firewall acceptance claim',
    };
  } catch (error) { failure = error; }
  const cleanups = await Promise.allSettled([
    network ? bounded(network.close(), 10_000, 'Owned TLS endpoints did not close within the qualification budget')
      .then(() => { cleanup.endpoints = true; }) : Promise.resolve(),
    relays ? bounded(relays.close(), 10_000, 'Owned TLS relays did not close within the qualification budget')
      .then(() => { cleanup.relays = true; }) : Promise.resolve(),
  ]);
  const errors = cleanups.flatMap(value => value.status === 'rejected' ? [value.reason] : []);
  if (failure || errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], 'Owned TLS refusal qualification failed');
  return { ...result, cleanup };
}

/** Own a separate process group so even a native startup/close hang cannot leave
 * an endpoint or relay behind when this finite qualification returns or fails. */
export async function runTlsRefusal({ directory }) {
  if (process.platform !== 'linux' || typeof directory !== 'string' || !directory) {
    throw new Error('TLS qualification requires Linux and a new owned directory');
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--owned-probe', resolve(directory)], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', overflow = false, timedOut = false, forced;
  const signalGroup = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  child.stdout.on('data', chunk => {
    if (output.length + chunk.length > 64 * 1024) { overflow = true; signalGroup('SIGKILL'); }
    else output += chunk.toString();
  });
  // Native diagnostics are private, bounded by process lifetime, and never
  // copied into portable receipts or surfaced as a credential-bearing error.
  child.stderr.resume();
  const timer = setTimeout(() => {
    timedOut = true; signalGroup('SIGTERM');
    forced = setTimeout(() => signalGroup('SIGKILL'), 2000);
  }, 60_000);
  let code;
  try {
    code = await new Promise((resolveExit, reject) => {
      child.once('error', () => reject(new Error('Owned TLS qualification process could not start')));
      child.once('exit', resolveExit);
    });
  } finally {
    clearTimeout(timer); clearTimeout(forced);
    signalGroup('SIGKILL'); // Exact newly owned group; no existing process is selected.
  }
  if (code !== 0 || timedOut || overflow) throw new Error('Owned TLS refusal qualification process failed');
  let evidence;
  try { evidence = JSON.parse(output); }
  catch { throw new Error('Owned TLS qualification returned invalid evidence'); }
  assert.equal(evidence.passed, true);
  assert.deepEqual(evidence.cleanup, { endpoints: true, relays: true });
  return { ...evidence, processGroup: { isolated: true, settled: true } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const worker = process.argv[2] === '--owned-probe', directory = process.argv[worker ? 3 : 2];
  if (!directory) throw new Error('Provide a new owned TLS qualification directory');
  const result = await (worker ? runOwnedProbe : runTlsRefusal)({ directory: resolve(directory) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
