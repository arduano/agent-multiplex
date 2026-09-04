# Agent Multiplex access gateway

The access gateway is the zero-authority HTTP/WebSocket edge. One local
p2prpc node connects directly to one or more independently pinned control-node
sources. It keeps every healthy source synchronized, selects ancestor
projections over overlapping descendants, and keeps suppressed descendants
warm for failover. It never accepts another gateway as a source.

The public protocol-v4 `access` surface is available at `/trpc`; the reference
dashboard is served at `/`.

Configuration:

```text
AGENT_MULTIPLEX_SHARED_SECRET                         required, 32+ UTF-8 bytes
AGENT_MULTIPLEX_ACCESS_GATEWAY_SOURCES                required, versioned JSON
AGENT_MULTIPLEX_ACCESS_GATEWAY_STATE                  default .agent-multiplex/access-gateway.sqlite
AGENT_MULTIPLEX_ACCESS_GATEWAY_IDENTITY               default .agent-multiplex/access-gateway.identity
AGENT_MULTIPLEX_ACCESS_GATEWAY_HTTP_BIND              default 127.0.0.1
AGENT_MULTIPLEX_ACCESS_GATEWAY_HTTP_PORT              default 4318
AGENT_MULTIPLEX_ACCESS_GATEWAY_RECONNECT_MAX_MS       default 30000
AGENT_MULTIPLEX_ACCESS_GATEWAY_BEARER_TOKEN_FILE      optional single-token mode
AGENT_MULTIPLEX_ACCESS_GATEWAY_SCOPES                 optional JSON scope array
AGENT_MULTIPLEX_ACCESS_GATEWAY_AUTH_SUBJECT           optional audit subject
AGENT_MULTIPLEX_ACCESS_GATEWAY_AUTH_FILE              optional multi-token config
```

`AGENT_MULTIPLEX_ACCESS_GATEWAY_SOURCES` has this shape:

```json
{
  "version": 1,
  "sources": [
    {
      "sourceId": "laptop-root",
      "displayName": "Laptop root",
      "endpointId": "independently-trusted-iroh-endpoint",
      "locator": { "kind": "ticket", "ticket": "untrusted-reachability" },
      "priority": 10,
      "enabled": true,
      "requestedScopes": [
        "read",
        "agent-launch",
        "agent-archive",
        "agent-control",
        "terminal-view",
        "terminal-control",
        "metadata-propose",
        "topology-admin",
        "authority-admin"
      ]
    }
  ]
}
```

For multiple downstream credentials, point
`AGENT_MULTIPLEX_ACCESS_GATEWAY_AUTH_FILE` at:

```json
{
  "version": 1,
  "credentials": [
    {
      "subject": "mobile-viewer",
      "bearerTokenFile": "mobile.token",
      "scopes": ["read", "terminal-view"]
    }
  ]
}
```

Relative token paths are resolved beside the auth file. Without bearer auth,
the gateway refuses every non-loopback bind. The SQLite file contains only
operational source locators, cursors, and health; it is never domain authority.
It never stores terminal bytes, replay screens, or keyboard leases.
Renewed p2p tickets are persisted as preferred reachability hints. The
configured locator remains the bootstrap fallback for the same independently
pinned endpoint identity, so an expired renewal cannot strand a restart.

Terminal authorization is independent from chat/agent control.
`terminal-view` permits lookup and attachment to an already-open PTY;
`terminal-control` additionally permits open, keyboard-lease operations,
input, resize, and supported termination, and also satisfies terminal view.
It does not imply general `read`. The source's enrolled grant and the caller's
HTTP/WS credential must both contain the needed scope.

Launch, archive, and ordinary agent control are also independent capabilities.
`agent-launch` permits only durable launch creation, `agent-archive` permits
only the stopped-session archive transition, and `agent-control` covers
refresh, resume, stop, agent commands, and interaction resolution. Read-only
launch/archive lookup and watches continue to require `read`.

Domain-specific launch workflows are statically composed by bespoke gateway
applications. `@arduano/agent-multiplex-gateway-core` exports
`createGatewayLaunchPort` and `instantiateGatewayPlugins`; the port permits
runtime/profile discovery and launch create/get/list operations but exposes no
metadata mutation, agent control, terminal, source, topology, or authority
capabilities. Plugins are trusted in-process code rather than dynamically
installed or remotely supplied packages. A matching runtime launch profile
must independently validate the opaque launch input and owns provisioning,
recovery, compensation, and resource release.

Run with `npm run dev:gateway`, or build first and use
`npm run start:gateway`.
