# 11 — Copilot native adapter

The adapter keeps Copilot's actual controls, queue, background tasks and callback
semantics behind one Host lifecycle owner. It does not translate them into Codex
commands. Its browser entry exports schemas and DTOs; its explicit Node entry
exports the native factory, typed Host router and injected SDK/media/input ports.
Construction is inert. The factory's default transport uses the actual published
`@github/copilot-sdk` **1.0.19**, whose CLI pin is **1.0.95**. The runtime verifies
both package metadata and the CLI status before opening a session. A package
build is not proof that those binaries have run successfully.

## Contract and ownership

| Surface            | Actual contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creation/reopening | A parked runtime allocation owns the process tree before launch. Allocation references use the runtime's canonical OpeningRef bytes. Invalid selection, unsupported SDK-open effort reset and same-scope pending cleanup refuse before allocating. Positive native session identity is committed immediately through `commitBinding(run)` before subsequent settings RPCs. Explicit Reopen alone invokes SDK Resume with pending-work continuation; passive history never does. Resume accepts model/reasoning, but this SDK exposes mode/permission changes only after binding: atomic mode/permission override before continuation is not claimed. Reopen reports actual native settings rather than pretending requested defaults were applied. An explicit mode/permission override differing from positive prior selection (or whose prior field is unknown) refuses before allocation. Unchanged controls and model/reasoning changes remain supported; null reasoning reset requires the live model RPC, not SDK Create/Resume. |
| Selection          | Actual current model, native provider ID, reasoning effort, mode and permission mode come from SDK reads. Missing mode/permission observations cannot become defaults. Model changes require available models; plan-mode configuration retains the selected model. Applied, deferred, confirmation-required and merely submitted results remain distinct.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Provider policy    | Provider configuration and environment are private static composition. Copilot-only can be required; an incompatible profile is rejected. Empty provider configuration is omitted, preserving the Copilot route. An explicit BYOK profile requires its own model catalog. No retry or alternate provider is selected by this adapter. Native provider ID is observed separately from the composition's policy label.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Send/steer         | Send uses native enqueue; steer uses immediate delivery. The returned native message ID acknowledges admission, not completion. Opaque file IDs require an injected input preparer. Its lease survives ACK until matching native consumption followed by session idle, or positive Stop. Stop wins a late preparer result without dispatching a message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Abort/Stop         | Abort acknowledges a turn interrupt. Stop proves the exact runtime-owned tree is retired. Positive native Stop is returned even while independent SDK/input/media cleanup remains pending; readiness remains false until actual cleanup finishes. No idle or connection error proves Stop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Tasks/queue        | Pending messages, steering messages, queue promotion, task list/progress/current-promotable task, cancel and background promotion use the actual RPCs. Requested and resolved task models remain distinct. Public task metadata excludes detached log paths and process IDs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Compact            | Manual native compaction returns success and counts. The private transcript summary is not copied into an operation receipt. Native compaction events become ordinary history notices.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| MCP                | Configured status is a passive read; it does not start every MCP server. Restart and HTTP/SSE OAuth login are explicit original commands. Login uses in-memory credentials and refuses persistent scope. Full authorization URLs have bounded private exact-original lookup; they do not enter receipts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Callbacks          | Permission events retain exact request and child ownership. Their actual reply RPC can confirm acceptance. SDK question, plan and elicitation closures acknowledge submission only. A resolved JS callback is not fabricated native confirmation. Additional question information is preserved in the native answer. The typed answer command forwards the exact admitted Original/hash into the existing structural CallbackDispatcher; absence refuses, uncertain delivery remains unknown, and no new journal or fabricated confirmation is added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Unsupported        | There is no atomic idle Continue primitive in this pinned SDK, so no generic Continue command is advertised. Codex goals/permission objects cannot type-check as Copilot commands.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

The lifecycle owns originals and allocation custody; the adapter owns its actual
SDK clients, event attachment, input holds and auxiliary promises. It creates no
second journal, transcript store, reconnect loop or native effect retry. Idle
passive readers can be closed by lifecycle disposal. A failed cleanup is retained
as unproved custody rather than cached as successful close. An acquisition whose
cleanup fails remains visibly unready; this layer does not invent a process
adoption or recovery service.

## History and callback boundaries

Live events feed one bounded HistoryWindow per proved stream. Root and child row
identities differ even when vendors reuse a message/tool ID. Child identity comes from the actual session-owned native agentId envelope; a
start event additionally proves task lineage. Contradictory identity produces a
capture gap. A mid-child attachment has an unproved earlier boundary. Root idle never invents child completion. The
SDK's `assistant.idle` and session/global activity are not treated as native Stop.
Actual session activity comes from `metadata.activity`.

The SDK's primary page includes typed child lifecycle events. Root pages keep
those delegation rows, while child conversation rows stay in their own stream.
Backward pages are chronological within each returned batch. Active event-log
reads are repeatable; the SDK's sessionless persisted-event cursors are single-use
capabilities. The adapter consumes a persisted cursor before issuing its read, so
an exception cannot license replay. Expired continuation is explicit. The initial
request supports 100 events, up to 128 per read; a tail page is not evidence of the
oldest boundary. A cold helper is custody-tracked, lives at most 240 seconds by
default and performs at most 256 reads. It never creates/resumes the native agent
or parses vendor history files.

Its existing reader set admits at most one helper for a logical session scope
before awaiting custody. Concurrent or later overlapping readers, including a
different generation, refuse `BUSY` before allocation. They cannot replace or
retire the first live helper. Share the retained conversation binding or close
the helper explicitly; only actual close releases same-scope capacity. The
paired Codex/Copilot scripted race oracles passed with focused strict compilation
(two cases,245ms), including no Create/Resume and replacement after exact close.

Text deltas retain missing-prefix/final evidence until a native full message
arrives. Current `tool.shell_output` chunks use publication sequence; missing
chunks remain explicit, late chunks do not duplicate text, and final native tool
output can replace a partial view. Deprecated partial output is a replacement
snapshot. Native errors and compaction notices remain visible independently from
working state. Large optional native metadata is bounded with omission markers
rather than destroying valid text/lifecycle capture.

SDK1.0.19 strips native request ID and child identity from question/plan/elicitation
closures. A callback that cannot be assigned safely during child activity fails
closed with `CALLBACK_OWNER_UNPROVED`; it does not silently become a root prompt
or freeze unrelated history capture. Exact permission events do not have this
limitation. A callback ownership gap and a history-capture gap remain different
facts.

The decoder keeps 1024 recent event hashes, with no lifetime event counter. It
trusts one ordered synchronous SDK notification attachment; history/reconnect does
not replay native deltas into it. Parent IDs are preserved as metadata, without
assuming that ephemeral or child events share a universal linked chain. Recent
conflicting IDs fail closed. Perfect deduplication of arbitrarily old unsequenced
deltas is not claimed: streamed bodies remain partial until an absolute native
result, and old weaker deltas cannot reopen a completed row.

At most 31 child windows are resident. Only inactive windows with no subscribers
can retire; subsequent positive native child envelopes create a fresh window with
an unknown earlier boundary. Active work and subscriptions cannot be silently
evicted. Global native session idle can clear work ambiguity without fabricating
completed child rows. Thus many successive child lifetimes and long ordinary
streams do not exhaust an ever-growing identity ledger. Truly simultaneous
capacity/identity failure remains explicit. Native exception reads retain their
own bounded semantics.

## Images and native inputs

A structural media materializer receives private native bytes/paths and exact
run/attachment/event/asset identity. Public history gets only pending, unavailable
or scoped StoredFile descriptors. Without that port it gets explicit unavailable
metadata, never raw base64 or filesystem authority. At most four captures run
concurrently, with 8MiB per encoded source, 16MiB pending and 128 asset entries.
Foreign scope and conflicting bytes fail closed. Attachment metadata is bounded
independently from transcript text.

Capture is asynchronous for live events. Its completion finds the current row and
replaces only the matching asset descriptor; it cannot restore old message text
or lifecycle. Stop prevents late publication while actual capture resources stay
tracked until settled. Bounded history reads may await their captured assets and
recheck the publication fence afterward. Capture failure is local asset
unavailability. There is no automatic native fetch/retry for bytes outside a
persisted page. **PR18 must connect the actual FileStore materializer, native input
preparer and UI asset preview; these scripted descriptors do not qualify that
composed behavior.**

## Source provenance and simplification

Behavior references are the exact retained commit
`61d90fd1cb356ccf15a7d681f8d896e38196ef9d`, particularly
`primitives/v8-harness-copilot/src/{runtime,history}.ts`,
`primitives/v8-history/src/native/copilot/history.ts` and
`packages/adapter-copilot/src/{native-owner,persisted-history,primary-history}.ts`.
Their native semantic distinctions were retained; their old package graph,
projection/recovery owners and compatibility generations were not copied. New
SDK response shapes were checked against the published pinned package's actual
`dist/types.d.ts`, `dist/generated/rpc.d.ts`, `dist/generated/session-events.d.ts`
and `dist/client.js`. SDK1.0.19's `mode.get()` returns a string, not the old
object-shaped fixture. The old max-one persisted page was replaced by the native
bounded count primitive. No historical test count is claimed as qualification.

The package was inspected by `npm pack`, not executed. Its published shasum is
`b1362165abe36a597914e4bb5546b211dc28f204`. Static structural SDK types isolate its
current declaration-graph conflicts from the framework; runtime replies are
validated at the adapter boundary. A concrete SDK/CLI protocol drift fails the
pins/decoder rather than silently selecting another API.

## Focused qualification

The owned focused compiler includes only `src/copilot`, its tests and their real
module dependencies. A separate `types: []` browser graph verifies that the
browser entry needs no Node globals. Compile-only router tests reject Codex
commands and unsupported Continue. The scripted SDK uses pinned native response
shapes; its allocation fake asserts exact canonical opening references.

Nineteen unique scripted cases cover: parked ownership and controls; queue/tasks/
MCP receipts and private URLs; permission versus closure acknowledgment; early
binding despite later initialization failure; input ACK/Stop races; passive cold
single-use history with 100-event request; child/error/compaction semantics; exact
router scope/original forwarding; current shell sequence; primary typed child
lifecycle; unavailable media privacy; late media versus newest row/Stop; media
scope/conflict/capacity; release-in-flight readiness and no-allocation BUSY; and
large optional metadata preserving text; 4200 normal ephemeral deltas without a
lifetime capture failure; and 70 successive children with resident/subscriber
ownership; incompatible explicit Reopen policy refusing without allocation; and
typed callback dispatch preserving the exact admitted original and invoking its
native reply once. Node strict compile, browser-only
compile and all 19 tests pass. Final exact source hashes and command output are
retained in the isolated `.cache/copilot-pr11-check` lane; the coordinator owns
archive/package/whole-stack gates.

All cases are model-free. Actual SDK/CLI subprocesses, provider POSTs, native
sessions, fleet changes and live credentials used: **zero**. Temporary test homes
are removed by the fixture. Real Copilot authentication, CLI launch/Stop, vendor
callback delivery, persisted-history behavior, real media bytes, platform
containment and browser composition remain explicitly unqualified here.

The adapter exposes `historyScopes(run)` from proved retained native child windows (not task-ID inference), and cold helper `usable()` facts for explicit conversation read-context renewal. These pure projections allocate nothing and do not Resume.

Actual child page work now holds that native history residency until its complete RPC/media promise settles, even without a UI observer. Completed proved Copilot children remain readonly-readable while callback ownership stays closed. Bounded child churn can evict the window only after actual read release. The adapter owner oracle exercises that exact race.

## F07 native contracts and observed Reopen

`copilot/contracts.ts` owns portable settings, message/command schemas and exact
queue/task/model/MCP/read DTOs. `copilot/node-contracts.ts` owns adapter construction
and borrowed lifecycle/read/resource ports. `copilot/sdk-contracts.ts` describes
the pinned SDK boundary separately from actual SDK construction in
`copilot/server/sdk.ts`. Remaining implementations live under `copilot/server/`;
`copilot/node.ts` retains the public constructor facade. No new adapter owner,
SDK singleton, process registry or package is introduced.

`CopilotNative` carries all four concrete schemas through default lifecycle
inference. Observed selection has a separate schema with required observed mode
and permission facts plus nullable nativeProviderId. Reopen uses that observed
schema, which accepts its own nativeProviderId field and does not invoke the
requested defaults. Missing policy facts positively refuse before allocation.
A proved observed Reopen resumes the same native ID without calling permission
or mode setters; native provider/configuration selection remains authoritative.
The new finite oracle exercises that exact Stop/Reopen boundary.

Read results preserve their actual per-request DTOs rather than becoming opaque
JSON. The compile-only actual Codex/Copilot/default-lifecycle router fixture in
`test/copilot/lifecycle-types.ts` is introduced at this layer, after both adapters
exist. It rejects cross-host selection and unsafe raw-path Send inputs and
preserves optional Codex facts versus required Copilot observed fields.

The native router now fences both session ID and generation for command and
read calls. A saved session-scoped context cannot submit a newer generation's
RunRef to bypass its old scope. This extends the existing authenticated-router
oracle without introducing another effect owner or journal.

The private media owner regression deliberately exercises concrete HistoryWindow
reset/publication through a test-only cast. Public adapter history remains a
borrowed read/feed capability; consumers do not acquire reset, publication or
close authority merely to inspect history. This preserves the exact
newest-row/generation and late-media oracle while narrowing product interfaces.

F07 focused evidence: strict native compilation and ESLint pass. The first
sequential mock suite has 47 passing cases and one new fixture input failure;
that single case passes after passing canonical capsule data instead of the
function-bearing parked handle. No existing passing case was replayed. These
48 unique selected scripted cases use zero native SDK/CLI agent processes,
provider POSTs or models; the separate existing test-owned Node wire child is
explicitly reaped. Actual vendor/transport/fleet proof remains separate.
