# @arduano/agent-multiplex-client

Protocol-v4 clients for the authority-neutral `access` contract.

`createAccessClient` is the HTTP/WebSocket client used by browsers, TUIs, and
embedded dashboards. Bearer providers are evaluated again for every HTTP
request and WebSocket reconnect. `watchAccess` adds bounded serialized
consumption, application-level retry, cursor advancement, and replay
suppression. A `nativeGap` is passed through: recovery always uses the native
`readNativeHistory` operation.

Launch helpers construct retry-stable protocol-v4 requests against an exact
runtime/profile schema fence. Launch and archive responses may be intermediate;
recover them by ID or the bounded operation/watch APIs. `sessions.search` is
the bounded source for normal running/stopped lists and explicit archived,
metadata, provenance, or activity-window searches. Native history remains
delegated even for temporary resume and is unavailable after archive cleanup.

`watchTerminal` provides the equivalent cursor-safe, bounded subscription for
opaque ANSI terminal frames. `acquireTerminalKeyboard` keeps lease credentials
private, renews the single-writer lease, serializes input and resize, chunks
large writes, and retries an ambiguous write only with its exact sequence and
payload. Keyboard writes are UTF-8 text and are split only at complete code
point boundaries; terminal output remains opaque bytes and is never interpreted
as agent history by this client.

Node-only p2prpc connection helpers live in
`@arduano/agent-multiplex-client-p2prpc`, keeping this base package suitable for
browser and ordinary HTTP/WebSocket consumers.
