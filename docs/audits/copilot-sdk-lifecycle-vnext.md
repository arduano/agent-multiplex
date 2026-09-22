# Copilot lifecycle vNext: exact dependency and adapter audit

Date: 2026-09-22. Base: `c28811b320f436acbec332b00199716a3c62cfa7`.
Scope: maintained Copilot adapter, installed SDK `1.0.13`, selected CLI
`1.0.81`, synthetic tests against the actual SDK JavaScript. No native process,
credential source, private conversation, model, or other worktree was opened
for this audit. These findings do not qualify native model behavior or Windows.

The read-only evidence inputs in
`/home/arduano/.local/state/leo-agents-tasks/copilot-lifecycle-vnext-20260922/`
passed their supplied `SHA256SUMS`: `BRIEF.md`, `CURRENT-AUDIT.md`, and
`STABILITY-CONTEXT.md`. They remain external evidence, not copied source.

## Findings and corrections

In the source anchors below, `SDK:` means
`node_modules/@github/copilot-sdk/dist/`; `CLI:` means
`node_modules/@github/copilot-linux-x64/`. Packaged declarations are evidence of
the published contract. SDK JavaScript and CLI JavaScript may be newer than the
CLI's bundled declarations; declarations alone cannot establish the absence of
a native behavior.

| Assumption | Verdict | Exact evidence and implication |
| --- | --- | --- |
| A send acknowledgement is a logical message ID, distinct from event UUID and queue ID | Confirmed | `SDK:session.js:448` returns `response.messageId`; `SDK:generated/rpc.d.ts:16863` defines the assigned ID. The adapter requires a nonempty acknowledged string. |
| A universal caller operation ID can be passed as an opaque native send field | Disproved for the supported SDK path | `SDK:session.js:448` forwards an explicit field list and drops caller `operationId`, `causalOperationId`, and `messageId`. `SendRequest` has no idempotency/causal-operation field. The executable SDK test observes the actual outgoing packet. Trace context and model HTTP headers are not an idempotency or native-echo contract. |
| Every native `user.message` can correlate to that acknowledgement | Disproved | `SDK:generated/session-events.d.ts:3419` makes `messageId` optional. `CLI:copilot-sdk/generated/session-events.d.ts:2466` lacks it entirely; the executable remote-session branch in `CLI:app.js` emits user messages with content/turn ID but no message ID (`emitClientUserMessage` and `case"userMessage"`). Missing identity remains uncorrelated. |
| `turnId` establishes a universal root cycle identity | Disproved | `CLI:copilot-sdk/generated/session-events.d.ts:3014` describes a stringified counter within a loop. The normalizer uses the unique `assistant.turn_start` event ID as an observed-start fence, never as a logical message ID or proof of command causality. |
| `parentId` is subagent ownership | Disproved | Both event declarations define envelope `parentId` as the chronologically preceding event. Ownership comes from envelope `agentId` and documented legacy data markers. Task-registry, tool-call and agent-instance IDs remain separate domains; aliases are not guessed. |
| Primary history retains child summaries but excludes ordinary child chatter | Confirmed contract | `SDK:generated/rpc.d.ts` `EventsAgentScope` and adapter `primary-history.ts` select `agentScope:"primary"`. Live bridge emissions retain all native events. Existing primary-history tests exercise filtering delegation and exact cursor/size retry behavior. |
| SDK and CLI bundled declarations are equivalent | Disproved | SDK event-log requests expose backward direction and `agentIds`; CLI bundled `EventLogReadRequest` at line 4651 does not. CLI queue declaration at line 11839 omits SDK optional correlation/in-flight fields, while CLI `app.js` consumers read `inFlightSteeringCount`. Treat optional fields as observed evidence only. Do not invent fallback cursors or assume all generated APIs work on the selected runtime. |
| `assistant.idle` means all session work completed | Disproved | It ends model activity only. `CLI:copilot-sdk/generated/session-events.d.ts:986` documents root `session.idle` as no background agents or attached shell commands in flight and includes `aborted`. Neither event identifies the objective or originating command. |
| Task refresh/list provides atomic snapshot plus event cursor | Disproved at supported contract | `SDK:generated/rpc.d.ts:24100` exposes distinct `refresh()` and `list()`; `TaskList` is only `tasks`, without cursor or global revision. CLI `TaskList` at line 15977 agrees. `session.background_tasks_changed` invalidates a snapshot; it is not a sequenced task delta. |
| A successful task read cannot overwrite newer task evidence | Defect reproduced and fixed | Before this change all task reads coalesced with identity `""` and accepted a delayed empty list after a newer invalidation. Adapter observations now fence the list against invalidations since dispatch, reject stale replies, and refuse to join a previous generation. The refresh step may itself emit invalidation; its completed refresh establishes the list's start revision. |
| Queue disappearance establishes display/consumption | Disproved | Queue snapshot is independent of native transcript commit. The same delayed-read defect existed for pending queues and is now rejected. Empty queue does not emit a delivery fact. Steering entries may be text only; their position is not a message ID. |
| UI callbacks provide exact identity and a durable acknowledgement | Disproved | `SDK:client.js:2311` and `:2326` strip user-input/plan request ID; `SDK:session.js:1224` strips elicitation ID before calling the handler, then separately submits the native response. Callback resolution precedes any success/refusal/loss of that submission. The executable SDK test confirms elicitation behavior. |
| Exact UI response APIs are unavailable | Disproved | `SDK:generated/rpc.d.ts:24687` exposes `handlePendingElicitation`, `handlePendingUserInput`, and `handlePendingExitPlanMode`, all keyed by native `requestId`; native false means no pending request was resolved. CLI's public native-domain list in `CLI:app.js` includes these methods. |
| Those APIs alone enable complete reconnect hydration | Disproved | User-input, elicitation, and exit-plan request/completion events are ephemeral. `eventLog.read` explicitly warns that ephemeral events are not replayable once pruned. `rpc.ui` has no pending-list/snapshot method. `permissions.pendingRequests()` is permission-only and its return omits agent ownership. Retaining callback mode is a declared staged limitation, not a complete reconnect solution. |
| Compaction native event IDs correlate a Multiplex compact command | Disproved | `CompactionCompleteData` exposes optional provider tracing IDs, no originating Multiplex command ID. A complete event may report failed native compaction. The normalizer emits only an uncorrelated observation that compaction ended, never a command receipt or settlement. |
| Task false cancel/promote result is a refusal/no-op | Confirmed | Existing task command tests and the supported boolean replies distinguish native false from malformed/lost acknowledgement; the latter remains `outcomeUnknown`, never retry. No native smoke was run by this audit. |
| The stability report establishes repeated WSL crashes or the SDK cause of Windows failures | Not established | The supplied report explicitly limits its evidence to one observed retirement cycle and session-specific Windows native-read failures. This audit uses no live probes and makes no attribution beyond those stated limits. |

## Implemented boundary

[`copilotLifecycleFacts`](../../packages/adapter-copilot/src/lifecycle.ts) is a
pure adapter-owned normalizer for the shared protocol lifecycle contract. It
emits payload-free facts after forwarding the original native event. Root and
child effects are fenced independently. Root send echoes require exact native
logical identity. Missing IDs, empty finals, text equality, queue disappearance,
elapsed time and chronological parent chains cannot manufacture delivery,
consumption or settlement.

Task/tool summary keys use the `tool:` domain; ordinary child event owners use
the `agent:` domain. A root `session.idle` may settle previously observed running
children in the shared reducer. A child event cannot settle another domain's
identity through an assumed alias. No child becomes a catalog session.

[`CopilotAdapterSession.readNativeState`](../../packages/adapter-copilot/src/session.ts)
now rejects task/queue snapshots invalidated during the read. These are local
observation fences, not native atomicity: missed notifications, native updates
before their event delivery, and SDK disconnects still require explicit unknown
freshness. The runtime's atomic persisted lifecycle snapshot/cursor establishes
the boundary of **runtime observations**, not a retroactive native transaction.

## Interaction migration blocker

An exact response API is necessary but insufficient to replace callbacks safely.
The current supported APIs cannot enumerate pending user-input, elicitation or
plan requests after their ephemeral request event disappears. Switching to
events alone would lose requests after attachment/reconnect; running both paths
would create competing responders without callback-to-event identity. No text
matching is acceptable. This stage therefore preserves callback handlers and
marks interaction completeness partial. It does not claim callback completion
is an acknowledged native answer.

Required SDK/CLI contract: a bounded pending-interaction snapshot that includes
request kind, exact ID, owner, native binding generation and an event cursor;
sequenced opened/completed changes; exact-ID response acknowledgements whose
unknown outcome can be queried without replay. Permission hydration must carry
owner identity too. Until then, runtime-owned known pending requests are useful
positive evidence, while their absence does not establish complete hydration.

## Durable correlation and SDK work still required

Multiplex owns `(commandId, payloadHash, runtime boot, binding revision, runtime
epoch)` before dispatch. A native acknowledgement may append a logical message
ID to that durable journal. An exact native echo can then establish display
before or after the acknowledgement. A crash after native effect but before
acknowledgement persistence cannot be solved by an adapter-generated ID that
native never accepted. Preserve `outcomeUnknown` under the original command ID.

Upstream work remains necessary for caller causal/idempotency IDs echoed across
send, queue, consumption and compaction evidence; atomic task/queue snapshots
with cursors; durable or snapshot-recoverable UI requests; supported owner/alias
maps for task/agent/tool identities; and clear per-command settlement semantics.
No dependency pin was changed in this stage.

## Executable evidence and exact dependency hashes

- [`sdk-lifecycle-contract.test.ts`](../../packages/adapter-copilot/test/sdk-lifecycle-contract.test.ts): actual installed SDK packet serialization, supported RPC method surface, elicitation callback identity/acknowledgement boundary; inert connection only.
- [`lifecycle.test.ts`](../../packages/adapter-copilot/test/lifecycle.test.ts): root/child ownership, repeated turn counters, missing IDs, uncorrelated compaction, invalidation and malformed envelopes.
- [`tasks.test.ts`](../../packages/adapter-copilot/test/tasks.test.ts) and [`session-state.test.ts`](../../packages/adapter-copilot/test/session-state.test.ts): delayed stale-empty snapshots, generation-safe coalescing and refresh-before-list behavior.

Dependency content hashes read in this worktree:

| Installed file | SHA-256 |
| --- | --- |
| SDK `session.js` | `e0bcdd68532f4108906af199531359f422cf192f1e5d61124b82e734ea0f5546` |
| SDK `client.js` | `23be6340fabd555ccd8f0c9fc20786bcb743902f73e0a30e26157a1c55c36abf` |
| SDK `generated/rpc.d.ts` | `f262cd7e036ea1c862e17f90a72340d918943761413552e6019a96f4aee33c3c` |
| SDK `generated/session-events.d.ts` | `c9bde505b270207f6015a83af7e8a6054352f17699ef0c380dc6417433edbc98` |
| CLI `copilot-sdk/generated/rpc.d.ts` | `365b753fd7ccca0365c5f739958dcd58effed4b24d9c012779e33009b71f6e92` |
| CLI `copilot-sdk/generated/session-events.d.ts` | `727881c00bedf3e2fe388c77a5c43ba25486eddb5e4a8b72204730f2dcaf5cff` |
| CLI `app.js` | `d93ad0e65559f599ac31a6646c5538f3617d2d42e374624532bb764a754b70fe` |

Passing and failing command receipts belong to the implementation handoff and
local checksummed receipt bundle. Source inspection and a mocked adapter test
are not native integration qualification.
