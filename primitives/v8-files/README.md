# V8 file primitives

Generic browser-safe contracts/client, worker-owned Host ledger/bytes, pure
native preparation and authenticated HTTP routing. Modules reuse the actual
history client and hardened SQLite helper; no consuming application source,
configuration or dependency installation is required.

The [file ownership contract](../../docs/design/v8-architecture.md#files-and-resource-ownership)
separates user uploads, native/request holds, cached immutable bytes, referenced
disk files and preview resources. First-preview capture preserves displayed
identity. Selected fixture limits permit arbitrary binary objects up to 10 MiB,
with image/text previews, IndexedDB reload recovery and background transfers.
Native model submission remains image-specific.

Expiry is pressure-driven only after all holds release. Bytes remain charged
until actual unlink succeeds. New staging admission expires at most
`cleanupBatch` stale uploads across all scopes because staging count/bytes are
Host-wide; scoped draft/trash cleanup stays separate. Remaining pressure can
truthfully return `STORAGE_FULL`, and later explicit cleanup/admission progresses
without a background timer or discarded original identities.

Native output capture uses a bounded memo of pending/recent resolutions, not a
lifetime image quota. Settled memo entries may roll; the same worker's existing
capture ledger retains occurrence signatures, original artifact IDs and expired
identities. Its native registration methods are trusted Host-only capabilities,
absent from ordinary `FilePort` and HTTP. Pending file jobs stay counted until
actual settlement. History rows retain already published availability after
their memo entry rolls; a later explicit page can resolve the same immutable ID.

Scoped path capture carries an optional exact native history scope. The owning
Host validates its attachment and child membership, obtains a trusted native
cwd for relative child paths and resolves an absolute path before the same root
FileHost reads it. Callers never supply cwd or new read roots. Unproved child
cwd stays unavailable; absolute paths retain the existing confinement policy.

`contracts/navigation.ts` describes credential-free authenticated file addresses.
`transport/navigation-http.ts` is a transient response adapter over the same
`FilePort`. The embedding authenticates every request and selects the current
Host scope and grant: first disk capture needs file-write access, while an
existing artifact needs read access. GET and HEAD verify the same bounded bytes;
HEAD emits no body. Full verification precedes ranges or explicit interactive
HTML. Raw HTML is downloaded; the explicit HTML representation adds an opaque
script-enabled sandbox and restrictive response CSP. Native file IDs and source
keys are references, never credentials. A disconnected response retains its
actual pending operation and any failed lease release within the admission cap.

Run `npm run qualify` here for the bounded source gate. It uses framework-owned
locked tools, disposable state and Chromium, with no native-agent/model/provider
calls. The [integration gate](../v8-integration/README.md) reuses selected file
oracles and real binary HTTP/browser seams. Source-hashed artifacts are local,
ignored and scoped to their inputs; they are not public deployment evidence.

The private archive barrier refuses active read leases and unreleased native
consumers. Its seal rejects new acquisition/writes/collection while retaining
bytes, manifests and audit holds; release of an already held lease stays valid.
The session owner supplies the durable outer admission seal across reopening.
Archive does not guess a missing Send outcome or delete its unsettled evidence.

Full renderer coverage, installed native temporary-path behavior, Clear and
metadata compaction remain separate. Reload recovery needs the
embedding's explicit reconciliation. Production/native acceptance is not implied
by scripted file or image-byte delivery.
