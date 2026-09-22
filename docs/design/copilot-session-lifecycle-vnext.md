# Copilot Session Lifecycle vNext

Status: normative for lifecycle contract version 1 in Agent Multiplex protocol
v6. The executable definition is
[`packages/protocol/src/lifecycle.ts`](../../packages/protocol/src/lifecycle.ts).
The protocol reducer wins if prose and code disagree.

This design concerns one active Copilot binding. Catalog open/stopped/archived
lifecycle remains control-node authority, and native transcript content remains
Copilot-owned. The lifecycle state records payload-free evidence about work and
delivery. It does not interpret conversation prose or decide whether a user's
objective was achieved.

The words MUST, MUST NOT, SHOULD, and MAY describe protocol requirements. This
is a coordinated clean break: protocol-v5 and protocol-v6 processes must not be
mixed.

## Authority and evidence ownership

| Concern | Authority | Required behavior |
| --- | --- | --- |
| Logical session, catalog state, metadata, archive, authority tree | Control node | Remains canonical and independent of transient native work. |
| Native session, task, queue, interaction, event-log and message facts | Copilot CLI/SDK on the owning runtime | Supplies native facts. Absence is meaningful only from a complete, fresh native observation. |
| Copilot event interpretation | Copilot adapter | Converts an exact native envelope into payload-free lifecycle facts and forwards the original native envelope separately. |
| Lifecycle state and command/native correlation | Runtime node | Is the single lifecycle writer, persists the reduced state before publishing its projection, and owns the active binding fence. |
| Durable mutation admission and receipt | Runtime command journal, replicated through controls | Uses the original `commandId` and `payloadHash`; an ambiguous result remains `outcomeUnknown`. |
| Routing and selected-source generation | Gateway | Selects a validated control source, fences a read across source-generation changes, and acquires no domain authority. |
| Transcript and operator presentation | Client | Projects server evidence. It may retain drafts and view preferences, but must not manufacture native delivery or completion. |
| Transport connection generation | p2prpc integration | Carries authenticated RPC and subscriptions. A transport generation is neither a native runtime epoch nor lifecycle authority. |

Control nodes and gateways validate and route `sessions.readLifecycle`; they do
not independently reduce Copilot evidence. A session catalog record carries only
the bounded lifecycle projection. The full state is read from the owning runtime
through the selected control path.

## Normative state vector

The state is:

```text
(version, fence, nextSequence, continuity,
 root, tasks, children, queue, interactions,
 commands, displayedMessageIds, consumedMessageIds, compaction)
```

`version` is lifecycle contract version `1`. It is independent of wire protocol
version `6` so a later lifecycle revision can be negotiated deliberately.

| Dimension | Shape | Meaning, monotonicity and recovery |
| --- | --- | --- |
| `fence` | `(sessionId, runtimeNodeId, runtimeNodeBootId, bindingRevision, runtimeEpoch)` | Exact execution incarnation. Every member must match. A replacement boot, binding or native epoch starts an uncertified state; evidence never crosses the fence. |
| `nextSequence` | Nonnegative integer | Next runtime lifecycle-evidence sequence for this exact fence. Duplicate/old evidence is ignored. A jump invalidates certainty. |
| `continuity` | `continuous \| gap` | Whether projection has an unbroken baseline for the current foreground cycle. An authoritative replacement snapshot or new fence can clear a gap. A uniquely identified later root start establishes continuity for its new foreground cycle; a later root whole-session idle establishes a quiescent root boundary. Other invalidated dimensions retain their own unknown markers. |
| `root` | `{phase, cycle, outcome}` | Root model/session dimension. `phase` is `unknown`, `paused`, `idle`, or `working`; `paused` means only the model loop is idle, while `idle` requires a whole-session idle or fresh inactive activity observation. `cycle` is the unique observed root-start event ID or `null`; `outcome` is `none`, `finished`, `interrupted`, or `failed`. A new explicit root start clears the prior outcome. |
| `tasks` | `{revision, freshness, items}` | Complete bounded task observation for one invalidation revision. `freshness` is `unknown` or `observed`. Retained items under `unknown` are diagnostic only and cannot prove current presence or absence. |
| `children` | `{completeness, items}` | Bounded native subagent/child observations, independently keyed and in `running`, `completed`, `failed`, `settled`, or `unknown`. `partial` means absence is unproved. `settled` means a newer whole-session idle proved no child remained in flight without claiming that child's outcome. These are members of the owning Copilot session, never catalog sessions. |
| `queue` | `{revision, freshness, items, unidentifiedSteering, inFlightSteering}` | Complete bounded pending-message observation for one invalidation revision. Identified items retain native queue ID and optional logical message ID. Text-only steering is represented only by a count. `null` in-flight count means the native version did not establish it. |
| `interactions` | `{completeness, items}` | Exact known pending requests. `partial` means absence is unproved. Each item has a Multiplex interaction ID, explicit owner and native kind. |
| `commands` | At most 256 correlation records | Bounded working set for command admission, optional native message identity and independent `displayed`, `consumed`, and `settled` evidence. The unbounded original receipt source remains the durable command journal. |
| `displayedMessageIds` | At most 512 native logical message IDs | Allows an exact root display observed before its command acknowledgement to correlate later. It is not history retention. |
| `consumedMessageIds` | At most 512 native logical message IDs | Allows exact root consumption observed before acknowledgement to correlate later. It is independent of display and is not history retention. |
| `compaction` | `unknown \| running \| observedComplete` | Uncorrelated native compaction observation. It never settles a compact command by itself. |

Initial state is sequence zero with continuous delivery but uncertified native
dimensions: root, tasks, queue and compaction are unknown; child and interaction
hydration are partial; correlation sets are empty. `continuous` at initialization
means no runtime facts have been skipped. It does not make absence-sensitive
dimensions fresh.

## Identity and causality

Identity domains must remain distinct.

| Identity | Scope and use | Forbidden substitution |
| --- | --- | --- |
| `sessionId` | Stable Multiplex logical session | Vendor session ID, title, workspace or transcript text |
| `runtimeNodeId` + `runtimeNodeBootId` | Runtime owner and process incarnation | Transport peer/session generation |
| `bindingRevision` + `runtimeEpoch` | Installed logical-to-native binding and live native handle | Catalog revision, source generation or reconnect time |
| `commandId` + `payloadHash` | Durable admission, dedupe and receipt reconciliation | A new ID for a retry, event UUID, message text or elapsed time |
| Native logical `messageId` | SDK-assigned send/steer identity; may link acknowledgement, queue item and root `user.message` | Event UUID, queue position, content equality or queue disappearance |
| Native queue item ID | Exact queued-item control such as `sendNow` | Logical message ID unless the native snapshot explicitly supplies that field |
| Native event UUID and runtime native sequence | One event occurrence and its admitted runtime-stream order | Universal message ID; reused native `turnId` |
| Root `cycle` | Unique root `assistant.turn_start` event UUID | Native `turnId`, which the selected CLI can reuse |
| Task ID | Exact native task-control target | PID, display name, tool-call ID or child-agent ID |
| Child ID | Explicit namespace such as `tool:<toolCallId>` or `agent:<eventOwner>` | An inferred alias between agent, tool-call and task registries |
| Interaction ID | Exact Multiplex interaction record; native request ID is retained separately where supported | Prompt text, request order or a callback's timing |
| Source generation | Gateway selection/read fence | Lifecycle sequence, native sequence or authority epoch |
| Access feed/cursor | Control/source stream continuity | Copilot event-log cursor or task revision |
| Copilot event-log cursor | Opaque native history position and direction | Runtime native sequence or lifecycle sequence |

The supported SDK does not pass a caller operation or idempotency field through
`session.send`. Multiplex therefore cannot create a universal native causal ID.
It durably records the command identity before dispatch, appends a native logical
message ID only when the acknowledgement provides one, and correlates later
evidence only through that exact ID. If the acknowledgement or native echo lacks
the link, uncertainty is preserved.

Envelope `parentId` is chronological ancestry, not child ownership. Text, image
equality, event time, event adjacency, queue absence and catalog idle are never
causal evidence.

## Evidence ordering and fences

For an incoming lifecycle evidence envelope:

| Condition | Reducer action |
| --- | --- |
| Lifecycle version differs | Ignore it. Protocol decoding normally rejects it first. |
| Any fence member differs | Ignore it as evidence from another execution incarnation. |
| `sequence < nextSequence` | Ignore the duplicate or stale fact. |
| `sequence > nextSequence`, fact is not `rootStarted` | Do not apply the jumped-over fact. Mark continuity `gap`, invalidate absence-sensitive dimensions, and advance `nextSequence` to the incoming sequence plus one. |
| `sequence > nextSequence`, fact is `rootStarted` | Invalidate all dimensions, advance `nextSequence`, then accept the unique start as the continuous boundary for its new root cycle. Tasks, queue, children and interactions remain unknown. |
| `sequence === nextSequence` | Advance once and apply the fact below. |
| Exact `gap` fact | Apply the same invalidation after consuming its exact sequence. |

Invalidation clears root phase/cycle/outcome certainty; advances task and queue
revisions and marks both unknown; marks children unknown; clears interactions
and makes their completeness partial; and makes compaction unknown. It retains
command correlation, exact display/consumption IDs and old task/queue records.
Retained task/queue records are diagnostic only until their dimension is fresh.

Task and queue reads use two fences. The adapter rejects a reply if its native
invalidation revision changed during the SDK request. The runtime captures its
lifecycle revision before the read, drains already admitted adapter events after
the reply, and installs the observation only if the lifecycle revision still
matches. A delayed empty response therefore cannot erase a newer invalidation.
The runtime schedules both observations when it activates a Copilot binding and
schedules the affected observation again after an invalidation. A lifecycle gap
schedules both. Independent per-view lanes coalesce bursts and run one follow-up
generation when a successful in-flight read was invalidated; a failed read
contributes no evidence and is not retried until another trigger.

`sessions.readLifecycle` drains already admitted native payload work, rechecks
the installed binding, then returns `{state, nextNativeSequence}`. The lifecycle
sequence and raw native sequence are independent. A client performing a
snapshot/stream handoff subscribes first, buffers native items, reads the
snapshot, discards buffered native items below `nextNativeSequence` for the exact
runtime epoch, and commits the rest in order. Gateway source generation must stay
unchanged across the read.

## Exhaustive fact transition table

### Root, children and native observations

| Fact | Preconditions | State transition | Does not establish |
| --- | --- | --- | --- |
| `rootStarted(cycleId)` | Exact envelope; nonempty unique observed event ID | Set continuity `continuous` for this new foreground boundary and `root = {working, cycleId, none}`; other invalidated dimensions stay unknown | Which command caused the cycle or whether background dimensions are fresh |
| `rootModelIdle` | Exact envelope | Set root phase to `paused`; retain cycle and outcome | Whole-session drain, Ready or Finished |
| `rootObserved(active=false)` | Fresh native activity observation | Set phase to `idle`; retain cycle/outcome | Whole-session drain or Finished |
| `rootObserved(active=true)` while already working | Fresh native activity observation | Retain the current working cycle/outcome | A new cycle identity or command cause |
| `rootObserved(active=true)` while not working | Fresh native activity observation without a cycle identity | Set phase `working`, cycle `null`, outcome `none` | A unique cycle identity, delivery or later Finished |
| `rootFailed` | Root-owned native failure | Set phase `idle` and outcome `failed`; failure is the dominant terminal observation until a new root cycle | Background task cancellation |
| `rootIdle(aborted=true)` | Root-owned whole-session idle | Set continuity `continuous` and phase `idle`; preserve any prior terminal outcome, otherwise set `interrupted`; mark child completeness `complete` and running or unknown children `settled` | Successful completion or a child-specific outcome |
| `rootIdle(aborted=false)` | Root-owned whole-session idle | Set continuity `continuous` and phase `idle`; preserve any prior terminal outcome, otherwise set `finished` when a cycle exists or `none` when it does not; mark child completeness `complete` and running or unknown children `settled` | User-objective success, child-specific success or per-command settlement |
| `child(id,running)` | Exact namespaced child identity | Upsert running child while retaining the current completeness | Task-record identity, root work or absence of another child |
| `child(id,completed\|failed)` | Exact same identity domain | Upsert terminal child observation while retaining the current completeness | Another task/tool/agent alias or complete child absence |
| `childrenHydrated(items,complete=true)` | Producer observed the binding from its beginning or has an authoritative complete snapshot | Replace the bounded set and mark complete | A mapping to task records |
| `childrenHydrated(items,complete=false)` | Partial resume/reconnect observation | Merge exact records and retain partial completeness | Absence of unobserved children |
| Child capacity exceeded | A new record would exceed 256 | Invalidate continuity | Silent eviction presented as complete state |
| `tasksInvalidated` | Native task-change signal | Increment task revision and mark freshness unknown | Any particular task delta |
| `tasksObserved(revision,items)` | Revision exactly equals current revision | Replace items and mark observed | Root completion |
| Stale/future task observation | Revision differs | Consume the fact sequence but leave tasks unchanged | Fresh emptiness |
| `queueInvalidated` | Native pending-message change | Increment queue revision and mark freshness unknown | Delivery or removal reason |
| `queueObserved(revision,...)` | Revision exactly equals current revision | Replace the full bounded queue/counts and mark observed | Transcript commit or consumption |
| Stale/future queue observation | Revision differs | Consume the fact sequence but leave queue unchanged | Fresh emptiness |
| `compaction(running\|observedComplete)` | Root-owned native compaction event | Replace compaction phase | Compact command causality, success, receipt or session settlement |

The root `session.idle` rule marks child completeness `complete` and may mark
running or gap-unknown children `settled` because the pinned native contract
defines that root event as having no background agents or attached shell commands
in flight. It does not invent `completed` or `failed`. Tasks remain independent:
a task snapshot is never rewritten by root idle.

### Interactions

| Fact | Transition |
| --- | --- |
| `interactionOpened(item)` | Upsert by exact Multiplex interaction ID. Positive root ownership can project Waiting for input even while hydration is partial. |
| `interactionClosed(id)` | Remove only the exact ID. An unrelated close is a no-op. |
| `interactionsHydrated(items, complete)` | Atomically replace the bounded set and set `complete` or `partial`. |
| Interaction capacity exceeded | Invalidate continuity instead of dropping an arbitrary request. |

Child interactions remain visible records but do not make the root session
Waiting for input. Fresh creation emits a complete empty baseline before any
synchronously buffered callback, because the adapter observes the binding from
its beginning; later positive callback facts extend that set. Resume emits a
partial baseline because the SDK cannot enumerate ephemeral requests that may
already have been pruned. A reconnect snapshot may claim `complete` only when a
native source enumerates every pending kind and owner for this exact binding.

### Command admission and delivery

| Fact | Transition |
| --- | --- |
| `commandPrepared(id,hash,kind)` | Insert with admission `prepared` and all evidence bits false. An exact duplicate is idempotent. Reuse with a different hash or kind is an identity conflict. At the 256-record bound, prefer evicting a correlation already failed, settled, displayed, consumed, or otherwise no longer useful; otherwise evict the oldest entry. Eviction loses optional lifecycle refinement but does not alter the durable command journal, which remains the full receipt source. |
| `commandReceipt(...,dispatched)` | Advance a known command to dispatched unless stronger evidence already exists. |
| `commandReceipt(...,outcomeUnknown)` | Preserve ambiguity. It cannot later regress to dispatched. |
| `commandReceipt(...,accepted)` | Establish the native command acknowledgement and optional logical message ID. It may refine outcomeUnknown. |
| `commandReceipt(...,failed)` | Establish definite failure. It may refine outcomeUnknown. |
| Receipt for an unknown bounded command | Ignore it; query the durable command journal by original ID. |
| Hash or nonempty message-ID conflict | Throw an identity conflict and leave state unchanged. |
| Accepted/failed contradiction | Throw a terminal receipt conflict. Accepted and failed never downgrade each other. |
| `messageDisplayed(messageId,root)` | Retain the exact root display and mark commands with that exact native message ID displayed. Display-before-ack and ack-before-display converge. |
| Display without message ID, or child display | No delivery transition. |
| `messageConsumed(messageId,root)` | Retain the exact root consumption and mark only commands with the exact native message ID consumed. Copilot emits this in addition to Displayed only when the same `user.message` has a nonempty `turnId`. |
| `commandSettled(id,hash)` | Mark only the exact command settled. |

`displayed`, `consumed` and `settled` are independent monotonic evidence bits.
They never arise from elapsed time, an empty queue, root idle or a successful
generic receipt.

## UI projections

Session state and per-command delivery are two projections. A UI should display
stream/history health alongside the main label when evidence is incomplete.

### Session label precedence

The first matching row wins:

| Priority | Label | Exact predicate and meaning |
| ---: | --- | --- |
| 1 | **Offline** | The selected source/current binding is unreachable or inactive according to outer routing/presence state. It says nothing about native completion. |
| 2 | **Unknown** | Lifecycle continuity is `gap`. It outranks interaction records because invalidation may have lost a close event. |
| 3 | **Waiting for input** | Under continuous evidence, at least one known interaction is owned by `root`. Positive input evidence is actionable even when absence is incomplete. |
| 4 | **Failed** | Root outcome is `failed`. |
| 5 | **Interrupted** | Root outcome is `interrupted`. |
| 6 | **Working** | Root phase is `working`. |
| 7 | **Waiting for child/task** | Root is not working and either a child is running or a fresh task snapshot contains `status: running`. |
| 8 | **Queued** | A fresh queue contains an item, unidentified steering count is positive, or known in-flight steering is positive. |
| 9 | **Unknown** | Root phase is unknown or only model-paused; task freshness or queue freshness is unknown; in-flight steering is `null`; child or interaction hydration is partial; or any child is unknown. |
| 10 | **Finished** | Root outcome is `finished` and every absence-sensitive dimension is known with no higher-priority blocker. This means an observed non-aborted whole-session idle followed an observed root cycle. It is not a business-level success assertion. |
| 11 | **Ready** | Root is idle with outcome `none`, all absence-sensitive dimensions are fresh/complete, and there is no queued, child/task or input work. It means ready to accept work. |

The runtime-published catalog projection is online-only and is removed when the
binding is inactive. Clients derive Offline from source, runtime and binding
availability; they must not expect an Offline lifecycle row from an unreachable
runtime.

The reference web consumes this bounded `SessionRecord.lifecycle` label in its
session rail and console header, derives Offline from runtime/binding presence,
and treats an active Copilot row without a projection as Unknown. It does not
currently query the full `readLifecycle` state; consumers that need individual
dimensions or the native-sequence handoff use that separate read.

### Delivery label precedence

| Priority | Label | Meaning |
| ---: | --- | --- |
| 1 | **Settled** | Exact command-specific settlement was recorded. |
| 2 | **Consumed** | A root `user.message` carried both the exact logical message ID and a `turnId`, establishing that an agent-loop turn consumed it. |
| 3 | **Displayed** | A root `user.message` displayed content with the acknowledged logical message ID. This is native event-log evidence, not proof that a browser painted a frame. |
| 4 | **Queued** | A fresh native queue contains an item carrying the command's exact logical message ID. |
| 5 | **Accepted** | The native command acknowledged admission/result. It does not establish display, consumption or session completion. |
| 6 | **Dispatched** | The owning runtime crossed the dispatch boundary. A lost reply after this point can be outcome unknown. |
| 7 | **Prepared** | The runtime durably registered the correlation record before native execution. |
| 8 | **Failed** | A definite terminal command failure was recorded. |
| 9 | **Unknown** | Admission is `outcomeUnknown`; the original effect may already exist or may appear later. |

For delivery projection, Settled, Consumed and Displayed outrank a failed or
unknown admission only when exact stronger evidence exists. Current Copilot
producers establish Accepted, exact Queued, Displayed and conditional Consumed.
Settled remains reserved until the native boundary supplies an authoritative
command-specific fact.

## Normal flows

### Send or steer

1. The client creates one `commandId` and canonical payload hash and durably
   retains the exact envelope before dispatch where its product requires crash
   recovery.
2. Runtime binding checks pass, then the runtime records `commandPrepared` and
   `dispatched` before calling the adapter.
3. Copilot `send` uses native enqueue mode; `steer` uses immediate mode. A
   nonempty returned native logical message ID produces `accepted(messageId)`.
4. A fresh queue snapshot may project Queued only when its item carries that
   exact logical message ID. Queue drain can return the delivery label to
   Accepted; it does not synthesize display.
5. A root `user.message` with the same logical message ID produces Displayed. If
   it also has a nonempty `turnId`, it produces Consumed. Acknowledgement and the
   native event may arrive in either order.
6. Consumption and settlement require later exact facts. Whole-session idle does
   not settle the command automatically.

If the native root echo omits `messageId`, the transcript can render the native
message while this command remains Accepted or Unknown. Same text, images, event
UUID and timing cannot close that causal gap.

### Root plus children and tasks

`rootStarted` re-establishes continuity for the new foreground cycle and projects
Working. A child or shell task can start concurrently.
`assistant.idle` changes only the root phase to paused; a fresh running task or child then
projects Waiting for child/task. A non-aborted root `session.idle` records the
root-cycle outcome and marks running child observations settled without choosing
their result, while a separately fresh running task still keeps the session at
Waiting for child/task. Failed or cancelled task rows do not by themselves create
a root Failed outcome.

### Blocking interaction

An admitted root interaction projects Waiting for input immediately. Resolution
or a native completion closes only the exact interaction. Child interaction
ownership remains separate. Fresh creation can prove initially empty complete
child and interaction sets because every callback is observed from the
beginning. Resume, reconnect, and post-gap recovery remain partial without a
complete native enumeration; an empty partial hydration cannot produce Ready or
Finished. A later root `session.idle` proves child completeness, but it does not
prove interaction absence. Plan approval is an interaction result; acknowledged
mode must still come from the native mode observation.

### Interrupt, failure and compaction

A root `session.idle` with `aborted:true` produces Interrupted. A root
`session.error` produces Failed, and later non-aborted idle preserves that
failure. Native compaction start/complete changes only the compaction dimension;
the native event has no Multiplex command identity, so it cannot rewrite an
unknown compact receipt.

## Recovery, crash and gaps

### Command uncertainty

`outcomeUnknown` is terminal uncertainty for dispatch policy, not proof of
failure. No gateway, control, runtime, browser, reconnect or transport renewal
may redispatch it automatically. Recovery reads the durable receipt by the
original command ID and validates the hash, session, runtime and immutable
request. A later authoritative accepted or failed receipt may refine the
lifecycle record. A later native effect without exact command identity remains
uncorrelated.

The runtime persists the command receipt before appending its derived lifecycle
receipt. On an unchanged execution fence, lifecycle read repairs that crash
window from the command journal using command/session/runtime/hash identity and
never dispatches. Runtime startup converts durable `received`/`started` command
rows to `outcomeUnknown`. If a crash occurred before the command entered the
bounded lifecycle window, the command receipt remains recoverable through
`commands.get` even though the lifecycle view has no correlation row.

### Stream gap or reset

An access `nativeGap`, lifecycle sequence jump, extraction overflow or invalid
native payload invalidates continuity. A control feed/source reset also invalidates
the consumer's projection. Clients must:

1. retain original command receipts and drafts without replay;
2. obtain a fresh validated catalog/source snapshot;
3. call `readLifecycle` for the exact current binding;
4. re-establish raw native stream order using `nextNativeSequence`;
5. use bounded native history for transcript repair;
6. let the runtime-owned coalesced task and queue observations refresh under
   their current invalidation revisions; and
7. keep interaction completeness partial unless an authoritative pending-request
   snapshot proves completeness, and keep child completeness partial until a
   whole-session idle or authoritative child snapshot proves quiescence.

Native primary history repairs a transcript window. It excludes ordinary child
chatter and cannot reconstruct a complete task, queue or interaction snapshot.
An expired opaque history cursor requires a window reset. History never authorizes
mutation replay.

A new exact root start can establish continuity for that new foreground cycle
after a gap. A later root whole-session idle can instead establish a quiescent
root boundary and complete the child dimension; with the lost cycle identity it
does not invent Finished. Tasks, queue and interactions remain unknown until
their own authoritative evidence refreshes them, so Finished and Ready still
fail closed. Without either native root boundary, only an authoritative
replacement snapshot or new fence can clear the gap.

### Binding replacement and late work

A new runtime boot, binding revision or runtime epoch creates a new fence and an
uncertified lifecycle state. Late adapter callbacks and command replies from the
retired binding may finish their durable original receipts, but they must not
advance the replacement lifecycle. Disconnect never moves authority or starts a
second native agent.

## Invariants

Every implementation and projection must preserve these properties:

1. Exactly one runtime writer reduces lifecycle evidence for an active fence.
2. No evidence crosses a runtime boot, binding revision or runtime epoch.
3. Sequence gaps reduce certainty; they never imply idle, Finished or failure.
4. A successful command receipt is independent of native display, consumption,
   root outcome, children, tasks, queue and interactions.
5. An empty or unavailable queue is never message-delivery evidence.
6. Only a fresh exact-revision task snapshot can prove task absence.
7. Root model idle is weaker than whole-session idle.
8. Child and root ownership are explicit, and child events cannot consume root
   delivery evidence or alter root settings.
9. Text, time, event UUID, chronological parent, queue position and queue absence
   never replace a missing native logical message ID.
10. `outcomeUnknown` is never automatically replayed and may be refined only by
    the original identity's authoritative receipt.
11. Failed and accepted terminal receipts cannot downgrade or contradict each
    other; identity conflicts fail closed.
12. Offline, Unknown, Ready and Finished are projections, not new sources of
    native or catalog authority.
13. Gateway and browser caches can retain presentation continuity but cannot
    assert native freshness.
14. Compaction observation remains independent of compact-command causality.

## Protocol-v6 package break and migration matrix

Protocol v6 uses exact `z.literal(6)` peer descriptors. There is no mixed-version
fallback or compatibility branch.

| Package / process | Protocol-v6 responsibility | Persistence / migration |
| --- | --- | --- |
| `@arduano/agent-multiplex-protocol` | Lifecycle schemas, reducer, projections, `readLifecycle`, typed command errors and exact v6 descriptors | Wire break; lifecycle contract version is 1. |
| `@arduano/agent-multiplex-adapter-copilot` | Emit exact root/child/invalidation/display/compaction facts; fence task and queue reads; preserve raw native envelopes | No adapter-owned store. SDK/CLI pins remain qualification boundaries. |
| `@arduano/agent-multiplex-runtime-node-core` | Single writer, full lifecycle read, native-cursor handoff, command-receipt repair and catalog projection | Append runtime store v6 typed-error migration and v7 `lifecycle_state`. Old binaries must not open the upgraded store. |
| Runtime app | Advertise protocol v6 and expose the runtime contract | Restart into the lockstep package graph during the maintenance window. |
| `@arduano/agent-multiplex-control-node-core` | Route/fence lifecycle reads; carry bounded session projections; preserve catalog authority | Control store v7 converts command errors and rotates the feed. Obtain a new snapshot; discard old replay/import checkpoints as the migration does. |
| Control app / isolated worker | Forward `readLifecycle` as a read and reject non-v6 peers | Main and worker must use identical package bytes. |
| `@arduano/agent-multiplex-transport-p2prpc` | Bind the new read procedure and exact v6 descriptors | No local/file dependency may be committed. Seamless renewal is the external boundary below. |
| `@arduano/agent-multiplex-client-p2prpc` | Forward lifecycle reads and typed receipts over the selected control source | No domain store. Late transport generations must be fenced. |
| `@arduano/agent-multiplex-gateway-core` and gateway app | Generation-fence lifecycle reads and validate runtime/binding/boot identity | No authoritative migration. Require a fresh validated source snapshot after control feed rotation. |
| `@arduano/agent-multiplex-client` | Preserve monotonic access cursors and read original command receipts without dispatch | No authoritative migration. Product-owned durable draft/receipt stores require their own CAS migration. |
| Web client and CLI | The web renders lifecycle labels and derives Offline from routing state; the CLI consumes the v6 wire contract and typed command errors | The reference web consumes the bounded `SessionRecord.lifecycle` label in its rail/header and fails active Copilot rows without it to Unknown. It does not yet query full lifecycle snapshots. The CLI does not currently render lifecycle labels. External consumers must replace duplicate reducers in the same cutover. |
| Codex/mock adapters | Compile against v6 while leaving the Copilot-specific lifecycle read unsupported unless explicitly implemented | No Copilot inference is shared into other harnesses. |
| `@arduano/agent-multiplex-storage-sqlite` | Execute append-only owner migrations and backup/integrity policy | Contains no lifecycle-domain authority of its own. |
| Archived `apps/host` / `packages/host-core` | None | Protocol-v2 evidence; do not build, migrate or use as a compatibility layer. |

The maintained Copilot implementation currently produces root, child, task/queue
invalidation and observations, known interactions, command admission/receipts,
exact display/conditional-consumption facts and compaction observations.
It emits complete empty child and interaction hydration before callbacks for
fresh creation, and partial empty baselines for resume. A root `session.idle`
can later prove child quiescence. Complete interaction hydration after resume,
reconnect, or a gap remains unavailable because the SDK cannot list all pending
ephemeral requests. `commandSettled` has no maintained Copilot producer. Those
interaction-partial sessions therefore remain Unknown once stronger positive
states are absent until exact completeness is available.

## Transport-renewal boundary

The separately owned p2prpc renewal implementation must satisfy this contract:

1. Authenticate the same endpoint and preserve control identity, authority,
   feed, runtime node/boot, binding revision and runtime epoch before declaring
   continuity.
2. Fence every response and subscription callback by transport generation so a
   retired connection cannot advance its replacement.
3. Resume subscriptions from the last consumer-committed access cursor. Cursor
   advancement occurs only after the consumer accepts the item.
4. Preserve monotonic native sequence within its runtime epoch and control cursor
   within its feed. Proven overlap may suppress duplicates; it must not hide a
   missing range.
5. Emit an explicit reset/gap and require snapshot recovery whenever identity,
   feed, cursor coverage or overlap is unproved.
6. Dispatch each mutation at most once. A reply lost at renewal remains an
   original-command receipt lookup; renewal never resends it.
7. Keep source selection and aggregate authority rules unchanged. Transport
   continuity alone does not mint authority or prove native health.

Current p2prpc `0.2.1` retires an authenticated session and reconnects at its
boundary; seamless renewal is not qualified by this lifecycle work. This design
does not inspect, duplicate or merge the external renewal implementation.

## Coordinated maintenance window and rollback

Before the window, build and verify one exact v6 package graph, drain admitted
mutations where possible, identify every control/runtime database, and take
coherent backups including SQLite WAL state. Preserve every unresolved command
ID and do not resolve uncertainty by replay.

Upgrade in this order:

1. Stop external clients and gateways from admitting work.
2. Quiesce all maintained controls and runtimes. Install the same v6 graph on
   every maintained role while all peers are offline.
3. Migrate authority and branch control stores from the root outward. The v6
   command-error migration rotates control feeds.
4. Migrate runtime stores, adding typed command errors and lifecycle state.
5. Start authority controls, then attached branch controls from parent to child;
   reject every v5 peer.
6. Start runtimes against their owning v6 controls. Validate runtime boot,
   binding revisions and command-journal recovery before admitting commands.
7. Start gateways, require fresh validated source snapshots and new feed cursors,
   then start web, CLI and other consumers.
8. For active Copilot bindings, subscribe before snapshot, read lifecycle, verify
   the runtime-owned task/queue observations became fresh, preserve partial
   interaction completeness for resumed bindings, and verify no command was
   automatically replayed.

Rollback is an offline store-set restore, not a binary downgrade in place. Stop
all v6 roles, restore the matching pre-upgrade control and runtime backups as one
set, discard gateway/client cursors from the v6 feeds, and reinstall the matching
v5 graph. A v6 binary must not talk to restored v5 peers, and a v5 binary must
not open migrated stores. If v6 admitted commands or native side effects after
the backup, restoring would discard receipts; reconcile those original IDs and
prefer a forward fix. Ambiguous commands are never replayed during rollback.

## Explicit native SDK limitations

Pinned SDK `1.0.13` / selected CLI `1.0.81` do not provide:

- a caller-supplied operation/idempotency ID echoed by send, queue, consumption
  and compaction evidence;
- a guaranteed logical message ID on every native root `user.message` event;
- an atomic task or pending-queue snapshot with a native cursor and sequenced
  deltas;
- a complete pending user-input/elicitation/exit-plan snapshot after reconnect;
- callback request identity plus an acknowledgement within the callback promise;
- a supported alias map across task, agent and tool-call identity domains; or
- a guaranteed consumption marker on every displayed message, or per-command
  settlement evidence.

Exact-ID UI response RPCs exist, but without a complete pending snapshot they
cannot safely replace callbacks. Permission hydration is also incomplete for
owner identity. Until an SDK/CLI contract supplies these pieces, positive known
evidence remains useful and absence remains Unknown. No model prompt, private
conversation read or dependency pin change was used to establish these limits.
