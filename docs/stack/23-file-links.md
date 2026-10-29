# 23 — Authorized native file links

A path in native Markdown is a preview candidate, not filesystem authority.
This layer connects a deliberate preview action to the existing FileStore
reference/capture boundary, then returns an immutable Preview. It introduces no
path resolver, file store, asset-transfer protocol, session journal or replay
owner. External HTTP/HTTPS/mail links and fragments keep ordinary navigation.
Relative names, native file URLs and Windows paths may be candidates; their
classification grants no access.

## Ownership and public contract

The browser entry exports FileLink, ResolveFile, FileLinkResolver and the small
candidate classifier. A FileLink carries the exact RunRef, native stream, row ID
and original href. The Node entry exports HostFileLinks and fileLinkRouter. The
router is an actual typed Host extension over05 hostProcedure/hostRouter, so the
normal Host contract, route epoch, admission and authentication remain in force.
Connection/principal/Host must match the authenticated caller; a session envelope,
when supplied, must also match the requested logical session and generation.

The Host supplies three authorities. `current` returns the actual native binding
for a logical scope. `history` returns only the proved `HistorySnapshotSource` for that run and
stream. `source` receives the actual retained native row plus requested href and
returns an existing opaque source key under the Host's actual workspace policy.
It must refuse hrefs that are not authorized for that occurrence. A browser
cannot send a trust root, private path mapping or a FileStore HostFile token.

FileStore's injected HostPathAuthority remains the only implementation that
resolves source keys to private disk paths. Its existing hardened capture checks
canonical paths, symlinks, file metadata and actual reads. The injected borrowed
`FileCapturePreviewPort` performs `reference` and `capture` through its one actual
asset/store owner; HostFileLinks never uses join/resolve/realpath as a competing
security boundary. Scope/run are rechecked after each asynchronous authority,
capture and read boundary, so a late old generation cannot publish a new preview.
Captured bytes may remain as a bounded immutable cache entry if a run changes
during I/O; stale completion grants no new lease or browser descriptor.

The capture ID derives from the exact run/stream/row/href occurrence. Reopening
or another row cannot alias it. Resolving that occurrence again preserves its
first captured bytes even if the live source changes. A trusted source policy
change does not retroactively edit already captured files; explicit file-scope
retirement/retention policy belongs to FileStore. Public descriptors never carry
disk paths. Capture/read refusal, unavailable history, eviction, capacity and
unsupported source conditions become a local unavailable preview, without
publishing private exception details or adding a session uncertainty state.
Actor/run violations are fenced at admission rather than disguised as success.

Text/HTML/Mermaid descriptor construction reads at most1MiB through the same
HostAssetOwner's scoped lease/read/release port. HTML retains the existing empty
sandbox and CSP. Verified raster/image and PDF captures use FileStore's existing
media validation and descriptors. Larger/unsupported content becomes the
existing download descriptor. Chat's separately bounded preview reader continues
to enforce its16MiB read limit; this layer does not claim an unlimited viewer or
a replacement download transport.

Both caches default to64 entries and two distinct captures in flight, with
bounded configurable ceilings. The browser additionally reserves at most16
pending/active handouts before any await, including coalesced callers waiting on
one capture. Handouts acquire actual FileReadPort leases and verify returned
scope/id/hash/size before publishing. Mounted previews protect captured bytes;
release frees their charge only after actual cleanup succeeds. `close` seals new
work, awaits pending capture/acquisition, releases late/active leases and remains
unready if cleanup fails. It cannot silently forget a pending acquisition.
HostFileLinks borrows one capture/preview capability, normally the actual
HostAssetOwner. It receives no separate FileStore, asset options, maintenance or
close authority. The asset owner owns its transferred store lifetime, retention
and cleanup. HostFileLinks closes only its own pending captures and descriptor
cache. `file-links/node-contracts` declares this dependency; the public Node
facade selects the implementation in `file-links/server/owner.ts`.

The F07 extraction preserves all five existing real-file/router/React cases.
They now supply a structural capture/preview facet and snapshot-only history;
closing links leaves the borrowed file owner usable. Scoped lint and strict
compilation pass. No browser, native process or deployed trust root is added to
this evidence.

## Chat integration

ChatProps adds optional `resolveFile`. HistoryRow supplies each row's recorded
native origin, including its actual child stream; missing origin never falls
back to root authority. Archived rows receive no resolver. ChatMarkdown renders
a small explicit Preview action for an authorized candidate. Rendering, stream
updates, reconnect and image Markdown never initiate capture automatically.
Existing explicit markdownFiles mappings retain their behavior.

One gesture invokes the resolver once. Stable Markdown renderer identities keep
that preview mounted during ordinary text/history updates. The returned real
lease is released on unmount or occurrence change, including when capture
settles afterward. The resource owner must remain alive until that cleanup has
settled and then close explicitly. React cleanup does not pretend to cancel
already admitted I/O. Capture failure stays beside that link; no native command,
session status or original-operation receipt changes. A lost read/capture reply
does not trigger an automatic retry.

A consumer composes the actual typed Host extension router, supplies its
`resolve` query to one FileLinkResolver with the existing scoped FileReadPort,
and passes `resolver.resolve` to Chat. The Host and resource owners close after
viewers release. This is an optional generic capability; private workspace/root
policy, gateway authentication and choosing which native rows authorize links
remain explicit consumer responsibilities.

## Qualification and replacement record

Focused strict ES2023/NodeNext/React compilation passed for source and tests.
Five focused cases passed in3.74s using disposable real filesystem/FileStore,
actual authenticated typed Host router and actual React Markdown/HistoryRow:

- Text, PNG, HTML and PDF capture; immutable bytes after source edits; foreign
  principal/run fencing; injected root refusal; `../` and symlink escapes;
  external/script links never treated as local capture authority.
- Shared capture with separate actual leases; bounded pending handouts; close
  waits a late real acquisition and releases it before reporting ready.
- No capture on render; one gesture through repeated clicks; retained preview
  during streaming rerender; exact release on unmount, including late results.
- Exact child-origin resolution and no fabricated authority for missing origin.

Source-boundary check passed137 modules. This extends16's Markdown and preview
owners rather than duplicating their HTML/CSP, diagram rendering, image viewing,
native media or file-read tests. Earlier FileStore path/retention tests remain
authoritative; this layer adds only their missing typed/React composition.
All test leases/Host owners closed and disposable directories were removed.

These are source, real FS/router and React owner proofs. No native agent,
provider/model, actual browser geometry, remote Iroh route, installed Host,
private workspace or production deployment was qualified or changed. The
reference application has not been silently granted a filesystem trust root;
an application must inject its real Host policy when enabling this capability.
