# Protocol-v5 images and native payloads

Protocol v5 adds bounded image transfer without changing domain-data ownership
or flattening native harness semantics. Its authoritative schemas and procedures
are in [`packages/protocol/src/image.ts`](../../packages/protocol/src/image.ts)
and [`contracts.ts`](../../packages/protocol/src/contracts.ts). Existing data-role
and launch invariants remain in [data roles](data-roles-v4.md) and
[launch extensions](launch-extensions-v4.md); their filenames remain stable.

## Ownership and routing

Only the owning runtime stores image bytes and upload progress. Control nodes
route one authenticated runtime/child path; gateways route one selected source
and own no durable image data. Images are scoped to a logical session, runtime,
and binding revision. Every transfer also carries the current runtime boot.
Descriptors contain immutable identity, media type, byte length, and SHA-256;
a process restart changes the transfer fence but does not change committed bytes.

Controls and gateways validate the session binding and route before dispatch and
again before releasing a response. Runtime replacement, source boot/feed
replacement, binding replacement, archive, and source selection changes fence
in-flight responses. A response cannot substitute another image, session, or
byte range. Gateways cannot be chained.

## Transfer and permissions

The access and runtime routers expose `images.beginUpload`, `writeUpload`,
`commitUpload`, `abortUpload`, `resolvePath`, `read`, and `limits`. Child-control
routes additionally carry the authenticated attachment/lineage fence.

| Procedures | Required access scope | Behavior |
| --- | --- | --- |
| `beginUpload`, `writeUpload`, `commitUpload`, `abortUpload` | `agent-control` | Allocate and commit immutable runtime image bytes |
| `resolvePath` | `read` | Snapshot an eligible runtime image path on first resolution |
| `read`, `limits` | `read` | Retrieve bounded chunks or configured runtime limits |

A caller supplies a stable image ID, declared size, hash, and MIME type before
sending bytes. Writes append at the acknowledged offset. An exact repeated
chunk is accepted; changed bytes or partially overlapping unacknowledged ranges
fail. Commit requires all declared bytes, matching SHA-256, and a supported
image signature. Commit and begin replay preserve the same descriptor. Clients
reconcile an interrupted transfer using the same image ID and original bytes;
they do not blindly allocate a replacement ID after an ambiguous result.

Decoded chunks are at most 256 KiB. Each image is at most 10 MiB, and a command
has at most 10 image references and 50 MiB of referenced bytes. Supported media are PNG, JPEG, WebP, GIF, and
SVG. Runtime quotas default to 512 MiB per session and 10 GiB total; pending
reservations count against them. `images.limits` is the runtime limit authority.
Harness/model limits can be narrower and remain harness-native. The 2 MiB
p2prpc control-frame limit and exact transport dependency are unchanged.

## Native envelopes

Native history payloads, native event payloads, command results, and interaction
payloads/resolutions use `NativePayload` with encoding `native-json-images-v1`.
The `json` field preserves native JSON structure. Known binary image leaves
become `null`, and `images` contains RFC 6901 pointers, original representation
(`base64`, `dataUrl`, or `path`), and immutable image descriptors. Path slots
retain `originalPath`; data URL slots may retain their exact `dataUrlPrefix`.
A sidecar for an asset reference or omission whose byte field was absent marks
`absent: true`; reconstruction removes that placeholder and preserves the
original native reference instead of inventing an inline byte field.
These preserve the original native representation on explicit reconstruction. Unavailable bytes use
an explicit reason at that same leaf. Pointers must be unique and target null
leaves; one envelope is bounded to 960 KiB and 256 image slots. Commands use
the same 960 KiB budget. The bound covers both JSON and conservative plain
MessagePack sizing, including float64 numbers, string/container headers, and
JSON escaping; JSON byte length alone is insufficient. A retained command
request and result therefore leave at least 128 KiB for record, event, and RPC
framing under the unchanged 2 MiB transport cap.
The estimate also reserves at least 16 bytes per value or map key, so two
maximum envelopes leave room below the transport's 131,072-value limit.

There is no heuristic wire coercion of arbitrary JSON into an envelope. Adapters
retain their internal native JSON interfaces and identify their own image
shapes; the runtime externalizes bytes, persists images, and validates envelopes
before publication. Native event ordering is preserved across asynchronous image
persistence. Overflow emits an explicit history-recovery gap and bounds further
payload admission while retaining lifecycle status, settings, and settlements
for already admitted interactions until the queue drains. Unknown/native omitted
image states must remain visible as such.

Input commands keep the native `request` shape and add an optional `images`
sidecar. Pointers are relative to `request`; image leaves are null until runtime
dispatch reconstructs the exact native representation. The durable immutable
command request and payload hash include those references, never reconstructed
binary data. Each adapter allowlists its native image input pointers; references
cannot inject image bytes into arbitrary tool arguments. Image-free commands retain their existing request/hash semantics.

History still comes from native APIs. Codex uses bounded `thread/items/list`
pages for item history, while metadata-only reads use `thread/read`; the client
follows native cursors. Both adapters budget history pages with the same wire
size estimator, including retained path/prefix metadata and image sidecars.
Neither runtime nor UI parses vendor history files.

## Paths, SVG, and external URLs

The direct backend resolves image paths inside the bound workspace plus explicit
image output roots. Broad launch `allowedRoots` are not an image-read grant.
Relative image paths resolve against the bound session `cwd`; absolute paths
remain subject to the same confinement checks. A relative path without a
session workspace is rejected. Symlink escapes, non-regular files,
remote schemes, and reads into the private image store fail closed. Custom
container/remote backends must implement their own bounded `readImageFile`
against the backend filesystem and enforce equivalent policy.

`resolvePath` uses a stable source key for the native item or Markdown image.
Its first successful snapshot is immutable; later path changes or deletion do
not silently replace that image. A new native image occurrence needs a new key.

SVG crosses the runtime/control plane as `image/svg+xml` bytes. Runtime code
must not execute, render, rasterize, or convert SVG, nor fetch external URLs.
Clients own interpretation. The reference UI creates authenticated, checksum-
verified Blob images and renders SVG only in an image context; it never injects
SVG markup into the DOM or opens it in a frame/document. For user-selected SVG
inputs, the reference browser composer decodes the SVG in an image context and
converts it to PNG through browser canvas before upload, fitting the longest
dimension to at most 4,096 pixels and checking the 10 MiB encoded-byte limit.
This client presentation step supports harnesses that accept raster inputs;
runtime output SVG remains its original SVG bytes. Core performs no conversion.
External URLs remain
links by default and must never become runtime path-resolution requests.

## Retention and archive

Committed uploads and successful file snapshots survive stop, resume, runtime
restart, browser reload, and later native history reads. Unfinished uploads
expire after 24 hours by default and can be explicitly aborted. Committed images
cannot be aborted or replaced. They remain until session archive.

Archive coordinates runtime image removal with backend/provider release and the
durable tombstone; it does not report successful release while image cleanup is
unfinished. Archived bindings are no longer image-read targets. Missing or
unavailable native images remain explicit unavailable slots. Losing the image
store does not authorize reconstruction from arbitrary files or terminal history.

Back up the runtime SQLite state and private image directory as one unit. The
SQLite backup API alone does not copy image files. Stop the runtime for a
consistent complete filesystem backup unless the embedding supplies its own
coordinated snapshot mechanism.

## Upgrade boundary

Protocol v5 rejects v4 peers; update controls, runtimes, gateways, and clients in
one coordinated maintenance window. Released v3/v4 SQLite migration identities
are unchanged. Appended v5 migrations wrap old durable native results and
interactions exactly once, add runtime image records, and reset the control feed
generation so old payloads/checkpoints cannot replay as new wire values. Legacy
JSON is retained unchanged inside its envelope, including any inline bytes
already journaled by v4; migration cannot invent runtime-owned descriptors for
that historical data. New output uses runtime image externalization.

A legacy native payload that cannot fit the v5 envelope causes an explicit atomic
migration refusal. The transaction preserves the original database, ledger,
feed, immutable command input, and result bytes. No migration truncates records,
invents image descriptors, or treats a shape resembling the encoding as already
migrated. Preserve a complete pre-upgrade backup; resolve an incompatibility
through an explicit upgrade/export decision rather than editing receipts or
released migration entries.

The [release checkpoint](../checkpoint-v4.md) records separately scoped v4 and
v5 qualification. Each passing receipt qualifies only its exact source,
dependency boundary, and recorded checks.
