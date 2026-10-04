# Copilot child task observation investigation — October 4, 2026

Installed Windows and WSL hotfix.29 disposable managed Luna runs each returned
the exact parent marker, completed two children, and emitted root `session.idle`.
Neither stream reported a gap. Both failed the subsequent healthy Finished check
with `tasks / observationRetrying`; concurrency and reconnect assertions were
not reached. This investigation contains no model call, SDK attachment, installed
service action or owner-session action. Published hotfix.29 remains immutable.

## Offline replay and causal limit

The [receipt replay](../../scripts/replay-copilot-task-observation.mjs) consumes
the retained native stream and a post-idle public session snapshot. After building
the checkout, run it with the two receipt file paths:

```bash
node scripts/replay-copilot-task-observation.mjs STREAM.ndjson SNAPSHOT.json
```

It checks stream continuity, exact binding, two child starts/completions and the
absence of task changes after whole-session idle. It replays native lifecycle
facts through the existing reducer, then reproduces the retained current-revision
failed task observation. Under a controlled empty queue, this correctly projects
Unknown with a task retry issue. A controlled complete terminal task snapshot
projects healthy Finished. Stale snapshots, idle tasks and partial interaction
hydration preserve Unknown; an actual pending root input remains Waiting for input.

Windows retained 656 native events and ten task invalidations; WSL retained 649
native events and nine task invalidations. Every task invalidation preceded root
idle. The failed snapshot bytes and the exact rejected-read cause were not
retained by this qualification driver. Controlled task/queue inputs in the replay
are negative controls, not recovered native facts or an incident-cause proof.

The [adapter](../../packages/adapter-copilot/src/session.ts) captures its task
revision after refresh and before list. The
[Runtime](../../packages/runtime-node-core/src/service.ts) captures its lifecycle
revision before the whole read. A refresh notification can therefore require a
quiet retry. Continuous refresh notifications could prevent acceptance, but
the retained post-idle sequence does not show them. Runtime revision mismatch
alone leaves observation pending; current-revision rejected reads produce
retrying. The strict task snapshot fields/enums match the pinned SDK 1.0.14 and
CLI 1.0.88 declarations, so these receipts do not justify relaxing validation.

## Correct diagnostic correlation

The first consumer trace capture selected every row by `nativeSessionJoinKey`.
Consumer `recordIncident` does not write that key; it writes `run`,
`sdkAttachmentId`, `sessionTraceId` and `bindingTraceId`. That filter therefore
omitted all reducer/observation incident rows. The correction is a two-pass join:

1. Select owned native rows using the protected native session join key and
   retain their `run` plus `sdkAttachmentId` (or native `session` ordinal).
2. Select incident rows matching those exact run/attachment pairs; retain their
   observation outcomes, revisions, failure counts and bounded state summaries.

An attachment ordinal cannot cross a run boundary. No raw native payload,
credentials, provider configuration or native identifier is needed in the safe
result. Retained WSL native rows show refresh/list acknowledgements, including
quiet post-idle retries; native acknowledgement by itself does not prove that
the adapter accepted the shape or Runtime installed the observation.

The corrected WSL capture confirms current-revision failure: task revision nine
equals current revision nine on repeated failures through 08:10:53 UTC. Its
45-second no-success watchdog degraded admission, and the supervised internal
Runtime generation later recovered at 08:11:13 UTC. New-generation revision zero
task observations were accepted. A subsequent read returned zero tasks, so that
reset did not preserve the failed task response for validation. Windows older
incident rows rotated before the corrected capture. This narrows the failure
to a rejected current-revision read, while the exact validation stage remains
unproved.

## Narrow source diagnostic correction

The adapter now reports fixed task snapshot failure reasons: malformed schema,
oversized envelope or invalid JSON wire data. Up to eight schema issues retain
only a known field path, fixed validation code and actual value type. Paths have
at most eight segments; unrecognized fields become `unknownField`, and array
indices saturate at 1,000. The shared error copies only these fields. Rejected
values, prompt/error text, identifiers, expected enum contents and unknown keys
are excluded. The wire check still precedes schema admission; a Date can be
described as a Date without converting or accepting it.

Runtime's private current-revision failed observation trace retains
`failureReason` and optional `validationIssues`. Lifecycle projection rejection
and generic native-read failure have separate fixed reasons. Stale revision,
generation and binding outcomes keep their precedence; retry timing, watchdogs,
accepted task schemas and lifecycle facts are unchanged. The embedding consumer
must explicitly allowlist the added private fields when recording the hook.

Source regressions cover malformed optional null, missing required `agentType`,
invalid enums, Date wire rejection, bounds and metadata privacy. A mocked native
session produces a real adapter snapshot rejection through Runtime and proves
the trace fields while the public lifecycle remains Unknown/recovering. This
controlled malformed shape is not a claim about the lost live response.

The incident cause remains unproved and no lifecycle repair is claimed. A future
correction requires the actual rejected shape or stage/cause and preservation
of both read fences. This source correction requires qualification/publication
under a new version. Root idle must not invent fresh task absence or clear
genuine interactions.

## Source verification

Typecheck/build, the full serial suite (**1,412 passed; eight skipped**),
checkpoint/docs/release/secrets checks and both original offline replays passed.
The focused adapter/Runtime suites contain 73 tests, including the actual
malformed-snapshot-to-trace regression and reason/path privacy checks.
An earlier four-worker run timed out in two unrelated control-node tests;
both passed with one worker. This qualifies the source diagnostic scope only:
no new artifact publication, installed activation or model acceptance occurred.
