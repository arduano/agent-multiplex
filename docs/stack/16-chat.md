# 16 — Embeddable conversation UI

`src/chat/index.ts` is a browser-only React presentation entry. It consumes the
actual15 `SessionView`, `SessionEntry` and `useTranscriptViewport`; there is no
second conversation store, reconnect loop or command queue. The consumer imports
the accompanying `chat/styles.css`, gives the embed a real width/height, and
supplies typed command preparation and callback operations. Rendering and SSR
perform no acquisition, model call, command, persistence or observation setup.

## Consumer boundary

`Chat({view, actions, title?, theme?, readOnly?, controls?, advancedControls?,
files?, media?, markdownFiles?, renderDiagram?})` embeds the complete conversation.
`controls(snapshot)` and `advancedControls(snapshot)` are static React slots for
the consumer's real typed adapter controls. They do not imply a universal vendor
settings union. `SessionList` reads retained entries without acquiring background
network leases. `ThemeScope` styles a standalone list or shared controls. Session
selection stays with the application; switching cannot discard the retained
draft, originals, history, pin or view's independent scroll intent.

`actions.draft(text,snapshot)` returns the consumer's exact `Command`, including
ID/run/payload/optimisticText. Chat invokes `view.submitDraft` only on an explicit
Send/Enter gesture; the owner clears an unchanged draft at durable admission,
before dispatch. A new edit during persistence survives. A view follows then,
never after ACK. Validation failure preserves the draft/reading position. Busy
admission is guarded synchronously against duplicate gestures. Stop is a separate
consumer command; stale observations do not disable the explicit Stop route.
The retained owner still applies original identity, capacity and exact receipts.
Unknown commands expose **Check original**, never a mutation retry.

`actions.respond(reference,answer)` receives the original callback incarnation,
attachment and run. The consumer must delegate to the actual interaction owner.
Nine forms preserve offered IDs/labels, scoped permissions, Copilot plan actions,
per-question extra information and typed missing/empty/false/zero distinctions.
The same09 validators associate schema errors with their fields and validate
every final answer. All pending requests remain individually selectable; their
unsent edits survive switching/closing a popup. Submitted/unknown is never native
confirmation, and an uncertain response is locked rather than retried. Unmount
does not deny/cancel. Security/permission/verification forms use scoped dialogs;
questions and Copilot plan acceptance are inline. Verification URLs are acquired
only by exact reference after a gesture, checked against the public origin and
opened in that gesture's isolated tab. The consumer remains responsible for its
real adapter verification authority and exact original observation.

Native completed-plan presentation requires a complete completed assistant plan,
fresh current run/history and matching authoritative current origin. A root
stream is not required to equal its native session ID; the feed and consumer
policy prove the actual root binding. The injected
`implementPlan.available/invoke` additionally owns the real mode, busy guard and
command meaning. An arbitrary Markdown `proposed_plan` is display-only and never
grants this affordance. Recorded structured optional question choices edit the
existing draft without Send; no bullet/prose heuristic creates native actions.

## Geometry, appearance and evidence

Rows expose exact `data-history-row` IDs to15's real geometry hook. One scroller
contains the history boundary, rows, requests and Working footer. Older reads
enter reading intent synchronously before the owner's read. The existing hook
handles ResizeObserver/after-paint alignment and user gesture fencing; no fixed
row-height estimate, content-visibility approximation or second viewport owner
is introduced. Previews have fixed thumbnail slots. A physical short transcript
keeps the existing feasible/clamped anchor; it does not fabricate a spacer.

Scoped light/dark CSS variables,44px narrow-embed controls, autosizing composer,
matching transcript/composer width and an advanced-settings dialog provide the
responsive presentation. Shared Select uses Radix, encodes every domain value
injectively (including real empty string), and renders themed options. Its
hidden Radix form bridge is not a visible native select. Dialogs/selects portal
only inside their actual embed/nearest dialog; labels are explicit, and no
document.body theme fallback or global registry exists. Radix owns keyboard,
focus and popup mechanics; those require21's actual browser gate below.

Fresh native Working is independent of capture completeness. Per-row streaming
and active compaction require stricter current-origin/turn/history proof without
capture/identity loss. A positive completed compaction metadata fact is required
for **Context compacted**; stale/unconfirmed observations stay static. Native
errors keep their real bodies. Partial messages/tools retain actual excerpt bytes
and exact missing categories in a disclosure. An empty partial tool says its
output was not captured once. Undated capture-loss evidence remains visible with
time-neutral wording; this layer never clears a gap or infers final content.

## Rich content and resource ownership

Markdown uses pinned react-markdown10.1.0/remark-gfm4.0.1 with raw HTML disabled.
Only explicit http/https/mailto or fragment links navigate; credentials, private
paths and other schemes do not. Remote images remain deliberate external links.
`markdownFiles` is an explicit map of authorized08 preview descriptors, not a
path parser or file capture operation. `media(row)` supplies actual authorized
native/tool media outside collapsed output.21 must compose this adapter hook.

`FileReadPort` is the only byte boundary. Image thumbnails acquire lazily while
visible, PDF/download after opening; each acquisition reads at most16MiB in256KiB
chunks and releases its exact lease on success/error/late unmount. Owned blob URLs
are revoked when offscreen/closed/unmounted. Archive removes file presentation;
late leases still release and cannot publish new URLs. Unknown/failed release
remains with the actual file owner; UI teardown does not claim retirement.
Images provide zoom/focal/pan/pinch controls. Text preserves the complete supplied
source.08 HTML descriptors render in an opaque sandbox with restrictive CSP;
this intentionally does not restore the old interactive-HTML policy. PDF uses
the browser's native PDF frame plus download, not a second PDF document/cache.
Downloads use an inert octet-stream blob so modified navigation cannot execute
captured HTML/SVG in the application origin. Mermaid requires an explicit strict
renderer returning a releasable image URL; there is no inline SVG/HTML injection.
21 supplies/qualifies a real renderer rather than a fabricated diagram fixture.

## Provenance and checks

The architecture uses the new07/08/09/15 owners. Scoped token/spacing and empty
Select encoding choices were reviewed against reference61d90fd's
`primitives/v8-react-ui/src/ui/{styles.css,select.tsx}`. They are selectively
authored around Radix primitives, not imports from the old client or a sibling
checkout. Earlier hidden-popup SSR expectations and native-select assumptions
are retired: closed popup content is not force-mounted to satisfy a test.

Focused strict compile: TypeScript5.9.2, NodeNext, ES2023/DOM, react-jsx,
strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes, no skipLibCheck.
The selected `test/chat/{chat,rendering}.test.ts` exercise actual SSR and React
components against retained owners: inert render, one durable Send before ACK,
new draft/failed validation, exact nine forms and field errors, independent
request edits, complete native plan one Send, Stop under unavailable observations,
partial/error/compaction provenance, scoped bounded file read/release and
archive/late acquisition. React's test-renderer deprecation remains reported.
No DOM/keyboard/visual correctness is inferred from that renderer's timer-only
Select host. SSR runs separately from mounted renderer cases.

**Remaining qualification:**21 must exercise actual desktop/mobile containment,
Select keyboard/typeahead/Escape/touch, nested focus, measured scroll/prepend/
stream races, focal pinch, image and native PDF behavior, real strict Mermaid,
and backend media composition. No native/model/platform/browser acceptance is
claimed by this source layer. Cold stopped native reader admission is still the
Host/adapter responsibility documented in07/10/11.

## Contract boundary refinement

Public component props, Select options, form values and the session-list read
capability are declared in `chat/contracts.ts`; JSX implementation lives in
`chat/client/`. Session lists borrow summary reads rather than root conversation
mutation controls. Root `Chat` retains its ergonomic view/action interface.

`ReadonlyTranscript` renders the same row, coverage, loading and viewport
components directly from `TranscriptViewPort`. It exposes no composer, Send,
Stop, native plan action or callback response authority. Native children therefore
need no invented root SessionState or draft owner. Tests retain actual observer
cleanup checks; assertions against private `viewCount` are retired because
residency is implementation detail rather than UI capability.

The shared contract-refinement gate passes strict compilation, owned ESLint and
44 focused tests, with one explicit published-network skip and no failures or
cancellations. It covers the retained client, actual React components, real
filesystem uploads, child views and loopback tRPC transport. This is source and
scripted composition evidence; no vendor, model, live relay, installed service
or full browser acceptance claim is added.
