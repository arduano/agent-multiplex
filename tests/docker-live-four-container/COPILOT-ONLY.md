# Copilot-only protocol-v6 live harness

This is a deliberately narrow, isolated integration harness for the current
protocol-v6 authority/access split and the real GitHub Copilot SDK runtime. It
creates three application containers with unique per-run names and a unique
bridge network:

1. one canonical control node (authority),
2. one runtime node advertising only `copilot`, and
3. one zero-authority bearer-authenticated gateway, the only published port.

The provider relay is credential-blind host test plumbing bound only to the
per-run Docker bridge. The runtime receives the existing codex-lb key as one
read-only file mount; no full Codex home, Copilot home, key value, bearer token,
provider endpoint, shared secret, or P2P ticket is written to the receipt. The
live source must equal `HEAD` outside the explicitly unrelated `tmp/` scratch
area. Docker resources and the relay are removed only after immutable-ID or
command-identity checks.

## Static validation (safe, credential-free)

This does not build an image, read credentials, start Docker, or contact a
model. It also does not require a clean worktree:

```bash
bash tests/docker-live-four-container/copilot-only-run.sh --static
```

It syntax-checks the shell and Node programs and enforces the important static
invariants, including exactly one `sessions.execute` call, fixed
`gpt-6-luna`, Copilot-only runtime configuration, native reply/idle checks,
stop/resume checks, and source/secret/cleanup fences.

## Explicit live run (parent review only)

The live branch sends exactly one synthetic `gpt-6-luna` prompt. There is no
model override and no second send. It verifies:

- protocol version 6 and a zero-authority gateway;
- one reachable runtime exposing only the real Copilot SDK adapter;
- a fresh session created through `core.direct/workspace`;
- the exact native `assistant.message` reply followed by root `session.idle`;
- an opportunistic same-turn Plan probe: if the real SDK emits
  `exit_plan_mode.requested`, the gateway must expose a pending `exitPlan` record
  through `interactions.list({sessionId,pendingOnly:true})` before the driver
  resolves it with exactly `{approved:true,selectedAction:"exit_only"}` and
  observes the matching native completion;
- native history containing that turn;
- stop to `resumable/stopped`, native resume with a new runtime epoch, retained
  native history, and a final stop;
- zero native stream gaps and zero pending interactions.

Run only after reviewing the files and intentionally opting into the one model
request:

```bash
AGENT_MULTIPLEX_COPILOT_ONLY_RUN=I_UNDERSTAND_ONE_GPT_6_LUNA_REQUEST \
  bash tests/docker-live-four-container/copilot-only-run.sh
```

Optional non-secret settings:

- `AGENT_MULTIPLEX_COPILOT_ONLY_TIMEOUT_MS` (default `600000`)
- `AGENT_MULTIPLEX_COPILOT_ONLY_RUN_ID`
- `AGENT_MULTIPLEX_COPILOT_ONLY_RECEIPT_ROOT`
- `AGENT_MULTIPLEX_DOCKER_NPMRC`
- `AGENT_MULTIPLEX_COPILOT_ONLY_SOURCE_CONFIG`
- `AGENT_MULTIPLEX_COPILOT_ONLY_SOURCE_KEY`

Receipts default to `receipts/protocol-v6-copilot-only/<run-id>/`.

## Exit-plan limitation

The harness requests `exit_plan_mode` inside its one authorized Luna prompt; it
never sends a retry. If the model emits the callback, the receipt contains
`rpc/exit-plan-pending.json` captured before resolution and
`rpc/exit-plan-resolved.json` after exact approval. If the turn completes
without the callback, the pending receipt is an empty list and `result.json`
records `exitPlan.observed:false` without weakening the create/send/reply,
security, or cleanup checks.

This remains model-directed because the pinned Copilot SDK has no supported
zero-model API for creating a genuine pending `exitPlan` request. The harness
never fabricates an adapter event merely to make the gateway test pass.
Stop/resume still requires no additional model request.
