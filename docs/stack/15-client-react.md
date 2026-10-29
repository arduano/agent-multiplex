# 15 — One retained client and committed React views

## Native Codex retained model

`codex/client` exposes `CodexWorkspace`; `codex/react` exposes the thin
`useCodexView` hook. Their input is the actual inferred `CodexRouter` read
client, rather than a generic history-row or command protocol. Applications
keep the actual native router for effects and their exact original receipts.
The retained read owner cannot Send, Stop, Resume or answer a callback.

One entry owns observations and bounded cached read bytes for an exact
`RunRef`. Root and proved child views share that run's single watch, while
each view owns its thread selection, native page references and anchor.
Views expose exact generated native thread/turn/item DTOs and opaque
`nextCursor`/`backwardsCursor` values. They do not fabricate child sessions,
merge IDs across turns or advance another view's pagination frontier.

The Host and browser share one pure Codex capture reducer, introduced with
the native adapter in layer 10. Host snapshots include bounded assembled
native state as well as the raw replay suffix. A fresh viewer can therefore
see an active item's already captured prefix after the replay ring rolls
over. Native completion snapshots can repair exact bodies; turn completion
does not prove that every tool or child completed. Native reasoning indexes
remain indexes, and native patch snapshots replace the corresponding patch.
Gaps, unbased deltas and bounded omission remain explicit.

Native read pages are separate evidence with `source: "native-read"`.
They never become live delta bases, overwrite streamed final text or pretend
to share an atomic native watermark. A native reversion invalidates that
thread's page epoch, including late pending replies. The Host capture cursor
for each reversion prevents repeated checkpoints from invalidating a page
that was already reread after the same edit.

Construction and rendering are inert. Committed views request a watch; pins
retain it while views switch or unmount. The first current capture decides
whether an initial passive read is necessary. A root positively opened by native
Create already has a valid empty baseline when neither capture nor assembled
state reports omission; this does not assert that a resumed/unknown thread or
child is empty. Otherwise a captured native item, or
native turn with included items, is already a useful recent baseline for
that selected thread. No read is performed in that case. Otherwise the view
requests missing metadata and up to 100 recent full turns, sharing current cached
pages and exact in-flight work with other views. An ordinary remount never
repeats that initial read. Older pages, missing content, invalidated pages
and explicit retry are separate caller-requested native reads; none resumes
native work. A failed read is not retained as a permanent promise latch. A later successful
metadata reply cannot hide a failure from the same overlapping read batch;
explicit retry starts a new batch.

The supplied `ObservationConnector` remains the sole logical reconnect
owner. Official tRPC connection-state changes also terminate an interrupted
logical watch, so recovery uses the latest Host cursor instead of silently
reusing a physical link's original input. Quiet reconnection receives a Host
checkpoint. Retained native data and anchors remain visible while freshness
is unavailable. The cursor proves only Host capture replay, never native
history completeness or exactly-once model execution.

Defaults bound 32 retained runs, 64 views, 16 cached pages with 4 MiB total
page bytes, 512 captured items with a separate 4 MiB capture payload budget,
two pending reads and 64 listeners per view. Exact native bodies are evicted,
not truncated into apparent completeness. Raw replay omission is distinct
from assembled state omission. A committed view's latest or anchored page
cannot be silently evicted; unavailable capacity refuses the new page. Later
eviction is an explicit view state, while the anchor remains its owner's
intent. Pins retain the observation, not an unlimited transcript. Workspace
close cancels read-only requests and joins observation cleanup; it does not
own or stop native lifetimes. Browser reload persistence is not implemented.

The focused native-client gate uses the actual inferred router with official
`experimental_localLink`, the existing observation supervisor, actual React
SSR/StrictMode, and the real Host capture owner with scripted native input.
Seven cases cover shared watches and initial reads, created/observed-baseline suppression,
independent view frontiers/anchors and pins, native read/live races and final
bodies, reversion/late replies, same-cursor retry, cache pressure/eviction,
attachment recovery and a fresh viewer after 150 deltas roll the replay ring.
Compile-only cases reject native effects through the retained read/view ports.
This is source/scripted/React ownership evidence, not a native-model, physical
relay, browser geometry or complete rollout claim.

The following generic-client sections describe the existing common presentation
and original-operation facilities. They are not a mandatory normalized Codex
data or native control surface.

The browser-safe `client` and `react` entries import declared protocol, history,
interaction and observation boundaries. They import no Node, storage, filesystem,
native adapter or private application code. Construction, entry/view preparation
and server rendering perform no I/O.

## Typed procedure boundary

Applications compose actual `createTRPCClient<Router>` instances with official
`@trpc/client` links. Router-derived input/output inference and cross-harness
type errors remain upstream tRPC contracts. The framework adds no generic HTTP
client factory, custom link, procedure envelope or second RPC method table.
`hostEndpointUrl(base, target)` supplies only the routing-metadata URL; procedure
paths, inputs and results remain ordinary tRPC. Subscription composition uses
`httpSubscriptionLink`; streamed query results use `httpBatchStreamLink`.

Fresh routing metadata does not rewrite a saved original's native generation or
payload. Cancellation releases an observation; it never retries or cancels an
already admitted business effect. These lifetime rules belong to the retained
entry and actual Host/Gateway owners, rather than another client wrapper.

The pinned client is `@trpc/client` 11.18.0, with React/ReactDOM 19.1.1 and types
19.1.12/19.1.9. Actual commit tests use react-test-renderer 19.1.1 and its types
19.1.0. The strict declaration graph requires `ws` 8.18.3 and `@types/ws` 8.5.4:
the later 8.5.14/8.18.x ESM default class declarations omit namespace aliases
used by this tRPC server's published declarations. No declaration shim or
`skipLibCheck` suppression is used. The stack integration owner declares these
dependencies at this layer.

## Conversation and original ownership

`RetainedWorkspace` has one map from exact logical scope to `SessionEntry`.
An entry alone owns session projections, history, interactions, draft, persistent
pin and original handles. There is no second plugin workspace or React store.
`SessionFeed` is structural: real typed router adapters supply ordered session,
history and interaction observations, explicit baseline/older reads, dispatch and
exact original lookup. Authorization and native policy remain with the Host and
transport; client display state grants no additional authority.

One injected `ObservationConnector` owns observational reconnection. Entry feeds
are shared across committed views, and pinned entries keep their observations
without viewers. Unmount releases only that view. Interrupted observations keep
retained evidence and report unavailability. The connector may reopen observations
with a fresh target; it never invokes dispatch. Release seals callbacks before
returning and retains its actual cleanup promise before entry eviction.

`ClientPersistence.save` must durably commit the exact immutable entry before
dispatch. This is an injected persistence contract, not a claim that the scripted
test store is physically durable. IDs, payloads and captured runs remain unchanged.
Restoring uncertain originals never dispatches them. Unknown outcomes use only
the exact Host-original read; null/missing receipts do not establish nonexecution.
A persistence failure before forwarding retains the draft and local failure,
without sending. Host permanent ID/hash deduplication remains authoritative after
recent client metadata leaves RAM.

Ordinary commands require fresh, running, exact native-run evidence. Stop has a
separate shape: its payload always carries explicit logical generation, including
zero before native identity exists, while `run` may be null. It does not fabricate
a native ID. Unavailable/opening state cannot consume Stop's reserved admission
slot through ordinary pressure. A stopped conversation's historical RunRef is
not permission to Send.

`submitDraft` captures the entry's existing draft-intent revision. Once the
original is locally durably admitted, it clears that exact unchanged draft before
forwarding. Edits made during persistence remain, even if their text happens to
match an earlier draft. The initiating view follows latest at admission without
waiting for a reply. A newer gesture, view release/switch or native generation
change fences that presentation callback; it never cancels the original.
Ordinary `submit` does not assume that its command came from the current draft.

Optimistic user text remains visibly local. A Send receipt proves operation
acceptance, not native transcript capture or turn completion. `nativeConfirmed`
changes only after a positive user history row carries the exact original ID and
matching run; text similarity supplies no proof.

## History and viewport

The entry applies immutable frames through `applyFrame`. Its one bounded retained
page projection uses `mergeHistoryOrder` and explicit commit placement. It does
not guess order from IDs or timestamps. A replacement snapshot without an ordering
anchor drops the old view cut and keeps omission evidence; a positively new
capture/generation establishes its own cut. Retained row origins remain explicit,
and weaker resident bodies cannot overwrite complete terminal retained evidence.
Bounds are prepared atomically, so an overlarge protected frame cannot partially
rewrite the visible projection.

Each `SessionView` alone owns its `AnchorController`. The React
`useTranscriptViewport` hook measures real row rectangles and observes both the
scroll container and complete content wrapper. Wheel/touch/keyboard intent
interrupts alignment before geometry growth. Prepend/resize/expansion restores
the retained physical row offset; follow mode aligns after paint and again after
geometry changes. There are no estimated row heights or another viewport store.
An initially short transcript may mathematically require a negative scroll offset
after prepend: preserve the browser's clamp and the visible physical anchor,
without inventing spacers. Native `scrollend` or bounded measured paint stability
ends a gesture; the fallback also runs when supported `scrollend` has no motion
to report. End/Control+End outside editable fields explicitly returns to latest.
A no-motion PageDown/wheel retains reading intent and releases the temporary
manual latch, so subsequent measured geometry can restore its exact anchor.
A later receipt cannot take the reader back to the
bottom; only valid admission or explicit follow changes that intent.

`useSessionView` uses `useSyncExternalStore` and a committed effect lease.
StrictMode release/reacquisition preserves the entry. The viewport hook returns
`scrollerRef`, `contentRef`, snapshot and intent. Rendered rows expose their exact
IDs as `data-history-row`. Do not also acquire a duplicate hook lease for the same
viewport. DOM paint, touch/scroll geometry and mobile containment still require
the actual PR16/21 browser oracle; the renderer/SSR tests qualify commit ownership.

## Bounds and cleanup

Defaults are 32 entries, 64 committed views, 64 listeners per entry, 64 KiB drafts,
128 unresolved originals plus one reserved Stop and 4 MiB unresolved request data
plus Stop headroom. Requests are at most 64 KiB; 32 recent terminal originals add
at most 2 MiB. History retains at most 512 rows/2 MiB, independent of the current
Host window. These byte maxima can be lowered. Recent terminal metadata rolls;
unknown originals do not silently expire. Old handles only observe their original.

Eviction requires an unpinned, unviewed entry with no draft, unresolved original,
active read/dispatch, persistence write or unsettled observer cleanup. This is
client resource idleness, not proof that the native agent stopped. Draft pressure
refuses a new entry instead of discarding unsent text. Workspace close performs
observation cleanup only and refuses outstanding actual calls; it sends no native
Stop and owns no hidden retry.

## Evidence

This is a replacement client, not a restoration of the former layered
Gateway/Session/History/interaction client maps. The sound ordering algorithm is
reused through PR07's explicit entry; its source provenance remains in that note.
No previous native/browser campaign is counted as new qualification here.

The original pre-F08 checkpoint passed focused strict TypeScript and fourteen
owner/type/actual React tests,
covering shared two-view feeds, switching/pins/drafts, persistence-before-dispatch,
receipt loss and exact reconciliation, restored unknowns, gesture/unmount/run
fences, optimistic-vs-native evidence, Stop reserve/pre-binding Stop, rolling
terminal activity, actual cleanup, older ordering and atomic history pressure,
real typed tRPC absence/null/void/abort and cross-harness negative checks, and
inert SSR/StrictMode committed leases. The first history harness used raw object
serialization as a fixture lookup key; replacing it with the logical identity
tuple corrected that fixture error. No weaker product oracle was adopted.

That checkpoint included a framework procedure-client wrapper suite, now deleted
in F08 together with its implementation. Its unique auth/routing, exact-original,
cancellation and observation-recovery invariants remain at the actual HTTP,
Reference and Catalog composition owners. Official tRPC serialization and link
behavior are not maintained as another framework wrapper test suite. Current
retained-owner cases live in `test/client/{workspace,history,contracts}.test.ts`
and `test/react/hooks.test.ts`; the historical count above does not claim that
the amended sources were rerun.

No native/model/provider, network, installed state or service was used. Physical
browser persistence, complete DOM geometry, mobile gestures, the real reconnect
supervisor and cold stopped-reader integration remain separately qualified later
boundaries. No native completion, Stop or successful end-to-end outage is inferred
from these controlled ports.

Adapter integration removes a vendor-specific root-stream assumption: frames must
match the selected RunRef, while the trusted SessionFeed selects the adapter's
actual root HistoryScope. Copilot names its root `root`; Codex uses the native
thread ID. No identity is rewritten. The history reducer still enforces exact
scope/generation/attachment and replacement snapshots. Native scope is not a
vendor-global string convention.

## Contract boundary refinement

The feature root declares structural read, draft, original lookup, anchor and
view capabilities in `contracts.ts`; retained entry/view/workspace code lives in
`internal/`, and React subscriptions and DOM effects live in `react/client/`.
Consumers no longer import concrete retained entries or private residency and
close controls. `SessionView` and `SessionEntry` are capability aliases, not
classes. The portable UI declaration graph uses these structural capabilities;
actual typed tRPC clients are supplied by application composition. The former
procedure-client contract leaf is removed with its wrapper.

A `TranscriptViewPort` supplies stable derived snapshots and read/scroll intent
without draft, Send, Stop or fabricated root session state. Root and native child
views use the same renderer and viewport ownership. The projection references
the existing retained history; it creates no additional transcript store. New
compile oracles reject calls beyond each borrowed capability, and a runtime
oracle proves stable snapshots and inert structural construction.

The shared contract-refinement gate passes strict compilation, owned ESLint and
44 focused tests, with one explicit published-network skip and no failures or
cancellations. It covers the retained client, actual React components, real
filesystem uploads, child views and loopback tRPC transport. This is source and
scripted composition evidence; no vendor, model, live relay, installed service
or full browser acceptance claim is added.

Structural ports may use ordinary receiver-dependent class methods. Each React
store hook memoizes bindings to its exact borrowed entry, anchor or transcript;
callers need not use arrow fields. A real React regression case fails against
the previous unbound hooks and proves SSR remains inert, all three distinct
receivers update, rerenders retain subscriptions, and unmount releases every
subscription and committed lease.

## F08 — Actual tRPC boundary

The generic procedure client/link and their public contract leaf are removed.
Consumers compose official tRPC clients and links directly; there is no framework
HTTP client/link factory. Retained state, drafts, view residency and scroll
anchors keep their owners when routing or the supplied client changes. Business
authentication/routing, lost-original, independent cancellation and recovery
coverage belongs to actual HTTP/Reference/Catalog tests, while tRPC owns its
wire and type inference. Earlier source, React and browser results above remain
evidence of their recorded snapshots; this contract amendment adds no renewed
qualification claim.
