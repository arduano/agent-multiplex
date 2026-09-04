# Real Codex interactive two-container acceptance test

> Archived protocol-v2 receipt harness. It depends on the removed worker/host
> build and is not a runnable protocol-v4 target. Commands below are retained
> only as a record of how the historical receipts were produced.

This is the high-fidelity companion to `tests/docker-codex-e2e`. It exercises
the production Codex adapter through the public Multiplex API with exactly two
application containers:

1. the canonical Multiplex metadata host, tRPC endpoint, and web dashboard;
2. one Multiplex worker whose child process is the real `codex app-server`.

Playwright runs directly on the Docker host, so screenshots do not require a
third application container. The worker has a fresh container-local Codex home.
After the container exists, the runner copies only a generated minimal
`codex-lb` provider config and the host's `codex-lb-api-key` into it. It does not
copy `auth.json`, Codex histories, databases, or the complete host Codex home.

## What the suite proves

One logical Codex session and one persistent Multiplex native watcher are used
across six phases:

- multiple `item/agentMessage/delta` events reconstruct the completed response
  byte-for-byte;
- a runtime model change appears in `thread/settings/updated` and the next turn
  completes on that session;
- a runtime reasoning-effort change is acknowledged and appears in native
  `thread/settings/updated` state;
- Plan mode produces a real blocking `request_user_input`, the canonical host
  exposes it, a typed native answer resolves it, and the answer reaches the
  final agent message;
- `turn/steer` targets a known in-flight turn without emitting another
  `turn/started`;
- output from a deliberately long shell command is visible before
  `turn/interrupt`, the turn ends as `interrupted`, and output stops early;
- a model advertising native multi-agent support emits matching
  `subAgentActivity` started/completed items; the assertions require the exact
  child marker to be routed from a thread ID derived from the started activity,
  and the parent result is visible through the same multiplexed stream;
- final history is requested from Codex with native `thread/read`; the test
  never reconstructs history from deltas.

The Plan request and running command are captured while they are live because
those are the two race-sensitive states. A third screenshot captures the
completed subagent lifecycle and routed child result in the sample dashboard.

## Run

The suite intentionally consumes real model credits and may take several
minutes:

```bash
npm run test:docker:codex:interactive
```

Defaults target the checkout's sibling `../p2prpc/packages/core`, the current
user's `~/.codex/config.toml`, and `~/.codex/codex-lb-api-key`. Overrides:

```bash
AGENT_MULTIPLEX_P2PRPC_CORE=/path/to/p2prpc/packages/core \
AGENT_MULTIPLEX_CODEX_SOURCE_CONFIG=/path/to/config.toml \
AGENT_MULTIPLEX_CODEX_SOURCE_KEY=/path/to/codex-lb-api-key \
AGENT_MULTIPLEX_INTERACTIVE_E2E_MODEL=gpt-5.6-sol \
npm run test:docker:codex:interactive
```

Receipts are written to
`receipts/codex-interactive-docker-e2e/<UTC run id>/`. They contain the complete
Multiplex fleet stream, per-phase filtered streams and assertions, public RPC
results, sanitized host/worker logs, three Playwright screenshots, topology and
process proofs, a manifest, and `SHA256SUMS`.

The shared fleet secret, raw P2P ticket, provider endpoint, provider config, and
API key are excluded and scanned for accidental leakage before a receipt can
pass. Containers, network, workspace, and image are removed on exit. Set
`AGENT_MULTIPLEX_INTERACTIVE_E2E_KEEP_IMAGE=1` to retain the image for debugging.
