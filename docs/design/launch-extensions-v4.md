# Protocol-v5 launch extensions

Protocol v5 makes session creation a small distributed kernel surrounded by
trusted, deployment-specific TypeScript modules. The kernel owns identities,
fences, journals, routing, and lifecycle. It deliberately does not own worktree
policy, container orchestration, PR validation, credentials, placement, quotas,
or a universal launch form.

## Composition model

```text
bespoke client / UI
        |
        | domain request (for example { prUrl, runtimeNodeId, profile })
        v
gateway plugin router                         zero authority
        |
        | restricted GatewayLaunchPort
        | LaunchRequest { exact runtime, profile fence, opaque JSON input }
        v
access gateway -> selected control-node tree  routing + metadata authority
        |
        | p2prpc/tRPC launch.create
        v
runtime launch provider                       domain resources + recovery
        |
        | RuntimePreparedLaunch { backendId, harness-native spawn options }
        v
runtime agent backend -> harness adapter       native execution + history
```

There is no plugin discovery protocol. Applications import and register modules
at startup. A gateway plugin and runtime provider may live in one package, but
they execute in different processes and communicate only through the normal
versioned launch request. This keeps the network contract independently usable
from the stock CLI, a custom reviewer service, or another internal dashboard.

The reference runtime enables the built-in `core.direct/workspace` provider.
It accepts an existing absolute `cwd`, applies the runtime's allowed-root and
native path policies, and selects a configured backend. It provisions and owns
nothing, so its release hook is a no-op. The reference gateway and React UI use
the generic launch-profile APIs; custom gateway facets are composed by bespoke
gateway applications through `@arduano/agent-multiplex-gateway-core`.

## Compatibility and trust fences

Every advertised profile contains:

```ts
interface LaunchProfileIdentity {
  profileId: string;
  providerId: string;       // namespaced, for example "company.review"
  contractVersion: number;  // semantic input contract selected by the author
  requestSchemaHash: string; // SHA-256 of canonical JSON Schema
}
```

The descriptor also carries `implementationVersion`, supported harnesses,
availability, and capabilities. Every request copies the complete identity.
Profile names alone are never compatibility proof.

At startup, the runtime recomputes `requestSchemaHash` from the provider's
canonical JSON Schema and rejects a mismatch, duplicate profile identity,
duplicate backend ID, duplicate harness/adapter-scope binding, or an empty,
untrimmed, control-character-bearing, or oversized implementation version. At request
time, the gateway checks that the exact profile fence is advertised by the
selected runtime. The runtime repeats lookup, harness admission, and input
validation; gateway-side validation is convenience, not trust.

`implementationVersion` is recorded by the runtime rather than chosen by the
caller. A pending operation cannot silently resume through changed provider
implementation. A successful session records immutable launch provenance:
launch, profile/provider, schema contract, provider implementation, backend,
and native binding revision. Resume, history, stop, and archive use that
provenance instead of guessing from the harness name.

Plugins are trusted local code. `GatewayLaunchPort` narrows what a well-behaved
plugin can do, but JavaScript module isolation is not a security sandbox. Review
and deploy plugins with the gateway/runtime binaries; do not load tenant code,
network-supplied packages, or mutable plugin directories into these processes.

## Gateway plugin contract

`GatewayPlugin<Router>` has a namespaced `pluginId`, a trimmed, printable
implementation version of at most 256 characters, and `createRouter(port)`.
`instantiateGatewayPlugins` rejects duplicate
or malformed IDs and supplies a frozen `GatewayLaunchPort` with only:

- runtime-node and launch-profile discovery;
- profile-specific model discovery;
- launch create/get/list;
- session lookup.

It cannot commit metadata, execute agent commands, access terminals, mutate
sources/topology/authority, or reach the underlying projection object. A
bespoke application mounts the returned router in its own tRPC namespace and
applies its own authentication/authorization before calling the port.

A plugin normally validates its domain request, chooses or requires an exact
runtime/profile according to application policy, reserves retry-stable launch
and logical-session IDs, builds the opaque JSON provider input, then calls
`port.create`. It should return the durable `LaunchRecord` and let clients poll
`get`, page `list`, or subscribe to the standard launch stream. An `accepted`
response is not a native session yet.

Core intentionally has no scheduler. Requiring a caller to select a runtime and
profile is the simplest generic contract. A company plugin may implement a
scheduler above the port, but that is explicit domain code whose decision can
be logged and tested without changing protocol core.

## Runtime provider and backend contracts

`RuntimeLaunchProvider` owns the lifecycle of domain resources. Its public JSON
Schema describes only non-secret launch input. Its hooks are:

- `validateInput`: synchronous admission; required and repeated at runtime;
- `prepare`: provision resources and select a registered backend;
- `recoverPreparation`: decide whether interrupted preparation is safe to
  repeat, already prepared, or ambiguous;
- `compensate`: idempotently clean a definite pre-binding failure;
- `listModels`: optional profile-aware discovery;
- `prepareResume`: optional restoration before interactive resume or temporary
  native-history access;
- `stop`: optional resumability-preserving work after the native handle stops;
- `release`: idempotently release session-exclusive resources during archive;
- `close`: process-level provider shutdown only.

`prepare` returns a `backendId`, harness-native spawn options, and optional
provider-private state. Provider state and checkpoints are stored only in the
runtime journal. They are not metadata or public session fields. A provider
must call `saveCheckpoint` before/after each external-effect boundary needed to
make recovery honest. If it cannot prove whether an effect occurred, it throws
`LaunchProviderOutcomeUnknownError` or returns `outcomeUnknown`; it must not
blindly create a second resource.

`RuntimeAgentBackend` is deliberately smaller: an opaque `backendId`, one
harness adapter, and optional idempotent per-session release. The adapter owns
native model/inventory/session operations and native history. Multiple backends
for one harness are supported as long as adapter-scope identities are unique.
This permits, for example, one shared Codex app server plus a separately scoped
container pool without teaching protocol core either topology.

## Durable launch and archive operations

Launch is admitted and journaled before asynchronous provider work:

```text
accepted -> preparing -> nativeStarting -> succeeded
                    \-> cleanupPending -> failed
          any unprovable external effect -> outcomeUnknown
```

Retrying the same `launchId` with byte-equivalent immutable input returns the
same durable operation. Reusing it with another payload fails. After restart,
`accepted` work is scheduled, `preparing` delegates the decision to
`recoverPreparation`, `cleanupPending` retries idempotent compensation, and an
interrupted `nativeStarting` becomes `outcomeUnknown` because a native session
may already exist. Native binding and launch success commit in one runtime
transaction.

The first launch permanently reserves its logical session ID, including after
failure. The runtime enforces this in its launch journal; each control enforces
it in the same transaction that admits or imports a launch record. Another
launch ID cannot replace that reservation. Same-launch payload mismatches and
historical conflicting records fail closed without rewriting either identity.
This prevents competing dispatch through a common control. Independently
addressed branches have no global admission handshake; their conflicting
projections are rejected on convergence.

Initial dispatch and recovery use the same admission-rejection path. Only a
validated semantic rejection followed by an absent owner record under the
unchanged dispatch fence can settle a locally accepted launch as failed. A
matching owner record is reconciled instead; an immutable mismatch is a
conflict. Transport, lookup, and fence failures preserve recovery by the same
launch ID. Runtime identity/reservation checks precede journaling, and a
missing provider never supplies an invented implementation version.

Launch metadata follows the ordinary metadata-authority path. A runtime session
upsert can never initialize canonical metadata, even when it supplies a newer
revision. Once reconciliation supplies the current authority fence, the runtime
atomically stores that canonical binding and enqueues the metadata from its
durable `LaunchRequest` as a CAS proposal. A UUIDv5 derived from the launch ID
in a fixed protocol namespace supplies the retry-stable metadata-operation ID
without sharing the caller-allocated launch-ID namespace. This makes process
restarts idempotent, routes unchanged through attached control-node branches,
and prevents a delayed initializer from overwriting a key that the authority
has already changed.

Stop is not archive. It closes the active native handle, persists a resumable
binding, and lets the provider preserve whatever is needed for resume. Archive
requires that stopped binding and is separately journaled:

```text
accepted -> releasing backend -> releasing provider -> succeeded
                       \-> failed or outcomeUnknown
```

Backend release precedes provider release because a provider-owned container or
worktree may still be needed to reach the backend. Progress flags make restart
recovery skip releases already recorded as complete. Success atomically creates
a runtime native-binding tombstone and removes the binding; only then does the
metadata authority make the session cold/archived. Ordinary failures leave it
stopped. Ambiguous cleanup is exposed as `outcomeUnknown` for operator
reconciliation.

## Example: containerized PR reviewer

A reviewer extension can remain entirely outside core:

1. A gateway plugin exposes `review.launch`, requiring a normalized PR URL,
   exact runtime/profile selection, review policy, and optional non-secret
   metadata such as `review.repository` and `review.pull_request`.
2. It verifies the URL against company policy, optionally performs placement in
   domain code, constructs a standard `LaunchRequest`, and calls only the
   restricted launch port.
3. The matching runtime provider validates the same JSON contract, resolves
   credentials from runtime-local configuration, allocates a worktree, records
   a checkpoint, starts a container, records another checkpoint, and returns a
   backend plus a container-local workspace path.
4. The backend adapter starts or resumes the native Codex/Copilot session and
   remains the only source of native events and history.
5. Stop preserves the container/worktree if that profile promises resume.
   Archive releases backend-native state first, then the provider removes the
   container and worktree idempotently.

One important topology constraint is non-negotiable: putting only the worktree
or CLI in a per-session container while retaining a shared app server outside
does not provide honest per-session process isolation. If isolation is the
profile's promise, the app server and its adapter-facing endpoint must live
inside the managed container (or another equally isolated backend). A shared
app-server backend is a valid density optimization, but its capability should
say so and its provider must never destroy that shared process when archiving
one session.

## Embedding surfaces

The published runtime daemon also accepts a static `createComponents` factory
through `RuntimeNodeAppOptions`. Applications can register custom providers and
disable the direct workspace profile without duplicating transport supervision.
The factory runs after allowed-root canonicalization and before network startup.
Once returned, its adapters/providers belong to the daemon's normal service
shutdown; a failing factory must clean up its own partially constructed resources.

Embedded control daemons can use `ControlNodeAppOptions.onReady` to persist the
control identity, endpoint, and signed locator privately. `printTicket: false`
suppresses the reference CLI's locator output. The callback runs after the HTTP
surface is listening and before the daemon waits for shutdown; callback failure
uses normal startup cleanup. This is process composition, not a wire API change.

The reusable boundary is split intentionally:

- `@arduano/agent-multiplex-protocol` supplies Zod schemas and tRPC-compatible access,
  runtime-link, and control-link contracts;
- `@arduano/agent-multiplex-gateway-core` supplies multi-source projection plus the
  restricted gateway plugin port;
- `@arduano/agent-multiplex-control-node-core` supplies durable authority, recursive
  routing, search, and operation journals behind transport-neutral ports;
- `@arduano/agent-multiplex-runtime-node-core` supplies provider/backend registration,
  durable execution, path policy, and native adapter routing;
- `@arduano/agent-multiplex-transport-p2prpc` binds those tRPC contracts to the v1
  API of the exact `@arduano/p2prpc-core` dependency;
- `@arduano/agent-multiplex-client` and
  `@arduano/agent-multiplex-client-p2prpc` supply browser-safe HTTP/WebSocket
  and Node-only p2prpc clients respectively for
  bespoke UIs and internal services.

Domain systems should store their own workflow state and link it through
namespaced session metadata. Metadata remains a flat key/value document whose
values may be arbitrary JSON. It is not a plugin database, work scheduler, or
native transcript store.


## Backend image filesystem boundary

A custom backend that exposes native output files implements bounded
`readImageFile` for its own filesystem and applies workspace/explicit-output-root
confinement. Core must not read host-local paths on behalf of a container or
remote backend. Image bytes and snapshots are runtime-owned resources retained
until archive; archive includes their release before its tombstone succeeds.
See [the image-v5 contract](images-v5.md).
