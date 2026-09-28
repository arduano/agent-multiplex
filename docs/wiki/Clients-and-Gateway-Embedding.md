# Clients and gateway embedding

The reusable client boundary is the protocol-v6 access router. The same shape is
served by a trusted-local control node and by the authenticated multi-source
gateway; applications do not need separate data models for the two.

For an active Copilot session, `sessions.readNativeState` observes the native
pending queue separately from transcript history. Gate UI controls using the
`queue.pending` and `queue.sendNow` v1 harness capabilities; older peers can omit
these surfaces. Reads use ordinary `read` access and never resume stopped
sessions. See [pending-message semantics](Adapters-and-Terminals.md#copilot-pending-messages)
for refresh events, message identity and atomic steering.

## HTTP and WebSocket client

Use `@arduano/agent-multiplex-client` instead of constructing untyped URLs. Queries and
mutations use HTTP; subscriptions use a reconnecting WebSocket when `wsUrl` is
provided.

`createAccessClient` sends each query and mutation as an independent HTTP
request. A slow native history or task read therefore cannot hold catalog,
health, or another session's response in the same HTTP batch. Each operation's
AbortSignal cancels only its request; it does not establish cancellation of
remote native work. Mutations are never automatically retried, and subscriptions
retain their separate WebSocket transport.

```ts
import { createAccessClient, launchRequest } from "@arduano/agent-multiplex-client";

const handle = createAccessClient({
  httpUrl: "https://agents.internal.example/trpc",
  wsUrl: "wss://agents.internal.example/trpc",
  bearerToken: async () => tokenStore.currentAccessToken(),
});

const runtimes = await handle.client.runtimeNodes.list.query();
const profiles = await handle.client.launchProfiles.list.query({
  runtimeNodeId: runtimes[0]!.runtimeNodeId,
  harness: "codex",
});

const request = launchRequest(
  runtimes[0]!.runtimeNodeId,
  profiles[0]!,
  "codex",
  { cwd: "/work/project", model: "gpt-5.6-sol" },
  { "work.item": "ENG-1234" },
);
const launch = await handle.client.launches.create.mutate(request);

// Keep the handle for the lifetime of the client and close it on shutdown.
handle.close();
```

Use retry-stable requests for uncertain mutations. Keep the same launch,
command, archive, or metadata operation ID and byte-equivalent immutable body
while reconciling an interrupted call; generating a new ID may duplicate the
domain action.

For command receipt recovery, call `readCommandReceipt(client, savedEnvelope)`.
It reads the original `commands.get` identity and verifies the receipt's full
immutable request, session and runtime. A missing receipt or `outcomeUnknown`
does not authorize redispatch. The reference console's **Check the original
command** action uses this read-only path. Send/steer success is displayed as
acceptance; native transcript events establish display independently. Native
messages are never matched to commands by their text or images. The reference
console retains uncertainty only for its current mounted binding; durable
reload and cross-tab draft recovery remain embedding-application work.

Generic failed or unknown command receipts now expose a typed `CommandError`:
an allowlisted code, stage, certainty, diagnostic ID, and fixed public message.
The fixed text is safe to persist and display, but the diagnostic ID is only a
support correlation key. Reconcile `outcomeUnknown` through the original
command ID and payload hash; neither an error code nor a new connection permits
redispatch.

For browser request construction, import the asynchronous helpers from
`@arduano/agent-multiplex-client/browser`. They use Web Crypto SHA-256 when it
is available and fall back to `@noble/hashes` when an HTTP origin or embedded
browser withholds `SubtleCrypto`. Both paths hash the same canonical JSON bytes
and have exact parity with the Node request builders.

## Access streams

The access stream combines bounded control history and native events. Consumers
must understand:

- source-selection resets when a gateway changes the selected projection;
- feed resets when a control feed generation changes;
- per-session native runtime epochs and sequences;
- `nativeGap`, which directs the client to the owning adapter's
  `sessions.readNativeHistory` path;
- heartbeat items, which are liveness rather than domain changes.

Use the cursor helpers and `watchAccess` exported by the client package. Commit a
cursor only after the application has committed the corresponding item. Native
history remains opaque harness data; do not build a fallback transcript parser.

## Copilot lifecycle snapshot handoff

An active Copilot `SessionRecord` carries a bounded runtime-produced lifecycle
label and exact binding fence. It is suitable for fleet and header status. Use
`sessions.readLifecycle` when a client needs the full payload-free state across
root work, tasks, children, queue, interactions, command delivery, compaction,
and continuity. Catalog running/stopped/archived state and source availability
remain separate; Offline, a successful receipt, or catalog idle does not prove
native completion.

The full response contains the runtime-owned lifecycle state and the exclusive
next native-event sequence observed with it. Use `LifecycleNativeHandoff` from
`@arduano/agent-multiplex-client` as follows:

1. Construct the helper and start the access subscription first.
2. Pass matching native, gap, stream-reset, and session-update items to
   `observe()` while the query is in flight.
3. Query `sessions.readLifecycle` and call `install()` exactly once.
4. Apply only the contiguous native events returned by `install()` and later
   `observe()` calls.

The helper discards overlap below the snapshot cursor and fails closed on a
missing sequence, explicit gap/reset, binding or native-epoch replacement, or
bounded-buffer overflow. Start a fresh handoff and use native-history recovery
when it reports `gap`; never fill the hole from terminal output, message text,
queue disappearance, or a newer catalog label. The gateway also fences the
query across selected-source generation changes, while controls revalidate the
current runtime boot and binding before returning it.

## Embedding a gateway

A bespoke gateway has four layers:

1. `createP2PAccessGatewayNode` from
   `@arduano/agent-multiplex-client-p2prpc` establishes independently pinned
   control-node sources and returns their typed access clients. Keep this
   Node-only package out of browser bundles.
2. An `AccessGatewayProjection` validates complete snapshots, selects
   non-overlapping sources, tracks warm standbys, and routes each action to one
   owner.
3. `createAccessGatewayRouter` exposes the core access surface with action-scope
   middleware.
4. The application mounts that router, optional domain routers, and its own
   authentication in a tRPC HTTP/WebSocket server. Install
   `installBoundedWebSocketEgress` from `@arduano/agent-multiplex-web` on the
   `ws` server before tRPC's `applyWSSHandler`; stock tRPC does not impose an
   egress byte ceiling for slow subscription clients. Construct the `ws`
   server with `maxPayload: WEBSOCKET_INGRESS_MESSAGE_LIMIT_BYTES` from the
   same package so one inbound message is bounded too, and pass
   `TRPC_HTTP_BODY_LIMIT_BYTES` as the tRPC HTTP handler's `maxBodySize` so
   POST bodies are bounded at the same edge.

The reference `apps/gateway` performs this composition for the stock web UI.
Domain launch routers are application composition, not a dynamic extension
endpoint: call `createGatewayLaunchPort(projection)`, pass that frozen port to
`instantiateGatewayPlugins`, and mount each returned router under the plugin's
namespaced ID in your bespoke root router.

## Gateway plugin capability

`GatewayLaunchPort` deliberately exposes only:

- runtime and launch-profile discovery;
- profile-aware model discovery;
- launch create/get/list;
- session lookup.

It exposes no metadata mutation, agent/terminal control, source configuration,
topology, authority, or projection object. Returned protocol records are cloned
and recursively frozen. This reduces accidental coupling, but a plugin is still
trusted JavaScript in the gateway process—not a sandbox.

Authenticate and authorize a plugin procedure before it calls the port. The
standard access route still enforces the source's `agent-launch` ceiling, but a
bespoke router must also decide which authenticated users may invoke the domain
workflow.

## Multi-source rules

- Configure sources as endpoint pin plus independent locator; never trust a
  ticket as identity.
- Connect directly to control nodes, including branches used as subtree proxies.
- Do not use another gateway as a source.
- Let ancestor coverage suppress a redundant descendant; do not client-side
  concatenate their rows.
- Treat `conflict` as an incident. Changing source priority cannot resolve an
  immutable identity or authority fork.
- After failover to a lagging warm source, reads may temporarily show an older
  canonical revision. Preserve mutation receipts until replication catches up.

## Dashboard boundaries

A UI may store view preferences locally, but sessions, metadata, launch state,
and interactions must come from the access API. Model and mode controls are
harness-native. Transcripts come from native history plus the live native
stream. Terminal data is a separate ephemeral channel and must not be merged
into canonical chat history.


## Images and native payloads

The `images` API introduced in v5 routes authenticated upload, read, and
path-snapshot requests
through the selected source to the owning runtime. Use the client image helpers
and retain the same image ID/bytes when reconciling interrupted uploads. Native
history, events, command results, and interactions use a bounded
`native-json-images-v1` envelope; access harness fields through `.json` and use
`.images` for the referenced bytes. Image pointers preserve native shape rather
than define a common transcript model. See [images and native payloads](Images-and-Native-Payloads.md).

## Custom application edges

An embedded control process receives `ControlNodeReadyInfo.createTicket()` in
`runControlNode`'s `onReady` callback. It obtains fresh signed reachability from
the running endpoint without exposing its private key, and rejects after
shutdown. A local application may periodically publish that locator through a
private rendezvous directory so an independent gateway can reconnect after
network changes or ticket expiry. Pin the control identity separately; the
locator never grants enrollment or action scopes. Publication cadence and local
file protection belong to the embedding application.

The reference gateway exports `createAccessGatewayRouter` and accepts an optional
`runGateway(config, signal, { httpSurface })` composition. A custom surface declares
`authentication: "external"` and owns all HTTP and WebSocket authentication before
creating `GatewayAuthContext`. It must preserve action scopes, bounded messages,
origin policy, and authenticated connection expiry. This is trusted static code,
not a configuration switch for bypassing authentication. Bearer configuration and
a custom surface cannot be combined. The stock daemon's bearer/loopback behavior
is unchanged.
