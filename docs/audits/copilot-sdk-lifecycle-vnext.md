# Copilot lifecycle vNext: exact dependency and adapter audit

Date: 2026-09-22; dependency re-audit: 2026-09-23. Base: `c28811b320f436acbec332b00199716a3c62cfa7`.
Scope: maintained Copilot adapter, installed SDK `1.0.14`, selected CLI
`1.0.88`, synthetic tests against the actual SDK JavaScript, and the CLI's
credential-free `--version` probe. No session-bearing native process, credential
source, private conversation, model, or other worktree was opened for this
audit. These findings do not qualify native model behavior or Windows. Public
npm metadata reported these as the latest stable versions on 2026-09-23; SDK
`1.0.15-preview.1` was a prerelease and was not selected.

The read-only evidence inputs in
`/home/arduano/.local/state/leo-agents-tasks/copilot-lifecycle-vnext-20260922/`
passed their supplied `SHA256SUMS`: `BRIEF.md`, `CURRENT-AUDIT.md`, and
`STABILITY-CONTEXT.md`. They remain external evidence, not copied source.

## Findings and corrections

In the source anchors below, `SDK:` means
`node_modules/@github/copilot-sdk/dist/`; `CLI:` means the opaque executable and
metadata in `node_modules/@github/copilot-linux-x64/`. Packaged SDK declarations
are evidence of the published SDK contract. CLI 1.0.88 no longer ships its
JavaScript or generated declarations, so SDK declarations cannot establish the
absence of undocumented native behavior.

| Assumption | Verdict | Exact evidence and implication |
| --- | --- | --- |
| A send acknowledgement is a logical message ID, distinct from event UUID and queue ID | Confirmed | `SDK:session.js:460-476` returns `response.messageId`; the generated RPC declarations define the assigned ID. The adapter requires a nonempty acknowledged string. |
| A universal caller operation ID can be passed as an opaque native send field | Disproved for the supported SDK path | `SDK:session.js:460-476` forwards an explicit field list and drops caller `operationId`, `causalOperationId`, and `messageId`. `SendRequest` has no idempotency/causal-operation field. The executable SDK test observes the actual outgoing packet. Trace context and model HTTP headers are not an idempotency or native-echo contract. |
| SDK 1.0.14 adds useful send/output correlation | Confirmed, but partial | `MessageOptions.source` is forwarded, and `AssistantMessageData.originatingMessageId` may match the ID returned by `session.send`. The field is optional and identifies the initiating native message, not the Multiplex command, compact operation, task snapshot, interaction acknowledgement, or whole-session settlement. The executable SDK test checks the new declaration and packet field. |
| Every native `user.message` can correlate to that acknowledgement | Disproved | `SDK:generated/session-events.d.ts:3550-3596` keeps `messageId` optional. Missing identity remains uncorrelated. |
| `turnId` establishes a universal root cycle identity | Disproved | `SDK:generated/session-events.d.ts:4113-4116` describes a stringified turn number within the agentic loop. The normalizer uses the unique `assistant.turn_start` event ID as an observed-start fence, never as a logical message ID or proof of command causality. |
| `parentId` is subagent ownership | Disproved | SDK event declarations define envelope `parentId` as the chronologically preceding event. Ownership comes from envelope `agentId` and documented legacy data markers. Task-registry, tool-call and agent-instance IDs remain separate domains; aliases are not guessed. |
| Primary history retains child summaries but excludes ordinary child chatter | Confirmed contract | `SDK:generated/rpc.d.ts` `EventsAgentScope` and adapter `primary-history.ts` select `agentScope:"primary"`. Live bridge emissions retain all native events. Existing primary-history tests exercise filtering delegation and exact cursor/size retry behavior. |
| SDK and CLI bundled declarations are equivalent | Inapplicable at the new pin | CLI 1.0.88 packages an opaque native executable and no bundled JavaScript or declarations. SDK 1.0.14 declarations and JavaScript establish only the SDK contract; they cannot establish undocumented CLI internals. Treat optional fields as observed evidence only and do not invent fallback cursors. |
| `assistant.idle` means all session work completed | Disproved | It ends model activity only. `SDK:generated/session-events.d.ts:1385-1442` documents root `session.idle` as no background agents or attached shell commands in flight and includes `aborted`. Neither event identifies the objective or originating command. |
| Task refresh/list provides atomic snapshot plus event cursor | Disproved at supported contract | `SDK:generated/rpc.d.ts:21490-21508` defines `TaskList` as only `tasks`, without cursor or global revision; the generated client exposes distinct `refresh()` and `list()`. `session.background_tasks_changed` invalidates a snapshot; it is not a sequenced task delta. |
| A successful task read cannot overwrite newer task evidence | Defect reproduced and fixed | Before this change all task reads coalesced with identity `""` and accepted a delayed empty list after a newer invalidation. Adapter observations now fence the list against invalidations since dispatch, reject stale replies, and refuse to join a previous generation. The refresh step may itself emit invalidation; its completed refresh establishes the list's start revision. |
| Queue disappearance establishes display/consumption | Disproved | Queue snapshot is independent of native transcript commit. The same delayed-read defect existed for pending queues and is now rejected. Empty queue does not emit a delivery fact. Steering entries may be text only; their position is not a message ID. |
| UI callbacks provide exact identity and a durable acknowledgement | Disproved | `SDK:client.js:2335-2357` strips user-input/plan request ID; `SDK:session.js:1272-1282` strips elicitation ID before calling the handler, then separately submits the native response. Callback resolution precedes any success/refusal/loss visible to the callback. The executable SDK test confirms elicitation behavior. |
| Exact UI response APIs are unavailable | Disproved | `SDK:generated/rpc.d.ts:25670-25710` exposes `handlePendingElicitation`, `handlePendingUserInput`, and `handlePendingExitPlanMode`, all keyed by native `requestId`; native false means no pending request was resolved. |
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
The 2026-09-23 re-audit advanced the exact stable pins from SDK 1.0.13 / CLI
1.0.81 to SDK 1.0.14 / CLI 1.0.88. It did not add a compatibility branch.

## GPT-6 Sol availability

GitHub's [2026-09-22 changelog](https://github.blog/changelog/2026-09-22-openais-gpt-6-sol-and-gpt-6-luna-now-available/)
explicitly lists GPT-6 Sol for the Copilot CLI model picker. Availability is for
Copilot Pro+, Max, Business, and Enterprise plans, rolls out gradually, and may
be disabled by an organization administrator's model policy. The CLI catalog is
account- and policy-driven; the opaque package binary does not provide a static
model catalog that can qualify a particular account. This audit used no
credentials, session, or model prompt, so it confirms upstream CLI support but
does not claim local account availability. The runtime must preserve the model
ID returned by native discovery rather than adding GPT-6 Sol to the adapter's
custom-provider-only fallback table.

## Executable evidence and exact dependency hashes

- [`sdk-lifecycle-contract.test.ts`](../../packages/adapter-copilot/test/sdk-lifecycle-contract.test.ts): actual installed SDK packet serialization, `source` forwarding, optional assistant origin correlation, supported RPC method surface, and elicitation callback identity/acknowledgement boundary; inert connection only.
- [`lifecycle.test.ts`](../../packages/adapter-copilot/test/lifecycle.test.ts): root/child ownership, repeated turn counters, missing IDs, uncorrelated compaction, invalidation and malformed envelopes.
- [`tasks.test.ts`](../../packages/adapter-copilot/test/tasks.test.ts) and [`session-state.test.ts`](../../packages/adapter-copilot/test/session-state.test.ts): delayed stale-empty snapshots, generation-safe coalescing and refresh-before-list behavior.

Dependency content hashes read in this worktree:

| Installed file | SHA-256 |
| --- | --- |
| SDK `session.js` | `d58e8e02a463c6901a701ee0185235ec1b7a2f64791d3daf5ec244ace9c30fe7` |
| SDK `client.js` | `55fb14a302354e6a99cc8afb4102bf26d053f0376a9456da23d73ffa306bcc9f` |
| SDK `generated/rpc.d.ts` | `12fdf0e8a96fa773b1e6816a888d7c487b893bd4018c63a1bee8c171ef221254` |
| SDK `generated/session-events.d.ts` | `8ca5384f6f50606cd0b14266cb75f8d77f2fde6c8c997bb9f867cea6d819b7de` |
| CLI native executable | `0059754cf78c3f3bf2c9d4564dfa7e9e25f3a3f8f411f2f0cdad9363f5662748` |
| CLI `package.json` | `ac29073b97fbd15ceb0bec58e86b5c9c050124e7d91a2b3e10d7fb214bf70077` |

Passing and failing command receipts belong to the implementation handoff and
local checksummed receipt bundle. Source inspection and a mocked adapter test
are not native integration qualification.
