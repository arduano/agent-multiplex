# V7 direct Host/Root contract

`@arduano/agent-multiplex-v7/protocol` is browser safe. The package root exports
Node `V7Store`, `HostService`, `RootService`, and `nativePortForAdapter`.
The wire generation is exactly `7`; reject other generations rather than negotiate.

Host construction: `new HostService({ store, hostId, name, native, ... })`.
Root construction: `new RootService({ store, rootId, ... })`.
Each store: `await V7Store.open({ filename, role: "host" | "root", instanceId })`.
One worker owns the application database and its OS-released SQLite exclusive
connection lease. SQLite reads, FULL durable writes and initialization stay off
the transport event loop. Lists and snapshots use the last committed memory view;
mutations await durable acknowledgement before native dispatch. The process can
serve `ready:false` while opening its store. A bundled consumer copies the public
`@arduano/agent-multiplex-v7/store-worker` resource beside its role bundle, or
passes that copied resource as `workerUrl` to the store factory.
At most 128 pending writer calls and 8 MiB of inputs are retained, including
calls waiting for initialization. Overflow fails with `STORE_BUSY` before
submission, without a native effect or automatic retry. Close has one reserved
control slot and rejects further calls as soon as it starts.
There are no persistent PID locks, installer tables, session snapshots, prompt
queues, transcript copies, branch catalogs, or automatic session attachments.

The `HostApi` supports descriptor/list/models/create/resume/stop/recover/archive,
execute/history/nativeState/resolve/receipt/watchSession. Mutations use a caller
`requestId` and `sessionId` and return `RequestReceipt`. The immutable input and
append-only receipt transitions progress admitted → dispatched → succeeded,
failed, or outcomeUnknown. Same ID/same input returns the original receipt; a
different input is rejected. A crashed admitted request fails without dispatch;
a crashed dispatched request becomes outcomeUnknown. Neither is retried.

Only explicit create/resume/recover creates native handles. Stop retains native
history and bindings. Archive releases the local native attachment then marks
the binding archived. Native app servers own queue, histories, tasks and reverse
interaction callbacks; execute passes supported commands directly to that owner.
The Host releases a returned controller if storing or subscribing its binding
fails; that cleanup never certifies that native creation did not happen. A failed
native shutdown still closes local observers and reports the cleanup failure.
The writer closes only when no outstanding receipt owner can still write; a
failed native cleanup with pending owners retains it and reports
`CLEANUP_UNPROVED`. Shutdown has a bounded caller observation, but its exact
cleanup owner survives a `CLEANUP_PENDING` deadline. A late acknowledged native
shutdown drains actual operation completions before the application writer.
Mutations awaiting durability cannot dispatch after shutdown begins;
a late returned native handle is released without attachment or replay.
Native queue views use nativeState. An unknown request is never a queued prompt.
Stopped and archived history uses the optional detached native read hook without
Resume. Image-bearing execute retains descriptor references in the receipt and
requires a Host preparation hook before dispatch; image bytes stay at their owner.

Root owns session title/pinning/metadata; `RootCreateInput` adds `hostId,title`.
Native creation does not wait for rename. `RootApi` adds snapshot/watch/rename/
updateMetadata and routes the remaining operations to the session's exact Host.
The Root registry retains logical archive state while its Host is disconnected.
`interactions(sessionId)` returns current native callbacks for a fresh client;
they are never rebuilt from history or durable state. Every receipt includes its
immutable request, allowing a Gateway restart without a second request journal.
An optional opaque `context` is part of that immutable request and passes through
the Root and Host; native adapters do not interpret it. `updateMetadata` merges
the provided map, applies `remove` keys, and changes optional title/pin together
at the Root. Removed keys win if also supplied in the same patch.
Each session has one `metadataRevision`, advanced only when its metadata changes.
Optional `expectedMetadataRevision` atomically rejects a stale patch. Browser
mutations carry `expectedAttachmentId` to reject a retired attachment before
dispatch, in addition to unique callback capabilities. Native gap facts take
effect at ingress even when image presentation is pending.
Root does not maintain a second native state store. Its current Host views live
in memory and disappear on restart/disconnect. `attachHost({descriptor, api,
sessions})` supplies one complete Host snapshot and returns a connection token;
`updateHost(token,sessions)` and `detachHost(token)` ignore obsolete connections.
Transport authenticates Host identity and private relay policy before attachment.

## Input acknowledgement and control ownership

Host acknowledgement observation defaults to 15 seconds; Root forwarding to
20 seconds, original-ID receipt observation to 5 seconds and Host/Root cleanup
observation to 5 seconds. Injectable positive bounds qualify deterministic
fixtures. These bounds do not promise storage latency or cancel native work.
After dispatch, elapsed observation yields `outcomeUnknown` and retains the
native operation/its late settlement. A normal mutation lane stays owned until
the actual operation settles, including a typed adapter pending promise.
Before dispatch, expiry fences late preparation and a delayed dispatch-record
acknowledgement so neither can execute later. Every later lifecycle step is
fenced again; an operation may advance its fence only across its own attachment
retirement. An earlier native effect keeps the overall outcome uncertain if a
later stage expires or is rejected.
Only explicit adapter `AdapterInputNotSubmittedError` proof becomes definite
failure; generic native/transport failures retain uncertainty.

An exact current attachment plus explicit valid Codex turn ID admits urgent
Interrupt through a separately serialized control lane. Exact attached
interaction capabilities may reply through that lane. Unfenced controls remain
ordinary mutations; stale attachments fail before dispatch. Explicit Stop or
Recover may retire an expired owned attachment, but reattachment keeps a
separate pending-operation guard until the original owner settles. Old callbacks
and late acknowledgements cannot mutate the replacement attachment. Codex
requires an explicit positive interaction hydration baseline; idle appearance or
an empty callback list cannot erase uncertainty. Native input capabilities are
static adapter opt-ins and are advertised without starting/describing a model.
The original request ID passes to execute out of band for native queue identity;
it does not rewrite the user's immutable command or opaque context.

Root `rejectExecute(input,reason)` is an optional advertised additive contract,
`request.reject.execute/v1`. It admits a failed `execute` under the original
canonical input and fixed reason without any Host/native dispatch. Existing
requests win and are never overwritten. Its read-only observation of a Gateway-
enriched unqualified steer requires identical validated/fingerprinted public
contexts and permits only the captured private steer turn/attachment difference;
ordinary execute deduplication still requires the full immutable private hash.

Root original-ID reconciliation queries terminal Host receipts for both
`dispatched` and `outcomeUnknown`. Reads coalesce by identity and retain bounded
underlying ownership after caller expiry, with at most 64 owners by default.
Matched session/operation/hash and current Host ownership are required; lookup
never dispatches a command. Forwarding, late ACK and receipt lookup settlements
serialize monotonically so a terminal receipt cannot regress.
Root shutdown retains forward, receipt-read and settlement ownership until all
possible late durable writes finish, even when their callers already timed out.
Ordinary forwards use at most 64 retained owners by default. A separate finite
reservation of eight urgent controls admits exact-attachment explicit-turn
Interrupt, Stop/Recover and exact interaction replies when ordinary ownership
is saturated. Reservations occur before durable dispatch, so concurrent
admissions cannot overrun either bound. The Host still validates actual turn,
attachment and callback ownership; unfenced controls consume ordinary slots.

Interaction/lifecycle ingress reserves a bounded lane independent of blocked
presentation payload externalization. Only explicitly adapter-annotated
structurally proven presentation events may lose display continuity without
latching the native interaction guard, including pure final assistant material.
Missing annotations, unknown or authoritative events, delivery-bearing completed
items, actual interaction loss and continuity gaps stay strict. A
presentation gap remains visible for resynchronization and is not silently hidden.
Diagnostics may include fixed phase/reason and numeric duration keyed by
request/session/boot; they never need prompt/provider/path data.

Root watch starts with a complete RootSnapshot followed by strictly increasing
RootDelta revisions in the same Root boot. A slow observer is terminated and
must obtain another snapshot. Session streams carry one attachment ID and
monotonic sequence; bounded replay emits a gap when continuity cannot be proved.
Native/interaction failures affect only the targeted session. Presence never
depends on history, inventory, diagnostics, or model list requests.

## Negotiated origin observation

`observation.origin-liveness/v1` opts in to separate observer envelopes.
`HostApi.watchSessionObserved(input)` yields `SessionObservation`: unchanged
session events under `{ kind: "event", event }`, plus Host-origin heartbeats.
`RootApi.watchObserved(signal)` yields `RootObservation`: unchanged Root items
under `{ kind: "item", item }`, plus Root-origin heartbeats.
`RootApi.watchSessionObserved(input)` forwards the exact current Host's observed
stream. Transports advertise these optional methods only when implemented;
selected native observation additionally requires the actual Host descriptor's
capability. A new Root refuses an old Host's observed endpoint rather than
substituting Root liveness for Host liveness.

Legacy `watch` and `watchSession` retain their existing vocabularies and replay
semantics. Old consumers never receive an unknown heartbeat kind; new consumers
must fall back without claiming origin-liveness proof when a peer lacks the
capability. Heartbeats do not increment Root revisions or native event sequences,
prove native model progress, or certify transcript catch-up.

Producers emit an initial heartbeat and another every 10 seconds, independently
of payload materialization or durability. Root heartbeats identify the Root and
boot plus its current revision. Host heartbeats identify Host/boot/session/native
attachment, carry its emitted `eventSequence`, and report attachment-scoped
`receivedPresentation`, conservative contiguous `materializedPresentation`,
`pendingPresentations` and `presentationGap`. Every rejected, overflowed or failed
native presentation latches the presentation gap; a later successful ordinal
cannot conceal that missing work. Critical status/interaction ingress remains
independent of the presentation queue. An authoritative history rebaseline may
repair a client's view despite a retained stream gap.

Consumer liveness deadlines apply only after negotiation and only to missing
origin heartbeats, using a monotonic clock. Quiet thinking, tools, idle sessions
and pending materialization remain valid while those beats arrive. Root boot
and Host/attachment identity fences still apply. Renewing a stale observer is a
read-only operation with a bounded buffer and cancellation lifetime; it never
replays a native mutation or turns unknown work into success.
