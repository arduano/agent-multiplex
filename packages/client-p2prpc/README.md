# @arduano/agent-multiplex-client-p2prpc

Node-only p2prpc client bindings for Agent Multiplex protocol v4. This package
creates a local p2prpc gateway endpoint, connects it to independently pinned
control-node sources, and adapts those connections for the zero-authority
gateway projection.

Use `@arduano/agent-multiplex-client` for browser-safe HTTP/WebSocket access.
This package intentionally owns the native p2prpc transport dependency and is
intended for gateways, CLIs, and other trusted Node.js processes.
