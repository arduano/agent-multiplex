# Real Copilot BYOK interactive two-container acceptance test

> Archived protocol-v2 receipt harness. It depends on the removed worker/host
> build and is not a runnable protocol-v4 target. Commands below are retained
> only as a record of how the historical receipts were produced.

This suite exercises the production Copilot adapter through the canonical
Multiplex host and p2prpc worker topology. Exactly two application containers
are used: one host/dashboard and one worker whose SDK starts the real bundled
Copilot runtime. Playwright runs on the Docker host.

The worker is configured through `AGENT_MULTIPLEX_COPILOT_PROVIDER_*` and uses
GitHub Copilot SDK BYOK with an OpenAI-compatible provider. By default, the
runner extracts only the `codex-lb` base URL from `~/.codex/config.toml` and
bind-mounts `~/.codex/codex-lb-api-key` read-only at
`/run/secrets/codex-lb-api-key`. The key is never copied into the image or
receipt. The adapter passes it to the SDK as `apiKey` with
`wireApi: "responses"`, `transport: "http"`, and logged-in-user authentication
disabled.

## Verified phases

- session spawn, metadata, and multi-delta streamed response reconstruction;
- shell permission exposed as a canonical interaction and resolved with native
  `{kind:"approve-once",approvedInteractively:true}`;
- native tool start/completion visibility;
- runtime model switch between two configured BYOK model IDs;
- Copilot Plan mode, native `ask_user`, typed freeform answer, native
  `exit_plan_mode`, and plan approval;
- interruption of an active turn and an aborted idle event;
- an idle `steer` command dispatched through Copilot immediate-delivery mode;
- a model-directed built-in Explore subagent with matching native
  `subagent.started`/`subagent.completed` events and routed child output;
- history obtained only from `CopilotSession.getEvents()`;
- stop, resumable inventory, native resume, continued messaging, and final stop;
- a live dashboard screenshot with browser-console error checking.

Plan interactions are model-directed native tools. The suite gives them one
retry and fails clearly if the configured model does not trigger either
`ask_user` or `exit_plan_mode`; it never fabricates these callbacks.

## Run

This consumes real model credits and usually takes several minutes:

```bash
npm run test:docker:copilot:interactive
```

Defaults and overrides:

```bash
AGENT_MULTIPLEX_P2PRPC_CORE=/path/to/p2prpc/packages/core \
AGENT_MULTIPLEX_COPILOT_SOURCE_CONFIG=/path/to/codex/config.toml \
AGENT_MULTIPLEX_COPILOT_SOURCE_KEY=/path/to/codex-lb-api-key \
AGENT_MULTIPLEX_COPILOT_E2E_MODEL=gpt-5.6-sol \
AGENT_MULTIPLEX_COPILOT_E2E_SECOND_MODEL=gpt-5.6-terra \
npm run test:docker:copilot:interactive
```

Receipts are written to
`receipts/copilot-interactive-docker-e2e/<UTC run id>/`. They include sanitized
logs, the fleet stream, per-phase assertions, RPC results, topology/process
proofs, the dashboard screenshot, a manifest, and `SHA256SUMS`. The raw API key,
provider endpoint, shared secret, and P2P ticket are scanned from the receipt
before the run can pass. Containers, network, workspace, Copilot home, and image
are removed on exit unless `AGENT_MULTIPLEX_COPILOT_E2E_KEEP_IMAGE=1` is set.
