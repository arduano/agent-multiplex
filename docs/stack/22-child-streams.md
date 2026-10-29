# 22 — Read-only native child streams

A native subagent is a history stream inside its parent's exact RunRef. It is
not a new Multiplex session. This layer does not change SessionScope.session,
invent a native root identity, allocate an agent or expose Send/Stop/Archive.
The parent lifecycle remains the sole native lifetime/effect owner.

## Two small responsibilities

The Node ChildStreamOwner receives a structural HostChildPort: positively proved
child inventory, an exact existing HistoryWindow/HistoryReadPort binding, parent
RunRef validation and the existing parent observation subscription. It exposes
a typed read-only Host router: inventory, watch, baseline and older. Ordinary
watch streams the existing native window without fetching. Explicit baseline or
older are exception reads using the existing HistoryAcquisition, count100,
shared actual-I/O ReadBudget2 and its existing cursor/single-use semantics.
Wait expiry only ends observation; it does not free actual I/O or repeat a read.

Bindings are keyed by full HistoryScope, including parent generation, native ID,
attachment and child stream. The owner admits at most32 resident bindings by
default (configurable1–64),128 history watchers and two actual reads. Unobserved,
settled bindings may retire; active reads/watchers cannot be evicted to create
fictional capacity. Retired reads retain their actual reservation and native
history hold until settlement. A failed hold release retains its exact binding,
refuses further work and leaves close/readiness unproved. Closing a child watch
only closes that local history subscription, never native work or the parent.

The browser RetainedChildStreams owns bounded residency and viewport intent.
It uses the existing history reducer and AnchorController, plus the application's
existing ObservationConnector for actual connection recovery. It creates no
second retry loop, durable journal or transport. Views are inert until commit;
mounted views and pinned entries share one observation per exact child. Pinning
keeps the child stream/rows/anchor through UI unmounts and child selection changes.
Defaults are32 resident children,64 mounted view leases and128 listeners.

Selecting another parent fences actions on old selected views. Pinned snapshots
for other logical parents can remain observed in the background; full scope keys
prevent their frames overwriting the current child. A new lifetime of the same
logical parent retires old-generation observations while retaining their visible
snapshot/anchor. Late callbacks are token/scope fenced. An evicted view cannot
resurrect an unaccounted observation. UI code may bind getSnapshot/subscribe to
React's external-store hook and render read-only HistoryRow components; this
layer deliberately provides no composer or fake SessionView command methods.

## Actual harness composition

The structural port must use actual adapter proof, not a task list or guessed ID:

```ts
// Codex: one already-owned native adapter and its positive lineage graph.
inventory: run => codex.history(run).scopes().filter(
  scope => codex.history(run).owner(scope.stream)?.relation === "child"
),
bind: scope => {
  const history = codex.history(scope.run);
  return {
    window: history.window(scope.stream),
    port: codex.historyRead(scope.run, scope.stream),
    release: history.protect(scope.stream),
  };
},

// Copilot: its own native root is literally "root"; do not rename it.
inventory: run => copilot.historyScopes(run).filter(scope => scope.stream !== "root"),
// Window/read ports are copilot.history(run, stream) and historyRead(run, stream).
```

The coordinator added the pure Copilot historyScopes projection over the actual
retained codec windows; this layer does not inspect SDK private state. Both
adapters now retain actual child residency throughout their complete historyRead
RPC and media work, releasing the exact hold in finally. CopilotHistory.protect
excludes held children from codec eviction; Codex uses its existing protect and
permits reads of closed, positively proved children while callback ownership
continues to refuse closed children. The added held-read/churn adapter oracles
belong to10/11 and the coordinator's stable gates. This closes the implementation
seam without dummy subscribers or additional native attachments; it does not
claim live vendor qualification. The generic optional release still carries any
longer-lived composition hold when one is actually acquired.

assertRun validates exact parent lifetime/custody using the lifecycle owner;
it may permit a stopped retained stream when a real read-only port exists. The
subscription reports parent lifetime changes. Inventory is a bounded explicit
query; native child discovery signals continue to belong to the existing native
attachment/parent history. Applications can query on those signals without a
second permanent poller. A source must not return an unproved root as a child.

Host procedures retain normal route/action gates and additionally fence the
authenticated connection/principal/host/session/generation. A read-only principal
can view its authorized children. No mutation route exists in the child router.
Transport subscription adapters use their normal abort/unsubscribe contract;
render, reconnect and browser close never Resume a native session.

## Focused evidence and limits

Three composed scripted cases use actual public CodexHistory lineage/window
code, actual typed Host callers, HistoryAcquisition/reducer and retained browser
views. They prove zero happy-path history reads, child scope under the parent,
read-only account fencing, pin/scroll retention, count100 exception acquisition,
generation fencing, deduplicated pending reads/late retirement, exact hold release,
resident eviction fencing and failed release custody. The browser graph compiles
with types:[] and rejects native owner imports; compile assertions reject Send
on views and Stop on the typed router.

Focused strict Node compilation passed in2.918s, strict browser compilation in
2.078s and all three owner cases in0.134s. Existing history/cursor/codec tests
remain their respective owners' evidence rather than being copied here. No
model, vendor CLI, provider, native lifetime, service or filesystem-state calls
occurred. This does not claim actual browser geometry, live Codex/Copilot subagent
qualification, persisted child discovery after a Host restart, or automatic cold
reader allocation. Those are composition/acceptance boundaries, not implied by
this read-only view implementation. The coordinator owns exports, logical PR
placement and the stable whole-graph gate.

The portable `client/anchor` factory returns only the anchor capability, so readonly views do not import the optional typed tRPC barrel or Node ambient declarations. Native adapter read holds are applied to the actual read promise, not a dummy UI subscriber.

## Contract boundary refinement

The Host child port and service contract are prominent Node interfaces; they
borrow `HistoryFeed & HistoryReadWindow`, acquisition and read-budget
capabilities instead of concrete HistoryWindow or owner classes. Their actual
owner retains the same read fence and shared budget. Browser retention lives in
`child-streams/client/`; Host ownership and typed routing live in `server/`.

Each child view derives a stable read-only transcript capability from its exact
RunRef/HistoryScope. It carries bounded exception-read state, the existing anchor
and the same resident history, with no parent mutation or fabricated SessionState.
The composed child oracle renders that capability using actual ReadonlyTranscript
and verifies no composer, Send, Stop or read-on-render. Existing lineage, pin,
root-generation fencing and actual lease-cleanup assertions remain unchanged.

The shared contract-refinement gate passes strict compilation, owned ESLint and
44 focused tests, with one explicit published-network skip and no failures or
cancellations. It covers the retained client, actual React components, real
filesystem uploads, child views and loopback tRPC transport. This is source and
scripted composition evidence; no vendor, model, live relay, installed service
or full browser acceptance claim is added.
