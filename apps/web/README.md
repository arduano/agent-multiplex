# @arduano/agent-multiplex-web

The reference React operator interface and static-asset server helper for Agent
Multiplex. The browser application is compiled into the package; runtime
consumers use the exported Node.js helper to serve those assets from a gateway
or local control-node composition.

This UI is a reference personal/internal dashboard. Applications may instead
build bespoke interfaces against `@arduano/agent-multiplex-client`.

The package includes `THIRD_PARTY_LICENSES.txt` at its root and beside the
served browser assets. It is generated from the exact bundle and includes the
copyright notices and full license texts for bundled code, icons, CSS, and font
software.

Node gateway compositions can also call `installBoundedWebSocketEgress(wss)`
before tRPC's `applyWSSHandler`. The helper terminates an individual observer
before its queued application data would exceed the exported 8 MiB default;
this keeps stock tRPC subscription egress byte-bounded for slow clients. Set
the `ws` server's `maxPayload` to the exported
`WEBSOCKET_INGRESS_MESSAGE_LIMIT_BYTES` as the matching 8 MiB inbound bound.
Pass the exported `TRPC_HTTP_BODY_LIMIT_BYTES` to tRPC's `maxBodySize` option
to apply the same limit to complete HTTP request bodies. The maintained gateway
and control-node surfaces install all three bounds by default.
