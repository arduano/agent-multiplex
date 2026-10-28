# V8 history primitives

An isolated executable qualification lane for the V8 history contract. The
modules are reusable code. The default gate uses scripted network/receipt
fixtures and synthetic or minimized captured native events. This directory is
outside the published workspaces and V7 build/test graph. There is no deployment
dependency on another checkout or product integration. A separate
[explicit live runner](qualification/live/README.md) qualifies disposable native
subsets only under a fresh finite owner allowance.

From this directory, with the framework's pinned development tools installed:

```bash
npm run typecheck
npm test
```

`npm test` performs strict checking, emits this directory into ignored `.build`,
runs the finite Node invariant suite, then runs the actual retained client in an
owned headless Chromium DOM harness. It writes a source/dependency manifest,
scrubbed result, log and SHA256SUMS into ignored `artifacts/latest/`. A failure
writes `failed-diagnostic`; only a complete pass writes `scripted-qualified`.
Chromium defaults to `/run/current-system/sw/bin/chromium`; see
[the browser runner](qualification/browser.mjs) for the exact environment.
No native/model allowance is consumed or implied. The parent release gates and
historic V7 suites are not a qualification claim for these new primitives.

## Simple contract

1. A proved native attachment installs one codec and Host capture owner. Capture
   spans zero browser viewers. Opening a viewer never resumes or stops native work.
2. Only that Host accumulates raw native deltas. The outward protocol carries a
   coherent retained snapshot or contiguous replay, then absolute versioned row
   changes. Browser subscribers cannot assemble speculative suffixes.
3. The reusable client validates a detached whole frame before publishing current
   state. Current-window eviction keeps retained view context; semantic retirement
   has explicit identity/proof and is retained in snapshot fallback as well as
   incremental commits. A missed replay cannot resurrect a retired row.
4. A workspace owns sessions independently of selection. Named views retain
   pages, expansions and anchors; sessions retain drafts and original operations.
   Pins hold independent local observation references. A view lease is never a
   native lifetime lease. An embedding owns the actual background subscriptions.
5. Native body recovery requires one named E01–E30 fact, exact scope and bounded
   read owner. UI reconnect, render, scroll, receipt checks and pressure cannot
   grant body reads. A timed-out consumer does not release an underlying read.
6. Text/body completeness, turn activity, observation freshness and the original
   Send receipt are different facts. Complete bytes require native full-body or
   native-defined captured-start-through-end evidence; Codex command starts do
   not prove the output prefix. Null/omitted output preserves evidence;
   an explicit full empty string is a known empty body.

History snapshots also retain `read`: idle, pending or settled acquisition state
with its exact initial/recover/older target. Optional commit `read` replaces that
projection; omission preserves it. Decoding an older captured-only snapshot
without this field produces idle. Acquisition admission publishes pending before
native dispatch; successful rows/edge commit before settled-ready. A finite
observer wait cannot settle or release actual work. Switching views/reconnecting
retains the same projection without another read.
This is retained Host/read-context state, not durability across Host restarts.
Observer expiry does not cancel underlying native I/O or promise settlement.

An eligible settled failed active-mode acquisition exposes an opaque token for
one explicit additional attempt, using the existing two-attempt allowance.
Duplicate token use joins the renewed episode. Unsupported/expired results,
stale bindings, exhausted allowance and consumed persisted cursors offer no
retry. Scope generation/read-context changes clear the projection and prevent
old settlement from publishing into the successor. No query, poller, scheduler
or additional persistence owner is introduced.

## Optional Codex question metadata

Codex optional questions are native assistant-message presentation metadata.
The live codec and native page normalizer share
[`codex/questions.ts`](src/native/codex/questions.ts): accepted titles/labels
remain exact, and excess or invalid whole questions are omitted within the
existing metadata bound without discarding message text. They create no
interaction, completion, callback or read authority. Reconnect and historical
display retain the same question facts; the UI may use them to edit a draft.

## Reference-only media extension

The [isolated files lane](../v8-files/README.md) adds an optional synchronous
native-media handler after exact root/child ownership classification. Known
inline image leaves are reduced to bounded occurrence references and exact byte
digests before history fingerprints/frames. Byte persistence is asynchronous
and separately bounded; it cannot delay text publication or settle Send.

The history package still has no file-store/native-SDK dependency. Files depend
one-way on its contracts/client. Native omission, absent byte fields and opaque
assets remain explicit; cross-page asset materialization and real native file
consumption are outside this qualification. Media resolution is a historical
commit observation, not a perpetual read lease: Host expiry stays authoritative.

## Modules and dependency direction

| Folder | Owns | May depend on |
| --- | --- | --- |
| [contracts](src/contracts/) | Exact native scopes, JSON/runtime validation, absolute frame schema | Platform JSON/collections only |
| [native/codex](src/native/codex/) | Pinned-shaped item/thread/turn semantics, indexed reasoning, live child authorization and pure cold ancestry proof | Contracts and injected CapturePort |
| [native/copilot](src/native/copilot/) | Pinned-shaped callback semantics, shell sequencing, explicit agent/legacy tool ownership and proven alias migration | Contracts and injected CapturePort |
| [acquisition](src/acquisition/) | Shared cold baseline, exact read episodes, native page admission, single-use persisted cursors and bounded retries | Contracts, Host and existing ReadCoordinator; injected read-only native port |
| [host](src/host/) | Raw append accumulation, evidence, residency, tombstones, atomic watch/replay and subscriber backpressure | Contracts |
| [client](src/client/) | Validated current state, retained workspace/view context, pure viewport intent/geometry | Contracts |
| [repair](src/repair/) | Finite actual read owners, observer deadlines, active versus single-use cursor rules | Contracts and injected read ports |
| [scripted](src/scripted/) | Qualification-only lossy link and original receipt/effect fixture | Real Host/client; no native SDK |
| [qualification](qualification/) | Unique output/ownership oracles, real DOM geometry and source-hashed evidence | Public primitives, Node tooling/Playwright in runner only |

[src/index.ts](src/index.ts) exposes the reusable facade. It does not export the
scripted effect/transport fixtures. No module imports V7 implementations, vendor
SDKs, credentials, files or a sibling checkout. Native kinds are concrete scope
unions, including Copilot's real legacy tool marker as its own namespace; a fake
agent ID is never manufactured. The executable scope type checks reject
cross-kind identities. Broader native controls and typed React binding live in the
[session](../v8-session/README.md) and [workspace](../v8-workspace/README.md) modules.

## Ownership and uncertainty

Cold/older reads now have a reusable [acquisition owner](src/acquisition/owner.ts)
and separate pure [Codex](src/native/codex/history.ts) /
[Copilot](src/native/copilot/history.ts) read ports. Native records supply no
Host versions. Historical lifecycle without positive completion stays `unknown`;
historical activity, permissions, edits and delegation cannot replay callbacks.
See the framework [history ownership contract](../../docs/design/v8-architecture.md#history-and-retained-views).

Production Codex `.162.1` reads use one bounded `thread/timeline/list` cursor,
with a distinct `timeline-v1` read context. Native windows arrive newest first,
with entries ordered inside each window by ordinal, kind and ID; an item and a
turn boundary can share an ordinal. The pinned
[canonical projection](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/thread_history_projection.rs)
stores `ItemCompleted` records, so timeline items provide positive completion
evidence without fabricated timestamps or inference from turn idleness. The
existing items-list port remains available with its original item-envelope
completion rules. Both reuse the same item/media normalization.

Live error notifications and native terminal-turn errors become exact
thread/turn-scoped notice rows with the native message. A complete diagnostic
does not certify turn completion or alter retry/Send behavior. Terminal errors
also survive reload through timeline boundaries, including turns with no items.
Captured retry-only notifications cannot be reconstructed after Host restart
unless native history itself retained that diagnostic. Arbitrary additional
provider details are not copied into row metadata.

One acquisition action skips empty continuing native pages until it reaches a
projected record, an explicit gap, a proved native end, or its finite native-call
budget. Copilot persisted reads still request one event at a time. The default
budget is 128 calls per action, each admitted decoded batch at most 512 KiB; the
owner holds one batch at a time and does not concatenate body pages. A scan-limit
page retains its exact available continuation, never an invented end. Unknown
native event types remain visible gaps rather than becoming ignored metadata.

The retained baseline and current/previous page handles coalesce viewers without
keeping every completed page in ReadCoordinator. Only exact settled superseded
paging facts are released; ordinary repair facts retain their existing renewal
rules. Active capture can establish a new baseline for a new real gap or window
generation. Persisted null/failed cursors remain consumed, with identity
tombstones bounded to 4096 entries and 1 MiB of serialized UTF8 keys/meanings.
Identity capacity, native expiry and byte failures remain exceptions; loaded
history survives. These bounds and the separate Host/native retention limits do
not claim unlimited-history coverage.

```ts
const acquisition = new HistoryAcquisition(hub.owner(scope), nativeHistoryPort, sharedReadCoordinator);
// Called by the attachment owner for a named cold-open fact, never by each mount.
const baseline = acquisition.baseline("E01", "cold-attachment");
await baseline.wait(500); // Consumer expiry leaves actual read and Host capture alive.

// Explicit older-page intent belongs to one retained view.
const token = view.beginOlderRead();
const result = await acquisition.older(token).wait(500);
if (result.state === "value" && result.value.status === "ready") {
  view.applyPage(result.value.page, token);
}
// To abandon this consumer: view.finishOlderRead(token). It cannot cancel native work.
```

The Host installs a local read fence before native acquisition. Any exact row
changed while the read runs keeps its newer native evidence, including across
current-window eviction. Stale missing-final/truncation facts cannot downgrade
that body. Native pages have no callback watermark: open historical text and a
later suffix are never concatenated. A subsequent full exact native final can
heal them. Shared-anchor order contradictions reject atomically; a new native
generation establishes its own order and fences old pages.

The Host alone mints globally monotone row/body version numbers for acquired and
native rows; the numbers are not vendor versions or per-row step counts. Cold
baseline publication is shared by all viewers. Older records/cursors remain
private view context. An empty filtered Copilot page can still have a continuation;
expiry/unsupported/failure is never native end-of-history evidence. Active
oversize reads shrink the same input; persisted continuations are consumed before
await and cannot be retried after error. There is no getEvents/resume fallback.
The selected SDK exposes no snapshot ID/generation/byte-boundary fields: the
older synthetic cursor helper is not used as a native persisted SDK wrapper.

Copilot's scoped read port retains a bounded event-identity ledger across pages
(4096 events / 1MiB of normalized fingerprints, no silent eviction). Reusing a
native event ID for a different logical row, owner or full body rejects the
whole page. Unknown/control envelopes retain safe headers, without instruction
or diagnostic bodies. This is distinct from live-versus-cold payload enrichment,
which still requires its native activation contract.

Qualification defaults add 1024 retained exact read/native evidence identities
and eight local read fences per Host scope. Native current residency is still
bounded separately. Completed, non-current evidence rolls out of this bounded
memory window; it is not a lifetime conversation quota or semantic retirement.
Current rows, running work and the selected read batch remain protected. Evicting
evidence retires outstanding local read-publication fences before a late page
could overwrite forgotten newer capture; the admitted native read remains owned
until it settles. A fence also retires if its changed-row set exceeds the evidence
bound. This does not change native cursors, cancel work or replay a read. Settled
stale/failed facts retain the existing explicit-reobservation limitations.

The generic Host body default remains 4 KiB; the production default lifecycle
selects 64 KiB per body and at most 128 current rows. A separate 512 KiB serialized
current-row budget includes JSON escaping and native metadata. Old non-running
rows leave shared residency rather than forcing ordinary complete plans and
messages to truncate. Previously observed client rows remain retained; neither
residency eviction nor evidence eviction establishes semantic deletion. Bodies
beyond 64 KiB remain explicitly truncated, and protected running work can still
exhaust bounded capacity. Full frames retain their separate 1 MiB wire bound.
Incoming read batches remain protected: a batch still exceeding current
capacity fails atomically rather than silently omitting rows from its cursor.
The 1024-entry evidence window can retain up to 64 MiB of UTF8 body text per
scope under the production body setting, plus bounded metadata and object
overhead; it is not an additional durable transcript store.

Codex `contextCompaction` is a bodyless native item, not an incomplete message.
Live starts explicitly retain omitted text; actual item completion adds
`native.compactionCompleted:true`. The native item-list completion envelope or
canonical completed timeline item supplies the same fact on reads. Parent-turn
settlement alone supplies no such proof and does not rotate the read boundary.
The existing generic terminal settlement still permits bounded row eviction;
no separate compaction job, timer or retained status owner is introduced.
Completion-only capture can retain missing-start evidence, which does not mean
that compaction has an absent textual final answer.

Acquisition targets100 native entries/events per active request within a512KiB
normalized batch. Existing same-input shrinking preserves the hard byte bound;
large records can return fewer entries. Persisted single-use native cursors keep
their one-event request semantics. Expanded reasoning
segments can force same-input shrink; singleton overflow remains unavailable.
`counters.portCalls` includes attempts rejected before a concrete native RPC;
injected RPC counters independently measure actual calls. Scripted counters do
not establish native conformance. The same ReadCoordinator spans
native resets, so an old hung read cannot free admission for its replacement.

The Host snapshot revision proves ordering of retained Host evidence. It is not
a vendor atomic history/event cursor and does not establish missing native
continuity. `knownStart` is a caller's proved capture assertion; the default is
false. Neither mounting nor a first callback proves a fresh empty conversation.

`HistoryWorkspace.setConnected(false)` changes observation availability only.
Client mounts/unmounts do not clear shared state. Pin preferences are local to
the in-memory workspace; disk/cross-tab/device persistence is not implemented.
Operations retain immutable original meaning; transcript matches cannot settle
them. The scripted ledger demonstrates that separation, not durable admission,
negative no-effect proof, receipt authorization or real native dispatch.

Attachment replacement requires explicit `rebind`. Scope keys contain connection,
principal, Host, native session and attachment plus the native child identity.
Old attachment frames/results are refused. A native edit rotates the affected
history generation and retires pending page tokens. Prior acquisition rows are
retained with exact old origins and `includesPriorGeneration`; they are stale
context, never current history or usable current locators. A renderer must label
or separate that context until new evidence replaces it. `thread/reverted` does
not identify a deleted suffix, so the codec does not invent one. Actual native
access authorization stays with the future authenticated adapter/port owner.

## Bounds and failure semantics

These are deliberately small qualification defaults, not selected production
retention budgets. Host defaults: 64 current rows, 4KiB body bytes per row,
32 scopes, 128 gaps, 256 semantic retirement identities, 32/1MiB replay frames,
16 subscribers, eight queued frames. A slow subscriber or replay-ring miss gets
a coherent retained snapshot, including retirement proof. UTF8 truncation is
explicit partial evidence. Admission never immediately discards a new row to
hide pressure. Terminal rows, including truncated or incomplete bodies, can
leave the current window while already-loaded client rows, body evidence and
anchors remain intact. Explicit recovery uses this same residency policy to
rebase a full window and publish its newly proved older cursor. An exhausted
window of running work still rejects protected capacity; no completion is
inferred to make room.

Coverage annotations also roll within their bound, retaining an explicit
truncation summary when older annotations are omitted. Their omission never
heals a partial body or proves a previously unknown prefix. Missing-prefix/final
annotations from a forgotten accumulator cannot downgrade an already proved
terminal complete body; native-gap and identity contradictions remain visible.
For a positively captured terminal complete body, orphan starts/deltas cannot
replace its bytes or metadata. A conflicting final is an explicit native-gap
annotation and preserves the proved body. Native completion may still supersede
a read-only snapshot; read provenance alone is not a captured callback fence.

Client defaults: 16 workspace sessions, eight retained views per session,
10,000 rows/16MiB approximate bytes per view, 128 original operations per session,
64 frame fingerprints and 64 retained generation fences. No draft, pin,
unresolved original, anchor or loaded row is silently evicted. Explicit pressure
errors preserve prior state. Browser/principal teardown and a later spill policy
are separate product work.

Reads default to two actual owners, 64 motivating facts and two attempts per fact.
Facts/scopes and semantic-retirement ledgers are finite; limits do not silently reset after
remount or a suffix delta. Settled facts remain coalesced; explicit finite renewal
requires a recognized new cause. Old-scope retirement blocks new admissions.
The active cursor can shrink the same input request; a persisted snapshot cursor
is consumed before await, pins the first native snapshot/byte boundary, and is
never replayed after failure. These are pure injected-port semantics, not a
claim that a selected running SDK honors them.

## Qualification boundaries

Focused tests check exact IDs/bytes, output order, gaps, native-shaped child
ownership, atomic publication, stale pages, underlying capacity and retained
client state. The DOM harness measures desktop/mobile anchor geometry. Actual
React/SSR/StrictMode integration is exercised separately by the
[workspace](../v8-workspace/README.md) and [composed application](../v8-integration/README.md).

Default fixtures use scripted ports and reviewed minimized captured events.
They do not launch native/model work or prove complete CLI/SDK conformance.
An atomic native page/live join, every child cold/live reattachment, experimental
cursor behavior and physical native reader release require their own native
oracles. Finite codec identity ledgers refuse pressure; indefinite-session
spill/rollover is separate work.

History does not independently own file bytes, terminal keyboard leases,
permission callbacks, durable command admission or process containment. Those
responsibilities remain with the corresponding modules. Terminal tool output is
conversation evidence; terminal scrollback is not canonical history.

The V8 shared-hop cancellation regression has a separate transport oracle. It
cannot establish an unobserved first physical-close caller in an older incident.
No old test is retired on a mocked pass. Ignored local artifacts preserve their
source/dependency scope and may contain private diagnostics; they are not
portable evidence. Further native/model work requires fresh explicit finite
scope through the [opt-in runner](qualification/live/README.md).
