# V8 retained workspace and React binding

`MultiplexWorkspace` assembles the existing history, catalog, session, file,
interaction, MCP and pin clients in one immutable connection/principal/authority
scope. It adds prepared view facades and observation capabilities, not another
session store, effect journal, native adapter or recovery scheduler.

Supply explicit scoped ports through `connect({ history, onFence, onConnection, onObservation })`.
The embedder can construct its real GatewayClient with that exact owned history
workspace and return per-logical-session file/interaction/MCP ports. Positive
`binding(scope)` must come from authenticated Host evidence. File routing uses
the resulting exact native FileScope tuple; no native/logical name inference.
Pass GatewayClient.onObservation directly to this structural callback. Composite
`observation.session/history` retain separate transport facts: an unavailable
history feed cannot become current merely because the session feed stays live.
A zero-frame stream remains connecting; there is no automatic polling/read.

Every composition supplies pure `access(scope)` from its authenticated exact
Host grants: `read`, `control`, `fileWrite`, `mcpRefresh` and `catalogWrite`.
The readonly snapshot projection is independent of native capabilities. It
adds no grant store or refresh owner. Local admission checks control before an
original/reference, file protection or answer marker can be retained; denied
intent stays a local draft. File upload/capture, MCP discovery and Catalog
writes retain their distinct grants. The server still authorizes every call.
Loaded history, exact receipt reads, local draft/selection and pins remain
available to a read-only viewer.

`sendReady` derives the same native/binding/control checks used by actual Send
preparation. It is independent of composer/file/preparation state and does not
mean a connection alone permits Send. The chat combines these existing facts
and rechecks the current snapshot when clicked.

```ts
const view = await workspace.open(sessionId); // explicit read-only bootstrap
// Prepare independent panels explicitly outside React render:
const side = workspace.view(sessionId, 'side');
// Import hook from the separate React entry:
const state = useAgent(view);
if (state.kind === 'codex') state.actions.setDefaults?.({ kind: 'codex', effort: 'low' });
```

`open` never Creates, Resumes, reads native history bodies or discovers MCP.
Selection/render/SSR never bind or acquire stream references. The hook calls
`useSyncExternalStore` and acquires an idempotent real history-view lease only
after commit. Separate leases cannot release one another under StrictMode.
Pins hold an independent real retained reference and matching history stream.

Prepared snapshot discriminants preserve actual Codex/Copilot controls. One safe
operation marker is shown per original ID. Generic answer controls are omitted;
`view.respond(prompt, nativeTypedAnswer)` uses the existing one-response callback
client. Private answers are absent composite snapshots and persistence.

Public operations include `create`, `setDraft`, `setPinned`, `restorePins`,
`refreshCatalog`, `list`, `refreshMcp`, `checkReceipt`, `saveFile`, `uploadFile`,
`previewFile`, explicit `rebind`, `disconnect`, `reconnect` and auth `close`.

Archive uses the existing session `actions.archive()` original. After positive
completion, explicit `publishArchive(session,id,generation)` publishes only the
Host's exact proof through the existing Catalog owner. Metadata publication can
be retried independently without native replay. Loaded pages, anchors, pins,
drafts and receipts remain retained; archived sessions release their history
stream and never reacquire it merely because a view or pin remains mounted.

`create` validates and retains the local original synchronously. Local rejection
throws before a promise is returned. A returned promise proves local retention,
not backend durability; its later rejection must not produce another Create.
`subscribeCatalog` observes the existing committed projection without reading or
binding sessions. It includes pin changes after their retention owner commits.
`previewFile` returns the existing ResourceCache ResourceLease; its private URLs
are released at namespace disposal. Every late result is fenced before it can
return private bytes through this facade. Cleanup can still release its exact
previously acquired local file capability.

Create can return `dispatching` before its native binding is published. Keep
that one original visible. `subscribeCreation(id, listener)` delegates to the
existing retained catalog-entry subscription; subscribe, then read
`creationStatus(id)` for the initial safe summary. A positive streamed binding
can enable explicit `open` while the last receipt still says `dispatching` or
`outcomeUnknown`, including a visibly Starting Host with a real confirmation.
Catalog `nativeCreated` proves identity and does not claim initialization success.
These independent facts are preserved, not inferred from a timeout. There is no
polling or new Create. `checkCreation(id)` explicitly checks only that original
when a receipt read is needed. Auth disposal emits null and retires subscribers;
late checks fail closed. Summaries omit launch payloads/private configuration.

Each view exposes actual retained viewport/expansion operations and explicit
`loadOlder()`. The latter coalesces one existing read token per view; there is no
automatic read on scroll/layout/reconnect. Pending originals/drafts/context are
never evicted by selection, unmount, unpin or a transport outage. Rebind is an
explicit existing-client history transition after fresh authenticated binding.

Rebind stages one verified next binding while existing domain handles remain
readable. `bindingTransition` reports preparing/unavailable separately from the
actual native phase. The next binding publishes only after exact session,
interaction and MCP observations exist; no await exposes a missing MCP entry.
Failed preparation retains prior MCP facts and loaded context for an explicit
retry. A same-native attachment change preserves the existing HistoryView and
its private pages/anchor/expansion. A genuine current-run confirmation can be
answered while optional MCP observation is still preparing; the actual native
SessionSnapshot and rich prompt prove that response, independently of the
assembled MCP/history descriptor. Retired-run prompts remain fenced.

React is an exact `19.2.8` peer for this module. Runtime imports the ordinary
`react` package; source/build qualification resolves framework-owned dependencies.
Publishing, production auth and deployment remain separate boundaries.

Focused tests compose actual retained clients and callbacks with actual
SSR/StrictMode/Chromium hooks. They use scripted native ports without
native/model calls. The [integration gate](../v8-integration/README.md) owns the
combined source manifest; the framework [retained-view contract](../../docs/design/v8-architecture.md#history-and-retained-views)
explains ownership and exception handling.

Draft preparation is retained with the composer, not a React component.
`view.submitDraft('send' | 'steer' | 'queue')` shares one slot and verified
attachment path. Its captured action/edit/run/native epoch/receipt owner never
changes after IO; Codex Steer also pins the exact observed root turn. Stop or a
replacement turn fences preparation instead of changing its destination.
`draftActions` derives current admission for each explicit action; the UI offers
Send while idle, Steer while working, and Queue separately. `sendDraft()` remains
the explicit ordinary-Send convenience over that same slot. Steering and Queue
preserve next-turn selection intent. Only the handed-off edit is consumed.
The existing bounded browser protection stores its captured edit association;
reload checks that original rather than minting another for the same edit. A
terminal receipt clears a crash-retained captured edit in the same transaction,
while newer edits and old Send records remain valid. No request is replayed.
`onReady` restores admitted observation facts through existing domain read
owners; reconnect never resubmits effects or fetches native history bodies.
Successful rebind releases the exact superseded MCP entry after publication.

Codex goal editing has its own retained objective/budget form in the prepared
session. A blank budget selects the native default; invalid/zero budgets refuse
before an original is created. Navigation preserves editor intent and ordinary
message/file drafts independently. Save uses the existing native goal original;
its receipt never rewrites the observed native goal or a newer editor draft.

`view.implementPlan(rowId)` admits only a completed plan occurrence from the
current root capture while its Codex run is idle and in Plan mode. One ordinary
Send contains that selected plan's exact body and selects default collaboration.
The ordinary composer and file attachments remain untouched. Both views join
the same bounded occurrence association; deterministic original identity and
existing original protection make reload observation-only for that occurrence.
Missing replies permit exact receipt checks, never a replacement Send. Oversized
plans refuse before original protection under the existing Send text limit;
child, incomplete and prior-run rows grant no action.

## Known Host plugin contracts

`PluginWorkspace<HostSet>` retains only public plugin projections. The app
registers each known Host kind with its public manifest and native kind, then
prepares typed Host/agent views using the actual inferred Host router client.
`createMultiplexReact<HostSet>()` supplies Provider/useHost/useAgent. Hooks take
prepared views, not caller-asserted alternate contracts. Narrowing `hostKind`
narrows native methods and custom data together.

`prepareHost` takes both the Host-scoped `client` and an inert
`sessionClient({id,generation})` factory. The latter binds the existing Gateway
RPC link's exact session context; an agent snapshot uses that client rather
than copying its Host client. A Host-level successful query does not qualify a
session-required harness/extension procedure. The focused oracle traverses the
actual authenticated Gateway/Host router and proves the difference without
native agent work.

Host keys include connection/principal, authority, Host, durable owner and route
epoch; session projections also include exact generation. Rebinding a physical
key as another kind refuses. Base views must match that authenticated scope.
One public session projection is shared across private viewer facades, so their
loaded pages/anchors remain independent. The existing base owner keeps history,
originals, drafts, file holds and native state. Plugin capacity refuses rather
than evicting a conversation.

Prepare/render/SSR are inert. Commit leases and explicit pins observe through a
supplied `PluginSource`; the source uses the existing Gateway descriptor/retry
owner. It must stream complete ordered snapshots and fence old epochs. Disconnect
retains prior data; auth disposal redacts it, releases all leases and isolates
cleanup failures. No additional reconnect timer, effect queue or native owner
is introduced.

Focused plugin tests cover retained/private views, exact type/scope binding,
synchronous source callbacks and redaction despite cleanup failure. The actual
plugin browser proof uses two different Host contracts through authenticated
HTTP, one mux and actual React/SSR/StrictMode. See the
[typed plugin contract](../../docs/design/v8-architecture.md#typed-host-composition)
for the ownership boundary and the integration runner for source evidence.

## Streamed agent inventory

The root `HistoryOwner` publishes optional `scopeInventory` with its ordinary
snapshot/commit/replay. `AgentHost.#historyScopes` remains the sole authorization
owner; each immutable entry contains the exact Scope and optional closed native
presentation facts. Scope identity and descriptive facts stay separate. Absence
means no inventory claim; a real empty inventory is explicit. The projection
shares existing revision, scope, replay and byte limits and cannot open a child.

The workspace consumes that stream through its existing retained HistoryClient.
There is no React fetch, second child store, polling, body read or new stream.
An explicit `refreshHistoryScopes` metadata exception remains available. A failed
refresh/native rebind keeps prior display facts but marks them unavailable or
unobserved. Child observation/recovery still requires the current exact binding
and observed scope. Old scopes are never rewritten into a new attachment.

`agents` is a pure summary of this projection and retained native delegation
rows. The newest invocation in existing native row order supplies its own status
and model facts; a reused agent's late older completion cannot finish the newer
invocation or donate a model to it. Parent item completion does not finish a
Codex child-start activity. Positive root native-tree Stop bounds the child
lifetime without inventing a completed or cancelled task. Disconnect and stale
history remain last-observed evidence.

Names and model facts come only from admitted native metadata. Codex `.162.1`
Thread.model is configured/latest persisted state, explicitly not per-turn
telemetry ([primary declaration](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs#L244)).
Copilot SDK `1.0.19` distinguishes the started model, configured preference,
parent task override, first dispatched model and native completion-reported
model. They remain separately labelled; parent defaults and unrelated provider
responses do not fill missing child data. Scope-only native announcements can
show unavailable fields. Cold child discovery remains a separate qualification.

The focused [mounted oracle](../v8-host/qualification/child-inventory-browser.mjs)
uses actual scripted Host ownership, authenticated HTTP Gateway, retained
workspace and shared React UI. It exercises metadata-only Codex discovery,
Copilot reused-agent provenance and positive root Stop without transcript-body
reads, native model processes or user mutation from the view.
