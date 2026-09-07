# @arduano/agent-multiplex-adapter-codex

The native Codex app-server adapter for Agent Multiplex runtime nodes. It maps
Codex sessions, model and mode changes, prompts, interactions, interrupts,
events, and native history onto the runtime adapter boundary without parsing
Codex history files.

## Native goals

The experimental `thread.goal` v2 capability exposes Codex's native thread goal.
Read it through `sessions.readNativeState` with `{ harness: "codex", view: "goal" }`;
the payload is the unmodified native `{ goal }` response, including `null` when
Codex reports no goal. Reads require an active binding and never resume it. They
preserve the objective, all six native statuses, token budget, usage and native
timestamps. Unsupported, malformed or oversized observations fail explicitly.
Selection and reconnect should read a fresh snapshot; root `thread/goal/updated`
and `thread/goal/cleared` notifications invalidate it. Descendant notifications
retain their native thread IDs and do not describe the root goal.

The durable `setGoal` command maps its supplied objective, status and token budget
to `thread/goal/set`; `clearGoal` maps to `thread/goal/clear`. No default status or
budget is inserted. Omitted `tokenBudget` leaves native behavior intact; explicit
`null` removes its limit. Clients can implement `/goal`, `/goal <objective>`,
`/goal edit`, `/goal pause`, `/goal resume` and `/goal clear` using these operations.
The objective is limited to 4,000 characters. Native refusals remain errors, and
missing mutation acknowledgements remain `outcomeUnknown` under the original
command ID. Never resend a goal mutation to infer its outcome.

These APIs already exist in the generated Codex `0.152.0` contract. Goal state is
native state, not session metadata, a collaboration mode or a synthetic chat turn.

The package pins the Codex CLI version used to generate and qualify its protocol
bindings. Codex app-server transport is upstream-experimental, so deployments
should re-run adapter and live qualification when changing that pin.

The generated declaration attribution, the full Apache-2.0 license, and the
upstream Codex NOTICE are included in `THIRD_PARTY_NOTICES.md` and `licenses/`
inside the published package.
