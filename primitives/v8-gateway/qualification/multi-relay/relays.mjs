/** Disposable, loopback-only real Iroh relay servers. Never contacts a deployed relay. */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, createPrivateKey, sign } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, access, copyFile, cp, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const lane = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const version = '1.0.2'; // Exact iroh-relay version in the published native fork's Cargo.lock.
const delay = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));

async function command(binary, args, options = {}) {
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let output = '';
  const record = chunk => { output = (output + chunk.toString()).slice(-32_768); };
  child.stdout.on('data', record); child.stderr.on('data', record);
  const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
  try {
    await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolveExit() : reject(new Error(`Disposable relay command failed (${code ?? signal}): ${output}`)));
    });
  } finally { clearTimeout(timer); }
  return output;
}

/** Explicit binary overrides are qualification inputs, never application dependencies. */
export async function relayBinary({ directory, binary } = {}) {
  if (binary) { await access(binary); return binary; }
  const cached = join(lane, '.cache/multi-relay-bootstrap/target/debug/iroh-relay');
  try { await access(cached); return cached; } catch { /* Build only into this fixture's owned directory. */ }
  if (!directory) throw new Error('A disposable build directory is required');
  const registry = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'registry/src');
  const registryDirectories = await readdir(registry);
  let source;
  for (const name of registryDirectories) {
    const candidate = join(registry, name, `iroh-relay-${version}`);
    try { await access(join(candidate, 'Cargo.toml')); source = candidate; break; } catch { /* Next cached registry. */ }
  }
  if (!source) throw new Error(`Exact cached iroh-relay ${version} source unavailable; provide an explicit compatible fixture binary`);
  const build = join(directory, 'relay-build'), copy = join(build, 'source');
  await mkdir(copy, { recursive: true, mode: 0o700 });
  await cp(join(source, 'src'), join(copy, 'src'), { recursive: true });
  for (const name of ['build.rs', 'Cargo.lock', 'README.md']) await copyFile(join(source, name), join(copy, name));
  // Registry source remains untouched. Unused development targets can require uncached
  // metadata even when Cargo only builds the server; omit them in this disposable copy.
  const manifest = (await readFile(join(source, 'Cargo.toml'), 'utf8')).split(/(?=^\[)/m)
    .filter(block => !/^\[(?:dev-dependencies|\[test\]|\[bench\])/.test(block)).join('');
  await writeFile(join(copy, 'Cargo.toml'), manifest);
  await command('cargo', ['build', '--offline', '--manifest-path', join(copy, 'Cargo.toml'), '--features', 'server', '--bin', 'iroh-relay', '--target-dir', join(build, 'target')]);
  return join(build, 'target/debug/iroh-relay');
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

const counterNames = ['bytes_sent', 'bytes_recv', 'send_packets_sent', 'send_packets_recv', 'send_packets_dropped', 'accepts', 'disconnects', 'http_connections', 'http_connections_closed'];
function counters(text) {
  const result = Object.fromEntries(counterNames.map(name => [name, 0]));
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const match = /^(\S+)\s+([0-9.e+-]+)(?:\s|$)/i.exec(line);
    if (!match) continue;
    for (const name of counterNames) if (match[1] === `relay_relayserver_${name}` || match[1] === `relay_relayserver_${name}_total` || match[1].endsWith(`_${name}`) || match[1].endsWith(`_${name}_total`)) result[name] += Number(match[2]);
  }
  return result;
}

async function startOne(binary, directory, label, mode) {
  const owned = join(directory, label);
  await mkdir(owned, { recursive: false, mode: 0o700 });
  const [httpPort, tlsPort, metricsPort] = await Promise.all([unusedPort(), unusedPort(), unusedPort()]);
  if (new Set([httpPort, tlsPort, metricsPort]).size !== 3) throw new Error('Disposable port allocation collided; retry the fixture');
  const authToken = randomBytes(32).toString('hex');
  const certPath = join(owned, 'certificate.pem'), keyPath = join(owned, 'key.pem');
  if (mode === 'tls') await command('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', keyPath, '-out', certPath]);
  const configPath = join(owned, 'relay.toml');
  const config = [
    `http_bind_addr = "127.0.0.1:${httpPort}"`, 'enable_quic_addr_discovery = false', 'enable_metrics = true',
    `metrics_bind_addr = "127.0.0.1:${metricsPort}"`, 'access.shared_token = ["overridden-by-disposable-environment"]',
    ...(mode === 'tls' ? ['[tls]', `https_bind_addr = "127.0.0.1:${tlsPort}"`, 'cert_mode = "Manual"', `manual_cert_path = ${JSON.stringify(certPath)}`, `manual_key_path = ${JSON.stringify(keyPath)}`] : []),
  ].join('\n');
  await writeFile(configPath, config, { mode: 0o600 });
  const child = spawn(binary, ['--config-path', configPath, ...(mode === 'http-development' ? ['--dev'] : [])], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, IROH_RELAY_ACCESS_TOKEN: authToken, RUST_LOG: 'error' },
  });
  let exited = false, failure, output = '';
  child.once('error', error => { failure = error; exited = true; });
  const finished = new Promise(resolveExit => {
    child.once('error', resolveExit);
    child.once('exit', (code, signal) => { exited = true; failure ??= new Error(`Relay ${label} exited (${code ?? signal})`); resolveExit(); });
  });
  const capture = chunk => { output = (output + chunk.toString().replaceAll(authToken, '[disposable-token]')).slice(-16_384); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  let closing;
  const close = () => closing ??= (async () => {
    if (!exited) child.kill('SIGTERM');
    let timer;
    try { await Promise.race([finished, new Promise((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Relay ${label} did not close within five seconds`)); }, 5000); })]); }
    catch (error) { await finished; throw error; }
    finally {
      clearTimeout(timer);
      for (const path of [configPath, keyPath]) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  })();
  const readStats = async () => {
    const response = await fetch(`http://127.0.0.1:${metricsPort}/metrics`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`Relay metrics HTTP ${response.status}`);
    return counters(await response.text());
  };
  try {
    const deadline = Date.now() + 15_000;
    while (true) {
      if (exited) throw new Error(`${failure?.message}: ${output}`);
      try { await readStats(); break; } catch (error) { if (Date.now() > deadline) throw error; await delay(50); }
    }
    const result = { url: `${mode === 'tls' ? 'https' : 'http'}://127.0.0.1:${mode === 'tls' ? tlsPort : httpPort}`, mode, caPath: mode === 'tls' ? certPath : undefined, pid: child.pid, stats: readStats, close };
    // Credentials are available to the owned endpoint constructor, but excluded from receipts/JSON.
    Object.defineProperty(result, 'authToken', { value: authToken, enumerable: false });
    return result;
  } catch (error) { await close(); throw error; }
}

/**
 * Starts two real, independently authenticated relay servers. Default TLS uses
 * disposable certificates: the published native wrapper cannot trust these.
 * http-development is an explicit native-test adapter boundary, never a production URL.
 */
export async function startRelays({ directory, binary, mode = 'tls' }) {
  if (!['tls', 'http-development'].includes(mode)) throw new Error('Unknown disposable relay mode');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const executable = await relayBinary({ directory, binary });
  const executableHash = createHash('sha256').update(await readFile(executable)).digest('hex');
  let a, b;
  try {
    a = await startOne(executable, directory, 'relay-a', mode);
    b = await startOne(executable, directory, 'relay-b', mode);
  } catch (error) {
    const cleanup = await Promise.allSettled([a?.close(), b?.close()]);
    const failures = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError([error, ...failures], 'Relay startup and cleanup failed');
    throw error;
  }
  let closing;
  return {
    a, b, version, executableHash,
    stats: async () => ({ a: await a.stats(), b: await b.stats() }),
    close: () => closing ??= (async () => {
      const results = await Promise.allSettled([a.close(), b.close()]);
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Owned relay cleanup failed');
    })(),
  };
}

/**
 * Explicit qualification adapter: published p2prpc framing/security over actual
 * pinned native Iroh sessions through local HTTP relays. It does not implement
 * or qualify the production HTTPS IrohEndpoint wrapper or DNS discovery.
 */
export async function createLocalRelayNode(options, { relay, allowedRelays = [relay] }) {
  const { createAdvancedP2PNode } = await import('@arduano/p2prpc-core/advanced');
  const { P2PError } = await import('@arduano/p2prpc-core');
  const { createNode, PublicKey } = await import('@momics/iroh-http-node');
  const origins = new Set(allowedRelays.map(value => value.url));
  for (const value of allowedRelays) {
    const url = new URL(value.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || value.mode !== 'http-development') throw new Error('Local relay adapter accepts only owned loopback HTTP relay fixtures');
  }
  if (!origins.has(relay.url)) throw new Error('Home relay must belong to the fixture allowlist');
  const fail = (code, message) => new P2PError(code, message);
  const prefix = 'multiplex-local-http-v1';
  const domain = Buffer.from(`${prefix}\0`);

  const send = stream => {
    const writer = stream.getWriter();
    let terminal;
    const end = method => terminal ??= (async () => { try { await writer[method](); } finally { writer.releaseLock(); } })();
    return { writeAll: value => writer.write(value), finish: () => end('close'), reset: () => end('abort'), setPriority: async () => {} };
  };
  const receive = stream => {
    const reader = stream.getReader();
    let buffered = new Uint8Array(), terminal, released = false;
    const release = () => { if (!released) { released = true; reader.releaseLock(); } };
    return {
      async readExact(size) {
        if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024) throw fail('RESOURCE_LIMIT', 'Fixture read size exceeded');
        const output = new Uint8Array(size);
        let offset = 0;
        while (offset < size) {
          if (!buffered.length) {
            const result = await reader.read();
            if (result.done) { release(); throw fail('DISCONNECTED', 'Native fixture stream ended early'); }
            buffered = result.value;
          }
          const count = Math.min(size - offset, buffered.length);
          output.set(buffered.subarray(0, count), offset); buffered = buffered.subarray(count); offset += count;
        }
        return output;
      },
      expectEnd: () => terminal ??= (async () => {
        try {
          if (buffered.length) throw fail('INVALID_FRAME', 'Trailing fixture stream bytes');
          while (true) {
            const result = await reader.read();
            if (result.done) return;
            if (result.value.length) throw fail('INVALID_FRAME', 'Trailing fixture stream bytes');
          }
        } finally { release(); }
      })(),
      stop: () => terminal ??= (async () => { try { await reader.cancel(); } finally { release(); } })(),
    };
  };
  const wrapSession = (session, native, side) => {
    const bi = session.incomingBidirectionalStreams.getReader(), uni = session.incomingUnidirectionalStreams.getReader();
    const wrapBi = stream => ({ send: send(stream.writable), recv: receive(stream.readable) });
    const next = async reader => { const result = await reader.read(); if (result.done) throw fail('DISCONNECTED', 'Native session closed'); return result.value; };
    const physical = session.closed.then(info => info.reason);
    physical.catch(() => {});
    const remoteId = session.remoteId.toString(), connectionId = randomBytes(12).toString('hex');
    return {
      remoteId, side,
      openBi: async () => wrapBi(await session.createBidirectionalStream()),
      acceptBi: async () => wrapBi(await next(bi)),
      openUni: async () => send(await session.createUnidirectionalStream()),
      acceptUni: async () => receive(await next(uni)),
      closed: () => physical,
      close: (code, reason) => session.close({ closeCode: Number(code), reason: new TextDecoder().decode(reason) }),
      stats: async () => {
        const value = await native.peerStats(remoteId);
        return { connectionId, rttMs: value?.rttMs ?? null, sentBytes: value?.bytesSent ?? 0, receivedBytes: value?.bytesReceived ?? 0, lostPackets: value?.lostPackets ?? 0, relay: value?.relay ?? null, relayUrl: value?.relayUrl ?? null,
          paths: (value?.paths ?? []).map(path => ({ relay: path.relay, address: path.addr, active: path.active })) };
      },
    };
  };
  const { iroh: _productionOptions, endpointFactory: _factory, ...rest } = options;
  return createAdvancedP2PNode({ ...rest, endpointFactory: async alpn => {
    const key = randomBytes(32), protocol = Buffer.from(alpn).toString('base64url');
    const native = await createNode({ key, bindAddr: '127.0.0.1:0', relay: { urls: [relay.url], authToken: relay.authToken }, discovery: { dns: false, mdns: false }, internals: { handleTtl: 0 } });
    const id = native.publicKey.toString();
    const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), key]), format: 'der', type: 'pkcs8' });
    const ticket = () => {
      const payload = Buffer.from(JSON.stringify({ peerId: id, relayUrl: relay.url, protocol, expiresAt: Date.now() + 120_000, directAddresses: [] }));
      return `${prefix}.${payload.toString('base64url')}.${sign(null, Buffer.concat([domain, payload]), privateKey).toString('base64url')}`;
    };
    const incoming = native.incoming()[Symbol.asyncIterator]();
    let closing;
    const connect = async (locator, wireAlpn, expected, signal) => {
      signal?.throwIfAborted();
      if (locator.kind !== 'ticket' || locator.ticket.length > 4096) throw fail('REJECTED', 'Fixture accepts its own bounded relay tickets only');
      const [format, body, signature, extra] = locator.ticket.split('.');
      if (format !== prefix || extra || !body || !signature) throw fail('INVALID_FRAME', 'Invalid local relay ticket');
      const payload = Buffer.from(body, 'base64url');
      let value;
      try { value = JSON.parse(payload.toString()); } catch { throw fail('INVALID_FRAME', 'Invalid local relay ticket payload'); }
      if (value.peerId !== expected || value.protocol !== protocol || Buffer.from(wireAlpn).toString('base64url') !== protocol || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < Date.now() || value.directAddresses?.length !== 0 || !origins.has(value.relayUrl)) throw fail('UNAUTHORIZED', 'Local relay ticket is outside the fixture peer/protocol/route fence');
      if (!await PublicKey.fromString(expected).verify(Buffer.concat([domain, payload]), Buffer.from(signature, 'base64url'))) throw fail('UNAUTHORIZED', 'Local relay ticket signature did not verify');
      const pending = native.dial(expected, { directAddrs: [], relayUrl: value.relayUrl });
      const session = await pending;
      if (signal?.aborted) { session.close(); throw signal.reason; }
      await session.ready;
      if (session.remoteId.toString() !== expected) { session.close(); throw fail('UNAUTHORIZED', 'Native peer identity mismatch'); }
      return wrapSession(session, native, 'client');
    };
    return {
      id, get address() { return { id, ticket: ticket() }; }, createTicket: async () => ticket(),
      connect: (value, wireAlpn, expected) => connect({ kind: 'ticket', ticket: value }, wireAlpn, expected), connectLocator: connect,
      accept: async () => { const result = await incoming.next(); return result.done ? null : wrapSession(result.value, native, 'server'); },
      diagnostics: () => native.stats(), close: () => closing ??= native.close(),
    };
  } });
}

/**
 * Linux qualification child launcher. Blocks outbound sendmsg/sendmmsg used by
 * this pinned native QUIC and sendto with an explicit destination. TCP sendto
 * with a null destination (Rust's normal connected TCP send) remains available.
 * The filter is irreversible only inside the newly exec'd owned child; no
 * machine firewall, namespace, capabilities, library, or trust store changes.
 */
export async function udpDeniedRunner({ directory }) {
  if (process.platform !== 'linux') throw new Error('Relay-only syscall-denial fixture requires Linux');
  const source = join(directory, 'deny-udp.c'), binary = join(directory, 'deny-udp');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(source, String.raw`
#define _GNU_SOURCE
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <linux/audit.h>
int main(int argc, char **argv) {
  if (argc < 2) return 64;
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
#if defined(__x86_64__)
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
#elif defined(__aarch64__)
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_AARCH64, 1, 0),
#else
#error Unsupported qualification architecture
#endif
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_sendto, 0, 5),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[4])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 0, 2),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[4]) + 4),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_sendmsg, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_sendmmsg, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = { .len = sizeof(filter) / sizeof(filter[0]), .filter = filter };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) { perror("owned child seccomp"); return 65; }
  if (setenv("MULTIPLEX_UDP_DENIED", "sendto(destination),sendmsg,sendmmsg", 1)) return 66;
  execvp(argv[1], argv + 1);
  perror("owned qualification exec");
  return 67;
}
`);
  await command('cc', ['-O2', '-Wall', '-Werror', source, '-o', binary]);
  return binary;
}
