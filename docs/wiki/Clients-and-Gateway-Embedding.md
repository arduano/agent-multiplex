# Clients and gateway embedding

The reusable client boundary is the protocol-v5 access router. The same shape is
served by a trusted-local control node and by the authenticated multi-source
gateway; applications do not need separate data models for the two.

## HTTP and WebSocket client

Use `@arduano/agent-multiplex-client` instead of constructing untyped URLs. Queries and
mutations use HTTP; subscriptions use a reconnecting WebSocket when `wsUrl` is
provided.

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

The v5 `images` API routes authenticated upload, read, and path-snapshot requests
through the selected source to the owning runtime. Use the client image helpers
and retain the same image ID/bytes when reconciling interrupted uploads. Native
history, events, command results, and interactions use a bounded
`native-json-images-v1` envelope; access harness fields through `.json` and use
`.images` for the referenced bytes. Image pointers preserve native shape rather
than define a common transcript model. See [images and native payloads](Images-and-Native-Payloads.md).

## Custom application edges

The reference gateway exports `createAccessGatewayRouter` and accepts an optional
`runGateway(config, signal, { httpSurface })` composition. A custom surface declares
`authentication: "external"` and owns all HTTP and WebSocket authentication before
creating `GatewayAuthContext`. It must preserve action scopes, bounded messages,
origin policy, and authenticated connection expiry. This is trusted static code,
not a configuration switch for bypassing authentication. Bearer configuration and
a custom surface cannot be combined. The stock daemon's bearer/loopback behavior
is unchanged.
