# Protocol-v6 maintenance operator handoff

**State at handoff, 2026-09-23: pre-cutover.** This card preserves the exact
source and decision boundary for a different agent to run the owner's proposed
three-hour maintenance window. It is a restart card, not evidence that a host
was upgraded. No service was stopped, database backed up or restored, ticket or
locator rotated, native model prompt sent, or live session mutated while
preparing this card. The owner intends to pause agents and have another agent
conduct the window; verify that pause and the window's start before changing a
service. Record subsequent phase changes in a scrubbed, durable handoff before
any restart that could end the operator's own session.

## Why a fresh agent must use this card

The coding agent that prepared this card runs inside `leo-runtime.service` on
main-pc. Its `leo-codex`/`codex-code-mode` process and the runtime are in the
same systemd cgroup, and the unit uses `KillMode=control-group`. Restarting
`leo-runtime.service` or `leo-host.target` should be treated as ending this
conversation. A control-only restart may still interrupt the client connection.
The [Codex CLI `codex resume` command](https://learn.chatgpt.com/codex/developer-commands?surface=cli#cli-codex-resume)
continues a previous **CLI interactive** session; it does not establish that
this conversation will be resumable. Start the replacement agent
outside the Leo runtime being upgraded and give it the prompt below.

## Exact source and evidence boundary

All three worktrees were clean and matched their pushed branches immediately
before this documentation-only handoff commit. Recheck Git state and installed
pins at the start of the window; source branches do not establish deployed state.

| Repository | Source boundary | Qualification and artifact |
| --- | --- | --- |
| `/home/arduano/programming/p2prpc` | `main` at `ca7bb6fb7b791813c937ddbf9bde62423d097373` | Independently published `@arduano/p2prpc-core@0.3.0-renewal.0`; package and receipt identities are in the [checkpoint](../checkpoint-v4.md#published-core-protocol-v6-source-gate--2026-09-23). |
| `/home/arduano/programming/agent-multiplex-copilot-lifecycle-vnext` | `feat/copilot-session-lifecycle-vnext-20260922` at pre-handoff `761f43b46efe51777c64e30d50c7781ca52c080f`; this card adds a documentation-only descendant | The signed 16-package `0.2.4-hotfix.17` graph comes from `6bb053cd05be66151114ecf397fd4143a0004512`. Later source `2dde123508715cd59f8fa4d845030b4a4b9f94c7` passed [CI](https://github.com/arduano/agent-multiplex/actions/runs/35849558841) and [no-model Windows checks](https://github.com/arduano/agent-multiplex/actions/runs/35849559080); subsequent `761f43b` changes documentation only. Exact receipts and artifact checksums are in the [checkpoint](../checkpoint-v4.md#published-core-protocol-v6-source-gate--2026-09-23). |
| `/home/arduano/programming/leo-multiplex-lifecycle-vnext-20260923` | `feat/copilot-lifecycle-vnext-20260923` at `a8b1a2f5667e4126cf43f46248f4c663a1d6f78f` | Pins all 16 signed framework artifacts and published core. [Exact-commit CI](https://github.com/arduano/leo-multiplex/actions/runs/35850282103) passed application, installer and two no-model Windows host jobs; eight downloaded Windows receipt inventories verified. Offline Nix build passed. See [Leo's staged-source handoff](https://github.com/arduano/leo-multiplex/blob/a8b1a2f5667e4126cf43f46248f4c663a1d6f78f/docs/Session-Handoff.md) in the sibling checkout. |

The code and tests implement the clean protocol-v6 break, host-owned Copilot
lifecycle view, exact command observation, runtime startup reattachment and
degraded recovery, consumer migration, and published p2prpc renewal. The
[current-state handoff](../wiki/Current-State.md), [lifecycle design and
rollback](../design/copilot-session-lifecycle-vnext.md#coordinated-maintenance-window-and-rollback),
[transport deployment matrix](../design/p2prpc-renewal-vnext.md#coordinated-migration-and-rollback),
and [readiness audit](maintenance-window-readiness-20260923.md) own the contract,
sequence, evidence and deletion inventory. For installed Leo service paths and
management, use [Host Maintenance](https://github.com/arduano/leo-multiplex/blob/a8b1a2f5667e4126cf43f46248f4c663a1d6f78f/docs/Host-Maintenance.md)
and [Independent Deployment](https://github.com/arduano/leo-multiplex/blob/a8b1a2f5667e4126cf43f46248f4c663a1d6f78f/docs/Independent-Deployment.md)
from the sibling checkout. `docs/deployment-v4.md` in this repository still
describes a protocol-v5 personal deployment; use the linked v6 designs for this
combined cutover.

## Admission and rollback gate

The readiness audit still says **no-go for live cutover**. The receiving agent
can use the proposed window to close these gates, but must record evidence
before admitting work:

1. Qualify the exact installed graph on the target Windows host, including
   native task observation, service ancestry/cleanup, Task Scheduler, ACL,
   sign-in and corporate security behavior. Disposable no-model CI does not
   prove installed behavior or the cause of historical Windows task-read stalls.
2. Rehearse a stopped-state, matching **control and runtime** backup/restore,
   including SQLite WAL state, identities and retained runtime files. Stage the
   entire compatible old graph. A source/package rollback alone cannot undo v6
   store migrations. Keep original unknown operation IDs in a private ledger.
3. Stage and verify the full v6 graph for every authority, branch, runtime,
   combined host, gateway, direct client and work-command/recovery consumer.
   Rotate ALPN-bound signed tickets and configured/cached locators in dependency
   order, preserving endpoint pins; verify a saved-locator reconnect. Never
   publish raw tickets, credentials, endpoints or private conversations.
4. Run synthetic native-model UAT only with separate explicit authorization.
   The original task forbade native model prompts and live session mutation;
   the later offer of a maintenance window did not explicitly grant either.
   Keep ambiguous command receipts tied to their original IDs and never replay
   them as a test.
5. After activation, observe at least 45 minutes spanning three real
   authentication expiries. Require advancing generations, stable logical
   boots/feed identity, contiguous cursors, fresh Copilot task reads, and no
   renewal-induced reachability or source-selection changes. Record native
   stalls separately from transport renewal.

Abort admission if exact identity, backup, locator, startup reattachment or
observation cannot be proved. If a pre-admission upgrade fails, stop all v6
roles and restore the matching pre-upgrade **control and runtime store set** with
the old compatible graph and fresh tickets. If v6 has admitted commands or
native side effects since the backup, a restore could discard receipts: retain
the original IDs, reconcile first, and prefer a forward fix where safe. Never
blindly resend an uncertain command. The complete order and exceptions are in
the linked v6 designs, not in this card.

## Copy into the replacement agent's first message

> Take over the coordinated protocol-v6 Copilot lifecycle, p2prpc renewal and
> Leo maintenance window. Start outside `leo-runtime.service`, since restarting
> that service ends the prior Codex agent's process. Read
> `/home/arduano/programming/agent-multiplex-copilot-lifecycle-vnext/AGENTS.md`,
> `docs/wiki/Current-State.md`, and
> `docs/audits/maintenance-window-operator-handoff-20260923.md`, then the
> linked v6 lifecycle/transport and Leo host-maintenance runbooks. Verify the
> three exact Git heads, clean worktrees, signed package graph, current installed
> pins and live service state; do not infer deployment from source. This handoff
> is pre-cutover: no service has been stopped and no backup, ticket rotation,
> model UAT or live session mutation has been done. Confirm my agent pause and
> three-hour window, close the recorded no-go gates before admitting work, and
> keep scrubbed phase/receipt updates durable before any process cutoff. Do not
> expose secrets or private conversations. Ask separately before native model
> prompts or live session mutation. Reconcile uncertain effects by original ID;
> never replay them blindly.
