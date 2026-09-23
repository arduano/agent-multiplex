# Copilot Session Lifecycle vNext evidence audit

Date: 2026-09-22. Baseline:
`c28811b320f436acbec332b00199716a3c62cfa7`. Worktree branch:
`feat/copilot-session-lifecycle-vnext-20260922`.

The external evidence directory was verified before use with the required
command:

```text
cd /home/arduano/.local/state/leo-agents-tasks/copilot-lifecycle-vnext-20260922 && sha256sum -c SHA256SUMS
BRIEF.md: OK
CURRENT-AUDIT.md: OK
STABILITY-CONTEXT.md: OK
```

Those files remained outside the worktree and were not modified. This audit
then checked the maintained source, lifecycle implementation,
pinned SDK/CLI declarations and JavaScript, and deterministic test sources. It
did not inspect the separate p2prpc renewal worktree, credentials, private
conversation content, production services, or live native sessions. No model
request, deployment or restart was used. The owner-authorized Copilot update
pins SDK `1.0.14` and CLI `1.0.88`; the public p2prpc pin remains unchanged.

Verdicts mean:

- **Confirmed**: exact maintained source or pinned dependency behavior supports
  the assertion at the stated scope.
- **Disproved**: the assertion is false at that scope; the corrected behavior is
  stated.
- **Conditional**: true only for a named consumer, capability, freshness fence,
  identity field or historical evidence set.
- **Untestable**: the available local and authorized evidence cannot establish
  it.

Test paths below are executable-evidence anchors. This document does not claim
they passed in the final combined tree; exact executions belong in the final
handoff receipt.

## Messages, history and native streaming

| Supplied assumption | Verdict | Exact local evidence and conclusion |
| --- | --- | --- |
| Historical root conversation is read through `sessions.readNativeHistory` | **Confirmed.** | Access/control/runtime contracts route the read to the owning adapter (`packages/protocol/src/contracts.ts`, `packages/control-node-core/src/service.ts:1136-1146`, `packages/runtime-node-core/src/service.ts:910-915,974-1005`). Native history remains separate from the live stream. |
| Copilot primary history uses `eventLog.read({agentScope:"primary"})` and opaque cursors | **Conditional.** | Confirmed when the caller explicitly selects primary view. `packages/adapter-copilot/src/session.ts:653-665` and `primary-history.ts`; pinned contract evidence is recorded in `docs/audits/copilot-sdk-lifecycle-vnext.md:23-31`. Cursor expiry and same-input-cursor size retry are explicit. |
| Every maintained reference-browser Copilot history read uses primary paging | **Disproved.** | `apps/web/src/client/native-history.ts` uses the legacy bounded read and does not select primary view. The 25/100-event external consumer policy in the supplied audit belongs to Leo, not this reference console. See `docs/copilot-lifecycle-browser-audit.md:23`. |
| Primary history contains root events plus subagent lifecycle summaries and excludes ordinary child chatter | **Confirmed.** | This is the native primary contract in `packages/adapter-copilot/src/primary-history.ts`, pinned SDK `generated/rpc.d.ts`, and adapter primary-history tests. It is not a complete child transcript. |
| Live native delivery carries all root/child events with runtime epoch and sequence | **Confirmed.** | Through the adapter/runtime boundary, `CopilotSessionBridge.nativeEvent` forwards the native envelope before lifecycle normalization (`packages/adapter-copilot/src/session.ts:167-183`); runtime publication assigns the binding epoch and monotonic native sequence (`packages/runtime-node-core/src/service.ts:2779-2811`). |
| Control/gateway/client replay exposes gaps and resets rather than silently splicing history | **Confirmed.** | The maintained layers include the formerly missing control requested-ahead case. Runtime replay: `packages/runtime-node-core/src/event-hub.ts:127-162`; control replay: `packages/control-node-core/src/event-hub.ts:266-310`; gateway replay: `packages/gateway-core/src/projection.ts:2348-2395`; cursor regression source: `packages/control-node-core/test/event-hub-native-dedup-v3.test.ts:53-97`. |
| Native message finals/deltas, reasoning, tools, hidden continuation messages and empty completion fences have distinct transcript semantics | **Conditional.** | Confirmed for transcript normalization in `apps/web/src/client/transcript.ts` and its regressions. The lifecycle reducer intentionally records only causal work/delivery facts and is not a second transcript parser. |
| A native `user.message` always has the logical message ID returned by send | **Disproved.** | Pinned SDK `UserMessageData.messageId` is optional; selected CLI emission can omit it. `packages/adapter-copilot/test/sdk-lifecycle-contract.test.ts` and `docs/audits/copilot-sdk-lifecycle-vnext.md:25-28` anchor the exact pin behavior. Text, UUID and chronology are rejected substitutes. |
| An exact root `user.message.messageId` establishes Displayed | **Confirmed.** | Pinned `UserMessageData` identifies displayed user content. The Copilot normalizer emits `messageDisplayed` only for a root event with that exact ID; reducer correlation is in `packages/protocol/src/lifecycle.ts`. Browser paint is outside this evidence meaning. |
| The same root message establishes Consumed only when it has `turnId` | **Conditional.** | Confirmed only when both exact fields exist. The pinned declaration describes `turnId` as present when an agent-loop turn consumed the message. The adapter emits an additional `messageConsumed` only for exact `messageId` plus nonempty `turnId`; missing identity leaves consumption unknown. Adapter normalization regressions live in `packages/adapter-copilot/test/lifecycle.test.ts`. |
| `turnId` is a universal root-cycle identity | **Disproved.** | Selected CLI declares a stringified loop counter and can reuse it. `assistant.turn_start` event UUID is the observed cycle fence (`packages/adapter-copilot/src/lifecycle.ts`; repeated-counter regression in `packages/adapter-copilot/test/lifecycle.test.ts`). It still does not identify the originating command. |

## Subagents and background work

| Supplied assumption | Verdict | Exact local evidence and conclusion |
| --- | --- | --- |
| Copilot children are native agents/tasks inside one Multiplex session, not catalog sessions | **Confirmed.** | Adapter lifecycle facts carry namespaced child observations; no catalog row is created (`packages/adapter-copilot/src/lifecycle.ts`, `packages/protocol/src/lifecycle.ts`). |
| Envelope `parentId` is child ownership | **Disproved.** | It is chronological ancestry. The normalizer uses explicit envelope/data agent ownership or legacy tool-call ownership and never reads chronological `parentId` (`packages/adapter-copilot/src/lifecycle.ts:3-23`). |
| Agent ID, task ID and tool-call ID can be freely aliased | **Disproved.** | `tool:<toolCallId>` and `agent:<eventOwner>` remain separate reducer keys. Exact task controls use task IDs. See adapter lifecycle and task tests. |
| `assistant.turn_end` or `assistant.idle` finishes a delegated task | **Disproved.** | `assistant.turn_end` emits no lifecycle fact; `assistant.idle` changes only root model phase. `packages/adapter-copilot/test/lifecycle.test.ts:28-38` and protocol orthogonality tests encode the distinction. |
| Explicit child completion/failure or child `session.idle` settles that exact child | **Confirmed.** | `subagent.completed/failed` uses exact tool-call identity; child-owned `session.idle/error` uses the event-owner domain (`packages/adapter-copilot/src/lifecycle.ts:13-24`). |
| A newer root `session.idle` may establish that no observed child remains in flight | **Confirmed.** | This is outcome-unspecified settlement. Pinned native declaration says no background agents or attached shell commands remain. The reducer marks child completeness `complete` and changes running or gap-unknown children to `settled`, not `completed`; it does not invent child success. Tasks remain a separate snapshot dimension. |
| Primary history is sufficient for complete child chatter and current child state | **Disproved.** | It contains lifecycle summaries, not ordinary child chatter. Live client child stores are bounded and partial; a gap makes current child state unknown. |

## Tasks and pending queue

| Supplied assumption | Verdict | Exact local evidence and conclusion |
| --- | --- | --- |
| Full task state is an authoritative pushed record stream | **Disproved.** | The supported path calls `tasks.refresh()` then `tasks.list()` through `sessions.readNativeState`; `session.background_tasks_changed` is only invalidation (`packages/adapter-copilot/src/session.ts:720-740`, `packages/adapter-copilot/src/lifecycle.ts`). |
| The SDK task snapshot is atomic with a native cursor or sequenced delta feed | **Disproved.** | Pinned SDK exposes separate refresh/list and no snapshot cursor/watch primitive. Actual installed surface is exercised in `packages/adapter-copilot/test/sdk-lifecycle-contract.test.ts:30-38`. |
| Task invalidation plus coalesced reads prevents a delayed empty snapshot from erasing newer evidence | **Confirmed.** | Adapter native revisions reject invalidation during an SDK read; runtime lifecycle revisions reject an observation invalidated before event drain. The server schedules both reads at activation, serializes them per binding and retries failed or malformed replies indefinitely with bounded backoff. At 45 seconds without success it degrades the binding and freezes Copilot mutation admission. Regressions: `packages/adapter-copilot/test/tasks.test.ts`, `packages/runtime-node-core/test/lifecycle-refresh.test.ts`, and `packages/protocol/test/lifecycle.test.ts`. Missed native notifications remain a limitation. |
| Task polling is the new lifecycle authority | **Disproved.** | The runtime writer installs revision-fenced explicit observations. It proactively schedules them on binding activation, native invalidation and lifecycle gaps; `readLifecycle` itself performs no SDK call, and ordinary caller `readNativeState` results do not mutate lifecycle evidence. External fleet/browser polling policies remain consumer repair mechanisms, not authority. |
| Only fresh native `running` tasks can override Ready/Finished | **Confirmed.** | `projectLifecycle` requires `tasks.observation.state === "observed"` before a running item can project Waiting for child/task (`packages/protocol/src/lifecycle.ts`). Unknown/stale data projects Unknown once no stronger positive state wins. |
| Exact-ID cancel/promotion is durable; native false is definite refusal/no-op and a missing reply is uncertain | **Confirmed.** | `packages/adapter-copilot/src/tasks.ts`, command handling in `session.ts`, task command regressions, and `docs/wiki/Adapters-and-Terminals.md:217-263`. No PID/text fallback exists. |
| Queue disappearance proves message display or consumption | **Disproved.** | Queue observation is independent. The reducer uses an exact queue item `messageId` only for the temporary Queued projection; drain returns to the underlying admission state. Queue invalidation regression: `packages/adapter-copilot/test/session-state.test.ts:118-134`; reducer regression: `packages/protocol/test/lifecycle.test.ts`. |
| Text-only steering entries have stable queue identity | **Disproved.** | Runtime preserves them only as `unidentifiedSteering` count and never synthesizes IDs from text or array position (`packages/runtime-node-core/src/service.ts:956-965`). |

## Completion, waiting and delivery

| Supplied assumption | Verdict | Exact local evidence and conclusion |
| --- | --- | --- |
| Copilot exposes one authoritative Finished Boolean | **Disproved.** | The executable vector keeps root phase/outcome, children, tasks, queue, interactions, continuity and command evidence independent (`packages/protocol/src/lifecycle.ts:35-52`). |
| `assistant.idle` is weaker than root `session.idle` | **Confirmed.** | Adapter emits `rootModelIdle` versus `rootIdle`; the latter carries `aborted` and the pinned native no-background-work contract. |
| Root `session.idle` proves the user's objective succeeded | **Disproved.** | It can establish a non-aborted observed-cycle outcome called Finished only after every absence-sensitive dimension is known. The design explicitly limits Finished to observed session settlement, not business success. |
| Root interaction, queue, tasks, children, root work, errors, connection and command certainty are orthogonal | **Confirmed.** | State vector and transition schedules: `packages/protocol/src/lifecycle.ts`; `packages/protocol/test/lifecycle.test.ts`. |
| Catalog idle/Ready or a successful command receipt proves whole-session completion | **Disproved.** | Catalog status is a bounded runtime projection; command success means adapter execution/result. `projectDelivery` and `projectLifecycle` are separate. |
| Disconnection or a stream gap can become Finished | **Disproved.** | Offline is an outer availability projection; a gap projects Unknown. Neither reducer path creates a root finished outcome. |
| Delivery has distinct prepared, dispatched, accepted, queued, displayed, consumed and settled milestones | **Confirmed.** | The vNext contract has these distinct fields, with producer limits. Command shape and reducer are in `packages/protocol/src/lifecycle.ts`; acceptance, exact queue, native display and conditional consumption have maintained producers. `commandSettled` is reserved and has no maintained Copilot producer. |
| Multiplex command ID/payload hash is durable admission identity | **Confirmed.** | Runtime command journal validates ID, hash, session, runtime and immutable request (`packages/runtime-node-core/src/service.ts:2965-3053`); client receipt validation is `packages/client/src/command-recovery.ts`. |
| Native logical message ID and queue item ID are separate | **Confirmed.** | SDK send returns a native-assigned message ID; pending items have their own IDs and optional message ID. The lifecycle schemas preserve both. |
| Root display/consumption may correlate by text, event UUID or queue disappearance when message ID is absent | **Disproved.** | Adapter and reducer ignore all those substitutes. `packages/adapter-copilot/test/lifecycle.test.ts` and `packages/protocol/test/lifecycle.test.ts` exercise missing identity and root/child separation. |
| Whole-session idle automatically settles a particular send, steer or compact command | **Disproved.** | Root cycle has no command-causal link. `commandSettled` requires exact command ID/hash and is never synthesized from idle or compaction observation. |
| `outcomeUnknown` can be retried after reconnect/failover | **Disproved.** | Runtime/control/gateway and client recovery retain the original ID. Reducer allows later authoritative accepted/failed refinement and forbids downgrade; `packages/protocol/test/lifecycle.test.ts:94-105`. |

## SDK identity and interaction assumptions

| Supplied assumption | Verdict | Exact local evidence and conclusion |
| --- | --- | --- |
| A universal Multiplex operation ID can be passed through `session.send` and echoed by Copilot | **Disproved.** | For SDK 1.0.14 / CLI 1.0.88, installed SDK serializes an explicit field list and drops caller operation/message/causal IDs. The executable inert-connection probe is `packages/adapter-copilot/test/sdk-lifecycle-contract.test.ts`. |
| SDK assistant origin correlation supplies Multiplex command causality | **Disproved.** | SDK 1.0.14 adds optional `AssistantMessageData.originatingMessageId`, matching the native ID returned by `session.send`, plus a forwarded provenance `source`. This improves assistant-output correlation but neither accepts a caller operation ID nor identifies compaction, task settlement, interaction acknowledgement, or whole-session idle. |
| Exact-ID user-input, elicitation and exit-plan response RPCs do not exist | **Disproved.** | Pinned SDK exposes `handlePendingUserInput`, `handlePendingElicitation` and `handlePendingExitPlanMode`; the executable surface probe checks them. Native false means nothing pending was resolved. |
| Those exact response RPCs provide complete reconnect hydration | **Disproved.** | `rpc.ui` has no pending snapshot/list; relevant events are ephemeral and may be pruned. SDK callback paths strip request identity and submit answers separately. `packages/adapter-copilot/test/sdk-lifecycle-contract.test.ts` locks the installed surface. |
| Callback resolution is a durable native answer acknowledgement | **Disproved.** | The callback promise resolves before the SDK's separate native response submission settles. Current callback handling is retained as a staged limitation. |
| Permission hydration is complete for owner identity | **Disproved.** | Native pending-permission read omits sufficient owner identity for a complete root/child snapshot. Positive permission events are useful; absence remains partial. |
| Compaction events identify the originating Multiplex compact command | **Disproved.** | Native compaction data has provider tracing fields but no Multiplex command identity. Adapter emits only uncorrelated phase (`packages/adapter-copilot/src/lifecycle.ts`; compaction regression in its lifecycle test). |

## Supplied concrete defects and disposition

| Defect / limit from the evidence input | Verdict at this worktree | Scope and exact anchor |
| --- | --- | --- |
| Hidden browser tabs spend finite receipt-check attempts while skipping the read | **Conditional Leo defect; fixed in the companion migration.** | The supplied Leo source audit identified the bug. The companion Leo branch uses a visibility-aware read scheduler, so hidden time does not spend finite receipt checks (`apps/web/src/client/visible-read-scheduler.ts` in that branch). Framework receipt checks remain original-ID reads. |
| A local native-compaction marker blocks later terminal receipt persistence | **Conditional Leo defect; fixed in the companion migration.** | The supplied Leo audit identified the race. The companion branch lets a terminal durable receipt outrank incomplete local compaction interpretation, preserving the draft and allowing composer release (`apps/web/src/client/operation-recovery.ts` in that branch). |
| Control replay omits a requested-ahead native cursor gap | **Confirmed at the base; fixed in scope.** | Control now reports requested-ahead, missing-ring and expired gaps before live delivery (`packages/control-node-core/src/event-hub.ts:266-310`; regression `packages/control-node-core/test/event-hub-native-dedup-v3.test.ts:53-97`). |
| Generic durable receipts store untyped arbitrary error strings while thrown RPC errors are sanitized/flattened | **Confirmed at the base; generic command receipts fixed in scope.** | Typed fixed-message `CommandError` is `packages/protocol/src/command-error.ts`; runtime/control migrations and secret-sentinel regressions are described in `docs/audits/copilot-lifecycle-vnext-errors.md`. Arbitrary native-read and launch/archive thrown-error boundaries remain separate. |
| Native `user.message` can omit originating command identity | **Confirmed unresolved SDK limit.** | Optional native message ID prevents exact display/consumption correlation for those events. The reducer preserves Accepted/Unknown rather than matching text. |
| Compaction events omit originating Multiplex command identity | **Confirmed unresolved SDK limit.** | Phase is observable, command causality is not. A local temporal marker never rewrites a durable receipt. |
| Callback-only input/elicitation/plan recovery lacks exact reconnect hydration | **Confirmed unresolved SDK limit.** | Exact response methods exist, but no complete pending snapshot exists. Lifecycle interaction completeness remains partial. |
| p2prpc authenticated-session retirement is break/reconnect rather than seamless renewal | **Conditional on public p2prpc 0.2.1; adopted local candidate.** | Supplied stability evidence recorded the 900-second boundary. The branch stages the independently prepared renewal patch and requires application contract `6.renewal.1` at the transport integration. The public `0.2.1` pin remains unchanged pending separate core publication; it does not qualify the final published graph. |

## Additional base defects found and fixed in scope

| Finding | Verdict and change | Evidence |
| --- | --- | --- |
| Browser recovery action redispatched the saved command instead of reading its receipt | **Confirmed at base; fixed.** | `packages/client/src/command-recovery.ts` permits only `commands.get.query` and validates the complete original envelope. Regression: `packages/client/test/command-recovery.test.ts`. |
| Optimistic native display used matching text/images | **Confirmed at base; fixed by removing the inference.** | Reference console renders native evidence and command status separately; repeat-text deterministic scenario is `tests/browser-lifecycle-vnext.mjs`. |
| A late successful receipt could clear a newer/different draft | **Confirmed at base; fixed for the mounted reference binding.** | Exact binding/text/ordered-image equality is required by `apps/web/src/client/command-draft.ts`; regression `tests/web-command-draft.test.ts`. Reload/multi-tab durable CAS remains product-owned. |
| Mutable cursor could regress same-epoch native sequence | **Confirmed at base; fixed.** | `packages/client/src/cursor.ts` delegates established-feed transitions to the shared monotonic function and preserves maximum pending positions; regression `packages/client/test/fleet-watch.test.ts`. |
| Delayed empty task/queue reads could erase a newer invalidation | **Confirmed at base; fixed in the Copilot adapter/runtime lifecycle path.** | Dual revision fences are described above; regressions are `packages/adapter-copilot/test/tasks.test.ts` and `session-state.test.ts`. |
| A protocol-v6 feed rotation left a pending authority-handoff request encoded as protocol v5 | **Confirmed during migration replay; fixed.** | Control migration v7 now rewrites the pending durable request, and lost-reply reconciliation admits the child's migration-rotated feed and boot without replacing the authority admission. Regression: `packages/control-node-core/test/authority-handoff-v5.test.ts`. |
| Persisted active Copilot bindings became resumable after runtime restart without a native handle | **Confirmed during integration; fixed for embedded runtime startup.** | `RuntimeNodeService.reattachPersistedCopilotSessions` captures exact previous active bindings before normalization, validates provider/backend and workspace identity, forces `continuePendingWork:false`, installs one handle, and rejects startup on failure. Registration follows reattachment; `tests/runtime-node-app-control-node.test.ts` checks readiness ordering and `packages/runtime-node-core/test/startup-reattach.test.ts` checks reattachment and mismatched-handle cleanup. |
| A send or steer succeeded without a native message ID and stayed in delivery polling forever | **Confirmed during integration; fixed.** | `commandObservationView` ends continuation at the accepted durable receipt when no exact ID can correlate later native facts. Focused regression: `packages/protocol/test/command-observation.test.ts`. |
| A cached lifecycle stayed online when its runtime descriptor disappeared | **Confirmed during integration; fixed.** | Gateway now overlays offline under the same source-generation and binding fence for a missing or unreachable runtime descriptor. Regression: `packages/gateway-core/test/projection.test.ts`. |

## Browser, client and routing assumptions

| Supplied assumption | Verdict | Exact evidence and conclusion |
| --- | --- | --- |
| HTTP queries/mutations share the subscription WebSocket failure boundary | **Disproved.** | `packages/client/src/client.ts` builds independent HTTP requests for queries/mutations and uses WS only for subscriptions. Regression: `packages/client/test/access-http-independence.test.ts`. |
| Receipt recovery is allowed to choose another route and retry a mutation | **Disproved.** | `readCommandReceipt` issues one read by original ID. Gateway dispatches a mutation once and converts unclassified post-dispatch failure to unknown (`packages/gateway-core/src/projection.ts:2306-2323`). |
| Reconnect cursor commits before asynchronous consumer work finishes | **Disproved for the maintained client contract.** | Access watch serializes callback completion and fences retired subscriptions; see `packages/client/src/access-watch.ts`, `resilient-subscription.ts`, and fleet-watch regression sources. A React setter is not durable browser storage or a paint transaction. |
| Reference web already consumes the full vNext lifecycle snapshot/reducer | **Disproved.** | The web consumes the bounded host-produced `SessionLifecycleView` status, health and action availability (`apps/web/src/client/session-lifecycle.ts`, `session-console.tsx`, `interactions.tsx`). The full state and private native sequence stay inside the runtime; `readLifecycle` returns the same compact public view. |
| Browser disconnection is native completion | **Disproved.** | Offline derives from selected source/runtime/binding availability. Native work can continue; lifecycle projection gains no completion fact. |

Consumer-specific quantitative claims in the supplied audit are **Conditional**,
not framework-wide protocol rules. The 25-event opening primary page, 100 root
message target, 20-request/8 MiB backfill budget, 64 child stores with 400 entries,
task-polling cadences, 256 MiB IndexedDB budget, seven delayed receipt checks and
local compaction marker describe the external Leo revision named by
`CURRENT-AUDIT.md`. The maintained reference web has different history,
interaction and recovery behavior. This worktree did not inspect or modify that
external checkout, so the supplied checksummed audit is the only evidence for
those exact values.

## Stability-context assumptions

| Supplied stability assertion | Verdict in this audit | Limit |
| --- | --- | --- |
| One observed p2prpc expiry caused subsecond leaf reconnects and about 60.839 seconds of aggregate-root probation | **Conditional historical evidence.** | Confirmed only by the supplied checksummed stability bundle. No live renewal cycle was observed here. |
| The stability bundle proves repeated simultaneous Windows and WSL runtime crashes | **Disproved by the supplied bundle itself.** | Different binding times and successful WSL reads refute one demonstrated shared runtime crash. Shared route/power effects remained plausible. |
| Work-Windows had repeated session-specific task-read failures while catalog/runtime presence remained healthy | **Conditional historical evidence.** | The sanitized bundle records 321 failures, but exact downstream SDK/IPC cause was flattened and is not attributable from this worktree. |
| Those Windows failures prove a Copilot SDK bug | **Untestable.** | No preserved typed downstream cause and no authorized live/native reproduction. |
| The archived work-host launcher can leave a recovery sidecar healthy after control/runtime failure | **Conditional historical structural risk; addressed in the companion Leo host.** | The supplied audit inspected exact deployed archived source. Framework `apps/host` and `packages/host-core` remain archived. The maintained Leo supervisor separates sidecar, control and runtime readiness, retries failed runtimes with bounded backoff/cooldown, and refuses another owner when native termination is unproved. |
| Lifecycle/compaction caused the observed WTG stability symptom | **Untestable; no supporting evidence.** | The stability audit explicitly deferred lifecycle mutation and compaction. This work performed no live probe. |

## Executable lifecycle implementation audit

The normative implementation is a multidimensional reducer rather than a scalar
status. The complete state/fact schemas and transitions are in
`packages/protocol/src/lifecycle.ts`; exhaustive transition and 4,096-schedule
invariant sources are in `packages/protocol/test/lifecycle.test.ts`.

| Required behavior | Implementation disposition |
| --- | --- |
| Exact authority/binding generation fence | **Confirmed.** Five-part fence equality; late other-generation facts are ignored. Control and gateway revalidate current binding/runtime boot on lifecycle reads. |
| Runtime-owned durable reducer | **Confirmed.** `packages/runtime-node-core/src/lifecycle.ts` persists the state through the runtime store; store migration `runtime-node-store-v7-lifecycle-evidence` appends one strict JSON state table. |
| Atomic lifecycle/native cursor handoff | **Conditional, private runtime boundary only.** `RuntimeNodeService.readLifecycle` drains admitted event work and returns a fenced projection with private reducer sequence. Control validates and strips those fields. Public `readLifecycle` has no native cursor; access-feed recovery uses its own committed cursor and native epoch. This is not a vendor task/event-log transaction. |
| Crash repair without redispatch | **Confirmed for a command already represented in the bounded lifecycle state under the same fence.** It reads terminal durable command receipts by exact identity. Runtime-store startup separately converts `received`/`started` commands to outcome unknown. |
| Task/queue sequenced delta stream | **Disproved as implemented and unsupported by the pin.** vNext uses revision-fenced complete observations after native invalidation. This is safe but does not meet the aspirational native-delta recommendation. |
| Exact child and interaction hydration | **Conditional.** Fresh creation emits complete empty child and interaction baselines before buffered callbacks because the adapter observes the binding from its beginning. Resume emits partial baselines; root whole-session idle can later prove child quiescence, but the Copilot pin has no complete reconnect pending-interaction snapshot (`packages/adapter-copilot/src/adapter.ts`, `session.ts`, `test/lifecycle-races.test.ts`). |
| Shared projection reducer | **Confirmed.** Protocol exports the private pure reducer and compact public session/command projections. The runtime computes action availability and health; controls and gateway route/fence that view. Browser reducers for task/queue/transcript lifecycle status are superseded. |
| Typed sanitized generic command errors | **Confirmed in scope.** Object-only fixed messages and deterministic migration; native-read/launch/archive error surfaces are not claimed migrated. |

## Deliberate partial boundaries and remaining inconsistencies

1. Fresh creation produces complete child and interaction hydration before
   buffered callbacks, so it can prove both initial sets. Resume produces partial
   baselines. Root whole-session idle can prove child quiescence, while reconnect
   and post-gap recovery still have no complete pending-interaction snapshot.
   Those paths remain Unknown once no stronger positive state applies.
2. `commandSettled` has no production Copilot producer. Root idle, compaction
   complete and command success cannot fill it. Consumption is produced only
   when exact `messageId` and `turnId` coexist.
3. Runtime activation schedules both task and queue observations; native
   invalidations schedule the affected coalesced lane, and a lifecycle gap
   schedules both. `readLifecycle` intentionally performs no SDK reads. A failed
   scheduled read retries under the same revision with bounded backoff; a
   stalled observation degrades health and freezes Copilot mutations.
4. A lifecycle gap clears root/interactions and invalidates task, queue and child
   certainty. A later uniquely identified root start establishes continuity for
   its new foreground boundary. A root whole-session idle can establish a
   quiescent root boundary and complete children without recovering the lost
   cycle or interaction set. Other dimensions still require refresh; there is no
   general native-history-to-lifecycle reconstruction path.
5. Full lifecycle state stays private to the runtime. Catalog streams and
   `readLifecycle` carry the bounded host view; raw native events remain the
   detailed live stream. Consumers recover from a committed access cursor and
   exact native epoch without interpreting private lifecycle revisions.
6. A command can become durable `started` before it enters the bounded lifecycle
   correlation window. Startup safely converts that receipt to outcome unknown,
   but lifecycle projection may omit it; recovery remains `commands.get` by the
   original ID.
7. `offline` is a host reachability overlay. Control and gateway produce it
   when a cached binding's runtime is unreachable or its descriptor is missing;
   browsers do not infer native completion from an outage.

## Fixed versus external-only summary

Implemented in this worktree: protocol-v6 lifecycle state/reducer/projections;
runtime persistence, fencing, private runtime observation and proactive
coalesced task/queue refresh; Copilot exact event normalization, fresh-session
child/interaction hydration and stale observation rejection; namespaced
interaction owners; generation-fenced routing; bounded host lifecycle views and
actions in the reference web; control requested-ahead/missing-ring gap signaling; typed generic
command receipt errors and migrations; original-ID read-only browser recovery;
exact draft settlement; monotonic mutable cursors; trusted Copilot startup
reattachment; and a version-2 `commands.observe` view that does not keep waiting
when the SDK gave no exact native message ID.

External-only or still blocked: Leo IndexedDB/Web Locks cross-tab migration;
complete Copilot interaction
hydration after resume/reconnect or a gap; universal native causal IDs;
guaranteed logical IDs; native task/queue snapshot cursors or deltas;
per-command settlement; and typed arbitrary native-read errors. The reviewed
p2prpc renewal candidate is staged locally, while public graph publication and
installed-host qualification remain outside this evidence.

The separate renewal implementation must preserve command identity/hash, control
authority/feed, runtime boot, binding revision, runtime epoch and consumer-committed
cursor continuity; fence retired generations; emit a gap/reset when continuity
is unproved; and never retransmit an uncertain mutation. The complete upgrade,
rollback and transport contract is in
[`docs/design/copilot-session-lifecycle-vnext.md`](../design/copilot-session-lifecycle-vnext.md).

## Qualification boundary

No native model behavior, Windows behavior, live production state, cross-tab Leo
storage, or published transport graph is qualified by this audit. The pinned SDK
tests use an inert connection and no native process. Native task-control UAT and
model-driven child behavior remain explicit limitations. Final test commands,
source identity, local commit IDs and checksummed receipts belong to the final
implementation handoff and must not be inferred from the presence of test files.
