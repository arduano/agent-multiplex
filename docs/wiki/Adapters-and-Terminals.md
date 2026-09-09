# Adapters and terminals

Adapters preserve native harness behavior behind a small common lifecycle. They
do not force Codex and Copilot models, modes, approvals, questions, or event
payloads into one invented schema.

## Common adapter contract

An adapter owns one `harness` and `adapterScopeId` and implements:

- harness catalog, model, and native-session discovery;
- native spawn and resume;
- session status and acknowledged settings where observable;
- native command execution and interaction responses;
- ordered native event subscription;
- native history reads;
- optional read-only native state views for an already active binding;
- stop and optional idempotent session release.

The runtime wraps adapters in named backends. A successful launch records the
provider, profile, implementation, backend, adapter scope, vendor session ID,
and binding revision. Resume, history, stop, and archive use that provenance
instead of guessing from `harness`.

### Bounded native history

Codex and Copilot history reads default to ascending order. Clients can select
`request.native.sortDirection: "desc"` to open at the latest native items and
follow opaque continuation cursors toward older history. The response echoes
`sortDirection`, allowing clients to reject an older host that ignored this
request instead of mislabelling the first page as the latest. Codex delegates the
direction to `thread/items/list`; Copilot pages the supported SDK `getEvents()`
result with direction-specific cursors. Copilot still retrieves the SDK's whole
event list inside the runtime; the gateway and browser receive one bounded page.

Copilot clients with `history.native.primary` v1 can instead select
`request.native.view: "primary"`. This uses bounded native `eventLog.read`
with `agentScope: "primary"`, retaining root events and native `subagent.*`
lifecycle events while child chatter stays in full native history. Filtering
happens in Copilot before the page limit, so child-heavy work cannot consume the
main conversation's page. Native events remain unchanged; the page follows the
requested ascending/descending order. These cursors are opaque and incompatible
with the full-history index cursors. The omitted view keeps the existing full
history behavior. Unsupported native methods fail explicitly.

Primary pages that exceed the wire envelope are re-read at the same native input
cursor with a smaller limit. The adapter never truncates a page while advancing
past the untransferred events. A single oversized item uses the explicit omission
mechanism below. An expired native cursor fails with
`Copilot history cursor expired; reload the conversation`; clients must reset
their history window instead of appending the native fallback as older messages.
The primary view counts native events, not rendered conversation messages.

Codex clients with `history.native.turns` v1 can select
`includeTurns: true, native: { view: "turns", sortDirection: "desc" }`, usually
with `limit: 1`, to read the latest turn's status/error after reconnect. This
delegates to native `thread/turns/list` with `itemsView: "summary"`; the payload
keeps native `{ data, nextCursor, backwardsCursor }` and unmodified turn fields.
These turn cursors are separate from item-history cursors. Pages are capped at
100 turns and re-read at the same cursor with smaller limits when oversized.
A single oversized summary first falls back to native `itemsView: "notLoaded"`,
preserving turn metadata and explicitly reporting absent item details. If that
metadata is also oversized, the ordinary explicit-omission rule below applies.
There is no full-history fallback or scan for an older failure; idle status alone
cannot establish the latest turn's outcome. Existing runtime history attachment
policy applies, and temporary history handles do not activate a stopped catalog
binding. An omitted view
retains existing item history. Unknown explicit views fail.

An individual native item may exceed the wire envelope even at page size one.
By default this is an error. Clients opting into
`request.native.omitOversizedItems: true` instead receive an empty native page,
an explicit `unavailableItem` descriptor, and the native continuation cursor.
They must display the omission; no truncated text is presented as the native
item. `complete` means pagination is exhausted, not that an explicitly unavailable
item was transferred. Native history remains intact and can be inspected in a
supported native terminal. This mechanism does not fetch, convert, or alter images.

## Codex

The runtime supervises one worker-local `codex app-server` on an owner-only
Unix-socket directory. Structured adapter connections and managed stock TUIs
address the same server and vendor session. The adapter supports native model,
collaboration mode, reasoning effort, turn settings, prompts/steering,
interrupts, approvals and `request_user_input`, events, bounded `thread/items/list`
history and optional `thread/turns/list` status/error pages,
and metadata-only `thread/read` reads according to the pinned Codex version.

A managed TUI runs conceptually as:

```text
codex resume --remote unix://<private-runtime-socket> <vendor-session-id>
```

Closing the TUI closes only its PTY. It does not close the structured session or
shared app server. The socket is never published through p2prpc.

Structured requests wait for the complete initialization handshake. Closing
the RPC client fences delayed startup and settles outstanding requests;
dispatched requests without a response report an unknown outcome and must be
reconciled through their durable operation IDs.

The maintained adapter is pinned to Codex CLI `0.152.0`. OpenAI classifies the
app-server command and WebSocket transport as experimental; re-run adapter and
live qualifications for every upgrade.

### Codex goals

The experimental `thread.goal` v2 capability advertises the native goal view and
durable goal commands. `sessions.readNativeState` accepts
`{ harness: "codex", view: "goal" }` and preserves native `{ goal }`, including
`null` for no goal. Refresh on attachment/selection, reconnect and root
`thread/goal/updated` or `thread/goal/cleared` notifications. Descendant events
retain their native ownership; they do not replace the root objective. Reads
require an active binding and never attach or resume stopped sessions.

`setGoal` passes only supplied objective/status/token-budget fields to native
`thread/goal/set`, while `clearGoal` calls `thread/goal/clear`. Clients can offer
the native `/goal` view, objective/edit, pause, resume and clear interactions.
No model prompt or synthetic user turn implements these controls. Objectives
have a 4,000-character limit. Omitted budgets remain omitted; explicit `null`
removes the limit. Active, paused, blocked, usage-limited, budget-limited and
complete states, usage counters and timestamps remain Codex's native values.
An active goal is distinct from a currently running turn; goal changes do not
invent session liveness. Native refusals remain visible errors, while malformed
or lost mutation acknowledgements remain `outcomeUnknown` under the original
stable command ID. See the [adapter reference](../../packages/adapter-codex/README.md#native-goals)
and [command schemas](../../packages/protocol/src/command.ts).

## Copilot

Pinned CLI `1.0.81` keeps a never-used session in memory without durable native
history. It can disappear from native inventory after a host restart even when
`sessions.save` acknowledged; that operation does not force empty sessions to
disk. An exact native missing-session resume refusal reports a known failure
with an explicit stop/archive-and-replace recovery path. Network failures remain
ambiguous. The adapter never creates fake history or silently replaces a missing
session. See [empty sessions](../../packages/adapter-copilot/README.md#empty-sessions-and-restart).

The supported path uses the Copilot SDK for session creation, native modes,
prompts, interrupts, interactions, events, and history. Provider/model selection
is runtime-local. An OpenAI-compatible BYOK provider can use the Responses wire
API and a runtime-local API-key or bearer-token file; its secret is never
projected.

The selected model is read from native `session.model.getCurrent` on every SDK
attachment, including resume without a model argument. Root `session.model_change`
events update the same acknowledged setting; child model choices remain native
child events. Missing or failed native reads stay unknown, and delayed replies
cannot replace newer native choices or acknowledged commands. Native model IDs,
including an explicit `auto`, are preserved without inferring a default.

Native mode is similarly read through `session.mode.get` on attachment and
mirrored from root `session.mode_changed` events. Approving a native plan can
therefore update the acknowledged mode without a Multiplex `setMode` command.
Children cannot change the root mode; newer native transitions fence delayed
reads and command acknowledgements. Missing or failed native observations remain
unknown, while an SDK without the optional read keeps its acknowledged mode.

Copilot's `assistant.idle` only means its main processing loop paused. Attached
shell commands and background agents can still be running, so it does not mark
the session done. Root `session.idle` supplies the whole-session idle signal;
unresolved root interactions continue to report waiting for input.

Attachment and ordinary inventory refresh also read native `metadata.activity()`
when supported, using the existing active SDK handle. This restores working status
after joining a running turn and reconciles missed whole-session idle events.
The native observation supplies `hasActiveWork` and `abortable`, not a breakdown
of tools or subagents. Resume's `sessionWasActive`/`continuePendingWork` flags remain visible
when that observation API is absent. Newer lifecycle events or pending root
interactions fence delayed activity reads. Sending another prompt cannot hide an
unresolved question or permission, and a duplicate completion for a retired
permission cannot restart the displayed working state.

### Stalled Copilot reads

Native history, queue, activity, model, mode, permissions and adapter discovery reads
have a 15-second caller deadline. Primary-history page-size reductions share the
same deadline. Identical in-flight reads coalesce; a different cursor or observation
revision cannot reuse an older response. A timeout releases the runtime read's
caller, but the underlying native request keeps its slot until it settles. Its
late result is discarded. Repeated refreshes therefore fail promptly without
piling up new native requests; at most 256 unresolved read calls are retained
across the adapter's session handles. A failed activity read marks an unchanged
running/idle observation unknown. Newer native events, errors and pending input
remain authoritative; no read failure invents completion.

These deadlines do not cancel native work, repair a stalled shared SDK server,
resume sessions or retry commands. Sends, steering, settings, interrupts and
lifecycle mutations keep their existing acknowledgement/unknown-outcome rules.
The runtime daemon's presence heartbeat remains independent of inventory and
metadata maintenance; see [process supervision](Operations.md#process-supervision).


### Copilot tracked tasks

Experimental `tasks.list` v1 advertises `sessions.readNativeState` with
`{ harness: "copilot", view: "tasks" }`. It refreshes detached shell metadata
then lists the native task snapshot. This includes synchronously awaited shells
and agents, background work, and client-owned tasks; the native `executionMode`,
`canPromoteToBackground`, status, owner, and requested/resolved model fields are
preserved. Refresh on selection, reconnect and root
`session.background_tasks_changed` events. Idle or completed native tasks are
not evidence that the whole session is running.

`tasks.progress` v1 adds `view: "taskProgress", id` for native recent shell output
or agent/client progress. `tasks.promoteToBackground` v1 adds
`view: "currentPromotableTask"` and the durable `promoteTaskToBackground` command
with the exact native task `id`. The task-list eligibility flag is authoritative
for that row; an empty current-task observation does not invalidate an eligible
listed task. `tasks.cancel` v1 adds the durable `cancelTask` command with its exact
`id`. IDs are opaque strings, bounded to 4,096 characters; PIDs, commands, names
and tool-call IDs are never substituted. Clients offer promotion only when
`canPromoteToBackground` is explicitly true, and respect `canCancel` for
client-owned work.

All views require an active binding and preserve native absence (`{}` or
`{ progress: null }`). No view resumes sessions or scans native history. Lists
are bounded to 1,000 entries and the native wire envelope; progress has the same
wire bound. Oversized, malformed or unsupported snapshots fail explicitly.
Refresh and list share one 15-second caller deadline and one coalesced read lane.
A timed-out native request retains that lane until settlement, and an expired
refresh cannot dispatch a later list. Progress reads similarly share a lane and
cannot mix task IDs or accumulate behind a stalled request.

Native `{ promoted: false }` and `{ cancelled: false }` are definite no-op
acknowledgements. Missing/malformed replies or lost mutations are
`outcomeUnknown`, reconciled by the original durable command identity. There is
no automatic retry, alternate-task selection, arbitrary shell execution, or
process termination fallback. Refresh can report a reaped shell as `completed`
after a successful cancellation acknowledgement; preserve that native status
rather than rewriting history. The client should re-read after an acknowledged
action instead of predicting the resulting list.

The disposable Linux native smoke at
[`native-tasks-smoke.mjs`](../../packages/adapter-copilot/test/native-tasks-smoke.mjs)
exercises sync-shell promotion, sync/background cancellation, absent-ID no-ops,
progress, and native invalidation without model requests. It uses a disposable
native tool only to create harmless fixture work; the public adapter exposes
only the native task controls. Windows and model-driven agent/client behavior
remain separate UAT.

### Copilot pending messages

`queue.pending` v1 advertises `sessions.readNativeState` with
`{ harness: "copilot", view: "pendingMessages" }`. The native payload preserves
the SDK's `queue.pendingItems()` snapshot: queued item IDs, optional logical
message IDs, displayed text, native kinds/modes, steering messages and optional
in-flight steering count. Refresh on root `pending_messages.modified`, selection,
and reconnect. A send acknowledgement means accepted; matching `user.message`
`data.messageId` identifies delivery into the native conversation. Older native
snapshots may omit correlation IDs or the in-flight count; absence stays unknown.

This read requires an active runtime binding and `read` access. It never resumes
a stopped session, scans history, creates command receipts or persists pending
text in the canonical catalog. Responses are bounded to the native envelope and
1,000 combined queue/steering entries; an oversized or unavailable snapshot fails
explicitly instead of reporting an empty or silently truncated queue.

`queue.sendNow` v1 advertises the `steerQueuedMessage` Copilot command with the
exact queued item `id`. The normal durable command journal calls native
`queue.sendNow({ id })` atomically. `{ steered: false }` means there was no live
main turn and leaves the item queued; it is not permission to remove and resend
its text. A lost or unrecognized acknowledgement remains `outcomeUnknown` under
the original command identity. Native notifications/snapshots reconcile the queue.

An acknowledged send must contain the native logical message ID; missing IDs are
an unknown command outcome, never an indication that a message was consumed.
Adapter shutdown fences in-flight attachments and detaches handles returned
after shutdown rather than publishing them as controllable sessions.

Copilot's native allow-all setting is separate from interactive/plan/autopilot.
The `permissions.mode` capability advertises the fenced `setPermissionMode`
command; it selects native `manual` or `allow-all` for tool, path and URL
permissions. The adapter never autoanswers questions or bypasses managed native
policy. A native refusal is reported, and a lost mutation reply remains
`outcomeUnknown` under the original command identity.

`harnessSettings.copilotPermissions` reports native acknowledged state, including
native `assisted` when observed elsewhere. `assisted` cannot be selected through the
Multiplex command. Every attachment reads the current state through the SDK;
it does not restore permissions from gateway storage or blindly reapply a saved
toggle. Root native changes update the same snapshot. Unknown state stays
unknown, and native completion retires only its exact pending permission
request. See the [adapter guide](../../packages/adapter-copilot/README.md#native-allow-all-permissions).

Copilot has no supported stock-TUI attach command. The optional TUI bridge is
therefore experimental and disabled by default. It pins CLI `1.0.81`, starts its
hidden `--ui-server --no-auto-update` mode on a random loopback-only port, and
connects the structured adapter as a sibling SDK client. A failed probe falls
back to structured Copilot with no terminal capability.

The hidden server does not accept the expected SDK connection-token mode, so
the loopback listener assumes other processes inside the runtime OS/container
boundary are trusted. Never publish or forward it. Remote terminate/restart is
unavailable because the TUI owns the shared SDK runtime.

## Mock

The mock adapter provides deterministic Codex-shaped sessions, chunks, status,
and metadata behavior for integration and scale testing. The 100-session
receipt validates control-plane fan-in, cursors, CAS, reconnect, and UI behavior.
It does not model real app-server memory, provider latency, token use, or OS
process pressure.

## Managed terminal side channel

The terminal is an explicit escape hatch for a session already owned by
Multiplex. It cannot adopt an arbitrary shell, tmux pane, or independently
started CLI.

Every terminal operation is fenced by session, runtime, binding revision, and
runtime boot. The runtime holds:

- the PTY process;
- a bounded raw output/resize timeline and synthesized fallback screen;
- current viewers;
- one short renewable keyboard/resize lease.

Several observers may attach. While the raw timeline is complete, a new viewer
reconstructs the terminal from its opening dimensions and the exact ordered
output/resize events. An explicit end barrier commits the replay high-water;
partial replay is discarded and retried after disconnect or bounded-buffer
overflow. Descriptor-bearing frames are self-fenced to their cursor's terminal
identity and relevant sequence. A serialized screen reset is used when the
bounded timeline expires or startup bytes were dropped, and is explicitly
approximate. Copilot's experimental adapter-scoped PTY also uses a synthesized
reset after a foreground-session switch: transition output is buffered for the
new owner, but the hidden UI server cannot prove an exact native redraw
boundary. Only the lease holder may send sequenced input or resize. Takeover
is explicit and compares the currently visible lease. Slow viewers are
disconnected instead of backpressuring the PTY.

Terminal bytes, screen snapshots, and lease secrets are memory-only. They never
enter SQLite, metadata, fleet snapshots, normalized native events, or native
history. Runtime restart drops them; reopen a terminal and use structured native
history for conversation recovery.

## Terminal permissions and risk

`terminal-view` reveals opaque, unredacted harness and workspace output.
`terminal-control` can open a terminal, take the keyboard lease, type, resize,
and request supported termination. It is equivalent to keyboard access under
the runtime account's OS and harness credentials. Neither permission should be
treated as a harmless extension of fleet `read`.

Keep `AGENT_MULTIPLEX_RUNTIME_NODE_MAX_RUNNING_TERMINALS` conservative. Leave
Copilot terminal support off unless the loopback trust and exact-version risks
are accepted. Never persist or log a terminal lease secret.


## Native images

Adapters identify native image fields without rewriting arbitrary tool arguments
or user strings. Runtime image storage externalizes those leaves and returns
native envelopes to clients. Codex image inputs and Copilot blob attachments
retain their native forms when reconstructed immediately before dispatch; model
vision capabilities remain harness-specific. Path outputs become immutable
runtime snapshots, and missing/omitted bytes remain explicit unavailable slots.
See [images and native payloads](Images-and-Native-Payloads.md).
