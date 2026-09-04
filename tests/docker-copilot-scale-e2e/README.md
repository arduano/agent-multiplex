# Real Copilot BYOK 10x10 scale acceptance

> Archived protocol-v2 receipt harness. It depends on the removed worker/host
> build and is not a runnable protocol-v4 target. Commands below are retained
> only as a record of how the historical receipts were produced.

This opt-in acceptance harness starts one canonical Agent Multiplex host and 10
isolated worker containers. Each worker starts one SDK-managed Copilot runtime
and owns 10 real Copilot sessions, giving a fixed 10-worker/100-session fleet.
It uses the codex-lb endpoint and token already configured on the Docker host.

The workload has two deliberately separate parts:

- a diagnostic baseline that creates and prompts one session per worker in 10
  staged waves;
- a second prompt on all 100 resident sessions, dispatched with a configurable
  concurrency limit that defaults to 100. One worker is removed from the Docker
  network during this burst and reattached to exercise application-stream
  outage recovery.

At the default burst width, the driver first prefetches session state and then
requires an observed maximum of 100 unresolved tRPC `sessions.execute` calls.
That client-RPC overlap is not evidence that all 100 provider turns overlapped
in wall-clock time. The suite also does not claim 100 separate Copilot runtime
processes. It records exact native events and observed timings so the receipt
says what was actually tested.

## Safe validation

The dry run validates local prerequisites, auth sources, configuration, and
script syntax without building containers or making inference requests:

```bash
AGENT_MULTIPLEX_COPILOT_SCALE_DRY_RUN=1 \
  npm run test:docker:copilot:scale
```

## Credit-consuming run

After the Copilot lifecycle changes are stable, the full acceptance run is:

```bash
AGENT_MULTIPLEX_COPILOT_SCALE_CONFIRM=I_UNDERSTAND_THIS_RUNS_100_REAL_SESSIONS \
  npm run test:docker:copilot:scale
```

Defaults can be overridden with
`AGENT_MULTIPLEX_COPILOT_SOURCE_CONFIG`,
`AGENT_MULTIPLEX_COPILOT_SOURCE_TOKEN`,
`AGENT_MULTIPLEX_COPILOT_SCALE_MODEL`,
`AGENT_MULTIPLEX_COPILOT_SCALE_REASONING_EFFORT`,
`AGENT_MULTIPLEX_COPILOT_SCALE_STAGE_WIDTH`,
`AGENT_MULTIPLEX_COPILOT_SCALE_STAGE_DELAY_MS`,
`AGENT_MULTIPLEX_COPILOT_SCALE_BURST_WIDTH`,
`AGENT_MULTIPLEX_COPILOT_SCALE_DISCONNECT_MS`, and
`AGENT_MULTIPLEX_COPILOT_SCALE_TIMEOUT_MS`. The topology remains fixed at
10x10. Reducing the burst width is useful for diagnosis but is not the default
full-fleet stress target.

## Validation and receipts

For both the baseline and burst, every session must produce at least one native
`assistant.message_delta`; concatenated deltas and the final native
`assistant.message` must equal that session's unique marker. The suite also
checks turn ordering, terminal idle, runtime epochs, contiguous worker-native
sequences, no application-visible gap or duplicate, exact 10-per-worker
distribution, metadata convergence, and all 100 histories through the
adapter's `CopilotSession.getEvents()` API.

Before stopping the sessions, Playwright asserts exact total DOM counts and
captures a live dashboard session. The runner then stops all sessions, refreshes
native inventory, requires 100 resumable/stopped records, records container
resources and lifecycle state, removes the exact topology, scans receipts for
the token/provider endpoint/fleet secret/raw p2prpc ticket, and writes
`SHA256SUMS` last.

The host API key is bind-mounted read-only at `/run/secrets/codex-lb` in each
worker. It is never copied into the image, worker state, or receipt tree.
Receipts are written under `receipts/copilot-real-scale/<run-id>/`.
