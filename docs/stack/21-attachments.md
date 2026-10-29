# 21 — Retained composer attachments

`attachments` is a browser-only resource owner over the actual `AssetRemote`
business intent router and actual peer file engine. `AttachmentOwner(entry, remote, files)` is explicitly prepared by the
consumer; construction, imports and rendering do no I/O. `add` accepts bounded
File/clipboard adapters with name, type, size and `arrayBuffer`. Picker, drop and
paste in Chat call it only from gestures. No local path, provider union or agent
command enters this boundary.

The existing SessionEntry is the only owner of confirmed draft descriptors.
Its immutable snapshot exposes `attachments: readonly ConfirmedDraftAttachment[]`
(StoredFile descriptors). `setAttachments` validates exact session scope, unique
IDs, hashes and bounds, increments the same draft-intent identity as text, and
persists the draft. Version1 persisted entries may omit attachments, meaning an
empty list; an explicit invalid value is rejected. Switching, viewer release and
restore retain confirmed descriptors. They also protect an unpinned entry from
idle eviction. No transfer bytes or pending operation is written into draft
persistence.

One configuration seam, `WorkspaceOptions.attachmentLimits`, defaults to eight
files and32MiB combined confirmed/pending bytes and may be lowered. Entry-owned
preparation reservations enforce those shared limits and protect actual work
from eviction/close even when a view leaves. They do not open feeds, alter pins,
admit native work or block Stop. `submitDraft` refuses outstanding preparations.
The upload owner serializes its admitted transfers through `uploadFile`, uses the
existing media classifier and SHA-256, and verifies returned scope/id/hash/size
before publishing a descriptor. It retains no second confirmed attachment map.

Pending/failed/unconfirmed transfer UI is owned separately by AttachmentOwner.
Send remains blocked until that intent is confirmed or removed. A lost reply
can be checked only with the same upload ID through readonly `status`; checking
does not repeat begin or files.sendFile. Clear before dispatch prevents a queued
upload; clear after actual I/O starts removes intent while that bounded transfer
settles. It does not falsely report cancellation, delete a committed Host file
or replay a request. Partial Host uploads remain governed by AssetOwner's bounded
expiration/cleanup policy. Closing this resource owner waits its actual calls and
releases entry reservations; it sends no native command. Pending upload UI is
ephemeral; reload restores confirmed descriptors and retained Send originals.

Chat's existing synchronous `actions.draft(text, snapshot)` receives the exact
confirmed descriptor set. The consumer encodes its actual typed attachment IDs
with the text into one Command. `submitDraft` durably admits that immutable
payload/run/id before one dispatch, then clears only an unchanged draft intent.
If text or files changed during admission, the newer whole draft bucket survives;
already-sent files remain visibly selected in that newer bucket rather than
silently editing it. An unknown Send remains the existing exact original and is
reconciled by receipt read, without automatic resend. Native confirmation remains
separate from upload confirmation and command receipt.

The reference consumer injects one owner per entry and uses its actual asset
router plus the same peer's actual files facet. `referenceMessageSchema` carries text plus optional `{id}` attachments.
The scripted provider looks each ID up in the same run scope's FileStore before
counting a Send; foreign/missing IDs are refused. Its positive user row carries
ready immutable asset descriptors. The stateless media hook validates those
descriptors and uses the existing scoped FileReadPort for image/PDF/download;
it never invents authority from text or maintains another file cache. This
scripted provider does not consume native local files. Real adapter input leases
remain the separately qualified18 boundary.

## Evidence and limits

Focused strict checks cover the actual browser exports and reference binding.
Tests use disposable FileStore/HostAssetOwner transfers, retained client originals,
the actual React composer, and one model-free Reference lifecycle fixture.
They verify scope/restore retention; durable text-plus-file admission and newer
edits; unknown Send read-only reconciliation; lost upload commit status-only
lookup; pending clear/Stop/resource guards; picker/drop/paste and one Send; and
real reference missing/foreign ID refusal before scripted-provider admission.

Earlier source/React and qualifier receipts remain under `.cache/attachments-pr21`.
They are historical evidence, not qualification of the changed byte transport.
The current focused run separately retains actual destination/store ownership,
composer behavior and source type checking. Reference runtime and real browser
transport acceptance belong to the coordinator's composed gate.

These are scripted source/React owner oracles. No browser gesture geometry,
vendor agent, provider/model, live service or installed application is qualified
by this PR. No existing state is read or changed. The full reference browser
qualification remains a separate numbered review boundary.

## Contract boundary refinement

The public upload controller borrows only `DraftUploadPort`: exact retained-owner
identity, scope, confirmed draft files, configured limits and preparation holds.
Its contract exposes no transcript, dispatch, remote client or close authority.
Only application composition retains the actual `AttachmentOwner.close` method.
Chat accepts the controller only when its opaque owner identity is the exact
view-entry owner; equal SessionScope values are insufficient.

A new mounted React oracle deliberately pairs separate owners with identical
scopes and proves that dropping a file invokes zero transfers and changes neither
draft. The reference integration uploads its own and foreign fixture files via
actual `assets.begin` plus its FileDestination through a scripted PeerFiles driver, preserving the scoped native-input rejection
and successful same-scope Send assertions without leaking raw FileStore access.

The p2p bridge integration retires the custom chunk/commit upload wire. The
attachment owner borrows `Pick<PeerFiles<AssetTransferMetadata>, "sendFile">`;
it cannot close the peer or create another transfer engine. Tests retain the
same one-Send/draft identity, clear-during-actual-I/O, status-only reconciliation,
wrong-owner receiver and picker/drop/paste oracles. They use a scripted driver
of the actual destination/source ports for resource ownership; real transport
qualification is separate. A transfer result lost after publication leaves an
unconfirmed upload until exact status reads establish its manifest. No mutation
is retried to resolve that state.
