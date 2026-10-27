# Isolated V8 catalog and creation primitives

One durable catalog authority reserves a stable logical conversation before its
native ID exists. Initial name/requested cwd and immutable original Create share
one worker-owned SQLite transaction. An injected exact Host request owner creates
native state; the authority publishes that proven binding independently. A lost
reply or restart reads only the original receipt. Nothing automatically replays
Create, Resume, adoption or metadata initialization.

Source is modular:

- `src/contracts`: browser-safe scoped identity, creation/metadata ports and validation.
- `src/authority`: bounded hardened SQLite worker, creation coordinator and narrow actual SessionPort adapter.
- `src/client`: retained logical entries, lightweight catalog and delayed composition of actual SessionWorkspace/HistoryWorkspace.

Import browser consumers from `src/index.ts`. Import Node ownership separately
from `src/authority/index.ts`. The module closes its build over framework
primitive source. No SDK/provider/native home is opened.

`CatalogAuthority.open({directory,scope,observationMs?,maxSessions?,maxOperations?})`
returns `CatalogPort` plus `register(HostCreationPort)`, `sealAdmissions`, `close`
and `terminate`.
`HostTarget.owner` is a durable authenticated request domain, separate from gateway
route epochs. Registration replacement retires the old route capability but never
stops its native work. The selected lifecycle's
[catalog bridge](../v8-lifecycle-default/src/catalog.ts) adapts its actual session
owner; read resolution must never create/Resume/attach native work.

Process shutdown explicitly awaits `sealAdmissions()` before its Host Stop
inventory. The authority owns reservations already awaiting SQLite and refuses
undispatched originals, including held observer registration, without starting
Host work. An optional `HostCreationPort.createAdmitted` delegates the same
original once and proves Host inventory admission before workspace/native
completion. An old port with pending or unknown admission remains `BUSY` until
positive exact-original evidence; sealing cannot invent refusal. Exact original
reads remain available. Ordinary Stop/StopAll does not seal creation.

`CatalogWorkspace({scope,port,sessions})` retains provisional draft/pin/original,
keeps lightweight rows separately, and binds the actual supplied history scope
only after positive native identity. Cwd is immutable **requested** launch intent;
name and a boolean Watch preference are mutable catalog metadata. Creation binding generation is provenance,
not current runtime lifecycle.

Rename and `setWatched` use one closed CAS/original owner and the existing
metadata operation table. Their original IDs share a collision domain; old
Create/Rename canonical payloads and stored rows retain their meaning. Missing
`metadata.watched` means false. Watch is only a canonical preference: it does
not pin, acquire an observer, change authority or promise notification delivery.
`metadataOriginal(scope,id)` reads the exact committed request/result, separately
from current metadata and with read authority. Gateways must also enforce the
returned session's exact Host/owner grant. A guessed original ID is not a grant.

The existing retained logical entry owns one pending/unconfirmed metadata
original across component mounts. A lost response is reconciled by that exact
read; neither a matching current name/boolean, missing lookup, reconnect nor
navigation proves its outcome or resends it. A proven older result may settle
its original without rolling a newer canonical catalog revision back.

Saved inventory consists of committed Catalog/Host metadata; it does not scan or
adopt vendor sessions. Explicit `publishArchive({scope,session,id,generation})`
asks the currently registered exact Host owner for a read-only completed archive
proof, then writes one monotonic fact on the retained Catalog row. Native
retirement remains a separate session original with its own control authority.
Retry after publication write loss rechecks only that same proof; it cannot
dispatch native work. Unknown Create/publication evidence never hides a row.

The framework [identity and original-operation contract](../../docs/design/v8-architecture.md#durable-identity-and-original-operations)
owns the cross-module boundary. Native/model execution, effective native cwd and
installation remain outside this module's scripted evidence.
