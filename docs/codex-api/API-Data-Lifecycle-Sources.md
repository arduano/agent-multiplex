# Codex API lifecycle: pinned source rationale

Companion to the [concise data lifecycle contract](API-Data-Lifecycle.md).
Section numbers correspond to its rows. This documents native Codex behavior;
it does not claim the adapter implements or qualifies every API.

| Pin                      | Value                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Native package           | `@openai/codex@0.162.1`                                                                                                     |
| Upstream tag             | [`rust-v0.162.1`](https://github.com/openai/codex/releases/tag/rust-v0.162.1)                                               |
| Resolved source revision | [`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`](https://github.com/openai/codex/tree/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d) |
| Reviewed                 | 29 October 2026                                                                                                             |

**Evidence labels:** schema/shape is a wire declaration; implementation/behavior
is an inspected code path in this pin; an upstream oracle is test source read,
not a test executed here. A missing guarantee is a boundary for consumers, not
proof that every individual method lacks stronger semantics. All code citations
below use this full source revision, never a mutable branch or unversioned guide.

## Reading and maintenance

Start with the summary. Use the numbered sections to establish what a value,
event or acknowledgement proves. [Version updates](#updating-the-codex-version)
must review the declarations and the producing/consuming code together.

## 1. Connection and RPC

**Schema:** [request IDs and message envelopes][lc01-rpc] define correlated string
or integer IDs, replies and notifications. [Initialize capabilities][lc01-init-schema]
include connection notification opt-outs; [notification timestamps][lc01-time]
record emission time, not sequence or replay position.

**Implementation:** [initialize][lc01-init] rejects repeated initialization and
stores negotiated connection state; [dispatch][lc01-dispatch] rejects requests
before initialization. **Upstream oracle, read only:** [two-connection test][lc01-test]
checks independent initialization and the same request ID on different connections.

**Not guaranteed:** durable effect deduplication, replay of every notification,
or rejection after a lost reply. None follows from request correlation. This is
not a claim that every method lacks its own stronger semantics.

## 2. Thread

**Schema:** [Thread][lc02-schema] separates `id`, session/parent/fork identities,
`ephemeral`, persisted history mode and runtime status. **Implementation:**
[start][lc02-start] attaches a listener and returns effective configuration;
[read][lc02-read] obtains metadata/history without invoking Resume.

**Upstream oracles, read only:** [fresh metadata read][lc02-test-path] succeeds
before its advertised rollout path exists; [full-history read][lc02-test-full]
can reject before the first user message. Creation ACK therefore does not prove
materialized history. Ephemeral threads intentionally have no persistence promise.

**Not guaranteed:** Resume is passive, or archive/delete ACK proves process-tree
retirement. [Removal][lc02-removal] proceeds after logged shutdown failure/timeout;
thread identity is not a process-lifetime receipt.

## 3. Runtime state

**Schema:** [ThreadStatus][lc03-schema] is `notLoaded`, `idle`, `systemError`, or
`active` with approval/input waiting flags. **Implementation:** [status derivation][lc03-owner]
uses this server's loaded/running/request/error facts; [stored-turn normalization][lc03-normalize]
can report an old in-progress turn interrupted when this runtime has no active
turn.

**Upstream oracle, read only:** [runtime status notifications][lc03-test] exercise
state changes and a separate test permits notification opt-out.

**Not guaranteed:** global cross-process liveness, absence of background
terminals, or complete shutdown from idle/notLoaded/disconnection. A cold
reader's status cannot prove another server process stopped.

## 4. Turn

**Schema:** [terminal statuses][lc04-status] and [exact steer/interrupt inputs][lc04-schema]
distinguish thread and turn IDs; steer requires `expectedTurnId`.
**Implementation:** [start][lc04-start] invokes `start_or_steer_turn`, so a
successful start may target existing work; [interrupt][lc04-interrupt] waits for
`TurnAborted` for a nonempty turn ID, while startup interruption acknowledges
submission without that turn event.

**Upstream oracles, read only:** [steer][lc04-test-steer] returns the active ID;
[interrupt tests][lc04-test-interrupt] cover abortion and completed-turn refusal.
[Late-child history oracle][lc04-test-late] also shows a terminal parent turn can
gain later items.

**Not guaranteed:** a new turn per start, immutable terminal containers, or
process retirement when a turn finishes/interruption is acknowledged.

## 5. Item

**Schema:** [ThreadItem][lc05-schema] has 19 ordinary variants; [lifecycle/delta
notifications][lc05-events] carry thread/turn/item identities and field-specific
indices. The plan contract explicitly permits final text to differ from
concatenated deltas. Realtime entries are a [separate union][lc05-realtime].

**Implementation:** [persisted item upsert][lc05-upsert] keys by thread+turn+item,
normally preserves a completed item, but defensively replaces differing duplicate
snapshots while retaining creation order. **Upstream oracle, read only:**
[growing-turn anchors][lc05-test] deliberately reuse one item ID in different
turns, demonstrating that item ID alone is insufficient.

**Not guaranteed:** byte-identical delta concatenation for every variant,
universal stored immutability, tool success, descendant completion or resource
retirement from `item/completed` alone.

## 6. Stored content

**Implementation:** [persistence policy][lc06-policy] omits many live progress
events and caps command/MCP results at 64 KiB specifically in paginated `ItemCompleted`
history; legacy history uses different representations. [MCP truncation][lc06-truncate]
may replace structured output with a JSON text preview; no public typed
truncation flag accompanies that replacement. [Write ordering][lc06-write]
flushes canonical rollout data before projecting; projection failure can be
logged without failing that completed durable write.

**Upstream oracles, read only:** [command][lc06-test-command] and [MCP][lc06-test-mcp]
check the persisted caps and reduced content. **Schema boundary:**
[item/result fields][lc05-schema] do not promise retained original bytes.

**Not guaranteed:** live/stored byte equality, an unlimited tool-output archive,
or atomic freshness of every SQLite-backed read. Representation differences
alone do not prove corruption; actual contradictory equivalent evidence remains
a distinct error.

## 7. History views

**Schema:** [TurnItemsView][lc07-schema] distinguishes intentionally empty
`notLoaded`, display-only `summary`, and `full`: every item available in
persisted app-server history, not every live byte or raw model-context item.
[ThreadReadParams][lc07-read-schema] deprecates full hydration for paginated
threads.

**Implementation:** [paginated views][lc07-owner] obtain turn shells/summary and
hydrate full items separately; the [projector][lc07-projector] primarily records
completed item snapshots. Legacy reads additionally [merge a live turn][lc07-legacy].
**Upstream oracle, read only:** [requested views][lc07-test] checks the distinct
payloads.

**Not guaranteed:** empty payload means empty conversation, `full` means an
atomic live snapshot, or all backends support the same read methods. Read-view
coverage and current execution state are separate facts.

## 8. Pages and cursors

**Schema:** [paging DTOs][lc08-schema] specify per-method directions, opaque
continuations, backwards cursors and turn-scoped exclusive item anchors.
**Implementation:** [history limits][lc08-limits] cap turns/items/timeline
requests at 100; other API limits differ. [Cursor admission][lc08-admission]
checks requested thread/scope and [segment paging][lc08-pages] follows the
visible lineage without exposing a snapshot revision or read/live watermark.

**Upstream oracles, read only:** [growing-turn anchors][lc05-test] verify
exclusive positioning; [rollback][lc08-test-rollback] rejects a removed turn
anchor. [Revert][lc08-revert] can change visible lineage while keeping thread ID.

**Not guaranteed:** atomic multi-page history or universal cursor stability
across edits, archive transitions or growth. Null continuation ends that queried
direction at that read; it does not prevent future appended history.

[lc01-rpc]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/rpc.rs#L13-L78
[lc01-init-schema]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v1.rs#L27-L69
[lc01-time]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/common.rs#L2063-L2079
[lc01-init]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/initialize_processor.rs#L58-L145
[lc01-dispatch]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/message_processor.rs#L929-L985
[lc01-test]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/tests/suite/v2/connection_handling_websocket.rs#L68-L104
[lc02-schema]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs#L204-L262
[lc02-start]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/thread_processor.rs#L1576-L1649
[lc02-read]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/thread_processor.rs#L2824-L2968
[lc02-test-path]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/tests/suite/v2/thread_read.rs#L1398-L1437
[lc02-test-full]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/tests/suite/v2/thread_read.rs#L1602-L1648
[lc02-removal]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/thread_processor.rs#L1048-L1080
[lc03-schema]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1661-L1682
[lc03-owner]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/thread_status.rs#L438-L468
[lc03-normalize]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/thread_processor.rs#L5805-L5837
[lc03-test]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/tests/suite/v2/thread_status.rs#L25-L158
[lc04-status]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L30-L38
[lc04-schema]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L303-L350
[lc04-start]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/turn_processor.rs#L652-L689
[lc04-interrupt]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/turn_processor.rs#L1610-L1653
[lc04-test-steer]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/tests/suite/v2/turn_steer.rs#L218-L359
[lc04-test-interrupt]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/tests/suite/v2/turn_interrupt.rs#L35-L219
[lc04-test-late]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/thread_history.rs#L5128-L5220
[lc05-schema]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L232-L433
[lc05-events]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L1340-L1499
[lc05-realtime]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/realtime.rs#L24-L80
[lc05-upsert]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/thread-store/src/local/thread_history.rs#L433-L484
[lc05-test]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/thread-store/src/local/thread_history/read_tests.rs#L251-L334
[lc06-policy]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/rollout/src/policy.rs#L211-L282
[lc06-truncate]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/utils/output-truncation/src/lib.rs#L43-L87
[lc06-write]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/thread-store/src/local/live_writer.rs#L327-L383
[lc06-test-command]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/thread-store/src/local/thread_history_materialization_tests.rs#L478-L513
[lc06-test-mcp]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/thread-store/src/local/thread_history_materialization_tests.rs#L568-L602
[lc07-schema]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs#L383-L423
[lc07-read-schema]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1684-L1695
[lc07-owner]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/thread_processor.rs#L3218-L3326
[lc07-projector]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/thread_history_projection.rs#L17-L98
[lc07-legacy]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/thread_processor.rs#L3123-L3156
[lc07-test]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/tests/suite/v2/thread_read.rs#L536-L605
[lc08-schema]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1718-L1832
[lc08-limits]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/thread_processor.rs#L5596-L5608
[lc08-admission]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/thread-store/src/local/thread_history/read.rs#L261-L291
[lc08-pages]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/thread-store/src/local/thread_history/segment_paging.rs#L45-L164
[lc08-test-rollback]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/tests/suite/v2/thread_read.rs#L1284-L1351
[lc08-revert]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/thread-store/src/local/revert_thread.rs#L15-L151

## 9. Settings and plans

**Shape:** `thread/settings/update` changes sticky defaults: cwd, approval/reviewer, sandbox or named permission profile, model, tier, effort/summary and collaboration mode. `turn/settings/update` instead targets an exact running thread/turn and exposes a smaller selection. Omitted/null semantics are field-specific: explicit null clears sticky service tier, but does not universally clear effort or mode. [Thread settings DTOs](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L236), [turn settings implementation](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/turn_processor.rs#L213).

**Behavior:** the thread update's empty ACK means queued, not applied. Observe `thread/settings/updated` before dependent partial updates, or combine intended changes. Running-turn `applied` means published for later step captures; it neither rewrites prior steps nor promises another inference. A full collaboration setting has precedence over separate model/effort inputs. [ACK warning](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/turn_processor.rs#L817), [collaboration normalization](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/turn_processor.rs#L404).

Collaboration `default`/`plan`, `turn/plan/updated` checklist progress, and a `plan` history item are independent. There is no `implementPlan` RPC. The upstream TUI implements an explicit user-input/mode action; its clear-context variant is a different operation. [Plan progress shape](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L583), [TUI action construction](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/tui/src/chatwidget/plan_implementation.rs#L9).

**Source oracle:** [running-turn settings tests](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/tests/suite/v2/turn_settings_update.rs#L55) were inspected, not executed. Preserve requested, queued and observed settings separately; never treat plan text as authorization.

## 10. Models and usage

**Shape:** paginated `model/list` entries include provider model slug, visibility/default state, supported/default reasoning effort, modalities, service tiers and availability metadata. `includeHidden` changes catalog selection. Reasoning effort accepts custom nonempty strings, so model-specific advertised choices remain important. [Custom values and parsing](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/protocol/src/openai_models.rs#L57-L72), [serialization/deserialization](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/protocol/src/openai_models.rs#L131-L156). [Catalog DTOs](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/model.rs#L54).

Catalog membership and configured `Thread.model` are not execution receipts. `model/rerouted` carries thread/turn, from/to models and reason; this pin's reason is `highRiskCyberActivity`. `model/verification` and safety-buffering updates report separate native facts. Auth-recovery started/completed notifications report provider recovery, not successful turn completion or permission for provider fallback. [Model event DTOs](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/model.rs#L187), [auth-recovery DTOs](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/notification.rs#L11).

`thread/tokenUsage/updated` contains attributed `total`, `last` and nullable `modelContextWindow`. Breakdowns include input/cached/cache-write/output/reasoning tokens. These are snapshots, not additive event deltas. The shape does not promise billing accuracy, disjoint parent/child accounting or an exact remaining-context counter. [Usage shapes](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1894).

**Maintenance:** retain catalog, requested selection and positively observed execution as distinct data. Recheck per-model capability fields when updating the pin; a new catalog value is not automatically a new supported control or qualified inference path.

## 11. Questions approvals and callbacks

**Shape:** the pin declares eleven server-request methods: command approval, file-change approval, user-input questions, MCP elicitation, permission approval, dynamic-tool call, token refresh, attestation, experimental current-time read, and legacy `applyPatchApproval`/`execCommandApproval`. Their contextual fields differ; credential/attestation callbacks have no thread ID. [Complete registry](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/common.rs#L1784).

**Behavior:** native custody stores a request and its one response callback. Ordinary pending requests can replay, unchanged, to another attaching connection; the first permitted response removes the callback, before its payload is necessarily validated. User verification instead binds an eligible connection and auth identity/revision, and is excluded from ordinary replay. [Registration](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/outgoing_message.rs#L330), [replay](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/outgoing_message.rs#L443), [reply ownership](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/outgoing_message.rs#L566).

`serverRequest/resolved` can precede deserialization and core submission. It clears a pending request; it does not prove permission granted, a valid answer or tool success. [Response ordering](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/bespoke_event_handling.rs#L1639).

Questions identify each question and return `answers: Record<questionId, { answers: string[] }>`; there is no native `extraInfo` field. Separate async questions are structured agent-message suggestions, not reply capabilities. [Question DTOs](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L1731), [async emission](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/tools/handlers/request_user_input_async.rs#L106).

Approval decisions distinguish one action, session approval caching, persistent policy amendment, decline and turn-cancel. Several callbacks can share an `itemId`; command/stdin `approvalId` adds contextual identity, while the RPC request ID remains the reply address. Permission responses specify the actual granted subset and turn/session scope. MCP form, URL and device-verification variants have different proof obligations; opening a URL is not successful verification. [Decision semantics](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L66), [callback parameters](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L1555), [MCP variants](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs#L787).

**No guarantee:** history playback cannot recreate an answerable callback. Preserve request-ID kind, native runtime scope, one-response custody and later action/error evidence independently.

## 12. Queues and goals

**Shape:** queue add/list/update/delete/reorder/start operate on native queued records. `clientUserMessageId` correlates user input; it is not the queue item's ID. Goals carry objective, status, budget/accounting and timestamps. Goal set/get/clear are experimental and feature-gated. [Queue DTOs](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L926), [goal DTOs](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L813).

**Behavior:** queued submissions persist separately from the current turn and can dispatch after completion or cold Resume. Interrupt does not mean deletion of queued future work. The goal service commits state before the processor sends its response/update and applies runtime effects; an active restored goal can continue on idle. A goal ACK is not continuation completion. Budget omission preserves, explicit null clears, and supplied values undergo policy validation. [Queue persistence](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/state/src/runtime/queued_items.rs#L77), [goal processor](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/thread_goal_processor.rs#L133), [goal runtime](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/ext/goal/src/extension.rs#L165).

**Source oracles:** [cold Resume dispatches saved queue work](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/tests/suite/v2/thread_queue.rs#L430); [paused goal survives Resume](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/tests/suite/v2/thread_resume.rs#L2973). Neither was run here. Preserve future-work state separately from current activity; disconnect and a terminal turn do not prove future work disabled.

## 13. Subagents

**Shape:** children have their own threads, turns and histories. Spawn ancestry uses `parentThreadId` and structured source edges; `forkedFromId` is history provenance. Although `sessionId` declares tree identity, pinned stored DTO construction can return the child's own ID. Session-ID equality alone cannot prove or disprove ancestry. [Thread fields](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs#L204), [stored fallback](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/thread_processor.rs#L6084).

Collab tool invocation status, target agent status and `subAgentActivity` are independent. A completed spawn/wait item need not mean child completion. V2 wait can wake for mailbox activity, steering or timeout. Parent completion is not child shutdown. [Event mapping](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/event_mapping.rs#L78), [V2 wait](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L40).

**Behavior:** V2 spawned children explicitly reject direct app-server input; `canAcceptDirectInput` exposes the loaded capability. Creation broadcasts can lag without resynchronizing, so relation inventory/read is the recovery path; default interactive lists need not include children. [Input policy](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/thread_input.rs#L8), [creation listener](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/lib.rs#L1291).

**Maintenance:** retain explicit ancestry and each stream's scope/cursor. Read-only child observation must not manufacture a new native root lifetime, composer or Stop authority.

## 14. Processes and files

Three native process namespaces differ. Thread background terminals belong to loaded-thread execution. Standalone sandboxed `command/exec` has a connection-scoped optional `processId`; its final response waits for exit, and streamed bytes are not repeated there. `process/spawn` runs without a Codex sandbox, registers a connection-scoped `processHandle`, and returns before completion; output/exit use notifications. [Thread terminal implementation](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/thread_processor.rs#L2368), [exec contract](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/command_exec.rs#L30), [spawn contract](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/process.rs#L18).

`fs/readFile`/write/metadata/directory/watch use host filesystem paths and separate resources. Read returns base64 bytes; a recorded image path or file-change path is not immutable file content. Watch handles are connection-scoped resources, with disconnect cleanup distinct from thread history. [Filesystem DTOs](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/fs.rs#L7), [watch cleanup](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/fs_processor.rs#L60).

**No guarantee:** turn completion, an empty terminal page or a successful submission ACK does not prove every process exited. File references do not promise future accessibility, unchanged bytes or a retention duration. Preserve the actual process API, ID namespace, completion event and file representation.

## 15. Configuration authentication and catalogs

**Shape:** `config/read` resolves effective values/origins, optionally layers and cwd. Config writes use a key path, merge strategy, optional file path/version. Batch `reloadUserConfig` explicitly excludes session-static model/effort/Plan-effort/tier defaults. Reading/writing configuration is not the thread-settings state machine. [Config read](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/config.rs#L389), [write/reload contract](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/config.rs#L1101).

Authentication has account/login resources, secrets, completion and cancellation. Even `account/read` can request token refresh; external-token mode has different ownership. MCP status can be thread-specific; nullable runtime status, cached tools and auth state are separate facts. OAuth's `loginId` correlates authorization URL and completion, not tool approval. [Account read semantics](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L544), [MCP inventory](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs#L50), [OAuth correlation](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs#L294).

Skills/plugins/environments are separately scoped catalogs/configuration; native mutation can invalidate their caches. Capability negotiation describes supported messages, not authorization. [Config mutation invalidation](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/config_processor.rs#L219).

**Maintenance:** for a new pin, regenerate stable/experimental schemas, compare method/field scope, then recheck the cited processor and one relevant upstream oracle. Mark source-only observations explicitly; catalog presence, comments and tests read as source do not qualify runtime behavior. Do not treat thread history as a complete auth/config audit log or publish credentials, provider configuration or private machine paths.

## Updating the Codex version

1. **Resolve both pins.** Record the installed package version and resolve its
   upstream tag to a full commit. Check the adapter's declared version and
   generated protocol agree. Do not replace all citation SHAs without reviewing
   the new code at their new line locations.
2. **Regenerate offline protocol outputs** from that package in separate empty
   directories:

   ```sh
   node node_modules/@openai/codex/bin/codex.js app-server generate-ts --out <default-types>
   node node_modules/@openai/codex/bin/codex.js app-server generate-ts --experimental --out <experimental-types>
   node node_modules/@openai/codex/bin/codex.js app-server generate-json-schema --experimental --out <schemas>
   ```

   These export schemas; they do not execute agent work. Compare method names,
   input/output fields, null/omission rules, enums, item unions and capability
   gates. Default export presence alone does not establish runtime stability,
   particularly for notifications.

3. **Revisit sections 1–15.** For each, inspect the cited DTO, processor/store path
   and relevant upstream oracle at the new revision. Recheck defaults, ordering,
   persistence/truncation, error paths and acknowledgements—not only type changes.
   Mark each claim unchanged, changed or unknown. Negative guarantees require
   reviewing the relevant surface, not assuming an older omission persists.
4. **Amend the summary and rationale together.** Preserve section IDs, update
   exact line anchors, record changed claims and unresolved questions below.
   Validate every relative link at the introducing Codex stack layer. Application
   implementation changes are a separate decision; a documentation update
   cannot silently assert adapter parity.
5. **Keep proof levels separate.** Source review and tests read as source establish
   this reference. Actual native/provider/browser qualification must name its
   own version, scope and evidence; do not inherit it by changing a pin. Use
   bounded existing owner oracles for changed behavior, not another blanket
   campaign or a second transcript/receipt implementation.

### Version ledger

| Package / source                                       | Claims reviewed         | Evidence and unresolved boundary                                                                                                                                                                        |
| ------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0.162.1` / `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` | 1–15, initial reference | Offline schema exports and pinned Rust/protocol/test-source review. No native/provider qualification claimed. Cross-page/read-live atomicity and universal effect deduplication are not API guarantees. |

For a new pin, append a row with the new full revision, changed section IDs,
remaining unknowns and the actual proof level. Keep the prior row and its
revision-pinned citations available in Git history; do not relabel old runtime
evidence as proof of the new version.
