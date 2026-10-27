# V8 gateway primitives

Isolated browser-safe client transport and Node authenticated loopback adapter.
The Gateway authenticates, routes and buffers individual viewers. It owns no
catalog, native lifecycle, transcript body source, durable forwarding outbox or
mutation replay policy.

`src/index.ts` exports only browser-safe contracts and clients. Node composition
imports `src/gateway/coordinator.ts` and `src/http/server.ts` explicitly. Existing
published transport pins and parent workspace manifests remain unchanged.

The framework [routing contract](../../docs/design/v8-architecture.md#routing-authentication-and-cancellation)
explains exact-owner reads, route epochs, authentication disposal and bounded
independent observations. The [integration gate](../v8-integration/README.md)
records its own exact source/dependency scope and distinguishes frozen results
from focused diagnostics.

## Composition

```ts
const gateway = new GatewayCoordinator();
gateway.register({
  target, session: sessionHost,
  history: { watch: (scope, cursor) => historyHub.watch(scope, cursor) },
  authorizeHistory: scope => trustedBindingProvesHistoryOwner(scope),
  interactions: interactionOwner, // optional read-only port
});
gateway.registerCatalog({ scope: catalogScope, owner: catalogOwner, port: catalog });
const server = await listenLoopback(gateway, verifyDisposableCredential);
const transport = new HttpGatewayTransport({ url: server.url, authorization });
const client = new GatewayClient({
  transport, history, targets: [target],
  onFence: () => disposeAndDetachOldWorkspaceNamespace(),
  onConnection: connected => sessionWorkspace.setConnected(connected),
  onObservation: observation => presentStreamFreshness(observation),
  onReady: observation => restoreRetainedObservation(observation), // snapshots/receipts only
});
const sessionWorkspace = new SessionWorkspace({ history, port: client });
const historyLease = client.observeHistory(logicalScope, nativeHistoryScope);
```

`target` is `{connection, principal, authority, host, session, owner, routeEpoch}`.
`owner` names the durable request domain; `routeEpoch` names a replaceable
authenticated transport attachment. The trusted credential verifier returns
`{connection, principal, authorities, actions}`. Actions are explicit `read`,
`control`, `catalogWrite`, `fileWrite`, `mcpRefresh`; missing permissions fail closed. Native access and
provider policy remain with the Host, independently of Gateway permissions.

Each trusted `SessionRoute`, `HostRpcRegistration` and `CatalogRoute` may also
select `actions` as a ceiling for that registration. Admission requires both
the authenticated identity action and the route action. An account's union of
permissions across several Hosts cannot widen a read-only Host edge. Omission
preserves identity-only admission; an empty array denies every action. The
Gateway validates and freezes known, unique actions before replacing a route
or awaiting remote verification. Later mutation of a configuration array cannot
broaden a registered grant. These coarse actions do not replace Host/domain
permission checks or native provider policy.

`register(sessionRoute)` and `registerHostRpc(hostRegistration)` return
idempotent disposers. A disposer removes only its exact registered object,
retires that registration's observers and releases remote expiry/revocation
listeners where present. It cannot retire a later registration, including one
reusing the same target/epoch. A released edge can therefore be mounted again
without restarting its Host or adding a lifecycle owner. Already admitted work
keeps its forwarding capacity and native owner until settlement; disposal never
sends Stop. Composition should retain these disposers and separately close any
observation bridge it owns. Catalog registration has no disposer API.

`SessionRoute.controlCatalog?: () => Promise<Catalog>` exposes the existing
trusted Host's configured model/provider/effort choices. The explicit
`controlCatalog` client read uses `read` permission and bounded optional-read
capacity; it cannot occupy the urgent effect lane. Mounts, subscriptions and
reconnect do not call it. Missing surfaces report unavailable. Existing catalog
validation rejects malformed choices, and completion rechecks the exact route,
durable owner, Host observation epoch and client namespace before publishing.
These are configured choices, not a claim that native models were discovered.

Read admission keeps four active reads and at most 64 waiting reads by default
(`reads` / `readQueue`). The FIFO holds only admitted read closures, drains as
actual work settles and rejects overflow with `FULL`. It adds no retry timer or
mutation queue. Dispatch and completion recheck the exact registered route;
closing rejects undispatched reads without invoking their ports. Urgent Stop
and answers retain their separate capacity. These are observation bounds, not
session or native-agent limits.

Remote session, interaction, MCP and exact-receipt snapshot watches share one
upstream per exact route/procedure/input. Each consumer retains an independent
lease; late consumers receive the current immutable baseline. The last release
or route retirement clears that baseline and closes only that upstream. This
bounded observation buffer is neither durable state nor permission authority.
History watches retain their own cursor/frame semantics. Remote snapshot failure
ends affected downstream queues through the ports' optional failure callback,
allowing the existing client observation owner to reconnect. It cannot retire
the entire Host or start native work. Per-viewer overflow and cancellation remain
independent. These source contracts require separate installed qualification;
they do not close the historical physical-connection incident.

`GatewayClient` implements existing `SessionPort`. `disconnect()` preserves
drafts, pins, rows and original requests. `reconnect()` only restarts retained
read observations. `bindRoute()` accepts a positively proved same-owner new
route epoch and replaces old read streams; original mutation targets remain
frozen. `receipt()` reads that exact original owner, including through a new
trusted route proving the same durable domain. `null` never proves no effect.
Repeated client `submit()` for a retained unresolved original is rejected;
check the original receipt instead. Exact terminal receipts retire Gateway
working entries; the Host keeps permanent ID/hash deduplication. A raw explicit
duplicate after retirement still meets that Host check. Reconnect and restored
receipt references never submit. Limits bound unresolved work, with a reserved
Stop slot; completed activity cannot consume lifetime admission capacity.

`HttpGatewayTransport.requestTimeoutMs` defaults to15 seconds (maximum30).
Finite requests include header and body observation; watch establishment includes
the first ready frame. A healthy admitted quiet stream has no inactivity timeout.
Late responses are canceled/fenced,401 remains UNAUTHENTICATED, and a timed-out
mutation remains an exact unresolved original. The transport never resends it.

Optional trailing history `retryToken` arguments flow through existing HTTP,
P2P, Gateway and Host calls. They are separate from `HistoryObservation`, whose
signal/deadline only controls the caller's wait. The Host acquisition alone grants
renewal. Temporary Host BUSY crosses the facade as TOO_MANY_REQUESTS/FULL;
PRECONDITION_FAILED/FENCED remains reserved for ownership/context failures.

`fence()`/`close()` revoke this client, abort private HTTP reads/observers, clear
its originals/routes/listeners and invoke mandatory owner namespace disposal.
A new principal requires a new client and new workspaces. Externally retained
immutable snapshots cannot be memory-revoked; actual React/provider disposal
remains a separate integration obligation. Throwing presentation callbacks do
not prevent revocation.

`GatewayClient.catalogPort()`, `interactionPort(scope)` and `mcpPort(scope)`
provide the retained callback facades. `HttpGatewayTransport` and
`P2pGatewayTransport` expose typed one-shot watches and raw unary methods; they
retain no callback subscription/restart owner. Catalog mutations go to the catalog
owner; interaction answers retain existing `SessionPort.submit(answer)` and
Host receipt ownership. No additional interaction mutation endpoint exists.

`createGatewayCatalogPort({scope, transport, onUnavailable})` adapts the existing
catalog transport vocabulary for an independently owned remote authority. It
returns `{port, ready, close}`. Await `ready` before publishing the port: its one
upstream catalog watch must be admitted before a local subscribe/list baseline.
Local subscriptions share that watch without a row cache. Unary methods also
await admission, enforce the exact configured catalog scope on requests and
results, and forward each mutation once, including archive publication over
P2P. Observation loss calls `onUnavailable`; the existing connection owner
decides restoration. The bridge never retries, seals the remote authority or
closes its transport/Peer. `close()` aborts the quiet watch before awaiting its
iterator cleanup. The focused catalog-port oracle checks this boundary through
the actual router/coordinator and a scripted published Peer seam, without
opening an endpoint or native process.

The disposable listener binds `127.0.0.1:0`; its reusable handler verifies credentials for
every request, uses no ambient configuration and never logs credentials/private
bodies. It is an executable boundary, not production TLS/sign-in/session auth.
HTTP requests use JSON bodies and Authorization headers, with no credentials
or prompt content in URLs. NDJSON observations have independent frame/byte
limits and respect writable backpressure before pulling another viewer item.

## Local checks

From the framework root, run `npm --prefix primitives/v8-gateway run typecheck`
or `npm --prefix primitives/v8-gateway test` for a bounded development check.
The integration owner runs the frozen source-bound combined checkpoint once;
this lane does not launch a second qualification campaign or real native calls.
The [P14 shared-hop correction](../../docs/design/v8-architecture.md#routing-authentication-and-cancellation)
has focused real published-transport proof below. The historical V7 incident's
first close caller remains unproved; its failed acceptance is preserved.

## All-domain composition increment

Host registration additionally accepts:

```ts
gateway.register({
  target, session: host.session, history: host.history,
  interactions: host.interactions, mcp: host.mcp,
  binding: () => host.binding(),
  files: { port: host.files, scope: () => host.fileScope() },
  authorizeHistory: scope => hostProvesThisHistoryScope(scope),
});
const binding = await transport.binding(target); // retained, null before native binding
const mcp = client.mcpPort(logicalScope);           // existing McpPort; passive until refresh
const files = transport.filePort(target);       // existing FilePort; binary HTTP bytes
```

`GatewayBinding` is browser-safe `{run,history}`. The descriptor is Host-derived,
checked against retained SessionHost kind/generation/native identity and exact
history attachment authorization. Native FileScope.session differs from logical
GatewayTarget.session, so file scope is resolved from proven Host binding on
every request. No guessed logical-ID file store is created before Create.

Actions now also include explicit `fileWrite` and `mcpRefresh`; `read` still
permits retained observations/downloads, while discovery and uploads/capture
require their distinct permissions. New optional ports do not change command
or catalog ownership. There is no MCP management mutation endpoint.

`createGatewayHttpHandler(gateway, verify)` is the reusable Node handler;
`listenLoopback` uses that exact handler. `.revoke({connection,principal})`
denies new requests and destroys active feeds/responses for the namespace.
Explicit `.sealAdmissions()` rejects new requests and requests still awaiting
authentication/body reading before dispatch. Existing observations and already
forwarded effects retain their owners; process composition separately seals
actual Catalog/Host admission, then Stops and drains before `.close()`.
The browser constructor accepts `onUnauthenticated` for explicit401/denial only;
it closes the private transport and invokes the callback once with consumer
errors isolated. Application composition connects this to namespace disposal.
Ordinary disconnect preserves retained background state and does not log out.

External TLS embedders pass their exact trusted origin in
`createGatewayHttpHandler(gateway, verify, { allowedFileOrigins: [origin] })`.
The nested file HTTP edge snapshots this policy; omission retains its loopback
HTTP default. Forwarded headers never authorize a file origin. The embedder
still owns credential verification and the outer request origin/Host checks.

File routing delegates actual lease/Range/ETag/drain/release behavior to the
existing FileHttpHandler. Every route/RPC/download needs Authorization; the
nonsecret route path is not a bearer capability. The browser reuses existing
local byte leases, fences all reads after close, clears exact leases and permits
idempotent release after close without fresh auth/native discovery. An actual
held read keeps its Host slot until settlement. Optional byte/discovery pressure
cannot consume urgent Gateway Stop/answer admission slots.

`HttpGatewayTransport.filePort(() => currentProvedTarget)` keeps one facade per
durable owner while new operations resolve the current epoch. Acquired local
byte leases retain their exact port/scope across replacement. A route changed
while discovery was held refuses before a new mutation; writes and acquisitions
are never replayed automatically. The existing four-lease bound spans epochs.

`register` is trusted same-process Host composition. Remote sources instead use
`registerRemote(route, authorization)` with configured RemoteRouteVerifier:
verified exact target/owner/routeEpoch, absolute expiry and revocation signal.
No caller owner string establishes proof. `src/node/route-proof.ts` provides a
small bounded issuer/audience/HMAC peer-proof adapter with explicit key-wide
revocation. Proof verification/expiry/revocation and original forwarding remain
distinct from durable Host receipt custody. The gateway never stores an outbox.

`src/node/p2prpc.ts` provides typed router/P2pGatewayTransport over the installed
published p2prpc API. Identity mapping receives only authenticated peer/session
facts, not RPC headers. Binary artifacts retain their authenticated HTTP port.
Adapter close cancels only its own observers and never closes a shared Peer.
The root-run `qualification/published-transport.mjs` helper creates three fresh
loopback Iroh endpoints with exact shared-secret/peer/principal pinning and all
relay/DNS/mDNS discovery disabled. It is excluded from focused Node test runs.
This new adapter subset does not qualify the original Root/Host P14 failure.

### Shared Peer cancellation — October 24 focused proof

A viewer owns its observation, while the existing Peer owns admitted physical
RPC setup. `P2pGatewayTransport` waits for published `onStarted` before an early
stream unsubscribe. Unary `recover`/`mcpRefresh` now race their observer locally:
cancellation/adapter close returns `CANCELLED`/`CLOSED` promptly without passing
that abort to raw RPC setup. Pre-aborted calls dispatch nothing, and late success
or failure cannot revive a closed observer. Host read deadlines still cross the
wire; actual work retains existing Host/Core capacity through settlement. A lost
response has no total response deadline in the pinned link and remains admitted
until settlement or physical Peer retirement. Existing Core limits bound that
work; there is no extra queue, retry or transport fork.

The [focused receipt](artifacts/p14-shared-hop-owner-iteration.json) passes three
safe cases through fresh authenticated p2prpc `0.3.0-renewal.2` / Iroh `0.6.2`
endpoints. Two retained clients share the exact same Root-to-Host Peer. In both
viewer orders, each loads eight older pages to retain 72 parent rows, navigates
the helper and both workers, and returns without losing those rows. A separate
case cancels a stream and unary recovery during acquired native opening, then
closes one adapter; the other viewer still pages, receives capture and reads the
one original receipt without another Send. Reconnect cannot hide a failure:
session identity, one raw connection and no close request/physical closure on
either endpoint are asserted before teardown. Public diagnostics settle to two
retained streams, or one after adapter close, with zero queued work.

A separate negative control uses a frozen unsafe iterator after actual raw
stream acquisition. It exercises the quarantine/close class associated with
`Bidirectional stream opening was cancelled`, while the corrected observer must
leave healthy viewers and their original receipts usable. The fixture records
exact endpoint cleanup and physical connection evidence; native-agent/model
calls are absent. This controlled class does not prove the missing initiating
caller in an older incident.

The [routing ownership contract](../../docs/design/v8-architecture.md#routing-authentication-and-cancellation)
explains the exceptions. Qualification belongs to the source-hashed composed
runner; historical ignored artifacts retain their original scope and are not
portable public evidence. No current source pass follows merely from these
fixture descriptions.

## Shared HTTP observer channel

All HttpGatewayTransport observers share one authenticated `watch.open` NDJSON
request. Short subscribe/unsubscribe controls carry logical IDs; initial frames
can safely precede subscribe ACK. This avoids HTTP/1.1's six-connection deadlock
when two sessions each need session/history/interaction/MCP feeds plus catalog.
Effect RPCs and binary files remain separate requests.

The channel binds the complete authenticated namespace/authorities/actions.
Defaults bound128 active logical subscriptions,128 coordinator observers,
128 aggregate frames/2MiB, and16 frames/1MiB per logical consumer. Physical
channel loss explicitly fails its logical iterators. One GatewayClient owns all session/history/catalog/interaction/MCP descriptors
until release. It admits at most 384 retained descriptors and 128 references per
descriptor; the active HTTP channel/coordinator bounds remain 128. Physical HTTP
loss invalidates every dependent feed, while a logical failure affects only its
feed. The published P2P API supplies per-feed errors/completion rather than a
public physical lifecycle callback; no private Peer fields or polling are used.

Pending registration remains owned through cancellation; exact unsubscribe
follows its ACK. Unknown registration failure or its finite15-second budget
closes the parent channel, which fences/releases even late async acquisition.
There is no automatic effect retry. Positive streamed auth denial
fences the namespace; ordinary disconnect preserves retained state.

Five additional mux oracles cover one channel with nine logical feeds,
callback/offline reconnect, scope attenuation, late acquisition and cancellation
before ACK, including explicit early failure rather than successful EOF. Root's actual Chromium composition separately checks browser
connection telemetry; Node connection counts alone are insufficient.

Observer controls combine their finite admission budget with the parent channel
signal, so disconnect releases pending control fetches promptly. Native effect
requests do not inherit that observation signal. Browser urgent network
reservation under arbitrary simultaneous long-body requests remains unqualified;
backend urgent admission and the observer-starvation repair do not prove
Stop latency after all remaining browser sockets are occupied. No normal-fetch
scheduler is included.


## Unified observation recovery

GatewayClient alone schedules retained observation recovery. One injected timer
uses 250, 500 ms, 1, 2, 4, 8, 16, then 30-second delays indefinitely, with 80–100% jitter.
Thirty healthy seconds reset escalation. Network loss, unexpected EOF,
`UNAVAILABLE`, `FULL` and `TIMEOUT` retry. Invalid/forbidden/fenced/conflicting/
overflowed feeds stay unavailable until explicit reconnect or corrected binding.
Auth denial destroys the namespace; HTTP 401 does so before decoding an absent or
malformed optional body. Explicit disconnect cancels recovery while preserving
retained state, and explicit reconnect starts immediately.

An optional `beforeObserve()` joins this same retry attempt before observation
transport starts. Applications may refresh authenticated routing configuration
there. A fenced feed receives one refresh opportunity and remains terminal
unless a validated same-owner epoch replacement rebinds it. Exact-epoch custom
RPC sources retire and need a newly composed descriptor. Receipt lookup uses
the current proved route only when its durable owner still matches the saved
original; it never forwards that original again.

Every one-shot watch receives an optional `onStarted` callback. HTTP calls it
only after the exact subscription ACK; P2P uses published `onStarted`. An early
frame is not admission evidence. GatewayClient invokes async `onReady` after
admission and reports `live` after that restoration succeeds. Frame processing
continues alongside a held restoration read. Old controller completions are
fenced, and restoration failure retries only that feed.

Restoration reads retained snapshots/listings and original receipts. Owners
coalesce actual pending I/O and check receipts sequentially, keeping admitted
Create/Send effects independent. Catalog changes have no initial full baseline:
a list started before admission cannot certify this gap, so the catalog owner
queues at most one fresh list behind the actual older read. Reconnect performs
zero native Resume, transcript acquisition, MCP discovery or mutation replay.

ViewerQueue `closed` means producer termination. `finish()` runs cleanup once
and drains accepted FIFO values; `fail(error)` discards and rejects, including an
undefined error; consumer `return()` discards immediately even after finish.
The wire carries a distinct logical `end` frame, so graceful EOF before HTTP ACK
does not consume/drop accepted values. Cancellation preserves exact admission/
unsubscribe ordering and never closes a shared Peer.

MCP snapshot/refresh/watch and file-surface acquisition enter the existing read
budget before asynchronous binding or SessionHost prerequisites. Actual pending
prerequisites retain that slot through settlement. Successful watch acquisition
then transfers observation lifetime to the subscriber bound, without a nested
read semaphore or a new authority.

## Typed Host plugins

`registerHostRpc` mounts a trusted configured Host port without inventing a
session ID. Custom queries, mutations and subscriptions dispatch against the
actual composed Host router using `createGatewayHostClient<HostRouter<D>>`.
The bridge checks the full Host/auth route and public composition. The actual
Host still validates every input/permission. It does not add a Gateway journal.

`createP2pHostRpcPort` forwards through a pinned existing Peer; configured
backend proof uses the permitted `x-multiplex-host-proof` application metadata
because published p2prpc reserves HTTP Authorization. `createHostPeerContext`
requires both the actual authenticated Peer and signed per-request scope.
`createInProcessHostRpcPort` mounts the same actual router for trusted local
composition. Errors expose allowlisted codes, never native text/stacks.

`GatewayClient.rpcSource` uses the existing logical descriptor and retry owner.
Complete public snapshots share one raw feed; each consumer runs its own
schema/decoder, including late subscribers. It cannot receive another decoder's
projected type. An HTTP subscribe ACK does not establish snapshot freshness.
Mutations never reconnect/retry automatically. The trusted registration may
reserve an urgent control policy; a caller cannot select forwarding capacity.
Native Stop/answer policies must be supplied by trusted Host composition.

The [plugin contract](../../docs/design/v8-architecture.md#typed-host-composition)
cover typed React binding, ownership and update behavior. New tests reuse the
same corrected shared-Peer observer. Published qualification holds a real raw
Iroh opening, cancels that one observer and proves two healthy viewers survive.
Backend proof expiry/revocation refuses new admission; routing/auth owners must
also close their existing observer leases when retiring a grant. Proof tokens
are not native Stop or effect-cancellation capabilities.

## Independent relay paths

`src/node/relay-config.ts` exports `normalizeRelayPaths` for trusted private
process composition. A path has a stable ID, one HTTPS relay origin, optional
relay authentication and an optional persisted 32-byte endpoint key, distinct
from every other concurrent path's key. Normalized
descriptions are frozen and keep credentials/keys inside a private construction
closure; `path.endpointOptions()` supplies fresh published `IrohEndpointOptions`.
Do not send those private endpoint options to a browser or log them. Configure
one independently running endpoint per path, exposing the same existing Host
owner and router. This differs from passing several custom relay URLs to one
endpoint: that is a candidate pool with one current home relay, not concurrent
publication on every relay. DNS/mDNS are disabled, direct ticket candidates and
advertised addresses are denied, and remote relay hints must match that path's
configured origin. This does not add a native network sandbox. Distinct paths
do not grant account access, create another native/session owner, retry effects
or prove another path dead. Relay authentication and application permissions
remain separate.

`src/node/relay-network.ts` exports `openRelayNetwork({ paths, node })`. Explicit
activation opens one published p2prpc endpoint per path with the same supplied
router/context/security. `path(id).route()` publishes a currently signed route;
an unobserved home relay yields `UNAVAILABLE`. `connect(localId, route, expected)`
requires independently trusted peer/principal pins, verifies protocol/expiry and
the exact configured relay, and rejects direct ticket candidates before dial.
`closePath(id)` and `close()` own transport only. Partial startup closes every
acquired endpoint, and close failures remain failures. There is no automatic
mutation failover, native lifecycle, duplicate journal or reconnect scheduler.

The normal development gate includes nine unique configuration/network oracles.
The [disposable native relay fixture](qualification/multi-relay/README.md)
provides two real local relay servers and a process-scoped UDP-denial launcher.
Its explicit HTTP/native adapter is qualification-only; it does not qualify the
production HTTPS wrapper. `tls-refusal.mjs` separately exercises the actual
published production factory against fresh untrusted HTTPS certificates and
requires bounded home unavailability, zero relay admissions and complete
cleanup, without modifying trust settings. Successful remote certificate and
firewall acceptance remain consumer deployment checks.

## Direct remote Host ports

`src/node/host-facade.ts` exposes an already owned Host directly, without a
Host-side Gateway or another catalog/journal. Supply the actual existing
`SessionRoute` and `HostCreationPort` owners plus complete committed session-ID
observations. `mergeHostFacade(host.router, facade.router)` adds the reserved
`multiplex` namespace beside the existing plugin routes. The endpoint must use
`createHostPeerContext`: an allowed authenticated Peer, a short-lived signed
procedure proof, and the activated Host's exact composition/owner/epoch check
are all required. No browser claim can construct that context.

Configure both proof issuer and verifier with `actionForProcedure:
hostFacadeAction`. Create requires `catalogWrite`, session originals require
`control`, MCP refresh requires `mcpRefresh`, and retained observations or
explicit history exceptions require `read`. The Host also enforces its own
ceiling and the supplied SessionRoute ceiling. A session-scoped proof cannot
list/create across the Host or change its session/generation. Generic
Gateway `rpcCall`/`watchRpc` reject the reserved namespace: their normal
mutation=`control` rule must not tunnel past a distinct catalog/file ceiling.
Existing custom plugin paths retain their current behavior.

`createRemoteHost({target, expected, creationTarget, identity, actions, port})`
converts a trusted pinned `HostRpcPort` back to those same existing ports. Peer
identity/protocol pins and expected public composition come from independent
configuration. Its identity is the exact routed account, attenuated to that
edge's actions; it is not a shared service user. `mountRemoteHost(gateway,
remote)` observes complete IDs and mounts those ports in the existing Gateway.
Register `remote.creation` with the existing catalog authority. The remote
adapter invokes its trusted port directly, outside generic plugin RPC.

The explicit `positiveCreationAdmission: true` option forwards optional
`createAdmitted` to the actual Host owner. An unsupported Host rejects before
legacy Create; there is no completion/transport-ACK fallback. Absence does not
claim a sealed remote shutdown. Actual Host/global lifetime and application
shutdown integration remain the caller's separate responsibility.

History bodies and replay remain with the Host. The remote route checks its
authenticated account/Host envelope; the canonical Host proves exact native,
attachment and child membership on each request. There is no duplicate Gateway
scope-proof cache to lose on remount. Explicit cold-child recovery acquires the
existing Host authorization before reading the child's body. DTOs detach shared JSON object references because
the pinned published codec rejects aliases; this adds no transcript mirror.
Each observation is bounded, and observer cancellation leaves admitted Peer
and Host work owned through settlement. A failed session-ID feed retires the
mount's reachability; an individual history/MCP observer cannot retire the Host.
Remote `CLOSED` observations use the existing client retry owner, while local
client close still cancels renewal. There is no second reconnect scheduler, command replay,
native Resume, implicit Stop or automatic endpoint selection.

Closing a mount/remote adapter/facade releases observations and owned transfer
leases only. The process owner separately settles native/Host custody. The
facade close is async: source preparation/read-release failures retain exact
cleanup ownership and may be retried through that same owner.

`readRemoteHostDescriptor` uses the sole stale-epoch exception,
`multiplex.describe`: actual allowed/pinned Peer, unexpired read proof, exact
account/authority/Host/owner and independently expected manifest remain required.
Only this descriptor may observe a newer server-owned epoch; all ordinary calls
and file transfers still require exact current epoch. The attenuated internal
proof retains its original expiry and grants only read. Configuration refresh
and the existing client retry owner decide whether to rebind; this module adds
no timer, automatic Resume or command replay.

`createRemoteFiles` supplies optional session file surfaces to `createRemoteHost`.
Use `peerFileMetadataSchema` at both endpoints and enrich the authenticated Host
context with `withHostFileContext`, using its actual current Peer. File metadata
procedures in the reserved `multiplexFiles.*` namespace preserve independent
read/fileWrite ceilings; generic custom RPC cannot invoke either reserved
namespace. Binary bytes use published request/principal-bound Peer.files, never
JSON/base64 or a Host HTTP listener. Download sources lazily acquire the real
FileHost lease inside SDK prepare/close, including failed hashing/cancellation.
The receiver publishes at most four temporary verified 10MiB byte leases after
exact RunRef/scope/metadata/SHA256/BLAKE3 checks. Upload chunks are at most 64KiB:
the Host reverse-pulls verified bytes, rechecks its current binding, then calls
the existing FileHost write once. Lost replies reconcile the existing upload
offset; no second durable store or upload journal is added.

The focused source oracles are `qualification/remote-host.test.ts`; the separate
`remote-host-published.test.ts` opens and closes two fresh loopback endpoints
using the exact installed published p2prpc/Iroh packages and scripted owners.
The byte oracle includes concurrent reads, corrupt handoff rejection, lost
write-reply status lookup, grant/generation fences, held-read/control isolation
and preparation/transfer cleanup. Neither test launches a native agent/model
or qualifies production firewalls. Installed process/HTTPS relay acceptance and
rendered remote-browser reconnection remain separate consumer gates.
