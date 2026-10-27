# Disposable two-relay qualification fixture

`relays.mjs` starts two **actual Iroh relay servers** on independent loopback TCP
ports. Each has an independent synthetic access token, private configuration,
relay-side packet/byte/admission counters, and an exact process cleanup handle.
Neither server contacts a deployed relay or uses an existing account, certificate,
native home, session, model provider, firewall rule, or service.

```js
const relays = await startRelays({ directory, mode: 'http-development' });
try {
  const host = await createLocalRelayNode(hostOptions, { relay: relays.a });
  // Existing p2prpc session authentication and authorization remain in hostOptions.
  // Close every owned node before closing its relay servers.
  const counts = await relays.stats();
} finally {
  await relays.close();
}
```

`a` and `b` expose `url`, `mode`, `pid`, `stats()` and `close()`. Their
`authToken` property is intentionally non-enumerable so ordinary JSON receipts
do not serialize it. Default `mode: 'tls'` additionally creates one-day
self-signed certificates and exposes `caPath`; it is useful for the negative
certificate-trust oracle, not an assertion that the production native wrapper
accepts this certificate.

The relay executable is `iroh-relay` **1.0.2**, matching the relay protocol crate
in the pinned `iroh-http` 0.6.2 fork's Cargo lock. The fixture records its binary
SHA-256. Supply `binary` explicitly or use the bounded offline build from cached
registry source. Only an owned copy of the relay crate is built; unneeded
development targets are removed from that copy to avoid requiring unrelated
test-package metadata. A missing cached dependency fails the build. This fixture
does not install, upgrade, or rewrite application dependencies or vendor source.

## Exact qualification boundary

The published native wrapper uses embedded WebPKI roots and exposes no custom
CA option. `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, and a local self-signed server
do not create a supported production TLS configuration. Its public p2prpc relay
configuration also deliberately rejects HTTP origins.

For that reason `createLocalRelayNode` uses the **published advanced endpoint
seam** with a small explicit test adapter. Published p2prpc owns the real framing,
application RPC, mutual session authentication, and authorization. The exact
pinned native SDK owns actual QUIC sessions, native streams, physical close,
and relay TCP connections. The adapter accepts only this fixture's loopback HTTP
origins, disables DNS/mDNS, advertises no direct addresses, and signs a distinct
`multiplex-local-http-v1` ticket with the native peer's Ed25519 key. Expected
identity, protocol, expiry, signature, and allowed relay are checked before dial.
It never labels an HTTP connection HTTPS and never invokes a private constructor,
patches the published dependency, disables TLS verification, or edits a trust store.

Successful data-plane assertions therefore qualify **published p2prpc plus the
exact pinned native SDK through the local HTTP test adapter**. They do not qualify
the production HTTPS wrapper, remote relay certificates, a real restrictive
firewall, arbitrary relay failover, or a previously unresolved cross-viewer case.

Each pinned native endpoint currently accepts one relay bearer token for its
whole configured custom-relay list. The fixture uses separate tokens deliberately:
two relay-facing transport endpoints may route into the **same backend agent
owner**, without duplicating the agent or granting access through relay possession.
Session authorization is an independent application oracle. Merely connecting to
the relay never grants a Gateway user access to a session.

## Prevent accidental direct-path success

An empty ticket address list is insufficient: native Iroh may learn UDP paths
after the relay handshake. The positive data-plane case must run in a fresh
owned child through `udpDeniedRunner({ directory })`:

```js
const launcher = await udpDeniedRunner({ directory });
const child = spawn(launcher, [process.execPath, ...qualificationArguments]);
```

This Linux-only launcher installs a process-scoped seccomp filter after
`PR_SET_NO_NEW_PRIVS`, then execs the qualification child. It denies `sendmsg` and
`sendmmsg`, the pinned native QUIC UDP transmission paths, plus `sendto` with an
explicit destination. Connected TCP `sendto` with a null destination remains
allowed because Rust uses it for relay writes. The child environment identifies
the exact filter as `MULTIPLEX_UDP_DENIED=sendto(destination),sendmsg,sendmmsg`.
There are no host firewall, namespace, privilege, or installed-runtime changes.

Before creating native endpoints, assert that a loopback UDP probe fails with
`EPERM`. During the application exchange require positive relay-side packet and
byte deltas, native `relay === true`, and no active direct path. A relay flag alone
is insufficient. The native UDP implementation and the filter are specific inputs
to this bounded qualification; this helper is not a general network sandbox.

Cleanup is mandatory even after assertion failure. Every endpoint close must be
awaited, followed by both relay close handles. Startup failure closes already
started owned children. Close removes the synthetic-token configuration and
private key; safe certificate/counter evidence may remain in the disposable
receipt directory. Failed probes remain diagnostics and do not become passing
qualification claims.
