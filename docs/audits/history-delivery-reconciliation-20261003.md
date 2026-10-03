# Exact delivery reconciliation from native history

Source candidate: October 3, 2026, based on published `.26` source
`be1732f213f4e44be35b870592c2e3eaea6dab36`. This is source qualification,
not publication, installed acceptance or native-model qualification.

## Defect and correction

The active runtime returned native history without using its exact root-message
consumption evidence to reconcile the durable delivery projection. Consequently
a missed live native echo could leave an identified accepted command visible
indefinitely even when a supported history page proves that exact message was
consumed. The runtime path is shared by Windows and Linux. Copilot and Codex
need harness-specific evidence extraction.

Adapters now return a private `messageDeliveryFacts` field with transferred
history pages. Copilot extracts root `user.message` display by the exact logical
`messageId`; consumption additionally requires the same event's nonempty
`turnId`. Codex extracts root `thread/items/list` user items only with an exact
`clientId` and nonempty containing `turnId`. Selected-child pages, turn summaries,
malformed identities and explicitly omitted items cannot certify root delivery.
Full and primary Copilot pages both use supported native APIs.

The active runtime drains admitted events, validates the response's harness and
native-session identity, and rechecks the complete runtime/boot/binding/native
epoch fence before and after awaited image extraction. It validates every
private fact before writing any, bounds the sidecar to twice the requested
native-item limit, and admits only root display/consumption through the existing
lifecycle writer. It deduplicates each fact kind, proves unmatched tracked
commands even when their IDs precede the retained page tail, then retains only
the latest 512 native identities per kind for acknowledgement races. A matching
command's already proved delivery stays proved after its auxiliary ID is
evicted. Repeated 600-ID pages therefore stabilize instead of churning both
bounded rings, including descending native pages.
The private field never reaches the wire result. Temporary stopped-session
history handles have no active delivery-writer fence and cannot reconcile this
ledger. A fresh read after explicit resume can do so.

Historical activity, tasks, children, interactions, compaction and recovery are
never replayed. Genuine lifecycle gaps remain gaps. Original command receipts
stay immutable; acknowledgement-before-history and history-before-native-ID
evidence converge under the existing correlation rules. No new protocol schema,
store migration, vendor dependency or transport dependency is required.

## Qualification

- Restoring only the exact published `.26` runtime service, while retaining the
  new native fixtures and private evidence extractors, reproduced **13 failures
  in the initial 15-case runtime regression suite**. The preserved local log is
  `receipts/delivery-history-20261003/published26-runtime-regressions.log`.
  This is a source-path reproduction; it is not a packed-package comparison.
- Focused candidate tests cover Copilot and Codex exact consumption, absent or
  wrong IDs, root/child ownership, missing turns, legacy Codex admissions,
  immutable receipts, duplicate reads, genuine gaps, delayed-response fences,
  exact correlation across a boot/native epoch change, temporary attachments,
  omissions/expired reads, and atomic rejection of historical work facts.
- The initial focused set passed **191 tests in 11 files**, with one worker and a
  60-second test bound. `npm run typecheck`, `npm run check:docs` and
  `git diff --check` also passed. An earlier parallel test run retained two
  unrelated file-backed fixture timeouts and two corrected temporary-history
  fixture expectations; the final one-worker set passed all four cases.
- Independent review added array/count admission, atomic validation and repeated
  600-ID page regressions in both directions. The expanded focused set passed
  **198 tests in 11 files** with one worker and the same 60-second bound.
  Typecheck, documentation and diff checks passed after the correction.
- No model calls, deployed services, owner sessions or native vendor files were
  used or changed.

## Limits

Positive evidence in a returned native page can repair delivery. Neither queue
absence nor exhausted history proves consumption, cancellation or loss. An
accepted message whose exact ID never appears therefore remains unverified.
It needs the separately reviewed warning/review presentation, not a fabricated
Consumed result or a resend. Explicit omissions and expired cursors preserve
that uncertainty.

The correlation journal remains bounded (256 command records and 512 exact
display/consumption IDs). Reconciliation cannot reconstruct an evicted command
correlation from transcript text. Existing receipts remain queryable by their
original command IDs.
