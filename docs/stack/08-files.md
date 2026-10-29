# 08 — Scoped immutable files and safe preview contracts

One Node `FileStore` owns its supplied private directory. Uploaded bytes become
immutable `StoredFile` records scoped to the complete authenticated conversation.
The caller supplies an original file ID; an identical duplicate reconciles to
the existing object, while different bytes or metadata conflict. Byte hashes,
canonical manifests and explicit four-field scope copies prevent accidental
private Host context from entering the public descriptor. A framework route must
bind this scope to its authenticated authority; a file descriptor grants no
additional principal, session or filesystem authority.

The portable `files/contracts` surface contains descriptors, read leases and
preview DTOs. Node-only `files/node-contracts` declares borrowed lookup,
capture/read/input facets and the owned `OwnedFileStore` maintenance/close
contract. The public `files/node` facade selects the implementation in
`files/server/store.ts`. Private directories and path-authority callbacks stay
on the Node side. Every borrowed facet forwards the owner's exact
`resourceIdentity`; wrapping bound methods does not create a new file owner.
Transferring an `OwnedFileStore` to another lifetime owner includes final close;
a borrower receives neither collection nor close authority.

The F07 extraction passes all seven existing filesystem/preview cases. The
actual assets composition additionally forwards a faithful `OwnedFileStore`
wrapper and asserts one final close of that exact resource. The browser
descriptor/read contract still compiles without Node declarations. These are
disposable source/FS proofs, not additional native or platform qualification.

Host-referenced files are a separate `HostFile` capability. Its opaque ID and
display name contain no disk path. The injected `HostPathAuthority` resolves an
observed source key against native/workspace context and private-path policy.
The store does not accept a browser-selected path or infer broad filesystem
access. Capture rechecks that authority, requires a canonical regular file,
opens with no-follow, compares the opened device/inode, reads an explicit bounded
size and rejects changes observed across the read. A capture is a new immutable
cache object; later disk edits do not change already-captured bytes. Host
references are bounded, short-lived and process-local; after restart the Host
must remint them from an authorized observation. Disk source authority is never
reconstructed from an untrusted history string alone.

The initial upload primitive accepts one bounded `Uint8Array`, default 32 MiB.
It copies bytes before asynchronous I/O and reserves entry, Host/session byte
and staging quotas before publication. This deliberately does not implement a
resumable/chunked HTTP upload protocol or another effect outbox. A future transport
must bound its own request/encoding buffers before calling this owner.

Each object is published as an atomically renamed directory containing flushed
data and a bounded canonical manifest. Directory synchronization precedes its
successful return. `put` optionally accepts a fifth `{signal, onCommitted}`
publication contract. It checks cancellation immediately before rename and calls
`onCommitted(file)` synchronously after visibility/entry registration, before
fallible directory synchronization. Synchronization is attempted even if the
witness throws. The actual transfer engine uses this boundary for markCommitted;
completed staging or a memory-buffer receipt is not publication. An identical
already-published immutable object supplies the same positive witness. One empty SQLite lock transaction provides OS-released writer
ownership, without a second domain journal or stale-PID stealing. Reopen validates
the private layout, manifest shape, object identity and full byte hash before
returning any retained object. Unknown files, corrupt objects, foreign lock DB
state, permissive ownership and symlinks fail closed. Reopen never repairs or
adopts an unrelated directory. A publication failure after rename is uncertain:
the owner refuses further work until close/reopen and exact original-ID lookup;
it does not claim the file was absent or overwrite it with a new attempt.

Read leases pin an immutable object through preview or native consumption.
They verify the complete hash on acquisition and check file identity/metadata
around bounded positioned reads. Quotas include pending acquisitions, and close
refuses while publication, captures, maintenance or leases retain custody.
`prepareInput` gives an injected structural native port the leased path and read
function, returning its prepared value plus explicit release. It imports no
concrete adapter. The caller retains that release through the actual native
consumption boundary; observation cancellation is not consumption completion.
Ports that allocate additional resources own their partial cleanup and those
resources' lifetime; the store only owns its supplied byte lease.

User uploads default to session retention. Captures default to cache retention.
Cache entries expire after a configurable ten minutes; collection skips every
held object. `retireSession` durably seals new file admission for that scope and
makes its objects eligible for collection after all holds end. This is an
explicit lifecycle policy call, not an implicit consequence of hiding a tab,
disconnecting a viewer or showing an archived conversation. Collection runs on
open and before new uploads; the composing Host may also call `collect` while
idle. A timer is unnecessary to keep storage bounded when no further activity
occurs. Deletion first renames the object into owner staging; a killed deletion
is reclaimed as unpublished staging on reopen. Failed deletion retains accounting
and poisons the owner rather than inventing reclaimed space.

Host bytes, per-session bytes, entries, scopes/retirement markers, staging
bytes/count, active leases and Host references all have explicit independent
limits. Retired-scope markers remain bounded by the scope quota rather than
growing without limit. Data byte accounting excludes bounded metadata and the
small lock database; it is not an exact filesystem-block or memory-size claim.
Metadata has separate per-record structural/UTF-8 bounds and bounded record
counts. Staging admission also charges objects currently being deleted.
Images are recognized by supported PNG/JPEG/GIF/WebP signatures; these checks
are not a full image decoder, dimension/decompression qualification or malware
inspection.

The browser entry exports reference/lease types and preview descriptors only.
Images, PDF, HTML, Mermaid, text and download paths are distinct. HTML carries an
empty sandbox and restrictive CSP for an opaque frame; it must never be inserted
as application-origin HTML. Mermaid requires strict security mode. Active SVG
falls back to download. UTF-8 text and preview size are bounded. The future HTTP
and UI layers still own MIME/content-disposition headers, opaque-frame wiring,
actual renderers and image decode limits. This layer claims those contracts,
not browser rendering or native adapter qualification.

Source provenance: the retained public reference is
`61d90fd1cb356ccf15a7d681f8d896e38196ef9d`, particularly
`primitives/v8-files/src/contracts/{types,content}.ts`, `src/host/ledger.ts` and
`src/native/index.ts`. Signature recognition, scoped immutable identity, bounded
reads and lease ownership retain their useful semantics. The old worker/SQLite
file ledger, consumer-release journal, resumable upload states, capture mapping,
HTTP client cache and vendor-specific image functions are not copied wholesale.
Applicable primitive invariants are replaced by the focused filesystem and
browser-contract oracles here; integration/native/browser coverage is not retired
or claimed by these tests.

Validation: strict TypeScript 5.9.2/Node 24.19.0 compilation passed, including a
browser-only compile with Node ambient types disabled. Seven focused filesystem
and descriptor tests passed on the final source after scope/manifest/accounting
counterexamples, root-directory synchronization and bounded directory enumeration
were added (9.199 seconds, concurrency 1, 30-second per-test bound). The coordinator
owns the later full-graph/archive gate. Test roots are removed in `finally`, all
leases/owners close, and the one deliberately killed disposable Node writer is
reaped. There were zero native-agent/model/provider/service operations.

Remaining boundaries: Windows ACL/durable rename semantics, physical disk-full
or fsync fault injection, synchronous constructor/SQLite filesystem stalls,
actual HTTP transfer limits, browser preview behavior, native input materializing
ports and their live consumption are unqualified. Existing native sessions,
services and private application state were not read or changed.

Independent checkpoint: source `f0ac7cb`, archive SHA-256
`9f2ae6836f9b0a7c298c206094671ae5965d2d89fd381bc350fecaba19c46b01`.
Own locked install, whole archived strict typecheck,33-module boundary graph,
all7 filesystem/preview cases and clean build passed. Earlier unchanged owner
suites retain their recorded checkpoints. This evidence annotation is docs only.

Asset integration exposes `isRetired(scope)` as a read of this existing owner.
Upload/input/capture admission can refuse an already retired session before
reserving resources; no consumer keeps a second retirement ledger. The scoped
retirement/held-lease invariant is qualified by18's actual FileStore composition.
