# 18 — Host assets and native materialization

One `HostAssetOwner` owns its supplied immutable FileStore, business upload
reservations, native-input holds and captured media. The published p2prpc file
engine owns byte transport, manifests, chunk integrity, transfer IDs, progress,
backpressure, reconnect and transfer receipts. Multiplex does not repeat that
protocol in tRPC procedures.

## Public contract

`./assets` exports `uploadFile(remote, files, {session, file}, data, signal?)`,
`assetFileReadPort(remote, files)`, schemas/descriptors and `replaceAsset`.
`remote` is the actual inferred asset-router client projected to its four
business operations: `begin`, `status`, `abort`, `acquire`. `files` is a borrowed
facet of the actual bridge peer's `PeerFiles`; it grants no peer-close authority.
`data` is a bounded Blob or Uint8Array. The helper sends one `begin`, one actual
`files.sendFile(blobSource(...))`, waits its result, then reads the exact status.
It never repeats admission or an agent Send after an uncertain response.

The Node entry exports `HostAssetOwner`, `assetRouter(owner)` and its public
construction/borrowed contracts. Store ownership, including final close, passes
to this exact owner. No private directories or native paths enter browser DTOs.
The router uses the existing `hostMiddleware` through official tRPC composition,
plus a positive `BridgeContext` capability check; missing bridge context fails
closed. The kernel's base context does not acquire a generic resource bag.

| Boundary             | Owner and rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `begin/status`       | A scoped ID, name, exact length, SHA256, MIME and retention identify the immutable resource. Begin reserves one fixed-size bounded buffer; status can reconcile a completed manifest after restart without dispatching an effect.                                                                                                                                                                                                                                                                                                                |
| `incoming`           | The actual authenticated FileOffer principal is decoded by the transport's verified-delegation helper. Control permission, Host namespace, optional selected session, upload token and exact UploadSpec must match. Arbitrary browser claims or a native path confer no authority.                                                                                                                                                                                                                                                               |
| FileDestination      | The existing peer engine delivers chunks. The destination retains the reservation, supports the same manifest's existing engine-managed resume, verifies complete BLAKE3 and business SHA256/type, then invokes FileStore.put once. It calls the engine's synchronous markCommitted only at08's actual publication witness.                                                                                                                                                                                                                      |
| `abort/expiry`       | Unpublished reservations release explicitly or on expiry. An already admitted publication remains charged through its actual promise. Neither disconnect nor UI clear claims rollback or completion.                                                                                                                                                                                                                                                                                                                                             |
| `acquire`            | The actual bridge files capability registry shares an immutable FileSource with short-lived peer/principal-bound authority. No second Multiplex lease/token/read-byte RPC protocol is exposed.                                                                                                                                                                                                                                                                                                                                                   |
| Source prepare/close | A prepared source acquires this owner's exact FileStore lease, performs bounded reads while hashing/transmitting, and releases only when the actual file engine closes it. Native/read acquisition remains jointly capped.                                                                                                                                                                                                                                                                                                                       |
| Browser preview      | The peer downloads into its existing explicit-quota memoryDestination. BLAKE3 plus business SHA256/length are verified before a FileReadPort exposes bounded Blob slices; release drops the retained Blob. This is a bounded whole-file preview, not a browser disk cache or unlimited streaming claim. One shared FileReadPort admits at most four retained/pending leases and64MiB of aggregate declared bytes, released on failure or explicit lease release; transport/hash/Blob copies can temporarily exceed that logical byte accounting. |
| Native input/capture | Existing Codex/Copilot structural input ports and media materialization retain their distinct native consumption and trusted path rules. They do not route through a second upload service.                                                                                                                                                                                                                                                                                                                                                      |
| Retirement/close     | Positive lifecycle Archive explicitly calls retireSession.08's retirement seal remains authoritative. Actual work, native inputs and failed cleanup retain custody; the exact supplied store closes once after cleanup. Bridge lifetime owners must retire their actual transfers before closing the assets resource.                                                                                                                                                                                                                            |

Defaults remain32MiB/file, four pending uploads,64MiB reserved upload bytes,
ten-minute upload expiry,32 combined read/native-input handle reservations,
16 actual reads globally and four per lease. Host reads are at most256KiB per
underlying read; a file engine chunk may be composed from those reads. No file
bytes are base64 encoded into tRPC inputs or outputs. Native inline image/data
URL capture still decodes its actual native representation locally.

`assetTransferMetadataSchema` permits absent metadata for capability downloads;
an incoming push requires its exact `{session,file,token}` object. Schema parsing
is not authentication. Only a verified FileOffer/BridgeContext principal may be
passed to the transport helper. Stable storage scopes come from the delegated
application namespace, never a logical bridge peer/session ID.

## Native authority and asynchronous projection

Private paths require HostPathAuthority and an explicit trusted occurrence/source
key.08 verifies canonical regular files, no-follow/device/inode/size and mutation
checks. URLs are not fetched and public file inputs accept no local path.
Capture is a snapshot at authorized capture time; it cannot establish historical
bytes from an old textual reference. Captured descriptors expose opaque IDs.

`prepareCodexInputs` creates native localImage/mention inputs; Copilot receives
its actual file attachments. Their adapters retain leases until native
consumption or positive Stop. A native Send ACK or observation release is not
consumption. `replaceAsset` fences exact RunRef/attachment/row/occurrence and
merges only the asset into the newest row, preserving later text and lifecycle.

## Coverage replacement and limits

The removed chunk/base64/offset/commit/read/release RPC tests are retired with
that implementation. p2prpc owns those transport invariants and its own browser,
interruption and commit tests; this layer does not claim them from a scripted
transfer driver. The bounded test driver invokes actual FileDestination and
FileSource contracts against real private FileStores and makes no retry claim.

The published SDK's manifest exposes `metadata` through a getter. This owner
materializes that public value with a shallow spread before retaining/comparing
its manifest DTO. Nested metadata already contains immutable ordinary values.
Strict protocol JSON validation remains unchanged. The real browser upload
journey exercises this boundary, which a plain scripted manifest cannot prove.

Seven focused owner cases retain immutable identity/reopen lookup, business
quota/hash/token/expiry, complete BLAKE3 refusal, delegated control and missing
bridge refusal, real source/native lease limits, retirement, inline image privacy,
trusted path/late Stop/newest-row fencing and scripted Copilot input/output
composition.08 separately proves publication witness versus abort/post-commit
failure.21 retains draft/uncertainty/custody checks. Exact current receipts are
recorded by the integration owner; browser/real Iroh/native-provider qualification
and historical P14 multi-hop/cross-viewer/auth renewal remain separate claims.
