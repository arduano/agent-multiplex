# 17 — Reusable conversation binding

This layer connects existing owners into a usable conversation contract. It
supplies a typed Host router and a real browser SessionFeed implementation; the
consumer does not have to invent a fixture-only glue layer. It adds no native
lifecycle, effect journal, transcript store, retry outbox or native-family union.
Native controls remain the selected harness's typed router.

## Contract and public entries

`./conversation` is browser-safe: `createConversationFeed`,
`subscriptionStream` and public observation/caller DTO types. It imports no Node,
storage or native implementation. `./conversation/node` exports
`ConversationFeature`, `ConversationOptions`, its structural lifecycle/history
ports and `conversationRouter`. Only the Node entry imports the Host kernel.

| Input/owner    | What17 consumes                                                                          | What17 does not own                                                                     |
| -------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Lifecycle06    | state, subscribe, exact command and original lookup                                      | Session state, native generation, Create/Send/Stop/Reopen/Archive or the durable writer |
| Native10/11    | Actual root HistoryWindow and HistoryReadPort                                            | Native allocation, raw vendor history, provider policy or helper retirement             |
| History07      | One acquisition/frontier per exact run and live/cold observation mode; shared ReadBudget | A duplicate transcript or invented public native cursor                                 |
| Interactions09 | The same owner's snapshot and subscribe; typed answer command encoder                    | Capability admission, native confirmation or another callback owner                     |
| Client15       | A complete SessionFeed from typed caller functions                                       | Drafts, pins, originals, row residency or per-view anchors                              |

The Host injects `history(run,state) -> {window,port}`. It must select the
actual root scope, including its genuine native stream identity. Codex's root
may equal nativeSession; Copilot's root is `root`. Nothing renames those values.
A live factory selects already-retained objects and performs no native I/O;
actual page work belongs in `port.read`. A stopped factory may obtain a durable
sessionless read helper and return its real scope. It must not Resume, Send,
read vendor transcript files or invent a containment identity. The selected
adapter/lifecycle retains the helper's exact resource close.

The interaction getter returns the same object that native callbacks received
through CallbackSink/CallbackDispatcher. Key it canonically by logical scope,
generation and native ID; plain JSON insertion order is not an identity. If no
native callback owner exists,17 reports an empty **partial** observation. It
cannot claim complete recovery or revive an old prompt.

The reply generic preserves host differences. A
`ConversationFeature<CodexCommand,CodexAnswer>` exposes only Codex answer kinds;
its encoded answer goes through `lifecycle.command(scope,id,command,run)`. That
owner admits the original before the adapter dispatches its exact one-use
capability.17 never manufactures a hash, receipt or successful native response.

## Observable behavior

The router exposes `state`, `stateWatch`, `historyWatch`, `interactionsWatch`,
`baseline`, `older`, `readState`, `original` and `answer`. All routes use the
actual05 action/admission middleware and check connection, principal, Host,
optional session and generation against their requested scope. Route freshness
remains with the Host kernel; it is not reinterpreted as a native lifetime.

State watches immediately publish the authoritative current projection and
conflate only complete snapshots. They map opening to starting, preserve unknown
activity and keep known stopped/archived native identity readable. Transitional
opening does not manufacture a Running RunRef. A quiet iterator's return resolves
its pending next and removes its observer without stopping native work.

History watches immediately subscribe to the selected actual window once its
binding exists. Slow consumers receive a full window snapshot instead of losing
incremental frames. A fresh Create's `provedEmptyCapture` boundary never causes
a native fetch. An unknown boundary triggers one bounded baseline exception,
shared with explicit baseline requests through07. Default reads request100
entries; only07's bounded size reduction can lower that count. There is no
normal-path history polling, reconnect fetch or replay of a mutation.

Stop changes the history observation from live to cold while preserving the exact
run.17 closes only the old observer, retires its read frontier and fences late
pages against the changed mode. A native helper remains adapter-owned after a
viewer leaves. The shared ReadBudget stays occupied until actual binding/page
work settles, even if a viewer cancels or a UI wait expires. Merely selecting
several retained live streams consumes no page budget, which avoids artificial
startup unavailability for multiple pinned conversations.

A user-requested baseline can use07's one explicit retry of a failed repeatable
read. Reconnect and automatic unknown-boundary loading never take that retry
branch. Single-use native readers keep their stricter cursor semantics. Native
unsupported/expired/stale/failed outcomes remain explicit. `readState` exposes
pending/result/retry facts for an advanced loading or diagnostic surface; it does
not start a second read.

## Browser integration

`createConversationFeed` receives a typed `caller(scope)` map and a typed
`dispatch(scope,command)` function. It supplies all SessionFeed observation,
baseline/paging and exact-original functions. The caller map can directly use a
real server-side tRPC caller or adapt browser tRPC observable subscriptions with:

```ts
stateWatch: ({ session }) =>
  subscriptionStream((observer) =>
    client.extensions.conversation.stateWatch.subscribe({ session }, observer),
  );
```

The other watch methods follow the same typed mapping; query methods retain
their actual typed results. Dispatch selects the consumer's concrete lifecycle
Send/native command/Stop functions once. It does not derive a vendor operation
from generic strings or retry when a response is lost. The browser stream bridge
retains final data before completion, returns quietly, unsubscribes exactly its
observer and preserves actual cleanup failure through the returned promise.

RetainedWorkspace still owns cross-view sharing. Two views of the same retained
entry use one observation feed, while independent consumers can hold their own
observers.15 retains drafts/pins/originals and anchors.17 supplies no React state
store and does not close a session when a React component unmounts.

## Actual bridge and public values

The browser caller map can borrow the actual `rpc` facet of a retained
`connectBridge<ActualHostRouter>` peer. The published bridge carries the same
Host router's real queries, mutations and subscriptions; Gateway HTTP does not
remount it. The separate Gateway HTTP tRPC API supplies topology only. The
application owns peer admission/close and supplies verified Host routing metadata
outside procedure inputs.17 owns only observation and read bindings, while15
retains drafts, original receipts and view state across channel interruption.

`ConversationFeature.state` constructs a public value with an independent copy
of the outer `scope`. Its nested `run.scope` has the same logical identity but
does not alias that outer object. The dependency's bounded RPC codec rejects
repeated object references as well as cycles; returning both references to one
scope instance would otherwise refuse a valid state observation. This is a
small DTO-construction rule at its actual owner, not generic JSON normalization,
result cloning or reconstruction of a router/client API.

A logical browser peer survives ordinary carrier reattachment only while the
Host retains its valid authenticated entry. Its resumption secret and file
ledgers are process-local, with expiry and capacity limits. Session switches
reuse the peer; reload creates a new one and can leave an old Host entry charged
until retirement. A fresh Host process cannot recognize an old secret.17 can
resubscribe observations once application composition supplies a valid new peer,
but cannot create authentication, renew a revoked grant, Resume an agent or
replay an original to repair that boundary. Source changes here do not qualify
long bridge TTLs, reload-capacity exhaustion or fresh-process recovery.

## Lifetime and capacity

Conversation bindings are disposable observation/frontier state, not agent slots.
The default bound is256 live/cold bindings and can be configured up to4096.
The reference owner must call `forget(run)` when an archived or superseded run
has no remaining viewers/read jobs. Forget first proves **all** that run's
bindings are settled and unobserved, then retires them together. It never closes
a native agent/helper or deletes durable session data. A retained view or actual
read refuses disposal. This explicit lifetime keeps old runs from consuming the
projection bound indefinitely without adding an LRU that might evict active
paging or callback custody.

Close seals observation admission and waits for observer release. Actual native
reads must first settle. Failed observer cleanup retains the same rejected close
and readiness remains blocked; it is not silently retried. Helper/captured-input
cleanup remains the selected adapter's lifecycle responsibility.

## Historical qualification and retained evidence

The focused command compiles only this layer and the actual dependencies reached
by its tests:

```sh
node node_modules/typescript/bin/tsc --target ES2023 --lib ES2023,DOM,DOM.Iterable --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noImplicitOverride --verbatimModuleSyntax --rootDir . --outDir .cache/conversation-check --declaration false src/conversation/node.ts src/conversation/index.ts test/conversation/conversation.test.ts
node --test --test-concurrency=1 --test-timeout=60000 .cache/conversation-check/test/conversation/conversation.test.js
```

Strict compilation passes. The complete five-case conversation gate passed in
2.639s; its actual composed case took2.506s. Later atomic projection-disposal and
latched-close refinements passed their two affected focused cases; the final
actual-read/Stop fence rerun took7.883ms. This is source qualification, not a
native-provider/browser/fleet campaign.

The composed oracle uses real private SQLite, DefaultLifecycle, typed05 Host
routing, the implemented10 wire/adapter and the actual15 RetainedWorkspace
through the shipped SessionFeed binding. It proves:

- Fresh Create streams with zero history fetch; sibling views share one feed.
- Send receipt and native text reach the retained client through real module APIs.
- Conversation answers retain the real admitted hash, deduplicate delivery and
  wait for native resolution to confirm the exact callback.
- Quiet observer cancellation does not Stop the native lifetime.
- Stopped native history auto-loads100 entries through the actual sessionless
  reader; that wire issues no Create, Resume or Send.
- Reader capsules are durably retained in a test-owned auxiliary checkpoint
  writer and are released by lifecycle/adapter close, not observer cancellation.

Four additional unique cases prove final-value/quiet subscription cleanup,
retained actual read reservations and late-live-page fencing after Stop,
explicit-only bounded read retry, and inert multiple live streams plus safe
projection disposal. Compile-time counterexamples reject Copilot answers on a
Codex-bound conversation. Fixture corrections used canonical run identity and
awaited actual client cleanup; no oracle was relaxed to conceal those ownership
requirements.

All vendor/model/provider calls and actual native-agent allocations are zero.
The native backend and wire are scripted; no OS process is launched by17's tests.
The actual owners, tRPC callers, SQLite writes and retained-client behavior are
real. Temporary journal/helper homes are closed and removed. Broader04/06/07/09
fault matrices are retained at their owners, not duplicated here.

## Explicit remaining boundaries

This layer does not qualify real Codex/Copilot providers, browser layout/scroll,
Iroh outages, two-viewer transport recovery or a running fleet. Native helper
expiry/cursor capability limits remain the adapter's explicit read outcomes.
A cold factory must manage its durable custody and supply a valid current port;
17 cannot reopen an expired native resource behind that owner's back.

Files and rich native assets remain scoped08 and18 concerns. History rows pass
through unchanged, so supplied file IDs/media descriptors survive; this module
does not materialize bytes or turn private paths into browser URLs. UI16 and
reference19 own actual prompt rendering, previews, controls, loading details and
native selection surfaces. Automatic read progress is available through
`readState`; the existing15 SessionFeed carries history frames and explicit read
results rather than a second progress store. The operator-selected Reopen
control remains a typed lifecycle/native concern.

No earlier private application, installed service, native home or provider was
opened. There is no Personal Multiplex dependency or compatibility shim.

Finite stopped-history helpers expose `HistoryBinding.resource` with a pure
`usable` fact and exact asynchronous `retire`. Explicit baseline/older reads
replace an expired binding only after its actual read has settled and its old
resource has retired. Existing observers follow the new attachment; an old
public cursor returns expired and the new capture obtains its normal baseline.
No native cursor is replayed across helper attachments and no agent Resume is
involved. Live bindings have no finite resource. Adapter read helpers expose
pure usability facts; custom finite helpers must supply this resource port.

## F07 contract-first amendment

The Host router borrows `ConversationService`; `node-contracts.ts` explicitly lends lifecycle commands, read/feed history and the same shared read budget. The private coordinator owns read bindings/observers, without obtaining a native lifetime or concrete history reset/close. The portable subscription buffer remains one shared internal implementation.
