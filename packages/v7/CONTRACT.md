# V7 direct Host/Root contract

`@arduano/agent-multiplex-v7/protocol` is browser safe. The package root exports
Node `V7Store`, `HostService`, `RootService`, and `nativePortForAdapter`.
The wire generation is exactly `7`; reject other generations rather than negotiate.

Host construction: `new HostService({ store, hostId, name, native, ... })`.
Root construction: `new RootService({ store, rootId, ... })`.
Each store: `new V7Store({ filename, role: "host" | "root", instanceId })`.
The application database takes an OS-released SQLite exclusive connection lease.
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
Native queue views use nativeState. An unknown request is never a queued prompt.

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
Root does not maintain a second native state store. Its current Host views live
in memory and disappear on restart/disconnect. `attachHost({descriptor, api,
sessions})` supplies one complete Host snapshot and returns a connection token;
`updateHost(token,sessions)` and `detachHost(token)` ignore obsolete connections.
Transport authenticates Host identity and private relay policy before attachment.

Root watch starts with a complete RootSnapshot followed by strictly increasing
RootDelta revisions in the same Root boot. A slow observer is terminated and
must obtain another snapshot. Session streams carry one attachment ID and
monotonic sequence; bounded replay emits a gap when continuity cannot be proved.
Native/interaction failures affect only the targeted session. Presence never
depends on history, inventory, diagnostics, or model list requests.
