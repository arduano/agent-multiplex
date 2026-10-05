# Copilot interaction-gap recovery investigation — October 5, 2026

Source base: `998128b0a9b00eaeb3c28f304554e79cdcaf16c3`, the hotfix.32
published-state handoff. Isolated branch: `fix/p0-copilot-gap-20261005`.
This work uses synthetic/disposable state and the installed pinned declarations;
no native process, external model, owner session, service, provider configuration,
private state mutation, release or deployment is included.

## Reported state and causal limit

The consumer reported Tariff before manual recovery as Unknown/recovering with
`incompleteNativeState` and Send disabled by `interactionStateUnknown`.
History returned in 168 ms, the native queue was empty, and nine completed shell
tasks contained no null requested models. Its retained routine logs did not
contain a matching initiating gap. The owner then manually recovered it; the
consumer's subsequent read-only capture found healthy Working and Send available.
Those facts do not identify a rejected native envelope or establish whether a
true pending request was lost. An ambiguous/active resume baseline can also leave
interaction completeness partial without any Runtime gap; the reported public
state alone does not distinguish that path from post-gap recovery. The requested model-null correction
in hotfix.32 cannot repair interaction completeness after a gap.

The [reducer](../../packages/protocol/src/lifecycle.ts) explains the persistent
symptom: invalidation clears interaction items and makes completeness partial.
Root whole-session idle restores continuity, root quiescence and child
completeness; it does not enumerate pending requests. Fresh task and queue
observations restore only their own dimensions and degraded native admission.
History repairs transcript content. All of these fences are intentional.

Existing [payload-gap regressions](../../tests/copilot-payload-gap.test.ts)
reproduce this state from complete interaction hydration, one rejected native
envelope, later root idle and fresh empty task/queue reads. The resulting Send
reason remains `interactionStateUnknown`. Genuine callback records and owner
Stop retain their existing independent paths.

## Supported synchronization contract

Pinned SDK `1.0.14` and CLI `1.0.88` offer:

| Surface | Positive proof and limitation |
| --- | --- |
| `session.permissions.pendingRequests` | `{items:[{requestId,request}]}` reconstructed from unmatched permission request/completion history. No owner, generation, revision or event cursor. |
| `session.permissions.handlePendingPermissionRequest` | An exact-ID decision with acknowledged boolean success; false includes an already resolved request. |
| `session.ui.handlePendingUserInput`, `handlePendingElicitation`, `handlePendingExitPlanMode` | Exact-ID reply RPCs with acknowledged success. These do not list pending requests. |
| `eventLog.read`/`tail` and interest registration | Bounded native history/event observation. Ephemeral requests cannot be recovered after pruning; interest changes listener gating and has no pending-state certificate. |
| `sessions.open` attachment and `metadata.activity` | Native attachment/status or aggregate active-work observation. Neither enumerates pending requests. |

The [pinned SDK contract test](../../packages/adapter-copilot/test/sdk-lifecycle-contract.test.ts)
uses an inert connection to prove exact reply methods and absence of a UI pending
snapshot. Generated SDK RPC declarations document permission-history
reconstruction and lack owner fields. Question, elicitation and exit-plan
request/completion events are ephemeral. SDK local subscriptions and connection
close have no supported complete pending-request replay certificate.
The CLI distributes an opaque executable; this review does not establish that
no undocumented internal API exists. No unsupported native method is used.

An empty permission snapshot, empty queue, completed tasks, root idle, inactive
activity, elapsed time or transcript similarity therefore cannot reopen Send
after genuine interaction uncertainty. A future consumer capture also needs the
first resume boundary's two explicit work flags and the adapter hydration
completeness/certificate decision, alongside any retained gap diagnostic, to
distinguish an uncertified resume baseline from local gap invalidation. These
flags and decisions are metadata; no conversation payload is needed.

## Narrow same-handle recovery design and unresolved proof

A gap proved to occur only inside Runtime admission has a narrower possible
repair: resynchronize exact retained adapter interactions from the still-owned
native bridge. The current maps are insufficient. Callback entries retain
cancellation/settlement functions without their immutable emitted events,
request kind, exact owner or stable token. Question/plan callbacks and elicitation
callbacks omit native request identity/ownership. Callback resolution deletes
the bridge entry before the SDK submits or acknowledges its native response.
SDK handler exceptions can be swallowed before bridge processing completes.
Runtime's admitted callback list cannot recover a rejected opening or certify
that a lost close is no longer pending.

A future constrained implementation must retain immutable bounded callback
events and stable private tokens, original Runtime interaction IDs/resolvers,
exact owner namespaces, synchronous revision fences and the unchanged binding.
It needs fresh-create or certified cold-resume provenance and explicit detection
of bridge processing loss/upstream discontinuity. Registry overflow, unattributed
requests, partial resume, expired binding and native response uncertainty must
retain partial state. Callback responses must remain uncertain until independent
native acceptance/completion proof; an empty local registry is insufficient.
It must resubmit no mutation, resolve no request, stop no shared owner and change
no receipt. This design is not implemented or qualified in this candidate.

## Cause-retention correction

[Private incident tracing](../../packages/runtime-node-core/src/copilot-incident-trace.ts)
now carries the strict gap diagnostic and fixed native type/ephemeral flag,
payload-validation stage and wire bounds directly on each gap record. One
immutable `lastInvalidatingGap` context remains attached to later records for
that exact trace binding. Later optional telemetry omissions preserve it, and
routine recent16 rollover does not remove it. This adds constant bounded metadata
within the existing 128-record asynchronous hook queue.

[Runtime activation](../../packages/runtime-node-core/src/service.ts) copies the
prior persisted `lastGap` into the private activated-binding trace as
`previousBindingGap` before its new lifecycle epoch replaces the old state.
The old diagnostic is not installed into the new reducer. Hooks must explicitly
retain these fields in protected diagnostics, with incident retention beyond
routine rotation. A stopped/hung logging sink retains the existing bounded,
best-effort behavior; it cannot prove every historical event was captured.

Prior diagnostic collection and trace recording are isolated from synchronous
failures. Previous diagnostic attribution checks the logical session, runtime node
and immutable binding revision while permitting an older boot/runtime epoch.
No lifecycle/admission, wire/persisted schema, migration, dependency, version,
native ownership, command or retry policy changes are included. Credentials,
provider data, payloads, unknown event names and native request/event identities
are absent from the added diagnostic context. P0 remains open until its initiating
cause or a complete supported recovery contract permits a safe behavioral fix.

## Source verification

Two new [incident trace regressions](../../tests/copilot-incident-trace.test.ts)
fail on exact base source: lost cause after recent16 rotation/optional omission,
and missing prior persisted cause at binding activation. Both pass with the
correction. Five focused suites pass **106 tests** on the final source: incident tracing, payload
gaps, lifecycle refresh, lifecycle journal and the pinned SDK contract. The
retained local red receipt is `receipts/p0-copilot-gap-20261005/red.json`.
Its SHA-256 is
`2a22f3d520178d3219d42a821f2c9d23102e5ec2d9556b4834e2e974942d237a`.
Independent review added synchronous tracing isolation and exact previous-binding
runtime-node/revision attribution guards. Four further incident regressions pass
(21 incident tests total). Prior boot/epoch differences are permitted only as
diagnostic history and never cross the new evidence fence.
Typecheck/build and checkpoint/docs/release/secrets checks pass. The broad serial
run reports **1,449 passed / two failed / eight skipped**. Its two existing
control failures are launch metadata through an attached branch and retained
stopped Codex binding bootstrap. The JSON reporter retains `STACK_TRACE_ERROR`
and durations of 21.7/22.9 seconds without a more specific cause. All **13 tests**
in those two files pass on isolated exact-source retry. The broad failed receipt
is retained; a clean full-suite run, publication, installed activation and native
owner acceptance are not claimed.

| Local receipt | SHA-256 |
| --- | --- |
| `receipts/p0-copilot-gap-20261005/full-tests.json` | `97c95914d323d4a98dc902b5ed222c6744cec146b03bb9bd478259b496c80d80` |
| `receipts/p0-copilot-gap-20261005/full-retry.json` | `a12bae00065e8e7f508234110e290b94c2013f35b8758f2e28f2238e2682c15f` |

Initial dependency installation used `npm ci --ignore-scripts`. An earlier broad
run lacked the declared `node-pty` native addon and was stopped; the allowed
package's explicit install script built that exact addon before final typecheck,
build and the retained full run. A generic `npm rebuild node-pty` was rejected by
the existing strict script policy due to an unrelated unapproved dependency
prepare hook; no policy or dependency pin was changed.

The focused reproduction and safety checks use no native owner or model:

```bash
npx vitest run tests/copilot-incident-trace.test.ts tests/copilot-payload-gap.test.ts packages/runtime-node-core/test/lifecycle-refresh.test.ts packages/runtime-node-core/test/lifecycle-journal.test.ts packages/adapter-copilot/test/sdk-lifecycle-contract.test.ts
```

## Coordinated hotfix.33 integration gate

The separate integration worktree is based on the same `998128b` published-state
source and carries the final reviewed patch plus lockstep `.33` version metadata.
`npm ci --strict-allow-scripts`, typecheck and build pass. Final
`npm test -- --maxWorkers=1` passes **1,451 tests** (eight skipped), **138 passing
files** (one skipped), followed by successful build/checkpoint/docs/release/secrets
checks. Root retains `/tmp/p0-framework33-serial-test.log` and associated gate logs.
An earlier overlapping integration run with two payload-gap failures was stopped
with exit130; I/O contention was observed but not proved as its cause. The earlier
producer failure receipts above remain valid diagnostic evidence.

No lifecycle behavior is relaxed by integration. Packed consumer/public release
qualification, exact consumer pins and installed Windows/WSL acceptance are
subsequent boundaries; none is implied by this source gate.
