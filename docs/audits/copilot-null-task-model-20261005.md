# Copilot null task model correction — October 5, 2026

## Reproducer and scope

Two owner-authorized disposable child fixtures on Leo's installed Windows/WSL
`.31` Hosts produced eight current-revision `snapshotMalformed` failures each:
native `tasks[0/1].model` was explicitly null, while admission required an
optional string. Exact unchanged installed-module offline reproduction agrees.
Four actual Luna children completed uncancelled and streamed; both parents
reached native idle but failed healthy Finished. Fixtures were stopped/archived,
retaining all 17 original bindings/five intended Hosts. Consumer evidence is
`docs/Copilot-Luna31-Task-Metadata-Reproduction-20261005.md` in Leo Multiplex.
This establishes those fixtures' rejection, not every historical incident.

Only agent-task requested `model` changes to `z.string().nullable().optional()`.
The native null survives unchanged; no parent/resolved model is invented.
`resolvedModel`, `displayName`, task identity/status/ownership/control, wire/count
limits, exact revision/binding fences and genuine interaction uncertainty remain.
No SDK/CLI/transport pin, protocol schema, profile hash or migration changes.
The separate Windows diagnostic-health private-write failure is not addressed.

## Qualification

Sixteen new real-adapter task regressions cover running/completed null, absent
and string model values, promotable null-model agents, malformed metadata/control
and count/wire bounds. Before the patch: **11 failed /39 passed**; after: **50
passed**. Four real adapter-to-Runtime regressions also fail on the former schema
and pass with the correction. They retain two running tasks/children through the
repair interval, require independent completed-task and whole-session idle facts
for healthy Finished/Send, retain genuine pending user input, and reject delayed
observations after native invalidation or explicit Stop/Resume. A read-only Vite
transform supplies the old-schema negative control without changing source.
No SDK/network/model call is used by these tests. Independent final review finds
no blocker and confirms the Leo task parser already treats null requested-model
metadata as unknown without rejecting the task or inventing a model.

Local receipts are under `receipts/copilot-null-model32/` and remain ignored.
At exact source `8638e14a79975de9838bb590d9ee2fdeef7fdb81`, typecheck, **1,445
tests / 138 passing files** (eight tests/one file skipped), build, checkpoint/docs/
release/secrets checks, all **16** isolated packed consumers with the reviewed
exact published transport graph, and SBOM generation pass. Signed
`hotfix-2026-10-05.2` publishes lockstep `0.2.4-hotfix.32`; all **19** public assets
independently match the qualified bytes and API size/digest metadata.
[Release proof, digests and retained failures](hotfix32-release-qualification-20261005.md)
record publication and its limits. Source publication does not qualify native
installed acceptance, which remains consumer-owned.
