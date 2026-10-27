# V8 embeddable React chat

A conversation surface for any authenticated Gateway-capable application. The
component renders one already prepared `WorkspaceView`; the surrounding
application owns account selection, Gateway construction, session creation and
navigation. A single developer build can compose this source directly.

```tsx
import { MultiplexChat, lightChatTheme } from './src/index.js';
// For a composed browser build, include the generated/scoped chat.css.
import './.build/browser/chat.css';

// Prepare outside React render using the authenticated retained workspace.
const view = await workspace.open(sessionId);
// The same retained workspace serves the full application and embedded panels.
<MultiplexChat view={view} />;
<MultiplexChat view={sideView} header={false}
  theme={{ ...lightChatTheme, accent: '#315e91' }} />;
```

`showMcp={false}` hides tool connections inside Session tools when the embedding shell
provides its own panel. MCP reads and refresh remain owned by the existing
workspace; opening a disclosure performs no discovery.

The container supplies width and a definite usable height (at least 300px for
normal composition). The chat uses container queries; phone controls and short
landscape remain available. Styles have no body/root reset, ambient font load or
application shell selectors. Set `--mpx-chat-*` CSS variables on any enclosing
scope or pass `theme`; font and mono tokens inherit ordinary font stacks.
`header={false}` leaves native state and pending confirmation visible. A shell can supply
`title` (React content), `subtitle`, `headerLeading` and `headerActions` to compose its
back/navigation and contextual actions into the single shared header. Native lifetime,
work and connection freshness are presented once: a finished turn can still have a
running agent, and an outage marks observed facts stale rather than claiming Stop.

`useAgent(view)` acquires exactly one lease after React commit. SSR, render and
selection perform no discovery, native body read or mutation. Unmount releases
that lease and an exact acquired preview capability, never the session, draft,
Send preparation, pins, history or original receipts. Separate embeds should
receive separate `workspace.view(sessionId, viewKey)` facades when they need
independent scroll anchors and expansion state.

Conversation, composer, files, confirmations, native activity and settings are
read directly from the retained workspace snapshot. The prepared view also binds
file, preview, receipt and history actions to that same owner; the component has
no independent workspace input. A changed prepared view replaces the transient visual boundary,
even when the next account uses the same human session ID. Only transient visual
choices, committed resource leases and DOM geometry live in React state. There
is no second reconnect scheduler, session store, receipt queue or history cache.
No automatic history fetch occurs on scroll, resize, mount or reconnect.
The transcript top offers `Load earlier history` for an available cursor and
`Check earlier history` for an unknown boundary, including compaction. A proved
end says `Start of available history`, without claiming gap-free coverage.
Root and read-only child views share this explicit read presentation. The
existing viewport owns follow/reading intent and anchors; the DOM adapter
settles user gestures before restoring geometry and observes boundary, row and
footer size changes. Explicit earlier-history actions capture the visible row
and enter reading mode before dispatch; an empty initial check retains follow
mode. Page prepend, touch/keyboard/scrollbar input, expansion and session switches
preserve the reading anchor within the available scroll range. When the original
content fits the viewport, prepend may move its first row down because the
browser cannot scroll beyond the content's end; no trailing spacer is invented,
and the loaded earlier rows remain reachable above it. A canonical Host capture
gap surfaces a notice even while the transport remains connected.
The working indicator requires fresh native and current-history work evidence.
Incomplete capture remains inspectable; an old running row alone never starts
a loader. Missing-final decoration is omitted only for a proved current turn.
An admitted composer action follows once in its initiating view. A newer gesture
or an unmounted chat suppresses that follow, including during attachment
preparation; later receipts never change reading intent.
Clearing a tall draft can enlarge the transcript and make the browser clamp its
old bottom. That automatic clamp and unchanged scroll notifications report
geometry without cancelling follow. The later native user row and streamed
response therefore stay visible; genuine reading gestures still take precedence.

Per-Host write controls consume the workspace's derived `access` projection,
separate from observed native capabilities. Native control, answer submission,
file writes and MCP discovery remain independently granted. Read-only viewers
retain history, receipt observation and local intent without creating denied
originals. The composer uses derived `draftActions` admission plus composer/preparation facts
and checks the current snapshot on click. Idle primary/Enter uses Send; working
primary/Enter uses Steer; Queue is an explicit menu action. Every action uses the
same retained `submitDraft` preparation, attachments and exact original. There is
no fallback between actions. Running/Connected alone is insufficient.

Codex `agentMessage.questions` remain optional inline callouts. Choosing an
option or Write a reply appends `Regarding: <question>` and the chosen answer
to the existing retained draft, preserving attachments and settings, then
focuses the composer. It sends nothing until the user invokes ordinary
Send/Steer. No question is inferred from Markdown prose. Child/archived and
read-only surfaces display the metadata without reply controls. Only an exact
complete duplicate of native's question fallback text is hidden in presentation;
the original history body and any different surrounding prose are retained.
These callouts have no pending native callback and never block agent work.

Codex and Copilot controls retain their actual discriminated native methods.
Choices for the next Send remain distinct from observed native settings and
separately acknowledged defaults. Stop uses the existing full-Stop original and
never turns a transport outage or a button click into proof of native Stop.
Native requests appear individually at the end of the transcript. Questions and
Copilot plan review expand inline; permissions and MCP verification require an
explicit scoped dialog. Selecting, collapsing or dismissing never answers a
request. Private form handles are acquired after commit and retain unfinished
answers across views; values never enter composite snapshots. Offered choices
and optional native descriptions stay distinct from the answer payload. Field
errors use the same primitive form validation as native dispatch. Every response
retains its exact original; an unknown response offers receipt lookup without
resubmission. Unknown/refused actions remain prominent, with Stop uncertainty given priority;
successful receipts recede into Activity inside Session tools.
Independent Send and answer owners do not prove a combined chronological order.
Acknowledgement is not described as completed agent work.

The composer exposes model, mode and reasoning directly at wider chat widths;
compact chats disclose them in Agent settings. A committed, connected view automatically
acquires unobserved model/reasoning metadata through the existing retained catalog
job. StrictMode, simultaneous views and remount share that same job and result.
Search and picker opening do not read again. A failed observation retains the current
value and draft; an explicit Retry stays in that same owner without a retry loop.
Permissions, defaults and current-turn native mutations live in
Advanced settings.
The current reasoning value remains visible while choices load or are unavailable.
Changing model preserves the exact selected effort, including an effort that the
new model does not offer, until the user explicitly chooses another effort.
Observed settings remain separate from retained intent; changes during work say
Next turn and are not silently applied by Steer or Queue. Native metadata remains
an observation, not an attachment-acceptance promise. Popovers overlay history;
opening them and receipt settlement do not displace the composer.

Current-message attachments appear as compact chips. File and camera selection
share one menu; the retained session file library is behind Files in Session tools.
The multiline text input sits above one compact settings/action toolbar, with
attachments beneath only when selected. History, settings and composer share
the same centered 780px content measure and responsive gutters. Routine draft persistence is
silent; storage failure remains visible and pauses submission. Phone actions
retain accessible labels and 44px targets without adding a second toolbar row.
Tool connections, native maintenance actions and child histories stay in that
same secondary surface. Earlier-history actions are at the conversation top.
Captured activity starts
collapsed, including running/failed rows; users can expand and collapse it, and
terminal output has bounded scrolling. Native lifecycle/body evidence is unchanged.

Archive appears only on a positively Stopped session and uses its existing
retained original. The Host's seal replaces controls with retained history and
receipts. Native cleanup completion and Catalog publication remain separate;
an explicit listing-update action retries only exact proof publication. Archived
views never fetch older history or reacquire file/native resources. Loaded text,
scroll anchors and expansions remain usable. Cold saved metadata browsing is
provided by the application; this component does not reopen archived native
history to manufacture a transcript.

Markdown is interpreted as structured text with raw HTML disabled. File/image
previews use the existing verified ResourceCache leases; native disk paths and
Markdown images are not fetched as arbitrary URLs. Explicit uploads use existing
file/composer ownership; user SVG conversion uses the existing browser helper. File picker, file drop and
clipboard images all enter that same explicit upload/composer boundary.

Local Markdown file links capture on activation; local/native images acquire
only near the viewport, with fixed thumbnail geometry outside folded tools. A stable
source key identifies the exact streamed occurrence and requested path; the Host
rechecks native cwd/root policy and retains its immutable first snapshot.
`view.captureFile` delegates that existing file owner, then the existing
ResourceCache transfers and verifies the bytes. Relative document references
resolve beside the opened native path and return through that same owner.
Closing, selection, account disposal and late completions release visual leases.
No preview path gains filesystem authority or becomes a browser `file:` URL.

Child references carry the exact history scope; the Host resolves their trusted
native cwd instead of borrowing the parent's. Browser links preserve encoded
paths, line/fragment intent and normal modified-click navigation through an
authenticated address. Nested documents have bounded Back navigation.

Text/Markdown render escaped structured content, with complete source and a
bounded rendered view side by side (tabs at narrow widths). Self-contained HTML
uses an explicit authenticated representation URL inside `sandbox="allow-scripts"`.
The response verifies the immutable bytes before serving and supplies a CSP
allowing inline script/style while denying parent privileges, network APIs,
external resources, forms and child frames. There is no application API bridge
or linked-resource crawler. A consumer without that route exposes the download.
Images and completed Mermaid diagrams share expanded fit/zoom/pan/pinch viewers.
PDF.js 6.3.289 receives verified byte copies and one owned module Worker.
Continuous pages are virtualized with 8 million pixels per page and 24 million
across visible canvases, plus escaped optional page text. PDF actions,
scripts, annotations, XFA/forms and document URLs are never exposed. Only the
fixed same-origin published worker/font/CMap closure can load. Unsupported,
password-protected, invalid or timed-out documents retain the exact download.

`fileAddress(file)` optionally returns an authenticated same-origin navigation
URL for Open/Copy address; the surrounding server must reauthorize each request.
The viewer rejects remote/credential-bearing URLs. Copy path and verified-byte
download remain available without such a route. Resource URLs are not authority.

The Agent histories surface receives the Host's proved scope inventory on the
existing root history stream. Metadata refresh is an explicit exception; opening
the disclosure performs no query. Opening a listed child mounts a read-only
facade over the same retained HistoryWorkspace. Its own rows, pages, anchors and
history-connection facts never replace the main conversation. The modal has no
composer, control methods, native callback form or session mutation authority.
Closing it releases its observation lease while keeping loaded rows/pages.
Older and missing-history reads remain explicit; selection, mount and reconnect
never fetch native transcript bodies. A changed native binding fences the view
and preserves stale loaded rows until auth disposal. Raw native metadata and
delegation text cannot create a selectable scope. Native names and status sit
next to the exact accessible `View agent <native ID>` selector. Model labels
separate Requested, Configured, Resolved at start, First dispatched and Completion
reported. Missing facts stay unavailable. A positive root native-tree Stop
replaces a previously running child display with Stopped; an outage does not.

The browser build emits `index.js`, `chat.css`, fonts and the isolated diagram
renderer under `.build/browser`. Its React and ReactDOM peers remain external.
When bundling this module into another application, emit the diagram asset and
pass `assets={{diagramRendererUrl: '/your-static/mermaid-frame.js'}}`; the exact
asset and sandbox policy are described beside the renderer. `build/styles.mjs` exports `buildChatStyles({outdir})` for an
application build that needs the same scoped math styles and font closure. When the embedding application uses a nonce-based parent script CSP, pass its
trusted per-response nonce as `assets.cspNonce`; chat content cannot select it.
Emit `build/pdf-assets.mjs`'s `buildPdfAssets({outdir})` closure beside
the bundle, or select its trusted same-origin directory through
`assets.pdfResourceBaseUrl`. Parent CSP must allow `worker-src 'self'` and
`frame-src 'self'`. The explicit HTML representation owns its isolated script
policy; the parent retains its ordinary policy. Emitted PDF font/CMap
license documents join the build-owned notice companion.
No native or model
execution is part of this module's checks.

Focused qualification runs the real retained workspace with scripted ports and
actual React/SSR/StrictMode/Chromium. It covers inert rendering, simultaneous
themed embeds, commit lease counts, pin/switch/unmount preservation, explicit
older reads, private native callbacks, modal focus restoration, disposal and six
viewport sizes. The integration owner qualifies actual Gateway/application
composition separately. Parent protocol-generation release gates are not
implied by this isolated source module.

## Presentation parity and limits

| Surface | This module | Boundary |
| --- | --- | --- |
| Theme, message measure, composer | Retained sage/graphite palette; scoped light/custom tokens; container responsive | Application shell/fleet/navigation belongs to the consumer |
| Rich transcript | Markdown/GFM, code, math and sandboxed diagrams; native body completeness remains visible | No raw HTML, arbitrary Markdown image fetch or untrusted native-file navigation; diagram artifacts keep their fixed dark backdrop across light/dark hosts |
| Native controls | Actual Codex/Copilot selections, defaults, native lifetime controls, steering, queue/task/goal actions | Capability absence hides unsupported methods; no host-type casting |
| Files and images | Picker/drop/paste, immutable local-link captures, inline images, source/render Markdown, sandboxed interactive HTML, continuous bounded PDF, image/diagram zoom and exact downloads | Existing file owner admits every reference; authenticated Open/Copy and HTML require the consumer's server route. Unsupported/encrypted documents download unchanged |
| Prompts and MCP | Rich private native forms in Radix modal; passive per-host tool facts and explicit refresh | No fake MCP management/login mutation where original-command API is absent |
| History and scrolling | Existing streaming/view/anchor/expansion owner; explicit older/gap exceptions | Loaded rows remain bounded by the retained history owner's limits; real row layout avoids estimated-height changes on remount. No second virtual list or paging scheduler |
| Terminal | Streamed tool/terminal output and native background-terminal controls | Interactive native TUI/PTY attachment is retired; no chat hook or slash action opens it |
| Subagents | Bounded Host-proved inventory on the root stream; native names/status/model provenance; read-only Codex/Copilot child transcript with retained pages/anchors and separate stream health | Cold child discovery remains separate. Unobserved metadata is unavailable; stale entries cannot authorize a current scope; no parent control is inferred |
| Composer commands | Explicit Send and supported native actions | Slash-command/path autocomplete needs an admitted typed discovery API; no filesystem scan or command parser in presentation |

Goal, task and queue presentation stays in three pure host-specific components:
`native-goal.ts`, `native-tasks.ts` and `native-queue.ts`. They render the existing
retained `nativeReads`; mounting, switching sessions and rendering perform no
reads. `native-actions.ts` composes task/queue inspection with compaction, Continue,
MCP and native background-terminal controls. The actual chat presents goal status
as one compact trigger for its on-demand retained editor; draft steering and
queueing remain in the one composer. The small shared observation label
distinguishes current, refreshing, unavailable and retained stale facts.

Codex goals show all native status labels and token/time usage. A dedicated
retained objective/budget editor survives session switches without consuming
the message draft or its files. Blank budget selects the native default; zero
and invalid budgets refuse before submission. The original command owns
settlement, so an acknowledgement never rewrites the displayed native goal.
Completed current root plans expose an explicit Implement plan action over the
existing Send owner. The selected body and default collaboration are captured
once; child/prior-run rows and repeated originals cannot submit it again.
Copilot queues distinguish the native in-flight steering prefix from
waiting steering text and queued entries. Selected-item mutation buttons need
a fresh corresponding read; explicit Refresh remains the exception path.

Copilot task views preserve native display name, description, type, execution
mode, timing, command/PID and bounded error/response/result text. Requested
model override and runtime-resolved model are labelled separately; neither is
provider-response proof. Missing agent models say Not reported. Agent result
text is at most 8 KiB with an ellipsis; opaque client-owner result JSON, native
prompts, log paths, provider settings and ownership capsules are not forwarded.
Progress keeps agent intent and activity together, shell output, and client
phase/percentage/message/activity. A positive root Stop makes retained active
tasks display Agent stopped beside their last observed state; this does not
certify cancellation of an external client-owned task. Disconnect alone never
produces that parent-lifetime fact.

The former presentation discarded task metadata and steering bodies, and used
one null-coalescing progress expression that hid activity behind an intent.
The bounded replacement adds no task store, polling, React observation copy or
new command framework. `node qualification/native-actions-check.mjs` uses an
isolated strict emit, the actual concrete adapter with scripted SDK-shaped RPC,
retained-read/SSR oracles and a mounted Chromium goal/task/queue journey. Native
SDK processes, provider calls and production acceptance remain separate.

These deferred API surfaces remain visible integration work. They are not
silently described as full legacy application parity.

Keep the emitted `THIRD_PARTY_LICENSES.txt` and `THIRD_PARTY_COMPONENTS.json`
with distributed assets. `buildChatNotices({outdir, metafiles})` in
`build/notices.mjs` derives these companions from the actual bundled
inputs, including math font notices and the diagram engine's source locator.

The shared `./ui` React submodule exports the shadcn-derived presentation controls.
Use the generated `./ui.css` for standalone controls, or `./chat.css` for the full
chat plus those controls. Run the UI build before consuming these exports;
application builders may call `buildChatStyles({outdir})` directly. Raw source
CSS is an input, not a complete public stylesheet. Dialogs and popovers require an
explicit themed container. Select resolves its mounted wrapper to the nearest
explicit dialog or themed scope. Options stay inside that theme/native-dialog top
layer and outside any implicit label, preventing native label activation from
reopening a touch choice.
Its controlled API is `value`, `onValueChange` and
`options: {value, label, disabled?}[]`; every string, including an empty keep/unset
value, retains its domain meaning. The trigger ref is an `HTMLButtonElement`,
and raw domain values are exposed as `data-value` on triggers and options.
Generic viewport geometry uses `--mpx-ui-visible-height` when an embedding
application supplies it.
