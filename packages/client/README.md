# @arduano/agent-multiplex-client

Protocol-v6 clients for the authority-neutral `access` contract.

`createAccessClient` is the HTTP/WebSocket client used by browsers, TUIs, and
embedded dashboards. Bearer providers are evaluated again for every HTTP
request and WebSocket reconnect. Each query or mutation has its own HTTP
request, so a slow native history or task read cannot hold another operation's
response in the same batch. Cancelling one request does not cancel its peers;
it does not prove that dispatched remote work stopped. `watchAccess` adds
bounded serialized consumption, application-level retry, cursor advancement, and replay
suppression. A `nativeGap` is passed through: recovery always uses the native
`readNativeHistory` operation.

`readCommandReceipt(client, savedEnvelope)` reads `commands.get` once and
validates the full immutable command identity/body before returning its receipt.
Missing and `outcomeUnknown` receipts never dispatch the saved mutation.
Successful send/steer receipts establish acceptance, not native message display
or completion. `assertCommandReceipt` applies the same validation to an initial
mutation response. Failed and unknown generic command receipts carry a typed
`CommandError` with fixed public text, stage, certainty, and diagnostic ID;
clients must not treat its diagnostic ID as retry authorization.

`LifecycleNativeHandoff` implements the subscribe-first handoff for an active
Copilot session. Buffer access-stream items before calling
`sessions.readLifecycle`, install the returned snapshot once, then apply only
the contiguous native suffix it releases. A stream reset, explicit gap, binding
or runtime-epoch replacement, missing sequence, or bounded-buffer overflow fails
closed and requires a new snapshot/history recovery attempt.

Launch helpers construct retry-stable protocol-v6 requests against an exact
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
