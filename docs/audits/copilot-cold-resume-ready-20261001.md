# Certified Copilot cold resume — October 1, 2026

## Cause and scope

The candidate starts at hotfix.24 preparation
`512cf4874968ef9b7620673d53aef0c4710ddbe9`. Leo's coordinator supplied
read-only evidence of idle Windows sessions with root `unknown/null/none`,
inactive aggregate activity, complete empty children/interactions, observed empty
task/queue state and continuous delivery. Their first current-handle native resume
reported `continuePendingWork:false` and `sessionWasActive:false`. Send was
available, but root phase stayed unknown, which Leo labelled “Status unavailable.”
The owner recovered Tariff and continued it; this work did not intervene.

A new runtime epoch starts an uncertified root. The existing adapter certificate
promoted empty child/interaction hydration, but emitted no root fact. Aggregate
inactivity intentionally cannot establish whole-session idle. Therefore an idle
cold resume could remain healthy/unknown indefinitely. This is distinct from
payload gaps, stalled reads and the B16 native-feed starvation defect; this fix
does not claim to resolve those incident classes.

The pinned SDK's `ResumeData` contract says false `continuePendingWork` abandons
old pending work, while false `sessionWasActive` excludes joining live work.
Both must be explicitly false. Missing fields are not treated as defaults.

## Correction and safety boundaries

The first session-scoped native resume boundary emits the existing complete empty
hydration facts followed by private `coldResumeQuiescent`. A root/native callback,
task/queue change, active aggregate read, command start, child or interaction
racing before that boundary blocks certification. Duplicate, ambiguous,
child-owned and retired-bridge boundaries do not establish quiescence or reset
the adapter's running status.

The reducer consumes the certificate only under continuous evidence, an untouched
unknown root with no cycle/outcome, complete empty child/interaction hydration,
and no observed task/queue/compaction activity or degraded native admission.
It sets root `idle/null/none` and aggregate inactivity. Tasks and queue must
independently become fresh before Ready projects. Existing gaps, partial
hydration, working/paused roots and failed/interrupted/finished outcomes are
preserved. Commands remain unsettled unless exact command evidence proves
otherwise. No synthetic idle/transcript event is manufactured.

`lifecycleFactSchema`/`lifecycleEvidenceSchema` are used only by the runtime's
internal journal/adapter boundary; no public RPC accepts them. The private
`LifecycleState`, public lifecycle view and runtime projection definitions are
byte-identical to the base. Runtime store/migration source is unchanged. The
store persists reduced state rather than fact envelopes, so older state readers
do not encounter a new discriminator. Installed rollback still needs the normal
stopped-backup and exact published-consumer acceptance gates. No SDK, native CLI,
transport, profile hash, protocol version, dependency or migration changed.
`SECURITY.md` and `THIRD_PARTY_NOTICES.md` were reviewed; their boundaries remain
unchanged and no dependency or copied vendor implementation is added.

## Exact local qualification

Nearest build:

```bash
npx tsc -b packages/adapter-copilot packages/adapter-codex --pretty false
```

The old bridge restored from exact base fails **eight regressions**: interactive,
plan and autopilot Ready projection plus root-start, failure, message, activity
and command races. Corrected source was restored after the baseline run.

Corrected Copilot qualification passed **105 tests / five files**, one worker:
protocol lifecycle, bridge races, adapter startup buffering, runtime startup
reattachment and durable lifecycle journal. Coverage includes explicit/missing/
active flags, duplicate/child/retired/replacement boundaries, independent pending
reads, existing outcomes, positive work, partial hydration, gap/sequence/fence
rejection, durable reopen and fresh-epoch uncertainty. The existing reducer's
4,096 deterministic schedules also pass. These tests use synthetic SDK sessions
and disposable state; no real model, live Host or owner session is involved.

Local receipt namespace: `receipts/copilot-cold-ready-20261001`.

| Receipt | SHA-256 |
| --- | --- |
| Old-bridge regression log | `11a537ba3afb58de59ed543ac5a6e6f8e9e834d18e735321040937cff12b1df7` |
| Corrected Copilot focused log | `42b5eaac47a4e2999a2ba892d07f3d46987f22ce8ccf5b4fd7ccc578b6a040ea` |
| Six source/test file inventory | `4f09cdf5b2270b6aabf7e31ddf0a27bb83f788160c1853ef66bb254500d78f7f` |
| Unchanged state/view/store boundary | `e0fec623dad3fc4c0efcf8edf5d2451f3dab96c0a3d2e5a6245296b6f16d9f23` |

Full source/package gates, coordinated publication, Leo wrapper/UI integration
and installed Windows/WSL acceptance remain separate coordinator-owned steps.
No deployed role, private configuration/state, credential, task, V5 service or
pre-existing session/worktree was changed.
